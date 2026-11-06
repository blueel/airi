import type { ProactiveGateInput } from './proactive'

import { describe, expect, it } from 'vitest'

import { attemptsInLastHour, checkProactiveGate, PROACTIVE_DEFAULTS } from './proactive'
import { REFLECTION_THRESHOLD, reflectionDue } from './reflection'

const now = new Date('2026-11-03T12:00:00Z').getTime()

function input(overrides: Partial<ProactiveGateInput> = {}): ProactiveGateInput {
  return {
    now,
    enabled: true,
    visible: true,
    backgroundAllowed: false,
    busy: false,
    idleSince: now - 6 * 60_000,
    sentInLastHour: 0,
    energy: 60,
    silenceMs: PROACTIVE_DEFAULTS.silenceMs,
    cooldownMs: PROACTIVE_DEFAULTS.cooldownMs,
    maxPerHour: PROACTIVE_DEFAULTS.maxPerHour,
    minEnergy: PROACTIVE_DEFAULTS.minEnergy,
    ...overrides,
  }
}

describe('proactive gate', () => {
  it('allows one message after the silence and before any limit', () => {
    expect(checkProactiveGate(input())).toMatchObject({ allowed: true, reason: 'ready' })
  })

  it('stays off until the owner turns it on', () => {
    expect(checkProactiveGate(input({ enabled: false })).reason).toBe('disabled')
  })

  it('waits while the page is hidden or a reply is running', () => {
    expect(checkProactiveGate(input({ visible: false })).reason).toBe('hidden')
    expect(checkProactiveGate(input({ busy: true })).reason).toBe('busy')
  })

  it('allows a hidden page when the owner wants background notifications', () => {
    expect(checkProactiveGate(input({ visible: false, backgroundAllowed: true })).reason).toBe('ready')
  })

  it('keeps quiet when the character has no energy', () => {
    expect(checkProactiveGate(input({ energy: PROACTIVE_DEFAULTS.minEnergy - 1 })).reason).toBe('low-energy')
  })

  it('waits until the owner has been quiet long enough', () => {
    expect(checkProactiveGate(input({ idleSince: now - 60_000 })).reason).toBe('not-idle')
    expect(checkProactiveGate(input({ idleSince: undefined })).reason).toBe('not-idle')
  })

  it('honors the cooldown and the hourly limit', () => {
    expect(checkProactiveGate(input({ lastAttemptAt: now - 60_000 })).reason).toBe('cooldown')
    expect(checkProactiveGate(input({ sentInLastHour: PROACTIVE_DEFAULTS.maxPerHour })).reason).toBe('hourly-limit')
  })

  it('reports how long the owner has been quiet', () => {
    expect(checkProactiveGate(input()).silentForMs).toBe(6 * 60_000)
  })
})

describe('proactive attempts', () => {
  it('counts only the attempts inside the last hour', () => {
    expect(attemptsInLastHour([now - 30 * 60_000, now - 61 * 60_000, now - 10 * 60_000], now)).toBe(2)
  })
})

describe('reflection threshold', () => {
  it('triggers at the threshold and not before it', () => {
    expect(reflectionDue(REFLECTION_THRESHOLD - 0.01)).toBe(false)
    expect(reflectionDue(REFLECTION_THRESHOLD)).toBe(true)
  })
})
