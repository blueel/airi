import type { OneBotMessage, OneBotMessageSegment } from './types'

/** Rendered in place of a non-text segment, so that the model knows something was attached. */
const SEGMENT_PLACEHOLDERS: Record<string, string> = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  forward: '[聊天记录]',
  node: '[聊天记录]',
  json: '[卡片]',
  xml: '[卡片]',
  dice: '[骰子]',
  rps: '[猜拳]',
  poke: '[戳一戳]',
}

/** Characters that a chunk prefers to end on, from the strongest break to the weakest. */
const BREAK_CHARACTERS = ['\n', '。', '！', '？', '；', '!', '?', ';', '.', '，', ',', ' ']

const CQ_CODE_PATTERN = /\[CQ:([\w.-]+)((?:,[^\]]*)?)\]/gi

export interface ParsedIncomingMessage {
  text: string
  mentionedSelf: boolean
}

function unescapeCQ(text: string): string {
  return text
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

function parseCQCodeString(raw: string): OneBotMessageSegment[] {
  const pattern = new RegExp(CQ_CODE_PATTERN.source, CQ_CODE_PATTERN.flags)
  const segments: OneBotMessageSegment[] = []
  let cursor = 0

  for (const match of raw.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) {
      const text = unescapeCQ(raw.slice(cursor, index))
      if (text)
        segments.push({ type: 'text', data: { text } })
    }

    const data: Record<string, unknown> = {}
    for (const pair of (match[2] ?? '').split(',')) {
      if (!pair)
        continue

      const separator = pair.indexOf('=')
      if (separator < 0) {
        data[pair] = ''
        continue
      }

      data[pair.slice(0, separator)] = unescapeCQ(pair.slice(separator + 1))
    }

    segments.push({ type: match[1], data })
    cursor = index + match[0].length
  }

  if (cursor < raw.length) {
    const text = unescapeCQ(raw.slice(cursor))
    if (text)
      segments.push({ type: 'text', data: { text } })
  }

  return segments
}

export function segmentsFromMessage(message: OneBotMessage): OneBotMessageSegment[] {
  if (Array.isArray(message))
    return message

  return parseCQCodeString(message)
}

/**
 * Flattens a message into text that a language model can read, and reports whether the message
 * mentions this account. A mention of another member keeps the QQ number in the text, so that the
 * model can tell the members apart.
 */
export function parseIncomingMessage(message: OneBotMessage, selfId: number): ParsedIncomingMessage {
  const self = String(selfId)
  const parts: string[] = []
  let mentionedSelf = false

  for (const segment of segmentsFromMessage(message)) {
    const { type, data } = segment

    if (type === 'text') {
      parts.push(String(data.text ?? ''))
      continue
    }

    if (type === 'at') {
      const target = String(data.qq ?? '')
      if (target === self) {
        mentionedSelf = true
        continue
      }

      if (target)
        parts.push(`@${target}`)

      continue
    }

    // A reply quotes an earlier message that the model has already seen in its own context.
    if (type === 'reply')
      continue

    const placeholder = SEGMENT_PLACEHOLDERS[type]
    if (placeholder)
      parts.push(placeholder)
  }

  return {
    text: parts.join('').replace(/[ \t]+/g, ' ').trim(),
    mentionedSelf,
  }
}

/**
 * Splits a reply into messages that a chat client accepts, preferring a paragraph or sentence
 * boundary near the limit over a hard cut.
 */
export function chunkText(text: string, maxLength: number): string[] {
  const limit = Math.max(1, Math.floor(maxLength))
  const trimmed = text.trim()
  if (trimmed.length <= limit)
    return trimmed ? [trimmed] : []

  const chunks: string[] = []
  let remaining = trimmed

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit)
    let breakAt = -1

    for (const character of BREAK_CHARACTERS) {
      const index = window.lastIndexOf(character)
      if (index > breakAt)
        breakAt = index
    }

    const cut = breakAt > limit * 0.4 ? breakAt + 1 : limit
    const chunk = remaining.slice(0, cut).trim()
    if (chunk)
      chunks.push(chunk)

    remaining = remaining.slice(cut).trim()
  }

  if (remaining)
    chunks.push(remaining)

  return chunks
}
