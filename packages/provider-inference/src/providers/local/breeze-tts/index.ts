import type { VoiceInfo } from '../../../types'

import { errorMessageFrom } from '@moeru/std'
import { z } from 'zod'

import { defineProvider } from '../../registry'

// NOTICE:
// The default is a same-origin proxy path. A phone cannot reach a loopback
// server, and this repository ships no public host. A build that serves
// Breeze-TTS elsewhere sets `VITE_AIRI_BREEZE_TTS_URL`.
// Removal: when a first-run flow asks for the server address, restore
// 'http://127.0.0.1:9310/'.
const DEFAULT_BASE_URL = import.meta.env.VITE_AIRI_BREEZE_TTS_URL?.trim() || '/breeze-tts/'
const DEFAULT_MODEL = 'breeze-tts-2'
const BUSY_RETRIES = 30
const BUSY_RETRY_DELAY_MS = 500
const HEALTH_TIMEOUT_MS = 5000

const breezeTtsConfigSchema = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  instructions: z.string().default(''),
})

type BreezeTtsConfig = z.input<typeof breezeTtsConfigSchema>

interface BreezeVoice {
  id?: unknown
  description?: unknown
  saved?: unknown
}

/**
 * Accepts a server root with or without a trailing slash, and with or without
 * the OpenAI `/v1` suffix. The provider appends its own versioned paths.
 *
 * A path-only value such as `/breeze-tts` is resolved against the page origin,
 * which is how a reverse-proxied deployment reaches the loopback server from a
 * page served elsewhere. Requests are built from an absolute URL, so the
 * origin has to be applied here rather than left to the caller.
 */
function normalizeBaseUrl(baseUrl: string | undefined) {
  const value = baseUrl?.trim() || DEFAULT_BASE_URL
  const root = value.replace(/\/+$/, '').replace(/\/v1$/, '')
  if (root.startsWith('/')) {
    const origin = globalThis.location?.origin
    if (origin)
      return `${origin}${root}/`
  }

  return `${root}/`
}

function delay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }

    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sends one request at a time and reads each response body before the next
 * request starts. Breeze-TTS-2 serves one model and rejects a second
 * concurrent request with 409, and a streaming body still occupies the model
 * until it is fully read.
 *
 * A 409 can still come from another tab or the bundled web UI. It is retried
 * with a fixed delay until the other generation finishes.
 */
function createSerializedFetch(): typeof globalThis.fetch {
  let tail: Promise<unknown> = Promise.resolve()

  return (input, init) => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const response = await globalThis.fetch(input, init)
        if (response.status !== 409 || attempt >= BUSY_RETRIES) {
          const body = await response.arrayBuffer()
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }

        await response.body?.cancel()
        await delay(BUSY_RETRY_DELAY_MS, init?.signal)
      }
    }

    const result = tail.then(run, run)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function voicesUrl(config: BreezeTtsConfig) {
  return `${normalizeBaseUrl(config.baseUrl)}v1/voices`
}

function healthUrl(config: BreezeTtsConfig) {
  return `${normalizeBaseUrl(config.baseUrl)}health`
}

export const providerBreezeTts = defineProvider<BreezeTtsConfig, 'breeze-tts'>({
  id: 'breeze-tts',
  name: 'Breeze-TTS-2',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.breeze-tts.title'),
  description: 'Local Breeze-TTS-2 server with GGUF weights.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.breeze-tts.description'),
  tasks: ['text-to-speech'],
  icon: 'i-solar:volume-loud-bold-duotone',
  requiresCredentials: false,

  createProviderConfig: () => breezeTtsConfigSchema,
  createProvider(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const fetch = createSerializedFetch()
    const speechOptions = {
      baseURL: `${baseUrl}v1/`,
      model: config.model?.trim() || DEFAULT_MODEL,
      // NOTICE:
      // The server's optional MP3 encoder (`third_party/shine`) writes frames
      // that Chromium's mpa decoder rejects partway through the utterance
      // ("malformed stream: mpa: huffman decode overrun"), so playback stops
      // mid-sentence. WAV is the server's native output and decodes everywhere.
      // The same bytes arrive over a direct connection and a proxy, so this is
      // the encoder, not transport.
      // Source: docs-zh/build.md (`BREEZE_MP3`), breeze-server v0.1.3.
      // Removal: when the server emits MP3 frames browsers decode cleanly.
      response_format: 'wav',
      ...(config.instructions?.trim() ? { instructions: config.instructions.trim() } : {}),
      fetch,
    }

    return {
      speech: () => speechOptions,
    }
  },

  validationRequiredWhen: config => Boolean(normalizeBaseUrl(config.baseUrl)),
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'breeze-tts:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
          try {
            const response = await fetch(healthUrl(config), { signal: controller.signal })
            if (!response.ok) {
              const reason = `Breeze-TTS is unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }
            }

            const health = await response.json() as { status?: unknown }
            if (health.status !== 'ok') {
              const reason = 'Breeze-TTS did not report a ready state.'
              return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }
            }
          }
          catch (error) {
            const reason = `Breeze-TTS connection failed: ${errorMessageFrom(error) ?? 'Unknown error'}`
            return { errors: [{ error }], reason, reasonKey: '', valid: false }
          }
          finally {
            clearTimeout(timeout)
          }

          return { errors: [], reason: '', reasonKey: '', valid: true }
        },
      }),
    ],
  },
  extraMethods: {
    listModels: async () => [{
      id: DEFAULT_MODEL,
      name: 'Breeze-TTS-2',
      provider: 'breeze-tts',
      description: 'Local Breeze-TTS-2 GGUF server',
      contextLength: 0,
      deprecated: false,
    }],
    voiceCatalogConfig: ({ baseUrl }) => ({ baseUrl: normalizeBaseUrl(baseUrl) }),
    listVoices: async (config, _provider, _model, signal) => {
      const response = await fetch(voicesUrl(config), signal ? { signal } : undefined)
      if (!response.ok)
        throw new Error(`Failed to load Breeze-TTS voices: HTTP ${response.status} ${response.statusText}`)

      const payload = await response.json() as unknown
      if (!Array.isArray(payload))
        throw new Error('Breeze-TTS returned an invalid voice list.')

      return (payload as BreezeVoice[])
        .filter(voice => typeof voice.id === 'string' && voice.id.trim() !== '')
        .map<VoiceInfo>(voice => ({
          id: voice.id as string,
          name: voice.id as string,
          provider: 'breeze-tts',
          description: typeof voice.description === 'string' ? voice.description : undefined,
          languages: [
            { code: 'zh-CN', title: 'Chinese (Mandarin)' },
            { code: 'en-US', title: 'English (US)' },
          ],
        }))
    },
  },
})
