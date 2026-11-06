import type { Plugin } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'

// The polyfill must evaluate before any module that calls the ES2024 APIs at module
// scope, so this import order is deliberate and exempt from sorting.
/* eslint-disable perfectionist/sort-imports */
import '@proj-airi/stage-shared/polyfills'

import Tres from '@tresjs/core'
import NProgress from 'nprogress'
/* eslint-enable perfectionist/sort-imports */

import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { autoAnimatePlugin } from '@formkit/auto-animate/vue'
import { errorMessageFrom } from '@moeru/std'
import { settingsSearchModules } from '@proj-airi/stage-pages/settings-search'
import { isEnvTruthy } from '@proj-airi/stage-shared'
import { trackButtonPlugin } from '@proj-airi/stage-ui/directives/track-button'
import { browserAuthorizationHandler, registerAuthorizationHandler } from '@proj-airi/stage-ui/libs/auth'
import { setupSynced } from '@proj-airi/stage-ui/libs/pinia'
import { configureAnalyticsAdapter } from '@proj-airi/stage-ui/libs/product-signals'
import { settingsSearch } from '@proj-airi/stage-ui/libs/settings-search'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { MotionPlugin } from '@vueuse/motion'
import { createPinia } from 'pinia'
import { setupLayouts } from 'virtual:generated-layouts'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'

import App from './App.vue'

import { installCharacterNotificationDelivery } from './modules/character-notifications'
import { installDeepLinks } from './modules/deep-links'
import { i18n } from './modules/i18n'
import { WebAuthentication } from './modules/web-authentication'
import { setupMikaTools } from './stores/tools/mika'

// NOTICE:
// Pocket slim build: the two CJK fonts (@proj-airi/font-cjkfonts-allseto,
// @proj-airi/font-xiaolai) are ~35MB in the APK. They are removed here and
// stripped from the bundle in vite.config.ts (stripVoiceRuntimeAssets); the
// UnoCSS preflight still emits @font-face declarations, but the missing files
// make the browser fall back to system fonts. Text rendering is unaffected.
// Removal condition: restore these imports and un-strip the fonts when the
// original typography is wanted.
import '@unocss/reset/tailwind.css'
import 'splitpanes/dist/splitpanes.css'
import 'vue-sonner/style.css'
import './styles/main.css'
import 'uno.css'

configureAnalyticsAdapter(async (options) => {
  const { createOpenpanelAdapter } = await import('@proj-airi/stage-ui/libs/product-signals/openpanel')
  return createOpenpanelAdapter(options)
})

if (Capacitor.isNativePlatform()) {
  if (Capacitor.getPlatform() === 'ios') {
    void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch((error) => {
      console.warn('Failed to hide the iOS keyboard accessory bar:', errorMessageFrom(error))
    })
  }

  registerAuthorizationHandler(async ({ authorizationUrl, provider }) => {
    const url = new URL(authorizationUrl)
    if (provider)
      url.searchParams.set('provider', provider)

    return await WebAuthentication.authenticate({
      callbackScheme: 'ai.moeru.airi-pocket',
      url: url.toString(),
    })
  })
}
else {
  registerAuthorizationHandler(browserAuthorizationHandler)
}

// The settings search lists only what these modules hold. Each module decides at runtime whether it is on.
for (const [name, source] of Object.entries(settingsSearchModules))
  settingsSearch.provide(name, source)

const pinia = createPinia()
const synced = setupSynced()
pinia.use(synced.pinia)

setupMikaTools(pinia)

// TODO: vite-plugin-vue-layouts is long deprecated, replace with another layout solution
const routeRecords = setupLayouts(routes as RouteRecordRaw[])

let router: Router
if (isEnvTruthy(import.meta.env.VITE_APP_TARGET_HUGGINGFACE_SPACE))
  router = createRouter({ routes: routeRecords, history: createWebHashHistory() })
else
  router = createRouter({ routes: routeRecords, history: createWebHistory() })

router.beforeEach((to, from) => {
  if (to.path !== from.path)
    NProgress.start()
})

router.afterEach(() => {
  NProgress.done()
})

window.addEventListener('unhandledrejection', (event) => {
  console.warn('Unhandled rejection:', event.reason)
})

installDeepLinks(router)

installCharacterNotificationDelivery({
  openSession: (sessionId) => {
    void router.push('/')
    void useChatSessionStore(pinia)
      .setActiveSession(sessionId)
      .catch(error => console.warn('[notifications] Could not open the session:', errorMessageFrom(error)))
  },
})

createApp(App)
  .use(synced.vue)
  .use(MotionPlugin)
  // TODO: Fix autoAnimatePlugin type error
  .use(autoAnimatePlugin as unknown as Plugin)
  .use(router)
  .use(pinia)
  .use(i18n)
  .use(Tres)
  .use(trackButtonPlugin)
  .mount('#app')

if (import.meta.env.DEV && !import.meta.env.SSR) {
  function captureEvents(el: HTMLElement) {
    // Force `pointer-events: auto` as DismissableLayer in Reka UI adds
    // `pointer-events: none` to document body.
    el.style.pointerEvents = 'auto'

    // We need to capture events inside elements like devtools to prevent them
    // from leaking to other layers (like DismissableLayer in Reka UI).
    //
    // See: https://github.com/unovue/reka-ui/blob/14866201d179b8bae3c8b4346a1ca8eff1c5eaa4/packages/radix-vue/src/DismissableLayer/DismissableLayer.vue#L186-L188
    el.addEventListener('focus', e => e.stopPropagation(), { capture: true })
    el.addEventListener('blur', e => e.stopPropagation(), { capture: true })
    el.addEventListener('pointerdown', e => e.stopPropagation(), { capture: true })
  }

  const observer = new MutationObserver((mutationsList, observer) => {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList') {
        const devtoolsContainer = document.getElementById('__vue-devtools-container__')

        if (devtoolsContainer) {
          captureEvents(devtoolsContainer)
          observer.disconnect()
        }
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })

  // Disconnect on timeout in case the MutationObserver is left here forever.
  // `observer.disconnect()` is idempotent, so it's safe to call it multiple times.
  setTimeout(() => observer.disconnect(), 15 * 1000)
}
