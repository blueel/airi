import type { PluginListenerHandle } from '@capacitor/core'

import { registerWatchAlongCaptureSource } from '@proj-airi/stage-ui/stores/watch-along'

import { FloatingAssistant, isFloatingAssistantSupported } from './floating-assistant'
import { i18n } from './i18n'

/**
 * Uses the floating bubble's MediaProjection session as the companion capture source.
 *
 * The bubble keeps the session and the frame loop in the foreground service, so the mode keeps working while the
 * owner uses another app. The WebView only receives the frames it asked for.
 */
export function installWatchAlongCapture() {
  if (!isFloatingAssistantSupported())
    return

  let listener: PluginListenerHandle | undefined

  registerWatchAlongCaptureSource({
    kind: 'android-bubble',
    async start({ intervalMs, onFrame }) {
      const status = await FloatingAssistant.status()
      if (!status.running)
        throw new Error(i18n.global.t('stage.chat.watch-along.errors.bubble-not-running'))

      await listener?.remove()
      listener = await FloatingAssistant.addListener('watchFrame', frame => onFrame(frame))
      try {
        await FloatingAssistant.startWatching({ intervalMs })
      }
      catch (error) {
        await listener?.remove()
        listener = undefined
        throw error
      }
    },
    async stop() {
      try {
        await FloatingAssistant.stopWatching()
      }
      finally {
        await listener?.remove()
        listener = undefined
      }
    },
  })
}
