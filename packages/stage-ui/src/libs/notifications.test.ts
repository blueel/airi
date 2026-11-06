import type { CharacterNotification, CharacterNotificationDelivery } from './notifications'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deliverCharacterNotification,
  getCharacterNotificationDelivery,
  getCharacterNotificationStatus,
  registerCharacterNotificationDelivery,
  requestCharacterNotificationPermission,
  resetCharacterNotificationDelivery,
} from './notifications'

function delivery(overrides: Partial<CharacterNotificationDelivery> = {}): CharacterNotificationDelivery {
  return {
    status: vi.fn(async () => ({ permission: 'granted' as const })),
    requestPermission: vi.fn(async () => 'granted' as const),
    show: vi.fn(async () => true),
    ...overrides,
  }
}

afterEach(() => resetCharacterNotificationDelivery())

describe('character notification delivery', () => {
  it('falls back to the Web Notification delivery', async () => {
    expect(getCharacterNotificationDelivery()).toBeDefined()
    expect(await requestCharacterNotificationPermission()).toBe('unsupported')
  })

  it('forwards a message to the registered delivery', async () => {
    const target = delivery()
    registerCharacterNotificationDelivery(target)
    const message: CharacterNotification = { title: 'Iru', body: 'Are you there?', sessionId: 'session-1' }

    expect(await deliverCharacterNotification(message)).toBe(true)
    expect(target.show).toHaveBeenCalledWith(message)
  })

  it('keeps a failed delivery from breaking the caller', async () => {
    registerCharacterNotificationDelivery(delivery({
      show: vi.fn(async () => {
        throw new Error('offline')
      }),
    }))

    expect(await deliverCharacterNotification({ title: 'Iru', body: '' })).toBe(false)
  })

  it('delegates the permission request and the status', async () => {
    const target = delivery()
    registerCharacterNotificationDelivery(target)

    expect(await requestCharacterNotificationPermission()).toBe('granted')
    expect(await getCharacterNotificationStatus()).toEqual({ permission: 'granted' })
  })

  it('restores the fallback after a reset', async () => {
    registerCharacterNotificationDelivery(delivery())
    resetCharacterNotificationDelivery()

    expect(await getCharacterNotificationStatus()).toEqual({ permission: 'unsupported' })
  })
})
