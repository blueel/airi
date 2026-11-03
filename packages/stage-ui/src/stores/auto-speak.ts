import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

/** The switch survives a reload, so a broadcast resumes with the app. */
export const AUTO_SPEAK_STORAGE_KEY = 'ui/chat/auto-speak/enabled'

/**
 * Whether the character speaks into the open conversation while nobody talks to her.
 * A broadcast keeps her talking, so a viewer who only watches still sees and hears her.
 */
export const useAutoSpeakStore = defineStore('auto-speak', () => {
  const enabled = useLocalStorage(AUTO_SPEAK_STORAGE_KEY, false)

  function toggle() {
    enabled.value = !enabled.value
  }

  return { enabled, toggle }
})
