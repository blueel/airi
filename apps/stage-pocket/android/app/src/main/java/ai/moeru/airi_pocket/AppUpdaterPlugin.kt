package ai.moeru.airi_pocket

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings

import androidx.core.content.FileProvider

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import okhttp3.OkHttpClient
import okhttp3.Request

import org.json.JSONObject

import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Checks a self-hosted update manifest and installs the downloaded APK.
 *
 * The app is served from `https://localhost`, so the WebView blocks plain HTTP
 * update endpoints as mixed content. Native HTTP avoids that policy and can
 * hand the APK to Android's package installer.
 */
@CapacitorPlugin(name = "AppUpdater")
class AppUpdaterPlugin : Plugin() {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    private val executor = Executors.newSingleThreadExecutor()

    private val bundles by lazy { BundleUpdater(context, client) { versionCode() } }

    /**
     * Runs before Capacitor restores the stored page directory, so a bundle that never came up is dropped before the
     * WebView loads it.
     */
    override fun load() {
        bundles.guardAtBoot()
    }

    private fun packageInfo() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    }
    else {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0)
    }

    private fun versionCode() = packageInfo().let { info ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
            info.longVersionCode
        else
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
    }

    private fun downloadFile(): File = File(File(context.cacheDir, "updates"), "airi-update.apk")

    @PluginMethod
    fun getVersion(call: PluginCall) {
        val result = JSObject()
        result.put("versionCode", versionCode())
        result.put("versionName", packageInfo().versionName ?: "")
        call.resolve(result)
    }

    /** Reports whether Android lets this app open the package installer. */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
        call.resolve(JSObject().put("canInstall", allowed))
    }

    /** Reports whether the owner enabled the accessibility service that taps the install button. */
    @PluginMethod
    fun autoInstallStatus(call: PluginCall) {
        call.resolve(JSObject().put("accessibilityEnabled", isAccessibilityServiceEnabled()))
    }

    /** Opens the accessibility settings list, where the owner enables AIRI's auto-install service. */
    @PluginMethod
    fun openAccessibilitySettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        call.resolve()
    }

    /** Opens the app info screen, where Android 13 and later allow restricted settings for a sideloaded app. */
    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun check(call: PluginCall) {
        val manifestUrl = call.getString("url")?.trim().orEmpty()
        if (manifestUrl.isEmpty()) {
            call.reject("The update manifest URL is empty.")
            return
        }

        executor.execute {
            try {
                val request = Request.Builder().url(manifestUrl).build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        call.reject("Update manifest request failed: HTTP ${response.code}")
                        return@use
                    }
                    val body = response.body?.string().orEmpty()
                    val manifest = JSONObject(body)
                    val latestCode = manifest.optLong("versionCode", -1)
                    if (latestCode < 0) {
                        call.reject("The update manifest has no versionCode.")
                        return@use
                    }

                    val currentCode = versionCode()
                    val latest = JSObject()
                    latest.put("versionCode", latestCode)
                    latest.put("versionName", manifest.optString("versionName", ""))
                    val apkUrl = manifest.optString("url", "")
                    latest.put("url", if (apkUrl.isEmpty()) "" else URI(manifestUrl).resolve(apkUrl).toString())
                    latest.put("sha256", manifest.optString("sha256", ""))
                    latest.put("size", manifest.optLong("size", 0))
                    latest.put("notes", manifest.optString("notes", ""))
                    latest.put("publishedAt", manifest.optString("publishedAt", ""))

                    val current = JSObject()
                    current.put("versionCode", currentCode)
                    current.put("versionName", packageInfo().versionName ?: "")

                    val result = JSObject()
                    result.put("updateAvailable", latestCode > currentCode)
                    result.put("current", current)
                    result.put("latest", latest)
                    call.resolve(result)
                }
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Failed to check for updates.", error)
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        val expectedSha256 = call.getString("sha256")?.trim()?.lowercase().orEmpty()
        if (url.isEmpty()) {
            call.reject("The update URL is empty.")
            return
        }

        executor.execute {
            val target = downloadFile()
            try {
                target.parentFile?.mkdirs()
                if (target.exists() && !target.delete())
                    throw IllegalStateException("Could not remove the previous update file.")

                val request = Request.Builder().url(url).build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful)
                        throw IllegalStateException("Update download failed: HTTP ${response.code}")
                    val body = response.body ?: throw IllegalStateException("The update response is empty.")
                    val total = body.contentLength()
                    val digest = MessageDigest.getInstance("SHA-256")
                    var received = 0L
                    var lastNotified = 0L

                    body.byteStream().use { input ->
                        FileOutputStream(target).use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0)
                                    break
                                output.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                                received += read
                                if (received - lastNotified >= 256 * 1024) {
                                    lastNotified = received
                                    notifyProgress(received, total)
                                }
                            }
                        }
                    }

                    notifyProgress(received, total)

                    val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                    if (expectedSha256.isNotEmpty() && actualSha256 != expectedSha256) {
                        target.delete()
                        throw IllegalStateException("The downloaded file failed its SHA-256 check.")
                    }

                    val result = JSObject()
                    result.put("path", target.absolutePath)
                    result.put("bytes", received)
                    result.put("sha256", actualSha256)
                    call.resolve(result)
                }
            }
            catch (error: Exception) {
                target.delete()
                call.reject(error.message ?: "Failed to download the update.", error)
            }
        }
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val target = downloadFile()
        if (!target.isFile) {
            call.reject("Download the update before installing it.")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(settingsIntent)
            val result = JSObject()
            result.put("launched", false)
            result.put("needsPermission", true)
            call.resolve(result)
            return
        }

        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // The accessibility service may tap the confirmation for this short window only.
            InstallGate.arm(context)
            activity.startActivity(intent)

            val result = JSObject()
            result.put("launched", true)
            call.resolve(result)
        }
        catch (error: Exception) {
            call.reject(error.message ?: "Could not start the package installer.", error)
        }
    }

    /** Reports which page directory runs: the one in the APK, or a bundle that arrived over the air. */
    @PluginMethod
    fun getBundleState(call: PluginCall) {
        executor.execute {
            try {
                call.resolve(bundleStateObject(bundles.state()))
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Could not read the bundle state.", error)
            }
        }
    }

    /**
     * Compares the signed bundle index on the release tunnel with the files this install has, and reports how much a
     * sync would download. It changes nothing on disk.
     */
    @PluginMethod
    fun checkBundle(call: PluginCall) {
        val manifestUrl = call.getString("url")?.trim().orEmpty()
        if (manifestUrl.isEmpty()) {
            call.reject("The update manifest URL is empty.")
            return
        }

        executor.execute {
            try {
                val result = bundles.check(manifestUrl)
                val latest = JSObject()
                latest.put("id", result.index.id)
                latest.put("versionName", result.index.versionName)
                latest.put("nativeVersion", result.manifest.nativeVersion)
                latest.put("notes", result.manifest.notes)
                latest.put("publishedAt", result.manifest.publishedAt)
                latest.put("size", result.index.totalBytes)

                val plan = JSObject()
                plan.put("files", result.plan.missing.size)
                plan.put("bytes", result.plan.bytes)
                plan.put("total", result.index.files.size)

                val payload = JSObject()
                payload.put("available", result.reason == BundleUpdater.REASON_AVAILABLE)
                payload.put("reason", result.reason)
                payload.put("current", bundleStateObject(bundles.state()))
                payload.put("latest", latest)
                payload.put("plan", plan)
                call.resolve(payload)
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Failed to check for a page update.", error)
            }
        }
    }

    /**
     * Downloads the missing files into a new directory and stages it. The next start runs it, so an update never
     * reloads the page under the owner.
     */
    @PluginMethod
    fun syncBundle(call: PluginCall) {
        val manifestUrl = call.getString("url")?.trim().orEmpty()
        val id = call.data?.optLong("id", 0L) ?: 0L
        if (manifestUrl.isEmpty() || id <= 0L) {
            call.reject("The bundle URL or release id is empty.")
            return
        }

        executor.execute {
            try {
                val directory = bundles.stage(manifestUrl, id) { received, total, phase ->
                    notifyBundleProgress(received, total, phase)
                }
                val result = JSObject()
                result.put("id", id)
                result.put("path", directory.absolutePath)
                call.resolve(result)
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Failed to download the page update.", error)
            }
        }
    }

    /** Switches to a downloaded bundle now. The page reloads into it. */
    @PluginMethod
    fun applyBundle(call: PluginCall) {
        val id = call.data?.optLong("id", 0L) ?: 0L
        if (id <= 0L) {
            call.reject("The release id is empty.")
            return
        }

        executor.execute {
            try {
                val path = bundles.activate(id)
                activity?.runOnUiThread {
                    bridge?.setServerBasePath(path)
                }
                call.resolve(JSObject().put("applied", true))
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Failed to apply the page update.", error)
            }
        }
    }

    /**
     * The page of the running bundle reached its mount point, so the next start keeps it. Without this call the next
     * start goes back to the bundle before it.
     */
    @PluginMethod
    fun markBundleHealthy(call: PluginCall) {
        executor.execute {
            try {
                bundles.markHealthy()
                call.resolve()
            }
            catch (error: Exception) {
                call.reject(error.message ?: "Failed to report the page state.", error)
            }
        }
    }

    private fun bundleStateObject(state: BundleUpdater.State): JSObject {
        val payload = JSObject()
        payload.put("id", state.id)
        payload.put("versionName", state.versionName)
        payload.put("source", state.source)
        payload.put("basePath", state.basePath)
        payload.put("pending", state.pending)
        return payload
    }

    private fun notifyBundleProgress(received: Long, total: Long, phase: String) {
        val payload = JSObject()
        payload.put("received", received)
        payload.put("total", total)
        payload.put("phase", phase)
        activity?.runOnUiThread {
            notifyListeners("bundleProgress", payload)
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = "${context.packageName}/${InstallAccessibilityService::class.java.name}"
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    private fun notifyProgress(received: Long, total: Long) {
        val payload = JSObject()
        payload.put("received", received)
        payload.put("total", total)
        activity.runOnUiThread {
            notifyListeners("downloadProgress", payload)
        }
    }
}