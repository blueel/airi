<script setup lang="ts">
import { IconItem, RippleGrid, SettingsSectionHeader } from '@proj-airi/stage-ui/components'
import { useRippleGridState } from '@proj-airi/stage-ui/composables/use-ripple-grid-state'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { lastClickedIndex, setLastClickedIndex } = useRippleGridState()

const sections = computed(() => [
  {
    id: 'basics',
    title: t('settings.pages.system.groups.basics.title'),
    description: t('settings.pages.system.groups.basics.description'),
    icon: 'i-solar:palette-bold-duotone',
    items: [
      {
        title: t('settings.pages.system.general.title'),
        description: t('settings.pages.system.general.description'),
        icon: 'i-solar:emoji-funny-square-bold-duotone',
        to: '/settings/system/general',
      },
      {
        title: t('settings.pages.system.color-scheme.title'),
        description: t('settings.pages.system.color-scheme.description'),
        icon: 'i-solar:pallete-2-bold-duotone',
        to: '/settings/system/color-scheme',
      },
    ],
  },
  {
    id: 'advanced',
    title: t('settings.pages.system.groups.advanced.title'),
    description: t('settings.pages.system.groups.advanced.description'),
    icon: 'i-solar:test-tube-bold-duotone',
    items: [
      {
        title: t('settings.pages.system.developer.title'),
        description: t('settings.pages.system.developer.description'),
        icon: 'i-solar:code-bold-duotone',
        to: '/settings/system/developer',
      },
      {
        title: t('settings.pages.system.experimental.title'),
        description: t('settings.pages.system.experimental.description'),
        icon: 'i-solar:test-tube-bold-duotone',
        to: '/settings/system/experimental',
      },
    ],
  },
])
</script>

<template>
  <div :class="['flex flex-col', 'font-normal']">
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
      <template #item="{ item }">
        <IconItem
          :title="item.title"
          :description="item.description"
          :icon="item.icon"
          :to="item.to"
        />
      </template>
    </RippleGrid>
    <div
      v-motion
      :class="['text-neutral-200/50 dark:text-neutral-600/20', 'pointer-events-none fixed top-[calc(100dvh-12rem)] bottom-0 right--10 z--1', 'size-60 flex items-center justify-center']"
      :initial="{ scale: 0.9, opacity: 0, rotate: 180 }"
      :enter="{ scale: 1, opacity: 1, rotate: 0 }"
      :duration="500"
    >
      <div v-motion :class="['text-60', 'i-solar:settings-bold-duotone']" />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.system.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.system.description
  icon: i-solar:filters-bold-duotone
  settingsEntry: true
  settingsGroup: app
  order: 8
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
