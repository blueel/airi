import type { InferOutput } from 'valibot'

import { array, boolean, looseObject, number, optional, picklist, safeParse, string } from 'valibot'

/**
 * The task states that Mika reports through its remote task API.
 *
 * `waiting_for_answer` and `waiting_on_phone` need a person. A caller must stop
 * waiting at these states and either answer the question or ask the owner to
 * finish the step on the phone.
 */
export type MikaTaskStatus
  = | 'starting'
    | 'running'
    | 'queued'
    | 'paused'
    | 'waiting_for_answer'
    | 'waiting_on_phone'
    | 'done'
    | 'failed'
    | 'cancelled'

export type MikaHttpMethod = 'GET' | 'POST'

/** One HTTP request that a platform transport sends on behalf of the client. */
export interface MikaHttpRequest {
  url: string
  method: MikaHttpMethod
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export interface MikaHttpResponse {
  status: number
  headers?: Record<string, string>
  body: string
}

/**
 * Sends one HTTP request from the platform layer.
 *
 * The Android transport is native OkHttp. A WebView fetch cannot be used,
 * because Mika rejects every request that carries an `Origin` header, and a
 * cross-origin WebView fetch always adds one.
 */
export type MikaTransport = (request: MikaHttpRequest) => Promise<MikaHttpResponse>

export interface MikaClientOptions {
  /** The server root, for example `http://127.0.0.1:8765`, or its `/api/v1` address. */
  baseUrl: string
  /** The access token that Mika shows in its computer connection settings. */
  token: string
  transport: MikaTransport
}

export interface MikaTask {
  taskId: string
  status: MikaTaskStatus
  conversation?: string
  goal?: string
  startedAtMs?: number
  step?: number
  /** The latest narration or reason that Mika reports while it works. */
  progress?: string
  waitingFor?: string
  /** A hint from Mika, such as the instruction to finish a step on the phone. */
  note?: string
  question?: string
  options?: string[]
  answer?: string
  verified?: boolean
  verificationNote?: string
  unconfirmed?: string[]
  reason?: string
  failureKind?: string
  answerable: boolean
}

export interface MikaServerInfo {
  apiVersion?: number
  serverVersion?: string
  capabilities: string[]
  limits?: {
    maxWaitSeconds?: number
    maxGoalLength?: number
    maxAnswerLength?: number
    maxSteerLength?: number
  }
}

export interface MikaWaitResult {
  task: MikaTask
  /** Whether the task changed during this wait. */
  changed: boolean
}

export interface MikaRunOptions {
  /** The soft deadline for the whole run. Defaults to 120 seconds. */
  timeoutMs?: number
  /** The longest single wait. Mika accepts 1 to 50 seconds. Defaults to 30. */
  waitSeconds?: number
  /** Groups tasks that share context inside Mika. */
  conversation?: string
  /** A UUID that makes task creation idempotent after a lost response. */
  requestId?: string
  /** Called with the first snapshot and after every wait that changes it. */
  onProgress?: (task: MikaTask) => void
}

export interface MikaRunResult {
  task: MikaTask
  /** True when the run stopped before a terminal state, for example at a deadline. */
  pending: boolean
}

/** An error response from Mika, or a response that does not match its contract. */
export class MikaApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'MikaApiError'
    this.status = status
    this.code = code
  }
}

const taskStatuses = [
  'starting',
  'running',
  'queued',
  'paused',
  'waiting_for_answer',
  'waiting_on_phone',
  'done',
  'failed',
  'cancelled',
] as const

const taskSchema = looseObject({
  task_id: string(),
  status: picklist(taskStatuses),
  conversation: optional(string()),
  goal: optional(string()),
  started_at_ms: optional(number()),
  step: optional(number()),
  progress: optional(string()),
  waiting_for: optional(string()),
  note: optional(string()),
  question: optional(string()),
  options: optional(array(string())),
  answer: optional(string()),
  verified: optional(boolean()),
  verification_note: optional(string()),
  unconfirmed: optional(array(string())),
  reason: optional(string()),
  failure_kind: optional(string()),
  answerable: optional(boolean()),
})

// `wait` adds `changed` to the task snapshot.
const waitSchema = looseObject({
  ...taskSchema.entries,
  changed: optional(boolean()),
})

const answerSchema = looseObject({
  task_id: string(),
  accepted: optional(boolean()),
})

const steerSchema = looseObject({
  task_id: string(),
  message_id: optional(string()),
  accepted: optional(boolean()),
})

const cancelSchema = looseObject({
  task_id: string(),
  accepted: optional(boolean()),
})

const serverInfoSchema = looseObject({
  api_version: optional(number()),
  server_version: optional(string()),
  capabilities: optional(array(string())),
  limits: optional(looseObject({
    max_wait_s: optional(number()),
    max_goal: optional(number()),
    max_answer: optional(number()),
    max_steer: optional(number()),
  })),
})

const errorSchema = looseObject({
  error: looseObject({
    code: optional(string()),
    message: optional(string()),
  }),
})

function taskFrom(raw: InferOutput<typeof taskSchema>): MikaTask {
  return {
    taskId: raw.task_id,
    status: raw.status,
    conversation: raw.conversation,
    goal: raw.goal,
    startedAtMs: raw.started_at_ms,
    step: raw.step,
    progress: raw.progress,
    waitingFor: raw.waiting_for,
    note: raw.note,
    question: raw.question,
    options: raw.options,
    answer: raw.answer,
    verified: raw.verified,
    verificationNote: raw.verification_note,
    unconfirmed: raw.unconfirmed,
    reason: raw.reason,
    failureKind: raw.failure_kind,
    answerable: raw.answerable ?? false,
  }
}

function serverInfoFrom(raw: InferOutput<typeof serverInfoSchema>): MikaServerInfo {
  return {
    apiVersion: raw.api_version,
    serverVersion: raw.server_version,
    capabilities: raw.capabilities ?? [],
    limits: raw.limits
      ? {
          maxWaitSeconds: raw.limits.max_wait_s,
          maxGoalLength: raw.limits.max_goal,
          maxAnswerLength: raw.limits.max_answer,
          maxSteerLength: raw.limits.max_steer,
        }
      : undefined,
  }
}

/**
 * Normalizes a user-entered Mika address to its `/api/v1` root.
 *
 * Mika documents the computer connection address as the server root or its
 * `/api/v1` path, and explicitly not the `/mcp` path. Pasting the MCP address is
 * a common mistake, so this function drops that suffix instead of failing.
 *
 * @example
 * normalizeMikaBaseUrl('http://127.0.0.1:8765/mcp')
 * // => 'http://127.0.0.1:8765/api/v1'
 */
export function normalizeMikaBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed)
    throw new Error('The Mika address is empty.')

  let url: URL
  try {
    url = new URL(trimmed)
  }
  catch {
    throw new Error('The Mika address is not a valid URL.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The Mika address must use HTTP or HTTPS.')

  if (url.username || url.password)
    throw new Error('Remove the credentials from the Mika address. Use the token field instead.')

  url.hash = ''
  url.search = ''

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/mcp'))
    path = path.slice(0, -'/mcp'.length)

  if (!path.endsWith('/api/v1'))
    path = `${path}/api/v1`

  url.pathname = path
  return url.toString().replace(/\/+$/, '')
}

const conversationPattern = /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Whether a string is a conversation id that Mika created.
 *
 * Mika rejects every other value, including ids that a caller invents.
 */
export function isMikaConversationId(value: string | undefined): value is string {
  return value !== undefined && conversationPattern.test(value)
}

export function isTerminalMikaStatus(status: MikaTaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/** Whether the task stops until a person answers a question or acts on the phone. */
export function needsUserActionMikaStatus(status: MikaTaskStatus): boolean {
  return status === 'waiting_for_answer' || status === 'waiting_on_phone'
}

/**
 * Builds a compact text summary of a task for a model turn.
 *
 * The summary keeps the task id last, so a model that decides to continue the
 * task can copy the id from the end of the tool result.
 */
export function describeMikaTask(task: MikaTask): string {
  const lines = [`Status: ${task.status}`]

  if (task.goal)
    lines.push(`Goal: ${task.goal}`)
  if (task.step !== undefined)
    lines.push(`Step: ${task.step}`)
  if (task.progress)
    lines.push(`Progress: ${task.progress}`)

  if (task.question) {
    lines.push(`Mika asks: ${task.question}`)
    if (task.options?.length)
      lines.push(`Options: ${task.options.join(', ')}`)
  }

  if (task.status === 'waiting_on_phone')
    lines.push(task.note ?? 'Finish this step on the phone.')
  else if (task.note)
    lines.push(`Note: ${task.note}`)

  if (task.answer)
    lines.push(`Answer: ${task.answer}`)
  if (task.verified !== undefined)
    lines.push(`Verified: ${task.verified ? 'yes' : 'no'}`)
  if (task.verificationNote)
    lines.push(`Verification: ${task.verificationNote}`)
  if (task.unconfirmed?.length)
    lines.push(`Unconfirmed: ${task.unconfirmed.join(', ')}`)
  if (task.reason)
    lines.push(`Reason: ${task.reason}`)
  if (task.failureKind)
    lines.push(`Failure kind: ${task.failureKind}`)

  lines.push(`Task id: ${task.taskId}`)
  return lines.join('\n')
}

/**
 * A client for Mika's plain HTTP task API.
 *
 * The client keeps no task state. Each method reads or changes one task on the
 * phone, and the caller decides how long to wait and what to do next.
 */
export class MikaClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly transport: MikaTransport

  constructor(options: MikaClientOptions) {
    this.baseUrl = normalizeMikaBaseUrl(options.baseUrl)
    this.token = options.token.trim()
    this.transport = options.transport
  }

  /** Reads the API version, the server version, and the supported capabilities. */
  async getServerInfo(): Promise<MikaServerInfo> {
    const { status, body } = await this.requestJson('GET', '', undefined, 15_000)
    const parsed = safeParse(serverInfoSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected server description.', status)
    return serverInfoFrom(parsed.output)
  }

  async createTask(goal: string, options?: { conversation?: string, requestId?: string }): Promise<MikaTask> {
    if (options?.conversation && !isMikaConversationId(options.conversation))
      throw new Error('The conversation id must come from an earlier Mika task.')

    const { status, body } = await this.requestJson('POST', '/tasks', {
      goal,
      ...(options?.conversation ? { conversation: options.conversation } : {}),
      ...(options?.requestId ? { request_id: options.requestId } : {}),
    }, 30_000)

    const parsed = safeParse(taskSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected task response.', status)
    return taskFrom(parsed.output)
  }

  async getTask(taskId: string): Promise<MikaTask> {
    const { status, body } = await this.requestJson('GET', `/tasks/${encodeURIComponent(taskId)}`, undefined, 15_000)
    const parsed = safeParse(taskSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected task response.', status)
    return taskFrom(parsed.output)
  }

  /** Waits for a change or for the timeout. Mika accepts 1 to 50 seconds. */
  async waitTask(taskId: string, timeoutSeconds: number): Promise<MikaWaitResult> {
    const timeout = Math.max(1, Math.min(50, Math.round(timeoutSeconds)))
    const { status, body } = await this.requestJson(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/wait`,
      { timeout_s: timeout },
      // The wait itself can use 50 seconds, so the transport needs a longer deadline.
      (timeout + 10) * 1000,
    )

    const parsed = safeParse(waitSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected task response.', status)
    return { task: taskFrom(parsed.output), changed: parsed.output.changed ?? false }
  }

  async answerTask(taskId: string, text: string): Promise<boolean> {
    const { status, body } = await this.requestJson(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/answer`,
      { text },
      20_000,
    )
    const parsed = safeParse(answerSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected answer response.', status)
    return parsed.output.accepted ?? true
  }

  async steerTask(taskId: string, text: string): Promise<boolean> {
    const { status, body } = await this.requestJson(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/steer`,
      { text },
      20_000,
    )
    const parsed = safeParse(steerSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected steering response.', status)
    return parsed.output.accepted ?? true
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const { status, body } = await this.requestJson(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
      20_000,
    )
    const parsed = safeParse(cancelSchema, body)
    if (!parsed.success)
      throw new MikaApiError('Mika returned an unexpected cancellation response.', status)
    return parsed.output.accepted ?? true
  }

  /**
   * Starts a task and waits until it ends, needs a person, or reaches the
   * soft deadline.
   *
   * A task that asks a question or waits for the phone stops the loop, because
   * no amount of waiting can move it. The result is still `pending`, and its
   * status tells the caller which action it needs.
   */
  async runTask(goal: string, options?: MikaRunOptions): Promise<MikaRunResult> {
    const timeoutMs = options?.timeoutMs ?? 120_000
    const waitSeconds = Math.max(1, Math.min(50, options?.waitSeconds ?? 30))
    const deadline = Date.now() + timeoutMs

    let task = await this.createTask(goal, {
      conversation: options?.conversation,
      requestId: options?.requestId,
    })
    options?.onProgress?.(task)

    while (!isTerminalMikaStatus(task.status) && !needsUserActionMikaStatus(task.status) && Date.now() < deadline) {
      const remainingSeconds = Math.ceil((deadline - Date.now()) / 1000)
      const slice = Math.max(1, Math.min(waitSeconds, remainingSeconds))
      const result = await this.waitTask(task.taskId, slice)
      task = result.task
      options?.onProgress?.(task)
    }

    return { task, pending: !isTerminalMikaStatus(task.status) }
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (hasBody)
      headers['Content-Type'] = 'application/json'
    if (this.token)
      headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  private async requestJson(
    method: MikaHttpMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<{ status: number, body: unknown }> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const response = await this.transport({
      url: `${this.baseUrl}${path}`,
      method,
      headers: this.headers(payload !== undefined),
      body: payload,
      timeoutMs,
    })

    let parsed: unknown
    try {
      parsed = response.body ? JSON.parse(response.body) : {}
    }
    catch {
      throw new MikaApiError('Mika returned a response that is not JSON.', response.status)
    }

    if (response.status < 200 || response.status >= 300) {
      const error = safeParse(errorSchema, parsed)
      const code = error.success ? error.output.error.code : undefined
      const message = error.success ? error.output.error.message : undefined
      throw new MikaApiError(message ?? `Mika request failed with HTTP ${response.status}.`, response.status, code)
    }

    return { status: response.status, body: parsed }
  }
}
