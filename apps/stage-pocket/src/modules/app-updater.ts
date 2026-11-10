import type { PluginListenerHandle } from '@capacitor/core'

import { registerPlugin } from '@capacitor/core'

export interface UpdateVersionInfo {
  versionCode: number
  versionName: string
}

export interface UpdateManifest extends UpdateVersionInfo {
  url: string
  sha256: string
  size: number
  notes: string
  publishedAt: string
}

export interface UpdateCheckResult {
  updateAvailable: boolean
  current: UpdateVersionInfo
  latest: UpdateManifest
}

/** Where the running pages come from: the APK itself, or a bundle that arrived over the air. */
export interface BundleRuntimeState {
  id: number
  versionName: string
  source: 'builtin' | 'downloaded'
  basePath: string
  /** The bundle is running for the first time and has not reported that its page came up. */
  pending: boolean
}

export interface BundleRelease {
  id: number
  versionName: string
  /** The lowest APK version code that can run this bundle. */
  nativeVersion: number
  notes: string
  publishedAt: string
  /** Every file of the bundle, in bytes. */
  size: number
}

export interface BundlePlan {
  /** Files to download. The rest are copied from the running bundle. */
  files: number
  bytes: number
  /** Files in the release. */
  total: number
}

export type BundleCheckReason = 'available' | 'up-to-date' | 'native-required' | 'failed-before'

export interface BundleCheckResult {
  available: boolean
  reason: BundleCheckReason
  current: BundleRuntimeState
  latest: BundleRelease
  plan: BundlePlan
}

export interface BundleSyncResult {
  id: number
  path: string
}

export interface BundleProgress {
  received: number
  total: number
  phase: 'prepare' | 'download' | 'done'
}

export interface AppUpdaterPlugin {
  getVersion: () => Promise<UpdateVersionInfo>
  check: (options: { url: string }) => Promise<UpdateCheckResult>
  download: (options: { url: string, sha256?: string }) => Promise<{ path: string, bytes: number, sha256: string }>
  install: () => Promise<{ launched: boolean, needsPermission?: boolean }>
  canInstall: () => Promise<{ canInstall: boolean }>
  autoInstallStatus: () => Promise<{ accessibilityEnabled: boolean }>
  openAccessibilitySettings: () => Promise<void>
  openAppSettings: () => Promise<void>
  getBundleState: () => Promise<BundleRuntimeState>
  checkBundle: (options: { url: string }) => Promise<BundleCheckResult>
  syncBundle: (options: { url: string, id: number }) => Promise<BundleSyncResult>
  applyBundle: (options: { id: number }) => Promise<{ applied: boolean }>
  markBundleHealthy: () => Promise<void>
  addListener: {
    (eventName: 'downloadProgress', listener: (payload: { received: number, total: number }) => void): Promise<PluginListenerHandle>
    (eventName: 'bundleProgress', listener: (payload: BundleProgress) => void): Promise<PluginListenerHandle>
  }
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater')

/** Native APK updates are served by the owner's frp tunnel. */
export const DEFAULT_UPDATE_MANIFEST_URL = 'http://airi.example/latest.json'
export const UPDATE_MANIFEST_URL_KEY = 'settings/system/update-manifest-url'
export const AUTO_INSTALL_KEY = 'settings/system/auto-install'
export const AUTO_LIVE_UPDATE_KEY = 'settings/system/auto-live-update'
