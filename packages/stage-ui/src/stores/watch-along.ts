import type { WatchAlongFrame } from '../libs/watch-along'
import type { WatchAlongCaptureSource } from '../libs/watch-along-capture'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { useVisionInference } from '../composables/vision'
import { WATCH_ALONG_NOTICE_SOURCE } from '../constants/chat'
import { isNotableCompanionDescription, WATCH_ALONG_COMMENT_COOLDOWN_MS, WATCH_ALONG_DEFAULT_INTERVAL_MS, watchAlongFrameChanged } from '../libs/watch-along'
import { createBrowserWatchAlongCapture } from '../libs/watch-along-capture'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useVisionStore } from './modules/vision'

const registeredCapture = shallowRef<WatchAlongCaptureSource>()

/**
 * Lets a host replace the browser screen share with its own capture.
 *
 * The Android app registers the floating bubble, which keeps the MediaProjection session alive while the owner
 * uses another app. Other hosts keep the browser source.
 */
export function registerWatchAlongCaptureSource(source: WatchAlongCaptureSource) {
  registeredCapture.value = source
}

/**
 * Watches the owner's screen with them.
 *
 * Each interval reads one frame, asks the vision model to describe what is happening, and sends the description to
 * the conversation as a notice. The character answers in her own voice when a reaction fits.
 *
 * Use when:
 * - The owner watches a video, plays a game, or works, and wants company.
 *
 * Expects:
 * - A configured vision provider.
 * - On Android, the floating bubble runs and holds the screen capture session.
 */
export const useWatchAlongStore = defineStore('watch-along', () => {
  const { t } = useI18n()
  const { runVisionInference } = useVisionInference()

  /** The pause between two looks. The value is read at start, so a running mode keeps its cadence. */
  const intervalMs = useLocalStorage('ui/chat/watch-along/interval-ms', WATCH_ALONG_DEFAULT_INTERVAL_MS)
  const running = shallowRef(false)
  const starting = shallowRef(false)
  const reading = shallowRef(false)
  const lastError = shallowRef('')
  /** The newest frame, for the panel preview. */
  const lastFrame = shallowRef('')
  const lastDescription = shallowRef('')
  const lastSentAt = shallowRef(0)
  const comments = shallowRef(0)
  const previewStream = shallowRef<MediaStream | null>(null)
  const source = shallowRef<WatchAlongCaptureSource>()
  const kind = computed(() => registeredCapture.value?.kind ?? 'screen')
  let lastHash: string | undefined
  let startVersion = 0

  async function start() {
    if (running.value || starting.value)
      return

    const vision = useVisionStore()
    if (!vision.configured) {
      lastError.value = t('stage.chat.watch-along.errors.vision')
      return
    }
    if (!registeredCapture.value && !navigator.mediaDevices?.getDisplayMedia) {
      lastError.value = t('stage.chat.watch-along.errors.unsupported')
      return
    }

    const version = ++startVersion
    const next = registeredCapture.value ?? createBrowserWatchAlongCapture()
    starting.value = true
    lastError.value = ''
    try {
      await next.start({
        intervalMs: intervalMs.value,
        onFrame: (frame) => {
          void processFrame(frame, next)
        },
        onEnded: () => {
          void stop()
        },
        onError: (error) => {
          lastError.value = errorMessageFrom(error) ?? t('stage.chat.watch-along.errors.capture')
        },
      })
      if (version !== startVersion) {
        await next.stop()
        return
      }

      source.value = next
      previewStream.value = next.previewStream ?? null
      running.value = true
      lastHash = undefined
      comments.value = 0
      lastSentAt.value = 0
      lastDescription.value = ''
      lastFrame.value = ''
    }
    catch (error) {
      // A picker that the owner closed is not a failure worth a message.
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        return
      lastError.value = errorMessageFrom(error) ?? t('stage.chat.watch-along.errors.start')
    }
    finally {
      if (version === startVersion)
        starting.value = false
    }
  }

  async function stop() {
    startVersion++
    running.value = false
    starting.value = false
    reading.value = false
    lastHash = undefined
    previewStream.value = null
    const current = source.value
    source.value = undefined
    if (current)
      await current.stop().catch(error => console.warn('[watch-along] Could not stop the capture:', errorMessageFrom(error) ?? 'unknown error'))
  }

  async function toggle() {
    if (running.value || starting.value)
      await stop()
    else
      await start()
  }

  async function processFrame(frame: WatchAlongFrame, owner: WatchAlongCaptureSource) {
    if (!running.value || source.value !== owner)
      return

    lastFrame.value = frame.dataUrl
    if (reading.value)
      return
    if (!watchAlongFrameChanged(lastHash, frame.hash))
      return

    const chat = useChatStore()
    const session = useChatSessionStore()
    const sessionId = session.activeSessionId
    if (!sessionId)
      return
    // Her reply is on its way. The next frame comes after it, so the two do not talk over each other.
    if (chat.activeTurns.some(turn => turn.sessionId === sessionId))
      return
    if (!useVisionStore().configured) {
      lastError.value = t('stage.chat.watch-along.errors.vision')
      return
    }
    // One line a minute is enough company. The frame stays unseen, so the next look after the gap still reads it.
    if (lastSentAt.value && Date.now() - lastSentAt.value < WATCH_ALONG_COMMENT_COOLDOWN_MS)
      return

    lastHash = frame.hash
    reading.value = true
    try {
      const description = (await runVisionInference({
        imageDataUrl: frame.dataUrl,
        workloadId: 'screen:companion',
      })).trim()
      lastDescription.value = description
      lastError.value = ''
      if (!isNotableCompanionDescription(description))
        return

      // The owner may have started a turn while the vision model read the frame.
      if (chat.activeTurns.some(turn => turn.sessionId === sessionId))
        return

      lastSentAt.value = Date.now()
      const header = t('stage.chat.watch-along.message-header')
      const request = t('stage.chat.watch-along.message-request')
      const sent = await chat.notifyConversation(sessionId, {
        source: WATCH_ALONG_NOTICE_SOURCE,
        text: `${header}\n${description}\n${request}`,
      })
      if (sent?.messages.some(message => message.role === 'assistant'))
        comments.value += 1
      lastError.value = ''
    }
    catch (error) {
      lastHash = undefined
      if (error instanceof DOMException && error.name === 'AbortError')
        return
      lastError.value = errorMessageFrom(error) ?? t('stage.chat.watch-along.errors.read')
    }
    finally {
      reading.value = false
    }
  }

  return {
    kind,
    intervalMs,
    running,
    starting,
    reading,
    lastError,
    lastFrame,
    lastDescription,
    lastSentAt,
    comments,
    previewStream,
    start,
    stop,
    toggle,
  }
})
