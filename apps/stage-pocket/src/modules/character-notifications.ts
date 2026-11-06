import type { PermissionState } from '@capacitor/core'
import type {
  CharacterNotification,
  CharacterNotificationPermission,
  CharacterNotificationStatus,
} from '@proj-airi/stage-ui/libs/notifications'

import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { errorMessageFrom } from '@moeru/std'
import { registerCharacterNotificationDelivery } from '@proj-airi/stage-ui/libs/notifications'
import { AndroidSettings, IOSSettings, NativeSettings } from 'capacitor-native-settings'

/**
 * One channel for messages the character starts on her own. High importance shows a heads-up banner,
 * which is what makes a proactive message visible while the owner is in another app.
 */
const CHANNEL_ID = 'character_messages'
const CHANNEL_NAME = 'Character messages'
const CHANNEL_IMPORTANCE_HIGH = 4

function toPermission(state: PermissionState): CharacterNotificationPermission {
  switch (state) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    default:
      return 'prompt'
  }
}

/**
 * A stable positive 32-bit id from the tag. Android updates a notification with the same id,
 * so a session leaves one entry instead of a stack of messages.
 */
function notificationId(notification: CharacterNotification) {
  const key = notification.tag ?? notification.sessionId ?? notification.title
  let hash = 0x811C9DC5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return 1 + ((hash >>> 0) % 0x7FFFFFFE)
}

async function isChannelBlocked() {
  if (Capacitor.getPlatform() !== 'android')
    return false
  const { channels } = await LocalNotifications.listChannels()
  return channels.find(channel => channel.id === CHANNEL_ID)?.importance === 0
}

/**
 * Replaces the Web Notification delivery with Capacitor local notifications.
 *
 * Use when:
 * - stage-pocket starts on a native platform and character messages must survive the app leaving the foreground.
 *
 * Expects:
 * - The owner allowed notifications. The delivery checks the permission before every post,
 *   because Android forbids a permission prompt from the background.
 *
 * Returns:
 * - Nothing. On the web this is a no-op, so the default Web Notification delivery stays.
 */
export function installCharacterNotificationDelivery(options: { openSession?: (sessionId: string) => void } = {}) {
  if (!Capacitor.isNativePlatform())
    return

  if (Capacitor.getPlatform() === 'android') {
    void LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: CHANNEL_NAME,
      description: 'Messages the character starts while the app is in the background.',
      importance: CHANNEL_IMPORTANCE_HIGH,
      visibility: 1,
      vibration: true,
    }).catch(error => console.warn('[notifications] Could not create the message channel:', errorMessageFrom(error)))
  }

  void LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    const extra: unknown = event.notification.extra
    const sessionId = typeof extra === 'object' && extra !== null && 'sessionId' in extra ? extra.sessionId : undefined
    if (typeof sessionId === 'string' && sessionId)
      options.openSession?.(sessionId)
  })

  registerCharacterNotificationDelivery({
    async status(): Promise<CharacterNotificationStatus> {
      const permission = await LocalNotifications.checkPermissions()
      return {
        permission: toPermission(permission.display),
        channelBlocked: await isChannelBlocked().catch(() => false),
      }
    },
    async requestPermission() {
      const permission = await LocalNotifications.requestPermissions()
      return toPermission(permission.display)
    },
    async show(notification) {
      const permission = await LocalNotifications.checkPermissions()
      if (permission.display !== 'granted')
        return false

      await LocalNotifications.schedule({
        notifications: [{
          id: notificationId(notification),
          title: notification.title,
          body: notification.body,
          largeBody: notification.body,
          channelId: CHANNEL_ID,
          autoCancel: true,
          extra: { sessionId: notification.sessionId },
          schedule: { at: new Date(Date.now() + 500), allowWhileIdle: true },
        }],
      })
      return true
    },
    async openSettings() {
      await NativeSettings.open({
        optionAndroid: AndroidSettings.AppNotification,
        optionIOS: IOSSettings.AppNotification,
      })
    },
  })
}
