/**
 * WIP Analytics FINAL — гибрид v2 и старой аналитики по handoff dashik6.
 *
 * Содержит:
 *   - 7 карточек категорий возки (SAND, PRS, VYEMKA, VYEMKA_OH, SCHEBEN, SHPS, ALL)
 *   - График 2: возка с карьеров (stacked bar, Д+Н)
 *   - Таблица «Основные объёмы» по участкам
 *
 * Данные:
 *   /api/wip/analytics/summary       — числа по категориям (sand/soil/shps/peat/transport)
 *   /api/wip/analytics/quarry-donut  — доли карьеров (для мини-доната в карточке)
 *   /api/dashboard/*                 — для графика возки и свай (существующие)
 *
 * ВАЖНО: API-контракт summary сейчас возвращает 4 категории (sand/soil/shps/peat).
 * 7 UI-категорий — из handoff. Мапинг:
 *   SAND       → api.sand
 *   PRS        → api.soil (снятие ПРС — частный случай грунта; разделение нужно в БД)
 *   VYEMKA     → api.soil (все выемки — объединены с PRS, пока нет детализации)
 *   VYEMKA_OH  → отдельная категория учета, если правило заведено в БД
 *   SCHEBEN    → отдельная категория учета, если материал/правило заведены в БД
 *   SHPS       → api.shps
 *   ALL        → api.transport
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { TrendingUp, Filter, Truck, BarChart3, Printer, X, Plus, Trash2 } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RCTooltip, ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { PeriodBar } from './PeriodBar'
import { usePeriod } from './usePeriod'
import { sectionCodeToUILabel, sectionCodeToUILabelSafe } from '../lib/sections'
import { EquipmentBlock } from './blocks/EquipmentBlock'
import { SparkHeatBlock } from './blocks/SparkHeatBlock'
import { useAuth } from '../auth'
import { exportDashboardPdf } from '../utils/pdfExport'

type Bucket = 'own' | 'almaz' | 'other_hired'
type ApiCatKey = 'SAND' | 'PRS' | 'VYEMKA' | 'VYEMKA_OH' | 'PEAT_VAD' | 'PEAT_OH' | 'SCHEBEN' | 'SHPS' | 'transport'
type MainVolumeObjectGroupKey = 'main_track' | 'temp_road' | 'other'
type MainVolumeSplitKey = 'SAND' | 'VYEMKA' | 'PEAT'

interface ApiCategory {
  fact: number
  plan: number
  trips: number
  by_section: Record<string, number>
  by_shift: { day: number; night: number }
  by_contractor: Record<Bucket, number>
  by_object_group?: Record<MainVolumeObjectGroupKey, number>
  by_section_object_group?: Record<string, Record<MainVolumeObjectGroupKey, number>>
}
interface MainVolumeObjectGroupSummary {
  by_object_group?: Record<MainVolumeObjectGroupKey, number>
  by_section_object_group?: Record<string, Record<MainVolumeObjectGroupKey, number>>
}
interface SummaryResponse {
  from: string; to: string
  categories: Record<ApiCatKey, ApiCategory>
  object_group_summary?: Partial<Record<MainVolumeSplitKey, MainVolumeObjectGroupSummary>>
  sections: string[]
}

interface TransportSourceRow {
  quarry_id: string
  quarry_name: string
  volume: number
  trips?: number
  share?: number
  material?: string
  by_shift?: { day?: number; night?: number }
  by_direction?: Record<string, number>
  by_contractor?: { own?: number; almaz?: number; hired?: number; other_hired?: number }
  by_section?: Record<string, number>
}

interface WorkFilterOption {
  name?: string
  code?: string
  object_type_code?: string
  object_type_name?: string
  section_codes?: string[]
  section_names?: string[]
  label?: string
  units?: string[]
  unit?: string
  fact_count: number
}
interface WorkFilterOptions {
  tags: WorkFilterOption[]
  object_types: WorkFilterOption[]
  objects: WorkFilterOption[]
  units: WorkFilterOption[]
}
interface WorkTagSummaryRow {
  tag: string
  unit: string
  object_type_code: string | null
  object_type_name: string
  object_code: string | null
  object_name: string
  section_code: string
  fact_count: number
  volume: number
}
interface WorkTagSummary {
  from: string
  to: string
  total: number
  plan_total?: number
  rows: WorkTagSummaryRow[]
  chart: { tag: string; unit: string; label: string; volume: number }[]
  by_section?: { tag: string; unit: string; section_code: string; volume: number }[]
  plan_by_section?: { tag: string; unit: string; section_code: string; planned_volume: number }[]
  timeseries?: { date: string; volume: number }[]
  heatmap?: { date: string; section_code: string; volume: number }[]
}
interface WorkFactRow {
  id: string
  date: string | null
  tag: string
  work_type_code: string | null
  work_type_name: string
  unit: string
  volume: number
  section_code: string
  object_code: string | null
  object_name: string
  object_type_code: string | null
  object_type_name: string
  shift: string | null
  contractor_name: string
  comment: string
}

// UI-категории «Показатели по основным работам».
// Факт основных работ считается из daily_work_items по выбранным тегам и объектам.
type UICatKey = 'SAND' | 'PRS' | 'VYEMKA' | 'VYEMKA_OH' | 'PEAT_VAD' | 'PEAT_OH' | 'SCHEBEN' | 'SHPS' | 'ALL'
type WorkCardScope = 'all' | `type:${string}` | `object:${string}` | `group:${MainVolumeObjectGroupKey}`
interface WorkMetricCardConfig {
  id: string
  label: string
  tags: string[]
  scopes: WorkCardScope[]
  units: string[]
}
interface WorkCardConfigResponse {
  cards: WorkMetricCardConfig[] | null
  updated_by?: string | null
  updated_at?: string | null
}

const DEFAULT_WORK_CARDS: WorkMetricCardConfig[] = [
  { id: 'sand-main', label: 'Отсыпка песка, м³', tags: ['Песок (Насыпь)'], scopes: [], units: ['м3'] },
  { id: 'prs', label: 'Снятие ПРС, м³', tags: ['ПРС'], scopes: [], units: ['м3'] },
  { id: 'vyemka-vad', label: 'Выемка (притрассовые), м³', tags: ['Выемка'], scopes: ['type:TEMP_ROAD'], units: ['м3'] },
  { id: 'vyemka-main', label: 'Выемка основного хода, м³', tags: ['Выемка'], scopes: ['type:MAIN_TRACK'], units: ['м3'] },
  { id: 'vyemka-other', label: 'Выемка иные объекты, м³', tags: ['Выемка'], scopes: ['group:other'], units: ['м3'] },
  { id: 'peat-vad', label: 'Выторфовка ВАД, м³', tags: ['Выторфовка'], scopes: ['type:TEMP_ROAD'], units: ['м3'] },
  { id: 'peat-main', label: 'Выторфовка ОХ, м³', tags: ['Выторфовка'], scopes: ['type:MAIN_TRACK'], units: ['м3'] },
  { id: 'peat-other', label: 'Выторфовка иные объекты, м³', tags: ['Выторфовка'], scopes: ['group:other'], units: ['м3'] },
  { id: 'scheben', label: 'Щебень, м³', tags: ['Щебень'], scopes: [], units: ['м3'] },
  { id: 'shps', label: 'Отсыпка ЩПС / ЩПГС, м³', tags: ['ЩПС'], scopes: [], units: ['м3'] },
  { id: 'all-works', label: 'Работы (всего)', tags: [], scopes: [], units: [] },
]

const BUCKET_COLOR: Record<Bucket, string> = {
  own: '#1a1a1a', almaz: '#dc2626', other_hired: '#7f1d1d',
}
const BUCKET_LABEL: Record<Bucket, string> = {
  own: 'ЖДС', almaz: 'АЛМАЗ', other_hired: 'Наёмн.',
}

const MAIN_VOLUME_OBJECT_GROUPS: { key: MainVolumeObjectGroupKey; label: string; hint: string }[] = [
  { key: 'main_track', label: 'ОХ', hint: 'Основной ход' },
  { key: 'temp_road', label: 'ВПД', hint: 'Временные притрассовые дороги' },
  { key: 'other', label: 'Иные', hint: 'ИССО, техпроезды и прочие объекты' },
]

function fmt(n: number): string { return Math.round(n).toLocaleString('ru-RU') }

function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`
  if (abs >= 1_000) return `${(n / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс`
  return fmt(n)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({})) as { detail?: string; message?: string }
  if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`)
  return data as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Неизвестная ошибка')
}

function AnalyticsError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
      {message}
    </div>
  )
}

function loadWorkCards(): WorkMetricCardConfig[] {
  return DEFAULT_WORK_CARDS.map(card => ({ ...card, tags: [...card.tags], scopes: [...card.scopes], units: [...card.units] }))
}

function normalizeWorkCards(input: unknown): WorkMetricCardConfig[] {
  if (!Array.isArray(input) || !input.length) return loadWorkCards()
  const cards = input
    .filter(item => item && typeof item === 'object')
    .map(item => {
      const raw = item as Record<string, unknown>
      const tags = Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : []
      const scopes = Array.isArray(raw.scopes)
        ? raw.scopes.map(String).filter(scope => scope.startsWith('type:') || scope.startsWith('object:') || scope.startsWith('group:')) as WorkCardScope[]
        : []
      const units = Array.isArray(raw.units)
        ? raw.units.map(String).filter(Boolean)
        : (typeof raw.unit === 'string' && raw.unit !== 'all' ? [raw.unit] : [])
      const id = String(raw.id || `card-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      const normalizedScopes = id === 'sand-main' && tags.includes('Песок (Насыпь)') && scopes.length === 1 && scopes[0] === 'type:MAIN_TRACK'
        ? []
        : scopes
      return {
        id,
        label: String(raw.label || 'Карточка работ'),
        tags,
        scopes: normalizedScopes,
        units,
      }
    })
    .filter(card => card.id && card.label)
  return cards.length ? cards : loadWorkCards()
}

function splitWorkScopes(scopes: WorkCardScope[]): { objectTypes: string[]; objects: string[]; objectGroups: MainVolumeObjectGroupKey[] } {
  const objectTypes: string[] = []
  const objects: string[] = []
  const objectGroups: MainVolumeObjectGroupKey[] = []
  for (const scope of scopes) {
    if (scope.startsWith('type:')) objectTypes.push(scope.slice(5))
    if (scope.startsWith('object:')) objects.push(scope.slice(7))
    if (scope.startsWith('group:')) objectGroups.push(scope.slice(6) as MainVolumeObjectGroupKey)
  }
  return { objectTypes, objects, objectGroups }
}

function summarizeLabels(labels: string[], allLabel: string): string {
  if (!labels.length) return allLabel
  if (labels.length <= 2) return labels.join(', ')
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`
}

function workTagsLabel(tags: string[]): string {
  return summarizeLabels(tags, 'Все теги')
}

function objectGroupLabel(group: MainVolumeObjectGroupKey): string {
  return MAIN_VOLUME_OBJECT_GROUPS.find(item => item.key === group)?.label || group
}

function workScopeLabel(scopes: WorkCardScope[], options?: WorkFilterOptions): string {
  if (!scopes.length) return 'Все объекты'
  const labels = scopes.map(scope => {
    if (scope === 'all') return 'Все объекты'
    if (scope.startsWith('type:')) {
      const code = scope.slice(5)
      const found = options?.object_types?.find(item => item.code === code)
      return found?.name ? `${found.name}` : code
    }
    if (scope.startsWith('group:')) return objectGroupLabel(scope.slice(6) as MainVolumeObjectGroupKey)
    const code = scope.slice(7)
    const found = options?.objects?.find(item => item.code === code)
    return found?.name ? `${found.name}` : code
  })
  return summarizeLabels(labels, 'Все объекты')
}

function unitFilterLabel(units: string[]): string {
  return summarizeLabels(units, 'Все ед. изм.')
}

function objectSectionHint(object: WorkFilterOption) {
  const codes = Array.from(new Set((object.section_codes || []).filter(Boolean)))
  if (codes.length) {
    const values = codes.map(code => sectionCodeToUILabelSafe(code).replace('Участок №', '№'))
    return `${codes.length > 1 ? 'Участки' : 'Участок'}: ${values.join(', ')}`
  }
  const names = Array.from(new Set((object.section_names || []).filter(Boolean)))
  if (names.length) return `${names.length > 1 ? 'Участки' : 'Участок'}: ${names.join(', ')}`
  return 'Участок не указан'
}

function mergeSections(bySection: Record<string, number>): { label: string; code: string; value: number }[] {
  const out: { label: string; code: string; value: number }[] = []
  const codes = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']
  for (const c of codes) {
    const v = bySection[c] || 0
    out.push({ label: sectionCodeToUILabel(c).replace('Участок №', '№'), code: c, value: v })
  }
  return out
}

export default function WipAnalyticsFinal() {
  const { from, to } = usePeriod()
  const { isUserEquivalent } = useAuth()
  const qc = useQueryClient()
  const canManageCards = isUserEquivalent
  const [secFilter, setSecFilter] = useState<string>('all')
  const [exportingPdf, setExportingPdf] = useState(false)
  const [workCards, setWorkCards] = useState<WorkMetricCardConfig[]>(loadWorkCards)
  const [cardsLoaded, setCardsLoaded] = useState(false)

  const { data: summary, isLoading: loadingS, isError: summaryIsError, error: summaryError } = useQuery<SummaryResponse>({
    queryKey: ['wip', 'analytics-works', from, to, secFilter],
    queryFn: () => {
      const url = `/api/wip/analytics/works-summary?from=${from}&to=${to}` +
                  (secFilter !== 'all' ? `&section=${secFilter}` : '')
      return fetchJson(url)
    },
  })
  const { data: workOptions, isLoading: loadingWorkOptions, isError: workOptionsIsError, error: workOptionsError } = useQuery<WorkFilterOptions>({
    queryKey: ['wip', 'analytics-work-filter-options', from, to, secFilter],
    queryFn: () => {
      const params = new URLSearchParams({ from, to })
      if (secFilter !== 'all') params.set('section', secFilter)
      return fetchJson(`/api/wip/analytics/work-filter-options?${params}`)
    },
  })
  const { data: savedWorkCards, isFetched: savedWorkCardsFetched } = useQuery<WorkCardConfigResponse>({
    queryKey: ['wip', 'analytics-work-card-config'],
    queryFn: () => fetchJson('/api/wip/analytics/work-card-config'),
  })
  const saveWorkCardsMutation = useMutation<WorkCardConfigResponse, Error>({
    mutationFn: () => {
      return fetchJson('/api/wip/analytics/work-card-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: workCards }),
      })
    },
    onSuccess: data => {
      qc.setQueryData(['wip', 'analytics-work-card-config'], data)
      setCardsLoaded(true)
    },
  })

  useEffect(() => {
    if (!savedWorkCardsFetched || cardsLoaded) return
    if (savedWorkCards?.cards?.length) setWorkCards(normalizeWorkCards(savedWorkCards.cards))
    setCardsLoaded(true)
  }, [cardsLoaded, savedWorkCards, savedWorkCardsFetched])

  function updateWorkCard(id: string, patch: Partial<WorkMetricCardConfig>) {
    setWorkCards(prev => prev.map(card => card.id === id ? { ...card, ...patch } : card))
  }

  function addWorkCard() {
    const firstTag = workOptions?.tags?.[0]?.name || ''
    setWorkCards(prev => [
      ...prev,
      {
        id: `card-${Date.now()}`,
        label: 'Новая карточка работ',
        tags: firstTag ? [firstTag] : [],
        scopes: [],
        units: [],
      },
    ])
  }

  function removeWorkCard(id: string) {
    setWorkCards(prev => prev.filter(card => card.id !== id))
  }

  return (
    <div className="flex flex-col min-h-full bg-bg-primary">
      <PeriodBar />

      <div className="px-4 sm:px-6 py-3 flex items-center gap-3 border-b border-border bg-white">
        <TrendingUp className="w-5 h-5 text-accent-red" />
        <h1 className="text-xl font-heading font-bold text-text-primary mr-auto">
          Аналитика
        </h1>
        <Filter className="w-4 h-4 text-text-muted no-print" />
        <select value={secFilter} onChange={e => setSecFilter(e.target.value)}
          className="no-print px-3 py-1.5 text-xs border border-border rounded-md bg-white">
          <option value="all">Все участки</option>
          <option value="UCH_1">Участок №1</option>
          <option value="UCH_2">Участок №2</option>
          <option value="UCH_3">Участок №3</option>
          <option value="UCH_4">Участок №4</option>
          <option value="UCH_5">Участок №5</option>
          <option value="UCH_6">Участок №6</option>
          <option value="UCH_7">Участок №7</option>
          <option value="UCH_8">Участок №8</option>
        </select>
        <button
          type="button"
          disabled={exportingPdf}
          onClick={async () => {
            setExportingPdf(true)
            try {
              await exportDashboardPdf({
                selector: '#analytics-pdf-content',
                title: 'Аналитика',
                subtitle: `${from} — ${to}`,
                filename: `Аналитика ${from}-${to}`,
              })
            } finally {
              setExportingPdf(false)
            }
          }}
          className="no-print flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-red text-white hover:bg-accent-burg transition disabled:cursor-wait disabled:opacity-60"
          title="Скачать PDF отчёт"
        >
          <Printer className="w-3.5 h-3.5" /> {exportingPdf ? 'PDF...' : 'PDF'}
        </button>
      </div>

      <div id="analytics-pdf-content" className="p-4 sm:p-6 pb-24 lg:pb-6 space-y-6">
        {/* Заголовок блока «Показатели по основным работам» */}
        <div className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-5 h-5 text-accent-red" />
            <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading">Показатели по основным работам</h2>
            <span className="ml-auto text-xs font-mono text-text-muted">
              факт по суточным отчётам · за период
            </span>
          </div>

          <div className="space-y-4">
            {loadingWorkOptions ? (
              [...Array(4)].map((_, i) =>
                <div key={i} className="h-40 bg-bg-surface border border-border rounded-xl animate-pulse" />)
            ) : (
              <>
                {workOptionsIsError && (
                  <AnalyticsError message={`Не удалось загрузить варианты фильтров: ${errorMessage(workOptionsError)}`} />
                )}
                {canManageCards && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {saveWorkCardsMutation.isError && (
                    <span className="mr-auto text-xs text-red-600">{saveWorkCardsMutation.error.message}</span>
                  )}
                  {saveWorkCardsMutation.isSuccess && (
                    <span className="mr-auto text-xs text-emerald-700">Конфигурация сохранена для всех</span>
                  )}
                  <button
                    type="button"
                    onClick={() => saveWorkCardsMutation.mutate()}
                    disabled={saveWorkCardsMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md border border-accent-red bg-white px-3 py-1.5 text-xs font-semibold text-accent-red hover:bg-red-50 disabled:opacity-60"
                  >
                    {saveWorkCardsMutation.isPending ? 'Сохранение...' : 'Сохранить конфигурацию карточек'}
                  </button>
                  <button
                    type="button"
                    onClick={addWorkCard}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-surface"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Добавить карточку
                  </button>
                </div>
                )}
                {workCards.map((card, i) => (
                  <motion.div key={card.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.03 }}>
                  <WorkMetricCard
                    card={card}
                    options={workOptions}
                    from={from}
                    to={to}
                    secFilter={secFilter}
                    onChange={patch => updateWorkCard(card.id, patch)}
                    onRemove={() => removeWorkCard(card.id)}
                    canRemove={workCards.length > 1}
                    canManageCards={canManageCards}
                  />
                </motion.div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Возка с карьеров (только BORROW_PIT) */}
        <QuarryBarChart from={from} to={to} secFilter={secFilter} />

        {/* Таблица «Основные объёмы» — табличное выражение показателей по работам */}
        {summaryIsError ? (
          <AnalyticsError message={`Не удалось загрузить основные объёмы: ${errorMessage(summaryError)}`} />
        ) : (
          <MainVolumesTable summary={loadingS ? undefined : summary} />
        )}

        {/* Производительность техники (перенесена с Обзора) */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <EquipmentBlock from={from} to={to} view="cards" />
        </motion.div>

        {/* Состояние накопителей по участкам */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <StockpileBalancesBlock to={to} />
        </motion.div>
      </div>
    </div>
  )
}

function WorkMetricCard({
  card,
  options,
  from,
  to,
  secFilter,
  onChange,
  onRemove,
  canRemove,
  canManageCards,
}: {
  card: WorkMetricCardConfig
  options?: WorkFilterOptions
  from: string
  to: string
  secFilter: string
  onChange: (patch: Partial<WorkMetricCardConfig>) => void
  onRemove: () => void
  canRemove: boolean
  canManageCards: boolean
}) {
  const [detailSection, setDetailSection] = useState<string | null>(null)
  const [openFilter, setOpenFilter] = useState<'tags' | 'objects' | 'units' | null>(null)
  const scope = splitWorkScopes(card.scopes)
  const params = new URLSearchParams({ from, to })
  if (secFilter !== 'all') params.set('section', secFilter)
  if (card.tags.length) params.set('tags', card.tags.join(','))
  if (scope.objectTypes.length) params.set('object_types', scope.objectTypes.join(','))
  if (scope.objectGroups.length) params.set('object_group', scope.objectGroups.join(','))
  if (scope.objects.length) params.set('objects', scope.objects.join(','))
  if (card.units.length) params.set('units', card.units.join(','))

  const { data, isLoading, isError, error } = useQuery<WorkTagSummary>({
    queryKey: ['wip', 'analytics-work-card', card.id, from, to, secFilter, card.tags.join('|'), card.scopes.join('|'), card.units.join('|')],
    queryFn: () => fetchJson(`/api/wip/analytics/work-tag-summary?${params}`),
  })

  const unitOptions = options?.units?.map(item => item.unit || '').filter(Boolean) || []
  const tagOptions = (options?.tags || [])
    .map(tag => ({ value: tag.name || '', label: tag.name || '', meta: `${fmt(tag.fact_count || 0)} строк` }))
    .filter(item => item.value)
  const objectOptions = [
    ...(options?.object_types || [])
      .filter(type => Boolean(type.code))
      .map(type => ({
        value: `type:${type.code}`,
        label: type.name || type.code || '',
        meta: 'тип объекта',
      }))
      .filter(item => item.value && item.label),
    ...(options?.objects || [])
      .filter(object => Boolean(object.code))
      .map(object => ({
        value: `object:${object.code}`,
        label: object.name || object.code || '',
        meta: objectSectionHint(object),
      }))
      .filter(item => item.value && item.label),
  ]
  const unitFilterOptions = unitOptions.map(unit => ({ value: unit, label: unit, meta: 'ед. изм.' }))
  const sectionTotals = new Map<string, number>()
  for (const row of data?.rows || []) {
    const code = row.section_code || '—'
    sectionTotals.set(code, (sectionTotals.get(code) || 0) + Number(row.volume || 0))
  }
  const sections = Array.from(sectionTotals.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([code, value]) => ({ code, label: sectionCodeToUILabelSafe(code).replace('Участок №', '№'), value }))
  const shownSections = sections.length ? sections : [{ code: '—', label: '—', value: 0 }]
  const detailRows = detailSection ? (data?.rows || []).filter(row => row.section_code === detailSection) : []
  const detailTotal = detailRows.reduce((sum, row) => sum + Number(row.volume || 0), 0)
  const legacyCategory = legacyCategoryForWorkCard(card)

  return (
    <section className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
      <div className="flex flex-wrap items-start gap-3 mb-4">
        <div className="min-w-[220px] flex-1">
          {canManageCards ? (
            <input
              value={card.label}
              onChange={e => onChange({ label: e.target.value })}
              className="w-full border-0 bg-transparent p-0 text-base font-heading font-semibold text-gray-800 focus:outline-none focus:ring-0"
            />
          ) : (
            <h3 className="text-base font-heading font-semibold text-gray-800">{card.label}</h3>
          )}
          <div className="mt-1 text-[11px] text-text-muted">
            {workTagsLabel(card.tags)} · {workScopeLabel(card.scopes, options)}
          </div>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          факт за период
        </span>
        {canManageCards && canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red"
            title="Удалить карточку"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {isError && (
        <div className="mb-4">
          <AnalyticsError message={`Не удалось загрузить карточку: ${errorMessage(error)}`} />
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-3 space-y-4">
          <div>
            <div className="font-mono text-5xl font-bold text-text-primary leading-none">
              {isLoading ? '...' : fmt(data?.total || 0)}
            </div>
            <div className="text-xs text-text-muted mt-1">факт за период</div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
            По участкам
          </div>
          <SectionsBarChart sections={shownSections} onSectionClick={setDetailSection} />
        </div>

        <div className="col-span-12 lg:col-span-4">
          {legacyCategory ? (
            <SparkHeatBlock from={from} to={to} category={legacyCategory} />
          ) : (
            <WorkPulseHeatBlock data={data} isLoading={isLoading} />
          )}
        </div>
      </div>

      <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <PopoverFilterButton
          title="Тип работ"
          label={workTagsLabel(card.tags)}
          isOpen={openFilter === 'tags'}
          allLabel="Все теги"
          values={card.tags}
          options={tagOptions}
          onToggle={() => setOpenFilter(openFilter === 'tags' ? null : 'tags')}
          onChange={tags => onChange({ tags })}
          onClose={() => setOpenFilter(null)}
        />
        <PopoverFilterButton
          title="Объект"
          label={workScopeLabel(card.scopes, options)}
          isOpen={openFilter === 'objects'}
          allLabel="Все объекты"
          values={card.scopes}
          options={objectOptions}
          onToggle={() => setOpenFilter(openFilter === 'objects' ? null : 'objects')}
          onChange={scopes => onChange({ scopes: scopes as WorkCardScope[] })}
          onClose={() => setOpenFilter(null)}
        />
        <PopoverFilterButton
          title="Ед. изм."
          label={unitFilterLabel(card.units)}
          isOpen={openFilter === 'units'}
          allLabel="Все ед. изм."
          values={card.units}
          options={unitFilterOptions}
          onToggle={() => setOpenFilter(openFilter === 'units' ? null : 'units')}
          onChange={units => onChange({ units })}
          onClose={() => setOpenFilter(null)}
        />
      </div>
      {detailSection && (
        <WorkTagDetailsModal
          title={card.label}
          section={detailSection}
          from={from}
          to={to}
          rows={detailRows}
          total={detailTotal}
          onClose={() => setDetailSection(null)}
        />
      )}
    </section>
  )
}

function legacyCategoryForWorkCard(card: WorkMetricCardConfig): UICatKey | null {
  if (card.scopes.some(scope => scope.startsWith('group:'))) return null
  if (card.id.includes('sand')) return 'SAND'
  if (card.id.includes('prs')) return 'PRS'
  if (card.id.includes('vyemka')) return card.scopes.some(scope => scope === 'type:MAIN_TRACK') ? 'VYEMKA_OH' : 'VYEMKA'
  if (card.id.includes('peat')) return card.scopes.some(scope => scope === 'type:MAIN_TRACK') ? 'PEAT_OH' : 'PEAT_VAD'
  if (card.id.includes('scheben')) return 'SCHEBEN'
  if (card.id.includes('shps')) return 'SHPS'
  return null
}

function PopoverFilterButton({
  title,
  label,
  isOpen,
  allLabel,
  values,
  options,
  onToggle,
  onChange,
  onClose,
}: {
  title: string
  label: string
  isOpen: boolean
  allLabel: string
  values: string[]
  options: { value: string; label: string; meta?: string }[]
  onToggle: () => void
  onChange: (values: string[]) => void
  onClose: () => void
}) {
  function toggle(value: string, checked: boolean) {
    if (checked) onChange([...values, value])
    else onChange(values.filter(item => item !== value))
  }
  const selected = new Set(values)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={`inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition ${
          isOpen ? 'border-accent-red bg-red-50 text-accent-red' : 'border-border bg-white text-text-secondary hover:bg-bg-surface'
        }`}
      >
        <span className="shrink-0 text-text-primary">{title}</span>
        <span className="truncate text-text-muted">{label}</span>
        {values.length > 0 && (
          <span className="rounded bg-bg-surface px-1 font-mono text-[10px] text-text-primary">{values.length}</span>
        )}
      </button>
      {isOpen && (
        <>
          <button type="button" className="fixed inset-0 z-[60] cursor-default" aria-label="Закрыть фильтр" onClick={onClose} />
          <div className="absolute bottom-10 left-0 z-[70] flex h-80 w-80 min-w-72 max-w-[calc(100vw-2rem)] resize flex-col overflow-auto rounded-lg border border-border bg-white p-2 shadow-xl">
            <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
              <button
                type="button"
                onClick={() => onChange([])}
                className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-bg-surface"
              >
                {allLabel}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto space-y-1 pr-1">
              {options.map(option => (
                <label key={option.value} className="flex min-w-0 items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-bg-surface">
                  <input
                    type="checkbox"
                    checked={selected.has(option.value)}
                    onChange={e => toggle(option.value, e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-text-primary" title={option.label}>{option.label}</span>
                    {option.meta && <span className="block truncate text-[10px] text-text-muted" title={option.meta}>{option.meta}</span>}
                  </span>
                </label>
              ))}
              {!options.length && <div className="px-1.5 py-3 text-center text-xs text-text-muted">Нет вариантов</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function WorkPulseHeatBlock({ data, isLoading }: { data?: WorkTagSummary; isLoading: boolean }) {
  if (isLoading) return <div className="h-52 rounded-lg bg-bg-surface animate-pulse" />
  const series = data?.timeseries || []
  const heatmap = data?.heatmap || []

  const maxSeries = Math.max(...series.map(row => row.volume || 0), 0)
  const points = series.map((row, i) => {
    const x = series.length <= 1 ? 50 : i / (series.length - 1) * 100
    const y = maxSeries > 0 ? 90 - (row.volume / maxSeries) * 80 : 90
    return `${x},${y}`
  }).join(' ')
  const days = Array.from(new Set(heatmap.map(row => row.date))).sort()
  const sections = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']
    .filter(code => heatmap.some(row => row.section_code === code))
  const fallbackSections = Array.from(new Set(heatmap.map(row => row.section_code))).sort()
  const sectionCodes = sections.length ? sections : fallbackSections
  const maxHeat = Math.max(...heatmap.map(row => row.volume || 0), 0)
  const heatByKey = new Map(heatmap.map(row => [`${row.section_code}:${row.date}`, row.volume || 0]))

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Пульс</div>
          <span className="ml-auto text-[10px] font-mono text-text-muted">{series.length} дн.</span>
        </div>
        <div className="h-24 rounded-lg border border-border bg-white p-2">
          {!series.length ? (
            <div className="grid h-full place-items-center text-xs text-text-muted">Нет данных</div>
          ) : series.length === 1 ? (
            <div className="flex h-full items-end justify-center">
              <div className="w-8 rounded-t bg-accent-red" style={{ height: `${maxSeries > 0 ? 86 : 0}%` }} />
            </div>
          ) : (
            <svg viewBox="0 0 100 100" className="h-full w-full" preserveAspectRatio="none">
              <polyline points={points} fill="none" stroke="#dc2626" strokeWidth="3" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Тепловая карта</div>
          <span className="ml-auto text-[10px] font-mono text-text-muted">{fmtCompact(maxHeat)} max</span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-white p-2">
          <div className="min-w-max space-y-1">
            {sectionCodes.map(code => (
              <div key={code} className="flex items-center gap-1">
                <span className="w-7 shrink-0 text-[10px] font-mono text-text-muted">{sectionCodeToUILabelSafe(code).replace('Участок №', '№')}</span>
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 1)}, 18px)` }}>
                  {days.map(day => {
                    const value = heatByKey.get(`${code}:${day}`) || 0
                    const opacity = maxHeat > 0 ? 0.12 + (value / maxHeat) * 0.88 : 0.08
                    return (
                      <span
                        key={`${code}:${day}`}
                        className="h-4 rounded-sm border border-white"
                        style={{ background: value > 0 ? `rgba(220, 38, 38, ${opacity})` : '#f2f2f2' }}
                        title={`${sectionCodeToUILabelSafe(code)} · ${formatDateRu(day)}: ${fmt(value)}`}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
            {!sectionCodes.length && <div className="py-3 text-center text-xs text-text-muted">Нет данных по участкам</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkTagDetailsModal({
  title,
  section,
  from,
  to,
  rows,
  total,
  onClose,
}: {
  title: string
  section: string
  from: string
  to: string
  rows: WorkTagSummaryRow[]
  total: number
  onClose: () => void
}) {
  const [selectedRow, setSelectedRow] = useState<WorkTagSummaryRow | null>(null)

  return (
    <div className="fixed inset-0 z-[90] bg-black/35 flex items-center justify-center p-4">
      <div className="w-full max-w-5xl max-h-[86vh] bg-white border border-border rounded-lg shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-heading font-bold text-text-primary">{title} · {sectionCodeToUILabelSafe(section)}</div>
            <div className="text-xs text-text-muted">Детализация выбранного участка · всего {fmt(total)} · нажмите на объект, чтобы открыть строки</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-bg-surface">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto p-4">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-white text-text-muted uppercase tracking-wider text-[10px]">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-2 font-semibold">Тег</th>
                <th className="text-left py-2 px-2 font-semibold">Тип объекта</th>
                <th className="text-left py-2 px-2 font-semibold">Объект</th>
                <th className="text-right py-2 px-2 font-semibold">Строк</th>
                <th className="text-right py-2 px-2 font-semibold">Объем</th>
                <th className="text-left py-2 px-2 font-semibold">Ед.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr
                  key={`${row.tag}:${row.object_code || row.object_type_code || 'missing'}:${row.unit}:${idx}`}
                  className="cursor-pointer border-b border-border/60 hover:bg-bg-surface"
                  onClick={() => setSelectedRow(row)}
                >
                  <td className="py-2 px-2 text-text-primary">{row.tag}</td>
                  <td className="py-2 px-2 text-text-secondary">{row.object_type_name || '—'}</td>
                  <td className="py-2 px-2 text-text-secondary">{row.object_name || row.object_code || '—'}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-muted">{fmt(row.fact_count)}</td>
                  <td className="py-2 px-2 text-right font-mono font-semibold text-text-primary">{fmt(row.volume)}</td>
                  <td className="py-2 px-2 text-text-muted">{row.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="py-6 text-center text-sm text-text-muted">Нет строк по выбранному участку</div>}
        </div>
      </div>
      {selectedRow && (
        <WorkFactRowsModal
          from={from}
          to={to}
          section={section}
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  )
}

function WorkFactRowsModal({
  from,
  to,
  section,
  row,
  onClose,
}: {
  from: string
  to: string
  section: string
  row: WorkTagSummaryRow
  onClose: () => void
}) {
  const params = new URLSearchParams({ from, to, section, tag: row.tag, unit: row.unit })
  if (row.object_code) params.set('object_code', row.object_code)
  else if (row.object_type_code) params.set('object_type_code', row.object_type_code)
  else params.set('object_missing', 'true')

  const { data, isLoading, isError, error } = useQuery<{ total: number; rows: WorkFactRow[] }>({
    queryKey: [
      'wip',
      'analytics-work-tag-fact-rows',
      from,
      to,
      section,
      row.tag,
      row.unit,
      row.object_code,
      row.object_type_code,
    ],
    queryFn: () => fetchJson(`/api/wip/analytics/work-tag-fact-rows?${params}`),
  })

  return (
    <div className="fixed inset-0 z-[100] bg-black/45 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[86vh] bg-white border border-border rounded-lg shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-heading font-bold text-text-primary">
              {row.object_name || row.object_code || 'Без объекта'} · {row.tag}
            </div>
            <div className="text-xs text-text-muted">
              {sectionCodeToUILabelSafe(section)} · {fmt(data?.total || row.volume)} {row.unit} · {fmt(data?.rows?.length || row.fact_count)} строк
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-bg-surface">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto p-4">
          {isLoading && <div className="text-sm text-text-muted">Загрузка...</div>}
          {isError && <div className="text-sm text-red-600">{(error as Error).message}</div>}
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-white text-text-muted uppercase tracking-wider text-[10px]">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-2 font-semibold">Дата</th>
                <th className="text-left py-2 px-2 font-semibold">Работа</th>
                <th className="text-left py-2 px-2 font-semibold">Объект</th>
                <th className="text-right py-2 px-2 font-semibold">Объем</th>
                <th className="text-left py-2 px-2 font-semibold">Ед.</th>
                <th className="text-left py-2 px-2 font-semibold">Смена</th>
                <th className="text-left py-2 px-2 font-semibold">Подрядчик</th>
                <th className="text-left py-2 px-2 font-semibold">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map(item => (
                <tr key={item.id} className="border-b border-border/60">
                  <td className="py-2 px-2 font-mono text-text-muted">{formatDateRu(item.date)}</td>
                  <td className="py-2 px-2 text-text-primary">{item.work_type_name}</td>
                  <td className="py-2 px-2 text-text-secondary">{item.object_name || item.object_code || '—'}</td>
                  <td className="py-2 px-2 text-right font-mono font-semibold text-text-primary">{fmt(item.volume)}</td>
                  <td className="py-2 px-2 text-text-muted">{item.unit}</td>
                  <td className="py-2 px-2 text-text-muted">{item.shift || '—'}</td>
                  <td className="py-2 px-2 text-text-secondary">{item.contractor_name || '—'}</td>
                  <td className="max-w-[320px] py-2 px-2 text-text-secondary">
                    <span className="line-clamp-2" title={item.comment || undefined}>{item.comment || '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && !data?.rows?.length && <div className="py-6 text-center text-sm text-text-muted">Нет строк</div>}
        </div>
      </div>
    </div>
  )
}


/** Адаптивный бар-чарт по участкам: min не-нулевой → 12%, max → 75% доступного.
 *  Лидер подсвечен золотом, отстающий — красным. */
function SectionsBarChart({
  sections,
  onSectionClick,
}: {
  sections: { label: string; code: string; value: number }[]
  onSectionClick?: (code: string) => void
}) {
  const values = sections.map(s => s.value).filter(v => v > 0)
  const vmax = values.length ? Math.max(...values) : 0
  const vmin = values.length ? Math.min(...values) : 0
  const MIN_PCT = 10, MAX_PCT = 95
  function heightOf(v: number): number {
    if (v <= 0) return 0
    if (vmax === vmin) return MAX_PCT
    return MIN_PCT + (v - vmin) / (vmax - vmin) * (MAX_PCT - MIN_PCT)
  }
  function colorOf(v: number): string {
    if (v <= 0) return '#e5e5e5'
    if (values.length > 1 && v === vmax) return '#d4af37'
    if (values.length > 1 && v === vmin) return '#dc2626'
    return '#1a1a1a'
  }
  const BAR_AREA_PX = 188
  return (
    <div className="flex items-end gap-1.5 h-56">
      {sections.map(s => (
        <div key={s.code} className="flex-1 min-w-0 flex flex-col items-center gap-1 group h-full justify-end">
          <span className="w-full truncate text-center font-mono text-[9px] leading-none text-text-primary" title={s.value > 0 ? fmt(s.value) : ''}>
            {s.value > 0 ? fmtCompact(s.value) : ''}
          </span>
          <button className="w-full rounded-t-sm transition-all group-hover:opacity-80"
               type="button"
               onClick={() => onSectionClick?.(s.code)}
               style={{
                 height: `${heightOf(s.value) / 100 * BAR_AREA_PX}px`,
                 background: colorOf(s.value),
                 minHeight: s.value > 0 ? 6 : 0,
               }}
               title={`${s.label}: ${fmt(s.value)}${s.value === vmax && values.length > 1 ? ' (лидер)' : s.value === vmin && values.length > 1 ? ' (отстающий)' : ''}`} />
          <span className="font-mono text-[10px] leading-none text-text-muted">{s.label}</span>
        </div>
      ))}
    </div>
  )
}

interface WorksDetailRow {
  id: string
  category_code: string
  source_kind: string
  source_code: string
  included: boolean
  date: string
  section_code: string
  work_name: string
  object_name: string
  unit: string
  volume: number
}

function WorksDetailsModal({
  category, section, from, to, title, onClose,
}: {
  category: string
  section: string
  from: string
  to: string
  title: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { isUserEquivalent } = useAuth()
  const canManageWorkDetails = isUserEquivalent
  const queryKey = ['wip', 'analytics-work-details', category, section, from, to]
  const { data, isLoading, isError, error } = useQuery<{ total: number; rows: WorksDetailRow[] }>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ from, to, category, section })
      return fetchJson(`/api/wip/analytics/works-details?${params}`)
    },
  })
  const patchMutation = useMutation({
    mutationFn: (row: WorksDetailRow) => fetchJson('/api/wip/analytics/work-category-rule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_code: row.category_code,
        source_kind: row.source_kind,
        source_code: row.source_code,
        included: !row.included,
        updated_by: 'dashboard',
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ['wip', 'analytics-works'] })
    },
  })

  return (
    <div className="fixed inset-0 z-[90] bg-black/35 flex items-center justify-center p-4">
      <div className="w-full max-w-5xl max-h-[86vh] bg-white border border-border rounded-lg shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-heading font-bold text-text-primary">{title} · {sectionCodeToUILabelSafe(section)}</div>
            <div className="text-xs text-text-muted">Состав суммы за выбранный период · учитывается: {fmt(data?.total || 0)} м³</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-bg-surface">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto p-4">
          {isLoading && <div className="text-sm text-text-muted">Загрузка...</div>}
          {isError && <div className="text-sm text-red-600">{(error as Error).message}</div>}
          {patchMutation.isError && <div className="mb-2 text-sm text-red-600">{(patchMutation.error as Error).message}</div>}
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-white text-text-muted uppercase tracking-wider text-[10px]">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-2 font-semibold">Учет</th>
                <th className="text-left py-2 px-2 font-semibold">Дата</th>
                <th className="text-left py-2 px-2 font-semibold">Наименование</th>
                <th className="text-left py-2 px-2 font-semibold">Объект</th>
                <th className="text-right py-2 px-2 font-semibold">Объем</th>
                <th className="text-left py-2 px-2 font-semibold">Ед.</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map(row => (
                <tr key={row.id} className={`border-b border-border/60 ${row.included ? '' : 'opacity-50'}`}>
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={row.included}
                      disabled={!canManageWorkDetails || patchMutation.isPending}
                      onChange={() => patchMutation.mutate(row)}
                      title={!canManageWorkDetails ? 'Менять правила учета могут только пользователи с правами user' : undefined}
                    />
                  </td>
                  <td className="py-2 px-2 font-mono text-text-muted">{formatDateRu(row.date)}</td>
                  <td className="py-2 px-2 text-text-primary">{row.work_name}</td>
                  <td className="py-2 px-2 text-text-secondary">{row.object_name}</td>
                  <td className="py-2 px-2 text-right font-mono">{fmt(row.volume)}</td>
                  <td className="py-2 px-2 text-text-muted">{row.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && !data?.rows?.length && <div className="py-6 text-center text-sm text-text-muted">Нет строк</div>}
        </div>
      </div>
    </div>
  )
}

function formatDateRu(value: string | null | undefined) {
  if (!value) return '—'
  const [y, m, d] = value.slice(0, 10).split('-')
  return y && m && d ? `${d}.${m}.${y}` : value
}

function QuarryDonut({
  from, to, material, sourceType, secFilter,
}: { from: string; to: string; material?: string; sourceType?: string; secFilter: string }) {
  const { data, isLoading, isError, error } = useQuery<{ total: number; rows: { quarry_id: string; quarry_name: string; volume: number; share: number }[] }>({
    queryKey: ['wip', 'quarry-donut', from, to, material, sourceType, secFilter],
    queryFn: () => {
      const params = new URLSearchParams({ from, to })
      if (material) params.set('material', material)
      if (sourceType) params.set('source_type', sourceType)
      if (secFilter !== 'all') params.set('section', secFilter)
      return fetchJson(`/api/wip/analytics/quarry-donut?${params}`)
    },
  })

  if (isError) return <AnalyticsError message={`Не удалось загрузить возку: ${errorMessage(error)}`} />
  if (isLoading || !data) return <div className="h-32 bg-bg-surface rounded animate-pulse" />
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!rows.length) {
    return <div className="text-xs text-text-muted py-6 text-center">Нет возки</div>
  }

  const R = 44, r = 28, cx = 60, cy = 60
  const palette = ['#1a1a1a','#dc2626','#7f1d1d','#525252','#a3a3a3','#f59e0b','#737373','#262626','#9a3412','#b45309','#115e59','#7c2d12']
  const segments = rows.reduce<{
    offset: number
    items: ({ start: number; end: number; color: string } & typeof rows[number])[]
  }>((acc, row, i) => {
    const a = data.total > 0 ? (row.volume / data.total) * 360 : 0
    const start = acc.offset
    const end = start + a
    return {
      offset: end,
      items: [...acc.items, { ...row, start, end, color: palette[i % palette.length] }],
    }
  }, { offset: 0, items: [] }).items

  return (
    <div className="flex items-start gap-3">
      <svg viewBox="0 0 120 120" className="w-[120px] h-[120px] shrink-0">
        {segments.map(s => (
          <DonutSlice key={s.quarry_id} start={s.start} end={s.end} R={R} r={r} cx={cx} cy={cy} color={s.color} />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={11} fill="#737373" fontFamily="JetBrains Mono, monospace">всего</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={13} fontWeight={700} fill="#1a1a1a" fontFamily="JetBrains Mono, monospace">{fmt(data.total)}</text>
      </svg>
      <ul className="flex-1 space-y-1 text-[11px] font-mono max-h-48 overflow-y-auto">
        {segments.map(s => (
          <li key={s.quarry_id} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="flex-1 text-text-secondary leading-tight">{s.quarry_name}</span>
            <span className="text-text-primary shrink-0">{s.share}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DonutSlice({
  start, end, R, r, cx, cy, color,
}: { start: number; end: number; R: number; r: number; cx: number; cy: number; color: string }) {
  const toRad = (deg: number) => (deg - 90) * Math.PI / 180
  const x1 = cx + R * Math.cos(toRad(start))
  const y1 = cy + R * Math.sin(toRad(start))
  const x2 = cx + R * Math.cos(toRad(end))
  const y2 = cy + R * Math.sin(toRad(end))
  const xi1 = cx + r * Math.cos(toRad(end))
  const yi1 = cy + r * Math.sin(toRad(end))
  const xi2 = cx + r * Math.cos(toRad(start))
  const yi2 = cy + r * Math.sin(toRad(start))
  const large = end - start > 180 ? 1 : 0
  const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi2} ${yi2} Z`
  return <path d={d} fill={color} />
}

function TransportBreakdownTable({ rows, sourceLabel }: { rows: TransportSourceRow[]; sourceLabel: string }) {
  if (!rows.length) return null
  const contractorValue = (row: TransportSourceRow, key: 'own' | 'almaz' | 'hired') => {
    if (key === 'hired') return row.by_contractor?.hired ?? row.by_contractor?.other_hired ?? 0
    return row.by_contractor?.[key] ?? 0
  }
  return (
    <div className="mt-4 overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-[11px]">
        <thead className="bg-bg-surface text-text-muted uppercase tracking-wider">
          <tr>
            <th className="text-left py-2 px-2 font-semibold">{sourceLabel}</th>
            <th className="text-right py-2 px-2 font-semibold">Всего</th>
            <th className="text-right py-2 px-2 font-semibold">День</th>
            <th className="text-right py-2 px-2 font-semibold">Ночь</th>
            <th className="text-right py-2 px-2 font-semibold">ЖДС</th>
            <th className="text-right py-2 px-2 font-semibold">АЛМАЗ</th>
            <th className="text-right py-2 px-2 font-semibold">Иные</th>
            <th className="text-left py-2 px-2 font-semibold min-w-[260px]">Из чего складывается</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.quarry_id} className="border-t border-border/60">
              <td className="py-2 px-2 text-text-primary font-medium">{row.quarry_name}</td>
              <td className="py-2 px-2 text-right font-mono font-semibold">{fmt(row.volume)}</td>
              <td className="py-2 px-2 text-right font-mono">{fmt(row.by_shift?.day ?? 0)}</td>
              <td className="py-2 px-2 text-right font-mono">{fmt(row.by_shift?.night ?? 0)}</td>
              <td className="py-2 px-2 text-right font-mono">{fmt(contractorValue(row, 'own'))}</td>
              <td className="py-2 px-2 text-right font-mono">{fmt(contractorValue(row, 'almaz'))}</td>
              <td className="py-2 px-2 text-right font-mono">{fmt(contractorValue(row, 'hired'))}</td>
              <td className="py-2 px-2">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(row.by_direction || {})
                    .filter(([, value]) => value > 0)
                    .map(([label, value]) => (
                      <span key={label} className="inline-flex items-center gap-1 rounded border border-border bg-white px-1.5 py-0.5">
                        <span className="text-text-secondary">{label}</span>
                        <span className="font-mono text-text-primary">{fmt(value)}</span>
                      </span>
                    ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Возка с карьеров (source_type=quarry → только реальные карьеры BORROW_PIT). */
function QuarryBarChart({ from, to, secFilter }: { from: string; to: string; secFilter: string }) {
  const { data, isError, error } = useQuery<{ total: number; rows: TransportSourceRow[] }>({
    queryKey: ['wip', 'quarry-bar', from, to, secFilter],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, source_type: 'quarry' })
      if (secFilter !== 'all') params.set('section', secFilter)
      return fetchJson(`/api/wip/analytics/quarry-donut?${params}`)
    },
  })

  const sourceRows = Array.isArray(data?.rows) ? data.rows : []
  const rows = sourceRows.map(r => ({
    name: r.quarry_name,
    'День': Math.round(r.by_shift?.day ?? 0),
    'Ночь': Math.round(r.by_shift?.night ?? 0),
  }))

  return (
    <section className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Truck className="w-5 h-5 text-accent-red" />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading">Возка с карьеров</h2>
        <span className="ml-auto text-xs font-mono text-text-muted">
          только карьеры · смены Д + Н · м³ за период
        </span>
      </div>
      {isError && (
        <div className="mb-4">
          <AnalyticsError message={`Не удалось загрузить возку с карьеров: ${errorMessage(error)}`} />
        </div>
      )}
      <div style={{ height: 360 }}>
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-text-muted">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <BarChart data={rows} layout="vertical" margin={{ left: 110, right: 16 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="#e7e7e7" />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#6b6b6b' }} axisLine={{ stroke: '#c9c9c9' }} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#262626' }} axisLine={false} tickLine={false} width={110} />
              <RCTooltip contentStyle={{ fontSize: 12, border: '1px solid #c9c9c9', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace' }} />
              <Bar dataKey="День" stackId="a" fill="#1a1a1a" />
              <Bar dataKey="Ночь" stackId="a" fill="#dc2626" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <TransportBreakdownTable rows={sourceRows} sourceLabel="Карьер" />
    </section>
  )
}

/** Блок «Состояние накопителей по участкам». */
interface StockpileRow {
  stockpile_id: string
  stockpile_name: string
  section_num: number | null
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
  pk_label?: string | null
  material_code: string
  material_name: string
  inbound: number
  outbound: number
  balance: number
  unit?: string
}

function StockpileBalancesBlock({ to }: { to: string }) {
  const { data, isLoading, isError, error } = useQuery<{
    effective_date: string | null; max_date: string; note: string | null; rows: StockpileRow[]
  }>({
    queryKey: ['wip', 'stockpile-balances', to],
    queryFn: () => fetchJson(`/api/wip/analytics/stockpile-balances?as_of=${to}`),
  })

  if (isError) {
    return (
      <section className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
        <AnalyticsError message={`Не удалось загрузить состояние накопителей: ${errorMessage(error)}`} />
      </section>
    )
  }
  if (isLoading || !data) {
    return <div className="h-40 bg-bg-card border border-border rounded-xl animate-pulse" />
  }

  const bySec: Record<number, StockpileRow[]> = {}
  const rows = Array.isArray(data.rows) ? data.rows : []
  for (const r of rows) {
    const n = r.section_num ?? 0
    bySec[n] ??= []
    bySec[n].push(r)
  }
  const sections = [1,2,3,4,5,6,7,8]

  return (
    <section className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <BarChart3 className="w-5 h-5 text-accent-red" />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading">Состояние накопителей по участкам</h2>
        <span className="ml-auto text-xs font-mono text-text-muted">
          на {data.effective_date}
        </span>
      </div>
      {data.note && (
        <div className="mb-3 text-[11px] text-accent-red bg-red-50 border border-red-200 rounded px-2 py-1">
          ⓘ {data.note}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {sections.map(n => {
          const rows = bySec[n] ?? []
          return (
            <div key={n} className="border border-border rounded-lg p-3 bg-white">
              <div className="text-[11px] font-semibold text-text-muted mb-2">№{n}</div>
              {rows.length === 0 ? (
                <div className="text-text-muted text-xs">нет накопителей</div>
              ) : (
                <table className="w-full text-[11px]">
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.stockpile_id} className="border-t border-border/60 first:border-t-0">
                        <td className="py-1.5 pr-2 text-text-secondary">
                          <div className="font-medium text-text-primary">{r.material_name}</div>
                          <div className="mt-0.5 font-mono text-[10px] leading-tight text-text-muted" title={r.stockpile_name}>
                            {r.pk_label || 'ПК н/д'}
                          </div>
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold text-text-primary">
                          {fmt(r.balance)} {r.unit || 'м³'}
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
      <div className="mt-3 text-[10px] text-text-muted">
        Остаток берется из последнего среза состояния накопителя в суточных отчетах на выбранную дату или раньше.
        Движение материалов в этом блоке не суммируется.
      </div>
    </section>
  )
}

/** Таблица «Основные объёмы» — табличное выражение показателей по основным работам. */
function MainVolumesTable({ summary }: { summary: SummaryResponse | undefined }) {
  if (!summary) return null
  const data = summary
  if (!data.categories) {
    return <AnalyticsError message="Не удалось отрисовать основные объёмы: API вернул ответ без категорий" />
  }
  const defaultCodes = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']
  type MainVolumeColumnKey = ApiCatKey | 'VYEMKA_TOTAL' | 'PEAT_TOTAL'
  type MainVolumeColumn = { key: MainVolumeColumnKey; label: string; categories: ApiCatKey[]; splitKey?: MainVolumeSplitKey }
  const columns: MainVolumeColumn[] = [
    { key: 'SAND', label: 'Насыпь песком', categories: ['SAND'], splitKey: 'SAND' },
    { key: 'PRS', label: 'ПРС', categories: ['PRS'] },
    { key: 'VYEMKA_TOTAL', label: 'Выемка', categories: ['VYEMKA', 'VYEMKA_OH'], splitKey: 'VYEMKA' },
    { key: 'PEAT_TOTAL', label: 'Выторфовка', categories: ['PEAT_VAD', 'PEAT_OH'], splitKey: 'PEAT' },
    { key: 'SHPS', label: 'ЩПС/ЩПГС', categories: ['SHPS'] },
    { key: 'SCHEBEN', label: 'Щебень', categories: ['SCHEBEN'] },
  ]
  const splitSummaries = data.object_group_summary ?? {}

  function categorySectionValue(column: MainVolumeColumn, sectionCode: string): number {
    return column.categories.reduce((sum, key) => sum + Number(data.categories[key]?.by_section?.[sectionCode] || 0), 0)
  }

  function columnSectionValue(column: MainVolumeColumn, sectionCode: string): number {
    const splitValue = column.splitKey
      ? objectGroupTotal(splitSummaries[column.splitKey]?.by_section_object_group?.[sectionCode])
      : 0
    return splitValue > 0 ? splitValue : categorySectionValue(column, sectionCode)
  }

  const summaryCodes = data.sections?.length ? data.sections : defaultCodes
  const codes = summaryCodes.filter(code => code !== '—' || columns.some(column => columnSectionValue(column, code) > 0))

  type Row = { code: string; label: string; vals: Record<MainVolumeColumnKey, number> }
  const merged: Row[] = []
  for (const code of codes) {
    const vals = {} as Record<MainVolumeColumnKey, number>
    for (const column of columns) vals[column.key] = columnSectionValue(column, code)
    merged.push({ code, label: sectionCodeToUILabel(code), vals })
  }

  const tot = {} as Record<MainVolumeColumnKey, number>
  for (const column of columns) tot[column.key] = 0
  for (const row of merged) for (const column of columns) tot[column.key] += row.vals[column.key]

  return (
    <section className="bg-bg-card border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-5 h-5 text-accent-red" />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading">Основные объёмы</h2>
        <span className="ml-auto text-xs font-mono text-text-muted">факт работ за период</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-text-muted uppercase tracking-wider">
              <th className="text-left py-2 px-2 font-semibold">Участок</th>
              {columns.map(column => (
                <th key={column.key} className="text-right py-2 px-2 font-semibold">{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {merged.map(row => (
              <tr key={row.code} className="border-b border-border/60 hover:bg-bg-surface/40">
                <td className="py-2 px-2 font-medium">{row.label}</td>
                {columns.map(column => {
                  const split = column.splitKey ? splitSummaries[column.splitKey]?.by_section_object_group?.[row.code] : undefined
                  return (
                    <td key={column.key} className="py-2 px-2 text-right font-mono">
                      {column.splitKey ? (
                        <MainVolumeSplitCell value={row.vals[column.key]} split={split} />
                      ) : fmt(row.vals[column.key])}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="bg-bg-surface/60">
              <td className="py-2 px-2 font-bold">Σ</td>
              {columns.map(column => {
                const split = column.splitKey ? splitSummaries[column.splitKey]?.by_object_group : undefined
                return (
                  <td key={column.key} className="py-2 px-2 text-right font-mono font-bold">
                    {column.splitKey ? (
                      <MainVolumeSplitCell value={tot[column.key]} split={split} emphasized />
                    ) : fmt(tot[column.key])}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function objectGroupValue(split: Record<MainVolumeObjectGroupKey, number> | undefined, key: MainVolumeObjectGroupKey): number {
  return Number(split?.[key] || 0)
}

function objectGroupTotal(split: Record<MainVolumeObjectGroupKey, number> | undefined): number {
  return MAIN_VOLUME_OBJECT_GROUPS.reduce((sum, item) => sum + objectGroupValue(split, item.key), 0)
}

function MainVolumeSplitCell({
  value,
  split,
  emphasized = false,
}: {
  value: number
  split?: Record<MainVolumeObjectGroupKey, number>
  emphasized?: boolean
}) {
  const splitTotal = objectGroupTotal(split)
  if (splitTotal <= 0) return <span>{fmt(value)}</span>

  return (
    <span className="block">
      <span className="block">{fmt(value)}</span>
      <span className={`mt-0.5 block whitespace-nowrap font-sans text-[10px] font-normal leading-tight ${emphasized ? 'text-text-secondary' : 'text-text-muted'}`}>
        {MAIN_VOLUME_OBJECT_GROUPS.map(item => `${item.label} ${fmt(objectGroupValue(split, item.key))}`).join(' · ')}
      </span>
    </span>
  )
}

// Legacy detail widgets are currently not mounted by the page, but keeping an
// explicit reference lets strict noUnusedLocals type-check the file until the
// analytics screen is fully cleaned up.
if (false) {
  console.debug(BUCKET_COLOR, BUCKET_LABEL, mergeSections, WorksDetailsModal, QuarryDonut)
}
