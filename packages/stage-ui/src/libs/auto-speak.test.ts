import { describe, expect, it } from 'vitest'

import { AUTO_SPEAK_IDLE_MS, AUTO_SPEAK_JITTER_MS, autoSpeakDueAt, randomAutoSpeakJitter } from './auto-speak'

describe('autoSpeakDueAt', () => {
  it('waits out the idle time after the last message of either side', () => {
    expect(autoSpeakDueAt({ lastMessageAt: 1_000, askedAt: 0, jitterMs: 0 })).toBe(1_000 + AUTO_SPEAK_IDLE_MS)
  })

  it('counts from her own last line when that is newer than the conversation', () => {
    expect(autoSpeakDueAt({ lastMessageAt: 1_000, askedAt: 9_000, jitterMs: 0 })).toBe(9_000 + AUTO_SPEAK_IDLE_MS)
  })

  it('adds the jitter of the round, so her lines do not come on a fixed beat', () => {
    expect(autoSpeakDueAt({ lastMessageAt: 1_000, askedAt: 0, jitterMs: 500 })).toBe(1_000 + AUTO_SPEAK_IDLE_MS + 500)
  })
})

describe('randomAutoSpeakJitter', () => {
  it('stays inside the widest silence', () => {
    for (let round = 0; round < 100; round += 1) {
      const jitter = randomAutoSpeakJitter()
      expect(jitter).toBeGreaterThanOrEqual(0)
      expect(jitter).toBeLessThanOrEqual(AUTO_SPEAK_JITTER_MS)
    }
  })
})
