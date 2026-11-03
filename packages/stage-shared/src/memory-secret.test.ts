import { describe, expect, it } from 'vitest'

import { containsLikelySecret } from './memory-secret'

describe('memory secret filter', () => {
  it('detects common secret statements', () => {
    expect(containsLikelySecret('password: hunter2')).toBe(true)
    expect(containsLikelySecret('我的密码是 abc123')).toBe(true)
    expect(containsLikelySecret('api_key=sk-abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(containsLikelySecret('card 6222020200112233445')).toBe(true)
  })

  it('keeps ordinary personal facts', () => {
    expect(containsLikelySecret('The owner lives in 杭州.')).toBe(false)
    expect(containsLikelySecret('The owner was born on 2000-01-01.')).toBe(false)
    expect(containsLikelySecret('The owner likes oat milk latte.')).toBe(false)
  })
})
