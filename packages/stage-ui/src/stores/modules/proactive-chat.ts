import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { attemptsInLastHour, checkProactiveGate, PROACTIVE_DEFAULTS } from '@proj-airi/stage-shared/emotion'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'

import { PROACTIVE_NOTICE_SOURCE } from '../../constants/chat'
import { useChatStore } from '../chat'
import { useChatSessionStore } from '../chat/session-store'
import { useEmotionStateStore } from './emotion-state'

/** The scheduler wakes at this rate. The gate does the real timing, so a slower tick only delays a message. */
const TICK_MS = 30_000

/**
 * Starts a conversation after a long silence. The scheduler sends a notice, not owner speech. The chat runtime already
 * stores a notice as a marked user message and lets the model answer with nothing, so a character that has nothing to
 * say stays quiet without a special path.
 *
 * Use when:
 * - The Stage is mounted, so the character is on screen and the owner can see a message.
 *
 * Expects:
 * - The store is off until the owner enables it in Settings.
 * - The active session is the owner's own conversation, not a task or a scene.
 */
export const useProactiveChatStore = defineStore('proactive-chat', () => {
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const emotion = useEmotionStateStore()

  const enabled = useLocalStorageManualReset<boolean>('emotion/proactive/enabled', false)
  const silenceMs = useLocalStorageManualReset<number>('emotion/proactive/silence-ms', PROACTIVE_DEFAULTS.silenceMs)
  const cooldownMs = useLocalStorageManualReset<number>('emotion/proactive/cooldown-ms', PROACTIVE_DEFAULTS.cooldownMs)
  const maxPerHour = useLocalStorageManualReset<number>('emotion/proactive/max-per-hour', PROACTIVE_DEFAULTS.maxPerHour)
  /** Every attempt, including one that stayed quiet. The cooldown and the hourly limit read this list. */
  const attempts = useLocalStorageManualReset<number[]>('emotion/proactive/attempts', [])
  /** Consecutive quiet answers. Each one doubles the cooldown, so the character does not try again right away. */
  const silentStreak = useLocalStorageManualReset<number>('emotion/proactive/silent-streak', 0)
  /** Why the last check did not send, for the Settings page and for debugging. */
  const lastReason = ref('disabled')

  const effectiveCooldownMs = computed(() => cooldownMs.value * 2 ** Math.min(silentStreak.value, 2))

  function pageVisible() {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  }

  function lastOwnerMessageAt(sessionId: string) {
    const messages = chatSession.getSessionMessagesIfLoaded(sessionId)
    if (!messages)
      return undefined
    const lastOwner = messages.findLast(message => message.role === 'user' && !message.notice)
    return lastOwner?.createdAt ?? lastOwner?.completedAt
  }

  async function startTopic(sessionId: string, quietMinutes: number) {
    // This tick is where the long silence changes the mood: sadness rises a little, and energy recovers.
    emotion.ingest('silence-tick')
    const snapshot = emotion.snapshot()
    const at = Date.now()
    attempts.value = [...attempts.value.filter(attempt => at - attempt < 60 * 60_000), at]

    const notice = [
      `[Proactive check] The owner has been quiet for ${Math.max(1, quietMinutes)} minutes.`,
      `Your current feeling: ${snapshot.emotion} (${Math.round(snapshot.intensity * 100)}%). Affection: ${Math.round(snapshot.affection)}/100. Energy: ${Math.round(snapshot.energy)}/100.`,
      'If a topic fits this moment, write one short message in character. If you prefer to stay quiet, reply with nothing.',
      'Do not mention this check.',
    ].join('\n')

    const result = await chat.notifyConversation(sessionId, { source: PROACTIVE_NOTICE_SOURCE, text: notice })
    const spoke = Boolean(result?.messages.some(message => message.role === 'assistant'))
    if (spoke) {
      silentStreak.value = 0
      emotion.ingest('message-sent')
    }
    else {
      // A quiet answer is a choice. Wait longer before the next attempt instead of repeating it.
      silentStreak.value = Math.min(silentStreak.value + 1, 3)
    }
  }

  async function tick() {
    if (!enabled.value)
      return

    try {
      const sessionId = chatSession.activeSessionId
      if (!sessionId)
        return

      const now = Date.now()
      const recent = attempts.value.filter(attempt => now - attempt < 60 * 60_000)
      if (recent.length !== attempts.value.length)
        attempts.value = recent

      const gate = checkProactiveGate({
        now,
        enabled: enabled.value,
        visible: pageVisible(),
        busy: chat.sending || chat.activeTurns.length > 0,
        idleSince: lastOwnerMessageAt(sessionId),
        lastAttemptAt: recent.at(-1),
        sentInLastHour: attemptsInLastHour(recent, now),
        energy: emotion.mood.energy,
        silenceMs: silenceMs.value,
        cooldownMs: effectiveCooldownMs.value,
        maxPerHour: Math.max(1, Math.round(maxPerHour.value)),
        minEnergy: PROACTIVE_DEFAULTS.minEnergy,
      })
      lastReason.value = gate.reason
      if (!gate.allowed)
        return

      await startTopic(sessionId, Math.round(gate.silentForMs / 60_000))
    }
    catch (error) {
      console.warn('[emotion] The proactive check failed:', errorMessageFrom(error))
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined

  function onVisibilityChange() {
    if (!pageVisible())
      return
    void tick()
  }

  /** Starts the scheduler once. A second call from another mounted Stage does nothing. */
  function start() {
    if (timer)
      return
    timer = setInterval(() => void tick(), TICK_MS)
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange)
    void tick()
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  // The store lives as long as the app. Dispose it with the store, so a test or a teardown leaves no timer behind.
  onScopeDispose(stop)

  function resetState() {
    enabled.reset()
    silenceMs.reset()
    cooldownMs.reset()
    maxPerHour.reset()
    attempts.reset()
    silentStreak.reset()
    lastReason.value = 'disabled'
  }

  return {
    enabled,
    silenceMs,
    cooldownMs,
    maxPerHour,
    attempts,
    lastReason,
    effectiveCooldownMs,
    start,
    stop,
    checkNow: tick,
    resetState,
  }
})
