package ai.moeru.airi_pocket

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Taps the install button of the system package installer while AIRI's own update is pending.
 *
 * Android does not let a normal app install an update without a confirmation. This service removes that tap. The
 * `InstallGate` limits it to a short window that the updater armed, and the package check keeps it inside a known
 * installer, so it never confirms another app's install.
 *
 * Use when:
 * - The owner enabled this service in Android accessibility settings.
 * - The update page opened the installer for a downloaded AIRI build.
 *
 * Expects:
 * - Android 13 and later can show "Restricted setting" for a sideloaded app. The owner must allow restricted settings
 *   in the app info first, or the system refuses to enable the service.
 */
class InstallAccessibilityService : AccessibilityService() {
    companion object {
        private const val TAG = "InstallAccessibility"
        private const val MAX_NODES = 2000
        private const val CLICK_DEBOUNCE_MS = 800L

        /** Labels of the confirmation button across AOSP and common OEM installers. */
        private val CONFIRM_LABELS = listOf(
            "install",
            "install anyway",
            "update",
            "continue",
            "ok",
            "yes",
            "安装",
            "继续安装",
            "仍然安装",
            "立即安装",
            "更新",
            "确定",
            "继续",
        )
    }

    private var lastClickAt = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null)
            return
        val type = event.eventType
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
            return

        val packageName = event.packageName?.toString() ?: return
        if (!isInstaller(packageName))
            return
        if (!InstallGate.isArmed(this))
            return
        if (SystemClock.elapsedRealtime() - lastClickAt < CLICK_DEBOUNCE_MS)
            return

        val root = rootInActiveWindow ?: return
        val button = findConfirmButton(root) ?: return
        if (!button.isEnabled) {
            // Some installers enable the button only after the content scrolls to its end.
            scrollForward(root)
            return
        }

        if (button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            lastClickAt = SystemClock.elapsedRealtime()
            Log.i(TAG, "Clicked the install button in $packageName")
        }
    }

    override fun onInterrupt() {}

    private fun isInstaller(packageName: String): Boolean {
        val name = packageName.lowercase()
        return name.contains("packageinstaller") || name.contains("package.installer")
    }

    private fun findConfirmButton(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0

        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val node = queue.removeFirst()
            visited += 1

            if (node.isClickable && (matches(node.text) || matches(node.contentDescription)))
                return node

            for (index in 0 until node.childCount)
                node.getChild(index)?.let(queue::addLast)
        }

        return null
    }

    private fun scrollForward(root: AccessibilityNodeInfo): Boolean {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0

        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val node = queue.removeFirst()
            visited += 1

            if (node.isScrollable && node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD))
                return true

            for (index in 0 until node.childCount)
                node.getChild(index)?.let(queue::addLast)
        }

        return false
    }

    private fun matches(value: CharSequence?): Boolean {
        val label = value?.toString()?.trim()?.lowercase() ?: return false
        return CONFIRM_LABELS.any { it == label }
    }
}