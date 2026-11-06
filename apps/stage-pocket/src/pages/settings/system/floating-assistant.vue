<script setup lang="ts">
import type { FloatingAssistantStatus } from '../../../modules/floating-assistant'

import { LocalNotifications } from '@capacitor/local-notifications'
import { errorMessageFrom } from '@moeru/std'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { Button, FieldCheckbox } from '@proj-airi/ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { FloatingAssistant, isFloatingAssistantSupported } from '../../../modules/floating-assistant'
import { MicrophonePermission } from '../../../modules/microphone-permission'
import { useFloatingAssistantWakeWordStore } from '../../../stores/floating-assistant-wake-word'

const { t } = useI18n()
const router = useRouter()
const supported = isFloatingAssistantSupported()
const consciousness = useConsciousnessStore()
const vision = useVisionStore()
const speech = useSpeechStore()
const wakeWord = useFloatingAssistantWakeWordStore()

const status = ref<FloatingAssistantStatus | null>(null)
const busy = ref(false)
const error = ref('')
const notificationsDenied = ref(false)

const running = computed(() => status.value?.running === true)
const overlayPermission = computed(() => status.value?.overlayPermission === true)
const microphonePermission = computed(() => status.value?.microphonePermission === true)
const microphoneMissing = computed(() => status.value != null && !microphonePermission.value)

/** The chat model reads the image itself, or a vision provider reads it before the chat model replies. */
const imagesHaveReader = computed(() => {
  const modelReadsImages = consciousness.providerModels.some(model =>
    model.id === consciousness.activeModel && model.metadata?.abilities?.vision === true)
  return modelReadsImages || (vision.configured && vision.useForChat)
})

/** One line that explains what the native listener does now. */
const wakeWordStatusText = computed(() => {
  if (!wakeWord.enabled)
    return t('settings.pages.system.floating-assistant.wake-word.status.stopped')
  if (!running.value)
    return t('settings.pages.system.floating-assistant.wake-word.start-bubble')

  switch (wakeWord.state) {
    case 'listening':
      return t('settings.pages.system.floating-assistant.wake-word.status.listening')
    case 'command':
      return t('settings.pages.system.floating-assistant.wake-word.status.command')
    case 'paused':
      return t('settings.pages.system.floating-assistant.wake-word.status.paused')
    default:
      return t('settings.pages.system.floating-assistant.wake-word.status.stopped')
  }
})

async function refresh() {
  if (!supported)
    return
  try {
    status.value = await FloatingAssistant.status()
    void wakeWord.refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.system.floating-assistant.errors.status')
  }
}

async function enable() {
  if (busy.value)
    return

  busy.value = true
  error.value = ''
  notificationsDenied.value = false

  try {
    const notification = await LocalNotifications.checkPermissions()
    if (notification.display === 'prompt' || notification.display === 'prompt-with-rationale') {
      const requested = await LocalNotifications.requestPermissions()
      notificationsDenied.value = requested.display !== 'granted'
    }
    else {
      notificationsDenied.value = notification.display !== 'granted'
    }

    // Hold-to-talk records with the native speech recognizer, so the bubble needs the microphone once.
    await MicrophonePermission.requestPermission()

    await FloatingAssistant.start()
    // The service creates its bubble on the main thread. Give it a moment before the page reports a failure.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      status.value = await FloatingAssistant.status()
      if (status.value.running)
        break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!running.value)
      error.value = t('settings.pages.system.floating-assistant.errors.not-running')
    else
      void wakeWord.sync()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.system.floating-assistant.errors.start')
  }
  finally {
    busy.value = false
  }
}

async function disable() {
  if (busy.value)
    return

  busy.value = true
  error.value = ''
  try {
    await FloatingAssistant.stop()
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.system.floating-assistant.errors.stop')
  }
  finally {
    busy.value = false
  }
}

async function grantMicrophone() {
  try {
    await MicrophonePermission.requestPermission()
    await wakeWord.sync()
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.system.floating-assistant.errors.microphone')
  }
}

function openSettings(path: string) {
  void router.push(path)
}

function refreshWhenVisible() {
  if (document.visibilityState === 'visible')
    void refresh()
}

onMounted(() => {
  void refresh()
  document.addEventListener('visibilitychange', refreshWhenVisible)
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', refreshWhenVisible)
})
</script>

<template>
  <div :class="['flex flex-col gap-5 pb-12']">
    <p :class="['text-sm text-neutral-600', 'md:text-base dark:text-neutral-300']">
      {{ t('settings.pages.system.floating-assistant.description') }}
    </p>

    <p v-if="!supported" :class="['text-sm text-amber-600 dark:text-amber-400']">
      {{ t('settings.pages.system.floating-assistant.native-only') }}
    </p>

    <div v-else :class="['flex flex-col gap-4 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']">
      <div :class="['flex items-center justify-between gap-3']">
        <span :class="['text-sm font-medium']">
          {{ t('settings.pages.system.floating-assistant.status.bubble') }}
        </span>
        <span :class="running ? 'text-green-600 dark:text-green-400' : 'text-neutral-500 dark:text-neutral-400'">
          {{ running ? t('settings.pages.system.floating-assistant.status.running') : t('settings.pages.system.floating-assistant.status.stopped') }}
        </span>
      </div>

      <div :class="['flex items-center justify-between gap-3']">
        <span :class="['text-sm font-medium']">
          {{ t('settings.pages.system.floating-assistant.status.overlay') }}
        </span>
        <span :class="overlayPermission ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
          {{ overlayPermission ? t('settings.pages.system.floating-assistant.status.granted') : t('settings.pages.system.floating-assistant.status.denied') }}
        </span>
      </div>

      <div :class="['flex items-center justify-between gap-3']">
        <span :class="['text-sm font-medium']">
          {{ t('settings.pages.system.floating-assistant.status.microphone') }}
        </span>
        <span :class="microphonePermission ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
          {{ microphonePermission ? t('settings.pages.system.floating-assistant.status.granted') : t('settings.pages.system.floating-assistant.status.denied') }}
        </span>
      </div>

      <Button
        v-if="!running"
        color="primary"
        variant="primary"
        block
        :loading="busy"
        :label="busy ? t('settings.pages.system.floating-assistant.enable.busy') : t('settings.pages.system.floating-assistant.enable.label')"
        @click="enable"
      />
      <Button
        v-else
        color="red"
        variant="secondary"
        block
        :loading="busy"
        :label="t('settings.pages.system.floating-assistant.disable.label')"
        @click="disable"
      />

      <p v-if="error" :class="['text-sm text-red-500']">
        {{ error }}
      </p>
      <p v-if="notificationsDenied" :class="['text-sm text-amber-600 dark:text-amber-400']">
        {{ t('settings.pages.system.floating-assistant.notice.notifications-denied') }}
      </p>
    </div>

    <div
      v-if="supported"
      :class="['flex flex-col gap-3 rounded-2xl p-4', 'bg-neutral-100/70 dark:bg-neutral-800/60']"
    >
      <FieldCheckbox
        :model-value="wakeWord.enabled"
        :disabled="wakeWord.phrases.length === 0 || wakeWord.busy"
        :label="t('settings.pages.system.floating-assistant.wake-word.title')"
        :description="wakeWord.phrases.length
          ? t('settings.pages.system.floating-assistant.wake-word.phrases', { phrases: wakeWord.phrases.join(' / ') })
          : t('settings.pages.system.floating-assistant.wake-word.no-phrases')"
        @update:model-value="wakeWord.setEnabled"
      />

      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ wakeWordStatusText }}
      </p>
      <p v-if="wakeWord.error" :class="['text-sm text-red-500']">
        {{ wakeWord.error }}
      </p>
      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.system.floating-assistant.wake-word.notice') }}
      </p>
      <Button
        v-if="wakeWord.phrases.length === 0"
        color="primary"
        variant="secondary"
        :label="t('settings.pages.system.floating-assistant.wake-word.open-settings')"
        @click="openSettings('/settings/modules/hearing/wake-words')"
      />
    </div>

    <div
      v-if="supported"
      :class="['flex flex-col gap-2 rounded-2xl p-4', 'bg-amber-50 dark:bg-amber-950/30']"
    >
      <span :class="['text-sm font-medium text-amber-700 dark:text-amber-300']">
        {{ t('settings.pages.system.floating-assistant.notice.title') }}
      </span>
      <p :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.floating-assistant.notice.body') }}
      </p>
      <p :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.floating-assistant.notice.background') }}
      </p>
      <p v-if="microphoneMissing" :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.floating-assistant.notice.microphone-denied') }}
      </p>
      <Button
        v-if="microphoneMissing"
        color="amber"
        variant="secondary"
        :label="t('settings.pages.system.floating-assistant.actions.grant-microphone')"
        @click="grantMicrophone"
      />
      <p v-if="!speech.configured" :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.floating-assistant.notice.voice') }}
      </p>
      <Button
        v-if="!speech.configured"
        color="amber"
        variant="secondary"
        :label="t('settings.pages.system.floating-assistant.actions.open-speech')"
        @click="openSettings('/settings/modules/speech')"
      />
      <p v-if="!imagesHaveReader" :class="['text-sm text-amber-700/90 dark:text-amber-200/80']">
        {{ t('settings.pages.system.floating-assistant.notice.vision') }}
      </p>
      <Button
        v-if="!imagesHaveReader"
        color="amber"
        variant="secondary"
        :label="t('settings.pages.system.floating-assistant.actions.open-vision')"
        @click="openSettings('/settings/modules/vision')"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.system.floating-assistant.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.system.floating-assistant.description
  icon: i-solar:screen-share-bold-duotone
  stageTransition:
    name: slide
</route>
