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

export interface AppUpdaterPlugin {
  getVersion: () => Promise<UpdateVersionInfo>
  check: (options: { url: string }) => Promise<UpdateCheckResult>
  download: (options: { url: string, sha256?: string }) => Promise<{ path: string, bytes: number, sha256: string }>
  install: () => Promise<{ launched: boolean, needsPermission?: boolean }>
  canInstall: () => Promise<{ canInstall: boolean }>
  autoInstallStatus: () => Promise<{ accessibilityEnabled: boolean }>
  openAccessibilitySettings: () => Promise<void>
  openAppSettings: () => Promise<void>
  addListener: (
    eventName: 'downloadProgress',
    listener: (payload: { received: number, total: number }) => void,
  ) => Promise<PluginListenerHandle>
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater')

/** Native APK updates are served by the owner's frp tunnel. */
export const DEFAULT_UPDATE_MANIFEST_URL = 'http://airi.example/latest.json'
export const UPDATE_MANIFEST_URL_KEY = 'settings/system/update-manifest-url'
export const AUTO_INSTALL_KEY = 'settings/system/auto-install'
