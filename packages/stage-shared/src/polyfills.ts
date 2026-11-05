/**
 * ES2024 API polyfills for older mobile browsers.
 *
 * `Promise.withResolvers` and `Map.groupBy` / `Object.groupBy` ship in Safari 17.4
 * (iOS 17.4, March 2024), and this codebase calls them at module scope, so a missing
 * API throws during module evaluation and the app never boots.
 *
 * Import this module for its side effect, as the FIRST import of an application
 * entry, so the polyfills land before any other module body runs:
 *
 * ```ts
 * import '@proj-airi/stage-shared/polyfills'
 * ```
 */

/** Fills in `Promise.withResolvers` when the runtime lacks it. */
function installPromiseWithResolvers() {
  if (typeof Promise.withResolvers === 'function')
    return

  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

/** Fills in `Map.groupBy` when the runtime lacks it. */
function installMapGroupBy() {
  if (typeof Map.groupBy === 'function')
    return

  Map.groupBy = function groupBy<T, K>(items: Iterable<T>, keySelector: (item: T, index: number) => K): Map<K, T[]> {
    const result = new Map<K, T[]>()
    let index = 0
    for (const item of items) {
      const key = keySelector(item, index++)
      const bucket = result.get(key)
      if (bucket)
        bucket.push(item)
      else
        result.set(key, [item])
    }
    return result
  }
}

/** Fills in `Object.groupBy` when the runtime lacks it. */
function installObjectGroupBy() {
  if (typeof Object.groupBy === 'function')
    return

  Object.groupBy = function groupBy<T, K extends PropertyKey>(items: Iterable<T>, keySelector: (item: T, index: number) => K): Partial<Record<K, T[]>> {
    const result: Partial<Record<K, T[]>> = {}
    let index = 0
    for (const item of items) {
      const key = keySelector(item, index++)
      const bucket = result[key]
      if (bucket)
        bucket.push(item)
      else
        result[key] = [item]
    }
    return result
  }
}

/** Installs every polyfill. Safe to call more than once: each fill checks first. */
export function installES2024Polyfills() {
  installPromiseWithResolvers()
  installMapGroupBy()
  installObjectGroupBy()
}

installES2024Polyfills()
