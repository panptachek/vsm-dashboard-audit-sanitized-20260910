import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BedDouble,
  Database,
  FileSpreadsheet,
  FileStack,
  FileText,
  LandPlot,
  Layers3,
  Map as MapIcon,
  MonitorPlay,
  Settings,
  Table2,
  Trophy,
  Truck,
} from 'lucide-react'

export interface SidebarNavItem {
  to: string
  icon: LucideIcon
  label: string
}

export interface SidebarSettingsItem {
  path: string
  enabled: boolean
  sort_order?: number | null
  fixed?: boolean | null
}

export interface SidebarSettingsPayload {
  items: SidebarSettingsItem[]
  updated_by?: string | null
  updated_at?: string | null
}

export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  { to: '/', icon: MonitorPlay, label: 'Дашборд' },
  { to: '/analytics', icon: BarChart3, label: 'Аналитика' },
  { to: '/section-rating', icon: Trophy, label: 'Рейтинг инженеров' },
  { to: '/reinforcement', icon: LandPlot, label: 'Участки усиления' },
  { to: '/zem-polotno', icon: Layers3, label: 'МСтрой' },
  { to: '/structural-schemes', icon: FileStack, label: 'Структурные схемы' },
  { to: '/pile', icon: LandPlot, label: 'Контроль свай' },
  { to: '/pilereports', icon: FileText, label: 'Ввод свай' },
  { to: '/map', icon: MapIcon, label: 'Карта трассы' },
  { to: '/mechanization', icon: Truck, label: 'Механизация' },
  { to: '/personnel-accommodation', icon: BedDouble, label: 'Размещение персонала' },
  { to: '/reports', icon: FileText, label: 'Отчёты' },
  { to: '/statements', icon: Table2, label: 'Ведомости' },
  { to: '/generator', icon: FileSpreadsheet, label: 'Генератор' },
  { to: '/database', icon: Database, label: 'База данных' },
  { to: '/settings', icon: Settings, label: 'Настройки' },
]

export const SIDEBAR_NAV_ITEM_BY_PATH = new Map(SIDEBAR_NAV_ITEMS.map(item => [item.to, item]))

export function mergeSidebarSettings(items?: SidebarSettingsItem[] | null): SidebarSettingsItem[] {
  const normalized: SidebarSettingsItem[] = []
  const seen = new Set<string>()

  for (const item of items ?? []) {
    const path = item?.path
    if (!path || seen.has(path) || !SIDEBAR_NAV_ITEM_BY_PATH.has(path)) continue
    seen.add(path)
    normalized.push({
      path,
      enabled: path === '/settings' ? true : item.enabled !== false,
      sort_order: normalized.length,
      fixed: path === '/settings' || Boolean(item.fixed),
    })
  }

  for (const navItem of SIDEBAR_NAV_ITEMS) {
    if (seen.has(navItem.to)) continue
    normalized.push({
      path: navItem.to,
      enabled: true,
      sort_order: normalized.length,
      fixed: navItem.to === '/settings',
    })
  }

  return normalized.map((item, index) => ({ ...item, sort_order: index }))
}

export function visibleSidebarNavItems(settings?: SidebarSettingsPayload | null): SidebarNavItem[] {
  return mergeSidebarSettings(settings?.items)
    .filter(item => item.enabled || item.path === '/settings')
    .map(item => SIDEBAR_NAV_ITEM_BY_PATH.get(item.path))
    .filter((item): item is SidebarNavItem => Boolean(item))
}
