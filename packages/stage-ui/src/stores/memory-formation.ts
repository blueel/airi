import type { Conversation } from '@proj-airi/core-agent'
import type { InferOutput } from 'valibot'

import type { ChatHistoryItem } from '../types/chat'
import type { MemoryEntry, MemoryKind } from '../types/memory'

import { errorMessageFrom } from '@moeru/std'
import { containsLikelySecret } from '@proj-airi/stage-shared/memory-secret'
import { defineStore } from 'pinia'
import { array, number, optional, picklist, safeParse, strictObject, string } from 'valibot'
import { ref } from 'vue'

import { useTextGeneration } from '../composables/text-generation'
import { useMemoryStore } from './memory'

const CURSOR_PREFIX = 'memory/formation/cursor/'
const REQUEST_TIMEOUT_MS = 60_000
const MAX_TRANSCRIPT_CHARS = 6_000
const MAX_MEMORIES_PER_PASS = 8
const SYNC_CHUNK_MESSAGES = 10
const SYNC_MAX_CALLS = 40

const formationSchema = strictObject({
  profile: optional(string()),
  memories: optional(array(strictObject({
    action: picklist(['add', 'update', 'merge', 'delete', 'skip']),
    id: optional(string()),
    targetIds: optional(array(string())),
    kind: optional(picklist(['fact', 'episode'])),
    description: optional(string()),
    body: optional(string()),
    importance: optional(number()),
  }))),
})

type FormationResult = InferOutput<typeof formationSchema>
type FormationMemory = NonNullable<FormationResult['memories']>[number]

interface FormationPayload {
  sessionId: string
  persona: string
  providerId: string
  model: string
  messages: ChatHistoryItem[]
}

interface FormationRange {
  start: number
  end: number
}

/** One conversation that the manual sync should turn into memories. */
export interface MemorySyncSession {
  sessionId: string
  persona: string
  providerId: string
  model: string
  messages: ChatHistoryItem[]
}

export interface MemorySyncProgress {
  calls: number
  sessions: number
}

export interface MemorySyncResult extends MemorySyncProgress {
  stopped: boolean
}

const FORMATION_SYSTEM_PROMPT = [
  'You maintain long-term memory for a companion character.',
  'Return JSON only, without markdown fences and without commentary.',
  'Shape:',
  '{"profile":"optional updated profile","memories":[{"action":"add|update|merge|delete|skip","id":"existing id for update or delete","targetIds":["existing ids for merge"],"kind":"fact|episode","description":"one line, at most 150 characters","body":"the fact, at most 2000 characters","importance":1}]}',
  'Rules:',
  '- Extract only from the Owner lines of the transcript. The Character lines are context.',
  '- Save durable facts, preferences, relationships, plans, promises, and lasting instructions. Skip greetings, small talk, one-off requests, and the character\'s wording.',
  '- One fact per entry. Write each entry as a standalone statement that is clear without the transcript. Include the date when the time matters.',
  '- Use the language of the owner\'s latest message. A Chinese conversation gets Chinese entries. Do not translate them into English.',
  '- Never save passwords, API keys, bank or identity numbers, or other secrets.',
  '- Compare every new fact with "Existing related memories" before you write:',
  '  - add: no existing entry says this.',
  '  - update: one existing entry states the same fact, and the new text corrects it or adds a specific detail. Put that id in id and the complete new text in body.',
  '  - merge: several existing entries describe the same fact, process, or event and complement each other. List them in targetIds and write one complete entry without repetition.',
  '  - skip: an existing entry already says this, or the new text is vaguer.',
  '  - delete: the owner retracts or corrects a fact. Put the entry id in id.',
  '- Never update, merge, or delete an entry marked (pinned). If new information contradicts a pinned entry, use add.',
  '- Importance: 5 for identity, health, safety, a taboo, or a promise. 4 for a lasting preference or an important plan. 3 for an ordinary durable fact. 2 for a minor detail. 1 for passing context.',
  '- Add at most one episode entry for a meaningful shared event, decision, or result. Do not record the character\'s behavior alone.',
  '- Update profile only when the owner reveals stable identity, language, work, relationships, or lasting preferences. Write a compact narrative of at most 1200 characters. Keep what is still true, and do not invent.',
  '- An empty memories array is a valid answer.',
].join('\n')

function textOf(message: ChatHistoryItem): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string')
      return message.content
    return message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
  }
  if (message.role === 'assistant') {
    return message.slices
      .filter(slice => slice.type === 'text')
      .map(slice => slice.text)
      .join('')
  }
  return ''
}

function transcriptLines(messages: ChatHistoryItem[]) {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({ role: message.role, text: textOf(message) }))
    .filter(line => line.text.trim().length > 0)
}

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

function readCursor(sessionId: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${CURSOR_PREFIX}${sessionId}`) ?? 'null') as { messageId?: string } | null
    return parsed?.messageId
  }
  catch {
    return undefined
  }
}

function writeCursor(sessionId: string, messageId: string | undefined) {
  if (!messageId)
    return
  localStorage.setItem(`${CURSOR_PREFIX}${sessionId}`, JSON.stringify({ messageId, at: Date.now() }))
}

function trimTranscript(lines: Array<{ role: string, text: string }>) {
  const kept: typeof lines = []
  let chars = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (kept.length >= 12 || chars + line.text.length > MAX_TRANSCRIPT_CHARS)
      break
    kept.unshift(line)
    chars += line.text.length
  }
  return kept
}

/**
 * Forms long-term memory after a finished turn. One background model call extracts facts,
 * updates the owner profile, and may add one episode. It never blocks the reply.
 */
export const useMemoryFormationStore = defineStore('memory-formation', () => {
  const memory = useMemoryStore()
  const { generateText } = useTextGeneration()

  const running = new Set<string>()

  async function applyProfile(profile: string | undefined, persona: string) {
    const body = profile?.trim()
    if (!body)
      return
    if (containsLikelySecret(body)) {
      console.warn('[memory] Skipped a profile that looks like it contains a secret.')
      return
    }
    const existing = memory.profileFor(persona)
    await memory.write({
      id: existing?.persona === persona ? existing.id : undefined,
      description: 'Owner profile',
      body: body.slice(0, 1200),
      kind: 'profile',
      pinned: true,
      importance: 5,
      source: 'auto',
    }, persona)
  }

  async function applyMemory(item: FormationMemory, persona: string, sessionId: string) {
    if (item.action === 'skip')
      return

    if (item.action === 'delete' || item.action === 'update') {
      if (!item.id)
        return
      const existing = memory.read(item.id, persona)
      // The background pass can change only this card's entries. General and pinned entries belong to the owner.
      if (!existing || existing.persona !== persona)
        return
      if (existing.pinned) {
        console.warn('[memory] Kept a pinned entry unchanged.')
        return
      }
      if (item.action === 'delete') {
        await memory.forget(existing.id, persona)
        return
      }

      const body = item.body?.trim() || existing.body
      if (!body)
        return
      if (containsLikelySecret(`${item.description ?? ''} ${body}`)) {
        console.warn('[memory] Skipped a memory update that looks like it contains a secret.')
        return
      }
      await memory.write({
        id: existing.id,
        description: item.description?.trim() || existing.description,
        body,
        kind: (item.kind ?? existing.kind ?? 'fact') as MemoryKind,
        importance: item.importance ?? existing.importance,
        source: 'auto',
        sourceSessionId: sessionId,
      }, persona)
      return
    }

    if (item.action === 'merge') {
      const targets = [...new Set(item.targetIds ?? [])]
        .map(id => memory.read(id, persona))
        .filter((entry): entry is MemoryEntry => Boolean(entry && entry.persona === persona && !entry.pinned))
      const body = item.body?.trim()
      // A merge with no usable target is a new fact. Fall through to add it.
      if (targets.length > 0 && body) {
        if (containsLikelySecret(`${item.description ?? ''} ${body}`)) {
          console.warn('[memory] Skipped a memory merge that looks like it contains a secret.')
          return
        }
        const [primary, ...rest] = targets
        await memory.write({
          id: primary!.id,
          description: item.description?.trim() || primary!.description || body.slice(0, 150),
          body,
          kind: (item.kind ?? primary!.kind ?? 'fact') as MemoryKind,
          importance: Math.min(5, Math.max(item.importance ?? 1, ...targets.map(entry => entry.importance ?? 3))),
          source: 'auto',
          sourceSessionId: sessionId,
        }, persona)
        for (const target of rest)
          await memory.forget(target.id, persona)
        return
      }
    }

    const body = item.body?.trim()
    if (!body)
      return
    if (containsLikelySecret(`${item.description ?? ''} ${body}`)) {
      console.warn('[memory] Skipped a memory that looks like it contains a secret.')
      return
    }
    await memory.write({
      description: item.description?.trim() || body.slice(0, 150),
      body,
      kind: (item.kind ?? 'fact') as MemoryKind,
      importance: item.importance,
      source: 'auto',
      sourceSessionId: sessionId,
    }, persona)
  }

  async function runOnce(payload: FormationPayload, range?: FormationRange): Promise<boolean> {
    const { sessionId, persona, providerId, model, messages } = payload

    const cursor = readCursor(sessionId)
    const cursorIndex = cursor ? messages.findIndex(message => message.id === cursor) : -1
    const start = range?.start ?? (cursorIndex >= 0 ? cursorIndex + 1 : Math.max(0, messages.length - 12))
    const end = range?.end ?? messages.length
    const recent = transcriptLines(messages.slice(start, end))

    if (recent.length < 2)
      return true

    const transcript = trimTranscript(recent)
    const lastUser = transcript.findLast(line => line.role === 'user')
    if (!lastUser)
      return true

    const background = trimTranscript(transcriptLines(messages.slice(Math.max(0, start - 5), start)))

    try {
      const query = transcript.filter(line => line.role === 'user').slice(-2).map(line => line.text).join('\n')
      const retrieved = query.trim() ? await memory.retrieve(query, persona, 10) : []
      // Recent entries add cross-session candidates that lexical search on one message can miss.
      const recentEntries = memory.entries
        .filter(entry => entry.persona === persona && entry.kind !== 'profile')
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 6)
      const seen = new Set<string>()
      const candidates = [...retrieved, ...recentEntries].filter((entry) => {
        if (seen.has(entry.id))
          return false
        seen.add(entry.id)
        return true
      }).slice(0, 12)
      const existingText = candidates.length
        ? candidates.map(entry => `[${entry.id}]${entry.pinned ? ' (pinned)' : ''} ${entry.description}: ${entry.body.slice(0, 240)}`).join('\n')
        : '(none)'
      const currentProfile = memory.profileFor(persona)?.body.trim() || '(none)'
      const prompt = [
        ...(background.length
          ? ['Background (context only, never extract from here):', ...background.map(line => `${line.role === 'user' ? 'Owner' : 'Character'}: ${line.text}`), '']
          : []),
        'Transcript (extract only from the Owner lines):',
        ...transcript.map(line => `${line.role === 'user' ? 'Owner' : 'Character'}: ${line.text}`),
        '',
        'Current profile:',
        currentProfile,
        '',
        'Existing related memories:',
        existingText,
      ].join('\n')

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let raw = ''
      try {
        const conversation: Conversation = {
          turns: [
            {
              id: 'memory-formation-system',
              type: 'system',
              authority: 'system',
              content: [{ type: 'text', text: FORMATION_SYSTEM_PROMPT }],
            },
            {
              id: 'memory-formation-user',
              type: 'user',
              content: [{ type: 'text', text: prompt }],
            },
          ],
        }
        raw = await generateText({ providerId, model })(conversation, controller.signal)
      }
      finally {
        clearTimeout(timeout)
      }

      const parsedJson = parseJsonObject(raw)
      const parsed = parsedJson ? safeParse(formationSchema, parsedJson) : undefined
      if (!parsed?.success) {
        console.warn('[memory] The formation pass returned no usable JSON:', raw.slice(0, 200))
        return false
      }

      await applyProfile(parsed.output.profile, persona)
      const items = (parsed.output.memories ?? []).slice(0, MAX_MEMORIES_PER_PASS)
      for (const item of items) {
        if ((item.kind as string | undefined) === 'profile')
          continue
        await applyMemory(item, persona, sessionId)
      }

      const lastMessage = messages.slice(start, end).reverse().find(message => message.role === 'user' || message.role === 'assistant')
      writeCursor(sessionId, lastMessage?.id)
      return true
    }
    catch (error) {
      console.warn('[memory] The formation pass failed:', errorMessageFrom(error))
      return false
    }
  }

  /**
   * Runs one pass under a cross-window lock. Two Electron windows can hold the same session, and the second pass must
   * see the cursor that the first one wrote instead of extracting the same turns again.
   */
  async function run(payload: FormationPayload) {
    const { sessionId } = payload
    if (running.has(sessionId))
      return
    running.add(sessionId)
    try {
      if (navigator.locks?.request)
        await navigator.locks.request(`airi:memory-formation:${sessionId}`, () => runOnce(payload))
      else
        await runOnce(payload)
    }
    finally {
      running.delete(sessionId)
    }
  }

  /** Accepts a finished turn and forms memories for it in the background. */
  function afterTurn(payload: FormationPayload) {
    if (!memory.enabled || !memory.autoFormation)
      return
    if (payload.messages.length < 2)
      return

    void run(payload)
  }

  const syncing = ref(false)
  let syncCancelled = false

  /** Stops the manual sync after the model call that is already running. */
  function cancelSync() {
    syncCancelled = true
  }

  /**
   * Turns older conversations into memories in bounded chunks. It resumes from each session's cursor, so a stopped
   * or failed run continues where it left off, and the per-turn pass never reads the same messages again.
   */
  async function syncHistory(
    sessions: readonly MemorySyncSession[],
    onProgress?: (progress: MemorySyncProgress) => void,
  ): Promise<MemorySyncResult> {
    if (syncing.value || !memory.enabled)
      return { calls: 0, sessions: 0, stopped: false }

    syncing.value = true
    syncCancelled = false
    let calls = 0
    let processedSessions = 0
    let stopped = false

    try {
      for (const session of sessions) {
        if (syncCancelled || calls >= SYNC_MAX_CALLS) {
          stopped = true
          break
        }
        if (session.messages.length < 2)
          continue

        const cursor = readCursor(session.sessionId)
        const cursorIndex = cursor ? session.messages.findIndex(message => message.id === cursor) : -1
        let start = cursorIndex >= 0 ? cursorIndex + 1 : 0
        let processed = false

        while (start < session.messages.length) {
          if (syncCancelled || calls >= SYNC_MAX_CALLS) {
            stopped = true
            break
          }
          const end = Math.min(session.messages.length, start + SYNC_CHUNK_MESSAGES)
          const ok = await runOnce(session, { start, end })
          calls++
          onProgress?.({ calls, sessions: processedSessions })
          if (!ok) {
            stopped = true
            break
          }
          processed = true
          start = end
        }

        if (processed)
          processedSessions++
        if (stopped)
          break
      }
    }
    finally {
      syncing.value = false
    }

    return { calls, sessions: processedSessions, stopped }
  }

  return {
    afterTurn,
    syncing,
    syncHistory,
    cancelSync,
  }
})
