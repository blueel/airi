import { describe, expect, it } from 'vitest'

import { installES2024Polyfills } from './polyfills'

/**
 * Removes a built-in static so the polyfill path actually runs on modern Node.
 * `Reflect` keeps this free of type-assertion chains.
 */
function hideStatic(target: object, key: string) {
  const original = Reflect.get(target, key)
  Reflect.deleteProperty(target, key)
  return function restore() {
    Reflect.set(target, key, original)
  }
}

describe('es2024 polyfills', () => {
  it('restores Promise.withResolvers when missing', async () => {
    const restore = hideStatic(Promise, 'withResolvers')
    try {
      installES2024Polyfills()

      const { promise, resolve } = Promise.withResolvers<number>()
      resolve(42)
      await expect(promise).resolves.toBe(42)

      const { promise: failing, reject: fail } = Promise.withResolvers<number>()
      fail(new Error('boom'))
      await expect(failing).rejects.toThrow('boom')
    }
    finally {
      restore()
    }
  })

  it('restores Map.groupBy when missing', () => {
    const restore = hideStatic(Map, 'groupBy')
    try {
      installES2024Polyfills()

      const grouped = Map.groupBy([1, 2, 3, 4], item => (item % 2 === 0 ? 'even' : 'odd'))
      expect(grouped.get('odd')).toEqual([1, 3])
      expect(grouped.get('even')).toEqual([2, 4])
    }
    finally {
      restore()
    }
  })

  it('restores Object.groupBy when missing', () => {
    const restore = hideStatic(Object, 'groupBy')
    try {
      installES2024Polyfills()

      const grouped = Object.groupBy(['apple', 'avocado', 'banana'], fruit => fruit[0]!)
      expect(grouped).toEqual({ a: ['apple', 'avocado'], b: ['banana'] })
    }
    finally {
      restore()
    }
  })

  it('keeps the native implementations when present', () => {
    const promiseOriginal = Promise.withResolvers
    const mapOriginal = Map.groupBy
    const objectOriginal = Object.groupBy

    installES2024Polyfills()

    expect(Promise.withResolvers).toBe(promiseOriginal)
    expect(Map.groupBy).toBe(mapOriginal)
    expect(Object.groupBy).toBe(objectOriginal)
  })
})
