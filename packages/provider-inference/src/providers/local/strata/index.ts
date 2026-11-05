import { createChatProvider, createEmbedProvider, createModelProvider, merge } from '@xsai-ext/providers/utils'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

const strataConfigSchema = z.object({
  apiKey: z
    .string('API Key')
    .optional(),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('http://localhost:8100/v1/'),
})

type StrataConfig = z.input<typeof strataConfigSchema>

export const providerStrata = defineProvider<StrataConfig, 'strata'>({
  id: 'strata',
  order: 4,
  name: 'Strata',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.strata.title'),
  description: 'Strata',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.strata.description'),
  tasks: ['chat'],
  icon: 'i-solar:server-bold-duotone',

  createProviderConfig: ({ t }) => strataConfigSchema.extend({
    apiKey: strataConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: strataConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    return merge(
      createChatProvider({ apiKey: config.apiKey, baseURL: config.baseUrl! }),
      createEmbedProvider({ apiKey: config.apiKey, baseURL: config.baseUrl! }),
      createModelProvider({ apiKey: config.apiKey, baseURL: config.baseUrl! }),
    )
  },

  validationRequiredWhen(config) {
    return !!config.baseUrl?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
      skipApiKeyCheck: true,
      schedule: {
        mode: 'interval',
        intervalMs: 15_000,
      },
      connectivityFailureReason: ({ errorMessage }) =>
        `Failed to reach Strata server, error: ${errorMessage} occurred.\n\nMake sure Strata is running with its OpenAI-compatible API server enabled, and that the base URL (default http://localhost:8100/v1/) is correct.\n\nIf the server is already running, this is likely a CORS (Cross-Origin Resource Sharing) issue. Enable CORS in the server settings of Strata.`,
      modelListFailureReason: ({ errorMessage }) =>
        `Failed to reach Strata server, error: ${errorMessage} occurred.\n\nMake sure Strata is running with its OpenAI-compatible API server enabled, and that a model is loaded.`,
    }),
  },
})
