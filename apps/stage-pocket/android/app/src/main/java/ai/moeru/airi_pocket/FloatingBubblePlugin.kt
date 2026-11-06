package ai.moeru.airi_pocket

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.widget.Toast

import androidx.activity.result.ActivityResult

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

import java.util.Locale

/**
 * Opens the permissions of the floating bubble and carries its captures and voice transcripts to the WebView.
 *
 * Use when:
 * - The settings page turns the bubble on or off.
 * - The bubble service has a screenshot or a transcript for the active chat turn.
 *
 * Expects:
 * - The owner grants "display over other apps", the screen capture consent once per app run, and microphone access.
 * - The WebView registers its listeners before a tap or a hold, which `ready` reports.
 *
 * The service holds the projection, so a tap never opens another consent dialog.
 */
@CapacitorPlugin(name = "FloatingBubble")
class FloatingBubblePlugin : Plugin() {
    companion object {
        private const val TAG = "FloatingBubblePlugin"
        /** A capture waits this long for a WebView that is still loading its page. */
        private const val PENDING_CAPTURE_TTL_MS = 120_000L

        @Volatile
        var instance: FloatingBubblePlugin? = null
            private set

        private val pendingLock = Any()
        private var pendingCapture: String? = null
        private var pendingSince = 0L
        private var pendingTranscript: String? = null
        private var pendingTranscriptSince = 0L

        /**
         * Keeps a capture until the WebView asks for it. The caller also opens the app when no activity exists,
         * because the WebView cannot read a capture without one.
         */
        fun holdCapture(context: Context, dataUrl: String, openActivity: Boolean) {
            synchronized(pendingLock) {
                pendingCapture = dataUrl
                pendingSince = SystemClock.elapsedRealtime()
            }
            if (openActivity)
                openAppForPending(context)
        }

        /** Keeps a transcript until the WebView asks for it, for the same reason as a capture. */
        fun holdTranscript(context: Context, text: String, openActivity: Boolean) {
            synchronized(pendingLock) {
                pendingTranscript = text
                pendingTranscriptSince = SystemClock.elapsedRealtime()
            }
            if (openActivity)
                openAppForPending(context)
        }

        private fun openAppForPending(context: Context) {
            val intent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            try {
                context.startActivity(intent)
            }
            catch (error: Exception) {
                Log.w(TAG, "Could not open the app for a pending bubble message", error)
            }
        }

        private fun takePendingCapture(): String? {
            synchronized(pendingLock) {
                val fresh = SystemClock.elapsedRealtime() - pendingSince <= PENDING_CAPTURE_TTL_MS
                val dataUrl = if (fresh) pendingCapture else null
                pendingCapture = null
                pendingSince = 0L
                return dataUrl
            }
        }

        private fun takePendingTranscript(): String? {
            synchronized(pendingLock) {
                val fresh = SystemClock.elapsedRealtime() - pendingTranscriptSince <= PENDING_CAPTURE_TTL_MS
                val text = if (fresh) pendingTranscript else null
                pendingTranscript = null
                pendingTranscriptSince = 0L
                return text
            }
        }
    }

    /** Whether the WebView installed its capture and transcript listeners. */
    @Volatile
    private var listenerReady = false

    override fun load() {
        instance = this
    }

    override fun handleOnDestroy() {
        listenerReady = false
        FloatingBubbleService.instance?.stopWatching()
        if (instance === this)
            instance = null
        super.handleOnDestroy()
    }

    /** Reports what the settings page can offer. Undenied permissions stay false. */
    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(statusObject())
    }

    /**
     * Stores the wake word phrases and switch. The service applies them at once when it runs, and reads them at the
     * next start when it does not.
     */
    @PluginMethod
    fun setWakeWord(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        val rawPhrases = call.getArray("phrases")
        val phrases = buildList {
            if (rawPhrases != null) {
                for (index in 0 until rawPhrases.length()) {
                    val value = try {
                        rawPhrases.getString(index)
                    }
                    catch (error: Exception) {
                        null
                    }
                    value?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
                }
            }
        }.distinct().take(WakeWordSettings.MAX_PHRASES)

        if (enabled && phrases.isEmpty()) {
            call.reject(context.getString(R.string.floating_bubble_wake_word_missing))
            return
        }
        if (phrases.any { it.length > WakeWordSettings.MAX_PHRASE_CHARS }) {
            call.reject(context.getString(R.string.floating_bubble_wake_word_too_long))
            return
        }

        val language = call.getString("language")
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: Locale.getDefault().toLanguageTag()
        val config = WakeWordConfig(enabled, phrases, language)
        WakeWordSettings.write(context, config)
        FloatingBubbleService.instance?.reloadWakeWordSettings()
        call.resolve(statusObject())
    }

    /** Pauses the wake loop while AIRI speaks, so the microphone does not hear her own voice. */
    @PluginMethod
    fun setWakeWordSpeaking(call: PluginCall) {
        val speaking = call.getBoolean("speaking") ?: false
        FloatingBubbleService.instance?.setWakeWordSpeaking(speaking)
        call.resolve()
    }

    /** Starts the companion frame loop on the bubble's MediaProjection session. */
    @PluginMethod
    fun startWatching(call: PluginCall) {
        val service = FloatingBubbleService.instance
        if (service == null || !FloatingBubbleService.isRunning || !FloatingBubbleService.hasProjection) {
            call.reject(context.getString(R.string.floating_bubble_watch_unavailable))
            return
        }

        val interval = (call.getInt("intervalMs") ?: 30_000).coerceAtLeast(15_000)
        service.startWatching(interval.toLong())
        call.resolve(JSObject().put("watching", true))
    }

    @PluginMethod
    fun stopWatching(call: PluginCall) {
        FloatingBubbleService.instance?.stopWatching()
        call.resolve()
    }

    private fun statusObject(): JSObject {
        val service = FloatingBubbleService.instance
        val config = service?.wakeWordConfig ?: WakeWordSettings.read(context)
        val state = service?.wakeWordState ?: WakeWordListener.State.STOPPED
        val phrases = JSArray()
        config.phrases.forEach { phrase -> phrases.put(phrase) }

        return JSObject().apply {
            put("supported", true)
            put("overlayPermission", Settings.canDrawOverlays(context))
            put("running", FloatingBubbleService.isRunning)
            put("projection", FloatingBubbleService.hasProjection)
            put(
                "microphonePermission",
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
            )
            put("wakeWordEnabled", config.enabled)
            put("wakeWordState", state.name.lowercase(Locale.ROOT))
            put(
                "wakeWordListening",
                state == WakeWordListener.State.LISTENING || state == WakeWordListener.State.COMMAND,
            )
            put("wakeWordPhrases", phrases)
            service?.wakeWordErrorResId?.let { put("wakeWordError", context.getString(it)) }
            put("watching", service?.isWatching() == true)
        }
    }

    /** Marks the WebView ready, after it added its capture and transcript listeners. */
    @PluginMethod
    fun ready(call: PluginCall) {
        listenerReady = true
        call.resolve()
    }

    /** Opens the two permission screens, then starts the bubble service. */
    @PluginMethod
    fun start(call: PluginCall) {
        if (FloatingBubbleService.isRunning && FloatingBubbleService.hasProjection) {
            call.resolve(JSObject().put("running", true))
            return
        }

        if (!Settings.canDrawOverlays(context)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            )
            startActivityForResult(call, intent, "overlayPermission")
            return
        }

        requestProjection(call)
    }

    /** Removes the bubble and the projection session. */
    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, FloatingBubbleService::class.java))
        synchronized(pendingLock) {
            pendingCapture = null
            pendingSince = 0L
            pendingTranscript = null
            pendingTranscriptSince = 0L
        }
        call.resolve()
    }

    /** Shows one short message over other apps, so a failed capture does not stay silent. */
    @PluginMethod
    fun toast(call: PluginCall) {
        val text = call.getString("text")?.trim().orEmpty()
        if (text.isNotEmpty()) {
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(context, text, Toast.LENGTH_LONG).show()
            }
        }
        call.resolve()
    }

    /** Returns one capture that arrived before the WebView could take it. */
    @PluginMethod
    fun consumePendingCapture(call: PluginCall) {
        val result = JSObject()
        takePendingCapture()?.let { dataUrl -> result.put("dataUrl", dataUrl) }
        call.resolve(result)
    }

    /** Returns one transcript that arrived before the WebView could take it. */
    @PluginMethod
    fun consumePendingTranscript(call: PluginCall) {
        val result = JSObject()
        takePendingTranscript()?.let { text -> result.put("text", text) }
        call.resolve(result)
    }

    /** Sends one capture to the active turn. A missing listener keeps it for `consumePendingCapture`. */
    fun deliverCapture(dataUrl: String) {
        val currentActivity = activity
        if (currentActivity == null || !listenerReady) {
            holdCapture(context, dataUrl, openActivity = currentActivity == null)
            return
        }

        Handler(Looper.getMainLooper()).post {
            if (!listenerReady) {
                holdCapture(context, dataUrl, openActivity = activity == null)
                return@post
            }
            notifyListeners("capture", JSObject().put("dataUrl", dataUrl))
        }
    }

    /** Sends one transcript to the active turn. A missing listener keeps it for `consumePendingTranscript`. */
    fun deliverTranscript(text: String) {
        val currentActivity = activity
        if (currentActivity == null || !listenerReady) {
            holdTranscript(context, text, openActivity = currentActivity == null)
            return
        }

        Handler(Looper.getMainLooper()).post {
            if (!listenerReady) {
                holdTranscript(context, text, openActivity = activity == null)
                return@post
            }
            notifyListeners("transcript", JSObject().put("text", text))
        }
    }

    /** Sends one watch frame to the WebView. A missing listener drops it, because a later frame replaces it. */
    fun deliverWatchFrame(dataUrl: String, hash: String) {
        if (activity == null || !listenerReady)
            return

        Handler(Looper.getMainLooper()).post {
            if (!listenerReady || activity == null)
                return@post
            notifyListeners(
                "watchFrame",
                JSObject().put("dataUrl", dataUrl).put("hash", hash),
            )
        }
    }

    private fun requestProjection(call: PluginCall) {
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        // Android 14 can capture one app instead of the display. The bubble always reads the whole screen.
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        }
        else {
            manager.createScreenCaptureIntent()
        }
        startActivityForResult(call, intent, "projectionPermission")
    }

    @ActivityCallback
    private fun overlayPermission(call: PluginCall?, result: ActivityResult) {
        if (call == null)
            return
        if (!Settings.canDrawOverlays(context)) {
            call.reject(context.getString(R.string.floating_bubble_overlay_denied))
            return
        }
        requestProjection(call)
    }

    @ActivityCallback
    private fun projectionPermission(call: PluginCall?, result: ActivityResult) {
        if (call == null)
            return

        val consent = result.data
        if (result.resultCode != Activity.RESULT_OK || consent == null) {
            call.reject(context.getString(R.string.floating_bubble_capture_denied))
            return
        }

        val intent = Intent(context, FloatingBubbleService::class.java).apply {
            action = FloatingBubbleService.ACTION_START
            putExtra(FloatingBubbleService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(FloatingBubbleService.EXTRA_RESULT_DATA, consent)
        }

        try {
            context.startForegroundService(intent)
        }
        catch (error: Exception) {
            call.reject(error.message ?: context.getString(R.string.floating_bubble_start_failed), error)
            return
        }

        // The service creates its bubble on the main thread. Report the state after it had that time.
        Handler(Looper.getMainLooper()).postDelayed({
            call.resolve(JSObject().put("running", FloatingBubbleService.isRunning))
        }, 400)
    }
}