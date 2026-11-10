import type { ChatProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type { ChatRequestOptions, ProviderInstance } from '../../../types'

import { describe, expect, it } from 'vitest'

import { getGenerationProvider } from '../../../types'
import { providerQwenTokenPlan } from './index'

type QwenTokenPlanChatProvider = ChatProviderWithExtraOptions<string, ChatRequestOptions>

function isChatProvider(provider: ProviderInstance): provider is QwenTokenPlanChatProvider {
  return 'chat' in provider && typeof provider.chat === 'function'
}

async function createChatProvider(): Promise<QwenTokenPlanChatProvider> {
  const provider = await providerQwenTokenPlan.createProvider({ apiKey: 'sk-test' })

  if (!isChatProvider(provider))
    throw new Error('Qwen Token Plan provider must support chat')

  return provider
}

describe('providerQwenTokenPlan.createProvider chat options', () => {
  it('keeps the gateway default when no reasoning option is requested', async () => {
    const provider = await createChatProvider()

    expect(provider.chat('qwen3.8-max')).not.toHaveProperty('enable_thinking')
  })

  it('disables thinking when the request asks for disabled reasoning', async () => {
    const provider = await createChatProvider()

    expect(provider.chat('qwen3.8-max', { reasoning: 'disabled' })).toMatchObject({
      enable_thinking: false,
    })
  })

  it('enables thinking when the request asks for enabled reasoning', async () => {
    const provider = await createChatProvider()

    expect(provider.chat('qwen3.8-max', { reasoning: 'enabled' })).toMatchObject({
      enable_thinking: true,
    })
  })

  it('forwards the reasoning choice through the generation adapter', async () => {
    const provider = await createChatProvider()
    const generation = getGenerationProvider(provider)

    const request = generation?.generation('qwen3.8-max', { reasoning: 'disabled' })

    expect(request).toMatchObject({ protocol: 'chat-completions' })
    expect(request?.config).toMatchObject({ enable_thinking: false })
  })

  it('defaults the base url to the CORS proxy that fronts the gateway', async () => {
    const provider = await createChatProvider()

    expect(provider.chat('qwen3.8-max')).toMatchObject({
      baseURL: 'https://airi.example/qwen/compatible-mode/v1',
    })
  })
})
