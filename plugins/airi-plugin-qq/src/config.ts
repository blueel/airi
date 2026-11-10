import { env } from 'node:process'

export interface QQAirIConfig {
  airi: {
    url: string
    token?: string
  }
  onebot: {
    host: string
    port: number
    path: string
    token?: string
  }
  behavior: {
    /**
     * A group message reaches the model only when it mentions this account or starts with the
     * trigger prefix. Turn this off to let the model read every group message.
     */
    groupRequireMention: boolean
    /** Optional prefix that also triggers a reply in a group, on top of a mention. */
    triggerPrefix: string
    /** Groups the bridge serves. Undefined means every group. */
    allowedGroups?: Set<number>
    /** Members the bridge serves in private chat. Undefined means every member. */
    allowedUsers?: Set<number>
    /** Upper bound of one outgoing QQ message, in characters. */
    maxChunkLength: number
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (!value)
    return fallback

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanFrom(value: string | undefined, fallback: boolean): boolean {
  if (!value)
    return fallback

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized))
    return true
  if (['0', 'false', 'no', 'off'].includes(normalized))
    return false

  return fallback
}

function idSetFrom(value: string | undefined): Set<number> | undefined {
  if (!value)
    return undefined

  const ids = value
    .split(',')
    .map(item => Number(item.trim()))
    .filter(id => Number.isSafeInteger(id) && id > 0)

  return ids.length ? new Set(ids) : undefined
}

function normalizePath(value: string | undefined): string {
  const path = value?.trim()
  if (!path)
    return '/onebot'

  return path.startsWith('/') ? path : `/${path}`
}

export function loadConfig(): QQAirIConfig {
  return {
    airi: {
      url: emptyToUndefined(env.AIRI_SERVER_URL) ?? 'ws://localhost:6121/ws',
      token: emptyToUndefined(env.AIRI_SERVER_TOKEN),
    },
    onebot: {
      host: emptyToUndefined(env.QQ_ONEBOT_HOST) ?? '127.0.0.1',
      port: numberFrom(env.QQ_ONEBOT_PORT, 6700),
      path: normalizePath(env.QQ_ONEBOT_PATH),
      token: emptyToUndefined(env.QQ_ONEBOT_TOKEN),
    },
    behavior: {
      groupRequireMention: booleanFrom(env.QQ_GROUP_REQUIRE_MENTION, true),
      triggerPrefix: emptyToUndefined(env.QQ_TRIGGER_PREFIX) ?? '',
      allowedGroups: idSetFrom(env.QQ_ALLOWED_GROUPS),
      allowedUsers: idSetFrom(env.QQ_ALLOWED_USERS),
      maxChunkLength: Math.max(40, Math.floor(numberFrom(env.QQ_MAX_CHUNK_LENGTH, 1200))),
    },
  }
}
