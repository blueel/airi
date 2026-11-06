/**
 * Seeds default providers so a fresh browser profile can chat and speak
 * without walking through provider setup first.
 *
 * Values only fill empty slots: an existing provider entry, or a model the
 * user already picked, is never overwritten. The DeepSeek key comes from the
 * `VITE_DEFAULT_DEEPSEEK_*` build variables rather than source, so the key
 * lives in an untracked `.env.local`. The Breeze-TTS seed runs only when
 * `VITE_DEFAULT_BREEZE_TTS` is true.
 */

import { isEnvTruthy } from '@proj-airi/stage-shared'

const STORAGE_KEY = {
  configuredProviders: 'settings/providers/configured',
  addedProviders: 'settings/providers/added',
  activeProvider: 'settings/consciousness/active-provider',
  activeModel: 'settings/consciousness/active-model',
} as const

const PROVIDER_ID = 'deepseek'

const SPEECH_STORAGE_KEY = {
  activeProvider: 'settings/speech/active-provider',
  activeModel: 'settings/speech/active-model',
  voice: 'settings/speech/voice',
  moduleDefaults: 'airi-card-module-defaults',
} as const

const OLLAMA = {
  providerId: 'ollama',
  /**
   * Forwarded to the loopback Ollama server by the dev and preview servers, so
   * the phone and the public HTTPS link reach the same machine that runs
   * Ollama. A loopback URL cannot: on a phone it resolves to the phone itself,
   * and it is blocked as mixed content from an `https:` page.
   *
   * Resolved against `location.origin` rather than stored as a bare path,
   * because the provider builds a `URL` from this value and relative paths
   * throw `Invalid base URL`.
   */
  proxyPath: '/ollama/v1/',
  defaultModel: 'huihui_ai/qwen3-abliterated:14b-v2',
} as const

/** Base URLs an earlier seed wrote, replaced in place by the origin-resolved proxy path. */
const LEGACY_OLLAMA_BASE_URLS = new Set([
  // Loopback: only correct on the machine running Ollama.
  'http://localhost:11434/v1/',
  'http://localhost:11434/v1',
  'http://127.0.0.1:11434/v1/',
  'http://127.0.0.1:11434/v1',
  // Bare proxy path: throws on the provider's `new URL(...)`.
  '/ollama/v1/',
  '/ollama/v1',
])

const BREEZE_TTS = {
  providerId: 'breeze-tts',
  model: 'breeze-tts-2',
  voiceId: 'xiaoling',
  /**
   * Origin-relative on purpose. `/breeze-tts/` is forwarded to the loopback
   * server by the dev and preview servers, so the same stored value works in a
   * local browser and from a phone on the public HTTPS link. A loopback URL
   * cannot: it resolves to the viewer's own device, and an `http:` request from
   * an `https:` page is blocked as mixed content.
   */
  proxyPath: '/breeze-tts/',
} as const

/** Loopback base URLs an earlier seed wrote, replaced in place by the proxy path. */
const LEGACY_BREEZE_BASE_URLS = new Set([
  'http://127.0.0.1:9310',
  'http://127.0.0.1:9310/',
  'http://localhost:9310',
  'http://localhost:9310/',
])

const STRATA = {
  providerId: 'strata',
  /**
   * Forwarded to the loopback Strata server by the dev and preview servers.
   * The Strata server sends no CORS headers, so a browser page cannot call the
   * loopback port directly; through the proxy the request is same-origin.
   * Resolved against `location.origin` rather than stored as a bare path,
   * because the provider builds a `URL` from this value and relative paths
   * throw `Invalid base URL`. The desktop app has no proxy and keeps using the
   * loopback address directly.
   */
  proxyPath: '/strata/v1/',
  defaultModel: 'qwen3.8-flash-next-iq2_xs',
} as const

/** Loopback base URLs the schema default seeded, replaced in place by the proxy path. */
const LEGACY_STRATA_BASE_URLS = new Set([
  'http://localhost:8100/v1/',
  'http://localhost:8100/v1',
  'http://127.0.0.1:8100/v1/',
  'http://127.0.0.1:8100/v1',
  // Bare proxy path: throws on the provider's `new URL(...)`.
  '/strata/v1/',
  '/strata/v1',
])

function readJson(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key)
  if (!raw)
    return undefined
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function readRawString(storage: Storage, key: string) {
  const raw = storage.getItem(key)
  return raw === null ? undefined : raw
}

function writeJson(storage: Storage, key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value))
}

/**
 * `useLocalStorage` serializes a string default without JSON, so these keys
 * hold the bare value. Writing a JSON-quoted string here would restore the
 * quotes as part of the provider id.
 */
function writeRawString(storage: Storage, key: string, value: string) {
  storage.setItem(key, value)
}

/**
 * Repairs a value written as a JSON string into a store that reads the key
 * without JSON. An earlier seed did this to the chat selection keys, which
 * surfaced as `Provider definition for "deepseek" not found`.
 */
function healJsonQuotedString(storage: Storage, key: string) {
  const raw = storage.getItem(key)
  if (!raw || raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"'))
    return

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string' && parsed !== '')
      writeRawString(storage, key, parsed)
  }
  catch {
    // Leave values this store did not write alone.
  }
}

function seedDeepSeekProvider() {
  const apiKey = import.meta.env.VITE_DEFAULT_DEEPSEEK_API_KEY
  if (!isNonEmptyString(apiKey))
    return

  const configured = readJson(localStorage, STORAGE_KEY.configuredProviders)
  const providers = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : {}

  if (!providers[PROVIDER_ID]) {
    providers[PROVIDER_ID] = {
      id: PROVIDER_ID,
      definitionId: PROVIDER_ID,
      config: {
        apiKey: apiKey.trim(),
        baseUrl: import.meta.env.VITE_DEFAULT_DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        thinkingMode: 'auto',
      },
      status: 'configured',
      configuredBy: 'user',
    }
    writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
  }

  const added = readJson(localStorage, STORAGE_KEY.addedProviders)
  const addedProviders = added && typeof added === 'object' && !Array.isArray(added)
    ? added as Record<string, unknown>
    : {}
  if (!addedProviders[PROVIDER_ID]) {
    addedProviders[PROVIDER_ID] = true
    writeJson(localStorage, STORAGE_KEY.addedProviders, addedProviders)
  }

  // Only claim the active selection when the user has not made one yet.
  healJsonQuotedString(localStorage, STORAGE_KEY.activeProvider)
  healJsonQuotedString(localStorage, STORAGE_KEY.activeModel)

  if (!isNonEmptyString(readRawString(localStorage, STORAGE_KEY.activeProvider)))
    writeRawString(localStorage, STORAGE_KEY.activeProvider, PROVIDER_ID)

  if (!isNonEmptyString(readRawString(localStorage, STORAGE_KEY.activeModel))) {
    const model = import.meta.env.VITE_DEFAULT_DEEPSEEK_MODEL
    writeRawString(localStorage, STORAGE_KEY.activeModel, isNonEmptyString(model) ? model : 'deepseek-flash')
  }
}

/**
 * Seeds a local Ollama chat provider so the machine-local model can be used
 * without opening the provider form first.
 *
 * Seeding also repairs a first-run dead end: while no Ollama entry exists, the
 * Ollama settings page throws `DataCloneError` on mount, because the provider
 * definition carries lazy validator factories that the synced pinia store
 * cannot `structuredClone`. With an entry present the page renders, so the seed
 * is the only way into that form for a fresh profile.
 *
 * Never overwrites an entry the user already has. The `thinkingMode` defaults
 * to `disable`: Qwen3 otherwise spends the whole reply budget on reasoning and
 * leaves companion chat without any spoken text.
 */
function seedOllamaProvider() {
  if (!isEnvTruthy(import.meta.env.VITE_DEFAULT_OLLAMA))
    return

  const configuredBaseUrl = import.meta.env.VITE_DEFAULT_OLLAMA_BASE_URL
  // An explicit absolute address wins; otherwise derive it from whichever
  // origin serves this page. Every origin keeps its own localStorage, so the
  // dev server and the public HTTPS link each store an address that reaches
  // their own proxy.
  const baseUrl = isNonEmptyString(configuredBaseUrl) && /^https?:\/\//i.test(configuredBaseUrl)
    ? configuredBaseUrl
    : `${globalThis.location.origin}${OLLAMA.proxyPath}`
  const model = import.meta.env.VITE_DEFAULT_OLLAMA_MODEL || OLLAMA.defaultModel

  const configured = readJson(localStorage, STORAGE_KEY.configuredProviders)
  const providers = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : {}

  if (!providers[OLLAMA.providerId]) {
    providers[OLLAMA.providerId] = {
      id: OLLAMA.providerId,
      definitionId: OLLAMA.providerId,
      config: {
        baseUrl,
        thinkingMode: 'disable',
      },
      status: 'configured',
      configuredBy: 'user',
    }
    writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
  }
  else if (typeof providers[OLLAMA.providerId] === 'object' && !Array.isArray(providers[OLLAMA.providerId])) {
    // A profile seeded before the proxy path points at the loopback port, which
    // only resolves on the machine running Ollama. Rewrite that exact value
    // once; any other address is the user's own and is left alone.
    const entry = providers[OLLAMA.providerId] as { config?: unknown }
    const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
      ? entry.config as Record<string, unknown>
      : {}
    if (isNonEmptyString(config.baseUrl) && LEGACY_OLLAMA_BASE_URLS.has(config.baseUrl.trim())) {
      config.baseUrl = baseUrl
      entry.config = config
      writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
    }
  }

  const added = readJson(localStorage, STORAGE_KEY.addedProviders)
  const addedProviders = added && typeof added === 'object' && !Array.isArray(added)
    ? added as Record<string, unknown>
    : {}
  if (!addedProviders[OLLAMA.providerId]) {
    addedProviders[OLLAMA.providerId] = true
    writeJson(localStorage, STORAGE_KEY.addedProviders, addedProviders)
  }

  // Claiming the chat selection is opt-in, so a profile that already chats
  // through another provider keeps its choice.
  if (isEnvTruthy(import.meta.env.VITE_DEFAULT_OLLAMA_ACTIVE)) {
    writeRawString(localStorage, STORAGE_KEY.activeProvider, OLLAMA.providerId)
    writeRawString(localStorage, STORAGE_KEY.activeModel, model)
  }
}

/**
 * Points the speech module at the local Breeze-TTS-2 server. The server keeps
 * its own voices, so the saved `xiaoling` voice is the default. A user who
 * picked another speech provider keeps that choice.
 */
function seedBreezeSpeechProvider() {
  if (!isEnvTruthy(import.meta.env.VITE_DEFAULT_BREEZE_TTS))
    return

  const configured = readJson(localStorage, STORAGE_KEY.configuredProviders)
  const providers = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : {}

  const existing = providers[BREEZE_TTS.providerId]
  if (!existing) {
    providers[BREEZE_TTS.providerId] = {
      id: BREEZE_TTS.providerId,
      definitionId: BREEZE_TTS.providerId,
      config: {
        baseUrl: BREEZE_TTS.proxyPath,
        model: BREEZE_TTS.model,
      },
      status: 'configured',
      configuredBy: 'user',
    }
    writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
  }
  else if (typeof existing === 'object' && !Array.isArray(existing)) {
    // Fill only missing fields, so a user's port or model survives.
    const entry = existing as { config?: unknown }
    const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
      ? entry.config as Record<string, unknown>
      : {}
    let changed = false
    if (!isNonEmptyString(config.baseUrl)) {
      config.baseUrl = BREEZE_TTS.proxyPath
      changed = true
    }
    // A profile seeded before the proxy path points at loopback, which is
    // correct only on the machine running the server. Rewrite that exact value
    // once; anything else is a user's own address and is left alone.
    else if (LEGACY_BREEZE_BASE_URLS.has((config.baseUrl as string).trim())) {
      config.baseUrl = BREEZE_TTS.proxyPath
      changed = true
    }
    if (!isNonEmptyString(config.model)) {
      config.model = BREEZE_TTS.model
      changed = true
    }
    if (changed) {
      entry.config = config
      writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
    }
  }

  const added = readJson(localStorage, STORAGE_KEY.addedProviders)
  const addedProviders = added && typeof added === 'object' && !Array.isArray(added)
    ? added as Record<string, unknown>
    : {}
  if (!addedProviders[BREEZE_TTS.providerId]) {
    addedProviders[BREEZE_TTS.providerId] = true
    writeJson(localStorage, STORAGE_KEY.addedProviders, addedProviders)
  }

  const activeProvider = readRawString(localStorage, SPEECH_STORAGE_KEY.activeProvider)
  const usesDefaultSpeech = !isNonEmptyString(activeProvider) || activeProvider === 'speech-noop'
  if (usesDefaultSpeech) {
    writeRawString(localStorage, SPEECH_STORAGE_KEY.activeProvider, BREEZE_TTS.providerId)
    writeRawString(localStorage, SPEECH_STORAGE_KEY.activeModel, BREEZE_TTS.model)
    writeRawString(localStorage, SPEECH_STORAGE_KEY.voice, BREEZE_TTS.voiceId)
  }
  else if (activeProvider === BREEZE_TTS.providerId) {
    if (!isNonEmptyString(readRawString(localStorage, SPEECH_STORAGE_KEY.activeModel)))
      writeRawString(localStorage, SPEECH_STORAGE_KEY.activeModel, BREEZE_TTS.model)
    if (!isNonEmptyString(readRawString(localStorage, SPEECH_STORAGE_KEY.voice)))
      writeRawString(localStorage, SPEECH_STORAGE_KEY.voice, BREEZE_TTS.voiceId)
  }

  // A card inherits these defaults unless the card sets its own speech source.
  const moduleDefaults = readJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults)
  if (moduleDefaults && typeof moduleDefaults === 'object' && !Array.isArray(moduleDefaults)) {
    const defaults = moduleDefaults as { speech?: unknown }
    const speech = defaults.speech && typeof defaults.speech === 'object' && !Array.isArray(defaults.speech)
      ? defaults.speech as Record<string, unknown>
      : {}

    const provider = speech.provider
    if (!isNonEmptyString(provider) || provider === 'speech-noop') {
      defaults.speech = {
        ...speech,
        provider: BREEZE_TTS.providerId,
        model: BREEZE_TTS.model,
        voice_id: BREEZE_TTS.voiceId,
      }
      writeJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults, defaults)
    }
    else if (provider === BREEZE_TTS.providerId) {
      let changed = false
      if (!isNonEmptyString(speech.model)) {
        speech.model = BREEZE_TTS.model
        changed = true
      }
      if (!isNonEmptyString(speech.voice_id)) {
        speech.voice_id = BREEZE_TTS.voiceId
        changed = true
      }
      if (changed)
        writeJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults, defaults)
    }
  }
}

/**
 * Seeds the local Strata chat provider so the machine-local model can be used
 * without opening the provider form first.
 *
 * A profile that added the provider before the proxy existed holds the
 * loopback schema default, which a browser page cannot fetch from (the Strata
 * server sends no CORS headers). That exact value is rewritten to the
 * origin-resolved proxy path once; any other address is the user's own and is
 * left alone. A missing model is filled so the consciousness module has a
 * selection without walking through the model picker.
 */
function seedStrataProvider() {
  if (!isEnvTruthy(import.meta.env.VITE_DEFAULT_STRATA))
    return

  const configuredBaseUrl = import.meta.env.VITE_DEFAULT_STRATA_BASE_URL
  // An explicit absolute address wins; otherwise derive it from whichever
  // origin serves this page. Every origin keeps its own localStorage, so the
  // dev server and the public HTTPS link each store an address that reaches
  // their own proxy.
  const baseUrl = isNonEmptyString(configuredBaseUrl) && /^https?:\/\//i.test(configuredBaseUrl)
    ? configuredBaseUrl
    : `${globalThis.location.origin}${STRATA.proxyPath}`
  const model = import.meta.env.VITE_DEFAULT_STRATA_MODEL || STRATA.defaultModel

  const configured = readJson(localStorage, STORAGE_KEY.configuredProviders)
  const providers = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : {}

  if (!providers[STRATA.providerId]) {
    providers[STRATA.providerId] = {
      id: STRATA.providerId,
      definitionId: STRATA.providerId,
      config: {
        baseUrl,
        model,
      },
      status: 'configured',
      configuredBy: 'user',
    }
    writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
  }
  else if (typeof providers[STRATA.providerId] === 'object' && !Array.isArray(providers[STRATA.providerId])) {
    const entry = providers[STRATA.providerId] as { config?: unknown }
    const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
      ? entry.config as Record<string, unknown>
      : {}
    let changed = false
    if (!isNonEmptyString(config.baseUrl)) {
      config.baseUrl = baseUrl
      changed = true
    }
    else if (LEGACY_STRATA_BASE_URLS.has(config.baseUrl.trim())) {
      config.baseUrl = baseUrl
      changed = true
    }
    if (!isNonEmptyString(config.model)) {
      config.model = model
      changed = true
    }
    if (changed) {
      entry.config = config
      writeJson(localStorage, STORAGE_KEY.configuredProviders, providers)
    }
  }

  const added = readJson(localStorage, STORAGE_KEY.addedProviders)
  const addedProviders = added && typeof added === 'object' && !Array.isArray(added)
    ? added as Record<string, unknown>
    : {}
  if (!addedProviders[STRATA.providerId]) {
    addedProviders[STRATA.providerId] = true
    writeJson(localStorage, STORAGE_KEY.addedProviders, addedProviders)
  }

  // Claiming the chat selection is opt-in, so a profile that already chats
  // through another provider keeps its choice.
  if (isEnvTruthy(import.meta.env.VITE_DEFAULT_STRATA_ACTIVE)) {
    writeRawString(localStorage, STORAGE_KEY.activeProvider, STRATA.providerId)
    writeRawString(localStorage, STORAGE_KEY.activeModel, model)
  }

  // A character inherits this snapshot unless its card sets a selection, and
  // the chat turn reads it per character, not the active selection above. A
  // provider-only default (picked while the model list still failed) surfaces
  // as `No chat provider or model configured for this character`.
  const moduleDefaults = readJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults)
  if (moduleDefaults && typeof moduleDefaults === 'object' && !Array.isArray(moduleDefaults)) {
    const defaults = moduleDefaults as { consciousness?: unknown }
    const consciousness = defaults.consciousness && typeof defaults.consciousness === 'object' && !Array.isArray(defaults.consciousness)
      ? defaults.consciousness as Record<string, unknown>
      : {}
    const provider = consciousness.provider
    const inheritsStrata = !isNonEmptyString(provider) || provider === STRATA.providerId
    // Fill only the missing model; a provider the user chose is left alone.
    if (inheritsStrata && !isNonEmptyString(consciousness.model)) {
      defaults.consciousness = { ...consciousness, provider: STRATA.providerId, model }
      writeJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults, defaults)
    }
  }
}

const DEEPSEEK_DEFAULT_MIGRATED_KEY = 'settings/consciousness/deepseek-default'

/**
 * Moves a profile that an older seed pointed at Ollama or Strata to DeepSeek once.
 * The marker keeps a later choice by the owner, so the default does not fight the settings page.
 */
function seedDeepSeekAsDefault() {
  const apiKey = import.meta.env.VITE_DEFAULT_DEEPSEEK_API_KEY
  if (!isNonEmptyString(apiKey))
    return
  if (localStorage.getItem(DEEPSEEK_DEFAULT_MIGRATED_KEY) === 'true')
    return

  const model = isNonEmptyString(import.meta.env.VITE_DEFAULT_DEEPSEEK_MODEL)
    ? import.meta.env.VITE_DEFAULT_DEEPSEEK_MODEL
    : 'deepseek-flash'

  writeRawString(localStorage, STORAGE_KEY.activeProvider, PROVIDER_ID)
  writeRawString(localStorage, STORAGE_KEY.activeModel, model)

  const defaults = readJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults)
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const moduleDefaults = defaults as { consciousness?: unknown }
    const consciousness = moduleDefaults.consciousness && typeof moduleDefaults.consciousness === 'object' && !Array.isArray(moduleDefaults.consciousness)
      ? moduleDefaults.consciousness as Record<string, unknown>
      : {}
    const provider = consciousness.provider
    if (!isNonEmptyString(provider) || provider === 'ollama' || provider === 'strata') {
      moduleDefaults.consciousness = { ...consciousness, provider: PROVIDER_ID, model }
      writeJson(localStorage, SPEECH_STORAGE_KEY.moduleDefaults, moduleDefaults)
    }
  }

  localStorage.setItem(DEEPSEEK_DEFAULT_MIGRATED_KEY, 'true')
}

export function seedDefaultProvider() {
  if (typeof localStorage === 'undefined')
    return

  // A blocked or full storage must not stop the app from booting.
  try {
    seedDeepSeekProvider()
  }
  catch (error) {
    console.error('Failed to seed the default chat provider:', error)
  }

  try {
    seedOllamaProvider()
  }
  catch (error) {
    console.error('Failed to seed the local Ollama provider:', error)
  }

  try {
    seedStrataProvider()
  }
  catch (error) {
    console.error('Failed to seed the local Strata provider:', error)
  }

  try {
    seedBreezeSpeechProvider()
  }
  catch (error) {
    console.error('Failed to seed the default speech provider:', error)
  }

  try {
    seedDeepSeekAsDefault()
  }
  catch (error) {
    console.error('Failed to make DeepSeek the default chat model:', error)
  }
}
