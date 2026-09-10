import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RCTooltip,
} from 'recharts'
import {
  BarChart3 as BarChartIcon,
  CalendarDays,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Download as DownloadIcon,
  Loader2 as LoaderIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  Table2 as TableIcon,
  X as XIcon,
} from 'lucide-react'

type EarthworksGranularity = 'day' | 'week' | 'month'
type EarthworksMode = 'cumulative' | 'interval'
type EarthworksGrouping = 'objects' | 'sections'
type EarthworksView = 'period' | 'dynamics'
type SortDir = 'asc' | 'desc'

interface DimensionOption {
  id: string
  label: string
  parentId?: string | null
  sourceIds?: string[]
  disabled?: boolean
  unit?: string | null
  precision?: number
}

interface ColumnMeta {
  key: string
  label: string
  role: string
  dataType: 'string' | 'number' | 'percent' | 'date'
  unit?: string | null
  precision?: number
  sortable?: boolean
  conditionalFormat?: 'deviation' | 'progress' | 'none'
}

interface EarthworksMetaResponse {
  updatedAt: string
  defaultDateFrom: string
  defaultDateTo: string
  dimensions: {
    sections: DimensionOption[]
    workTypes: DimensionOption[]
    contractors: DimensionOption[]
    objects: DimensionOption[]
    metrics: DimensionOption[]
  }
  columns: {
    summary: ColumnMeta[]
    period: ColumnMeta[]
    overall: ColumnMeta[]
  }
  capabilities: {
    exportCsv: boolean
    exportXlsx: boolean
    hasForecast: boolean
    supportedGranularities: EarthworksGranularity[]
    supportedModes: EarthworksMode[]
    supportedGroupings?: EarthworksGrouping[]
  }
}

interface EarthworksTreeRow {
  id: string
  parentId?: string | null
  label: string
  unit?: string | null
  level: number
  hasChildren: boolean
  sourceIds?: string[]
  values: Record<string, number | null>
}

interface MetricTotals {
  metricId: string
  label: string
  unit?: string | null
  plan: number | null
  fact: number | null
  deviation: number | null
  remaining: number | null
  completionPct: number | null
  lastFactDate?: string | null
  pace7d?: number | null
}

interface ResponseCacheInfo {
  status?: 'fresh' | 'stale' | string
  fingerprint?: string | null
  generated_at?: string | null
  persistent_created_at?: string | null
  refreshing?: boolean
}

interface EarthworksOverviewResponse {
  updatedAt: string
  summaryRows: EarthworksTreeRow[]
  periodRows: EarthworksTreeRow[]
  overallRows: EarthworksTreeRow[]
  selectedMetricTotals?: MetricTotals | null
  cache?: ResponseCacheInfo
}

interface PlanFactPoint {
  date: string
  plan: number | null
  fact: number | null
  forecast?: number | null
}

interface DynamicsSeriesMeta {
  id: string
  label: string
  unit?: string | null
  groupId?: string | null
}

interface DynamicsPoint {
  date: string
  values: Record<string, number | null>
}

interface EarthworksTimeseriesResponse {
  updatedAt: string
  planFact: {
    metricId: string
    label: string
    unit?: string | null
    points: PlanFactPoint[]
  } | null
  dynamics: {
    series: DynamicsSeriesMeta[]
    points: DynamicsPoint[]
  }
  cache?: ResponseCacheInfo
}

interface MatrixPeriod {
  key: string
  label: string
  dateFrom: string
  dateTo: string
}

interface MatrixCell {
  plan: number | null
  fact: number | null
  deviation: number | null
  completionPct: number | null
}

interface EarthworksMatrixRow {
  id: string
  parentId?: string | null
  label: string
  unit?: string | null
  level: number
  hasChildren?: boolean
  sourceIds?: string[]
  cumulativeTotals?: MatrixCell
  totals: MatrixCell
  cells: Record<string, MatrixCell>
}

interface EarthworksMatrixResponse {
  updatedAt: string
  periods: MatrixPeriod[]
  rows: EarthworksMatrixRow[]
  cache?: ResponseCacheInfo
}

interface SortState {
  key: string
  dir: SortDir
}

const numberFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const integerFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const CHART_COLORS = ['#dc2626', '#1a1a1a', '#16a34a', '#d97706', '#2563eb', '#7f1d1d', '#0f766e', '#9333ea', '#ea580c', '#64748b', '#0891b2', '#be123c']

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof body === 'object' && body && 'detail' in body ? (body as { detail?: unknown }).detail : undefined
    if (typeof detail === 'string') throw new Error(detail)
    if (typeof detail === 'object' && detail && 'message' in detail) throw new Error(String((detail as { message?: unknown }).message))
    throw new Error('Не удалось загрузить данные')
  }
  return body as T
}

function compactNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`
  if (abs >= 100_000) return `${(value / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс`
  return numberFormatter.format(value)
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return Math.abs(value) >= 10_000 ? integerFormatter.format(Math.round(value)) : numberFormatter.format(value)
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${numberFormatter.format(value)}%`
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('ru-RU')
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

function csvEscape(value: unknown): string {
  const str = value == null ? '' : String(value)
  if (!/[;"\n]/.test(str)) return str
  return `"${str.replace(/"/g, '""')}"`
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map(row => row.map(csvEscape).join(';')).join('\n')
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function splitParam(value: string | null): string[] {
  if (!value || value === 'all') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function buildApiQuery(params: {
  dateFrom: string
  dateTo: string
  sections: string[]
  workTypes: string[]
  contractors: string[]
  objects: string[]
  granularity?: EarthworksGranularity
  grouping?: EarthworksGrouping
}): string {
  const qs = new URLSearchParams()
  if (params.dateFrom) qs.set('date_from', params.dateFrom)
  if (params.dateTo) qs.set('date_to', params.dateTo)
  if (params.sections.length) qs.set('section_ids', params.sections.join(','))
  if (params.workTypes.length) qs.set('work_type_ids', params.workTypes.join(','))
  if (params.contractors.length) qs.set('contractor_ids', params.contractors.join(','))
  if (params.objects.length) qs.set('object_ids', params.objects.join(','))
  if (params.granularity) qs.set('granularity', params.granularity)
  if (params.grouping) qs.set('grouping', params.grouping)
  return qs.toString()
}

function rowValue(row: EarthworksTreeRow, key: string): number | null {
  if (key === 'label') return null
  if (key === 'unit') return null
  return row.values?.[key] ?? null
}

function matrixTotalValue(row: EarthworksMatrixRow, key: string): number | null {
  const source = key.startsWith('cumulative.') ? (row.cumulativeTotals || null) : row.totals
  const field = key.replace('cumulative.', '')
  if (field === 'plan') return source?.plan ?? null
  if (field === 'fact') return source?.fact ?? null
  if (field === 'deviation') return source?.deviation ?? null
  if (field === 'completionPct') return source?.completionPct ?? null
  return null
}

function valueClass(key: string, value: number | null | undefined): string {
  if (value == null) return 'text-text-muted'
  if (key === 'deviation') return value < 0 ? 'text-accent-red' : value > 0 ? 'text-progress-green' : 'text-text-muted'
  if (key === 'completion_pct' || key === 'completionPct') return value >= 100 ? 'text-progress-green' : value >= 80 ? 'text-progress-amber' : 'text-accent-red'
  return 'text-text-primary'
}

function CompletionBar({ value }: { value: number | null | undefined }) {
  if (value == null || Number.isNaN(value)) return <span className="text-text-muted">—</span>
  const width = Math.max(0, Math.min(100, value))
  return (
    <div className="flex min-w-[116px] items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
        <div
          className={`h-full rounded-full ${value >= 100 ? 'bg-progress-green' : value >= 80 ? 'bg-progress-amber' : 'bg-accent-red'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className={`font-mono tabular-nums ${valueClass('completion_pct', value)}`}>{value > 100 ? `>${formatPercent(100)}` : formatPercent(value)}</span>
    </div>
  )
}

function CellValue({ column, value }: { column: ColumnMeta; value: number | null | undefined }) {
  if (column.role === 'completion_pct' || column.key === 'completion_pct') return <CompletionBar value={value} />
  return <span className={`font-mono tabular-nums ${valueClass(column.key, value)}`}>{formatNumber(value)}</span>
}

function ErrorState({ message }: { message: string }) {
  return <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{message}</div>
}

function EmptyState({ label = 'Нет данных за выбранный период' }: { label?: string }) {
  return <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border bg-bg-surface px-4 py-8 text-sm text-text-muted">{label}</div>
}

function LoadingState({ label = 'Загрузка данных...' }: { label?: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-text-muted">
      <LoaderIcon className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

function ToggleButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-accent-burg text-white' : 'bg-white text-text-secondary hover:bg-neutral-100'}`}
    >
      {children}
    </button>
  )
}

function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'Все',
}: {
  label: string
  options: DimensionOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [search, setSearch] = useState('')
  const selected = useMemo(() => new Set(value), [value])
  const byId = useMemo(() => new Map(options.map(option => [option.id, option])), [options])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const base = needle ? options.filter(option => `${option.label} ${option.parentId ?? ''}`.toLowerCase().includes(needle)) : options
    return base.slice(0, 160)
  }, [options, search])
  const labelText = value.length ? value.map(item => byId.get(item)?.label || item).slice(0, 2).join(', ') : placeholder
  const suffix = value.length > 2 ? ` +${value.length - 2}` : ''

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next))
  }

  return (
    <details className="group relative">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary shadow-sm hover:bg-neutral-50">
        <span className="text-xs font-semibold uppercase text-text-muted">{label}</span>
        <span className="max-w-48 truncate">{labelText}{suffix}</span>
        <ChevronDownIcon className="h-4 w-4 text-text-muted transition group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-12 z-40 w-80 rounded-md border border-border bg-white p-3 shadow-xl">
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
          <SearchIcon className="h-4 w-4 text-text-muted" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Поиск"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
          <span>{value.length ? `Выбрано: ${value.length}` : 'Все значения'}</span>
          {value.length ? <button type="button" onClick={() => onChange([])} className="text-accent-red hover:underline">Сбросить</button> : null}
        </div>
        <div className="max-h-72 overflow-auto pr-1">
          {filtered.map(option => (
            <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-50">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-red-700"
                checked={selected.has(option.id)}
                disabled={option.disabled}
                onChange={() => toggle(option.id)}
              />
              <span className="min-w-0">
                <span className="block truncate text-text-primary">{option.label}</span>
                {option.parentId ? <span className="block truncate text-xs text-text-muted">{option.parentId}</span> : null}
              </span>
            </label>
          ))}
          {!filtered.length ? <div className="px-2 py-4 text-sm text-text-muted">Ничего не найдено</div> : null}
        </div>
      </div>
    </details>
  )
}

function FilterChips({
  meta,
  sections,
  workTypes,
  contractors,
  objects,
  onRemove,
}: {
  meta: EarthworksMetaResponse | undefined
  sections: string[]
  workTypes: string[]
  contractors: string[]
  objects: string[]
  onRemove: (key: string, id?: string) => void
}) {
  if (!meta) return null
  const groups: Array<[string, string[], DimensionOption[]]> = [
    ['sections', sections, meta.dimensions.sections],
    ['workTypes', workTypes, meta.dimensions.workTypes],
    ['contractors', contractors, meta.dimensions.contractors],
    ['objects', objects, meta.dimensions.objects],
  ]
  const chips: Array<{ key: string; id: string; label: string }> = []
  for (const [key, values, options] of groups) {
    const map = new Map(options.map(option => [option.id, option.label]))
    for (const id of values) chips.push({ key, id, label: map.get(id) || id })
  }
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 pt-2">
      {chips.slice(0, 14).map(chip => (
        <button
          type="button"
          key={`${chip.key}:${chip.id}`}
          onClick={() => onRemove(chip.key, chip.id)}
          className="inline-flex max-w-80 items-center gap-1 rounded-md border border-red-100 bg-red-50 px-2 py-1 text-xs text-accent-burg hover:bg-red-100"
          title={chip.label}
        >
          <span className="truncate">{chip.label}</span>
          <XIcon className="h-3 w-3 shrink-0" />
        </button>
      ))}
      {chips.length > 14 ? <span className="rounded-md bg-neutral-100 px-2 py-1 text-xs text-text-muted">+{chips.length - 14}</span> : null}
    </div>
  )
}

function buildVisibleRows(rows: EarthworksTreeRow[], expanded: Set<string>, search: string, sort: SortState | null): EarthworksTreeRow[] {
  const children = new Map<string | null, EarthworksTreeRow[]>()
  const byId = new Map<string, EarthworksTreeRow>()
  for (const row of rows) {
    byId.set(row.id, row)
    const parent = row.parentId ?? null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(row)
  }
  const needle = search.trim().toLowerCase()
  const selfMatches = (row: EarthworksTreeRow) => !needle || `${row.label} ${row.unit ?? ''}`.toLowerCase().includes(needle)
  const subtreeMatches = (row: EarthworksTreeRow): boolean => selfMatches(row) || (children.get(row.id) || []).some(subtreeMatches)
  const comparator = (a: EarthworksTreeRow, b: EarthworksTreeRow) => {
    if (!sort) return 0
    const dir = sort.dir === 'asc' ? 1 : -1
    if (sort.key === 'label' || sort.key === 'unit') return String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? ''), 'ru') * dir
    return ((rowValue(a, sort.key) ?? -Infinity) - (rowValue(b, sort.key) ?? -Infinity)) * dir
  }
  const out: EarthworksTreeRow[] = []
  const append = (parent: string | null) => {
    const list = [...(children.get(parent) || [])]
    if (sort) list.sort(comparator)
    for (const row of list) {
      if (!subtreeMatches(row)) continue
      out.push(row)
      if (row.hasChildren && expanded.has(row.id)) append(row.id)
    }
  }
  append(null)
  return out
}

function HierarchyTable({
  title,
  rows,
  columns,
  defaultExpand = true,
  dense = false,
}: {
  title: string
  rows: EarthworksTreeRow[]
  columns: ColumnMeta[]
  defaultExpand?: boolean
  dense?: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const parentIds = useMemo(() => rows.filter(row => row.hasChildren).map(row => row.id), [rows])

  useEffect(() => {
    if (defaultExpand) setExpanded(new Set(parentIds))
    else setExpanded(new Set())
  }, [defaultExpand, parentIds.join('|')])

  const visible = useMemo(() => buildVisibleRows(rows, expanded, search, sort), [rows, expanded, search, sort])
  const displayColumns = columns.filter(column => column.key !== 'unit')
  const unitColumn = columns.find(column => column.key === 'unit')

  function toggleSort(column: ColumnMeta) {
    if (column.sortable === false) return
    setSort(current => {
      if (!current || current.key !== column.key) return { key: column.key, dir: 'desc' }
      if (current.dir === 'desc') return { key: column.key, dir: 'asc' }
      return null
    })
  }

  function toggleRow(row: EarthworksTreeRow) {
    if (!row.hasChildren) return
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })
  }

  return (
    <section className="rounded-lg border border-border bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <TableIcon className="h-5 w-5 text-accent-red" />
          <h2 className="text-base font-bold text-text-primary">{title}</h2>
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-text-muted">{rows.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-56 items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5">
            <SearchIcon className="h-4 w-4 text-text-muted" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по строкам" className="w-full bg-transparent text-sm outline-none" />
          </div>
          <button type="button" onClick={() => setExpanded(new Set(parentIds))} className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-neutral-50">Развернуть все</button>
          <button type="button" onClick={() => setExpanded(new Set())} className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-neutral-50">Свернуть все</button>
        </div>
      </div>
      <div className="max-h-[56vh] overflow-auto">
        <table className="min-w-[1180px] w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20 bg-white shadow-[0_1px_0_#e5e5e5]">
            <tr>
              <th className="sticky left-0 z-30 min-w-[340px] bg-white px-3 py-2 text-left text-xs font-semibold uppercase text-text-muted">Наименование</th>
              {unitColumn ? <th className="min-w-24 px-3 py-2 text-left text-xs font-semibold uppercase text-text-muted">{unitColumn.label}</th> : null}
              {displayColumns.filter(column => column.key !== 'label').map(column => (
                <th key={column.key} className="min-w-32 px-3 py-2 text-right text-xs font-semibold uppercase text-text-muted">
                  <button type="button" onClick={() => toggleSort(column)} className="inline-flex items-center justify-end gap-1 hover:text-text-primary">
                    <span>{column.label}</span>
                    {sort?.key === column.key ? <span>{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(row => {
              const isGroup = row.hasChildren && row.level <= 1
              return (
                <tr key={row.id} onClick={() => toggleRow(row)} className={`cursor-pointer border-b border-border ${isGroup ? 'bg-neutral-50' : 'hover:bg-neutral-50'}`}>
                  <td className={`sticky left-0 z-10 border-b border-border px-3 ${dense ? 'py-1.5' : 'py-2'} ${isGroup ? 'bg-neutral-50' : 'bg-white'}`}>
                    <div className="flex items-center gap-2" style={{ paddingLeft: `${row.level * 18}px` }}>
                      {row.hasChildren ? (expanded.has(row.id) ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-text-muted" /> : <ChevronRightIcon className="h-4 w-4 shrink-0 text-text-muted" />) : <span className="h-4 w-4 shrink-0" />}
                      <span className={`truncate ${isGroup ? 'font-semibold text-text-primary' : 'text-text-secondary'}`} title={row.label}>{row.label}</span>
                    </div>
                  </td>
                  {unitColumn ? <td className="border-b border-border px-3 py-2 text-text-muted">{row.unit || '—'}</td> : null}
                  {displayColumns.filter(column => column.key !== 'label').map(column => (
                    <td key={column.key} className={`border-b border-border px-3 ${dense ? 'py-1.5' : 'py-2'} text-right`}>
                      <CellValue column={column} value={rowValue(row, column.key)} />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!visible.length ? <EmptyState /> : null}
      </div>
    </section>
  )
}

function DynamicsChart({ data, selectedSeries, onSeriesSelect }: { data: EarthworksTimeseriesResponse | undefined; selectedSeries: string; onSeriesSelect: (id: string) => void }) {
  const series = data?.dynamics.series || []
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const chartRows = useMemo(() => (data?.dynamics.points || []).map(point => ({ date: point.date, ...point.values })), [data])
  const colorByGroup = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of series) {
      const key = item.groupId || item.id
      if (!map.has(key)) map.set(key, CHART_COLORS[map.size % CHART_COLORS.length])
    }
    return map
  }, [series])
  const visibleSeries = series.filter(item => !hidden.has(item.id))
  function seriesColor(item: DynamicsSeriesMeta): string {
    return colorByGroup.get(item.groupId || item.id) || CHART_COLORS[0]
  }
  function toggleSeries(id: string) {
    setHidden(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    onSeriesSelect(id)
  }
  return (
    <section className="relative z-20 rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-bold text-text-primary">Динамика выполнения работ за выбранный период</h2>
          <p className="text-xs text-text-muted">Серии соответствуют работам МСтрой; в режиме участков цвет закреплен за работой</p>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto pb-1">
          {series.slice(0, 36).map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => toggleSeries(item.id)}
              className={`shrink-0 rounded-md border px-2 py-1 text-xs ${selectedSeries === item.id ? 'border-accent-burg bg-red-50 text-accent-burg' : hidden.has(item.id) ? 'border-border bg-neutral-50 text-text-muted line-through' : 'border-border bg-white text-text-secondary'}`}
              title={item.label}
            >
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: seriesColor(item) }} />
              <span className="inline-block max-w-72 truncate align-bottom">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      {!chartRows.length ? <EmptyState /> : (
        <div className="h-[440px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <AreaChart data={chartRows} margin={{ top: 12, right: 20, left: 0, bottom: 6 }}>
              <CartesianGrid stroke="#e5e5e5" strokeDasharray="3 3" />
              <XAxis dataKey="date" minTickGap={28} tick={{ fontSize: 12 }} tickFormatter={formatDate} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={compactNumber} width={70} />
              <RCTooltip
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 80, pointerEvents: 'none' }}
                contentStyle={{ borderRadius: 8, borderColor: '#e5e5e5', boxShadow: '0 12px 30px rgba(0,0,0,0.16)' }}
                formatter={(value: unknown, name: unknown) => {
                  const meta = series.find(item => item.id === name)
                  return [formatNumber(typeof value === 'number' ? value : Number(value)), meta ? `${meta.label}${meta.unit ? `, ${meta.unit}` : ''}` : String(name)]
                }}
                labelFormatter={label => formatDate(String(label))}
              />
              {visibleSeries.map(item => (
                <Area
                  key={item.id}
                  type="monotone"
                  dataKey={item.id}
                  name={item.id}
                  stroke={seriesColor(item)}
                  fill={seriesColor(item)}
                  fillOpacity={selectedSeries === item.id ? 0.22 : 0.08}
                  strokeWidth={selectedSeries === item.id ? 2.8 : 1.8}
                  dot={false}
                  connectNulls
                />
              ))}
              {chartRows.length > 45 ? <Brush dataKey="date" height={24} travellerWidth={8} tickFormatter={formatDate} /> : null}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}

function buildVisibleMatrixRows(rows: EarthworksMatrixRow[], expanded: Set<string>, search: string, sort: SortState | null): EarthworksMatrixRow[] {
  const children = new Map<string | null, EarthworksMatrixRow[]>()
  for (const row of rows) {
    const parent = row.parentId ?? null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(row)
  }
  const needle = search.trim().toLowerCase()
  const selfMatches = (row: EarthworksMatrixRow) => !needle || `${row.label} ${row.unit ?? ''}`.toLowerCase().includes(needle)
  const subtreeMatches = (row: EarthworksMatrixRow): boolean => selfMatches(row) || (children.get(row.id) || []).some(subtreeMatches)
  const comparator = (a: EarthworksMatrixRow, b: EarthworksMatrixRow) => {
    if (!sort) return 0
    const dir = sort.dir === 'asc' ? 1 : -1
    if (sort.key === 'label') return a.label.localeCompare(b.label, 'ru') * dir
    return ((matrixTotalValue(a, sort.key) ?? -Infinity) - (matrixTotalValue(b, sort.key) ?? -Infinity)) * dir
  }
  const out: EarthworksMatrixRow[] = []
  const append = (parent: string | null) => {
    const list = [...(children.get(parent) || [])]
    if (sort) list.sort(comparator)
    for (const row of list) {
      if (!subtreeMatches(row)) continue
      out.push(row)
      if (row.hasChildren && (expanded.has(row.id) || Boolean(needle))) append(row.id)
    }
  }
  append(null)
  return out
}

function MatrixTable({ data }: { data: EarthworksMatrixResponse | undefined }) {
  const rows = data?.rows || []
  const periods = data?.periods || []
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const metricColumns = [
    { key: 'plan', label: 'План' },
    { key: 'fact', label: 'Факт' },
    { key: 'deviation', label: 'Δ' },
    { key: 'completionPct', label: '%' },
  ]
  const parentIds = useMemo(() => rows.filter(row => row.hasChildren).map(row => row.id), [rows])
  useEffect(() => {
    setExpanded(new Set())
  }, [parentIds.join('|')])
  const filteredRows = useMemo(() => buildVisibleMatrixRows(rows, expanded, search, sort), [rows, expanded, search, sort])
  function toggleSort(key: string) {
    setSort(current => {
      if (!current || current.key !== key) return { key, dir: 'desc' }
      if (current.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }
  function toggleRow(row: EarthworksMatrixRow) {
    if (!row.hasChildren) return
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })
  }
  return (
    <section className="relative z-0 rounded-lg border border-border bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <BarChartIcon className="h-5 w-5 text-accent-red" />
          <h2 className="text-base font-bold text-text-primary">План-фактный анализ выполнения работ за выбранный период</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setExpanded(new Set(parentIds))} className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-neutral-50">Развернуть все</button>
          <button type="button" onClick={() => setExpanded(new Set())} className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-neutral-50">Свернуть все</button>
          <div className="flex min-w-64 items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <SearchIcon className="h-4 w-4 text-text-muted" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по матрице" className="w-full bg-transparent text-sm outline-none" />
          </div>
        </div>
      </div>
      <div className="max-h-[58vh] overflow-auto">
        <table className="min-w-[1760px] border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-30 bg-white shadow-[0_1px_0_#e5e5e5]">
            <tr>
              <th rowSpan={2} className="sticky left-0 z-40 w-[360px] min-w-[360px] bg-white px-3 py-2 text-left text-xs font-semibold uppercase text-text-muted">
                <button type="button" onClick={() => toggleSort('label')}>Наименование {sort?.key === 'label' ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</button>
              </th>
              <th rowSpan={2} className="min-w-20 bg-white px-3 py-2 text-left text-xs font-semibold uppercase text-text-muted">Ед.</th>
              <th colSpan={4} className="min-w-[360px] border-l border-border px-3 py-2 text-center text-xs font-semibold uppercase text-text-muted">Накопительно</th>
              <th colSpan={4} className="min-w-[360px] border-l border-border px-3 py-2 text-center text-xs font-semibold uppercase text-text-muted">Итого за период</th>
              {periods.map(period => <th key={period.key} colSpan={4} className="min-w-[360px] border-l border-border px-3 py-2 text-center text-xs font-semibold uppercase text-text-muted">{period.label}</th>)}
            </tr>
            <tr>
              {metricColumns.map((column, idx) => (
                <th key={`cumulative:${column.key}`} className={`sticky top-[33px] z-20 min-w-24 bg-white px-3 py-2 text-right text-xs font-semibold uppercase text-text-muted ${idx === 0 ? 'border-l border-border' : ''}`}>
                  <button type="button" onClick={() => toggleSort(`cumulative.${column.key}`)}>{column.label} {sort?.key === `cumulative.${column.key}` ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</button>
                </th>
              ))}
              {metricColumns.map((column, idx) => (
                <th key={`total:${column.key}`} className={`sticky top-[33px] z-20 min-w-24 bg-white px-3 py-2 text-right text-xs font-semibold uppercase text-text-muted ${idx === 0 ? 'border-l border-border' : ''}`}>
                  <button type="button" onClick={() => toggleSort(column.key)}>{column.label} {sort?.key === column.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</button>
                </th>
              ))}
              {periods.flatMap(period => metricColumns.map((column, idx) => <th key={`${period.key}:${column.key}`} className={`sticky top-[33px] z-20 min-w-24 bg-white px-3 py-2 text-right text-xs font-semibold uppercase text-text-muted ${idx === 0 ? 'border-l border-border' : ''}`}>{column.label}</th>))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(row => {
              const isGroup = Boolean(row.hasChildren)
              return (
                <tr key={row.id} onClick={() => toggleRow(row)} className={`${isGroup ? 'cursor-pointer bg-neutral-50' : 'hover:bg-neutral-50'}`}>
                  <td className={`sticky left-0 z-10 border-b border-border px-3 py-2 ${isGroup ? 'bg-neutral-50 font-semibold text-text-primary' : 'bg-white font-medium text-text-primary'}`}>
                    <div className="flex items-center gap-2" style={{ paddingLeft: `${Math.min(row.level || 0, 5) * 18}px` }}>
                      {row.hasChildren ? (expanded.has(row.id) ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-text-muted" /> : <ChevronRightIcon className="h-4 w-4 shrink-0 text-text-muted" />) : <span className="h-4 w-4 shrink-0" />}
                      <span className="whitespace-normal break-words" title={row.label}>{row.label}</span>
                    </div>
                  </td>
                  <td className={`border-b border-border px-3 py-2 ${isGroup ? 'bg-neutral-50 font-semibold text-text-secondary' : 'text-text-muted'}`}>{row.unit || '—'}</td>
                  <FragmentCells cell={row.cumulativeTotals || { plan: null, fact: null, deviation: null, completionPct: null }} />
                  <FragmentCells cell={row.totals} />
                  {periods.map(period => {
                    const cell = row.cells[period.key] || { plan: null, fact: null, deviation: null, completionPct: null }
                    return <FragmentCells key={period.key} cell={cell} />
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!filteredRows.length ? <EmptyState /> : null}
      </div>
    </section>
  )
}

function FragmentCells({ cell }: { cell: MatrixCell }) {
  return (
    <>
      <MatrixCellView value={cell.plan} separated />
      <MatrixCellView value={cell.fact} accent />
      <MatrixCellView value={cell.deviation} deviation />
      <MatrixCellView value={cell.completionPct} percent />
    </>
  )
}

function MatrixCellView({ value, percent = false, deviation = false, accent = false, separated = false }: { value: number | null | undefined; percent?: boolean; deviation?: boolean; accent?: boolean; separated?: boolean }) {
  const color = deviation ? valueClass('deviation', value) : percent ? valueClass('completion_pct', value) : accent ? 'text-accent-red' : 'text-text-primary'
  const bg = deviation && value != null && value < 0 ? 'bg-red-50' : percent && value != null && value >= 100 ? 'bg-green-50' : ''
  return <td className={`border-b border-border px-3 py-2 text-right font-mono tabular-nums ${separated ? 'border-l' : ''} ${bg} ${color}`}>{percent ? formatPercent(value) : formatNumber(value)}</td>
}

function buildOverviewCsv(overview: EarthworksOverviewResponse | undefined, columns: ColumnMeta[]): string[][] {
  const header = ['Блок', ...columns.map(column => column.label)]
  const rows = overview?.summaryRows || []
  return [header, ...rows.map(row => ['Сводная', ...columns.map(column => column.key === 'label' ? row.label : column.key === 'unit' ? row.unit || '' : String(row.values[column.key] ?? ''))])]
}

function buildMatrixCsv(matrix: EarthworksMatrixResponse | undefined): string[][] {
  const periods = matrix?.periods || []
  const header = ['Наименование', 'Ед. изм.', 'Накопительно план', 'Накопительно факт', 'Накопительно Δ', 'Накопительно %', 'Итого план', 'Итого факт', 'Итого Δ', 'Итого %', ...periods.flatMap(period => [`${period.label} план`, `${period.label} факт`, `${period.label} Δ`, `${period.label} %`])]
  const rows = matrix?.rows || []
  return [header, ...rows.map(row => {
    const cumulative = row.cumulativeTotals || { plan: null, fact: null, deviation: null, completionPct: null }
    return [
      row.label,
      row.unit || '',
      String(cumulative.plan ?? ''),
      String(cumulative.fact ?? ''),
      String(cumulative.deviation ?? ''),
      String(cumulative.completionPct ?? ''),
      String(row.totals.plan ?? ''),
      String(row.totals.fact ?? ''),
      String(row.totals.deviation ?? ''),
      String(row.totals.completionPct ?? ''),
      ...periods.flatMap(period => {
        const cell = row.cells[period.key] || { plan: null, fact: null, deviation: null, completionPct: null }
        return [String(cell.plan ?? ''), String(cell.fact ?? ''), String(cell.deviation ?? ''), String(cell.completionPct ?? '')]
      }),
    ]
  })]
}

export default function EarthworksPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view: EarthworksView = searchParams.get('view') === 'dynamics' ? 'dynamics' : 'period'
  const granularity: EarthworksGranularity = ['day', 'week', 'month'].includes(searchParams.get('granularity') || '') ? searchParams.get('granularity') as EarthworksGranularity : 'day'
  const matrixGranularity: EarthworksGranularity = granularity === 'day' ? 'week' : granularity
  const grouping: EarthworksGrouping = searchParams.get('grouping') === 'sections' ? 'sections' : 'objects'
  const sections = splitParam(searchParams.get('sections'))
  const workTypes = splitParam(searchParams.get('workTypes'))
  const contractors = splitParam(searchParams.get('contractors'))
  const objects = splitParam(searchParams.get('objects'))
  const dateFromParam = searchParams.get('dateFrom') || ''
  const dateToParam = searchParams.get('dateTo') || ''

  const metaQuery = useQuery<EarthworksMetaResponse, Error>({
    queryKey: ['earthworks-meta'],
    queryFn: () => fetchJson('/api/wip/earthworks/meta'),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  })
  const meta = metaQuery.data
  const dateFrom = dateFromParam || meta?.defaultDateFrom || ''
  const dateTo = dateToParam || meta?.defaultDateTo || ''

  const apiQuery = useMemo(() => buildApiQuery({ dateFrom, dateTo, sections, workTypes, contractors, objects, granularity, grouping }), [dateFrom, dateTo, sections.join(','), workTypes.join(','), contractors.join(','), objects.join(','), granularity, grouping])
  const matrixQueryString = useMemo(() => buildApiQuery({ dateFrom, dateTo, sections, workTypes, contractors, objects, granularity: matrixGranularity, grouping }), [dateFrom, dateTo, sections.join(','), workTypes.join(','), contractors.join(','), objects.join(','), matrixGranularity, grouping])

  const overviewQuery = useQuery<EarthworksOverviewResponse, Error>({
    queryKey: ['earthworks-overview', apiQuery],
    queryFn: () => fetchJson(`/api/wip/earthworks/overview?${apiQuery}`),
    enabled: view === 'period' && Boolean(dateFrom && dateTo),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const timeseriesQuery = useQuery<EarthworksTimeseriesResponse, Error>({
    queryKey: ['earthworks-timeseries', apiQuery],
    queryFn: () => fetchJson(`/api/wip/earthworks/timeseries?${apiQuery}`),
    enabled: Boolean(dateFrom && dateTo),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const matrixQuery = useQuery<EarthworksMatrixResponse, Error>({
    queryKey: ['earthworks-matrix', matrixQueryString],
    queryFn: () => fetchJson(`/api/wip/earthworks/matrix?${matrixQueryString}`),
    enabled: view === 'dynamics' && Boolean(dateFrom && dateTo),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  const [selectedSeries, setSelectedSeries] = useState('')
  const updatedAt = view === 'period' ? (overviewQuery.data?.updatedAt || meta?.updatedAt) : (timeseriesQuery.data?.updatedAt || matrixQuery.data?.updatedAt || meta?.updatedAt)
  const activeCacheInfo = view === 'period'
    ? (overviewQuery.data?.cache?.status === 'stale' ? overviewQuery.data.cache : timeseriesQuery.data?.cache)
    : (matrixQuery.data?.cache?.status === 'stale' ? matrixQuery.data.cache : timeseriesQuery.data?.cache)
  const isRecalculating = activeCacheInfo?.status === 'stale'
  const isLoading = metaQuery.isLoading || (view === 'period' ? overviewQuery.isLoading : (timeseriesQuery.isLoading || matrixQuery.isLoading))
  const error = metaQuery.error || (view === 'period' ? overviewQuery.error : (timeseriesQuery.error || matrixQuery.error))

  useEffect(() => {
    if (!meta) return
    const patch: Record<string, string> = {}
    if (!searchParams.get('dateFrom')) patch.dateFrom = meta.defaultDateFrom
    if (!searchParams.get('dateTo')) patch.dateTo = meta.defaultDateTo
    if (!Object.keys(patch).length) return
    setUrl(patch, true)
  }, [meta])

  useEffect(() => {
    if (!isRecalculating) return
    const timer = window.setTimeout(() => {
      if (view === 'period') {
        overviewQuery.refetch()
        timeseriesQuery.refetch()
      } else {
        timeseriesQuery.refetch()
        matrixQuery.refetch()
      }
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [activeCacheInfo?.fingerprint, activeCacheInfo?.generated_at, isRecalculating, view])

  function setUrl(patch: Record<string, string | string[] | null | undefined>, replace = false) {
    const next = new URLSearchParams(searchParams)
    for (const [key, raw] of Object.entries(patch)) {
      if (Array.isArray(raw)) {
        if (raw.length) next.set(key, raw.join(','))
        else next.delete(key)
      } else if (raw) {
        next.set(key, raw)
      } else {
        next.delete(key)
      }
    }
    setSearchParams(next, { replace })
  }

  function resetFilters() {
    const next = new URLSearchParams()
    next.set('view', view)
    next.set('grouping', grouping)
    if (meta) {
      next.set('dateFrom', meta.defaultDateFrom)
      next.set('dateTo', meta.defaultDateTo)
    }
    setSearchParams(next)
  }

  function setCurrentMonth() {
    const base = new Date(dateTo || meta?.defaultDateTo || new Date().toISOString().slice(0, 10))
    const first = new Date(base.getFullYear(), base.getMonth(), 1)
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0)
    setUrl({ dateFrom: first.toISOString().slice(0, 10), dateTo: last.toISOString().slice(0, 10) })
  }

  function refreshAll() {
    metaQuery.refetch()
    if (view === 'period') {
      overviewQuery.refetch()
      timeseriesQuery.refetch()
    } else {
      timeseriesQuery.refetch()
      matrixQuery.refetch()
    }
  }

  function removeChip(key: string, id?: string) {
    if (key === 'sections') setUrl({ sections: sections.filter(item => item !== id) })
    if (key === 'workTypes') setUrl({ workTypes: workTypes.filter(item => item !== id) })
    if (key === 'contractors') setUrl({ contractors: contractors.filter(item => item !== id) })
    if (key === 'objects') setUrl({ objects: objects.filter(item => item !== id) })
  }

  function exportCurrentView() {
    if (view === 'dynamics') downloadCsv(`mstroy-matrix-${dateFrom}-${dateTo}.csv`, buildMatrixCsv(matrixQuery.data))
    else downloadCsv(`mstroy-overview-${dateFrom}-${dateTo}.csv`, buildOverviewCsv(overviewQuery.data, meta?.columns.summary || []))
  }

  return (
    <div className="space-y-4 p-4 pb-24 lg:p-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-text-muted">
            <CalendarDays className="h-4 w-4" />
            <span>Обновлено: {formatDateTime(updatedAt)}</span>
          </div>
          <h1 className="text-2xl font-bold text-text-primary lg:text-3xl">МСтрой</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-lg bg-white p-1 shadow-sm ring-1 ring-border">
            <ToggleButton active={view === 'period'} onClick={() => setUrl({ view: 'period' })}>Объемы</ToggleButton>
            <ToggleButton active={view === 'dynamics'} onClick={() => setUrl({ view: 'dynamics' })}>Динамика</ToggleButton>
          </div>
          <button type="button" onClick={refreshAll} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm text-text-secondary shadow-sm hover:bg-neutral-50">
            <RefreshIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Обновить
          </button>
          {meta?.capabilities.exportCsv ? (
            <button type="button" onClick={exportCurrentView} className="inline-flex items-center gap-2 rounded-md bg-accent-burg px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark">
              <DownloadIcon className="h-4 w-4" />
              CSV
            </button>
          ) : null}
        </div>
	      </header>

	      {isRecalculating ? (
	        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
	          <RefreshIcon className="h-4 w-4 animate-spin" />
	          <span>Показан часовой кеш МСтрой. Свежие данные пересчитываются в фоне, вкладка обновится автоматически.</span>
	        </div>
	      ) : null}

	      <section className="sticky top-0 z-30 rounded-lg border border-border bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm">
            <span className="text-xs font-semibold uppercase text-text-muted">От</span>
            <input type="date" value={dateFrom} onChange={event => setUrl({ dateFrom: event.target.value })} className="bg-transparent outline-none" />
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm">
            <span className="text-xs font-semibold uppercase text-text-muted">До</span>
            <input type="date" value={dateTo} onChange={event => setUrl({ dateTo: event.target.value })} className="bg-transparent outline-none" />
          </div>
          <button type="button" onClick={setCurrentMonth} className="rounded-md border border-border bg-white px-3 py-2 text-sm text-text-secondary hover:bg-neutral-50">Месяц</button>
          <div className="flex items-center gap-1 rounded-md border border-border bg-white p-1">
            <span className="px-2 text-xs font-semibold uppercase text-text-muted">Детализация</span>
            <ToggleButton active={grouping === 'objects'} onClick={() => setUrl({ grouping: 'objects' })}>Объекты</ToggleButton>
            <ToggleButton active={grouping === 'sections'} onClick={() => setUrl({ grouping: 'sections' })}>Участки</ToggleButton>
          </div>
          <MultiSelect label="Участок" options={meta?.dimensions.sections || []} value={sections} onChange={next => setUrl({ sections: next })} />
          <button type="button" onClick={resetFilters} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:bg-neutral-50">
            <XIcon className="h-4 w-4" />
            Сброс
          </button>
        </div>
        <FilterChips meta={meta} sections={sections} workTypes={workTypes} contractors={contractors} objects={objects} onRemove={removeChip} />
      </section>

      {error ? <ErrorState message={error.message} /> : null}
      {isLoading && (view === 'period' ? !overviewQuery.data : (!timeseriesQuery.data && !matrixQuery.data)) ? <LoadingState /> : null}

      {view === 'period' ? (
        <div className="space-y-4">
          <HierarchyTable
            title="Сводная таблица объемов"
            rows={overviewQuery.data?.summaryRows || []}
            columns={meta?.columns.summary || []}
          />
          <HierarchyTable
            title="Объемы за выбранный период"
            rows={overviewQuery.data?.periodRows || []}
            columns={meta?.columns.period || []}
            dense
          />
          {timeseriesQuery.isLoading && !timeseriesQuery.data ? <LoadingState label="Загрузка графика..." /> : <DynamicsChart data={timeseriesQuery.data} selectedSeries={selectedSeries} onSeriesSelect={setSelectedSeries} />}
        </div>
      ) : (
        <div className="space-y-4">
          <DynamicsChart data={timeseriesQuery.data} selectedSeries={selectedSeries} onSeriesSelect={setSelectedSeries} />
          <MatrixTable data={matrixQuery.data} />
        </div>
      )}
    </div>
  )
}
