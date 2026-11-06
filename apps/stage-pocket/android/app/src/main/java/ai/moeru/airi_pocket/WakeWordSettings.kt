package ai.moeru.airi_pocket

import android.content.Context
import android.content.SharedPreferences
import java.util.Locale

/** The wake word configuration of the floating bubble. The service reads it before the WebView loads. */
data class WakeWordConfig(
    val enabled: Boolean,
    val phrases: List<String>,
    val language: String,
) {
    /** A configuration without phrases never opens the microphone. */
    val usable: Boolean
        get() = enabled && phrases.isNotEmpty()
}

/**
 * Keeps the wake word configuration in private storage.
 *
 * Use when:
 * - The settings page changes the switch or the phrases.
 * - The service starts and the WebView is not ready yet.
 *
 * Expects:
 * - The settings page and the service run in the same app process, so both read the same preferences.
 */
object WakeWordSettings {
    private const val PREFS = "airi_floating_bubble"
    private const val KEY_ENABLED = "wake_word_enabled"
    private const val KEY_PHRASES = "wake_word_phrases"
    private const val KEY_LANGUAGE = "wake_word_language"

    /** A short list keeps the recognizer prompt small and the settings page readable. */
    const val MAX_PHRASES = 8
    const val MAX_PHRASE_CHARS = 48

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(context: Context): WakeWordConfig {
        val prefs = prefs(context)
        val phrases = prefs.getStringSet(KEY_PHRASES, emptySet())
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.distinct()
            ?.sorted()
            ?.take(MAX_PHRASES)
            .orEmpty()
        val language = prefs.getString(KEY_LANGUAGE, null)
            ?.takeIf { it.isNotBlank() }
            ?: Locale.getDefault().toLanguageTag()

        return WakeWordConfig(
            enabled = prefs.getBoolean(KEY_ENABLED, false),
            phrases = phrases,
            language = language,
        )
    }

    fun write(context: Context, config: WakeWordConfig) {
        prefs(context).edit()
            .putBoolean(KEY_ENABLED, config.enabled)
            .putStringSet(KEY_PHRASES, config.phrases.toSet())
            .putString(KEY_LANGUAGE, config.language)
            .apply()
    }
}