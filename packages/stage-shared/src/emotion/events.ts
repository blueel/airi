import type { EmotionEventType, EmotionLabel, EmotionState, MoodDimensions } from './types'

import { clamp, clampMood, decayIntensity, regressMood } from './decay'

/** What one event does to the state. The importance feeds the reflection ledger, not the expression. */
export interface EmotionEventEffect {
  emotion?: EmotionLabel
  intensityDelta?: number
  affectionDelta?: number
  energyDelta?: number
  importance: number
}

/**
 * Every effect in one table, so tuning a reaction needs one edit. The values are small on purpose:
 * a single message moves the feeling a little, and a gift is rare enough to move it a lot.
 */
export const EMOTION_EVENT_EFFECTS: Record<EmotionEventType, EmotionEventEffect> = {
  'message-received': { emotion: 'happy', intensityDelta: 0.08, affectionDelta: 0.2, energyDelta: -1, importance: 1 },
  'message-sent': { energyDelta: -1, importance: 1 },
  'gift': { emotion: 'surprised', intensityDelta: 0.9, affectionDelta: 8, importance: 5 },
  'silence-tick': { emotion: 'sad', intensityDelta: 0.05, energyDelta: 1, importance: 0.5 },
  'positive-feedback': { emotion: 'happy', intensityDelta: 0.3, affectionDelta: 2, importance: 3 },
  'negative-feedback': { emotion: 'sad', intensityDelta: 0.4, affectionDelta: -2, importance: 3 },
  'long-session': { emotion: 'tired', intensityDelta: 0.2, energyDelta: -10, importance: 1 },
}

export interface AppliedEmotionEvent {
  state: EmotionState
  mood: MoodDimensions
  effect: EmotionEventEffect
}

/**
 * Applies one event and the time that passed since the last change. An event with another emotion replaces the
 * current one instead of mixing two expressions. An event with no emotion only decays the current one.
 */
export function applyEmotionEvent(
  state: EmotionState,
  mood: MoodDimensions,
  type: EmotionEventType,
  now: number,
): AppliedEmotionEvent {
  const effect = EMOTION_EVENT_EFFECTS[type]
  const elapsed = Math.max(0, now - state.updatedAt)
  const decayed = decayIntensity(state.intensity, elapsed)

  let emotion = state.emotion
  let intensity = decayed
  if (effect.emotion) {
    // A new emotion starts from the faded weight of the same emotion. Any other emotion starts from zero.
    const base = effect.emotion === state.emotion ? decayed : 0
    emotion = effect.emotion
    intensity = clamp(base + (effect.intensityDelta ?? 0), 0, 1)
  }

  const regressed = regressMood(mood, Math.max(0, now - mood.updatedAt))
  const nextMood = clampMood({
    affection: regressed.affection + (effect.affectionDelta ?? 0),
    energy: regressed.energy + (effect.energyDelta ?? 0),
  })

  return {
    state: { emotion, intensity, updatedAt: now },
    mood: { ...nextMood, updatedAt: now },
    effect,
  }
}
