import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { isMikaConversationId, MikaClient } from '@proj-airi/stage-shared/mika'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { isMikaSupported, mikaTransport } from '../modules/mika'

export const DEFAULT_MIKA_BASE_URL = 'http://127.0.0.1:8765'

export const useMikaSettingsStore = defineStore('mika-settings', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/mika/enabled', false)
  const baseUrl = useLocalStorageManualReset<string>('settings/mika/base-url', DEFAULT_MIKA_BASE_URL)
  const token = useLocalStorageManualReset<string>('settings/mika/token', '')
  const conversation = useLocalStorageManualReset<string>('settings/mika/conversation', '')

  // Earlier builds stored an id that Mika never accepts. Drop it.
  if (conversation.value && !isMikaConversationId(conversation.value))
    conversation.value = ''

  const supported = computed(() => isMikaSupported())

  const configured = computed(() => {
    return supported.value
      && enabled.value
      && baseUrl.value.trim().length > 0
      && token.value.trim().length > 0
  })

  /**
   * The client for the current settings, or `undefined` when phone control is
   * unavailable or incomplete. A client holds no task state, so creating one
   * for a single call is cheap.
   *
   * @param options - Optional behavior.
   * @param options.requireEnabled - Set false to test the address and token
   * before the owner turns phone control on.
   */
  function createClient(options?: { requireEnabled?: boolean }): MikaClient | undefined {
    if (!supported.value)
      return undefined
    if ((options?.requireEnabled ?? true) && !enabled.value)
      return undefined
    if (!baseUrl.value.trim() || !token.value.trim())
      return undefined

    return new MikaClient({
      baseUrl: baseUrl.value,
      token: token.value,
      transport: mikaTransport,
    })
  }

  /** The conversation that Mika returned for an earlier task, if it is still valid. */
  function currentConversation(): string | undefined {
    return isMikaConversationId(conversation.value) ? conversation.value : undefined
  }

  /** Saves the conversation that Mika returns when it starts a task. */
  function rememberConversation(id: string | undefined) {
    if (isMikaConversationId(id) && id !== conversation.value)
      conversation.value = id
  }

  function resetState() {
    enabled.reset()
    baseUrl.reset()
    token.reset()
    conversation.reset()
  }

  return {
    enabled,
    baseUrl,
    token,
    conversation,
    supported,
    configured,
    createClient,
    currentConversation,
    rememberConversation,
    resetState,
  }
})
