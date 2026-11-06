import { errorMessageFrom } from '@moeru/std'

/** A message from the character that can reach the owner while the app is in the background. */
export interface CharacterNotification {
  /** The character or app name shown as the notification title. */
  title: string
  /** One short message. Native notifications clip long text themselves. */
  body: string
  /** The conversation that the notification opens when the owner taps it. */
  sessionId?: string
  /**
   * Notifications with the same tag replace each other, so a chatty character leaves one entry.
   * Defaults to the session id, or the title when there is no session.
   */
  tag?: string
}

export type CharacterNotificationPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'

export interface CharacterNotificationStatus {
  permission: CharacterNotificationPermission
  /**
   * The system lowered or blocked the app's message channel. Only native adapters can report it,
   * because the Web Notification API does not expose channel importance.
   */
  channelBlocked?: boolean
}

/**
 * A platform that can show a notification while the app is not in front.
 *
 * The default delivery uses the Web Notification API. stage-pocket registers a Capacitor delivery
 * that posts through a native channel, because Android WebView does not construct `Notification`.
 */
export interface CharacterNotificationDelivery {
  status: () => Promise<CharacterNotificationStatus>
  requestPermission: () => Promise<CharacterNotificationPermission>
  /** Returns whether the notification reached the system. A refusal or a platform error returns false. */
  show: (notification: CharacterNotification) => Promise<boolean>
  /** Opens the system page where the owner can allow notifications. Omitted when the platform has no page. */
  openSettings?: () => Promise<void>
}

function toWebPermission(): CharacterNotificationPermission {
  if (typeof globalThis.Notification === 'undefined')
    return 'unsupported'
  switch (globalThis.Notification.permission) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    default:
      return 'prompt'
  }
}

function createWebNotificationDelivery(): CharacterNotificationDelivery {
  return {
    async status() {
      return { permission: toWebPermission() }
    },
    async requestPermission() {
      if (typeof globalThis.Notification === 'undefined')
        return 'unsupported'
      if (globalThis.Notification.permission !== 'default')
        return toWebPermission()
      const result = await globalThis.Notification.requestPermission()
      return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'prompt'
    },
    async show(notification) {
      if (toWebPermission() !== 'granted')
        return false
      try {
        const shown = new globalThis.Notification(notification.title, {
          body: notification.body,
          tag: notification.tag ?? notification.sessionId ?? notification.title,
        })
        shown.onclick = () => {
          if (typeof window !== 'undefined')
            window.focus()
          shown.close()
        }
        return true
      }
      catch {
        // Android Chrome refuses to construct a page notification and needs a service worker instead.
        // stage-pocket avoids this path by registering the Capacitor delivery.
        return false
      }
    },
  }
}

let delivery: CharacterNotificationDelivery = createWebNotificationDelivery()

/** Replaces the delivery for this app. stage-pocket calls it once at startup. */
export function registerCharacterNotificationDelivery(next: CharacterNotificationDelivery) {
  delivery = next
}

/** Restores the Web Notification delivery. Tests use it to leave no adapter behind. */
export function resetCharacterNotificationDelivery() {
  delivery = createWebNotificationDelivery()
}

export function getCharacterNotificationDelivery() {
  return delivery
}

export async function getCharacterNotificationStatus(): Promise<CharacterNotificationStatus> {
  try {
    return await delivery.status()
  }
  catch (error) {
    console.warn('[notifications] Could not read the notification status:', errorMessageFrom(error))
    return { permission: 'unsupported' }
  }
}

export async function requestCharacterNotificationPermission(): Promise<CharacterNotificationPermission> {
  try {
    return await delivery.requestPermission()
  }
  catch (error) {
    console.warn('[notifications] Could not request the notification permission:', errorMessageFrom(error))
    return 'denied'
  }
}

/**
 * Shows one character message. A failed delivery never breaks the chat turn that produced it,
 * so the caller can fire this without a guard.
 */
export async function deliverCharacterNotification(notification: CharacterNotification): Promise<boolean> {
  try {
    return await delivery.show(notification)
  }
  catch (error) {
    console.warn('[notifications] Could not show the character message:', errorMessageFrom(error))
    return false
  }
}
