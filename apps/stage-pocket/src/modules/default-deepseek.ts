import { errorMessageFrom } from '@moeru/std'

/**
 * Configures the DeepSeek provider on a fresh install. Memory processing always
 * uses DeepSeek, so the provider must exist before the first reply, even when
 * the owner chats through a local model.
 *
 * The key comes from `VITE_DEFAULT_DEEPSEEK_API_KEY` at build time. The seed
 * moves an older seeded local chat selection to DeepSeek once, then leaves a
 * later choice by the owner alone.
 */
const DEEPSEEK_DEFAULT_MIGRATED_KEY = 'settings/consciousness/deepseek-default'

export function seedDefaultDeepSeek() {
  if (typeof localStorage === 'undefined')
    return

  const apiKey = import.meta.env.VITE_DEFAULT_DEEPSEEK_API_KEY?.trim()
  if (!apiKey)
    return

  const model = import.meta.env.VITE_DEFAULT_DEEPSEEK_MODEL?.trim() || 'deepseek-flash'

  try {
    const configured = JSON.parse(localStorage.getItem('settings/providers/configured') || 'null') as Record<string, unknown> | null
    const providers = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {}
    if (!providers.deepseek) {
      providers.deepseek = {
        id: 'deepseek',
        definitionId: 'deepseek',
        config: {
          apiKey,
          baseUrl: import.meta.env.VITE_DEFAULT_DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
          thinkingMode: 'auto',
        },
        status: 'configured',
        configuredBy: 'user',
      }
      localStorage.setItem('settings/providers/configured', JSON.stringify(providers))
    }

    const added = JSON.parse(localStorage.getItem('settings/providers/added') || 'null') as Record<string, unknown> | null
    const addedProviders = added && typeof added === 'object' && !Array.isArray(added) ? added : {}
    if (!addedProviders.deepseek) {
      addedProviders.deepseek = true
      localStorage.setItem('settings/providers/added', JSON.stringify(addedProviders))
    }

    if (localStorage.getItem(DEEPSEEK_DEFAULT_MIGRATED_KEY) === 'true')
      return

    const activeProvider = localStorage.getItem('settings/consciousness/active-provider')?.trim() || ''
    if (!activeProvider || activeProvider === 'ollama' || activeProvider === 'strata' || activeProvider === 'deepseek') {
      localStorage.setItem('settings/consciousness/active-provider', 'deepseek')
      localStorage.setItem('settings/consciousness/active-model', model)
    }

    const defaults = JSON.parse(localStorage.getItem('airi-card-module-defaults') || 'null') as Record<string, unknown> | null
    if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
      const consciousness = defaults.consciousness && typeof defaults.consciousness === 'object' && !Array.isArray(defaults.consciousness)
        ? defaults.consciousness as Record<string, unknown>
        : {}
      const provider = consciousness.provider
      if (!provider || provider === 'ollama' || provider === 'strata' || provider === 'deepseek') {
        defaults.consciousness = { ...consciousness, provider: 'deepseek', model }
        localStorage.setItem('airi-card-module-defaults', JSON.stringify(defaults))
      }
    }

    localStorage.setItem(DEEPSEEK_DEFAULT_MIGRATED_KEY, 'true')
  }
  catch (error) {
    console.error('Failed to seed the DeepSeek provider:', errorMessageFrom(error))
  }
}
