import type { FloatingAssistantBackgroundReplyConfig, FloatingAssistantBackgroundTurn } from './floating-assistant'

import { App } from '@capacitor/app'
import { errorMessageFrom } from '@moeru/std'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { clean, objCamelToSnake, requestURL } from '@xsai/shared'
import { watch } from 'vue'

import { useBackgroundReplyStore } from '../stores/background-reply'
import { FloatingAssistant, isFloatingAssistantSupported } from './floating-assistant'

/** A provider that can build an OpenAI-style chat request from a model id. */
interface ChatCapableProvider {
  chat: (model: string, extraOptions?: Record<string, unknown>) => Record<string, unknown>
}

/** A provider that can build an OpenAI-style speech request from a model id. */
interface SpeechCapableProvider {
  speech: (model: string, extraOptions?: Record<string, unknown>) => Record<string, unknown>
}

const TRANSPORT_KEYS = ['baseURL', 'apiKey', 'headers', 'fetch', 'abortSignal'] as const
const SYNC_INTERVAL_MS = 20_000
const SYNC_DEBOUNCE_MS = 800

function emptyConfig(): FloatingAssistantBackgroundReplyConfig {
  return {
    enabled: false,
    sessionId: '',
    systemPrompt: '',
    history: [],
    chat: { url: '', headers: {}, body: {} },
    speech: { url: '', headers: {}, body: {} },
  }
}

/** Removes the fields that belong to the transport, not to the JSON body. */
function omitTransport(options: Record<string, unknown>) {
  const rest = { ...options }
  for (const key of TRANSPORT_KEYS)
    delete rest[key]
  return rest
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value)
    return {}
  if (typeof Headers !== 'undefined' && value instanceof Headers)
    return Object.fromEntries(value.entries())
  if (typeof value !== 'object')
    return {}

  const headers: Record<string, string> = {}
  for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header === 'string')
      headers[key] = header
  }
  return headers
}

/** Matches the headers of an xsai call, where a custom Authorization header wins over the key. */
function callHeaders(apiKey: unknown, value: unknown): Record<string, string> {
  const headers = normalizeHeaders(value)
  if (typeof apiKey !== 'string' || apiKey === '')
    return headers
  if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization'))
    return headers

  return { Authorization: `Bearer ${apiKey}`, ...headers }
}

function isChatCapable(value: unknown): value is ChatCapableProvider {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'chat') === 'function'
}

function isSpeechCapable(value: unknown): value is SpeechCapableProvider {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'speech') === 'function'
}

function bodyOf(options: Record<string, unknown>, extra: Record<string, unknown>) {
  return objCamelToSnake(clean({ ...omitTransport(options), ...extra }))
}

/**
 * Keeps the Android background reply configuration in step with the active conversation.
 *
 * The WebView freezes while the app is hidden, so the floating bubble asks the chat and speech providers on its
 * own. This module prepares the same requests that a normal turn would use, and appends the turns that the service
 * finished once the page can run again.
 *
 * Use when:
 * - Stage Pocket starts on Android with the screen bubble.
 *
 * Expects:
 * - The chat and speech providers are configured, and the character has a chat model.
 *
 * Returns:
 * - Nothing. Other platforms and an unconfigured character leave the native path off.
 */
export function installBackgroundReplies() {
  if (!isFloatingAssistantSupported())
    return

  const backgroundReply = useBackgroundReplyStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const cards = useAiriCardStore()
  const consciousness = useConsciousnessStore()
  const speech = useSpeechStore()
  const speechOutput = useSpeechOutputControlStore()
  const providers = useProviderStore()
  const providerConfig = useProviderConfigStore()

  let installed = false
  let syncVersion = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let lastSynced = ''
  let consuming = false

  async function composeConfig(): Promise<FloatingAssistantBackgroundReplyConfig> {
    if (!backgroundReply.enabled || !speech.enabled || speechOutput.speechMuted)
      return emptyConfig()

    const sessionId = chatSession.activeSessionId
    if (!sessionId)
      return emptyConfig()

    const characterId = chatSession.sessionMetas[sessionId]?.characterId || cards.activeCardId
    if (!characterId)
      return emptyConfig()

    const modules = cards.getModules(characterId)
    const chatSelection = modules.consciousness
    const speechSelection = modules.speech
    if (!chatSelection.provider || !chatSelection.model)
      return emptyConfig()

    // A character can inherit its speech selection, so the global one fills an empty card.
    const cardSpeech = speechSelection.provider && speechSelection.provider !== 'speech-noop'
    const speechProviderId = cardSpeech ? speechSelection.provider : speech.activeSpeechProvider
    const speechModel = cardSpeech ? speechSelection.model : speech.activeSpeechModel
    const speechVoice = cardSpeech ? speechSelection.voice_id : speech.activeSpeechVoiceId
    if (!speechProviderId || speechProviderId === 'speech-noop' || !speechModel)
      return emptyConfig()

    const chatProvider = await consciousness.getChatProviderInstance(chatSelection.provider)
    if (!isChatCapable(chatProvider))
      return emptyConfig()
    const chatOptions = chatProvider.chat(chatSelection.model)
    if (typeof chatOptions.baseURL !== 'string' && !(chatOptions.baseURL instanceof URL))
      return emptyConfig()

    const speechProvider = await providers.getProviderInstance(speechProviderId)
    if (!isSpeechCapable(speechProvider))
      return emptyConfig()

    const speechSettings = { ...providerConfig.getProviderConfig(speechProviderId) }
    const speechOptions = speechProvider.speech(speechModel, speechSettings)
    if (typeof speechOptions.baseURL !== 'string' && !(speechOptions.baseURL instanceof URL))
      return emptyConfig()
    const voiceId = speechVoice || (typeof speechSettings.voice === 'string' ? speechSettings.voice : '')
    if (!voiceId)
      return emptyConfig()

    const context = chat.backgroundTurnContext(sessionId)

    return {
      enabled: true,
      sessionId,
      systemPrompt: context.systemPrompt,
      history: context.history,
      chat: {
        url: requestURL('chat/completions', chatOptions.baseURL).toString(),
        headers: callHeaders(chatOptions.apiKey, chatOptions.headers),
        body: bodyOf(chatOptions, {
          temperature: consciousness.activeTemperature,
          topP: consciousness.activeTopP,
        }),
      },
      speech: {
        url: requestURL('audio/speech', speechOptions.baseURL).toString(),
        headers: callHeaders(speechOptions.apiKey, speechOptions.headers),
        body: bodyOf(speechOptions, { voice: voiceId }),
      },
    }
  }

  async function syncNow() {
    const version = ++syncVersion
    try {
      const config = await composeConfig()
      if (version !== syncVersion)
        return

      const serialized = JSON.stringify(config)
      if (serialized === lastSynced)
        return

      await FloatingAssistant.syncBackgroundReply({ config })
      lastSynced = serialized
    }
    catch (error) {
      console.warn('[background-reply] Could not prepare the background reply:', errorMessageFrom(error) ?? 'unknown error')
    }
  }

  function scheduleSync() {
    if (debounce)
      clearTimeout(debounce)
    debounce = setTimeout(() => void syncNow(), SYNC_DEBOUNCE_MS)
  }

  async function appendTurn(turn: FloatingAssistantBackgroundTurn) {
    const sessionId = turn.sessionId || chatSession.activeSessionId
    if (!sessionId || !chatSession.sessionMetas[sessionId])
      return
    if (!turn.userText.trim() || !turn.assistantText.trim())
      return

    const existing = new Set(chatSession.getSessionMessages(sessionId).map(message => message.id))
    if (!existing.has(turn.id)) {
      await chatSession.storeMessage(sessionId, {
        id: turn.id,
        role: 'user',
        content: turn.userText,
        createdAt: turn.createdAt,
      })
    }

    const replyId = `${turn.id}-reply`
    if (!existing.has(replyId)) {
      await chatSession.storeMessage(sessionId, {
        id: replyId,
        role: 'assistant',
        content: turn.assistantText,
        createdAt: turn.completedAt,
        completedAt: turn.completedAt,
        slices: [{ type: 'text', text: turn.assistantText }],
        tool_results: [],
      })
    }
  }

  async function consumeTurns() {
    if (consuming || !chatSession.isReady)
      return

    consuming = true
    try {
      const { turns } = await FloatingAssistant.consumeBackgroundTurns()
      for (const turn of turns)
        await appendTurn(turn)
    }
    catch (error) {
      console.warn('[background-reply] Could not read the finished background turns:', errorMessageFrom(error) ?? 'unknown error')
    }
    finally {
      consuming = false
    }
  }

  function start() {
    if (installed)
      return
    installed = true

    // A transcript that arrives while the app is hidden is answered by the service, so the page only needs the
    // latest configuration. The interval covers changes that no watcher reports while the page is busy.
    watch(
      () => {
        const sessionId = chatSession.activeSessionId
        return [
          backgroundReply.enabled,
          chatSession.isReady,
          sessionId ?? '',
          sessionId ? chatSession.getSessionMessages(sessionId).length : 0,
          sessionId ? chatSession.sessionMetas[sessionId]?.characterId ?? '' : '',
          speech.enabled,
          speechOutput.speechMuted,
          speech.activeSpeechProvider,
          speech.activeSpeechModel,
          speech.activeSpeechVoiceId,
          providerConfig.providers,
          cards.cards,
        ]
      },
      () => scheduleSync(),
      { immediate: true, deep: true },
    )

    watch(() => chatSession.isReady, (ready) => {
      if (ready)
        void consumeTurns()
    }, { immediate: true })

    setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
    // A turn can finish after the owner returns. The short poll appends it without another app switch.
    setInterval(() => void consumeTurns(), 5_000)

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void consumeTurns()
        void syncNow()
        return
      }
      // The last chance before Android freezes the page.
      void syncNow()
    })

    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive)
        return
      void consumeTurns()
      void syncNow()
    })
  }

  start()
}
