import process from 'node:process'

import { serve } from '@hono/node-server'

import { createMemoryApp } from './app'
import { MemoryDatabase } from './db'

const port = Number(process.env.MEMORY_PORT ?? 4319)
const hostname = process.env.MEMORY_HOST?.trim() || '127.0.0.1'
const dbPath = process.env.MEMORY_DB_PATH?.trim() || './data/memory.db'
const token = process.env.MEMORY_TOKEN?.trim()
if (!token) {
  console.error('[memory-server] MEMORY_TOKEN is required. Generate one with: openssl rand -hex 18')
  process.exit(1)
}
const allowedOrigins = (process.env.MEMORY_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

const db = new MemoryDatabase(dbPath)
const app = createMemoryApp(db, { token, allowedOrigins })

serve({ fetch: app.fetch, port, hostname })

console.info(`[memory-server] listening on http://${hostname}:${port}`)
console.info(`[memory-server] database ${dbPath}`)

function close() {
  db.close()
  process.exit(0)
}

process.on('SIGINT', close)
process.on('SIGTERM', close)
