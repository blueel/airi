import type { EmotionEventType, EmotionLabel, EmotionSnapshot, EmotionState, MoodDimensions } from '@proj-airi/stage-shared/emotion'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import {
  applyEmotionEvent,
  clampMood,
  decayIntensity,
  MOOD_BASELINE,
  regressMood,
} from '@proj-airi/stage-shared/emotion'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'

const STATE_KEY = 'emotion/state'
const MOOD_KEY = 'emotion/mood'
const LEDGER_KEY = 'emotion/reflection/ledger'

/** The decay of a visible feeling, and the offline compensation after a hidden tab returns. */
const DECAY_TICK_MS = 30_000
/** A feeling that lasts for minutes shows itself again at this interval, because one expression lasts a few seconds. */
const DISPLAY_REFRESH_MS = 90_000

/**
 * The character's own feeling and relationship state. Messages and other events change it. Time moves it back
 * to calm. A visible expression and a background reflection read it, and no reply creates it directly.
 *
 * Use when:
 * - The chat records a turn, the Stage shows an expression, or a proactive check reads the current state.
 *
 * Expects:
 * - One state per window. localStorage shares it with the other windows.
 *
 * Returns:
 * - `ingest` for one event, `snapshot` for prompts, and the display values for the Stage.
 */
export const useEmotionStateStore = defineStore('emotion-state', () => {
  const stored = useLocalStorageManualReset<EmotionState>(STATE_KEY, {
    emotion: 'relaxed',
    intensity: 0,
    updatedAt: 0,
  })
  const mood = useLocalStorageManualReset<MoodDimensions>(MOOD_KEY, {
    ...MOOD_BASELINE,
    updatedAt: 0,
  })
  /** Accumulated importance since the last reflection. The reflection store owns the model call. */
  const ledger = useLocalStorageManualReset<number>(LEDGER_KEY, 0)

  const startedAt = Date.now()
  const lastDecayAt = ref(stored.value.updatedAt || startedAt)
  const emotion = ref<EmotionLabel>(stored.value.emotion)
  const intensity = ref(decayIntensity(stored.value.intensity, startedAt - lastDecayAt.value))
  /** Bumped on each event and on each display refresh, so the Stage can pulse an expression that is still active. */
  const displayRevision = ref(0)
  let lastDisplayRefreshAt = startedAt

  // The app can stay closed for days. Move the relationship toward its baseline once, now.
  if (mood.value.updatedAt > 0)
    mood.value = { ...clampMood(regressMood(mood.value, startedAt - mood.value.updatedAt)), updatedAt: startedAt }
  else
    mood.value = { ...MOOD_BASELINE, updatedAt: startedAt }

  const displayEmotion = computed<EmotionLabel | 'neutral'>(() => intensity.value > 0 ? emotion.value : 'neutral')
  const displayIntensity = computed(() => intensity.value)

  function decayTo(at: number) {
    const elapsed = at - lastDecayAt.value
    if (elapsed < 1_000)
      return

    intensity.value = decayIntensity(intensity.value, elapsed)
    lastDecayAt.value = at

    // An emotion under the floor is over. The neutral expression needs no refresh.
    if (intensity.value === 0)
      return
    if (at - lastDisplayRefreshAt >= DISPLAY_REFRESH_MS) {
      lastDisplayRefreshAt = at
      displayRevision.value++
    }
  }

  /**
   * Applies one event to the feeling and the mood. Resolves to the applied state, so a caller can read the effect
   * that it just caused.
   */
  function ingest(type: EmotionEventType) {
    const at = Date.now()
    const applied = applyEmotionEvent(
      { emotion: emotion.value, intensity: intensity.value, updatedAt: lastDecayAt.value },
      mood.value,
      type,
      at,
    )

    emotion.value = applied.state.emotion
    intensity.value = applied.state.intensity
    mood.value = applied.mood
    lastDecayAt.value = at
    lastDisplayRefreshAt = at
    stored.value = { ...applied.state }
    ledger.value += applied.effect.importance
    displayRevision.value++

    return applied
  }

  /** A reflection pass can move the relationship a little. The value is a delta, and it stays inside 0..100. */
  function adjustMood(adjustment: { affection?: number, energy?: number }) {
    const at = Date.now()
    const regressed = regressMood(mood.value, Math.max(0, at - mood.value.updatedAt))
    mood.value = {
      ...clampMood({
        affection: regressed.affection + (adjustment.affection ?? 0),
        energy: regressed.energy + (adjustment.energy ?? 0),
      }),
      updatedAt: at,
    }
  }

  /** The state that a prompt or a reflection pass reads. The label is `relaxed` once the feeling has faded. */
  function snapshot(): EmotionSnapshot {
    return {
      emotion: intensity.value > 0 ? emotion.value : 'relaxed',
      intensity: intensity.value,
      affection: mood.value.affection,
      energy: mood.value.energy,
    }
  }

  function resetLedger() {
    ledger.value = 0
  }

  function resetState() {
    stored.reset()
    mood.reset()
    ledger.reset()
    emotion.value = 'relaxed'
    intensity.value = 0
    lastDecayAt.value = Date.now()
    lastDisplayRefreshAt = lastDecayAt.value
    mood.value = { ...MOOD_BASELINE, updatedAt: lastDecayAt.value }
    displayRevision.value++
  }

  let ticker: ReturnType<typeof setInterval> | undefined
  function onVisibilityChange() {
    if (document.visibilityState === 'visible')
      decayTo(Date.now())
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    ticker = setInterval(() => decayTo(Date.now()), DECAY_TICK_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    onScopeDispose(() => {
      if (ticker)
        clearInterval(ticker)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  }

  return {
    ledger,
    mood,
    displayEmotion,
    displayIntensity,
    displayRevision,
    snapshot,
    ingest,
    adjustMood,
    resetLedger,
    resetState,
  }
})
