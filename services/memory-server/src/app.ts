import type { MemoryDatabase } from './db'
import type { MemoryKind, MemoryPatch } from './types'

import { errorMessageFrom } from '@moeru/std'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { array, boolean, nullable, number, optional, picklist, safeParse, strictObject, string, unknown } from 'valibot'

const kindSchema = picklist(['profile', 'fact', 'episode'])

const writeSchema = strictObject({
  id: optional(string()),
  persona: optional(nullable(string())),
  kind: optional(kindSchema),
  description: optional(string()),
  body: string(),
  importance: optional(number()),
  pinned: optional(boolean()),
  source: optional(string()),
  sourceSessionId: optional(string()),
})

const patchSchema = strictObject({
  persona: optional(nullable(string())),
  kind: optional(kindSchema),
  description: optional(string()),
  body: optional(string()),
  importance: optional(number()),
  pinned: optional(boolean()),
  supersededBy: optional(nullable(string())),
  deletedAt: optional(nullable(number())),
})

const searchSchema = strictObject({
  query: string(),
  persona: optional(string()),
  limit: optional(number()),
})

const importSchema = strictObject({
  entries: array(unknown()),
})

const removeSchema = strictObject({
  ids: array(string()),
})

const forgetSchema = strictObject({
  id: string(),
  persona: string(),
})

export interface MemoryAppOptions {
  token?: string
  allowedOrigins?: string[]
}

/** Builds the HTTP app around one database. Tests use the same app with an in-memory database. */
export function createMemoryApp(db: MemoryDatabase, options: MemoryAppOptions = {}) {
  const app = new Hono()

  app.use('*', cors({
    origin: options.allowedOrigins?.length ? options.allowedOrigins : '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  }))

  app.get('/health', c => c.json({ ok: true, service: 'airi-memory' }))

  app.use('*', async (c, next) => {
    if (!options.token)
      return next()
    if (c.req.header('authorization') !== `Bearer ${options.token}`)
      return c.json({ error: 'unauthorized' }, 401)
    return next()
  })

  app.get('/memory', (c) => {
    const persona = c.req.query('persona')?.trim() || undefined
    const kind = c.req.query('kind')
    const includeGeneral = c.req.query('includeGeneral') !== 'false'
    const limit = Number(c.req.query('limit') ?? 5_000)
    const offset = Number(c.req.query('offset') ?? 0)
    if (kind && !['profile', 'fact', 'episode'].includes(kind))
      return c.json({ error: 'invalid kind' }, 400)
    const filter = {
      persona,
      includeGeneral,
      ...(kind ? { kind: kind as MemoryKind } : {}),
    }
    return c.json({
      entries: db.list({
        ...filter,
        limit: Number.isFinite(limit) ? limit : 5_000,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
      total: db.count(filter),
    })
  })

  app.get('/memory/export', (c) => {
    return c.json({
      format: 'airi-memory-export:v1',
      exportedAt: Date.now(),
      memories: db.exportAll(),
    })
  })

  app.post('/memory/import', async (c) => {
    const parsed = safeParse(importSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid import payload' }, 400)
    try {
      return c.json({ imported: db.import(parsed.output.entries) })
    }
    catch (error) {
      return c.json({ error: errorMessageFrom(error) ?? 'memory write failed' }, 400)
    }
  })

  app.post('/memory/search', async (c) => {
    const parsed = safeParse(searchSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid search payload' }, 400)
    const limit = parsed.output.limit !== undefined
      ? Math.min(50, Math.max(1, Math.round(parsed.output.limit)))
      : 8
    return c.json({
      entries: db.search(parsed.output.query, parsed.output.persona, limit),
    })
  })

  app.post('/memory/remove', async (c) => {
    const parsed = safeParse(removeSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid remove payload' }, 400)
    return c.json({ removed: db.remove(parsed.output.ids) })
  })

  app.post('/memory/forget', async (c) => {
    const parsed = safeParse(forgetSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid forget payload' }, 400)
    return c.json({ forgotten: db.forget(parsed.output.id, parsed.output.persona) })
  })

  app.post('/memory/clear', (c) => {
    db.clear()
    return c.json({ cleared: true })
  })

  app.post('/memory', async (c) => {
    const parsed = safeParse(writeSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid memory payload' }, 400)
    try {
      const entry = db.write({
        ...parsed.output,
        persona: parsed.output.persona ?? undefined,
        description: parsed.output.description ?? '',
      })
      return c.json({ entry })
    }
    catch (error) {
      return c.json({ error: errorMessageFrom(error) ?? 'memory write failed' }, 400)
    }
  })

  app.post('/memory/:id/make-general', (c) => {
    return c.json({ changed: db.makeGeneral(c.req.param('id')) })
  })

  app.patch('/memory/:id', async (c) => {
    const parsed = safeParse(patchSchema, await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid memory patch' }, 400)
    const entry = db.patch(c.req.param('id'), parsed.output as MemoryPatch)
    return entry ? c.json({ entry }) : c.json({ error: 'memory not found' }, 404)
  })

  app.delete('/memory/:id', (c) => {
    return c.json({ removed: db.remove([c.req.param('id')]) })
  })

  return app
}
