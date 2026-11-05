import type { SpeechProvider } from '@xsai-ext/providers/utils'

import type { ProviderTranslator } from '../../../types'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { providerBreezeTts } from '.'

const translate: ProviderTranslator = key => key

afterEach(() => {
  vi.unstubAllGlobals()
})

async function createProvider(config: Parameters<typeof providerBreezeTts.createProvider>[0] = {}) {
  return await providerBreezeTts.createProvider(config) as SpeechProvider
}

describe('breeze-tts provider', () => {
  it('defaults to the tunneled server and its single model', async () => {
    const config = z.parse(await providerBreezeTts.createProviderConfig({ t: translate }), {})

    expect(config.baseUrl).toBe('http://airi.example/')
    expect(config.model).toBe('breeze-tts-2')
  })

  it('accepts a server root with or without the OpenAI /v1 suffix', async () => {
    const provider = await createProvider({ baseUrl: 'http://127.0.0.1:9310/v1' })

    expect(provider.speech('breeze-tts-2').baseURL).toBe('http://127.0.0.1:9310/v1/')
  })

  it('resolves a proxied path against the page origin', async () => {
    vi.stubGlobal('location', { origin: 'https://airi.example:9200' })
    const provider = await createProvider({ baseUrl: '/breeze-tts/' })

    expect(provider.speech('breeze-tts-2').baseURL).toBe('https://airi.example:9200/breeze-tts/v1/')
  })

  it('lists the voices the server reports', async () => {
    vi.stubGlobal('fetch', async (input: URL | RequestInfo) => {
      expect(String(input)).toBe('http://127.0.0.1:9310/v1/voices')
      return Response.json([
        { id: 'xiaoling', description: 'Cute soft voice', saved: true },
        { id: '   ', description: 'ignored' },
        { id: 3 },
      ])
    })

    const voices = await providerBreezeTts.extraMethods?.listVoices?.(
      { baseUrl: 'http://127.0.0.1:9310/', model: 'breeze-tts-2', instructions: '' },
      {} as never,
    )

    expect(voices).toEqual([{
      id: 'xiaoling',
      name: 'xiaoling',
      provider: 'breeze-tts',
      description: 'Cute soft voice',
      languages: [
        { code: 'zh-CN', title: 'Chinese (Mandarin)' },
        { code: 'en-US', title: 'English (US)' },
      ],
    }])
  })

  it('sends the OpenAI speech body and retries a busy server', async () => {
    const bodies: string[] = []
    let attempts = 0

    vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:9310/v1/audio/speech')
      bodies.push(String(init?.body))
      attempts++
      if (attempts === 1)
        return new Response(JSON.stringify({ error: 'busy' }), { status: 409 })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    })

    const provider = await createProvider({
      baseUrl: 'http://127.0.0.1:9310/',
      instructions: 'Speak softly.',
    })
    const audio = await generateSpeech({
      ...provider.speech('breeze-tts-2'),
      input: '你好',
      voice: 'xiaoling',
    })

    expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3]))
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0])).toMatchObject({
      model: 'breeze-tts-2',
      input: '你好',
      voice: 'xiaoling',
      instructions: 'Speak softly.',
      response_format: 'wav',
    })
  })

  it('runs concurrent requests one at a time', async () => {
    let active = 0
    let maxActive = 0

    vi.stubGlobal('fetch', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active--
      return new Response(new Uint8Array([1]), { status: 200 })
    })

    const provider = await createProvider()
    await Promise.all([
      generateSpeech({ ...provider.speech('breeze-tts-2'), input: 'one', voice: 'xiaoling' }),
      generateSpeech({ ...provider.speech('breeze-tts-2'), input: 'two', voice: 'xiaoling' }),
    ])

    expect(maxActive).toBe(1)
  })
})
