/** How long the conversation stays quiet before the character finds something to say. */
export const AUTO_SPEAK_IDLE_MS = 45_000
/** The pause between the switch and her first line, so turning it on opens the broadcast. */
export const AUTO_SPEAK_OPENING_MS = 2_000
/** The longest silence that is added to the idle time of one round, so her lines do not come on a fixed beat. */
export const AUTO_SPEAK_JITTER_MS = 15_000

export interface AutoSpeakTiming {
  /** When a message of either side last joined the conversation. */
  lastMessageAt: number
  /** When the character last spoke, or when the silence began. */
  askedAt: number
  /** Added to the idle time of this round. */
  jitterMs: number
}

/**
 * When the character's next own line is due.
 * The silence counts from the later of the last message and her last line, so a viewer who speaks, and the character
 * herself, both hold the next line back for a full idle time.
 */
export function autoSpeakDueAt(timing: AutoSpeakTiming) {
  return Math.max(timing.lastMessageAt, timing.askedAt) + AUTO_SPEAK_IDLE_MS + timing.jitterMs
}

/** A silence to add to one round of the idle time. */
export function randomAutoSpeakJitter() {
  return Math.round(Math.random() * AUTO_SPEAK_JITTER_MS)
}
