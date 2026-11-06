import type { MikaClient, MikaRunResult } from '@proj-airi/stage-shared/mika'
import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { Tool } from '@xsai/shared-chat'
import type { Pinia } from 'pinia'

import { errorMessageFrom } from '@moeru/std'
import { describeMikaTask, isTerminalMikaStatus, needsUserActionMikaStatus } from '@proj-airi/stage-shared/mika'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { TOOL_ICONS } from '@proj-airi/stage-ui/tools/icons'
import { watchDebounced } from '@vueuse/core'
import { rawTool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { description, maxLength, maxValue, minLength, minValue, number, optional, pipe, safeParse, strictObject, string } from 'valibot'
import { toJsonSchema } from 'xsschema'

import { isMikaSupported } from '../../modules/mika'
import { useMikaSettingsStore } from '../mika'

export const MIKA_RUN_TASK_TOOL_NAME = 'builtIn_mikaRunTask'
export const MIKA_TASK_STATUS_TOOL_NAME = 'builtIn_mikaTaskStatus'
export const MIKA_ANSWER_TASK_TOOL_NAME = 'builtIn_mikaAnswerTask'
export const MIKA_STEER_TASK_TOOL_NAME = 'builtIn_mikaSteerTask'
export const MIKA_CANCEL_TASK_TOOL_NAME = 'builtIn_mikaCancelTask'

const goalSchema = pipe(
  string(),
  minLength(1),
  maxLength(2000),
  description('What the owner wants to happen, in the owner\'s words. Name the app or the website when it is known.'),
)
const taskIdSchema = pipe(
  string(),
  minLength(1),
  description('The task id that a previous Mika tool result shows.'),
)
const messageSchema = pipe(
  string(),
  minLength(1),
  maxLength(4000),
  description('The text to send to Mika.'),
)
const waitSecondsSchema = optional(pipe(
  number(),
  minValue(1),
  maxValue(50),
  description('How long this call waits for an update, in seconds. Defaults to 20, and Mika accepts at most 50.'),
))

const runParameters = strictObject({
  goal: goalSchema,
  wait_seconds: waitSecondsSchema,
})
const statusParameters = strictObject({
  task_id: taskIdSchema,
  wait_seconds: waitSecondsSchema,
})
const answerParameters = strictObject({
  task_id: taskIdSchema,
  text: messageSchema,
})
const steerParameters = strictObject({
  task_id: taskIdSchema,
  text: messageSchema,
})
const cancelParameters = strictObject({
  task_id: taskIdSchema,
})

function failure(error: unknown) {
  return `Mika request failed: ${errorMessageFrom(error) ?? 'Unknown error.'}`
}

function formatRunResult(result: MikaRunResult) {
  const summary = describeMikaTask(result.task)

  if (result.task.status === 'waiting_for_answer')
    return `Mika asks a question. Relay it to the owner and send the answer with ${MIKA_ANSWER_TASK_TOOL_NAME}.\n${summary}`
  if (result.task.status === 'waiting_on_phone')
    return `The owner must finish this step on the phone. Tell them what Mika shows.\n${summary}`
  if (result.pending)
    return `Mika is still working. Check again with ${MIKA_TASK_STATUS_TOOL_NAME} before you report the outcome.\n${summary}`

  return summary
}

/**
 * Creates the Mika tools for one settings snapshot.
 *
 * The tools are thin adapters over {@link MikaClient}. A task that does not
 * finish within the tool call stays on the phone, and a later status call
 * continues from its id.
 */
export async function createMikaTools(
  client: MikaClient,
  options: {
    /** The conversation from an earlier task. Mika creates one on the first task. */
    getConversation: () => string | undefined
    /** Receives the conversation that Mika returns for a task. */
    onConversation: (id: string | undefined) => void
  },
): Promise<Tool[]> {
  return [
    rawTool({
      name: MIKA_RUN_TASK_TOOL_NAME,
      description: 'Start a task in another app on the owner\'s phone through Mika. Mika taps, types, and scrolls on a background screen. Use it when the owner asks you to act in an app or a website on the phone. Payment and confirmation steps stay on the phone.',
      parameters: await toJsonSchema(runParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(runParameters, rawInput)
        if (!parsed.success)
          return 'Give a goal for the phone task.'

        try {
          const result = await client.runTask(parsed.output.goal, {
            conversation: options.getConversation(),
            waitSeconds: parsed.output.wait_seconds,
            onProgress: task => options.onConversation(task.conversation),
          })
          return formatRunResult(result)
        }
        catch (error) {
          return failure(error)
        }
      },
    }),
    rawTool({
      name: MIKA_TASK_STATUS_TOOL_NAME,
      description: 'Read a Mika task that is still running, or wait for its next update. Call it after builtIn_mikaRunTask reports that Mika is still working.',
      parameters: await toJsonSchema(statusParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(statusParameters, rawInput)
        if (!parsed.success)
          return 'Give the task id that the previous Mika result shows.'

        try {
          const task = await client.getTask(parsed.output.task_id)
          // Mika's wait keeps polling while the state does not change, even at a state that needs a person.
          if (isTerminalMikaStatus(task.status) || needsUserActionMikaStatus(task.status))
            return describeMikaTask(task)

          const result = await client.waitTask(task.taskId, parsed.output.wait_seconds ?? 20)
          return describeMikaTask(result.task)
        }
        catch (error) {
          return failure(error)
        }
      },
    }),
    rawTool({
      name: MIKA_ANSWER_TASK_TOOL_NAME,
      description: 'Answer a question that a Mika task asks. Use it when a task status includes a question.',
      parameters: await toJsonSchema(answerParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(answerParameters, rawInput)
        if (!parsed.success)
          return 'Give the task id and the answer text.'

        try {
          return await client.answerTask(parsed.output.task_id, parsed.output.text)
            ? 'Answer sent to Mika.'
            : 'Mika did not accept the answer. Check the task status first.'
        }
        catch (error) {
          return failure(error)
        }
      },
    }),
    rawTool({
      name: MIKA_STEER_TASK_TOOL_NAME,
      description: 'Add a requirement to a running Mika task. Use it when the owner changes the goal while Mika works.',
      parameters: await toJsonSchema(steerParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(steerParameters, rawInput)
        if (!parsed.success)
          return 'Give the task id and the new requirement.'

        try {
          return await client.steerTask(parsed.output.task_id, parsed.output.text)
            ? 'Requirement sent to Mika.'
            : 'Mika did not accept the requirement. The task may have finished.'
        }
        catch (error) {
          return failure(error)
        }
      },
    }),
    rawTool({
      name: MIKA_CANCEL_TASK_TOOL_NAME,
      description: 'Cancel a Mika task that is running or queued.',
      parameters: await toJsonSchema(cancelParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(cancelParameters, rawInput)
        if (!parsed.success)
          return 'Give the task id to cancel.'

        try {
          return await client.cancelTask(parsed.output.task_id)
            ? 'Cancellation accepted.'
            : 'The task was already finished, so Mika cancelled nothing.'
        }
        catch (error) {
          return failure(error)
        }
      },
    }),
  ]
}

const toolIdPrefix = 'mika:'

/**
 * Registers the Mika tools in the shared tool registry.
 *
 * The registry is the only entry point that the chat uses, so registering here
 * makes the tools available to every conversation in this app. A settings
 * change re-registers them with the new client.
 */
export const useMikaToolsStore = defineStore('mika-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const settings = useMikaSettingsStore()

  let generation = 0

  // The tool registry persists its definitions, so a reload can leave Mika tools
  // from the previous settings. Always replace every tool with this prefix.
  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  async function refresh() {
    const current = ++generation

    try {
      const client = settings.createClient()
      if (!client) {
        llmToolsStore.removeToolsByIds(...registeredToolIds())
        return
      }

      const tools = await createMikaTools(client, {
        getConversation: () => settings.currentConversation(),
        onConversation: id => settings.rememberConversation(id),
      })
      if (current !== generation)
        return

      llmToolsStore.removeToolsByIds(...registeredToolIds())
      llmToolsStore.addTools(...tools.map(tool => ({
        ...tool,
        icon: TOOL_ICONS.phone,
        id: `${toolIdPrefix}${tool.function.name}`,
      } satisfies ExecutableTool)))
    }
    catch (error) {
      console.warn('Failed to register the Mika tools:', errorMessageFrom(error) ?? error)
    }
  }

  function dispose() {
    generation++
    llmToolsStore.removeToolsByIds(...registeredToolIds())
  }

  return {
    refresh,
    dispose,
  }
})

/**
 * Starts the Mika tool registration for the app lifetime.
 *
 * Only the Android build has the native transport, so every other platform
 * registers nothing.
 */
export function setupMikaTools(pinia: Pinia) {
  if (!isMikaSupported())
    return

  const tools = useMikaToolsStore(pinia)
  const settings = useMikaSettingsStore(pinia)

  watchDebounced(
    () => [settings.enabled, settings.baseUrl, settings.token].join('\u0000'),
    () => { void tools.refresh() },
    { debounce: 400, immediate: true },
  )
}
