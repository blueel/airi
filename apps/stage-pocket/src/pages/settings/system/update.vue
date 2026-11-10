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
  AUTO_INSTALL_KEY,
} from '../../../modules/app-updater'
import {
  applyBundleUpdate,
  autoLiveUpdate,
  bundleCheck,
  bundleChecking,
  bundleError,
  bundleProgress,
  bundleStaged,
  bundleState,
  bundleSupported,
  bundleSyncing,
  checkBundleUpdate,
  manifestUrl,
  refreshBundleState,
  syncBundleUpdate,
} from '../../../modules/bundle-updater'

const { t } = useI18n()

const isNative = Capacitor.isNativePlatform()
const isAndroid = Capacitor.getPlatform() === 'android'
const autoInstall = useLocalStorage(AUTO_INSTALL_KEY, true)
const autoConfirmEnabled = ref(false)

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

  document.addEventListener('visibilitychange', onVisibilityChange)

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

  await refreshInstallState()

  if (isAndroid) {
    void refreshBundleState()
    void checkBundleUpdate({ quiet: true })
  }
})

onUnmounted(async () => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  await progressListener?.remove()
})

const percent = computed(() => {
  if (progress.value.total <= 0)
    return 0
  return Math.min(100, Math.round((progress.value.received / progress.value.total) * 100))
})

const bundlePercent = computed(() => {
  if (bundleProgress.value.total <= 0)
    return bundleProgress.value.phase === 'done' ? 100 : 0
  return Math.min(100, Math.round((bundleProgress.value.received / bundleProgress.value.total) * 100))
})

const bundleDownloadSize = computed(() => sizeLabel(bundleCheck.value?.plan.bytes ?? 0))

function sizeLabel(bytes: number) {
  if (bytes <= 0)
    return '0 MB'
  if (bytes < 1024 * 1024)
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function checkBundle() {
  await checkBundleUpdate()
}

async function downloadBundle() {
  await syncBundleUpdate()
}

async function applyBundle() {
  await applyBundleUpdate()
}

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

  if (downloaded.value && autoInstall.value && isAndroid)
    await installUpdate()
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

/** Reads whether the owner enabled the accessibility service that taps the install button. */
async function refreshInstallState() {
  if (!isAndroid)
    return
  try {
    const status = await AppUpdater.autoInstallStatus()
    autoConfirmEnabled.value = status.accessibilityEnabled
  }
  catch (cause) {
    console.warn('Could not read the auto-install state:', errorMessageFrom(cause) ?? 'unknown error')
  }
}

async function openAccessibilitySettings() {
  try {
    await AppUpdater.openAccessibilitySettings()
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
}

async function openAppSettings() {
  try {
    await AppUpdater.openAppSettings()
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
}

/** After the owner grants "install unknown apps", finish the install without another tap. */
async function retryInstallAfterPermission() {
  if (!needsInstallPermission.value || !downloaded.value || installing.value)
    return
  try {
    const permission = await AppUpdater.canInstall()
    if (!permission.canInstall)
      return
    needsInstallPermission.value = false
    await installUpdate()
  }
  catch (cause) {
    error.value = messageOf(cause)
  }
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible')
    return
  void refreshInstallState()
  void retryInstallAfterPermission()
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

      <div
        v-if="isAndroid"
        :class="['flex flex-col gap-3 rounded-xl p-3', 'bg-white dark:bg-neutral-900']"
      >
        <label :class="['flex items-start gap-3']">
          <input v-model="autoInstall" type="checkbox" :class="['mt-0.5 h-4 w-4']">
          <span :class="['flex flex-col gap-0.5']">
            <span :class="['text-sm font-medium']">
              {{ t('settings.pages.system.update.auto-install.label') }}
            </span>
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
              {{ t('settings.pages.system.update.auto-install.description') }}
            </span>
          </span>
        </label>

        <div :class="['flex items-center justify-between gap-3']">
          <span :class="['text-sm font-medium']">
            {{ t('settings.pages.system.update.auto-confirm.label') }}
          </span>
          <span :class="autoConfirmEnabled ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
            {{ autoConfirmEnabled ? t('settings.pages.system.update.auto-confirm.enabled') : t('settings.pages.system.update.auto-confirm.disabled') }}
          </span>
        </div>
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.system.update.auto-confirm.description') }}
        </p>
        <div :class="['flex flex-wrap gap-2']">
          <button
            :class="[
              'rounded-lg px-3 py-1.5 text-xs font-medium',
              'bg-neutral-200 text-neutral-700 active:bg-neutral-300',
              'dark:bg-neutral-800 dark:text-neutral-200 dark:active:bg-neutral-700',
            ]"
            @click="openAccessibilitySettings"
          >
            {{ t('settings.pages.system.update.auto-confirm.open') }}
          </button>
          <button
            :class="[
              'rounded-lg px-3 py-1.5 text-xs font-medium',
              'bg-neutral-200 text-neutral-700 active:bg-neutral-300',
              'dark:bg-neutral-800 dark:text-neutral-200 dark:active:bg-neutral-700',
            ]"
            @click="openAppSettings"
          >
            {{ t('settings.pages.system.update.auto-confirm.open-app-settings') }}
          </button>
        </div>
        <p v-if="!autoConfirmEnabled" :class="['text-xs text-amber-600 dark:text-amber-400']">
          {{ t('settings.pages.system.update.auto-confirm.restricted') }}
        </p>
      </div>
    </div>

    <div
      v-if="isAndroid && bundleSupported"
      :class="['flex flex-col gap-3 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']"
    >
      <div :class="['flex items-center justify-between gap-3']">
        <span :class="['text-sm font-medium']">
          {{ t('settings.pages.system.update.bundle.title') }}
        </span>
        <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ bundleState?.source === 'downloaded'
            ? t('settings.pages.system.update.bundle.source-downloaded', { id: bundleState?.id })
            : t('settings.pages.system.update.bundle.source-builtin') }}
        </span>
      </div>

      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.system.update.bundle.description') }}
      </p>

      <label :class="['flex items-start gap-3']">
        <input v-model="autoLiveUpdate" type="checkbox" :class="['mt-0.5 h-4 w-4']">
        <span :class="['flex flex-col gap-0.5']">
          <span :class="['text-sm font-medium']">
            {{ t('settings.pages.system.update.bundle.auto.label') }}
          </span>
          <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.system.update.bundle.auto.description') }}
          </span>
        </span>
      </label>

      <button
        :disabled="bundleChecking || bundleSyncing"
        :class="[
          'rounded-xl px-4 py-2.5 text-sm font-medium text-white',
          'bg-primary-500 active:bg-primary-600 disabled:opacity-50',
        ]"
        @click="checkBundle"
      >
        {{ bundleChecking ? t('settings.pages.system.update.bundle.checking') : t('settings.pages.system.update.bundle.check') }}
      </button>

      <div v-if="bundleSyncing" :class="['flex flex-col gap-1']">
        <div :class="['h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700']">
          <div
            :class="['h-full rounded-full bg-primary-500 transition-all']"
            :style="{ width: `${bundlePercent}%` }"
          />
        </div>
        <span :class="['text-xs text-neutral-500']">
          {{ bundleProgress.phase === 'prepare'
            ? t('settings.pages.system.update.bundle.preparing')
            : t('settings.pages.system.update.bundle.downloading', { percent: bundlePercent }) }}
        </span>
      </div>

      <div v-else-if="bundleStaged" :class="['flex flex-col gap-2']">
        <span :class="['text-sm text-green-600 dark:text-green-400']">
          {{ t('settings.pages.system.update.bundle.staged') }}
        </span>
        <button
          :class="[
            'rounded-xl px-4 py-2.5 text-sm font-medium text-white',
            'bg-primary-500 active:bg-primary-600',
          ]"
          @click="applyBundle"
        >
          {{ t('settings.pages.system.update.bundle.apply') }}
        </button>
      </div>

      <template v-else-if="bundleCheck">
        <p v-if="bundleCheck.reason === 'up-to-date'" :class="['text-sm text-green-600 dark:text-green-400']">
          {{ t('settings.pages.system.update.bundle.up-to-date') }}
        </p>
        <p v-else-if="bundleCheck.reason === 'native-required'" :class="['text-sm text-amber-600 dark:text-amber-400']">
          {{ t('settings.pages.system.update.bundle.native-required', { version: bundleCheck.latest.nativeVersion }) }}
        </p>
        <p v-else-if="bundleCheck.reason === 'failed-before'" :class="['text-sm text-amber-600 dark:text-amber-400']">
          {{ t('settings.pages.system.update.bundle.failed-before') }}
        </p>
        <template v-else-if="bundleCheck.available">
          <span :class="['text-sm']">
            {{ t('settings.pages.system.update.bundle.available', {
              version: bundleCheck.latest.versionName,
              files: bundleCheck.plan.files,
              size: bundleDownloadSize,
            }) }}
          </span>
          <button
            :class="[
              'rounded-xl px-4 py-2.5 text-sm font-medium text-white',
              'bg-primary-500 active:bg-primary-600',
            ]"
            @click="downloadBundle"
          >
            {{ t('settings.pages.system.update.bundle.download') }}
          </button>
        </template>
      </template>

      <p v-if="bundleError" :class="['text-sm text-red-500']">
        {{ t('settings.pages.system.update.failed', { message: bundleError }) }}
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
