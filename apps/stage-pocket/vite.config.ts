/// <reference types="./vite.config-env.d.ts" />

import type { PluginOption } from 'vite'

import process from 'node:process'

import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import messages from '@proj-airi/i18n/locales'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'
import Info from 'unplugin-info/vite'
import Yaml from 'unplugin-yaml/vite'
import mkcert from 'vite-plugin-mkcert'
import VueDevTools from 'vite-plugin-vue-devtools'
import Layouts from 'vite-plugin-vue-layouts'
import VueMacros from 'vue-macros/vite'
import VueRouter from 'vue-router/vite'

import { tryCatch } from '@moeru/std'
import { localeRemap, serializeStartupFallbackLocales } from '@proj-airi/i18n'
import { paraformerBilingualZhEn, xAsrBilingualZhEnInt8, zipformerMultilingual } from '@proj-airi/provider-inference/sherpaw-transcription/models'
import { createSettingsSearch } from '@proj-airi/stage-pages/vite/settings-search'
import { speakerModel } from '@proj-airi/stage-shared/speaker-model'
import { kwsModel } from '@proj-airi/stage-ui/libs/voice/kws-model-info'
import { DownloadLive2DSDK } from '@proj-airi/unplugin-live2d-sdk/vite'
import { Sherpaw } from '@proj-airi/vite-plugin-sherpaw'
import { defineConfig } from 'vite'

// import { isEnvTruthy } from '@proj-airi/stage-shared'
function isEnvTruthy(value: string | undefined | null): boolean {
  if (value == null)
    return false

  return /^(?:1|true|t|yes|y|on)$/i.test(value.trim())
}

/**
 * NOTICE:
 * Pocket-specific slim build: strips the local voice runtimes (ASR, keyword
 * spotting, speaker diarization/embedding, and the bundled wake-word model)
 * from the output. The sherpa-onnx WASM engines arrive as assets through
 * `@sherpaw/asr` / `@sherpaw/xsai-transcription` imports shared with the other
 * stage apps; the code only fetches them when a voice feature is used, so
 * deleting the assets degrades exactly those features instead of the whole app.
 * Saves ~60MB in the APK. TTS (Breeze-TTS) runs on a remote server and is
 * unaffected.
 * The two CJK fonts (~35MB) are stripped by the same plugin: the @font-face
 * declarations survive, the missing files fall back to system fonts.
 * Removal condition: restore when local speech recognition or the original
 * typography is wanted on mobile.
 */
const STRIPPED_VOICE_ASSETS = /(?:^|\/)(?:asr|kws|speaker-embedding|sherpa-onnx-wasm-main-speaker-diarization)-[^/]+\.wasm$|^preload-[^/]+\.data$|cjkFonts_allseto-[^/]+\.ttf$|XiaolaiSC-[^/]+\.ttf$/

function stripVoiceRuntimeAssets(): PluginOption {
  return {
    name: 'airi-pocket-strip-voice-runtime',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (STRIPPED_VOICE_ASSETS.test(name))
          delete bundle[name]
      }
    },
  }
}

const sharedCacheDir = resolve(join(import.meta.dirname, '..', '..', '.cache'))
const settingsSearch = createSettingsSearch()
const funasrOrigin = process.env.AIRI_FUNASR_ORIGIN?.trim()

export default defineConfig({
  optimizeDeps: {
    exclude: [
      // Internal Packages
      '@proj-airi/stage-ui/*',
      '@proj-airi/drizzle-duckdb-wasm',
      '@proj-airi/drizzle-duckdb-wasm/*',

      // Static Assets: Models, Images, etc.
      'public/assets/*',

      // Live2D SDK
      '@framework/live2dcubismframework',
      '@framework/math/cubismmatrix44',
      '@framework/type/csmvector',
      '@framework/math/cubismviewmatrix',
      '@framework/cubismdefaultparameterid',
      '@framework/cubismmodelsettingjson',
      '@framework/effect/cubismbreath',
      '@framework/effect/cubismeyeblink',
      '@framework/model/cubismusermodel',
      '@framework/motion/acubismmotion',
      '@framework/motion/cubismmotionqueuemanager',
      '@framework/type/csmmap',
      '@framework/utils/cubismdebug',
      '@framework/model/cubismmoc',
    ],
  },
  resolve: {
    alias: {
      '@proj-airi/server-sdk': resolve(join(import.meta.dirname, '..', '..', 'packages', 'server-sdk', 'src')),
      '@proj-airi/i18n': resolve(join(import.meta.dirname, '..', '..', 'packages', 'i18n', 'src')),
      '@proj-airi/stage-ui': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src')),
      '@proj-airi/stage-layouts': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-layouts', 'src')),
      '@proj-airi/stage-pages': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src')),
      '@proj-airi/stage-shared': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-shared', 'src')),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5273,
    proxy: (funasrOrigin
      ? {
          '/funasr': {
            target: funasrOrigin,
            changeOrigin: true,
            secure: false,
            rewrite: (path: string) => path.replace(/^\/funasr/, ''),
          },
        }
      : {}),
    fs: {
      // To mute errors like:
      //   The request id ".../node_modules/@fontsource/sniglet/files/sniglet-latin-400-normal.woff" is outside of Vite serving allow list.
      //
      // See: https://vite.dev/config/server-options#server-fs-strict
      strict: false,
    },
    warmup: {
      clientFiles: [
        `${resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src'))}/*.vue`,
        `${resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src'))}/*.vue`,
        `${resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-layouts', 'src'))}/*.vue`,
      ],
    },
  },
  build: {
    // NOTICE:
    // Pocket-specific slim build: sourcemaps are pure debugging payload and cost
    // ~25MB in the APK; the owner builds locally without needing them.
    // Removal condition: restore `true` when debugging a production build.
    sourcemap: false,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
      },
    },
  },

  plugins: [
    {
      name: 'airi-startup-locales',
      transformIndexHtml: html => html.replace('__AIRI_STARTUP_LOCALES__', serializeStartupFallbackLocales(messages, localeRemap)),
    },
    ...isEnvTruthy(process.env.VITE_SKIP_MKCERT ?? '')
      ? []
      : [mkcert((() => {
          // Workaround: plugin's bundled downloader has a feaxios bug, prefer system mkcert
          const command = process.platform === 'win32' ? 'where' : 'which'

          const { data } = tryCatch(() => ({ mkcertPath: execSync(`${command} mkcert`, { stdio: 'pipe' }).toString().trim().split(/\r?\n/)[0] }))
          return data
        })())],

    Info(),
    // NOTICE:
    // Pocket-specific slim build: transcription and speaker models stay remote,
    // and the wake-word model is no longer bundled (see stripVoiceRuntimeAssets).
    // Wake-word detection degrades to a download-on-demand failure until the
    // bundled model is restored here.
    Sherpaw({
      models: [paraformerBilingualZhEn, zipformerMultilingual, xAsrBilingualZhEnInt8, kwsModel, speakerModel],
      developmentModels: [],
      bundledModels: [],
      cacheDir: sharedCacheDir,
    }),

    stripVoiceRuntimeAssets(),

    Yaml(),

    settingsSearch.plugin,

    VueMacros({
      plugins: {
        vue: Vue({
          include: [/\.vue$/, /\.md$/],
          ...templateCompilerOptions,
        }),
        vueJsx: false,
      },
      betterDefine: false,
    }),

    VueRouter({
      extensions: ['.vue', '.md'],
      dts: resolve(import.meta.dirname, 'src/typed-router.d.ts'),
      importMode: 'async',
      routesFolder: [
        resolve(import.meta.dirname, 'src', 'pages'),
        {
          src: resolve(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src', 'pages'),
          exclude: base => [
            ...base,
            '**/settings/connection/index.vue',
            '**/settings/modules/beat-sync.vue',
          ],
        },
      ],
      exclude: ['**/components/**'],
      extendRoute: settingsSearch.extendRoute,
    }),

    // https://github.com/JohnCampionJr/vite-plugin-vue-layouts
    Layouts({
      layoutsDirs: [
        resolve(import.meta.dirname, 'src', 'layouts'),
        resolve(import.meta.dirname, '..', '..', 'packages', 'stage-layouts', 'src', 'layouts'),
      ],
    }),

    // https://github.com/antfu/unocss
    // see uno.config.ts for config
    Unocss(),

    // https://github.com/intlify/bundle-tools/tree/main/packages/unplugin-vue-i18n
    VueI18n({
      runtimeOnly: true,
      compositionOnly: true,
      fullInstall: true,
    }),

    // https://github.com/webfansplz/vite-plugin-vue-devtools
    VueDevTools(),

    // NOTICE:
    // Pocket slim build: preset model downloads removed together with the
    // trimmed `displayModelsPresets` in stage-ui (only 黑白猫猫 remains, which
    // lives in the repo, not behind a Download). Restore these calls together
    // with the preset entries when the other character models are wanted.
    DownloadLive2DSDK(),

    ...isEnvTruthy(process.env.VITE_CAP_SYNC_IOS_AFTER_BUILD ?? '')
      ? [{
          name: 'proj-airi:capacitor-sync',
          closeBundle: {
            sequential: true,
            handler() {
              if (this.meta.watchMode) {
                execSync('cap sync ios', { stdio: 'inherit' })
              }
            },
          },
        } as PluginOption]
      : [],

    {
      name: 'proj-airi:defines',
      config(ctx) {
        const define: Record<string, any> = {
          'import.meta.env.RUNTIME_ENVIRONMENT': '\'capacitor\'',
        }
        if (ctx.mode === 'development') {
          define['import.meta.env.URL_MODE'] = '\'server\''
        }
        if (ctx.mode === 'production') {
          define['import.meta.env.URL_MODE'] = '\'file\''
        }

        return { define }
      },
    },
  ],
})
