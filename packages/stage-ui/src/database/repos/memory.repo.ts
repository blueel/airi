import type { MemoryEntry, MemoryWrite } from '../../types/memory'

import localforage from 'localforage'

import { scoreMemoryCandidates } from '@proj-airi/stage-shared/memory-search'
import { v7 as uuidv7 } from 'uuid'

/** A removed entry stays as a tombstone with the time of the removal, so a later sync can remove it on other devices. */
interface MemoryTombstone {
  id: string
  updatedAt: number
  deleted: true
}

type StoredMemory = MemoryEntry | MemoryTombstone

const records = localforage.createInstance({ name: 'airi-memory', storeName: 'entries' })

interface RemoteMemoryConfig {
  url: string
  token?: string
}

let remoteConfig: RemoteMemoryConfig | undefined

/** Switches the repository between the browser store and a remote memory server. */
export function configureMemoryRepository(config: { mode: 'local' | 'remote', url?: string, token?: string }) {
  const url = config.url?.trim()
  remoteConfig = config.mode === 'remote' && url
    ? { url: url.replace(/\/+$/, ''), ...(config.token?.trim() ? { token: config.token.trim() } : {}) }
    : undefined
}

export function isRemoteMemoryRepository() {
  return Boolean(remoteConfig)
}

async function remoteRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<T> {
  const config = remoteConfig
  if (!config)
    throw new Error('Memory server is not configured')

  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Memory server responded ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return await response.json() as T
}

/**
 * Runs one write. Every write of every window takes this lock, so a write that reads the stored records sees every
 * write before it, and no other write lands between its read and its save.
 */
function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:memory', run)
}

/** The stored entry with this id, or undefined when it is missing or removed. */
async function storedEntry(id: string) {
  const stored = await records.getItem<StoredMemory>(id)
  return stored && !('deleted' in stored) ? stored : undefined
}

/** Long-term memory on this device, one record for each entry, keyed by the entry id. */
export const localMemoryRepo = {
  /** The entries that are not removed, oldest change first. */
  async list() {
    const entries: MemoryEntry[] = []
    await records.iterate<StoredMemory, void>((record) => {
      if (!('deleted' in record))
        entries.push(record)
    })
    return entries.sort((left, right) => left.updatedAt - right.updatedAt)
  },
  /** Adds entries as they are, with their ids. Only the move from localStorage uses it. */
  async add(entries: MemoryEntry[]) {
    await write(() => Promise.all(entries.map(entry => records.setItem<MemoryEntry>(entry.id, entry))))
  },
  /**
   * Saves a fact on the card of `persona`, on the stored records. An id of the card's own stored entry replaces that
   * entry. Any other id, for example of a general or a removed entry, adds a new entry with a new id.
   * Resolves to the stored entry.
   */
  async write(input: MemoryWrite, persona: string, updatedAt: number) {
    return write(async () => {
      const own = input.id ? await storedEntry(input.id) : undefined
      const entry: MemoryEntry = {
        id: own?.persona === persona ? own.id : uuidv7(),
        description: input.description,
        body: input.body,
        persona,
        updatedAt,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(own?.createdAt !== undefined ? { createdAt: own.createdAt } : { createdAt: updatedAt }),
        ...(own?.lastUsedAt !== undefined ? { lastUsedAt: own.lastUsedAt } : {}),
        ...(own?.useCount !== undefined ? { useCount: own.useCount } : {}),
      }
      await records.setItem<MemoryEntry>(entry.id, entry)
      return entry
    })
  },
  /** Changes any stored entry. Only the owner uses it, in Settings. */
  async update(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>, updatedAt: number) {
    return write(async () => {
      const stored = await storedEntry(id)
      if (!stored)
        return undefined
      const entry: MemoryEntry = { ...stored, ...fields, id, updatedAt }
      await records.setItem<MemoryEntry>(id, entry)
      return entry
    })
  },
  /** Makes a card's stored entry general. Resolves to whether it changed. */
  async makeGeneral(id: string, updatedAt: number) {
    return write(async () => {
      const stored = await storedEntry(id)
      if (!stored?.persona)
        return false
      const { persona: _card, ...general } = stored
      await records.setItem<MemoryEntry>(id, { ...general, updatedAt })
      return true
    })
  },
  /**
   * Replaces the entry with a tombstone when it still belongs to the card of `persona`. General memories belong to the
   * owner, so a run cannot forget them. Resolves to whether it removed the entry.
   */
  async forget(id: string, persona: string, updatedAt: number) {
    return write(async () => {
      if ((await storedEntry(id))?.persona !== persona)
        return false
      await records.setItem<MemoryTombstone>(id, { id, updatedAt, deleted: true })
      return true
    })
  },
  /** Replaces each entry with a tombstone, whoever owns it. Only the owner removes entries this way, in Settings. */
  async remove(ids: string[], updatedAt: number) {
    await write(() => Promise.all(ids.map(id => records.setItem<MemoryTombstone>(id, { id, updatedAt, deleted: true }))))
  },
  /** Deletes every record, tombstones too. Only deleting all data uses it. */
  async clear() {
    await write(() => records.clear())
  },
  /** Ranks the local entries with the same scorer as the memory server. */
  async search(query: string, persona: string, limit = 8) {
    const entries = (await this.list()).filter(entry => !entry.persona || entry.persona === persona)
    return scoreMemoryCandidates(entries, query, { limit }).map(item => item.memory)
  },
}

/** Long-term memory on the memory server, shared by every device. */
const remoteMemoryRepo = {
  async list() {
    const pageSize = 1_000
    const entries: MemoryEntry[] = []
    let offset = 0
    while (true) {
      const page = await remoteRequest<{ entries: MemoryEntry[], total: number }>(
        `/memory?limit=${pageSize}&offset=${offset}`,
        {},
        3_000,
      )
      entries.push(...page.entries)
      offset += page.entries.length
      if (page.entries.length === 0 || page.entries.length < pageSize || entries.length >= page.total)
        return entries
    }
  },
  async import(entries: MemoryEntry[]) {
    return await remoteRequest<{ imported: number }>('/memory/import', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    })
  },
  async write(input: MemoryWrite, persona: string) {
    const result = await remoteRequest<{ entry: MemoryEntry }>('/memory', {
      method: 'POST',
      body: JSON.stringify({
        id: input.id,
        persona,
        kind: input.kind,
        description: input.description,
        body: input.body,
        importance: input.importance,
        pinned: input.pinned,
        source: input.source,
        sourceSessionId: input.sourceSessionId,
      }),
    })
    return result.entry
  },
  async update(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>) {
    const result = await remoteRequest<{ entry: MemoryEntry }>(`/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    })
    return result.entry
  },
  async makeGeneral(id: string) {
    const result = await remoteRequest<{ changed: boolean }>(`/memory/${encodeURIComponent(id)}/make-general`, { method: 'POST' })
    return result.changed
  },
  async forget(id: string, persona: string) {
    const result = await remoteRequest<{ forgotten: boolean }>('/memory/forget', {
      method: 'POST',
      body: JSON.stringify({ id, persona }),
    })
    return result.forgotten
  },
  async remove(ids: string[]) {
    await remoteRequest('/memory/remove', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    })
  },
  async clear() {
    await remoteRequest('/memory/clear', { method: 'POST' })
  },
  async search(query: string, persona: string, limit = 8) {
    const result = await remoteRequest<{ entries: MemoryEntry[] }>('/memory/search', {
      method: 'POST',
      body: JSON.stringify({ query, persona, limit }),
    }, 1_500)
    return result.entries
  },
  async health() {
    const result = await remoteRequest<{ ok: boolean }>('/health', {}, 3_000)
    return result.ok
  },
  async exportAll() {
    return await remoteRequest<{ format: string, exportedAt: number, memories: MemoryEntry[] }>('/memory/export')
  },
}

/** The repository the memory store uses. Remote mode keeps every device on one database. */
export const memoryRepo = {
  configure: configureMemoryRepository,
  isRemote: isRemoteMemoryRepository,
  async list() {
    return remoteConfig ? remoteMemoryRepo.list() : localMemoryRepo.list()
  },
  async add(entries: MemoryEntry[]) {
    if (remoteConfig)
      return await remoteMemoryRepo.import(entries)
    return await localMemoryRepo.add(entries)
  },
  async write(input: MemoryWrite, persona: string, updatedAt: number) {
    return remoteConfig
      ? await remoteMemoryRepo.write(input, persona)
      : await localMemoryRepo.write(input, persona, updatedAt)
  },
  async update(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>, updatedAt: number) {
    return remoteConfig
      ? await remoteMemoryRepo.update(id, fields)
      : await localMemoryRepo.update(id, fields, updatedAt)
  },
  async makeGeneral(id: string, updatedAt: number) {
    return remoteConfig
      ? await remoteMemoryRepo.makeGeneral(id)
      : await localMemoryRepo.makeGeneral(id, updatedAt)
  },
  async forget(id: string, persona: string, updatedAt: number) {
    return remoteConfig
      ? await remoteMemoryRepo.forget(id, persona)
      : await localMemoryRepo.forget(id, persona, updatedAt)
  },
  async remove(ids: string[], updatedAt: number) {
    if (remoteConfig)
      return await remoteMemoryRepo.remove(ids)
    return await localMemoryRepo.remove(ids, updatedAt)
  },
  async clear() {
    if (remoteConfig)
      return await remoteMemoryRepo.clear()
    return await localMemoryRepo.clear()
  },
  async search(query: string, persona: string, limit = 8) {
    return remoteConfig
      ? await remoteMemoryRepo.search(query, persona, limit)
      : await localMemoryRepo.search(query, persona, limit)
  },
  async listLocal() {
    return await localMemoryRepo.list()
  },
  async importLocal(entries: MemoryEntry[]) {
    return await remoteMemoryRepo.import(entries)
  },
  async migrateLocalToRemote() {
    const entries = await localMemoryRepo.list()
    if (!entries.length)
      return 0
    const result = await remoteMemoryRepo.import(entries)
    return result.imported
  },
  async health() {
    if (!remoteConfig)
      return true
    return await remoteMemoryRepo.health()
  },
  async exportAll() {
    if (remoteConfig)
      return await remoteMemoryRepo.exportAll()
    return {
      format: 'airi-memory-export:v1',
      exportedAt: Date.now(),
      memories: await localMemoryRepo.list(),
    }
  },
  async importAll(entries: MemoryEntry[]) {
    if (remoteConfig)
      return await remoteMemoryRepo.import(entries)
    await localMemoryRepo.add(entries)
    return entries.length
  },
}
