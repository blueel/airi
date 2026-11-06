package ai.moeru.airi_pocket

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.Locale

/**
 * Listens for a configured wake word while the floating bubble runs.
 *
 * Android has no public always-on keyword detector for third-party apps. This listener runs the platform speech
 * recognizer in a loop and matches the returned text at the start of an utterance. The recognizer is asked to prefer
 * the on-device model, so a phone with offline speech keeps the audio on the device. A phone without it can send the
 * audio to the system recognition service.
 *
 * The listener pauses while the character speaks and while hold-to-talk runs, so the microphone never sends the
 * character's own voice back as a command.
 */
class WakeWordListener(
    private val context: Context,
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        /** A wake phrase matched. The bubble can show that it listens. */
        fun onWakeWord(phrase: String)

        /** A command arrived. `text` never contains the wake phrase. */
        fun onCommand(text: String)

        /** The listening state changed. */
        fun onStateChanged(state: State)

        /** Listening cannot run until the owner fixes the permission or the device. */
        fun onUnavailable(messageResId: Int)
    }

    enum class State {
        STOPPED,
        LISTENING,
        COMMAND,
        PAUSED,
    }

    private enum class Mode {
        WAKE,
        COMMAND,
    }

    companion object {
        private const val TAG = "WakeWordListener"
        private const val RESTART_DELAY_MS = 300L
        private const val ERROR_BACKOFF_MS = 1_500L
        private const val MAX_BACKOFF_MS = 8_000L
        private const val WAKE_WATCHDOG_MS = 20_000L
        private const val SEGMENT_WATCHDOG_MS = 60_000L
        private const val COMMAND_TIMEOUT_MS = 8_000L
        private const val REPLY_COOLDOWN_MS = 4_000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var config = WakeWordConfig(false, emptyList(), Locale.getDefault().toLanguageTag())
    private var state = State.STOPPED
    private var speaking = false
    private var holdToTalk = false
    private var blocked = false
    /** Some phones have no offline model for the selected language. The first such error retries online. */
    private var preferOffline = true
    private var mode = Mode.WAKE
    private var partialCommand = ""
    /** A segmented session delivered this utterance, so a later `onResults` must not handle it twice. */
    private var segmentDelivered = false
    private var generation = 0
    private var starting = false
    private var backoffMs = RESTART_DELAY_MS
    private var restart: Runnable? = null
    private var watchdog: Runnable? = null
    private var cooldown: Runnable? = null

    val currentState: State
        get() = state

    /** Replaces the phrases or the switch. A changed configuration restarts recognition with the new words. */
    fun updateConfig(next: WakeWordConfig) {
        val changed = next != config
        config = next
        if (!next.usable) {
            blocked = false
            stopInternal()
            return
        }

        blocked = false
        if (changed && state != State.STOPPED) {
            restartNow()
            return
        }
        if (state == State.STOPPED)
            resumeIfReady()
    }

    fun start() {
        if (!config.usable || speaking || holdToTalk || blocked)
            return
        if (state != State.STOPPED)
            return
        startRecognition(Mode.WAKE)
    }

    fun stop() {
        blocked = false
        stopInternal()
    }

    fun destroy() {
        stopInternal()
        recognizer?.destroy()
        recognizer = null
    }

    /** AIRI speaks. The microphone must not hear her own voice. */
    fun setSpeaking(value: Boolean) {
        if (speaking == value)
            return
        speaking = value
        if (value)
            pauseInternal()
        else
            resumeIfReady()
    }

    /** Hold-to-talk owns the microphone, so the wake loop releases it. */
    fun setHoldToTalk(value: Boolean) {
        if (holdToTalk == value)
            return
        holdToTalk = value
        if (value)
            pauseInternal()
        else
            resumeIfReady()
    }

    /**
     * Pauses after a transcript. The reply can start a few seconds later, so the pause buys time for
     * {@link setSpeaking} to arrive before the microphone opens again.
     */
    fun pauseForReply() {
        pauseInternal()
        cooldown?.let(handler::removeCallbacks)
        val action = Runnable {
            cooldown = null
            resumeIfReady()
        }
        cooldown = action
        handler.postDelayed(action, REPLY_COOLDOWN_MS)
    }

    private fun restartNow() {
        cancelTimers()
        stopRecognition()
        setState(State.PAUSED)
        scheduleRestart(RESTART_DELAY_MS)
    }

    private fun pauseInternal() {
        cancelTimers()
        stopRecognition()
        if (state != State.STOPPED)
            setState(State.PAUSED)
    }

    private fun stopInternal() {
        cancelTimers()
        stopRecognition()
        setState(State.STOPPED)
    }

    private fun resumeIfReady() {
        if (speaking || holdToTalk || !config.usable || blocked || cooldown != null)
            return
        if (state == State.LISTENING || state == State.COMMAND || starting)
            return
        scheduleRestart(RESTART_DELAY_MS)
    }

    private fun startRecognition(mode: Mode) {
        if (!config.usable || speaking || holdToTalk || blocked)
            return
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail(R.string.floating_bubble_wake_word_permission)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            fail(R.string.floating_bubble_wake_word_unavailable)
            return
        }

        cancelTimers()
        stopRecognition()
        this.mode = mode
        partialCommand = ""
        segmentDelivered = false
        starting = true
        val currentGeneration = ++generation
        val current = ensureRecognizer()
        if (current == null) {
            starting = false
            scheduleRestart(ERROR_BACKOFF_MS)
            return
        }

        current.setRecognitionListener(listenerFor(currentGeneration))
        setState(if (mode == Mode.COMMAND) State.COMMAND else State.LISTENING)
        try {
            current.startListening(intentFor(mode))
            scheduleWatchdog(if (mode == Mode.COMMAND) COMMAND_TIMEOUT_MS else wakeWatchdogMs()) {
                if (mode == Mode.COMMAND)
                    finishCommand()
                else
                    restartRecognition()
            }
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not start wake word recognition", error)
            starting = false
            scheduleRestart(ERROR_BACKOFF_MS)
        }
    }

    private fun stopRecognition() {
        generation++
        starting = false
        try {
            recognizer?.cancel()
        }
        catch (error: Exception) {
            Log.w(TAG, "Could not cancel wake word recognition", error)
        }
    }

    private fun ensureRecognizer(): SpeechRecognizer? {
        recognizer?.let { return it }
        return try {
            SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        }
        catch (error: Exception) {
            Log.e(TAG, "Could not create the wake word recognizer", error)
            fail(R.string.floating_bubble_wake_word_failed)
            null
        }
    }

    private fun intentFor(mode: Mode): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, config.language)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            if (preferOffline)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            if (mode == Mode.WAKE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, true)
            if (mode == Mode.COMMAND) {
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1_200L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 800L)
            }
        }
    }

    /** A segmented session can stay open between utterances. The watchdog only recovers a stuck recognizer. */
    private fun wakeWatchdogMs(): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) SEGMENT_WATCHDOG_MS else WAKE_WATCHDOG_MS
    }

    private fun listenerFor(generation: Int): RecognitionListener {
        return object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (generation != this@WakeWordListener.generation)
                    return
                starting = false
                backoffMs = RESTART_DELAY_MS
            }

            override fun onBeginningOfSpeech() {
                if (generation != this@WakeWordListener.generation)
                    return
                if (mode == Mode.COMMAND)
                    scheduleWatchdog(COMMAND_TIMEOUT_MS) { finishCommand() }
                else
                    scheduleWatchdog(wakeWatchdogMs()) { restartRecognition() }
            }

            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}

            override fun onError(error: Int) {
                if (generation != this@WakeWordListener.generation)
                    return
                handleError(error)
            }

            override fun onResults(results: Bundle?) {
                if (generation != this@WakeWordListener.generation)
                    return
                if (segmentDelivered)
                    return
                handleResults(textOf(results))
            }

            override fun onPartialResults(partialResults: Bundle?) {
                if (generation != this@WakeWordListener.generation)
                    return
                if (mode == Mode.WAKE)
                    scheduleWatchdog(wakeWatchdogMs()) { restartRecognition() }
                handlePartial(textOf(partialResults))
            }

            override fun onSegmentResults(results: Bundle) {
                if (generation != this@WakeWordListener.generation)
                    return
                segmentDelivered = true
                scheduleWatchdog(wakeWatchdogMs()) { restartRecognition() }
                handleSegment(textOf(results))
            }

            override fun onEndOfSegmentedSession() {
                if (generation != this@WakeWordListener.generation)
                    return
                starting = false
                cancelWatchdog()
                if (mode == Mode.COMMAND)
                    finishCommand()
                else
                    scheduleRestart(RESTART_DELAY_MS)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        }
    }

    private fun textOf(results: Bundle?): String {
        return results
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.trim()
            .orEmpty()
    }

    private fun handlePartial(text: String) {
        if (text.isEmpty())
            return

        if (mode == Mode.COMMAND) {
            partialCommand = text
            scheduleWatchdog(COMMAND_TIMEOUT_MS) { finishCommand() }
            return
        }

        val match = WakeWordMatcher.match(text, config.phrases) ?: return
        callbacks.onWakeWord(match.phrase)

        // A partial result can still grow. Keep the recognition open and deliver the final result or the segment.
        mode = Mode.COMMAND
        partialCommand = text
        setState(State.COMMAND)
        scheduleWatchdog(COMMAND_TIMEOUT_MS) { finishCommand() }
    }

    /** Handles one complete segment of a segmented session. The session stays open for the next segment. */
    private fun handleSegment(text: String) {
        if (text.isEmpty())
            return

        if (mode == Mode.COMMAND) {
            val command = stripWakePhrase(text)
            if (command.isNotEmpty())
                deliverCommand(command)
            return
        }

        val match = WakeWordMatcher.match(text, config.phrases) ?: return
        callbacks.onWakeWord(match.phrase)
        if (match.hasCommand) {
            deliverCommand(match.remainder)
            return
        }

        mode = Mode.COMMAND
        partialCommand = ""
        setState(State.COMMAND)
        scheduleWatchdog(COMMAND_TIMEOUT_MS) { finishCommand() }
    }

    private fun handleResults(text: String) {
        cancelWatchdog()
        if (mode == Mode.COMMAND) {
            val command = stripWakePhrase(text).ifEmpty { stripWakePhrase(partialCommand) }
            if (command.isNotEmpty())
                deliverCommand(command)
            else
                scheduleRestart(RESTART_DELAY_MS)
            return
        }

        val match = WakeWordMatcher.match(text, config.phrases)
        if (match == null) {
            scheduleRestart(RESTART_DELAY_MS)
            return
        }

        callbacks.onWakeWord(match.phrase)
        if (match.hasCommand)
            deliverCommand(match.remainder)
        else
            startRecognition(Mode.COMMAND)
    }

    /** The owner said only the wake word and then stopped. Send what was recognized, if anything. */
    private fun finishCommand() {
        val command = stripWakePhrase(partialCommand)
        if (command.isNotEmpty())
            deliverCommand(command)
        else
            scheduleRestart(RESTART_DELAY_MS)
    }

    private fun stripWakePhrase(text: String): String {
        if (text.isBlank())
            return ""
        return WakeWordMatcher.match(text, config.phrases)?.remainder ?: text.trim()
    }

    private fun deliverCommand(text: String) {
        val command = text.trim()
        if (command.isEmpty()) {
            scheduleRestart(RESTART_DELAY_MS)
            return
        }
        stopRecognition()
        callbacks.onCommand(command)
        pauseForReply()
    }

    private fun handleError(error: Int) {
        starting = false
        cancelWatchdog()

        // A command that heard nothing leaves the wake loop clean. It must not show an error for every quiet pause.
        if (mode == Mode.COMMAND && (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)) {
            scheduleRestart(RESTART_DELAY_MS)
            return
        }

        // A phone without the offline language pack can reject the offline request. Retry with the online service once.
        if (preferOffline
            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)
        ) {
            preferOffline = false
            scheduleRestart(RESTART_DELAY_MS)
            return
        }

        when (error) {
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail(R.string.floating_bubble_wake_word_permission)
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            SpeechRecognizer.ERROR_CLIENT,
            -> scheduleRestart(RESTART_DELAY_MS)

            else -> {
                Log.w(TAG, "Wake word recognition failed with error $error")
                scheduleRestart(nextBackoff())
            }
        }
    }

    private fun fail(messageResId: Int) {
        blocked = true
        cancelTimers()
        stopRecognition()
        setState(State.STOPPED)
        callbacks.onUnavailable(messageResId)
    }

    private fun restartRecognition() {
        cancelWatchdog()
        stopRecognition()
        scheduleRestart(RESTART_DELAY_MS)
    }

    private fun scheduleRestart(delay: Long) {
        cancelWatchdog()
        restart?.let(handler::removeCallbacks)
        val action = Runnable {
            restart = null
            startRecognition(Mode.WAKE)
        }
        restart = action
        handler.postDelayed(action, delay)
    }

    private fun scheduleWatchdog(delay: Long, action: () -> Unit) {
        cancelWatchdog()
        val runnable = Runnable {
            watchdog = null
            action()
        }
        watchdog = runnable
        handler.postDelayed(runnable, delay)
    }

    private fun cancelWatchdog() {
        watchdog?.let(handler::removeCallbacks)
        watchdog = null
    }

    private fun cancelTimers() {
        restart?.let(handler::removeCallbacks)
        restart = null
        cooldown?.let(handler::removeCallbacks)
        cooldown = null
        cancelWatchdog()
    }

    private fun nextBackoff(): Long {
        val current = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        return current
    }

    private fun setState(next: State) {
        if (state == next)
            return
        state = next
        callbacks.onStateChanged(next)
    }
}