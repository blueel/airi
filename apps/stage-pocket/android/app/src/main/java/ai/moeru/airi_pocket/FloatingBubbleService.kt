package ai.moeru.airi_pocket

import android.Manifest
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Outline
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keeps a small bubble over other apps and captures the screen when the owner taps it.
 *
 * The service runs in the foreground because Android ties a MediaProjection session to a foreground service of type
 * `mediaProjection`. The projection consent comes from the plugin, so this service never asks for it. A capture sends
 * a JPEG data URL to the WebView, which starts a normal chat turn and speaks the reply.
 *
 * The bubble stays while the Activity is stopped, so AIRI keeps working in the background. A swipe away from the task
 * stops the service, and the bubble leaves with it.
 */
class FloatingBubbleService : Service() {
    companion object {
        const val ACTION_START = "ai.moeru.airi_pocket.floating.START"
        const val ACTION_STOP = "ai.moeru.airi_pocket.floating.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        /** Whether the service holds a bubble. The plugin reports this to the settings page. */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** Whether a MediaProjection session is open. A revoked session stops the service. */
        @Volatile
        var hasProjection: Boolean = false
            private set

        private const val TAG = "FloatingBubbleService"
        private const val CHANNEL_ID = "floating_bubble"
        private const val NOTIFICATION_ID = 4102
        private const val BUBBLE_SIZE_DP = 58
        private const val BUBBLE_MARGIN_DP = 10
        private const val BUBBLE_SNAP_THRESHOLD_DP = 28
        private const val BUBBLE_SNAP_DURATION_MS = 180L
        private const val BUBBLE_FADE_DURATION_MS = 140L
        private const val BUBBLE_TAP_FLASH_DURATION_MS = 200L
        private const val BUBBLE_TAP_HIDE_DELAY_MS = 120L
        private const val BUBBLE_LONG_PRESS_MS = 450L
        private const val VOICE_MAX_DURATION_MS = 30_000L
        private const val VOICE_PULSE_DURATION_MS = 650L
        private const val VOICE_ALPHA_MIN = 0.16f
        private const val VOICE_ALPHA_MAX = 0.42f
        private const val BUBBLE_ALPHA_NORMAL = 0.96f
        private const val BUBBLE_ALPHA_SNAPPED = 0.6f
        private const val EDGE_NONE = 0
        private const val EDGE_LEFT = 1
        private const val EDGE_RIGHT = 2
        private const val BUBBLE_SCREEN_FRACTION = 0.62f
        private const val MAX_CAPTURE_SIDE = 1280
        private const val CAPTURE_TIMEOUT_MS = 2_500L
        /** The bubble leaves the frame before the capture, so the screenshot holds only the owner's screen. */
        private const val BUBBLE_HIDE_DELAY_MS = 140L
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val captureExecutor = Executors.newSingleThreadExecutor()
    private val captureThread = HandlerThread("airi-screen-capture").apply { start() }
    private val captureHandler = Handler(captureThread.looper)
    private val capturing = AtomicBoolean(false)

    private var windowManager: WindowManager? = null
    private var bubbleView: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleFlashView: View? = null
    private var bubbleTouchListener: BubbleDragListener? = null
    private var snapAnimator: ValueAnimator? = null
    private var alphaAnimator: ObjectAnimator? = null
    private var listeningAnimator: ObjectAnimator? = null
    private var snappedEdge = EDGE_NONE
    private var speechRecognizer: SpeechRecognizer? = null
    private var voiceTimeout: Runnable? = null
    private var voiceGestureActive = false
    private var voiceHolding = false
    private var voiceListening = false
    private var voiceCancelled = false
    private var voiceResult: String? = null
    private var mediaProjection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private val frameLock = Any()
    private var latestFrame: Image? = null
    private var latestFrameAt = 0L
    private var captureWidth = 0
    private var captureHeight = 0
    private var captureDensity = 0

    /** Cleared before a teardown, so a late frame does not keep a buffer after the reader closes. */
    @Volatile
    private var acceptingFrames = false

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getProjectionData()
        if (resultData == null) {
            Log.w(TAG, "The start request has no screen capture consent")
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundWithProjection()
        startProjection(resultCode, resultData)
        addBubble()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        voiceGestureActive = false
        voiceHolding = false
        voiceResult = null
        voiceListening = false
        clearVoiceTimeout()
        stopListeningFeedback()
        voiceCancelled = true
        try {
            speechRecognizer?.cancel()
        }
        catch (error: Exception) {
            Log.w(TAG, "Could not cancel speech recognition", error)
        }
        speechRecognizer?.destroy()
        speechRecognizer = null
        snapAnimator?.cancel()
        snapAnimator = null
        alphaAnimator?.cancel()
        alphaAnimator = null
        removeBubble()
        stopProjection()
        captureExecutor.shutdownNow()
        captureThread.quitSafely()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)

        val view = bubbleView ?: return
        val params = bubbleParams ?: return
        val metrics = screenMetrics()
        val margin = dp(BUBBLE_MARGIN_DP)
        val maxX = max(margin, metrics.widthPixels - view.width - margin)
        val maxY = max(margin, metrics.heightPixels - view.height - margin)

        params.x = when (snappedEdge) {
            EDGE_LEFT -> margin
            EDGE_RIGHT -> maxX
            else -> params.x.coerceIn(margin, maxX)
        }
        params.y = params.y.coerceIn(margin, maxY)
        updateBubbleLayout(view, params)
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.floating_bubble_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.floating_bubble_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun startForegroundWithProjection() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        }
        else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, FloatingBubbleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_floating_bubble)
            .setContentTitle(getString(R.string.floating_bubble_notification_title))
            .setContentText(getString(R.string.floating_bubble_notification_body))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, getString(R.string.floating_bubble_notification_stop), stopIntent)
            .build()
    }

    private fun startProjection(resultCode: Int, resultData: Intent) {
        stopProjection()
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = try {
            manager.getMediaProjection(resultCode, resultData)
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not open the screen capture session", error)
            null
        }
        if (projection == null) {
            stopSelf()
            return
        }

        // Android 14 requires this callback before any virtual display, and a stop
        // from the system or the notification revokes every later capture.
        val callback = object : MediaProjection.Callback() {
            override fun onStop() {
                Log.w(TAG, "The screen capture session stopped")
                hasProjection = false
                stopSelf()
            }
        }
        projection.registerCallback(callback, mainHandler)
        projectionCallback = callback

        mediaProjection = projection
        hasProjection = true

        if (!ensureCaptureSurface()) {
            stopSelf()
        }
    }

    /**
     * Creates the single virtual display of this projection, or resizes it after a rotation.
     *
     * Android 14 limits each MediaProjection consent to one `createVirtualDisplay` call, so later captures reuse this
     * display and take the newest frame from its reader. A size change resizes and re-surfaces the same display.
     */
    @Synchronized
    private fun ensureCaptureSurface(): Boolean {
        val projection = mediaProjection ?: return false
        val metrics = screenMetrics()
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi
        if (width <= 0 || height <= 0)
            return false

        if (imageReader != null && captureWidth == width && captureHeight == height && captureDensity == density)
            return true

        return try {
            acceptingFrames = false
            imageReader?.setOnImageAvailableListener(null, null)
            synchronized(frameLock) {
                latestFrame?.close()
                latestFrame = null
                latestFrameAt = 0L
            }

            val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            reader.setOnImageAvailableListener({ source ->
                val image = try {
                    source.acquireLatestImage()
                }
                catch (error: Exception) {
                    null
                } ?: return@setOnImageAvailableListener

                synchronized(frameLock) {
                    if (!acceptingFrames) {
                        image.close()
                        return@synchronized
                    }
                    latestFrame?.close()
                    latestFrame = image
                    latestFrameAt = SystemClock.elapsedRealtime()
                }
            }, captureHandler)

            val display = virtualDisplay
            if (display == null) {
                virtualDisplay = projection.createVirtualDisplay(
                    "airi-screen",
                    width,
                    height,
                    density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.surface,
                    null,
                    captureHandler,
                )
            }
            else {
                display.resize(width, height, density)
                display.setSurface(reader.surface)
            }

            val previousReader = imageReader
            imageReader = reader
            captureWidth = width
            captureHeight = height
            captureDensity = density
            acceptingFrames = true
            previousReader?.close()
            true
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not open the screen capture surface", error)
            false
        }
    }

    @Synchronized
    private fun stopProjection() {
        acceptingFrames = false
        // An intentional stop unregisters first, so its callback does not stop the service that replaces it.
        projectionCallback?.let { callback -> mediaProjection?.unregisterCallback(callback) }
        projectionCallback = null
        imageReader?.setOnImageAvailableListener(null, null)
        virtualDisplay?.release()
        virtualDisplay = null
        synchronized(frameLock) {
            latestFrame?.close()
            latestFrame = null
            latestFrameAt = 0L
        }
        imageReader?.close()
        imageReader = null
        captureWidth = 0
        captureHeight = 0
        captureDensity = 0
        try {
            mediaProjection?.stop()
        }
        catch (error: Exception) {
            Log.w(TAG, "The screen capture session was already stopped", error)
        }
        mediaProjection = null
        hasProjection = false
    }

    private fun addBubble() {
        if (bubbleView != null)
            return

        val manager = windowManager ?: return
        val size = dp(BUBBLE_SIZE_DP)
        val metrics = screenMetrics()
        val params = WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = max(0, metrics.widthPixels - size - dp(BUBBLE_MARGIN_DP))
            y = (metrics.heightPixels * BUBBLE_SCREEN_FRACTION).toInt()
        }

        val bubble = createBubbleView(size)
        val listener = BubbleDragListener(params)
        bubbleTouchListener = listener
        bubble.setOnTouchListener(listener)

        try {
            manager.addView(bubble, params)
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not add the floating bubble", error)
            bubbleFlashView = null
            bubbleTouchListener = null
            stopSelf()
            return
        }

        bubbleView = bubble
        bubbleParams = params
        // The bubble starts on the right edge, so it starts in the snapped state.
        bubble.alpha = BUBBLE_ALPHA_SNAPPED
        snappedEdge = EDGE_RIGHT
    }

    private fun removeBubble() {
        val bubble = bubbleView ?: return
        bubbleTouchListener?.cancelLongPress(bubble)
        bubbleTouchListener = null
        snapAnimator?.cancel()
        snapAnimator = null
        alphaAnimator?.cancel()
        alphaAnimator = null
        bubbleView = null
        bubbleParams = null
        bubbleFlashView = null
        snappedEdge = EDGE_NONE
        try {
            windowManager?.removeView(bubble)
        }
        catch (error: Exception) {
            Log.w(TAG, "Could not remove the floating bubble", error)
        }
    }

    private fun createBubbleView(size: Int): View {
        val ringWidth = dp(2)
        val ring = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            gradientType = GradientDrawable.LINEAR_GRADIENT
            orientation = GradientDrawable.Orientation.TL_BR
            colors = intArrayOf(0xFFFFE9E2.toInt(), 0xFFFFC9B8.toInt())
            setStroke(ringWidth, 0xFFFF7A59.toInt())
        }

        val container = FrameLayout(this).apply {
            background = ring
            elevation = dp(6).toFloat()
            contentDescription = getString(R.string.floating_bubble_notification_title)
        }

        val iconFrame = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.WHITE)
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setOval(0, 0, view.width, view.height)
                }
            }
        }
        val icon = ImageView(this).apply {
            setImageDrawable(packageManager.getApplicationIcon(packageName))
            scaleType = ImageView.ScaleType.CENTER_CROP
        }
        iconFrame.addView(icon, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
            Gravity.CENTER,
        ))

        val inset = dp(7)
        container.addView(iconFrame, FrameLayout.LayoutParams(size - inset * 2, size - inset * 2, Gravity.CENTER))

        // A short white flash confirms the tap before the bubble hides for the capture.
        val flash = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.WHITE)
            }
            alpha = 0f
        }
        iconFrame.addView(flash, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        bubbleFlashView = flash

        return container
    }

    /** Moves the bubble to the nearest side when the owner drops it close to that side. */
    private fun settleBubble(view: View, params: WindowManager.LayoutParams, animate: Boolean) {
        val metrics = screenMetrics()
        val margin = dp(BUBBLE_MARGIN_DP)
        val threshold = dp(BUBBLE_SNAP_THRESHOLD_DP)
        val maxX = max(margin, metrics.widthPixels - view.width - margin)
        val leftDistance = params.x
        val rightDistance = metrics.widthPixels - view.width - params.x

        when {
            leftDistance <= threshold -> {
                snappedEdge = EDGE_LEFT
                moveBubble(view, params, margin, animate)
            }

            rightDistance <= threshold -> {
                snappedEdge = EDGE_RIGHT
                moveBubble(view, params, maxX, animate)
            }

            else -> {
                snappedEdge = EDGE_NONE
                fadeBubble(view, BUBBLE_ALPHA_NORMAL)
            }
        }
    }

    private fun moveBubble(view: View, params: WindowManager.LayoutParams, targetX: Int, animate: Boolean) {
        if (params.x == targetX) {
            fadeBubble(view, BUBBLE_ALPHA_SNAPPED)
            return
        }

        if (!animate) {
            params.x = targetX
            updateBubbleLayout(view, params)
            fadeBubble(view, BUBBLE_ALPHA_SNAPPED)
            return
        }

        snapAnimator?.cancel()
        val animator = ValueAnimator.ofInt(params.x, targetX).apply {
            duration = BUBBLE_SNAP_DURATION_MS
            interpolator = DecelerateInterpolator()
            addUpdateListener { animation ->
                params.x = animation.animatedValue as Int
                updateBubbleLayout(view, params)
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (snapAnimator === this@apply) {
                        snapAnimator = null
                        fadeBubble(view, BUBBLE_ALPHA_SNAPPED)
                    }
                }
            })
        }
        snapAnimator = animator
        animator.start()
    }

    private fun fadeBubble(view: View, targetAlpha: Float) {
        if (abs(view.alpha - targetAlpha) < 0.01f)
            return
        alphaAnimator?.cancel()
        alphaAnimator = ObjectAnimator.ofFloat(view, View.ALPHA, view.alpha, targetAlpha).apply {
            duration = BUBBLE_FADE_DURATION_MS
            start()
        }
    }

    private fun updateBubbleLayout(view: View, params: WindowManager.LayoutParams) {
        try {
            windowManager?.updateViewLayout(view, params)
        }
        catch (error: Exception) {
            Log.w(TAG, "Could not move the floating bubble", error)
        }
    }

    private fun playTapFeedback(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        bubbleFlashView?.let { flash ->
            flash.animate().cancel()
            flash.alpha = 0.45f
            flash.animate().alpha(0f).setDuration(BUBBLE_TAP_FLASH_DURATION_MS).start()
        }
    }

    /** Starts hold-to-talk after the owner held the bubble. */
    private fun beginVoiceGesture(view: View) {
        if (voiceGestureActive)
            return

        voiceGestureActive = true
        voiceHolding = true
        voiceResult = null
        voiceCancelled = false
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        fadeBubble(view, BUBBLE_ALPHA_NORMAL)

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            notify(R.string.floating_bubble_microphone_denied)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            notify(R.string.floating_bubble_voice_unavailable)
            return
        }

        val recognizer = ensureSpeechRecognizer() ?: return
        startListeningFeedback()
        voiceListening = true
        try {
            recognizer.startListening(speechRecognizerIntent())
            scheduleVoiceTimeout()
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not start speech recognition", error)
            voiceListening = false
            stopListeningFeedback()
            notify(R.string.floating_bubble_voice_failed)
        }
    }

    /** Stops hold-to-talk on release and sends the transcript when the recognizer has it. */
    private fun endVoiceGesture(view: View, params: WindowManager.LayoutParams) {
        voiceHolding = false
        voiceGestureActive = false

        if (voiceListening) {
            voiceListening = false
            clearVoiceTimeout()
            stopListeningFeedback()
            try {
                speechRecognizer?.stopListening()
            }
            catch (error: Exception) {
                Log.w(TAG, "Could not stop speech recognition", error)
            }
        }
        else {
            val result = voiceResult
            voiceResult = null
            if (!result.isNullOrEmpty())
                deliverVoice(result)
        }

        settleBubble(view, params, animate = false)
    }

    private fun cancelVoiceGesture() {
        voiceGestureActive = false
        voiceHolding = false
        voiceResult = null
        voiceListening = false
        clearVoiceTimeout()
        stopListeningFeedback()
        if (speechRecognizer != null) {
            voiceCancelled = true
            speechRecognizer?.cancel()
        }
    }

    private fun ensureSpeechRecognizer(): SpeechRecognizer? {
        speechRecognizer?.let { return it }
        return try {
            SpeechRecognizer.createSpeechRecognizer(this).also { recognizer ->
                recognizer.setRecognitionListener(voiceListener)
                speechRecognizer = recognizer
            }
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not create the speech recognizer", error)
            notify(R.string.floating_bubble_voice_failed)
            null
        }
    }

    private val voiceListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onError(error: Int) = handleVoiceError(error)
        override fun onResults(results: Bundle?) = handleVoiceResults(results)
        override fun onPartialResults(partialResults: Bundle?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun handleVoiceResults(results: Bundle?) {
        voiceListening = false
        clearVoiceTimeout()
        stopListeningFeedback()

        val text = results
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.trim()
            .orEmpty()

        if (text.isEmpty()) {
            notify(R.string.floating_bubble_voice_empty)
            voiceResult = null
            return
        }

        // The recognizer can end on silence while the owner still holds the bubble.
        if (voiceHolding) {
            voiceResult = text
            return
        }

        deliverVoice(text)
    }

    private fun handleVoiceError(error: Int) {
        voiceListening = false
        clearVoiceTimeout()
        stopListeningFeedback()
        voiceResult = null

        if (error == SpeechRecognizer.ERROR_CLIENT)
            return

        Log.w(TAG, "Speech recognition failed with error $error")
        val message = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> R.string.floating_bubble_voice_empty

            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> R.string.floating_bubble_microphone_denied
            else -> R.string.floating_bubble_voice_failed
        }
        notify(message)
    }

    private fun speechRecognizerIntent(): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }
    }

    private fun scheduleVoiceTimeout() {
        clearVoiceTimeout()
        val timeout = Runnable {
            voiceTimeout = null
            if (!voiceListening)
                return@Runnable

            voiceListening = false
            stopListeningFeedback()
            try {
                speechRecognizer?.stopListening()
            }
            catch (error: Exception) {
                Log.w(TAG, "Could not stop the long voice input", error)
            }
        }
        voiceTimeout = timeout
        mainHandler.postDelayed(timeout, VOICE_MAX_DURATION_MS)
    }

    private fun clearVoiceTimeout() {
        voiceTimeout?.let { mainHandler.removeCallbacks(it) }
        voiceTimeout = null
    }

    private fun startListeningFeedback() {
        val flash = bubbleFlashView ?: return
        listeningAnimator?.cancel()
        flash.animate().cancel()
        flash.alpha = VOICE_ALPHA_MIN
        listeningAnimator = ObjectAnimator.ofFloat(flash, View.ALPHA, VOICE_ALPHA_MIN, VOICE_ALPHA_MAX).apply {
            duration = VOICE_PULSE_DURATION_MS
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            start()
        }
    }

    private fun stopListeningFeedback() {
        listeningAnimator?.cancel()
        listeningAnimator = null
        bubbleFlashView?.let { flash ->
            flash.animate().cancel()
            flash.animate().alpha(0f).setDuration(120).start()
        }
    }

    private fun deliverVoice(text: String) {
        val plugin = FloatingBubblePlugin.instance
        if (plugin == null) {
            FloatingBubblePlugin.holdTranscript(this, text, openActivity = true)
            return
        }
        plugin.deliverTranscript(text)
    }

    private fun notify(message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private inner class BubbleDragListener(
        private val params: WindowManager.LayoutParams,
    ) : View.OnTouchListener {
        private val touchSlop = ViewConfiguration.get(this@FloatingBubbleService).scaledTouchSlop
        private var startX = 0
        private var startY = 0
        private var downRawX = 0f
        private var downRawY = 0f
        private var dragging = false
        private var longPressAction: Runnable? = null

        fun cancelLongPress(view: View) {
            longPressAction?.let { view.removeCallbacks(it) }
            longPressAction = null
        }

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = params.x
                    startY = params.y
                    dragging = false
                    cancelLongPress(view)
                    snapAnimator?.cancel()
                    snapAnimator = null
                    // The snapped bubble is translucent, so it becomes opaque while the owner holds it.
                    fadeBubble(view, BUBBLE_ALPHA_NORMAL)
                    view.animate().scaleX(0.92f).scaleY(0.92f).setDuration(80).start()

                    longPressAction = Runnable {
                        longPressAction = null
                        if (!dragging)
                            beginVoiceGesture(view)
                    }.also { action -> view.postDelayed(action, BUBBLE_LONG_PRESS_MS) }
                }

                MotionEvent.ACTION_MOVE -> {
                    if (voiceGestureActive)
                        return true

                    val deltaX = event.rawX - downRawX
                    val deltaY = event.rawY - downRawY
                    if (!dragging && (abs(deltaX) > touchSlop || abs(deltaY) > touchSlop)) {
                        dragging = true
                        cancelLongPress(view)
                    }
                    if (!dragging)
                        return true

                    val metrics = screenMetrics()
                    params.x = (startX + deltaX).toInt().coerceIn(0, max(0, metrics.widthPixels - view.width))
                    params.y = (startY + deltaY).toInt().coerceIn(0, max(0, metrics.heightPixels - view.height))
                    updateBubbleLayout(view, params)
                }

                MotionEvent.ACTION_UP -> {
                    cancelLongPress(view)
                    view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
                    when {
                        voiceGestureActive -> endVoiceGesture(view, params)

                        !dragging -> {
                            playTapFeedback(view)
                            settleBubble(view, params, animate = false)
                            requestCapture()
                        }

                        else -> settleBubble(view, params, animate = true)
                    }
                }

                MotionEvent.ACTION_CANCEL -> {
                    cancelLongPress(view)
                    view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
                    if (voiceGestureActive)
                        cancelVoiceGesture()
                    settleBubble(view, params, animate = false)
                }
            }
            return true
        }
    }

    private fun requestCapture() {
        if (!capturing.compareAndSet(false, true))
            return

        val bubble = bubbleView
        // Let the tap feedback play before the bubble leaves the frame.
        mainHandler.postDelayed({
            if (!isRunning) {
                capturing.set(false)
                return@postDelayed
            }

            // Hiding the bubble changes the screen, so the next frame holds no overlay.
            val requestedAt = SystemClock.elapsedRealtime()
            bubble?.visibility = View.INVISIBLE
            mainHandler.postDelayed({
                if (!isRunning) {
                    capturing.set(false)
                    return@postDelayed
                }

                captureExecutor.execute {
                    try {
                        val dataUrl = captureScreen(requestedAt)
                        if (dataUrl != null)
                            deliverCapture(dataUrl)
                        else
                            Log.w(TAG, "The screen capture returned no frame")
                    }
                    catch (error: Exception) {
                        Log.e(TAG, "The screen capture failed", error)
                    }
                    finally {
                        mainHandler.post {
                            bubble?.visibility = View.VISIBLE
                            capturing.set(false)
                        }
                    }
                }
            }, BUBBLE_HIDE_DELAY_MS)
        }, BUBBLE_TAP_HIDE_DELAY_MS)
    }

    private fun captureScreen(requestedAt: Long): String? {
        if (!ensureCaptureSurface())
            return null

        val deadline = SystemClock.uptimeMillis() + CAPTURE_TIMEOUT_MS
        while (SystemClock.uptimeMillis() < deadline) {
            val frame = synchronized(frameLock) {
                val frame = latestFrame
                // A frame from before the bubble hid would show the bubble, so wait for a later one.
                if (frame == null || latestFrameAt < requestedAt)
                    return@synchronized null
                latestFrame = null
                latestFrameAt = 0L
                frame
            }

            if (frame != null) {
                return try {
                    bitmapToDataUrl(imageToBitmap(frame))
                }
                finally {
                    frame.close()
                }
            }
            Thread.sleep(40)
        }

        // A static screen can produce no frame after the hide. The newest frame is still the current screen.
        val fallback = synchronized(frameLock) {
            val frame = latestFrame
            latestFrame = null
            latestFrameAt = 0L
            frame
        } ?: return null

        return try {
            bitmapToDataUrl(imageToBitmap(fallback))
        }
        finally {
            fallback.close()
        }
    }

    private fun imageToBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width
        var bitmap = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888,
        )
        bitmap.copyPixelsFromBuffer(plane.buffer)
        if (bitmap.width != image.width) {
            val cropped = Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
            bitmap.recycle()
            bitmap = cropped
        }
        return bitmap
    }

    private fun bitmapToDataUrl(source: Bitmap): String {
        val scale = min(1f, MAX_CAPTURE_SIDE.toFloat() / max(source.width, source.height))
        val scaled = if (scale < 1f) {
            Bitmap.createScaledBitmap(
                source,
                max(1, (source.width * scale).toInt()),
                max(1, (source.height * scale).toInt()),
                true,
            )
        }
        else {
            source
        }

        val output = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 72, output)
        if (scaled !== source)
            scaled.recycle()
        source.recycle()

        val base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        return "data:image/jpeg;base64,$base64"
    }

    private fun deliverCapture(dataUrl: String) {
        val plugin = FloatingBubblePlugin.instance
        if (plugin == null) {
            FloatingBubblePlugin.holdCapture(this, dataUrl, openActivity = true)
            return
        }
        plugin.deliverCapture(dataUrl)
    }

    @Suppress("DEPRECATION")
    private fun screenMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        val display = getSystemService(DISPLAY_SERVICE) as DisplayManager
        display.getDisplay(Display.DEFAULT_DISPLAY)?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            metrics.setTo(resources.displayMetrics)
        }
        if (metrics.densityDpi <= 0)
            metrics.densityDpi = resources.displayMetrics.densityDpi
        return metrics
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    @Suppress("DEPRECATION")
    private fun Intent.getProjectionData(): Intent? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else
            getParcelableExtra(EXTRA_RESULT_DATA)
    }
}