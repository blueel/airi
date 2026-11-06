package ai.moeru.airi_pocket

import android.content.Context

/**
 * Limits automatic install clicks to a short window in which AIRI opened the installer itself.
 *
 * The accessibility service reads this gate, so it cannot confirm an unrelated app install later. The window is short
 * because the installer screen shows right after the updater starts it.
 */
internal object InstallGate {
    private const val PREFS = "auto-install"
    private const val KEY_ARMED_UNTIL = "armed-until"
    private const val WINDOW_MS = 90_000L

    fun arm(context: Context) {
        prefs(context).edit()
            .putLong(KEY_ARMED_UNTIL, System.currentTimeMillis() + WINDOW_MS)
            .apply()
    }

    fun isArmed(context: Context): Boolean {
        return prefs(context).getLong(KEY_ARMED_UNTIL, 0L) > System.currentTimeMillis()
    }

    fun disarm(context: Context) {
        prefs(context).edit().remove(KEY_ARMED_UNTIL).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}