/** Every emotion that the state machine can hold. The set joins the VRM presets and the sticker labels. */
export type EmotionLabel
  = | 'happy'
    | 'sad'
    | 'angry'
    | 'surprised'
    | 'relaxed'
    | 'confused'
    | 'tired'
    | 'affectionate'
    | 'awkward'

export const EMOTION_LABELS: readonly EmotionLabel[] = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'confused',
  'tired',
  'affectionate',
  'awkward',
]

/**
 * The short-lived feeling. The intensity falls toward zero on its own, so a reaction never stays forever.
 * `updatedAt` is the time of the last change, and also the base of the decay that follows it.
 */
export interface EmotionState {
  emotion: EmotionLabel
  /** 0..1 */
  intensity: number
  updatedAt: number
}

/** The long-lived relationship. These values do not fade between events. They drift toward a baseline over days. */
export interface MoodDimensions {
  /** 0..100 */
  affection: number
  /** 0..100 */
  energy: number
  updatedAt: number
}

/** A state that a prompt or a reflection pass reads at one moment. */
export interface EmotionSnapshot {
  emotion: EmotionLabel
  intensity: number
  affection: number
  energy: number
}

export type EmotionEventType
  = | 'message-received'
    | 'message-sent'
    | 'gift'
    | 'silence-tick'
    | 'positive-feedback'
    | 'negative-feedback'
    | 'long-session'

/** One change that reaches the emotion state. `note` stays with the event for a later reflection pass. */
export interface EmotionEvent {
  type: EmotionEventType
  note?: string
  at: number
}
