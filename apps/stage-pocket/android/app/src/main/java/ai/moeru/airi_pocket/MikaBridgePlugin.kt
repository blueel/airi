package ai.moeru.airi_pocket

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Sends plain HTTP requests to the Mika app on this phone.
 *
 * Mika rejects every request that carries an `Origin` header. A WebView fetch
 * always adds one, so the WebView cannot reach Mika directly. This native
 * transport sends the request through OkHttp, which adds no such header.
 *
 * The WebView only loads AIRI's own code, so the bridge accepts any HTTP or
 * HTTPS address that the settings page provides.
 */
@CapacitorPlugin(name = "MikaBridge")
class MikaBridgePlugin : Plugin() {
    private val executor = Executors.newCachedThreadPool()
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        if (url.isEmpty()) {
            call.reject("The request URL is empty.")
            return
        }

        val scheme = runCatching { URI(url).scheme?.lowercase() }.getOrNull()
        if (scheme != "http" && scheme != "https") {
            call.reject("The request URL must use HTTP or HTTPS.")
            return
        }

        val method = (call.getString("method") ?: "GET").uppercase()
        if (method != "GET" && method != "POST") {
            call.reject("Unsupported request method: $method")
            return
        }

        val body = call.getString("body")
        val timeoutMs = (call.getInt("timeoutMs")?.toLong() ?: 20_000L).coerceIn(1_000L, 120_000L)
        val headers = call.getObject("headers")

        executor.execute {
            try {
                val builder = Request.Builder().url(url)

                headers?.keys()?.forEach { key ->
                    // OkHttp sets these itself, and Mika rejects Origin on purpose.
                    if (key.equals("origin", true)
                        || key.equals("host", true)
                        || key.equals("content-length", true)
                        || key.equals("transfer-encoding", true)
                        || key.equals("connection", true)
                    ) {
                        return@forEach
                    }
                    headers.getString(key)?.let { value -> builder.header(key, value) }
                }

                when (method) {
                    "GET" -> builder.get()
                    "POST" -> builder.post((body ?: "{}").toRequestBody())
                }

                val requestClient = client.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()

                requestClient.newCall(builder.build()).execute().use { response ->
                    val text = response.body?.string().orEmpty()
                    val result = JSObject()
                    result.put("status", response.code)

                    val responseHeaders = JSObject()
                    response.headers.names().forEach { name ->
                        responseHeaders.put(name, response.headers.get(name))
                    }
                    result.put("headers", responseHeaders)
                    result.put("body", if (text.length > MAX_RESPONSE_CHARS) text.substring(0, MAX_RESPONSE_CHARS) else text)

                    call.resolve(result)
                }
            }
            catch (error: Exception) {
                call.reject(error.message ?: "The Mika request failed.", error)
            }
        }
    }

    override fun handleOnDestroy() {
        executor.shutdownNow()
        super.handleOnDestroy()
    }

    private companion object {
        // Mika task snapshots are small. This cap only stops a wrong address from filling the WebView heap.
        const val MAX_RESPONSE_CHARS = 2 * 1024 * 1024
    }
}