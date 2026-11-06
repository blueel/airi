import type { Conversation } from '@proj-airi/core-agent'

import type { MemoryEntry, MemoryWrite } from '../types/memory'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { scoreMemoryCandidates, tokenizeMemoryText } from '@proj-airi/stage-shared/memory-search'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { v7 as uuidv7 } from 'uuid'
import { array, optional, safeParse, strictObject, string } from 'valibot'
import { computed, ref, watch } from 'vue'

import { useTextGeneration } from '../composables/text-generation'
import { localMemoryRepo, memoryRepo } from '../database/repos/memory.repo'

const LEGACY_ENTRIES_STORAGE_KEY = 'memory/entries'
const REMOTE_MIGRATED_KEY = 'memory/remote-migrated'
const MAX_INDEX_ENTRIES = 60
const MAX_INDEX_CHARS = 6_000
const MAX_RECALL_CANDIDATES = 80
const RECALL_TIMEOUT_MS = 2_000
const RECALL_SYSTEM_PROMPT = [
  'You choose long-term memories that help a companion character answer the owner.',
  'Choose by meaning, not by shared words. A memory helps when it explains the owner message or gives relevant context, even when the words differ.',
  'Return JSON only: {"ids":["..."]}. Choose at most 6 ids from the list. If no memory helps, return {"ids":[]}.',
  'Never invent an id. Do not choose the owner profile; it is already in the prompt.',
].join('\n')
const recallSchema = strictObject({ ids: optional(array(string())) })

function parseJsonObject(raw: string) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown
  }
  catch {
    return undefined
  }
}

// NOTICE:
// v0.13.1 stored entries in localStorage, keyed by a model-chosen name.
// IndexedDB now keeps them with generated ids. Move them once; the lock stops two windows from moving them twice.
// Removal condition: two releases after the release that moves them.
async function moveLegacyEntries() {
  if (!globalThis.localStorage?.getItem(LEGACY_ENTRIES_STORAGE_KEY))
    return
  await navigator.locks.request('airi:memory-move', async () => {
    const stored = localStorage.getItem(LEGACY_ENTRIES_STORAGE_KEY)
    if (!stored)
      return
    const legacy: (Omit<MemoryEntry, 'id'> & { name: string })[] = JSON.parse(stored)
    await localMemoryRepo.add(legacy.map(({ description, body, persona, updatedAt }) => ({ id: uuidv7(), description, body, persona, updatedAt })))
    localStorage.removeItem(LEGACY_ENTRIES_STORAGE_KEY)
  })
}

/**
 * Long-term memory as a small index and one entry per fact, kept by the character itself.
 * IndexedDB keeps the entries by default. A memory server keeps them for every device when one is configured.
 * After each change, the other windows read them again.
 *
 * Use when:
 * - A run reads the index or an entry, writes or forgets a fact, or Settings lists the memories by card.
 *
 * Expects:
 * - Callers pass the character card of the run. It reads its own memories and the general ones.
 * - Only the owner makes a memory general, in Settings. A run writes and forgets only its own card's memories.
 *
 * Returns:
 * - Whether memory is on, entries, `ready` for the first read, the index for a card, and actions that change entries.
 */
export const useMemoryStore = defineStore('memory', () => {
  const enabled = useLocalStorageManualReset<boolean>('memory/enabled', true)
  const autoFormation = useLocalStorageManualReset<boolean>('memory/auto-formation', true)
  const backend = useLocalStorageManualReset<'local' | 'remote'>('memory/backend', 'local')
  const serverUrl = useLocalStorageManualReset<string>('memory/server-url', '/api/memory')
  const serverToken = useLocalStorageManualReset<string>('memory/server-token', '')
  const formationProvider = useLocalStorageManualReset<string>('memory/formation/provider', 'deepseek')
  const formationModel = useLocalStorageManualReset<string>('memory/formation/model', 'deepseek-flash')
  const entries = ref<MemoryEntry[]>([])
  const { data: changed, post } = useBroadcastChannel<string[], string[]>({ name: 'airi:memory' })
  const { generateText } = useTextGeneration()

  function applyBackend() {
    memoryRepo.configure({ mode: backend.value, url: serverUrl.value, token: serverToken.value })
  }
  applyBackend()

  let pendingLoad = moveLegacyEntries()
    .catch(error => console.warn('[memory] Failed to move the entries from localStorage:', errorMessageFrom(error)))

  /** Reads the entries again, after the reads that started before. */
  function load() {
    pendingLoad = pendingLoad.catch(() => {}).then(async () => {
      if (memoryRepo.isRemote()) {
        const remote = await memoryRepo.list()
        const migrated = localStorage.getItem(REMOTE_MIGRATED_KEY) === 'true'
        if (!remote.length && !migrated) {
          const local = await memoryRepo.listLocal()
          if (local.length) {
            await memoryRepo.importLocal(local)
            localStorage.setItem(REMOTE_MIGRATED_KEY, 'true')
            entries.value = await memoryRepo.list()
            return
          }
        }
        entries.value = remote
        return
      }
      entries.value = await memoryRepo.list()
    })
    return pendingLoad
  }

  /**
   * Resolves after every read that started before the call, the first read and the move from localStorage included.
   * Until then, `entries` is empty because nothing is read yet, not because nothing is remembered.
   */
  function ready() {
    return pendingLoad.catch(() => {})
  }

  /** Reads the entries again after a change, and tells the other windows. */
  async function publish(ids: string[]) {
    await load()
    post(ids)
  }

  /**
   * The index for a card: its own memories, then general ones, each as an id and its description.
   * A run reads it when it starts, from the entries that the window read last.
   */
  function indexFor(personaId: string) {
    const visible = entries.value
      .filter(entry => entry.kind !== 'profile' && (!entry.persona || entry.persona === personaId))
      .sort(indexOrder)
    return formatIndex(visible, personaId)
  }

  /** A smaller index for the stable system prompt: pinned entries and the most important recent ones. */
  function coreIndexFor(personaId: string) {
    const visible = entries.value
      .filter(entry => entry.kind !== 'profile' && (!entry.persona || entry.persona === personaId))
      .sort((left, right) => {
        const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
        if (pinned !== 0)
          return pinned
        const importance = (right.importance ?? 3) - (left.importance ?? 3)
        if (importance !== 0)
          return importance
        return right.updatedAt - left.updatedAt
      })
      .slice(0, 12)
    return formatIndex(visible, personaId)
  }

  /** The user profile that the extraction pass keeps. */
  function profileFor(personaId: string) {
    return entries.value.find(entry => entry.kind === 'profile' && entry.persona === personaId)
      ?? entries.value.find(entry => entry.kind === 'profile' && !entry.persona)
  }

  /** Reads an entry that the persona can see by its id: one of its own, or a general one. */
  function read(id: string, personaId: string) {
    return entries.value.find(entry => entry.id === id && (!entry.persona || entry.persona === personaId))
  }

  /**
   * Saves a fact on the card. An id of the card's own entry replaces that entry. Any other id, for example of a general
   * entry that only the owner changes, adds a new entry. Resolves to the stored entry, or undefined for an empty body.
   */
  async function write(input: MemoryWrite, personaId: string) {
    const body = input.body.trim()
    if (!body)
      return undefined
    // The background pass and a reflection can see the same fact twice. Reuse the closest own entry instead of growing duplicates.
    const id = input.id ?? (input.source === 'auto' || input.source === 'reflection' ? duplicateIdOf(entries.value, input, personaId) : undefined)
    const entry = await memoryRepo.write({
      ...input,
      id,
      description: input.description.trim(),
      body,
    }, personaId, Date.now())
    await publish([entry.id])
    return entry
  }

  /** Changes any entry. Only the owner uses it, in Settings. */
  async function update(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>) {
    const entry = await memoryRepo.update(id, fields, Date.now())
    if (entry)
      await publish([entry.id])
    return entry
  }

  /** Makes a card's memory general, so every card reads it. */
  async function makeGeneral(entry: Pick<MemoryEntry, 'id'>) {
    if (await memoryRepo.makeGeneral(entry.id, Date.now()))
      await publish([entry.id])
  }

  /** Removes one entry from Settings. */
  async function remove(entry: Pick<MemoryEntry, 'id'>) {
    await memoryRepo.remove([entry.id], Date.now())
    await publish([entry.id])
  }

  /** Forgets an entry of the card by its id. General memories belong to the owner, so a run cannot forget them. */
  async function forget(id: string, personaId: string) {
    if (!await memoryRepo.forget(id, personaId, Date.now()))
      return false
    await publish([id])
    return true
  }

  /**
   * Reads the memories that matter for this message. Local mode ranks the entries already in memory, so it never
   * waits on IndexedDB. A remote server ranks them; `timeoutMs` lets a chat stop waiting and send without memory.
   */
  async function retrieve(query: string, personaId: string, limit = 8, options: { timeoutMs?: number } = {}) {
    if (!enabled.value || !query.trim())
      return []

    const local = () => {
      const visible = entries.value
        .filter(entry => entry.kind !== 'profile' && (!entry.persona || entry.persona === personaId))
      return scoreMemoryCandidates(visible, query, { limit }).map(item => item.memory)
    }

    const run = (async () => {
      if (!memoryRepo.isRemote())
        return local()
      try {
        return await memoryRepo.search(query, personaId, limit)
      }
      catch (error) {
        // A server that is down or slow must not keep the chat waiting. Fall back to the entries this window already has.
        if ((error as { name?: string }).name !== 'AbortError')
          console.warn('[memory] Failed to read from the memory server, using the local entries:', errorMessageFrom(error))
        return local()
      }
    })()

    if (!options.timeoutMs)
      return await run

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<MemoryEntry[]>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs, [])
    })
    try {
      return await Promise.race([run, timeout])
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  /**
   * Picks the memories that help this message by meaning, through the memory model. The candidate list is bounded,
   * so the selection prompt stays small while the main prompt receives only the chosen entries.
   */
  async function selectRelevant(query: string, personaId: string, limit = 6, options: { timeoutMs?: number, signal?: AbortSignal } = {}) {
    if (!enabled.value || !query.trim())
      return []
    const providerId = formationProvider.value.trim()
    const model = formationModel.value.trim()
    if (!providerId || !model)
      return []

    const candidates = entries.value
      .filter(entry => entry.kind !== 'profile' && (!entry.persona || entry.persona === personaId))
      .slice(0, MAX_RECALL_CANDIDATES)
    if (candidates.length === 0)
      return []

    const catalog = candidates.map(entry => `[${entry.id}] (${entry.kind}) ${entry.description}`).join('\n')
    const conversation: Conversation = {
      turns: [
        {
          id: 'memory-recall-system',
          type: 'system',
          authority: 'system',
          content: [{ type: 'text', text: RECALL_SYSTEM_PROMPT }],
        },
        {
          id: 'memory-recall-user',
          type: 'user',
          content: [{ type: 'text', text: `Owner message:\n${query.slice(0, 2_000)}\n\nMemories:\n${catalog}` }],
        },
      ],
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? RECALL_TIMEOUT_MS)
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const raw = await generateText({ providerId, model })(conversation, controller.signal)
      const json = parseJsonObject(raw)
      const parsed = json ? safeParse(recallSchema, json) : undefined
      if (!parsed?.success)
        return []
      const seen = new Set<string>()
      return (parsed.output.ids ?? [])
        .map(id => read(id, personaId))
        .filter((entry): entry is MemoryEntry => {
          if (!entry || seen.has(entry.id))
            return false
          seen.add(entry.id)
          return true
        })
        .slice(0, limit)
    }
    catch (error) {
      if ((error as { name?: string }).name !== 'AbortError')
        console.warn('[memory] Semantic recall failed:', errorMessageFrom(error))
      return []
    }
    finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  /** Checks that the configured memory server answers. */
  async function testConnection() {
    try {
      return await memoryRepo.health()
    }
    catch {
      return false
    }
  }

  /** Copies this browser's memories to the configured server. Resolves to the number of entries sent. */
  async function migrateLocalToRemote() {
    const count = await memoryRepo.migrateLocalToRemote()
    if (count > 0) {
      localStorage.setItem(REMOTE_MIGRATED_KEY, 'true')
      await publish([])
    }
    return count
  }

  async function resetState() {
    enabled.reset()
    autoFormation.reset()
    formationProvider.reset()
    formationModel.reset()
    localStorage.removeItem(REMOTE_MIGRATED_KEY)
    await memoryRepo.clear()
    await publish([])
  }

  function reload() {
    void load().catch(error => console.warn('[memory] Failed to read the entries:', errorMessageFrom(error)))
  }

  watch([backend, serverUrl, serverToken], () => {
    applyBackend()
    reload()
  })
  watch(changed, reload)
  reload()

  return {
    enabled,
    autoFormation,
    backend,
    serverUrl,
    serverToken,
    formationProvider,
    formationModel,
    entries: computed(() => entries.value),
    ready,
    indexFor,
    coreIndexFor,
    profileFor,
    read,
    write,
    update,
    makeGeneral,
    forget,
    remove,
    retrieve,
    selectRelevant,
    testConnection,
    migrateLocalToRemote,
    resetState,
  }
})

function indexOrder(left: MemoryEntry, right: MemoryEntry) {
  const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
  if (pinned !== 0)
    return pinned
  const importance = (right.importance ?? 3) - (left.importance ?? 3)
  if (importance !== 0)
    return importance
  return right.updatedAt - left.updatedAt
}

function formatIndex(entries: readonly MemoryEntry[], personaId: string, includeGeneral = true) {
  const line = (entry: MemoryEntry) => `- ${entry.id}: ${entry.description}`
  let used = 0
  let count = 0
  const take = (source: readonly MemoryEntry[]) => {
    const lines: string[] = []
    for (const entry of source) {
      if (count >= MAX_INDEX_ENTRIES)
        break
      const text = line(entry)
      if (used + text.length > MAX_INDEX_CHARS)
        break
      lines.push(text)
      used += text.length
      count += 1
    }
    return lines
  }
  const own = take(entries.filter(entry => entry.persona === personaId))
  const general = includeGeneral ? take(entries.filter(entry => !entry.persona)) : []
  return [
    ...(own.length ? [`Your own:\n${own.join('\n')}`] : []),
    ...(general.length ? [`General:\n${general.join('\n')}`] : []),
  ].join('\n')
}

function normalizedText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function jaccard(left: readonly string[], right: readonly string[]) {
  if (left.length === 0 || right.length === 0)
    return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  let intersection = 0
  for (const token of leftSet) {
    if (rightSet.has(token))
      intersection++
  }
  return intersection / (leftSet.size + rightSet.size - intersection)
}

/** The own entry that an automatic write repeats, so the background pass updates instead of appending. */
function duplicateIdOf(entries: readonly MemoryEntry[], input: MemoryWrite, personaId: string) {
  const kind = input.kind ?? 'fact'
  const description = normalizedText(input.description)
  const tokens = tokenizeMemoryText(`${input.description}\n${input.body}`)
  for (const entry of entries) {
    if (entry.persona !== personaId || (entry.kind ?? 'fact') !== kind)
      continue
    if (description && normalizedText(entry.description) === description)
      return entry.id
    if (jaccard(tokens, tokenizeMemoryText(`${entry.description}\n${entry.body}`)) >= 0.9)
      return entry.id
  }
  return undefined
}
