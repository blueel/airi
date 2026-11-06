<script setup lang="ts">
import { BasicButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { WATCH_ALONG_INTERVAL_OPTIONS } from '../../../../libs/watch-along'
import { useVisionStore } from '../../../../stores/modules/vision'
import { useWatchAlongStore } from '../../../../stores/watch-along'

const open = defineModel<boolean>({ default: false })

const { t } = useI18n()
const router = useRouter()
const watchAlong = useWatchAlongStore()
const vision = useVisionStore()
const {
  kind,
  intervalMs,
  running,
  starting,
  reading,
  lastError,
  lastFrame,
  lastSentAt,
  comments,
  previewStream,
} = storeToRefs(watchAlong)

const preview = useTemplateRef<HTMLVideoElement>('preview')
const intervalOptions = WATCH_ALONG_INTERVAL_OPTIONS.map(value => ({
  value,
  label: t('stage.chat.watch-along.interval-seconds', { seconds: value / 1000 }),
}))
const statusLine = computed(() => {
  if (starting.value)
    return t('stage.chat.watch-along.status-starting')
  if (reading.value)
    return t('stage.chat.watch-along.status-reading')
  if (running.value) {
    return comments.value
      ? t('stage.chat.watch-along.status-count', { count: comments.value })
      : t('stage.chat.watch-along.status-watching')
  }
  return t('stage.chat.watch-along.status-idle')
})
const lastSentLabel = computed(() => lastSentAt.value
  ? new Date(lastSentAt.value).toLocaleTimeString()
  : '—')

function attachPreview() {
  const video = preview.value
  if (!video)
    return
  video.srcObject = previewStream.value
  if (previewStream.value)
    void video.play().catch(() => {})
}

watch([previewStream, open], () => {
  void nextTick(attachPreview)
}, { flush: 'post' })

function openSettings(path: string) {
  open.value = false
  void router.push(path)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="open = $event">
    <DialogPortal>
      <DialogOverlay :class="['fixed inset-0 z-[9999] bg-black/40', 'data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn']" />
      <DialogContent
        :aria-describedby="undefined"
        :class="[
          'pointer-events-auto fixed left-1/2 top-1/2 z-[9999] max-h-[88dvh] w-[min(40rem,92dvw)] overflow-y-auto rounded-3xl p-5',
          '-translate-x-1/2 -translate-y-1/2 bg-neutral-50 text-neutral-900 shadow-xl outline-none',
          'dark:bg-neutral-900 dark:text-neutral-100 scrollbar-none',
          'data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow',
        ]"
      >
        <DialogTitle :class="['text-lg font-semibold tracking-tight']">
          {{ t('stage.chat.watch-along.title') }}
        </DialogTitle>
        <p :class="['mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('stage.chat.watch-along.description') }}
        </p>

        <div :class="['mt-4 overflow-hidden rounded-2xl bg-neutral-900']">
          <video
            v-if="previewStream"
            ref="preview"
            muted
            playsinline
            :class="['max-h-72 w-full object-contain']"
          />
          <img
            v-else-if="lastFrame"
            :src="lastFrame"
            alt=""
            :class="['max-h-72 w-full object-contain']"
          >
          <div v-else :class="['flex h-40 flex-col items-center justify-center gap-2 text-neutral-400']">
            <span aria-hidden="true" :class="['i-solar:eye-outline size-7']" />
            <span :class="['text-xs']">{{ t('stage.chat.watch-along.preview-empty') }}</span>
          </div>
        </div>

        <p
          v-if="kind === 'android-bubble'"
          :class="['mt-2 text-[11px] text-neutral-400']"
        >
          {{ t('stage.chat.watch-along.android-source') }}
        </p>
        <p v-else :class="['mt-2 text-[11px] text-neutral-400']">
          {{ t('stage.chat.watch-along.browser-source') }}
        </p>

        <div :class="['mt-4 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 dark:bg-neutral-800/50']">
          <p v-if="!vision.configured" :class="['text-xs text-amber-600 dark:text-amber-400']">
            {{ t('stage.chat.watch-along.errors.vision') }}
          </p>
          <BasicButton
            v-if="!vision.configured"
            :class="['h-9 self-start rounded-full px-4 text-xs font-medium']"
            @click="openSettings('/settings/modules/vision')"
          >
            {{ t('stage.chat.watch-along.open-vision') }}
          </BasicButton>

          <p v-if="kind === 'android-bubble' && !running" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
            {{ t('stage.chat.watch-along.android-hint') }}
          </p>
          <BasicButton
            v-if="kind === 'android-bubble' && !running"
            :class="['h-9 self-start rounded-full px-4 text-xs font-medium']"
            @click="openSettings('/settings/system/floating-assistant')"
          >
            {{ t('stage.chat.watch-along.open-bubble') }}
          </BasicButton>

          <div :class="['flex items-center gap-3']">
            <BasicButton
              :disabled="!vision.configured || starting"
              :class="[
                'h-9 min-w-24 rounded-full px-4 text-sm font-medium',
                running
                  ? 'bg-primary-500 text-white hover:bg-primary-600'
                  : 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-100',
                (!vision.configured || starting) && 'opacity-40',
              ]"
              @click="watchAlong.toggle()"
            >
              {{ starting
                ? t('stage.chat.watch-along.starting')
                : running
                  ? t('stage.chat.watch-along.stop')
                  : t('stage.chat.watch-along.start') }}
            </BasicButton>
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">{{ statusLine }}</span>
            <span :class="['ml-auto text-[11px] text-neutral-400']">
              {{ t('stage.chat.watch-along.last-look', { time: lastSentLabel }) }}
            </span>
          </div>

          <div :class="['flex flex-wrap items-center gap-2']">
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">{{ t('stage.chat.watch-along.interval') }}</span>
            <button
              v-for="option in intervalOptions"
              :key="option.value"
              type="button"
              :disabled="running || starting"
              :class="[
                'rounded-full px-3 py-1 text-xs outline-none transition-colors',
                intervalMs === option.value
                  ? 'bg-primary-500 text-white'
                  : 'bg-neutral-200/70 text-neutral-600 hover:bg-neutral-300/70 dark:bg-neutral-700/50 dark:text-neutral-300',
                (running || starting) && 'cursor-not-allowed opacity-50',
              ]"
              @click="intervalMs = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <p v-if="lastError" :class="['text-xs text-red-500']">
            {{ lastError }}
          </p>
          <p :class="['text-[11px] text-neutral-400']">
            {{ t('stage.chat.watch-along.notice') }}
          </p>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
