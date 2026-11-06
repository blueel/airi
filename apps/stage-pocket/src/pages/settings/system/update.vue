<script setup lang="ts">
import type { PluginListenerHandle } from '@capacitor/core'

import type { UpdateCheckResult } from '../../../modules/app-updater'

import { Capacitor } from '@capacitor/core'
import { errorMessageFrom } from '@moeru/std'
import { useLocalStorage } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  AppUpdater,
  DEFAULT_UPDATE_MANIFEST_URL,
  UPDATE_MANIFEST_URL_KEY,
} from '../../../modules/app-updater'

const { t } = useI18n()

const manifestUrl = useLocalStorage(UPDATE_MANIFEST_URL_KEY, DEFAULT_UPDATE_MANIFEST_URL)
const isNative = Capacitor.isNativePlatform()

const currentVersion = ref('')
const result = ref<UpdateCheckResult | null>(null)
const checking = ref(false)
const downloading = ref(false)
const installing = ref(false)
const progress = ref({ received: 0, total: 0 })
const downloaded = ref<{ bytes: number } | null>(null)
const error = ref('')
const needsInstallPermission = ref(false)

let progressListener: PluginListenerHandle | undefined

onMounted(async () => {
  if (!isNative)
    return

  progressListener = await AppUpdater.addListener('downloadProgress', (payload) => {
    progress.value = payload
  })

  try {
    const version = await AppUpdater.getVersion()
    currentVersion.value = `${version.versionName} (${version.versionCode})`
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Unknown error'
  }
})

onUnmounted(async () => {
  await progressListener?.remove()
})

const percent = computed(() => {
  if (progress.value.total <= 0)
    return 0
  return Math.min(100, Math.round((progress.value.received / progress.value.total) * 100))
})

const downloadedSize = computed(() => {
  if (!downloaded.value)
    return ''
  return `${(downloaded.value.bytes / 1024 / 1024).toFixed(1)} MB`
})

const noteLines = computed(() => {
  const notes = result.value?.latest.notes?.trim()
  if (!notes)
    return []
  return notes
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
})

function messageOf(cause: unknown) {
  return errorMessageFrom(cause) ?? 'Unknown error'
}

async function checkForUpdates() {
  if (!isNative || checking.value)
    return
  error.value = ''
  result.value = null
  downloaded.value = null
  needsInstallPermission.value = false
  checking.value = true
  try {
    result.value = await AppUpdater.check({ url: manifestUrl.value })
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
  finally {
    checking.value = false
  }
}

async function downloadUpdate() {
  if (!result.value || downloading.value)
    return
  error.value = ''
  downloading.value = true
  progress.value = { received: 0, total: result.value.latest.size }
  try {
    downloaded.value = await AppUpdater.download({
      url: result.value.latest.url,
      sha256: result.value.latest.sha256,
    })
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
  finally {
    downloading.value = false
  }
}

async function installUpdate() {
  if (installing.value)
    return
  error.value = ''
  installing.value = true
  try {
    const outcome = await AppUpdater.install()
    needsInstallPermission.value = outcome.needsPermission === true
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
  finally {
    installing.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-5 pb-12']">
    <p :class="['text-sm text-neutral-600', 'md:text-base dark:text-neutral-300']">
      {{ t('settings.pages.system.update.description') }}
    </p>

    <div :class="['flex flex-col gap-3 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']">
      <div :class="['flex items-center justify-between gap-3']">
        <span :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.system.update.current-version') }}
        </span>
        <span :class="['text-sm font-medium']">{{ currentVersion || '—' }}</span>
      </div>

      <label :class="['flex flex-col gap-1']">
        <span :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.system.update.manifest-url') }}
        </span>
        <input
          v-model="manifestUrl"
          type="url"
          :class="[
            'w-full rounded-xl px-3 py-2 text-sm outline-none',
            'bg-white dark:bg-neutral-900',
            'border border-neutral-200 dark:border-neutral-700',
            'focus:border-primary-400',
          ]"
        >
        <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">
          {{ t('settings.pages.system.update.manifest-url-description') }}
        </span>
      </label>

      <button
        :disabled="!isNative || checking"
        :class="[
          'mt-1 rounded-xl px-4 py-2.5 text-sm font-medium text-white',
          'bg-primary-500 active:bg-primary-600 disabled:opacity-50',
        ]"
        @click="checkForUpdates"
      >
        {{ checking ? t('settings.pages.system.update.checking') : t('settings.pages.system.update.check') }}
      </button>

      <p v-if="!isNative" :class="['text-xs text-amber-600 dark:text-amber-400']">
        {{ t('settings.pages.system.update.native-only') }}
      </p>
    </div>

    <div
      v-if="result"
      :class="['flex flex-col gap-3 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']"
    >
      <template v-if="result.updateAvailable">
        <div :class="['flex flex-col gap-1']">
          <span :class="['text-base font-medium']">
            {{ t('settings.pages.system.update.available', { version: result.latest.versionName }) }}
          </span>
          <span v-if="result.latest.publishedAt" :class="['text-xs text-neutral-400']">
            {{ result.latest.publishedAt }}
          </span>
        </div>

        <div v-if="noteLines.length" :class="['flex flex-col gap-1']">
          <span :class="['text-sm text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.system.update.notes') }}
          </span>
          <ul :class="['list-disc pl-5', 'flex flex-col gap-1 text-sm']">
            <li v-for="(line, index) in noteLines" :key="index">
              {{ line }}
            </li>
          </ul>
        </div>

        <div v-if="downloading" :class="['flex flex-col gap-1']">
          <div :class="['h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700']">
            <div
              :class="['h-full rounded-full bg-primary-500 transition-all']"
              :style="{ width: `${percent}%` }"
            />
          </div>
          <span :class="['text-xs text-neutral-500']">
            {{ t('settings.pages.system.update.downloading', { percent }) }}
          </span>
        </div>

        <template v-else>
          <span v-if="downloaded" :class="['text-sm text-green-600 dark:text-green-400']">
            {{ t('settings.pages.system.update.downloaded', { size: downloadedSize }) }}
          </span>

          <button
            v-if="!downloaded"
            :class="[
              'rounded-xl px-4 py-2.5 text-sm font-medium text-white',
              'bg-primary-500 active:bg-primary-600 disabled:opacity-50',
            ]"
            @click="downloadUpdate"
          >
            {{ t('settings.pages.system.update.download') }}
          </button>
          <button
            v-else
            :disabled="installing"
            :class="[
              'rounded-xl px-4 py-2.5 text-sm font-medium text-white',
              'bg-primary-500 active:bg-primary-600 disabled:opacity-50',
            ]"
            @click="installUpdate"
          >
            {{ installing ? t('settings.pages.system.update.installing') : t('settings.pages.system.update.install') }}
          </button>

          <p v-if="needsInstallPermission" :class="['text-xs text-amber-600 dark:text-amber-400']">
            {{ t('settings.pages.system.update.install-permission') }}
          </p>
        </template>
      </template>

      <p v-else :class="['text-sm text-green-600 dark:text-green-400']">
        {{ t('settings.pages.system.update.up-to-date') }}
      </p>
    </div>

    <p v-if="error" :class="['text-sm text-red-500']">
      {{ t('settings.pages.system.update.failed', { message: error }) }}
    </p>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.system.update.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
