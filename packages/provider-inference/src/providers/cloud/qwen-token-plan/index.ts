import type { ChatRequestOptions } from '../../../types'

import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

// The upstream gateway (`token-plan.maas.qianwenaiapi.com`) sends no CORS headers,
// so a browser or WebView cannot call it at all. This default points at the CORS
// proxy published on the public origin instead: `D:/AI/qwen-proxy/qwen-cors-proxy.mjs`
// behind the `/qwen` route of the web preview. Callers that do not use a browser
// can still set this field back to the gateway's own `/compatible-mode/v1`.
const DEFAULT_BASE_URL = 'https://airi.example/qwen/compatible-mode/v1'

const qwenTokenPlanConfigSchema = z.object({
  apiKey: z
    .string('API Key')
    .optional(),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default(DEFAULT_BASE_URL),
})

type QwenTokenPlanConfig = z.input<typeof qwenTokenPlanConfigSchema>

export const providerQwenTokenPlan = defineProvider<QwenTokenPlanConfig, 'qwen-token-plan'>({
  id: 'qwen-token-plan',
  order: 19,
  name: 'Qwen Token Plan',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.qwen-token-plan.title'),
  description: 'token-plan.maas.qianwenaiapi.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.qwen-token-plan.description'),
  tasks: ['chat'],
  capabilities: { chat: { reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-lobe-icons:alibabacloud',

  createProviderConfig: ({ t }) => qwenTokenPlanConfigSchema.extend({
    apiKey: qwenTokenPlanConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: qwenTokenPlanConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    const baseProvider = createOpenAI(config.apiKey || '', config.baseUrl ?? DEFAULT_BASE_URL)

    return {
      ...baseProvider,
      chat(model: string, options?: ChatRequestOptions) {
        const chatOptions = baseProvider.chat(model)

        // The gateway normalizes `enable_thinking` for Qwen and DeepSeek models.
        // GLM-5.3 refuses `false` because its thinking cannot be disabled, so it
        // needs the reasoning setting enabled in the interface.
        if (!options?.reasoning)
          return chatOptions

        return { ...chatOptions, enable_thinking: options.reasoning === 'enabled' }
      },
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
