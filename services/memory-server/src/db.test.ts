import { afterEach, describe, expect, it } from 'vitest'

import { MemoryDatabase } from './db'

const databases: MemoryDatabase[] = []

function createDatabase() {
  const db = new MemoryDatabase(':memory:')
  databases.push(db)
  return db
}

afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
})

describe('memory database', () => {
  it('keeps card memories apart and shares a general memory', () => {
    const db = createDatabase()
    const own = db.write({ persona: 'airi', description: 'Nickname', body: 'Yumeka' })
    const other = db.write({ persona: 'other', description: 'Rule', body: 'No spoilers' })
    const general = db.write({ description: 'Language', body: 'Chinese' })

    expect(new Set(db.list({ persona: 'airi' }).map(entry => entry.id))).toEqual(new Set([general.id, own.id]))
    expect(db.list({ persona: 'airi', includeGeneral: false }).map(entry => entry.id)).toEqual([own.id])
    expect(db.list({ persona: 'other' }).map(entry => entry.id)).toContain(other.id)
  })

  it('updates only an entry that belongs to the same card', () => {
    const db = createDatabase()
    const general = db.write({ description: 'Language', body: 'Chinese' })
    const added = db.write({ id: general.id, persona: 'airi', description: 'Language', body: 'English' })

    expect(added.id).not.toBe(general.id)
    expect(db.get(general.id)?.body).toBe('Chinese')
    expect(added.body).toBe('English')
  })

  it('finds a Chinese memory and forgets only a card entry', () => {
    const db = createDatabase()
    const name = db.write({ persona: 'airi', description: '名字', body: '主人的名字是小明' })
    db.write({ persona: 'airi', description: '咖啡', body: '主人喜欢燕麦拿铁' })

    expect(db.search('我叫什么名字', 'airi', 1)[0]?.id).toBe(name.id)
    expect(db.forget(name.id, 'other')).toBe(false)
    expect(db.forget(name.id, 'airi')).toBe(true)
    expect(db.list({ persona: 'airi' })).toHaveLength(1)
  })

  it('round-trips an export through import', () => {
    const source = createDatabase()
    source.write({ persona: 'airi', description: 'City', body: '杭州', importance: 4 })
    const exported = source.exportAll()

    const target = createDatabase()
    expect(target.import(exported)).toBe(1)
    expect(target.list({ persona: 'airi' })[0]?.body).toBe('杭州')
  })
})
