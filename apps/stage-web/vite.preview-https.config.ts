// HTTPS preview overlay for public access through frp.
// AIRI uses Web Locks (navigator.locks), which only exists in a secure context,
// so plain HTTP over a public IP cannot boot the app. This config serves the
// production build over TLS with a self-signed certificate for the public IP.
import process from 'node:process'

import { readFileSync } from 'node:fs'

import base, { breezeTtsProxy, ollamaProxy } from './vite.config'

const keyPath = process.env.AIRI_TLS_KEY ?? 'D:/AI/内网穿透/certs/airi-key.pem'
const certPath = process.env.AIRI_TLS_CERT ?? 'D:/AI/内网穿透/certs/airi-cert.pem'

export default {
  ...base,
  preview: {
    ...base.preview,
    // The public link reaches the loopback TTS server through this origin, so
    // the seeded `/breeze-tts/` base URL resolves here exactly as it does in
    // the dev server. `/ollama` needs the same treatment: the phone cannot
    // reach the loopback Ollama port on its own.
    proxy: { ...base.preview?.proxy, ...breezeTtsProxy, ...ollamaProxy },
    host: '127.0.0.1',
    port: Number(process.env.AIRI_PREVIEW_PORT ?? 4174),
    strictPort: true,
    https: {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
  },
}
