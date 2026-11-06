<script setup lang="ts">
import { ConnectionSettings } from '@proj-airi/stage-ui/components'
</script>

<template>
  <ConnectionSettings />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.connection.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.connection.description
  icon: i-solar:wi-fi-router-bold-duotone
  settingsEntry: true
  settingsGroup: app
  order: 6
  stageTransition:
    name: slide
</route>
