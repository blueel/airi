import { errorMessageFrom } from '@moeru/std'
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { AUTO_SPEAK_NOTICE_SOURCE } from '../constants/chat'
import { AUTO_SPEAK_OPENING_MS, autoSpeakDueAt, randomAutoSpeakJitter } from '../libs/auto-speak'
import { useAutoSpeakStore } from '../stores/auto-speak'
import { useChatStore } from '../stores/chat'
import { useChatSessionStore } from '../stores/chat/session-store'
import { useConsciousnessStore } from '../stores/modules/consciousness'

/** She checks the conversation this often. A check only reads state, so a second is cheap. */
const AUTO_SPEAK_CHECK_INTERVAL_MS = 1_000

/**
 * Keeps the character talking while nobody talks to her.
 *
 * The switch and the idle rule live here, and the runtime's notice does the rest: the model reads that the room is
 * quiet, answers in her own voice, and the Stage speaks that reply like any other. A notice is not owner speech, so a
 * reply to it never reads as an answer to the viewer, and the model may still stay quiet when nothing fits.
 */
export function useAutoSpeak() {
  const { t } = useI18n()
  const autoSpeak = useAutoSpeakStore()
  const { enabled } = storeToRefs(autoSpeak)
  const chatOrchestrator = useChatStore()
  const chatSession = useChatSessionStore()
  const { activeSessionId, messages } = storeToRefs(chatSession)
  const { activeTurns } = storeToRefs(chatOrchestrator)
  const { chatReady } = storeToRefs(useConsciousnessStore())
  const visibility = useDocumentVisibility()

  /** When she last spoke, or when this window began to listen. Her next line counts the silence from here. */
  const askedAt = shallowRef(Date.now())
  /** Her own line is being written. A second one waits until this one ends. */
  const speaking = shallowRef(false)
  /** When her opening line is due. It is set only by the switch, so a restored switch waits out the idle time. */
  const openingAt = shallowRef(0)
  const jitterMs = shallowRef(randomAutoSpeakJitter())

  const lastMessageAt = computed(() => messages.value.reduce(
    (latest, message) => Math.max(latest, message.createdAt ?? 0),
    0,
  ))
  const dueAt = computed(() => {
    if (openingAt.value)
      return openingAt.value

    return autoSpeakDueAt({ lastMessageAt: lastMessageAt.value, askedAt: askedAt.value, jitterMs: jitterMs.value })
  })
  /** A reply of this conversation is on its way, so her own line would talk over it. */
  const generating = computed(() => activeTurns.value.some(turn => turn.sessionId === activeSessionId.value))

  watch(enabled, (on) => {
    if (!on) {
      openingAt.value = 0
      return
    }

    // The switch opens the broadcast: she greets the room instead of waiting out the first silence.
    askedAt.value = Date.now()
    jitterMs.value = randomAutoSpeakJitter()
    openingAt.value = Date.now() + AUTO_SPEAK_OPENING_MS
  })

  async function speak() {
    const sessionId = activeSessionId.value
    if (!sessionId)
      return

    speaking.value = true
    openingAt.value = 0
    askedAt.value = Date.now()
    jitterMs.value = randomAutoSpeakJitter()
    try {
      await chatOrchestrator.notifyConversation(sessionId, {
        source: AUTO_SPEAK_NOTICE_SOURCE,
        text: t('stage.chat.auto-speak.prompt'),
      })
    }
    catch (error) {
      console.warn('[auto-speak] The character could not speak on her own:', errorMessageFrom(error) ?? 'unknown error')
    }
    finally {
      speaking.value = false
      // Generation takes a while, so her silence counts from the end of it rather than from the request.
      askedAt.value = Date.now()
    }
  }

  function check() {
    // A hidden window keeps the conversation still: nobody watches, and speech would only queue up.
    if (visibility.value !== 'visible')
      return
    if (!enabled.value || !chatReady.value || speaking.value || generating.value || !activeSessionId.value)
      return
    if (Date.now() < dueAt.value)
      return

    void speak()
  }

  useIntervalFn(check, AUTO_SPEAK_CHECK_INTERVAL_MS)

  return { enabled, toggle: autoSpeak.toggle }
}
