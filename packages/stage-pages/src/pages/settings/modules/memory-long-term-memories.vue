<script setup lang="ts">
import type { MemoryEntry } from '@proj-airi/stage-ui/types/memory'

import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { GhostButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { memorySearchKey } from './memory-long-term-memories.search'

const { t } = useI18n()
const memory = useMemoryStore()
const { cards } = storeToRefs(useAiriCardStore())

const KEY = 'settings.pages.modules.memory-long-term.memories'
const editingId = ref<string>()
const draftDescription = ref('')
const draftBody = ref('')

/** General memories first, then each character card, and any other card id that kept a memory. */
const groups = computed(() => {
  const personas = new Map<string, string>()
  for (const [id, card] of cards.value)
    personas.set(id, card.name || id)
  for (const entry of memory.entries) {
    if (entry.persona && !personas.has(entry.persona))
      personas.set(entry.persona, entry.persona)
  }
  return [
    { key: 'general', title: t(`${KEY}.general`), icon: 'i-solar:global-bold-duotone', entries: memory.entries.filter(entry => !entry.persona) },
    ...[...personas].map(([id, name]) => ({ key: id, title: name, icon: 'i-solar:user-rounded-bold-duotone', entries: memory.entries.filter(entry => entry.persona === id) })),
  ]
})

function kindLabel(entry: MemoryEntry) {
  return t(`${KEY}.kind.${entry.kind ?? 'fact'}`)
}

function startEdit(entry: MemoryEntry) {
  editingId.value = entry.id
  draftDescription.value = entry.description
  draftBody.value = entry.body
}

function cancelEdit() {
  editingId.value = undefined
  draftDescription.value = ''
  draftBody.value = ''
}

async function saveEdit(entry: MemoryEntry) {
  await memory.update(entry.id, {
    description: draftDescription.value.trim(),
    body: draftBody.value.trim(),
  })
  cancelEdit()
}

async function togglePin(entry: MemoryEntry) {
  await memory.update(entry.id, { pinned: !entry.pinned })
}

function remove(entry: MemoryEntry) {
  void memory.remove(entry)
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t(`${KEY}.description`) }}
    </p>

    <section
      v-for="group in groups"
      :key="group.key"
      :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']"
    >
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="[group.icon, 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1', 'truncate']">{{ group.title }}</span>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ group.entries.length }}</span>
      </h2>
      <ul v-if="group.entries.length" :class="['flex flex-col', 'gap-2']">
        <li
          v-for="entry in group.entries"
          :key="entry.id"
          :data-settings-search="memorySearchKey(entry)"
          :class="['flex items-start', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <div v-if="editingId === entry.id" :class="['min-w-0 flex-1', 'flex flex-col', 'gap-2']">
            <input
              v-model="draftDescription"
              :class="['w-full', 'rounded-md', 'border border-neutral-200 dark:border-neutral-700', 'bg-transparent', 'px-2 py-1', 'text-sm']"
              :placeholder="t(`${KEY}.description_label`)"
            >
            <textarea
              v-model="draftBody"
              rows="4"
              :class="['w-full', 'rounded-md', 'border border-neutral-200 dark:border-neutral-700', 'bg-transparent', 'px-2 py-1', 'text-sm']"
            />
            <div :class="['flex', 'gap-2']">
              <GhostButton size="sm" icon="i-solar:check-circle-linear" :aria-label="t(`${KEY}.save`)" @click="saveEdit(entry)" />
              <GhostButton size="sm" icon="i-solar:close-circle-linear" :aria-label="t(`${KEY}.cancel`)" @click="cancelEdit" />
            </div>
          </div>
          <div v-else :class="['min-w-0 flex-1', 'flex flex-col', 'gap-0.5']">
            <div :class="['flex', 'items-center', 'gap-2']">
              <span :class="['text-[10px]', 'uppercase', 'tracking-wide', 'text-neutral-400']">{{ kindLabel(entry) }}</span>
              <span v-if="entry.pinned" :class="['text-[10px]', 'text-primary-500']">{{ t(`${KEY}.pinned`) }}</span>
            </div>
            <span v-if="entry.description" :class="['text-sm font-medium', 'break-words']">{{ entry.description }}</span>
            <p :class="['pt-1', 'text-sm', 'whitespace-pre-wrap break-words']">
              {{ entry.body }}
            </p>
          </div>
          <GhostButton
            size="sm"
            :icon="entry.pinned ? 'i-solar:pin-bold' : 'i-solar:pin-linear'"
            :aria-label="entry.pinned ? t(`${KEY}.unpin`) : t(`${KEY}.pin`)"
            :title="entry.pinned ? t(`${KEY}.unpin`) : t(`${KEY}.pin`)"
            @click="togglePin(entry)"
          />
          <GhostButton
            size="sm"
            icon="i-solar:pen-linear"
            :aria-label="t(`${KEY}.edit`)"
            :title="t(`${KEY}.edit`)"
            @click="startEdit(entry)"
          />
          <GhostButton
            v-if="entry.persona"
            size="sm"
            icon="i-solar:global-linear"
            :aria-label="t(`${KEY}.make_general`, { name: entry.description || entry.body })"
            :title="t(`${KEY}.make_general`, { name: entry.description || entry.body })"
            @click="memory.makeGeneral(entry)"
          />
          <GhostButton size="sm" icon="i-solar:trash-bin-minimalistic-linear" :aria-label="t(`${KEY}.forget`, { name: entry.description || entry.body })" :title="t(`${KEY}.forget`, { name: entry.description || entry.body })" @click="remove(entry)" />
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.empty`) }}
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.memories.title
  subtitleKey: settings.pages.modules.memory-long-term.title
  stageTransition:
    name: slide
</route>
