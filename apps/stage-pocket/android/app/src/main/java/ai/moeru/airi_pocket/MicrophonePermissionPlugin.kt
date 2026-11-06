package ai.moeru.airi_pocket

import android.Manifest
import android.content.pm.PackageManager
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "MicrophonePermission",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
    ],
)
class MicrophonePermissionPlugin : Plugin() {
    /** Reports native permission state without opening Android's permission dialog. */
    @PluginMethod
    fun checkPermission(call: PluginCall) {
        val permission = Manifest.permission.RECORD_AUDIO
        val result = JSObject().apply {
            put("granted", context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED)
        }
        call.resolve(result)
    }

    /** Opens Android's microphone dialog when the owner has not answered it yet. */
    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("microphone", call, "microphonePermission")
    }

    @PermissionCallback
    private fun microphonePermission(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("microphone") == PermissionState.GRANTED))
    }
}
