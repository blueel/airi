/** A region of the shared screen in fractions of its width and height, so it keeps its place when the preview resizes. */
export interface LiveRoomRect {
  x: number
  y: number
  width: number
  height: number
}

/** One line that a viewer wrote in the live room. `name` is empty when the screen did not separate a name. */
export interface LiveRoomComment {
  name: string
  text: string
}

/** The smallest region that is worth reading, as a fraction of the screen. A stray click must not start a scan. */
export const LIVE_ROOM_MIN_SIZE = 0.04
/** How long the region rests between two reads. A read costs a model call, so a second does not help. */
export const LIVE_ROOM_DEFAULT_INTERVAL_MS = 4_000
/** Comments of one message. More would bury the conversation and the model would answer none of them. */
export const LIVE_ROOM_MAX_COMMENTS_PER_MESSAGE = 6
/** The comments that a scan remembers, so a comment that stays on screen is sent once. */
export const LIVE_ROOM_SEEN_LIMIT = 300
/** The longest left side of a line that still reads as a nickname rather than part of a sentence. */
const NICKNAME_MAX_LENGTH = 24
/** The widest crop that a read sends. A wider one only costs tokens, and the text is large enough. */
export const LIVE_ROOM_MAX_CROP_WIDTH = 1_280

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** A stored region keeps four decimals, so a drag does not fill the storage with float noise. */
function roundRectValue(value: number) {
  return Math.round(value * 10_000) / 10_000
}

/** Keeps a region inside the screen. */
export function clampLiveRoomRect(rect: LiveRoomRect): LiveRoomRect {
  const x = clamp01(rect.x)
  const y = clamp01(rect.y)
  return {
    x: roundRectValue(x),
    y: roundRectValue(y),
    width: roundRectValue(Math.min(clamp01(rect.width), 1 - x)),
    height: roundRectValue(Math.min(clamp01(rect.height), 1 - y)),
  }
}

/** The region between where a drag started and where the pointer is now, whichever way it moved. */
export function liveRoomRectFromPoints(from: { x: number, y: number }, to: { x: number, y: number }): LiveRoomRect {
  const startX = clamp01(from.x)
  const startY = clamp01(from.y)
  const endX = clamp01(to.x)
  const endY = clamp01(to.y)
  return clampLiveRoomRect({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: roundRectValue(Math.abs(endX - startX)),
    height: roundRectValue(Math.abs(endY - startY)),
  })
}

/** Whether a region is big enough to read, so a click or a jitter does not become a region. */
export function liveRoomRectIsUsable(rect: LiveRoomRect | null | undefined): rect is LiveRoomRect {
  return !!rect && rect.width >= LIVE_ROOM_MIN_SIZE && rect.height >= LIVE_ROOM_MIN_SIZE
}

/** The pixels of a region in a frame of the given size, which is what a canvas crops. */
export function liveRoomCropRegion(rect: LiveRoomRect, frameWidth: number, frameHeight: number) {
  const width = Math.max(1, Math.round(rect.width * frameWidth))
  const height = Math.max(1, Math.round(rect.height * frameHeight))
  return {
    x: Math.min(Math.round(rect.x * frameWidth), Math.max(0, frameWidth - width)),
    y: Math.min(Math.round(rect.y * frameHeight), Math.max(0, frameHeight - height)),
    width,
    height,
  }
}

/** A nickname and a line with its spacing and trailing punctuation dropped, so a repeated line matches its first read. */
function normalizeForComparison(value: string) {
  return value.replace(/\s+/g, '').replace(/[，。！？、,.!?~～…]+$/g, '')
}

/** Identity of one comment. The same line keeps the same key however the reader spaced it. */
export function liveRoomCommentKey(comment: LiveRoomComment) {
  return `${normalizeForComparison(comment.name)}|${normalizeForComparison(comment.text)}`
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

/** One `name: text` line of a reader that answered in prose instead of JSON. */
function parseCommentLine(line: string): LiveRoomComment | undefined {
  const trimmed = line.replace(/^[\s\-*•·]+/, '').replace(/^\d+[.、)]\s*/, '').trim()
  if (!trimmed)
    return undefined

  const colon = trimmed.search(/[:：]/)
  // A nickname is short. A longer left side is part of the sentence, and the line has no nickname.
  if (colon < 1 || colon > NICKNAME_MAX_LENGTH)
    return { name: '', text: cleanText(trimmed) }

  const text = cleanText(trimmed.slice(colon + 1))
  return text ? { name: cleanText(trimmed.slice(0, colon)), text } : undefined
}

/**
 * Reads a reader's answer as comments.
 * A model that follows the request answers with a JSON array. One that answers in prose still gives usable lines.
 */
export function parseLiveRoomComments(raw: string): LiveRoomComment[] {
  const json = raw.match(/\[[\s\S]*\]/)
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json[0])
      if (Array.isArray(parsed)) {
        return parsed.flatMap((entry) => {
          if (!entry || typeof entry !== 'object')
            return []

          const record = entry as Record<string, unknown>
          const text = cleanText(String(record.text ?? record.content ?? record.message ?? ''))
          if (!text)
            return []

          return [{ name: cleanText(String(record.name ?? record.user ?? '')), text }]
        })
      }
    }
    catch {
      // The answer broke in the middle. The lines below still carry what the reader saw.
    }
  }

  return raw
    .split('\n')
    .map(parseCommentLine)
    .filter((comment): comment is LiveRoomComment => !!comment)
}

/** The comments that no earlier scan sent, in the order the screen showed them. */
export function selectFreshComments(comments: LiveRoomComment[], seen: ReadonlySet<string>) {
  const fresh: LiveRoomComment[] = []
  const keys = new Set<string>()
  for (const comment of comments) {
    const key = liveRoomCommentKey(comment)
    if (seen.has(key) || keys.has(key))
      continue
    keys.add(key)
    fresh.push(comment)
  }
  return fresh
}
