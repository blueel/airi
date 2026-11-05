import type { LiveDanmakuEvent } from '@proj-airi/stage-shared/live-danmaku'

import { errorMessageFrom } from '@moeru/std'
import {
  DANMAKU_OP_AUTH_REPLY,
  DANMAKU_OP_HEARTBEAT_REPLY,
  DANMAKU_OP_MESSAGE,
  encodeDanmakuAuthPacket,
  encodeDanmakuHeartbeatPacket,
  parseLiveDanmakuEvent,
  readDanmakuCommandBody,
  readDanmakuSocketMessage,
} from '@proj-airi/stage-shared/live-danmaku'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import { useLiveRoomStore } from './live-room'
import { useEmotionStateStore } from './modules/emotion-state'

/** The pauses between two batches of comments that leave for the conversation. */
const BATCH_FLUSH_INTERVAL_MS = 3_000
/** A batch never carries more comments than the live room panel sends for one message. */
const BATCH_LIMIT = 6
/** The seconds between two heartbeats. Bilibili drops the socket without one. */
const HEARTBEAT_INTERVAL_MS = 30_000
/** The socket must answer the auth packet before this passes, or it starts over. */
const AUTH_TIMEOUT_MS = 5_000
/** Reconnect waits grow up to this. */
const RECONNECT_MAX_DELAY_MS = 30_000
/** One entry per danmaku source comment keeps the character from talking over every viewer. */
const MAX_COMMENTS_PER_FLUSH = BATCH_LIMIT

export type LiveDanmakuStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

/**
 * Builds a buvid3 in the shape Bilibili expects, so a guest connection carries
 * one without the owner pasting their cookie. A pasted cookie wins instead.
 */
function randomBuvid3(): string {
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}infoc`
}

/**
 * Connects to the danmaku socket of one Bilibili live room and turns what it
 * sends into the app's own flows: viewer lines join the live room conversation
 * the way the screen reader delivers them, and gifts and super chats raise the
 * character's mood.
 *
 * The `getDanmuInfo` request goes through `/api/live/danmu-info`, which the dev
 * and preview servers proxy to Bilibili: the socket itself connects cross-origin
 * without trouble, but that one request is blocked by CORS.
 */
export const useLiveDanmakuStore = defineStore('live-danmaku', () => {
  const roomId = useLocalStorage('ui/chat/live-danmaku/room-id', '')
  /** A paste of the owner's Bilibili cookie. Guests work without it until Bilibili tightens. */
  const cookie = useLocalStorage('ui/chat/live-danmaku/cookie', '')
  /** Whether a gift or a super chat moves the mood. */
  const giftsAffectMood = useLocalStorage('ui/chat/live-danmaku/gifts-affect-mood', true)

  const status = shallowRef<LiveDanmakuStatus>('idle')
  const lastError = shallowRef('')
  const commentsReceived = ref(0)
  const giftsReceived = ref(0)
  const superChatsReceived = ref(0)
  const popularity = ref(0)

  let socket: WebSocket | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let authTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  /** Set when the owner pressed the switch, so a closed socket stays closed. */
  let stopping = false
  const pendingComments: { name: string, text: string }[] = []

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    if (authTimer) {
      clearTimeout(authTimer)
      authTimer = undefined
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = undefined
    }
  }

  function closeSocket() {
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      }
      catch {
        // A socket that already died needs no closing.
      }
      socket = undefined
    }
    clearTimers()
  }

  async function fetchDanmuInfo(id: number): Promise<{ token: string, host: string, port: number }> {
    const headers: Record<string, string> = {}
    const pasted = cookie.value.trim()
    if (pasted)
      headers['x-danmaku-cookie'] = pasted

    const response = await fetch(`/api/live/danmu-info?id=${id}&type=0`, { headers })
    const payload = await response.json().catch(() => undefined) as { code?: number, message?: string, data?: { token?: string, host_list?: Array<{ host: string, wss_port: number }> } } | undefined
    if (!payload || payload.code !== 0 || !payload.data?.token || !payload.data.host_list?.length)
      throw new Error(`Bilibili getDanmuInfo failed: ${payload?.message ?? response.status}`)
    const host = payload.data.host_list[0]!
    return { token: payload.data.token, host: host.host, port: host.wss_port }
  }

  function handleEvent(event: LiveDanmakuEvent) {
    switch (event.kind) {
      case 'comment': {
        commentsReceived.value++
        pendingComments.push(event.comment)
        scheduleBatch()
        break
      }
      case 'gift': {
        giftsReceived.value++
        if (giftsAffectMood.value)
          useEmotionStateStore().ingest('gift')
        break
      }
      case 'super-chat': {
        superChatsReceived.value++
        pendingComments.push({ name: event.superChat.name, text: `SC ¥${event.superChat.priceCny}：${event.superChat.text}` })
        scheduleBatch()
        if (giftsAffectMood.value)
          useEmotionStateStore().ingest('gift')
        break
      }
    }
  }

  function scheduleBatch() {
    if (batchTimer || pendingComments.length === 0)
      return
    batchTimer = setTimeout(flushBatch, BATCH_FLUSH_INTERVAL_MS)
  }

  function flushBatch() {
    batchTimer = undefined
    if (pendingComments.length === 0)
      return
    const batch = pendingComments.splice(0, MAX_COMMENTS_PER_FLUSH)
    const sent = useLiveRoomStore().pushExternalComments(batch)
    // The turn is busy or the panel holds the comments. They wait for the next round.
    if (sent < batch.length)
      pendingComments.unshift(...batch.slice(sent))
    scheduleBatch()
  }

  async function handleMessage(data: ArrayBuffer | Uint8Array<ArrayBuffer>) {
    for (const message of await readDanmakuSocketMessage(data)) {
      if (message.operation === DANMAKU_OP_HEARTBEAT_REPLY) {
        popularity.value = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength).getUint32(0)
        continue
      }
      if (message.operation === DANMAKU_OP_AUTH_REPLY) {
        // The room accepted the packet. From here the heartbeat keeps it alive.
        if (authTimer) {
          clearTimeout(authTimer)
          authTimer = undefined
        }
        reconnectAttempts = 0
        status.value = 'connected'
        lastError.value = ''
        startHeartbeat()
        continue
      }
      if (message.operation !== DANMAKU_OP_MESSAGE)
        continue
      const read = readDanmakuCommandBody(message.body)
      if (!read)
        continue
      const event = parseLiveDanmakuEvent(read.cmd, read.payload)
      if (event)
        handleEvent(event)
    }
  }

  function scheduleReconnect() {
    if (stopping)
      return
    status.value = 'reconnecting'
    reconnectAttempts++
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 2_000 * 2 ** Math.min(reconnectAttempts, 4))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, delay)
  }

  async function connect() {
    if (status.value === 'connected' || status.value === 'connecting')
      return
    if (typeof WebSocket === 'undefined') {
      lastError.value = 'WebSocket is unavailable in this runtime'
      return
    }

    stopping = false
    const id = Number.parseInt(roomId.value, 10)
    if (!Number.isFinite(id) || id <= 0) {
      lastError.value = 'A numeric room id is needed'
      return
    }

    closeSocket()
    status.value = 'connecting'
    lastError.value = ''

    let token: string
    let host: string
    let port: number
    try {
      ;({ token, host, port } = await fetchDanmuInfo(id))
    }
    catch (error) {
      status.value = 'idle'
      lastError.value = errorMessageFrom(error) ?? 'Failed to reach Bilibili'
      return
    }

    const buvid = cookie.value.match(/buvid3=([^;]+)/)?.[1] ?? randomBuvid3()
    const ws = new WebSocket(`wss://${host}:${port}/sub`)
    socket = ws
    ws.binaryType = 'arraybuffer'

    authTimer = setTimeout(() => {
      // No auth reply means the room never accepted the connection.
      lastError.value = 'The danmaku server did not answer the auth packet'
      closeSocket()
      scheduleReconnect()
    }, AUTH_TIMEOUT_MS)

    ws.onopen = () => {
      ws.send(encodeDanmakuAuthPacket({ uid: 0, roomId: id, key: token, buvid, protocolVersion: 2 }))
    }

    ws.onmessage = (event) => {
      try {
        const data = event.data instanceof ArrayBuffer ? event.data : new Uint8Array(event.data as ArrayBuffer)
        void handleMessage(data).catch((error) => {
          lastError.value = errorMessageFrom(error) ?? 'Failed to read a danmaku message'
        })
      }
      catch (error) {
        lastError.value = errorMessageFrom(error) ?? 'Failed to read a danmaku message'
      }
    }

    ws.onclose = () => {
      clearTimers()
      socket = undefined
      scheduleReconnect()
    }

    ws.onerror = () => {
      lastError.value = 'The danmaku socket failed'
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer)
      clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(encodeDanmakuHeartbeatPacket())
    }, HEARTBEAT_INTERVAL_MS)
  }

  function disconnect() {
    stopping = true
    reconnectAttempts = 0
    closeSocket()
    status.value = 'idle'
  }

  function toggle() {
    if (status.value === 'idle' || status.value === 'reconnecting')
      void connect()
    else
      disconnect()
  }

  function reset() {
    disconnect()
    pendingComments.length = 0
    commentsReceived.value = 0
    giftsReceived.value = 0
    superChatsReceived.value = 0
    popularity.value = 0
    lastError.value = ''
  }

  return {
    roomId,
    cookie,
    giftsAffectMood,
    status,
    lastError,
    commentsReceived,
    giftsReceived,
    superChatsReceived,
    popularity,

    connect,
    disconnect,
    toggle,
    reset,
  }
})
