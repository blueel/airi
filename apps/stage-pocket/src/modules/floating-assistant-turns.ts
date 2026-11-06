import type { useAudioContext } from '@proj-airi/stage-ui/stores/audio'
import type { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import type { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'

import { errorMessageFrom } from '@moeru/std'

import { FloatingAssistant, isFloatingAssistantSupported } from './floating-assistant'
import { i18n } from './i18n'

export interface FloatingAssistantTurnDeps {
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
 * Sends each bubble capture and voice transcript to the active conversation.
 *
 * The reply is a normal owner turn, so the Stage hooks speak it like a typed message. A message that arrives while the
 * page still loads waits for the session store, and one the WebView missed is taken from the native buffer.
 */
export function installFloatingAssistantTurns(deps: FloatingAssistantTurnDeps) {
  if (!isFloatingAssistantSupported())
    return

  const reportFailure = (error: unknown, messageKey: string) => {
    console.warn('[floating-assistant] The bubble message could not be sent:', errorMessageFrom(error) ?? 'unknown error')
    void FloatingAssistant.toast({ text: i18n.global.t(messageKey) }).catch(() => {})
  }

  const ensureTurn = async () => {
    // Android can suspend the Web Audio context while the app is in the background. The speech player needs a
    // running context to play the reply that this message starts.
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
    return sessionId
  }

  const sendCapture = async (dataUrl: string) => {
    const sessionId = await ensureTurn()
    await deps.chat.send({
      sessionId,
      text: i18n.global.t('stage.floating-assistant.prompt'),
      attachments: [attachmentFromCapture(dataUrl)],
    })
  }

  const sendTranscript = async (text: string) => {
    const transcript = text.trim()
    if (!transcript)
      return

    const sessionId = await ensureTurn()
    await deps.chat.send({ sessionId, text: transcript })
  }

  void (async () => {
    await FloatingAssistant.addListener('capture', ({ dataUrl }) => {
      if (dataUrl)
        void sendCapture(dataUrl).catch(error => reportFailure(error, 'stage.floating-assistant.failed'))
    })
    await FloatingAssistant.addListener('transcript', ({ text }) => {
      if (text)
        void sendTranscript(text).catch(error => reportFailure(error, 'stage.floating-assistant.voice-failed'))
    })
    // Only now can the service hand a message straight to these listeners.
    await FloatingAssistant.ready()

    const pendingCapture = await FloatingAssistant.consumePendingCapture()
    if (pendingCapture.dataUrl)
      void sendCapture(pendingCapture.dataUrl).catch(error => reportFailure(error, 'stage.floating-assistant.failed'))

    const pendingTranscript = await FloatingAssistant.consumePendingTranscript()
    if (pendingTranscript.text)
      void sendTranscript(pendingTranscript.text).catch(error => reportFailure(error, 'stage.floating-assistant.voice-failed'))
  })().catch(error => reportFailure(error, 'stage.floating-assistant.failed'))
}
