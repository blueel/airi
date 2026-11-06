import { errorMessageFrom } from '@moeru/std'

/**
 * Points a fresh install at the shared long-term memory server.
 *
 * The Android app has no Vite proxy, so `/api/memory` would resolve to the
 * WebView's own origin. Build the APK with `VITE_DEFAULT_MEMORY_SERVER_URL` and
 * `VITE_DEFAULT_MEMORY_SERVER_TOKEN` to seed the absolute public address and
 * token once. A later start never overwrites a choice the owner made.
 */
const SEEDED_KEY = 'memory/default-server-seeded'

export function seedDefaultMemoryServer() {
  if (typeof localStorage === 'undefined')
    return

  const url = import.meta.env.VITE_DEFAULT_MEMORY_SERVER_URL?.trim()
  const token = import.meta.env.VITE_DEFAULT_MEMORY_SERVER_TOKEN?.trim()
  if (!url || !token)
    return

  try {
    if (localStorage.getItem(SEEDED_KEY) === 'true')
      return
    localStorage.setItem('memory/backend', 'remote')
    localStorage.setItem('memory/server-url', url)
    localStorage.setItem('memory/server-token', token)
    localStorage.setItem(SEEDED_KEY, 'true')
  }
  catch (error) {
    console.error('Failed to seed the default memory server:', errorMessageFrom(error))
  }
}
