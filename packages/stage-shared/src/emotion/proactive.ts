/**
 * Defaults for starting a topic. The owner can change all of them in Settings.
 * The values are conservative: a quiet character is better than one that talks over the owner.
 */
export const PROACTIVE_DEFAULTS = {
  /** The owner must be quiet for this long before the character may start a topic. */
  silenceMs: 5 * 60_000,
  /** The shortest time between two attempts, even when the first one stayed quiet. */
  cooldownMs: 15 * 60_000,
  /** The character never starts more than this many topics in one hour. */
  maxPerHour: 3,
  /** Below this energy the character stays quiet instead of pushing itself. */
  minEnergy: 20,
} as const

export type ProactiveGateReason
  = | 'ready'
    | 'disabled'
    | 'hidden'
    | 'busy'
    | 'low-energy'
    | 'not-idle'
    | 'cooldown'
    | 'hourly-limit'

export interface ProactiveGateInput {
  now: number
  enabled: boolean
  /** The page must be visible. A hidden tab has nobody to talk to. */
  visible: boolean
  /**
   * The owner allowed a message while the page is hidden, and a system notification carries it.
   * Without it, a hidden page waits until it is visible again.
   */
  backgroundAllowed: boolean
  /** A running reply or speech keeps the floor. */
  busy: boolean
  /** When the owner last wrote, or when the session started. Undefined means that nothing is known. */
  idleSince?: number
  lastAttemptAt?: number
  sentInLastHour: number
  energy: number
  silenceMs: number
  cooldownMs: number
  maxPerHour: number
  minEnergy: number
}

export interface ProactiveGateResult {
  allowed: boolean
  reason: ProactiveGateReason
  silentForMs: number
}

/**
 * Decides whether the scheduler may send one notice now. A denial names the first condition that failed,
 * so the Settings page and the tests can tell a waiting scheduler from a broken one.
 *
 * @example
 * checkProactiveGate({ ...input, enabled: false }).reason
 * // => 'disabled'
 */
export function checkProactiveGate(input: ProactiveGateInput): ProactiveGateResult {
  const silentForMs = input.idleSince === undefined ? 0 : Math.max(0, input.now - input.idleSince)
  const denied = (reason: ProactiveGateReason): ProactiveGateResult => ({ allowed: false, reason, silentForMs })

  if (!input.enabled)
    return denied('disabled')
  if (!input.visible && !input.backgroundAllowed)
    return denied('hidden')
  if (input.busy)
    return denied('busy')
  if (input.energy < input.minEnergy)
    return denied('low-energy')
  if (!input.idleSince || silentForMs < input.silenceMs)
    return denied('not-idle')
  if (input.lastAttemptAt !== undefined && input.now - input.lastAttemptAt < input.cooldownMs)
    return denied('cooldown')
  if (input.sentInLastHour >= input.maxPerHour)
    return denied('hourly-limit')

  return { allowed: true, reason: 'ready', silentForMs }
}

/** The attempts inside the last hour. The scheduler keeps the raw times, and the hourly limit reads this count. */
export function attemptsInLastHour(attempts: readonly number[], now: number) {
  return attempts.filter(at => now - at < 60 * 60_000).length
}
