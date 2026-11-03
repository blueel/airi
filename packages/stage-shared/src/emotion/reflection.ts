/**
 * Accumulated importance that triggers one reflection pass. A gift alone does not reach it.
 * A few meaningful turns do, which keeps the extra model call rare.
 */
export const REFLECTION_THRESHOLD = 12

/** One pass writes at most this many insights. More than three turns a reflection into a diary. */
export const REFLECTION_MAX_INSIGHTS = 3

/** After a failed pass, the next turn may try again only after this quiet period. */
export const REFLECTION_RETRY_MS = 10 * 60_000

export function reflectionDue(ledger: number) {
  return ledger >= REFLECTION_THRESHOLD
}
