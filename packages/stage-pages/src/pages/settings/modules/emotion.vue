<script setup lang="ts">
import { useEmotionStateStore } from '@proj-airi/stage-ui/stores/modules/emotion-state'
import { useProactiveChatStore } from '@proj-airi/stage-ui/stores/modules/proactive-chat'
import { FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const KEY = 'settings.pages.modules.emotion'

const emotion = useEmotionStateStore()
const proactive = useProactiveChatStore()
const { enabled, silenceMs, cooldownMs, maxPerHour } = storeToRefs(proactive)

const silenceMinutes = computed<number>({
  get: () => Math.round(silenceMs.value / 60_000),
  set: value => silenceMs.value = Math.min(24 * 60, Math.max(1, Math.round(Number(value) || 5))) * 60_000,
})
const cooldownMinutes = computed<number>({
  get: () => Math.round(cooldownMs.value / 60_000),
  set: value => cooldownMs.value = Math.min(24 * 60, Math.max(1, Math.round(Number(value) || 15))) * 60_000,
})
const messagesPerHour = computed<number>({
  get: () => Math.round(maxPerHour.value),
  set: value => maxPerHour.value = Math.min(12, Math.max(1, Math.round(Number(value) || 3))),
})
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <div>
        <p :class="['text-lg', 'font-medium']">
          {{ t(`${KEY}.state.title`) }}
        </p>
        <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.state.description`) }}
        </p>
      </div>

      <div :class="['flex items-center', 'justify-between', 'gap-3']">
        <span>{{ t(`${KEY}.state.feeling`) }}</span>
        <span :class="['font-medium']">
          {{ t(`${KEY}.state.feeling_values.${emotion.displayEmotion}`) }}
          <span :class="['text-neutral-500 dark:text-neutral-400']">({{ Math.round(emotion.displayIntensity * 100) }}%)</span>
        </span>
      </div>

      <div :class="['flex flex-col', 'gap-1']">
        <div :class="['flex items-center', 'justify-between', 'text-sm']">
          <span>{{ t(`${KEY}.state.affection`) }}</span>
          <span :class="['text-neutral-500 dark:text-neutral-400']">{{ Math.round(emotion.mood.affection) }}/100</span>
        </div>
        <div :class="['h-2', 'overflow-hidden', 'rounded-full', 'bg-neutral-200 dark:bg-neutral-800']">
          <div :class="['h-full', 'rounded-full', 'bg-primary-500']" :style="{ width: `${emotion.mood.affection}%` }" />
        </div>
      </div>

      <div :class="['flex flex-col', 'gap-1']">
        <div :class="['flex items-center', 'justify-between', 'text-sm']">
          <span>{{ t(`${KEY}.state.energy`) }}</span>
          <span :class="['text-neutral-500 dark:text-neutral-400']">{{ Math.round(emotion.mood.energy) }}/100</span>
        </div>
        <div :class="['h-2', 'overflow-hidden', 'rounded-full', 'bg-neutral-200 dark:bg-neutral-800']">
          <div :class="['h-full', 'rounded-full', 'bg-amber-500']" :style="{ width: `${emotion.mood.energy}%` }" />
        </div>
      </div>
    </div>

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.proactive.label`)" :description="t(`${KEY}.proactive.description`)" />
      <div v-if="enabled" :class="['grid grid-cols-1 gap-3 sm:grid-cols-3']">
        <FieldInput v-model="silenceMinutes" type="number" :label="t(`${KEY}.proactive.silence`)" :description="t(`${KEY}.proactive.silence-description`)" />
        <FieldInput v-model="cooldownMinutes" type="number" :label="t(`${KEY}.proactive.cooldown`)" :description="t(`${KEY}.proactive.cooldown-description`)" />
        <FieldInput v-model="messagesPerHour" type="number" :label="t(`${KEY}.proactive.max-per-hour`)" :description="t(`${KEY}.proactive.max-per-hour-description`)" />
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.emotion.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
