package ai.moeru.airi_pocket

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.core.app.NotificationCompat
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import java.io.ByteArrayOutputStream
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
        removeBubble()
        stopProjection()
        captureExecutor.shutdownNow()
        captureThread.quitSafely()
        super.onDestroy()
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
        bubble.setOnTouchListener(BubbleDragListener(params))

        try {
            manager.addView(bubble, params)
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not add the floating bubble", error)
            stopSelf()
            return
        }

        bubbleView = bubble
        bubbleParams = params
    }

    private fun removeBubble() {
        val bubble = bubbleView ?: return
        bubbleView = null
        bubbleParams = null
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
            alpha = 0.96f
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
        return container
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

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = params.x
                    startY = params.y
                    dragging = false
                    view.animate().scaleX(0.92f).scaleY(0.92f).setDuration(80).start()
                }

                MotionEvent.ACTION_MOVE -> {
                    val deltaX = event.rawX - downRawX
                    val deltaY = event.rawY - downRawY
                    if (!dragging && (abs(deltaX) > touchSlop || abs(deltaY) > touchSlop))
                        dragging = true
                    if (!dragging)
                        return true

                    val metrics = screenMetrics()
                    params.x = (startX + deltaX).toInt().coerceIn(0, max(0, metrics.widthPixels - view.width))
                    params.y = (startY + deltaY).toInt().coerceIn(0, max(0, metrics.heightPixels - view.height))
                    try {
                        windowManager?.updateViewLayout(view, params)
                    }
                    catch (error: Exception) {
                        Log.w(TAG, "Could not move the floating bubble", error)
                    }
                }

                MotionEvent.ACTION_UP -> {
                    view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
                    if (!dragging)
                        requestCapture()
                }

                MotionEvent.ACTION_CANCEL -> {
                    view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
                }
            }
            return true
        }
    }

    private fun requestCapture() {
        if (!capturing.compareAndSet(false, true))
            return

        val bubble = bubbleView
        // Hiding the bubble changes the screen, so the next frame holds no overlay.
        val requestedAt = SystemClock.elapsedRealtime()
        bubble?.visibility = View.INVISIBLE
        mainHandler.postDelayed({
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