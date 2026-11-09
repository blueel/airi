import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

/** The switch survives a reload, so a running bubble keeps its setting. */
export const BACKGROUND_VOICE_STORAGE_KEY = 'settings/floating-assistant/background-voice'

/**
 * Whether the screen bubble answers a wake word or hold-to-talk turn itself while the app is in the background.
 *
 * The WebView freezes while the app is hidden, so only this native path can speak a reply there. It reads the
 * conversation that the app prepared and returns the finished turn to the chat history.
 */
export const useBackgroundReplyStore = defineStore('background-reply', () => {
  const enabled = useLocalStorage(BACKGROUND_VOICE_STORAGE_KEY, true)

  function toggle() {
    enabled.value = !enabled.value
  }

  return { enabled, toggle }
})
