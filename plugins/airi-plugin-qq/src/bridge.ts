import type { WebSocketBaseEvent, WebSocketEvents } from '@proj-airi/server-sdk'

import type { QQAirIConfig } from './config'
import type { ParsedIncomingMessage } from './onebot/message'
import type { OneBotMessageEvent } from './onebot/types'

import { useLogg } from '@guiiai/logg'
import { Client } from '@proj-airi/server-sdk'

import { chunkText, parseIncomingMessage } from './onebot/message'
import { OneBotServer } from './onebot/server'

type ChatCompleteEvent = WebSocketBaseEvent<'output:gen-ai:chat:complete', WebSocketEvents['output:gen-ai:chat:complete']>

interface QQTarget {
  kind: 'group' | 'user'
  id: number
}

/**
 * One conversation per group, and one per member in private chat. The binding is what makes AIRI
 * keep a separate persona session for each of them, and it is also how a reply finds its way back
 * to QQ.
 */
const BINDING_PATTERN = /^qq:(group|user):(\d+)$/

/** How many message ids the bridge remembers to drop the duplicates a reconnect can resend. */
const SEEN_MESSAGE_LIMIT = 512

function parseBinding(binding: string): QQTarget | undefined {
  const match = BINDING_PATTERN.exec(binding)
  if (!match)
    return undefined

  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id <= 0)
    return undefined

  return { kind: match[1] === 'group' ? 'group' : 'user', id }
}

function extractAssistantText(message: unknown): string {
  if (typeof message === 'string')
    return message.trim()

  if (!message || typeof message !== 'object')
    return ''

  const content = (message as { content?: unknown }).content
  if (typeof content === 'string')
    return content.trim()

  if (!Array.isArray(content))
    return ''

  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object')
      continue

    const { type, text } = part as { type?: unknown, text?: unknown }
    if (type === 'text' && typeof text === 'string')
      parts.push(text)
  }

  return parts.join('').trim()
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class QQAirIBridge {
  private readonly log = useLogg('QQAirIBridge').useGlobalConfig()
  private readonly config: QQAirIConfig
  private readonly onebot: OneBotServer
  private readonly airi: Client
  private readonly seenMessageIds = new Set<number>()
  private readonly deliveryQueues = new Map<string, Promise<void>>()

  constructor(config: QQAirIConfig) {
    this.config = config

    this.onebot = new OneBotServer({
      host: config.onebot.host,
      port: config.onebot.port,
      path: config.onebot.path,
      token: config.onebot.token,
      onMessage: event => this.handleQQMessage(event),
    })

    this.airi = new Client({
      name: 'qq',
      url: config.airi.url,
      token: config.airi.token,
      possibleEvents: ['input:text', 'output:gen-ai:chat:complete'],
      onReady: () => this.log.log('Connected to the AIRI channel server'),
      onClose: () => this.log.warn('Lost the AIRI channel server, waiting for it to come back'),
      onError: error => this.log.withError(toError(error)).warn('AIRI channel error'),
    })

    this.airi.onEvent('output:gen-ai:chat:complete', event => this.handleAiriReply(event))
  }

  async start(): Promise<void> {
    await this.onebot.start()
  }

  async stop(): Promise<void> {
    this.airi.close()
    await this.onebot.stop()
  }

  private handleQQMessage(event: OneBotMessageEvent): void {
    if (event.user_id === event.self_id)
      return

    if (!this.markSeen(event.message_id))
      return

    const isGroup = event.message_type === 'group'
    const groupId = event.group_id
    if (isGroup && typeof groupId !== 'number')
      return

    if (!this.isAllowed(event, isGroup))
      return

    const parsed = parseIncomingMessage(event.message, event.self_id)
    const text = isGroup ? this.triggerText(parsed) : parsed.text
    if (!text)
      return

    const binding = isGroup ? `qq:group:${groupId}` : `qq:user:${event.user_id}`
    const displayName = event.sender?.card || event.sender?.nickname || String(event.user_id)
    const scene = isGroup ? `QQ group ${groupId}` : 'a QQ private chat'

    const sent = this.airi.send({
      type: 'input:text',
      data: {
        text,
        textRaw: event.raw_message,
        overrides: {
          binding,
          messagePrefix: `(From QQ user ${displayName} in ${scene}): `,
        },
      },
    })

    if (!sent) {
      this.log.warn(`The AIRI channel is not ready, dropped a message from ${binding}`)
      return
    }

    this.log.log(`Forwarded ${binding} -> AIRI: ${text.slice(0, 80)}`)
  }

  private handleAiriReply(event: ChatCompleteEvent): void {
    const binding = event.data['gen-ai:chat']?.input?.data?.overrides?.binding
    if (!binding)
      return

    const target = parseBinding(binding)
    if (!target)
      return

    const text = extractAssistantText(event.data.message)
    if (!text)
      return

    this.enqueue(binding, async () => {
      for (const chunk of chunkText(text, this.config.behavior.maxChunkLength)) {
        if (target.kind === 'group')
          await this.onebot.sendGroupMessage(target.id, chunk)
        else
          await this.onebot.sendPrivateMessage(target.id, chunk)
      }

      this.log.log(`Replied to ${binding} with ${text.length} characters`)
    })
  }

  /**
   * A group is noisy, so the bridge answers only a mention or the trigger prefix unless the
   * configuration asks for every message.
   */
  private triggerText(parsed: ParsedIncomingMessage): string | undefined {
    const prefix = this.config.behavior.triggerPrefix
    const hasPrefix = Boolean(prefix) && parsed.text.startsWith(prefix)

    if (!parsed.mentionedSelf && !hasPrefix && this.config.behavior.groupRequireMention)
      return undefined

    return hasPrefix ? parsed.text.slice(prefix.length).trim() : parsed.text
  }

  private isAllowed(event: OneBotMessageEvent, isGroup: boolean): boolean {
    const { allowedGroups, allowedUsers } = this.config.behavior

    if (isGroup) {
      if (!allowedGroups)
        return true

      return typeof event.group_id === 'number' && allowedGroups.has(event.group_id)
    }

    if (!allowedUsers)
      return true

    return allowedUsers.has(event.user_id)
  }

  private markSeen(messageId: number): boolean {
    if (this.seenMessageIds.has(messageId))
      return false

    this.seenMessageIds.add(messageId)
    if (this.seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
      const [oldest] = this.seenMessageIds
      if (typeof oldest === 'number')
        this.seenMessageIds.delete(oldest)
    }

    return true
  }

  /**
   * Chunks of one reply must reach the group in order, while replies to different conversations
   * need not wait for each other.
   */
  private enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.deliveryQueues.get(key) ?? Promise.resolve()
    const settled = previous
      .then(task, task)
      .catch(error => this.log.withError(toError(error)).error('Failed to deliver a QQ reply'))

    this.deliveryQueues.set(key, settled)
    void settled.finally(() => {
      if (this.deliveryQueues.get(key) === settled)
        this.deliveryQueues.delete(key)
    })
  }
}
