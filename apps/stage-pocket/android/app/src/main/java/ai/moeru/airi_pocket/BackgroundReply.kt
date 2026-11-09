package ai.moeru.airi_pocket

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

import org.json.JSONArray
import org.json.JSONObject

import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One endpoint that the WebView prepared for a background turn.
 *
 * The WebView builds the URL, the headers, and the body with the same helpers that it uses for a normal turn,
 * so provider-specific paths and options stay in one place.
 */
data class BackgroundReplyCall(
    val url: String,
    val headers: Map<String, String>,
    /** The body without the fields that change for each turn. */
    val body: String,
) {
    val usable: Boolean get() = url.isNotBlank()
}

data class BackgroundReplyMessage(
    val role: String,
    val content: String,
)

data class BackgroundReplyConfig(
    val enabled: Boolean,
    val sessionId: String,
    val systemPrompt: String,
    val history: List<BackgroundReplyMessage>,
    val chat: BackgroundReplyCall,
    val speech: BackgroundReplyCall,
) {
    /** A turn needs both endpoints and the conversation that owns the reply. */
    val usable: Boolean
        get() = enabled && sessionId.isNotBlank() && chat.usable && speech.usable
}

/** One exchange that the service finished while the WebView could not run. */
data class BackgroundReplyTurn(
    val id: String,
    val sessionId: String,
    val userText: String,
    val assistantText: String,
    val createdAt: Long,
    val completedAt: Long,
)

/** Reads and writes the configuration and the finished turns in private storage. */
object BackgroundReplySettings {
    private const val PREFS = "background_reply"
    private const val KEY_CONFIG = "config"
    private const val KEY_TURNS = "turns"
    private const val MAX_TURNS = 20

    @Synchronized
    fun writeConfig(context: Context, raw: String?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (raw.isNullOrBlank())
            prefs.edit().remove(KEY_CONFIG).apply()
        else
            prefs.edit().putString(KEY_CONFIG, raw).apply()
    }

    @Synchronized
    fun readConfig(context: Context): BackgroundReplyConfig? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CONFIG, null)
        return parseConfig(raw)
    }

    @Synchronized
    fun appendTurn(context: Context, turn: BackgroundReplyTurn) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val turns = readTurns(prefs.getString(KEY_TURNS, null)).toMutableList()
        turns += turn
        val kept = turns.takeLast(MAX_TURNS)
        val array = JSONArray()
        kept.forEach { array.put(it.toJson()) }
        prefs.edit().putString(KEY_TURNS, array.toString()).apply()
    }

    /** Removes and returns every finished turn, so the WebView appends each one once. */
    @Synchronized
    fun takeTurns(context: Context): List<BackgroundReplyTurn> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val turns = readTurns(prefs.getString(KEY_TURNS, null))
        prefs.edit().remove(KEY_TURNS).apply()
        return turns
    }

    internal fun parseConfig(raw: String?): BackgroundReplyConfig? {
        if (raw.isNullOrBlank())
            return null
        return try {
            val root = JSONObject(raw)
            BackgroundReplyConfig(
                enabled = root.optBoolean("enabled", false),
                sessionId = root.optString("sessionId"),
                systemPrompt = root.optString("systemPrompt"),
                history = parseMessages(root.optJSONArray("history")),
                chat = parseCall(root.optJSONObject("chat")),
                speech = parseCall(root.optJSONObject("speech")),
            )
        }
        catch (error: Exception) {
            Log.w("BackgroundReply", "Could not read the background reply configuration", error)
            null
        }
    }

    private fun parseMessages(array: JSONArray?): List<BackgroundReplyMessage> {
        if (array == null)
            return emptyList()
        val messages = mutableListOf<BackgroundReplyMessage>()
        for (index in 0 until array.length()) {
            val entry = array.optJSONObject(index) ?: continue
            val role = entry.optString("role")
            val content = entry.optString("content")
            if ((role == "user" || role == "assistant") && content.isNotBlank())
                messages += BackgroundReplyMessage(role, content)
        }
        return messages
    }

    private fun parseCall(json: JSONObject?): BackgroundReplyCall {
        if (json == null)
            return BackgroundReplyCall("", emptyMap(), "{}")

        val headers = mutableMapOf<String, String>()
        json.optJSONObject("headers")?.let { headerJson ->
            for (key in headerJson.keys()) {
                val value = headerJson.optString(key)
                if (key.isNotBlank() && value.isNotBlank())
                    headers[key] = value
            }
        }

        return BackgroundReplyCall(
            url = json.optString("url"),
            headers = headers,
            body = json.optString("body", "{}").ifBlank { "{}" },
        )
    }

    private fun readTurns(raw: String?): List<BackgroundReplyTurn> {
        if (raw.isNullOrBlank())
            return emptyList()
        return try {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val entry = array.optJSONObject(index) ?: continue
                    val id = entry.optString("id")
                    if (id.isBlank())
                        continue
                    add(
                        BackgroundReplyTurn(
                            id = id,
                            sessionId = entry.optString("sessionId"),
                            userText = entry.optString("userText"),
                            assistantText = entry.optString("assistantText"),
                            createdAt = entry.optLong("createdAt"),
                            completedAt = entry.optLong("completedAt"),
                        ),
                    )
                }
            }
        }
        catch (error: Exception) {
            Log.w("BackgroundReply", "Could not read the finished background turns", error)
            emptyList()
        }
    }

    internal fun BackgroundReplyTurn.toJson() = JSONObject().apply {
        put("id", id)
        put("sessionId", sessionId)
        put("userText", userText)
        put("assistantText", assistantText)
        put("createdAt", createdAt)
        put("completedAt", completedAt)
    }
}

/** Pure parsing helpers, kept outside the engine so a unit test can read them without a context. */
internal object BackgroundReplyCodec {
    private val MARKER = Regex("<\\|[^|]*\\|>")

    fun stripMarkers(text: String): String = text.replace(MARKER, "").trim()

    fun extensionOf(contentType: String): String = when {
        contentType.contains("wav", ignoreCase = true) -> ".wav"
        contentType.contains("mpeg", ignoreCase = true) || contentType.contains("mp3", ignoreCase = true) -> ".mp3"
        contentType.contains("ogg", ignoreCase = true) -> ".ogg"
        contentType.contains("mp4", ignoreCase = true) || contentType.contains("aac", ignoreCase = true) -> ".m4a"
        else -> ".audio"
    }

    fun parseChatReply(payload: String): String? {
        if (payload.isBlank())
            return null
        val root = JSONObject(payload)
        val choices = root.optJSONArray("choices") ?: return null
        val message = choices.optJSONObject(0)?.optJSONObject("message") ?: return null
        val content = message.opt("content")
        val text = when (content) {
            is String -> content
            is JSONArray -> buildString {
                for (index in 0 until content.length()) {
                    val part = content.optJSONObject(index) ?: continue
                    if (part.optString("type") == "text")
                        append(part.optString("text"))
                }
            }
            else -> null
        } ?: return null
        return text.trim().takeIf { it.isNotEmpty() }
    }
}

/**
 * Answers one wake word or hold-to-talk turn without the WebView.
 *
 * The WebView cannot run while the app is hidden, so the service asks the chat and speech providers that the
 * WebView prepared, then plays the answer in this process. The finished exchange is queued for the chat history.
 */
class BackgroundReplyEngine(
    private val context: Context,
    private val onSpeaking: (Boolean) -> Unit,
    private val onCompleted: (BackgroundReplyTurn) -> Unit,
) {
    companion object {
        private const val TAG = "BackgroundReply"
        private const val BUSY_RETRIES = 20
        private const val BUSY_RETRY_DELAY_MS = 500L
        private const val JSON = "application/json"
    }

    private val main = Handler(Looper.getMainLooper())
    private val running = AtomicBoolean(false)
    /** Settles each turn once, so a completion and an audio focus loss cannot queue it twice. */
    private val settled = AtomicBoolean(false)
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private var player: MediaPlayer? = null
    private var focusRequest: AudioFocusRequest? = null
    private var audioFile: File? = null
    /** The turn that the player currently speaks. A focus loss keeps it for the history. */
    private var pending: BackgroundReplyTurn? = null

    /**
     * Starts one background turn.
     *
     * Returns:
     * - `true` when this call owns the turn.
     * - `false` when the configuration is off or another turn runs. The caller then keeps its normal path.
     */
    fun start(text: String): Boolean {
        val prompt = text.trim()
        if (prompt.isEmpty())
            return false
        val config = BackgroundReplySettings.readConfig(context) ?: return false
        if (!config.usable)
            return false
        if (!running.compareAndSet(false, true))
            return false

        settled.set(false)
        onSpeaking(true)
        requestChat(config, prompt)
        return true
    }

    /** Releases the player and the audio focus. A turn that still runs finishes without sound. */
    fun release() {
        running.set(false)
        main.post {
            releasePlayer()
            onSpeaking(false)
        }
        client.dispatcher.executorService.shutdown()
    }

    private fun requestChat(config: BackgroundReplyConfig, prompt: String) {
        val body = try {
            JSONObject(config.chat.body).apply {
                put("messages", messagesJson(config, prompt))
                put("stream", false)
            }
        }
        catch (error: Exception) {
            fail(config, prompt, "Could not build the chat request", error)
            return
        }

        val request = try {
            request(config.chat, body.toString())
        }
        catch (error: Exception) {
            fail(config, prompt, "Could not build the chat request", error)
            return
        }

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                fail(config, prompt, "The chat request failed", e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!response.isSuccessful) {
                        fail(config, prompt, "The chat request returned HTTP ${response.code}", null)
                        return
                    }
                    val reply = try {
                        BackgroundReplyCodec.parseChatReply(response.body?.string().orEmpty())
                    }
                    catch (error: Exception) {
                        fail(config, prompt, "Could not read the chat reply", error)
                        return
                    }
                    if (reply.isNullOrBlank()) {
                        fail(config, prompt, "The chat reply was empty", null)
                        return
                    }
                    requestSpeech(config, prompt, reply)
                }
            }
        })
    }

    private fun requestSpeech(config: BackgroundReplyConfig, prompt: String, reply: String) {
        val spoken = BackgroundReplyCodec.stripMarkers(reply)
        if (spoken.isEmpty()) {
            complete(config, prompt, reply)
            return
        }

        val body = try {
            JSONObject(config.speech.body).apply { put("input", spoken) }
        }
        catch (error: Exception) {
            fail(config, prompt, "Could not build the speech request", error)
            return
        }

        val request = try {
            request(config.speech, body.toString())
        }
        catch (error: Exception) {
            fail(config, prompt, "Could not build the speech request", error)
            return
        }

        requestSpeechWithRetry(config, prompt, reply, request, 0)
    }

    private fun requestSpeechWithRetry(
        config: BackgroundReplyConfig,
        prompt: String,
        reply: String,
        request: Request,
        attempt: Int,
    ) {
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                fail(config, prompt, "The speech request failed", e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    // A local speech server answers 409 while another generation owns the model.
                    if (response.code == 409 && attempt < BUSY_RETRIES) {
                        main.postDelayed({
                            requestSpeechWithRetry(config, prompt, reply, request, attempt + 1)
                        }, BUSY_RETRY_DELAY_MS)
                        return
                    }
                    if (!response.isSuccessful) {
                        fail(config, prompt, "The speech request returned HTTP ${response.code}", null)
                        return
                    }
                    val audio = try {
                        response.body?.bytes()
                    }
                    catch (error: Exception) {
                        fail(config, prompt, "Could not read the speech audio", error)
                        return
                    }
                    if (audio == null || audio.isEmpty()) {
                        fail(config, prompt, "The speech audio was empty", null)
                        return
                    }
                    play(config, prompt, reply, audio, response.header("Content-Type").orEmpty())
                }
            }
        })
    }

    private fun play(
        config: BackgroundReplyConfig,
        prompt: String,
        reply: String,
        audio: ByteArray,
        contentType: String,
    ) {
        val file = try {
            File(context.cacheDir, "background-reply-${UUID.randomUUID()}${BackgroundReplyCodec.extensionOf(contentType)}").apply {
                writeBytes(audio)
            }
        }
        catch (error: Exception) {
            fail(config, prompt, "Could not store the speech audio", error)
            return
        }

        main.post {
            if (!running.get()) {
                file.delete()
                return@post
            }
            releasePlayer()
            audioFile = file
            val started = try {
                val mediaPlayer = MediaPlayer()
                mediaPlayer.setAudioAttributes(audioAttributes())
                mediaPlayer.setDataSource(file.absolutePath)
                mediaPlayer.setOnCompletionListener {
                    complete(config, prompt, reply)
                }
                mediaPlayer.setOnErrorListener { _, what, extra ->
                    fail(config, prompt, "The player failed with $what/$extra", null)
                    true
                }
                mediaPlayer.prepare()
                mediaPlayer.start()
                player = mediaPlayer
                true
            }
            catch (error: Exception) {
                fail(config, prompt, "Could not play the speech audio", error)
                false
            }

            if (started) {
                pending = BackgroundReplyTurn(
                    id = "background-${UUID.randomUUID()}",
                    sessionId = config.sessionId,
                    userText = prompt,
                    assistantText = reply,
                    createdAt = System.currentTimeMillis(),
                    completedAt = System.currentTimeMillis(),
                )
                requestAudioFocus()
                onSpeaking(true)
            }
        }
    }

    private fun complete(config: BackgroundReplyConfig, prompt: String, reply: String) {
        if (!settled.compareAndSet(false, true))
            return
        main.post {
            releasePlayer()
            onSpeaking(false)
            running.set(false)
            pending = null
            val now = System.currentTimeMillis()
            onCompleted(
                BackgroundReplyTurn(
                    id = "background-${UUID.randomUUID()}",
                    sessionId = config.sessionId,
                    userText = prompt,
                    assistantText = reply,
                    createdAt = now,
                    completedAt = now,
                ),
            )
        }
    }

    /** Keeps the transcript for the WebView, so the reply arrives when the app returns. */
    private fun fail(config: BackgroundReplyConfig, prompt: String, message: String, error: Throwable?) {
        if (!settled.compareAndSet(false, true))
            return
        Log.w(TAG, "${config.sessionId}: $message: ${error?.message ?: "no detail"}", error)
        main.post {
            releasePlayer()
            onSpeaking(false)
            running.set(false)
            pending = null
            Toast.makeText(context, R.string.floating_bubble_background_reply_failed, Toast.LENGTH_SHORT).show()
            FloatingBubblePlugin.instance?.deliverTranscript(prompt)
        }
    }

    private fun request(call: BackgroundReplyCall, body: String): Request {
        val builder = Request.Builder()
            .url(call.url)
            .post(body.toRequestBody(JSON.toMediaType()))
        call.headers.forEach { (key, value) -> builder.header(key, value) }
        return builder.build()
    }

    private fun messagesJson(config: BackgroundReplyConfig, prompt: String): JSONArray {
        val messages = JSONArray()
        fun add(role: String, content: String) {
            messages.put(JSONObject().put("role", role).put("content", content))
        }
        val system = config.systemPrompt.trim()
        if (system.isNotEmpty())
            add("system", system)
        config.history.forEach { add(it.role, it.content) }
        add("user", prompt)
        return messages
    }

    private fun audioAttributes() = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private fun requestAudioFocus() {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(audioAttributes())
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener { change ->
                if (change <= AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
                    main.post { stopPlayback() }
            }
            .build()
        focusRequest = request
        manager.requestAudioFocus(request)
    }

    private fun stopPlayback() {
        if (!settled.compareAndSet(false, true))
            return
        val turn = pending
        pending = null
        releasePlayer()
        onSpeaking(false)
        running.set(false)
        // Another app took the audio focus. The reply stays in the history even without its last words.
        if (turn != null)
            onCompleted(turn)
    }

    private fun releasePlayer() {
        player?.let { mediaPlayer ->
            try {
                mediaPlayer.stop()
            }
            catch (error: Exception) {
                Log.w(TAG, "Could not stop the player", error)
            }
            mediaPlayer.release()
        }
        player = null
        audioFile?.let { file -> file.delete() }
        audioFile = null
        focusRequest?.let { request ->
            val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            manager.abandonAudioFocusRequest(request)
        }
        focusRequest = null
    }
}