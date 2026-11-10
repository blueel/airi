<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  ProviderAdvancedSettings,
  ProviderApiKeyInput,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  TranscriptionPlayground,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Alert, Button, FieldCombobox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'

interface FunAsrStoredConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

const providerId = 'funasr-transcription'
const DEFAULT_BASE_URL = import.meta.env.VITE_AIRI_FUNASR_URL?.trim() || '/funasr/v1/'
const MODEL_OPTIONS = [
  { value: 'sensevoice', label: 'SenseVoiceSmall (multilingual, recommended)' },
  { value: 'paraformer-zh', label: 'Paraformer ZH (Mandarin pipeline)' },
]

const hearingStore = useHearingStore()
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()
const { configs: providers } = storeToRefs(providerStore) as { configs: RemovableRef<Record<string, FunAsrStoredConfig>> }

const apiKey = computed({
  get: () => providers.value[providerId]?.apiKey || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].apiKey = value
  },
})

const baseUrl = computed({
  get: () => providers.value[providerId]?.baseUrl || DEFAULT_BASE_URL,
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].baseUrl = value
  },
})

const model = computed({
  get: () => providers.value[providerId]?.model || 'sensevoice',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].model = value
  },
})

const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)

async function handleGenerateTranscription(file: File) {
  const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string>>(providerId)
  if (!provider)
    throw new Error('Failed to initialize transcription provider')

  return await hearingStore.transcription(
    providerId,
    provider,
    model.value,
    file,
    'json',
  )
}

const {
  t,
  router,
  providerMetadata,
  isValidating,
  isValid,
  validationMessage,
  handleResetSettings,
  forceValid,
} = useProviderValidation(providerId)

onMounted(async () => {
  await providersStore.initializeProvider(providerId)
  if (!providers.value[providerId]?.model)
    model.value = 'sensevoice'
  if (!providers.value[providerId]?.baseUrl)
    baseUrl.value = DEFAULT_BASE_URL
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <div flex="~ col md:row gap-6">
      <ProviderSettingsContainer class="w-full md:w-[45%]">
        <ProviderBasicSettings
          :title="t('settings.pages.providers.common.section.basic.title')"
          :description="t('settings.pages.providers.common.section.basic.description')"
          :on-reset="handleResetSettings"
        >
          <ProviderApiKeyInput
            v-model="apiKey"
            :provider-name="providerMetadata?.localizedName"
            placeholder="FunASR access token"
          />
          <FieldCombobox
            v-model="model"
            label="Model"
            description="SenseVoiceSmall is faster; Paraformer ZH runs a VAD + punctuation pipeline."
            :options="MODEL_OPTIONS"
            placeholder="Select a model..."
          />
        </ProviderBasicSettings>

        <ProviderAdvancedSettings :title="t('settings.pages.providers.common.section.advanced.title')">
          <ProviderBaseUrlInput
            v-model="baseUrl"
            :placeholder="DEFAULT_BASE_URL"
          />
        </ProviderAdvancedSettings>

        <div class="text-sm text-neutral-500 dark:text-neutral-400" flex="~ col gap-1">
          <p>
            Access token is the value of <code>access_token.txt</code> next to the FunASR server.
          </p>
          <p>
            If the browser rejects the self-signed certificate, set the base URL to
            <code>/funasr/v1/</code> to use the same-origin dev proxy instead.
          </p>
        </div>

        <Alert v-if="!isValid && isValidating === 0 && validationMessage" tone="danger" :title="t('settings.dialogs.onboarding.validationFailed')">
          <div :class="['whitespace-pre-wrap break-all']">
            {{ validationMessage }}
          </div>
          <template #actions>
            <Button size="sm" color="red" @click="forceValid">
              {{ t('settings.pages.providers.common.continueAnyway') }}
            </Button>
          </template>
        </Alert>
        <Alert v-if="isValid && isValidating === 0" tone="success" :title="t('settings.dialogs.onboarding.validationSuccess')" />
      </ProviderSettingsContainer>

      <div flex="~ col gap-6" class="w-full md:w-[55%]">
        <div w-full rounded-xl>
          <TranscriptionPlayground
            :generate-transcription="handleGenerateTranscription"
            :api-key-configured="apiKeyConfigured"
          />
        </div>
      </div>
    </div>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
