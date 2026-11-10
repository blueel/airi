/**
 * Minimal subset of the OneBot v11 protocol.
 *
 * The plugin only speaks the parts that a chat bridge needs: incoming message events and the
 * `send_group_msg` / `send_private_msg` actions. Everything else is ignored on purpose, so that a
 * non-standard implementation cannot break the bridge with an unexpected payload.
 */
export interface OneBotMessageSegment {
  type: string
  data: Record<string, unknown>
}

/**
 * OneBot sends either an array of segments or a CQ code string, depending on the implementation
 * configuration. Both shapes reach this plugin.
 */
export type OneBotMessage = string | OneBotMessageSegment[]

export interface OneBotSender {
  user_id?: number
  nickname?: string
  card?: string
  role?: string
}

export interface OneBotMessageEvent {
  post_type: 'message'
  message_type: 'private' | 'group'
  sub_type?: string
  self_id: number
  user_id: number
  group_id?: number
  message_id: number
  message: OneBotMessage
  raw_message: string
  sender?: OneBotSender
  time?: number
}

export interface OneBotMetaEvent {
  post_type: 'meta_event'
  meta_event_type: string
  self_id: number
  time?: number
}

export interface OneBotNoticeEvent {
  post_type: 'notice' | 'request'
  self_id: number
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | OneBotNoticeEvent

export interface OneBotActionResponse {
  status: 'ok' | 'async' | 'failed'
  retcode: number
  data?: unknown
  echo?: string
  message?: string
  wording?: string
}

export function isMessageEvent(event: OneBotEvent): event is OneBotMessageEvent {
  return event.post_type === 'message'
}
