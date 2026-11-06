import type { RouteRecordNormalized } from 'vue-router'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

/** The groups of the settings home, in the order that they show. */
export const SETTINGS_GROUPS = [
  { id: 'character', icon: 'i-solar:user-heart-bold-duotone' },
  { id: 'ai', icon: 'i-solar:cpu-bolt-bold-duotone' },
  { id: 'app', icon: 'i-solar:widget-6-bold-duotone' },
] as const

export type SettingsGroupId = typeof SETTINGS_GROUPS[number]['id']

/** A settings page in the home. */
export interface SettingsEntry {
  title: string
  description: string
  icon?: string
  to: string
}

/** A named set of settings pages in the home. */
export interface SettingsGroup {
  id: SettingsGroupId
  title: string
  description: string
  icon: string
  items: SettingsEntry[]
}

/** The route meta that a settings page sets in its `<route>` block. */
export interface SettingsRouteMeta {
  settingsEntry?: boolean
  settingsGroup?: SettingsGroupId
  order?: number
  titleKey?: string
  descriptionKey?: string
  title?: string
  description?: string
  icon?: string
}

function isSettingsEntry(route: RouteRecordNormalized) {
  return Boolean((route.meta as SettingsRouteMeta).settingsEntry)
}

/**
 * Groups the settings pages by the group that each page sets in its route meta.
 *
 * Use when:
 * - A settings home shows every settings page, grouped by what the pages configure.
 *
 * Expects:
 * - Each page with `settingsEntry: true` also sets `settingsGroup`.
 *
 * Returns:
 * - The groups in their fixed order, with the pages of each group in `order`.
 *   An empty group is not returned.
 */
export function useSettingsGroups() {
  const router = useRouter()
  const { t } = useI18n()

  const groups = computed<SettingsGroup[]>(() => {
    const routes = router
      .getRoutes()
      .filter(isSettingsEntry)
      .sort((a, b) => Number((a.meta as SettingsRouteMeta).order ?? 0) - Number((b.meta as SettingsRouteMeta).order ?? 0))

    return SETTINGS_GROUPS.flatMap(({ id, icon }) => {
      const items = routes
        // A page without a group stays reachable in the app group.
        .filter(route => ((route.meta as SettingsRouteMeta).settingsGroup ?? 'app') === id)
        .map((route): SettingsEntry => {
          const meta = route.meta as SettingsRouteMeta
          return {
            title: meta.titleKey ? t(meta.titleKey) : (meta.title ?? ''),
            description: meta.descriptionKey ? t(meta.descriptionKey) : (meta.description ?? ''),
            icon: meta.icon,
            to: route.path,
          }
        })

      if (!items.length)
        return []

      return [{
        id,
        icon,
        title: t(`settings.groups.${id}.title`),
        description: t(`settings.groups.${id}.description`),
        items,
      }]
    })
  })

  return { groups }
}
