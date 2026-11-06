// HTTPS preview overlay for public access through frp.
// AIRI uses Web Locks (navigator.locks), which only exists in a secure context,
// so plain HTTP over a public IP cannot boot the app. This config serves the
// production build over TLS with a self-signed certificate for the public IP.
import type { Plugin } from 'vite'

import process from 'node:process'

import { readFileSync } from 'node:fs'

import base, { breezeTtsProxy, funasrProxy, liveDanmakuProxy, memoryProxy, ollamaProxy } from './vite.config'

const keyPath = process.env.AIRI_TLS_KEY ?? 'D:/AI/内网穿透/certs/airi-key.pem'
const certPath = process.env.AIRI_TLS_CERT ?? 'D:/AI/内网穿透/certs/airi-cert.pem'

// `vite preview` sends `Cache-Control: no-cache` for every file, so each visit
// revalidates every asset. Files under `assets/` carry a content hash and can be
// kept for a year. Browsers disable the HTTP cache for untrusted certificates,
// so a phone still re-downloads after clicking through the self-signed warning.
const hashedAssetName = /-[\w-]{8}\.\w+$/

function cacheHeaders(): Plugin {
  return {
    name: 'airi-preview-cache-headers',
    configurePreviewServer(server) {
      // Added before Vite installs its static middleware; sirv keeps response
      // headers that are already set instead of overwriting them.
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        if (pathname.startsWith('/assets/') && hashedAssetName.test(pathname)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
        else if (pathname.startsWith('/ort/') || pathname.startsWith('/ocr/')) {
          // Stable names, not content hashes: keep them fresh for an hour so a
          // rebuild that replaces them is picked up on the next visit.
          res.setHeader('Cache-Control', 'public, max-age=3600')
        }
        next()
      })
    },
  }
}

export default {
  ...base,
  plugins: [...(base.plugins ?? []), cacheHeaders()],
  preview: {
    ...base.preview,
    // The public link reaches the loopback TTS server through this origin, so
    // the seeded `/breeze-tts/` base URL resolves here exactly as it does in
    // the dev server. `/ollama` needs the same treatment: the phone cannot
    // reach the loopback Ollama port on its own.
    proxy: { ...base.preview?.proxy, ...breezeTtsProxy, ...ollamaProxy, ...memoryProxy, ...liveDanmakuProxy, ...funasrProxy },
    host: '127.0.0.1',
    port: Number(process.env.AIRI_PREVIEW_PORT ?? 4174),
    strictPort: true,
    https: {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
  },
}
