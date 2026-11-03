import type { EmotionLabel } from './types'

/** The expressions that the VRM renderer registers. Each label maps to the closest one. */
export type VrmExpressionName = 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed'

/**
 * The public expression for each label. The renderer keeps one expression at a time, so labels that the model does
 * not define fall back to the closest pose instead of leaving the previous face on screen.
 */
export const EMOTION_TO_VRM: Record<EmotionLabel, VrmExpressionName> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  relaxed: 'relaxed',
  confused: 'surprised',
  tired: 'relaxed',
  affectionate: 'happy',
  awkward: 'sad',
}
