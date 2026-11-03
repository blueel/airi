import type { EmotionLabel } from '@proj-airi/stage-shared/emotion'

export enum Emotion {
  Happy = 'happy',
  Sad = 'sad',
  Angry = 'angry',
  Think = 'think',
  Surprise = 'surprised',
  Awkward = 'awkward',
  Question = 'question',
  Curious = 'curious',
  Neutral = 'neutral',
}

export const EMOTION_VALUES = Object.values(Emotion)

export const EmotionHappyMotionName = 'Happy'
export const EmotionSadMotionName = 'Sad'
export const EmotionAngryMotionName = 'Angry'
export const EmotionAwkwardMotionName = 'Awkward'
export const EmotionThinkMotionName = 'Think'
export const EmotionSurpriseMotionName = 'Surprise'
export const EmotionQuestionMotionName = 'Question'
export const EmotionNeutralMotionName = 'Idle'
export const EmotionCuriousMotionName = 'Curious'

export const EMOTION_EmotionMotionName_value = {
  [Emotion.Happy]: EmotionHappyMotionName,
  [Emotion.Sad]: EmotionSadMotionName,
  [Emotion.Angry]: EmotionAngryMotionName,
  [Emotion.Think]: EmotionThinkMotionName,
  [Emotion.Surprise]: EmotionSurpriseMotionName,
  [Emotion.Awkward]: EmotionAwkwardMotionName,
  [Emotion.Question]: EmotionQuestionMotionName,
  [Emotion.Neutral]: EmotionNeutralMotionName,
  [Emotion.Curious]: EmotionCuriousMotionName,
}

export const EMOTION_VRMExpressionName_value = {
  [Emotion.Happy]: 'happy',
  [Emotion.Sad]: 'sad',
  [Emotion.Angry]: 'angry',
  [Emotion.Think]: 'think',
  [Emotion.Surprise]: 'surprised',
  [Emotion.Awkward]: 'neutral',
  [Emotion.Question]: 'think',
  [Emotion.Neutral]: 'neutral',
  [Emotion.Curious]: 'think',
} satisfies Record<Emotion, string | undefined>

export const EMOTION_SpineAnimationName_value = {
  [Emotion.Happy]: 'celebrate',
  [Emotion.Sad]: 'sad',
  [Emotion.Angry]: 'angry',
  [Emotion.Think]: 'think',
  [Emotion.Surprise]: 'surprise',
  [Emotion.Awkward]: 'awkward',
  [Emotion.Question]: 'question',
  [Emotion.Neutral]: 'idle',
  [Emotion.Curious]: 'curious',
} satisfies Record<Emotion, string>

export interface EmotionPayload {
  name: Emotion
  intensity: number
  /** How long a VRM keeps the expression before it returns to neutral. The default fits a reaction in a reply. */
  durationMs?: number
}

/**
 * The expression name for a persistent emotion label. The state store uses labels from many sources, and the Stage
 * keeps its own shorter list of expressions. Each label maps to the closest expression that the Stage can show.
 */
const EMOTION_STAGE_NAME: Record<EmotionLabel, Emotion> = {
  happy: Emotion.Happy,
  sad: Emotion.Sad,
  angry: Emotion.Angry,
  surprised: Emotion.Surprise,
  relaxed: Emotion.Neutral,
  confused: Emotion.Question,
  tired: Emotion.Neutral,
  affectionate: Emotion.Happy,
  awkward: Emotion.Awkward,
}

export function emotionPayloadFromLabel(label: EmotionLabel, intensity: number): EmotionPayload {
  return { name: EMOTION_STAGE_NAME[label], intensity }
}
