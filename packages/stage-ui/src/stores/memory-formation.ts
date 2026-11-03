import type { Conversation } from '@proj-airi/core-agent'
import type { InferOutput } from 'valibot'

import type { ChatHistoryItem } from '../types/chat'
import type { MemoryKind } from '../types/memory'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { containsLikelySecret } from '@proj-airi/stage-shared/memory-secret'
import { defineStore } from 'pinia'
import { array, number, optional, picklist, safeParse, strictObject, string } from 'valibot'

import { useTextGeneration } from '../composables/text-generation'
import { useMemoryStore } from './memory'

const CURSOR_PREFIX = 'memory/formation/cursor/'
const IDLE_DELAY_MS = 25_000
const REQUEST_TIMEOUT_MS = 60_000
const MAX_TRANSCRIPT_CHARS = 6_000
const MAX_MEMORIES_PER_PASS = 8

const formationSchema = strictObject({
  profile: optional(string()),
  memories: optional(array(strictObject({
    action: picklist(['add', 'update', 'delete']),
    id: optional(string()),
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

const FORMATION_SYSTEM_PROMPT = [
  'You maintain long-term memory for a companion character.',
  'Return JSON only, without markdown fences and without commentary.',
  'Shape:',
  '{"profile":"optional updated profile","memories":[{"action":"add|update|delete","id":"existing id for update or delete","kind":"fact|episode","description":"one line, at most 150 characters","body":"the fact, at most 2000 characters","importance":1}]}',
  'Rules:',
  '- Save durable facts, preferences, relationships, plans, and promises. Skip greetings, small talk, and the assistant wording.',
  '- Never save passwords, API keys, bank or identity numbers, or other secrets.',
  '- One fact per entry. Use action update with the existing id when a new fact replaces an old one.',
  '- Use action delete only when the owner retracts or corrects a memory.',
  '- Add at most one kind episode entry when the segment contains a meaningful event, decision, or shared experience.',
  '- Update profile only when the owner reveals stable identity, language, work, relationships, or lasting preferences. Keep it under 800 characters.',
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
  const interval = useLocalStorageManualReset<number>('memory/formation/interval', 3)

  const counters = new Map<string, number>()
  const lastPayload = new Map<string, FormationPayload>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()

  function clearTimer(sessionId: string) {
    const timer = timers.get(sessionId)
    if (timer)
      clearTimeout(timer)
    timers.delete(sessionId)
  }

  function schedule(sessionId: string) {
    clearTimer(sessionId)
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId)
      const payload = lastPayload.get(sessionId)
      if (payload)
        void run(payload)
    }, IDLE_DELAY_MS))
  }

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
      body: body.slice(0, 800),
      kind: 'profile',
      pinned: true,
      importance: 5,
      source: 'auto',
    }, persona)
  }

  async function applyMemory(item: FormationMemory, persona: string, sessionId: string) {
    if (item.action === 'delete') {
      if (item.id)
        await memory.forget(item.id, persona)
      return
    }

    if (item.action === 'update') {
      if (!item.id)
        return
      const existing = memory.read(item.id, persona)
      // The background pass can change only this card's entries. General memories belong to the owner.
      if (!existing || existing.persona !== persona)
        return
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

  async function runOnce(payload: FormationPayload) {
    const { sessionId, persona, providerId, model, messages } = payload
    clearTimer(sessionId)

    const cursor = readCursor(sessionId)
    const cursorIndex = cursor ? messages.findIndex(message => message.id === cursor) : -1
    const start = cursorIndex >= 0 ? cursorIndex + 1 : Math.max(0, messages.length - 12)
    const recent = messages.slice(start)
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({ role: message.role, text: textOf(message) }))
      .filter(line => line.text.trim().length > 0)

    if (recent.length < 2)
      return

    const transcript = trimTranscript(recent)
    const lastUser = transcript.findLast(line => line.role === 'user')
    if (!lastUser)
      return

    try {
      const existing = await memory.retrieve(lastUser.text, persona, 8)
      const existingText = existing.length
        ? existing.map(entry => `[${entry.id}] ${entry.description}: ${entry.body.slice(0, 300)}`).join('\n')
        : '(none)'
      const currentProfile = memory.profileFor(persona)?.body.trim() || '(none)'
      const prompt = [
        'Transcript:',
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
        return
      }

      await applyProfile(parsed.output.profile, persona)
      const items = (parsed.output.memories ?? []).slice(0, MAX_MEMORIES_PER_PASS)
      for (const item of items) {
        if ((item.kind as string | undefined) === 'profile')
          continue
        await applyMemory(item, persona, sessionId)
      }

      const lastMessage = [...messages].reverse().find(message => message.role === 'user' || message.role === 'assistant')
      writeCursor(sessionId, lastMessage?.id)
      counters.set(sessionId, 0)
    }
    catch (error) {
      console.warn('[memory] The formation pass failed:', errorMessageFrom(error))
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

  /** Accepts a finished turn. The pass runs after the interval, or after a short idle period. */
  function afterTurn(payload: FormationPayload) {
    if (!memory.enabled || !memory.autoFormation)
      return
    if (payload.messages.length < 2)
      return

    lastPayload.set(payload.sessionId, payload)
    const count = (counters.get(payload.sessionId) ?? 0) + 1
    counters.set(payload.sessionId, count)

    if (count >= Math.max(1, interval.value))
      void run(payload)
    else
      schedule(payload.sessionId)
  }

  /** Runs the pending pass now. Tests and the Settings page use it. */
  function flush(sessionId: string) {
    const payload = lastPayload.get(sessionId)
    if (payload)
      return run(payload)
    return Promise.resolve()
  }

  return {
    interval,
    afterTurn,
    flush,
  }
})
