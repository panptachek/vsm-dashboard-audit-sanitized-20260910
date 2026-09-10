export type Role = 'admin' | 'user'

export interface AccessUser {
  username: string
  role: Role
  access_group?: string | null
  access_group_label?: string | null
  pages?: string[]
  permissions?: string[]
}

export type AccessGroup = 'admin_full' | 'full_user_pages' | 'pile_control' | 'pile_report_input' | 'report_input_view' | 'default_user'

const FULL_USER_PAGE_USERNAMES = new Set([
  'fdeputy', 'ceo',
  'rp1', 'rp2', 'rp3', 'rp4', 'rp5', 'rp6', 'rp7', 'rp8',
])

const PILE_CONTROL_USERNAMES = new Set([
  'isso', 'rp_isso',
  'isso_uch1', 'isso_uch2', 'isso_uch3', 'isso_uch4',
  'isso_uch5', 'isso_uch6', 'isso_uch7', 'isso_uch8',
])

const PILE_REPORT_INPUT_USERNAMES = new Set([
  'uchastok1', 'uchastok2', 'uchastok3', 'uchastok4',
  'uchastok5', 'uchastok6', 'uchastok7', 'uchastok8',
])

const REPORT_INPUT_VIEW_USERNAMES = new Set(['user'])

const DISABLED_PATHS = new Set(['/metabase'])

const VIEW_AND_REPORT_PATHS = new Set([
  '/',
  '/map',
  '/analytics',
  '/section-rating',
  '/mechanization',
  '/personnel-accommodation',
  '/reinforcement',
  '/zem-polotno',
  '/structural-schemes',
  '/reports',
])

const FULL_PAGE_PATHS = new Set([
  '/',
  '/map',
  '/analytics',
  '/section-rating',
  '/mechanization',
  '/personnel-accommodation',
  '/reinforcement',
  '/zem-polotno',
  '/structural-schemes',
  '/reports',
  '/statements',
  '/generator',
  '/database',
  '/settings',
  '/pile',
  '/pilereports',
])

function normalizePath(path: string): string {
  if (!path) return '/'
  if (path === '/dashboard') return '/'
  if (path === '/pile-control') return '/pile'
  return path
}

function hasServerPages(user: AccessUser | null): user is AccessUser & { pages: string[] } {
  return Boolean(user && Array.isArray(user.pages))
}

function normalizedUserPageSet(user: AccessUser & { pages: string[] }): Set<string> {
  return new Set(user.pages.map(normalizePath).filter(path => !DISABLED_PATHS.has(path)))
}

export function accessGroupForUser(user: AccessUser | null): AccessGroup {
  if (!user) return 'default_user'
  if (user.access_group && ['admin_full', 'full_user_pages', 'pile_control', 'pile_report_input', 'report_input_view', 'default_user'].includes(user.access_group)) return user.access_group as AccessGroup
  if (user.role === 'admin') return 'admin_full'
  if (FULL_USER_PAGE_USERNAMES.has(user.username)) return 'full_user_pages'
  if (PILE_CONTROL_USERNAMES.has(user.username)) return 'pile_control'
  if (PILE_REPORT_INPUT_USERNAMES.has(user.username)) return 'pile_report_input'
  if (REPORT_INPUT_VIEW_USERNAMES.has(user.username)) return 'report_input_view'
  return 'default_user'
}

export function hasFullPageAccess(user: AccessUser | null): boolean {
  const group = accessGroupForUser(user)
  return group === 'admin_full' || group === 'full_user_pages'
}

export function hasSettingsManagerRights(user: AccessUser | null): boolean {
  return Boolean(user && (user.role === 'admin' || user.permissions?.includes('settings:write')))
}

export function hasReportReviewRights(user: AccessUser | null): boolean {
  return Boolean(user && (user.role === 'admin' || user.permissions?.includes('reports:review') || user.permissions?.includes('reports:edit')))
}

export function hasReportEditRights(user: AccessUser | null): boolean {
  return Boolean(user && (user.role === 'admin' || user.permissions?.includes('reports:edit')))
}

export function hasStatementsProjectWriteRights(user: AccessUser | null): boolean {
  return Boolean(user && (user.role === 'admin' || user.permissions?.includes('statements:project:write')))
}

export function canAccessPileControl(user: AccessUser | null): boolean {
  if (hasServerPages(user)) return normalizedUserPageSet(user).has('/pile')
  const group = accessGroupForUser(user)
  return group === 'admin_full' || group === 'full_user_pages' || group === 'pile_control'
}

export function canAccessPileReports(user: AccessUser | null): boolean {
  if (hasServerPages(user)) return normalizedUserPageSet(user).has('/pilereports')
  const group = accessGroupForUser(user)
  return group === 'admin_full' || group === 'full_user_pages' || group === 'pile_control' || group === 'pile_report_input'
}

export function canAccessPath(user: AccessUser | null, path: string): boolean {
  if (!user) return false
  const normalized = normalizePath(path)
  if (DISABLED_PATHS.has(normalized)) return false
  if (normalized === '/section-rating') return true
  if (hasServerPages(user)) return normalizedUserPageSet(user).has(normalized)
  if (normalized === '/pile') return canAccessPileControl(user)
  if (normalized === '/pilereports') return canAccessPileReports(user)
  if (hasFullPageAccess(user)) return FULL_PAGE_PATHS.has(normalized)
  const group = accessGroupForUser(user)
  if (group === 'pile_control') return normalized === '/pile' || normalized === '/pilereports'
  if (group === 'pile_report_input') return VIEW_AND_REPORT_PATHS.has(normalized) || normalized === '/pilereports'
  if (group === 'report_input_view') return VIEW_AND_REPORT_PATHS.has(normalized)
  return VIEW_AND_REPORT_PATHS.has(normalized)
}

export function defaultRouteForUser(user: AccessUser | null): string {
  if (!user) return '/'
  if (hasServerPages(user)) {
    const pages = normalizedUserPageSet(user)
    for (const path of ['/', '/reports', '/pile', '/pilereports']) {
      if (pages.has(path)) return path
    }
    return Array.from(pages)[0] || '/'
  }
  const group = accessGroupForUser(user)
  if (group === 'pile_control') return '/pile'
  if (group === 'pile_report_input') return '/pilereports'
  if (hasFullPageAccess(user)) return '/'
  return '/reports'
}

export function accessGroupLabel(group: AccessGroup): string {
  if (group === 'admin_full') return 'Администратор: полный доступ'
  if (group === 'full_user_pages') return 'Все страницы + расширенные права'
  if (group === 'pile_control') return 'Контроль свай + ввод свай'
  if (group === 'pile_report_input') return 'Ввод свай + просмотр'
  if (group === 'report_input_view') return 'Просмотр + ввод отчетов'
  return 'Просмотр + ввод отчетов'
}
