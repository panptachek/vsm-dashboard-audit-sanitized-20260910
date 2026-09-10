import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Boxes, Printer, Users, X } from 'lucide-react'
import { PeriodBar } from './PeriodBar'
import { usePeriod } from './usePeriod'
import { DailySummaryBlock } from './blocks/DailySummaryBlock'
import { QuarryMaterialFlowBlock, TransferMaterialFlowBlock } from './blocks/MaterialFlowBlock'
import { PilesBlock } from './blocks/PilesBlock'
import { EquipmentPulseBlock } from './blocks/EquipmentPulseBlock'
import { EquipmentBlock } from './blocks/EquipmentBlock'
import { WorksBySectionBlock } from './blocks/WorksBySectionBlock'

const DASHBOARD_QUERY_STALE_MS = 5 * 60_000
const DASHBOARD_QUERY_GC_MS = 15 * 60_000

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number, digits = 0) => nf.format(Number(n.toFixed(digits)))

function formatDate(value?: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('ru-RU')
}

function filenameFromResponse(res: Response, fallback: string): string {
  const header = res.headers.get('Content-Disposition') || ''
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf?.[1]) return decodeURIComponent(utf[1])
  const ascii = header.match(/filename="?([^";]+)"?/i)
  if (ascii?.[1]) return ascii[1]
  return fallback
}

async function downloadResponse(res: Response, fallbackFilename: string) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || res.statusText)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filenameFromResponse(res, fallbackFilename)
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function DashboardPage() {
  const { from, to } = usePeriod()
  const [exporting, setExporting] = useState(false)

  async function exportPdf() {
    setExporting(true)
    try {
      await downloadResponse(
        await fetch(`/api/wip/dashboard/pdf?from=${from}&to=${to}`),
        `Дашборд ${from}-${to}.pdf`,
      )
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-bg-primary">
      <PeriodBar />
      <div className="border-b border-border bg-white px-4 py-3 sm:px-6 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-bold text-text-primary">Дашборд</h1>
          <div className="text-xs text-text-muted">Сводка по ключевым показателям за выбранный период</div>
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={exportPdf}
          className="no-print inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-burg disabled:cursor-wait disabled:opacity-60"
          title="Скачать PDF отчет"
        >
          <Printer className="h-3.5 w-3.5" />
          {exporting ? 'PDF...' : 'PDF'}
        </button>
      </div>

      <div id="dashboard-pdf-content" className="space-y-6 p-4 pb-24 sm:p-6 lg:pb-6">
        <DailySummaryBlock from={from} to={to} variant="dashboard" />
        <QuarryMaterialFlowBlock from={from} to={to} view="cards" endpoint={`/api/wip/dashboard/material-flow?from=${from}&to=${to}`} />
        <TransferMaterialFlowBlock from={from} to={to} view="cards" />
        <PilesBlock from={from} to={to} view="cards" planLabel="План" />
        <StaffResourcesBlock from={from} to={to} />
        <EquipmentPulseBlock from={from} to={to} />
        <EquipmentBlock from={from} to={to} view="cards" />
        <DashboardStockpileBalancesBlock to={to} />
        <WorksBySectionBlock from={from} to={to} />
      </div>
    </div>
  )
}

type StaffCategoryKey = 'hired' | 'at_work' | 'intershift' | 'vacation' | 'sick' | 'day_off' | 'absence'

interface PeopleCounts {
  hired: number
  at_work: number
  intershift: number
  vacation: number
  sick: number
  day_off: number
  absence: number
  vacation_sick?: number
}

interface StaffCategoryMeta {
  key: StaffCategoryKey
  label: string
  source?: string
}

interface StaffRow {
  category: string
  count: number
  report_count: number
}

interface StaffSection {
  section_code: string
  section_num: number | null
  label?: string | null
  total: number
  rows: StaffRow[]
}

interface StaffCard {
  card_code: string
  card_type: 'section' | 'office' | string
  section_num: number | null
  label: string
  total: number
  position_count?: number
  counts: PeopleCounts
}

interface StaffResourcesData {
  source?: string
  fallback_used: boolean
  note: string | null
  total: number
  rows: StaffRow[]
  sections: StaffSection[]
  cards?: StaffCard[]
  summary?: PeopleCounts
  categories?: StaffCategoryMeta[]
  report_date?: string | null
  source_filename?: string | null
}

interface StaffDetailRow {
  position: string
  sphere?: string
  counts: PeopleCounts
}

interface StaffDetailGroup {
  sphere: string
  counts: PeopleCounts
  positions: StaffDetailRow[]
}

interface StaffDetailData {
  card_code: string
  label: string
  report_date?: string | null
  source_filename?: string | null
  totals: PeopleCounts
  categories: StaffCategoryMeta[]
  groups?: StaffDetailGroup[]
  positions: StaffDetailRow[]
}

const peopleStatusOrder: StaffCategoryKey[] = ['hired', 'at_work', 'intershift', 'vacation', 'sick', 'day_off', 'absence']
const peopleStatusLabels: Record<StaffCategoryKey, string> = {
  hired: 'Устроено',
  at_work: 'На работе',
  intershift: 'Межвахта',
  vacation: 'Отпуск',
  sick: 'Больничный',
  day_off: 'Выходной',
  absence: 'Неявка',
}
const defaultPeopleCategories: StaffCategoryMeta[] = peopleStatusOrder.map(key => ({ key, label: peopleStatusLabels[key] }))

function peopleValue(counts: Partial<PeopleCounts> | undefined, key: StaffCategoryKey): number {
  return Number(counts?.[key] ?? 0)
}

function peopleVacationSick(counts: Partial<PeopleCounts> | undefined): number {
  return Number(counts?.vacation_sick ?? (peopleValue(counts, 'vacation') + peopleValue(counts, 'sick')))
}

function staffLabel(category: string): string {
  const normalized = category.trim().toLowerCase()
  const labels: Record<string, string> = {
    workers: 'Рабочие',
    worker: 'Рабочие',
    staff: 'Персонал',
    itr: 'ИТР',
    engineers: 'ИТР',
    operators: 'Машинисты',
    drivers: 'Водители',
    pto: 'ПТО',
    'пто': 'ПТО',
    geodesy: 'Геодезия',
    geodetic: 'Геодезия',
    'геодезия': 'Геодезия',
    office: 'Офис',
  }
  return labels[normalized] || category
}

function StaffResourcesBlock({ from, to }: { from: string; to: string }) {
  const [selectedCard, setSelectedCard] = useState<StaffCard | null>(null)
  const { data, isLoading } = useQuery<StaffResourcesData>({
    queryKey: ['wip', 'dashboard', 'staff', from, to],
    queryFn: () => fetch(`/api/wip/dashboard/staff-resources?from=${from}&to=${to}`).then(r => r.json()),
    staleTime: DASHBOARD_QUERY_STALE_MS,
    gcTime: DASHBOARD_QUERY_GC_MS,
    refetchOnWindowFocus: false,
  })
  const detailQuery = useQuery<StaffDetailData>({
    queryKey: ['wip', 'dashboard', 'staff', 'details', selectedCard?.card_code, to],
    enabled: Boolean(selectedCard?.card_code),
    queryFn: async () => {
      const res = await fetch(`/api/wip/dashboard/staff-resources/${selectedCard!.card_code}/details?to=${to}`)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.detail || res.statusText)
      }
      return res.json()
    },
    staleTime: DASHBOARD_QUERY_STALE_MS,
    gcTime: DASHBOARD_QUERY_GC_MS,
    refetchOnWindowFocus: false,
  })

  if (isLoading || !data) return <div className="h-36 animate-pulse rounded-xl border border-border bg-white" />

  const hasPeopleCards = data.source === 'dashboard_people' && Array.isArray(data.cards)
  if (!hasPeopleCards) {
    return (
      <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Users className="h-5 w-5 text-text-primary" />
          <h2 className="font-heading text-base font-semibold uppercase tracking-wide text-gray-800">Численность</h2>
          <span className="ml-auto font-mono text-xs text-text-muted">Всего: {fmt(data.total, data.fallback_used ? 1 : 0)} чел.</span>
        </div>
        {data.note && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">{data.note}</div>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(data.sections ?? []).map(section => (
            <div key={section.section_code} className="rounded-lg border border-border bg-bg-surface/40 p-3">
              <div className="mb-2 flex items-baseline gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  {section.label || (section.section_num ? `Участок №${section.section_num}` : 'Без участка')}
                </div>
                <div className="ml-auto font-heading text-xl font-bold text-text-primary">
                  {fmt(section.total, data.fallback_used ? 1 : 0)}
                </div>
              </div>
              <div className="space-y-1">
                {section.rows.map(row => (
                  <div key={`${section.section_code}:${row.category}`} className="flex items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-text-secondary">{staffLabel(row.category)}</span>
                    <span className="font-mono font-semibold text-text-primary">{fmt(row.count, data.fallback_used ? 1 : 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {(data.sections ?? []).length === 0 && <div className="text-sm text-text-muted">Нет данных по людям</div>}
        </div>
      </section>
    )
  }

  const categories = data.categories?.length ? data.categories : defaultPeopleCategories
  const summary = data.summary ?? {
    hired: data.total,
    at_work: 0,
    intershift: 0,
    vacation: 0,
    sick: 0,
    day_off: 0,
    absence: 0,
  }
  const summaryItems = [
    { label: 'Устроено', value: peopleValue(summary, 'hired') },
    { label: 'На работе', value: peopleValue(summary, 'at_work') },
    { label: 'Межвахта', value: peopleValue(summary, 'intershift') },
    { label: 'Отпуск/больничный', value: peopleVacationSick(summary) },
  ]
  const detail = detailQuery.data
  const detailCategories = detail?.categories?.length ? detail.categories : categories
  const detailGroups = detail
    ? (detail.groups?.length ? detail.groups : [{ sphere: 'Должности', counts: detail.totals, positions: detail.positions }])
    : []
  const hasDetailRows = detailGroups.some(group => group.positions.length > 0)

  return (
    <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Users className="h-5 w-5 text-text-primary" />
        <h2 className="font-heading text-base font-semibold uppercase tracking-wide text-gray-800">Численность</h2>
        <span className="ml-auto font-mono text-xs text-text-muted">срез: {formatDate(data.report_date)}</span>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {summaryItems.map(item => (
          <div key={item.label} className="rounded-lg border border-border bg-bg-surface px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{item.label}</div>
            <div className="font-heading text-2xl font-bold text-text-primary">{fmt(item.value)}</div>
          </div>
        ))}
      </div>
      {data.note && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">{data.note}</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {(data.cards ?? []).map(card => (
          <button
            key={card.card_code}
            type="button"
            onClick={() => setSelectedCard(card)}
            className="rounded-lg border border-border bg-bg-surface/40 p-3 text-left transition hover:border-accent-red/50 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-red/25"
          >
            <div className="mb-3 flex items-start gap-2">
              <div className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{card.label}</div>
              <div className="font-heading text-2xl font-bold leading-none text-text-primary">{fmt(peopleValue(card.counts, 'hired'))}</div>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {categories.map(category => (
                <div key={`${card.card_code}:${category.key}`} className="flex min-w-0 items-center gap-1 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-text-secondary">{category.label}</span>
                  <span className="font-mono font-semibold text-text-primary">{fmt(peopleValue(card.counts, category.key))}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
        {(data.cards ?? []).length === 0 && <div className="text-sm text-text-muted">Нет данных по людям</div>}
      </div>

      {selectedCard && (
        <div className="fixed inset-y-0 left-0 right-0 z-50 flex items-center justify-center bg-black/40 p-3 print:hidden lg:left-64" role="dialog" aria-modal="true">
          <div className="absolute inset-0" onClick={() => setSelectedCard(null)} />
          <div className="relative max-h-[calc(100vh-24px)] w-full max-w-none overflow-hidden rounded-xl border border-border bg-white shadow-xl">
            <div className="flex items-start gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-heading text-base font-semibold text-text-primary">{selectedCard.label}</div>
                <div className="text-xs text-text-muted">срез: {formatDate(detail?.report_date ?? data.report_date)}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCard(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition hover:bg-bg-surface hover:text-text-primary"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[calc(100vh-112px)] overflow-auto p-4">
              {detailQuery.isLoading && <div className="h-28 animate-pulse rounded-lg border border-border bg-bg-surface" />}
              {detailQuery.isError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Не удалось загрузить детализацию</div>}
              {detail && !detailQuery.isLoading && (
                <div className="min-w-[760px] overflow-hidden rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-bg-surface text-[11px] uppercase tracking-wide text-text-muted">
                      <tr>
                        <th className="border-b border-border px-3 py-2 text-left font-semibold">Должность</th>
                        {detailCategories.map(category => (
                          <th key={category.key} className="border-b border-border px-3 py-2 text-right font-semibold">{category.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detailGroups.map(group => (
                        <Fragment key={group.sphere}>
                          <tr className="border-b border-border bg-gray-100">
                            <td className="border-l-4 border-accent-red bg-gray-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-accent-red" colSpan={detailCategories.length + 1}>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                <span className="text-sm font-bold text-accent-red">{group.sphere}</span>
                                <span className="font-mono normal-case tracking-normal text-gray-800">
                                  Устроено: {fmt(peopleValue(group.counts, 'hired'))}, на работе: {fmt(peopleValue(group.counts, 'at_work'))}
                                </span>
                              </div>
                            </td>
                          </tr>
                          {group.positions.map(row => (
                            <tr key={`${group.sphere}:${row.position}`} className="border-b border-border/70 last:border-b-0">
                              <td className="px-3 py-2 text-text-primary">{row.position}</td>
                              {detailCategories.map(category => (
                                <td key={`${group.sphere}:${row.position}:${category.key}`} className="px-3 py-2 text-right font-mono text-text-primary">
                                  {fmt(peopleValue(row.counts, category.key))}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                      {!hasDetailRows && (
                        <tr>
                          <td className="px-3 py-6 text-center text-text-muted" colSpan={detailCategories.length + 1}>Нет детализации по должностям</td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="bg-bg-surface font-semibold">
                      <tr>
                        <td className="border-t border-border px-3 py-2 text-text-primary">Итого</td>
                        {detailCategories.map(category => (
                          <td key={`total:${category.key}`} className="border-t border-border px-3 py-2 text-right font-mono text-text-primary">
                            {fmt(peopleValue(detail.totals, category.key))}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

interface StockpileRow {
  stockpile_id: string
  stockpile_name: string
  section_num: number | null
  pk_label?: string | null
  material_name: string
  balance: number
  unit?: string
  snapshot_date?: string | null
  report_id?: string | null
}

function DashboardStockpileBalancesBlock({ to }: { to: string }) {
  const [selectedSection, setSelectedSection] = useState<number | null>(null)
  const { data, isLoading } = useQuery<{
    effective_date: string | null
    max_date: string | null
    note: string | null
    rows: StockpileRow[]
  }>({
    queryKey: ['wip', 'dashboard', 'stockpile-balances', to],
    queryFn: () => fetch(`/api/wip/analytics/stockpile-balances?as_of=${to}`).then(r => r.json()),
    staleTime: DASHBOARD_QUERY_STALE_MS,
    gcTime: DASHBOARD_QUERY_GC_MS,
    refetchOnWindowFocus: false,
  })

  if (isLoading || !data) return <div className="h-40 animate-pulse rounded-xl border border-border bg-white" />

  const bySec: Record<number, StockpileRow[]> = {}
  const totalsByMaterial = new Map<string, { material: string; value: number; unit: string }>()
  for (const row of data.rows) {
    const n = row.section_num ?? 0
    bySec[n] ??= []
    bySec[n].push(row)
    const key = `${row.material_name || 'Материал'}:${row.unit || 'м3'}`
    const slot = totalsByMaterial.get(key) ?? { material: row.material_name || 'Материал', value: 0, unit: row.unit || 'м3' }
    slot.value += Number(row.balance || 0)
    totalsByMaterial.set(key, slot)
  }
  const materialTotals = Array.from(totalsByMaterial.values()).sort((a, b) => b.value - a.value)
  const selectedRows = selectedSection == null ? [] : bySec[selectedSection] ?? []
  const selectedTotals = new Map<string, { material: string; value: number; unit: string }>()
  for (const row of selectedRows) {
    const key = `${row.material_name || 'Материал'}:${row.unit || 'м3'}`
    const slot = selectedTotals.get(key) ?? { material: row.material_name || 'Материал', value: 0, unit: row.unit || 'м3' }
    slot.value += Number(row.balance || 0)
    selectedTotals.set(key, slot)
  }

  return (
    <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Boxes className="h-5 w-5 text-text-primary" />
        <h2 className="font-heading text-base font-semibold uppercase tracking-wide text-gray-800">Состояние накопителей по участкам</h2>
        <span className="ml-auto font-mono text-xs text-text-muted">последний срез: {formatDate(data.effective_date)}</span>
      </div>
      {data.note && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{data.note}</div>}
      {materialTotals.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {materialTotals.map(total => (
            <div key={`${total.material}:${total.unit}`} className="rounded-md border border-border bg-bg-surface px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-muted">{total.material}</div>
              <div className="font-mono text-sm font-semibold text-text-primary">{fmt(total.value, 1)} {total.unit}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map(n => {
          const rows = bySec[n] ?? []
          return (
            <div
              key={n}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedSection(n)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelectedSection(n)
                }
              }}
              className="cursor-pointer rounded-lg border border-border bg-bg-surface/30 p-3 text-left transition hover:border-accent-red/40 hover:bg-white focus:outline-none focus:ring-2 focus:ring-red-100"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-semibold text-text-muted">Участок №{n}</span>
                <span className="ml-auto text-[10px] font-medium text-accent-red">детали</span>
              </div>
              {rows.length === 0 ? (
                <div className="text-xs text-text-muted">нет накопителей</div>
              ) : (
                <table className="w-full text-[11px]">
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.stockpile_id} className="border-t border-border/60 first:border-t-0">
                        <td className="py-1.5 pr-2">
                          <div className="font-medium text-text-primary">{row.material_name}</div>
                          <div className="font-mono text-[10px] text-text-muted">{row.pk_label || 'ПК н/д'}</div>
                          <div className="mt-0.5 text-[10px] text-text-muted">отчет {formatDate(row.snapshot_date)}</div>
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold text-text-primary">
                          {fmt(row.balance, 1)} {row.unit || 'м3'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
      {selectedSection != null && (
        <div className="fixed inset-y-0 left-0 right-0 z-50 flex items-center justify-center bg-black/40 p-3 lg:left-64" onMouseDown={event => {
          if (event.target === event.currentTarget) setSelectedSection(null)
        }}>
          <div className="flex max-h-[calc(100vh-24px)] w-full max-w-none flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Состояние накопителей</div>
                <h3 className="mt-0.5 font-heading text-lg font-semibold text-text-primary">Участок №{selectedSection}</h3>
                <div className="mt-1 text-xs text-text-muted">Показаны последние заведенные срезы по каждому накопителю на дату отчета не позже {formatDate(to)}.</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSection(null)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red"
                aria-label="Закрыть детали накопителей"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto px-4 py-4">
              {selectedRows.length === 0 ? (
                <div className="rounded-md border border-border bg-bg-surface px-3 py-8 text-center text-sm text-text-muted">По участку нет заведенных срезов накопителей.</div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {Array.from(selectedTotals.values()).map(total => (
                      <div key={`${total.material}:${total.unit}`} className="rounded-md border border-border bg-bg-surface px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wide text-text-muted">{total.material}</div>
                        <div className="font-mono text-sm font-semibold text-text-primary">{fmt(total.value, 1)} {total.unit}</div>
                      </div>
                    ))}
                  </div>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full min-w-[720px] text-[12px]">
                      <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold">Накопитель</th>
                          <th className="px-3 py-2 text-left font-semibold">Материал</th>
                          <th className="px-3 py-2 text-left font-semibold">ПК</th>
                          <th className="px-3 py-2 text-right font-semibold">Объем</th>
                          <th className="px-3 py-2 text-left font-semibold">Дата отчета</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRows.map(row => (
                          <tr key={row.stockpile_id} className="border-t border-border/60">
                            <td className="px-3 py-2 font-medium text-text-primary">{row.stockpile_name || 'Накопитель'}</td>
                            <td className="px-3 py-2 text-text-secondary">{row.material_name || 'Материал'}</td>
                            <td className="px-3 py-2 font-mono text-text-muted">{row.pk_label || 'ПК н/д'}</td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{fmt(row.balance, 1)} {row.unit || 'м3'}</td>
                            <td className="px-3 py-2 font-mono text-text-secondary">
                              {row.report_id ? (
                                <a
                                  href={`/reports?report_id=${encodeURIComponent(row.report_id)}`}
                                  className="font-semibold text-accent-red underline-offset-2 hover:underline"
                                >
                                  {formatDate(row.snapshot_date)}
                                </a>
                              ) : (
                                formatDate(row.snapshot_date)
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
