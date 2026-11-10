<script setup lang="ts">
import type { MemoryEntry, MemoryKind } from '@proj-airi/stage-ui/types/memory'

import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

type KindFilter = 'all' | MemoryKind
type SortBy = 'updated' | 'importance'

const { locale, t } = useI18n()
const memory = useMemoryStore()
const { cards } = storeToRefs(useAiriCardStore())
const { backend, entries } = storeToRefs(memory)

const KEY = 'settings.pages.modules.memory-long-term.explorer'
const KIND_KEY = 'settings.pages.modules.memory-long-term.memories.kind'

const RECENT_DAYS = 7
const BAR_MAX_HEIGHT = 52

const keyword = ref('')
const kindFilter = ref<KindFilter>('all')
const personaFilter = ref('all')
const pinnedOnly = ref(false)
const sortBy = ref<SortBy>('updated')
const expandedId = ref<string>()

onMounted(() => {
  // The store reads on its own, but a page opened before the first read settles would show an empty list.
  void memory.ready()
})

const kindOptions = computed(() => [
  { id: 'all' as KindFilter, label: t(`${KEY}.filter.all`) },
  { id: 'profile' as KindFilter, label: t(`${KIND_KEY}.profile`) },
  { id: 'fact' as KindFilter, label: t(`${KIND_KEY}.fact`) },
  { id: 'episode' as KindFilter, label: t(`${KIND_KEY}.episode`) },
])

const sortOptions = computed(() => [
  { id: 'updated' as SortBy, label: t(`${KEY}.sort.updated`) },
  { id: 'importance' as SortBy, label: t(`${KEY}.sort.importance`) },
])

/** Characters that kept at least one memory, with the name from their card when this device has it. */
const personaOptions = computed(() => {
  const ids = new Set<string>()
  for (const entry of entries.value) {
    if (entry.persona)
      ids.add(entry.persona)
  }
  return [...ids]
    .map(id => ({ id, name: cards.value.get(id)?.name?.trim() || id }))
    .sort((left, right) => left.name.localeCompare(right.name))
})

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase()
  const list = entries.value.filter((entry) => {
    if (pinnedOnly.value && !entry.pinned)
      return false
    if (kindFilter.value !== 'all' && (entry.kind ?? 'fact') !== kindFilter.value)
      return false
    if (personaFilter.value !== 'all' && (entry.persona ?? '') !== personaFilter.value)
      return false
    if (needle && !`${entry.description}\n${entry.body}`.toLowerCase().includes(needle))
      return false
    return true
  })
  return list.sort(sortBy.value === 'importance' ? byImportance : byUpdated)
})

const summary = computed(() => [
  { id: 'total', label: t(`${KEY}.summary.total`), value: entries.value.length },
  { id: 'pinned', label: t(`${KEY}.summary.pinned`), value: entries.value.filter(entry => entry.pinned).length },
  { id: 'personas', label: t(`${KEY}.summary.personas`), value: personaOptions.value.length },
])

/** Counts by the day of the last change, so the bars show when the character learned something. */
const daily = computed(() => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (RECENT_DAYS - 1))

  const buckets = new Map<string, number>()
  for (const entry of entries.value) {
    const key = dayKey(new Date(entry.updatedAt))
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }

  const series = Array.from({ length: RECENT_DAYS }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = dayKey(date)
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: buckets.get(key) ?? 0 }
  })

  const max = Math.max(1, ...series.map(item => item.count))
  return series.map(item => ({
    ...item,
    height: item.count === 0 ? 2 : Math.max(4, Math.round((item.count / max) * BAR_MAX_HEIGHT)),
  }))
})

const relativeFormatter = computed(() => new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }))

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function byUpdated(left: MemoryEntry, right: MemoryEntry) {
  const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
  return pinned !== 0 ? pinned : right.updatedAt - left.updatedAt
}

function byImportance(left: MemoryEntry, right: MemoryEntry) {
  const importance = (right.importance ?? 3) - (left.importance ?? 3)
  return importance !== 0 ? importance : right.updatedAt - left.updatedAt
}

function formatRelative(ms: number) {
  const diff = ms - Date.now()
  const hour = 3_600_000
  const day = 86_400_000
  if (Math.abs(diff) < hour)
    return relativeFormatter.value.format(Math.round(diff / 60_000), 'minute')
  if (Math.abs(diff) < day)
    return relativeFormatter.value.format(Math.round(diff / hour), 'hour')
  if (Math.abs(diff) < 30 * day)
    return relativeFormatter.value.format(Math.round(diff / day), 'day')
  return relativeFormatter.value.format(Math.round(diff / (30 * day)), 'month')
}

function formatDate(ms?: number) {
  return typeof ms === 'number'
    ? new Date(ms).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
    : '—'
}

function kindLabel(entry: MemoryEntry) {
  return t(`${KIND_KEY}.${entry.kind ?? 'fact'}`)
}

function personaLabel(entry: MemoryEntry) {
  if (!entry.persona)
    return t(`${KEY}.detail.general`)
  return cards.value.get(entry.persona)?.name?.trim() || entry.persona
}

function toggle(entry: MemoryEntry) {
  expandedId.value = expandedId.value === entry.id ? undefined : entry.id
}

function clearFilters() {
  keyword.value = ''
  kindFilter.value = 'all'
  personaFilter.value = 'all'
  pinnedOnly.value = false
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <section :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
        <h2 :class="['text-sm font-medium']">
          {{ t(`${KEY}.summary.title`) }}
        </h2>
        <span
          :class="[
            'rounded-full', 'px-2 py-0.5', 'text-[10px]',
            backend === 'remote'
              ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
              : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300',
          ]"
        >
          {{ backend === 'remote' ? t(`${KEY}.backend.remote`) : t(`${KEY}.backend.local`) }}
        </span>
      </div>

      <div :class="['grid', 'grid-cols-3', 'gap-2']">
        <div
          v-for="item in summary"
          :key="item.id"
          :class="['flex', 'flex-col', 'gap-0.5', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2']"
        >
          <span :class="['text-lg font-semibold tabular-nums']">{{ item.value }}</span>
          <span :class="['text-[11px]', 'text-neutral-500 dark:text-neutral-400']">{{ item.label }}</span>
        </div>
      </div>

      <div :class="['flex', 'flex-col', 'gap-1']">
        <span :class="['text-[11px]', 'text-neutral-500 dark:text-neutral-400']">{{ t(`${KEY}.chart.title`, { days: RECENT_DAYS }) }}</span>
        <div :class="['flex', 'items-end', 'gap-1']" :style="{ height: `${BAR_MAX_HEIGHT + 4}px` }">
          <div
            v-for="day in daily"
            :key="day.key"
            :class="[
              'flex-1', 'rounded-sm',
              day.count ? 'bg-primary-400 dark:bg-primary-500' : 'bg-neutral-200 dark:bg-neutral-700',
            ]"
            :style="{ height: `${day.height}px` }"
            :title="`${day.label} · ${day.count}`"
          />
        </div>
        <div :class="['flex', 'justify-between', 'text-[10px]', 'text-neutral-400 dark:text-neutral-500']">
          <span>{{ daily[0]?.label }}</span>
          <span>{{ daily[daily.length - 1]?.label }}</span>
        </div>
      </div>
    </section>

    <div :class="['flex', 'flex-col', 'gap-2']">
      <input
        v-model="keyword"
        type="search"
        :placeholder="t(`${KEY}.search.placeholder`)"
        :class="[
          'w-full', 'rounded-lg',
          'border border-neutral-200 dark:border-neutral-700',
          'bg-white dark:bg-neutral-900',
          'px-3 py-2', 'text-sm',
          'outline-none focus:border-primary-400 dark:focus:border-primary-500',
        ]"
      >

      <div :class="['flex', 'flex-wrap', 'gap-1.5']">
        <button
          v-for="option in kindOptions"
          :key="option.id"
          type="button"
          :class="[
            'rounded-full', 'px-3 py-1', 'text-xs',
            'transition-colors',
            kindFilter === option.id
              ? 'bg-primary-500 text-white'
              : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
          ]"
          @click="kindFilter = option.id"
        >
          {{ option.label }}
        </button>
      </div>

      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <select
          v-if="personaOptions.length > 1"
          v-model="personaFilter"
          :class="[
            'rounded-lg', 'px-2 py-1.5', 'text-xs',
            'border border-neutral-200 dark:border-neutral-700',
            'bg-white dark:bg-neutral-900',
          ]"
        >
          <option value="all">
            {{ t(`${KEY}.filter.persona_all`) }}
          </option>
          <option v-for="option in personaOptions" :key="option.id" :value="option.id">
            {{ option.name }}
          </option>
        </select>

        <label :class="['flex', 'items-center', 'gap-1.5', 'text-xs', 'text-neutral-600 dark:text-neutral-300']">
          <input v-model="pinnedOnly" type="checkbox" :class="['accent-primary-500']">
          <span>{{ t(`${KEY}.filter.pinned_only`) }}</span>
        </label>

        <div :class="['ml-auto', 'flex', 'gap-1']">
          <button
            v-for="option in sortOptions"
            :key="option.id"
            type="button"
            :class="[
              'rounded-lg', 'px-2 py-1', 'text-xs',
              sortBy === option.id
                ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 dark:text-neutral-400',
            ]"
            @click="sortBy = option.id"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <span :class="['text-[11px]', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.count`, { shown: filtered.length, total: entries.length }) }}
      </span>
    </div>

    <ul v-if="filtered.length" :class="['flex', 'flex-col', 'gap-2']">
      <li
        v-for="entry in filtered"
        :key="entry.id"
        :class="[
          'flex', 'flex-col', 'gap-2', 'rounded-xl',
          'bg-neutral-50 dark:bg-neutral-800/60',
          'px-3 py-2.5',
          'cursor-pointer transition-colors',
          'hover:bg-neutral-100 dark:hover:bg-neutral-800',
        ]"
        @click="toggle(entry)"
      >
        <div :class="['flex', 'items-center', 'gap-2']">
          <span :class="['rounded-full', 'bg-white dark:bg-neutral-900', 'px-2 py-0.5', 'text-[10px]', 'uppercase', 'tracking-wide', 'text-neutral-500 dark:text-neutral-400']">
            {{ kindLabel(entry) }}
          </span>
          <span v-if="entry.pinned" :class="['i-solar:pin-bold', 'text-xs', 'text-primary-500']" :title="t(`${KEY}.filter.pinned_only`)" />
          <span :class="['text-[10px]', 'text-neutral-400 dark:text-neutral-500']">{{ entry.importance ?? 3 }}/5</span>
          <span :class="['ml-auto', 'shrink-0', 'text-[11px]', 'text-neutral-400 dark:text-neutral-500']">{{ formatRelative(entry.updatedAt) }}</span>
        </div>

        <p v-if="entry.description" :class="['text-sm font-medium', 'break-words']">
          {{ entry.description }}
        </p>

        <p
          v-if="entry.body && entry.body !== entry.description"
          :class="[
            'text-xs', 'break-words',
            'text-neutral-500 dark:text-neutral-400',
            expandedId === entry.id ? ['max-h-56', 'overflow-auto', 'whitespace-pre-wrap'] : 'line-clamp-2',
          ]"
        >
          {{ entry.body }}
        </p>

        <div v-if="expandedId === entry.id" :class="['flex', 'flex-col', 'gap-1', 'border-t', 'border-neutral-200 dark:border-neutral-700', 'pt-2']">
          <div :class="['grid', 'grid-cols-2', 'gap-x-3 gap-y-1', 'text-[11px]']">
            <span :class="['text-neutral-400 dark:text-neutral-500']">{{ t(`${KEY}.detail.persona`) }}</span>
            <span :class="['text-right', 'text-neutral-600 dark:text-neutral-300']">{{ personaLabel(entry) }}</span>
            <span :class="['text-neutral-400 dark:text-neutral-500']">{{ t(`${KEY}.detail.updated`) }}</span>
            <span :class="['text-right', 'text-neutral-600 dark:text-neutral-300']">{{ formatDate(entry.updatedAt) }}</span>
            <span :class="['text-neutral-400 dark:text-neutral-500']">{{ t(`${KEY}.detail.created`) }}</span>
            <span :class="['text-right', 'text-neutral-600 dark:text-neutral-300']">{{ formatDate(entry.createdAt) }}</span>
            <span :class="['text-neutral-400 dark:text-neutral-500']">{{ t(`${KEY}.detail.used`) }}</span>
            <span :class="['text-right', 'text-neutral-600 dark:text-neutral-300']">{{ entry.useCount ?? 0 }}</span>
          </div>
          <span v-if="entry.source" :class="['text-[11px]', 'text-neutral-400 dark:text-neutral-500']">
            {{ t(`${KEY}.detail.source`, { source: entry.source }) }}
          </span>
        </div>
      </li>
    </ul>

    <div v-else :class="['flex', 'flex-col', 'gap-1', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'px-4 py-8', 'text-center']">
      <span :class="['text-sm', 'text-neutral-600 dark:text-neutral-300']">{{ t(`${KEY}.empty.title`) }}</span>
      <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ t(`${KEY}.empty.description`) }}</span>
      <button
        type="button"
        :class="['mx-auto', 'mt-2', 'rounded-lg', 'bg-white dark:bg-neutral-900', 'px-3 py-1.5', 'text-xs', 'text-primary-600 dark:text-primary-400']"
        @click="clearFilters"
      >
        {{ t(`${KEY}.empty.clear`) }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.explorer.title
  subtitleKey: settings.pages.modules.memory-long-term.title
  stageTransition:
    name: slide
</route>
