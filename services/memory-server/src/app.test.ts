import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryApp } from './app'
import { MemoryDatabase } from './db'

const databases: MemoryDatabase[] = []

function createApp(token?: string) {
  const db = new MemoryDatabase(':memory:')
  databases.push(db)
  return { app: createMemoryApp(db, { token }), db }
}

afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
})

describe('memory server app', () => {
  it('rejects a request without the token', async () => {
    const { app } = createApp('secret')
    const response = await app.request('http://localhost/memory')

    expect(response.status).toBe(401)
  })

  it('writes, lists, searches, and removes a memory', async () => {
    const { app } = createApp('secret')
    const headers = { 'authorization': 'Bearer secret', 'content-type': 'application/json' }

    const created = await app.request('http://localhost/memory', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        persona: 'airi',
        description: '名字',
        body: '主人的名字是小明',
        importance: 4,
      }),
    })
    expect(created.status).toBe(200)
    const entry = (await created.json() as { entry: { id: string } }).entry

    const searched = await app.request('http://localhost/memory/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: '我叫什么名字', persona: 'airi', limit: 3 }),
    })
    const found = await searched.json() as { entries: Array<{ id: string }> }
    expect(found.entries[0]?.id).toBe(entry.id)

    const removed = await app.request(`http://localhost/memory/${entry.id}`, {
      method: 'DELETE',
      headers,
    })
    expect(removed.status).toBe(200)

    const listed = await app.request('http://localhost/memory?persona=airi', { headers })
    expect((await listed.json() as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('pages list results and reports the total', async () => {
    const { app } = createApp('secret')
    const headers = { 'authorization': 'Bearer secret', 'content-type': 'application/json' }
    for (const id of ['one', 'two', 'three']) {
      await app.request('http://localhost/memory', {
        method: 'POST',
        headers,
        body: JSON.stringify({ persona: 'airi', description: id, body: `body ${id}` }),
      })
    }

    const first = await app.request('http://localhost/memory?persona=airi&limit=2&offset=0', { headers })
    const firstPage = await first.json() as { entries: unknown[], total: number }
    expect(firstPage.entries).toHaveLength(2)
    expect(firstPage.total).toBe(3)

    const second = await app.request('http://localhost/memory?persona=airi&limit=2&offset=2', { headers })
    const secondPage = await second.json() as { entries: unknown[], total: number }
    expect(secondPage.entries).toHaveLength(1)
    expect(secondPage.total).toBe(3)
  })
})
