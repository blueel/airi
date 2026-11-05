import type { MikaHttpRequest, MikaHttpResponse, MikaTransport } from '@proj-airi/stage-shared/mika'

import { Capacitor, registerPlugin } from '@capacitor/core'

interface MikaBridgePlugin {
  request: (request: MikaHttpRequest) => Promise<MikaHttpResponse>
}

const MikaBridge = registerPlugin<MikaBridgePlugin>('MikaBridge')

/**
 * Mika runs on Android only, and the native transport exists only in the
 * Android build. Other builds keep the settings entry and tools hidden.
 */
export function isMikaSupported(): boolean {
  return Capacitor.getPlatform() === 'android'
}

/** Sends a Mika request from native code, so the request carries no `Origin` header. */
export const mikaTransport: MikaTransport = async (request) => {
  if (!isMikaSupported())
    throw new Error('Phone control is only available in the Android app.')
  return await MikaBridge.request(request)
}
