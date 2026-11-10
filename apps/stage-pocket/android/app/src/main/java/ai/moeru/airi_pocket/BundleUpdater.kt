package ai.moeru.airi_pocket

import android.content.Context
import android.util.Base64

import com.getcapacitor.plugin.WebView

import okhttp3.OkHttpClient
import okhttp3.Request

import org.json.JSONArray
import org.json.JSONObject

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Serves the pages from a directory that updates over the air.
 *
 * Capacitor starts the WebView from `assets/public` and `Bridge.loadWebView` restores the directory that
 * `persistServerBasePath` saved, so a new bundle only needs a complete directory and one preference write.
 * `Bridge.isNewBinary` clears that preference after an APK update, so this class keeps its own copy of the state and
 * drops it at the same time.
 *
 * A bundle is a directory of the same files that `cap sync` copies into the APK. Every file is listed with its SHA-256
 * in `bundle-index.json`, which the release tunnel signs with the key behind [PUBLIC_KEY]. A client copies the files it
 * already has, downloads the rest, and switches only after every hash checks out.
 */
class BundleUpdater(
    private val context: Context,
    private val client: OkHttpClient,
    private val versionCode: () -> Long,
) {
    data class FileEntry(val path: String, val sha256: String, val size: Long)

    data class RemoteIndex(
        val id: Long,
        val versionName: String,
        val files: List<FileEntry>,
        val raw: ByteArray,
    ) {
        val totalBytes: Long = files.sumOf { it.size }
    }

    data class Manifest(
        val id: Long,
        val versionName: String,
        val nativeVersion: Int,
        val indexUrl: String,
        val signature: String,
        val notes: String,
        val publishedAt: String,
    )

    data class State(
        val id: Long,
        val versionName: String,
        val source: String,
        val basePath: String,
        val pending: Boolean,
    )

    /** Files to copy from the running bundle, and files to download from the release. */
    data class Plan(val reuse: List<FileEntry>, val missing: List<FileEntry>) {
        val bytes: Long = missing.sumOf { it.size }
    }

    data class Check(
        val manifest: Manifest,
        val index: RemoteIndex,
        val plan: Plan,
        val reason: String,
    )

    companion object {
        const val REASON_AVAILABLE = "available"
        const val REASON_UP_TO_DATE = "up-to-date"
        const val REASON_NATIVE_REQUIRED = "native-required"
        const val REASON_BLOCKED = "failed-before"

        private const val PREFS = "airi_web_bundles"
        private const val KEY_ACTIVE_PATH = "active.path"
        private const val KEY_ACTIVE_ID = "active.id"
        private const val KEY_PREVIOUS_PATH = "previous.path"
        private const val KEY_PREVIOUS_ID = "previous.id"
        private const val KEY_PENDING_ID = "pending.id"
        private const val KEY_STAGED_ID = "staged.id"
        private const val KEY_FAILED_ID = "failed.id"
        private const val KEY_BINARY_CODE = "binary.code"

        private const val ASSET_ROOT = "public"
        private const val INDEX_FILE = "bundle-index.json"
        private const val BUNDLE_ROOT = "web-bundles"
        private const val MIN_FREE_BYTES = 64L * 1024 * 1024

        /**
         * The public half of the key that signs `bundle-index.json`. The update tunnel serves plain HTTP, so the
         * signature is what stops anyone between the phone and the tunnel from shipping code.
         */
        private const val PUBLIC_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAsn+Mf5z8USV1gO2zCoUfg3HQoOmgzBr7aRALOZM0GL4rUkgzLPl3DlykQRr4Er9msgLFenoyXQ9yb0ofxRWTo3cvU9H/hRCqQEK0UdsPY3FmC+LCg79f0zvSx4K83e6W01Ik3JGopT9+U4iysn/DheIK0BBXUC19fBHwzUXgVG7J8PdF2q/RMltEBHHk972pCcIvES81bfmQnPMcWV/ANuTtISOUfBjRZR2c8IcipQxwcsbAvQZ9PKXIF9N0vkKeuFQ710pwjHQgv62HLBE4NMd7Ttpj2+RhczBUZstXRG6uuPCeTEY6BSvbDKT0ZFXERFuGtF96Zh1qegvrfmmiPIcvyTA2/tT0aO5WzaL1kNjFRElOXmRrkCUmLTyqRsO+8oymH1yF5IAxBHvNzPyf6DFhGX+nWcqGTCkpL2j/iVD1mDoQ5KHe7GR3pQ/rtuFNufel19pA2KgiQn1AHJqPRU0vv246EgmaAoMg/2RYuuz1vydEDER1FQtp20QfkVcxAgMBAAE="
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val root: File
        get() = File(context.filesDir, BUNDLE_ROOT).apply { mkdirs() }

    /**
     * Runs before Capacitor reads the stored directory, so a bundle that never came up is dropped before the WebView
     * loads it. The order matters: `Bridge` loads the plugins in its constructor and reads the preference in
     * `loadWebView` afterwards.
     */
    fun guardAtBoot() {
        val binaryCode = versionCode()
        if (prefs.getInt(KEY_BINARY_CODE, -1) != binaryCode.toInt()) {
            // A new APK carries the newest pages, so the built-in assets win and every downloaded bundle goes.
            clearState()
            root.deleteRecursively()
            prefs.edit().putInt(KEY_BINARY_CODE, binaryCode.toInt()).apply()
            writeServerBasePath("")
            return
        }

        val pending = prefs.getLong(KEY_PENDING_ID, 0L)
        if (pending > 0L) {
            // The last launch switched to this bundle and its page never reported that it works.
            val failedPath = prefs.getString(KEY_ACTIVE_PATH, "").orEmpty()
            val previousPath = prefs.getString(KEY_PREVIOUS_PATH, "").orEmpty()
            val previousId = prefs.getString(KEY_PREVIOUS_ID, "").orEmpty()

            prefs.edit()
                .putString(KEY_ACTIVE_PATH, previousPath)
                .putString(KEY_ACTIVE_ID, previousId)
                .remove(KEY_PENDING_ID)
                .putLong(KEY_FAILED_ID, pending)
                .apply()

            if (failedPath.isNotEmpty())
                File(failedPath).deleteRecursively()

            writeServerBasePath(previousPath)
        }

        promoteStaged()
        prune()
    }

    fun state(): State {
        val path = activePath().orEmpty()
        val index = if (path.isEmpty()) readBuiltinIndex() else readIndex(File(path, INDEX_FILE))
        return State(
            id = index?.id ?: 0L,
            versionName = index?.versionName.orEmpty(),
            source = if (path.isEmpty()) "builtin" else "downloaded",
            basePath = path,
            pending = prefs.getLong(KEY_PENDING_ID, 0L) > 0L,
        )
    }

    fun check(manifestUrl: String): Check {
        val manifest = fetchManifest(manifestUrl)
        val index = fetchIndex(manifest)
        val current = state()

        val reason = when {
            manifest.nativeVersion > versionCode() -> REASON_NATIVE_REQUIRED
            current.id >= index.id -> REASON_UP_TO_DATE
            prefs.getLong(KEY_FAILED_ID, 0L) == index.id -> REASON_BLOCKED
            else -> REASON_AVAILABLE
        }

        val plan = if (reason == REASON_AVAILABLE)
            planFor(index, current)
        else
            Plan(emptyList(), emptyList())

        return Check(manifest, index, plan, reason)
    }

    /**
     * Writes the bundle into its final directory. The caller applies it, or the next launch does: a staged bundle
     * waits for a cold start, so an update never reloads the page under the owner.
     */
    fun stage(manifestUrl: String, expectedId: Long, onProgress: (Long, Long, String) -> Unit): File {
        val result = check(manifestUrl)
        if (result.index.id != expectedId)
            throw IllegalStateException("The release changed. Check for updates again.")
        if (result.reason == REASON_NATIVE_REQUIRED)
            throw IllegalStateException("This release needs a newer APK (${result.manifest.nativeVersion}).")
        if (result.reason != REASON_AVAILABLE)
            throw IllegalStateException("This release is not installable (${result.reason}).")

        val index = result.index
        val target = File(root, index.id.toString())
        if (target.isDirectory) {
            prefs.edit().putLong(KEY_STAGED_ID, index.id).apply()
            onProgress(index.totalBytes, index.totalBytes, "done")
            return target
        }

        val usable = context.filesDir.usableSpace
        if (usable < index.totalBytes + MIN_FREE_BYTES)
            throw IllegalStateException("Not enough free space: ${usable / 1024 / 1024} MB available, ${index.totalBytes / 1024 / 1024} MB needed.")

        val temporary = File(root, "${index.id}.tmp")
        temporary.deleteRecursively()
        if (!temporary.mkdirs())
            throw IllegalStateException("Could not create ${temporary.absolutePath}")

        val base = URI(result.manifest.indexUrl).resolve(".")
        val reusePaths = result.plan.reuse.mapTo(HashSet()) { it.path }
        val basePath = activePath().orEmpty()

        var received = 0L
        var lastNotified = 0L
        val total = result.plan.bytes
        onProgress(0L, total, "prepare")

        fun advance(bytes: Long) {
            received += bytes
            if (received - lastNotified >= 256 * 1024 || received >= total) {
                lastNotified = received
                onProgress(received, total, "download")
            }
        }

        try {
            for (entry in index.files) {
                val destination = File(temporary, entry.path)
                destination.parentFile?.mkdirs()

                if (entry.path in reusePaths) {
                    try {
                        openRunning(basePath, entry.path).use { input ->
                            FileOutputStream(destination).use { output -> input.copyTo(output) }
                        }
                        continue
                    }
                    catch (_: Exception) {
                        // The running copy is unreadable. Download this file instead of failing the whole bundle.
                        destination.delete()
                    }
                }

                download(entry, base, destination, ::advance)
            }

            File(temporary, INDEX_FILE).writeBytes(index.raw)

            if (!temporary.renameTo(target)) {
                target.deleteRecursively()
                if (!temporary.renameTo(target))
                    throw IllegalStateException("Could not move the bundle into ${target.absolutePath}")
            }
        }
        catch (error: Exception) {
            temporary.deleteRecursively()
            throw error
        }

        prefs.edit().putLong(KEY_STAGED_ID, index.id).apply()
        onProgress(total, total, "done")
        return target
    }

    /** Makes the bundle run now. Returns the directory that Capacitor must serve. */
    fun activate(id: Long): String {
        val directory = File(root, id.toString())
        if (!directory.isDirectory)
            throw IllegalStateException("Download the update before applying it.")

        val activePath = prefs.getString(KEY_ACTIVE_PATH, "").orEmpty()
        prefs.edit()
            .putString(KEY_PREVIOUS_PATH, activePath)
            .putString(KEY_PREVIOUS_ID, prefs.getString(KEY_ACTIVE_ID, "").orEmpty())
            .putString(KEY_ACTIVE_PATH, directory.absolutePath)
            .putString(KEY_ACTIVE_ID, id.toString())
            .putLong(KEY_PENDING_ID, id)
            .remove(KEY_STAGED_ID)
            .apply()

        val path = directory.absolutePath
        writeServerBasePath(path)
        return path
    }

    /** The page of the running bundle came up, so the launcher keeps it and the bundle before it can go. */
    fun markHealthy() {
        if (prefs.getLong(KEY_PENDING_ID, 0L) <= 0L)
            return

        val previous = prefs.getString(KEY_PREVIOUS_PATH, "").orEmpty()
        prefs.edit()
            .remove(KEY_PENDING_ID)
            .remove(KEY_PREVIOUS_PATH)
            .remove(KEY_PREVIOUS_ID)
            .apply()

        // A confirmed bundle needs no rollback copy. Losing the current one falls back to the APK instead.
        if (previous.isNotEmpty())
            File(previous).deleteRecursively()
    }

    fun activatable(id: Long): Boolean = File(root, id.toString()).isDirectory

    private fun promoteStaged() {
        val stagedId = prefs.getLong(KEY_STAGED_ID, 0L)
        if (stagedId <= 0L)
            return

        val directory = File(root, stagedId.toString())
        if (!directory.isDirectory) {
            prefs.edit().remove(KEY_STAGED_ID).apply()
            return
        }

        prefs.edit()
            .putString(KEY_PREVIOUS_PATH, prefs.getString(KEY_ACTIVE_PATH, ""))
            .putString(KEY_PREVIOUS_ID, prefs.getString(KEY_ACTIVE_ID, ""))
            .putString(KEY_ACTIVE_PATH, directory.absolutePath)
            .putString(KEY_ACTIVE_ID, stagedId.toString())
            .putLong(KEY_PENDING_ID, stagedId)
            .remove(KEY_STAGED_ID)
            .apply()

        writeServerBasePath(directory.absolutePath)
    }

    private fun prune() {
        val keep = HashSet<String>()
        prefs.getString(KEY_ACTIVE_PATH, "").orEmpty().takeIf(String::isNotEmpty)?.let { keep += File(it).name }
        prefs.getString(KEY_PREVIOUS_PATH, "").orEmpty().takeIf(String::isNotEmpty)?.let { keep += File(it).name }
        prefs.getLong(KEY_STAGED_ID, 0L).takeIf { it > 0L }?.let { keep += it.toString() }

        root.listFiles()?.forEach { entry ->
            if (entry.name !in keep)
                entry.deleteRecursively()
        }
    }

    private fun clearState() {
        prefs.edit()
            .remove(KEY_ACTIVE_PATH)
            .remove(KEY_ACTIVE_ID)
            .remove(KEY_PREVIOUS_PATH)
            .remove(KEY_PREVIOUS_ID)
            .remove(KEY_PENDING_ID)
            .remove(KEY_STAGED_ID)
            .remove(KEY_FAILED_ID)
            .apply()
    }

    private fun activePath(): String? {
        val path = prefs.getString(KEY_ACTIVE_PATH, "").orEmpty()
        if (path.isEmpty())
            return null
        return if (File(path).isDirectory) path else null
    }

    private fun writeServerBasePath(path: String) {
        context.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(WebView.CAP_SERVER_PATH, path)
            .apply()
    }

    private fun planFor(index: RemoteIndex, current: State): Plan {
        val local = (if (current.source == "downloaded")
            readIndex(File(current.basePath, INDEX_FILE))
        else
            readBuiltinIndex())
            ?.files
            ?.associateBy { it.path }
            .orEmpty()

        val reuse = ArrayList<FileEntry>(index.files.size)
        val missing = ArrayList<FileEntry>()
        for (entry in index.files) {
            if (local[entry.path]?.sha256 == entry.sha256)
                reuse += entry
            else
                missing += entry
        }
        return Plan(reuse, missing)
    }

    private fun readIndex(file: File): RemoteIndex? {
        if (!file.isFile)
            return null
        return try {
            parseIndex(file.readBytes())
        }
        catch (_: Exception) {
            null
        }
    }

    private fun readBuiltinIndex(): RemoteIndex? {
        return try {
            context.assets.open("$ASSET_ROOT/$INDEX_FILE").use { parseIndex(it.readBytes()) }
        }
        catch (_: Exception) {
            null
        }
    }

    private fun parseIndex(raw: ByteArray): RemoteIndex {
        val json = JSONObject(String(raw, Charsets.UTF_8))
        val entries = json.optJSONArray("files") ?: JSONArray()
        val files = ArrayList<FileEntry>(entries.length())
        for (position in 0 until entries.length()) {
            val entry = entries.getJSONObject(position)
            files += FileEntry(
                path = entry.getString("path"),
                sha256 = entry.optString("sha256").lowercase(),
                size = entry.optLong("size"),
            )
        }
        return RemoteIndex(
            id = json.optLong("id"),
            versionName = json.optString("versionName"),
            files = files,
            raw = raw,
        )
    }

    private fun fetchManifest(manifestUrl: String): Manifest {
        val body = get(manifestUrl)
        val json = JSONObject(String(body, Charsets.UTF_8))
        val bundle = json.optJSONObject("bundle")
            ?: throw IllegalStateException("The update manifest has no bundle.")

        val indexUrl = bundle.optString("indexUrl")
        if (indexUrl.isEmpty())
            throw IllegalStateException("The update manifest has no bundle index.")

        return Manifest(
            id = bundle.optLong("id"),
            versionName = bundle.optString("versionName"),
            nativeVersion = bundle.optInt("nativeVersion", 0),
            indexUrl = URI(manifestUrl).resolve(indexUrl).toString(),
            signature = bundle.optString("signature"),
            notes = bundle.optString("notes"),
            publishedAt = bundle.optString("publishedAt"),
        )
    }

    private fun fetchIndex(manifest: Manifest): RemoteIndex {
        val raw = get(manifest.indexUrl)
        if (!verify(raw, manifest.signature))
            throw IllegalStateException("The bundle index failed its signature check.")

        val index = parseIndex(raw)
        if (index.id != manifest.id)
            throw IllegalStateException("The bundle index belongs to another release.")
        if (index.files.isEmpty())
            throw IllegalStateException("The bundle index lists no files.")
        return index
    }

    private fun verify(raw: ByteArray, signature: String): Boolean {
        if (signature.isEmpty())
            return false
        return try {
            val key = KeyFactory.getInstance("RSA")
                .generatePublic(X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)))
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(key)
            verifier.update(raw)
            verifier.verify(Base64.decode(signature, Base64.DEFAULT))
        }
        catch (_: Exception) {
            false
        }
    }

    private fun get(url: String): ByteArray {
        val request = Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful)
                throw IllegalStateException("Request failed: HTTP ${response.code} for $url")
            return response.body?.bytes() ?: throw IllegalStateException("Empty response for $url")
        }
    }

    private fun download(entry: FileEntry, base: URI, target: File, onBytes: (Long) -> Unit) {
        val request = Request.Builder().url(resolve(base, entry.path)).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful)
                throw IllegalStateException("Download failed: HTTP ${response.code} for ${entry.path}")
            val body = response.body ?: throw IllegalStateException("Empty download for ${entry.path}")
            val digest = MessageDigest.getInstance("SHA-256")

            body.byteStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0)
                            break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        onBytes(read.toLong())
                    }
                }
            }

            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (entry.sha256.isNotEmpty() && !actual.equals(entry.sha256, ignoreCase = true)) {
                target.delete()
                throw IllegalStateException("SHA-256 mismatch for ${entry.path}")
            }
        }
    }

    private fun openRunning(basePath: String, path: String): InputStream {
        return if (basePath.isEmpty())
            context.assets.open("$ASSET_ROOT/$path")
        else
            File(basePath, path).inputStream()
    }

    private fun resolve(base: URI, path: String): String {
        val encoded = path.split('/').joinToString("/") { segment ->
            URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        }
        return base.resolve(encoded).toString()
    }
}
