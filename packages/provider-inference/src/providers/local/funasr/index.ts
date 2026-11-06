import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { defineProvider } from '../../registry'

/**
 * Default points at the frp-tunneled FunASR server. It serves the OpenAI
 * `/v1/audio/transcriptions` contract over HTTPS and requires a bearer token
 * (the `access_token.txt` next to the server). A same-origin proxy path such
 * as `/funasr/v1/` works too, for hosts whose dev server forwards that path.
 */
const DEFAULT_BASE_URL = 'https://airi.example/v1/'

const funAsrConfigSchema = z.object({
  apiKey: z.string('API Key').default(''),
  baseUrl: z.string('Base URL').default(DEFAULT_BASE_URL),
})

type FunAsrConfig = z.input<typeof funAsrConfigSchema>

const funAsrTranscriptionModels = [
  ['sensevoice', 'SenseVoiceSmall', 'Fast multilingual ASR with punctuation and ITN (zh / en / ja / ko / yue).'],
  ['paraformer-zh', 'Paraformer ZH', 'VAD + ASR + punctuation pipeline tuned for Mandarin.'],
].map(([id, name, description]) => ({
  id,
  name,
  description,
  provider: 'funasr-transcription',
  contextLength: 0,
  deprecated: false,
}))

/**
 * The transcription client builds a `URL` from the base, so a proxy path has
 * to be resolved against the page origin here instead of by the caller.
 */
export function normalizeBaseUrl(baseUrl: string | undefined) {
  const value = baseUrl?.trim() || DEFAULT_BASE_URL
  if (value.startsWith('/')) {
    const origin = globalThis.location?.origin
    if (origin)
      return new URL(value, origin).toString()
  }
  return value.endsWith('/') ? value : `${value}/`
}

function createFunAsrProvider(config: FunAsrConfig) {
  const provider = createOpenAI(config.apiKey?.trim() ?? '', normalizeBaseUrl(config.baseUrl))
  const transcription = provider.transcription.bind(provider)
  provider.transcription = (model: string, extraOptions?: Record<string, unknown>) => ({
    ...transcription(model),
    ...extraOptions,
  })
  return provider
}

export const providerFunAsrTranscription = defineProvider<FunAsrConfig, 'funasr-transcription'>({
  id: 'funasr-transcription',
  name: 'FunASR',
  nameLocalize: () => 'FunASR',
  description: 'Self-hosted FunASR speech recognition',
  descriptionLocalize: () => '自托管 FunASR 语音识别服务',
  tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
  icon: 'i-solar:microphone-3-bold-duotone',
  capabilities: {
    transcription: { protocol: 'http', generateOutput: true, streamOutput: false, streamInput: false },
  },
  createProviderConfig: ({ t }) => funAsrConfigSchema.extend({
    apiKey: funAsrConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: funAsrConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider: createFunAsrProvider,
  validationRequiredWhen: config => Boolean(config.apiKey?.trim()),
  validators: {
    validateConfig: [
      () => ({
        id: 'funasr:check-config',
        name: 'FunASR configuration',
        validator: async (config: FunAsrConfig) => {
          const errors: Array<{ error: unknown }> = []
          const value = config.baseUrl?.trim() || DEFAULT_BASE_URL
          const isAbsolute = /^https?:\/\//i.test(value)
          const isProxyPath = value.startsWith('/')
          if (!isAbsolute && !isProxyPath)
            errors.push({ error: new Error('Base URL must be an absolute http(s) URL or a same-origin proxy path such as /funasr/v1/.') })
          return {
            errors,
            reason: errors.map(item => (item.error as Error).message).join(', '),
            reasonKey: '',
            valid: errors.length === 0,
          }
        },
      }),
    ],
  },
  extraMethods: {
    listModels: async () => funAsrTranscriptionModels,
  },
})
