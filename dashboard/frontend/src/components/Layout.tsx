import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Train, LogOut } from 'lucide-react'
import { useAuth } from '../auth'
import { canAccessPath } from '../access'
import { SIDEBAR_NAV_ITEMS, type SidebarSettingsPayload, visibleSidebarNavItems } from '../navigation'

export function Layout() {
  const loc = useLocation()
  const { user, logout } = useAuth()
  const { data: sidebarSettings } = useQuery<SidebarSettingsPayload>({
    queryKey: ['wip', 'settings', 'sidebar'],
    queryFn: async () => {
      const response = await fetch('/api/wip/settings/sidebar')
      if (!response.ok) throw new Error('sidebar settings fetch failed')
      return response.json()
    },
    staleTime: 60_000,
    retry: 1,
  })
  // Карта и широкие таблицы — full-bleed, без max-w. Остальные страницы ограничиваем на широких мониторах.
  const isMap = loc.pathname.startsWith('/map')
  const isStatements = loc.pathname.startsWith('/statements')
  const isEarthworks = loc.pathname.startsWith('/zem-polotno')
  const isStructuralSchemes = loc.pathname.startsWith('/structural-schemes')
  const isSectionRating = loc.pathname.startsWith('/section-rating')
  const isTvDashboard = false
  const configuredNavItems = useMemo(
    () => (sidebarSettings ? visibleSidebarNavItems(sidebarSettings) : SIDEBAR_NAV_ITEMS),
    [sidebarSettings],
  )
  const navItems = useMemo(
    () => configuredNavItems.filter(item => canAccessPath(user, item.to)),
    [configuredNavItems, user],
  )
  return (
    <div className="flex h-full min-h-0 bg-bg-primary">
      <aside className={`hidden lg:sticky lg:top-0 lg:flex h-full shrink-0 flex-col w-64 overflow-y-auto bg-bg-sidebar border-r border-neutral-800 p-4 ${
        isTvDashboard
          ? 'fixed left-0 top-0 bottom-0 z-50 -translate-x-[15.25rem] hover:translate-x-0 focus-within:translate-x-0 transition-transform duration-300 ease-out'
          : ''
      }`}>
        <div className="flex items-center gap-3 mb-8 px-2">
          <Train className="w-8 h-8 text-accent-red" />
          <div>
            <h1 className="text-lg font-bold font-heading text-text-on-dark leading-tight">
              ВСМ ЖДС
            </h1>
            <span className="text-xs text-neutral-400 block leading-tight">Аналитическое табло</span>
            <span className="text-[10px] text-neutral-500 block leading-tight">3 этап</span>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-accent-burg text-white'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`
              }
            >
              <Icon className="w-5 h-5" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-neutral-800 pt-3">
          <div className="px-3 py-2 text-xs text-neutral-400">
            <div className="font-mono text-neutral-200">{user?.username}</div>
            <div>{user?.role === 'admin' ? 'admin' : 'user'}</div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-400 hover:text-white hover:bg-neutral-800 transition-all"
          >
            <LogOut className="w-5 h-5" />
            Выйти
          </button>
        </div>
      </aside>

      <main className={`h-full min-h-0 flex-1 overflow-auto bg-bg-primary ${isTvDashboard ? 'lg:ml-0' : ''}`}>
        {isMap || isStatements || isEarthworks || isStructuralSchemes || isSectionRating || isTvDashboard ? (
          <Outlet />
        ) : (
          <div className="max-w-[1800px] mx-auto">
            <Outlet />
          </div>
        )}
      </main>

      <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-border flex gap-1 overflow-x-auto py-2 px-2 z-50">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex min-w-[72px] flex-col items-center gap-0.5 text-[10px] transition-colors shrink-0 px-2 ${
                isActive ? 'text-accent-red' : 'text-text-muted'
              }`
            }
          >
            <Icon className="w-5 h-5" />
            <span className="whitespace-nowrap">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
