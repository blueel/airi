import { describe, expect, it } from 'vitest'

import {
  averageHashFromLuma,
  hammingDistanceHex,
  isNotableCompanionDescription,
  watchAlongFrameChanged,
} from './watch-along'

describe('averageHashFromLuma', () => {
  it('sets every bit when every pixel is equal', () => {
    expect(averageHashFromLuma(Array.from<number>({ length: 64 }).fill(128))).toBe('ffffffffffffffff')
  })

  it('sets the brighter half of a split image', () => {
    const luma = Array.from({ length: 64 }, (_, index) => index < 32 ? 0 : 255)
    expect(averageHashFromLuma(luma)).toBe('00000000ffffffff')
  })

  it('rejects an image that is not 16 x 16', () => {
    expect(() => averageHashFromLuma([1, 2, 3])).toThrow()
  })
})

describe('hammingDistanceHex', () => {
  it('counts the bits that differ', () => {
    expect(hammingDistanceHex('0000', '0001')).toBe(1)
    expect(hammingDistanceHex('ffffffffffffffff', '0000000000000000')).toBe(64)
  })

  it('treats a different length as fully different', () => {
    expect(hammingDistanceHex('00', '0000')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('watchAlongFrameChanged', () => {
  it('accepts the first frame', () => {
    expect(watchAlongFrameChanged(undefined, '0000000000000000')).toBe(true)
  })

  it('skips a frame within the distance limit', () => {
    expect(watchAlongFrameChanged('0000000000000000', '0000000000000001')).toBe(false)
  })

  it('accepts a frame beyond the distance limit', () => {
    expect(watchAlongFrameChanged('0000000000000000', '000000000000007f')).toBe(true)
  })
})

describe('isNotableCompanionDescription', () => {
  it('rejects the quiet answer in English and Chinese', () => {
    expect(isNotableCompanionDescription('')).toBe(false)
    expect(isNotableCompanionDescription('nothing')).toBe(false)
    expect(isNotableCompanionDescription('Nothing notable.')).toBe(false)
    expect(isNotableCompanionDescription('无')).toBe(false)
    expect(isNotableCompanionDescription('画面没有明显变化。')).toBe(false)
    expect(isNotableCompanionDescription('画面没有变化')).toBe(false)
  })

  it('accepts a scene that changed', () => {
    expect(isNotableCompanionDescription('A boss fight started, and the health bar is low.')).toBe(true)
    expect(isNotableCompanionDescription('角色走进了新的房间。')).toBe(true)
  })
})
