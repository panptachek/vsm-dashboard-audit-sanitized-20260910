import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react'
import { useLocation } from 'react-router-dom'

interface AnnouncementItem {
  id?: string
  enabled: boolean
  title?: string
  message?: string
  tone?: 'info' | 'warning' | 'critical' | 'success'
  target_paths?: string[]
}

interface AnnouncementPayload {
  items?: AnnouncementItem[]
  enabled?: boolean
  title?: string
  message?: string
  tone?: AnnouncementItem['tone']
  updated_at?: string | null
}

const toneClass: Record<string, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-950',
  warning: 'border-amber-200 bg-amber-50 text-amber-950',
  critical: 'border-red-200 bg-red-50 text-red-950',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-950',
}

export function GlobalAnnouncement() {
  const location = useLocation()
  const { data } = useQuery<AnnouncementPayload>({
    queryKey: ['wip', 'announcement', 'active', location.pathname],
    queryFn: async () => {
      const params = new URLSearchParams({ path: location.pathname })
      const response = await fetch(`/api/wip/announcements/active?${params.toString()}`)
      if (!response.ok) throw new Error('announcement fetch failed')
      return response.json()
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  })
  const items = data?.items?.length
    ? data.items
    : data?.enabled && (data.title || data.message)
      ? [{ enabled: true, title: data.title, message: data.message, tone: data.tone }]
      : []
  if (!items.length) return null
  return (
    <div data-testid="global-announcements" className="relative z-40 max-h-[40dvh] shrink-0 overflow-y-auto shadow-sm">
      {items.map((item, index) => {
        const tone = item.tone || 'info'
        const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle
        return (
          <div key={item.id || `${tone}-${index}`} className={`border-b px-4 py-2 text-sm ${toneClass[tone] || toneClass.info}`}>
            <div className="mx-auto flex max-w-[1800px] items-start gap-2">
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                {item.title ? <div className="font-semibold leading-snug">{item.title}</div> : null}
                {item.message ? <div className="whitespace-pre-wrap leading-snug opacity-90">{item.message}</div> : null}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
