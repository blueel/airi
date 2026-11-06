<script setup lang="ts">
import type { ChatHistoryItem } from '../../../../types/chat'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import HitPill from './hit-pill.vue'

import { AUTO_SPEAK_NOTICE_SOURCE, LIVE_ROOM_NOTICE_SOURCE, PROACTIVE_NOTICE_SOURCE, WATCH_ALONG_NOTICE_SOURCE } from '../../../../constants/chat'
import { extractMessageText } from '../../../../libs/chat-sync'
import { liveRoomCommentKey, parseLiveRoomComments } from '../../../../libs/live-room'

/** A stored notice, for example a finished background task. The owner did not write it, so it shows as a pill in the middle with its text folded. */
const props = withDefaults(defineProps<{
  message: Extract<ChatHistoryItem, { role: 'user' }>
  /** How the notice paints its background; see `ChatHistory`'s `surface`. */
  surface?: 'translucent' | 'opaque'
}>(), {
  surface: 'translucent',
})

const { t } = useI18n()

// A background task names itself `recipe:<name>`. Other sources show as they are.
const sourceName = computed(() => props.message.notice?.source.replace(/^recipe:/, '') ?? '')
const text = computed(() => extractMessageText(props.message))
/**
 * A line that the character started on her own leaves no notice: the reply already reads as her speaking, and a pill
 * between her lines would tell the viewer that something besides her wrote them.
 */
const herOwnLine = computed(() => {
  const source = props.message.notice?.source
  return source === AUTO_SPEAK_NOTICE_SOURCE || source === PROACTIVE_NOTICE_SOURCE
})
/** Comments that the room reader wrote into the conversation. They show as the viewers wrote them, not as a report. */
const isLiveRoom = computed(() => props.message.notice?.source === LIVE_ROOM_NOTICE_SOURCE)
/** One description of the owner's screen that the companion mode saw. Only the description shows, not the prompt. */
const isWatchAlong = computed(() => props.message.notice?.source === WATCH_ALONG_NOTICE_SOURCE)
const watchAlongDescription = computed(() => {
  if (!isWatchAlong.value)
    return ''

  const header = t('stage.chat.watch-along.message-header')
  const request = t('stage.chat.watch-along.message-request')
  return text.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line !== header && line !== request)
    .join('\n')
})
const roomComments = computed(() => {
  if (!isLiveRoom.value)
    return []

  // The reader writes the comments between two lines that address the model, the header and the request.
  const header = t('stage.chat.live-room.message-header')
  const request = t('stage.chat.live-room.message-request')
  const lines = text.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line !== header && line !== request)

  // A nickname is one word of a comment list, so a line without one stays a plain comment of the room.
  return parseLiveRoomComments(lines.join('\n'))
})

// Two viewers can write the same line, so the row counts instead of the text.
function rowKey(comment: { name: string, text: string }, index: number) {
  return `${index}-${liveRoomCommentKey(comment)}`
}
</script>

<template>
  <div
    v-if="isLiveRoom && roomComments.length"
    :class="[
      'mx-auto max-w-[92%] flex flex-col gap-1 rounded-2xl px-3 py-2',
      props.surface === 'opaque' ? 'bg-neutral-100' : 'bg-neutral-100/80 dark:bg-neutral-800/60',
    ]"
  >
    <span :class="['flex items-center gap-1 text-[10px] text-neutral-400 dark:text-neutral-500']">
      <span aria-hidden="true" :class="['i-solar:users-group-rounded-outline size-3']" />
      {{ t('stage.chat.live-room.badge') }}
    </span>
    <ul :class="['flex flex-col gap-0.5']">
      <li
        v-for="(comment, index) in roomComments"
        :key="rowKey(comment, index)"
        :class="['text-xs leading-relaxed break-words']"
      >
        <span v-if="comment.name" :class="['mr-1 font-medium text-primary-600 dark:text-primary-300']">{{ comment.name }}</span>
        <span :class="['text-neutral-700 dark:text-neutral-200']">{{ comment.text }}</span>
      </li>
    </ul>
  </div>
  <div
    v-else-if="isWatchAlong && watchAlongDescription"
    :class="[
      'mx-auto max-w-[92%] flex flex-col gap-1 rounded-2xl px-3 py-2',
      props.surface === 'opaque' ? 'bg-neutral-100' : 'bg-neutral-100/80 dark:bg-neutral-800/60',
    ]"
  >
    <span :class="['flex items-center gap-1 text-[10px] text-neutral-400 dark:text-neutral-500']">
      <span aria-hidden="true" :class="['i-solar:eye-outline size-3']" />
      {{ t('stage.chat.watch-along.badge') }}
    </span>
    <p :class="['text-xs leading-relaxed break-words text-neutral-700 dark:text-neutral-200']">
      {{ watchAlongDescription }}
    </p>
  </div>
  <HitPill
    v-else-if="!herOwnLine"
    :class="['py-1']"
    align="center"
    :icons="['i-mingcute:notification-fill']"
    :surface="props.surface"
  >
    <template #label>
      {{ t('stage.chat.notice.label', { name: sourceName }) }}
    </template>
    <!-- A notice without text has nothing to unfold. -->
    <template v-if="text" #default>
      <p :class="['m-0 rounded-lg px-2.5 py-2 text-xs', 'whitespace-pre-wrap break-words', 'bg-white/75 dark:bg-neutral-800/60']">
        {{ text }}
      </p>
    </template>
  </HitPill>
</template>
