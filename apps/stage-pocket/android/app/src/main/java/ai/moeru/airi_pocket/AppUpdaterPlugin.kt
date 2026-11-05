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
            activity.startActivity(intent)

            val result = JSObject()
            result.put("launched", true)
            call.resolve(result)
        }
        catch (error: Exception) {
            call.reject(error.message ?: "Could not start the package installer.", error)
        }
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