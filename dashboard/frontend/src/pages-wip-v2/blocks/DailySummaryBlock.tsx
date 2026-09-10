/**
 * Блок «Выполнение за выбранный период» + «Сводные показатели по 3 этапу».
 * Источник: /api/wip/analytics/daily-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, ClipboardCheck, Route, Truck, Users, X } from 'lucide-react'

const DASHBOARD_BLOCK_STALE_MS = 5 * 60_000
const DASHBOARD_BLOCK_GC_MS = 15 * 60_000
const DASHBOARD_DETAIL_STALE_MS = 2 * 60_000

function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
}

interface ContractorSplit {
  own: number; almaz: number; hired: number; total: number
}
interface SandSupplySplit {
  total_m3: number
  self_purchase_m3: number
  customer_supplied_m3: number
  local_soil_m3?: number | null
}
interface MaterialFlowRow {
  material: string
  quarry_name?: string | null
  source_object_name?: string | null
  source_group_key?: string | null
  movement_type?: string | null
  contractor_bucket?: 'zhds' | 'almaz' | 'hire' | string | null
  contractor_kind?: string | null
  contractor_short?: string | null
  volume: number
}
interface WorkObjectTotals {
  sand_oh_m3?: number
  sand_vad_m3?: number
  sand_other_m3?: number
  excavation_oh_m3?: number
  excavation_vad_m3?: number
  excavation_other_m3?: number
  excavation_total_m3?: number
}
interface Summary {
  prs_m3: number
  vyemka_m3: number
  shpgs_m3: number
  sand_work_m3?: number
  work_object_totals?: WorkObjectTotals
  sand_transport: ContractorSplit
  sand_quarry_transport?: ContractorSplit
  shpgs_transport: ContractorSplit
  soil_transport: ContractorSplit
  piles: { main: number; trial: number; dyntest: number; total: number }
}
interface TempRoadSectionDetail {
  group: 'project' | 'driveways' | string
  road_id?: string
  road_code?: string | null
  road_name?: string | null
  section: number
  section_code?: string | null
  section_name?: string | null
  ad_pk_start?: number | null
  ad_pk_end?: number | null
  rail_pk_start?: number | null
  rail_pk_end?: number | null
  length_m: number
  passable_m?: number
  completed_m?: number
  ready_m?: number
  ready_plus_done_m: number
}
interface Stage3Section {
  section: number
  length_m: number
  passable_m?: number
  passable_pct?: number
  completed_m?: number
  ready_m?: number
  ready_plus_done_m: number
  pct_ready_plus_done: number
  details?: TempRoadSectionDetail[]
}
interface Stage3Snapshot {
  total_length_m: number
  passable_m: number
  completed_m: number
  ready_m?: number
  ready_plus_done_m: number
  passable_pct?: number
  completed_pct?: number
  ready_pct?: number
  ready_plus_done_pct?: number
  sections: Stage3Section[]
}
interface Stage3 extends Stage3Snapshot {
  project?: Stage3Snapshot
  driveways?: Stage3Snapshot
  combined?: Stage3Snapshot
}
interface DashboardCacheMeta {
  cache_status?: 'fresh' | 'stale' | string
  cache_refreshing?: boolean
  cache_created_at?: string
}

interface Response extends DashboardCacheMeta {
  from: string
  to: string
  summary: Summary
  stage3: Stage3
}
interface MaterialFlowResponse extends DashboardCacheMeta {
  rows: MaterialFlowRow[]
  sand_supply_split?: SandSupplySplit
}

type DashboardKpiMetric =
  | 'sand_delivery'
  | 'excavation_total'
  | 'excavation_oh'
  | 'sand_oh'
  | 'sand_other'
  | 'piles'
  | 'excavation_other'
  | 'excavation_vad'
  | 'sand_vad'
  | 'temp_roads_passable'

interface KpiCardSpec {
  metric: DashboardKpiMetric
  label: string
  value: string
  unit?: string
  colorClass?: string
}

interface KpiDetailRow {
  section_code: string
  section_label: string
  object_type_code: string
  object_type_name: string
  object_id?: string | null
  object_code?: string | null
  object_name: string
  volume: number
  plan_volume: number
  completion_pct?: number | null
  fact_count: number
  details?: KpiSourceDetail[]
}

interface KpiSourceDetail {
  kind: 'fact' | 'plan'
  object_name: string
  work_type_name: string
  volume: number
  report_date?: string | null
  shift?: string | null
  report_id?: string | null
  plan_item_id?: string | null
  period_start?: string | null
  period_end?: string | null
}

interface KpiDetailObjectType {
  object_type_code: string
  object_type_name: string
  volume: number
  plan_volume: number
  completion_pct?: number | null
  fact_count: number
  objects: KpiDetailRow[]
}

interface KpiDetailSection {
  section_code: string
  section_label: string
  volume: number
  plan_volume: number
  completion_pct?: number | null
  fact_count: number
  object_types: KpiDetailObjectType[]
}

interface KpiDetailResponse {
  metric: DashboardKpiMetric
  label: string
  unit: string
  total: number
  fact_total?: number
  plan_total?: number
  completion_pct?: number | null
  source_total?: number
  source_fact_total?: number
  source_sections?: KpiDetailSection[]
  source_rows?: KpiDetailRow[]
  sections: KpiDetailSection[]
  rows: KpiDetailRow[]
}

type KpiSortKey = 'object_type_name' | 'object_name' | 'plan_volume' | 'volume' | 'completion_pct'
type KpiVolumeLike = Pick<KpiDetailRow, 'volume' | 'plan_volume' | 'completion_pct'>
interface KpiSortState {
  key: KpiSortKey
  dir: 'asc' | 'desc'
}

type EquipmentStatus = 'working' | 'idle' | 'repair'

interface EquipmentUnit {
  category: string
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
}

interface EquipmentSection {
  section_code: string
  label: string
  working_total: number
  idle_total: number
  repair_total: number
  units: EquipmentUnit[]
}

interface EquipmentPulseResponse extends DashboardCacheMeta {
  effective_date?: string
  totals: Record<EquipmentStatus, number>
  sections: EquipmentSection[]
}

interface PeopleCounts {
  hired?: number
  at_work?: number
  intershift?: number
  vacation?: number
  sick?: number
  vacation_sick?: number
}

interface StaffCard {
  card_code: string
  label: string
  counts: PeopleCounts
  total: number
  section_num?: number | null
}

interface StaffSectionFallback {
  section_code: string
  label?: string | null
  rows?: { category: string; count: number; label?: string }[]
  counts?: PeopleCounts
  total: number
  section_num?: number | null
}

interface StaffResourcesData extends DashboardCacheMeta {
  summary?: PeopleCounts
  cards?: StaffCard[]
  sections?: StaffSectionFallback[]
  rows?: { category: string; count: number; label?: string }[]
  total: number
}

interface MoneyRow {
  section_code: string
  section_label: string
  object_type_name: string
  object_name: string
  work_type_name: string
  unit: string
  plan_volume: number
  fact_volume: number
  plan_amount: number
  fact_amount: number
  missing_rate: boolean
}

interface MissingMoneyWorkType {
  work_type_id?: string | null
  work_type_code: string
  work_type_name: string
  unit: string
  plan_volume: number
  fact_volume: number
  row_count: number
  section_count: number
  object_count: number
}

interface MoneySection {
  section_code: string
  section_label: string
  plan_amount: number
  fact_amount: number
  rows: MoneyRow[]
}

interface MoneyPlanFactResponse {
  plan_total: number
  fact_total: number
  missing_rate_count: number
  missing_work_type_count?: number
  missing_row_count?: number
  missing_work_types?: MissingMoneyWorkType[]
  rows: MoneyRow[]
  sections: MoneySection[]
}
interface IssoSupportFactMonth {
  value: string
  label: string
  sites: number
  material_kind?: string
  material_label?: string
}

interface IssoSupportFillMaterial {
  kind: string
  label: string
  sites: number
}

interface IssoSupportLineRow {
  line_id: string
  row_num: number
  support_label: string
  target_month_support_label?: string
  supports_total: number
  supports_done: number
  fact_supports: number
  fact_june_sites?: number
  fact_july_sites?: number
  fact_months?: IssoSupportFactMonth[]
  sites_total: number
  sites_done: number
  sites_sand_done: number
  sites_shpgs_done: number
  current_month_plan: number
  current_month_done: number
  current_month_sand_done: number
  current_month_shpgs_done: number
  rd_status: string
  status: string
  work_activity_count?: number
  last_work_date?: string
  work_object_code?: string
  work_object_name?: string
  road_sand?: string
  road_shps?: string
  site_sand?: string
  site_shps?: string
  ms11_started?: boolean
  ms11_scope?: boolean
  ms11_working?: boolean
  ms11_bridge_work?: boolean
  fill_material_kind?: string
  fill_material_label?: string
  fill_materials?: IssoSupportFillMaterial[]
  deadline?: string
  letter?: string
  remark: string
}

interface IssoSupportIsso {
  object_no: number
  object_code: string
  object_name: string
  object_type: string
  section_code: string
  section_label: string
  source_pk_m?: number | null
  pk_start_m?: number | null
  pk_end_m?: number | null
  pk_label?: string | null
  supports_total: number
  supports_done: number
  fact_supports_total: number
  sites_total: number
  sites_done: number
  sites_sand_done: number
  sites_shpgs_done: number
  current_month_plan: number
  current_month_done: number
  current_month_sand_done: number
  current_month_shpgs_done: number
  rows: IssoSupportLineRow[]
}

interface IssoSupportSection {
  section_code: string
  section_label: string
  objects: number
  supports_total: number
  supports_done: number
  fact_supports_total: number
  sites_total: number
  sites_done: number
  sites_sand_done: number
  sites_shpgs_done: number
  current_month_plan: number
  current_month_done: number
  current_month_sand_done: number
  current_month_shpgs_done: number
  issos: IssoSupportIsso[]
}

interface IssoSupportTotals {
  objects: number
  supports_total: number
  supports_done: number
  fact_supports_total: number
  sites_total: number
  sites_done: number
  sites_sand_done: number
  sites_shpgs_done: number
  current_month_plan: number
  current_month_done: number
  current_month_sand_done: number
  current_month_shpgs_done: number
}

interface IssoSupportMonthOption {
  value: string
  label: string
}

interface IssoSupportResponse {
  available: boolean
  detail?: string
  from: string
  to: string
  target_month: string
  target_month_label: string
  target_month_material_kind?: string
  months?: IssoSupportMonthOption[]
  snapshot?: { snapshot_date?: string; source_filename?: string; title?: string } | null
  totals: IssoSupportTotals
  sections: IssoSupportSection[]
}

type IssoStatus = 'ready' | 'no_rd' | 'idle_with_rd' | 'sand' | 'shpgs_partial' | 'unknown' | 'gray' | 'red' | 'green' | 'blue' | 'white'

interface DonutSlice {
  key: string
  label: string
  value: number
  color: string
  valueLabel?: string
}

type DonutKind = 'money' | 'isso_support' | 'equipment' | 'people'
interface DonutSelection {
  kind: DonutKind
  title: string
  segmentKey?: string
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))
const fmt2 = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const moneyFullNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const PROJECT_START_DATE = '2025-08-01'
type TempRoadMode = 'project' | 'with_driveways'
const EMPTY_STAGE3: Stage3Snapshot = {
  total_length_m: 0,
  passable_m: 0,
  completed_m: 0,
  ready_m: 0,
  ready_plus_done_m: 0,
  passable_pct: 0,
  completed_pct: 0,
  ready_pct: 0,
  ready_plus_done_pct: 0,
  sections: [],
}

const KPI_DEFAULT_SORT: KpiSortState = { key: 'object_type_name', dir: 'asc' }
const DONUT_COLORS = {
  red: '#b91c1c',
  burgundy: '#7f1d1d',
  graphite: '#1f2937',
  steel: '#64748b',
  zinc: '#a1a1aa',
  amber: '#d97706',
  green: '#15803d',
}

function fmtMoneyFull(value: number): string {
  return `${moneyFullNf.format(Math.round(Number(value || 0)))} ₽`
}

function sectionNum(sectionCode: string | null | undefined): number | null {
  const match = String(sectionCode || '').match(/^UCH_(\d+)$/)
  return match ? Number(match[1]) : null
}

function sectionSortValue(sectionCode: string | null | undefined): number {
  return sectionNum(sectionCode) ?? 9999
}

function kpiSectionLabel(sectionCode: string | null | undefined, fallback?: string | null): string {
  const num = sectionNum(sectionCode)
  if (num != null) return `Участок №${num}`
  if (sectionCode === 'ALL') return 'Все участки'
  const fallbackText = String(fallback || '').trim()
  const fallbackMatch = fallbackText.match(/уч(?:асток)?\.?\s*№?\s*(\d+)/i)
  if (fallbackMatch) return `Участок №${Number(fallbackMatch[1])}`
  return fallbackText || String(sectionCode || 'Без участка')
}

function staffCount(data: StaffResourcesData | undefined, key: keyof PeopleCounts): number {
  if (!data) return 0
  if (key === 'vacation_sick') {
    const fromSummary = Number(data.summary?.vacation_sick ?? 0)
    if (fromSummary) return fromSummary
    return Number(data.summary?.vacation ?? 0) + Number(data.summary?.sick ?? 0)
  }
  const summaryValue = Number(data.summary?.[key] ?? 0)
  if (summaryValue) return summaryValue
  const row = (data.rows || []).find(item => item.category === key)
  return Number(row?.count ?? 0)
}

function staffFallbackCounts(section: StaffSectionFallback): PeopleCounts {
  if (section.counts) return section.counts
  const counts: PeopleCounts = {}
  for (const row of section.rows || []) {
    const key = row.category as keyof PeopleCounts
    counts[key] = Number(counts[key] || 0) + Number(row.count || 0)
  }
  counts.vacation_sick = Number(counts.vacation_sick || 0) || Number(counts.vacation || 0) + Number(counts.sick || 0)
  return counts
}

function staffDisplayCards(data: StaffResourcesData | undefined): Array<{ key: string; label: string; counts: PeopleCounts; total: number; section_num?: number | null }> {
  if (!data) return []
  if (data.cards?.length) {
    return data.cards.map(card => ({
      key: card.card_code || card.label,
      label: card.label,
      counts: card.counts || {},
      total: card.total,
      section_num: card.section_num,
    }))
  }
  return (data.sections || []).map(section => ({
    key: section.section_code || section.label || '—',
    label: section.label || section.section_code || '—',
    counts: staffFallbackCounts(section),
    total: section.total,
    section_num: section.section_num,
  }))
}

function equipmentStatusLabel(status: EquipmentStatus): string {
  if (status === 'working') return 'В работе'
  if (status === 'repair') return 'Ремонт'
  return 'Простой'
}

function kpiSortLabel(key: KpiSortKey): string {
  if (key === 'object_type_name') return 'Тип объекта'
  if (key === 'object_name') return 'Объект'
  if (key === 'plan_volume') return 'План'
  if (key === 'volume') return 'Факт'
  return '% выполнения'
}

function stageSection(stage: Stage3Snapshot | undefined, section: number): Stage3Section | undefined {
  return stage?.sections.find(row => row.section === section)
}

function tempRoadGroupLabel(group: string | undefined): string {
  return group === 'driveways' ? 'Непроектный проезд' : 'Проектная дорога'
}

function formatPkPoint(value: number | null | undefined): string {
  if (value == null) return ''
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  const sign = numeric < 0 ? '-' : ''
  const abs = Math.abs(numeric)
  const pk = Math.floor(abs / 100)
  const plus = abs - pk * 100
  const plusText = Math.abs(plus - Math.round(plus)) < 0.005
    ? String(Math.round(plus)).padStart(2, '0')
    : plus.toFixed(2).replace('.', ',').replace(/0+$/, '').replace(/,$/, '').padStart(2, '0')
  return `${sign}ПК${pk}+${plusText}`
}

function formatPkRange(start: number | null | undefined, end: number | null | undefined): string {
  const startText = formatPkPoint(start)
  const endText = formatPkPoint(end)
  if (!startText || !endText) return '—'
  return startText === endText ? startText : `${startText}-${endText}`
}

function pctColor(p: number): string {
  if (p >= 50) return 'text-progress-green'
  if (p >= 15) return 'text-progress-amber'
  return 'text-accent-red'
}

function fmtPct(value: number | null | undefined): string {
  if (value == null) return '—'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return numeric.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
}

function fmtPctUnit(value: number | null | undefined): string {
  const text = fmtPct(value)
  return text === '—' ? text : `${text}%`
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU')
}

function formatPeriod(from: string, to: string): string {
  return from === to ? formatDate(to) : `${formatDate(from)} — ${formatDate(to)}`
}

function monthStartFromDate(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-01` : ''
}

function monthLabelFromValue(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/)
  if (!match) return 'месяц'
  const monthIndex = Number(match[2]) - 1
  const labels = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ]
  return `${labels[monthIndex] || match[2]} ${match[1]}`
}

function formatRuDate(value: string | null | undefined): string {
  const text = String(value || '').trim()
  if (!text || text === '-') return text
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`
  const shortMatch = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/)
  if (shortMatch) return `${shortMatch[1].padStart(2, '0')}.${shortMatch[2].padStart(2, '0')}.20${shortMatch[3]}`
  return text
}

function emptySplit(): ContractorSplit {
  return { own: 0, almaz: 0, hired: 0, total: 0 }
}

function flowBucket(row: MaterialFlowRow): keyof Omit<ContractorSplit, 'total'> {
  if (row.contractor_bucket === 'zhds') return 'own'
  if (row.contractor_bucket === 'almaz') return 'almaz'
  if (row.contractor_bucket === 'hire') return 'hired'
  if (row.contractor_kind === 'own') return 'own'
  if ((row.contractor_short ?? '').toUpperCase().includes('АЛМАЗ')) return 'almaz'
  return 'hired'
}

function dashboardMaterialSplit(rows: MaterialFlowRow[] | undefined, materialCodes: string | string[]): ContractorSplit | null {
  if (!rows) return null
  const split = emptySplit()
  const wanted = new Set((Array.isArray(materialCodes) ? materialCodes : [materialCodes]).map(code => code.toUpperCase()))
  for (const row of rows) {
    const material = String(row.material || '').toUpperCase()
    const direction = row.movement_type || ''
    if (!wanted.has(material)) continue
    if (direction !== 'pit_to_stockpile' && direction !== 'pit_to_constructive') continue
    const volume = Number(row.volume || 0)
    const bucket = flowBucket(row)
    split[bucket] += volume
    split.total += volume
  }
  return split
}

function sandSourceKey(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^карьер\s+/i, '')
    .replace(/["«»]/g, '')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SAND_SELF_PURCHASE_SOURCE_KEYS = new Set([
  'Боровенка',
  'Зорька 2',
  'Выползово',
  'УССК',
  'Пирус',
  'Едрово',
  'Южные Маяки',
  'Добывалово',
].map(name => `quarry:${sandSourceKey(name)}`))

function rowSandSourceKey(row: MaterialFlowRow): string {
  if (row.source_group_key) return row.source_group_key
  const key = sandSourceKey(row.quarry_name || row.source_object_name)
  return key ? `quarry:${key}` : ''
}

function dashboardSandSupplySplit(rows: MaterialFlowRow[] | undefined): SandSupplySplit | null {
  if (!rows) return null
  let total = 0
  let selfPurchase = 0
  for (const row of rows) {
    const material = String(row.material || '').toUpperCase()
    const direction = row.movement_type || ''
    if (material !== 'SAND' && material !== 'COARSE_SAND') continue
    if (direction !== 'pit_to_stockpile' && direction !== 'pit_to_constructive') continue
    const volume = Number(row.volume || 0)
    if (volume <= 0) continue
    total += volume
    if (SAND_SELF_PURCHASE_SOURCE_KEYS.has(rowSandSourceKey(row))) {
      selfPurchase += volume
    }
  }
  return {
    total_m3: total,
    self_purchase_m3: selfPurchase,
    customer_supplied_m3: Math.max(0, total - selfPurchase),
  }
}

function dashboardCacheState(items: Array<DashboardCacheMeta | undefined | null>) {
  const staleItems = items.filter(item => item?.cache_status === 'stale')
  const refreshing = items.some(item => item?.cache_refreshing)
  const createdAt = staleItems
    .map(item => item?.cache_created_at)
    .filter((value): value is string => Boolean(value))
    .sort()[0]
  return {
    show: staleItems.length > 0 || refreshing,
    staleCount: staleItems.length,
    refreshing,
    createdAt,
  }
}

function dashboardCacheDateLabel(value?: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function DailySummaryBlock({ from, to, variant = 'overview' }: { from: string; to: string; variant?: 'overview' | 'dashboard' }) {
  const isDashboard = variant === 'dashboard'
  const dashboardMaterialFlowUrl = `/api/wip/dashboard/material-flow?from=${from}&to=${to}`
  const allTimeDashboardMaterialFlowUrl = `/api/wip/dashboard/material-flow?from=${PROJECT_START_DATE}&to=${to}`

  const { data, isLoading, refetch: refetchDailySummary } = useQuery<Response>({
    queryKey: ['wip', 'daily-summary', from, to],
    queryFn: () => fetch(`/api/wip/analytics/daily-summary?from=${from}&to=${to}`).then(r => r.json()),
    staleTime: isDashboard ? DASHBOARD_BLOCK_STALE_MS : 2 * 60_000,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: dashboardMaterial, isLoading: isDashboardMaterialLoading, refetch: refetchDashboardMaterial } = useQuery<MaterialFlowResponse>({
    queryKey: ['wip', 'material-flow', 'quarry', dashboardMaterialFlowUrl, from, to],
    queryFn: () => fetch(dashboardMaterialFlowUrl).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: allTimeSummary, isLoading: isAllTimeSummaryLoading, refetch: refetchAllTimeSummary } = useQuery<Response>({
    queryKey: ['wip', 'daily-summary', 'all-time', PROJECT_START_DATE, to],
    queryFn: () => fetch(`/api/wip/analytics/daily-summary?from=${PROJECT_START_DATE}&to=${to}`).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: allTimeDashboardMaterial, isLoading: isAllTimeDashboardMaterialLoading, refetch: refetchAllTimeDashboardMaterial } = useQuery<MaterialFlowResponse>({
    queryKey: ['wip', 'material-flow', 'quarry', allTimeDashboardMaterialFlowUrl, PROJECT_START_DATE, to],
    queryFn: () => fetch(allTimeDashboardMaterialFlowUrl).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const [selectedKpi, setSelectedKpi] = useState<KpiCardSpec | null>(null)
  const [selectedKpiSection, setSelectedKpiSection] = useState<string | null>(null)
  const [kpiSort, setKpiSort] = useState<KpiSortState>(KPI_DEFAULT_SORT)
  const [selectedDonut, setSelectedDonut] = useState<DonutSelection | null>(null)
  const [tempRoadMode, setTempRoadMode] = useState<TempRoadMode>('project')
  const [selectedTempRoadSection, setSelectedTempRoadSection] = useState<number | null>(null)
  const { data: selectedKpiDetail, isLoading: isKpiDetailLoading } = useQuery<KpiDetailResponse>({
    queryKey: ['wip', 'dashboard', 'kpi-detail', selectedKpi?.metric, from, to],
    queryFn: () => fetch(`/api/wip/dashboard/kpi-detail?metric=${encodeURIComponent(selectedKpi?.metric || '')}&from=${from}&to=${to}`).then(r => r.json()),
    enabled: isDashboard && !!selectedKpi && selectedKpi.metric !== 'temp_roads_passable',
    staleTime: DASHBOARD_DETAIL_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: issoSupportData, isLoading: isIssoSupportLoading } = useQuery<IssoSupportResponse>({
    queryKey: ['wip', 'dashboard', 'isso-support', from, to],
    queryFn: () => fetch(`/api/wip/dashboard/isso-support?from=${from}&to=${to}`).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: equipmentData, isLoading: isEquipmentLoading, refetch: refetchEquipment } = useQuery<EquipmentPulseResponse>({
    queryKey: ['wip', 'overview', 'equipment-pulse', 'donut', from, to],
    queryFn: () => fetch(`/api/wip/overview/equipment-pulse?from=${from}&to=${to}`).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const { data: staffData, isLoading: isStaffLoading, refetch: refetchStaff } = useQuery<StaffResourcesData>({
    queryKey: ['wip', 'dashboard', 'staff-resources', 'donut', from, to],
    queryFn: () => fetch(`/api/wip/dashboard/staff-resources?from=${from}&to=${to}`).then(r => r.json()),
    enabled: isDashboard,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })

  const dashboardCache = dashboardCacheState([
    data,
    dashboardMaterial,
    allTimeSummary,
    allTimeDashboardMaterial,
    equipmentData,
    staffData,
  ])

  useEffect(() => {
    if (!isDashboard || !dashboardCache.refreshing) return undefined
    const timer = window.setTimeout(() => {
      void refetchDailySummary()
      void refetchDashboardMaterial()
      void refetchAllTimeSummary()
      void refetchAllTimeDashboardMaterial()
      void refetchEquipment()
      void refetchStaff()
    }, 7000)
    return () => window.clearTimeout(timer)
  }, [
    dashboardCache.refreshing,
    isDashboard,
    refetchAllTimeDashboardMaterial,
    refetchAllTimeSummary,
    refetchDailySummary,
    refetchDashboardMaterial,
    refetchEquipment,
    refetchStaff,
  ])

  if (isLoading || !data || (isDashboard && isDashboardMaterialLoading && !dashboardMaterial)) {
    return <div className="h-40 bg-white border border-border rounded-xl animate-pulse" />
  }

  const periodStr = formatPeriod(data.from, data.to)
  const asOfStr = formatDate(data.to)
  const s = data.summary
  const st = data.stage3
  const projectStage = st.project ?? st
  const drivewaysStage = st.driveways ?? EMPTY_STAGE3
  const combinedStage = st.combined ?? st
  const activeStage = isDashboard && tempRoadMode === 'with_driveways' ? combinedStage : (isDashboard ? projectStage : st)
  const pctTotal = activeStage.total_length_m > 0
    ? (activeStage.ready_plus_done_m / activeStage.total_length_m * 100) : 0
  const tempRoadShpgsPct = activeStage.total_length_m > 0
    ? (activeStage.completed_m / activeStage.total_length_m * 100) : 0
  const sandQuarry = s.sand_quarry_transport ?? s.sand_transport
  const dashboardSand = isDashboard ? dashboardMaterialSplit(dashboardMaterial?.rows, ['SAND', 'COARSE_SAND']) : null
  const dashboardShpgs = isDashboard ? dashboardMaterialSplit(dashboardMaterial?.rows, 'SHPGS') : null
  const sandDisplay = isDashboard && dashboardSand && dashboardSand.total > 0 ? dashboardSand : sandQuarry
  const shpgsDisplay = isDashboard && dashboardShpgs && dashboardShpgs.total > 0 ? dashboardShpgs : s.shpgs_transport
  const dashboardSandValue = isDashboard && sandDisplay.total <= 0 ? (s.sand_work_m3 ?? 0) : sandDisplay.total
  const workObjectTotals = s.work_object_totals ?? {}
  const excavationTotalValue = Number(workObjectTotals.excavation_total_m3 ?? s.vyemka_m3 ?? 0)
  const sandOhValue = Number(workObjectTotals.sand_oh_m3 ?? 0)
  const sandVadValue = Number(workObjectTotals.sand_vad_m3 ?? 0)
  const sandOtherValue = Number(workObjectTotals.sand_other_m3 ?? 0)
  const excavationOhValue = Number(workObjectTotals.excavation_oh_m3 ?? 0)
  const excavationVadValue = Number(workObjectTotals.excavation_vad_m3 ?? 0)
  const excavationOtherValue = Number(workObjectTotals.excavation_other_m3 ?? 0)
  const allTimeSandSupply = isDashboard ? (allTimeDashboardMaterial?.sand_supply_split ?? dashboardSandSupplySplit(allTimeDashboardMaterial?.rows)) : null
  const allTimeShpgs = isDashboard ? dashboardMaterialSplit(allTimeDashboardMaterial?.rows, 'SHPGS') : null
  const allTimeReady = isDashboard && !isAllTimeSummaryLoading && !isAllTimeDashboardMaterialLoading && !!allTimeSummary && !!allTimeDashboardMaterial
  const allTimeValue = (value: number | null | undefined) => allTimeReady ? (value == null ? '...' : fmt(value)) : '...'
  const passablePct = activeStage.passable_pct ?? (activeStage.total_length_m > 0 ? activeStage.passable_m / activeStage.total_length_m * 100 : 0)
  const donePct = activeStage.completed_pct ?? tempRoadShpgsPct
  const readyM = activeStage.ready_m ?? Math.max(0, activeStage.ready_plus_done_m - activeStage.completed_m)
  const readyPct = activeStage.ready_pct ?? (activeStage.total_length_m > 0 ? readyM / activeStage.total_length_m * 100 : 0)
  const selectedProjectSection = selectedTempRoadSection == null ? undefined : stageSection(projectStage, selectedTempRoadSection)
  const selectedDrivewaysSection = selectedTempRoadSection == null ? undefined : stageSection(drivewaysStage, selectedTempRoadSection)
  const selectedCombinedSection = selectedTempRoadSection == null ? undefined : stageSection(combinedStage, selectedTempRoadSection)
  const kpiCards: KpiCardSpec[] = isDashboard
    ? [
      { metric: 'sand_delivery', label: 'Завоз песка', value: fmt(dashboardSandValue), unit: 'м³' },
      { metric: 'excavation_total', label: 'Разработка выемки итого', value: fmt(excavationTotalValue), unit: 'м³' },
      { metric: 'excavation_oh', label: 'Выемка ОХ', value: fmt(excavationOhValue), unit: 'м³' },
      { metric: 'sand_oh', label: 'Отсыпка песка ОХ', value: fmt(sandOhValue), unit: 'м³' },
      { metric: 'sand_other', label: 'Отсыпка песка прочее', value: fmt(sandOtherValue), unit: 'м³' },
      { metric: 'piles', label: 'Забитые сваи', value: fmt(s.piles.total), unit: 'шт' },
      { metric: 'excavation_other', label: 'Разработка выемки прочее', value: fmt(excavationOtherValue), unit: 'м³' },
      { metric: 'excavation_vad', label: 'Выемка ВАД', value: fmt(excavationVadValue), unit: 'м³' },
      { metric: 'sand_vad', label: 'Отсыпка песка ВАД', value: fmt(sandVadValue), unit: 'м³' },
      {
        metric: 'temp_roads_passable',
        label: 'КМ доступно для проезда',
        value: fmt2(activeStage.passable_m / 1000),
        unit: 'км',
        colorClass: pctColor(passablePct),
      },
    ]
    : [
      { metric: 'sand_delivery', label: 'Завоз песка', value: fmt(dashboardSandValue), unit: 'м³' },
      { metric: 'piles', label: 'Забитые сваи', value: fmt(s.piles.total), unit: 'шт' },
      {
        metric: 'temp_roads_passable',
        label: '% готовности временных АД',
        value: tempRoadShpgsPct.toLocaleString('ru-RU', { maximumFractionDigits: 1 }),
        unit: '%',
        colorClass: pctColor(tempRoadShpgsPct),
      },
    ]
  const openKpi = (card: KpiCardSpec) => {
    setSelectedKpi(card)
    setSelectedKpiSection(null)
    setKpiSort(KPI_DEFAULT_SORT)
  }
  const tempRoadKpiSections: KpiDetailSection[] = activeStage.sections.map(sec => ({
    section_code: `UCH_${sec.section}`,
    section_label: `Участок №${sec.section}`,
    volume: Number(sec.passable_m ?? sec.ready_plus_done_m ?? 0) / 1000,
    plan_volume: Number(sec.length_m || 0) / 1000,
    completion_pct: sec.length_m > 0 ? Number(sec.passable_m ?? sec.ready_plus_done_m ?? 0) / Number(sec.length_m || 1) * 100 : null,
    fact_count: (sec.details || []).length,
    object_types: [
      {
        object_type_code: 'TEMP_ROAD',
        object_type_name: 'Временные дороги',
        volume: Number(sec.passable_m ?? sec.ready_plus_done_m ?? 0) / 1000,
        plan_volume: Number(sec.length_m || 0) / 1000,
        completion_pct: sec.length_m > 0 ? Number(sec.passable_m ?? sec.ready_plus_done_m ?? 0) / Number(sec.length_m || 1) * 100 : null,
        fact_count: (sec.details || []).length,
        objects: (sec.details || []).map((detail, index) => ({
          section_code: `UCH_${sec.section}`,
          section_label: `Участок №${sec.section}`,
          object_type_code: detail.group,
          object_type_name: tempRoadGroupLabel(detail.group),
          object_code: detail.road_code || detail.road_id || String(index + 1),
          object_name: detail.road_name || detail.road_code || `Дорога ${index + 1}`,
          volume: Number(detail.passable_m ?? detail.ready_plus_done_m ?? 0) / 1000,
          plan_volume: Number(detail.length_m || 0) / 1000,
          completion_pct: detail.length_m > 0 ? Number(detail.passable_m ?? detail.ready_plus_done_m ?? 0) / Number(detail.length_m || 1) * 100 : null,
          fact_count: 1,
        })),
      },
    ],
  }))
  const issoSitesTotal = Number(issoSupportData?.totals?.sites_total ?? 0)
  const issoSitesDone = Number(issoSupportData?.totals?.sites_done ?? 0)
  const donutSlices = {
    isso_support: [
      { key: 'done', label: 'Отсыпано в ЩПГС', value: issoSitesDone, color: DONUT_COLORS.green, valueLabel: `${fmt(issoSitesDone)} пл.` },
      { key: 'remaining', label: 'Осталось', value: Math.max(issoSitesTotal - issoSitesDone, 0), color: DONUT_COLORS.steel, valueLabel: `${fmt(Math.max(issoSitesTotal - issoSitesDone, 0))} пл.` },
    ],
    equipment: [
      { key: 'working', label: 'В работе', value: Number(equipmentData?.totals?.working ?? 0), color: DONUT_COLORS.green },
      { key: 'repair', label: 'Ремонт', value: Number(equipmentData?.totals?.repair ?? 0), color: DONUT_COLORS.red },
      { key: 'idle', label: 'Простой', value: Number(equipmentData?.totals?.idle ?? 0), color: DONUT_COLORS.steel },
    ],
    people: [
      { key: 'at_work', label: 'В работе', value: staffCount(staffData, 'at_work'), color: DONUT_COLORS.green },
      { key: 'intershift', label: 'Межвахта', value: staffCount(staffData, 'intershift'), color: DONUT_COLORS.amber },
      { key: 'vacation_sick', label: 'Отпуск/больничный', value: staffCount(staffData, 'vacation_sick'), color: DONUT_COLORS.red },
    ],
  }

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <ClipboardCheck className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Выполнение за {periodStr}
        </h2>
      </div>

      {isDashboard && dashboardCache.show && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">{dashboardCache.refreshing ? 'Данные пересчитываются в фоне' : 'Показан кешированный снимок'}</span>
          {dashboardCache.createdAt && (
            <span className="font-mono text-amber-800">снимок: {dashboardCacheDateLabel(dashboardCache.createdAt)}</span>
          )}
          {dashboardCache.staleCount > 0 && (
            <span className="text-amber-800">обновляем блоков: {dashboardCache.staleCount}</span>
          )}
        </div>
      )}

      <div className={`grid gap-2 sm:gap-3 ${isDashboard ? 'grid-cols-2 xl:grid-cols-5 mb-5' : 'grid-cols-1 sm:grid-cols-3 mb-5'}`}>
        {kpiCards.map(card => (
          <KpiBig
            key={card.metric}
            label={card.label}
            value={card.value}
            unit={card.unit}
            colorClass={card.colorClass}
            onClick={isDashboard ? () => openKpi(card) : undefined}
          />
        ))}
      </div>

      {isDashboard && (
        <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <IndustrialDonutCard
            title="Отсыпка площадок для ИССО"
            icon="isso_support"
            slices={donutSlices.isso_support}
            loading={isIssoSupportLoading}
            centerLabel={`${fmt(issoSitesTotal)} пл.`}
            onOpen={(segmentKey) => setSelectedDonut({ kind: 'isso_support', title: 'Отсыпка площадок для ИССО', segmentKey })}
          />
          <IndustrialDonutCard
            title="Техника"
            icon="equipment"
            slices={donutSlices.equipment}
            loading={isEquipmentLoading}
            centerLabel={`${fmt(donutSlices.equipment.reduce((sum, item) => sum + item.value, 0))} ед.`}
            onOpen={(segmentKey) => setSelectedDonut({ kind: 'equipment', title: 'Техника', segmentKey })}
          />
          <IndustrialDonutCard
            title="Люди"
            icon="people"
            slices={donutSlices.people}
            loading={isStaffLoading}
            centerLabel={`${fmt(donutSlices.people.reduce((sum, item) => sum + item.value, 0))} чел.`}
            onOpen={(segmentKey) => setSelectedDonut({ kind: 'people', title: 'Люди', segmentKey })}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Левая колонка: работы + сваи */}
        <div className="space-y-3 text-[13px]">
          <SummaryRow label="Снятие ПРС" value={`${fmt(s.prs_m3)} м³`} />
          <div>
            <SummaryRow label={isDashboard && sandDisplay.total <= 0 ? 'Песок (работы по укладке)' : 'Песок (завоз с карьеров)'}
              value={`${fmt(dashboardSandValue)} м³`}
              bold />
            <div className="ml-5 mt-1 space-y-0.5 text-[12px] text-text-secondary font-mono">
              <div>— собственными силами: {fmt(sandDisplay.own)} м³</div>
              <div>— силами ООО «АЛМАЗ»: {fmt(sandDisplay.almaz)} м³</div>
              <div>— наёмники: {fmt(sandDisplay.hired)} м³</div>
            </div>
          </div>
          <SummaryRow label="Выемка грунта" value={`${fmt(s.vyemka_m3)} м³`} />
          <div>
            <SummaryRow label="ЩПС/ЩПГС"
              value={`${fmt(shpgsDisplay.total)} м³`}
              bold />
            <div className="ml-5 mt-1 space-y-0.5 text-[12px] text-text-secondary font-mono">
              <div>— ЖДС: {fmt(shpgsDisplay.own)} м³</div>
              <div>— АЛМАЗ: {fmt(shpgsDisplay.almaz)} м³</div>
              <div>— наёмники: {fmt(shpgsDisplay.hired)} м³</div>
            </div>
          </div>
          <SummaryRow label="Перевозка грунта" value={`${fmt(s.soil_transport.total)} м³`} />
          <div>
            <SummaryRow label="Погружение свай"
              value={`${fmt(s.piles.total)} шт`}
              bold />
            <div className="ml-5 mt-1 space-y-0.5 text-[12px] text-text-secondary font-mono">
              <div>— пробных: {fmt(s.piles.trial)} шт</div>
              <div>— основных: {fmt(s.piles.main)} шт</div>
              {!isDashboard && <div>— динамические испытания: {fmt(s.piles.dyntest)} шт</div>}
            </div>
          </div>
          {isDashboard && (
            <div className="pt-3">
              <div className="font-semibold text-text-primary">- За все время:</div>
              <div className="mt-1 space-y-0.5 font-mono text-[12px] text-text-secondary">
                <div>- Песок (завоз с карьеров): <span className="font-semibold text-text-primary">{allTimeValue(allTimeSandSupply?.total_m3)}</span> м³ (самостоятельно закупленное: <span className="font-semibold text-text-primary">{allTimeValue(allTimeSandSupply?.self_purchase_m3)}</span> м³, давальческий материал: <span className="font-semibold text-text-primary">{allTimeValue(allTimeSandSupply?.customer_supplied_m3)}</span> м³)</div>
                <div>- Местный грунт: <span className="font-semibold text-text-primary">{allTimeValue(allTimeSandSupply?.local_soil_m3)} м³</span></div>
                <div>- ЩПС/ЩПГС (завоз с карьеров): <span className="font-semibold text-text-primary">{allTimeValue(allTimeShpgs?.total)} м³</span></div>
                <div>- Погружено свай: <span className="font-semibold text-text-primary">{allTimeValue(allTimeSummary?.summary.piles.total)} шт</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Правая колонка: сводные показатели по 3 этапу */}
        <div className="border border-border rounded-lg p-4 bg-bg-surface/40">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Route className="w-4 h-4 text-accent-red" strokeWidth={2} />
            <h3 className="text-sm font-semibold text-gray-800 font-heading uppercase tracking-wider">
              {isDashboard ? 'Отсыпка временных дорог' : 'Сводные показатели по 3 этапу'}
            </h3>
            {isDashboard && (
              <div className="ml-auto inline-flex rounded-md border border-border bg-white p-0.5 text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setTempRoadMode('project')}
                  className={`rounded px-2.5 py-1 ${tempRoadMode === 'project' ? 'bg-accent-red text-white' : 'text-text-secondary hover:text-text-primary'}`}
                  aria-pressed={tempRoadMode === 'project'}
                >
                  Проектная дорога
                </button>
                <button
                  type="button"
                  onClick={() => setTempRoadMode('with_driveways')}
                  className={`rounded px-2.5 py-1 ${tempRoadMode === 'with_driveways' ? 'bg-accent-red text-white' : 'text-text-secondary hover:text-text-primary'}`}
                  aria-pressed={tempRoadMode === 'with_driveways'}
                >
                  С непроектными проездами
                </button>
              </div>
            )}
          </div>
          <div className="text-[12px] text-text-secondary mb-3 leading-snug">
            {isDashboard ? (
              <>
                По состоянию на <b className="text-text-primary">{asOfStr}</b> {tempRoadMode === 'with_driveways' ? 'с учетом непроектных проездов' : 'по проектным дорогам'} для проезда доступно
                <b className="text-text-primary font-mono"> {fmt2(activeStage.passable_m / 1000)} км</b> ({passablePct.toFixed(1)}%),
                ЩПГС уложен на <b className="text-text-primary font-mono">{fmt2(activeStage.completed_m / 1000)} км</b> ({donePct.toFixed(1)}%),
                готово к приему ЩПГС — <b className="text-text-primary font-mono">{fmt2(readyM / 1000)} км</b> ({readyPct.toFixed(1)}%).
              </>
            ) : (
              <>
                Общая протяжённость временных притрассовых автодорог 3 этапа —
                <b className="text-text-primary font-mono"> {fmt2(activeStage.total_length_m / 1000)} км</b>.
                По состоянию на <b className="text-text-primary">{asOfStr}</b> для проезда доступно
                <b className="text-text-primary font-mono"> {fmt2(activeStage.passable_m / 1000)} км</b>,
                работы по устройству ЗП завершены на
                <b className="text-text-primary font-mono"> {fmt2(activeStage.completed_m / 1000)} км</b>,
                готово к следующему этапу — <b className="text-text-primary font-mono">{fmt2(activeStage.ready_plus_done_m / 1000)} км</b>
                {' '}({pctTotal.toFixed(1)}%).
              </>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-text-muted uppercase tracking-wider text-[9px] border-b border-border">
                  <th className="text-left py-1 pr-2 font-semibold">Уч.</th>
                  <th className="text-right py-1 px-1 font-semibold">L<sub>проектная а/д</sub>, м</th>
                  <th className="text-right py-1 px-1 font-semibold">L<sub>непроектные проезды</sub>, м</th>
                  <th className="text-right py-1 px-1 font-semibold">L<sub>доступно</sub>, м</th>
                  <th className="text-right py-1 px-1 font-semibold">L<sub>готово</sub>, м</th>
                  <th className="text-right py-1 pl-1 font-semibold">%</th>
                </tr>
              </thead>
              <tbody>
                {activeStage.sections.map(sec => {
                  const projectSec = stageSection(projectStage, sec.section)
                  const drivewaySec = stageSection(drivewaysStage, sec.section)
                  const hasDetails = tempRoadMode === 'with_driveways'
                    ? Boolean((projectSec?.details?.length || 0) + (drivewaySec?.details?.length || 0))
                    : Boolean(projectSec?.details?.length || 0)
                  return (
                    <tr
                      key={sec.section}
                      className={`border-b border-border/60 ${hasDetails ? 'cursor-pointer hover:bg-white' : ''}`}
                      onClick={() => { if (hasDetails) setSelectedTempRoadSection(sec.section) }}
                      tabIndex={hasDetails ? 0 : undefined}
                      onKeyDown={event => {
                        if (hasDetails && (event.key === 'Enter' || event.key === ' ')) {
                          event.preventDefault()
                          setSelectedTempRoadSection(sec.section)
                        }
                      }}
                    >
                      <td className="py-1 pr-2 font-semibold text-text-primary">№{sec.section}</td>
                      <td className="py-1 px-1 text-right font-mono text-text-secondary">{fmt(projectSec?.length_m ?? 0)}</td>
                      <td className="py-1 px-1 text-right font-mono text-text-secondary">{fmt(drivewaySec?.length_m ?? 0)}</td>
                      <td className="py-1 px-1 text-right font-mono text-text-secondary">{fmt(sec.passable_m ?? sec.ready_plus_done_m)}</td>
                      <td className="py-1 px-1 text-right font-mono text-text-secondary">{fmt(sec.ready_plus_done_m)}</td>
                      <td className={`py-1 pl-1 text-right font-mono font-semibold ${pctColor(sec.pct_ready_plus_done)}`}>
                        {sec.pct_ready_plus_done.toFixed(1)}
                      </td>
                    </tr>
                  )
                })}
                <tr className="bg-white font-bold">
                  <td className="py-1 pr-2 text-text-primary">Σ</td>
                  <td className="py-1 px-1 text-right font-mono text-text-primary">{fmt(projectStage.total_length_m)}</td>
                  <td className="py-1 px-1 text-right font-mono text-text-primary">{fmt(drivewaysStage.total_length_m)}</td>
                  <td className="py-1 px-1 text-right font-mono text-text-primary">{fmt(activeStage.passable_m)}</td>
                  <td className="py-1 px-1 text-right font-mono text-text-primary">{fmt(activeStage.ready_plus_done_m)}</td>
                  <td className={`py-1 pl-1 text-right font-mono ${pctColor(pctTotal)}`}>
                    {pctTotal.toFixed(1)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selectedKpi && (
        <KpiDetailModal
          card={selectedKpi}
          detail={selectedKpi.metric === 'temp_roads_passable' ? {
            metric: selectedKpi.metric,
            label: selectedKpi.label,
            unit: 'км',
            total: activeStage.passable_m / 1000,
            fact_total: activeStage.passable_m / 1000,
            plan_total: activeStage.total_length_m / 1000,
            completion_pct: activeStage.total_length_m > 0 ? activeStage.passable_m / activeStage.total_length_m * 100 : null,
            rows: tempRoadKpiSections.flatMap(section => section.object_types.flatMap(type => type.objects)),
            sections: tempRoadKpiSections,
          } : selectedKpiDetail}
          loading={isKpiDetailLoading}
          selectedSection={selectedKpiSection}
          sort={kpiSort}
          onSelectSection={setSelectedKpiSection}
          onSort={key => setKpiSort(current => ({
            key,
            dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
          }))}
          onOpenTempRoadSection={sectionCode => {
            const num = sectionNum(sectionCode)
            if (num != null) {
              setSelectedKpi(null)
              setSelectedTempRoadSection(num)
            }
          }}
          onClose={() => setSelectedKpi(null)}
        />
      )}

      {selectedDonut && (
        <DonutDetailsModal
          selection={selectedDonut}
          issoSupport={issoSupportData}
          equipment={equipmentData}
          staff={staffData}
          from={from}
          to={to}
          onClose={() => setSelectedDonut(null)}
        />
      )}

      {selectedTempRoadSection != null && (
        <TempRoadSectionDetailsModal
          sectionNum={selectedTempRoadSection}
          mode={tempRoadMode}
          project={selectedProjectSection}
          driveways={selectedDrivewaysSection}
          combined={selectedCombinedSection}
          onClose={() => setSelectedTempRoadSection(null)}
        />
      )}
    </section>
  )
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-secondary">— <b className={bold ? 'text-text-primary' : ''}>{label}</b>: </span>
      <span className="font-mono font-semibold text-text-primary">{value}</span>
    </div>
  )
}

function KpiBig({ label, value, unit, colorClass, onClick }: {
  label: string; value: string; unit?: string; colorClass?: string; onClick?: () => void
}) {
  const content = (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5">
        <span className={`min-w-0 break-words text-[24px] font-bold font-heading leading-none sm:text-3xl ${colorClass ?? 'text-text-primary'}`}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-text-muted font-mono sm:text-sm">{unit}</span>}
      </div>
      <div className="mt-1.5 text-[10px] leading-tight text-gray-500 uppercase tracking-wider sm:text-xs">
        {label}
      </div>
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="min-h-[104px] rounded-lg border border-border bg-white p-2.5 text-left transition hover:border-accent-red/50 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-red/20 sm:min-h-[114px] sm:p-3"
      >
        {content}
      </button>
    )
  }
  return (
    <div className="min-h-[104px] rounded-lg border border-border bg-white p-2.5 sm:min-h-[114px] sm:p-3">
      {content}
    </div>
  )
}

function donutGradient(slices: DonutSlice[]): string {
  const total = slices.reduce((sum, item) => sum + Math.max(0, Number(item.value || 0)), 0)
  if (total <= 0) return '#e5e7eb 0 100%'
  let cursor = 0
  return slices
    .map(slice => {
      const start = cursor
      const end = cursor + Math.max(0, Number(slice.value || 0)) / total * 100
      cursor = end
      return `${slice.color} ${start.toFixed(3)}% ${end.toFixed(3)}%`
    })
    .join(', ')
}

function donutSegmentKeyAt(slices: DonutSlice[], clientX: number, clientY: number, rect: DOMRect): string | undefined {
  const total = slices.reduce((sum, item) => sum + Math.max(0, Number(item.value || 0)), 0)
  if (total <= 0) return undefined
  const x = clientX - rect.left - rect.width / 2
  const y = clientY - rect.top - rect.height / 2
  const radius = Math.sqrt(x * x + y * y)
  if (radius < rect.width * 0.22) return undefined
  const angle = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360
  let cursor = 0
  for (const slice of slices) {
    const size = Math.max(0, Number(slice.value || 0)) / total * 360
    if (angle >= cursor && angle <= cursor + size) return slice.key
    cursor += size
  }
  return slices.find(slice => Number(slice.value || 0) > 0)?.key
}

function IndustrialDonutCard({
  title,
  icon,
  slices,
  loading,
  centerLabel,
  onOpen,
}: {
  title: string
  icon: DonutKind | 'equipment'
  slices: DonutSlice[]
  loading?: boolean
  centerLabel: string
  onOpen: (segmentKey?: string) => void
}) {
  const total = slices.reduce((sum, item) => sum + Math.max(0, Number(item.value || 0)), 0)
  const Icon = icon === 'money' ? CircleDollarSign : icon === 'people' ? Users : icon === 'isso_support' ? Route : Truck
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group min-h-[288px] overflow-hidden rounded-lg border border-zinc-300 bg-[linear-gradient(135deg,#f8fafc_0%,#ffffff_44%,#eef2f7_100%)] p-4 text-left shadow-sm transition hover:border-accent-red/50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent-red/20 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-300 bg-zinc-900 text-white shadow-inner">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="font-heading text-sm font-semibold uppercase tracking-wide text-text-primary">{title}</div>
          <div className="mt-0.5 text-[11px] font-mono text-text-muted">{loading ? '...' : total > 0 ? centerLabel : '0'}</div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 items-center justify-items-center gap-3 sm:grid-cols-[190px_minmax(0,1fr)] sm:justify-items-stretch">
        <div
          className="relative h-[190px] w-[190px] cursor-pointer"
          onClick={event => {
            event.stopPropagation()
            onOpen(donutSegmentKeyAt(slices, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()))
          }}
        >
          <div className="absolute inset-x-5 bottom-2 h-10 rounded-full bg-slate-950/20 blur-md" />
          <div
            className="absolute inset-0 rounded-full border border-zinc-400 shadow-[inset_0_12px_24px_rgba(255,255,255,0.38),inset_0_-16px_22px_rgba(15,23,42,0.28),0_10px_18px_rgba(15,23,42,0.16)] transition group-hover:scale-[1.015]"
            style={{ background: loading ? '#e5e7eb' : `conic-gradient(${donutGradient(slices)})` }}
          />
          <div className="absolute inset-[40px] rounded-full border border-zinc-300 bg-white/95 shadow-[inset_0_8px_16px_rgba(15,23,42,0.08)]" />
          <div className="absolute inset-[58px] flex items-center justify-center rounded-full bg-zinc-950 text-center font-heading text-[13px] font-bold leading-tight text-white">
            {loading ? '...' : centerLabel}
          </div>
        </div>
        <div className="w-full min-w-0 space-y-1.5">
          {slices.map(slice => (
            <button
              key={slice.key}
              type="button"
              onClick={event => {
                event.stopPropagation()
                onOpen(slice.key)
              }}
              className="grid w-full grid-cols-[10px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-0.5 rounded-md border border-transparent px-1.5 py-1 text-left hover:border-border hover:bg-white/70"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm shadow-inner" style={{ backgroundColor: slice.color }} />
              <span className="min-w-0 truncate text-[10px] font-semibold leading-tight text-text-secondary">{slice.label}</span>
              <span className="col-start-2 min-w-0 break-words font-mono text-[10px] font-bold leading-tight text-text-primary sm:text-[11px]">{slice.valueLabel || fmt(slice.value)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function sortKpiRows(rows: KpiDetailRow[], sort: KpiSortState): KpiDetailRow[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    let result = 0
    if (sort.key === 'volume' || sort.key === 'plan_volume' || sort.key === 'completion_pct') {
      result = Number(a[sort.key] || 0) - Number(b[sort.key] || 0)
    } else {
      result = String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), 'ru')
    }
    return sort.dir === 'asc' ? result : -result
  })
  return sorted
}

function normalizeKpiRow(row: KpiDetailRow, section?: KpiDetailSection, type?: KpiDetailObjectType): KpiDetailRow {
  const sectionCode = row.section_code || section?.section_code || '—'
  return {
    ...row,
    section_code: sectionCode,
    section_label: kpiSectionLabel(sectionCode, row.section_label || section?.section_label),
    object_type_code: row.object_type_code || type?.object_type_code || '—',
    object_type_name: row.object_type_name || type?.object_type_name || 'Без типа',
  }
}

function normalizeKpiSection(section: KpiDetailSection): KpiDetailSection {
  const sectionLabel = kpiSectionLabel(section.section_code, section.section_label)
  return {
    ...section,
    section_label: sectionLabel,
    object_types: section.object_types.map(type => ({
      ...type,
      objects: type.objects.map(row => normalizeKpiRow(row, { ...section, section_label: sectionLabel }, type)),
    })),
  }
}

function sortKpiSections(sections: KpiDetailSection[]): KpiDetailSection[] {
  return sections
    .map(normalizeKpiSection)
    .sort((a, b) => (
      sectionSortValue(a.section_code) - sectionSortValue(b.section_code)
      || a.section_label.localeCompare(b.section_label, 'ru')
      || String(a.section_code || '').localeCompare(String(b.section_code || ''), 'ru')
    ))
}

function flattenKpiSectionRows(sections: KpiDetailSection[]): KpiDetailRow[] {
  return sections.flatMap(section => section.object_types.flatMap(type => type.objects.map(row => normalizeKpiRow(row, section, type))))
}

function kpiRowsTotal(rows: KpiDetailRow[], field: 'volume' | 'plan_volume'): number {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0)
}

function KpiVolumeCells({ row, emphasis = false }: { row: KpiVolumeLike; emphasis?: boolean }) {
  const valueClass = emphasis ? 'font-semibold text-text-primary' : 'text-text-primary'
  return (
    <>
      <td className={`px-3 py-2 text-right font-mono ${valueClass}`}>{fmt2(Number(row.plan_volume || 0))}</td>
      <td className={`px-3 py-2 text-right font-mono ${valueClass}`}>{fmt2(Number(row.volume || 0))}</td>
      <td className={`px-3 py-2 text-right font-mono font-semibold ${row.completion_pct == null ? 'text-text-muted' : pctColor(Number(row.completion_pct || 0))}`}>
        {fmtPctUnit(row.completion_pct)}
      </td>
    </>
  )
}

function KpiSectionTotalLabel({ section }: { section: KpiDetailSection }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-5 w-1 rounded bg-sky-600" />
      <span className="font-semibold text-text-primary">{section.section_label}</span>
    </div>
  )
}

function KpiChildIndent({ label = 'позиция' }: { label?: string }) {
  return (
    <div className="ml-4 border-l border-border pl-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
      {label}
    </div>
  )
}

function kpiShiftLabel(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'day') return 'День'
  if (normalized === 'night') return 'Ночь'
  return 'Смена не указана'
}

function kpiPlanPeriodLabel(detail: KpiSourceDetail): string {
  const start = formatRuDate(detail.period_start)
  const end = formatRuDate(detail.period_end)
  if (start && end) return start === end ? start : `${start} - ${end}`
  return start || end || 'Период не указан'
}

function KpiRowDetailModal({ row, unit, onClose }: { row: KpiDetailRow; unit: string; onClose: () => void }) {
  const details = row.details || []
  useCloseOnEscape(onClose)
  return (
    <div className="fixed inset-0 z-[1010] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-white shadow-2xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Объект, работа и источник объема</div>
            <h3 className="mt-0.5 text-base font-bold text-text-primary">{row.object_name || 'Без объекта'}</h3>
            <div className="mt-1 text-xs text-text-muted">{row.section_label} · план {fmt2(Number(row.plan_volume || 0))} {unit} · факт {fmt2(Number(row.volume || 0))} {unit}</div>
          </div>
          <button type="button" onClick={onClose} className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть детализацию строки">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-auto p-3">
          {details.length ? (
            <table className="w-full min-w-[760px] text-[12px]">
              <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Источник</th>
                  <th className="px-3 py-2 text-left font-semibold">Объект</th>
                  <th className="px-3 py-2 text-left font-semibold">Работа</th>
                  <th className="px-3 py-2 text-left font-semibold">Дата / смена</th>
                  <th className="px-3 py-2 text-right font-semibold">Объем</th>
                </tr>
              </thead>
              <tbody>
                {details.map((detail, index) => (
                  <tr key={`${detail.kind}-${detail.report_id || detail.plan_item_id || index}-${index}`} className="border-t border-border/60">
                    <td className="px-3 py-2 font-semibold text-text-primary">{detail.kind === 'fact' ? 'Отчет' : 'План'}</td>
                    <td className="px-3 py-2 text-text-secondary">{detail.object_name || row.object_name || 'Без объекта'}</td>
                    <td className="px-3 py-2 text-text-secondary">{detail.work_type_name || 'Работа не указана'}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {detail.kind === 'fact'
                        ? `${formatRuDate(detail.report_date) || 'Дата не указана'} · ${kpiShiftLabel(detail.shift)}`
                        : kpiPlanPeriodLabel(detail)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{fmt2(Number(detail.volume || 0))} {unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-10 text-center text-sm text-text-muted">Для строки нет исходных записей.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function SandDeliveryDetail({
  detail,
  sort,
  onSort,
  onOpenRow,
}: {
  detail: KpiDetailResponse
  sort: KpiSortState
  onSort: (key: KpiSortKey) => void
  onOpenRow: (row: KpiDetailRow) => void
}) {
  const sourceRows = useMemo(() => (
    detail.source_rows?.length
      ? detail.source_rows.map(row => normalizeKpiRow(row))
      : flattenKpiSectionRows(detail.source_sections || [])
  ), [detail.source_rows, detail.source_sections])
  const objectSections = useMemo(() => sortKpiSections(detail.sections || []), [detail.sections])
  const objectRows = useMemo(() => flattenKpiSectionRows(objectSections), [objectSections])
  const sourceFact = Number(detail.source_fact_total ?? detail.source_total ?? kpiRowsTotal(sourceRows, 'volume'))
  const objectPlan = Number(detail.plan_total ?? kpiRowsTotal(objectRows, 'plan_volume'))
  const objectFact = Number(detail.fact_total ?? kpiRowsTotal(objectRows, 'volume'))
  const completion = detail.completion_pct ?? (objectPlan > 0 ? objectFact / objectPlan * 100 : null)

  return (
    <div className="min-h-0 overflow-auto p-3">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TempRoadModalStat label="План по объектам" value={`${fmt2(objectPlan)} ${detail.unit}`} />
        <TempRoadModalStat label="Факт по объектам" value={`${fmt2(objectFact)} ${detail.unit}`} />
        <TempRoadModalStat label="% выполнения плана" value={fmtPctUnit(completion)} />
        <TempRoadModalStat label="Вывоз с карьеров" value={`${fmt2(sourceFact)} ${detail.unit}`} />
      </div>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Вывоз с карьеров</div>
      <table className="mb-5 w-full min-w-[760px] text-[12px]">
        <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Карьер / источник</th>
            <th className="px-3 py-2 text-right font-semibold">План</th>
            <th className="px-3 py-2 text-right font-semibold">Факт</th>
            <th className="px-3 py-2 text-right font-semibold">% выполнения</th>
          </tr>
        </thead>
        <tbody>
          {sourceRows.length ? sourceRows.map((row, index) => (
            <tr key={`source-${row.section_code}-${row.object_code}-${index}`} className="cursor-pointer border-t border-border/60 hover:bg-bg-surface/70" onClick={() => onOpenRow(row)} title="Открыть детализацию">
              <td className="px-3 py-2 text-text-secondary">{row.object_name || row.object_code || '—'}</td>
              <KpiVolumeCells row={row} />
            </tr>
          )) : (
            <tr>
              <td className="px-3 py-8 text-center text-text-muted" colSpan={4}>Нет фактов вывоза с карьеров за выбранный период.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Планы и факты завоза по объектам</div>
      <table className="w-full min-w-[920px] text-[12px]">
        <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Участок / уровень</th>
            <KpiHeader sortKey="object_type_name" sort={sort} onSort={onSort} />
            <KpiHeader sortKey="object_name" sort={sort} onSort={onSort} />
            <KpiHeader sortKey="plan_volume" sort={sort} onSort={onSort} align="right" />
            <KpiHeader sortKey="volume" sort={sort} onSort={onSort} align="right" />
            <KpiHeader sortKey="completion_pct" sort={sort} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {objectSections.length ? objectSections.map(section => {
            const rows = sortKpiRows(flattenKpiSectionRows([section]), sort)
            return (
              <Fragment key={section.section_code}>
                <tr key={`${section.section_code}-total`} className="border-y border-sky-200 bg-sky-50/80">
                  <td className="px-3 py-2"><KpiSectionTotalLabel section={section} /></td>
                  <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-sky-900" colSpan={2}>Итого по участку</td>
                  <KpiVolumeCells row={section} emphasis />
                </tr>
                {rows.map((row, index) => (
                  <tr key={`object-${row.section_code}-${row.object_type_code}-${row.object_code}-${index}`} className="cursor-pointer border-t border-border/60 hover:bg-bg-surface/70" onClick={() => onOpenRow(row)} title="Открыть детализацию">
                    <td className="px-3 py-2"><KpiChildIndent /></td>
                    <td className="px-3 py-2 text-text-secondary">{row.object_type_name || row.object_type_code || '—'}</td>
                    <td className="px-3 py-2 text-text-secondary">{row.object_name || row.object_code || '—'}</td>
                    <KpiVolumeCells row={row} />
                  </tr>
                ))}
              </Fragment>
            )
          }) : (
            <tr>
              <td className="px-3 py-8 text-center text-text-muted" colSpan={6}>Нет объектных строк завоза песка за выбранный период.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function KpiDetailModal({
  card,
  detail,
  loading,
  selectedSection,
  sort,
  onSelectSection,
  onSort,
  onOpenTempRoadSection,
  onClose,
}: {
  card: KpiCardSpec
  detail?: KpiDetailResponse
  loading: boolean
  selectedSection: string | null
  sort: KpiSortState
  onSelectSection: (sectionCode: string) => void
  onSort: (key: KpiSortKey) => void
  onOpenTempRoadSection: (sectionCode: string) => void
  onClose: () => void
}) {
  const [selectedRow, setSelectedRow] = useState<KpiDetailRow | null>(null)
  useCloseOnEscape(onClose)
  const sections = useMemo(() => sortKpiSections(detail?.sections || []), [detail?.sections])
  const activeSectionCode = selectedSection || sections[0]?.section_code || null
  const activeSection = sections.find(section => section.section_code === activeSectionCode)
  const activeRows = useMemo(() => sortKpiRows(
    activeSection ? flattenKpiSectionRows([activeSection]) : [],
    sort,
  ), [activeSection, sort])
  const isTempRoad = card.metric === 'temp_roads_passable'
  const isSandDelivery = card.metric === 'sand_delivery'
  const hasSandSourceRows = isSandDelivery && Boolean(detail?.source_rows?.length || detail?.source_sections?.length)
  const hasDetailRows = sections.length > 0 || hasSandSourceRows

  function openRow(row: KpiDetailRow) {
    if (row.details?.length) {
      setSelectedRow(row)
      return
    }
    if (isTempRoad) onOpenTempRoadSection(row.section_code)
  }

  function selectSection(sectionCode: string) {
    setSelectedRow(null)
    onSelectSection(sectionCode)
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-white shadow-2xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Детализация KPI</div>
            <h2 className="mt-0.5 font-heading text-lg font-bold text-text-primary">{card.label}</h2>
            <div className="mt-1 font-mono text-xs text-text-muted">{card.value} {card.unit || detail?.unit || ''}</div>
          </div>
          <button type="button" onClick={onClose} className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="m-4 h-72 rounded-lg border border-border bg-bg-surface animate-pulse" />
        ) : !detail || !hasDetailRows ? (
          <div className="m-4 rounded-lg border border-border bg-bg-surface px-4 py-10 text-center text-sm text-text-muted">Нет данных за выбранный период.</div>
        ) : isSandDelivery ? (
          <SandDeliveryDetail detail={detail} sort={sort} onSort={onSort} onOpenRow={openRow} />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[300px_1fr]">
            <div className="overflow-auto border-b border-border bg-bg-surface/40 p-3 lg:border-b-0 lg:border-r">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Участки</div>
              <div className="space-y-1">
                {sections.map(section => {
                  const isActive = section.section_code === activeSectionCode
                  return (
                    <button
                      key={section.section_code}
                      type="button"
                      onClick={() => selectSection(section.section_code)}
                      onDoubleClick={() => { if (isTempRoad) onOpenTempRoadSection(section.section_code) }}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition ${isActive ? 'border-accent-red bg-white shadow-sm' : 'border-transparent hover:border-border hover:bg-white'}`}
	                    >
	                      <span className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{section.section_label}</span>
	                      <span className="font-mono text-xs text-text-secondary">{fmt2(Number(section.plan_volume || 0))}</span>
	                    </button>
                  )
                })}
              </div>
            </div>

            <div className="min-h-0 overflow-auto p-3">
	              {activeSection && (
	                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
	                  <TempRoadModalStat label="Участок" value={activeSection.section_label} />
	                  <TempRoadModalStat label="План" value={`${fmt2(Number(activeSection.plan_volume || 0))} ${detail.unit}`} />
	                  <TempRoadModalStat label="Факт" value={`${fmt2(Number(activeSection.volume || 0))} ${detail.unit}`} />
	                  <TempRoadModalStat label="% выполнения плана" value={fmtPctUnit(activeSection.completion_pct)} />
	                </div>
	              )}
	              <table className="w-full min-w-[860px] text-[12px]">
	                <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
	                  <tr>
	                    <KpiHeader sortKey="object_type_name" sort={sort} onSort={onSort} />
	                    <KpiHeader sortKey="object_name" sort={sort} onSort={onSort} />
	                    <KpiHeader sortKey="plan_volume" sort={sort} onSort={onSort} align="right" />
	                    <KpiHeader sortKey="volume" sort={sort} onSort={onSort} align="right" />
	                    <KpiHeader sortKey="completion_pct" sort={sort} onSort={onSort} align="right" />
	                  </tr>
	                </thead>
                <tbody>
                  {activeSection && (
                    <tr className="border-y border-sky-200 bg-sky-50/80">
                      <td className="px-3 py-2" colSpan={2}><KpiSectionTotalLabel section={activeSection} /></td>
                      <KpiVolumeCells row={activeSection} emphasis />
                    </tr>
                  )}
                  {activeRows.length ? activeRows.map((row, index) => (
                    <tr
                      key={`${row.section_code}-${row.object_type_code}-${row.object_code}-${index}`}
                      className={`border-t border-border/60 ${row.details?.length || isTempRoad ? 'cursor-pointer hover:bg-bg-surface/70' : ''}`}
                      onClick={() => openRow(row)}
                      title={row.details?.length ? 'Открыть детализацию' : undefined}
                    >
		                      <td className="px-3 py-2 font-semibold text-text-primary">
		                        <div className="ml-4 border-l border-border pl-3">{row.object_type_name || row.object_type_code || '—'}</div>
		                      </td>
		                      <td className="px-3 py-2 text-text-secondary">{row.object_name || row.object_code || '—'}</td>
		                      <KpiVolumeCells row={row} />
		                    </tr>
	                  )) : (
	                    <tr>
	                      <td className="px-3 py-8 text-center text-text-muted" colSpan={5}>По участку нет строк детализации.</td>
	                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {selectedRow && <KpiRowDetailModal row={selectedRow} unit={detail?.unit || card.unit || ''} onClose={() => setSelectedRow(null)} />}
      </div>
    </div>
  )
}

function KpiHeader({ sortKey, sort, onSort, align = 'left' }: {
  sortKey: KpiSortKey
  sort: KpiSortState
  onSort: (key: KpiSortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === sortKey
  return (
    <th className={`px-3 py-2 font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 ${active ? 'text-accent-red' : 'hover:text-text-primary'}`}
      >
        {kpiSortLabel(sortKey)}
        {active && <span className="font-mono">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
}

function DonutDetailsModal({
  selection,
  issoSupport,
  money,
  equipment,
  staff,
  from,
  to,
  onClose,
}: {
  selection: DonutSelection
  issoSupport?: IssoSupportResponse
  money?: MoneyPlanFactResponse
  equipment?: EquipmentPulseResponse
  staff?: StaffResourcesData
  from: string
  to: string
  onClose: () => void
}) {
  const isIssoSupport = selection.kind === 'isso_support'
  useCloseOnEscape(onClose)
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/45 p-2 sm:p-3" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className={`flex w-full flex-col overflow-hidden rounded-lg border border-border bg-white shadow-2xl ${isIssoSupport ? 'h-[calc(100vh-16px)] max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] sm:h-[calc(100vh-24px)] sm:max-h-[calc(100vh-24px)]' : 'max-h-[92vh] max-w-6xl'}`} onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Детализация диаграммы</div>
            <h2 className="mt-0.5 font-heading text-lg font-bold text-text-primary">{selection.title}</h2>
          </div>
          <button type="button" onClick={onClose} className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={`min-h-0 ${isIssoSupport ? 'flex-1 overflow-hidden p-3' : 'overflow-auto p-4'}`}>
          {selection.kind === 'isso_support' && <IssoSupportDetails data={issoSupport} segmentKey={selection.segmentKey} from={from} to={to} />}
          {selection.kind === 'money' && <MoneyDetails money={money} segmentKey={selection.segmentKey} />}
          {selection.kind === 'equipment' && <EquipmentDonutDetails equipment={equipment} segmentKey={selection.segmentKey as EquipmentStatus | undefined} />}
          {selection.kind === 'people' && <PeopleDonutDetails staff={staff} segmentKey={selection.segmentKey} />}
        </div>
      </div>
    </div>
  )
}


function IssoSupportDetails({ data, segmentKey, from, to }: { data?: IssoSupportResponse; segmentKey?: string; from: string; to: string }) {
  const [selectedSectionCode, setSelectedSectionCode] = useState<string | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<string>(() => monthStartFromDate(to))
  const shouldLoadMonth = Boolean(data?.available && selectedMonth && selectedMonth !== data.target_month)
  const { data: selectedMonthData, isLoading: isMonthLoading } = useQuery<IssoSupportResponse>({
    queryKey: ['wip', 'dashboard', 'isso-support', from, to, selectedMonth],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, month: selectedMonth })
      return fetch(`/api/wip/dashboard/isso-support?${params.toString()}`).then(r => r.json())
    },
    enabled: shouldLoadMonth,
    staleTime: DASHBOARD_BLOCK_STALE_MS,
    gcTime: DASHBOARD_BLOCK_GC_MS,
    refetchOnWindowFocus: false,
  })
  const activeData = shouldLoadMonth && selectedMonthData ? selectedMonthData : data

  if (!data || !activeData) return <div className="h-60 rounded-lg border border-border bg-bg-surface animate-pulse" />
  if (!activeData.available) {
    return (
      <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-text-secondary">
        {activeData.detail || 'Нет данных расширенного отчета ИССО.'}
      </div>
    )
  }

  const segmentPriority = (item: IssoSupportIsso) => {
    const sitesTotal = Number(item.sites_total || 0)
    const sitesDone = issoShpgsDone(item)
    if (segmentKey === 'done') return sitesDone > 0 ? 0 : 1
    if (segmentKey === 'remaining') return Math.max(sitesTotal - sitesDone, 0) > 0 ? 0 : 1
    return 0
  }
  const sections = activeData.sections
    .map(section => {
      const issos = [...(section.issos || [])].sort((a, b) => segmentPriority(a) - segmentPriority(b))
      const total = (key: keyof IssoSupportIsso) => issos.reduce((sum, item) => sum + Number(item[key] || 0), 0)
      return {
        ...section,
        objects: issos.length,
        supports_total: total('supports_total'),
        supports_done: total('supports_done'),
        fact_supports_total: total('fact_supports_total'),
        sites_total: total('sites_total'),
        sites_done: total('sites_done'),
        sites_sand_done: total('sites_sand_done'),
        sites_shpgs_done: total('sites_shpgs_done'),
        current_month_plan: total('current_month_plan'),
        current_month_done: total('current_month_done'),
        current_month_sand_done: total('current_month_sand_done'),
        current_month_shpgs_done: total('current_month_shpgs_done'),
        issos,
      }
    })
    .filter(section => section.issos.length > 0)
  const effectiveSectionCode = selectedSectionCode && sections.some(section => section.section_code === selectedSectionCode)
    ? selectedSectionCode
    : null
  const visibleSections = effectiveSectionCode
    ? sections.filter(section => section.section_code === effectiveSectionCode)
    : sections
  const monthLabel = activeData.target_month_label || monthLabelFromValue(selectedMonth)
  const targetMonthMaterialKind = activeData.target_month_material_kind || 'shpgs'
  const baseMonthOptions = activeData.months?.length ? activeData.months : (data.months || [])
  const monthOptions = selectedMonth && !baseMonthOptions.some(option => option.value === selectedMonth)
    ? [...baseMonthOptions, { value: selectedMonth, label: monthLabelFromValue(selectedMonth) }]
    : baseMonthOptions

  if (!sections.length) {
    return (
      <div className="space-y-3">
        <IssoMonthSelector
          value={selectedMonth}
          defaultValue={data.target_month || monthStartFromDate(to)}
          options={monthOptions}
          loading={isMonthLoading}
          onChange={setSelectedMonth}
          onReset={() => setSelectedMonth(data.target_month || monthStartFromDate(to))}
        />
        <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-text-secondary">
          По выбранному сегменту нет ИССО для отображения.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-surface/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">График площадок ИССО</div>
          <div className="mt-0.5 text-sm font-semibold text-text-primary">План и факт по площадкам</div>
        </div>
        <IssoMonthSelector
          value={selectedMonth}
          defaultValue={data.target_month || monthStartFromDate(to)}
          options={monthOptions}
          loading={isMonthLoading}
          onChange={setSelectedMonth}
          onReset={() => setSelectedMonth(data.target_month || monthStartFromDate(to))}
        />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <TempRoadModalStat label="Площадок всего" value={fmt(Number(activeData.totals.sites_total || 0))} />
        <TempRoadModalStat label="Отсыпано в песке" value={fmt(Number(activeData.totals.sites_sand_done || 0))} />
        <TempRoadModalStat label="Отсыпано в ЩПГС" value={fmt(issoShpgsDone(activeData.totals))} />
        <TempRoadModalStat label={`План ${monthLabel}`} value={fmt(Number(activeData.totals.current_month_plan || 0))} />
        <TempRoadModalStat label={issoMonthFactLabel(activeData.totals, monthLabel, targetMonthMaterialKind)} value={fmt(Number(activeData.totals.current_month_done || 0))} />
      </div>
      <IssoStatusLegend />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-surface/60">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Участки
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
            <button
              type="button"
              onClick={() => setSelectedSectionCode(null)}
              className={`w-full rounded-md border px-3 py-2 text-left transition ${effectiveSectionCode == null ? 'border-accent-red bg-white shadow-sm' : 'border-transparent hover:border-border hover:bg-white'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-text-primary">Все участки</span>
                <span className="font-mono text-xs text-text-secondary">{fmt(sections.reduce((sum, section) => sum + section.objects, 0))}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
                    <span>ЩПГС</span>
                    <span className="font-mono text-text-secondary">{fmt(sections.reduce((sum, section) => sum + issoShpgsDone(section), 0))}/{fmt(sections.reduce((sum, section) => sum + section.sites_total, 0))}</span>
              </div>
            </button>
            {sections.map(section => {
              const isActive = section.section_code === effectiveSectionCode
              const showMonthProgress = shouldShowIssoMonthProgress(section)
              return (
                <button
                  key={section.section_code}
                  type="button"
                  onClick={() => setSelectedSectionCode(section.section_code)}
                  className={`w-full rounded-md border px-3 py-2 text-left transition ${isActive ? 'border-accent-red bg-white shadow-sm' : 'border-transparent hover:border-border hover:bg-white'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{section.section_label}</span>
                    <span className="font-mono text-xs text-text-secondary">{fmt(section.objects)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
                      <span>ЩПГС</span>
                      <span className="font-mono text-text-secondary">{fmt(issoShpgsDone(section))}/{fmt(section.sites_total)}</span>
                  </div>
                  {showMonthProgress && (
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-text-muted">
                      <span>{issoMonthFactLabel(section, monthLabel, targetMonthMaterialKind)}</span>
                      <span className="font-mono text-text-secondary">{fmt(section.current_month_done)}/{fmt(section.current_month_plan)}</span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="min-w-0 overflow-auto pr-1">
          <div className="space-y-4">
            {visibleSections.map(section => (
              <section key={section.section_code} className="rounded-lg border border-border bg-white">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-surface/70 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Участок</div>
                    <h3 className="mt-0.5 truncate font-heading text-base font-bold text-text-primary">{section.section_label}</h3>
                  </div>
                  <IssoSectionMetric label="ИССО" value={fmt(section.objects)} />
                  <IssoSectionMetric label="Песок" value={fmt(section.sites_sand_done)} />
                  <IssoSectionMetric label="ЩПГС" value={`${fmt(issoShpgsDone(section))}/${fmt(section.sites_total)}`} />
                  {shouldShowIssoMonthProgress(section) && <IssoSectionMetric label={issoMonthFactLabel(section, monthLabel, targetMonthMaterialKind)} value={`${fmt(section.current_month_done)}/${fmt(section.current_month_plan)}`} />}
                </div>
                <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2 2xl:grid-cols-3">
                  {section.issos.map(item => (
                    <IssoObjectCard key={`${item.section_code}-${item.object_no}-${item.object_code}`} item={item} monthLabel={monthLabel} targetMonthMaterialKind={targetMonthMaterialKind} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function IssoMonthSelector({ value, defaultValue, options, loading, onChange, onReset }: {
  value: string
  defaultValue: string
  options: IssoSupportMonthOption[]
  loading: boolean
  onChange: (value: string) => void
  onReset: () => void
}) {
  const normalizedOptions = options.length ? options : [{ value, label: monthLabelFromValue(value) }]
  const canReset = Boolean(defaultValue && value !== defaultValue)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <span>Отображаемый месяц</span>
        <select
          value={value}
          onChange={event => onChange(event.target.value)}
          className="h-8 rounded-md border border-border bg-white px-2 text-xs font-semibold normal-case tracking-normal text-text-primary shadow-sm outline-none focus:border-accent-red"
        >
          {normalizedOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onReset}
        disabled={!canReset}
        className="h-8 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-text-secondary shadow-sm transition hover:border-accent-red hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border disabled:hover:text-text-secondary"
      >
        Сбросить
      </button>
      {loading && <span className="text-[11px] text-text-muted">обновляю...</span>}
    </div>
  )
}

function IssoSectionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[92px] rounded-md border border-border bg-white px-2.5 py-1.5 text-right">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-xs font-semibold text-text-primary">{value}</div>
    </div>
  )
}

function IssoStatusLegend() {
  const items: Array<{ status: IssoStatus; label: string }> = [
    { status: 'ready', label: 'площадки готовы в ЩПГС' },
    { status: 'sand', label: 'отсыпано в песке' },
    { status: 'shpgs_partial', label: 'частично отсыпано в ЩПГС' },
    { status: 'no_rd', label: 'нет РД' },
    { status: 'idle_with_rd', label: 'РД есть, работы не производятся' },
  ]
  return (
    <div className="mb-3 flex flex-wrap gap-2 rounded-lg border border-border bg-white px-3 py-2">
      {items.map(item => (
        <div key={item.status} className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
          <span className={`h-3 w-3 rounded-sm border ${issoLegendSwatchClasses(item.status)}`} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function issoLineStatus(row: IssoSupportLineRow): IssoStatus {
  const status = String(row.status || '').toLowerCase()
  if (status === 'sand' || issoSandDone(row) > 0) return 'sand'
  if (status === 'no_rd' || row.rd_status === 'missing') return 'no_rd'
  if (status === 'ready' || isIssoSitesComplete(row)) return 'ready'
  if (status === 'shpgs_partial' || issoShpgsDone(row) > 0) return 'shpgs_partial'
  if (status === 'idle_with_rd') return 'idle_with_rd'
  if (status === 'gray') return 'gray'
  if (row.rd_status !== 'missing') return 'idle_with_rd'
  if (status === 'red') return 'idle_with_rd'
  if (status === 'green') return 'ready'
  if (status === 'blue') return 'shpgs_partial'
  return 'unknown'
}

function issoCardStatus(item: IssoSupportIsso): IssoStatus {
  const statuses = item.rows.map(issoLineStatus)
  if (issoSandDone(item) > 0 || statuses.includes('sand')) return 'sand'
  if (statuses.includes('no_rd')) return 'no_rd'
  if (isIssoSitesComplete(item)) return 'ready'
  if (issoShpgsDone(item) > 0 || statuses.includes('ready') || statuses.includes('shpgs_partial')) return 'shpgs_partial'
  if (statuses.includes('idle_with_rd')) return 'idle_with_rd'
  if (statuses.every(status => status === 'gray')) return 'gray'
  return 'unknown'
}

function issoStatusClasses(status: IssoStatus): string {
  if (status === 'ready') return 'border-emerald-500 bg-emerald-50/95'
  if (status === 'no_rd') return 'border-black bg-rose-100/90'
  if (status === 'idle_with_rd') return 'border-red-400 bg-red-50/90'
  if (status === 'sand') return 'border-yellow-400 bg-yellow-50/90'
  if (status === 'shpgs_partial') return 'border-blue-400 bg-blue-50/90'
  if (status === 'gray') return 'border-slate-300 bg-slate-50/90'
  return 'border-border bg-white'
}

function issoAccentClass(status: IssoStatus): string {
  if (status === 'ready') return 'bg-emerald-500'
  if (status === 'no_rd') return 'bg-red-700'
  if (status === 'idle_with_rd') return 'bg-red-500'
  if (status === 'sand') return 'bg-yellow-500'
  if (status === 'shpgs_partial') return 'bg-blue-500'
  if (status === 'gray') return 'bg-slate-400'
  return 'bg-slate-300'
}

function issoLegendSwatchClasses(status: IssoStatus): string {
  if (status === 'ready') return 'border-emerald-600 bg-emerald-200'
  if (status === 'no_rd') return 'border-black bg-rose-300'
  if (status === 'idle_with_rd') return 'border-red-500 bg-red-200'
  if (status === 'sand') return 'border-yellow-500 bg-yellow-200'
  if (status === 'shpgs_partial') return 'border-blue-500 bg-blue-200'
  if (status === 'gray') return 'border-slate-400 bg-slate-100'
  return 'border-border bg-white'
}

function issoFillMaterialBadgeClasses(kind?: string): string {
  if (kind === 'sand') return 'border-yellow-300 bg-yellow-100 text-yellow-900'
  if (kind === 'shpgs') return 'border-blue-300 bg-blue-100 text-blue-900'
  return 'border-slate-200 bg-slate-100 text-slate-700'
}

function issoShpgsDone(row: { sites_done?: number; sites_shpgs_done?: number }): number {
  return Number(row.sites_shpgs_done ?? row.sites_done ?? 0)
}

function issoSandDone(row: { sites_sand_done?: number }): number {
  return Number(row.sites_sand_done || 0)
}

function isIssoSitesComplete(row: { sites_total: number; sites_done?: number; sites_shpgs_done?: number }): boolean {
  return Number(row.sites_total || 0) > 0 && issoShpgsDone(row) >= Number(row.sites_total || 0)
}

function shouldShowIssoMonthProgress(row: { sites_total: number; sites_done: number; current_month_plan: number; current_month_done: number }): boolean {
  if (Number(row.current_month_plan || 0) > 0 || Number(row.current_month_done || 0) > 0) return true
  return !isIssoSitesComplete(row)
}

function rdStatusLabel(status: string): string {
  if (status === 'missing') return 'нет РД'
  return 'РД есть'
}

function issoSupportTitle(row: IssoSupportLineRow): string {
  const label = String(row.support_label || row.target_month_support_label || '').trim()
  return label || 'Опоры не указаны'
}

function issoFactMonthsLabel(row: IssoSupportLineRow): string {
  const months = row.fact_months || []
  if (!months.length) return ''
  return months.map(month => {
    const material = month.material_kind === 'sand' ? 'песок' : month.material_kind === 'shpgs' ? 'ЩПГС' : ''
    return `${fmt(Number(month.sites || 0))} площ. ${month.label}${material ? ` (${material})` : ''}`
  }).join(' · ')
}

function issoMonthFactLabel(
  row: { current_month_sand_done?: number; current_month_shpgs_done?: number },
  monthLabel: string,
  configuredKind = '',
): string {
  const sand = Number(row.current_month_sand_done || 0)
  const shpgs = Number(row.current_month_shpgs_done || 0)
  const materialKind = sand > 0 && shpgs === 0
    ? 'sand'
    : shpgs > 0 && sand === 0
      ? 'shpgs'
      : sand > 0 && shpgs > 0
        ? 'mixed'
        : configuredKind
  const title = materialKind === 'sand' ? 'Песок' : materialKind === 'shpgs' ? 'ЩПГС' : 'Факт'
  return `${title} ${monthLabel}`
}

function IssoObjectCard({ item, monthLabel, targetMonthMaterialKind }: {
  item: IssoSupportIsso
  monthLabel: string
  targetMonthMaterialKind: string
}) {
  const cardStatus = issoCardStatus(item)
  const showItemMonthProgress = shouldShowIssoMonthProgress(item)
  return (
    <article className={`relative overflow-hidden rounded-lg border p-3 shadow-sm ${issoStatusClasses(cardStatus)}`}>
      <div className={`absolute bottom-0 left-0 top-0 w-1 ${issoAccentClass(cardStatus)}`} />
      <div className="pl-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="font-heading text-sm font-bold leading-snug text-text-primary">
              {item.object_no ? `№${item.object_no} · ` : ''}{item.object_name || 'ИССО'}
            </h4>
            <div className="mt-0.5 text-[11px] font-semibold text-text-secondary">
              {item.pk_label || 'ПК не задан'}
            </div>
          </div>
          <div className="rounded-md border border-border bg-white/80 px-2 py-1 text-right">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">ЩПГС</div>
            <div className="font-mono text-xs font-bold text-text-primary">{fmt(issoShpgsDone(item))}/{fmt(item.sites_total)}</div>
          </div>
        </div>

        {showItemMonthProgress && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <IssoTinyStat label={`План ${monthLabel}`} value={fmt(item.current_month_plan)} />
            <IssoTinyStat label={issoMonthFactLabel(item, monthLabel, targetMonthMaterialKind)} value={fmt(item.current_month_done)} />
          </div>
        )}

        <div className="mt-3 space-y-2">
          {item.rows.map(row => {
            const lineStatus = issoLineStatus(row)
            const factMonths = issoFactMonthsLabel(row)
            const showMonthProgress = shouldShowIssoMonthProgress(row)
            const fillMaterials = row.fill_materials?.length
              ? row.fill_materials
              : row.fill_material_label
                ? [{ kind: row.fill_material_kind || '', label: row.fill_material_label, sites: row.fill_material_kind === 'sand' ? issoSandDone(row) : issoShpgsDone(row) }]
                : []
            return (
              <div key={row.line_id} className={`rounded-md border px-2.5 py-2 ${issoStatusClasses(lineStatus)}`}>
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                  <div className="min-w-0 flex-1 font-semibold text-[12px] leading-snug text-text-primary">
                    {issoSupportTitle(row)}
                  </div>
                  <span className="rounded border border-border bg-white/80 px-1.5 py-0.5 font-mono text-[10px] text-text-primary">
                    ЩПГС {fmt(issoShpgsDone(row))}/{fmt(row.sites_total)}
                  </span>
                  {showMonthProgress && (
                    <span className="rounded border border-border bg-white/80 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                      {issoMonthFactLabel(row, monthLabel, targetMonthMaterialKind)}: {fmt(row.current_month_done)}/{fmt(row.current_month_plan)}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${row.rd_status === 'missing' ? 'bg-red-100 text-red-800' : row.rd_status === 'available' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
                    {rdStatusLabel(row.rd_status)}
                  </span>
                  {lineStatus === 'ready' && (
                    <span className="rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900">
                      площадки готовы в ЩПГС
                    </span>
                  )}
                  {fillMaterials.map(material => (
                    <span key={material.kind} className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${issoFillMaterialBadgeClasses(material.kind)}`}>
                      {material.label}: {fmt(material.sites)} пл.
                    </span>
                  ))}
                  {lineStatus === 'idle_with_rd' && (
                    <span className="rounded border border-red-300 bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">
                      работы не производятся
                    </span>
                  )}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${row.ms11_scope ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-700'}`}>
                    Силами МС-11: {row.ms11_scope ? 'да' : 'нет'}
                  </span>
                  {row.ms11_working && (
                    <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-900">
                      МС11 производит работы
                    </span>
                  )}
                  {row.ms11_bridge_work && (
                    <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-900">
                      МС11 делает рабочий мост
                    </span>
                  )}
                  {row.deadline && row.deadline !== '-' && (
                    <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                      Срок выполнения: {formatRuDate(row.deadline)}
                    </span>
                  )}
                </div>
                {factMonths && (
                  <div className="mt-1.5 rounded border border-border bg-white/70 px-2 py-1 text-[10px] font-semibold leading-snug text-text-secondary">
                    Фактическая отсыпка: {factMonths}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </article>
  )
}

function IssoTinyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-white/80 px-2 py-1.5">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-xs font-semibold text-text-primary">{value}</div>
    </div>
  )
}

function MoneyDetails({ money, segmentKey }: { money?: MoneyPlanFactResponse; segmentKey?: string }) {
  const rows = (money?.rows || []).filter(row => {
    if (segmentKey === 'plan') return Math.abs(row.plan_amount) > 0.5
    if (segmentKey === 'fact') return Math.abs(row.fact_amount) > 0.5
    return Math.abs(row.plan_amount) + Math.abs(row.fact_amount) > 0.5
  })
  const missingWorkTypes = (money?.missing_work_types || []).filter(row => {
    if (segmentKey === 'plan') return Math.abs(row.plan_volume) > 0.000001
    if (segmentKey === 'fact') return Math.abs(row.fact_volume) > 0.000001
    return Math.abs(row.plan_volume) + Math.abs(row.fact_volume) > 0.000001
  })
  if (!money) return <div className="h-60 rounded-lg border border-border bg-bg-surface animate-pulse" />
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TempRoadModalStat label="План" value={fmtMoneyFull(money.plan_total)} />
        <TempRoadModalStat label="Факт" value={fmtMoneyFull(money.fact_total)} />
        <TempRoadModalStat label="Строк в деньгах" value={fmt(rows.length)} />
        <TempRoadModalStat label="Не учтено" value={`${fmt(missingWorkTypes.length)} типов`} />
      </div>
      <table className="w-full min-w-[980px] text-[12px]">
        <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Участок</th>
            <th className="px-3 py-2 text-left font-semibold">Тип объекта</th>
            <th className="px-3 py-2 text-left font-semibold">Объект</th>
            <th className="px-3 py-2 text-left font-semibold">Работа</th>
            <th className="px-3 py-2 text-right font-semibold">План</th>
            <th className="px-3 py-2 text-right font-semibold">Факт</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.section_code}-${row.object_name}-${row.work_type_name}-${index}`} className="border-t border-border/60">
              <td className="px-3 py-2 font-semibold text-text-primary">{row.section_label}</td>
              <td className="px-3 py-2 text-text-secondary">{row.object_type_name}</td>
              <td className="px-3 py-2 text-text-secondary">{row.object_name}</td>
              <td className="px-3 py-2 text-text-secondary">{row.work_type_name}</td>
              <td className="px-3 py-2 text-right font-mono text-text-primary">{fmtMoneyFull(row.plan_amount)}</td>
              <td className="px-3 py-2 text-right font-mono text-text-primary">{fmtMoneyFull(row.fact_amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missingWorkTypes.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Не учтено без расценки
          </div>
          <table className="w-full min-w-[900px] text-[12px]">
            <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Код</th>
                <th className="px-3 py-2 text-left font-semibold">Работа</th>
                <th className="px-3 py-2 text-left font-semibold">Ед.</th>
                <th className="px-3 py-2 text-right font-semibold">План объем</th>
                <th className="px-3 py-2 text-right font-semibold">Факт объем</th>
                <th className="px-3 py-2 text-right font-semibold">Строк</th>
                <th className="px-3 py-2 text-right font-semibold">Объектов</th>
              </tr>
            </thead>
            <tbody>
              {missingWorkTypes.map(row => (
                <tr key={row.work_type_id || row.work_type_code || row.work_type_name} className="border-t border-border/60">
                  <td className="px-3 py-2 font-mono text-text-muted">{row.work_type_code || '—'}</td>
                  <td className="px-3 py-2 font-semibold text-text-primary">{row.work_type_name || 'Работа'}</td>
                  <td className="px-3 py-2 text-text-secondary">{row.unit || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-primary">{fmt2(row.plan_volume || 0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-primary">{fmt2(row.fact_volume || 0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(row.row_count || 0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(row.object_count || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function EquipmentDonutDetails({ equipment, segmentKey }: { equipment?: EquipmentPulseResponse; segmentKey?: EquipmentStatus }) {
  if (!equipment) return <div className="h-60 rounded-lg border border-border bg-bg-surface animate-pulse" />
  const units = equipment.sections.flatMap(section => (section.units || []).map(unit => ({ ...unit, section_label: section.label })))
    .filter(unit => !segmentKey || unit.slot === segmentKey)
  return (
    <table className="w-full min-w-[900px] text-[12px]">
      <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
        <tr>
          <th className="px-3 py-2 text-left font-semibold">Участок</th>
          <th className="px-3 py-2 text-left font-semibold">Статус</th>
          <th className="px-3 py-2 text-left font-semibold">Тип</th>
          <th className="px-3 py-2 text-left font-semibold">Марка</th>
          <th className="px-3 py-2 text-left font-semibold">Госномер</th>
          <th className="px-3 py-2 text-left font-semibold">Комментарий</th>
        </tr>
      </thead>
      <tbody>
        {units.map((unit, index) => (
          <tr key={`${unit.section_label}-${unit.plate_number}-${unit.unit_number}-${index}`} className="border-t border-border/60">
            <td className="px-3 py-2 font-semibold text-text-primary">{unit.section_label}</td>
            <td className="px-3 py-2 text-text-secondary">{equipmentStatusLabel(unit.slot)}</td>
            <td className="px-3 py-2 text-text-secondary">{unit.equipment_type || '—'}</td>
            <td className="px-3 py-2 text-text-secondary">{unit.brand_model || '—'}</td>
            <td className="px-3 py-2 font-mono text-text-secondary">{unit.plate_number || unit.unit_number || '—'}</td>
            <td className="px-3 py-2 text-text-muted">{unit.comment || unit.location || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PeopleDonutDetails({ staff, segmentKey }: { staff?: StaffResourcesData; segmentKey?: string }) {
  if (!staff) return <div className="h-60 rounded-lg border border-border bg-bg-surface animate-pulse" />
  const cards = staffDisplayCards(staff)
  const valueFor = (counts: PeopleCounts) => {
    if (segmentKey === 'vacation_sick') return Number(counts.vacation_sick ?? 0) || Number(counts.vacation ?? 0) + Number(counts.sick ?? 0)
    if (segmentKey === 'at_work' || segmentKey === 'intershift') return Number(counts[segmentKey] ?? 0)
    return Number(counts.at_work ?? 0) + Number(counts.intershift ?? 0) + (Number(counts.vacation_sick ?? 0) || Number(counts.vacation ?? 0) + Number(counts.sick ?? 0))
  }
  return (
    <table className="w-full min-w-[720px] text-[12px]">
      <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
        <tr>
          <th className="px-3 py-2 text-left font-semibold">Участок/офис</th>
          <th className="px-3 py-2 text-right font-semibold">В работе</th>
          <th className="px-3 py-2 text-right font-semibold">Межвахта</th>
          <th className="px-3 py-2 text-right font-semibold">Отпуск/больничный</th>
          <th className="px-3 py-2 text-right font-semibold">Итого</th>
        </tr>
      </thead>
      <tbody>
        {cards
          .filter(card => !segmentKey || valueFor(card.counts || {}) > 0)
          .sort((a, b) => (a.section_num ?? 9999) - (b.section_num ?? 9999) || a.label.localeCompare(b.label, 'ru'))
          .map(card => {
            const vacationSick = Number(card.counts?.vacation_sick ?? 0) || Number(card.counts?.vacation ?? 0) + Number(card.counts?.sick ?? 0)
            return (
              <tr key={card.key || card.label} className="border-t border-border/60">
                <td className="px-3 py-2 font-semibold text-text-primary">{card.label}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(Number(card.counts?.at_work ?? 0))}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(Number(card.counts?.intershift ?? 0))}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(vacationSick)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{fmt(valueFor(card.counts || {}))}</td>
              </tr>
            )
          })}
      </tbody>
    </table>
  )
}


function TempRoadSectionDetailsModal({
  sectionNum,
  mode,
  project,
  driveways,
  combined,
  onClose,
}: {
  sectionNum: number
  mode: TempRoadMode
  project?: Stage3Section
  driveways?: Stage3Section
  combined?: Stage3Section
  onClose: () => void
}) {
  const active = mode === 'with_driveways' ? combined : project
  const details = mode === 'with_driveways'
    ? (combined?.details ?? [...(project?.details ?? []), ...(driveways?.details ?? [])])
    : (project?.details ?? [])
  useCloseOnEscape(onClose)

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-white shadow-xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Отсыпка временных дорог</div>
            <h2 className="mt-0.5 text-base font-semibold text-text-primary">Участок №{sectionNum}</h2>
          </div>
          <button type="button" onClick={onClose} className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-border bg-bg-surface/40 p-3 sm:grid-cols-4">
          <TempRoadModalStat label="L проектная а/д" value={`${fmt(project?.length_m ?? 0)} м`} />
          <TempRoadModalStat label="L непроектные проезды" value={`${fmt(driveways?.length_m ?? 0)} м`} />
          <TempRoadModalStat label="Lдоступно" value={`${fmt(active?.passable_m ?? 0)} м`} />
          <TempRoadModalStat label="Lготово" value={`${fmt(active?.ready_plus_done_m ?? 0)} м`} />
        </div>

        <div className="overflow-auto p-3">
          <table className="w-full min-w-[860px] text-[12px]">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-2 py-2 text-left font-semibold">Тип</th>
                <th className="px-2 py-2 text-left font-semibold">Дорога</th>
                <th className="px-2 py-2 text-left font-semibold">АД ПК</th>
                <th className="px-2 py-2 text-left font-semibold">ВСЖМ ПК</th>
                <th className="px-2 py-2 text-right font-semibold">L проектная а/д, м</th>
                <th className="px-2 py-2 text-right font-semibold">L непроектные проезды, м</th>
                <th className="px-2 py-2 text-right font-semibold">Lдоступно, м</th>
                <th className="px-2 py-2 text-right font-semibold">Lготово, м</th>
                <th className="px-2 py-2 text-right font-semibold">ЩПГС, м</th>
              </tr>
            </thead>
            <tbody>
              {details.length ? details.map((detail, index) => {
                const isDriveway = detail.group === 'driveways'
                return (
                  <tr key={`${detail.group}-${detail.road_id || detail.road_code || index}-${detail.ad_pk_start ?? index}`} className="border-b border-border/60">
                    <td className="px-2 py-2 text-text-secondary">{tempRoadGroupLabel(detail.group)}</td>
                    <td className="px-2 py-2 font-semibold text-text-primary">
                      {detail.road_code || '—'}{detail.road_name && detail.road_name !== detail.road_code ? ` · ${detail.road_name}` : ''}
                    </td>
                    <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(detail.ad_pk_start, detail.ad_pk_end)}</td>
                    <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(detail.rail_pk_start, detail.rail_pk_end)}</td>
                    <td className="px-2 py-2 text-right font-mono text-text-secondary">{fmt(isDriveway ? 0 : detail.length_m)}</td>
                    <td className="px-2 py-2 text-right font-mono text-text-secondary">{fmt(isDriveway ? detail.length_m : 0)}</td>
                    <td className="px-2 py-2 text-right font-mono text-text-secondary">{fmt(detail.passable_m ?? 0)}</td>
                    <td className="px-2 py-2 text-right font-mono text-text-secondary">{fmt(detail.ready_plus_done_m)}</td>
                    <td className="px-2 py-2 text-right font-mono text-text-secondary">{fmt(detail.completed_m ?? 0)}</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td className="px-2 py-6 text-center text-text-muted" colSpan={9}>Детализация по дорогам отсутствует.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function TempRoadModalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-white px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-text-primary">{value}</div>
    </div>
  )
}
