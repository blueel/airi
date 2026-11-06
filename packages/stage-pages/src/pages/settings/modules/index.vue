<script setup lang="ts">
import type { Module } from '@proj-airi/stage-ui/composables/use-modules-list'

import { IconStatusItem, RippleGrid, SettingsSectionHeader } from '@proj-airi/stage-ui/components'
import { useModulesList } from '@proj-airi/stage-ui/composables/use-modules-list'
import { useRippleGridState } from '@proj-airi/stage-ui/composables/use-ripple-grid-state'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { categorizedModules, categoryNames } = useModulesList()
const { lastClickedIndex, setLastClickedIndex } = useRippleGridState()

const CATEGORY_ORDER = ['essential', 'messaging', 'gaming'] as const
const CATEGORY_ICONS: Record<typeof CATEGORY_ORDER[number], string> = {
  essential: 'i-solar:star-fall-bold-duotone',
  messaging: 'i-solar:chat-round-dots-bold-duotone',
  gaming: 'i-solar:gamepad-bold-duotone',
}

interface ModuleSection {
  id: typeof CATEGORY_ORDER[number]
  title: string
  description: string
  icon: string
  items: Module[]
}

const sections = computed<ModuleSection[]>(() => {
  return CATEGORY_ORDER.flatMap((id) => {
    const items = categorizedModules.value[id]
    if (!items?.length)
      return []

    return [{
      id,
      title: categoryNames.value[id],
      description: t(`settings.pages.modules.categoryDescriptions.${id}`),
      icon: CATEGORY_ICONS[id],
      items,
    }]
  })
})
</script>

<template>
  <div>
    <RippleGrid
      :sections="sections"
      :get-items="section => section.items"
      :get-key="item => item.to"
      :columns="{ default: 1, sm: 2 }"
      :origin-index="lastClickedIndex"
      @item-click="({ globalIndex }) => setLastClickedIndex(globalIndex)"
    >
      <template #header="{ section }">
        <SettingsSectionHeader
          :title="section.title"
          :description="section.description"
          :icon="section.icon"
        />
      </template>
      <template #item="{ item: module }">
        <IconStatusItem
          :title="module.name"
          :description="module.description"
          :icon="module.icon"
          :icon-color="module.iconColor"
          :icon-image="module.iconImage"
          :to="module.to"
          :configured="module.configured"
        />
      </template>
    </RippleGrid>
  </div>
  <div
    v-motion
    text="neutral-200/50 dark:neutral-600/20" pointer-events-none
    fixed top="[calc(100dvh-15rem)]" bottom-0 right--5 z--1
    :initial="{ scale: 0.9, opacity: 0, y: 20 }"
    :enter="{ scale: 1, opacity: 1, y: 0 }"
    :duration="500"
    size-60
    flex items-center justify-center
  >
    <div text="60" i-solar:layers-bold-duotone />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.modules.description
  icon: i-solar:layers-bold-duotone
  settingsEntry: true
  settingsGroup: ai
  order: 4
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
