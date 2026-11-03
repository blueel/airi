import type { EmotionState, MoodDimensions } from './types'

import { describe, expect, it } from 'vitest'

import { decayIntensity, EMOTION_FLOOR, EMOTION_HALF_LIFE_MS, regressMood } from './decay'
import { applyEmotionEvent, EMOTION_EVENT_EFFECTS } from './events'
import { EMOTION_TO_VRM } from './mapping'
import { EMOTION_LABELS } from './types'

describe('emotion decay', () => {
  it('keeps the value before the first millisecond', () => {
    expect(decayIntensity(0.8, 0)).toBe(0.8)
    expect(decayIntensity(0.8, -100)).toBe(0.8)
  })

  it('halves the value after one half life', () => {
    expect(decayIntensity(0.8, EMOTION_HALF_LIFE_MS)).toBeCloseTo(0.4, 8)
    expect(decayIntensity(0.8, EMOTION_HALF_LIFE_MS * 2)).toBeCloseTo(0.2, 8)
  })

  it('treats zero, negative, and invalid input as gone', () => {
    expect(decayIntensity(0, 1_000)).toBe(0)
    expect(decayIntensity(-1, 1_000)).toBe(0)
    expect(decayIntensity(Number.NaN, 1_000)).toBe(0)
  })

  it('drops a trace below the floor instead of keeping it forever', () => {
    const almostGone = EMOTION_FLOOR * 0.9
    expect(decayIntensity(almostGone, 1)).toBe(0)
    expect(decayIntensity(0.8, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('clamps a value above one', () => {
    expect(decayIntensity(2, 0)).toBe(1)
  })
})

describe('mood regression', () => {
  const mood: MoodDimensions = { affection: 100, energy: 100, updatedAt: 0 }

  it('moves half of the distance to the baseline in one day', () => {
    const next = regressMood(mood, 24 * 60 * 60_000)
    expect(next.affection).toBeCloseTo(75, 8)
    expect(next.energy).toBeCloseTo(90, 8)
    expect(next.updatedAt).toBe(0)
  })

  it('leaves the mood unchanged when no time passed', () => {
    expect(regressMood(mood, 0)).toEqual(mood)
  })
})

describe('emotion events', () => {
  const now = new Date('2026-11-03T12:00:00Z').getTime()
  const calm: EmotionState = { emotion: 'relaxed', intensity: 0, updatedAt: now }
  const neutralMood: MoodDimensions = { affection: 50, energy: 80, updatedAt: now }

  it('names one reaction for each event', () => {
    expect(Object.keys(EMOTION_EVENT_EFFECTS).sort()).toEqual([
      'gift',
      'long-session',
      'message-received',
      'message-sent',
      'negative-feedback',
      'positive-feedback',
      'silence-tick',
    ])
  })

  it('answers a message with a small amount of happy', () => {
    const applied = applyEmotionEvent(calm, neutralMood, 'message-received', now)
    expect(applied.state.emotion).toBe('happy')
    expect(applied.state.intensity).toBeCloseTo(0.08, 8)
    expect(applied.mood.affection).toBeCloseTo(50.2, 8)
    expect(applied.mood.energy).toBe(79)
  })

  it('replaces another feeling instead of adding to it', () => {
    const sad: EmotionState = { emotion: 'sad', intensity: 0.6, updatedAt: now }
    const applied = applyEmotionEvent(sad, neutralMood, 'gift', now)
    expect(applied.state.emotion).toBe('surprised')
    expect(applied.state.intensity).toBeCloseTo(0.9, 8)
  })

  it('adds to the same feeling', () => {
    const happy: EmotionState = { emotion: 'happy', intensity: 0.2, updatedAt: now }
    const applied = applyEmotionEvent(happy, neutralMood, 'message-received', now)
    expect(applied.state.intensity).toBeCloseTo(0.28, 8)
  })

  it('never leaves the mood outside its range', () => {
    let mood = { ...neutralMood, affection: 1, energy: 1 }
    for (let index = 0; index < 20; index++)
      mood = applyEmotionEvent(calm, mood, 'negative-feedback', now).mood
    expect(mood.affection).toBe(0)
    expect(mood.energy).toBe(1)

    mood = { ...neutralMood, affection: 99, energy: 99 }
    for (let index = 0; index < 20; index++)
      mood = applyEmotionEvent(calm, mood, 'gift', now).mood
    expect(mood.affection).toBe(100)
    expect(mood.energy).toBe(99)
  })

  it('counts a gift as a more important event than a message', () => {
    expect(EMOTION_EVENT_EFFECTS.gift.importance).toBeGreaterThan(EMOTION_EVENT_EFFECTS['message-received'].importance)
  })
})

describe('emotion mapping', () => {
  it('maps every label to an expression that the renderer registers', () => {
    for (const label of EMOTION_LABELS)
      expect(EMOTION_TO_VRM[label]).toBeDefined()
  })
})
