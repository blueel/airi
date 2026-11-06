<script setup lang="ts">
import { SettingsHome } from '@proj-airi/stage-ui/components'
</script>

<template>
  <SettingsHome />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.title
  stageTransition:
    name: slide
</route>
