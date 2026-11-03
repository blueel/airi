import { describe, expect, it } from 'vitest'

import { scoreMemoryCandidates, tokenizeMemoryText } from './memory-search'

describe('memory search', () => {
  const now = new Date('2026-11-03T12:00:00Z').getTime()

  it('keeps Chinese words and character bigrams', () => {
    const tokens = tokenizeMemoryText('我的名字是小明')
    expect(tokens).toContain('名字')
    expect(tokens).toContain('小明')
  })

  it('ranks the memory that answers the query first', () => {
    const ranked = scoreMemoryCandidates([
      { id: 'coffee', description: 'Coffee order', body: 'The owner drinks oat milk latte.', updatedAt: now },
      { id: 'name', description: 'Owner name', body: '主人的名字是小明。', updatedAt: now },
      { id: 'city', description: 'Owner city', body: 'The owner lives in 杭州.', updatedAt: now },
    ], '我叫什么名字', { now })

    expect(ranked[0]?.memory.id).toBe('name')
  })

  it('returns nothing when the query shares no term with a memory', () => {
    const ranked = scoreMemoryCandidates([
      { id: 'old', description: 'Old note', body: 'Something.', importance: 1, updatedAt: now - 365 * 86_400_000 },
      { id: 'pinned', description: 'Pinned note', body: 'Something else.', importance: 5, pinned: true, updatedAt: now },
    ], '嗯', { now })

    expect(ranked).toEqual([])
  })

  it('does not pad a result with memories that share no term', () => {
    const ranked = scoreMemoryCandidates([
      { id: 'coffee', description: 'Coffee order', body: 'The owner drinks oat milk latte.', updatedAt: now },
      { id: 'name', description: 'Owner name', body: '主人的名字是小明。', updatedAt: now },
      { id: 'city', description: 'Owner city', body: 'The owner lives in 杭州.', updatedAt: now },
    ], '名字', { now })

    expect(ranked.map(item => item.memory.id)).toEqual(['name'])
  })
})
