<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMikaSettingsStore } from '../../../stores/mika'

const { t } = useI18n()
const settings = useMikaSettingsStore()
const isAndroid = Capacitor.getPlatform() === 'android'

const testing = ref(false)
const testError = ref('')
const serverVersion = ref('')

async function testConnection() {
  if (testing.value)
    return

  testing.value = true
  testError.value = ''
  serverVersion.value = ''

  try {
    const client = settings.createClient({ requireEnabled: false })
    if (!client) {
      testError.value = t('settings.pages.system.mika.test.missing')
      return
    }

    const info = await client.getServerInfo()
    serverVersion.value = info.serverVersion ?? 'unknown'
  }
  catch (error) {
    testError.value = errorMessageFrom(error) ?? 'Unknown error'
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-5 pb-12']">
    <p :class="['text-sm text-neutral-600', 'md:text-base dark:text-neutral-300']">
      {{ t('settings.pages.system.mika.description') }}
    </p>

    <p v-if="!isAndroid" :class="['text-sm text-amber-600 dark:text-amber-400']">
      {{ t('settings.pages.system.mika.native-only') }}
    </p>

    <div v-else :class="['flex flex-col gap-4 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']">
      <FieldCheckbox
        v-model="settings.enabled"
        :label="t('settings.pages.system.mika.enabled.label')"
        :description="t('settings.pages.system.mika.enabled.description')"
      />

      <FieldInput
        v-model="settings.baseUrl"
        type="url"
        :label="t('settings.pages.system.mika.base-url.label')"
        :description="t('settings.pages.system.mika.base-url.description')"
        placeholder="http://127.0.0.1:8765"
      />

      <FieldInput
        v-model="settings.token"
        type="password"
        :label="t('settings.pages.system.mika.token.label')"
        :description="t('settings.pages.system.mika.token.description')"
      />

      <Button
        color="primary"
        variant="primary"
        block
        :loading="testing"
        :label="testing ? t('settings.pages.system.mika.test.testing') : t('settings.pages.system.mika.test.label')"
        @click="testConnection"
      />

      <p v-if="testError" :class="['text-sm text-red-500']">
        {{ t('settings.pages.system.mika.test.failed', { message: testError }) }}
      </p>
      <p v-else-if="serverVersion" :class="['text-sm text-green-600 dark:text-green-400']">
        {{ t('settings.pages.system.mika.test.success', { version: serverVersion }) }}
      </p>
    </div>

    <div
      v-if="isAndroid"
      :class="['flex flex-col gap-2 rounded-2xl p-4', 'bg-amber-50 dark:bg-amber-950/30']"
    >
      <span :class="['text-sm font-medium text-amber-700 dark:text-amber-300']">
        {{ t('settings.pages.system.mika.notice.title') }}
      </span>
      <p :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.mika.notice.body') }}
      </p>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.system.mika.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
