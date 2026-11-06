import { registerPlugin } from '@capacitor/core'

interface MicrophonePermissionState {
  granted: boolean
}

interface MicrophonePermissionPlugin {
  checkPermission: () => Promise<MicrophonePermissionState>
  requestPermission: () => Promise<MicrophonePermissionState>
}

/** Reads Android's native microphone permission state and can open the system permission dialog. */
export const MicrophonePermission = registerPlugin<MicrophonePermissionPlugin>('MicrophonePermission')
