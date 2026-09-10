
import { useEffect, useMemo, useState, type UIEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ClipboardList, Download, Filter, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import { useAuth } from '../auth'
import { hasStatementsProjectWriteRights } from '../access'

interface StatementSection {
  code: string
  name: string
  sort_order?: number | null
}

interface StatementObjectType {
  code: string
  name: string
  sort_order?: number | null
  is_linear?: boolean | null
}

interface StatementObject {
  id: string
  object_code: string | null
  object_name: string | null
  object_type_code: string | null
  object_type_name: string | null
  section_code: string | null
  section_name: string | null
  pk_start?: number | null
  pk_end?: number | null
}
interface StatementReferenceCandidate {
  id: string
  code: string | null
  label: string | null
  ref_count?: number
  review_tag?: string | null
}
interface StatementReferenceCandidatesResponse { rows: StatementReferenceCandidate[] }

interface WorkbookDay {
  key: string
  date: string
  label: string
}

interface WorkbookFactDetail {
  date: string
  shift?: string | null
  volume: number
  material_volume?: number | null
  pk_range?: string | null
  pk_start?: number | null
  pk_end?: number | null
  source_bucket?: string | null
  work_name?: string | null
  report_id?: string | null
  pile_length_m?: number | null
}

type UnitRateSource = 'object' | 'reference' | 'missing' | string

interface PkSegment {
  pk_start: number | null
  pk_end: number | null
  label: string
}

interface WorkbookProjectRef {
  project_item_id: string
  project_segment_id?: string | null
  project_segment_count?: number | null
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
  project_volume?: number | null
  can_edit?: boolean | null
}

interface WorkbookDayValue {
  date: string
  plan_volume: number
  material_plan_volume?: number
  fact_volume: number
  material_fact_volume?: number
  pk_ranges: string[]
  pk_segments?: PkSegment[]
  details: WorkbookFactDetail[]
}

interface WorkbookRow {
  id: string
  category: string
  category_label: string
  category_sort_order?: number | null
  section_code: string | null
  section_name: string | null
  section_sort_order?: number | null
  object_id: string | null
  object_code: string | null
  object_name: string | null
  object_type_code: string | null
  object_type_name: string | null
  work_type_id: string | null
  work_type_code: string | null
  work_type_name: string | null
  unit: string
  pk_start: number | null
  pk_end: number | null
  pk_label: string | null
  project_refs?: WorkbookProjectRef[]
  project_item_id?: string | null
  project_segment_id?: string | null
  project_segment_count?: number | null
  can_edit_project?: boolean
  project_volume: number
  month_plan: number
  month_plan_locked?: boolean
  month_plan_source?: string | null
  month_fact: number
  cumulative_plan: number
  cumulative_fact: number
  material_project_volume?: number
  material_month_plan?: number
  material_month_fact?: number
  material_cumulative_plan?: number
  material_cumulative_fact?: number
  cumulative_pk_ranges?: string[]
  cumulative_pk_segments?: PkSegment[]
  compaction_factor?: number
  compaction_coefficient?: number
  compaction_label?: string | null
  pile_length_m?: number | null
  unit_rate_novgorod?: number | null
  unit_rate_tver?: number | null
  unit_rate_source_novgorod?: UnitRateSource | null
  unit_rate_source_tver?: UnitRateSource | null
  month_plan_amount?: number | null
  month_plan_amount_missing_rate?: boolean
  month_plan_amount_regions?: Array<{ region_code: string; region_label: string; share: number; volume: number; rate: number | null; rate_source?: UnitRateSource | null; amount: number | null }>
  current_year_plan?: number
  current_year_plan_amount?: number | null
  current_year_plan_amount_missing_rate?: boolean
  current_decade_plan?: number
  current_decade_plan_amount?: number | null
  current_decade_plan_amount_missing_rate?: boolean
  month_amount?: number | null
  month_amount_missing_rate?: boolean
  month_amount_regions?: Array<{ region_code: string; region_label: string; share: number; volume: number; rate: number | null; rate_source?: UnitRateSource | null; amount: number | null }>
  cumulative_amount?: number | null
  cumulative_amount_missing_rate?: boolean
  cumulative_amount_regions?: Array<{ region_code: string; region_label: string; share: number; volume: number; rate: number | null; rate_source?: UnitRateSource | null; amount: number | null }>
  current_year_amount?: number | null
  current_year_amount_missing_rate?: boolean
  current_decade_amount?: number | null
  current_decade_amount_missing_rate?: boolean
  month_percent: number | null
  cumulative_percent: number | null
  day_values: Record<string, WorkbookDayValue> | WorkbookDayValue[]
  month_details: WorkbookFactDetail[]
  cumulative_details: WorkbookFactDetail[]
}

interface WorkbookGroupedRow extends WorkbookRow {
  source_rows: WorkbookRow[]
  segment_count: number
}

interface WorkbookTotal {
  unit: string
  project_volume: number
  month_plan: number
  month_fact: number
  cumulative_plan: number
  cumulative_fact: number
  material_project_volume?: number
  material_month_plan?: number
  material_month_fact?: number
  material_cumulative_plan?: number
  material_cumulative_fact?: number
  cumulative_pk_ranges?: string[]
  cumulative_pk_segments?: PkSegment[]
  compaction_factor?: number
  compaction_coefficient?: number
  compaction_label?: string | null
  month_percent: number | null
  cumulative_percent: number | null
}

interface StatementWorkType {
  id: string
  code: string | null
  name: string | null
  default_unit?: string | null
  unit?: string | null
  work_group?: string | null
  analytics_tag?: string | null
}

interface SectionSandQuarrySummary {
  quarry_id?: string | null
  quarry_code?: string | null
  quarry_name: string
  volume: number
  cumulative_volume?: number
  unit?: string | null
  day_values?: Record<string, number>
}

interface SectionSandSourceSummary {
  source_bucket: string
  source_label: string
  total_volume: number
  cumulative_volume?: number
  unit?: string | null
  quarries: SectionSandQuarrySummary[]
}

interface SectionSandMaterialSummary {
  material_code?: string | null
  material_name: string
  total_volume: number
  cumulative_volume?: number
  unit?: string | null
  sources: SectionSandSourceSummary[]
}

interface SectionSandSummary {
  section_code: string | null
  section_name: string | null
  total_volume: number
  cumulative_volume?: number
  unit?: string | null
  quarries: SectionSandQuarrySummary[]
  materials?: SectionSandMaterialSummary[]
}

interface QuarryHaulDisplayRow {
  key: string
  sectionCode: string | null
  sectionLabel: string
  materialLabel: string
  sourceLabel: string
  quarryLabel: string
  volume: number
  cumulativeVolume: number
  unit: string
  dayValues: Record<string, number>
}

interface StatementsMetadataPayload {
  sections: StatementSection[]
  object_types: StatementObjectType[]
  objects: StatementObject[]
  work_types: StatementWorkType[]
}

interface WorkbookFinancialAmount {
  amount?: number | null
  amount_mln?: number | null
  missing_rate?: boolean
  date_from?: string
  date_to?: string
}

interface WorkbookFinancialSummary {
  currency: string
  all_time: WorkbookFinancialAmount
  current_year: WorkbookFinancialAmount
  current_year_plan?: WorkbookFinancialAmount
  current_year_plan_completion_pct?: number | null
  current_month: WorkbookFinancialAmount
  current_decade: WorkbookFinancialAmount
  current_decade_plan?: WorkbookFinancialAmount
  current_decade_plan_completion_pct?: number | null
  current_month_plan?: WorkbookFinancialAmount
  current_month_plan_completion_pct?: number | null
}

interface WorkbookPayload extends StatementsMetadataPayload {
  month: string
  month_start: string
  month_end: string
  days: WorkbookDay[]
  rows: WorkbookRow[]
  sand_by_section?: SectionSandSummary[]
  totals: WorkbookTotal[] | Record<string, WorkbookTotal>
  financial_summary?: WorkbookFinancialSummary
  row_count: number
  updated_at?: string | null
  cache?: {
    status?: 'fresh' | 'stale' | string
    fingerprint?: string | null
    generated_at?: string | null
    refreshing?: boolean
  }
}

interface WorkbookFilters {
  month: string
  sections: string[]
  objectTypes: string[]
  objectIds: string[]
  search: string
  actualSectionBinding: boolean
}

interface MultiFilterOption {
  value: string
  label: string
  hint?: string
}

interface MonthPlanPayload {
  object_id: string
  work_type_id: string
  planned_volume: number
  unit?: string
  month: string
  section_code?: string
  pk_start?: number
  pk_end?: number
  pk_raw_text?: string
  comment?: string
  actual_section_binding?: boolean
}

interface MonthPlanSaveItem {
  row: WorkbookGroupedRow
  month: string
  value: number
  draftKey: string
  actualSectionBinding: boolean
}

interface ProjectEditTarget {
  kind: 'existing' | 'create'
  project_item_id?: string
  project_segment_id?: string | null
  object_id?: string | null
  work_type_id?: string | null
  unit?: string | null
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
}

interface ProjectVolumeSaveItem {
  target: ProjectEditTarget
  value: number
  draftKey?: string
}

interface ObjectRateSaveItem {
  row: WorkbookGroupedRow
  rate_novgorod: number | null
  rate_tver: number | null
}

interface EditableProjectRef extends WorkbookProjectRef {
  key: string
  label: string
  sourceRow: WorkbookRow
  project_item_id: string
  target: ProjectEditTarget
}

interface SegmentVolume {
  key: string
  label: string
  pk_start: number | null
  pk_end: number | null
  volume: number
  details?: WorkbookFactDetail[]
  sourceRow?: WorkbookRow
}

interface DetailInterval {
  key: string
  pk_start: number | null
  pk_end: number | null
  project: number
  monthFact: number
  cumulativeFact: number
  materialProject: number
  materialMonthFact: number
  materialCumulativeFact: number
}

type WorkbookVolumeField =
  | 'project_volume'
  | 'month_fact'
  | 'cumulative_fact'
  | 'material_project_volume'
  | 'material_month_fact'
  | 'material_cumulative_fact'

interface SelectedRowState {
  row: WorkbookGroupedRow
  pkFrom: string
  pkTo: string
  detailed: boolean
}

type WorkbookGroupMode = 'objectType' | 'section'
type FinancialDetailMode = 'all' | 'year' | 'month' | 'decade'

interface GroupAmountSummary {
  monthPlanAmount: number | null
  monthAmount: number | null
  cumulativeAmount: number | null
  monthPlanMissing: boolean
  monthMissing: boolean
  cumulativeMissing: boolean
}

interface FinancialDetailState {
  mode: FinancialDetailMode
  label: string
  periodLabel: string
}

interface WorkbookExportJob {
  job_id: string
  status: 'queued' | 'running' | 'ready' | 'error' | string
  ready: boolean
  download_url?: string | null
  filename?: string | null
  message?: string | null
  error?: string | null
}

type DisplayItem =
  | { kind: 'objectType'; key: string; label: string; count: number; expanded: boolean; summary?: GroupAmountSummary }
  | { kind: 'section'; key: string; label: string; count: number; expanded: boolean; hint?: string; summary?: GroupAmountSummary }
  | { kind: 'object'; key: string; label: string; hint: string; count: number; expanded: boolean; objectId: string | null; summary?: GroupAmountSummary }
  | { kind: 'haulGroup'; key: string; label: string; count: number; expanded: boolean }
  | { kind: 'haulRow'; key: string; row: QuarryHaulDisplayRow }
  | { kind: 'row'; key: string; row: WorkbookGroupedRow }

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const compactNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const moneyNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const moneyMlnNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const currentMonth = new Date().toISOString().slice(0, 7)
const ROW_WINDOW_SIZE = 220
const ZERO_EPS = 0.000001
const STATEMENTS_SEARCH_DEBOUNCE_MS = 650
const STATEMENT_RATE_BOUNDARY_PK = 3039 * 100
const STATEMENT_RATE_REGION_CODES = ['novgorod', 'tver'] as const
const EMPTY_WORKBOOK_ROWS: WorkbookRow[] = []
const EMPTY_WORKBOOK_DAYS: WorkbookDay[] = []

type StatementRateRegion = typeof STATEMENT_RATE_REGION_CODES[number]

function readJson<T>(res: Response, fallbackMessage: string): Promise<T> {
  return res.json().catch(() => ({ detail: fallbackMessage })).then(body => {
    if (!res.ok) throw new Error(body.detail || fallbackMessage)
    return body as T
  })
}

async function responseErrorText(res: Response, fallbackMessage: string): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return fallbackMessage
  try {
    const parsed = JSON.parse(text)
    return parsed.detail || parsed.error || parsed.message || fallbackMessage
  } catch {
    return text.slice(0, 500) || fallbackMessage
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try { return decodeURIComponent(utfMatch[1]) } catch { return utfMatch[1] }
  }
  const asciiMatch = header.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] || null
}

async function saveDownloadResponse(res: Response, fallbackFilename: string) {
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackFilename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function startWorkbookExportJob(params: URLSearchParams): Promise<WorkbookExportJob> {
  const res = await fetch(`/api/wip/statements/general-workbook/export-jobs?${params.toString()}`, { method: 'POST' })
  return readJson<WorkbookExportJob>(res, 'Не удалось поставить XLSX в очередь генерации')
}

async function fetchWorkbookExportJob(jobId: string): Promise<WorkbookExportJob> {
  const res = await fetch(`/api/wip/generator/pipeline-export-jobs/${encodeURIComponent(jobId)}`)
  return readJson<WorkbookExportJob>(res, 'Не удалось получить статус генерации XLSX')
}

async function downloadWorkbookExportJob(job: WorkbookExportJob) {
  if (!job.download_url) throw new Error('Файл готов, но ссылка на скачивание не получена')
  const res = await fetch(job.download_url)
  if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось скачать готовый XLSX'))
  await saveDownloadResponse(res, job.filename || 'Ведомость.xlsx')
}

function multiFilterParam(values: string[]): string {
  return values.map(item => item.trim()).filter(Boolean).join(',')
}

function buildWorkbookParams(filters: WorkbookFilters): URLSearchParams {
  const params = new URLSearchParams()
  params.set('month', filters.month)
  params.set('include_metadata', 'false')
  const section = multiFilterParam(filters.sections)
  const objectType = multiFilterParam(filters.objectTypes)
  const objectId = multiFilterParam(filters.objectIds)
  if (section) params.set('section', section)
  if (objectType) params.set('object_type', objectType)
  if (objectId) params.set('object_id', objectId)
  if (filters.search.trim()) params.set('q', filters.search.trim())
  if (filters.actualSectionBinding) params.set('actual_section_binding', 'true')
  return params
}

function buildMetadataParams(filters: WorkbookFilters): URLSearchParams {
  const params = new URLSearchParams()
  const section = multiFilterParam(filters.sections)
  const objectType = multiFilterParam(filters.objectTypes)
  if (section) params.set('section', section)
  if (objectType) params.set('object_type', objectType)
  if (filters.actualSectionBinding) params.set('actual_section_binding', 'true')
  return params
}

async function fetchWorkbook(filters: WorkbookFilters, signal?: AbortSignal): Promise<WorkbookPayload> {
  const params = buildWorkbookParams(filters)
  const res = await fetch(`/api/wip/statements/general-workbook?${params.toString()}`, { signal })
  return readJson<WorkbookPayload>(res, 'Не удалось загрузить электронную версию общего отчета')
}

async function fetchStatementsMetadata(filters: WorkbookFilters, signal?: AbortSignal): Promise<StatementsMetadataPayload> {
  const params = buildMetadataParams(filters)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const res = await fetch(`/api/wip/statements/metadata${suffix}`, { signal })
  return readJson<StatementsMetadataPayload>(res, 'Не удалось загрузить справочники ведомостей')
}

function monthPlanPayload(row: WorkbookGroupedRow, month: string, value: number, actualSectionBinding: boolean): MonthPlanPayload {
  if (!row.object_id || !row.work_type_id) throw new Error('Для строки нет объекта или вида работ')
  return {
    object_id: row.object_id,
    work_type_id: row.work_type_id,
    planned_volume: value,
    unit: row.unit || undefined,
    month,
    section_code: row.section_code || undefined,
    pk_start: row.pk_start ?? undefined,
    pk_end: row.pk_end ?? undefined,
    pk_raw_text: row.pk_label || undefined,
    comment: 'План месяца из электронной версии общего отчета',
    actual_section_binding: actualSectionBinding,
  }
}

async function saveWorkbookMonthPlan(item: MonthPlanSaveItem): Promise<{ ok: boolean; inserted?: number; deleted?: number; daily_volume?: number }> {
  const res = await fetch('/api/wip/statements/general-workbook/month-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(monthPlanPayload(item.row, item.month, item.value, item.actualSectionBinding)),
  })
  return readJson(res, 'Не удалось сохранить месячный план')
}

async function saveWorkbookProjectVolume(item: ProjectVolumeSaveItem): Promise<{ ok: boolean; changed?: number; created?: boolean; project_item_id?: string }> {
  if (!Number.isFinite(item.value) || item.value < 0) throw new Error('Введите неотрицательный проектный объем')
  const comment = 'Проектный объем изменен из электронной ведомости'
  if (item.target.kind === 'existing') {
    if (!item.target.project_item_id) throw new Error('У строки нет тех. ID проектной позиции')
    const body: Record<string, unknown> = {
      project_volume: item.value,
      unit: item.target.unit && item.target.unit !== '—' ? item.target.unit : undefined,
      comment,
    }
    if (item.target.project_segment_id) body.project_segment_id = item.target.project_segment_id
    if (item.target.pk_raw_text) body.pk_raw_text = item.target.pk_raw_text
    const res = await fetch(`/api/wip/statements/project-rows/${encodeURIComponent(item.target.project_item_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return readJson(res, 'Не удалось сохранить проектный объем')
  }

  if (!item.target.object_id || !item.target.work_type_id) throw new Error('У строки нет объекта или вида работ для создания проектной позиции')
  const res = await fetch('/api/wip/statements/project-rows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_id: item.target.object_id,
      work_type_id: item.target.work_type_id,
      project_volume: item.value,
      unit: item.target.unit && item.target.unit !== '—' ? item.target.unit : undefined,
      pk_start: item.target.pk_start ?? undefined,
      pk_end: item.target.pk_end ?? undefined,
      pk_raw_text: item.target.pk_raw_text || undefined,
      comment,
    }),
  })
  return readJson(res, 'Не удалось создать проектную позицию')
}

async function saveWorkbookObjectRates(item: ObjectRateSaveItem): Promise<{ ok: boolean }> {
  if (!item.row.object_id || !item.row.work_type_id) throw new Error('У строки нет объекта или вида работ для сохранения расценки')
  const res = await fetch('/api/wip/statements/object-unit-rates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_id: item.row.object_id,
      work_type_id: item.row.work_type_id,
      unit: item.row.unit || undefined,
      rate_novgorod: item.rate_novgorod,
      rate_tver: item.rate_tver,
      pile_length_m: item.row.pile_length_m ?? undefined,
    }),
  })
  return readJson(res, 'Не удалось сохранить расценку')
}

interface CreateStatementWorkPayload {
  object_id: string
  work_type_id: string
  planned_volume: number
  unit?: string
  month: string
  section_code?: string
  pk_start?: number
  pk_end?: number
  pk_raw_text?: string
  actual_section_binding?: boolean
}

interface CreateStatementObjectPayload {
  object_code: string
  object_name: string
  object_type_code: string
  section_code?: string
  pk_start?: number
  pk_end?: number
  pk_raw_text?: string
  comment?: string
}

interface DeleteStatementObjectWorkPayload {
  object_id: string
  work_type_id: string
  unit?: string
}

async function createStatementObject(payload: CreateStatementObjectPayload): Promise<StatementObject> {
  const res = await fetch('/api/wip/statements/objects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readJson<StatementObject>(res, 'Не удалось добавить объект')
}

async function createStatementWorkWithPlan(payload: CreateStatementWorkPayload): Promise<{ ok: boolean }> {
  const projectRes = await fetch('/api/wip/statements/project-rows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_id: payload.object_id,
      work_type_id: payload.work_type_id,
      project_volume: 0,
      unit: payload.unit || undefined,
      pk_start: payload.pk_start,
      pk_end: payload.pk_end,
      pk_raw_text: payload.pk_raw_text,
      comment: 'Работа добавлена из электронной версии общего отчета',
    }),
  })
  await readJson(projectRes, 'Не удалось добавить работу к объекту')
  if (Number(payload.planned_volume || 0) > 0) {
    const planRes = await fetch('/api/wip/statements/general-workbook/month-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object_id: payload.object_id,
        work_type_id: payload.work_type_id,
        planned_volume: payload.planned_volume,
        unit: payload.unit || undefined,
        month: payload.month,
        section_code: payload.section_code,
        pk_start: payload.pk_start,
        pk_end: payload.pk_end,
        pk_raw_text: payload.pk_raw_text,
        comment: 'План месяца из электронной версии общего отчета',
        actual_section_binding: payload.actual_section_binding,
      }),
    })
    await readJson(planRes, 'Не удалось сохранить план для новой работы')
  }
  return { ok: true }
}

async function deleteStatementObjectWork(payload: DeleteStatementObjectWorkPayload): Promise<{ ok: boolean; deleted_plan_rows?: number; deleted_project_rows?: number; deleted_project_segments?: number }> {
  const res = await fetch('/api/wip/statements/object-work', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readJson(res, 'Не удалось удалить работу у объекта')
}

async function deleteStatementObject(objectId: string): Promise<{ ok: boolean; deleted?: Record<string, number> }> {
  const res = await fetch(`/api/wip/statements/objects/${objectId}`, { method: 'DELETE' })
  return readJson(res, 'Не удалось удалить объект')
}

function formatVolume(value: number | null | undefined): string {
  return nf.format(Number(value || 0))
}

function formatCompactVolume(value: number | null | undefined): string {
  return compactNf.format(Number(value || 0))
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${compactNf.format(value)}%`
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return `${moneyNf.format(Number(value))} ₽`
}

function formatMoneyMln(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return `${moneyMlnNf.format(Number(value) / 1_000_000)} млн ₽`
}

function formatFinancialAmount(item?: WorkbookFinancialAmount | null): string {
  if (!item) return '—'
  if (item.amount == null) return '—'
  return `${formatMoney(item.amount)}${item.missing_rate ? ' *' : ''}`
}

function financialPeriodLabel(item?: WorkbookFinancialAmount | null): string {
  if (!item?.date_from || !item.date_to) return ''
  const period = `${formatDate(item.date_from)} - ${formatDate(item.date_to)}`
  return item.missing_rate ? `${period}, есть строки без расценки` : period
}

function rateSourceLabel(source?: UnitRateSource | null): string {
  if (source === 'object') return 'расценка ведомости'
  if (source === 'reference') return 'справочная расценка'
  if (source === 'missing') return 'нет расценки'
  return source || 'нет расценки'
}

function rateSourceClass(source?: UnitRateSource | null): string {
  if (source === 'reference') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (source === 'object') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return 'border-border bg-bg-surface text-text-muted'
}

function parseOptionalRateDraft(value: string): number | null | undefined {
  const text = value.trim().replace(',', '.')
  if (!text) return null
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function rowObjectKey(row: WorkbookRow): string {
  return String(row.object_id || row.object_code || row.object_name || 'none')
}

function rowMonthFactAbs(row: WorkbookRow): number {
  return Math.abs(Number(row.month_fact || 0)) + Math.abs(Number(row.material_month_fact || 0))
}

function rowCumulativeFactAbs(row: WorkbookRow): number {
  return Math.abs(Number(row.cumulative_fact || 0)) + Math.abs(Number(row.material_cumulative_fact || 0))
}

function rowMonthPlanAbs(row: WorkbookRow): number {
  return Math.abs(Number(row.month_plan || 0)) + Math.abs(Number(row.material_month_plan || 0))
}

function rowHasMissingVisibleRate(row: WorkbookRow): boolean {
  if (rowMonthPlanAbs(row) > ZERO_EPS && (row.month_plan_amount_missing_rate || row.month_plan_amount == null)) return true
  if (rowMonthFactAbs(row) > ZERO_EPS && (row.month_amount_missing_rate || row.month_amount == null)) return true
  if (rowCumulativeFactAbs(row) > ZERO_EPS && (row.cumulative_amount_missing_rate || row.cumulative_amount == null)) return true
  return false
}

function applyWorkbookVisibilityFilters(
  rows: WorkbookGroupedRow[],
  hideZeroWorks: boolean,
  hideZeroObjects: boolean,
  onlyWithPlan: boolean,
  onlyMissingRate: boolean,
): WorkbookGroupedRow[] {
  let result = rows
  if (hideZeroObjects) {
    const monthFactByObject = new Map<string, number>()
    for (const row of result) {
      const key = rowObjectKey(row)
      monthFactByObject.set(key, (monthFactByObject.get(key) || 0) + rowMonthFactAbs(row))
    }
    result = result.filter(row => {
      const objectMonthFact = monthFactByObject.get(rowObjectKey(row)) || 0
      return objectMonthFact > ZERO_EPS && rowMonthFactAbs(row) > ZERO_EPS
    })
  }
  if (hideZeroWorks) {
    result = result.filter(row => rowCumulativeFactAbs(row) > ZERO_EPS)
  }
  if (onlyWithPlan) {
    result = result.filter(row => rowMonthPlanAbs(row) > ZERO_EPS)
  }
  if (onlyMissingRate) {
    result = result.filter(row => rowHasMissingVisibleRate(row))
  }
  return result
}

function groupAmountSummary(rows: WorkbookGroupedRow[]): GroupAmountSummary {
  let monthPlanAmount = 0
  let monthAmount = 0
  let cumulativeAmount = 0
  let monthPlanHasAmount = false
  let monthHasAmount = false
  let cumulativeHasAmount = false
  let monthPlanMissing = false
  let monthMissing = false
  let cumulativeMissing = false
  for (const row of rows) {
    if ((row.month_plan_amount_missing_rate || row.month_plan_amount == null) && Math.abs(Number(row.month_plan || 0)) > ZERO_EPS) monthPlanMissing = true
    if (row.month_plan_amount != null) {
      monthPlanAmount += Number(row.month_plan_amount || 0)
      monthPlanHasAmount = true
    }

    if ((row.month_amount_missing_rate || row.month_amount == null) && rowMonthFactAbs(row) > ZERO_EPS) monthMissing = true
    if (row.month_amount != null) {
      monthAmount += Number(row.month_amount || 0)
      monthHasAmount = true
    }

    if ((row.cumulative_amount_missing_rate || row.cumulative_amount == null) && rowCumulativeFactAbs(row) > ZERO_EPS) cumulativeMissing = true
    if (row.cumulative_amount != null) {
      cumulativeAmount += Number(row.cumulative_amount || 0)
      cumulativeHasAmount = true
    }
  }
  return {
    monthPlanAmount: monthPlanHasAmount ? monthPlanAmount : null,
    monthAmount: monthHasAmount ? monthAmount : null,
    cumulativeAmount: cumulativeHasAmount ? cumulativeAmount : null,
    monthPlanMissing,
    monthMissing,
    cumulativeMissing,
  }
}

function AmountSummaryText({ amount, missing }: { amount: number | null | undefined; missing: boolean }) {
  if (amount != null) return <span className="text-accent-burg">{formatMoneyMln(amount)}</span>
  if (amount == null && !missing) return <>—</>
  return <span className="text-text-primary">нет расценки</span>
}

function FinancialDetailAmount({ amount, missing }: { amount: number | null; missing: boolean }) {
  if (amount != null) {
    return <span>{formatMoney(amount)}{missing ? <span className="ml-1 text-[11px] font-normal text-text-muted">неполно</span> : null}</span>
  }
  if (missing) return <span className="text-text-primary">нет расценки</span>
  return <span className="text-text-muted">—</span>
}

function financialDetailValues(row: WorkbookGroupedRow, mode: FinancialDetailMode) {
  if (mode === 'month') {
    return {
      planAmount: row.month_plan_amount ?? null,
      planMissing: Boolean(row.month_plan_amount_missing_rate && Math.abs(Number(row.month_plan || 0)) > ZERO_EPS),
      factAmount: row.month_amount ?? null,
      factMissing: Boolean(row.month_amount_missing_rate && rowMonthFactAbs(row) > ZERO_EPS),
    }
  }
  if (mode === 'year') {
    return {
      planAmount: row.current_year_plan_amount ?? null,
      planMissing: Boolean(row.current_year_plan_amount_missing_rate && Math.abs(Number(row.current_year_plan || 0)) > ZERO_EPS),
      factAmount: row.current_year_amount ?? null,
      factMissing: Boolean(row.current_year_amount_missing_rate),
    }
  }
  if (mode === 'decade') {
    return {
      planAmount: row.current_decade_plan_amount ?? null,
      planMissing: Boolean(row.current_decade_plan_amount_missing_rate && Math.abs(Number(row.current_decade_plan || 0)) > ZERO_EPS),
      factAmount: row.current_decade_amount ?? null,
      factMissing: Boolean(row.current_decade_amount_missing_rate),
    }
  }
  return {
    planAmount: null,
    planMissing: false,
    factAmount: row.cumulative_amount ?? null,
    factMissing: Boolean(row.cumulative_amount_missing_rate && rowCumulativeFactAbs(row) > ZERO_EPS),
  }
}

function financialDetailRows(rows: WorkbookGroupedRow[], mode: FinancialDetailMode) {
  const grouped = new Map<string, {
    key: string
    section: string
    planAmount: number
    factAmount: number
    hasPlan: boolean
    hasFact: boolean
    planMissing: boolean
    factMissing: boolean
  }>()
  for (const row of rows) {
    const key = row.section_code || '__none__'
    const target = grouped.get(key) || {
      key,
      section: row.section_name || row.section_code || 'Без участка',
      planAmount: 0,
      factAmount: 0,
      hasPlan: false,
      hasFact: false,
      planMissing: false,
      factMissing: false,
    }
    const values = financialDetailValues(row, mode)
    if (values.planAmount != null) {
      target.planAmount += Number(values.planAmount || 0)
      target.hasPlan = true
    }
    if (values.factAmount != null) {
      target.factAmount += Number(values.factAmount || 0)
      target.hasFact = true
    }
    target.planMissing = target.planMissing || values.planMissing
    target.factMissing = target.factMissing || values.factMissing
    grouped.set(key, target)
  }
  return Array.from(grouped.values())
    .filter(row => row.hasPlan || row.hasFact || row.planMissing || row.factMissing)
    .sort((a, b) => String(a.key).localeCompare(String(b.key), 'ru'))
}

function FinancialDetailModal({
  state,
  rows,
  actualSectionBinding,
  bindingLoading,
  onToggleActualSectionBinding,
  onClose,
}: {
  state: FinancialDetailState
  rows: WorkbookGroupedRow[]
  actualSectionBinding: boolean
  bindingLoading: boolean
  onToggleActualSectionBinding: () => void
  onClose: () => void
}) {
  const detailRows = financialDetailRows(rows, state.mode)
  const total = detailRows.reduce((acc, row) => ({
    planAmount: acc.planAmount + row.planAmount,
    factAmount: acc.factAmount + row.factAmount,
    hasPlan: acc.hasPlan || row.hasPlan,
    hasFact: acc.hasFact || row.hasFact,
    planMissing: acc.planMissing || row.planMissing,
    factMissing: acc.factMissing || row.factMissing,
  }), { planAmount: 0, factAmount: 0, hasPlan: false, hasFact: false, planMissing: false, factMissing: false })
  const completion = total.hasPlan && Math.abs(total.planAmount) > ZERO_EPS && total.hasFact
    ? Math.round(total.factAmount / total.planAmount * 1000) / 10
    : null
  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div className="mx-auto flex max-h-[calc(100vh-24px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:max-h-[calc(100vh-48px)]" onClick={event => event.stopPropagation()}>
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-red">Детализация по участкам</div>
              <h2 className="mt-1 text-lg font-semibold text-text-primary">{state.label}</h2>
              <div className="mt-1 text-sm text-text-secondary">{state.periodLabel || 'Текущий фильтр ведомости'}</div>
            </div>
            <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 flex justify-end">
            <ActualSectionBindingSwitch
              checked={actualSectionBinding}
              loading={bindingLoading}
              onToggle={onToggleActualSectionBinding}
              labelId="actual-section-binding-financial-detail-label"
            />
          </div>
        </div>
        <div className="grid gap-2 border-b border-border bg-bg-surface/70 px-4 py-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-white p-3">
            <div className="text-xs text-text-muted">План</div>
            <div className="mt-1 font-mono text-base font-semibold text-blue-700"><FinancialDetailAmount amount={total.hasPlan ? total.planAmount : null} missing={total.planMissing} /></div>
          </div>
          <div className="rounded-md border border-border bg-white p-3">
            <div className="text-xs text-text-muted">Факт</div>
            <div className="mt-1 font-mono text-base font-semibold text-accent-burg"><FinancialDetailAmount amount={total.hasFact ? total.factAmount : null} missing={total.factMissing} /></div>
          </div>
          <div className="rounded-md border border-border bg-white p-3">
            <div className="text-xs text-text-muted">Выполнение</div>
            <div className="mt-1 font-mono text-base font-semibold text-text-primary">{formatPercent(completion)}</div>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {detailRows.length ? (
            <table className="w-full min-w-[620px] text-sm">
              <thead className="bg-bg-surface text-xs uppercase text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Участок</th>
                  <th className="px-3 py-2 text-right">План</th>
                  <th className="px-3 py-2 text-right">Факт</th>
                  <th className="px-3 py-2 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map(row => {
                  const rowCompletion = row.hasPlan && Math.abs(row.planAmount) > ZERO_EPS && row.hasFact
                    ? Math.round(row.factAmount / row.planAmount * 1000) / 10
                    : null
                  return (
                    <tr key={row.key} className="border-t border-border">
                      <td className="px-3 py-2 font-medium text-text-primary">{row.section}</td>
                      <td className="px-3 py-2 text-right font-mono text-blue-700"><FinancialDetailAmount amount={row.hasPlan ? row.planAmount : null} missing={row.planMissing} /></td>
                      <td className="px-3 py-2 text-right font-mono text-accent-burg"><FinancialDetailAmount amount={row.hasFact ? row.factAmount : null} missing={row.factMissing} /></td>
                      <td className="px-3 py-2 text-right font-mono">{formatPercent(rowCompletion)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="py-10 text-center text-sm text-text-muted">Нет сумм по текущим фильтрам.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ActualSectionBindingSwitch({
  checked,
  loading = false,
  onToggle,
  labelId,
}: {
  checked: boolean
  loading?: boolean
  onToggle: () => void
  labelId: string
}) {
  return (
    <div className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-white px-3 py-1.5">
      <span id={labelId} className="text-xs font-medium text-text-secondary">Фактическая привязка объектов</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-busy={loading}
        disabled={loading}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-wait disabled:opacity-70 ${checked ? 'bg-accent-red' : 'bg-neutral-300'}`}
      >
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
      {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" aria-label="Загрузка" />}
    </div>
  )
}

function FinancialSummaryCards({
  summary,
  actualSectionBinding,
  bindingLoading,
  onToggleActualSectionBinding,
  onOpenDetail,
}: {
  summary?: WorkbookFinancialSummary
  actualSectionBinding: boolean
  bindingLoading: boolean
  onToggleActualSectionBinding: () => void
  onOpenDetail: (state: FinancialDetailState) => void
}) {
  if (!summary) return null
  const cards: Array<{
    key: string
    detailMode: FinancialDetailMode
    label: string
    value: string
    valueLabel?: string
    hint: string
    plan?: WorkbookFinancialAmount | null
    completion?: number | null
  }> = [
    { key: 'all', detailMode: 'all' as const, label: 'Финансы за все время', value: formatFinancialAmount(summary.all_time), hint: 'Накопительный факт' },
    { key: 'year', detailMode: 'year' as const, label: 'Текущий год', value: formatFinancialAmount(summary.current_year), valueLabel: 'Факт', hint: financialPeriodLabel(summary.current_year), plan: summary.current_year_plan, completion: summary.current_year_plan_completion_pct },
    { key: 'month', detailMode: 'month' as const, label: 'Текущий месяц', value: formatFinancialAmount(summary.current_month), valueLabel: 'Факт', hint: financialPeriodLabel(summary.current_month), plan: summary.current_month_plan, completion: summary.current_month_plan_completion_pct },
    { key: 'decade', detailMode: 'decade' as const, label: 'Текущая декада', value: formatFinancialAmount(summary.current_decade), valueLabel: 'Факт', hint: financialPeriodLabel(summary.current_decade), plan: summary.current_decade_plan, completion: summary.current_decade_plan_completion_pct },
    {
      key: 'plan',
      detailMode: 'month' as const,
      label: 'План месяца',
      value: summary.current_month_plan_completion_pct == null ? '—' : formatPercent(summary.current_month_plan_completion_pct),
      valueLabel: 'Выполнение',
      hint: summary.current_month_plan?.missing_rate ? `план: ${formatFinancialAmount(summary.current_month_plan)}, неполно` : `план: ${formatFinancialAmount(summary.current_month_plan)}`,
      plan: summary.current_month_plan,
      completion: summary.current_month_plan_completion_pct,
    },
  ]
  return (
    <section className="border-b border-border bg-white px-4 py-3 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-text-primary">Карточки по периодам</div>
        <ActualSectionBindingSwitch
          checked={actualSectionBinding}
          loading={bindingLoading}
          onToggle={onToggleActualSectionBinding}
          labelId="actual-section-binding-cards-label"
        />
      </div>
      <div className="grid gap-2 md:grid-cols-5">
        {cards.map(card => (
          <button
            key={card.key}
            type="button"
            onClick={() => onOpenDetail({ mode: card.detailMode, label: card.label, periodLabel: card.hint })}
            className="rounded-md border border-border bg-bg-surface/40 px-3 py-2 text-left transition hover:border-blue-200 hover:bg-blue-50/40"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{card.label}</div>
            {card.plan && (
              <div className="mt-1 space-y-1">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">План</div>
                  <div className="whitespace-normal break-words font-mono text-lg font-bold leading-tight text-blue-700 lg:text-xl">{formatFinancialAmount(card.plan)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{card.valueLabel || 'Факт'}</div>
                  <div className="whitespace-normal break-words font-mono text-lg font-bold leading-tight text-accent-burg lg:text-xl">{card.value}</div>
                </div>
              </div>
            )}
            {!card.plan && <div className="mt-1 whitespace-normal break-words font-mono text-lg font-bold leading-tight text-accent-burg lg:text-xl">{card.value}</div>}
            <div className="mt-0.5 truncate text-[11px] text-text-muted" title={card.hint}>{card.hint || '—'}</div>
          </button>
        ))}
      </div>
    </section>
  )
}

function GroupAmountRightCells({
  summary,
  daysLength,
  bgClass,
  textClass = 'text-text-secondary',
}: {
  summary?: GroupAmountSummary
  daysLength: number
  bgClass: string
  textClass?: string
}) {
  return (
    <>
      <td colSpan={4} className={`border-t border-border ${bgClass}`} />
      <td className={`border-t border-border px-3 py-2 text-right align-middle font-mono text-xs font-semibold ${bgClass} ${textClass}`}><AmountSummaryText amount={summary?.monthPlanAmount} missing={Boolean(summary?.monthPlanMissing)} /></td>
      <td className={`border-t border-border ${bgClass}`} />
      <td className={`border-t border-border px-3 py-2 text-right align-middle font-mono text-xs font-semibold ${bgClass} ${textClass}`}><AmountSummaryText amount={summary?.monthAmount} missing={Boolean(summary?.monthMissing)} /></td>
      <td className={`border-t border-border px-3 py-2 text-right align-middle font-mono text-xs font-semibold ${bgClass} ${textClass}`}><AmountSummaryText amount={summary?.cumulativeAmount} missing={Boolean(summary?.cumulativeMissing)} /></td>
      <td className={`border-t border-border ${bgClass}`} />
      <td colSpan={3 + daysLength} className={`border-t border-border ${bgClass}`} />
    </>
  )
}

function hasCompaction(row: WorkbookRow): boolean {
  return Boolean(row.compaction_label && Math.abs(Number(row.compaction_factor ?? 1) - 1) > 0.000001)
}

function formatWorkMaterialCompact(row: WorkbookRow, workValue: number | null | undefined, materialValue?: number | null): string {
  const workText = formatCompactVolume(workValue)
  if (!hasCompaction(row)) return workText
  return `${workText} / ${formatCompactVolume(materialValue ?? workValue)}`
}

function DayWorkMaterialValue({
  row,
  workValue,
  materialValue,
  visible,
}: {
  row: WorkbookRow
  workValue: number
  materialValue?: number | null
  visible: boolean
}) {
  if (!visible) return <span className="text-text-muted">—</span>
  if (!hasCompaction(row)) return <span>{formatCompactVolume(workValue)}</span>

  return (
    <span className="inline-flex flex-col items-end gap-0.5 leading-none tabular-nums">
      <span className="whitespace-nowrap">
        <span className="mr-1 font-sans text-[9px] font-medium uppercase text-text-muted">раб.</span>
        {formatCompactVolume(workValue)}
      </span>
      <span className="whitespace-nowrap">
        <span className="mr-1 font-sans text-[9px] font-medium uppercase text-text-muted">мат.</span>
        {formatCompactVolume(materialValue ?? workValue)}
      </span>
    </span>
  )
}

function formatWorkMaterialVolume(row: WorkbookRow, workValue: number | null | undefined, materialValue?: number | null): string {
  const workText = formatVolume(workValue)
  if (!hasCompaction(row)) return workText
  return `${workText} / ${formatVolume(materialValue ?? workValue)}`
}

function compactPkRanges(pkRanges: string[]): string {
  if (!pkRanges.length) return '—'
  const shown = pkRanges.slice(0, 2).join('; ')
  return pkRanges.length > 2 ? `${shown} +${pkRanges.length - 2}` : shown
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const parts = value.slice(0, 10).split('-')
  if (parts.length !== 3) return value
  return `${parts[2]}.${parts[1]}.${parts[0]}`
}

function formatPk(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const normalized = Math.round(Number(value) * 100) / 100
  const pk = Math.floor(normalized / 100)
  const plus = normalized - pk * 100
  const plusText = Math.abs(plus - Math.round(plus)) < 0.001
    ? String(Math.round(plus)).padStart(2, '0')
    : plus.toFixed(2).replace('.', ',').padStart(5, '0')
  return `ПК${pk}+${plusText}`
}

function formatPkRange(start: number | null, end: number | null): string {
  if (start == null && end == null) return '—'
  if (start != null && end != null && Math.abs(start - end) < 0.001) return formatPk(start)
  return `${formatPk(start)} - ${formatPk(end)}`
}

function normalizedPkValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function statementRateRegionsForPk(pkStart: number | null | undefined, pkEnd: number | null | undefined): StatementRateRegion[] {
  let start = normalizedPkValue(pkStart)
  let end = normalizedPkValue(pkEnd)
  if (start === null && end === null) return [...STATEMENT_RATE_REGION_CODES]
  if (start === null) start = end
  if (end === null) end = start
  if (start === null || end === null) return [...STATEMENT_RATE_REGION_CODES]
  if (start > end) [start, end] = [end, start]
  if (Math.abs(end - start) < 0.001) return [start < STATEMENT_RATE_BOUNDARY_PK ? 'novgorod' : 'tver']

  const regions: StatementRateRegion[] = []
  const novgorodLength = Math.max(0, Math.min(end, STATEMENT_RATE_BOUNDARY_PK) - start)
  const tverLength = Math.max(0, end - Math.max(start, STATEMENT_RATE_BOUNDARY_PK))
  if (novgorodLength > 0) regions.push('novgorod')
  if (tverLength > 0) regions.push('tver')
  if (regions.length > 0) return regions

  const midpoint = (start + end) / 2
  return [midpoint < STATEMENT_RATE_BOUNDARY_PK ? 'novgorod' : 'tver']
}

function statementRateRegionsForRow(row: Pick<WorkbookRow, 'pk_start' | 'pk_end'>): StatementRateRegion[] {
  return statementRateRegionsForPk(row.pk_start, row.pk_end)
}

function statementRateSourceForRegion(row: WorkbookRow, region: StatementRateRegion): UnitRateSource | null | undefined {
  return region === 'novgorod' ? row.unit_rate_source_novgorod : row.unit_rate_source_tver
}

function statementRowUsesReferenceRate(row: WorkbookRow): boolean {
  return statementRateRegionsForRow(row).some(region => statementRateSourceForRegion(row, region) === 'reference')
}

function rowPkLabel(row: WorkbookRow): string {
  return row.pk_label || formatPkRange(row.pk_start, row.pk_end)
}

function parseDraftVolume(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed.replace(',', '.').replace(/\s+/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parsePkInput(value: string): number | null {
  const raw = value.trim().replace(',', '.')
  if (!raw) return null
  const station = raw.match(/(?:п\s*\.?\s*к\s*\.?|pk)?\s*(\d{1,6})(?:\s*\+\s*(\d{1,3}(?:\.\d+)?))?/i)
  if (station && raw.includes('+')) return Number(station[1]) * 100 + Number(station[2] || 0)
  const numeric = Number(raw.replace(/\s+/g, ''))
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 10000 ? numeric * 100 : numeric
  if (station) return Number(station[1]) * 100 + Number(station[2] || 0)
  return null
}

function percentTone(percent: number | null): string {
  if (percent == null) return 'bg-neutral-100 text-neutral-600'
  if (percent >= 100) return 'bg-emerald-100 text-emerald-700'
  if (percent >= 70) return 'bg-sky-100 text-sky-700'
  if (percent >= 30) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

function sourceBucketLabel(value: string | null | undefined): string {
  const normalized = (value || '').trim().toLowerCase()
  if (normalized === 'web') return 'web'
  if (normalized === 'dim') return 'ДиМ'
  if (normalized === 'm') return 'М'
  if (normalized === 'manual') return 'ручной ввод'
  return value || 'источник не указан'
}

function objectLabel(object: StatementObject): string {
  return object.object_name || object.object_code || object.id
}

function statementObjectOptionKey(object: StatementObject): string {
  return [object.id, object.section_code || '', object.pk_start ?? '', object.pk_end ?? ''].join('|')
}

function statementObjectPkRawText(object: StatementObject): string | undefined {
  const label = formatPkRange(object.pk_start ?? null, object.pk_end ?? null)
  return label === '—' ? undefined : label
}

function rowObjectLabel(row: WorkbookRow): string {
  return row.object_name || row.object_code || 'Объект не указан'
}

function isPileDrivingStatementRow(row: WorkbookRow): boolean {
  const code = String(row.work_type_code || '').toUpperCase()
  if (code === 'PILE_MAIN' || code === 'PILE_TRIAL') return true
  const name = String(row.work_type_name || '').toLowerCase()
  return name.includes('забив') && name.includes('сва')
}

function rowWorkLabel(row: WorkbookRow): string {
  const base = row.work_type_name || row.work_type_code || 'Вид работ не указан'
  if (isPileDrivingStatementRow(row) && row.pile_length_m) return `${base}, ${formatVolume(row.pile_length_m)} м`
  return base
}

const SECTION_SORT_FALLBACK = Number.MAX_SAFE_INTEGER

function sectionOrderFromCode(code?: string | null): number {
  const match = /^UCH[_\s-]?(\d+)$/i.exec(String(code || '').trim())
  return match ? Number(match[1]) : SECTION_SORT_FALLBACK
}

function sectionSortOrder(order?: number | null, code?: string | null): number {
  if (order != null) {
    const numeric = Number(order)
    if (Number.isFinite(numeric)) return numeric
  }
  return sectionOrderFromCode(code)
}

function sectionGroupMeta(
  sectionKey: string,
  sectionRows: WorkbookGroupedRow[] = [],
  haulRows: QuarryHaulDisplayRow[] = [],
) {
  const firstRow = sectionRows[0]
  const firstHaulRow = haulRows[0]
  const code = firstRow?.section_code || firstHaulRow?.sectionCode || (sectionKey === 'none' ? null : sectionKey)
  const label = firstRow?.section_name || firstRow?.section_code || firstHaulRow?.sectionLabel || code || 'Без участка'
  return {
    order: sectionSortOrder(firstRow?.section_sort_order, code),
    code: code || '',
    label,
  }
}

function compareSectionGroups(
  aKey: string,
  aRows: WorkbookGroupedRow[] = [],
  aHaulRows: QuarryHaulDisplayRow[] = [],
  bKey: string,
  bRows: WorkbookGroupedRow[] = [],
  bHaulRows: QuarryHaulDisplayRow[] = [],
): number {
  const a = sectionGroupMeta(aKey, aRows, aHaulRows)
  const b = sectionGroupMeta(bKey, bRows, bHaulRows)
  return (
    a.order - b.order ||
    a.code.localeCompare(b.code, 'ru') ||
    a.label.localeCompare(b.label, 'ru')
  )
}

function compareObjectTypeGroups(aKey: string, aRows: WorkbookGroupedRow[], bKey: string, bRows: WorkbookGroupedRow[]): number {
  const aLabel = aRows[0]?.object_type_name || aRows[0]?.object_type_code || aKey || 'Без типа объекта'
  const bLabel = bRows[0]?.object_type_name || bRows[0]?.object_type_code || bKey || 'Без типа объекта'
  return aLabel.localeCompare(bLabel, 'ru') || aKey.localeCompare(bKey, 'ru')
}

function detailLine(detail: WorkbookFactDetail): string {
  const shift = detail.shift ? `, ${detail.shift}` : ''
  const pk = detail.pk_range ? `, ${detail.pk_range}` : ''
  return `${formatDate(detail.date)}${shift}: ${formatVolume(detail.volume)}${pk}`
}

function dayValuesMap(row: WorkbookRow): Record<string, WorkbookDayValue> {
  const raw = row.day_values
  if (Array.isArray(raw)) {
    const mapped: Record<string, WorkbookDayValue> = {}
    for (const value of raw) {
      if (value?.date) mapped[value.date] = value
    }
    return mapped
  }
  return raw || {}
}

function emptyDayMap(days: WorkbookDay[]): Record<string, WorkbookDayValue> {
  const out: Record<string, WorkbookDayValue> = {}
  for (const day of days) out[day.date] = { date: day.date, plan_volume: 0, material_plan_volume: 0, fact_volume: 0, material_fact_volume: 0, pk_ranges: [], pk_segments: [], details: [] }
  return out
}

function mergePkSegments(segments: PkSegment[], maxGap = 5): PkSegment[] {
  const clean = segments
    .filter(segment => segment && (segment.pk_start != null || segment.pk_end != null))
    .map(segment => {
      const start = Number(segment.pk_start ?? segment.pk_end)
      const end = Number(segment.pk_end ?? segment.pk_start)
      return start <= end ? { start, end } : { start: end, end: start }
    })
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (!clean.length) return []
  const merged: { start: number; end: number }[] = [{ ...clean[0] }]
  for (const segment of clean.slice(1)) {
    const last = merged[merged.length - 1]
    if (segment.start <= last.end + maxGap) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  return merged.map(segment => ({ pk_start: segment.start, pk_end: segment.end, label: formatPkRange(segment.start, segment.end) }))
}

function nextWholePkBoundary(value: number): number {
  const boundary = Math.ceil(value / 100) * 100
  return boundary <= value + 0.001 ? boundary + 100 : boundary
}

function addDayValues(target: Record<string, WorkbookDayValue>, source: Record<string, WorkbookDayValue>, days: WorkbookDay[]) {
  for (const day of days) {
    const src = source[day.date]
    if (!src) continue
    const dst = target[day.date] || { date: day.date, plan_volume: 0, material_plan_volume: 0, fact_volume: 0, material_fact_volume: 0, pk_ranges: [], pk_segments: [], details: [] }
    dst.plan_volume += Number(src.plan_volume || 0)
    dst.material_plan_volume = Number(dst.material_plan_volume || 0) + Number(src.material_plan_volume ?? src.plan_volume ?? 0)
    dst.fact_volume += Number(src.fact_volume || 0)
    dst.material_fact_volume = Number(dst.material_fact_volume || 0) + Number(src.material_fact_volume ?? src.fact_volume ?? 0)
    dst.pk_segments = mergePkSegments([...(dst.pk_segments || []), ...((src.pk_segments || []).filter(Boolean))])
    dst.pk_ranges = dst.pk_segments.map(segment => segment.label)
    dst.details = [...(dst.details || []), ...((src.details || []))]
    target[day.date] = dst
  }
}

function mergePkStart(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

function mergePkEnd(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

function normalizeStatementUnit(value: string | null | undefined): string {
  return String(value || '—')
    .trim()
    .toLowerCase()
    .replaceAll('³', '3')
    .replaceAll('²', '2')
    .replace(/\s+/g, '') || '—'
}

function projectEditTargetKey(target: ProjectEditTarget): string {
  if (target.kind === 'existing') return `project:${target.project_item_id || ''}:${target.project_segment_id || 'item'}`
  return [
    'project:create',
    target.object_id || '',
    target.work_type_id || '',
    normalizeStatementUnit(target.unit),
    target.pk_start ?? '',
    target.pk_end ?? '',
  ].join(':')
}

function sourceProjectRefs(sourceRow: WorkbookRow): WorkbookProjectRef[] {
  if (sourceRow.project_refs?.length) return sourceRow.project_refs
  if (sourceRow.project_item_id && sourceRow.can_edit_project !== false) {
    return [{
      project_item_id: sourceRow.project_item_id,
      project_segment_id: sourceRow.project_segment_id || null,
      project_segment_count: sourceRow.project_segment_count || 0,
      pk_start: sourceRow.pk_start,
      pk_end: sourceRow.pk_end,
      pk_raw_text: sourceRow.pk_label,
      project_volume: sourceRow.project_volume,
      can_edit: true,
    }]
  }
  return []
}

function editableProjectRefs(row: WorkbookGroupedRow): EditableProjectRef[] {
  const refs: EditableProjectRef[] = []
  const seen = new Set<string>()
  for (const sourceRow of row.source_rows?.length ? row.source_rows : [row]) {
    for (const ref of sourceProjectRefs(sourceRow)) {
      if (!ref.project_item_id || ref.can_edit === false) continue
      const key = `${ref.project_item_id}:${ref.project_segment_id || ''}:${ref.pk_start ?? ''}:${ref.pk_end ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const target: ProjectEditTarget = {
        kind: 'existing',
        project_item_id: ref.project_item_id,
        project_segment_id: ref.project_segment_id || null,
        unit: sourceRow.unit || row.unit || null,
        pk_raw_text: ref.pk_raw_text || sourceRow.pk_label || null,
      }
      refs.push({
        ...ref,
        key,
        label: rowPkLabel(sourceRow),
        sourceRow,
        project_item_id: ref.project_item_id,
        project_volume: Number(ref.project_volume ?? sourceRow.project_volume ?? 0),
        target,
      })
    }
  }
  return refs
}

function createProjectTargetForRow(row: WorkbookGroupedRow): ProjectEditTarget | null {
  if (!row.object_id || !row.work_type_id) return null
  const useVisiblePk = row.segment_count <= 1
  return {
    kind: 'create',
    object_id: row.object_id,
    work_type_id: row.work_type_id,
    unit: row.unit || null,
    pk_start: useVisiblePk ? row.pk_start : null,
    pk_end: useVisiblePk ? row.pk_end : null,
    pk_raw_text: useVisiblePk ? row.pk_label : null,
  }
}

function singleProjectEditTarget(row: WorkbookGroupedRow): ProjectEditTarget | null {
  const refs = editableProjectRefs(row)
  if (refs.length === 1) return refs[0].target
  if (refs.length === 0) return createProjectTargetForRow(row)
  return null
}

function groupKey(row: WorkbookRow): string {
  return [
    row.category,
    row.section_code || '',
    row.object_id || row.object_code || row.object_name || '',
    row.work_type_id || row.work_type_code || row.work_type_name || '',
    normalizeStatementUnit(row.unit),
    row.pile_length_m == null ? '' : String(row.pile_length_m),
  ].join('||')
}

function groupWorkbookRows(rows: WorkbookRow[], days: WorkbookDay[]): WorkbookGroupedRow[] {
  const grouped = new Map<string, WorkbookGroupedRow>()
  for (const row of rows) {
    const key = groupKey(row)
    let group = grouped.get(key)
    if (!group) {
      group = {
        ...row,
        id: `group:${key}`,
        category_sort_order: row.category_sort_order ?? 9999,
        day_values: emptyDayMap(days),
        pk_start: null,
        pk_end: null,
        pk_label: null,
        project_volume: 0,
        month_plan: 0,
        month_fact: 0,
        cumulative_plan: 0,
        cumulative_fact: 0,
        material_project_volume: 0,
        material_month_plan: 0,
        material_month_fact: 0,
        material_cumulative_plan: 0,
        material_cumulative_fact: 0,
        month_amount: 0,
        month_amount_missing_rate: false,
        month_amount_regions: [],
        cumulative_amount: 0,
        cumulative_amount_missing_rate: false,
        cumulative_amount_regions: [],
        cumulative_pk_ranges: [],
        cumulative_pk_segments: [],
        project_refs: [],
        project_item_id: null,
        project_segment_id: null,
        project_segment_count: 0,
        can_edit_project: false,
        compaction_factor: row.compaction_factor ?? 1,
        compaction_coefficient: row.compaction_coefficient ?? 1,
        compaction_label: row.compaction_label ?? null,
        pile_length_m: row.pile_length_m ?? null,
        unit_rate_novgorod: row.unit_rate_novgorod ?? null,
        unit_rate_tver: row.unit_rate_tver ?? null,
        unit_rate_source_novgorod: row.unit_rate_source_novgorod ?? null,
        unit_rate_source_tver: row.unit_rate_source_tver ?? null,
        current_year_plan: 0,
        current_year_plan_amount: null,
        current_year_plan_amount_missing_rate: false,
        current_decade_plan: 0,
        current_decade_plan_amount: null,
        current_decade_plan_amount_missing_rate: false,
        month_plan_amount: null,
        month_plan_amount_missing_rate: false,
        month_plan_amount_regions: [],
        month_percent: null,
        cumulative_percent: null,
        current_year_amount: null,
        current_year_amount_missing_rate: false,
        current_decade_amount: null,
        current_decade_amount_missing_rate: false,
        month_details: [],
        cumulative_details: [],
        source_rows: [],
        segment_count: 0,
      }
      grouped.set(key, group)
    }
    if (group.section_sort_order == null && row.section_sort_order != null) group.section_sort_order = row.section_sort_order
    group.source_rows.push(row)
    if (row.month_plan_locked) {
      group.month_plan_locked = true
      group.month_plan_source = row.month_plan_source || group.month_plan_source || 'Подписанная производственная программа'
    }
    group.project_refs = [...(group.project_refs || []), ...sourceProjectRefs(row)]
    group.project_segment_count = Number(group.project_segment_count || 0) + Number(row.project_segment_count || 0)
    group.segment_count += 1
    group.pk_start = mergePkStart(group.pk_start, row.pk_start)
    group.pk_end = mergePkEnd(group.pk_end, row.pk_end)
    group.pk_label = formatPkRange(group.pk_start, group.pk_end)
    group.project_volume += Number(row.project_volume || 0)
    group.month_plan += Number(row.month_plan || 0)
    group.current_year_plan = Number(group.current_year_plan || 0) + Number(row.current_year_plan || 0)
    group.current_decade_plan = Number(group.current_decade_plan || 0) + Number(row.current_decade_plan || 0)
    group.month_fact += Number(row.month_fact || 0)
    group.cumulative_plan += Number(row.cumulative_plan || 0)
    group.cumulative_fact += Number(row.cumulative_fact || 0)
    group.material_project_volume = Number(group.material_project_volume || 0) + Number(row.material_project_volume ?? row.project_volume ?? 0)
    group.material_month_plan = Number(group.material_month_plan || 0) + Number(row.material_month_plan ?? row.month_plan ?? 0)
    group.material_month_fact = Number(group.material_month_fact || 0) + Number(row.material_month_fact ?? row.month_fact ?? 0)
    group.material_cumulative_plan = Number(group.material_cumulative_plan || 0) + Number(row.material_cumulative_plan ?? row.cumulative_plan ?? 0)
    group.material_cumulative_fact = Number(group.material_cumulative_fact || 0) + Number(row.material_cumulative_fact ?? row.cumulative_fact ?? 0)
    if (row.month_amount_missing_rate || row.month_amount == null) {
      group.month_amount_missing_rate = Boolean(row.month_amount_missing_rate) || rowMonthFactAbs(row) > ZERO_EPS
    }
    if (row.month_amount != null) group.month_amount = Number(group.month_amount || 0) + Number(row.month_amount || 0)
    group.month_amount_regions = [...(group.month_amount_regions || []), ...((row.month_amount_regions || []).filter(Boolean))]
    if (row.cumulative_amount_missing_rate || row.cumulative_amount == null) {
      group.cumulative_amount_missing_rate = Boolean(row.cumulative_amount_missing_rate) || rowCumulativeFactAbs(row) > ZERO_EPS
    }
    if (row.cumulative_amount != null) group.cumulative_amount = Number(group.cumulative_amount || 0) + Number(row.cumulative_amount || 0)
    group.cumulative_amount_regions = [...(group.cumulative_amount_regions || []), ...((row.cumulative_amount_regions || []).filter(Boolean))]
    if (group.unit_rate_novgorod == null && row.unit_rate_novgorod != null) group.unit_rate_novgorod = row.unit_rate_novgorod
    if (group.unit_rate_tver == null && row.unit_rate_tver != null) group.unit_rate_tver = row.unit_rate_tver
    if (!group.unit_rate_source_novgorod && row.unit_rate_source_novgorod) group.unit_rate_source_novgorod = row.unit_rate_source_novgorod
    if (!group.unit_rate_source_tver && row.unit_rate_source_tver) group.unit_rate_source_tver = row.unit_rate_source_tver
    if (group.month_plan_amount_missing_rate || row.month_plan_amount_missing_rate || (row.month_plan_amount == null && Math.abs(Number(row.month_plan || 0)) > ZERO_EPS)) {
      group.month_plan_amount_missing_rate = true
    }
    if (row.month_plan_amount != null && !group.month_plan_amount_missing_rate) group.month_plan_amount = Number(group.month_plan_amount || 0) + Number(row.month_plan_amount || 0)
    group.month_plan_amount_regions = [...(group.month_plan_amount_regions || []), ...((row.month_plan_amount_regions || []).filter(Boolean))]
    if (group.current_year_plan_amount_missing_rate || row.current_year_plan_amount_missing_rate || (row.current_year_plan_amount == null && Math.abs(Number(row.current_year_plan || 0)) > ZERO_EPS)) {
      group.current_year_plan_amount_missing_rate = true
    }
    if (row.current_year_plan_amount != null && !group.current_year_plan_amount_missing_rate) group.current_year_plan_amount = Number(group.current_year_plan_amount || 0) + Number(row.current_year_plan_amount || 0)
    if (group.current_decade_plan_amount_missing_rate || row.current_decade_plan_amount_missing_rate || (row.current_decade_plan_amount == null && Math.abs(Number(row.current_decade_plan || 0)) > ZERO_EPS)) {
      group.current_decade_plan_amount_missing_rate = true
    }
    if (row.current_decade_plan_amount != null && !group.current_decade_plan_amount_missing_rate) group.current_decade_plan_amount = Number(group.current_decade_plan_amount || 0) + Number(row.current_decade_plan_amount || 0)
    if (group.current_year_amount_missing_rate || row.current_year_amount_missing_rate) {
      group.current_year_amount_missing_rate = true
    }
    if (row.current_year_amount != null && !group.current_year_amount_missing_rate) group.current_year_amount = Number(group.current_year_amount || 0) + Number(row.current_year_amount || 0)
    if (group.current_decade_amount_missing_rate || row.current_decade_amount_missing_rate) {
      group.current_decade_amount_missing_rate = true
    }
    if (row.current_decade_amount != null && !group.current_decade_amount_missing_rate) group.current_decade_amount = Number(group.current_decade_amount || 0) + Number(row.current_decade_amount || 0)
    group.cumulative_pk_segments = mergePkSegments([...(group.cumulative_pk_segments || []), ...((row.cumulative_pk_segments || []).filter(Boolean))])
    group.cumulative_pk_ranges = group.cumulative_pk_segments.map(segment => segment.label)
    if (!group.compaction_label && row.compaction_label) group.compaction_label = row.compaction_label
    group.month_details = [...group.month_details, ...((row.month_details || []).map(detail => ({ ...detail, pk_start: detail.pk_start ?? row.pk_start, pk_end: detail.pk_end ?? row.pk_end, pk_range: detail.pk_range || rowPkLabel(row) })))]
    group.cumulative_details = [...group.cumulative_details, ...((row.cumulative_details || []).map(detail => ({ ...detail, pk_start: detail.pk_start ?? row.pk_start, pk_end: detail.pk_end ?? row.pk_end, pk_range: detail.pk_range || rowPkLabel(row) })))]
    addDayValues(group.day_values as Record<string, WorkbookDayValue>, dayValuesMap(row), days)
  }
  const result = Array.from(grouped.values())
  for (const row of result) {
    row.project_volume = Math.round(row.project_volume * 1000) / 1000
    row.month_plan = Math.round(row.month_plan * 1000) / 1000
    row.current_year_plan = Math.round(Number(row.current_year_plan || 0) * 1000) / 1000
    row.current_decade_plan = Math.round(Number(row.current_decade_plan || 0) * 1000) / 1000
    row.month_fact = Math.round(row.month_fact * 1000) / 1000
    row.cumulative_plan = Math.round(row.cumulative_plan * 1000) / 1000
    row.cumulative_fact = Math.round(row.cumulative_fact * 1000) / 1000
    row.material_project_volume = Math.round(Number(row.material_project_volume || 0) * 1000) / 1000
    row.material_month_plan = Math.round(Number(row.material_month_plan || 0) * 1000) / 1000
    row.material_month_fact = Math.round(Number(row.material_month_fact || 0) * 1000) / 1000
    row.material_cumulative_plan = Math.round(Number(row.material_cumulative_plan || 0) * 1000) / 1000
    row.material_cumulative_fact = Math.round(Number(row.material_cumulative_fact || 0) * 1000) / 1000
    const hasMonthAmount = Math.abs(Number(row.month_amount || 0)) > ZERO_EPS || (row.month_amount_regions || []).some(region => region.amount != null)
    const hasCumulativeAmount = Math.abs(Number(row.cumulative_amount || 0)) > ZERO_EPS || (row.cumulative_amount_regions || []).some(region => region.amount != null)
    const hasMonthPlanAmount = Math.abs(Number(row.month_plan_amount || 0)) > ZERO_EPS || (row.month_plan_amount_regions || []).some(region => region.amount != null)
    row.month_amount = hasMonthAmount ? Math.round(Number(row.month_amount || 0) * 100) / 100 : null
    row.cumulative_amount = hasCumulativeAmount ? Math.round(Number(row.cumulative_amount || 0) * 100) / 100 : null
    row.month_plan_amount = hasMonthPlanAmount ? Math.round(Number(row.month_plan_amount || 0) * 100) / 100 : null
    if (row.current_year_plan_amount != null) row.current_year_plan_amount = Math.round(Number(row.current_year_plan_amount || 0) * 100) / 100
    if (row.current_decade_plan_amount != null) row.current_decade_plan_amount = Math.round(Number(row.current_decade_plan_amount || 0) * 100) / 100
    if (row.current_year_amount != null) row.current_year_amount = Math.round(Number(row.current_year_amount || 0) * 100) / 100
    if (row.current_decade_amount != null) row.current_decade_amount = Math.round(Number(row.current_decade_amount || 0) * 100) / 100
    row.month_percent = row.month_plan ? Math.round(row.month_fact / row.month_plan * 1000) / 10 : null
    row.cumulative_percent = row.project_volume ? Math.round(row.cumulative_fact / row.project_volume * 1000) / 10 : null
  }
  result.sort((a, b) => (
    String(a.object_type_name || a.object_type_code || '').localeCompare(String(b.object_type_name || b.object_type_code || ''), 'ru') ||
    sectionSortOrder(a.section_sort_order, a.section_code) - sectionSortOrder(b.section_sort_order, b.section_code) ||
    String(a.section_code || '').localeCompare(String(b.section_code || ''), 'ru') ||
    (Number(a.pk_start ?? Number.MAX_SAFE_INTEGER) - Number(b.pk_start ?? Number.MAX_SAFE_INTEGER)) ||
    String(rowObjectLabel(a)).localeCompare(String(rowObjectLabel(b)), 'ru') ||
    (Number(a.category_sort_order ?? 9999) - Number(b.category_sort_order ?? 9999)) ||
    String(a.category_label || '').localeCompare(String(b.category_label || ''), 'ru') ||
    String(rowWorkLabel(a)).localeCompare(String(rowWorkLabel(b)), 'ru')
  ))
  return result
}

function quarryHaulDisplayRows(items?: SectionSandSummary[]): QuarryHaulDisplayRow[] {
  const rows: QuarryHaulDisplayRow[] = []
  for (const section of items || []) {
    const sectionCode = section.section_code || null
    const sectionLabel = section.section_name || section.section_code || 'Без участка'
    const materials = section.materials?.length
      ? section.materials
      : [{ material_name: 'Песок', material_code: 'SAND', total_volume: section.total_volume, unit: section.unit, sources: [{ source_bucket: 'all', source_label: 'Все силы', total_volume: section.total_volume, unit: section.unit, quarries: section.quarries || [] }] }]
    for (const material of materials) {
      for (const source of material.sources || []) {
        for (const quarry of source.quarries || []) {
          rows.push({
            key: [
              sectionCode || 'none',
              material.material_code || material.material_name || 'material',
              source.source_bucket || source.source_label || 'source',
              quarry.quarry_id || quarry.quarry_code || quarry.quarry_name || 'quarry',
            ].join(':'),
            sectionCode,
            sectionLabel,
            materialLabel: material.material_name || material.material_code || 'Материал не указан',
            sourceLabel: source.source_label || source.source_bucket || 'Силы не указаны',
            quarryLabel: quarry.quarry_name || quarry.quarry_code || 'Карьер не указан',
            volume: Number(quarry.volume || 0),
            cumulativeVolume: Number(quarry.cumulative_volume || 0),
            unit: quarry.unit || source.unit || material.unit || section.unit || 'м3',
            dayValues: quarry.day_values || {},
          })
        }
      }
    }
  }
  return rows.sort((a, b) => (
    sectionOrderFromCode(a.sectionCode) - sectionOrderFromCode(b.sectionCode) ||
    a.sectionLabel.localeCompare(b.sectionLabel, 'ru') ||
    a.materialLabel.localeCompare(b.materialLabel, 'ru') ||
    a.sourceLabel.localeCompare(b.sourceLabel, 'ru') ||
    a.quarryLabel.localeCompare(b.quarryLabel, 'ru')
  ))
}

function haulRowsBySection(rows: QuarryHaulDisplayRow[]): Map<string, QuarryHaulDisplayRow[]> {
  const result = new Map<string, QuarryHaulDisplayRow[]>()
  for (const row of rows) {
    const key = row.sectionCode || 'none'
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push(row)
  }
  return result
}

function expansionStateForRows(
  rows: WorkbookGroupedRow[],
  expandedValue = true,
  groupMode: WorkbookGroupMode = 'objectType',
  quarryHaulRows: QuarryHaulDisplayRow[] = [],
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const row of rows) {
    const typeKeyRaw = row.object_type_code || row.object_type_name || 'none'
    const sectionKeyRaw = row.section_code || 'none'
    const objectKeyRaw = row.object_id || row.object_code || row.object_name || 'none'
    if (groupMode === 'section') {
      const sectionKey = `section:${sectionKeyRaw}`
      const objectTypeKey = `${sectionKey}:type:${typeKeyRaw}`
      const objectKey = `${objectTypeKey}:object:${objectKeyRaw}`
      next[sectionKey] = expandedValue
      next[objectTypeKey] = expandedValue
      next[objectKey] = expandedValue
    } else {
      const objectTypeKey = `type:${typeKeyRaw}`
      const sectionKey = `${objectTypeKey}:section:${sectionKeyRaw}`
      const objectKey = `${sectionKey}:object:${objectKeyRaw}`
      next[objectTypeKey] = expandedValue
      next[sectionKey] = expandedValue
      next[objectKey] = expandedValue
    }
  }
  if (groupMode === 'section') {
    for (const row of quarryHaulRows) {
      const sectionKey = `section:${row.sectionCode || 'none'}`
      next[sectionKey] = expandedValue
      next[`${sectionKey}:haul`] = expandedValue
    }
  } else if (quarryHaulRows.length) {
    next['type:quarry-haul'] = expandedValue
    for (const row of quarryHaulRows) {
      next[`type:quarry-haul:section:${row.sectionCode || 'none'}`] = expandedValue
    }
  }
  return next
}

function emitObjectItems(
  items: DisplayItem[],
  rows: WorkbookGroupedRow[],
  parentKey: string,
  expanded: Record<string, boolean>,
  forceOpen: boolean,
  rowLimit: number,
  emittedRows: { count: number },
) {
  const byObject = new Map<string, WorkbookGroupedRow[]>()
  for (const row of rows) {
    const objectKey = row.object_id || row.object_code || row.object_name || 'none'
    if (!byObject.has(objectKey)) byObject.set(objectKey, [])
    byObject.get(objectKey)!.push(row)
  }
  for (const [objectKeyRaw, objectRows] of byObject) {
    const objectKey = `${parentKey}:object:${objectKeyRaw}`
    const objectExpanded = forceOpen || Boolean(expanded[objectKey])
    const first = objectRows[0]
    items.push({
      kind: 'object',
      key: objectKey,
      label: rowObjectLabel(first),
      hint: [rowPkLabel(first), `${objectRows.length} работ`].filter(Boolean).join(' · '),
      count: objectRows.length,
      expanded: objectExpanded,
      objectId: first.object_id || null,
      summary: groupAmountSummary(objectRows),
    })
    if (!objectExpanded) continue
    for (const row of objectRows) {
      if (emittedRows.count >= rowLimit) continue
      items.push({ kind: 'row', key: row.id, row })
      emittedRows.count += 1
    }
  }
}

function emitHaulItems(
  items: DisplayItem[],
  rows: QuarryHaulDisplayRow[],
  key: string,
  expanded: Record<string, boolean>,
  forceOpen: boolean,
) {
  if (!rows.length) return
  const isExpanded = forceOpen || Boolean(expanded[key])
  items.push({ kind: 'haulGroup', key, label: 'Вывоз с карьеров', count: rows.length, expanded: isExpanded })
  if (!isExpanded) return
  for (const row of rows) items.push({ kind: 'haulRow', key: `${key}:row:${row.key}`, row })
}

function emitHaulRowsBySection(
  items: DisplayItem[],
  rows: QuarryHaulDisplayRow[],
  parentKey: string,
  expanded: Record<string, boolean>,
  forceOpen: boolean,
) {
  const bySection = haulRowsBySection(rows)
  const sectionEntries = [...bySection.entries()]
    .sort(([aKey, aRows], [bKey, bRows]) => compareSectionGroups(aKey, [], aRows, bKey, [], bRows))
  for (const [sectionKeyRaw, sectionRows] of sectionEntries) {
    const sectionKey = `${parentKey}:section:${sectionKeyRaw}`
    const sectionExpanded = forceOpen || Boolean(expanded[sectionKey])
    items.push({
      kind: 'section',
      key: sectionKey,
      label: sectionRows[0]?.sectionLabel || 'Без участка',
      count: sectionRows.length,
      expanded: sectionExpanded,
    })
    if (!sectionExpanded) continue
    for (const row of sectionRows) items.push({ kind: 'haulRow', key: `${sectionKey}:haul:${row.key}`, row })
  }
}

function buildDisplayItems(
  rows: WorkbookGroupedRow[],
  expanded: Record<string, boolean>,
  forceOpen: boolean,
  rowLimit: number,
  groupMode: WorkbookGroupMode,
  quarryHaulRows: QuarryHaulDisplayRow[],
): DisplayItem[] {
  const items: DisplayItem[] = []
  const emittedRows = { count: 0 }
  const haulBySection = haulRowsBySection(quarryHaulRows)

  if (groupMode === 'section') {
    const bySection = new Map<string, WorkbookGroupedRow[]>()
    for (const row of rows) {
      const key = row.section_code || 'none'
      if (!bySection.has(key)) bySection.set(key, [])
      bySection.get(key)!.push(row)
    }
    const sectionKeys = [...bySection.keys()]
    for (const key of haulBySection.keys()) {
      if (!bySection.has(key)) sectionKeys.push(key)
    }
    sectionKeys.sort((a, b) => compareSectionGroups(
      a,
      bySection.get(a) || [],
      haulBySection.get(a) || [],
      b,
      bySection.get(b) || [],
      haulBySection.get(b) || [],
    ))
    for (const sectionKeyRaw of sectionKeys) {
      const sectionRows = bySection.get(sectionKeyRaw) || []
      const sectionHaulRows = haulBySection.get(sectionKeyRaw) || []
      const sectionKey = `section:${sectionKeyRaw}`
      const sectionExpanded = forceOpen || Boolean(expanded[sectionKey])
      items.push({
        kind: 'section',
        key: sectionKey,
        label: sectionRows[0]?.section_name || sectionRows[0]?.section_code || sectionHaulRows[0]?.sectionLabel || 'Без участка',
        count: sectionRows.length + sectionHaulRows.length,
        expanded: sectionExpanded,
        summary: sectionRows.length ? groupAmountSummary(sectionRows) : undefined,
      })
      if (!sectionExpanded) continue
      const byType = new Map<string, WorkbookGroupedRow[]>()
      for (const row of sectionRows) {
        const typeKey = row.object_type_code || row.object_type_name || 'none'
        if (!byType.has(typeKey)) byType.set(typeKey, [])
        byType.get(typeKey)!.push(row)
      }
      const typeEntries = [...byType.entries()]
        .sort(([aKey, aRows], [bKey, bRows]) => compareObjectTypeGroups(aKey, aRows, bKey, bRows))
      for (const [typeKeyRaw, typeRows] of typeEntries) {
        const objectTypeKey = `${sectionKey}:type:${typeKeyRaw}`
        const typeExpanded = forceOpen || Boolean(expanded[objectTypeKey])
        items.push({ kind: 'objectType', key: objectTypeKey, label: typeRows[0]?.object_type_name || typeRows[0]?.object_type_code || 'Без типа объекта', count: typeRows.length, expanded: typeExpanded, summary: groupAmountSummary(typeRows) })
        if (typeExpanded) emitObjectItems(items, typeRows, objectTypeKey, expanded, forceOpen, rowLimit, emittedRows)
      }
      emitHaulItems(items, sectionHaulRows, `${sectionKey}:haul`, expanded, forceOpen)
    }
    return items
  }

  const byType = new Map<string, WorkbookGroupedRow[]>()
  for (const row of rows) {
    const key = row.object_type_code || row.object_type_name || 'none'
    if (!byType.has(key)) byType.set(key, [])
    byType.get(key)!.push(row)
  }

  const typeEntries = [...byType.entries()]
    .sort(([aKey, aRows], [bKey, bRows]) => compareObjectTypeGroups(aKey, aRows, bKey, bRows))
  for (const [typeKey, typeRows] of typeEntries) {
    const typeLabel = typeRows[0]?.object_type_name || typeRows[0]?.object_type_code || 'Без типа объекта'
    const objectTypeKey = `type:${typeKey}`
    const typeExpanded = forceOpen || Boolean(expanded[objectTypeKey])
    items.push({ kind: 'objectType', key: objectTypeKey, label: typeLabel, count: typeRows.length, expanded: typeExpanded, summary: groupAmountSummary(typeRows) })
    if (!typeExpanded) continue

    const bySection = new Map<string, WorkbookGroupedRow[]>()
    for (const row of typeRows) {
      const sectionKey = row.section_code || 'none'
      if (!bySection.has(sectionKey)) bySection.set(sectionKey, [])
      bySection.get(sectionKey)!.push(row)
    }
    const sectionEntries = [...bySection.entries()]
      .sort(([aKey, aRows], [bKey, bRows]) => compareSectionGroups(aKey, aRows, [], bKey, bRows, []))
    for (const [sectionKeyRaw, sectionRows] of sectionEntries) {
      const sectionKey = `${objectTypeKey}:section:${sectionKeyRaw}`
      const sectionExpanded = forceOpen || Boolean(expanded[sectionKey])
      items.push({ kind: 'section', key: sectionKey, label: sectionRows[0]?.section_name || sectionRows[0]?.section_code || 'Без участка', count: sectionRows.length, expanded: sectionExpanded, summary: groupAmountSummary(sectionRows) })
      if (sectionExpanded) emitObjectItems(items, sectionRows, sectionKey, expanded, forceOpen, rowLimit, emittedRows)
    }
  }
  if (quarryHaulRows.length) {
    const haulTypeKey = 'type:quarry-haul'
    const haulExpanded = forceOpen || Boolean(expanded[haulTypeKey])
    items.push({ kind: 'objectType', key: haulTypeKey, label: 'Вывоз с карьеров', count: quarryHaulRows.length, expanded: haulExpanded })
    if (haulExpanded) emitHaulRowsBySection(items, quarryHaulRows, haulTypeKey, expanded, forceOpen)
  }
  return items
}


function filterOptionsFromSections(sections: StatementSection[]): MultiFilterOption[] {
  return [...sections]
    .sort((a, b) => Number(a.sort_order ?? 999) - Number(b.sort_order ?? 999) || a.name.localeCompare(b.name, 'ru'))
    .map(section => ({ value: section.code, label: section.name || section.code }))
}

function filterOptionsFromObjectTypes(types: StatementObjectType[]): MultiFilterOption[] {
  return [...types]
    .sort((a, b) => Number(a.sort_order ?? 999) - Number(b.sort_order ?? 999) || a.name.localeCompare(b.name, 'ru'))
    .map(type => ({ value: type.code, label: type.name || type.code }))
}

function filterOptionsFromObjects(objects: StatementObject[]): MultiFilterOption[] {
  return [...objects]
    .sort((a, b) => (
      String(a.section_code || '').localeCompare(String(b.section_code || ''), 'ru')
      || (Number(a.pk_start ?? Number.MAX_SAFE_INTEGER) - Number(b.pk_start ?? Number.MAX_SAFE_INTEGER))
      || (Number(a.pk_end ?? Number.MAX_SAFE_INTEGER) - Number(b.pk_end ?? Number.MAX_SAFE_INTEGER))
      || objectLabel(a).localeCompare(objectLabel(b), 'ru')
      || String(a.object_code || '').localeCompare(String(b.object_code || ''), 'ru')
    ))
    .map(object => ({
      value: object.id,
      label: objectLabel(object),
      hint: [object.section_name, object.object_type_name, formatPkRange(object.pk_start ?? null, object.pk_end ?? null)].filter(Boolean).join(' · '),
    }))
}

function segmentVolumeInRange(segment: SegmentVolume, rangeStart: number | null, rangeEnd: number | null): number {
  const volume = Number(segment.volume || 0)
  if (volume === 0) return 0
  if (rangeStart == null && rangeEnd == null) return volume
  let from = rangeStart ?? rangeEnd
  let to = rangeEnd ?? rangeStart
  if (from == null || to == null) return volume
  if (from > to) [from, to] = [to, from]
  let start = segment.pk_start ?? segment.pk_end
  let end = segment.pk_end ?? segment.pk_start
  if (start == null || end == null) return volume
  if (start > end) [start, end] = [end, start]
  if (Math.abs(end - start) < 0.001) return start >= from && start <= to ? volume : 0
  const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from))
  if (overlap <= 0) return 0
  return volume * overlap / Math.abs(end - start)
}

function segmentsFromRows(row: WorkbookGroupedRow, field: WorkbookVolumeField): SegmentVolume[] {
  return row.source_rows
    .map((sourceRow, index) => ({
      key: `${field}:${sourceRow.id}:${index}`,
      label: rowPkLabel(sourceRow),
      pk_start: sourceRow.pk_start,
      pk_end: sourceRow.pk_end,
      volume: Number(sourceRow[field] || 0),
      details: field === 'month_fact' || field === 'material_month_fact' ? sourceRow.month_details : field === 'cumulative_fact' || field === 'material_cumulative_fact' ? sourceRow.cumulative_details : undefined,
      sourceRow,
    }))
    .filter(segment => segment.volume !== 0 || segment.pk_start != null || segment.pk_end != null)
}

function buildDetailIntervals(row: WorkbookGroupedRow, rangeStart: number | null, rangeEnd: number | null): DetailInterval[] {
  const project = segmentsFromRows(row, 'project_volume')
  const monthFact = segmentsFromRows(row, 'month_fact')
  const cumulativeFact = segmentsFromRows(row, 'cumulative_fact')
  const materialProject = segmentsFromRows(row, 'material_project_volume')
  const materialMonthFact = segmentsFromRows(row, 'material_month_fact')
  const materialCumulativeFact = segmentsFromRows(row, 'material_cumulative_fact')
  let from = rangeStart ?? row.pk_start
  let to = rangeEnd ?? row.pk_end
  if (from != null && to == null) to = from
  if (to != null && from == null) from = to
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) {
    return [{
      key: 'all',
      pk_start: row.pk_start,
      pk_end: row.pk_end,
      project: project.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
      monthFact: monthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
      cumulativeFact: cumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
      materialProject: materialProject.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
      materialMonthFact: materialMonthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
      materialCumulativeFact: materialCumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0),
    }]
  }
  if (from > to) [from, to] = [to, from]
  if (Math.abs(to - from) < 0.001) {
    return [{
      key: `${from}:${to}`,
      pk_start: from,
      pk_end: to,
      project: project.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
      monthFact: monthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
      cumulativeFact: cumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
      materialProject: materialProject.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
      materialMonthFact: materialMonthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
      materialCumulativeFact: materialCumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, from, to), 0),
    }]
  }

  const intervals: DetailInterval[] = []
  let cursor = from
  let guard = 0
  while (cursor < to - 0.001 && guard < 2000) {
    let next = Math.min(to, nextWholePkBoundary(cursor))
    if (next <= cursor + 0.001) next = Math.min(to, cursor + 100)
    const interval = {
      key: `${cursor}:${next}`,
      pk_start: cursor,
      pk_end: next,
      project: project.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
      monthFact: monthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
      cumulativeFact: cumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
      materialProject: materialProject.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
      materialMonthFact: materialMonthFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
      materialCumulativeFact: materialCumulativeFact.reduce((sum, segment) => sum + segmentVolumeInRange(segment, cursor, next), 0),
    }
    if (interval.project || interval.monthFact || interval.cumulativeFact) intervals.push(interval)
    cursor = next
    guard += 1
  }
  return intervals
}


function MultiFilterPanel({ label, options, selected, onChange, emptyLabel }: {
  label: string
  options: MultiFilterOption[]
  selected: string[]
  onChange: (next: string[]) => void
  emptyLabel: string
}) {
  const selectedSet = new Set(selected)
  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter(item => item !== value) : [...selected, value])
  }
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
        <button type="button" onClick={() => onChange([])} disabled={!selected.length} className="text-[11px] font-medium text-accent-red disabled:text-text-muted">Все</button>
      </div>
      <div className="max-h-40 overflow-auto rounded-md border border-border bg-white p-1">
        {options.length ? options.map(option => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm text-text-primary hover:bg-bg-surface">
            <input type="checkbox" checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} className="mt-1 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate" title={option.label}>{option.label}</span>
              {option.hint && <span className="block truncate text-[11px] text-text-muted" title={option.hint}>{option.hint}</span>}
            </span>
          </label>
        )) : <div className="px-2 py-2 text-xs text-text-muted">{emptyLabel}</div>}
      </div>
      <div className="mt-1 truncate text-[11px] text-text-muted">{selected.length ? `Выбрано: ${selected.length}` : 'Все'}</div>
    </div>
  )
}


function DownloadWorkbookModal({
  month,
  sectionOptions,
  objectTypeOptions,
  defaultSections,
  defaultObjectTypes,
  groupMode,
  hideZeroWorks,
  hideZeroObjects,
  onlyWithPlan,
  onlyMissingRate,
  actualSectionBinding,
  search,
  onClose,
}: {
  month: string
  sectionOptions: MultiFilterOption[]
  objectTypeOptions: MultiFilterOption[]
  defaultSections: string[]
  defaultObjectTypes: string[]
  groupMode: WorkbookGroupMode
  hideZeroWorks: boolean
  hideZeroObjects: boolean
  onlyWithPlan: boolean
  onlyMissingRate: boolean
  actualSectionBinding: boolean
  search: string
  onClose: () => void
}) {
  const [sections, setSections] = useState(defaultSections)
  const [objectTypes, setObjectTypes] = useState(defaultObjectTypes)
  const [downloading, setDownloading] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [errorText, setErrorText] = useState('')

  async function download() {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('group_mode', groupMode)
    params.set('hide_zero_works', hideZeroWorks ? 'true' : 'false')
    params.set('hide_zero_objects', hideZeroObjects ? 'true' : 'false')
    params.set('only_with_plan', onlyWithPlan ? 'true' : 'false')
    params.set('only_missing_rate', onlyMissingRate ? 'true' : 'false')
    params.set('actual_section_binding', actualSectionBinding ? 'true' : 'false')
    const section = multiFilterParam(sections)
    const objectType = multiFilterParam(objectTypes)
    if (section) params.set('section', section)
    if (objectType) params.set('object_type', objectType)
    if (search.trim()) params.set('q', search.trim())
    setDownloading(true)
    setErrorText('')
    try {
      let job = await startWorkbookExportJob(params)
      setStatusText(job.message || 'Файл поставлен в очередь генерации')
      while (!job.ready) {
        if (job.status === 'error') throw new Error(job.error || job.message || 'Не удалось сгенерировать XLSX')
        await sleep(1500)
        job = await fetchWorkbookExportJob(job.job_id)
        setStatusText(job.message || (job.status === 'running' ? 'Файл генерируется на сервере' : 'Файл ожидает генерации'))
      }
      await downloadWorkbookExportJob(job)
      onClose()
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Не удалось скачать XLSX')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div className="mx-auto flex max-h-[calc(100vh-24px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:max-h-[calc(100vh-48px)]" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-accent-red">Ведомости</div>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">Скачать XLSX</h2>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-4 overflow-auto px-4 py-4 md:grid-cols-2">
          <MultiFilterPanel label="Участки" options={sectionOptions} selected={sections} onChange={setSections} emptyLabel="Участков нет" />
          <MultiFilterPanel label="Типы объектов" options={objectTypeOptions} selected={objectTypes} onChange={setObjectTypes} emptyLabel="Типов нет" />
          <div className="md:col-span-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-secondary">
            XLSX повторит текущую группировку, поиск и настройки фильтрации строк. Пустой выбор означает все значения.
          </div>
          {(statusText || errorText) && (
            <div className={`md:col-span-2 rounded-md border px-3 py-2 text-xs ${errorText ? 'border-red-200 bg-red-50 text-red-700' : 'border-border bg-white text-text-secondary'}`}>
              {errorText || statusText}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} disabled={downloading} className="rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-60">Отмена</button>
          <button type="button" onClick={download} disabled={downloading} className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"><Download className="h-4 w-4" />{downloading ? 'Готовим...' : 'Скачать XLSX'}</button>
        </div>
      </div>
    </div>
  )
}


function AddWorkModal({
  objects,
  sections,
  workTypes,
  month,
  defaultSectionCode,
  actualSectionBinding,
  isPending,
  onSubmit,
  onClose,
}: {
  objects: StatementObject[]
  sections: StatementSection[]
  workTypes: StatementWorkType[]
  month: string
  defaultSectionCode?: string
  actualSectionBinding: boolean
  isPending: boolean
  onSubmit: (payload: CreateStatementWorkPayload) => void
  onClose: () => void
}) {
  const objectOptions = objects.map(object => ({ key: statementObjectOptionKey(object), object }))
  const [objectKey, setObjectKey] = useState(objectOptions[0]?.key || '')
  const selectedOption = objectOptions.find(option => option.key === objectKey) || objectOptions[0]
  const selectedObject = selectedOption?.object
  const selectedObjectKey = selectedOption?.key || ''
  const [sectionCode, setSectionCode] = useState(defaultSectionCode || selectedObject?.section_code || sections[0]?.code || '')
  const [workTypeId, setWorkTypeId] = useState(workTypes[0]?.id || '')
  const selectedWork = workTypes.find(work => work.id === workTypeId)
  const [unit, setUnit] = useState(selectedWork?.default_unit || selectedWork?.unit || '')
  const [plan, setPlan] = useState('')

  function submit() {
    const value = parseDraftVolume(plan) ?? 0
    if (!selectedObject || !workTypeId) return
    onSubmit({
      object_id: selectedObject.id,
      work_type_id: workTypeId,
      planned_volume: value,
      unit: unit || undefined,
      month,
      section_code: (actualSectionBinding ? sectionCode : selectedObject.section_code) || undefined,
      pk_start: selectedObject.pk_start ?? undefined,
      pk_end: selectedObject.pk_end ?? undefined,
      pk_raw_text: statementObjectPkRawText(selectedObject),
      actual_section_binding: actualSectionBinding,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div className="mx-auto flex max-h-[calc(100vh-24px)] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:max-h-[calc(100vh-48px)]" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-accent-red">Ведомости</div>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">Добавить работу для объекта</h2>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-4 overflow-auto px-4 py-4 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Объект</span>
            <select value={selectedObjectKey} onChange={event => setObjectKey(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
              {objectOptions.map(({ key, object }) => <option key={key} value={key}>{objectLabel(object)} · {object.object_type_name || object.object_type_code || 'тип не указан'} · {object.section_name || object.section_code || 'без участка'} · {formatPkRange(object.pk_start ?? null, object.pk_end ?? null)}</option>)}
            </select>
          </label>
          {actualSectionBinding && (
            <label className="block md:col-span-2">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">Участок плана</span>
              <select value={sectionCode} onChange={event => setSectionCode(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
                {sections.map(section => <option key={section.code} value={section.code}>{section.name || section.code}</option>)}
              </select>
            </label>
          )}
          <label className="block md:col-span-2">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Работа</span>
            <select value={workTypeId} onChange={event => {
              const next = event.target.value
              setWorkTypeId(next)
              const work = workTypes.find(item => item.id === next)
              setUnit(work?.default_unit || work?.unit || '')
            }} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
              {workTypes.map(work => <option key={work.id} value={work.id}>{work.name || work.code || work.id}{work.analytics_tag ? ` · ${work.analytics_tag}` : ''}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Ед.</span>
            <input value={unit} onChange={event => setUnit(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">План месяца</span>
            <input value={plan} onChange={event => setPlan(event.target.value)} placeholder="0" className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-right font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">Отмена</button>
          <button type="button" onClick={submit} disabled={!selectedObject || !workTypeId || (actualSectionBinding && !sectionCode) || isPending} className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-45"><Plus className="h-4 w-4" />Добавить</button>
        </div>
      </div>
    </div>
  )
}


function AddObjectModal({
  sections,
  objectTypes,
  isPending,
  onSubmit,
  onClose,
}: {
  sections: StatementSection[]
  objectTypes: StatementObjectType[]
  isPending: boolean
  onSubmit: (payload: CreateStatementObjectPayload) => void
  onClose: () => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [objectTypeCode, setObjectTypeCode] = useState(objectTypes[0]?.code || 'OTHER')
  const [sectionCode, setSectionCode] = useState(sections[0]?.code || '')
  const [pkFrom, setPkFrom] = useState('')
  const [pkTo, setPkTo] = useState('')
  const selectedType = objectTypes.find(type => type.code === objectTypeCode)
  const codeValue = code.trim().toUpperCase()
  const nameValue = name.trim()
  const pkStart = pkFrom.trim() ? parsePkInput(pkFrom) : null
  const pkEnd = pkTo.trim() ? parsePkInput(pkTo) : pkStart
  const pkInvalid = (pkFrom.trim() && pkStart == null) || (pkTo.trim() && pkEnd == null)
  const duplicateObjectSearch = useMemo(() => [nameValue, codeValue].find(value => value.length >= 2) || '', [nameValue, codeValue])
  const duplicateObjectQuery = useQuery<StatementReferenceCandidatesResponse>({
    queryKey: ['wip', 'settings', 'dedup', 'references', 'object', duplicateObjectSearch],
    enabled: duplicateObjectSearch.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/wip/settings/dedup/references?kind=object&q=${encodeURIComponent(duplicateObjectSearch)}&limit=6`)
      if (!res.ok) return { rows: [] }
      return (await res.json()) as StatementReferenceCandidatesResponse
    },
  })
  const duplicateObjectCandidates = (duplicateObjectQuery.data?.rows || [])
    .filter(candidate => String(candidate.code || '').trim())
    .slice(0, 5)

  function candidateLabel(candidate: StatementReferenceCandidate): string {
    const candidateCode = String(candidate.code || '').trim()
    const candidateName = String(candidate.label || '').trim()
    if (candidateCode && candidateName && candidateCode !== candidateName) return `${candidateName} · ${candidateCode}`
    return candidateName || candidateCode || candidate.id
  }

  function submit() {
    if (!codeValue || !nameValue || !objectTypeCode || pkInvalid) return
    onSubmit({
      object_code: codeValue,
      object_name: nameValue,
      object_type_code: objectTypeCode,
      section_code: sectionCode || undefined,
      pk_start: pkStart ?? undefined,
      pk_end: pkEnd ?? undefined,
      pk_raw_text: [pkFrom.trim(), pkTo.trim()].filter(Boolean).join(' - ') || undefined,
      comment: 'created from statements page',
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div className="mx-auto flex max-h-[calc(100vh-24px)] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:max-h-[calc(100vh-48px)]" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-accent-red">Ведомости</div>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">Добавить объект</h2>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-4 overflow-auto px-4 py-4 md:grid-cols-2">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Код</span>
            <input value={code} onChange={event => setCode(event.target.value)} placeholder="например AD18" className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Название</span>
            <input value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          {duplicateObjectCandidates.length > 0 && (
            <div className="md:col-span-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-[11px] font-semibold text-amber-800">Похожие объекты уже есть в БД</div>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {duplicateObjectCandidates.map(candidate => (
                  <div key={candidate.id} className="flex items-center gap-2 rounded border border-amber-200/80 bg-white px-2 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-text-primary" title={candidateLabel(candidate)}>{candidateLabel(candidate)}</div>
                      <div className="text-[10px] text-text-muted">{candidate.ref_count || 0} ссылок{candidate.review_tag ? ` · ${candidate.review_tag}` : ''}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCode(String(candidate.code || ''))
                        setName(String(candidate.label || candidate.code || ''))
                      }}
                      className="shrink-0 rounded border border-border bg-white px-2 py-1 text-[11px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red"
                    >
                      Взять
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Тип объекта</span>
            <select value={objectTypeCode} onChange={event => setObjectTypeCode(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
              {objectTypes.map(type => <option key={type.code} value={type.code}>{type.name || type.code}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Участок</span>
            <select value={sectionCode} onChange={event => setSectionCode(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
              <option value="">Без участка</option>
              {sections.map(section => <option key={section.code} value={section.code}>{section.name || section.code}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">ПК от</span>
            <input value={pkFrom} onChange={event => setPkFrom(event.target.value)} placeholder="ПК2799+80" className={`mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 ${pkFrom.trim() && pkStart == null ? 'border-red-300 bg-red-50' : 'border-border'}`} />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">ПК до</span>
            <input value={pkTo} onChange={event => setPkTo(event.target.value)} placeholder="можно пустым" className={`mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 ${pkTo.trim() && pkEnd == null ? 'border-red-300 bg-red-50' : 'border-border'}`} />
          </label>
          <div className="md:col-span-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-secondary">
            {selectedType?.is_linear ? 'Для линейного типа нужен ПК или участок: без ПК backend возьмет границы выбранного участка.' : 'Для карьеров, накопителей и прочих нелинейных объектов ПК можно не указывать.'}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">Отмена</button>
          <button type="button" onClick={submit} disabled={!codeValue || !nameValue || !objectTypeCode || Boolean(pkInvalid) || isPending} className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-45"><Plus className="h-4 w-4" />Добавить</button>
        </div>
      </div>
    </div>
  )
}

function FactDetailsList({ row, details }: { row: WorkbookRow; details: WorkbookFactDetail[] }) {
  if (!details.length) return <div className="text-sm text-text-muted">Факта по выбранной строке нет.</div>
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border bg-white">
      {details.slice(0, 160).map((detail, index) => (
        <div key={`${detail.date}:${index}:${detail.volume}`} className="grid grid-cols-[110px_80px_minmax(120px,1fr)_150px] gap-2 border-b border-border px-3 py-2 text-xs last:border-0">
          <div className="font-medium text-text-primary">{formatDate(detail.date)}</div>
          <div className="text-text-secondary">{detail.shift || '—'}</div>
          <div className="min-w-0 truncate text-text-secondary" title={detail.pk_range || ''}>{detail.pk_range || 'ПК не указан'}</div>
          <div className="text-right font-mono text-text-primary">{formatWorkMaterialVolume(row, detail.volume, detail.material_volume)}</div>
          <div className="col-span-4 text-[11px] text-text-muted">{sourceBucketLabel(detail.source_bucket)}{detail.work_name ? ` · ${detail.work_name}` : ''}</div>
        </div>
      ))}
      {details.length > 160 && <div className="px-3 py-2 text-xs text-text-muted">Показаны первые 160 строк из {details.length}</div>}
    </div>
  )
}

function RowDetailsModal({
  state,
  onChange,
  onClose,
  canEditProject,
  projectSavePending,
  onSaveProjectVolume,
  rateSavePending,
  onSaveObjectRates,
}: {
  state: SelectedRowState
  onChange: (next: SelectedRowState) => void
  onClose: () => void
  canEditProject: boolean
  projectSavePending: boolean
  onSaveProjectVolume: (target: ProjectEditTarget, value: number, draftKey?: string) => void
  rateSavePending: boolean
  onSaveObjectRates: (item: ObjectRateSaveItem) => void
}) {
  const { row } = state
  const rangeStartRaw = parsePkInput(state.pkFrom)
  const rangeEndRaw = parsePkInput(state.pkTo)
  const rangeStart = rangeStartRaw ?? row.pk_start
  const rangeEnd = rangeEndRaw ?? row.pk_end
  const projectSegments = segmentsFromRows(row, 'project_volume')
  const monthSegments = segmentsFromRows(row, 'month_fact')
  const cumulativeSegments = segmentsFromRows(row, 'cumulative_fact')
  const materialProjectSegments = segmentsFromRows(row, 'material_project_volume')
  const materialMonthSegments = segmentsFromRows(row, 'material_month_fact')
  const materialCumulativeSegments = segmentsFromRows(row, 'material_cumulative_fact')
  const projectInRange = projectSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const monthInRange = monthSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const cumulativeInRange = cumulativeSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const materialProjectInRange = materialProjectSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const materialMonthInRange = materialMonthSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const materialCumulativeInRange = materialCumulativeSegments.reduce((sum, segment) => sum + segmentVolumeInRange(segment, rangeStart, rangeEnd), 0)
  const intervals = state.detailed ? buildDetailIntervals(row, rangeStart, rangeEnd) : []
  const editableRefs = editableProjectRefs(row)
  const [projectSegmentDrafts, setProjectSegmentDrafts] = useState<Record<string, string>>({})
  const [rateDrafts, setRateDrafts] = useState({
    novgorod: row.unit_rate_novgorod == null ? '' : String(row.unit_rate_novgorod),
    tver: row.unit_rate_tver == null ? '' : String(row.unit_rate_tver),
  })
  const activeRateRegions = statementRateRegionsForRow(row)
  const showNovgorodRate = activeRateRegions.includes('novgorod')
  const showTverRate = activeRateRegions.includes('tver')
  const rateInputGridClass = showNovgorodRate && showTverRate
    ? 'grid gap-2 sm:grid-cols-[1fr_1fr_auto]'
    : 'grid gap-2 sm:grid-cols-[1fr_auto]'

  useEffect(() => {
    setRateDrafts({
      novgorod: row.unit_rate_novgorod == null ? '' : String(row.unit_rate_novgorod),
      tver: row.unit_rate_tver == null ? '' : String(row.unit_rate_tver),
    })
  }, [row.id, row.unit_rate_novgorod, row.unit_rate_tver])

  const parsedRateNovgorod = parseOptionalRateDraft(rateDrafts.novgorod)
  const parsedRateTver = parseOptionalRateDraft(rateDrafts.tver)
  const rateDraftInvalid = parsedRateNovgorod === undefined || parsedRateTver === undefined

  function editableRefForSegment(segment: SegmentVolume): EditableProjectRef | null {
    const sourceId = segment.sourceRow?.id
    const matches = editableRefs.filter(ref => ref.sourceRow.id === sourceId)
    return matches.length === 1 ? matches[0] : null
  }

  function segmentDraftValue(ref: EditableProjectRef): string {
    const key = projectEditTargetKey(ref.target)
    if (Object.prototype.hasOwnProperty.call(projectSegmentDrafts, key)) return projectSegmentDrafts[key]
    const value = Number(ref.project_volume ?? 0)
    return value ? String(value) : ''
  }

  function saveSegmentProjectVolume(ref: EditableProjectRef) {
    const key = projectEditTargetKey(ref.target)
    const parsed = parseDraftVolume(segmentDraftValue(ref))
    if (parsed == null || parsed < 0) return
    onSaveProjectVolume(ref.target, parsed, key)
  }

  function saveObjectRates() {
    if (rateDraftInvalid) return
    const preservedNovgorodRate = row.unit_rate_source_novgorod === 'object' ? row.unit_rate_novgorod ?? null : null
    const preservedTverRate = row.unit_rate_source_tver === 'object' ? row.unit_rate_tver ?? null : null
    onSaveObjectRates({
      row,
      rate_novgorod: showNovgorodRate ? parsedRateNovgorod ?? null : preservedNovgorodRate,
      rate_tver: showTverRate ? parsedRateTver ?? null : preservedTverRate,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div className="mx-auto flex max-h-[calc(100vh-24px)] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:max-h-[calc(100vh-48px)]" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-accent-red">{row.category_label}</div>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">{rowWorkLabel(row)}</h2>
            <div className="mt-1 text-sm text-text-secondary">{rowObjectLabel(row)} · {row.section_name || row.section_code || 'Без участка'} · {row.unit || '—'}</div>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red" aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </div>

	        <div className="grid gap-3 border-b border-border bg-bg-surface/70 px-4 py-3 lg:grid-cols-[1.1fr_1.9fr]">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">ПК от</span>
              <input value={state.pkFrom} onChange={event => onChange({ ...state, pkFrom: event.target.value })} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">ПК до</span>
              <input value={state.pkTo} onChange={event => onChange({ ...state, pkTo: event.target.value })} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
            </label>
            <button type="button" onClick={() => onChange({ ...state, pkFrom: row.pk_start == null ? '' : formatPk(row.pk_start), pkTo: row.pk_end == null ? '' : formatPk(row.pk_end) })} className="col-span-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-accent-red">Диапазон строки</button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-border bg-white p-3"><div className="text-xs text-text-muted">ПК</div><div className="mt-1 font-semibold text-text-primary">{formatPkRange(rangeStart, rangeEnd)}</div></div>
            <div className="rounded-md border border-border bg-white p-3"><div className="text-xs text-text-muted">Проект</div><div className="mt-1 font-mono font-semibold text-text-primary">{formatWorkMaterialVolume(row, projectInRange, materialProjectInRange)}</div></div>
            <div className="rounded-md border border-border bg-white p-3"><div className="text-xs text-text-muted">Факт месяца</div><div className="mt-1 font-mono font-semibold text-text-primary">{formatWorkMaterialVolume(row, monthInRange, materialMonthInRange)}</div></div>
            <div className="rounded-md border border-border bg-white p-3"><div className="text-xs text-text-muted">Факт накоп.</div><div className="mt-1 font-mono font-semibold text-text-primary">{formatWorkMaterialVolume(row, cumulativeInRange, materialCumulativeInRange)}</div></div>
	          </div>
	        </div>

	        <div className="border-b border-border px-4 py-3">
	          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
	            <div>
	              <h3 className="text-sm font-semibold text-text-primary">Расценка для расчета стоимости</h3>
	              <div className="mt-0.5 text-xs text-text-muted">Расценка ведомости задается для строки: объект + работа{row.pile_length_m ? ` + длина сваи ${formatVolume(row.pile_length_m)} м` : ''}. Если поле пустое, используется старая справочная расценка из БД.</div>
	            </div>
	            <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
	              {showNovgorodRate && <span className={`rounded border px-2 py-0.5 ${rateSourceClass(row.unit_rate_source_novgorod)}`}>Новгород: {rateSourceLabel(row.unit_rate_source_novgorod)}</span>}
	              {showTverRate && <span className={`rounded border px-2 py-0.5 ${rateSourceClass(row.unit_rate_source_tver)}`}>Тверь: {rateSourceLabel(row.unit_rate_source_tver)}</span>}
	            </div>
	          </div>
	          <div className={rateInputGridClass}>
	            {showNovgorodRate && (
	              <label className="block">
	                <span className="text-[11px] uppercase tracking-wide text-text-muted">Новгородская область, руб./ед.</span>
	                <input value={rateDrafts.novgorod} onChange={event => setRateDrafts(prev => ({ ...prev, novgorod: event.target.value }))} disabled={!canEditProject} className={`mt-1 h-9 w-full rounded-md border bg-white px-3 py-2 text-right font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 disabled:bg-bg-surface ${parsedRateNovgorod === undefined ? 'border-red-300 bg-red-50' : 'border-border'}`} placeholder="справочная" />
	              </label>
	            )}
	            {showTverRate && (
	              <label className="block">
	                <span className="text-[11px] uppercase tracking-wide text-text-muted">Тверская область, руб./ед.</span>
	                <input value={rateDrafts.tver} onChange={event => setRateDrafts(prev => ({ ...prev, tver: event.target.value }))} disabled={!canEditProject} className={`mt-1 h-9 w-full rounded-md border bg-white px-3 py-2 text-right font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 disabled:bg-bg-surface ${parsedRateTver === undefined ? 'border-red-300 bg-red-50' : 'border-border'}`} placeholder="справочная" />
	              </label>
	            )}
	            <button type="button" onClick={saveObjectRates} disabled={!canEditProject || rateDraftInvalid || rateSavePending || !row.object_id || !row.work_type_id} className="self-end rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40">Сохранить расценку</button>
	          </div>
	        </div>

	        <div className="flex-1 overflow-auto px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text-primary">ПК-сегменты: {row.segment_count}</div>
            <button type="button" onClick={() => onChange({ ...state, detailed: !state.detailed })} className={`rounded-md border px-3 py-1.5 text-sm font-medium ${state.detailed ? 'border-accent-red bg-red-50 text-accent-red' : 'border-border bg-white text-text-secondary hover:text-accent-red'}`}>Попикетно</button>
          </div>

          {state.detailed ? (
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-bg-surface text-xs uppercase text-text-muted">
                  <tr><th className="px-3 py-2 text-left">ПК</th><th className="px-3 py-2 text-right">Проект</th><th className="px-3 py-2 text-right">Факт месяца</th><th className="px-3 py-2 text-right">Факт накоп.</th></tr>
                </thead>
                <tbody>
                  {intervals.map(interval => (
                    <tr key={interval.key} className="border-t border-border">
                      <td className="px-3 py-2 font-medium text-text-primary">{formatPkRange(interval.pk_start, interval.pk_end)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatWorkMaterialVolume(row, interval.project, interval.materialProject)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatWorkMaterialVolume(row, interval.monthFact, interval.materialMonthFact)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatWorkMaterialVolume(row, interval.cumulativeFact, interval.materialCumulativeFact)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">Проектные сегменты</h3>
                <div className="max-h-72 overflow-auto rounded-md border border-border bg-white">
                  {projectSegments.length ? projectSegments.slice(0, 160).map(segment => {
                    const materialSegment = materialProjectSegments.find(item => item.key === segment.key.replace('project_volume:', 'material_project_volume:'))
                    const editableRef = canEditProject ? editableRefForSegment(segment) : null
                    const editKey = editableRef ? projectEditTargetKey(editableRef.target) : ''
                    const rawDraft = editableRef ? segmentDraftValue(editableRef) : ''
                    const parsedDraft = editableRef ? parseDraftVolume(rawDraft) : null
                    const dirty = Boolean(editKey && Object.prototype.hasOwnProperty.call(projectSegmentDrafts, editKey))
                    const invalid = dirty && (rawDraft.trim() === '' || parsedDraft == null || parsedDraft < 0)
                    return (
                      <div key={segment.key} className="grid grid-cols-[minmax(120px,1fr)_170px_150px] gap-2 border-b border-border px-3 py-2 text-xs last:border-0">
                        <div className="truncate font-medium text-text-primary" title={segment.label}>{segment.label}</div>
                        {editableRef ? (
                          <div className="flex items-center justify-end gap-1">
                            <input
                              value={rawDraft}
                              onChange={event => setProjectSegmentDrafts(prev => ({ ...prev, [editKey]: event.target.value }))}
                              onKeyDown={event => { if (event.key === 'Enter') saveSegmentProjectVolume(editableRef) }}
                              className={`h-7 w-24 rounded-md border bg-white px-2 text-right font-mono text-xs outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 ${invalid ? 'border-red-300 bg-red-50' : dirty ? 'border-amber-300 bg-amber-50/40' : 'border-border'}`}
                              placeholder="0"
                            />
                            <button type="button" onClick={() => saveSegmentProjectVolume(editableRef)} disabled={invalid || parsedDraft == null || projectSavePending} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-muted hover:border-accent-red/50 hover:text-accent-red disabled:opacity-40" title="Сохранить проектный сегмент">
                              <Save className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="text-right font-mono text-text-secondary">{formatWorkMaterialVolume(row, segment.volume, materialSegment?.volume)}</div>
                        )}
                        <div className="text-right font-mono text-accent-red">{formatWorkMaterialVolume(row, segmentVolumeInRange(segment, rangeStart, rangeEnd), materialSegment ? segmentVolumeInRange(materialSegment, rangeStart, rangeEnd) : undefined)}</div>
                      </div>
                    )
                  }) : <div className="px-3 py-3 text-sm text-text-muted">Проектных сегментов нет.</div>}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">Факт за месяц</h3>
                <FactDetailsList row={row} details={row.month_details} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatementsActionBar({
  dirtyDraftCount,
  invalidDraftCount,
  canAddWork,
  canAddObject,
  isFetching,
  isSaving,
  hideZeroWorks,
  hideZeroObjects,
  onlyWithPlan,
  onlyMissingRate,
  onAddWork,
  onAddObject,
  onExpandAll,
  onCollapseAll,
  onRefresh,
  onToggleHideZeroWorks,
  onToggleHideZeroObjects,
  onToggleOnlyWithPlan,
  onToggleOnlyMissingRate,
  onDownload,
  onSavePlans,
}: {
  dirtyDraftCount: number
  invalidDraftCount: number
  canAddWork: boolean
  canAddObject: boolean
  isFetching: boolean
  isSaving: boolean
  hideZeroWorks: boolean
  hideZeroObjects: boolean
  onlyWithPlan: boolean
  onlyMissingRate: boolean
  onAddWork: () => void
  onAddObject: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onRefresh: () => void
  onToggleHideZeroWorks: () => void
  onToggleHideZeroObjects: () => void
  onToggleOnlyWithPlan: () => void
  onToggleOnlyMissingRate: () => void
  onDownload: () => void
  onSavePlans: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-white px-4 py-2 sm:px-6">
      <button type="button" onClick={onAddWork} disabled={!canAddWork} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:border-accent-red/50 hover:text-accent-red disabled:opacity-50">
        <Plus className="h-4 w-4" />Добавить работу
      </button>
      <button type="button" onClick={onAddObject} disabled={!canAddObject} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:border-accent-red/50 hover:text-accent-red disabled:opacity-50">
        <Plus className="h-4 w-4" />Добавить объект
      </button>
      <div className="mx-1 h-6 w-px bg-border" />
      <button type="button" onClick={onExpandAll} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ChevronDown className="h-4 w-4" />Развернуть все
      </button>
      <button type="button" onClick={onCollapseAll} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ChevronRight className="h-4 w-4" />Свернуть все
      </button>
      <button type="button" onClick={onRefresh} disabled={isFetching} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
        <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />Обновить
      </button>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
        <input type="checkbox" checked={hideZeroWorks} onChange={onToggleHideZeroWorks} className="h-3.5 w-3.5" />
        Скрывать нулевые работы
      </label>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
        <input type="checkbox" checked={hideZeroObjects} onChange={onToggleHideZeroObjects} className="h-3.5 w-3.5" />
        Скрывать нулевые объекты за период
      </label>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
        <input type="checkbox" checked={onlyWithPlan} onChange={onToggleOnlyWithPlan} className="h-3.5 w-3.5" />
        План
      </label>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
        <input type="checkbox" checked={onlyMissingRate} onChange={onToggleOnlyMissingRate} className="h-3.5 w-3.5" />
        Без расценки
      </label>
      <button type="button" onClick={onDownload} className="ml-auto inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:border-accent-red/50 hover:text-accent-red">
        <Download className="h-4 w-4" />Скачать
      </button>
      <button type="button" onClick={onSavePlans} disabled={!dirtyDraftCount || invalidDraftCount > 0 || isSaving} className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-45">
        <Save className="h-4 w-4" />Сохранить планы{dirtyDraftCount ? ` (${dirtyDraftCount})` : ''}
      </button>
    </div>
  )
}

export default function StatementsPage() {
  const queryClient = useQueryClient()
  const { isAdmin, user } = useAuth()
  const canEditProjectData = hasStatementsProjectWriteRights(user)
  const [month, setMonth] = useState(currentMonth)
  const [selectedSections, setSelectedSections] = useState<string[]>([])
  const [selectedObjectTypes, setSelectedObjectTypes] = useState<string[]>([])
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({})
  const [rowWindow, setRowWindow] = useState<{ signature: string; limit: number }>({ signature: '', limit: ROW_WINDOW_SIZE })
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [selectedRow, setSelectedRow] = useState<SelectedRowState | null>(null)
  const [financialDetail, setFinancialDetail] = useState<FinancialDetailState | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [groupMode, setGroupMode] = useState<WorkbookGroupMode>('section')
  const [actualSectionBinding, setActualSectionBinding] = useState(false)
  const [hideZeroWorks, setHideZeroWorks] = useState(false)
  const [hideZeroObjects, setHideZeroObjects] = useState(false)
  const [onlyWithPlan, setOnlyWithPlan] = useState(false)
  const [onlyMissingRate, setOnlyMissingRate] = useState(false)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [addWorkOpen, setAddWorkOpen] = useState(false)
  const [addObjectOpen, setAddObjectOpen] = useState(false)

  useEffect(() => {
    const nextSearch = searchInput.trim()
    const timer = window.setTimeout(() => {
      setSearch(current => current === nextSearch ? current : nextSearch)
    }, STATEMENTS_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const filters = useMemo<WorkbookFilters>(() => ({
    month,
    sections: selectedSections,
    objectTypes: selectedObjectTypes,
    objectIds: selectedObjectIds,
    search,
    actualSectionBinding,
  }), [actualSectionBinding, month, search, selectedObjectIds, selectedObjectTypes, selectedSections])

  const filterSignature = useMemo(() => JSON.stringify({ filters, groupMode, hideZeroWorks, hideZeroObjects, onlyWithPlan, onlyMissingRate }), [filters, groupMode, hideZeroObjects, hideZeroWorks, onlyMissingRate, onlyWithPlan])
  const metadataFilters = useMemo<WorkbookFilters>(() => ({
    month,
    sections: selectedSections,
    objectTypes: selectedObjectTypes,
    objectIds: [],
    search: '',
    actualSectionBinding,
  }), [actualSectionBinding, month, selectedObjectTypes, selectedSections])
  const metadataQueryKey = useMemo(() => ['wip-statements-metadata', metadataFilters] as const, [metadataFilters])
  const metadataQuery = useQuery({
    queryKey: metadataQueryKey,
    queryFn: ({ signal }) => fetchStatementsMetadata(metadataFilters, signal),
    staleTime: 300_000,
    gcTime: 30 * 60_000,
    placeholderData: previousData => previousData,
    refetchOnWindowFocus: false,
  })
  const metadata = metadataQuery.data
  const queryKey = useMemo(() => ['wip-statements-general-workbook', filters] as const, [filters])
  const { data, isError, error, isFetching, isLoading, isPlaceholderData, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchWorkbook(filters, signal),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    placeholderData: previousData => previousData,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (data?.cache?.status !== 'stale') return
    const timer = window.setTimeout(() => {
      void refetch()
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [data?.cache?.fingerprint, data?.cache?.generated_at, data?.cache?.status, refetch])

  const savePlanMutation = useMutation({
    mutationFn: async (items: MonthPlanSaveItem[]) => Promise.all(items.map(saveWorkbookMonthPlan)),
    onSuccess: async results => {
      const inserted = results.reduce((sum, item) => sum + Number(item.inserted || 0), 0)
      setStatus({ kind: 'ok', text: `План месяца сохранен, дневных строк: ${inserted}` })
      setDrafts({})
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка сохранения плана' }),
  })

  const saveProjectMutation = useMutation({
    mutationFn: saveWorkbookProjectVolume,
    onSuccess: async (_result, item) => {
      if (item.draftKey) {
        setProjectDrafts(prev => {
          const next = { ...prev }
          delete next[item.draftKey!]
          return next
        })
      }
      setStatus({ kind: 'ok', text: 'Проектный объем сохранен, ведомость обновляется' })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка сохранения проектного объема' }),
  })

  const saveRateMutation = useMutation({
    mutationFn: saveWorkbookObjectRates,
    onSuccess: async () => {
      setStatus({ kind: 'ok', text: 'Расценка сохранена, ведомость пересчитывается' })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка сохранения расценки' }),
  })

  const createWorkMutation = useMutation({
    mutationFn: createStatementWorkWithPlan,
    onSuccess: async () => {
      setAddWorkOpen(false)
      setStatus({ kind: 'ok', text: 'Работа добавлена, ведомость обновляется' })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка добавления работы' }),
  })

  const createObjectMutation = useMutation({
    mutationFn: createStatementObject,
    onSuccess: async object => {
      setAddObjectOpen(false)
      setStatus({ kind: 'ok', text: `Объект ${object.object_code || object.object_name} добавлен, ведомость обновляется` })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка добавления объекта' }),
  })

  const deleteObjectWorkMutation = useMutation({
    mutationFn: deleteStatementObjectWork,
    onSuccess: async result => {
      const plan = Number(result.deleted_plan_rows || 0)
      const project = Number(result.deleted_project_rows || 0)
      const segments = Number(result.deleted_project_segments || 0)
      setSelectedRow(null)
      setStatus({ kind: 'ok', text: `Работа удалена: плановых строк ${plan}, проектных строк ${project}, сегментов ${segments}` })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка удаления работы у объекта' }),
  })

  const deleteObjectMutation = useMutation({
    mutationFn: deleteStatementObject,
    onSuccess: async (result, objectId) => {
      const total = Object.values(result.deleted || {}).reduce((sum, value) => sum + Number(value || 0), 0)
      setSelectedRow(null)
      setSelectedObjectIds(prev => prev.filter(id => id !== objectId))
      setStatus({ kind: 'ok', text: `Объект удален, связанных редактируемых строк очищено: ${total}` })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-general-workbook'] })
      await queryClient.invalidateQueries({ queryKey: ['wip-statements-metadata'] })
    },
    onError: err => setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Ошибка удаления объекта' }),
  })

  const sections = metadata?.sections ?? data?.sections ?? []
  const objectTypes = metadata?.object_types ?? data?.object_types ?? []
  const objects = metadata?.objects ?? data?.objects ?? []
  const sectionOptions = useMemo(() => filterOptionsFromSections(sections), [sections])
  const objectTypeOptions = useMemo(() => filterOptionsFromObjectTypes(objectTypes), [objectTypes])
  const objectOptions = useMemo(() => filterOptionsFromObjects(objects), [objects])
  const workTypes = useMemo(() => [...(metadata?.work_types ?? data?.work_types ?? [])].sort((a, b) => String(a.name || a.code || '').localeCompare(String(b.name || b.code || ''), 'ru')), [data?.work_types, metadata?.work_types])
  const rows = data?.rows ?? EMPTY_WORKBOOK_ROWS
  const days = data?.days ?? EMPTY_WORKBOOK_DAYS
  const groupedRows = useMemo(() => groupWorkbookRows(rows, days), [days, rows])
  const filteredGroupedRows = useMemo(() => applyWorkbookVisibilityFilters(groupedRows, hideZeroWorks, hideZeroObjects, onlyWithPlan, onlyMissingRate), [groupedRows, hideZeroObjects, hideZeroWorks, onlyMissingRate, onlyWithPlan])
  const monthLabel = data ? `${formatDate(data.month_start)} - ${formatDate(data.month_end)}` : month
  const visibleLimit = rowWindow.signature === filterSignature ? rowWindow.limit : ROW_WINDOW_SIZE
  const forceExpanded = search.trim().length > 0
  const quarryHaulRows = useMemo(() => quarryHaulDisplayRows(data?.sand_by_section), [data?.sand_by_section])
  const filteredQuarryHaulRows = useMemo(() => (onlyWithPlan || onlyMissingRate ? [] : quarryHaulRows), [onlyMissingRate, onlyWithPlan, quarryHaulRows])
  const displayItems = useMemo(() => buildDisplayItems(filteredGroupedRows, expanded, forceExpanded, visibleLimit, groupMode, filteredQuarryHaulRows), [expanded, filteredGroupedRows, filteredQuarryHaulRows, forceExpanded, groupMode, visibleLimit])
  const baseColumnCount = 13
  const hiddenRowCount = Math.max(0, filteredGroupedRows.length - visibleLimit)
  const workbookCacheStatus = data?.cache?.status
  const workbookStatusText = workbookCacheStatus === 'stale'
    ? 'Показан кеш, свежая версия пересчитывается'
    : isFetching ? 'Обновление данных...' : 'Данные из БД'
  const workbookStatusClass = workbookCacheStatus === 'stale' ? 'text-amber-700' : 'text-text-muted'

  const dirtyDrafts = useMemo(() => Object.entries(drafts).filter(([, value]) => value.trim() !== ''), [drafts])
  const invalidDraftCount = useMemo(() => dirtyDrafts.filter(([, value]) => parseDraftVolume(value) == null).length, [dirtyDrafts])

  function draftKey(row: WorkbookGroupedRow): string {
    return `month-plan:${row.id}`
  }

  function draftValue(row: WorkbookGroupedRow): string {
    const key = draftKey(row)
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key]
    const sourceValue = hasCompaction(row) ? Number(row.material_month_plan ?? row.month_plan ?? 0) : Number(row.month_plan || 0)
    return sourceValue ? String(sourceValue) : ''
  }

  function isDraftDirty(row: WorkbookGroupedRow): boolean {
    return Object.prototype.hasOwnProperty.call(drafts, draftKey(row))
  }

  function projectDraftKey(row: WorkbookGroupedRow): string {
    const target = singleProjectEditTarget(row)
    return target ? projectEditTargetKey(target) : `project:${row.id}`
  }

  function projectDraftValue(row: WorkbookGroupedRow): string {
    const key = projectDraftKey(row)
    if (Object.prototype.hasOwnProperty.call(projectDrafts, key)) return projectDrafts[key]
    return row.project_volume ? String(row.project_volume) : ''
  }

  function isProjectDraftDirty(row: WorkbookGroupedRow): boolean {
    return Object.prototype.hasOwnProperty.call(projectDrafts, projectDraftKey(row))
  }

  function saveProjectVolumeForRow(row: WorkbookGroupedRow) {
    if (!canEditProjectData) return
    const target = singleProjectEditTarget(row)
    if (!target) {
      setStatus({ kind: 'error', text: 'Строка разбита на несколько проектных источников. Откройте детали и меняйте сегменты отдельно.' })
      return
    }
    const key = projectDraftKey(row)
    const parsed = parseDraftVolume(projectDraftValue(row))
    if (parsed == null || parsed < 0) {
      setStatus({ kind: 'error', text: 'Введите корректный неотрицательный проектный объем' })
      return
    }
    saveProjectMutation.mutate({ target, value: parsed, draftKey: key })
  }

  function saveProjectVolumeTarget(target: ProjectEditTarget, value: number, draftKey?: string) {
    if (!canEditProjectData) return
    if (!Number.isFinite(value) || value < 0) {
      setStatus({ kind: 'error', text: 'Введите корректный неотрицательный проектный объем' })
      return
    }
    saveProjectMutation.mutate({ target, value, draftKey })
  }

  function saveRowPlan(row: WorkbookGroupedRow) {
    if (row.month_plan_locked) {
      setStatus({ kind: 'error', text: 'План свайных работ за этот месяц зафиксирован подписанной производственной программой' })
      return
    }
    const key = draftKey(row)
    const parsed = parseDraftVolume(draftValue(row))
    if (parsed == null) {
      setStatus({ kind: 'error', text: 'Введите корректный план месяца' })
      return
    }
    if (!row.object_id || !row.work_type_id) {
      setStatus({ kind: 'error', text: 'У строки нет объекта или вида работ для сохранения плана' })
      return
    }
    savePlanMutation.mutate([{ row, month, value: parsed, draftKey: key, actualSectionBinding }])
  }

  function saveAllDrafts() {
    const items: MonthPlanSaveItem[] = []
    for (const row of groupedRows) {
      if (row.month_plan_locked) continue
      const key = draftKey(row)
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) continue
      const parsed = parseDraftVolume(drafts[key])
      if (parsed == null || !row.object_id || !row.work_type_id) continue
      items.push({ row, month, value: parsed, draftKey: key, actualSectionBinding })
    }
    if (!items.length) {
      setStatus({ kind: 'error', text: 'Нет корректных черновиков для сохранения' })
      return
    }
    savePlanMutation.mutate(items)
  }

  function showMoreRows() {
    setRowWindow({ signature: filterSignature, limit: Math.min(filteredGroupedRows.length, visibleLimit + ROW_WINDOW_SIZE) })
  }

  function toggleExpanded(key: string) {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function expandAllRows() {
    setExpanded(expansionStateForRows(filteredGroupedRows, true, groupMode, filteredQuarryHaulRows))
  }

  function collapseAllRows() {
    setExpanded({})
  }

  function handleTableScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget
    if (hiddenRowCount > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 520) showMoreRows()
  }

  function clearFilters() {
    setSelectedSections([])
    setSelectedObjectTypes([])
    setSelectedObjectIds([])
    setSearchInput('')
    setSearch('')
    setOnlyWithPlan(false)
    setOnlyMissingRate(false)
  }

  function toggleActualSectionBinding() {
    if ((dirtyDrafts.length || Object.keys(projectDrafts).length) && !window.confirm('Несохраненные изменения будут отменены. Переключить привязку объектов?')) return
    setDrafts({})
    setProjectDrafts({})
    setExpanded({})
    setSelectedRow(null)
    setActualSectionBinding(value => !value)
  }

  function openRowDetails(row: WorkbookGroupedRow) {
    setSelectedRow({
      row,
      pkFrom: row.pk_start == null ? '' : formatPk(row.pk_start),
      pkTo: row.pk_end == null ? '' : formatPk(row.pk_end),
      detailed: true,
    })
  }

  function deleteWorkRow(row: WorkbookGroupedRow) {
    if (!isAdmin) return
    if (!row.object_id || !row.work_type_id) {
      setStatus({ kind: 'error', text: 'У строки нет объекта или вида работ для удаления' })
      return
    }
    const confirmed = window.confirm(`Удалить работу "${rowWorkLabel(row)}" у объекта "${rowObjectLabel(row)}"? Плановые и проектные строки будут удалены, если по ним нет фактов.`)
    if (!confirmed) return
    deleteObjectWorkMutation.mutate({ object_id: row.object_id, work_type_id: row.work_type_id, unit: row.unit || undefined })
  }

  function deleteObjectItem(item: Extract<DisplayItem, { kind: 'object' }>) {
    if (!isAdmin || !item.objectId) return
    const confirmed = window.confirm(`Удалить объект "${item.label}"? Это возможно только если по нему нет фактических значений и внешних ссылок.`)
    if (!confirmed) return
    deleteObjectMutation.mutate(item.objectId)
  }

  return (
    <div className="min-h-screen bg-bg-page text-text-primary">
      <header className="border-b border-border bg-white px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent-red"><ClipboardList className="h-4 w-4" />Ведомости</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text-primary">Электронная версия общего отчета</h1>
          </div>
          <div className={`text-xs ${workbookStatusClass}`}>{workbookStatusText}</div>
        </div>
      </header>

      <section className="border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="block w-44 min-w-0">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Месяц</span>
            <input type="month" value={month} onChange={event => setMonth(event.target.value || currentMonth)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          <label className="block min-w-[260px] flex-1">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Поиск</span>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Объект, работа, участок, ПК" className="w-full rounded-md border border-border bg-white py-2 pl-8 pr-8 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
              {searchInput && <button type="button" onClick={() => { setSearchInput(''); setSearch('') }} className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-text-muted hover:bg-bg-surface hover:text-accent-red" aria-label="Очистить поиск"><X className="h-4 w-4" /></button>}
            </div>
          </label>
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
            <Filter className="h-4 w-4" />Сбросить фильтры
          </button>
        </div>
        <div className="grid gap-3 xl:grid-cols-3">
          <MultiFilterPanel label="Участки" options={sectionOptions} selected={selectedSections} onChange={setSelectedSections} emptyLabel="Участков нет" />
          <MultiFilterPanel label="Типы объектов" options={objectTypeOptions} selected={selectedObjectTypes} onChange={setSelectedObjectTypes} emptyLabel="Типов нет" />
          <MultiFilterPanel label="Объекты" options={objectOptions} selected={selectedObjectIds} onChange={setSelectedObjectIds} emptyLabel="Объектов нет" />
        </div>
	      </section>

	      <FinancialSummaryCards
	        summary={data?.financial_summary}
	        actualSectionBinding={actualSectionBinding}
	        bindingLoading={isFetching && isPlaceholderData}
	        onToggleActualSectionBinding={toggleActualSectionBinding}
	        onOpenDetail={setFinancialDetail}
	      />

	      {data?.cache?.status === 'stale' && (
	        <div className="mx-4 mt-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:mx-6">
	          <RefreshCw className="h-4 w-4 animate-spin" />
	          <span>Показан часовой кеш. Свежая ведомость пересчитывается в фоне, после готовности вкладка обновится автоматически.</span>
	        </div>
	      )}

	      {(isError || status) && (
        <div className={`mx-4 mt-4 rounded-lg border px-4 py-3 text-sm sm:mx-6 ${isError || status?.kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {isError ? (error instanceof Error ? error.message : 'Ошибка загрузки') : status?.text}
        </div>
      )}

      <main className="px-0 py-4 sm:py-5">
        <section className="border-y border-border bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">Общий отчет за {monthLabel}</h2>
              <div className="mt-0.5 text-xs text-text-muted">Группировка: {groupMode === 'section' ? 'участок → тип объекта → объект → работа' : 'тип объекта → участок → объект → работа'}.</div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ActualSectionBindingSwitch
                checked={actualSectionBinding}
                loading={isFetching && isPlaceholderData}
                onToggle={toggleActualSectionBinding}
                labelId="actual-section-binding-table-label"
              />
              <div className="flex rounded-md border border-border bg-bg-surface p-1 text-xs font-medium">
                <button type="button" onClick={() => { setGroupMode('objectType'); setExpanded({}) }} className={`rounded px-3 py-1.5 ${groupMode === 'objectType' ? 'bg-white text-accent-red shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>По типам</button>
                <button type="button" onClick={() => { setGroupMode('section'); setExpanded({}) }} className={`rounded px-3 py-1.5 ${groupMode === 'section' ? 'bg-white text-accent-red shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>По участкам</button>
              </div>
            </div>
            {dirtyDrafts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                <span className="font-semibold">Черновики: {dirtyDrafts.length}</span>
                {invalidDraftCount > 0 && <span className="font-semibold text-red-700">ошибок: {invalidDraftCount}</span>}
                <button type="button" onClick={() => setDrafts({})} className="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-text-secondary hover:text-accent-red">Отменить</button>
              </div>
            )}
          </div>
          <StatementsActionBar
            dirtyDraftCount={dirtyDrafts.length}
            invalidDraftCount={invalidDraftCount}
            canAddWork={canEditProjectData && Boolean(objects.length && workTypes.length)}
            canAddObject={canEditProjectData && Boolean(objectTypes.length)}
            isFetching={isFetching}
            isSaving={savePlanMutation.isPending}
            hideZeroWorks={hideZeroWorks}
            hideZeroObjects={hideZeroObjects}
            onlyWithPlan={onlyWithPlan}
            onlyMissingRate={onlyMissingRate}
            onAddWork={() => setAddWorkOpen(true)}
            onAddObject={() => setAddObjectOpen(true)}
            onExpandAll={expandAllRows}
            onCollapseAll={collapseAllRows}
            onRefresh={() => refetch()}
            onToggleHideZeroWorks={() => setHideZeroWorks(value => !value)}
            onToggleHideZeroObjects={() => setHideZeroObjects(value => !value)}
            onToggleOnlyWithPlan={() => setOnlyWithPlan(value => !value)}
            onToggleOnlyMissingRate={() => setOnlyMissingRate(value => !value)}
            onDownload={() => setDownloadOpen(true)}
            onSavePlans={saveAllDrafts}
          />
          {isLoading ? (
            <div className="py-12 text-center text-sm text-text-muted">Загрузка электронной ведомости...</div>
          ) : filteredGroupedRows.length === 0 && filteredQuarryHaulRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-text-muted">Нет строк под текущие фильтры.</div>
          ) : (
            <div className="max-h-[calc(100vh-250px)] w-full overflow-auto" onScroll={handleTableScroll}>
              <table className="w-full border-separate border-spacing-0 text-sm [&_td]:border-r [&_td]:border-border [&_th]:border-r [&_th]:border-border" style={{ minWidth: Math.max(2490, 1750 + days.length * 180) }}>
                <thead className="sticky top-0 z-20 bg-neutral-100 text-xs font-bold uppercase text-text-primary">
                  <tr>
                    <th className="sticky left-0 z-30 w-[540px] min-w-[540px] border-b border-r border-border bg-bg-surface px-3 py-2 text-left font-bold">Работа</th>
                    <th className="w-[190px] min-w-[190px] border-b border-border px-3 py-2 text-left font-bold">ПК</th>
                    <th className="w-[70px] min-w-[70px] border-b border-border px-3 py-2 text-left font-bold">Ед.</th>
                    <th className="w-[145px] min-w-[145px] border-b border-border px-3 py-2 text-right font-bold">Проект</th>
                    <th className="w-[145px] min-w-[145px] border-b border-border px-3 py-2 text-right font-bold">План месяца</th>
                    <th className="w-[150px] min-w-[150px] border-b border-border px-3 py-2 text-right font-bold">Сумма плана месяца</th>
                    <th className="w-[120px] min-w-[120px] border-b border-border px-3 py-2 text-right font-bold">Факт месяца</th>
                    <th className="w-[130px] min-w-[130px] border-b border-border px-3 py-2 text-right font-bold">Сумма месяца</th>
                    <th className="w-[130px] min-w-[130px] border-b border-border px-3 py-2 text-right font-bold">Сумма накоп.</th>
                    <th className="w-[90px] min-w-[90px] border-b border-border px-3 py-2 text-right font-bold">% мес.</th>
                    <th className="w-[130px] min-w-[130px] border-b border-border px-3 py-2 text-right font-bold">Факт накоп.</th>
                    <th className="w-[190px] min-w-[190px] border-b border-border px-3 py-2 text-left font-bold">ПК накоп.</th>
                    <th className="w-[90px] min-w-[90px] border-b border-border px-3 py-2 text-right font-bold">% накоп.</th>
                    {days.map(day => <th key={day.key} className="w-[180px] min-w-[180px] border-b border-l border-border px-2 py-2 text-center font-bold" title={formatDate(day.date)}>{day.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map(item => {
                    if (item.kind === 'objectType') {
                      return (
                        <tr key={item.key}>
                          <td className="sticky left-0 z-10 w-[540px] min-w-[540px] border-t border-r border-border bg-neutral-100 px-4 py-2">
                            <button type="button" onClick={() => toggleExpanded(item.key)} className="flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wide text-text-primary">
                              {item.expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1 truncate">{item.label}</span><span className="shrink-0 text-text-muted">{item.count} строк</span>
                            </button>
                          </td>
                          <GroupAmountRightCells summary={item.summary} daysLength={days.length} bgClass="bg-neutral-100" textClass="text-text-primary" />
                        </tr>
                      )
                    }
                    if (item.kind === 'section') {
                      return (
                        <tr key={item.key}>
                          <td className="sticky left-0 z-10 w-[540px] min-w-[540px] border-t border-r border-border bg-white px-5 py-2 shadow-[inset_4px_0_0_#991b1b]">
                            <button type="button" onClick={() => toggleExpanded(item.key)} className="flex w-full items-start gap-2 text-left text-xs font-semibold uppercase tracking-wide text-text-primary">
                              {item.expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                              <span className="min-w-0 flex-1">
                                <span className="block whitespace-normal break-words">{item.label}</span>
                                {item.hint ? <span className="block normal-case tracking-normal text-text-muted">{item.hint}</span> : null}
                              </span>
                              <span className="shrink-0 text-text-muted">{item.count} строк</span>
                            </button>
                          </td>
                          <GroupAmountRightCells summary={item.summary} daysLength={days.length} bgClass="bg-white" />
                        </tr>
                      )
                    }
                    if (item.kind === 'object') {
                      return (
                        <tr key={item.key}>
                          <td className="sticky left-0 z-10 w-[540px] min-w-[540px] border-t border-r border-border bg-white px-3 py-2">
                            <div className="flex items-start gap-2">
                              <button type="button" onClick={() => toggleExpanded(item.key)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                                {item.expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />}
                                <span className="min-w-0 flex-1"><span className="block font-semibold text-text-primary">{item.label}</span><span className="block text-xs text-text-muted">{item.hint}</span></span>
                              </button>
                              {isAdmin && item.objectId && (
                                <button type="button" onClick={() => deleteObjectItem(item)} disabled={deleteObjectMutation.isPending} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40" title="Удалить объект" aria-label="Удалить объект">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                          <GroupAmountRightCells summary={item.summary} daysLength={days.length} bgClass="bg-white" />
                        </tr>
                      )
                    }
                    if (item.kind === 'haulGroup') {
                      return <tr key={item.key}><td colSpan={baseColumnCount + days.length} className="border-t border-border bg-neutral-100 px-4 py-2"><button type="button" onClick={() => toggleExpanded(item.key)} className="flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wide text-text-primary">{item.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}<span>{item.label}</span><span className="ml-auto text-text-muted">{item.count} строк</span></button></td></tr>
                    }
                    if (item.kind === 'haulRow') {
                      const haul = item.row
                      return (
                        <tr key={item.key} className="border-t border-border hover:bg-bg-surface/60">
                          <td className="sticky left-0 z-10 border-r border-t border-border bg-white px-3 py-2 align-top hover:bg-bg-surface">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-red">Вывоз с карьеров</div>
                            <div className="mt-1 whitespace-normal break-words font-semibold leading-snug text-text-primary">{haul.materialLabel}</div>
                            <div className="mt-1 text-xs font-medium text-text-secondary">{haul.quarryLabel}</div>
                            <div className="mt-0.5 text-[11px] text-text-muted">{haul.sectionLabel} · <span className="font-semibold text-text-primary">{haul.sourceLabel}</span></div>
                          </td>
                          <td className="border-t border-border px-3 py-2 align-top text-text-secondary">—</td>
                          <td className="border-t border-border px-3 py-2 align-top text-text-secondary">{haul.unit || '—'}</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">—</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">—</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">—</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">{formatVolume(haul.volume)}</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">—</td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">—</td>
                          <td className="border-t border-border px-3 py-2 text-right align-top"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${percentTone(null)}`}>{formatPercent(null)}</span></td>
                          <td className="border-t border-border px-3 py-2 text-right font-mono align-top">{haul.cumulativeVolume ? formatVolume(haul.cumulativeVolume) : '—'}</td>
                          <td className="border-t border-border px-3 py-2 align-top text-xs text-text-secondary">—</td>
                          <td className="border-t border-border px-3 py-2 text-right align-top"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${percentTone(null)}`}>{formatPercent(null)}</span></td>
                          {days.map(day => {
                            const fact = Number(haul.dayValues?.[day.date] || 0)
                            const hasData = fact !== 0
                            return (
                              <td key={`${item.key}:${day.date}`} className={`border-l border-t border-border px-2 py-2 align-top ${hasData ? 'bg-white' : 'bg-bg-surface/35 text-text-muted'}`}>
                                <div className="space-y-1.5 text-[11px] leading-tight">
                                  <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-start gap-x-2">
                                    <span className="text-text-muted">План:</span>
                                    <span className="min-w-0 justify-self-end text-right font-mono text-text-secondary">—</span>
                                  </div>
                                  <div className={`grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-start gap-x-2 ${hasData ? 'font-semibold text-text-primary' : 'text-text-muted'}`}>
                                    <span>Факт:</span>
                                    <span className="min-w-0 justify-self-end text-right font-mono">{hasData ? formatCompactVolume(fact) : '—'}</span>
                                  </div>
                                  <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 text-text-muted">
                                    <span>ПК:</span>
                                    <span>—</span>
                                  </div>
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    }
                    const row = item.row
                    const key = draftKey(row)
                    const rawDraft = draftValue(row)
                    const parsedDraft = parseDraftVolume(rawDraft)
                    const dirty = isDraftDirty(row)
                    const invalid = dirty && rawDraft.trim() !== '' && parsedDraft == null
                    const planLocked = Boolean(row.month_plan_locked)
                    const dayMap = dayValuesMap(row)
                    const monthHasFact = rowMonthFactAbs(row) > ZERO_EPS
                    const cumulativeHasFact = rowCumulativeFactAbs(row) > ZERO_EPS
                    const projectTarget = canEditProjectData ? singleProjectEditTarget(row) : null
                    const projectRawDraft = projectDraftValue(row)
                    const projectParsedDraft = parseDraftVolume(projectRawDraft)
                    const projectDirty = isProjectDraftDirty(row)
                    const projectInvalid = projectDirty && (projectRawDraft.trim() === '' || projectParsedDraft == null || projectParsedDraft < 0)
                    const projectRefs = editableProjectRefs(row)
                    const monthHasPlan = Math.abs(Number(row.month_plan || 0)) > ZERO_EPS
                    return (
                      <tr key={row.id} className="border-t border-border hover:bg-bg-surface/60">
                        <td className="sticky left-0 z-10 border-r border-t border-border bg-white px-3 py-2 align-top hover:bg-bg-surface">
                          <button type="button" onClick={() => openRowDetails(row)} className="block w-full text-left">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-red">{row.category_label}</div>
	                            <div className="mt-1 whitespace-normal break-words font-semibold leading-snug text-text-primary">{rowWorkLabel(row)}</div>
	                            <div className="mt-1 text-xs font-medium text-text-secondary">{rowObjectLabel(row)}</div>
	                            <div className="mt-0.5 text-[11px] text-text-muted">{row.section_name || row.section_code || 'Без участка'} · {rowPkLabel(row)}</div>
	                            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-text-muted">
	                              <span>сегментов: {row.segment_count}</span>
	                              {row.compaction_label && <span className="rounded bg-amber-50 px-1.5 font-semibold text-amber-800" title="Основная строка считается как материал / Купл">{row.compaction_label}</span>}
	                              {statementRowUsesReferenceRate(row) && <span className="rounded bg-blue-50 px-1.5 font-semibold text-blue-700" title="Сумма считается по справочной расценке вида работ из старой вкладки БД">справочная расценка</span>}
	                            </div>
	                          </button>
                          {isAdmin && row.object_id && row.work_type_id && (
                            <button type="button" onClick={() => deleteWorkRow(row)} disabled={deleteObjectWorkMutation.isPending} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40" title="Удалить работу у объекта">
                              <Trash2 className="h-3.5 w-3.5" />Удалить работу
                            </button>
                          )}
                        </td>
                        <td className="border-t border-border px-3 py-2 align-top text-text-secondary"><button type="button" onClick={() => openRowDetails(row)} className="text-left hover:text-accent-red">{rowPkLabel(row)}</button></td>
                        <td className="border-t border-border px-3 py-2 align-top text-text-secondary">{row.unit || '—'}</td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top">
                          {projectTarget ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                value={projectRawDraft}
                                onChange={event => setProjectDrafts(prev => ({ ...prev, [projectDraftKey(row)]: event.target.value }))}
                                onKeyDown={event => { if (event.key === 'Enter') saveProjectVolumeForRow(row) }}
                                className={`h-8 w-24 rounded-md border bg-white px-2 text-right font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 ${projectInvalid ? 'border-red-300 bg-red-50' : projectDirty ? 'border-amber-300 bg-amber-50/40' : 'border-border'}`}
                                placeholder="0"
                              />
                              <button type="button" onClick={() => saveProjectVolumeForRow(row)} disabled={projectInvalid || projectParsedDraft == null || saveProjectMutation.isPending} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted hover:border-accent-red/50 hover:text-accent-red disabled:opacity-40" title="Сохранить проектный объем">
                                <Save className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div>
                              <button type="button" onClick={() => openRowDetails(row)} className="hover:text-accent-red">{formatVolume(row.project_volume)}</button>
                              {canEditProjectData && projectRefs.length > 1 && <button type="button" onClick={() => openRowDetails(row)} className="mt-1 block w-full text-right font-sans text-[10px] font-semibold text-accent-red hover:underline">сегменты</button>}
                            </div>
                          )}
                          {hasCompaction(row) && <div className="mt-1 text-[10px] font-normal text-text-muted">мат. {formatCompactVolume(row.material_project_volume)}</div>}
                        </td>
                        <td className="border-t border-border px-3 py-2 text-right align-top">
                          {planLocked ? (
                            <div className="text-right" title={row.month_plan_source || 'Подписанная производственная программа'}>
                              <div className="font-mono font-semibold text-blue-800">{monthHasPlan ? formatVolume(row.month_plan) : '0'}</div>
                              <div className="mt-1 text-[10px] font-semibold text-blue-700">подписная программа</div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                value={rawDraft}
                                onChange={event => setDrafts(prev => ({ ...prev, [key]: event.target.value }))}
                                onKeyDown={event => { if (event.key === 'Enter') saveRowPlan(row) }}
                                className={`h-8 w-24 rounded-md border bg-white px-2 text-right font-mono text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100 ${invalid ? 'border-red-300 bg-red-50' : dirty ? 'border-amber-300 bg-amber-50/40' : 'border-border'}`}
                                placeholder="0"
                              />
                              <button type="button" onClick={() => saveRowPlan(row)} disabled={invalid || parsedDraft == null || savePlanMutation.isPending} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted hover:border-accent-red/50 hover:text-accent-red disabled:opacity-40" title="Сохранить план месяца">
                                <Save className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          {hasCompaction(row) && <div className="mt-1 text-right text-[10px] text-text-muted">плотн. {formatCompactVolume(row.month_plan)}</div>}
                        </td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top"><button type="button" onClick={() => openRowDetails(row)} className={row.month_plan_amount == null ? 'text-text-primary hover:text-accent-red' : 'text-blue-700 hover:text-accent-red'} title={row.month_plan_amount_missing_rate ? 'Для расчета не хватает расценки руб./ед.изм. по региону' : undefined}>{monthHasPlan ? formatMoney(row.month_plan_amount) : '—'}</button>{row.month_plan_amount_missing_rate && monthHasPlan && <div className="mt-1 text-[10px] font-normal text-text-primary">нет расценки</div>}</td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top"><button type="button" onClick={() => openRowDetails(row)} className="hover:text-accent-red">{formatVolume(row.month_fact)}</button>{hasCompaction(row) && <div className="mt-1 text-[10px] font-normal text-text-muted">мат. {formatCompactVolume(row.material_month_fact)}</div>}</td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top"><button type="button" onClick={() => openRowDetails(row)} className={row.month_amount == null ? 'text-text-primary hover:text-accent-red' : 'text-accent-burg hover:text-accent-red'} title={row.month_amount_missing_rate ? 'Для расчета не хватает расценки руб./ед.изм. по региону' : undefined}>{monthHasFact ? formatMoney(row.month_amount) : '—'}</button>{row.month_amount_missing_rate && monthHasFact && <div className="mt-1 text-[10px] font-normal text-text-primary">нет расценки</div>}</td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top"><button type="button" onClick={() => openRowDetails(row)} className={row.cumulative_amount == null ? 'text-text-primary hover:text-accent-red' : 'text-accent-burg hover:text-accent-red'} title={row.cumulative_amount_missing_rate ? 'Для расчета не хватает расценки руб./ед.изм. по региону' : undefined}>{cumulativeHasFact ? formatMoneyMln(row.cumulative_amount) : '—'}</button>{row.cumulative_amount_missing_rate && cumulativeHasFact && <div className="mt-1 text-[10px] font-normal text-text-primary">нет расценки</div>}</td>
                        <td className="border-t border-border px-3 py-2 text-right align-top"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${percentTone(row.month_percent)}`}>{formatPercent(row.month_percent)}</span></td>
                        <td className="border-t border-border px-3 py-2 text-right font-mono align-top"><button type="button" onClick={() => openRowDetails(row)} className="hover:text-accent-red">{formatVolume(row.cumulative_fact)}</button>{hasCompaction(row) && <div className="mt-1 text-[10px] font-normal text-text-muted">мат. {formatCompactVolume(row.material_cumulative_fact)}</div>}</td>
                        <td className="border-t border-border px-3 py-2 align-top text-xs text-text-secondary">
                          {(row.cumulative_pk_ranges || []).length ? <button type="button" onClick={() => openRowDetails(row)} className="line-clamp-3 text-left hover:text-accent-red" title={(row.cumulative_pk_ranges || []).join('; ')}>{(row.cumulative_pk_ranges || []).slice(0, 3).join('; ')}{(row.cumulative_pk_ranges || []).length > 3 ? ` +${(row.cumulative_pk_ranges || []).length - 3}` : ''}</button> : '—'}
                        </td>
                        <td className="border-t border-border px-3 py-2 text-right align-top"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${percentTone(row.cumulative_percent)}`}>{formatPercent(row.cumulative_percent)}</span></td>
                        {days.map(day => {
                          const value = dayMap[day.date]
                          const fact = Number(value?.fact_volume || 0)
                          const plan = Number(value?.plan_volume || 0)
                          const materialPlan = Number(value?.material_plan_volume ?? plan)
                          const materialFact = Number(value?.material_fact_volume ?? fact)
                          const pkRanges = value?.pk_ranges ?? []
                          const hasMaterial = hasCompaction(row)
                          const hasData = fact !== 0 || plan !== 0 || materialFact !== 0 || materialPlan !== 0 || pkRanges.length > 0
                          const hasPlanValue = plan !== 0 || materialPlan !== 0
                          const hasFactValue = fact !== 0 || materialFact !== 0
                          return (
                            <td key={`${row.id}:${day.date}`} className={`border-l border-t border-border px-2 py-2 align-top ${hasData ? 'bg-white' : 'bg-bg-surface/35 text-text-muted'}`}>
                              <div className="space-y-1.5 text-[11px] leading-tight">
                                {hasMaterial ? (
                                  <div className="min-w-0">
                                    <div className="text-text-muted">План:</div>
                                    <div className="mt-0.5 min-w-0 text-right font-mono text-text-secondary" title={hasPlanValue ? `Работа: ${formatCompactVolume(plan)}; материал: ${formatCompactVolume(materialPlan)}` : undefined}>
                                      <DayWorkMaterialValue row={row} workValue={plan} materialValue={materialPlan} visible={hasPlanValue} />
                                    </div>
                                  </div>
                                ) : (
                                  <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-start gap-x-2">
                                    <span className="text-text-muted">План:</span>
                                    <span className="min-w-0 justify-self-end text-right font-mono text-text-secondary">
                                      <DayWorkMaterialValue row={row} workValue={plan} materialValue={materialPlan} visible={hasPlanValue} />
                                    </span>
                                  </div>
                                )}
                                {hasMaterial ? (
                                  <button type="button" onClick={() => openRowDetails(row)} className={`block w-full min-w-0 text-left ${hasFactValue ? 'font-semibold text-text-primary hover:text-accent-red' : 'text-text-muted'}`}>
                                    <div>Факт:</div>
                                    <div className="mt-0.5 min-w-0 text-right font-mono" title={hasFactValue ? `Работа: ${formatCompactVolume(fact)}; материал: ${formatCompactVolume(materialFact)}` : undefined}>
                                      <DayWorkMaterialValue row={row} workValue={fact} materialValue={materialFact} visible={hasFactValue} />
                                    </div>
                                  </button>
                                ) : (
                                  <button type="button" onClick={() => openRowDetails(row)} className={`grid w-full min-w-0 grid-cols-[42px_minmax(0,1fr)] items-start gap-x-2 text-left ${hasFactValue ? 'font-semibold text-text-primary hover:text-accent-red' : 'text-text-muted'}`}>
                                    <span>Факт:</span>
                                    <span className="min-w-0 justify-self-end text-right font-mono">
                                      <DayWorkMaterialValue row={row} workValue={fact} materialValue={materialFact} visible={hasFactValue} />
                                    </span>
                                  </button>
                                )}
                                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 text-text-muted">
                                  <span>ПК:</span>
                                  {pkRanges.length ? (
                                    <button type="button" onClick={() => openRowDetails(row)} className="min-w-0 space-y-0.5 text-left text-text-secondary hover:text-accent-red" title={pkRanges.join('; ')}>
                                      {pkRanges.map(pk => <span key={pk} className="block break-words leading-snug">{pk}</span>)}
                                    </button>
                                  ) : <span>—</span>}
                                </div>
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
      {selectedRow && (
        <RowDetailsModal
          state={selectedRow}
          onChange={setSelectedRow}
          onClose={() => setSelectedRow(null)}
          canEditProject={canEditProjectData}
          projectSavePending={saveProjectMutation.isPending}
          onSaveProjectVolume={saveProjectVolumeTarget}
          rateSavePending={saveRateMutation.isPending}
          onSaveObjectRates={item => saveRateMutation.mutate(item)}
        />
      )}
      {financialDetail && (
        <FinancialDetailModal
          state={financialDetail}
          rows={filteredGroupedRows}
          actualSectionBinding={actualSectionBinding}
          bindingLoading={isFetching && isPlaceholderData}
          onToggleActualSectionBinding={toggleActualSectionBinding}
          onClose={() => setFinancialDetail(null)}
        />
      )}
      {downloadOpen && (
        <DownloadWorkbookModal
          month={month}
          sectionOptions={sectionOptions}
          objectTypeOptions={objectTypeOptions}
          defaultSections={selectedSections}
          defaultObjectTypes={selectedObjectTypes}
          groupMode={groupMode}
          hideZeroWorks={hideZeroWorks}
          hideZeroObjects={hideZeroObjects}
          onlyWithPlan={onlyWithPlan}
          onlyMissingRate={onlyMissingRate}
          actualSectionBinding={actualSectionBinding}
          search={search}
          onClose={() => setDownloadOpen(false)}
        />
      )}
      {addWorkOpen && <AddWorkModal objects={objects} sections={sections} workTypes={workTypes} month={month} defaultSectionCode={selectedSections.length === 1 ? selectedSections[0] : undefined} actualSectionBinding={actualSectionBinding} isPending={createWorkMutation.isPending} onSubmit={payload => createWorkMutation.mutate(payload)} onClose={() => setAddWorkOpen(false)} />}
      {addObjectOpen && <AddObjectModal sections={sections} objectTypes={objectTypes} isPending={createObjectMutation.isPending} onSubmit={payload => createObjectMutation.mutate(payload)} onClose={() => setAddObjectOpen(false)} />}
    </div>
  )
}
