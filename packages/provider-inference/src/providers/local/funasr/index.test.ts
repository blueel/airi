import type { ProviderTranslator } from '../../../types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { normalizeBaseUrl, providerFunAsrTranscription } from '.'

const translate: ProviderTranslator = key => key

afterEach(() => {
  vi.unstubAllGlobals()
})

async function parseConfig() {
  return z.parse(await providerFunAsrTranscription.createProviderConfig({ t: translate }), {})
}

describe('funasr-transcription provider', () => {
  it('defaults to the tunneled server', async () => {
    const config = await parseConfig()

    expect(config.baseUrl).toBe('https://airi.example/v1/')
    expect(config.apiKey).toBe('')
  })

  it('normalizes an absolute base URL', () => {
    expect(normalizeBaseUrl('https://example.test:9250/v1')).toBe('https://example.test:9250/v1/')
    expect(normalizeBaseUrl('https://example.test:9250/v1/')).toBe('https://example.test:9250/v1/')
    expect(normalizeBaseUrl('')).toBe('https://airi.example/v1/')
  })

  it('resolves a same-origin proxy path against the page origin', () => {
    vi.stubGlobal('location', { origin: 'https://airi.example:9200' })

    expect(normalizeBaseUrl('/funasr/v1/')).toBe('https://airi.example:9200/funasr/v1/')
  })

  it('lists the two FunASR models', async () => {
    const config = await parseConfig()
    const provider = await providerFunAsrTranscription.createProvider(config)
    const models = await providerFunAsrTranscription.extraMethods?.listModels?.(config, provider)

    expect(models?.map(model => model.id)).toEqual(['sensevoice', 'paraformer-zh'])
  })
})
