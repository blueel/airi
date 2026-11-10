import type { BundleCheckResult, BundleProgress, BundleRuntimeState } from './app-updater'

import { Capacitor } from '@capacitor/core'
import { errorMessageFrom } from '@moeru/std'
import { useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'

import {
  AppUpdater,
  AUTO_LIVE_UPDATE_KEY,
  DEFAULT_UPDATE_MANIFEST_URL,
  UPDATE_MANIFEST_URL_KEY,
} from './app-updater'

/**
 * Drives the page bundle that updates without an APK.
 *
 * The native side owns the rules: it fetches a signed index, copies the files it already has, downloads the rest, and
 * switches directories only after every hash matches. This module only reports what the owner sees, and starts one
 * quiet check per launch so an update arrives without an APK download.
 */

const CHECK_DELAY_MS = 15_000
const HEALTH_DELAY_MS = 2_000

interface NetworkInformationLike {
  type?: string
  saveData?: boolean
}

export const manifestUrl = useLocalStorage(UPDATE_MANIFEST_URL_KEY, DEFAULT_UPDATE_MANIFEST_URL)
export const autoLiveUpdate = useLocalStorage(AUTO_LIVE_UPDATE_KEY, true)

export const bundleState = ref<BundleRuntimeState | null>(null)
/** Whether the installed APK has the bundle updater. Builds before it only know the APK update. */
export const bundleSupported = ref(false)
export const bundleCheck = ref<BundleCheckResult | null>(null)
export const bundleProgress = ref<BundleProgress>({ received: 0, total: 0, phase: 'prepare' })
export const bundleChecking = ref(false)
export const bundleSyncing = ref(false)
export const bundleStaged = ref(false)
export const bundleError = ref('')

let installed = false

export function isBundleUpdaterAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

function messageOf(cause: unknown) {
  return errorMessageFrom(cause) ?? 'Unknown error'
}

/** A metered connection should not receive a bundle on its own. */
function isMeteredConnection() {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  return connection?.saveData === true || connection?.type === 'cellular'
}

export async function refreshBundleState() {
  if (!isBundleUpdaterAvailable())
    return
  try {
    bundleState.value = await AppUpdater.getBundleState()
    bundleSupported.value = true
  }
  catch (cause) {
    bundleSupported.value = false
    bundleError.value = messageOf(cause)
  }
}

/**
 * Runs on every launch: reports that the running bundle came up, so the next start keeps it, and schedules one quiet
 * check. The page mounts after the first screen, so a bundle that starts blank never reports and goes back.
 */
export function installLiveUpdates() {
  if (installed || !isBundleUpdaterAvailable())
    return
  installed = true

  // The mount runs before the first screen paints, so a bundle that throws while it renders still goes back: without
  // this report the next start drops it.
  window.setTimeout(() => {
    void AppUpdater.markBundleHealthy().catch(cause => console.warn('Could not confirm the page bundle:', messageOf(cause)))
  }, HEALTH_DELAY_MS)
  void AppUpdater.addListener('bundleProgress', (payload) => {
    bundleProgress.value = payload
  })
  void refreshBundleState()

  if (!autoLiveUpdate.value)
    return

  window.setTimeout(() => void syncInBackground(), CHECK_DELAY_MS)
}

async function syncInBackground() {
  if (!autoLiveUpdate.value || isMeteredConnection())
    return

  const result = await checkBundleUpdate({ quiet: true })
  if (!result?.available)
    return

  await syncBundleUpdate({ quiet: true })
}

export async function checkBundleUpdate(options: { quiet?: boolean } = {}) {
  if (!isBundleUpdaterAvailable() || bundleChecking.value)
    return null

  if (!options.quiet)
    bundleError.value = ''
  bundleChecking.value = true
  try {
    bundleCheck.value = await AppUpdater.checkBundle({ url: manifestUrl.value })
    return bundleCheck.value
  }
  catch (cause) {
    if (!options.quiet)
      bundleError.value = messageOf(cause)
    return null
  }
  finally {
    bundleChecking.value = false
  }
}

export async function syncBundleUpdate(options: { quiet?: boolean } = {}) {
  const check = bundleCheck.value
  if (!check?.available || bundleSyncing.value)
    return false

  if (!options.quiet)
    bundleError.value = ''
  bundleStaged.value = false
  bundleSyncing.value = true
  bundleProgress.value = { received: 0, total: check.plan.bytes, phase: 'prepare' }
  try {
    await AppUpdater.syncBundle({ url: manifestUrl.value, id: check.latest.id })
    bundleStaged.value = true
    await refreshBundleState()
    return true
  }
  catch (cause) {
    bundleError.value = messageOf(cause)
    return false
  }
  finally {
    bundleSyncing.value = false
  }
}

/** Switches to the downloaded bundle now. The page reloads, and the new pages report health on their own. */
export async function applyBundleUpdate() {
  const id = bundleCheck.value?.latest.id
  if (!id)
    return false

  try {
    await AppUpdater.applyBundle({ id })
    return true
  }
  catch (cause) {
    bundleError.value = messageOf(cause)
    return false
  }
}
