import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { attemptsInLastHour, checkProactiveGate, PROACTIVE_DEFAULTS } from '@proj-airi/stage-shared/emotion'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'

import { PROACTIVE_NOTICE_SOURCE } from '../../constants/chat'
import { extractMessageText } from '../../libs/chat-sync/wire-message'
import { deliverCharacterNotification, getCharacterNotificationStatus } from '../../libs/notifications'
import { useChatStore } from '../chat'
import { useChatSessionStore } from '../chat/session-store'
import { useEmotionStateStore } from './emotion-state'

/** The scheduler wakes at this rate. The gate does the real timing, so a slower tick only delays a message. */
const TICK_MS = 30_000

/** A notification body stays one short line. The full reply is in the chat. */
const NOTIFICATION_BODY_CHARS = 240

export interface ProactiveStartOptions {
  /** Returns the character name for the notification title. Defaults to the app name. */
  title?: () => string
}

function notificationBody(text: string) {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > NOTIFICATION_BODY_CHARS ? `${plain.slice(0, NOTIFICATION_BODY_CHARS - 1)}…` : plain
}

/**
 * Starts a conversation after a long silence. The scheduler sends a notice, not owner speech. The chat runtime already
 * stores a notice as a marked user message and lets the model answer with nothing, so a character that has nothing to
 * say stays quiet without a special path.
 *
 * Use when:
 * - The Stage is mounted, so the character can speak and the owner can see the reply.
 * - Or the page is hidden and the owner allowed background messages, so the reply arrives as a system notification.
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
  /**
   * Whether a hidden page may start a topic. The reply goes to a system notification, because nobody is looking at the chat.
   * Off means the scheduler waits until the page is visible again.
   */
  const notifyWhenHidden = useLocalStorageManualReset<boolean>('emotion/proactive/notify-when-hidden', true)
  /** Every attempt, including one that stayed quiet. The cooldown and the hourly limit read this list. */
  const attempts = useLocalStorageManualReset<number[]>('emotion/proactive/attempts', [])
  /** Consecutive quiet answers. Each one doubles the cooldown, so the character does not try again right away. */
  const silentStreak = useLocalStorageManualReset<number>('emotion/proactive/silent-streak', 0)
  /** Why the last check did not send, for the Settings page and for debugging. */
  const lastReason = ref('disabled')
  let characterTitle = () => 'AIRI'

  const effectiveCooldownMs = computed(() => cooldownMs.value * 2 ** Math.min(silentStreak.value, 2))

  function pageVisible() {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  }

  /** The owner is looking at the chat, not another tab, window, or app. */
  function pageInFront() {
    return pageVisible() && (typeof document === 'undefined' || document.hasFocus())
  }

  /**
   * Whether a hidden page can reach the owner through a notification. The permission can change in system settings,
   * so a hidden page reads it at most once a minute instead of on every tick.
   */
  let backgroundAllowedUntil = 0
  let backgroundAllowedNow = false

  async function canUseBackgroundNotifications() {
    const now = Date.now()
    if (now < backgroundAllowedUntil)
      return backgroundAllowedNow

    const status = await getCharacterNotificationStatus()
    backgroundAllowedNow = status.permission === 'granted' && !status.channelBlocked
    backgroundAllowedUntil = now + 60_000
    return backgroundAllowedNow
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
    const reply = result?.messages.findLast(message => message.role === 'assistant')
    const replyText = reply ? extractMessageText(reply).trim() : ''
    const spoke = Boolean(result?.messages.some(message => message.role === 'assistant'))
    if (spoke) {
      silentStreak.value = 0
      emotion.ingest('message-sent')
    }
    else {
      // A quiet answer is a choice. Wait longer before the next attempt instead of repeating it.
      silentStreak.value = Math.min(silentStreak.value + 1, 3)
    }

    if (replyText && notifyWhenHidden.value && !pageInFront()) {
      void deliverCharacterNotification({
        title: characterTitle(),
        body: notificationBody(replyText),
        sessionId,
      })
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

      const visible = pageVisible()
      const backgroundAllowed = !visible
        && notifyWhenHidden.value
        && await canUseBackgroundNotifications()

      const gate = checkProactiveGate({
        now,
        enabled: enabled.value,
        visible,
        backgroundAllowed,
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
  function start(options: ProactiveStartOptions = {}) {
    if (options.title)
      characterTitle = options.title
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
    notifyWhenHidden.reset()
    attempts.reset()
    silentStreak.reset()
    lastReason.value = 'disabled'
  }

  return {
    enabled,
    silenceMs,
    cooldownMs,
    maxPerHour,
    notifyWhenHidden,
    attempts,
    lastReason,
    effectiveCooldownMs,
    start,
    stop,
    checkNow: tick,
    resetState,
  }
})
