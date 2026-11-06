import type { useAudioContext } from '@proj-airi/stage-ui/stores/audio'
import type { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import type { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'

import { errorMessageFrom } from '@moeru/std'

import { FloatingAssistant, isFloatingAssistantSupported } from './floating-assistant'
import { i18n } from './i18n'

export interface FloatingAssistantCaptureDeps {
  audioContext: ReturnType<typeof useAudioContext>
  chat: ReturnType<typeof useChatStore>
  chatSession: ReturnType<typeof useChatSessionStore>
}

/** Turns one base64 data URL from the native service into a chat attachment. */
export function attachmentFromCapture(dataUrl: string): { type: 'image', data: string, mimeType: string } {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl)
  if (!match)
    throw new Error('The screen capture is not a base64 data URL.')
  return { type: 'image', data: match[2], mimeType: match[1] }
}

/**
 * Sends each bubble capture to the active conversation.
 *
 * The reply is a normal owner turn, so the Stage hooks speak it like a typed message. A capture that arrives while the
 * page still loads waits for the session store, and one the WebView missed is taken from the native buffer.
 */
export function installFloatingAssistantCapture(deps: FloatingAssistantCaptureDeps) {
  if (!isFloatingAssistantSupported())
    return

  const reportFailure = (error: unknown) => {
    console.warn('[floating-assistant] The screen capture could not be sent:', errorMessageFrom(error) ?? 'unknown error')
    void FloatingAssistant.toast({ text: i18n.global.t('stage.floating-assistant.failed') }).catch(() => {})
  }

  const sendCapture = async (dataUrl: string) => {
    // Android can suspend the Web Audio context while the app is in the background. The speech player needs a
    // running context to play the reply that this capture starts.
    if (deps.audioContext.audioContext.state === 'suspended') {
      try {
        await deps.audioContext.audioContext.resume()
      }
      catch (error) {
        console.warn('[floating-assistant] Could not resume the audio context:', errorMessageFrom(error) ?? 'unknown error')
      }
    }

    const deadline = Date.now() + 60_000
    while (!deps.chatSession.isReady && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 200))

    const sessionId = await deps.chatSession.ensureCurrentSession()
    if (!sessionId)
      throw new Error('AIRI has no active conversation.')

    await deps.chat.send({
      sessionId,
      text: i18n.global.t('stage.floating-assistant.prompt'),
      attachments: [attachmentFromCapture(dataUrl)],
    })
  }

  void (async () => {
    await FloatingAssistant.addListener('capture', ({ dataUrl }) => {
      if (dataUrl)
        void sendCapture(dataUrl).catch(reportFailure)
    })
    // Only now can the service hand a capture straight to this listener.
    await FloatingAssistant.ready()

    const pending = await FloatingAssistant.consumePendingCapture()
    if (pending.dataUrl)
      void sendCapture(pending.dataUrl).catch(reportFailure)
  })().catch(reportFailure)
}
