import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { Activity, Truck, Wrench, X } from 'lucide-react'

interface CategoryPulse {
  key: 'dump_truck' | 'excavator' | 'bulldozer' | 'other'
  label: string
  short: string
  working: number
  idle: number
  repair: number
}

type EquipmentStatus = 'working' | 'idle' | 'repair'

interface UnitPulse {
  category: CategoryPulse['key']
  slot: EquipmentStatus
  equipment_type: string
  brand_model: string
  plate_number: string
  unit_number: string
  ownership_type: string
  contractor_name: string
  status: string
  comment: string
  location: string
  source_name: string
  source_date: string | null
}

interface SectionPulse {
  section_code: string
  label: string
  working_total: number
  idle_total: number
  repair_total: number
  categories: Record<CategoryPulse['key'], Pick<CategoryPulse, 'working' | 'idle' | 'repair'>>
  units: UnitPulse[]
}

interface Response {
  from: string
  to: string
  requested_from?: string
  requested_to?: string
  effective_date?: string
  date_note?: string | null
  categories: CategoryPulse[]
  sections: SectionPulse[]
  totals: { working: number; idle: number; repair: number }
}

const nf = new Intl.NumberFormat('ru-RU')

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU')
}

function fmtPeriod(from: string, to: string): string {
  return from === to ? fmtDate(to) : `${fmtDate(from)} — ${fmtDate(to)}`
}

const STATUS_TEXT: Record<EquipmentStatus, { title: string; subtitle: string; tone: 'work' | 'idle' | 'repair' }> = {
  working: {
    title: 'Техника в работе',
    subtitle: 'единиц на дату среза',
    tone: 'work',
  },
  idle: {
    title: 'Техника в простое',
    subtitle: 'ожидание, отсутствие задания или нет признака ремонта',
    tone: 'idle',
  },
  repair: {
    title: 'Техника в ремонте',
    subtitle: 'ремонт, неисправность или сервисное обслуживание',
    tone: 'repair',
  },
}

const CATEGORY_LABEL: Record<CategoryPulse['key'], string> = {
  dump_truck: 'Самосвалы',
  excavator: 'Экскаваторы',
  bulldozer: 'Бульдозеры',
  other: 'Прочая техника',
}

function statusLabel(value: string | null | undefined): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'working') return 'В работе'
  if (normalized === 'repair') return 'Ремонт'
  if (normalized === 'out') return 'Не на линии'
  if (normalized === 'standby') return 'Ожидание'
  if (normalized === 'unknown') return 'Статус не указан'
  return value || 'Статус не указан'
}

function ownershipLabel(unit: Pick<UnitPulse, 'ownership_type' | 'contractor_name'>): string {
  const ownership = (unit.ownership_type || '').toLowerCase()
  const contractor = (unit.contractor_name || '').trim()
  const normalized = contractor.toLowerCase().replace('ё', 'е')
  if (ownership === 'own' || normalized === 'ждс' || normalized.includes('ооо ждс')) return 'ЖДС'
  if (normalized.includes('алмаз')) return 'АЛМАЗ'
  if (contractor) return contractor
  if (ownership === 'hired') return 'Наемная'
  return 'Не указано'
}

function equipmentTypeLabel(unit: UnitPulse): string {
  const raw = (unit.equipment_type || '').trim()
  const normalized = raw.toLowerCase()
  if (unit.category === 'other' && raw && normalized !== 'other' && normalized !== 'unknown') {
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }
  return CATEGORY_LABEL[unit.category] ?? (raw || 'Техника')
}

export function EquipmentPulseBlock({ from, to }: { from: string; to: string }) {
  const [details, setDetails] = useState<{ section: SectionPulse; status: EquipmentStatus } | null>(null)
  const { data, isLoading } = useQuery<Response>({
    queryKey: ['wip', 'overview', 'equipment-pulse', from, to],
    queryFn: () => fetch(`/api/wip/overview/equipment-pulse?from=${from}&to=${to}`).then(r => r.json()),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  if (isLoading || !data) {
    return <div className="h-72 bg-white border border-border rounded-xl animate-pulse" />
  }

  const detailUnits = details
    ? (details.section.units ?? []).filter(unit => unit.slot === details.status)
    : []

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 mb-5">
        <div className="flex items-center gap-2 mr-auto">
          <Activity className="w-5 h-5 text-accent-red" />
          <div>
            <h2 className="text-base font-semibold text-gray-800 font-heading tracking-wide uppercase">
              Пульс техники
            </h2>
            <div className="text-[11px] text-text-muted font-mono">{fmtPeriod(data.from, data.to)}</div>
            {data.date_note && (
              <div className="mt-1 inline-flex max-w-full rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800">
                {data.date_note}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Badge label="В работе" value={data.totals.working} tone="work" />
          <Badge label="В простое" value={data.totals.idle} tone="idle" />
          <Badge label="В ремонте" value={data.totals.repair} tone="repair" />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {(['working', 'idle', 'repair'] as EquipmentStatus[]).map(status => (
          <PulseCard
            key={status}
            status={status}
            value={data.totals[status]}
            sections={data.sections}
            onOpen={(section) => setDetails({ section, status })}
          />
        ))}
      </div>

      {details && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-950/45 p-4"
          onClick={() => setDetails(null)}
        >
          <div
            className="w-full max-w-5xl rounded-xl border border-border bg-white shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{STATUS_TEXT[details.status].title}</div>
                <h3 className="mt-0.5 font-heading text-lg font-bold text-text-primary">{details.section.label}</h3>
                <div className="text-xs text-text-muted">{detailUnits.length} ед. техники</div>
              </div>
              <button
                type="button"
                onClick={() => setDetails(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-text-primary"
                aria-label="Закрыть"
                title="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-auto p-4">
              {detailUnits.length === 0 ? (
                <div className="rounded-md border border-border bg-bg-surface px-4 py-8 text-center text-sm text-text-muted">Нет строк техники по выбранному статусу.</div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Тип</th>
                      <th className="px-2 py-2 text-left font-semibold">Марка</th>
                      <th className="px-2 py-2 text-left font-semibold">Госномер</th>
                      <th className="px-2 py-2 text-left font-semibold">Бортовой</th>
                      <th className="px-2 py-2 text-left font-semibold">Принадлежность</th>
                      <th className="px-2 py-2 text-left font-semibold">Статус</th>
                      <th className="px-3 py-2 text-left font-semibold">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailUnits.map((unit, index) => (
                      <tr key={`${unit.plate_number}|${unit.unit_number}|${index}`} className="border-t border-border/60">
                        <td className="px-3 py-2 font-semibold text-text-primary">{equipmentTypeLabel(unit)}</td>
                        <td className="px-2 py-2 text-text-secondary">{unit.brand_model || '—'}</td>
                        <td className="px-2 py-2 font-mono text-text-secondary">{unit.plate_number || '—'}</td>
                        <td className="px-2 py-2 font-mono text-text-secondary">{unit.unit_number || '—'}</td>
                        <td className="px-2 py-2 text-text-secondary">{ownershipLabel(unit)}</td>
                        <td className="px-2 py-2 font-semibold text-text-primary">{statusLabel(unit.status)}</td>
                        <td className="px-3 py-2 text-text-muted">{unit.comment || unit.location || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function PulseCard({
  status,
  value,
  sections,
  onOpen,
}: {
  status: EquipmentStatus
  value: number
  sections: SectionPulse[]
  onOpen: (section: SectionPulse) => void
}) {
  const meta = STATUS_TEXT[status]
  const Icon = status === 'working' ? Truck : status === 'repair' ? Wrench : Activity
  const activeSections = sections.filter(section => section[`${status}_total`] > 0)
  return (
    <div className="relative border border-border rounded-lg p-4 bg-white min-h-[360px]">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-bg-surface border border-border flex items-center justify-center">
          <Icon className={`w-5 h-5 ${status === 'working' ? 'text-slate-900' : 'text-accent-red'}`} />
        </div>
        <div className="flex-1">
          <div className="text-[12px] uppercase tracking-wider text-text-muted font-semibold">{meta.title}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <AnimatedNumber
              value={value}
              className="text-4xl font-heading font-bold leading-none text-text-primary"
            />
          </div>
          <div className="mt-1 text-[11px] text-text-muted">{meta.subtitle}</div>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-3">
        <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-2">По участкам</div>
        {activeSections.length === 0 ? (
          <div className="text-[12px] text-text-muted">Нет данных по выбранному статусу.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-2">
            {activeSections.map((section, index) => (
              <SectionStatusTile key={section.section_code} section={section} status={status} index={index} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionStatusTile({ section, status, index, onOpen }: {
  section: SectionPulse
  status: EquipmentStatus
  index: number
  onOpen: (section: SectionPulse) => void
}) {
  const total = section[`${status}_total`]
  const maxCat = Math.max(1, ...Object.values(section.categories).map(category => category[status]))
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      onClick={() => onOpen(section)}
      className="min-h-[104px] rounded-lg border border-border bg-bg-surface/50 p-2 text-left hover:border-slate-300 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-text-primary">{section.label}</div>
        <div className="text-[12px] font-mono font-bold text-text-primary">{total}</div>
      </div>
      <div className="mt-2 space-y-1.5">
        {Object.entries(section.categories).map(([key, category]) => {
          const count = category[status]
          const width = Math.round((count / maxCat) * 100)
          const meta = key === 'dump_truck'
            ? { short: 'СВ', label: 'Самосвалы' }
            : key === 'excavator'
              ? { short: 'ЭК', label: 'Экскаваторы' }
              : key === 'bulldozer'
                ? { short: 'БД', label: 'Бульдозеры' }
                : { short: 'ПР', label: 'Прочая' }
          return (
            <div key={key} className="grid grid-cols-[24px_minmax(0,1fr)_22px] items-center gap-1.5 text-[10px] font-mono">
              <div className="text-text-muted" title={meta.label}>{meta.short}</div>
              <div className="h-1.5 rounded-full bg-white overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ duration: 0.65, ease: 'easeOut' }}
                  className={`h-full ${status === 'repair' ? 'bg-accent-red' : status === 'idle' ? 'bg-progress-amber' : 'bg-slate-900'}`}
                />
              </div>
              <div className="text-right text-text-primary">{count}</div>
            </div>
          )
        })}
      </div>
    </motion.button>
  )
}

function Badge({ label, value, suffix = '', tone }: {
  label: string; value: number | null; suffix?: string; tone: 'work' | 'idle' | 'repair'
}) {
  const color = tone === 'work'
    ? 'bg-slate-900 text-white'
    : tone === 'repair'
      ? 'bg-red-50 text-red-800 border-red-200'
      : 'bg-amber-50 text-amber-900 border-amber-200'
  return (
    <div className={`border rounded-md px-2 py-1 ${color}`}>
      <span className="opacity-75">{label}: </span>
      <b className="font-mono">{value === null ? '—' : `${nf.format(Math.round(value))}${suffix}`}</b>
    </div>
  )
}

function AnimatedNumber({
  value,
  suffix = '',
  decimals = 0,
  className,
}: {
  value: number
  suffix?: string
  decimals?: number
  className?: string
}) {
  const mv = useMotionValue(0)
  const text = useTransform(mv, latest => {
    const rounded = decimals > 0
      ? latest.toLocaleString('ru-RU', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })
      : nf.format(Math.round(latest))
    return `${rounded}${suffix}`
  })

  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease: 'easeOut' })
    return () => controls.stop()
  }, [mv, value])

  return <motion.span className={className}>{text}</motion.span>
}
