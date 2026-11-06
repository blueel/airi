import { errorMessageFrom } from '@moeru/std'

/**
 * Points a fresh Android install at the tunneled Breeze TTS server.
 *
 * The Web build seeds this through `seedBreezeSpeechProvider`. The Android app
 * has no Vite proxy and no shared seed, so without this file the default speech
 * provider stays `speech-noop` and replies arrive as text only.
 *
 * The seed fills only missing or placeholder values. A provider the owner chose
 * is left alone, and a loopback address from an older build is rewritten once.
 */
const BREEZE = {
  providerId: 'breeze-tts',
  model: 'breeze-tts-2',
  voiceId: 'xiaoling',
  // The direct frp tunnel is plain HTTP, which Android WebView blocks as mixed
  // content on the `https://localhost` app origin. The preview origin serves the
  // same server over HTTPS, and the app already trusts its certificate.
  baseUrl: 'https://airi.example/breeze-tts/',
} as const

const LEGACY_BASE_URLS = new Set([
  'http://127.0.0.1:9310',
  'http://127.0.0.1:9310/',
  'http://localhost:9310',
  'http://localhost:9310/',
  'http://airi.example',
  'http://airi.example/',
  '/breeze-tts/',
  '/breeze-tts',
  'https://airi.example/breeze-tts',
])

function readObject(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }
  catch {
    return {}
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function writeSpeechSelection(provider: string, model: string, voiceId: string) {
  localStorage.setItem('settings/speech/active-provider', provider)
  localStorage.setItem('settings/speech/active-model', model)
  localStorage.setItem('settings/speech/voice', voiceId)
}

export function seedDefaultSpeech() {
  if (typeof localStorage === 'undefined')
    return

  try {
    const configured = readObject('settings/providers/configured')
    const existing = configured[BREEZE.providerId]
    if (!existing) {
      configured[BREEZE.providerId] = {
        id: BREEZE.providerId,
        definitionId: BREEZE.providerId,
        config: { baseUrl: BREEZE.baseUrl, model: BREEZE.model },
        status: 'configured',
        configuredBy: 'user',
      }
      localStorage.setItem('settings/providers/configured', JSON.stringify(configured))
    }
    else if (typeof existing === 'object' && !Array.isArray(existing)) {
      const entry = existing as { config?: unknown }
      const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
        ? entry.config as Record<string, unknown>
        : {}
      let changed = false
      if (!isText(config.baseUrl) || LEGACY_BASE_URLS.has(config.baseUrl.trim())) {
        config.baseUrl = BREEZE.baseUrl
        changed = true
      }
      if (!isText(config.model)) {
        config.model = BREEZE.model
        changed = true
      }
      if (changed) {
        entry.config = config
        configured[BREEZE.providerId] = entry
        localStorage.setItem('settings/providers/configured', JSON.stringify(configured))
      }
    }

    const added = readObject('settings/providers/added')
    if (!added[BREEZE.providerId]) {
      added[BREEZE.providerId] = true
      localStorage.setItem('settings/providers/added', JSON.stringify(added))
    }

    const activeProvider = localStorage.getItem('settings/speech/active-provider') || ''
    if (!activeProvider || activeProvider === 'speech-noop') {
      writeSpeechSelection(BREEZE.providerId, BREEZE.model, BREEZE.voiceId)
    }
    else if (activeProvider === BREEZE.providerId) {
      if (!isText(localStorage.getItem('settings/speech/active-model')))
        localStorage.setItem('settings/speech/active-model', BREEZE.model)
      if (!isText(localStorage.getItem('settings/speech/voice')))
        localStorage.setItem('settings/speech/voice', BREEZE.voiceId)
    }

    const defaults = readObject('airi-card-module-defaults')
    const speech = defaults.speech && typeof defaults.speech === 'object' && !Array.isArray(defaults.speech)
      ? defaults.speech as Record<string, unknown>
      : {}
    const provider = speech.provider
    if (!isText(provider) || provider === 'speech-noop') {
      defaults.speech = {
        ...speech,
        provider: BREEZE.providerId,
        model: BREEZE.model,
        voice_id: BREEZE.voiceId,
      }
      localStorage.setItem('airi-card-module-defaults', JSON.stringify(defaults))
    }
    else if (provider === BREEZE.providerId) {
      let changed = false
      if (!isText(speech.model)) {
        speech.model = BREEZE.model
        changed = true
      }
      if (!isText(speech.voice_id)) {
        speech.voice_id = BREEZE.voiceId
        changed = true
      }
      if (changed) {
        defaults.speech = speech
        localStorage.setItem('airi-card-module-defaults', JSON.stringify(defaults))
      }
    }
  }
  catch (error) {
    console.error('Failed to seed the Breeze speech provider:', errorMessageFrom(error))
  }
}
