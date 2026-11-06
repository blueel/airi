import type { PluginListenerHandle } from '@capacitor/core'

import { Capacitor, registerPlugin } from '@capacitor/core'

/** What the settings page shows. A permission that the owner denied stays false. */
export interface FloatingAssistantStatus {
  supported: boolean
  overlayPermission: boolean
  running: boolean
  projection: boolean
  microphonePermission: boolean
  wakeWordEnabled: boolean
  wakeWordState: 'stopped' | 'listening' | 'command' | 'paused'
  wakeWordListening: boolean
  wakeWordPhrases: string[]
  wakeWordError?: string
  /** The companion frame loop runs on the bubble's screen capture session. */
  watching: boolean
}

interface FloatingAssistantListener {
  (eventName: 'capture', listener: (capture: { dataUrl: string }) => void): Promise<PluginListenerHandle>
  (eventName: 'transcript', listener: (transcript: { text: string }) => void): Promise<PluginListenerHandle>
  (eventName: 'watchFrame', listener: (frame: { dataUrl: string, hash?: string }) => void): Promise<PluginListenerHandle>
}

interface FloatingAssistantPlugin {
  status: () => Promise<FloatingAssistantStatus>
  start: () => Promise<{ running: boolean }>
  stop: () => Promise<void>
  ready: () => Promise<void>
  consumePendingCapture: () => Promise<{ dataUrl?: string }>
  consumePendingTranscript: () => Promise<{ text?: string }>
  toast: (options: { text: string }) => Promise<void>
  setWakeWord: (options: { enabled: boolean, phrases: string[], language?: string }) => Promise<FloatingAssistantStatus>
  setWakeWordSpeaking: (options: { speaking: boolean }) => Promise<void>
  startWatching: (options: { intervalMs: number }) => Promise<{ watching: boolean }>
  stopWatching: () => Promise<void>
  addListener: FloatingAssistantListener
}

export const FloatingAssistant = registerPlugin<FloatingAssistantPlugin>('FloatingBubble')

/** The overlay bubble exists only in the Android app. */
export function isFloatingAssistantSupported() {
  return Capacitor.getPlatform() === 'android'
}
