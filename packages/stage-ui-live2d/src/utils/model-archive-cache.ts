/**
 * Shared cache for Live2D zip archives.
 *
 * The Stage renderer and the character-card inspector otherwise download the
 * same zip independently: once for the model, once more to read its expressions
 * and motions. The Stage keeps an unpacked copy in OPFS, but that path runs
 * after the archive is fetched and does not help a browser without OPFS.
 *
 * Content hashes are part of asset URLs, so archive bytes never go stale. One
 * copy in the Cache API serves every caller, across visits, even on origins
 * where the browser disables the HTTP cache (untrusted certificates).
 */
const cacheName = 'airi-live2d-archives'
const maxCachedArchives = 12

const inFlight = new Map<string, Promise<Blob>>()

async function readCachedArchive(url: string): Promise<Blob | undefined> {
  if (typeof caches === 'undefined')
    return undefined

  try {
    const cache = await caches.open(cacheName)
    const response = await cache.match(url)
    return response ? await response.blob() : undefined
  }
  catch {
    return undefined
  }
}

async function writeCachedArchive(url: string, blob: Blob) {
  if (typeof caches === 'undefined')
    return

  try {
    const cache = await caches.open(cacheName)
    const keys = await cache.keys()
    // `keys()` follows insertion order. Drop old hashes left by earlier builds.
    for (const key of keys.slice(0, Math.max(0, keys.length - (maxCachedArchives - 1))))
      await cache.delete(key)
    await cache.put(url, new Response(blob))
  }
  catch {
    // A full quota or unsupported storage only costs one more download.
  }
}

/**
 * Returns the archive at `url`, reusing a cached copy and joining a download
 * that is already running for the same URL.
 */
export async function fetchLive2DArchive(url: string): Promise<Blob> {
  const cached = await readCachedArchive(url)
  if (cached)
    return cached

  let pending = inFlight.get(url)
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url)
      if (!response.ok)
        throw new Error(`Failed to load the Live2D archive (${response.status} ${response.statusText}).`)

      const blob = await response.blob()
      await writeCachedArchive(url, blob)
      return blob
    })()
    inFlight.set(url, pending)

    const forget = () => {
      if (inFlight.get(url) === pending)
        inFlight.delete(url)
    }
    void pending.then(forget, forget)
  }

  return await pending
}
