import indexedDbDriver from 'unstorage/drivers/indexedb'
import memoryDriver from 'unstorage/drivers/memory'

import { createStorage } from 'unstorage'

export const storage = createStorage({
  driver: memoryDriver(),
})

storage.mount('local', indexedDbDriver({ base: 'airi-local' }))
storage.mount('outbox', indexedDbDriver({ base: 'airi-sync-queue' }))

/**
 * Mark the origin's storage as persistent so the browser never evicts
 * chat sessions and other local data. Chrome silently wipes best-effort
 * (non-persistent) IndexedDB and OPFS when device disk runs low, which
 * already destroyed a user's chat history while localStorage survived.
 * The call is fire-and-forget: browsers may still deny it, and nothing
 * in the app depends on the outcome.
 */
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}
