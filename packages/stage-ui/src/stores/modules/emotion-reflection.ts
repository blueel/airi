import type { Conversation } from '@proj-airi/core-agent'

import type { ChatHistoryItem } from '../../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { REFLECTION_MAX_INSIGHTS, REFLECTION_RETRY_MS, reflectionDue } from '@proj-airi/stage-shared/emotion'
import { containsLikelySecret } from '@proj-airi/stage-shared/memory-secret'
import { defineStore } from 'pinia'
import { array, maxValue, minValue, number, optional, pipe, safeParse, strictObject, string } from 'valibot'

import { useTextGeneration } from '../../composables/text-generation'
import { extractMessageText } from '../../libs/chat-sync'
import { useMemoryStore } from '../memory'
import { useEmotionStateStore } from './emotion-state'

const LAST_ATTEMPT_KEY = 'emotion/reflection/last-attempt'
const REQUEST_TIMEOUT_MS = 60_000
const MAX_TRANSCRIPT_CHARS = 6_000
const MAX_TRANSCRIPT_MESSAGES = 12
const INSIGHT_IMPORTANCE = 4

const reflectionSchema = strictObject({
  insights: optional(array(string())),
  moodAdjustment: optional(strictObject({
    affection: optional(pipe(number(), minValue(-10), maxValue(10))),
    energy: optional(pipe(number(), minValue(-10), maxValue(10))),
  })),
})

interface ReflectionPayload {
  sessionId: string
  persona: string
  providerId: string
  model: string
  messages: ChatHistoryItem[]
}

const REFLECTION_SYSTEM_PROMPT = [
  'You reflect on a conversation for a companion character.',
  'Return JSON only, without markdown fences and without commentary.',
  'Shape:',
  '{"insights":["one lasting observation"],"moodAdjustment":{"affection":-2,"energy":1}}',
  'Rules:',
  '- Write at most 3 insights. Each insight is one sentence about the owner, the relationship, or what the character learned.',
  '- Skip greetings, small talk, the assistant wording, and anything that the transcript already makes obvious.',
  '- Never write passwords, API keys, bank or identity numbers, or other secrets.',
  '- moodAdjustment is optional. Use a small number between -10 and 10 for affection or energy.',
  '- An empty insights array is a valid answer.',
].join('\n')

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

function trimTranscript(messages: ChatHistoryItem[]) {
  const lines: Array<{ role: 'Owner' | 'Character', text: string }> = []
  let chars = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user' && message.role !== 'assistant')
      continue
    // A notice is not owner speech. A reflection reads what the owner said, not the application's own prompts.
    if (message.role === 'user' && message.notice)
      continue

    const text = extractMessageText(message).trim()
    if (!text)
      continue
    if (lines.length >= MAX_TRANSCRIPT_MESSAGES || chars + text.length > MAX_TRANSCRIPT_CHARS)
      break

    lines.unshift({ role: message.role === 'user' ? 'Owner' : 'Character', text })
    chars += text.length
  }
  return lines
}

/**
 * Runs one background reflection after enough important events collected. It turns the recent conversation and the
 * current emotion into a few lasting insights on the card's memory, and a small mood change. A failure keeps the
 * ledger, so the next turn can try again after a quiet period.
 *
 * Use when:
 * - A finished owner turn may have crossed the importance threshold.
 *
 * Expects:
 * - Memory is on. A reflection is an extra model call and never blocks the reply.
 * - Two windows that cross the threshold together run one pass, because a Web Lock serializes them.
 */
export const useEmotionReflectionStore = defineStore('emotion-reflection', () => {
  const memory = useMemoryStore()
  const emotion = useEmotionStateStore()
  const { generateText } = useTextGeneration()
  const lastAttemptAt = useLocalStorageManualReset<number>(LAST_ATTEMPT_KEY, 0)

  let running = false

  async function runOnce(payload: ReflectionPayload) {
    // Another window may have finished the pass while this one waited for the lock.
    if (!reflectionDue(emotion.ledger))
      return

    const transcript = trimTranscript(payload.messages)
    if (transcript.length < 2)
      return

    const snapshot = emotion.snapshot()
    const prompt = [
      'Recent conversation:',
      ...transcript.map(line => `${line.role}: ${line.text}`),
      '',
      'Current state:',
      `Feeling: ${snapshot.emotion} (${Math.round(snapshot.intensity * 100)}%). Affection: ${Math.round(snapshot.affection)}/100. Energy: ${Math.round(snapshot.energy)}/100.`,
    ].join('\n')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let raw = ''
    try {
      const conversation: Conversation = {
        turns: [
          {
            id: 'emotion-reflection-system',
            type: 'system',
            authority: 'system',
            content: [{ type: 'text', text: REFLECTION_SYSTEM_PROMPT }],
          },
          {
            id: 'emotion-reflection-user',
            type: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      }
      raw = await generateText({ providerId: payload.providerId, model: payload.model })(conversation, controller.signal)
    }
    finally {
      clearTimeout(timeout)
    }

    const parsedJson = parseJsonObject(raw)
    const parsed = parsedJson ? safeParse(reflectionSchema, parsedJson) : undefined
    if (!parsed?.success) {
      console.warn('[emotion] The reflection pass returned no usable JSON:', raw.slice(0, 200))
      return
    }

    const insights = (parsed.output.insights ?? [])
      .map(insight => insight.trim())
      .filter(Boolean)
      .filter((insight) => {
        if (!containsLikelySecret(insight))
          return true
        console.warn('[emotion] Skipped a reflection that looks like it contains a secret.')
        return false
      })
      .slice(0, REFLECTION_MAX_INSIGHTS)

    for (const insight of insights) {
      await memory.write({
        description: insight.slice(0, 150),
        body: insight,
        kind: 'episode',
        importance: INSIGHT_IMPORTANCE,
        source: 'reflection',
        sourceSessionId: payload.sessionId,
      }, payload.persona)
    }

    const adjustment = parsed.output.moodAdjustment
    if (adjustment)
      emotion.adjustMood({ affection: adjustment.affection, energy: adjustment.energy })

    emotion.resetLedger()
  }

  /**
   * Runs one pass when the ledger is full. Resolves when the pass ends, or at once when nothing is due.
   * A caller must not await it on the chat path.
   */
  async function maybeReflect(payload: ReflectionPayload): Promise<void> {
    if (!memory.enabled)
      return
    if (!reflectionDue(emotion.ledger))
      return
    if (Date.now() - lastAttemptAt.value < REFLECTION_RETRY_MS)
      return
    if (running)
      return

    running = true
    try {
      if (navigator.locks?.request)
        await navigator.locks.request('airi:emotion-reflection', () => runOnce(payload))
      else
        await runOnce(payload)
    }
    catch (error) {
      console.warn('[emotion] The reflection pass failed:', errorMessageFrom(error))
    }
    finally {
      running = false
      lastAttemptAt.value = Date.now()
    }
  }

  function resetState() {
    lastAttemptAt.reset()
  }

  return {
    maybeReflect,
    resetState,
  }
})
