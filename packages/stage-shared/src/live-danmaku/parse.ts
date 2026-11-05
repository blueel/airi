import { looseObject, number, optional, safeParse, string } from 'valibot'

/** One line that a viewer wrote. The shape matches the live room's own comments. */
export interface LiveDanmakuComment {
  name: string
  text: string
}

/** One gift, with its worth in CNY when it is a paid one. */
export interface LiveDanmakuGift {
  name: string
  giftName: string
  num: number
  /** Gold gifts count their price, silver ones are free and worth 0. */
  priceCny: number
}

/** One paid highlighted message. The price is already in CNY. */
export interface LiveDanmakuSuperChat {
  name: string
  text: string
  priceCny: number
}

export type LiveDanmakuEvent
  = | { kind: 'comment', comment: LiveDanmakuComment }
    | { kind: 'gift', gift: LiveDanmakuGift }
    | { kind: 'super-chat', superChat: LiveDanmakuSuperChat }

const giftPayloadSchema = looseObject({
  uname: optional(string(), ''),
  giftName: optional(string(), ''),
  num: optional(number(), 1),
  coinType: optional(string(), 'gold'),
  price: optional(number(), 0),
})

const superChatPayloadSchema = looseObject({
  uname: optional(string(), ''),
  message: optional(string(), ''),
  price: optional(number(), 0),
})

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/** Reads one viewer line out of the deep and heterogeneous `info` array of DANMU_MSG. */
function parseDanmuMsg(record: Record<string, unknown>): LiveDanmakuEvent | undefined {
  const info = Array.isArray(record.info) ? record.info : []
  const text = typeof info[1] === 'string' ? info[1] : ''
  if (!text)
    return undefined
  const sender = Array.isArray(info[2]) ? info[2] : []
  const name = typeof sender[1] === 'string' ? sender[1] : ''
  return { kind: 'comment', comment: { name, text } }
}

function parseSendGift(record: Record<string, unknown>): LiveDanmakuEvent | undefined {
  // The gift fields live under `data`, one level below the command envelope.
  const parsed = safeParse(giftPayloadSchema, asRecord(record.data) ?? record)
  if (!parsed.success || !parsed.output.giftName)
    return undefined

  const { uname, giftName, num, coinType, price } = parsed.output
  return {
    kind: 'gift',
    gift: {
      name: uname,
      giftName,
      num,
      priceCny: coinType === 'gold' ? (price * num) / 1000 : 0,
    },
  }
}

function parseSuperChat(record: Record<string, unknown>): LiveDanmakuEvent | undefined {
  const parsed = safeParse(superChatPayloadSchema, asRecord(record.data) ?? record)
  if (!parsed.success || !parsed.output.message)
    return undefined

  return {
    kind: 'super-chat',
    superChat: {
      name: parsed.output.uname,
      text: parsed.output.message,
      priceCny: parsed.output.price,
    },
  }
}

/**
 * Turns one `cmd` message into an event. Commands that this app has no use for,
 * among them the many rank and watch counters, come back as undefined.
 */
export function parseLiveDanmakuEvent(cmd: string, payload: unknown): LiveDanmakuEvent | undefined {
  // The web client sends suffixed commands such as `DANMU_MSG:4:0:2:2:2:0`.
  const base = cmd.split(':')[0] ?? cmd
  const record = asRecord(payload)
  if (!record)
    return undefined

  switch (base) {
    case 'DANMU_MSG':
      return parseDanmuMsg(record)
    case 'SEND_GIFT':
      return parseSendGift(record)
    case 'SUPER_CHAT_MESSAGE':
      return parseSuperChat(record)
    default:
      return undefined
  }
}

/** Reads the JSON body of an operation 5 message into its command and payload. */
export function readDanmakuCommandBody(body: Uint8Array): { cmd: string, payload: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    const record = asRecord(parsed)
    const cmd = record && typeof record.cmd === 'string' ? record.cmd : undefined
    if (!cmd)
      return undefined
    return { cmd, payload: parsed }
  }
  catch {
    return undefined
  }
}
