<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  icon: string
}>()
</script>

<template>
  <div :class="['flex items-start gap-3', 'px-1']">
    <span
      :class="[
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        'bg-primary-500/10 text-primary-600',
        'dark:bg-primary-400/10 dark:text-primary-300',
      ]"
    >
      <span aria-hidden="true" :class="[icon, 'size-4']" />
    </span>
    <div :class="['min-w-0']">
      <h2 :class="['text-base font-medium text-neutral-700 dark:text-neutral-200']">
        {{ title }}
      </h2>
      <p v-if="description" :class="['mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400']">
        {{ description }}
      </p>
    </div>
  </div>
</template>
