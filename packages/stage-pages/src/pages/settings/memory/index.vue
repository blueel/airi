<script setup lang="ts">
import { WIP } from '@proj-airi/stage-ui/components'
</script>

<template>
  <WIP />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.memory.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.memory.description
  icon: i-solar:leaf-bold-duotone
  stageTransition:
    name: slide
</route>
