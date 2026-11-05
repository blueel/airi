import type { CapacitorConfig } from '@capacitor/cli'

import { argv, env } from 'node:process'

const serverURL = env.CAPACITOR_DEV_SERVER_URL

const appId = argv.includes('android') ? 'ai.moeru.airi_pocket' : 'ai.moeru.airi-pocket'

const config: CapacitorConfig = {
  appId,
  appName: 'AIRI',
  webDir: 'dist',
  server: serverURL
    ? {
        url: serverURL,
        cleartext: false,
      }
    : undefined,
  android: {
    // NOTICE:
    // The app page runs on https://localhost, while the local Breeze-TTS and
    // update servers are served over plain HTTP. Without this flag Android
    // WebView blocks every request as mixed content and the provider reports
    // "Failed to fetch".
    // The app already allows cleartext traffic; the remaining gate is the
    // WebView mixed-content policy.
    // Removal condition: serve every local provider over HTTPS.
    allowMixedContent: true,
    buildOptions: {
      keystorePath: env.CAPACITOR_ANDROID_KEYSTORE_PATH,
      keystoreAlias: env.CAPACITOR_ANDROID_KEYSTORE_ALIAS,
      keystorePassword: env.CAPACITOR_ANDROID_KEYSTORE_PASSWORD,
      keystoreAliasPassword: env.CAPACITOR_ANDROID_KEYSTORE_ALIAS_PASSWORD,
      releaseType: 'APK',
      signingType: 'apksigner',
    },
  },
}

export default config
