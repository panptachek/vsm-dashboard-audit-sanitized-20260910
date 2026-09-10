/**
 * Страница «Производительность механизации».
 * Таблица всей техники, встречавшейся в суточных отчётах за выбранный период.
 * Колонки: Тип | Марка | Гос.номер | Бортовой № | Участок | Смен | Время | Пробег | Моточасы | Расход | %
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Check, ChevronDown, ChevronRight, Loader2, Pencil, Trash2, Truck, X } from 'lucide-react'
import { PeriodBar } from './PeriodBar'
import { usePeriod } from './usePeriod'
import { EquipmentBlock } from './blocks/EquipmentBlock'
import { EquipmentFuelBlock } from './blocks/EquipmentFuelBlock'

interface ShiftDetail {
  date: string; shift: string; section: string
  work: string; fact: number; norm: number; reference_norm?: number | null
  work_hours?: number | null; unit?: string | null; percent: number | null
}
interface UnitRow {
  merge_key?: string
  master_equipment_id?: string | null
  report_equipment_ids?: string[]
  equipment_type: string
  brand_model: string
  plate_number: string
  unit_number: string
  ownership: string
  contractor: string
  status?: string
  location?: string | null
  source_name?: string | null
  source_date?: string | null
  last_section: string | null
  last_date: string | null
  shifts_worked: number
  work_hours_total?: number
  fact_total: number
  expected_total: number
  fact_unit: string | null
  percent: number | null
  mileage_km_total?: number
  engine_hours_total?: number
  fuel_liters_total?: number
  operation_metric_rows?: number
  operation_work_shifts?: number
  details: ShiftDetail[]
}

interface CleanupUnit {
  kind: 'master' | 'report'
  master_equipment_id?: string | null
  report_equipment_ids?: string[]
  label: string
  equipment_type: string
  brand_model: string
  plate_number: string
  unit_number: string
  ownership: string
  contractor: string
  status?: string | null
  source_name?: string | null
  source_date?: string | null
  location?: string | null
  first_date?: string | null
  last_date?: string | null
  shifts_count?: number
}

interface CleanupPair {
  id: string
  score: number
  reason: string
  master: CleanupUnit
  report: CleanupUnit
}

interface CleanupCandidates {
  from: string
  to: string
  pairs: CleanupPair[]
  others: CleanupUnit[]
}

interface CleanupMutationResponse {
  ok: boolean
}

interface DuplicateMergeResponse extends CleanupMutationResponse {
  merged_master_groups: number
  deactivated_master_units: number
  relinked_master_references: number
  merged_report_groups: number
  hidden_report_units: number
  linked_report_units: number
  moved_work_usage: number
  moved_movement_usage: number
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))

type MechanizationSortKey = 'type' | 'brand' | 'plate' | 'unit' | 'ownership' | 'section' | 'status' | 'shifts' | 'work_hours' | 'mileage' | 'engine_hours' | 'fuel' | 'percent'
type SortDir = 'asc' | 'desc'
type MechanizationFilterKey = 'type' | 'brand' | 'plate' | 'unit' | 'ownership' | 'section' | 'status'
type MechanizationFilters = Partial<Record<MechanizationFilterKey, string[]>>
type MechanizationFilterOption = { value: string; label: string; count: number }

const MECHANIZATION_SORT_KEY_KEY = 'vsm-dashboard:mechanization:sort-key'
const MECHANIZATION_SORT_DIR_KEY = 'vsm-dashboard:mechanization:sort-dir'
const MECHANIZATION_FILTERS_KEY = 'vsm-dashboard:mechanization:filters'
const MECHANIZATION_FILTER_KEYS: MechanizationFilterKey[] = ['type', 'brand', 'plate', 'unit', 'ownership', 'section', 'status']

function storedMechanizationSortKey(): MechanizationSortKey {
  if (typeof window === 'undefined') return 'section'
  const value = window.localStorage.getItem(MECHANIZATION_SORT_KEY_KEY)
  return value === 'type' || value === 'brand' || value === 'plate' || value === 'unit' || value === 'ownership' || value === 'section' || value === 'status' || value === 'shifts' || value === 'work_hours' || value === 'mileage' || value === 'engine_hours' || value === 'fuel' || value === 'percent'
    ? value
    : 'section'
}

function storedSortDir(key: string, fallback: SortDir = 'asc'): SortDir {
  if (typeof window === 'undefined') return fallback
  return window.localStorage.getItem(key) === 'desc' ? 'desc' : 'asc'
}

function storedMechanizationFilters(): MechanizationFilters {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MECHANIZATION_FILTERS_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: MechanizationFilters = {}
    for (const key of MECHANIZATION_FILTER_KEYS) {
      const raw = (parsed as Record<string, unknown>)[key]
      if (!Array.isArray(raw)) continue
      const values = raw.filter((item): item is string => typeof item === 'string')
      if (values.length) result[key] = values
    }
    return result
  } catch {
    return {}
  }
}

function isJdsOwnership(ownership?: string | null, contractor?: string | null): boolean {
  const owner = (ownership || '').toLowerCase()
  const normalized = (contractor || '').trim().toLowerCase().replace('ё', 'е')
  return owner === 'own' || normalized === 'ждс' || normalized.includes('ооо ждс')
}

function mechanizationOwnershipLabel(unit: { ownership?: string | null; contractor?: string | null }): string {
  const contractor = (unit.contractor || '').trim()
  const normalized = contractor.toLowerCase().replace('ё', 'е')
  if (isJdsOwnership(unit.ownership, unit.contractor)) return 'ЖДС'
  if (normalized.includes('алмаз')) return 'АЛМАЗ'
  if (contractor && contractor !== '—') return contractor
  if ((unit.ownership || '').toLowerCase() === 'hired') return 'Наемная'
  return 'Не указано'
}

function mechanizationStatusLabel(status?: string | null): string {
  const value = (status || '').toLowerCase()
  if (value === 'working') return 'В работе'
  if (value === 'repair') return 'Ремонт'
  if (value === 'out') return 'Не на линии'
  if (value === 'standby') return 'Ожидание'
  if (value === 'unknown') return 'Не указано'
  return status || 'Не указано'
}

function mechanizationFilterValue(unit: UnitRow, key: MechanizationFilterKey): string {
  if (key === 'type') return unit.equipment_type || ''
  if (key === 'brand') return unit.brand_model || ''
  if (key === 'plate') return unit.plate_number || ''
  if (key === 'unit') return unit.unit_number || ''
  if (key === 'ownership') return mechanizationOwnershipLabel(unit)
  if (key === 'section') return unit.last_section || ''
  return mechanizationStatusLabel(unit.status)
}

function mechanizationFilterLabel(key: MechanizationFilterKey, value: string): string {
  if (!value || value === '—') return '—'
  if (key === 'ownership' || key === 'status') return value
  if (key === 'section') return value.replace('UCH_', '№')
  return value
}

function buildMechanizationFilterOptions(units: UnitRow[], key: MechanizationFilterKey): MechanizationFilterOption[] {
  const counts = new Map<string, number>()
  for (const unit of units) {
    const value = mechanizationFilterValue(unit, key)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: mechanizationFilterLabel(key, value), count }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

function unitRowKey(unit: UnitRow): string {
  return unit.merge_key ?? `${unit.equipment_type}|${unit.brand_model}|${unit.plate_number}|${unit.unit_number}|${unit.source_name ?? ''}`
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof body === 'object' && body && 'detail' in body ? (body as { detail?: unknown }).detail : undefined
    if (typeof detail === 'string') throw new Error(detail)
    if (typeof detail === 'object' && detail && 'message' in detail) {
      throw new Error(String((detail as { message?: unknown }).message))
    }
    throw new Error('Не удалось выполнить действие')
  }
  return body as T
}

function pctColor(p: number | null): string {
  if (p == null) return 'text-text-muted'
  if (p >= 95) return 'text-[#16a34a]'
  if (p >= 75) return 'text-[#f59e0b]'
  return 'text-accent-red'
}

function cleanupUnitKey(unit: CleanupUnit): string {
  return (unit.report_equipment_ids ?? []).join('|') || unit.master_equipment_id || unit.label
}

function formatDateRange(unit: CleanupUnit): string {
  if (unit.kind === 'master') {
    return [unit.source_name, unit.source_date].filter(Boolean).join(' · ') || 'Гермес'
  }
  if (unit.first_date && unit.last_date && unit.first_date !== unit.last_date) {
    return `${unit.first_date}—${unit.last_date}`
  }
  return unit.last_date || unit.first_date || '—'
}

function formatDuplicateMergeSummary(result: DuplicateMergeResponse): string {
  const changes = [
    result.merged_master_groups > 0 ? `${result.merged_master_groups} групп справочника` : null,
    result.deactivated_master_units > 0 ? `${result.deactivated_master_units} дублей справочника выключено` : null,
    result.relinked_master_references > 0 ? `${result.relinked_master_references} ссылок отчетов перепривязано` : null,
    result.merged_report_groups > 0 ? `${result.merged_report_groups} групп в отчетах` : null,
    result.hidden_report_units > 0 ? `${result.hidden_report_units} строк отчетов скрыто` : null,
    result.moved_work_usage + result.moved_movement_usage > 0
      ? `${result.moved_work_usage + result.moved_movement_usage} фактов производительности перенесено`
      : null,
  ].filter(Boolean)
  return changes.length > 0 ? `Объединение выполнено: ${changes.join(', ')}.` : 'Дубли по госномеру за выбранный период не найдены.'
}

function CleanupUnitSummary({ unit, badge }: { unit: CleanupUnit; badge: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded bg-bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{badge}</span>
        <span className="truncate text-[11px] text-text-muted">{formatDateRange(unit)}</span>
      </div>
      <div className="truncate text-sm font-heading font-bold text-text-primary">{unit.label}</div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-text-muted">Госномер</span>
          <span className="font-mono">{unit.plate_number || '—'}</span>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-text-muted">Бортовой</span>
          <span className="font-mono">{unit.unit_number || '—'}</span>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-text-muted">Собственность</span>
          <span>{mechanizationOwnershipLabel(unit)}</span>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-text-muted">Смен</span>
          <span className="font-mono">{unit.shifts_count ?? 0}</span>
        </div>
      </div>
      {unit.contractor && unit.contractor !== '—' && (
        <div className="mt-2 truncate text-[11px] text-text-muted">{unit.contractor}</div>
      )}
    </div>
  )
}

function CleanupPanel({
  data,
  isLoading,
  error,
  pendingMergeId,
  pendingDeleteKey,
  isBulkMerging,
  bulkMergeMessage,
  onMerge,
  onDelete,
  onMergeDuplicates,
}: {
  data: CleanupCandidates | undefined
  isLoading: boolean
  error: Error | null
  pendingMergeId: string | null
  pendingDeleteKey: string | null
  isBulkMerging: boolean
  bulkMergeMessage: string | null
  onMerge: (pair: CleanupPair, keep: 'master' | 'report') => void
  onDelete: (unit: CleanupUnit) => void
  onMergeDuplicates: () => void
}) {
  if (isLoading) {
    return (
      <section className="border border-border bg-white p-4 shadow-sm">
        <div className="h-28 animate-pulse rounded-md bg-bg-surface" />
      </section>
    )
  }

  if (error) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-accent-red">
        {error.message}
      </section>
    )
  }

  const pairs = data?.pairs ?? []
  const others = data?.others ?? []

  return (
    <section className="space-y-4">
      <div className="border border-border bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-heading text-base font-bold text-text-primary">Предположительные дубли</h2>
            <div className="text-[11px] text-text-muted">{pairs.length} пар</div>
          </div>
          <button
            type="button"
            onClick={onMergeDuplicates}
            disabled={isBulkMerging}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBulkMerging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
            Объединить дубли
          </button>
        </div>
        {bulkMergeMessage && (
          <div className="border-b border-border bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800">
            {bulkMergeMessage}
          </div>
        )}
        <div className="divide-y divide-border">
          {pairs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">Похожих пар за период нет.</div>
          ) : pairs.map(pair => {
            const isPending = pendingMergeId === pair.id
            return (
              <div key={pair.id} className="grid gap-3 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px]">
                <CleanupUnitSummary unit={pair.master} badge="Гермес" />
                <CleanupUnitSummary unit={pair.report} badge="Суточный отчет" />
                <div className="flex flex-col justify-between gap-3 rounded-md border border-border bg-bg-surface p-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Совпадение {Math.round(pair.score * 100)}%</div>
                    <div className="mt-1 text-xs text-text-secondary">{pair.reason}</div>
                  </div>
                  <div className="grid gap-2">
                    <button
                      type="button"
                      onClick={() => onMerge(pair, 'master')}
                      disabled={isPending}
                      className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                      В первую
                    </button>
                    <button
                      type="button"
                      onClick={() => onMerge(pair, 'report')}
                      disabled={isPending}
                      className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                      Во вторую
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="overflow-hidden border border-border bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-heading text-base font-bold text-text-primary">Остальные строки из отчетов</h2>
            <div className="text-[11px] text-text-muted">{others.length} строк</div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-bg-surface">
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-muted">
                <th className="py-2 pl-4 pr-2 text-left font-semibold">Тип</th>
                <th className="px-2 py-2 text-left font-semibold">Марка</th>
                <th className="px-2 py-2 text-left font-semibold">Гос.номер</th>
                <th className="px-2 py-2 text-left font-semibold">Борт. №</th>
                <th className="px-2 py-2 text-left font-semibold">Период</th>
                <th className="px-2 py-2 text-right font-semibold">Смен</th>
                <th className="py-2 pl-2 pr-4 text-right font-semibold">Действие</th>
              </tr>
            </thead>
            <tbody>
              {others.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-text-muted">Строк нет.</td></tr>
              ) : others.map(unit => {
                const key = cleanupUnitKey(unit)
                const isPending = pendingDeleteKey === key
                return (
                  <tr key={key} className="border-b border-border/60">
                    <td className="py-2 pl-4 pr-2 font-semibold text-text-primary">{unit.equipment_type}</td>
                    <td className="px-2 py-2 text-text-secondary">{unit.brand_model}</td>
                    <td className="px-2 py-2 font-mono text-text-secondary">{unit.plate_number}</td>
                    <td className="px-2 py-2 font-mono text-text-secondary">{unit.unit_number}</td>
                    <td className="px-2 py-2 font-mono text-text-muted">{formatDateRange(unit)}</td>
                    <td className="px-2 py-2 text-right font-mono">{unit.shifts_count ?? 0}</td>
                    <td className="py-2 pl-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => onDelete(unit)}
                        disabled={isPending || (unit.report_equipment_ids?.length ?? 0) === 0}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-accent-red hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        Удалить
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function MechanizationColumnHeader({
  title,
  align = 'left',
  sortKeyValue,
  activeSortKey,
  sortDir,
  filterKey,
  isFilterOpen,
  options = [],
  excludedValues = [],
  onToggleSort,
  onToggleFilter,
  onToggleFilterValue,
  onClearFilter,
}: {
  title: string
  align?: 'left' | 'right' | 'center'
  sortKeyValue: MechanizationSortKey
  activeSortKey: MechanizationSortKey
  sortDir: SortDir
  filterKey?: MechanizationFilterKey
  isFilterOpen: boolean
  options?: MechanizationFilterOption[]
  excludedValues?: string[]
  onToggleSort: (key: MechanizationSortKey) => void
  onToggleFilter: (key: MechanizationFilterKey) => void
  onToggleFilterValue: (key: MechanizationFilterKey, value: string) => void
  onClearFilter: (key: MechanizationFilterKey) => void
}) {
  const excludedSet = useMemo(() => new Set(excludedValues), [excludedValues])
  const activeFilterCount = excludedValues.length
  const isSorted = activeSortKey === sortKeyValue
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'

  return (
    <th className={`relative px-1 py-1.5 ${textAlign} font-semibold`}>
      <div className={`flex items-center gap-0.5 ${justify}`}>
        <button
          type="button"
          onClick={() => onToggleSort(sortKeyValue)}
          className="inline-flex min-w-0 items-center gap-0.5 rounded px-0.5 py-0.5 font-semibold text-text-secondary hover:bg-white hover:text-text-primary"
          title="Сортировка"
        >
          <span className="truncate">{title}</span>
          {isSorted && <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </button>
        {filterKey && (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              onToggleFilter(filterKey)
            }}
            className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded border px-0.5 ${
              activeFilterCount > 0
                ? 'border-sky-300 bg-sky-50 text-sky-700'
                : 'border-transparent text-text-muted hover:border-border hover:bg-white hover:text-text-primary'
            }`}
            aria-label={`Фильтр: ${title}`}
            title="Фильтр значений"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isFilterOpen ? 'rotate-90' : ''}`} />
            {activeFilterCount > 0 && <span className="text-[10px] font-semibold">{activeFilterCount}</span>}
          </button>
        )}
      </div>
      {filterKey && isFilterOpen && (
        <div
          className={`absolute ${align === 'right' ? 'right-2' : 'left-2'} top-full z-40 mt-1 w-64 rounded-md border border-border bg-white text-left normal-case tracking-normal shadow-xl`}
          onClick={event => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-text-primary">{title}</span>
            <button
              type="button"
              onClick={() => onToggleFilter(filterKey)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-bg-surface hover:text-text-primary"
              aria-label="Закрыть фильтр"
              title="Закрыть"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {options.map(option => {
              const checked = !excludedSet.has(option.value)
              return (
                <label key={option.value || '__empty__'} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleFilterValue(filterKey, option.value)}
                    className="h-3.5 w-3.5 rounded border-border text-sky-600 focus:ring-sky-500"
                  />
                  <span className={`min-w-0 flex-1 truncate ${checked ? 'text-text-primary' : 'text-text-muted line-through'}`} title={option.label}>{option.label}</span>
                  <span className="font-mono text-[10px] text-text-muted">{option.count}</span>
                </label>
              )
            })}
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <button
              type="button"
              onClick={() => onClearFilter(filterKey)}
              disabled={activeFilterCount === 0}
              className="text-xs font-medium text-sky-700 hover:text-sky-900 disabled:text-text-muted disabled:hover:text-text-muted"
            >
              Показать все
            </button>
            <span className="text-[10px] text-text-muted">{options.length}</span>
          </div>
        </div>
      )}
    </th>
  )
}

export default function MechanizationPage() {
  const { from, to } = usePeriod()
  const queryClient = useQueryClient()
  const [bucket, setBucket] = useState<'all'|'own'|'almaz'|'hired'>('all')
  const [editMode, setEditMode] = useState(false)
  const [sortKey, setSortKey] = useState<MechanizationSortKey>(() => storedMechanizationSortKey())
  const [sortDir, setSortDir] = useState<SortDir>(() => storedSortDir(MECHANIZATION_SORT_DIR_KEY))
  const [filters, setFilters] = useState<MechanizationFilters>(() => storedMechanizationFilters())
  const [openFilter, setOpenFilter] = useState<MechanizationFilterKey | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const [bulkMergeMessage, setBulkMergeMessage] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ count: number; units: UnitRow[] }>({
    queryKey: ['wip', 'mechanization', from, to],
    queryFn: () => fetchJson(`/api/wip/mechanization/units?from=${from}&to=${to}`),
  })

  const cleanupQuery = useQuery<CleanupCandidates, Error>({
    queryKey: ['wip', 'mechanization', 'cleanup', from, to],
    queryFn: () => fetchJson(`/api/wip/mechanization/cleanup-candidates?from=${from}&to=${to}`),
    enabled: editMode,
  })

  const cleanupMergeMutation = useMutation<CleanupMutationResponse, Error, { pair: CleanupPair; keep: 'master'|'report' }>({
    mutationFn: ({ pair, keep }) => fetchJson('/api/wip/mechanization/cleanup/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        master_equipment_id: pair.master.master_equipment_id,
        report_equipment_ids: pair.report.report_equipment_ids ?? [],
        keep,
      }),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization'] }),
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization', 'cleanup'] }),
      ])
    },
  })

  const cleanupDeleteMutation = useMutation<CleanupMutationResponse, Error, CleanupUnit>({
    mutationFn: unit => fetchJson('/api/wip/mechanization/cleanup/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_equipment_ids: unit.report_equipment_ids ?? [],
      }),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization'] }),
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization', 'cleanup'] }),
      ])
    },
  })

  const duplicateMergeMutation = useMutation<DuplicateMergeResponse, Error, void>({
    mutationFn: () => fetchJson('/api/wip/mechanization/cleanup/merge-duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date_from: from,
        date_to: to,
      }),
    }),
    onMutate: () => {
      setBulkMergeMessage(null)
    },
    onSuccess: async result => {
      setBulkMergeMessage(formatDuplicateMergeSummary(result))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization'] }),
        queryClient.invalidateQueries({ queryKey: ['wip', 'mechanization', 'cleanup'] }),
      ])
    },
  })

  function unitBucket(u: UnitRow): 'own'|'almaz'|'hired' {
    const owner = mechanizationOwnershipLabel(u).toLowerCase()
    if (owner === 'ждс') return 'own'
    if (owner.includes('алмаз')) return 'almaz'
    return 'hired'
  }
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(MECHANIZATION_SORT_KEY_KEY, sortKey)
    window.localStorage.setItem(MECHANIZATION_SORT_DIR_KEY, sortDir)
  }, [sortKey, sortDir])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(MECHANIZATION_FILTERS_KEY, JSON.stringify(filters))
  }, [filters])

  const filterOptions = useMemo(() => {
    const result = {} as Record<MechanizationFilterKey, MechanizationFilterOption[]>
    const rows = data?.units ?? []
    for (const key of MECHANIZATION_FILTER_KEYS) result[key] = buildMechanizationFilterOptions(rows, key)
    return result
  }, [data?.units])

  const activeFilterCount = useMemo(
    () => MECHANIZATION_FILTER_KEYS.reduce((sum, key) => sum + (filters[key]?.length ?? 0), 0),
    [filters],
  )

  const sortedUnits = useMemo(() => {
    const textValue = (value: string | null | undefined) => (value || '').toLocaleLowerCase('ru')
    const numericValue = (value: number | null | undefined) => value ?? -1
    const sectionValue = (value: string | null | undefined) => {
      const match = String(value || '').match(/(\d+)/)
      return match ? Number(match[1]) : 99
    }
    const cmp = (a: UnitRow, b: UnitRow): number => {
      if (sortKey === 'type') return textValue(a.equipment_type).localeCompare(textValue(b.equipment_type), 'ru')
      if (sortKey === 'brand') return textValue(a.brand_model).localeCompare(textValue(b.brand_model), 'ru')
      if (sortKey === 'plate') return textValue(a.plate_number).localeCompare(textValue(b.plate_number), 'ru')
      if (sortKey === 'unit') return textValue(a.unit_number).localeCompare(textValue(b.unit_number), 'ru')
      if (sortKey === 'ownership') return textValue(mechanizationOwnershipLabel(a)).localeCompare(textValue(mechanizationOwnershipLabel(b)), 'ru')
      if (sortKey === 'status') return textValue(`${mechanizationStatusLabel(a.status)} ${a.location}`).localeCompare(textValue(`${mechanizationStatusLabel(b.status)} ${b.location}`), 'ru')
      if (sortKey === 'shifts') return numericValue(a.shifts_worked) - numericValue(b.shifts_worked)
      if (sortKey === 'work_hours') return numericValue(a.work_hours_total) - numericValue(b.work_hours_total)
      if (sortKey === 'mileage') return numericValue(a.mileage_km_total) - numericValue(b.mileage_km_total)
      if (sortKey === 'engine_hours') return numericValue(a.engine_hours_total) - numericValue(b.engine_hours_total)
      if (sortKey === 'fuel') return numericValue(a.fuel_liters_total) - numericValue(b.fuel_liters_total)
      if (sortKey === 'percent') return numericValue(a.percent) - numericValue(b.percent)
      return sectionValue(a.last_section) - sectionValue(b.last_section)
    }
    const ownershipPriority = (unit: UnitRow) => unitBucket(unit) === 'own' ? 0 : unitBucket(unit) === 'almaz' ? 1 : 2
    const productionPriority = (unit: UnitRow) => (unit.fact_total || 0) > 0 ? 0 : 1
    const direction = sortDir === 'asc' ? 1 : -1
    return (data?.units ?? [])
      .filter(u => bucket === 'all' || unitBucket(u) === bucket)
      .filter(u => MECHANIZATION_FILTER_KEYS.every(key => {
        const excluded = filters[key]
        return !excluded?.includes(mechanizationFilterValue(u, key))
      }))
      .sort((a, b) => {
        const base = productionPriority(a) - productionPriority(b)
          || ownershipPriority(a) - ownershipPriority(b)
          || sectionValue(a.last_section) - sectionValue(b.last_section)
        const primary = base || cmp(a, b) * direction
        const fallback = textValue(a.equipment_type).localeCompare(textValue(b.equipment_type), 'ru')
          || textValue(a.plate_number).localeCompare(textValue(b.plate_number), 'ru')
          || textValue(a.unit_number).localeCompare(textValue(b.unit_number), 'ru')
        return primary || fallback
      })
  }, [bucket, data?.units, filters, sortDir, sortKey])

  const pendingMergeId = cleanupMergeMutation.isPending ? cleanupMergeMutation.variables?.pair.id ?? null : null
  const pendingDeleteKey = cleanupDeleteMutation.isPending && cleanupDeleteMutation.variables
    ? cleanupUnitKey(cleanupDeleteMutation.variables)
    : null
  const editError = cleanupMergeMutation.error ?? cleanupDeleteMutation.error ?? duplicateMergeMutation.error ?? cleanupQuery.error ?? null

  function defaultSortDir(key: MechanizationSortKey): SortDir {
    return key === 'shifts' || key === 'work_hours' || key === 'mileage' || key === 'engine_hours' || key === 'fuel' || key === 'percent' ? 'desc' : 'asc'
  }

  function toggleSort(key: MechanizationSortKey) {
    if (sortKey === key) setSortDir(value => (value === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(defaultSortDir(key)) }
  }

  function toggleFilter(key: MechanizationFilterKey) {
    setOpenFilter(current => (current === key ? null : key))
  }

  function toggleFilterValue(key: MechanizationFilterKey, value: string) {
    setFilters(prev => {
      const excluded = new Set(prev[key] ?? [])
      if (excluded.has(value)) excluded.delete(value)
      else excluded.add(value)
      const next: MechanizationFilters = { ...prev }
      const values = Array.from(excluded)
      if (values.length) next[key] = values
      else delete next[key]
      return next
    })
  }

  function clearFilter(key: MechanizationFilterKey) {
    setFilters(prev => {
      const next: MechanizationFilters = { ...prev }
      delete next[key]
      return next
    })
  }

  function clearAllFilters() {
    setFilters({})
  }

  function toggleExpanded(key: string) {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function mergeDuplicates() {
    const confirmed = window.confirm('Объединить все дубли по госномеру за выбранный период? Факты производительности будут перенесены на остающуюся строку техники.')
    if (confirmed) duplicateMergeMutation.mutate()
  }

  return (
    <div className="flex min-h-full flex-col bg-bg-primary">
      <PeriodBar />

      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-white px-4 py-3 sm:px-6">
        <Truck className="h-5 w-5 text-accent-red" />
        <h1 className="mr-auto text-xl font-heading font-bold text-text-primary">
          Производительность механизации
        </h1>
        <button
          type="button"
          onClick={() => setEditMode(value => !value)}
          className={`no-print inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold ${
            editMode
              ? 'bg-slate-800 text-white hover:bg-slate-700'
              : 'border border-gray-200 bg-white text-gray-700 hover:text-text-primary'
          }`}
        >
          {editMode ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          {editMode ? 'Готово' : 'Редактировать'}
        </button>
        <div className="no-print flex items-center gap-1 text-xs">
          {(['all','own','almaz','hired'] as const).map(o => (
            <button key={o}
              onClick={() => setBucket(o)}
              className={`rounded-md px-2.5 py-1 ${
                bucket === o
                  ? 'bg-slate-800 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:text-text-primary'
              }`}>
              {o === 'all' ? 'все' : o === 'own' ? 'ЖДС' : o === 'almaz' ? 'АЛМАЗ' : 'наёмные'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        {editMode && (
          <>
            {editError && !cleanupQuery.error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-accent-red">
                {editError.message}
              </div>
            )}
            <CleanupPanel
              data={cleanupQuery.data}
              isLoading={cleanupQuery.isLoading}
              error={cleanupQuery.error ?? null}
              pendingMergeId={pendingMergeId}
              pendingDeleteKey={pendingDeleteKey}
              isBulkMerging={duplicateMergeMutation.isPending}
              bulkMergeMessage={bulkMergeMessage}
              onMerge={(pair, keep) => cleanupMergeMutation.mutate({ pair, keep })}
              onDelete={unit => cleanupDeleteMutation.mutate(unit)}
              onMergeDuplicates={mergeDuplicates}
            />
          </>
        )}

        <div className="space-y-4">
          <EquipmentBlock from={from} to={to} view="cards" bucket={bucket} />
          <EquipmentFuelBlock from={from} to={to} bucket={bucket} />
        </div>

        {!isLoading && data && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-text-muted">
            <span>Показано {sortedUnits.length} из {data.units.length}</span>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="inline-flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
                Сбросить фильтры
              </button>
            )}
          </div>
        )}

        <section className="overflow-hidden rounded-xl border border-border bg-white shadow-sm">
          {isLoading || !data ? (
            <div className="h-40 animate-pulse bg-bg-surface" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1140px] table-fixed text-[11px]">
                <colgroup>
                  <col className="w-[12%]" />
                  <col className="w-[15%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[10%]" />
                  <col className="w-[5%]" />
                  <col className="w-[12%]" />
                  <col className="w-[5%]" />
                  <col className="w-[6%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                  <col className="w-[5%]" />
                </colgroup>
                <thead className="bg-bg-surface">
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-muted">
                    <MechanizationColumnHeader title="Тип" sortKeyValue="type" filterKey="type" isFilterOpen={openFilter === 'type'} options={filterOptions.type} excludedValues={filters.type ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Марка" sortKeyValue="brand" filterKey="brand" isFilterOpen={openFilter === 'brand'} options={filterOptions.brand} excludedValues={filters.brand ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Гос.номер" sortKeyValue="plate" filterKey="plate" isFilterOpen={openFilter === 'plate'} options={filterOptions.plate} excludedValues={filters.plate ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Борт. №" sortKeyValue="unit" filterKey="unit" isFilterOpen={openFilter === 'unit'} options={filterOptions.unit} excludedValues={filters.unit ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Собственность" sortKeyValue="ownership" filterKey="ownership" isFilterOpen={openFilter === 'ownership'} options={filterOptions.ownership} excludedValues={filters.ownership ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Уч." align="center" sortKeyValue="section" filterKey="section" isFilterOpen={openFilter === 'section'} options={filterOptions.section} excludedValues={filters.section ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Статус" sortKeyValue="status" filterKey="status" isFilterOpen={openFilter === 'status'} options={filterOptions.status} excludedValues={filters.status ?? []} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Смен" align="right" sortKeyValue="shifts" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Время" align="right" sortKeyValue="work_hours" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Пробег" align="right" sortKeyValue="mileage" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Моточасы" align="right" sortKeyValue="engine_hours" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="Расход" align="right" sortKeyValue="fuel" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                    <MechanizationColumnHeader title="%" align="right" sortKeyValue="percent" isFilterOpen={false} activeSortKey={sortKey}
                      sortDir={sortDir}
                      onToggleSort={toggleSort}
                      onToggleFilter={toggleFilter}
                      onToggleFilterValue={toggleFilterValue}
                      onClearFilter={clearFilter} />
                  </tr>
                </thead>
                <tbody>
                  {sortedUnits.length === 0 && (
                    <tr><td colSpan={13} className="py-8 text-center text-text-muted">Нет техники за выбранный период.</td></tr>
                  )}
                  {sortedUnits.map(u => {
                    const key = unitRowKey(u)
                    const hasDetails = u.details.length > 0
                    const isExpanded = expandedKeys.has(key)
                    const detailRows = [...u.details].sort((a, b) => (
                      b.date.localeCompare(a.date) || b.shift.localeCompare(a.shift) || a.work.localeCompare(b.work, 'ru')
                    ))
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => { if (hasDetails) toggleExpanded(key) }}
                          onKeyDown={event => {
                            if (!hasDetails) return
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              toggleExpanded(key)
                            }
                          }}
                          role={hasDetails ? 'button' : undefined}
                          tabIndex={hasDetails ? 0 : undefined}
                          className={`border-b border-border/60 hover:bg-bg-surface/40 ${hasDetails ? 'cursor-pointer' : ''}`}
                        >
                          <td className="py-1.5 pl-2 pr-1 font-semibold text-text-primary">
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                              {hasDetails ? (
                                isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                              ) : <span className="h-3.5 w-3.5 shrink-0" />}
                              <span className="truncate" title={u.equipment_type}>{u.equipment_type}</span>
                            </span>
                          </td>
                          <td className="px-1.5 py-1.5 text-text-secondary" title={u.brand_model}>
                            <span className="block truncate">{u.brand_model}</span>
                          </td>
                          <td className="whitespace-nowrap px-1.5 py-1.5 font-mono text-text-secondary">{u.plate_number}</td>
                          <td className="whitespace-nowrap px-1.5 py-1.5 font-mono text-text-secondary">{u.unit_number}</td>
                          <td className="px-1.5 py-1.5 text-[10.5px] text-text-secondary">
                            <span className="block truncate" title={mechanizationOwnershipLabel(u)}>{mechanizationOwnershipLabel(u)}</span>
                            {u.contractor !== '—' && mechanizationOwnershipLabel(u) !== u.contractor && <span className="block truncate text-[9.5px] text-text-muted" title={u.contractor}>{u.contractor}</span>}
                          </td>
                          <td className="px-1 py-1.5 text-center font-mono text-text-primary">
                            {u.last_section?.replace('UCH_','№') ?? '—'}
                          </td>
                          <td className="px-1.5 py-1.5 text-[10.5px] text-text-secondary">
                            <span className="block truncate font-semibold" title={mechanizationStatusLabel(u.status)}>{mechanizationStatusLabel(u.status)}</span>
                            {(u.location || u.source_date) && (
                              <span className="block truncate text-[9.5px] text-text-muted" title={`${u.location || u.source_name || '—'}${u.source_date ? ` · ${u.source_date}` : ''}`}>
                                {u.location || u.source_name || '—'}{u.source_date ? ` · ${u.source_date}` : ''}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-1 py-1.5 text-right font-mono">{u.shifts_worked}</td>
                          <td className="whitespace-nowrap px-1 py-1.5 text-right font-mono">{Number(u.work_hours_total || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч</td>
                          <td className="whitespace-nowrap px-1 py-1.5 text-right font-mono">{fmt(Number(u.mileage_km_total || 0))} км</td>
                          <td className="whitespace-nowrap px-1 py-1.5 text-right font-mono">{Number(u.engine_hours_total || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</td>
                          <td className="whitespace-nowrap px-1 py-1.5 text-right font-mono">{fmt(Number(u.fuel_liters_total || 0))} л</td>
                          <td className={`whitespace-nowrap py-1.5 pl-1 pr-2 text-right font-mono font-semibold ${pctColor(u.percent)}`}>
                            {u.percent == null ? '—' : `${Math.round(u.percent)}%`}
                          </td>
                        </tr>
                        {isExpanded && hasDetails && (
                          <tr className="border-b border-border/60 bg-bg-surface/40">
                            <td colSpan={13} className="px-4 py-3">
                              <div className="overflow-hidden rounded-md border border-border bg-white">
                                <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                                  Работы, влияющие на производительность
                                </div>
                                <table className="w-full text-[11px]">
                                  <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                                    <tr>
                                      <th className="px-3 py-2 text-left font-semibold">Дата</th>
                                      <th className="px-2 py-2 text-left font-semibold">Смена</th>
                                      <th className="px-2 py-2 text-left font-semibold">Уч.</th>
                                      <th className="px-2 py-2 text-left font-semibold">Работа</th>
                                      <th className="px-2 py-2 text-right font-semibold">Время</th>
                                      <th className="px-2 py-2 text-right font-semibold">Факт</th>
                                      <th className="px-2 py-2 text-right font-semibold">Норма</th>
                                      <th className="px-3 py-2 text-right font-semibold">%</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detailRows.map((detail, index) => (
                                      <tr key={`${detail.date}|${detail.shift}|${detail.section}|${detail.work}|${index}`} className="border-t border-border/60">
                                        <td className="px-3 py-2 font-mono text-text-secondary">{detail.date}</td>
                                        <td className="px-2 py-2 text-text-secondary">{detail.shift === 'night' ? 'Ночь' : 'День'}</td>
                                        <td className="px-2 py-2 font-mono text-text-secondary">{detail.section?.replace('UCH_','№') || '—'}</td>
                                        <td className="px-2 py-2 text-text-primary">{detail.work}</td>
                                        <td className="px-2 py-2 text-right font-mono text-text-secondary">{Number(detail.work_hours ?? 11).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч</td>
                                        <td className="px-2 py-2 text-right font-mono text-text-primary">{fmt(detail.fact)}</td>
                                        <td className="px-2 py-2 text-right font-mono text-text-muted">
                                          <div>{fmt(detail.norm)}</div>
                                          {detail.reference_norm != null && Number(detail.reference_norm) !== Number(detail.norm) && <div className="text-[9px]">из {fmt(detail.reference_norm)} / 11 ч</div>}
                                        </td>
                                        <td className={`px-3 py-2 text-right font-mono font-semibold ${pctColor(detail.percent)}`}>
                                          {detail.percent == null ? '—' : `${Math.round(detail.percent)}%`}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="text-[11px] text-text-muted">
          Методика: для каждой работы или перевозки ожидаемая норма равна справочной сменной норме × время работы / 11 часов; пустое время считается равным 11 часам.
          Для самосвалов песок и крупный песок используют нормы по участкам и направлению, прочая перевозка — 166 м³/смена.
          Экскаваторы, бульдозеры, автогрейдеры и катки используют нормы по справочнику.
        </div>
      </div>
    </div>
  )
}
