import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import type { RawData } from 'ws'

import type { OneBotActionResponse, OneBotMessage, OneBotMessageEvent, OneBotMessageSegment, OneBotSender } from './types'

import { Buffer as NodeBuffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { useLogg } from '@guiiai/logg'
import { WebSocket, WebSocketServer } from 'ws'

/** How long one action may wait for its answer before the caller sees a timeout. */
const ACTION_TIMEOUT_MS = 30_000

export interface OneBotServerOptions {
  host: string
  port: number
  path: string
  token?: string
  onMessage: (event: OneBotMessageEvent) => void
}

interface PendingAction {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function frameToText(raw: RawData): string {
  if (Array.isArray(raw))
    return NodeBuffer.concat(raw).toString('utf8')

  if (raw instanceof ArrayBuffer)
    return NodeBuffer.from(raw).toString('utf8')

  return raw.toString('utf8')
}

function toSender(raw: unknown): OneBotSender | undefined {
  if (!raw || typeof raw !== 'object')
    return undefined

  const { user_id, nickname, card, role } = raw as { user_id?: unknown, nickname?: unknown, card?: unknown, role?: unknown }

  return {
    user_id: typeof user_id === 'number' ? user_id : undefined,
    nickname: typeof nickname === 'string' ? nickname : undefined,
    card: typeof card === 'string' ? card : undefined,
    role: typeof role === 'string' ? role : undefined,
  }
}

function toMessage(raw: unknown): OneBotMessage | undefined {
  if (typeof raw === 'string')
    return raw

  if (!Array.isArray(raw))
    return undefined

  const segments: OneBotMessageSegment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object')
      continue

    const { type, data } = item as { type?: unknown, data?: unknown }
    if (typeof type !== 'string' || !data || typeof data !== 'object')
      continue

    segments.push({ type, data: data as Record<string, unknown> })
  }

  return segments
}

function toMessageEvent(record: Record<string, unknown>): OneBotMessageEvent | undefined {
  if (record.post_type !== 'message')
    return undefined

  const messageType = record.message_type
  if (messageType !== 'private' && messageType !== 'group')
    return undefined

  const { self_id, user_id, message_id, raw_message } = record
  if (typeof self_id !== 'number' || typeof user_id !== 'number' || typeof message_id !== 'number')
    return undefined

  if (typeof raw_message !== 'string')
    return undefined

  const message = toMessage(record.message)
  if (!message)
    return undefined

  return {
    post_type: 'message',
    message_type: messageType,
    self_id,
    user_id,
    message_id,
    raw_message,
    message,
    group_id: typeof record.group_id === 'number' ? record.group_id : undefined,
    sender: toSender(record.sender),
  }
}

function toActionResponse(record: Record<string, unknown>): OneBotActionResponse {
  const status = record.status === 'ok' || record.status === 'async' ? record.status : 'failed'

  return {
    status,
    retcode: typeof record.retcode === 'number' ? record.retcode : -1,
    data: record.data,
    echo: typeof record.echo === 'string' ? record.echo : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    wording: typeof record.wording === 'string' ? record.wording : undefined,
  }
}

/**
 * Accepts the connection that NapCat / LLOneBot opens towards this plugin (OneBot's reverse
 * WebSocket), then uses that same connection to call the send actions. A single socket carries both
 * directions, so the bridge needs no second HTTP endpoint.
 */
export class OneBotServer {
  private readonly log = useLogg('OneBotServer').useGlobalConfig()
  private readonly options: OneBotServerOptions
  private readonly httpServer: Server
  private readonly wss: WebSocketServer
  private readonly pending = new Map<string, PendingAction>()
  private active?: WebSocket
  private selfId?: number

  constructor(options: OneBotServerOptions) {
    this.options = options
    this.httpServer = createServer((_, response) => {
      response.writeHead(426, { 'content-type': 'text/plain' })
      response.end('This endpoint speaks WebSocket only.')
    })
    this.wss = new WebSocketServer({ noServer: true })

    this.httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head)
    })

    this.wss.on('connection', socket => this.handleConnection(socket))
  }

  get isConnected(): boolean {
    return this.active?.readyState === WebSocket.OPEN
  }

  get accountId(): number | undefined {
    return this.selfId
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject)
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off('error', reject)
        resolve()
      })
    })

    this.log.log(`Waiting for a OneBot client on ws://${this.options.host}:${this.options.port}${this.options.path}`)
  }

  async stop(): Promise<void> {
    this.failPending(new Error('The OneBot server stopped'))
    for (const socket of this.wss.clients)
      socket.close()

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve())
      this.httpServer.closeAllConnections()
    })
  }

  async sendGroupMessage(groupId: number, text: string): Promise<void> {
    await this.call('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }],
    })
  }

  async sendPrivateMessage(userId: number, text: string): Promise<void> {
    await this.call('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
    })
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (stripTrailingSlash(url.pathname) !== stripTrailingSlash(this.options.path)) {
      socket.destroy()
      return
    }

    if (!this.isAuthorized(request, url)) {
      this.log.warn('Rejected a OneBot connection that carried a wrong token')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(request, socket, head, (client) => {
      this.wss.emit('connection', client, request)
    })
  }

  private isAuthorized(request: IncomingMessage, url: URL): boolean {
    const token = this.options.token
    if (!token)
      return true

    const header = request.headers.authorization
    if (header === `Bearer ${token}` || header === `Token ${token}`)
      return true

    return url.searchParams.get('access_token') === token
  }

  private handleConnection(socket: WebSocket): void {
    this.active = socket
    this.log.log('OneBot client connected')

    socket.on('message', data => this.handleFrame(data))
    socket.on('error', error => this.log.withError(error).warn('OneBot socket failed'))
    socket.on('close', () => {
      if (this.active !== socket)
        return

      this.active = undefined
      this.failPending(new Error('The OneBot client disconnected'))
      this.log.warn('OneBot client disconnected, waiting for it to reconnect')
    })
  }

  private handleFrame(raw: RawData): void {
    let payload: unknown
    try {
      payload = JSON.parse(frameToText(raw))
    }
    catch {
      this.log.warn('Ignored a OneBot frame that is not valid JSON')
      return
    }

    if (!payload || typeof payload !== 'object')
      return

    const record = payload as Record<string, unknown>

    if (typeof record.echo === 'string') {
      this.settle(toActionResponse(record))
      return
    }

    const event = toMessageEvent(record)
    if (!event)
      return

    if (this.selfId !== event.self_id) {
      this.selfId = event.self_id
      this.log.log(`Serving QQ account ${event.self_id}`)
    }

    this.options.onMessage(event)
  }

  private settle(response: OneBotActionResponse): void {
    const echo = response.echo
    if (!echo)
      return

    const pending = this.pending.get(echo)
    if (!pending)
      return

    clearTimeout(pending.timer)
    this.pending.delete(echo)

    if (response.retcode === 0 || response.status === 'ok') {
      pending.resolve(response.data)
      return
    }

    const detail = response.wording ?? response.message ?? `retcode ${response.retcode}`
    pending.reject(new Error(`OneBot action failed: ${detail}`))
  }

  private failPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(echo)
    }
  }

  private call<T>(action: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.active
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('No OneBot client is connected'))

    const echo = randomUUID()
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.pending.delete(echo)
      reject(new Error(`OneBot action ${action} timed out after ${ACTION_TIMEOUT_MS}ms`))
    }, ACTION_TIMEOUT_MS)

    this.pending.set(echo, { resolve, reject, timer })

    socket.send(JSON.stringify({ action, params, echo }), (error) => {
      if (!error)
        return

      const pending = this.pending.get(echo)
      if (!pending)
        return

      clearTimeout(pending.timer)
      this.pending.delete(echo)
      pending.reject(error)
    })

    return promise as Promise<T>
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}
