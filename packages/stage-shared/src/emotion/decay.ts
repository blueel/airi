import type { EmotionState, MoodDimensions } from './types'

/** A feeling loses half of its intensity in this time. */
export const EMOTION_HALF_LIFE_MS = 20 * 60_000

/** Below this value the feeling counts as gone, so a trace never stays forever. */
export const EMOTION_FLOOR = 0.05

/** Mood values return to these levels while nothing happens, for example while the app is closed. */
export const MOOD_BASELINE = {
  affection: 50,
  energy: 80,
} as const

/** Mood moves half of the distance to the baseline in this time. */
export const MOOD_REGRESSION_HALF_LIFE_MS = 24 * 60 * 60_000

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Exponential decay with a floor. A non-positive or invalid input counts as gone.
 *
 * @example
 * decayIntensity(0.8, 20 * 60_000)
 * // => 0.4
 */
export function decayIntensity(intensity: number, elapsedMs: number, halfLifeMs = EMOTION_HALF_LIFE_MS): number {
  if (!Number.isFinite(intensity) || intensity <= 0)
    return 0

  const value = clamp(intensity, 0, 1)
  if (Number.isNaN(elapsedMs) || elapsedMs <= 0)
    return value

  const decayed = value * 0.5 ** (elapsedMs / halfLifeMs)
  return decayed < EMOTION_FLOOR ? 0 : decayed
}

export function clampMood(mood: Pick<MoodDimensions, 'affection' | 'energy'>): Pick<MoodDimensions, 'affection' | 'energy'> {
  return {
    affection: clamp(mood.affection, 0, 100),
    energy: clamp(mood.energy, 0, 100),
  }
}

/**
 * Moves both mood values toward the baseline. A long silence recovers energy. Several quiet days
 * bring affection back to its neutral level, so one bad day does not decide the relationship.
 *
 * @example
 * regressMood({ affection: 100, energy: 100, updatedAt: 0 }, 24 * 60 * 60_000)
 * // => { affection: 75, energy: 90, updatedAt: <the same time> }
 */
export function regressMood(mood: MoodDimensions, elapsedMs: number, halfLifeMs = MOOD_REGRESSION_HALF_LIFE_MS): MoodDimensions {
  if (Number.isNaN(elapsedMs) || elapsedMs <= 0)
    return { ...mood }

  const remaining = 0.5 ** (elapsedMs / halfLifeMs)
  return {
    affection: MOOD_BASELINE.affection + (mood.affection - MOOD_BASELINE.affection) * remaining,
    energy: MOOD_BASELINE.energy + (mood.energy - MOOD_BASELINE.energy) * remaining,
    updatedAt: mood.updatedAt,
  }
}

/** Applies the time that passed since the last change. The result always carries the new time. */
export function decayEmotion(state: EmotionState, now: number): EmotionState {
  return {
    emotion: state.emotion,
    intensity: decayIntensity(state.intensity, now - state.updatedAt),
    updatedAt: now,
  }
}
