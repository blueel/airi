<script setup lang="ts">
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

const { t } = useI18n()
const memory = useMemoryStore()
const { autoFormation, backend, enabled, formationModel, formationProvider, serverToken, serverUrl } = storeToRefs(memory)

const KEY = 'settings.pages.modules.memory-long-term'
const status = ref('')
const busy = ref(false)

const remote = computed({
  get: () => backend.value === 'remote',
  set: value => backend.value = value ? 'remote' : 'local',
})

async function testConnection() {
  busy.value = true
  status.value = ''
  try {
    status.value = await memory.testConnection()
      ? t(`${KEY}.server.connected`)
      : t(`${KEY}.server.failed`)
  }
  finally {
    busy.value = false
  }
}

async function importLocal() {
  busy.value = true
  status.value = ''
  try {
    const count = await memory.migrateLocalToRemote()
    status.value = count > 0
      ? t(`${KEY}.server.imported`, { count })
      : t(`${KEY}.server.import_empty`)
  }
  catch {
    status.value = t(`${KEY}.server.failed`)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.enable`)" :description="t(`${KEY}.enable-description`)" />
      <FieldCheckbox v-model="autoFormation" :label="t(`${KEY}.auto.label`)" :description="t(`${KEY}.auto.description`)" />
      <template v-if="autoFormation">
        <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.model.description`) }}
        </p>
        <div :class="['grid grid-cols-1 gap-3 sm:grid-cols-2']">
          <FieldInput v-model="formationProvider" :label="t(`${KEY}.model.provider`)" placeholder="ollama" />
          <FieldInput v-model="formationModel" :label="t(`${KEY}.model.model`)" placeholder="qwen3:4b" />
        </div>
      </template>
    </div>

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="remote" :label="t(`${KEY}.server.label`)" :description="t(`${KEY}.server.description`)" />
      <template v-if="remote">
        <FieldInput v-model="serverUrl" :label="t(`${KEY}.server.url`)" :description="t(`${KEY}.server.url_description`)" placeholder="http://127.0.0.1:4319" />
        <FieldInput v-model="serverToken" type="password" :label="t(`${KEY}.server.token`)" :description="t(`${KEY}.server.token_description`)" />
        <div :class="['flex flex-wrap', 'gap-2']">
          <Button size="sm" variant="primary" icon="i-solar:plug-circle-linear" :label="t(`${KEY}.server.test`)" :disabled="busy" @click="testConnection" />
          <Button size="sm" variant="secondary" icon="i-solar:download-square-linear" :label="t(`${KEY}.server.import`)" :disabled="busy" @click="importLocal" />
        </div>
        <p v-if="status" :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
          {{ status }}
        </p>
      </template>
    </div>

    <RouterLink
      to="/settings/modules/memory-long-term-recipes"
      :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'p-4', 'flex items-center', 'gap-3', 'transition-colors', 'hover:bg-neutral-100 dark:hover:bg-neutral-700']"
    >
      <div :class="['i-solar:book-bookmark-bold-duotone', 'text-2xl', 'text-primary-500 dark:text-primary-400']" />
      <div :class="['flex-1', 'flex flex-col', 'gap-1']">
        <span :class="['text-lg font-medium']">{{ t(`${KEY}.recipes.entry.title`) }}</span>
        <span :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">{{ t(`${KEY}.recipes.entry.description`) }}</span>
      </div>
      <div :class="['i-solar:alt-arrow-right-linear', 'text-neutral-400']" />
    </RouterLink>
    <RouterLink
      to="/settings/modules/memory-long-term-memories"
      :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'p-4', 'flex items-center', 'gap-3', 'transition-colors', 'hover:bg-neutral-100 dark:hover:bg-neutral-700']"
    >
      <div :class="['i-solar:notebook-bookmark-bold-duotone', 'text-2xl', 'text-primary-500 dark:text-primary-400']" />
      <div :class="['flex-1', 'flex flex-col', 'gap-1']">
        <span :class="['text-lg font-medium']">{{ t(`${KEY}.memories.entry.title`) }}</span>
        <span :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">{{ t(`${KEY}.memories.entry.description`) }}</span>
      </div>
      <div :class="['i-solar:alt-arrow-right-linear', 'text-neutral-400']" />
    </RouterLink>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
