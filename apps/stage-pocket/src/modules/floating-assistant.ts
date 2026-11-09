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

/** One prepared HTTP request for a turn that the service runs while the WebView cannot. */
export interface FloatingAssistantHttpCall {
  url: string
  headers: Record<string, string>
  /** The request body without the fields that change for each turn. */
  body: Record<string, unknown>
}

/**
 * The chat and speech requests for a background turn.
 *
 * The WebView builds them with the same helpers as a normal turn, so provider URLs, headers, and options stay in
 * one place. `enabled: false` turns the native path off and keeps the usual WebView path.
 */
export interface FloatingAssistantBackgroundReplyConfig {
  enabled: boolean
  sessionId: string
  systemPrompt: string
  history: Array<{ role: 'user' | 'assistant', content: string }>
  chat: FloatingAssistantHttpCall
  speech: FloatingAssistantHttpCall
}

/** One exchange that the service finished while the WebView could not run. */
export interface FloatingAssistantBackgroundTurn {
  id: string
  sessionId: string
  userText: string
  assistantText: string
  createdAt: number
  completedAt: number
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
  syncBackgroundReply: (options: { config: FloatingAssistantBackgroundReplyConfig }) => Promise<void>
  consumeBackgroundTurns: () => Promise<{ turns: FloatingAssistantBackgroundTurn[] }>
  startWatching: (options: { intervalMs: number }) => Promise<{ watching: boolean }>
  stopWatching: () => Promise<void>
  addListener: FloatingAssistantListener
}

export const FloatingAssistant = registerPlugin<FloatingAssistantPlugin>('FloatingBubble')

/** The overlay bubble exists only in the Android app. */
export function isFloatingAssistantSupported() {
  return Capacitor.getPlatform() === 'android'
}
