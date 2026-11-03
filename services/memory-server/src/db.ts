import type { MemoryEntry, MemoryKind, MemoryListFilter, MemoryPatch, MemoryWriteInput } from './types'

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { scoreMemoryCandidates } from '@proj-airi/stage-shared/memory-search'

const KINDS = new Set<MemoryKind>(['profile', 'fact', 'episode'])

function toKind(value: unknown): MemoryKind {
  return typeof value === 'string' && KINDS.has(value as MemoryKind) ? value as MemoryKind : 'fact'
}

function textOf(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function numberOf(value: unknown, fallback = 0) {
  if (typeof value === 'number')
    return value
  return typeof value === 'bigint' ? Number(value) : fallback
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function optionalNumber(value: unknown) {
  if (typeof value === 'number')
    return value
  return typeof value === 'bigint' ? Number(value) : undefined
}

function toEntry(row: Record<string, unknown>): MemoryEntry {
  const persona = optionalText(row.persona)
  const source = optionalText(row.source)
  const sourceSessionId = optionalText(row.source_session_id)
  const lastUsedAt = optionalNumber(row.last_used_at)
  const supersededBy = optionalText(row.superseded_by)
  const deletedAt = optionalNumber(row.deleted_at)
  return {
    id: textOf(row.id),
    ...(persona ? { persona } : {}),
    kind: toKind(row.kind),
    description: textOf(row.description),
    body: textOf(row.body),
    importance: numberOf(row.importance, 3),
    pinned: numberOf(row.pinned) !== 0,
    ...(source ? { source } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    createdAt: numberOf(row.created_at),
    updatedAt: numberOf(row.updated_at),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    useCount: numberOf(row.use_count),
    ...(supersededBy ? { supersededBy } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  }
}

function clampImportance(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 3
  return Math.min(5, Math.max(1, Math.round(value)))
}

function filterClause(filter: MemoryListFilter) {
  const clauses = ['deleted_at IS NULL']
  const values: Array<string | number> = []
  if (filter.persona) {
    if (filter.includeGeneral ?? true) {
      clauses.push('(persona = ? OR persona IS NULL)')
      values.push(filter.persona)
    }
    else {
      clauses.push('persona = ?')
      values.push(filter.persona)
    }
  }
  if (filter.kind) {
    clauses.push('kind = ?')
    values.push(filter.kind)
  }
  return { clauses, values }
}

export class MemoryDatabase {
  readonly #db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id                TEXT PRIMARY KEY,
        persona           TEXT,
        kind              TEXT NOT NULL DEFAULT 'fact',
        description       TEXT NOT NULL,
        body              TEXT NOT NULL,
        importance        INTEGER NOT NULL DEFAULT 3,
        pinned            INTEGER NOT NULL DEFAULT 0,
        source            TEXT,
        source_session_id TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        last_used_at      INTEGER,
        use_count         INTEGER NOT NULL DEFAULT 0,
        superseded_by     TEXT,
        deleted_at        INTEGER,
        embedding         BLOB,
        embedding_model   TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory(persona, deleted_at);
      CREATE INDEX IF NOT EXISTS memory_kind_idx ON memory(kind, deleted_at);
    `)
  }

  close() {
    this.#db.close()
  }

  get(id: string): MemoryEntry | undefined {
    const row = this.#db.prepare('SELECT * FROM memory WHERE id = ?').get(id)
    return row ? toEntry(row) : undefined
  }

  list(filter: MemoryListFilter = {}): MemoryEntry[] {
    const { clauses, values } = filterClause(filter)
    values.push(
      Math.min(10_000, Math.max(1, filter.limit ?? 5_000)),
      Math.max(0, filter.offset ?? 0),
    )
    const rows = this.#db
      .prepare(`SELECT * FROM memory WHERE ${clauses.join(' AND ')} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?`)
      .all(...values)
    return rows.map(toEntry)
  }

  count(filter: MemoryListFilter = {}) {
    const { clauses, values } = filterClause(filter)
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM memory WHERE ${clauses.join(' AND ')}`)
      .get(...values)
    return numberOf(row?.total)
  }

  write(input: MemoryWriteInput): MemoryEntry {
    const body = input.body.trim()
    if (!body)
      throw new Error('Memory body is empty')

    const now = Date.now()
    const persona = input.persona?.trim() || null
    const kind = toKind(input.kind)
    const description = input.description.trim() || body.slice(0, 150)
    const importance = clampImportance(input.importance)
    const pinned = (input.pinned ?? kind === 'profile') ? 1 : 0
    const existing = input.id ? this.get(input.id) : undefined

    if (existing && !existing.deletedAt && (existing.persona ?? null) === persona) {
      this.#db.prepare(`
        UPDATE memory
        SET kind = ?, description = ?, body = ?, importance = ?, pinned = ?,
            source = ?, source_session_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        kind,
        description,
        body,
        importance,
        pinned,
        input.source ?? existing.source ?? null,
        input.sourceSessionId ?? existing.sourceSessionId ?? null,
        now,
        existing.id,
      )
      return this.get(existing.id)!
    }

    const id = randomUUID()
    this.#db.prepare(`
      INSERT INTO memory (
        id, persona, kind, description, body, importance, pinned,
        source, source_session_id, created_at, updated_at, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      persona,
      kind,
      description,
      body,
      importance,
      pinned,
      input.source ?? null,
      input.sourceSessionId ?? null,
      now,
      now,
    )
    return this.get(id)!
  }

  patch(id: string, patch: MemoryPatch): MemoryEntry | undefined {
    const current = this.get(id)
    if (!current || current.deletedAt)
      return undefined

    const assignments: string[] = []
    const values: Array<string | number | null> = []
    const set = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`)
      values.push(value)
    }

    if ('persona' in patch)
      set('persona', patch.persona?.trim() || null)
    if (patch.kind !== undefined)
      set('kind', toKind(patch.kind))
    if (patch.description !== undefined)
      set('description', patch.description.trim() || current.body.slice(0, 150))
    if (patch.body !== undefined)
      set('body', patch.body.trim())
    if (patch.importance !== undefined)
      set('importance', clampImportance(patch.importance))
    if (patch.pinned !== undefined)
      set('pinned', patch.pinned ? 1 : 0)
    if ('supersededBy' in patch)
      set('superseded_by', patch.supersededBy?.trim() || null)
    if ('deletedAt' in patch)
      set('deleted_at', patch.deletedAt ?? null)

    if (assignments.length === 0)
      return current

    set('updated_at', Date.now())
    values.push(id)
    this.#db.prepare(`UPDATE memory SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
    return this.get(id)
  }

  makeGeneral(id: string): boolean {
    const result = this.#db
      .prepare('UPDATE memory SET persona = NULL, updated_at = ? WHERE id = ? AND persona IS NOT NULL AND deleted_at IS NULL')
      .run(Date.now(), id)
    return Number(result.changes) > 0
  }

  forget(id: string, persona: string): boolean {
    const result = this.#db
      .prepare('UPDATE memory SET deleted_at = ?, updated_at = ? WHERE id = ? AND persona = ? AND deleted_at IS NULL')
      .run(Date.now(), Date.now(), id, persona)
    return Number(result.changes) > 0
  }

  remove(ids: string[]): number {
    if (ids.length === 0)
      return 0
    const now = Date.now()
    const statement = this.#db.prepare('UPDATE memory SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    let changed = 0
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids)
        changed += Number(statement.run(now, now, id).changes)
      this.#db.exec('COMMIT')
    }
    catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return changed
  }

  clear() {
    this.#db.exec('DELETE FROM memory')
  }

  search(query: string, persona: string | undefined, limit = 8): MemoryEntry[] {
    const entries = this.list({ persona, includeGeneral: true, limit: 5_000 })
      .filter(entry => entry.kind !== 'profile')
    if (entries.length === 0)
      return []

    const ranked = scoreMemoryCandidates(entries, query, { limit })
    const now = Date.now()
    const touch = this.#db.prepare('UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of ranked) {
        if (item.similarity > 0)
          touch.run(now, item.memory.id)
      }
      this.#db.exec('COMMIT')
    }
    catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return ranked.map(item => item.memory)
  }

  import(entries: unknown[]): number {
    const rows: MemoryEntry[] = []
    for (const value of entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        continue
      const input = value as Record<string, unknown>
      if (typeof input.id !== 'string' || typeof input.description !== 'string' || typeof input.body !== 'string')
        continue
      const now = Date.now()
      rows.push({
        id: input.id,
        ...(typeof input.persona === 'string' && input.persona ? { persona: input.persona } : {}),
        kind: toKind(input.kind),
        description: input.description,
        body: input.body,
        importance: clampImportance(input.importance),
        pinned: input.pinned === true,
        ...(typeof input.source === 'string' ? { source: input.source } : {}),
        ...(typeof input.sourceSessionId === 'string' ? { sourceSessionId: input.sourceSessionId } : {}),
        createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
        updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
        ...(typeof input.lastUsedAt === 'number' ? { lastUsedAt: input.lastUsedAt } : {}),
        useCount: typeof input.useCount === 'number' ? input.useCount : 0,
        ...(typeof input.supersededBy === 'string' ? { supersededBy: input.supersededBy } : {}),
        ...(typeof input.deletedAt === 'number' ? { deletedAt: input.deletedAt } : {}),
      })
    }

    const statement = this.#db.prepare(`
      INSERT INTO memory (
        id, persona, kind, description, body, importance, pinned,
        source, source_session_id, created_at, updated_at, last_used_at,
        use_count, superseded_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        persona = excluded.persona,
        kind = excluded.kind,
        description = excluded.description,
        body = excluded.body,
        importance = excluded.importance,
        pinned = excluded.pinned,
        source = excluded.source,
        source_session_id = excluded.source_session_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at,
        use_count = excluded.use_count,
        superseded_by = excluded.superseded_by,
        deleted_at = excluded.deleted_at
    `)

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        statement.run(
          row.id,
          row.persona ?? null,
          row.kind,
          row.description,
          row.body,
          row.importance,
          row.pinned ? 1 : 0,
          row.source ?? null,
          row.sourceSessionId ?? null,
          row.createdAt,
          row.updatedAt,
          row.lastUsedAt ?? null,
          row.useCount,
          row.supersededBy ?? null,
          row.deletedAt ?? null,
        )
      }
      this.#db.exec('COMMIT')
    }
    catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  exportAll() {
    const rows = this.#db
      .prepare('SELECT * FROM memory ORDER BY updated_at ASC')
      .all()
    return rows.map(toEntry)
  }
}
