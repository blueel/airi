import type { MikaApiError, MikaHttpRequest, MikaHttpResponse } from './index'

import { describe, expect, it, vi } from 'vitest'

import { describeMikaTask, isMikaConversationId, MikaClient, normalizeMikaBaseUrl } from './index'

function response(status: number, value: unknown): MikaHttpResponse {
  return { status, body: JSON.stringify(value) }
}

function createTransport(responses: MikaHttpResponse[]) {
  const requests: MikaHttpRequest[] = []
  const transport = vi.fn(async (request: MikaHttpRequest) => {
    requests.push(request)
    const next = responses.shift()
    if (!next)
      throw new Error('The test queued no response for this request.')
    return next
  })
  return { requests, transport }
}

function createClient(responses: MikaHttpResponse[]) {
  const { requests, transport } = createTransport(responses)
  const client = new MikaClient({
    baseUrl: 'http://127.0.0.1:8765',
    token: 'secret',
    transport,
  })
  return { client, requests, transport }
}

describe('normalizeMikaBaseUrl', () => {
  it('appends the API path to a server root', () => {
    expect(normalizeMikaBaseUrl('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765/api/v1')
    expect(normalizeMikaBaseUrl('http://127.0.0.1:8765/')).toBe('http://127.0.0.1:8765/api/v1')
  })

  it('keeps an API path that is already present', () => {
    expect(normalizeMikaBaseUrl('http://127.0.0.1:8765/api/v1')).toBe('http://127.0.0.1:8765/api/v1')
    expect(normalizeMikaBaseUrl('http://127.0.0.1:8765/api/v1/')).toBe('http://127.0.0.1:8765/api/v1')
  })

  it('drops the MCP path that Mika tells users not to paste', () => {
    expect(normalizeMikaBaseUrl('http://127.0.0.1:8765/mcp')).toBe('http://127.0.0.1:8765/api/v1')
  })

  it('rejects a non-HTTP address', () => {
    expect(() => normalizeMikaBaseUrl('ftp://127.0.0.1:8765')).toThrow('HTTP or HTTPS')
  })

  it('rejects embedded credentials', () => {
    expect(() => normalizeMikaBaseUrl('http://user:pass@127.0.0.1:8765')).toThrow('Remove the credentials')
  })

  it('rejects an empty address', () => {
    expect(() => normalizeMikaBaseUrl('   ')).toThrow('empty')
  })
})

describe('isMikaConversationId', () => {
  it('accepts a conversation id that Mika created', () => {
    expect(isMikaConversationId('mcp-123e4567-e89b-42d3-a456-426614174000')).toBe(true)
  })

  it('rejects an invented id', () => {
    expect(isMikaConversationId('airi-123e4567-e89b-42d3-a456-426614174000')).toBe(false)
    expect(isMikaConversationId('mcp-123E4567-E89B-42D3-A456-426614174000')).toBe(false)
    expect(isMikaConversationId(undefined)).toBe(false)
  })
})

describe('mikaClient', () => {
  it('creates a task without an Origin header', async () => {
    const conversation = 'mcp-123e4567-e89b-42d3-a456-426614174000'
    const { client, requests } = createClient([
      response(201, {
        task_id: 'task-1',
        status: 'starting',
        goal: 'Open Settings',
        conversation,
        answerable: false,
      }),
    ])

    const task = await client.createTask('Open Settings', { conversation })

    expect(task.taskId).toBe('task-1')
    expect(task.status).toBe('starting')
    expect(requests[0]?.url).toBe('http://127.0.0.1:8765/api/v1/tasks')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers).toMatchObject({
      'Accept': 'application/json',
      'Authorization': 'Bearer secret',
      'Content-Type': 'application/json',
    })
    expect(requests[0]?.headers.origin).toBeUndefined()
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      goal: 'Open Settings',
      conversation,
    })
  })

  it('rejects a conversation id that Mika did not create', async () => {
    const { client, requests } = createClient([])

    await expect(client.createTask('Open Settings', { conversation: 'airi-task' }))
      .rejects
      .toThrow('earlier Mika task')

    expect(requests).toHaveLength(0)
  })

  it('clamps a wait to the range that Mika accepts', async () => {
    const { client, requests } = createClient([
      response(200, { task_id: 'task-1', status: 'running', changed: false, answerable: false }),
    ])

    await client.waitTask('task-1', 99)

    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ timeout_s: 50 })
    expect(requests[0]?.timeoutMs).toBe(60_000)
  })

  it('maps an API error to a typed error', async () => {
    const { client } = createClient([
      response(403, { error: { code: 'access_denied', message: 'Browser requests are not allowed' } }),
    ])

    await expect(client.getServerInfo()).rejects.toMatchObject({
      name: 'MikaApiError',
      status: 403,
      code: 'access_denied',
      message: 'Browser requests are not allowed',
    } satisfies Partial<MikaApiError>)
  })

  it('stops a run when Mika asks a question', async () => {
    const { client, requests } = createClient([
      response(201, { task_id: 'task-1', status: 'running', answerable: false }),
      response(200, {
        task_id: 'task-1',
        status: 'waiting_for_answer',
        question: 'Which account?',
        options: ['Personal', 'Work'],
        answerable: true,
        changed: true,
      }),
    ])

    const result = await client.runTask('Send a message')

    expect(result.pending).toBe(true)
    expect(result.task.status).toBe('waiting_for_answer')
    expect(result.task.question).toBe('Which account?')
    expect(requests).toHaveLength(2)
  })

  it('stops a run at a terminal state', async () => {
    const { client } = createClient([
      response(201, { task_id: 'task-1', status: 'running', answerable: false }),
      response(200, {
        task_id: 'task-1',
        status: 'done',
        answer: 'The message was sent.',
        verified: true,
        answerable: false,
        changed: true,
      }),
    ])

    const result = await client.runTask('Send a message')

    expect(result.pending).toBe(false)
    expect(result.task.status).toBe('done')
    expect(result.task.answer).toBe('The message was sent.')
    expect(result.task.verified).toBe(true)
  })

  it('returns a pending result at the run deadline', async () => {
    const { client, requests } = createClient([
      response(201, { task_id: 'task-1', status: 'running', answerable: false }),
    ])

    const result = await client.runTask('Send a message', { timeoutMs: 0 })

    expect(result.pending).toBe(true)
    expect(result.task.status).toBe('running')
    expect(requests).toHaveLength(1)
  })
})

describe('describeMikaTask', () => {
  it('keeps the task id in the last line', () => {
    const text = describeMikaTask({
      taskId: 'task-1',
      status: 'waiting_for_answer',
      goal: 'Send a message',
      question: 'Which account?',
      options: ['Personal', 'Work'],
      answerable: true,
    })

    expect(text).toContain('Mika asks: Which account?')
    expect(text).toContain('Options: Personal, Work')
    expect(text.endsWith('Task id: task-1')).toBe(true)
  })
})
