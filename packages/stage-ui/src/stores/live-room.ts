import type { LiveRoomComment, LiveRoomRect } from '../libs/live-room'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { LIVE_ROOM_NOTICE_SOURCE } from '../constants/chat'
import {
  clampLiveRoomRect,
  LIVE_ROOM_DEFAULT_INTERVAL_MS,
  LIVE_ROOM_MAX_COMMENTS_PER_MESSAGE,
  LIVE_ROOM_MAX_CROP_WIDTH,
  LIVE_ROOM_SEEN_LIMIT,
  liveRoomCommentKey,
  liveRoomCropRegion,
  liveRoomRectIsUsable,
  parseLiveRoomComments,
  selectFreshComments,
} from '../libs/live-room'
import { loadLocalOcr, localOcrIsReady, readLocalOcr } from '../libs/local-ocr'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'

/** The pauses that the panel offers between two reads of the region. */
export const LIVE_ROOM_INTERVAL_OPTIONS = [2_000, 4_000, 6_000, 10_000]
/** The last comments stay in the panel for the reader, even after the region scrolled them out. */
const LIVE_ROOM_RECENT_LIMIT = 12

/** Where the local reader stands. The first read loads 15 MB of models before it recognizes anything. */
export type LiveRoomOcrState = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * Reads the viewer comments of a live room from one region of the shared screen.
 *
 * The region holds the comment list of the room, which the browser shows like any other page. A local reader
 * (PaddleOCR on ONNX Runtime, running in this tab) reads that region as text on a pause, and every comment goes to the
 * conversation as a notice, so the character answers a viewer rather than the owner. Recognized text never leaves the
 * machine, and nothing about the screen is sent anywhere.
 */
export const useLiveRoomStore = defineStore('live-room', () => {
  const { t } = useI18n()

  /** The region of the screen that holds the comments, kept across reloads. */
  const region = useLocalStorage<LiveRoomRect | null>('ui/chat/live-room/region', null)
  /** How long the region rests between two reads. */
  const intervalMs = useLocalStorage('ui/chat/live-room/interval-ms', LIVE_ROOM_DEFAULT_INTERVAL_MS)
  /** Whether a read comment goes to the conversation, or only to this panel. */
  const sendToChat = useLocalStorage('ui/chat/live-room/send-to-chat', true)

  const stream = shallowRef<MediaStream | null>(null)
  const sharing = shallowRef(false)
  /** Reads run on a timer while this is true. Sharing alone reads nothing. */
  const running = shallowRef(false)
  const reading = shallowRef(false)
  const lastError = shallowRef('')
  const lastReadAt = shallowRef(0)
  const lastSentAt = shallowRef(0)
  /** How many comments reached the conversation since the panel opened. */
  const received = ref(0)
  const recent = shallowRef<LiveRoomComment[]>([])
  /** The local reader builds once, on the first read or when the panel opens. */
  const ocrState = shallowRef<LiveRoomOcrState>(localOcrIsReady() ? 'ready' : 'idle')

  /** Keys of the comments that already left, so one that stays on screen is sent once. */
  const seen = new Set<string>()
  const seenOrder: string[] = []
  let captureVideo: HTMLVideoElement | undefined
  let readTimer: ReturnType<typeof setTimeout> | undefined

  function remember(comments: LiveRoomComment[]) {
    for (const comment of comments) {
      const key = liveRoomCommentKey(comment)
      if (seen.has(key))
        continue
      seen.add(key)
      seenOrder.push(key)
    }
    while (seenOrder.length > LIVE_ROOM_SEEN_LIMIT) {
      const oldest = seenOrder.shift()
      if (oldest)
        seen.delete(oldest)
    }
  }

  function clearTimer() {
    if (readTimer)
      clearTimeout(readTimer)
    readTimer = undefined
  }

  /** The pixels of the stored region of one frame, kept small enough to read without paying for a large image. */
  function cropFrame(video: HTMLVideoElement, area: LiveRoomRect) {
    const crop = liveRoomCropRegion(area, video.videoWidth, video.videoHeight)
    const scale = Math.min(1, LIVE_ROOM_MAX_CROP_WIDTH / crop.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(crop.width * scale))
    canvas.height = Math.max(1, Math.round(crop.height * scale))
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('Canvas is unavailable')

    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9)
  }

  /** One screen frame that the reader reads. A detached video keeps decoding, so it is mounted out of the way. */
  function mountCaptureVideo(media: MediaStream) {
    const video = captureVideo ?? document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = media
    if (!video.isConnected) {
      video.setAttribute('aria-hidden', 'true')
      video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      document.body.appendChild(video)
    }
    captureVideo = video
    return video
  }

  function stopSharing() {
    clearTimer()
    running.value = false
    reading.value = false
    for (const track of stream.value?.getTracks() ?? [])
      track.stop()
    stream.value = null
    sharing.value = false
    if (captureVideo) {
      captureVideo.srcObject = null
      captureVideo.remove()
      captureVideo = undefined
    }
  }

  /** Shares the screen that holds the live room. The browser asks which one on every call. */
  async function share() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      lastError.value = t('stage.chat.live-room.unsupported')
      throw new Error('Screen capture is unavailable')
    }

    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      })
    }
    catch (error) {
      // A picker that the owner closed is not a failure worth a message.
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        return
      lastError.value = errorMessageFrom(error) ?? t('stage.chat.live-room.share-failed')
      throw error
    }

    stopSharing()
    stream.value = media
    sharing.value = true
    lastError.value = ''

    const video = mountCaptureVideo(media)
    try {
      await video.play()
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) ?? t('stage.chat.live-room.share-failed')
    }

    media.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopSharing()
    }, { once: true })
  }

  /** Sets the region that a drag selected, in fractions of the preview. */
  function setRegion(next: LiveRoomRect | null) {
    region.value = next ? clampLiveRoomRect(next) : null
  }

  function composeMessage(comments: LiveRoomComment[]) {
    return [
      t('stage.chat.live-room.message-header'),
      ...comments.map(comment => comment.name ? `${comment.name}：${comment.text}` : comment.text),
      t('stage.chat.live-room.message-request'),
    ].join('\n')
  }

  async function readOnce() {
    const video = captureVideo
    const area = region.value
    if (reading.value || !running.value || !video || !area || !liveRoomRectIsUsable(area))
      return
    if (video.readyState < 2 || !video.videoWidth)
      return
    const chat = useChatStore()
    const session = useChatSessionStore()
    const sessionId = session.activeSessionId
    if (!sessionId)
      return
    // Her reply is on its way. The comments stay on the screen, so they come next round instead of talking over her.
    if (chat.activeTurns.some(turn => turn.sessionId === sessionId))
      return

    reading.value = true
    try {
      const image = cropFrame(video, area)
      const lines = await readLocalOcr(image)
      lastReadAt.value = Date.now()

      const fresh = selectFreshComments(parseLiveRoomComments(lines.join('\n')), seen)
      if (!fresh.length)
        return

      const batch = fresh.slice(0, LIVE_ROOM_MAX_COMMENTS_PER_MESSAGE)
      remember(batch)
      recent.value = [...batch, ...recent.value].slice(0, LIVE_ROOM_RECENT_LIMIT)
      received.value += batch.length
      lastError.value = ''

      if (sendToChat.value) {
        lastSentAt.value = Date.now()
        // The reply takes a while, and this loop only schedules the next read.
        void chat.notifyConversation(sessionId, {
          source: LIVE_ROOM_NOTICE_SOURCE,
          text: composeMessage(batch),
        })
      }
    }
    catch (error) {
      // A read that the vision module cancels, for example when it is switched off, needs no report.
      if (error instanceof DOMException && error.name === 'AbortError')
        return
      lastError.value = errorMessageFrom(error) ?? t('stage.chat.live-room.read-failed')
    }
    finally {
      reading.value = false
    }
  }

  function scheduleNextRead() {
    clearTimer()
    if (!running.value)
      return
    readTimer = setTimeout(() => {
      void tick()
    }, intervalMs.value)
  }

  async function tick() {
    if (!running.value)
      return
    // A hidden window shows nothing new, and its reads only cost.
    if (document.visibilityState === 'visible')
      await readOnce()
    scheduleNextRead()
  }

  /** The load that runs now. Two presses of the switch share it instead of starting a second one. */
  let preparing: Promise<boolean> | undefined

  /** Builds the local reader, so the first read of a region does not also wait for its models. */
  async function prepareReader() {
    if (ocrState.value === 'ready')
      return true

    preparing ??= (async () => {
      ocrState.value = 'loading'
      lastError.value = ''
      try {
        await loadLocalOcr()
        ocrState.value = 'ready'
        return true
      }
      catch (error) {
        ocrState.value = 'failed'
        lastError.value = errorMessageFrom(error) ?? t('stage.chat.live-room.ocr-failed')
        return false
      }
      finally {
        preparing = undefined
      }
    })()

    return preparing
  }

  /**
   * Receives comments that a source other than the screen reader produced, for
   * example the danmaku socket. They share the seen list, the panel, and the
   * conversation. Resolves to the number of comments that reached the chat: 0
   * means the turn is busy, and the caller keeps the comments for next time.
   */
  function pushExternalComments(incoming: LiveRoomComment[]) {
    const fresh = selectFreshComments(incoming, seen)
    if (!fresh.length)
      return 0
    const batch = fresh.slice(0, LIVE_ROOM_MAX_COMMENTS_PER_MESSAGE)
    remember(batch)
    recent.value = [...batch, ...recent.value].slice(0, LIVE_ROOM_RECENT_LIMIT)
    received.value += batch.length
    if (!sendToChat.value)
      return batch.length

    const chat = useChatStore()
    const session = useChatSessionStore()
    const sessionId = session.activeSessionId
    if (!sessionId)
      return 0
    // Her reply is on its way. The caller keeps the comments, so they come next round instead of talking over her.
    if (chat.activeTurns.some(turn => turn.sessionId === sessionId))
      return 0

    lastSentAt.value = Date.now()
    void chat.notifyConversation(sessionId, {
      source: LIVE_ROOM_NOTICE_SOURCE,
      text: composeMessage(batch),
    })
    return batch.length
  }

  /** Starts reading the region. Sharing, a usable region, and the local reader must all be there first. */
  async function startReading() {
    if (!stream.value) {
      lastError.value = t('stage.chat.live-room.share-first')
      return
    }
    if (!liveRoomRectIsUsable(region.value)) {
      lastError.value = t('stage.chat.live-room.region-first')
      return
    }
    if (!await prepareReader())
      return

    lastError.value = ''
    running.value = true
    void tick()
  }

  function stopReading() {
    clearTimer()
    running.value = false
  }

  function toggleReading() {
    if (running.value) {
      stopReading()
      return
    }
    void startReading()
  }

  function reset() {
    stopSharing()
    seen.clear()
    seenOrder.length = 0
    recent.value = []
    received.value = 0
    lastReadAt.value = 0
    lastSentAt.value = 0
    lastError.value = ''
  }

  return {
    region,
    intervalMs,
    sendToChat,
    stream,
    sharing,
    running,
    reading,
    lastError,
    lastReadAt,
    lastSentAt,
    received,
    recent,
    ocrState,

    share,
    stopSharing,
    setRegion,
    pushExternalComments,
    startReading,
    stopReading,
    toggleReading,
    prepareReader,
    reset,
  }
})
