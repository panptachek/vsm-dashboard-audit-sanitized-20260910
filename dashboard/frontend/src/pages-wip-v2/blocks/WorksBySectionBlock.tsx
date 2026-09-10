/**
 * Блок «Работы на участке за период».
 * Плоская таблица: вид работ · конструктив · уч. · пикетаж · объём · дни.
 * Фильтр по участку — chip-группа сверху. Данные из /api/wip/works-by-section.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ClipboardList } from 'lucide-react'

interface WorkRow {
  wt_code: string
  wt_name: string
  unit: string
  section_code: string
  object_id: string | null
  object_name: string
  constructive_name: string
  volume: number
  days: number
  pk_min: number | null
  pk_max: number | null
}

const SECTION_CODES = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const fmt = (n: number) => n > 0 ? nf.format(n) : ''

function formatPK(v: number): string {
  const pk = Math.floor(v / 100)
  const plus = v - pk * 100
  return `ПК${pk}+${plus.toFixed(0).padStart(2, '0')}`
}

function pkRange(min: number | null, max: number | null): string {
  if (min == null || max == null) return '—'
  if (min === max) return formatPK(min)
  return `${formatPK(min)}–${formatPK(max)}`
}

export function WorksBySectionBlock({ from, to }: { from: string; to: string }) {
  const [sec, setSec] = useState<'all' | string>('all')
  const { data, isLoading } = useQuery<{ rows: WorkRow[] }>({
    queryKey: ['wip', 'works-by-section', from, to, sec],
    queryFn: () => {
      const params = new URLSearchParams({ from, to })
      if (sec !== 'all') params.set('section', sec)
      return fetch(`/api/wip/works-by-section?${params}`).then(r => r.json())
    },
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  const rows = useMemo(() => data?.rows ?? [], [data?.rows])

  if (isLoading) {
    return <div className="bg-white border border-border rounded-xl p-5 h-40 animate-pulse" />
  }

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <ClipboardList className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Работы на участке
        </h2>
        <span className="text-xs text-text-muted">
          {rows.length} запис(ей) · за период · {sec === 'all' ? 'все участки' : sec.replace('UCH_', '№')}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Chip active={sec === 'all'} onClick={() => setSec('all')}>все</Chip>
          {SECTION_CODES.map(c => (
            <Chip key={c} active={sec === c} onClick={() => setSec(c)}>
              {c.replace('UCH_', '№')}
            </Chip>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-text-muted py-8 text-center">
          Нет работ за выбранный период.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-text-muted uppercase tracking-wider text-[10px] border-b border-border">
                <th className="text-left py-2 pr-3 font-semibold">Вид работ</th>
                <th className="text-left py-2 px-2 font-semibold">Объект</th>
                <th className="text-center py-2 px-2 font-semibold">Уч.</th>
                <th className="text-left py-2 px-2 font-semibold">Пикетаж</th>
                <th className="text-right py-2 px-2 font-semibold">Ед.</th>
                <th className="text-right py-2 px-2 font-semibold">Дн.</th>
                <th className="text-right py-2 px-2 font-semibold">Объём</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.wt_code}-${r.object_id ?? 'x'}-${r.section_code}-${i}`} className="border-b border-border/60 hover:bg-bg-surface/40">
                  <td className="py-2 pr-3 text-text-primary">{r.wt_name}</td>
                  <td className="py-2 px-2 text-text-secondary">{r.object_name}</td>
                  <td className="py-2 px-2 text-center font-mono text-text-secondary">
                    {r.section_code.replace('UCH_', '№')}
                  </td>
                  <td className="py-2 px-2 font-mono text-text-secondary text-[11px]">
                    {pkRange(r.pk_min, r.pk_max)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-text-muted">{r.unit}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">{r.days}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-primary font-semibold">{fmt(r.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${
        active
          ? 'bg-slate-800 text-white'
          : 'bg-white text-gray-600 border border-gray-200 hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
