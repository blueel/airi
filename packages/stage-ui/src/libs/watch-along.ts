/** The pauses that the watch-along panel offers between two looks at the screen. */
export const WATCH_ALONG_INTERVAL_OPTIONS = [20_000, 30_000, 60_000, 120_000]
export const WATCH_ALONG_DEFAULT_INTERVAL_MS = 30_000
/** A frame stays small enough for a cheap vision read. */
export const WATCH_ALONG_MAX_FRAME_SIDE = 1280
/**
 * A frame whose average hash is this close to the previous one counts as unchanged.
 * A cursor or a clock changes a few bits, while a new scene changes many.
 */
export const WATCH_ALONG_HASH_DISTANCE = 6
/** The character speaks at most once a minute, even when the screen changes faster. */
export const WATCH_ALONG_COMMENT_COOLDOWN_MS = 60_000

export interface WatchAlongFrame {
  /** JPEG data URL of the frame. */
  dataUrl: string
  /** 64-bit average hash as 16 lowercase hex characters. */
  hash?: string
}

const HASH_SIDE = 8
const HASH_BITS = HASH_SIDE * HASH_SIDE

const BIT_COUNTS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const

/**
 * A 64-bit average hash of a grayscale image, as 16 hex characters.
 *
 * The caller supplies the luma of an 8 x 8 image in row-major order. A pixel above the average sets its bit.
 * The floating bubble computes the same value in Kotlin, so both platforms can compare their own frames.
 */
export function averageHashFromLuma(luma: readonly number[]): string {
  if (luma.length !== HASH_BITS)
    throw new Error(`The average hash needs ${HASH_BITS} luma values`)

  const total = luma.reduce((sum, value) => sum + value, 0)
  const average = total / HASH_BITS
  let hash = ''

  for (let chunk = 0; chunk < 4; chunk += 1) {
    let value = 0
    for (let bit = 0; bit < 16; bit += 1) {
      const index = chunk * 16 + bit
      if (luma[index] >= average)
        value |= 1 << bit
    }
    hash += value.toString(16).padStart(4, '0')
  }
  return hash
}

/** The number of bits that differ between two average hashes. Different lengths count as fully different. */
export function hammingDistanceHex(left: string, right: string): number {
  if (left.length !== right.length)
    return Number.POSITIVE_INFINITY

  let distance = 0
  for (let index = 0; index < left.length; index += 1) {
    distance += BIT_COUNTS[Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16)] ?? 4
  }
  return distance
}

/** Whether the new frame differs enough from the previous one to be worth a vision read. */
export function watchAlongFrameChanged(previous: string | undefined, next: string | undefined): boolean {
  if (!previous || !next)
    return true
  return hammingDistanceHex(previous, next) > WATCH_ALONG_HASH_DISTANCE
}

/**
 * Whether a vision description says that something happened.
 *
 * The companion workload asks for the word `nothing` when the screen is quiet. Models sometimes add a period or a
 * short phrase, so the check accepts those forms and rejects an empty answer.
 */
export function isNotableCompanionDescription(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.。!！?？\s]+$/g, '')
  if (!normalized)
    return false

  if (/^nothing\b/.test(normalized))
    return false
  if (/^(?:无|没有|没什么|无变化|没有变化|画面没有变化|无明显变化|没有明显变化|画面无明显变化|画面没有明显变化|什么都没发生|什么都没有发生|没什么特别的?|没有特别的?事?)$/.test(normalized))
    return false
  return true
}
