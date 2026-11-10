import process from 'node:process'

/**
 * AIRI memory viewer — read-only dashboard over the memory-server SQLite file.
 *
 * Usage:
 *   node --disable-warning=ExperimentalWarning server.mjs
 *   node --disable-warning=ExperimentalWarning server.mjs --db path/to/memory.db --port 4320
 *
 * Env: MEMORY_DB_PATH, PORT, HOST.
 *
 * It never writes to the database. Every query runs on a single connection opened
 * with `PRAGMA query_only = 1`, so a typo in a filter cannot corrupt the memories
 * the running memory-server owns.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dbPath = resolve(
  argOf('db')
  ?? process.env.MEMORY_DB_PATH
  ?? join(here, '../../services/memory-server/data/memory.db'),
)
const port = Number(argOf('port') ?? process.env.PORT ?? 4320)
const host = argOf('host') ?? process.env.HOST ?? '127.0.0.1'
const publicDir = join(here, 'public')

if (!existsSync(dbPath)) {
  console.error(`[memory-viewer] database not found: ${dbPath}`)
  console.error('[memory-viewer] pass --db <path> or set MEMORY_DB_PATH')
  process.exit(1)
}

let db
let readOnly = true
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only = 1')
}
catch (error) {
  // A WAL database without a readable -shm file refuses a read-only open. Fall back
  // to a read-write handle and keep `query_only` on, so the connection still cannot write.
  console.warn(`[memory-viewer] read-only open failed (${describeError(error)}); retrying read-write + query_only`)
  readOnly = false
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA query_only = 1')
}

const KINDS = new Set(['profile', 'fact', 'episode'])

function text(value) {
  return typeof value === 'string' ? value : ''
}

function num(value) {
  if (typeof value === 'number')
    return value
  return typeof value === 'bigint' ? Number(value) : 0
}

function optionalNum(value) {
  if (typeof value === 'number')
    return value
  return typeof value === 'bigint' ? Number(value) : undefined
}

function toEntry(row) {
  const persona = text(row.persona) || undefined
  return {
    id: text(row.id),
    persona,
    kind: KINDS.has(text(row.kind)) ? text(row.kind) : 'fact',
    description: text(row.description),
    body: text(row.body),
    importance: num(row.importance),
    pinned: num(row.pinned) !== 0,
    source: text(row.source) || undefined,
    sourceSessionId: text(row.source_session_id) || undefined,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    lastUsedAt: optionalNum(row.last_used_at),
    useCount: num(row.use_count),
    supersededBy: text(row.superseded_by) || undefined,
    deletedAt: optionalNum(row.deleted_at),
    embeddingModel: text(row.embedding_model) || undefined,
  }
}

/** Same shape as `errorMessageFrom` in @moeru/std, without pulling a workspace dependency. */
function describeError(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, parsed))
}

const SORTS = {
  default: 'pinned DESC, importance DESC, updated_at DESC',
  updated: 'updated_at DESC',
  created: 'updated_at DESC',
  oldest: 'updated_at ASC',
  importance: 'importance DESC, updated_at DESC',
  used: 'use_count DESC, updated_at DESC',
  description: 'description COLLATE NOCASE ASC',
}

/** Shared WHERE builder for the list, the count and the export, so the three never drift. */
function buildFilter(params) {
  const where = []
  const values = []

  if (params.get('deleted') !== '1')
    where.push('deleted_at IS NULL')

  const persona = params.get('persona')
  if (persona === '__general__') {
    where.push('persona IS NULL')
  }
  else if (persona && persona !== '__all__') {
    where.push('persona = ?')
    values.push(persona)
  }

  const kind = params.get('kind')
  if (kind && KINDS.has(kind)) {
    where.push('kind = ?')
    values.push(kind)
  }

  const pinned = params.get('pinned')
  if (pinned === '1' || pinned === '0') {
    where.push('pinned = ?')
    values.push(Number(pinned))
  }

  const importance = Number.parseInt(params.get('importance') ?? '', 10)
  if (Number.isFinite(importance) && importance > 1) {
    where.push('importance >= ?')
    values.push(importance)
  }

  const from = Number.parseInt(params.get('from') ?? '', 10)
  if (Number.isFinite(from)) {
    where.push('updated_at >= ?')
    values.push(from)
  }

  const to = Number.parseInt(params.get('to') ?? '', 10)
  if (Number.isFinite(to)) {
    where.push('updated_at <= ?')
    values.push(to)
  }

  const q = (params.get('q') ?? '').trim()
  if (q) {
    where.push(`(description LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(q)}%`
    values.push(pattern, pattern)
  }

  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    values,
  }
}

function listEntries(params) {
  const { clause, values } = buildFilter(params)
  const limit = intParam(params.get('limit'), 50, 1, 500)
  const offset = intParam(params.get('offset'), 0, 0, 1_000_000)
  const order = SORTS[params.get('sort') ?? ''] ?? SORTS.default

  const total = num(db.prepare(`SELECT COUNT(*) AS total FROM memory ${clause}`).get(...values)?.total)
  const rows = db.prepare(`SELECT * FROM memory ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit, offset)

  return { total, limit, offset, entries: rows.map(toEntry) }
}

function overview() {
  const active = num(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NULL').get()?.n)
  const deleted = num(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NOT NULL').get()?.n)
  const pinned = num(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NULL AND pinned = 1').get()?.n)
  const general = num(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NULL AND persona IS NULL').get()?.n)
  const personas = db
    .prepare(`SELECT COALESCE(persona, '__general__') AS persona, COUNT(*) AS n
              FROM memory WHERE deleted_at IS NULL
              GROUP BY persona ORDER BY n DESC`)
    .all()
    .map(row => ({ persona: text(row.persona), count: num(row.n) }))
  const kinds = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM memory WHERE deleted_at IS NULL GROUP BY kind ORDER BY n DESC`)
    .all()
    .map(row => ({ kind: text(row.kind), count: num(row.n) }))

  const range = db.prepare('SELECT MIN(created_at) AS first, MAX(updated_at) AS last FROM memory').get()

  return {
    active,
    deleted,
    pinned,
    general,
    personas,
    kinds,
    firstAt: optionalNum(range?.first),
    lastAt: optionalNum(range?.last),
  }
}

/** Daily counts of entries whose `updated_at` lands on that day, gaps filled with zero. */
function dailyCounts(days) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))

  const rows = db
    .prepare(`SELECT date(updated_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
              FROM memory WHERE deleted_at IS NULL AND updated_at >= ?
              GROUP BY day`)
    .all(start.getTime())

  const found = new Map(rows.map(row => [text(row.day), num(row.n)]))
  const series = []
  for (let index = 0; index < days; index++) {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    series.push({ day: key, count: found.get(key) ?? 0 })
  }
  return series
}

const CSV_COLUMNS = [
  'id',
  'persona',
  'kind',
  'description',
  'body',
  'importance',
  'pinned',
  'source',
  'source_session_id',
  'created_at',
  'updated_at',
  'last_used_at',
  'use_count',
  'deleted_at',
]

function csvCell(value) {
  if (value === null || value === undefined)
    return ''
  const raw = String(value)
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function isoOrEmpty(value) {
  return typeof value === 'number' ? new Date(value).toISOString() : ''
}

function exportCsv(params) {
  const { clause, values } = buildFilter(params)
  const rows = db.prepare(`SELECT * FROM memory ${clause} ORDER BY updated_at DESC`).all(...values)
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push([
      text(row.id),
      text(row.persona),
      text(row.kind),
      text(row.description),
      text(row.body),
      num(row.importance),
      num(row.pinned),
      text(row.source),
      text(row.source_session_id),
      isoOrEmpty(optionalNum(row.created_at)),
      isoOrEmpty(optionalNum(row.updated_at)),
      isoOrEmpty(optionalNum(row.last_used_at)),
      num(row.use_count),
      isoOrEmpty(optionalNum(row.deleted_at)),
    ].map(csvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}`
}

function exportJson(params) {
  const { clause, values } = buildFilter(params)
  const rows = db.prepare(`SELECT * FROM memory ${clause} ORDER BY updated_at DESC`).all(...values)
  return JSON.stringify({
    format: 'airi-memory-export:v1',
    exportedAt: Date.now(),
    memories: rows.map(toEntry),
  }, null, 2)
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendText(response, body, type, filename) {
  const headers = { 'content-type': type, 'cache-control': 'no-store' }
  if (filename)
    headers['content-disposition'] = `attachment; filename="${filename}"`
  response.writeHead(200, headers)
  response.end(body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = resolve(join(publicDir, relative))
  if (!target.startsWith(resolve(publicDir))) {
    response.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(target).pipe(response)
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const params = url.searchParams

  try {
    if (url.pathname === '/api/meta') {
      const summary = overview()
      // A young database would leave most of a fixed 30-day window empty, so shrink
      // the window to the age of the data and keep at least a week for context.
      const ageDays = summary.firstAt
        ? Math.ceil((Date.now() - summary.firstAt) / 86_400_000) + 1
        : 30
      const windowDays = Math.min(30, Math.max(7, ageDays))
      return sendJson(response, {
        dbPath,
        readOnly,
        sizeBytes: statSync(dbPath).size,
        updatedAt: statSync(dbPath).mtimeMs,
        ...summary,
        dailyDays: windowDays,
        daily: dailyCounts(windowDays),
      })
    }

    if (url.pathname === '/api/memories')
      return sendJson(response, listEntries(params))

    if (url.pathname === '/api/export') {
      if (params.get('format') === 'csv') {
        const stamp = new Date().toISOString().slice(0, 10)
        return sendText(response, exportCsv(params), 'text/csv; charset=utf-8', `airi-memory-${stamp}.csv`)
      }
      const stamp = new Date().toISOString().slice(0, 10)
      return sendText(response, exportJson(params), 'application/json; charset=utf-8', `airi-memory-${stamp}.json`)
    }

    if (url.pathname.startsWith('/api/'))
      return sendJson(response, { error: 'unknown endpoint' }, 404)

    return serveStatic(response, url.pathname)
  }
  catch (error) {
    console.error('[memory-viewer]', error)
    return sendJson(response, { error: describeError(error) }, 500)
  }
})

server.listen(port, host, () => {
  console.info(`[memory-viewer] http://${host}:${port}`)
  console.info(`[memory-viewer] database ${dbPath} (${readOnly ? 'read-only' : 'query_only'})`)
})

function shutdown() {
  try {
    db.close()
  }
  catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
