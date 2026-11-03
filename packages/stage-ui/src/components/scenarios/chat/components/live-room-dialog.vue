<script setup lang="ts">
import type { LiveRoomRect } from '../../../../libs/live-room'

import { BasicButton, GhostButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  liveRoomRectFromPoints,
  liveRoomRectIsUsable,
} from '../../../../libs/live-room'
import { LIVE_ROOM_INTERVAL_OPTIONS, useLiveRoomStore } from '../../../../stores/live-room'

const open = defineModel<boolean>({ default: false })

const { t } = useI18n()
const liveRoom = useLiveRoomStore()
const {
  intervalMs,
  lastError,
  lastReadAt,
  reading,
  recent,
  received,
  region,
  ocrState,
  running,
  sendToChat,
  sharing,
  stream,
} = storeToRefs(liveRoom)

const preview = useTemplateRef<HTMLVideoElement>('preview')
const surface = useTemplateRef<HTMLElement>('surface')
/** The frame shape of the shared screen, so the preview has the same shape and a region maps onto it directly. */
const frame = ref({ width: 16, height: 9 })
/** The region that a drag is drawing right now. */
const drafting = shallowRef<LiveRoomRect | null>(null)
const dragStart = shallowRef<{ x: number, y: number } | null>(null)

const shownRegion = computed(() => drafting.value ?? region.value)
const previewStyle = computed(() => ({ aspectRatio: `${frame.value.width} / ${frame.value.height}` }))
const regionLabel = computed(() => {
  const shown = shownRegion.value
  if (!shown)
    return ''
  return `${Math.round(shown.width * 100)}% × ${Math.round(shown.height * 100)}%`
})
const statusLine = computed(() => {
  if (ocrState.value === 'loading')
    return t('stage.chat.live-room.status-loading-model')
  if (!sharing.value)
    return t('stage.chat.live-room.status-idle')
  if (!running.value)
    return t('stage.chat.live-room.status-ready')
  if (reading.value)
    return t('stage.chat.live-room.status-reading')
  return t('stage.chat.live-room.status-count', { count: received.value })
})
const lastReadLabel = computed(() => lastReadAt.value
  ? new Date(lastReadAt.value).toLocaleTimeString()
  : '—')
const intervalOptions = LIVE_ROOM_INTERVAL_OPTIONS.map(value => ({
  value,
  label: t('stage.chat.live-room.interval-seconds', { seconds: value / 1000 }),
}))

function attachPreview() {
  const video = preview.value
  if (!video)
    return

  video.srcObject = stream.value
  if (stream.value)
    void video.play().catch(() => {})
}

watch([stream, open], attachPreview, { flush: 'post' })
// The models are large, so opening the panel starts loading them while the region is drawn.
watch(open, (opened) => {
  if (opened)
    void liveRoom.prepareReader()
})

function handleLoadedMetadata() {
  const video = preview.value
  if (!video)
    return
  frame.value = {
    width: video.videoWidth || 16,
    height: video.videoHeight || 9,
  }
}

function pointFromEvent(event: PointerEvent) {
  const bounds = surface.value?.getBoundingClientRect()
  if (!bounds || !bounds.width || !bounds.height)
    return { x: 0, y: 0 }
  return {
    x: (event.clientX - bounds.left) / bounds.width,
    y: (event.clientY - bounds.top) / bounds.height,
  }
}

function handlePointerDown(event: PointerEvent) {
  if (!sharing.value)
    return
  event.preventDefault()
  const target = event.currentTarget
  if (target instanceof Element && 'setPointerCapture' in target)
    (target as Element & { setPointerCapture: (id: number) => void }).setPointerCapture(event.pointerId)

  dragStart.value = pointFromEvent(event)
  drafting.value = { ...dragStart.value, width: 0, height: 0 }
}

function handlePointerMove(event: PointerEvent) {
  if (!dragStart.value)
    return
  drafting.value = liveRoomRectFromPoints(dragStart.value, pointFromEvent(event))
}

function handlePointerUp(event: PointerEvent) {
  const start = dragStart.value
  dragStart.value = null
  drafting.value = null
  if (!start)
    return

  const next = liveRoomRectFromPoints(start, pointFromEvent(event))
  // A click or a jitter leaves the region that already works.
  if (liveRoomRectIsUsable(next))
    liveRoom.setRegion(next)
}

function regionStyle(rect: LiveRoomRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

async function handleShare() {
  if (sharing.value)
    return
  await liveRoom.share().catch(() => {})
}

function handleClearRegion() {
  liveRoom.setRegion(null)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="open = $event">
    <DialogPortal>
      <DialogOverlay :class="['fixed inset-0 z-[9999] bg-black/40', 'data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn']" />
      <DialogContent
        :aria-describedby="undefined"
        :class="[
          'pointer-events-auto fixed left-1/2 top-1/2 z-[9999] max-h-[88dvh] w-[min(44rem,92dvw)] overflow-y-auto rounded-3xl p-5',
          '-translate-x-1/2 -translate-y-1/2 bg-neutral-50 text-neutral-900 shadow-xl outline-none',
          'dark:bg-neutral-900 dark:text-neutral-100 scrollbar-none',
          'data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow',
        ]"
      >
        <DialogTitle :class="['text-lg font-semibold tracking-tight']">
          {{ t('stage.chat.live-room.title') }}
        </DialogTitle>
        <p :class="['mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('stage.chat.live-room.description') }}
        </p>

        <!-- The shared screen and the region that a drag selects on it. -->
        <div v-if="sharing" :class="['mt-4']">
          <div
            ref="surface"
            :style="previewStyle"
            :class="[
              'relative w-full overflow-hidden rounded-2xl bg-neutral-900 select-none',
              'touch-none cursor-crosshair',
            ]"
            @pointerdown="handlePointerDown"
            @pointermove="handlePointerMove"
            @pointerup="handlePointerUp"
            @pointercancel="handlePointerUp"
          >
            <video
              ref="preview"
              muted
              playsinline
              :class="['h-full w-full object-contain']"
              @loadedmetadata="handleLoadedMetadata"
            />
            <div
              v-if="shownRegion"
              :class="[
                'pointer-events-none absolute border-2 border-primary-400',
                'shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]',
              ]"
              :style="regionStyle(shownRegion)"
            >
              <span
                v-if="regionLabel"
                :class="[
                  'absolute -top-6 left-0 rounded-md bg-primary-500 px-1.5 py-0.5 text-[10px] text-white font-medium',
                ]"
              >
                {{ regionLabel }}
              </span>
            </div>
            <div
              v-else
              :class="[
                'pointer-events-none absolute inset-5 flex items-center justify-center rounded-xl',
                'border-2 border-dashed border-white/60',
              ]"
            >
              <span :class="['rounded-md bg-black/40 px-2 py-1 text-xs text-white/90']">
                {{ t('stage.chat.live-room.draw-region') }}
              </span>
            </div>
          </div>
          <div :class="['mt-2 flex flex-wrap items-center gap-2']">
            <GhostButton size="sm" @click="handleClearRegion">
              {{ t('stage.chat.live-room.clear-region') }}
            </GhostButton>
            <GhostButton size="sm" @click="liveRoom.stopSharing()">
              {{ t('stage.chat.live-room.stop-sharing') }}
            </GhostButton>
            <span :class="['ml-auto text-[11px] text-neutral-400']">
              {{ t('stage.chat.live-room.region-hint') }}
            </span>
          </div>
        </div>
        <BasicButton
          v-else
          block
          size="unset"
          :class="['mt-4 h-24 flex flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-neutral-300 dark:border-neutral-700']"
          @click="handleShare"
        >
          <span aria-hidden="true" :class="['i-solar:crop-outline size-6']" />
          <span :class="['text-sm font-medium']">{{ t('stage.chat.live-room.share-screen') }}</span>
          <span :class="['text-[11px] text-neutral-400']">{{ t('stage.chat.live-room.share-screen-hint') }}</span>
        </BasicButton>

        <!-- The switches of the reader. -->
        <div :class="['mt-4 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 dark:bg-neutral-800/50']">
          <div :class="['flex items-center gap-3']">
            <BasicButton
              :disabled="!sharing"
              :class="[
                'h-9 min-w-24 rounded-full px-4 text-sm font-medium',
                running
                  ? 'bg-primary-500 text-white hover:bg-primary-600'
                  : 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-100',
                !sharing && 'opacity-40',
              ]"
              @click="liveRoom.toggleReading()"
            >
              {{ running ? t('stage.chat.live-room.stop') : t('stage.chat.live-room.start') }}
            </BasicButton>
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">{{ statusLine }}</span>
            <span :class="['ml-auto text-[11px] text-neutral-400']">
              {{ t('stage.chat.live-room.last-read', { time: lastReadLabel }) }}
            </span>
          </div>

          <div :class="['flex flex-wrap items-center gap-2']">
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">{{ t('stage.chat.live-room.interval') }}</span>
            <button
              v-for="option in intervalOptions"
              :key="option.value"
              type="button"
              :class="[
                'rounded-full px-3 py-1 text-xs outline-none transition-colors',
                intervalMs === option.value
                  ? 'bg-primary-500 text-white'
                  : 'bg-neutral-200/70 text-neutral-600 hover:bg-neutral-300/70 dark:bg-neutral-700/50 dark:text-neutral-300',
              ]"
              @click="intervalMs = option.value"
            >
              {{ option.label }}
            </button>
            <label :class="['ml-auto flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400']">
              <input v-model="sendToChat" type="checkbox" :class="['size-3.5']">
              {{ t('stage.chat.live-room.send-to-chat') }}
            </label>
          </div>
        </div>

        <p v-if="lastError" role="alert" :class="['mt-3 text-xs text-red-600 dark:text-red-400']">
          {{ lastError }}
        </p>
        <p v-else :class="['mt-3 text-[11px] text-neutral-400']">
          {{ t(ocrState === 'loading' ? 'stage.chat.live-room.ocr-loading-hint' : 'stage.chat.live-room.ocr-hint') }}
        </p>

        <section v-if="recent.length" :class="['mt-3']">
          <h3 :class="['mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400']">
            {{ t('stage.chat.live-room.recent') }}
          </h3>
          <ul :class="['flex flex-col gap-1']">
            <li
              v-for="(comment, index) in recent"
              :key="`${index}-${comment.text}`"
              :class="['rounded-lg bg-white/70 px-2.5 py-1.5 text-xs dark:bg-neutral-800/50']"
            >
              <span v-if="comment.name" :class="['mr-1 font-medium text-primary-600 dark:text-primary-300']">{{ comment.name }}</span>
              <span :class="['text-neutral-700 dark:text-neutral-200']">{{ comment.text }}</span>
            </li>
          </ul>
        </section>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
