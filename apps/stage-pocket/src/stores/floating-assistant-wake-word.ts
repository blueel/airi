import type { FloatingAssistantStatus } from '../modules/floating-assistant'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { kwsModel } from '@proj-airi/stage-ui/libs/voice/kws-model-info'
import { useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useWakeWordsStore } from '@proj-airi/stage-ui/stores/wake-words'
import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'

import { FloatingAssistant, isFloatingAssistantSupported } from '../modules/floating-assistant'
import { i18n } from '../modules/i18n'

/**
 * Keeps the floating bubble's wake word setting in step with the active character.
 *
 * The native service reads the same phrases from private storage, so it can listen before the WebView loads.
 * This store owns the user's intent, the live status, and the pause while AIRI speaks.
 */
export const useFloatingAssistantWakeWordStore = defineStore('floating-assistant-wake-word', () => {
  const supported = isFloatingAssistantSupported()
  const cards = useAiriCardStore()
  const wakeWords = useWakeWordsStore()
  const speaking = useSpeakingStore()

  /** The owner's choice. The native preference mirrors it. */
  const enabled = useLocalStorageManualReset<boolean>('settings/floating-assistant/wake-word', false)
  const status = shallowRef<FloatingAssistantStatus>()
  const error = shallowRef('')
  const busy = shallowRef(false)
  let syncVersion = 0
  let initialized = false

  /** The active character's active wake words. The native listener matches written text, not model tokens. */
  const phrases = computed(() => {
    const characterId = cards.activeCardId
    const texts = wakeWords.catalog.active
      .filter(pronunciation => pronunciation.characterId === characterId && pronunciation.modelId === kwsModel.id)
      .map(pronunciation => pronunciation.text.trim())
      .filter(Boolean)
    return [...new Set(texts)]
  })

  const state = computed(() => status.value?.wakeWordState ?? 'stopped')
  const listening = computed(() => state.value === 'listening' || state.value === 'command')
  /** A stable key so an unrelated card update with the same phrases does not rewrite the native setting. */
  const phraseKey = computed(() => phrases.value.join('\u0000'))

  async function refresh() {
    if (!supported)
      return

    try {
      const next = await FloatingAssistant.status()
      status.value = next
      // A sync in flight already owns the switch state. Its result arrives with the final native value.
      if (!busy.value)
        enabled.value = next.wakeWordEnabled
      error.value = next.wakeWordError ?? ''
    }
    catch (cause) {
      error.value = i18n.global.t('settings.pages.system.floating-assistant.wake-word.errors.status')
      console.warn('[floating-assistant] Could not read the wake word status:', errorMessageFrom(cause) ?? 'unknown error')
    }
  }

  async function sync() {
    if (!supported || !cards.ready)
      return

    const version = ++syncVersion
    busy.value = true
    try {
      const next = phrases.value
      const active = enabled.value && next.length > 0
      const result = await FloatingAssistant.setWakeWord({
        enabled: active,
        phrases: next,
        language: typeof navigator === 'undefined' ? undefined : navigator.language,
      })
      if (version !== syncVersion)
        return
      status.value = result
      enabled.value = result.wakeWordEnabled
      error.value = result.wakeWordError ?? ''
      // The service can start while AIRI speaks. Send the current state after every configuration change.
      void FloatingAssistant.setWakeWordSpeaking({ speaking: speaking.nowSpeaking }).catch(() => {})
    }
    catch (cause) {
      if (version !== syncVersion)
        return
      error.value = i18n.global.t('settings.pages.system.floating-assistant.wake-word.errors.sync')
      console.warn('[floating-assistant] Could not update the wake word setting:', errorMessageFrom(cause) ?? 'unknown error')
    }
    finally {
      if (version === syncVersion)
        busy.value = false
    }
  }

  async function setEnabled(value: boolean) {
    if (value && phrases.value.length === 0) {
      error.value = i18n.global.t('settings.pages.system.floating-assistant.wake-word.no-phrases')
      return
    }
    enabled.value = value
    await sync()
  }

  if (supported) {
    void (async () => {
      await refresh()
      initialized = true
      // A sync before the character library loads sees no phrases and turns the switch off.
      if (cards.ready)
        await sync()
    })()

    // The native side pauses the microphone while AIRI speaks, so the character never wakes herself.
    watch(() => speaking.nowSpeaking, (value) => {
      void FloatingAssistant.setWakeWordSpeaking({ speaking: value }).catch((cause) => {
        console.warn('[floating-assistant] Could not report speech output:', errorMessageFrom(cause) ?? 'unknown error')
      })
    }, { immediate: true })

    // The character library can load after this store starts. The first sync waits for it.
    watch(() => cards.ready, (ready) => {
      if (ready && initialized)
        void sync()
    })

    // The active character or its card can change while this store lives.
    watch(phraseKey, () => {
      if (initialized && enabled.value)
        void sync()
    })
  }

  return { supported, enabled, phrases, status, state, listening, busy, error, refresh, sync, setEnabled }
})
