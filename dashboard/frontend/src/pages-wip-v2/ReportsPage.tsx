/**
 * Вкладка «Отчёты» — /reports.
 *
 * Три состояния внутри одной страницы:
 *   1. list    — таблица uploaded daily_reports из /api/wip/reports
 *   2. upload  — dropzone для .txt/.log/.xlsx, отправляет в /api/wip/reports/preview
 *   3. preview — человекочитаемый просмотр распарсенной структуры + inline-правки;
 *                «Импортировать» → /api/wip/reports/import.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileText, Upload, Check, X, ChevronRight, Plus, Trash2, HelpCircle, Minimize2, Download, Flag } from 'lucide-react'
import { useAuth } from '../auth'
import { hasReportEditRights, hasReportReviewRights } from '../access'
import {
  MAINLINE_FILL_STATUS_BY_KEY,
  MAINLINE_FILL_STATUS_DEFINITIONS,
  TEMP_ROAD_FILL_STATUS_BY_KEY,
  TEMP_ROAD_FILL_STATUS_DEFINITIONS,
  type FillStatusDefinition,
  type MainlineFillStatusKey,
  type TempRoadFillStatusKey,
} from './fillStatusMeta'
import { TempRoadSchemeCard, parseTempRoadSchemeTitle, type TempRoadSchemeRoad, type TempRoadSchemeSegment } from './blocks/TempRoadsBlock'

// ── types ───────────────────────────────────────────────────────────────

interface ReportUserFlag {
  key: string
  label: string
  color: string
  updated_by?: string
  updated_at?: string
}

interface ReportRow {
  id: string
  report_date: string
  shift: string
  source_type: string
  uploaded_by_username?: string | null
  status: string
  parse_status: string
  operator_status: string
  pk_validation_level?: 'warning' | 'error' | null
  pk_validation_count?: number
  review_flags?: string[]
  user_flags?: ReportUserFlag[]
  created_at: string
  section_code: string | null
  section_name: string | null
  work_items_count: number
  movements_count: number
  equipment_count: number
  fill_statuses_count?: number
}

interface ReportUploaderOption {
  value: string
  label: string
  count: number
}

interface ReportsListResponse {
  rows: ReportRow[]
  total: number
  limit: number
  offset: number
  filter_options?: {
    uploaders?: ReportUploaderOption[]
  }
}

interface ParsedHeader {
  report_date: string
  shift: string
  section_code: string
  section_name?: string
  author?: string
  constructives?: string
}

interface AliasesSummary {
  total_items: number
  resolved: number
  unresolved: number
  unresolved_samples: string[]
}

interface AliasRow {
  id: string
  canonical_code: string
  alias_text: string
  kind: string
  notes?: string | null
  created_at?: string | null
}

interface ReferenceSuggestion {
  code: string
  label: string
  score?: number
  source?: string
  table?: string
  default_unit?: string
  analytics_tag?: string
  productivity_enabled?: boolean
  object_type_code?: string
  constructive_code?: string
  constructive_name?: string
  section_code?: string | null
  pk_start?: number | string | null
  pk_end?: number | string | null
  pk_raw_text?: string | null
}
interface ReferenceDedupCandidate {
  id: string
  code: string | null
  label: string | null
  default_unit?: string | null
  analytics_tag?: string | null
  productivity_enabled?: boolean | null
  is_active?: boolean | null
  review_tag?: string | null
  ref_count?: number
}
interface ReferenceDedupCandidatesResponse { rows: ReferenceDedupCandidate[] }

interface EquipmentSuggestion {
  id?: string
  equipment_unit_id?: string
  label?: string
  equipment_type?: string
  brand_model?: string
  unit_number?: string
  plate_number?: string
  ownership_type?: string
  contractor_name?: string
  owner?: string
  status?: string
  source?: string
  location?: string
  matched_identifiers?: unknown
}

interface ObjectTypeMeta {
  code: string
  name: string
  map_enabled?: boolean
  work_accounting_enabled?: boolean
  material_accounting_enabled?: boolean
  is_linear?: boolean
  accounting_note?: string | null
}

interface ReferenceMeta {
  object_types: ObjectTypeMeta[]
  work_tags: string[]
}

type PreviewValue = string | number | boolean | null | undefined | PreviewItem[] | ReferenceSuggestion[] | EquipmentSuggestion[] | Record<string, unknown>
type PreviewItem = Record<string, PreviewValue>

interface TransportTrip extends PreviewItem {
  material?: string
  material_code?: string
  material_selection_mode?: string
  material_suggestions?: ReferenceSuggestion[]
  from?: string
  from_object_code?: string
  from_object_selection_mode?: string
  from_object_suggestions?: ReferenceSuggestion[]
  to?: string
  to_object_code?: string
  to_object_selection_mode?: string
  to_object_suggestions?: ReferenceSuggestion[]
  volume?: number | string | null
  trips?: number | string | null
  haul_distance_km?: number | string | null
  haul_distance_source?: string | null
  work_hours?: number | string | null
}

interface TransportItem extends PreviewItem {
  vehicle?: string
  equipment_type?: string
  brand_model?: string
  equipment_unit_id?: string
  equipment_suggestions?: EquipmentSuggestion[]
  equipment_match_status?: string
  reported_number?: string
  plate?: string
  plate_number?: string
  unit_number?: string
  owner?: string
  trips?: TransportTrip[]
}

interface WorkPreviewItem extends PreviewItem {
  constructive?: string
  constructive_code?: string
  object_code?: string
  object_selection_mode?: string
  object_suggestions?: ReferenceSuggestion[]
  work_name?: string
  work_type_code?: string
  work_type_selection_mode?: string
  work_type_suggestions?: ReferenceSuggestion[]
  work_block_forbidden?: boolean
  work_block_forbidden_message?: string
  vehicle?: string
  equipment_type?: string
  brand_model?: string
  equipment_unit_id?: string
  equipment_suggestions?: EquipmentSuggestion[]
  equipment_match_status?: string
  reported_number?: string
  plate?: string
  plate_number?: string
  unit_number?: string
  owner?: string
  contractor_name?: string
  pk_rail_start?: string | number | null
  pk_rail_end?: string | number | null
  pk_rail_raw?: string | null
  pk_ad_raw?: string | null
  pk_validation_override?: boolean
  volume?: string | number | null
  unit?: string
  volume_note?: string
  work_hours?: number | string | null
  productivity_enabled?: boolean
  analytics_tag?: string
  comment?: string
  equipment?: PreviewItem[]
}

interface ParkPreviewItem extends PreviewItem {
  equipment_type?: string
  brand_model?: string
  equipment_unit_id?: string
  equipment_suggestions?: EquipmentSuggestion[]
  equipment_match_status?: string
  reported_number?: string
  unit_number?: string
  plate_number?: string
  plate?: string
  owner?: string
  status?: string
}

interface StockpileOption {
  id: string
  stockpile_id?: string | null
  object_id?: string | null
  name: string
  object_name?: string | null
  material_code?: string | null
  material?: string | null
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
  pk_label?: string | null
  section_code?: string | null
  has_stockpile_record?: boolean
}
interface StockpilePreviewItem extends PreviewItem {
  existing_stockpile_id?: string | null
  existing_object_id?: string | null
  name?: string
  material?: string
  material_code?: string
  material_suggestions?: ReferenceSuggestion[]
  pk_raw_text?: string
  pk_validation_override?: boolean
  volume?: string | number | null
  unit?: string
  needs_create?: boolean
  existing_object_name?: string
}

interface PileDrivingItem extends PreviewItem {
  field_id?: string | null
  field_code?: string
  field_type?: string
  target_type?: 'pile_field' | 'pipe' | string
  object_id?: string | null
  object_code?: string | null
  object_name?: string | null
  pipe_pile_spec_id?: string | null
  pk_start?: number | string | null
  pk_end?: number | string | null
  pk_text?: string
  pile_kind?: 'main' | 'test' | string
  pile_operation?: 'driving' | 'headcap' | string
  work_type_code?: string | null
  count?: number | string | null
  pile_type?: string
  pile_length_label?: string
  report_equipment_unit_id?: string | null
  equipment_unit_id?: string | null
  equipment_label?: string
  equipment_type?: string
  unit_number?: string
  plate_number?: string
  ownership_type?: string
  contractor_name?: string
  comment?: string
}

type PileIssuePriority = 'green' | 'yellow' | 'red'

interface PileControlIssue extends PreviewItem {
  text?: string
  priority?: PileIssuePriority
}

interface PileControlMeta extends PreviewItem {
  reported_at?: string
  interval_hours?: number | string
  sender_name?: string
  issues?: PileControlIssue[]
}

interface PileEquipmentOption {
  report_equipment_unit_id: string
  equipment_unit_id?: string | null
  label: string
  equipment_type?: string | null
  brand_model?: string | null
  unit_number?: string | null
  plate_number?: string | null
  ownership_type?: string | null
  status?: string | null
  section_code?: string | null
  section_name?: string | null
  shift?: string | null
  contractor?: string | null
}

interface PileFieldOption {
  id: string
  field_code: string
  target_type?: 'pile_field' | 'pipe' | string | null
  object_id?: string | null
  object_code?: string | null
  object_name?: string | null
  pipe_pile_spec_id?: string | null
  work_type_code?: string | null
  field_type?: string | null
  pile_type?: string | null
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
  pk_label?: string | null
  pile_count?: number | null
  completed_count?: number | null
  remaining_count?: number | null
  pile_length_label?: string | null
  section_code?: string | null
}

interface TempRoadOption {
  id: string
  road_code: string
  road_name: string
  section_code?: string | null
  section_name?: string | null
  ad_start_pk?: number | string | null
  ad_end_pk?: number | string | null
  rail_start_pk?: number | string | null
  rail_end_pk?: number | string | null
}

interface SectionBoundary {
  boundary_kind: string
  section_code: string
  section_name?: string | null
  pk_start: number | string
  pk_end: number | string
}

interface SectionBoundariesData {
  rows: SectionBoundary[]
}

interface FillStatusItem extends PreviewItem {
  road_id?: string | null
  road_code?: string
  road_name?: string
  section_code?: string
  status_type?: TempRoadFillStatusKey
  pk_ranges?: string
  rail_pk_ranges?: string
  pioneer_fill?: string
  subgrade_not_to_grade?: string
  dso?: string
  ready_for_shpgs?: string
  shpgs_done?: string
  pk_validation_override?: boolean
  comment?: string
}

interface MainlineFillStatusItem extends PreviewItem {
  section_code?: string
  status_type?: MainlineFillStatusKey
  pk_ranges?: string
  pk_validation_override?: boolean
  comment?: string
}

interface TempRoadStatusRoad {
  id: string
  code: string
  name: string
  ad_pk_start?: number | null
  ad_pk_end?: number | null
  rail_pk_start?: number | null
  rail_pk_end?: number | null
  effective_date?: string | null
  length_m?: number | null
  section_code?: string | null
  sections?: Array<{ section_code?: string | null; section_name?: string | null; section_num?: number | null; ad_pk_start?: number | null; ad_pk_end?: number | null; rail_pk_start?: number | null; rail_pk_end?: number | null }>
  segments?: Array<{
    status_type: TempRoadFillStatusKey
    ad_pk_start?: number | null
    ad_pk_end?: number | null
    rail_pk_start?: number | null
    rail_pk_end?: number | null
    pk_start?: number | null
    pk_end?: number | null
    is_demo?: boolean
  }>
}

interface TempRoadStatusData {
  as_of: string
  roads: TempRoadStatusRoad[]
}

interface MainlineFillStatusSection {
  section_id: string
  section_code: string
  section_name?: string | null
  pk_start?: number | null
  pk_end?: number | null
  ranges?: Array<{ pk_start?: number | null; pk_end?: number | null }>
  effective_date?: string | null
  segments?: Array<{ status_type: MainlineFillStatusKey; pk_start?: number | null; pk_end?: number | null }>
}

interface MainlineFillStatusData {
  as_of: string
  schema_ready?: boolean
  sections: MainlineFillStatusSection[]
}

interface StaffCountItem extends PreviewItem {
  category?: string
  count?: number | string | null
}

interface ParsedPayload {
  source?: { filename: string; chars: number; lines: number }
  report_mode?: 'default' | 'fill'
  aliases?: AliasesSummary
  header: ParsedHeader
  human_summary?: {
    constructives?: string
    delivery_info?: string
    global_comments?: string[]
  }
  transport: TransportItem[]
  main_works: WorkPreviewItem[]
  aux_works: WorkPreviewItem[]
  staff_counts?: StaffCountItem[]
  park: ParkPreviewItem[]
  problems: string
  stockpiles?: StockpilePreviewItem[]
  piles?: PileDrivingItem[]
  pile_control?: PileControlMeta
  fill_statuses?: FillStatusItem[]
  mainline_fill_statuses?: MainlineFillStatusItem[]
  warnings?: string[]
  review_actions?: { stockpiles_to_create?: StockpilePreviewItem[] }
  review_flags?: string[]
  raw_text?: string
  initial_parse?: Record<string, unknown>
  _stub?: boolean
}

interface BatchPreviewPayload {
  batch: true
  source_filename: string
  count: number
  reports: ParsedPayload[]
}

type PreviewResponse = ParsedPayload | BatchPreviewPayload

type AliasKind = 'work_type' | 'material' | 'object'
type ReferenceContext = Record<AliasKind, ReferenceSuggestion[]>

type Section = { code: string; name: string }

interface IssoSupportInputPlan {
  plan_id?: string | null
  plan_month: string
  month_label?: string
  support_range_text: string
  planned_sites: number
}

interface IssoSupportInputFactMonth {
  value: string
  label?: string
  sites: number
}

interface IssoSupportInputLine {
  line_id: string
  row_num: number
  support_label: string
  supports_total: number
  supports_done: number
  fact_supports: number
  sites_total: number
  sites_done: number
  fact_june_sites: number
  fact_july_sites: number
  fact_august_sites: number
  fact_months?: IssoSupportInputFactMonth[]
  rd_status: string
  remark: string
  deadline: string
  ms11_started: boolean
  ms11_scope: boolean
  plans: IssoSupportInputPlan[]
}

interface IssoSupportInputObject {
  object_no: number
  object_code: string
  object_name: string
  object_type: string
  section_code: string
  section_label: string
  pk_label?: string | null
  sites_total: number
  sites_done: number
  ms11_scope: boolean
  ms11_started: boolean
  rows: IssoSupportInputLine[]
}

interface IssoSupportInputSection {
  section_code: string
  section_label: string
  sites_total: number
  sites_done: number
  objects: IssoSupportInputObject[]
}

interface IssoSupportInputResponse {
  available: boolean
  detail?: string
  snapshot?: { snapshot_date?: string; source_filename?: string; title?: string } | null
  target_month: string
  target_month_label: string
  months: { value: string; label: string }[]
  sections: IssoSupportInputSection[]
}

type Mode = 'list' | 'upload' | 'preview' | 'batch' | 'isso_support_input'
type SortKey = 'date' | 'section' | 'status' | 'records' | 'source'
type SortDir = 'asc' | 'desc'
type ReportFilterKey = 'date' | 'shift' | 'section' | 'status' | 'source'
type ReportFilters = Partial<Record<ReportFilterKey, string[]>>
type ReportFilterOption = { value: string; label: string; count: number }

const REPORTS_SORT_KEY_KEY = 'vsm-dashboard:reports:sort-key'
const REPORTS_SORT_DIR_KEY = 'vsm-dashboard:reports:sort-dir'
const REPORTS_FILTERS_KEY = 'vsm-dashboard:reports:filters'
const REPORT_FILTER_KEYS: ReportFilterKey[] = ['date', 'shift', 'section', 'status', 'source']

function storedReportFilters(): ReportFilters {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REPORTS_FILTERS_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: ReportFilters = {}
    for (const key of REPORT_FILTER_KEYS) {
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

function storedReportSortKey(): SortKey {
  if (typeof window === 'undefined') return 'date'
  const value = window.localStorage.getItem(REPORTS_SORT_KEY_KEY)
  return value === 'date' || value === 'section' || value === 'status' || value === 'records' || value === 'source'
    ? value
    : 'date'
}

function storedSortDir(key: string, fallback: SortDir = 'desc'): SortDir {
  if (typeof window === 'undefined') return fallback
  return window.localStorage.getItem(key) === 'asc' ? 'asc' : 'desc'
}

type HelpContent = {
  title: string
  points: string[]
  examples?: string[]
}


type PkValidationStatus = 'empty' | 'ok' | 'warning' | 'error'

interface PkValidationResult {
  status: PkValidationStatus
  message?: string
  normalized?: number
  label?: string
  ranges?: PkParsedRange[]
}

interface PkParsedRange {
  start: number
  end: number
  from: string
  to: string
}

interface PkBoundaryRange {
  start: number
  end: number
}

interface PkBoundary {
  start: number
  end: number
  label: string
  ranges?: PkBoundaryRange[]
}

interface PkValidationContext {
  sectionCode?: string | null
  sectionBoundaries?: SectionBoundary[]
  boundaryKind?: 'main' | 'temp_roads' | 'piles_pipes'
  objectBoundary?: PkBoundary | null
  roadBoundary?: PkBoundary | null
}

function pkNumericValue(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  return Number.isFinite(num) ? num : null
}

function normalizePkSource(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/ё/g, 'е')
    .replace(/\u00a0/g, ' ')
    .replace(/[–—−]/g, '-')
}

function formatPkForUi(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  const pk = Math.floor(value / 100)
  const plus = value - pk * 100
  const rounded = Math.round(plus * 100) / 100
  const plusText = Number.isInteger(rounded)
    ? String(rounded).padStart(2, '0')
    : rounded.toFixed(2).replace('.', ',').padStart(5, '0')
  return `ПК${pk}+${plusText}`
}

function pkValueFromParts(picketText: string, plusText?: string): number | null {
  const digits = String(picketText || '').replace(/\D+/g, '')
  if (!digits) return null
  const implicitPlus = plusText === undefined && digits.length >= 6
  const picket = Number(implicitPlus ? digits.slice(0, -2) : digits)
  const plus = implicitPlus ? Number(digits.slice(-2)) : (plusText === undefined ? 0 : Number(String(plusText).replace(',', '.')))
  if (!Number.isFinite(picket) || !Number.isFinite(plus) || plus < 0 || plus >= 100) return null
  return picket * 100 + plus
}

function parsePkValuesForUi(value: string | number | null | undefined): number[] {
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'number') return Number.isFinite(value) ? [Math.abs(value) < 10000 ? value * 100 : value] : []
  const raw = normalizePkSource(value)
  if (!raw) return []
  const compact = raw.replace(/\s+/g, '')
  const plainNumber = compact.match(/^\d+(?:[,.]\d+)?$/)
  if (plainNumber && (compact.includes('.') || compact.includes(','))) {
    const numeric = Number(compact.replace(',', '.'))
    if (Number.isFinite(numeric) && Math.abs(numeric) >= 10000) return [numeric]
  }
  const bareSingle = /^\d{4,7}$/.test(compact)
  const bareRange = /^\d{4,7}(?:-\d{4,7})+$/.test(compact)
  if (bareSingle) {
    const parsed = pkValueFromParts(compact)
    return parsed === null ? [] : [parsed]
  }
  const values: number[] = []
  const tokenRe = /(?:(п\s*\.?\s*к\s*\.?)\s*)?(\d{1,7})(?:\s*(?:\+|[,.])\s*(\d{1,3}(?:[,.]\d+)?))?/gi
  let match: RegExpMatchArray | null
  let previousEnd = -1
  while ((match = tokenRe.exec(raw))) {
    const token = match[0] || ''
    const hasPrefix = Boolean(match[1]) || /п\s*\.?\s*к/i.test(token)
    const hasPlus = match[3] !== undefined || token.includes('+')
    const hasDashBefore = previousEnd >= 0 && raw.slice(previousEnd, match.index).includes('-')
    const picketText = match[2] || ''
    if (!hasPrefix && !hasPlus && !bareRange && !(hasDashBefore && picketText.length >= 4)) {
      previousEnd = tokenRe.lastIndex
      continue
    }
    const parsed = pkValueFromParts(picketText, match[3])
    if (parsed === null) {
      previousEnd = tokenRe.lastIndex
      continue
    }
    values.push(parsed)
    previousEnd = tokenRe.lastIndex
  }
  return values
}

function parsePkRangesForUi(value: string | number | null | undefined): PkParsedRange[] {
  const raw = normalizePkSource(value)
  if (!raw) return []
  const chunks = raw.split(/[\n;]+/).map(part => part.trim()).filter(Boolean)
  const ranges: PkParsedRange[] = []
  for (const chunk of chunks) {
    const values = parsePkValuesForUi(chunk)
    if (!values.length) continue
    for (let i = 0; i < values.length; i += 2) {
      const start = values[i]
      const end = values[i + 1] ?? start
      const from = Math.min(start, end)
      const to = Math.max(start, end)
      ranges.push({ start: from, end: to, from: formatPkForUi(from), to: formatPkForUi(to) })
    }
  }
  return ranges
}

function boundaryRangeFromValues(startValue: unknown, endValue: unknown): PkBoundaryRange | null {
  const start = pkNumericValue(startValue)
  const end = pkNumericValue(endValue)
  if (start === null || end === null) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

function boundaryFromValues(startValue: unknown, endValue: unknown, label: string): PkBoundary | null {
  const range = boundaryRangeFromValues(startValue, endValue)
  if (!range) return null
  return { start: range.start, end: range.end, label, ranges: [range] }
}

function objectBoundaryFromSuggestion(suggestion?: ReferenceSuggestion): PkBoundary | null {
  if (!suggestion) return null
  return boundaryFromValues(suggestion.pk_start, suggestion.pk_end, `границы объекта ${suggestion.label || suggestion.code}`)
}

function sectionBoundaryFor(
  rows: SectionBoundary[] | undefined,
  sectionCode: string | null | undefined,
  kind: PkValidationContext['boundaryKind'] = 'main',
): PkBoundary | null {
  if (!rows?.length || !sectionCode) return null
  const ranges = rows
    .filter(item => item.section_code === sectionCode && item.boundary_kind === kind)
    .map(item => boundaryRangeFromValues(item.pk_start, item.pk_end))
    .filter((range): range is PkBoundaryRange => Boolean(range))
  if (!ranges.length) return null
  return {
    start: Math.min(...ranges.map(range => range.start)),
    end: Math.max(...ranges.map(range => range.end)),
    label: `границы участка ${sectionLabel(sectionCode)}`,
    ranges,
  }
}

function resolvePkBoundary(context?: PkValidationContext): PkBoundary | null {
  return context?.objectBoundary
    || context?.roadBoundary
    || sectionBoundaryFor(context?.sectionBoundaries, context?.sectionCode, context?.boundaryKind || 'main')
}

function rangeInsideBoundary(range: PkParsedRange, boundary: PkBoundary): boolean {
  const allowedRanges = boundary.ranges?.length ? boundary.ranges : [{ start: boundary.start, end: boundary.end }]
  return allowedRanges.some(allowed => range.start >= allowed.start && range.end <= allowed.end)
}

function rangeOutsideBoundary(range: PkParsedRange, boundary: PkBoundary): boolean {
  return !rangeInsideBoundary(range, boundary)
}

function formatBoundaryForUi(boundary: PkBoundary): string {
  const ranges = boundary.ranges?.length ? boundary.ranges : [{ start: boundary.start, end: boundary.end }]
  return ranges.map(range => `${formatPkForUi(range.start)} - ${formatPkForUi(range.end)}`).join('; ')
}

function validatePkForUi(
  value: string | number | null | undefined,
  opts: { required?: boolean; textOnlyAllowed?: boolean; context?: PkValidationContext } = {},
): PkValidationResult {
  const raw = normalizePkSource(value)
  if (!raw) {
    return opts.required ? { status: 'warning', message: 'Проверьте пикетаж: поле пустое.' } : { status: 'empty' }
  }
  const ranges = parsePkRangesForUi(value)
  if (!ranges.length) {
    return { status: 'error', message: 'Ошибка в пикетаже. Допустимые варианты: ПК2702, ПК2702+00, 2702, 270200.' }
  }
  const boundary = resolvePkBoundary(opts.context)
  if (boundary) {
    const outside = ranges.find(range => rangeOutsideBoundary(range, boundary))
    if (outside) {
      return {
        status: 'warning',
        normalized: outside.start,
        label: outside.from === outside.to ? outside.from : `${outside.from} - ${outside.to}`,
        ranges,
        message: `Проверьте пикетаж: ${outside.from === outside.to ? outside.from : `${outside.from} - ${outside.to}`} выходит за ${boundary.label} (${formatBoundaryForUi(boundary)}).`,
      }
    }
  }
  const first = ranges[0]
  const label = first.from === first.to ? first.from : `${first.from} - ${first.to}`
  return { status: 'ok', normalized: first.start, label, ranges, message: `Пикетаж распознан: ${label}` }
}

function PkSoftHint({
  value,
  textOnlyAllowed = false,
  context,
}: {
  value: string | number | null | undefined
  textOnlyAllowed?: boolean
  context?: PkValidationContext
}) {
  const check = validatePkForUi(value, { textOnlyAllowed, context })
  if (check.status === 'empty') return null
  if (check.status === 'ok') {
    return <div className="mt-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] leading-snug text-emerald-700">{check.message}</div>
  }
  const tone = check.status === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'
  return (
    <div className={`mt-1 rounded border px-2 py-1 text-[10px] leading-snug ${tone}`}>
      <div>{check.message}</div>
    </div>
  )
}

function pkInputClassName(
  value: string | number | null | undefined,
  _override?: boolean,
  textOnlyAllowed = false,
  context?: PkValidationContext,
): string {
  const check = validatePkForUi(value, { textOnlyAllowed, context })
  if (check.status === 'ok') return `${inputCls} border-emerald-300 bg-emerald-50/40`
  if (check.status === 'warning') return `${inputCls} border-amber-300 bg-amber-50/50`
  if (check.status === 'error') return `${inputCls} border-red-300 bg-red-50/50`
  return inputCls
}

interface PkValidationIssue {
  location: string
  message: string
  status: 'warning' | 'error'
}

function pkValidationIssue(
  location: string,
  value: string | number | null | undefined,
  _override?: boolean,
  opts: { textOnlyAllowed?: boolean; context?: PkValidationContext } = {},
): PkValidationIssue | null {
  const check = validatePkForUi(value, opts)
  if (check.status === 'warning' || check.status === 'error') {
    return { location, message: check.message || 'Проверьте пикетаж', status: check.status }
  }
  return null
}

function validateFillPkText(value: PreviewValue, context?: PkValidationContext): PkValidationResult {
  const raw = normalizePkSource(value as string | number | null | undefined)
  if (!raw) return { status: 'empty' }
  const ranges = parsePkRangesForUi(raw)
  if (!ranges.length) {
    return { status: 'error', message: 'Ошибка в пикетаже. Допустимые варианты: ПК2702, ПК2702+00, 2702, 270200.' }
  }
  const boundary = resolvePkBoundary(context)
  if (boundary) {
    const outside = ranges.find(range => rangeOutsideBoundary(range, boundary))
    if (outside) {
      return {
        status: 'warning',
        ranges,
        message: `Проверьте пикетаж: ${outside.from === outside.to ? outside.from : `${outside.from} - ${outside.to}`} выходит за ${boundary.label} (${formatBoundaryForUi(boundary)}).`,
      }
    }
  }
  return { status: 'ok', ranges, message: `Распознано диапазонов: ${ranges.length}` }
}

function pkTextareaClassName(value: PreviewValue, context?: PkValidationContext): string {
  const check = validateFillPkText(value, context)
  if (check.status === 'ok') return `${inputCls} border-emerald-300 bg-emerald-50/40`
  if (check.status === 'warning') return `${inputCls} border-amber-300 bg-amber-50/50`
  if (check.status === 'error') return `${inputCls} border-red-300 bg-red-50/50`
  return inputCls
}

function FillPkSoftHint({ value, context }: { value: PreviewValue; context?: PkValidationContext }) {
  const check = validateFillPkText(value, context)
  if (check.status === 'empty') return null
  if (check.status === 'ok') {
    return <div className="mt-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] leading-snug text-emerald-700">{check.message}</div>
  }
  const tone = check.status === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-700'
  return (
    <div className={`mt-1 rounded border px-2 py-1 text-[10px] leading-snug ${tone}`}>
      <div>{check.message}</div>
    </div>
  )
}

function roadBoundaryFor(row: FillStatusItem, roads: TempRoadOption[]): PkBoundary | null {
  const road = roads.find(item => (
    (row.road_id && item.id === row.road_id)
    || (row.road_code && item.road_code === row.road_code)
  ))
  if (!road) return null
  return boundaryFromValues(road.ad_start_pk, road.ad_end_pk, `границы ${road.road_name || road.road_code}`)
}


function roadRailBoundaryFor(row: FillStatusItem, roads: TempRoadOption[]): PkBoundary | null {
  const road = roads.find(item => (
    (row.road_id && item.id === row.road_id)
    || (row.road_code && item.road_code === row.road_code)
  ))
  if (!road) return null
  return boundaryFromValues(road.rail_start_pk, road.rail_end_pk, `ВСЖМ-границы ${road.road_name || road.road_code}`)
}

function numberOrNull(value: unknown): number | null {
  const num = pkNumericValue(value)
  return num === null || !Number.isFinite(num) ? null : num
}

function normalizeRoadCode(value?: string | null): string {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

function tempRoadStatusToSchemeRoad(road: TempRoadStatusRoad): TempRoadSchemeRoad | null {
  const adStart = numberOrNull(road.ad_pk_start)
  const adEnd = numberOrNull(road.ad_pk_end)
  if (adStart === null || adEnd === null) return null
  const railStart = numberOrNull(road.rail_pk_start)
  const railEnd = numberOrNull(road.rail_pk_end)
  const segments: TempRoadSchemeSegment[] = (road.segments || []).flatMap(segment => {
    const pkStart = numberOrNull(segment.pk_start ?? segment.rail_pk_start ?? segment.ad_pk_start)
    const pkEnd = numberOrNull(segment.pk_end ?? segment.rail_pk_end ?? segment.ad_pk_end)
    if (pkStart === null || pkEnd === null) return []
    return [{
      status_type: segment.status_type,
      pk_start: pkStart,
      pk_end: pkEnd,
      ad_pk_start: numberOrNull(segment.ad_pk_start),
      ad_pk_end: numberOrNull(segment.ad_pk_end),
      rail_pk_start: numberOrNull(segment.rail_pk_start),
      rail_pk_end: numberOrNull(segment.rail_pk_end),
      is_demo: Boolean(segment.is_demo),
    }]
  })
  return {
    id: road.id,
    code: road.code,
    name: road.name,
    ad_pk_start: adStart,
    ad_pk_end: adEnd,
    rail_pk_start: railStart,
    rail_pk_end: railEnd,
    length_m: numberOrNull(road.length_m) ?? Math.abs(adEnd - adStart),
    effective_date: road.effective_date || null,
    section_code: road.section_code || null,
    sections: (road.sections || []).flatMap(section => {
      const sectionAdStart = numberOrNull(section.ad_pk_start)
      const sectionAdEnd = numberOrNull(section.ad_pk_end)
      if (sectionAdStart === null || sectionAdEnd === null) return []
      return [{
        section_code: String(section.section_code || ''),
        section_name: section.section_name || null,
        section_num: section.section_num ?? null,
        ad_pk_start: sectionAdStart,
        ad_pk_end: sectionAdEnd,
        rail_pk_start: numberOrNull(section.rail_pk_start),
        rail_pk_end: numberOrNull(section.rail_pk_end),
      }]
    }),
    segments,
  }
}

function mapAdToRail(road: TempRoadSchemeRoad, adStart: number, adEnd: number): [number, number] | null {
  if (road.rail_pk_start === null || road.rail_pk_end === null) return null
  const adSpan = road.ad_pk_end - road.ad_pk_start
  if (Math.abs(adSpan) < 1e-4) return null
  const railSpan = road.rail_pk_end - road.rail_pk_start
  const railStart = road.rail_pk_start + ((adStart - road.ad_pk_start) / adSpan) * railSpan
  const railEnd = road.rail_pk_start + ((adEnd - road.ad_pk_start) / adSpan) * railSpan
  return [Math.min(railStart, railEnd), Math.max(railStart, railEnd)]
}

function mapRailToAd(road: TempRoadSchemeRoad, railStart: number, railEnd: number): [number, number] | null {
  if (road.rail_pk_start === null || road.rail_pk_end === null) return null
  const railSpan = road.rail_pk_end - road.rail_pk_start
  if (Math.abs(railSpan) < 1e-4) return null
  const adSpan = road.ad_pk_end - road.ad_pk_start
  const adStart = road.ad_pk_start + ((railStart - road.rail_pk_start) / railSpan) * adSpan
  const adEnd = road.ad_pk_start + ((railEnd - road.rail_pk_start) / railSpan) * adSpan
  return [Math.min(adStart, adEnd), Math.max(adStart, adEnd)]
}

function roadMatchesFillRow(road: TempRoadSchemeRoad | TempRoadStatusRoad, row: FillStatusItem): boolean {
  const rowCode = normalizeRoadCode(row.road_code)
  const roadCode = normalizeRoadCode('code' in road ? road.code : '')
  return Boolean(
    (row.road_id && row.road_id === road.id)
    || (rowCode && roadCode && rowCode === roadCode),
  )
}

function draftSegmentsForTempRoad(road: TempRoadSchemeRoad, rows: FillStatusItem[]): TempRoadSchemeSegment[] {
  return rows.flatMap(row => {
    if (!roadMatchesFillRow(road, row)) return []
    const status = tempRoadEditableStatus(row.status_type)
    const out: TempRoadSchemeSegment[] = []
    for (const range of parsePkRangesForUi(row.pk_ranges)) {
      const rail = mapAdToRail(road, range.start, range.end)
      out.push({
        status_type: status,
        pk_start: rail ? rail[0] : range.start,
        pk_end: rail ? rail[1] : range.end,
        ad_pk_start: range.start,
        ad_pk_end: range.end,
        rail_pk_start: rail?.[0] ?? null,
        rail_pk_end: rail?.[1] ?? null,
        is_demo: true,
      })
    }
    for (const range of parsePkRangesForUi(row.rail_pk_ranges)) {
      const ad = mapRailToAd(road, range.start, range.end)
      if (!ad) continue
      out.push({
        status_type: status,
        pk_start: range.start,
        pk_end: range.end,
        ad_pk_start: ad[0],
        ad_pk_end: ad[1],
        rail_pk_start: range.start,
        rail_pk_end: range.end,
        is_demo: true,
      })
    }
    return out
  })
}

function collectPayloadPkValidationIssues(
  payload: ParsedPayload,
  sectionBoundaries: SectionBoundary[] = [],
  roads: TempRoadOption[] = [],
): PkValidationIssue[] {
  const issues: PkValidationIssue[] = []
  ;[...(payload.main_works || []), ...(payload.aux_works || [])].forEach((row, idx) => {
    const rowNo = idx + 1
    const objectSuggestion = selectedReferenceSuggestion(row.object_code || row.constructive_code, row.object_suggestions, row.constructive)
    const context: PkValidationContext = {
      sectionCode: payload.header.section_code,
      sectionBoundaries,
      boundaryKind: 'main',
      objectBoundary: objectBoundaryFromSuggestion(objectSuggestion || undefined),
    }
    ;[
      ['ПК ВСЖМ начало', row.pk_rail_start],
      ['ПК ВСЖМ конец', row.pk_rail_end],
    ].forEach(([label, value]) => {
      const issue = pkValidationIssue(`Работа №${rowNo}: ${label}`, value as string | number | null | undefined, row.pk_validation_override, { context })
      if (issue) issues.push(issue)
    })
    ;[
      ['ПК АД', row.pk_ad_raw],
    ].forEach(([label, value]) => {
      const issue = pkValidationIssue(`Работа №${rowNo}: ${label}`, value as string | number | null | undefined, row.pk_validation_override)
      if (issue) issues.push(issue)
    })
  })
  ;(payload.stockpiles || []).forEach((row, idx) => {
    if (row.existing_stockpile_id) return
    const raw = row.pk_raw_text
    if ((row.pk_start || row.rounded_pk) && validatePkForUi(raw).status !== 'error') return
    const issue = pkValidationIssue(`Накопитель №${idx + 1}: ПК`, raw, Boolean(row.pk_validation_override), {
      context: {
        sectionCode: payload.header.section_code,
        sectionBoundaries,
        boundaryKind: 'main',
      },
    })
    if (issue) issues.push(issue)
  })
  ;(payload.fill_statuses || []).forEach((row, idx) => {
    const normalized = singleStatusTempRoadRow(row)
    const adContext: PkValidationContext = {
      sectionCode: normalized.section_code || payload.header.section_code,
      sectionBoundaries,
      boundaryKind: 'temp_roads',
      roadBoundary: roadBoundaryFor(normalized, roads),
    }
    const railContext: PkValidationContext = {
      sectionCode: normalized.section_code || payload.header.section_code,
      sectionBoundaries,
      boundaryKind: 'temp_roads',
      roadBoundary: roadRailBoundaryFor(normalized, roads),
    }
    const label = TEMP_ROAD_FILL_STATUS_BY_KEY[normalized.status_type || 'pioneer_fill']?.label || 'статус'
    ;[
      ['ПК АД', normalized.pk_ranges, adContext],
      ['ПК ВСЖМ', normalized.rail_pk_ranges, railContext],
    ].forEach(([pkLabel, value, context]) => {
      const check = validateFillPkText(value as PreviewValue, context as PkValidationContext)
      if (check.status === 'warning' || check.status === 'error') {
        issues.push({ location: `Отсыпка ВАД №${idx + 1}: ${label} · ${pkLabel}`, message: check.message || 'Проверьте диапазон пикетажа', status: check.status })
      }
    })
  })
  ;(payload.mainline_fill_statuses || []).forEach((row, idx) => {
    const context: PkValidationContext = {
      sectionCode: row.section_code || payload.header.section_code,
      sectionBoundaries,
      boundaryKind: 'main',
    }
    const check = validateFillPkText(row.pk_ranges, context)
    if (check.status === 'warning' || check.status === 'error') {
      const label = MAINLINE_FILL_STATUS_BY_KEY[(row.status_type || 'prep_works') as MainlineFillStatusKey]?.label || 'статус'
      issues.push({ location: `Отсыпка ОХ №${idx + 1}: ${label}`, message: check.message || 'Проверьте диапазон пикетажа', status: check.status })
    }
  })
  return issues
}

const REPORT_HELP: Record<string, HelpContent> = {
  intro: {
    title: 'Как проверить отчет',
    points: [
      'Идите сверху вниз: шапка, перевозки, работы, отсыпка ВАД/ОХ, накопители, сваи и проблемы.',
      'После загрузки откройте отчет еще раз: справа не должно быть желтых предупреждений.',
      'Сверьте объемы перевозки и работ с исходным отчетом; для отсыпки материал должен сходиться с перевозкой в конструктив.',
      'Загруженный отчет можно корректировать с того же аккаунта, поэтому не всегда нужно удалять и грузить заново.',
    ],
    examples: [
      'Если поле БД пустое, объем по этой строке не засчитается.',
      'Если материал отвезли в конструктив, работа по отсыпке должна иметь тег этого материала.',
    ],
  },
  header: {
    title: 'Шапка отчета',
    points: [
      'Дата и смена должны соответствовать фактической смене, а не дате загрузки файла.',
      'Участок выбирайте из списка. Если участок не определен, отчет нужно уточнить до подтверждения.',
      'Проверьте, что направление и конструктивы помогают найти нужные объекты в строках ниже.',
    ],
    examples: ['Пример: 12.05.2026, День, участок №4.'],
  },
  transport: {
    title: 'Перевозки',
    points: [
      'Проверьте принадлежность техники: ЖДС, Алмаз или наем.',
      'Для каждого рейса должны быть материал, откуда, куда, объем, рейсы, организация и плечо возки.',
      'Проверьте накопители: без материала может подставиться накопитель с другим материалом на том же пикете.',
      'Если вместо бортового номера указана часть госномера, техника может распознаться неправильно.',
      'Если откуда и куда совпадают, загрузка может упасть; найдите строку по объему из ошибки и исправьте маршрут.',
      'Самосвалы с нулевыми объемами лучше удалить: они влияют на количество работающих самосвалов и план выработки.',
      'Время работы уменьшает сменную норму пропорционально. Пустое поле означает полную смену 11 часов; сумма часов одной машины по всем строкам не может быть больше 11.',
    ],
    examples: ['Пример: песок, карьер -> накопитель, 180 м3, 6 рейсов, плечо 16 км.'],
  },
  works: {
    title: 'Работы',
    points: [
      'Все объемы указываются в рыхлом теле; единица измерения берется из базы по работе.',
      'Если объект или работа не распознаны, вручную введите общее название или пикет и выберите нужный пункт из списка.',
      'Если нужной сущности точно нет в базе, добавьте ее через «+ Добавить в БД» и проверьте тип, пикеты и название.',
      'Если подставился неверный объект/работа, исправьте словарь через «+ Алиас»: удалите плохой синоним и привяжите фразу к правильной сущности.',
      'Если отсыпали материал, работа обязательно должна иметь тег материала; иначе материал останется на балансе.',
      'Галочка производительности управляет только расчетом выработки техники, не фактом выполненной работы.',
      'Время работы уменьшает справочную сменную норму пропорционально. Если поле пустое, расчет идет за полную 11-часовую смену.',
    ],
    examples: [
      'Снятие ПРС всегда м3; отсыпка ЩПГС тоже м3.',
      'Планировка и профилирование не учитывают отсыпанный материал.',
    ],
  },
  stockpiles: {
    title: 'Накопители',
    points: [
      'Проверяйте материал накопителя: ошибка материала меняет баланс.',
      'Если нужного накопителя нет в списке, лучше уточнить с инженером по дашборду перед подтверждением.',
      'Название, пикет, объем и единица должны соответствовать исходному отчету.',
    ],
    examples: ['Пример: Накопитель песка АД13, ПК2715+00, 1000 м3.'],
  },
  piles: {
    title: 'Свайные работы',
    points: [
      'Выберите операцию: забивка свай или монтаж наголовников, затем поле/ветку пробников и количество за смену или сутки.',
      'Если нужного поля нет, возможно объем уже закрыт ранее; выберите свободное поле и сообщите инженеру по дашборду.',
      'Если в базе неверная длина свай или пикеты, не подтверждайте молча: это нужно разобрать.',
      'Количество свай в дашборде должно сходиться с графиком погружения.',
    ],
    examples: ['Пример: поле 5_1 Н, забивка свай, основные, 4 шт.', 'Пример: поле 5_1 Н, монтаж наголовников, основные, 4 шт.'],
  },
  fill_statuses: {
    title: 'Отсыпка ВАД',
    points: [
      'Одна строка это один сегмент временной автомобильной дороги.',
      'Автодорогу выбирайте из справочника, участок нужен для проверки границ.',
      'Статусы: пионерка, не в отметку, ДСО, готово под ЩПГС, под АБ.',
      'Для статуса «не в отметку» указывайте только новые участки земляного полотна, попавшие в работу; не повторяйте одни и те же пикеты.',
      'В статусные поля можно вставлять несколько диапазонов строками или через точку с запятой.',
    ],
    examples: ['Пример: АД5; ПК АД 0+00-2+15; не в отметку.'],
  },
  mainline_fill_statuses: {
    title: 'Отсыпка ОХ',
    points: [
      'Одна строка это один сегмент основного хода в границах выбранного участка.',
      'ПРС: срезка ПРС, выторфовка, замена грунта.',
      'Основные работы: выемка, насыпь, замена, выторфовка в работе.',
      'ЗС №2: второй морозоустойчивый защитный слой из песка гравелистого, крупного или ПГС.',
      'ЗС №1: первый защитный слой из ЩПС/ЩПГС.',
      'Асфальтобетон: укладка защитного слоя из асфальтобетона.',
    ],
    examples: ['Пример: участок №1; ПК2654+50-ПК2655+20; Основные работы.'],
  },
  problems: {
    title: 'Проблемы',
    points: [
      'Пишите только фактические ограничения смены: простой, отсутствие материала, погода, доступ, техника.',
      'Если проблем нет, оставьте поле пустым или напишите «нет».',
    ],
    examples: ['Пример: простой катка 2 часа из-за ремонта гидравлики.'],
  },
}

// ── helpers ─────────────────────────────────────────────────────────────

function isoDateOffset(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function localDateTimeInputValue(value = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function shiftFromDateTime(value: string): 'day' | 'night' | 'unknown' {
  const hour = Number(value.slice(11, 13))
  if (!Number.isFinite(hour)) return 'unknown'
  return hour >= 8 && hour < 20 ? 'day' : 'night'
}

function pileControlOperationalDate(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/)
  if (!match) return isoDateOffset(0)
  const [, year, month, day, hourRaw] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  const hour = Number(hourRaw ?? '0')
  if (Number.isFinite(hour) && hour < 8) date.setDate(date.getDate() - 1)
  return localDateTimeInputValue(date).slice(0, 10)
}

function emptyReferenceContext(): ReferenceContext {
  return { work_type: [], material: [], object: [] }
}

function emptyReportPayload(filename = 'manual-report'): ParsedPayload {
  return {
    source: { filename, chars: 0, lines: 0 },
    header: {
      report_date: isoDateOffset(-1),
      shift: 'day',
      section_code: '',
      section_name: '',
    },
    human_summary: {},
    transport: [],
    main_works: [],
    aux_works: [],
    staff_counts: [],
    park: [],
    problems: '',
    stockpiles: [],
    piles: [],
    fill_statuses: [],
    mainline_fill_statuses: [],
    warnings: [],
    review_actions: { stockpiles_to_create: [] },
    raw_text: '',
    _stub: false,
  }
}

function emptyFillReportPayload(): ParsedPayload {
  const base = emptyReportPayload('fill-report-manual')
  return {
    ...base,
    header: { ...base.header, shift: 'unknown', section_code: '', section_name: '' },
    report_mode: 'fill',
    human_summary: { constructives: 'Данные по отсыпке' },
    fill_statuses: [],
    mainline_fill_statuses: [],
  }
}

function emptyPileControlPayload(): ParsedPayload {
  const reportedAt = localDateTimeInputValue()
  return {
    ...emptyReportPayload('pile-control-manual'),
    header: {
      report_date: pileControlOperationalDate(reportedAt),
      shift: shiftFromDateTime(reportedAt),
      section_code: '',
      section_name: '',
      author: '',
    },
    human_summary: { constructives: 'Оперативный контроль забивки свай' },
    piles: [{ field_id: null, field_code: '', pile_kind: 'main', pile_operation: 'driving', work_type_code: null, count: '', report_equipment_unit_id: null, comment: '' }],
    pile_control: { reported_at: reportedAt, interval_hours: 3, sender_name: '', issues: [] },
    source: { filename: 'pile-control-manual', chars: 0, lines: 0 },
  }
}

function pileControlProblemsText(issues: PileControlIssue[] = []): string {
  return issues
    .map(issue => ({ text: String(issue.text || '').trim(), priority: issue.priority || 'yellow' }))
    .filter(issue => issue.text)
    .map(issue => `[${issue.priority}] ${issue.text}`)
    .join('\n')
}

function BlockHelpButton({ help }: { help: HelpContent }) {
  const [open, setOpen] = useState(false)
  const tooltipText = useMemo(() => [help.title, ...help.points, ...(help.examples || [])].join('\n'), [help])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-white text-text-muted hover:border-accent-red/40 hover:text-accent-red"
        aria-label={`Подсказка: ${help.title}`}
        title={tooltipText}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 py-6" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-lg border border-border bg-white shadow-xl">
            <div className="flex items-start gap-3 border-b border-border px-4 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-50 text-accent-red">
                <HelpCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-heading font-semibold text-text-primary">{help.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-surface hover:text-text-primary"
                aria-label="Закрыть подсказку"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-4 py-3 text-[12px] leading-relaxed text-text-secondary">
              <ul className="space-y-1.5">
                {help.points.map(point => <li key={point}>• {point}</li>)}
              </ul>
              {help.examples && help.examples.length > 0 && (
                <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Примеры</div>
                  <ul className="space-y-1">
                    {help.examples.map(example => <li key={example}>{example}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function WizardIntro() {
  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-heading font-semibold text-text-primary">Перед заполнением</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-muted">
            Проверьте распознанные данные сверху вниз. Пустые блоки допустимы, если работ или перевозок в смене не было.
            Непонятные направления оставляйте исходным текстом и сопоставляйте со справочником БД перед подтверждением.
          </p>
        </div>
        <BlockHelpButton help={REPORT_HELP.intro} />
      </div>
    </section>
  )
}

function isBatchPreview(payload: PreviewResponse): payload is BatchPreviewPayload {
  return Boolean((payload as BatchPreviewPayload).batch && Array.isArray((payload as BatchPreviewPayload).reports))
}

function shiftLabel(s: string) {
  return s === 'day' ? 'День' : s === 'night' ? 'Ночь' : '—'
}

function sourceLabel(s: string) {
  if (s === 'telegram_text') return 'Telegram'
  if (s === 'web_pile_control') return 'Контроль свай'
  if (s === 'web_manual') return 'Web'
  if (s === 'web_text' || s === 'web_upload') return 'Web'
  if (s === 'mechanization_report_m') return 'Отчет М'
  if (s === 'hermes') return 'Hermes'
  return s || '—'
}

function isWebReportSource(sourceType: string) {
  return sourceType.toLowerCase().startsWith('web')
}

function sourceDisplay(row: ReportRow) {
  const base = sourceLabel(row.source_type)
  if (isWebReportSource(row.source_type || '') && row.uploaded_by_username) {
    return `${base} · ${row.uploaded_by_username}`
  }
  return base
}

function reportSectionDownloadPart(row: ReportRow) {
  const raw = row.section_code || row.section_name || ''
  const match = raw.match(/(\d+)/)
  return match ? `уч${Number(match[1])}` : 'участок'
}

function reportFallbackXlsxFilename(row: ReportRow) {
  const date = row.report_date ? row.report_date.split('-').reverse().join('.') : '__.__.____'
  const shift = row.shift === 'day' ? 'день' : row.shift === 'night' ? 'ночь' : 'смена'
  return `Сменный отчет за ${date} ${reportSectionDownloadPart(row)} ${shift}.xlsx`
}

function filenameFromContentDisposition(header: string | null) {
  if (!header) return null
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf?.[1]) {
    try { return decodeURIComponent(utf[1]) } catch { return utf[1] }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1] || null
}

const REPORT_USER_FLAG_PRESETS: ReportUserFlag[] = [
  { key: 'checked', label: 'Проверен', color: '#16a34a' },
  { key: 'duplicate', label: 'Дубль', color: '#dc2626' },
  { key: 'attention', label: 'Обратить внимание', color: '#f59e0b' },
  { key: 'piles', label: 'Сваи', color: '#64748b' },
  { key: 'fill', label: 'Отсыпка', color: '#2563eb' },
]

const REPORT_USER_FLAG_COLORS = ['#16a34a', '#f59e0b', '#dc2626', '#64748b', '#2563eb', '#7c3aed']

function normalizeReportFlagColor(value?: string | null) {
  const color = (value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#64748b'
}

function reportFlagStyle(flag: ReportUserFlag) {
  const color = normalizeReportFlagColor(flag.color)
  return { borderColor: color, color, backgroundColor: `${color}18` }
}

function reportFlagRowStyle(flags?: ReportUserFlag[]) {
  const firstFlag = flags?.[0]
  if (!firstFlag) return undefined
  const color = normalizeReportFlagColor(firstFlag.color)
  return {
    backgroundImage: `linear-gradient(90deg, ${color}12 0%, ${color}08 42%, transparent 100%)`,
    boxShadow: `inset 3px 0 0 ${color}70`,
  }
}

function reportFlagMatches(a: ReportUserFlag, b: ReportUserFlag) {
  return a.key === b.key && a.label.trim().toLowerCase() === b.label.trim().toLowerCase()
}

function upsertReportFlag(flags: ReportUserFlag[] | undefined, flag: ReportUserFlag) {
  const current = flags || []
  const next = current.filter(item => !reportFlagMatches(item, flag))
  return [...next, { ...flag, color: normalizeReportFlagColor(flag.color) }]
}

function removeReportFlag(flags: ReportUserFlag[] | undefined, flag: ReportUserFlag) {
  return (flags || []).filter(item => !reportFlagMatches(item, flag))
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    draft: 'Черновик',
    review: 'Проверка',
    pending_review: 'Ожидает проверки',
    confirmed: 'Подтверждён',
    rejected: 'Отклонён',
  }
  return map[s] || s
}

function reportFilterValue(row: ReportRow, key: ReportFilterKey): string {
  if (key === 'date') return row.report_date || ''
  if (key === 'shift') return row.shift || ''
  if (key === 'section') return row.section_code || row.section_name || ''
  if (key === 'status') return row.status || ''
  return row.source_type || ''
}

function reportFilterLabel(key: ReportFilterKey, value: string, sample?: ReportRow): string {
  if (!value) return '—'
  if (key === 'shift') return shiftLabel(value)
  if (key === 'status') return statusLabel(value)
  if (key === 'source') return sourceLabel(value)
  if (key === 'section') return sample?.section_name || sample?.section_code || value
  return value
}

function buildReportFilterOptions(rows: ReportRow[], key: ReportFilterKey): ReportFilterOption[] {
  const counts = new Map<string, { count: number; sample?: ReportRow }>()
  for (const row of rows) {
    const value = reportFilterValue(row, key)
    const current = counts.get(value)
    if (current) current.count += 1
    else counts.set(value, { count: 1, sample: row })
  }
  return Array.from(counts.entries())
    .map(([value, meta]) => ({
      value,
      label: reportFilterLabel(key, value, meta.sample),
      count: meta.count,
    }))
    .sort((a, b) => {
      if (key === 'date') return b.value.localeCompare(a.value)
      return a.label.localeCompare(b.label, 'ru')
    })
}

function statusTone(s: string): string {
  if (s === 'confirmed') return 'bg-emerald-100 text-emerald-700'
  if (s === 'review') return 'bg-sky-100 text-sky-700'
  if (s === 'pending_review') return 'bg-amber-100 text-amber-800'
  if (s === 'rejected') return 'bg-red-100 text-red-700'
  return 'bg-neutral-100 text-neutral-600'
}

function pkReportTone(level?: 'warning' | 'error' | null): string {
  if (level === 'error') return 'border-red-200 bg-red-50/70'
  if (level === 'warning') return 'border-amber-200 bg-amber-50/70'
  return ''
}

function pkReportBadgeTone(level?: 'warning' | 'error' | null): string {
  if (level === 'error') return 'bg-red-100 text-red-700'
  if (level === 'warning') return 'bg-amber-100 text-amber-800'
  return ''
}

function equipmentStatusLabel(value?: string | null) {
  const map: Record<string, string> = {
    working: 'в работе',
    repair: 'ремонт',
    standby: 'простой',
    out: 'вне работы',
    unknown: 'статус не задан',
  }
  return map[(value || '').toLowerCase()] || value || 'статус не задан'
}

function equipmentSuggestionId(s: EquipmentSuggestion) {
  return s.equipment_unit_id || s.id || ''
}

function safeEquipmentText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function sanitizeEquipmentSuggestion(value: unknown): EquipmentSuggestion | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const matched = raw.matched_identifiers
  return {
    id: safeEquipmentText(raw.id),
    equipment_unit_id: safeEquipmentText(raw.equipment_unit_id),
    label: safeEquipmentText(raw.label),
    equipment_type: safeEquipmentText(raw.equipment_type),
    brand_model: safeEquipmentText(raw.brand_model),
    unit_number: safeEquipmentText(raw.unit_number),
    plate_number: safeEquipmentText(raw.plate_number),
    ownership_type: safeEquipmentText(raw.ownership_type),
    contractor_name: safeEquipmentText(raw.contractor_name),
    owner: safeEquipmentText(raw.owner),
    status: safeEquipmentText(raw.status),
    source: safeEquipmentText(raw.source),
    location: safeEquipmentText(raw.location),
    matched_identifiers: Array.isArray(matched)
      ? matched.map(safeEquipmentText).filter(Boolean)
      : safeEquipmentText(matched),
  }
}

function preventInputSubmitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.preventDefault()
}

const EQUIPMENT_ID_TRANSLIT: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
}

function normalizeEquipmentIdentifier(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, char => EQUIPMENT_ID_TRANSLIT[char] || char)
    .replace(/[^0-9A-ZА-Я]/g, '')
}

function equipmentSuggestionLogicalKey(s: EquipmentSuggestion) {
  const unit = normalizeEquipmentIdentifier(s.unit_number)
  if (unit) return `unit:${unit}`
  const plate = normalizeEquipmentIdentifier(s.plate_number)
  if (plate) return `plate:${plate}`
  const id = equipmentSuggestionId(s)
  return id ? `master:${id}` : ''
}

function firstNestedEquipmentRow(row: PreviewItem): PreviewItem | null {
  const equipment = row.equipment
  if (!Array.isArray(equipment)) return null
  const item = equipment.find(value => value && typeof value === 'object' && !Array.isArray(value))
  return (item || null) as PreviewItem | null
}

function patchFirstNestedEquipment(row: PreviewItem, patch: Partial<PreviewItem>): Partial<PreviewItem> {
  const equipment = row.equipment
  if (!Array.isArray(equipment)) return {}
  const index = equipment.findIndex(value => value && typeof value === 'object' && !Array.isArray(value))
  if (index < 0) return {}
  return {
    equipment: equipment.map((value, i) => (
      i === index && value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as PreviewItem), ...patch }
        : value
    )) as PreviewItem[],
  }
}

function equipmentNumber(row: PreviewItem) {
  const nested = firstNestedEquipmentRow(row)
  return String(
    row.reported_number
    || row.unit_number
    || row.plate_number
    || row.plate
    || nested?.reported_number
    || nested?.unit_number
    || nested?.plate_number
    || nested?.plate
    || '',
  ).trim()
}

function hiredEquipmentCount(row: PreviewItem) {
  const nested = firstNestedEquipmentRow(row)
  return String(
    row.equipment_count
    || row.hired_count
    || row.count_units
    || nested?.equipment_count
    || nested?.hired_count
    || nested?.count_units
    || '',
  ).trim()
}

function isInternalEquipmentOwnerText(value: unknown) {
  const text = String(value || '').trim().toLowerCase().replace(/ё/g, 'е')
  if (!text) return false
  return (
    text === 'ждс'
    || text.includes('ждс')
    || text.includes('желдорстрой')
    || text.includes('желдор')
    || text.includes('жел дор строй')
    || text.includes('железнодорожное строительство')
  )
}

function isExternalOwnerText(value: unknown) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return false
  return !isInternalEquipmentOwnerText(text)
}

function isHiredEquipmentRow(row: PreviewItem) {
  const nested = firstNestedEquipmentRow(row)
  return (
    row.ownership_type === 'hired'
    || isExternalOwnerText(row.owner || row.contractor_name)
    || nested?.ownership_type === 'hired'
    || isExternalOwnerText(nested?.owner || nested?.contractor_name)
  )
}

function patchEquipmentNumber<T extends PreviewItem>(row: T, value: string): Partial<T> {
  const next = value.trim()
  const patch = {
    reported_number: next,
    unit_number: next,
    plate_number: '',
    plate: '',
    equipment_count: '',
    hired_count: '',
    equipment_unit_id: '',
    equipment_match_status: next ? 'searching' : 'no_number',
    equipment_suggestions: [],
  }
  return {
    ...patch,
    ...patchFirstNestedEquipment(row, patch),
  } as unknown as Partial<T>
}

function patchHiredEquipmentCount<T extends PreviewItem>(row: T, value: string): Partial<T> {
  const count = value.replace(/[^\d]/g, '')
  const patch = {
    equipment_count: count,
    hired_count: count,
    reported_number: '',
    unit_number: '',
    plate_number: '',
    plate: '',
    equipment_unit_id: '',
    equipment_match_status: count ? 'external_owner' : 'no_number',
    equipment_suggestions: [],
  }
  return {
    ...patch,
    ...patchFirstNestedEquipment(row, patch),
  } as unknown as Partial<T>
}

function patchEquipmentOwner<T extends PreviewItem>(row: T, value: string): Partial<T> {
  const owner = value.trim()
  if (!isExternalOwnerText(owner)) {
    const patch = { owner, contractor_name: owner, ownership_type: owner ? 'own' : '', equipment_count: '', hired_count: '' }
    return {
      ...patch,
      ...patchFirstNestedEquipment(row, patch),
    } as unknown as Partial<T>
  }
  const count = hiredEquipmentCount(row) || '1'
  const patch = {
    owner,
    contractor_name: owner,
    ownership_type: 'hired',
    equipment_unit_id: '',
    brand_model: '',
    reported_number: '',
    unit_number: '',
    plate_number: '',
    plate: '',
    equipment_count: count,
    hired_count: count,
    equipment_suggestions: [],
    equipment_match_status: count ? 'external_owner' : 'no_number',
  }
  return {
    ...patch,
    ...patchFirstNestedEquipment(row, patch),
  } as unknown as Partial<T>
}

function equipmentSuggestionList(value: unknown): EquipmentSuggestion[] {
  return Array.isArray(value)
    ? value.map(sanitizeEquipmentSuggestion).filter((item): item is EquipmentSuggestion => Boolean(item))
    : []
}

function equipmentMatchedIdentifiers(suggestion: EquipmentSuggestion): string[] {
  const raw = suggestion.matched_identifiers
  if (Array.isArray(raw)) return raw.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(/[;,]/).map(item => item.trim()).filter(Boolean)
  return []
}

function mergeEquipmentSuggestions(...lists: unknown[]): EquipmentSuggestion[] {
  const byKey = new Map<string, EquipmentSuggestion>()
  for (const list of lists) {
    for (const item of equipmentSuggestionList(list)) {
      const key = equipmentSuggestionLogicalKey(item)
      if (!key) continue
      byKey.set(key, { ...byKey.get(key), ...item })
    }
  }
  return Array.from(byKey.values())
}

function applyEquipmentSuggestion<T extends PreviewItem>(row: T, suggestion: EquipmentSuggestion): T {
  const equipmentType = suggestion.equipment_type || (row.equipment_type as string | undefined) || ''
  const brandModel = suggestion.brand_model || (row.brand_model as string | undefined) || ''
  const vehicle = [equipmentType, brandModel].filter(Boolean).join(' ')
  const plateNumber = suggestion.plate_number || (row.plate_number as string | undefined) || (row.plate as string | undefined) || ''
  const owner = suggestion.owner || suggestion.contractor_name || (row.owner as string | undefined) || ''
  const currentStatus = String(row.status || '').trim().toLowerCase()
  const patch = {
    equipment_unit_id: equipmentSuggestionId(suggestion),
    equipment_type: equipmentType || row.equipment_type,
    brand_model: brandModel || row.brand_model,
    vehicle: vehicle || row.vehicle,
    reported_number: row.reported_number || row.unit_number || row.plate_number || row.plate || suggestion.unit_number || suggestion.plate_number,
    unit_number: suggestion.unit_number || row.unit_number,
    plate_number: plateNumber || row.plate_number,
    plate: plateNumber || row.plate,
    owner: owner || row.owner,
    contractor_name: suggestion.contractor_name || row.contractor_name,
    ownership_type: suggestion.ownership_type || row.ownership_type,
    status: currentStatus && currentStatus !== 'unknown' ? row.status : suggestion.status || row.status,
    equipment_match_status: 'resolved',
    equipment_suggestions: mergeEquipmentSuggestions([suggestion], row.equipment_suggestions as EquipmentSuggestion[] | undefined),
  }
  return {
    ...row,
    ...patch,
    ...patchFirstNestedEquipment(row, patch),
  } as T
}

function referenceKey(item: ReferenceSuggestion) {
  return (item.code || item.label || '').trim().toLowerCase()
}

function mergeReferenceSuggestions(...lists: Array<ReferenceSuggestion[] | undefined>): ReferenceSuggestion[] {
  const byKey = new Map<string, ReferenceSuggestion>()
  for (const list of lists) {
    for (const item of list || []) {
      const key = referenceKey(item)
      if (!key) continue
      const current = byKey.get(key)
      if (!current || (item.score ?? 0) > (current.score ?? 0) || item.source === 'current_report') {
        byKey.set(key, {
          ...current,
          ...item,
          label: item.label || current?.label || item.code,
          source: item.source || current?.source,
        })
      }
    }
  }
  return Array.from(byKey.values())
}

function selectedReferenceSuggestion(
  code?: string | null,
  suggestions?: ReferenceSuggestion[],
  fallbackLabel?: string | null,
): ReferenceSuggestion | null {
  const value = (code || '').trim()
  if (!value) return null
  const existing = (suggestions || []).find(item => item.code === value)
  if (existing) return existing
  return {
    code: value,
    label: (fallbackLabel || '').trim() || value,
    source: 'current_report',
  }
}

function rememberReferenceSelection(
  suggestions: ReferenceSuggestion[] | undefined,
  code?: string | null,
  suggestion?: ReferenceSuggestion,
  fallbackLabel?: string | null,
): ReferenceSuggestion[] | undefined {
  const selected = suggestion?.code
    ? { ...suggestion, label: suggestion.label || fallbackLabel || suggestion.code, source: suggestion.source || 'current_report' }
    : selectedReferenceSuggestion(code, suggestions, fallbackLabel)
  if (!selected) return suggestions
  return mergeReferenceSuggestions([{ ...selected, source: selected.source || 'current_report' }], suggestions)
}

function buildReferenceContext(payload: ParsedPayload): ReferenceContext {
  const ctx = emptyReferenceContext()
  const add = (kind: AliasKind, item: ReferenceSuggestion | null) => {
    if (!item) return
    ctx[kind] = mergeReferenceSuggestions(ctx[kind], [{ ...item, source: item.source || 'current_report' }])
  }

  for (const unit of payload.transport || []) {
    for (const trip of unit.trips || []) {
      add('material', selectedReferenceSuggestion(trip.material_code, trip.material_suggestions, trip.material))
      add('object', selectedReferenceSuggestion(trip.from_object_code, trip.from_object_suggestions, trip.from))
      add('object', selectedReferenceSuggestion(trip.to_object_code, trip.to_object_suggestions, trip.to))
    }
  }
  for (const row of [...(payload.main_works || []), ...(payload.aux_works || [])]) {
    add('work_type', selectedReferenceSuggestion(row.work_type_code, row.work_type_suggestions, row.work_name))
    add('object', selectedReferenceSuggestion(row.object_code || row.constructive_code, row.object_suggestions, row.constructive))
  }
  for (const sp of payload.stockpiles || []) {
    add('material', selectedReferenceSuggestion(sp.material_code, sp.material_suggestions, sp.material))
  }
  return ctx
}

// ── main page ───────────────────────────────────────────────────────────

type ReportsPageProps = {
  standaloneMode?: 'pile-control'
}

export default function ReportsPage({ standaloneMode }: ReportsPageProps = {}) {
  const isPileStandalone = standaloneMode === 'pile-control'
  const [mode, setMode] = useState<Mode>(() => isPileStandalone ? 'preview' : 'list')
  const [parsed, setParsed] = useState<ParsedPayload | null>(() => isPileStandalone ? emptyPileControlPayload() : null)
  const [sourceFilename, setSourceFilename] = useState<string>(() => isPileStandalone ? 'pile-control-manual' : '')
  const [batch, setBatch] = useState<BatchPreviewPayload | null>(null)
  const [importedBatchReports, setImportedBatchReports] = useState<Set<string>>(() => new Set())
  const [wizardCollapsed, setWizardCollapsed] = useState(false)
  const [pileSubmitNotice, setPileSubmitNotice] = useState('')
  const [pileFormRevision, setPileFormRevision] = useState(0)

  const resetToList = useCallback((notice = '') => {
    if (isPileStandalone) {
      setMode('preview')
      setParsed(emptyPileControlPayload())
      setSourceFilename('pile-control-manual')
      setBatch(null)
      setImportedBatchReports(new Set())
      setWizardCollapsed(false)
      setPileSubmitNotice(notice)
      setPileFormRevision(value => value + 1)
      return
    }
    setMode('list')
    setParsed(null)
    setSourceFilename('')
    setBatch(null)
    setImportedBatchReports(new Set())
    setWizardCollapsed(false)
  }, [isPileStandalone])

  const openUploadWizard = () => {
    if (isPileStandalone) {
      resetToList()
      return
    }
    setParsed(null)
    setSourceFilename('')
    setBatch(null)
    setImportedBatchReports(new Set())
    setWizardCollapsed(false)
    setMode('upload')
  }

  const openIssoSupportInputWizard = () => {
    if (isPileStandalone) return
    setParsed(null)
    setSourceFilename('isso-support-input')
    setBatch(null)
    setImportedBatchReports(new Set())
    setWizardCollapsed(false)
    setMode('isso_support_input')
  }

  const collapseWizard = useCallback(() => {
    if (!isPileStandalone && mode !== 'list') setWizardCollapsed(true)
  }, [isPileStandalone, mode])

  useEffect(() => {
    if (isPileStandalone || mode === 'list' || wizardCollapsed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        collapseWizard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapseWizard, isPileStandalone, mode, wizardCollapsed])

  const wizardTitle = isPileStandalone
    ? 'Ввод контроля свай'
    : mode === 'upload'
      ? 'Мастер загрузки отчета'
      : mode === 'isso_support_input'
        ? 'Ввод площадок ИССО'
        : mode === 'batch'
          ? `Пакет отчетов: ${batch?.reports?.length ?? 0}`
          : `Черновик отчета${sourceFilename ? `: ${sourceFilename}` : ''}`

  return (
    <div className="flex min-h-dvh flex-col bg-bg-primary">
      <div className="px-4 sm:px-6 py-3 flex items-center gap-3 border-b border-border bg-white">
        <FileText className="w-5 h-5 text-accent-red" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-heading font-bold text-text-primary">
            {isPileStandalone ? 'Ввод контроля свай' : 'Отчёты'}
          </h1>
          {isPileStandalone && (
            <p className="mt-0.5 text-xs text-text-muted">Форма участка для оперативной подачи данных по забивке свай.</p>
          )}
        </div>
        {isPileStandalone ? (
          <button
            onClick={() => resetToList()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary"
          >
            <Plus className="w-4 h-4" />
            Новая форма
          </button>
        ) : mode === 'list' && (
          <button
            onClick={openUploadWizard}
            className="inline-flex items-center gap-2 bg-accent-red hover:bg-accent-burg text-white
                       px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors"
          >
            <Upload className="w-4 h-4" />
            Загрузить
          </button>
        )}
        {!isPileStandalone && mode !== 'list' && !wizardCollapsed && (
          <button
            onClick={collapseWizard}
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
          >
            <Minimize2 className="w-4 h-4" />
            Свернуть
          </button>
        )}
        {!isPileStandalone && mode !== 'list' && wizardCollapsed && (
          <button
            onClick={() => setWizardCollapsed(false)}
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
          >
            <ChevronRight className="w-4 h-4" />
            Развернуть
          </button>
        )}
        {!isPileStandalone && mode !== 'list' && (
          <button
            onClick={resetToList}
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
          >
            <X className="w-4 h-4" />
            К списку
          </button>
        )}
      </div>

      <div className={isPileStandalone ? 'p-3 pb-20 sm:p-4 md:p-6 lg:p-8' : 'p-4 sm:p-6 pb-24 lg:pb-6'}>
        {isPileStandalone && pileSubmitNotice && (
          <div className="mx-auto mb-3 max-w-[1600px] rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            {pileSubmitNotice}
          </div>
        )}
        {isPileStandalone ? (
          parsed && (
            <PreviewPane
              key={`pile-control-${pileFormRevision}`}
              parsed={parsed}
              sourceFilename={sourceFilename}
              compactPileMode
              onPayloadChange={setParsed}
              onImported={() => resetToList('Отчет отправлен. Поля очищены, можно вводить следующий отчет.')}
            />
          )
        ) : (
          <>
            {(mode === 'list' || wizardCollapsed) && (
              <div className="space-y-3">
                {wizardCollapsed && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs uppercase tracking-wide text-text-muted">Мастер свернут</div>
                      <div className="truncate text-sm font-semibold text-text-primary">{wizardTitle}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWizardCollapsed(false)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg"
                    >
                      <ChevronRight className="h-4 w-4" />
                      Продолжить
                    </button>
                    <button
                      type="button"
                      onClick={resetToList}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                    >
                      <X className="h-4 w-4" />
                      Закрыть
                    </button>
                  </div>
                )}
                <ReportsList />
              </div>
            )}

            {mode !== 'list' && (
              <div className={wizardCollapsed ? 'hidden' : ''} aria-hidden={wizardCollapsed}>
                {mode === 'isso_support_input' && (
                  <IssoSupportInputPane onClose={() => resetToList()} />
                )}
                {mode === 'upload' && (
                  <UploadPane
                    onParsed={(p, name) => { setParsed(p); setSourceFilename(name); setWizardCollapsed(false); setMode('preview') }}
                    onBatch={(payload) => { setBatch(payload); setImportedBatchReports(new Set()); setParsed(null); setWizardCollapsed(false); setMode('batch') }}
                    onIssoSupportInput={openIssoSupportInputWizard}
                  />
                )}
                {mode === 'batch' && batch && (
                  <BatchPreviewPane
                    batch={batch}
                    imported={importedBatchReports}
                    onSelect={(p, name) => { setParsed(p); setSourceFilename(name); setWizardCollapsed(false); setMode('preview') }}
                  />
                )}
                {mode === 'preview' && parsed && (
                  <PreviewPane
                    parsed={parsed}
                    sourceFilename={sourceFilename}
                    onPayloadChange={setParsed}
                    onImported={() => {
                      if (batch) {
                        setImportedBatchReports(prev => new Set(prev).add(sourceFilename))
                        setParsed(null)
                        setWizardCollapsed(false)
                        setMode('batch')
                      } else {
                        resetToList()
                      }
                    }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}


function issoMonthLabel(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/)
  if (!match) return 'месяц'
  const labels = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
  return `${labels[Number(match[2]) - 1] || match[2]} ${match[1]}`
}

function issoMonthInputValue(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}` : ''
}

function parseIssoInputInt(value: string | number | null | undefined): number {
  const parsed = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function issoMonthShortLabel(value: string, fallback?: string): string {
  const label = String(fallback || issoMonthLabel(value)).replace(/\s+\d{4}$/, '').trim()
  return label || 'месяц'
}

function issoLegacyFactValue(row: IssoSupportInputLine, monthValue: string): number {
  if (monthValue.includes('-06-')) return Number(row.fact_june_sites || 0)
  if (monthValue.includes('-07-')) return Number(row.fact_july_sites || 0)
  if (monthValue.includes('-08-')) return Number(row.fact_august_sites || 0)
  return 0
}

function normalizeIssoFactMonths(row: IssoSupportInputLine, months: { value: string; label: string }[]): IssoSupportInputFactMonth[] {
  const sourceMonths = months.length ? months : (row.fact_months || []).map(month => ({ value: month.value, label: month.label || issoMonthLabel(month.value) }))
  const values = new Map<string, IssoSupportInputFactMonth>()
  for (const month of row.fact_months || []) {
    if (!month.value) continue
    values.set(month.value, { value: month.value, label: month.label || issoMonthLabel(month.value), sites: parseIssoInputInt(month.sites) })
  }
  for (const month of sourceMonths) {
    const legacyValue = issoLegacyFactValue(row, month.value)
    const current = values.get(month.value)
    values.set(month.value, {
      value: month.value,
      label: month.label || current?.label || issoMonthLabel(month.value),
      sites: current ? parseIssoInputInt(current.sites) : legacyValue,
    })
  }
  return Array.from(values.values()).sort((a, b) => a.value.localeCompare(b.value))
}

function syncIssoFactMonthLegacy(row: IssoSupportInputLine, factMonths: IssoSupportInputFactMonth[]): IssoSupportInputLine {
  const valueFor = (needle: string) => factMonths.find(month => month.value.includes(needle))?.sites || 0
  const factTotal = factMonths.reduce((sum, month) => sum + parseIssoInputInt(month.sites), 0)
  return {
    ...row,
    fact_months: factMonths,
    fact_june_sites: valueFor('-06-'),
    fact_july_sites: valueFor('-07-'),
    fact_august_sites: valueFor('-08-'),
    sites_done: Math.max(Number(row.sites_done || 0), factTotal),
  }
}

function ensureIssoTargetPlan(row: IssoSupportInputLine, targetMonth: string): IssoSupportInputLine {
  if (!targetMonth || row.plans.some(plan => plan.plan_month === targetMonth)) return { ...row, plans: [...row.plans] }
  return {
    ...row,
    plans: [
      ...row.plans,
      { plan_id: '', plan_month: targetMonth, month_label: issoMonthLabel(targetMonth), support_range_text: '', planned_sites: 0 },
    ],
  }
}

function issoInputObjectTone(item: IssoSupportInputObject): string {
  if (item.ms11_scope) return 'border-sky-300 bg-sky-50/80'
  if (Number(item.sites_total || 0) > 0 && Number(item.sites_done || 0) >= Number(item.sites_total || 0)) return 'border-emerald-300 bg-emerald-50/80'
  return 'border-border bg-white'
}

function issoInputRowTone(row: IssoSupportInputLine): string {
  if (row.rd_status === 'missing') return 'border-red-200 bg-red-50/80'
  if (row.ms11_scope) return 'border-sky-200 bg-sky-50/80'
  if (Number(row.sites_total || 0) > 0 && Number(row.sites_done || 0) >= Number(row.sites_total || 0)) return 'border-emerald-200 bg-emerald-50/80'
  return 'border-border bg-bg-surface/40'
}

async function saveIssoSupportLine(row: IssoSupportInputLine): Promise<IssoSupportInputResponse> {
  const res = await fetch(`/api/wip/reports/isso-support-input/lines/${encodeURIComponent(row.line_id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Не удалось сохранить строку ИССО' }))
    throw new Error(error.detail || 'Не удалось сохранить строку ИССО')
  }
  return res.json()
}

function IssoSupportInputPane({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [selectedMonth, setSelectedMonth] = useState('')
  const [selectedSectionCode, setSelectedSectionCode] = useState<string | null>(null)
  const [bulkSavingKey, setBulkSavingKey] = useState<string | null>(null)
  const { data, isLoading, isError, error } = useQuery<IssoSupportInputResponse>({
    queryKey: ['wip', 'reports', 'isso-support-input', selectedMonth],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (selectedMonth) params.set('month', selectedMonth)
      const res = await fetch(`/api/wip/reports/isso-support-input${params.toString() ? `?${params}` : ''}`)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ detail: 'Не удалось загрузить площадки ИССО' }))
        throw new Error(payload.detail || 'Не удалось загрузить площадки ИССО')
      }
      return res.json()
    },
  })
  useEffect(() => {
    if (!selectedMonth && data?.target_month) setSelectedMonth(data.target_month)
  }, [data?.target_month, selectedMonth])
  useEffect(() => {
    if (!data?.sections?.length) return
    if (!selectedSectionCode || !data.sections.some(section => section.section_code === selectedSectionCode)) {
      setSelectedSectionCode(data.sections[0].section_code)
    }
  }, [data?.sections, selectedSectionCode])

  const saveMutation = useMutation({
    mutationFn: saveIssoSupportLine,
    onSuccess: saved => {
      qc.setQueryData(['wip', 'reports', 'isso-support-input', selectedMonth], saved)
      qc.invalidateQueries({ queryKey: ['wip', 'dashboard', 'isso-support'] })
      qc.invalidateQueries({ queryKey: ['wip', 'reports', 'isso-support-input'] })
    },
  })

  const activeSection = data?.sections.find(section => section.section_code === selectedSectionCode) || data?.sections[0]

  async function markObjectMs11(item: IssoSupportInputObject) {
    setBulkSavingKey(item.object_code || item.object_name)
    try {
      for (const row of item.rows) {
        await saveMutation.mutateAsync(ensureIssoTargetPlan({ ...row, ms11_scope: true }, selectedMonth || data?.target_month || ''))
      }
    } finally {
      setBulkSavingKey(null)
    }
  }

  return (
    <div className="mx-auto max-w-[1800px] space-y-3">
      <section className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Новый режим ввода</div>
            <h2 className="font-heading text-lg font-bold text-text-primary">Отсыпка площадок ИССО</h2>
            <p className="mt-0.5 text-xs text-text-muted">Редактирование карточек расширенного ИССО отчета: площадки, факты, планы, РД и МС-11.</p>
          </div>
          <label className="block">
            <span className="text-xs text-text-muted">Месяц</span>
            <select
              value={selectedMonth || data?.target_month || ''}
              onChange={e => setSelectedMonth(e.target.value)}
              className="mt-1 rounded-md border border-border bg-white px-3 py-1.5 text-sm font-semibold text-text-primary"
            >
              {(data?.months || []).map(month => <option key={month.value} value={month.value}>{month.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-surface">
            <X className="h-4 w-4" />
            Закрыть
          </button>
        </div>
        {data?.snapshot && (
          <div className="mt-3 rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-muted">
            Источник: {data.snapshot.title || data.snapshot.source_filename || 'последний snapshot'} · дата {data.snapshot.snapshot_date || 'н/д'}
          </div>
        )}
      </section>

      {isLoading ? (
        <div className="h-72 animate-pulse rounded-lg border border-border bg-white" />
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{(error as Error).message}</div>
      ) : !data?.available ? (
        <div className="rounded-lg border border-border bg-white p-4 text-sm text-text-secondary">{data?.detail || 'Данные ИССО недоступны.'}</div>
      ) : (
        <div className="grid min-h-[680px] grid-cols-1 gap-3 lg:grid-cols-[290px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-hidden rounded-lg border border-border bg-white">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Участки</div>
            <div className="max-h-[72vh] space-y-1 overflow-auto p-2">
              {data.sections.map(section => {
                const active = section.section_code === activeSection?.section_code
                return (
                  <button
                    key={section.section_code}
                    type="button"
                    onClick={() => setSelectedSectionCode(section.section_code)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition ${active ? 'border-accent-red bg-bg-surface shadow-sm' : 'border-transparent hover:border-border hover:bg-bg-surface'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-text-primary">{section.section_label}</span>
                      <span className="font-mono text-xs text-text-secondary">{section.objects.length}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
                      <span>Площадки</span>
                      <span className="font-mono">{section.sites_done}/{section.sites_total}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>

          <main className="min-w-0 space-y-3 overflow-auto pr-1">
            {!activeSection ? (
              <div className="rounded-lg border border-border bg-white p-4 text-sm text-text-muted">Выберите участок.</div>
            ) : activeSection.objects.length === 0 ? (
              <div className="rounded-lg border border-border bg-white p-4 text-sm text-text-muted">На участке нет карточек ИССО.</div>
            ) : activeSection.objects.map(item => (
              <IssoSupportInputObjectCard
                key={`${item.section_code}-${item.object_code}-${item.object_no}`}
                item={item}
                targetMonth={selectedMonth || data.target_month}
                months={data.months || []}
                saving={saveMutation.isPending || bulkSavingKey === (item.object_code || item.object_name)}
                saveError={saveMutation.error?.message || ''}
                onSave={line => saveMutation.mutate(ensureIssoTargetPlan(line, selectedMonth || data.target_month))}
                onMarkObjectMs11={() => markObjectMs11(item)}
              />
            ))}
          </main>
        </div>
      )}
    </div>
  )
}

function IssoSupportInputObjectCard({
  item,
  targetMonth,
  months,
  saving,
  saveError,
  onSave,
  onMarkObjectMs11,
}: {
  item: IssoSupportInputObject
  targetMonth: string
  months: { value: string; label: string }[]
  saving: boolean
  saveError: string
  onSave: (line: IssoSupportInputLine) => void
  onMarkObjectMs11: () => void
}) {
  return (
    <section className={`rounded-lg border p-3 shadow-sm ${issoInputObjectTone(item)}`}>
      <div className="flex flex-wrap items-start gap-3 border-b border-border/70 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{item.section_label} · {item.pk_label || 'ПК не задан'}</div>
          <h3 className="mt-0.5 font-heading text-base font-bold text-text-primary">{item.object_no ? `№${item.object_no} · ` : ''}{item.object_name}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-semibold">
            <span className="rounded border border-border bg-white/80 px-2 py-0.5 text-text-secondary">Площадки {item.sites_done}/{item.sites_total}</span>
            <span className={`rounded px-2 py-0.5 ${item.ms11_scope ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-700'}`}>Силами МС-11: {item.ms11_scope ? 'да' : 'нет'}</span>
            <span className={`rounded px-2 py-0.5 ${item.ms11_started ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>МС-11 зашел: {item.ms11_started ? 'да' : 'нет'}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onMarkObjectMs11}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          Весь ИССО силами МС-11
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {item.rows.map(row => (
          <IssoSupportInputLineEditor key={row.line_id} row={row} targetMonth={targetMonth} months={months} saving={saving} onSave={onSave} />
        ))}
      </div>
      {saveError && <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{saveError}</div>}
    </section>
  )
}

function IssoSupportInputLineEditor({
  row,
  targetMonth,
  months,
  saving,
  onSave,
}: {
  row: IssoSupportInputLine
  targetMonth: string
  months: { value: string; label: string }[]
  saving: boolean
  onSave: (line: IssoSupportInputLine) => void
}) {
  const [draft, setDraft] = useState<IssoSupportInputLine>(() => syncIssoFactMonthLegacy(ensureIssoTargetPlan(row, targetMonth), normalizeIssoFactMonths(row, months)))
  useEffect(() => setDraft(syncIssoFactMonthLegacy(ensureIssoTargetPlan(row, targetMonth), normalizeIssoFactMonths(row, months))), [row, targetMonth, months])

  function updateNumber(key: 'supports_total' | 'supports_done' | 'fact_supports' | 'sites_total' | 'sites_done', value: string) {
    setDraft(prev => ({ ...prev, [key]: parseIssoInputInt(value) }))
  }

  function updateFactMonth(monthValue: string, value: string) {
    const sites = parseIssoInputInt(value)
    setDraft(prev => {
      const factMonths = normalizeIssoFactMonths(prev, months).map(month => (
        month.value === monthValue ? { ...month, sites } : month
      ))
      return syncIssoFactMonthLegacy(prev, factMonths)
    })
  }

  function updatePlan(index: number, patch: Partial<IssoSupportInputPlan>) {
    setDraft(prev => ({
      ...prev,
      plans: prev.plans.map((plan, i) => i === index ? { ...plan, ...patch } : plan),
    }))
  }

  function addPlan() {
    const baseMonth = targetMonth || new Date().toISOString().slice(0, 7) + '-01'
    setDraft(prev => ({
      ...prev,
      plans: [...prev.plans, { plan_id: '', plan_month: baseMonth, month_label: issoMonthLabel(baseMonth), support_range_text: '', planned_sites: 0 }],
    }))
  }

  return (
    <div className={`rounded-md border p-3 ${issoInputRowTone(draft)}`}>
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(220px,1.6fr)_repeat(5,minmax(82px,0.45fr))_150px]">
        <label className="block min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Опоры / блок</span>
          <input
            value={draft.support_label || ''}
            onChange={e => setDraft(prev => ({ ...prev, support_label: e.target.value }))}
            className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm font-semibold text-text-primary"
          />
        </label>
        <NumberField label="Опор" value={draft.supports_total} onChange={value => updateNumber('supports_total', value)} />
        <NumberField label="Опор факт" value={draft.supports_done} onChange={value => updateNumber('supports_done', value)} />
        <NumberField label="Площ." value={draft.sites_total} onChange={value => updateNumber('sites_total', value)} />
        <NumberField label="Готово" value={draft.sites_done} onChange={value => updateNumber('sites_done', value)} />
        <NumberField label="Факт опор" value={draft.fact_supports} onChange={value => updateNumber('fact_supports', value)} />
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">РД</span>
          <select
            value={draft.rd_status || 'unknown'}
            onChange={e => setDraft(prev => ({ ...prev, rd_status: e.target.value }))}
            className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
          >
            <option value="available">РД есть</option>
            <option value="missing">нет РД</option>
            <option value="unknown">РД н/д</option>
          </select>
        </label>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {normalizeIssoFactMonths(draft, months).map(month => (
          <NumberField
            key={month.value}
            label={`Факт ${issoMonthShortLabel(month.value, month.label)}`}
            value={month.sites}
            onChange={value => updateFactMonth(month.value, value)}
          />
        ))}
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Срок</span>
          <input value={draft.deadline || ''} onChange={e => setDraft(prev => ({ ...prev, deadline: e.target.value }))} className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm" />
        </label>
        <label className="flex items-center gap-2 self-end rounded border border-border bg-white px-2 py-1.5 text-sm font-semibold text-text-primary">
          <input type="checkbox" checked={Boolean(draft.ms11_scope)} onChange={e => setDraft(prev => ({ ...prev, ms11_scope: e.target.checked }))} />
          Силами МС-11
        </label>
        <label className="flex items-center gap-2 self-end rounded border border-border bg-white px-2 py-1.5 text-sm font-semibold text-text-primary">
          <input type="checkbox" checked={Boolean(draft.ms11_started)} onChange={e => setDraft(prev => ({ ...prev, ms11_started: e.target.checked }))} />
          МС-11 зашел
        </label>
      </div>

      <label className="mt-2 block">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">Комментарий</span>
        <textarea value={draft.remark || ''} onChange={e => setDraft(prev => ({ ...prev, remark: e.target.value }))} rows={2} className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm" />
      </label>

      <div className="mt-3 rounded-md border border-border bg-white/70 p-2">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Планы по месяцам</div>
          <button type="button" onClick={addPlan} className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-white">
            <Plus className="h-3 w-3" />
            План
          </button>
        </div>
        <div className="space-y-1.5">
          {draft.plans.map((plan, index) => (
            <div key={`${plan.plan_id || 'new'}-${index}`} className="grid grid-cols-1 gap-1.5 md:grid-cols-[150px_100px_minmax(0,1fr)]">
              <input
                type="month"
                value={issoMonthInputValue(plan.plan_month)}
                onChange={e => updatePlan(index, { plan_month: e.target.value ? `${e.target.value}-01` : plan.plan_month, month_label: e.target.value ? issoMonthLabel(`${e.target.value}-01`) : plan.month_label })}
                className="rounded border border-border bg-white px-2 py-1.5 text-sm"
              />
              <input
                type="number"
                min={0}
                value={plan.planned_sites ?? 0}
                onChange={e => updatePlan(index, { planned_sites: parseIssoInputInt(e.target.value) })}
                className="rounded border border-border bg-white px-2 py-1.5 text-sm font-mono"
                aria-label="План площадок"
              />
              <input
                value={plan.support_range_text || ''}
                onChange={e => updatePlan(index, { support_range_text: e.target.value })}
                placeholder="Опоры месяца"
                className="rounded border border-border bg-white px-2 py-1.5 text-sm"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => onSave(syncIssoFactMonthLegacy(draft, normalizeIssoFactMonths(draft, months)))}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          {saving ? 'Сохраняю...' : 'Сохранить строку'}
        </button>
      </div>
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
      <input
        type="number"
        min={0}
        value={value ?? 0}
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm font-mono text-text-primary"
      />
    </label>
  )
}


// ── list ────────────────────────────────────────────────────────────────

function ReportColumnHeader({
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
  align?: 'left' | 'right'
  sortKeyValue?: SortKey
  activeSortKey: SortKey
  sortDir: SortDir
  filterKey?: ReportFilterKey
  isFilterOpen: boolean
  options?: ReportFilterOption[]
  excludedValues?: string[]
  onToggleSort: (key: SortKey) => void
  onToggleFilter: (key: ReportFilterKey) => void
  onToggleFilterValue: (key: ReportFilterKey, value: string) => void
  onClearFilter: (key: ReportFilterKey) => void
}) {
  const excludedSet = useMemo(() => new Set(excludedValues), [excludedValues])
  const activeFilterCount = excludedValues.length
  const isSorted = sortKeyValue && activeSortKey === sortKeyValue
  const menuAlign = align === 'right' ? 'right-2' : 'left-2'

  return (
    <th className={`relative px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
        {sortKeyValue ? (
          <button
            type="button"
            onClick={() => onToggleSort(sortKeyValue)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold text-text-secondary hover:bg-white hover:text-text-primary"
            title="Сортировка"
          >
            <span>{title}</span>
            {isSorted && <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ) : (
          <span className="px-1 font-semibold text-text-secondary">{title}</span>
        )}
        {filterKey && (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              onToggleFilter(filterKey)
            }}
            className={`inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded border px-1 ${
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
          className={`absolute ${menuAlign} top-full z-40 mt-1 w-64 rounded-md border border-border bg-white text-left normal-case shadow-xl`}
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
                <label
                  key={option.value || '__empty__'}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleFilterValue(filterKey, option.value)}
                    className="h-3.5 w-3.5 rounded border-border text-sky-600 focus:ring-sky-500"
                  />
                  <span className={`min-w-0 flex-1 truncate ${checked ? 'text-text-primary' : 'text-text-muted line-through'}`} title={option.label}>
                    {option.label}
                  </span>
                  <span className="font-mono text-[10px] text-text-muted">{option.count}</span>
                </label>
              )
            })}
            {options.length === 0 && (
              <div className="px-3 py-4 text-xs text-text-muted">Нет значений</div>
            )}
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

function ReportUserFlagsCell({
  row,
  open,
  isSaving,
  onToggleOpen,
  onSave,
}: {
  row: ReportRow
  open: boolean
  isSaving: boolean
  onToggleOpen: () => void
  onSave: (flags: ReportUserFlag[]) => void
}) {
  const [customLabel, setCustomLabel] = useState('')
  const [customColor, setCustomColor] = useState(REPORT_USER_FLAG_COLORS[0])
  const flags = row.user_flags || []

  function togglePreset(preset: ReportUserFlag) {
    const active = flags.some(flag => reportFlagMatches(flag, preset))
    onSave(active ? removeReportFlag(flags, preset) : upsertReportFlag(flags, preset))
  }

  function addCustomFlag() {
    const label = customLabel.trim()
    if (!label) return
    onSave(upsertReportFlag(flags, { key: 'custom', label, color: customColor }))
    setCustomLabel('')
  }

  return (
    <div className="relative min-w-[12rem]" onClick={e => e.stopPropagation()}>
      <div className="flex max-w-[18rem] flex-wrap items-center gap-1">
        {flags.length === 0 && <span className="text-xs text-text-muted">—</span>}
        {flags.map(flag => (
          <button
            key={`${flag.key}:${flag.label}`}
            type="button"
            onClick={() => onSave(removeReportFlag(flags, flag))}
            className="inline-flex max-w-[10rem] items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium"
            style={reportFlagStyle(flag)}
            title={flag.updated_by ? `Поставил: ${flag.updated_by}` : 'Снять флаг'}
          >
            <span className="truncate">{flag.label}</span>
            <X className="h-3 w-3 shrink-0" />
          </button>
        ))}
        <button
          type="button"
          onClick={onToggleOpen}
          disabled={isSaving}
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-white text-text-muted hover:bg-bg-surface hover:text-text-primary disabled:opacity-50"
          title="Редактировать флаги"
          aria-label="Редактировать флаги отчета"
        >
          <Flag className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-8 z-30 w-72 rounded-lg border border-border bg-white p-3 font-sans shadow-xl">
          <div className="mb-2 text-xs font-semibold uppercase text-text-muted">Флаги отчета</div>
          <div className="grid gap-1.5">
            {REPORT_USER_FLAG_PRESETS.map(preset => {
              const active = flags.some(flag => reportFlagMatches(flag, preset))
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => togglePreset(preset)}
                  disabled={isSaving}
                  className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-sm ${active ? 'bg-bg-surface text-text-primary' : 'bg-white text-text-secondary hover:bg-bg-surface'}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: preset.color }} />
                    {preset.label}
                  </span>
                  {active && <Check className="h-4 w-4" />}
                </button>
              )
            })}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 text-xs font-medium text-text-muted">Свой флаг</div>
            <div className="flex items-center gap-2">
              <input
                value={customLabel}
                onChange={e => setCustomLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomFlag() } }}
                className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-accent-red"
                placeholder="Название"
                maxLength={48}
              />
              <input
                type="color"
                value={customColor}
                onChange={e => setCustomColor(e.target.value)}
                className="h-8 w-9 rounded border border-border bg-white p-0.5"
                title="Цвет флага"
              />
              <button
                type="button"
                onClick={addCustomFlag}
                disabled={isSaving || !customLabel.trim()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent-red text-white hover:bg-accent-burg disabled:opacity-50"
                title="Добавить флаг"
                aria-label="Добавить флаг"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex gap-1">
              {REPORT_USER_FLAG_COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setCustomColor(color)}
                  className={`h-5 w-5 rounded-full border ${customColor === color ? 'border-text-primary' : 'border-white'}`}
                  style={{ backgroundColor: color }}
                  title={color}
                  aria-label={`Выбрать цвет ${color}`}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReportsList() {
  const { isAdmin, user } = useAuth()
  const qc = useQueryClient()
  const pageSize = 100
  const [page, setPage] = useState(0)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')
  const [uploadedBy, setUploadedBy] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>(() => storedReportSortKey())
  const [sortDir, setSortDir] = useState<SortDir>(() => storedSortDir(REPORTS_SORT_DIR_KEY))
  const [filters, setFilters] = useState<ReportFilters>(() => storedReportFilters())
  const [openFilter, setOpenFilter] = useState<ReportFilterKey | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [minimizedReportId, setMinimizedReportId] = useState<string | null>(null)
  const [flagEditorId, setFlagEditorId] = useState<string | null>(null)
  const [downloadingReportId, setDownloadingReportId] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState('')
  const didMountServerFilters = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const reportId = new URLSearchParams(window.location.search).get('report_id')
    if (reportId) {
      setSelectedId(reportId)
      setMinimizedReportId(null)
    }
  }, [])

  const { data, isLoading, isError } = useQuery<ReportsListResponse>({
    queryKey: ['reports-list', page, dateFrom, dateTo, uploadedBy],
    queryFn: async () => {
      const params = new URLSearchParams({
        paged: 'true',
        limit: String(pageSize),
        offset: String(page * pageSize),
      })
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (uploadedBy) params.set('uploaded_by', uploadedBy)
      const res = await fetch(`/api/wip/reports?${params.toString()}`)
      if (!res.ok) throw new Error(`Failed to fetch reports: ${res.status}`)
      return res.json()
    },
  })

  useEffect(() => {
    if (!didMountServerFilters.current) {
      didMountServerFilters.current = true
      return
    }
    setPage(0)
    setSelectedId(null)
    setMinimizedReportId(null)
  }, [dateFrom, dateTo, uploadedBy])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(REPORTS_FILTERS_KEY, JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(REPORTS_SORT_KEY_KEY, sortKey)
    window.localStorage.setItem(REPORTS_SORT_DIR_KEY, sortDir)
  }, [sortKey, sortDir])

  const deleteMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const res = await fetch(`/api/wip/reports/${reportId}`, { method: 'DELETE' })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка удаления отчета' }))
        throw new Error(e.detail || 'Ошибка удаления отчета')
      }
      return res.json()
    },
    onSuccess: (_result, reportId) => {
      if (selectedId === reportId) setSelectedId(null)
      if (minimizedReportId === reportId) setMinimizedReportId(null)
      qc.invalidateQueries({ queryKey: ['reports-list'] })
    },
  })

  const flagMutation = useMutation<{ id: string; user_flags: ReportUserFlag[] }, Error, { reportId: string; flags: ReportUserFlag[] }>({
    mutationFn: async ({ reportId, flags }) => {
      const res = await fetch(`/api/wip/reports/${reportId}/user-flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка сохранения флагов' }))
        throw new Error(e.detail || 'Ошибка сохранения флагов')
      }
      return res.json()
    },
    onSuccess: (result, vars) => {
      qc.setQueriesData<ReportsListResponse>({ queryKey: ['reports-list'] }, current => current ? ({
        ...current,
        rows: (current.rows || []).map(row => (
          row.id === vars.reportId ? { ...row, user_flags: result.user_flags || [] } : row
        )),
      }) : current)
    },
  })

  const currentUsername = user?.username || ''
  function canDeleteReport(row: ReportRow): boolean {
    const status = row.status
    if (isAdmin) return ['pending_review', 'review', 'confirmed', 'approved'].includes(status)
    const isOwner = Boolean(row.uploaded_by_username && row.uploaded_by_username === currentUsername)
    return isOwner && ['pending_review', 'review'].includes(status)
  }

  async function downloadReportXlsx(row: ReportRow) {
    setDownloadError('')
    setDownloadingReportId(row.id)
    try {
      const res = await fetch(`/api/wip/reports/${row.id}/xlsx`)
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка загрузки отчета' }))
        throw new Error(e.detail || 'Ошибка загрузки отчета')
      }
      const blob = await res.blob()
      const filename = filenameFromContentDisposition(res.headers.get('Content-Disposition')) || reportFallbackXlsxFilename(row)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setDownloadError((err as Error).message || 'Ошибка загрузки отчета')
    } finally {
      setDownloadingReportId(null)
    }
  }

  const allRows = useMemo<ReportRow[]>(() => data?.rows ?? [], [data])
  const serverTotal = data?.total ?? allRows.length
  const serverOffset = data?.offset ?? page * pageSize
  const pageStart = serverTotal === 0 ? 0 : serverOffset + 1
  const pageEnd = Math.min(serverOffset + allRows.length, serverTotal)
  const hasNextPage = serverOffset + pageSize < serverTotal
  const hasPrevPage = page > 0
  const hasServerFilters = Boolean(dateFrom || dateTo || uploadedBy)
  const hasPendingDateFilters = dateFromDraft !== dateFrom || dateToDraft !== dateTo
  const uploaderOptions = data?.filter_options?.uploaders ?? []
  const recordCount = (row: ReportRow) => (row.work_items_count ?? 0) + (row.movements_count ?? 0) + (row.equipment_count ?? 0) + (row.fill_statuses_count ?? 0)

  const filterOptions = useMemo(() => {
    const result = {} as Record<ReportFilterKey, ReportFilterOption[]>
    for (const key of REPORT_FILTER_KEYS) result[key] = buildReportFilterOptions(allRows, key)
    return result
  }, [allRows])

  const activeFilterCount = useMemo(
    () => REPORT_FILTER_KEYS.reduce((sum, key) => sum + (filters[key]?.length ?? 0), 0),
    [filters],
  )

  const rows = useMemo(() => {
    const filtered = allRows.filter(row => REPORT_FILTER_KEYS.every(key => {
      const excluded = filters[key]
      return !excluded?.includes(reportFilterValue(row, key))
    }))
    const cmp = (a: ReportRow, b: ReportRow): number => {
      if (sortKey === 'date') return a.report_date.localeCompare(b.report_date)
      if (sortKey === 'section') return (a.section_name ?? '').localeCompare(b.section_name ?? '', 'ru')
      if (sortKey === 'source') return sourceLabel(a.source_type).localeCompare(sourceLabel(b.source_type), 'ru')
      if (sortKey === 'records') return recordCount(a) - recordCount(b)
      return statusLabel(a.status).localeCompare(statusLabel(b.status), 'ru')
    }
    const direction = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const primary = cmp(a, b)
      const fallback = a.report_date.localeCompare(b.report_date) || a.created_at.localeCompare(b.created_at)
      return (primary || fallback) * direction
    })
  }, [allRows, filters, sortDir, sortKey])

  function defaultSortDir(key: SortKey): SortDir {
    return key === 'date' || key === 'records' ? 'desc' : 'asc'
  }

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(defaultSortDir(k)) }
  }

  function toggleFilter(key: ReportFilterKey) {
    setOpenFilter(current => (current === key ? null : key))
  }

  function toggleFilterValue(key: ReportFilterKey, value: string) {
    setFilters(prev => {
      const excluded = new Set(prev[key] ?? [])
      if (excluded.has(value)) excluded.delete(value)
      else excluded.add(value)
      const next: ReportFilters = { ...prev }
      const values = Array.from(excluded)
      if (values.length) next[key] = values
      else delete next[key]
      return next
    })
  }

  function clearFilter(key: ReportFilterKey) {
    setFilters(prev => {
      const next: ReportFilters = { ...prev }
      delete next[key]
      return next
    })
  }

  function clearAllFilters() {
    setFilters({})
  }

  if (isLoading) {
    return <div className="py-12 text-center text-text-muted text-sm">Загрузка…</div>
  }
  if (isError) {
    return <div className="py-12 text-center text-red-500 text-sm">Ошибка загрузки</div>
  }
  const minimizedReport = minimizedReportId
    ? allRows.find(row => row.id === minimizedReportId) ?? null
    : null

  const resetServerFilters = () => {
    setDateFrom('')
    setDateTo('')
    setDateFromDraft('')
    setDateToDraft('')
    setUploadedBy('')
  }

  const applyDateFilters = () => {
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  const applyDateFiltersOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    applyDateFilters()
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-text-primary">Архив отчетов</div>
            <div className="text-xs text-text-muted">
              Загружаем серверными страницами по {pageSize}; старые даты ищутся через период и «кто добавил».
            </div>
          </div>
          {hasServerFilters && (
            <button
              type="button"
              onClick={resetServerFilters}
              className="inline-flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
              Сбросить период/автора
            </button>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-[160px_160px_auto_minmax(220px,1fr)]">
          <label className="block text-xs font-medium text-text-muted">
            Дата с
            <input
              type="date"
              value={dateFromDraft}
              onChange={event => setDateFromDraft(event.target.value)}
              onKeyDown={applyDateFiltersOnEnter}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm font-mono text-text-primary focus:border-accent-red focus:outline-none"
            />
          </label>
          <label className="block text-xs font-medium text-text-muted">
            Дата по
            <input
              type="date"
              value={dateToDraft}
              onChange={event => setDateToDraft(event.target.value)}
              onKeyDown={applyDateFiltersOnEnter}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm font-mono text-text-primary focus:border-accent-red focus:outline-none"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={applyDateFilters}
              disabled={!hasPendingDateFilters}
              className={`h-[34px] rounded-md px-3 text-sm font-medium ${hasPendingDateFilters ? 'bg-accent-red text-white hover:bg-accent-burg' : 'border border-border bg-bg-surface text-text-muted'}`}
            >
              Показать
            </button>
          </div>
          <label className="block text-xs font-medium text-text-muted">
            Кто добавил
            <select
              value={uploadedBy}
              onChange={event => setUploadedBy(event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary focus:border-accent-red focus:outline-none"
            >
              <option value="">Все пользователи</option>
              {uploaderOptions.map(option => (
                <option key={option.value || '__empty__'} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {minimizedReport && selectedId === minimizedReportId && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-text-muted">Отчет свернут</div>
            <div className="truncate text-sm font-semibold text-text-primary">
              {minimizedReport.report_date} / {shiftLabel(minimizedReport.shift)} / {minimizedReport.section_name ?? '—'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMinimizedReportId(null)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg"
          >
            <ChevronRight className="h-4 w-4" />
            Открыть
          </button>
          <button
            type="button"
            onClick={() => { setSelectedId(null); setMinimizedReportId(null) }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
            Закрыть
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-text-muted">
        <span>
          Показано {rows.length} строк на странице; диапазон {pageStart}–{pageEnd} из {serverTotal}
          {activeFilterCount > 0 ? ` (после локальных фильтров: ${activeFilterCount})` : ''}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
              Сбросить локальные фильтры таблицы
            </button>
          )}
          <button
            type="button"
            onClick={() => setPage(value => Math.max(0, value - 1))}
            disabled={!hasPrevPage}
            className="rounded border border-border bg-white px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            ← Назад
          </button>
          <span>Стр. {page + 1}</span>
          <button
            type="button"
            onClick={() => setPage(value => value + 1)}
            disabled={!hasNextPage}
            className="rounded border border-border bg-white px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Дальше →
          </button>
        </div>
      </div>

      <div className="bg-white border border-border rounded-lg overflow-x-auto">
        {deleteMutation.isError && (
          <div className="px-3 py-2 text-sm text-red-600 border-b border-red-100 bg-red-50">
            {deleteMutation.error?.message || 'Ошибка удаления отчета'}
          </div>
        )}
        {downloadError && (
          <div className="px-3 py-2 text-sm text-red-600 border-b border-red-100 bg-red-50">
            {downloadError}
          </div>
        )}
        {flagMutation.isError && (
          <div className="px-3 py-2 text-sm text-red-600 border-b border-red-100 bg-red-50">
            {flagMutation.error?.message || 'Ошибка сохранения флагов'}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted">Нет отчетов под текущие фильтры.</div>
        ) : (
          <table className="w-full min-w-[960px] text-sm font-mono">
            <thead className="bg-bg-surface text-text-muted text-xs uppercase">
              <tr>
                <ReportColumnHeader
                  title="Дата"
                  sortKeyValue="date"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  filterKey="date"
                  isFilterOpen={openFilter === 'date'}
                  options={filterOptions.date}
                  excludedValues={filters.date ?? []}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <ReportColumnHeader
                  title="Смена"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  filterKey="shift"
                  isFilterOpen={openFilter === 'shift'}
                  options={filterOptions.shift}
                  excludedValues={filters.shift ?? []}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <ReportColumnHeader
                  title="Участок"
                  sortKeyValue="section"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  filterKey="section"
                  isFilterOpen={openFilter === 'section'}
                  options={filterOptions.section}
                  excludedValues={filters.section ?? []}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <ReportColumnHeader
                  title="Статус"
                  sortKeyValue="status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  filterKey="status"
                  isFilterOpen={openFilter === 'status'}
                  options={filterOptions.status}
                  excludedValues={filters.status ?? []}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <th className="px-3 py-2 text-left">Флаги</th>
                <ReportColumnHeader
                  title="Записей"
                  align="right"
                  sortKeyValue="records"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  isFilterOpen={false}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <ReportColumnHeader
                  title="Источник"
                  sortKeyValue="source"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  filterKey="source"
                  isFilterOpen={openFilter === 'source'}
                  options={filterOptions.source}
                  excludedValues={filters.source ?? []}
                  onToggleSort={toggleSort}
                  onToggleFilter={toggleFilter}
                  onToggleFilterValue={toggleFilterValue}
                  onClearFilter={clearFilter}
                />
                <th className="px-3 py-2 text-right">Действие</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const total = recordCount(r)
                const userFlags = r.user_flags || []
                return (
                  <tr
                    key={r.id}
                    onClick={() => { setSelectedId(r.id); setMinimizedReportId(null) }}
                    className={`border-t border-border cursor-pointer transition-colors hover:bg-bg-surface/50 ${pkReportTone(r.pk_validation_level)}`}
                    style={reportFlagRowStyle(userFlags)}
                  >
                    <td className="px-3 py-2 text-text-primary">{r.report_date}</td>
                    <td className="px-3 py-2 text-text-secondary">{shiftLabel(r.shift)}</td>
                    <td className="px-3 py-2 text-text-secondary">{r.section_name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${statusTone(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                      {r.pk_validation_level && (
                        <span
                          className={`ml-1 inline-flex px-2 py-0.5 rounded text-xs font-medium ${pkReportBadgeTone(r.pk_validation_level)}`}
                          title={r.pk_validation_level === 'error' ? 'В отчете есть ошибка в пикетаже' : 'В отчете есть предупреждение по пикетажу'}
                        >
                          ПК {r.pk_validation_count || ''}
                        </span>
                      )}
                      {(r.review_flags || []).map(flag => (
                        <span
                          key={flag}
                          className="ml-1 inline-flex px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800"
                          title="Дополнительный тег проверки"
                        >
                          {flag}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ReportUserFlagsCell
                        row={r}
                        open={flagEditorId === r.id}
                        isSaving={flagMutation.isPending}
                        onToggleOpen={() => setFlagEditorId(current => (current === r.id ? null : r.id))}
                        onSave={flags => flagMutation.mutate({ reportId: r.id, flags })}
                      />
                    </td>
                    <td className="px-3 py-2 text-right text-text-secondary">{total}</td>
                    <td className="px-3 py-2 text-text-muted text-xs">{sourceDisplay(r)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation()
                            downloadReportXlsx(r)
                          }}
                          disabled={downloadingReportId === r.id}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-surface hover:text-text-primary disabled:opacity-50"
                          aria-label="Скачать отчет XLSX"
                          title="Скачать XLSX"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        {canDeleteReport(r) && (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              const confirmed = ['confirmed', 'approved'].includes(r.status)
                              const message = confirmed
                                ? 'Удалить подтвержденный отчет и все связанные с ним факты из дашборда?'
                                : 'Удалить неподтвержденный отчет?'
                              if (window.confirm(message)) {
                                deleteMutation.mutate(r.id)
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                            aria-label="Удалить отчет"
                            title={['confirmed', 'approved'].includes(r.status) ? 'Удалить подтвержденный отчет' : 'Удалить неподтвержденный отчет'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {selectedId && minimizedReportId !== selectedId && (
          <ReportDetailModal
            reportId={selectedId}
            onClose={() => { setSelectedId(null); setMinimizedReportId(null) }}
            onCollapse={() => setMinimizedReportId(selectedId)}
          />
        )}
      </div>
    </div>
  )
}

// ── upload ──────────────────────────────────────────────────────────────

function UploadPane({
  onParsed,
  onBatch,
  onIssoSupportInput,
}: {
  onParsed: (p: ParsedPayload, filename: string) => void
  onBatch: (payload: BatchPreviewPayload) => void
  onIssoSupportInput: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [pastedText, setPastedText] = useState('')

  const previewMutation = useMutation({
    mutationFn: async (input: { file?: File; text?: string; name: string }) => {
      const fd = new FormData()
      if (input.file) {
        fd.append('file', input.file)
      } else if (input.text) {
        const blob = new Blob([input.text], { type: 'text/plain' })
        fd.append('file', blob, input.name || 'pasted.txt')
      }
      const res = await fetch('/api/wip/reports/preview', { method: 'POST', body: fd })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка разбора' }))
        throw new Error(e.detail || 'Ошибка разбора')
      }
      return (await res.json()) as PreviewResponse
    },
    onSuccess: (parsed, input) => {
      if (isBatchPreview(parsed)) {
        onBatch(parsed)
      } else {
        onParsed(parsed, input.name)
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  const handleFile = useCallback((file: File) => {
    setError(null)
    const name = file.name.toLowerCase()
    if (!name.endsWith('.txt') && !name.endsWith('.log') && !name.endsWith('.xlsx') && !name.endsWith('.xlsm')) {
      setError('Только .txt, .log, .xlsx или .xlsm')
      return
    }
    previewMutation.mutate({ file, name: file.name })
  }, [previewMutation])

  const handleText = useCallback(() => {
    setError(null)
    const t = pastedText.trim()
    if (!t) {
      setError('Вставьте текст отчёта')
      return
    }
    previewMutation.mutate({ text: t, name: `pasted-${Date.now()}.txt` })
  }, [pastedText, previewMutation])

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4 text-xs">
        <button
          onClick={() => setMode('file')}
          className={`px-3 py-1.5 rounded-md ${mode === 'file' ? 'bg-text-primary text-white' : 'bg-bg-surface text-text-muted'}`}
        >Файл</button>
        <button
          onClick={() => setMode('text')}
          className={`px-3 py-1.5 rounded-md ${mode === 'text' ? 'bg-text-primary text-white' : 'bg-bg-surface text-text-muted'}`}
        >Текст</button>
        <button
          onClick={() => onParsed(emptyReportPayload(), 'manual-report')}
          className="px-3 py-1.5 rounded-md bg-bg-surface text-text-muted hover:bg-text-primary hover:text-white"
        >Конструктор</button>
        <button
          onClick={() => onParsed(emptyFillReportPayload(), 'fill-report-manual')}
          className="px-3 py-1.5 rounded-md bg-bg-surface text-text-muted hover:bg-text-primary hover:text-white"
        >Данные по отсыпке</button>
        <button
          onClick={onIssoSupportInput}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-surface text-text-muted hover:bg-text-primary hover:text-white"
        >
          <Flag className="h-3.5 w-3.5" />
          Отсыпка площадок ИССО
        </button>
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setIsDragging(false)
            const f = e.dataTransfer.files[0]
            if (f) handleFile(f)
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed p-12 text-center cursor-pointer transition-all bg-white
            ${isDragging ? 'border-accent-red bg-red-50' : 'border-border hover:border-accent-red/50'}`}
        >
          <Upload className="w-12 h-12 text-text-muted mx-auto mb-4" />
          <p className="text-text-primary font-medium">Перетащите файл или нажмите для выбора</p>
          <p className="text-text-muted text-xs mt-2 font-mono">.txt, .log, .xlsx или .xlsm</p>
          <input
            ref={fileInputRef} type="file" accept=".txt,.log,.xlsx,.xlsm" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
        </div>
      ) : mode === 'text' ? (
        <div className="rounded-xl border border-border bg-white p-4">
          <label className="text-xs uppercase tracking-wider text-text-muted block mb-2">
            Вставь текст суточного отчёта (формат «===СЕКЦИЯ===»)
          </label>
          <textarea
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
            rows={18}
            placeholder={'===Шапка===\nДата - 22.04.2026\nСмена - день\nУчасток - участок №8\n...\n\n===Перевозка===\nЕдиница техники:\n...'}
            className="w-full text-xs font-mono border border-border rounded-md p-2 resize-y min-h-[240px]"
          />
          <div className="flex justify-end mt-3">
            <button
              onClick={handleText}
              disabled={!pastedText.trim() || previewMutation.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-md bg-accent-red text-white hover:bg-accent-burg disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" /> Разобрать
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-white p-6 text-sm text-text-secondary">
          Откроется форма ввода забивки свай с датой, сменой, участком и строками по полям.
        </div>
      )}

      {previewMutation.isPending && (
        <p className="mt-4 text-center text-text-muted text-sm">Разбираем…</p>
      )}
      {error && (
        <p className="mt-4 text-center text-red-500 text-sm">{error}</p>
      )}
    </div>
  )
}

function BatchPreviewPane({
  batch,
  imported,
  onSelect,
}: {
  batch: BatchPreviewPayload
  imported: Set<string>
  onSelect: (payload: ParsedPayload, sourceFilename: string) => void
}) {
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <section className="bg-white border border-border rounded-lg p-4">
        <h2 className="text-sm font-heading font-semibold text-text-primary">В файле найдено несколько отчетов</h2>
        <p className="text-xs text-text-muted mt-1">
          {batch.source_filename}: {batch.count} отчетов. Открой каждый отчет, проверь и отправь на проверку отдельно.
        </p>
      </section>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {batch.reports.map((report, index) => {
          const name = report.source?.filename || `${batch.source_filename} #${index + 1}`
          const done = imported.has(name)
          const warnings = report.warnings?.length || 0
          return (
            <button
              key={name}
              type="button"
              onClick={() => onSelect(report, name)}
              className="text-left bg-white border border-border rounded-lg p-4 hover:border-accent-red/60 hover:shadow-sm transition-all"
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-bg-surface text-text-muted'}`}>
                  {done ? <Check className="w-4 h-4" /> : index + 1}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary">
                    {report.header.report_date || 'дата не задана'} · {shiftLabel(report.header.shift)}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {report.header.section_name || report.header.section_code || 'участок не задан'}
                  </div>
                  <div className="text-xs text-text-muted mt-2">
                    Работы: {(report.main_works || []).length + (report.aux_works || []).length} ·
                    {' '}Перевозка: {(report.transport || []).length} ·
                    {' '}Парк: {(report.park || []).length}
                  </div>
                  {warnings > 0 && (
                    <div className="text-xs text-amber-700 mt-1">{warnings} предупрежд.</div>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── shift summary ───────────────────────────────────────────────────────

function numericValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.').replace(/\s+/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function carrierBucket(value?: string | null) {
  const text = (value || '').toLowerCase()
  if (text.includes('ждс')) return 'ЖДС'
  if (text.includes('алмаз')) return 'АЛМАЗ'
  return 'Иные'
}

function materialBucket(code?: string | null, name?: string | null, suggestions?: ReferenceSuggestion[]) {
  const selected = selectedReferenceSuggestion(code, suggestions, name)
  const rawCode = String(selected?.code || code || '').trim()
  const rawName = String(selected?.label || name || '').trim()
  const text = `${rawCode} ${rawName}`.toLowerCase()
  const codeUpper = rawCode.toUpperCase()
  if (codeUpper === 'COARSE_SAND' || text.includes('coarse_sand') || text.includes('крупный песок') || text.includes('песок крупный')) return 'Крупный песок'
  if (codeUpper === 'SAND' || text.includes('sand') || text.includes('пес')) return 'Песок'
  if (['SHPGS', 'SHPS', 'ЩПС', 'ЩПГС'].includes(codeUpper) || text.includes('shpgs') || text.includes('щпгс') || text.includes('щпс')) return 'ЩПС/ЩПГС'
  if (codeUpper === 'PGS' || text.includes('пгс')) return 'ПГС'
  if (codeUpper === 'CRUSHED_STONE' || codeUpper === 'SCHEBEN' || text.includes('щеб')) return 'Щебень'
  if (codeUpper === 'SOIL' || text.includes('soil') || text.includes('грунт')) return 'Грунт'
  if (codeUpper === 'PEAT' || text.includes('peat') || text.includes('торф')) return 'Торф'
  return rawName || rawCode || 'Материал не указан'
}

function placeRole(
  code?: string | null,
  name?: string | null,
  suggestions?: ReferenceSuggestion[],
) {
  const selected = selectedReferenceSuggestion(code, suggestions, name)
  const objectTypeCode = String(selected?.object_type_code || '').toUpperCase()

  if (objectTypeCode === 'BORROW_PIT') return 'career'
  if (objectTypeCode === 'STOCKPILE') return 'stockpile'
  if (objectTypeCode) return 'constructive'

  const text = `${selected?.code || code || ''} ${selected?.label || name || ''}`.toLowerCase()
  if (text.includes('карьер') || text.includes('borrow') || text.includes('pit')) return 'career'
  if (
    text.includes('накоп') ||
    text.includes('stockpile') ||
    text.includes('stock_auto') ||
    text.includes('stock_')
  ) return 'stockpile'

  return 'constructive'
}

function movementCategory(trip: TransportTrip) {
  const fromRole = placeRole(trip.from_object_code, trip.from, trip.from_object_suggestions)
  const toRole = placeRole(trip.to_object_code, trip.to, trip.to_object_suggestions)
  if (fromRole === 'career' && toRole === 'stockpile') return 'карьер-накопитель'
  if (fromRole === 'career') return 'карьер-конструктив'
  if (fromRole === 'stockpile' && toRole === 'stockpile') return 'накопитель-накопитель'
  if (fromRole === 'stockpile') return 'накопитель-конструктив'
  if (toRole === 'stockpile') return 'конструктив-накопитель'
  return 'прочее'
}

function workSummaryLabel(row: WorkPreviewItem) {
  const selected = selectedReferenceSuggestion(row.work_type_code, row.work_type_suggestions, row.work_name)
  return selected?.label || row.work_type_code || row.work_name || 'Работа'
}

function objectSummaryLabel(row: WorkPreviewItem) {
  const selected = selectedReferenceSuggestion(row.object_code || row.constructive_code, row.object_suggestions, row.constructive)
  return selected?.label || row.object_code || row.constructive_code || row.constructive || 'Объект не задан'
}

function computeShiftSummary(payload: ParsedPayload) {
  const transport = new Map<string, { material: string; category: string; carrier: string; volume: number; trips: number }>()
  for (const unit of payload.transport || []) {
    const carrier = carrierBucket((unit.owner || unit.contractor_name) as string | undefined)
    for (const trip of unit.trips || []) {
      const material = materialBucket(trip.material_code, trip.material, trip.material_suggestions)
      if (!material) continue
      const category = movementCategory(trip)
      const key = `${material}|${category}|${carrier}`
      const existing = transport.get(key) || { material, category, carrier, volume: 0, trips: 0 }
      existing.volume += numericValue(trip.volume)
      existing.trips += numericValue(trip.trips)
      transport.set(key, existing)
    }
  }

  const works = new Map<string, { work: string; object: string; volume: number; unit: string; productivity: boolean }>()
  for (const row of [...(payload.main_works || []), ...(payload.aux_works || [])]) {
    const work = workSummaryLabel(row)
    const object = objectSummaryLabel(row)
    const unit = row.unit || 'м3'
    const key = `${work}|${object}|${unit}|${row.productivity_enabled !== false}`
    const existing = works.get(key) || { work, object, unit, productivity: row.productivity_enabled !== false, volume: 0 }
    existing.volume += numericValue(row.volume)
    works.set(key, existing)
  }

  const proposed: string[] = []
  for (const unit of payload.transport || []) {
    for (const trip of unit.trips || []) {
      if (trip.material && !trip.material_code) proposed.push(`Материал: ${trip.material}`)
      if (trip.from && !trip.from_object_code) proposed.push(`Объект откуда: ${trip.from}`)
      if (trip.to && !trip.to_object_code) proposed.push(`Объект куда: ${trip.to}`)
    }
  }
  for (const row of [...(payload.main_works || []), ...(payload.aux_works || [])]) {
    if (row.work_name && !row.work_type_code) proposed.push(`Работа: ${row.work_name}`)
    if (row.constructive && !(row.object_code || row.constructive_code)) proposed.push(`Объект: ${row.constructive}`)
  }
  for (const sp of payload.stockpiles || []) {
    if (sp.needs_create) proposed.push(`Накопитель: ${sp.name || sp.pk_raw_text || 'без названия'}`)
  }

  return {
    transport: Array.from(transport.values()).sort((a, b) => `${a.material}${a.category}${a.carrier}`.localeCompare(`${b.material}${b.category}${b.carrier}`)),
    works: Array.from(works.values()).sort((a, b) => `${a.object}${a.work}`.localeCompare(`${b.object}${b.work}`)),
    proposed: Array.from(new Set(proposed)),
  }
}

function ShiftSummaryPanel({
  payload,
  roads = [],
  sectionBoundaries = [],
  tempRoadStatusData,
  mainlineFillStatusData,
}: {
  payload: ParsedPayload
  roads?: TempRoadOption[]
  sectionBoundaries?: SectionBoundary[]
  tempRoadStatusData?: TempRoadStatusData
  mainlineFillStatusData?: MainlineFillStatusData
}) {
  const summary = useMemo(() => computeShiftSummary(payload), [payload])
  if (payload.report_mode === 'fill') {
    return (
      <FillShiftSummaryPanel
        payload={payload}
        roads={roads}
        sectionBoundaries={sectionBoundaries}
        tempRoadStatusData={tempRoadStatusData}
        mainlineFillStatusData={mainlineFillStatusData}
      />
    )
  }
  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <h2 className="text-sm font-heading font-semibold text-text-primary mb-3">Промежуточные итоги за сутки</h2>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 text-xs">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Возка</div>
          {summary.transport.length === 0 ? (
            <p className="text-text-muted">Нет данных</p>
          ) : (
            <div className="space-y-1">
              {summary.transport.map(row => (
                <div key={`${row.material}-${row.category}-${row.carrier}`} className="rounded border border-border bg-bg-surface px-2 py-1">
                  <div className="font-medium text-text-primary">{row.material} · {row.category} · {row.carrier}</div>
                  <div className="font-mono text-text-secondary">{row.volume.toFixed(1)} м3 · {row.trips} рейс.</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Работы в конструктиве</div>
          {summary.works.length === 0 ? (
            <p className="text-text-muted">Нет данных</p>
          ) : (
            <div className="space-y-1">
              {summary.works.map(row => (
                <div key={`${row.object}-${row.work}-${row.unit}-${row.productivity}`} className="rounded border border-border bg-bg-surface px-2 py-1">
                  <div className="font-medium text-text-primary">{row.object}</div>
                  <div className="font-mono text-text-secondary">{row.work}: {row.volume.toFixed(1)} {row.unit}</div>
                  <div className={row.productivity ? 'text-emerald-700' : 'text-text-muted'}>
                    {row.productivity ? 'учитывается в производительности' : 'не учитывается в производительности'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Предлагаемые изменения в БД</div>
          {summary.proposed.length === 0 ? (
            <p className="text-emerald-700">Новых сущностей не требуется</p>
          ) : (
            <ul className="space-y-1">
              {summary.proposed.map(item => (
                <li key={item} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">{item}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}


type FillMiniSegment = {
  statusKey: string
  start: number
  end: number
  label: string
}

function fillDefinitionMap<T extends string>(definitions: FillStatusDefinition<T>[]): Record<string, FillStatusDefinition<T>> {
  return Object.fromEntries(definitions.map(item => [item.key, item])) as Record<string, FillStatusDefinition<T>>
}

function tempRoadEditableStatus(value?: string | null): TempRoadEditableStatusKey {
  const key = String(value || '').trim() as TempRoadFillStatusKey
  return fillStatusFields.some(field => field.key === key) ? key as TempRoadEditableStatusKey : 'pioneer_fill'
}

function tempRoadRowPkRanges(row: FillStatusItem): string {
  if (row.pk_ranges !== undefined) return String(row.pk_ranges || '')
  const status = tempRoadEditableStatus(row.status_type)
  const explicit = (row as Record<string, PreviewValue>)[status]
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit)
  const first = fillStatusFields.find(field => String((row as Record<string, PreviewValue>)[field.key] || '').trim())
  return first ? String((row as Record<string, PreviewValue>)[first.key] || '') : ''
}

function singleStatusTempRoadRow(row: FillStatusItem): FillStatusItem {
  const status = tempRoadEditableStatus(row.status_type || fillStatusFields.find(field => String((row as Record<string, PreviewValue>)[field.key] || '').trim())?.key)
  const pkRanges = tempRoadRowPkRanges({ ...row, status_type: status })
  const next: FillStatusItem = { ...row, status_type: status, pk_ranges: pkRanges }
  fillStatusFields.forEach(field => {
    next[field.key] = field.key === status ? pkRanges : ''
  })
  return next
}

function normalizeTempRoadFillItems(items: FillStatusItem[]): FillStatusItem[] {
  return items.flatMap(row => {
    if (row.status_type || row.pk_ranges !== undefined) return [singleStatusTempRoadRow(row)]
    const filled = fillStatusFields.filter(field => String((row as Record<string, PreviewValue>)[field.key] || '').trim())
    if (!filled.length) return [singleStatusTempRoadRow(row)]
    return filled.map(field => singleStatusTempRoadRow({ ...row, status_type: field.key, pk_ranges: String((row as Record<string, PreviewValue>)[field.key] || '') }))
  })
}

function fillMiniSegmentsFromMainline(row: MainlineFillStatusItem): FillMiniSegment[] {
  const definition = MAINLINE_FILL_STATUS_BY_KEY[(row.status_type || 'prep_works') as MainlineFillStatusKey]
  return parsePkRangesForUi(row.pk_ranges).map(range => ({
    statusKey: definition.key,
    start: range.start,
    end: range.end,
    label: range.from === range.to ? range.from : `${range.from} - ${range.to}`,
  }))
}

function fillMiniSegmentsFromMainlineStatus(section: MainlineFillStatusSection): FillMiniSegment[] {
  return (section.segments || []).flatMap(segment => {
    if (segment.pk_start === null || segment.pk_start === undefined || segment.pk_end === null || segment.pk_end === undefined) return []
    const from = Number(segment.pk_start)
    const to = Number(segment.pk_end)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return []
    return [{
      statusKey: segment.status_type,
      start: Math.min(from, to),
      end: Math.max(from, to),
      label: formatPkForUi(Math.min(from, to)) === formatPkForUi(Math.max(from, to))
        ? formatPkForUi(from)
        : `${formatPkForUi(Math.min(from, to))} - ${formatPkForUi(Math.max(from, to))}`,
    }]
  })
}

function mainlineSectionDisplayLabel(section: Pick<MainlineFillStatusSection, 'section_code' | 'section_name'>): string {
  const name = String(section.section_name || '').trim()
  if (name && name.toLowerCase() !== 'бд') return name
  const code = String(section.section_code || '').trim()
  if (!code || code.toLowerCase() === 'бд') return 'Участок'
  return sectionLabel(code)
}

function boundaryFromMainlineStatus(section: MainlineFillStatusSection): PkBoundary | null {
  const ranges = (section.ranges || [])
    .filter(range => range.pk_start !== null && range.pk_start !== undefined && range.pk_end !== null && range.pk_end !== undefined)
    .map(range => ({ start: Number(range.pk_start), end: Number(range.pk_end) }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map(range => ({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) }))
  if (ranges.length) {
    return {
      start: Math.min(...ranges.map(range => range.start)),
      end: Math.max(...ranges.map(range => range.end)),
      label: mainlineSectionDisplayLabel(section),
      ranges,
    }
  }
  return boundaryFromValues(section.pk_start, section.pk_end, mainlineSectionDisplayLabel(section))
}

function derivedBoundaryFromSegments(segments: FillMiniSegment[], fallbackLabel: string): PkBoundary | null {
  if (!segments.length) return null
  const start = Math.min(...segments.map(segment => segment.start))
  const end = Math.max(...segments.map(segment => segment.end))
  return { start, end, label: fallbackLabel, ranges: [{ start, end }] }
}

function FillMiniScheme<T extends string>({
  title,
  boundary,
  segments,
  definitions,
}: {
  title: string
  boundary: PkBoundary | null
  segments: FillMiniSegment[]
  definitions: FillStatusDefinition<T>[]
}) {
  const effectiveBoundary = boundary || derivedBoundaryFromSegments(segments, title)
  const ranges = effectiveBoundary?.ranges?.length
    ? effectiveBoundary.ranges
    : effectiveBoundary
      ? [{ start: effectiveBoundary.start, end: effectiveBoundary.end }]
      : []
  const definitionByKey = fillDefinitionMap(definitions)
  return (
    <div className="rounded border border-border bg-white p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-text-primary">{title}</div>
        <div className="font-mono text-[10px] text-text-muted">{effectiveBoundary ? formatBoundaryForUi(effectiveBoundary) : 'границы не заданы'}</div>
      </div>
      {ranges.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-bg-surface px-2 py-3 text-center text-[11px] text-text-muted">Нет распознанных пикетов для схемы</div>
      ) : (
        <div className="space-y-1.5">
          {ranges.map((range, laneIndex) => {
            const span = Math.max(1, range.end - range.start)
            const laneSegments = segments.filter(segment => segment.end >= range.start && segment.start <= range.end)
            return (
              <div key={`${range.start}-${range.end}-${laneIndex}`} className="relative h-8 overflow-hidden rounded border border-border bg-bg-surface">
                <div className="absolute inset-y-0 left-0 right-0" />
                {laneSegments.map((segment, idx) => {
                  const definition = definitionByKey[segment.statusKey]
                  const start = Math.max(segment.start, range.start)
                  const end = Math.min(segment.end, range.end)
                  const left = ((start - range.start) / span) * 100
                  const width = Math.max(1, ((end - start) / span) * 100)
                  return (
                    <div
                      key={`${segment.statusKey}-${segment.start}-${segment.end}-${idx}`}
                      className="absolute top-1 h-6 rounded-sm border"
                      title={`${definition?.label || segment.statusKey}: ${segment.label}${definition?.description ? ` — ${definition.description}` : ''}`}
                      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: definition?.fill || '#e5e7eb', borderColor: definition?.stroke || '#9ca3af' }}
                    />
                  )
                })}
                <div className="pointer-events-none absolute inset-x-1 bottom-0 flex justify-between font-mono text-[9px] text-text-muted">
                  <span>{formatPkForUi(range.start)}</span>
                  <span>{formatPkForUi(range.end)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {definitions.map(definition => (
          <span key={definition.key} className="inline-flex items-center gap-1" title={definition.description}>
            <span className="h-2.5 w-3 rounded-[2px] border" style={{ backgroundColor: definition.fill, borderColor: definition.stroke }} />
            <span className="text-text-secondary">{definition.shortLabel}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function FillShiftSummaryPanel({
  payload,
  roads,
  sectionBoundaries,
  tempRoadStatusData,
  mainlineFillStatusData,
}: {
  payload: ParsedPayload
  roads: TempRoadOption[]
  sectionBoundaries: SectionBoundary[]
  tempRoadStatusData?: TempRoadStatusData
  mainlineFillStatusData?: MainlineFillStatusData
}) {
  const tempRows = normalizeTempRoadFillItems(payload.fill_statuses || [])
  const mainlineRows = payload.mainline_fill_statuses || []
  const visibleTempRows = tempRows.filter(row => row.road_id || row.road_code || row.pk_ranges || row.rail_pk_ranges || row.comment)
  const selectedTempRows = visibleTempRows.filter(row => row.road_id || row.road_code)
  const selectedRoadIds = new Set(selectedTempRows.map(row => row.road_id).filter(Boolean) as string[])
  const selectedRoadCodes = new Set(selectedTempRows.map(row => normalizeRoadCode(row.road_code)).filter(Boolean))
  const visibleMainlineRows = mainlineRows.filter(row => row.pk_ranges || row.status_type || row.comment)
  const selectedSection = payload.header.section_code || ''
  const tempRoadSchemes = (tempRoadStatusData?.roads || [])
    .filter(road => selectedRoadIds.has(road.id) || selectedRoadCodes.has(normalizeRoadCode(road.code)))
    .map(tempRoadStatusToSchemeRoad)
    .filter((road): road is TempRoadSchemeRoad => Boolean(road))
    .map(road => ({ ...road, segments: [...road.segments, ...draftSegmentsForTempRoad(road, selectedTempRows)] }))
  const dbMainlineSections = (mainlineFillStatusData?.sections || [])
    .filter(section => !selectedSection || section.section_code === selectedSection)
    .filter(section => fillMiniSegmentsFromMainlineStatus(section).length > 0)

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <h2 className="mb-3 text-sm font-heading font-semibold text-text-primary">Промежуточные итоги за сутки</h2>
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Отсыпка временных притрассовых автомобильных дорог</div>
          {selectedTempRows.length === 0 ? (
            <p className="text-xs text-text-muted">Выберите дороги в блоке отсыпки ниже — здесь появятся только их схемы.</p>
          ) : tempRoadSchemes.length === 0 ? (
            <p className="text-xs text-text-muted">Для выбранных дорог пока нет схем на выбранную дату.</p>
          ) : (
            <div className="space-y-3">
              <div className="text-[11px] text-text-muted">Показаны только дороги, выбранные в строках ниже. Полупрозрачные сегменты — текущий черновик до импорта.</div>
              {tempRoadSchemes.map(road => (
                <TempRoadSchemeCard
                  key={`temp-road-scheme-${road.id}`}
                  road={road}
                  title={parseTempRoadSchemeTitle(road).title}
                />
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Отсыпка путей основного хода</div>
          {dbMainlineSections.length === 0 && visibleMainlineRows.length === 0 ? (
            <p className="text-xs text-text-muted">Нет внесенных данных по ОХ</p>
          ) : (
            <div className="space-y-2">
              {dbMainlineSections.map(section => (
                <FillMiniScheme
                  key={`db-main-${section.section_id}`}
                  title={`Сохранено · ${mainlineSectionDisplayLabel(section)}`}
                  boundary={boundaryFromMainlineStatus(section)}
                  segments={fillMiniSegmentsFromMainlineStatus(section)}
                  definitions={MAINLINE_FILL_STATUS_DEFINITIONS.filter(def => def.key !== 'no_work')}
                />
              ))}
              {visibleMainlineRows.map((row, index) => {
                const sectionCode = row.section_code || payload.header.section_code
                return (
                  <FillMiniScheme
                    key={`draft-main-${sectionCode || 'main'}-${row.status_type || 'status'}-${index}`}
                    title={`Черновик · ${sectionLabel(sectionCode)} · ${MAINLINE_FILL_STATUS_BY_KEY[(row.status_type || 'prep_works') as MainlineFillStatusKey]?.label || 'статус'}`}
                    boundary={sectionBoundaryFor(sectionBoundaries, sectionCode, 'main')}
                    segments={fillMiniSegmentsFromMainline(row)}
                    definitions={MAINLINE_FILL_STATUS_DEFINITIONS.filter(def => def.key !== 'no_work')}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ── preview ─────────────────────────────────────────────────────────────

function buildReportPayloadBody(payload: ParsedPayload, sourceFilename: string) {
  const isPileControl = Boolean(payload.pile_control)
  const isFillReport = payload.report_mode === 'fill'
  const pileIssues = payload.pile_control?.issues || []
  const header = isFillReport
    ? { ...payload.header, shift: 'unknown', section_code: '', section_name: '' }
    : payload.header
  return {
    report_mode: payload.report_mode,
    header,
    transport: isPileControl ? [] : payload.transport,
    main_works: isPileControl ? [] : payload.main_works,
    aux_works: isPileControl ? [] : payload.aux_works,
    park: [],
    staff_counts: [],
    problems: isPileControl ? pileControlProblemsText(pileIssues) : payload.problems,
    stockpiles: isPileControl ? [] : payload.stockpiles || [],
    piles: payload.piles || [],
    pile_control: payload.pile_control,
    fill_statuses: isPileControl ? [] : payload.fill_statuses || [],
    mainline_fill_statuses: isPileControl ? [] : payload.mainline_fill_statuses || [],
    raw_text: payload.raw_text,
    initial_parse: payload.initial_parse,
    source_type: isPileControl ? 'web_pile_control' : isFillReport ? 'web_fill_report' : sourceFilename.startsWith('manual-') ? 'web_manual' : 'web_upload',
    source_reference: sourceFilename,
    review_flags: isPileControl ? ['isso', 'контроль свай'] : payload.review_flags || [],
  }
}

function PreviewPane({
  parsed,
  sourceFilename,
  onImported,
  existingReportId,
  existingReportStatus,
  onPayloadChange,
  compactPileMode = false,
}: {
  parsed: ParsedPayload
  sourceFilename: string
  onImported: () => void
  existingReportId?: string
  existingReportStatus?: string | null
  onPayloadChange?: (payload: ParsedPayload) => void
  compactPileMode?: boolean
}) {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [payload, setPayloadState] = useState<ParsedPayload>(parsed)
  const payloadSourceKey = existingReportId ? `report:${existingReportId}` : `source:${sourceFilename}`
  const payloadSourceKeyRef = useRef(payloadSourceKey)
  const setPayload = useCallback((nextOrUpdater: ParsedPayload | ((prev: ParsedPayload) => ParsedPayload)) => {
    setPayloadState(prev => {
      const next = typeof nextOrUpdater === 'function'
        ? (nextOrUpdater as (prev: ParsedPayload) => ParsedPayload)(prev)
        : nextOrUpdater
      onPayloadChange?.(next)
      return next
    })
  }, [onPayloadChange])
  useEffect(() => {
    if (payloadSourceKeyRef.current === payloadSourceKey) return
    payloadSourceKeyRef.current = payloadSourceKey
    setPayloadState(parsed)
    onPayloadChange?.(parsed)
  }, [onPayloadChange, parsed, payloadSourceKey])
  const referenceContext = useMemo(() => buildReferenceContext(payload), [payload])
  const extractionNumbers = useMemo(() => buildExtractionNumberMaps(payload), [payload])
  const { data: sections } = useQuery<Section[]>({
    queryKey: ['sections-list'],
    queryFn: () => fetch('/api/sections/list').then(r => r.json()),
  })
  const { data: sectionBoundaries } = useQuery<SectionBoundariesData>({
    queryKey: ['wip', 'settings', 'section-boundaries'],
    queryFn: () => fetch('/api/wip/settings/section-boundaries').then(r => r.json()),
  })
  const { data: referenceMeta } = useQuery<ReferenceMeta>({
    queryKey: ['report-reference-meta'],
    queryFn: () => fetch('/api/wip/reports/reference-meta').then(r => r.json()),
  })
  const { data: tempRoads } = useQuery<TempRoadOption[]>({
    queryKey: ['report-temp-roads'],
    queryFn: () => fetch('/api/wip/reports/temp-roads').then(r => r.json()),
  })
  const isPileControl = Boolean(payload.pile_control)
  const isFillReport = payload.report_mode === 'fill'
  const reportDate = payload.header.report_date
  const fillModeEnabled = isFillReport && !isPileControl && Boolean(reportDate)
  const { data: tempRoadStatusData } = useQuery<TempRoadStatusData>({
    queryKey: ['wip', 'temp-roads', 'status', reportDate],
    queryFn: () => fetch(`/api/wip/temp-roads/status?to=${encodeURIComponent(reportDate)}&include_display_excluded=true`).then(r => r.json()),
    enabled: fillModeEnabled,
  })
  const { data: mainlineFillStatusData } = useQuery<MainlineFillStatusData>({
    queryKey: ['wip', 'mainline-fill', 'status', reportDate],
    queryFn: () => fetch(`/api/wip/mainline-fill/status?to=${encodeURIComponent(reportDate)}`).then(r => r.json()),
    enabled: fillModeEnabled,
  })
  const pkValidationIssues = useMemo(
    () => collectPayloadPkValidationIssues(payload, sectionBoundaries?.rows || [], tempRoads || []),
    [payload, sectionBoundaries?.rows, tempRoads],
  )
  const pkValidationErrors = pkValidationIssues.filter(issue => issue.status === 'error')
  const pkValidationWarnings = pkValidationIssues.filter(issue => issue.status === 'warning')
  const isConfirmedExistingReport = Boolean(existingReportId && (existingReportStatus === 'confirmed' || existingReportStatus === 'approved'))

  const importMutation = useMutation({
    mutationFn: async (action: 'save' | 'confirm' | 'import' = existingReportId ? 'save' : 'import') => {
      const body = buildReportPayloadBody(payload, sourceFilename)
      const res = await fetch(existingReportId ? `/api/wip/reports/${existingReportId}/review-payload` : '/api/wip/reports/import', {
        method: existingReportId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка сохранения' }))
        throw new Error(e.detail || 'Ошибка сохранения')
      }
      const saved = await res.json()
      if (existingReportId && action === 'confirm') {
        if (!isAdmin) throw new Error('Подтверждать отчеты может только администратор')
        const confirmRes = await fetch(`/api/wip/reports/${existingReportId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (!confirmRes.ok) {
          const e = await confirmRes.json().catch(() => ({ detail: 'Ошибка подтверждения' }))
          throw new Error(e.detail || 'Ошибка подтверждения')
        }
        return { ...(await confirmRes.json()), action }
      }
      return { ...saved, action }
    },
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ['reports-list'] })
      qc.invalidateQueries({ queryKey: ['wip'] })
      if (existingReportId) {
        qc.invalidateQueries({ queryKey: ['report-preview', existingReportId] })
      }
      if (result.action !== 'save') {
        onImported()
      }
    },
  })

  function patchHeader<K extends keyof ParsedHeader>(key: K, value: ParsedHeader[K]) {
    setPayload(p => ({ ...p, header: { ...p.header, [key]: value } }))
  }

  function patchItems<K extends 'transport' | 'main_works' | 'aux_works' | 'staff_counts' | 'park' | 'stockpiles' | 'piles' | 'fill_statuses' | 'mainline_fill_statuses'>(
    key: K,
    items: ParsedPayload[K],
  ) {
    setPayload(p => ({ ...p, [key]: items }))
  }
  function patchWorks(items: WorkPreviewItem[]) {
    setPayload(p => ({ ...p, main_works: items, aux_works: [] }))
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto space-y-6">
      {payload._stub && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Данные распознаны частично. Проверьте шапку и заполните недостающие блоки перед импортом.
        </div>
      )}

      {!compactPileMode && <WizardIntro />}

      {pkValidationIssues.length > 0 && (
        <div className={`rounded-md border px-3 py-2 text-xs ${
          pkValidationErrors.length > 0
            ? 'border-red-300 bg-red-50 text-red-700'
            : 'border-amber-300 bg-amber-50 text-amber-800'
        }`}>
          <div className="mb-1 font-semibold">
            Пикетажи требуют проверки: ошибок {pkValidationErrors.length}, предупреждений {pkValidationWarnings.length}
          </div>
          <ul className="space-y-1">
            {pkValidationIssues.slice(0, 8).map((issue, idx) => (
              <li key={`${issue.location}-${idx}`}>
                • <span className="font-medium">{issue.location}</span>: {issue.message}
              </li>
            ))}
          </ul>
          {pkValidationIssues.length > 8 && <div className="mt-1">Еще замечаний: {pkValidationIssues.length - 8}</div>}
          <div className="mt-1">Отчет можно сохранить: администратор увидит эту пометку при проверке.</div>
        </div>
      )}

      {!compactPileMode && (
        <>
      {/* header editor */}
      <section className="bg-white border border-border rounded-lg p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Быстрая проверка</h2>
          <BlockHelpButton help={REPORT_HELP.intro} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-text-muted mb-1">Конструктивы</div>
            <div className="font-mono text-text-secondary whitespace-pre-wrap">{payload.human_summary?.constructives || payload.header.section_name || '—'}</div>
          </div>
          <div>
            <div className="text-text-muted mb-1">Информация по завозу</div>
            <div className="font-mono text-text-secondary whitespace-pre-wrap">{payload.human_summary?.delivery_info || '—'}</div>
          </div>
        </div>
        {(payload.warnings || []).length > 0 && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2">
            <div className="text-xs font-semibold text-amber-800 mb-1">Требует внимания перед импортом</div>
            <ul className="text-xs text-amber-800 font-mono space-y-0.5">
              {(payload.warnings || []).map((w, i) => <li key={i}>• {w}</li>)}
            </ul>
          </div>
        )}
      </section>

      <section className="bg-white border border-border rounded-lg p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Шапка</h2>
          <BlockHelpButton help={REPORT_HELP.header} />
        </div>
        <div className={isFillReport ? 'grid grid-cols-1 gap-3 sm:grid-cols-[220px_minmax(0,1fr)]' : 'grid grid-cols-1 sm:grid-cols-3 gap-3'}>
          <label className="block">
            <span className="text-xs text-text-muted">Дата</span>
            <input
              type="date"
              value={payload.header.report_date}
              onChange={e => patchHeader('report_date', e.target.value)}
              className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono
                         focus:outline-none focus:border-accent-red/50"
            />
          </label>
          {isFillReport ? (
            <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-xs leading-snug text-text-secondary">
              Данные по отсыпке вводятся за сутки. Участок выбирается в строках блоков ВАД и ОХ, поэтому в одном отчете можно заполнить несколько участков.
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-xs text-text-muted">Смена</span>
                <select
                  value={payload.header.shift}
                  onChange={e => patchHeader('shift', e.target.value)}
                  className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm
                             focus:outline-none focus:border-accent-red/50"
                >
                  <option value="day">День</option>
                  <option value="night">Ночь</option>
                  <option value="unknown">—</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-text-muted">Участок</span>
                <select
                  value={payload.header.section_code}
                  onChange={e => patchHeader('section_code', e.target.value)}
                  className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm
                             focus:outline-none focus:border-accent-red/50"
                >
                  <option value="">— не задан —</option>
                  {sections?.map(s => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
      </section>
        </>
      )}

      {isPileControl ? (
        <>
          <PileControlSettingsSection
            payload={payload}
            sections={sections || []}
            showSection={compactPileMode}
            onPayloadChange={setPayload}
          />
          <PileControlIssuesSection
            issues={payload.pile_control?.issues || []}
            onIssuesChange={issues => setPayload(p => ({
              ...p,
              pile_control: { ...(p.pile_control || {}), issues },
              problems: pileControlProblemsText(issues),
            }))}
          />
          <PileDrivingPreviewSection
            sectionCode={payload.header.section_code}
            items={payload.piles || []}
            reportDate={payload.header.report_date}
            pileControlMode={compactPileMode}
            onItemsChange={items => patchItems('piles', items)}
          />
        </>
      ) : (
        <>
          <ShiftSummaryPanel
            payload={payload}
            roads={tempRoads || []}
            sectionBoundaries={sectionBoundaries?.rows || []}
            tempRoadStatusData={tempRoadStatusData}
            mainlineFillStatusData={mainlineFillStatusData}
          />
          <FillStatusPreviewSection
            sectionCode={payload.header.section_code}
            items={payload.fill_statuses || []}
            sections={sections || []}
            roads={tempRoads || []}
            sectionBoundaries={sectionBoundaries?.rows || []}
            onItemsChange={items => patchItems('fill_statuses', items)}
          />
          <MainlineFillStatusPreviewSection
            sectionCode={payload.header.section_code}
            items={payload.mainline_fill_statuses || []}
            sections={sections || []}
            sectionBoundaries={sectionBoundaries?.rows || []}
            onItemsChange={items => patchItems('mainline_fill_statuses', items)}
          />
          {payload.report_mode !== 'fill' && (
            <>
          <TransportPreviewSection
            sectionCode={payload.header.section_code}
            items={payload.transport}
            referenceContext={referenceContext}
            extractionNumbers={extractionNumbers}
            onItemsChange={items => patchItems('transport', items)}
          />
          <WorksPreviewSection
            sectionCode={payload.header.section_code}
            title="Работы"
            items={[...(payload.main_works || []), ...(payload.aux_works || [])]}
            referenceContext={referenceContext}
            workTags={referenceMeta?.work_tags || []}
            sectionBoundaries={sectionBoundaries?.rows || []}
            extractionNumbers={extractionNumbers}
            onItemsChange={patchWorks}
          />
          <StockpilePreviewSection
            items={payload.stockpiles || []}
            onItemsChange={items => patchItems('stockpiles', items)}
          />
          <PileDrivingPreviewSection
            sectionCode={payload.header.section_code}
            items={payload.piles || []}
            reportDate={payload.header.report_date}
            onItemsChange={items => patchItems('piles', items)}
          />

          <section className="bg-white border border-border rounded-lg p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Проблемы</h2>
              <BlockHelpButton help={REPORT_HELP.problems} />
            </div>
            <textarea
              value={payload.problems || ''}
              onChange={e => setPayload(p => ({ ...p, problems: e.target.value }))}
              rows={3}
              className="w-full bg-bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono
                         focus:outline-none focus:border-accent-red/50"
            />
          </section>
            </>
          )}
        </>
      )}

      {/* import */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        {importMutation.isError && (
          <p className="text-red-500 text-sm mr-auto">{importMutation.error?.message}</p>
        )}
        <a
          href="/api/wip/settings/daily-report-review-instruction.docx"
          download="Памятка по проверке сменного отчета при загрузке в дашборд.docx"
          className="inline-flex items-center gap-2 border border-border bg-white hover:bg-bg-surface text-text-secondary
                     px-4 py-2 rounded-md text-sm font-medium transition-colors"
          title="Скачать актуальную памятку по проверке сменного отчета"
        >
          <Download className="w-4 h-4" />
          Памятка
        </a>
        {existingReportId && (
          <button
            onClick={() => importMutation.mutate('save')}
            disabled={importMutation.isPending}
            className="inline-flex items-center gap-2 border border-border bg-white hover:bg-bg-surface text-text-secondary
                       px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {importMutation.isPending ? 'Сохраняю…' : isConfirmedExistingReport ? 'Сохранить и пересобрать' : 'Сохранить правки'}
          </button>
        )}
        {!isConfirmedExistingReport && (
          <button
            onClick={() => importMutation.mutate(existingReportId ? 'confirm' : 'import')}
            disabled={importMutation.isPending || Boolean(existingReportId && !isAdmin)}
            className="inline-flex items-center gap-2 bg-accent-red hover:bg-accent-burg text-white
                       px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
            title={existingReportId && !isAdmin ? 'Подтверждать отчеты может только администратор' : undefined}
          >
            <Check className="w-4 h-4" />
            {importMutation.isPending
              ? 'Сохраняю…'
              : existingReportId ? 'Подтвердить админом' : 'Отправить на проверку'}
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── preview sub-section ─────────────────────────────────────────────────


function PileControlSettingsSection({
  payload,
  sections,
  showSection = false,
  onPayloadChange,
}: {
  payload: ParsedPayload
  sections: Section[]
  showSection?: boolean
  onPayloadChange: (payload: ParsedPayload) => void
}) {
  const meta = payload.pile_control || { reported_at: localDateTimeInputValue(), interval_hours: 3, sender_name: '', issues: [] }

  function updateReportedAt(value: string) {
    onPayloadChange({
      ...payload,
      header: {
        ...payload.header,
        report_date: pileControlOperationalDate(value),
        shift: shiftFromDateTime(value),
      },
      pile_control: { ...meta, reported_at: value },
    })
  }

  function updateSenderName(value: string) {
    onPayloadChange({
      ...payload,
      header: { ...payload.header, author: value },
      pile_control: { ...meta, sender_name: value },
    })
  }

  function updateSection(sectionCode: string) {
    const section = sections.find(item => item.code === sectionCode)
    onPayloadChange({
      ...payload,
      header: {
        ...payload.header,
        section_code: sectionCode,
        section_name: section?.name || '',
      },
    })
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Параметры подачи данных</h2>
      </div>
      <div className={`grid grid-cols-1 gap-3 ${showSection ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        <label className="block">
          <span className="text-xs text-text-muted">Отчетное время</span>
          <input
            type="datetime-local"
            value={String(meta.reported_at || '')}
            onChange={e => updateReportedAt(e.target.value)}
            className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-accent-red/50"
          />
        </label>
        <label className="block">
          <span className="text-xs text-text-muted">Фамилия и ИО отправителя</span>
          <input
            value={String(meta.sender_name || payload.header.author || '')}
            onChange={e => updateSenderName(e.target.value)}
            placeholder="Иванов И.И."
            className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent-red/50"
          />
        </label>
        {showSection && (
          <label className="block">
            <span className="text-xs text-text-muted">Участок</span>
            <select
              value={payload.header.section_code}
              onChange={e => updateSection(e.target.value)}
              className="w-full mt-1 bg-bg-surface border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent-red/50"
            >
              <option value="">— не задан —</option>
              {sections.map(section => <option key={section.code} value={section.code}>{section.name}</option>)}
            </select>
          </label>
        )}
      </div>
    </section>
  )
}

function pileIssueTone(priority: PileIssuePriority | undefined): string {
  if (priority === 'red') return 'border-red-200 bg-red-50 text-red-800'
  if (priority === 'yellow') return 'border-amber-200 bg-amber-50 text-amber-800'
  return 'border-emerald-200 bg-emerald-50 text-emerald-800'
}

function PileControlIssuesSection({
  issues,
  onIssuesChange,
}: {
  issues: PileControlIssue[]
  onIssuesChange: (issues: PileControlIssue[]) => void
}) {
  function updateIssue(index: number, patch: Partial<PileControlIssue>) {
    onIssuesChange(issues.map((issue, i) => i === index ? { ...issue, ...patch } : issue))
  }

  function addIssue() {
    onIssuesChange([...issues, { text: '', priority: 'yellow' }])
  }

  function removeIssue(index: number) {
    onIssuesChange(issues.filter((_, i) => i !== index))
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Проблемные вопросы</h2>
        <button
          type="button"
          onClick={addIssue}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="h-3 w-3" />
          Вопрос
        </button>
      </div>
      {issues.length === 0 ? (
        <p className="text-xs text-text-muted">Нет проблемных вопросов. При появлении вопроса добавьте строку и выберите приоритет.</p>
      ) : (
        <div className="space-y-2">
          {issues.map((issue, index) => (
            <div key={index} className={`rounded-md border p-3 ${pileIssueTone(issue.priority)}`}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[150px_minmax(0,1fr)_32px]">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide opacity-75">Приоритет</span>
                  <select
                    value={issue.priority || 'yellow'}
                    onChange={e => updateIssue(index, { priority: e.target.value as PileIssuePriority })}
                    className="mt-1 w-full rounded border border-current/20 bg-white/80 px-2 py-1.5 text-sm text-text-primary"
                  >
                    <option value="green">Зеленый</option>
                    <option value="yellow">Желтый</option>
                    <option value="red">Красный</option>
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide opacity-75">Описание</span>
                  <input
                    value={issue.text || ''}
                    onChange={e => updateIssue(index, { text: e.target.value })}
                    placeholder="Кратко опишите вопрос"
                    className="mt-1 w-full rounded border border-current/20 bg-white/80 px-2 py-1.5 text-sm text-text-primary"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeIssue(index)}
                  className="self-end inline-flex h-8 w-8 items-center justify-center rounded text-current hover:bg-white/60"
                  aria-label="Удалить вопрос"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PreviewSection<T extends PreviewItem>({
  title,
  items,
  fields,
  help,
  sectionCode,
  sectionBoundaries = [],
  onItemsChange,
}: {
  title: string
  items: T[]
  fields: string[]
  help?: HelpContent
  sectionCode?: string | null
  sectionBoundaries?: SectionBoundary[]
  onItemsChange: (items: T[]) => void
}) {
  function coercePreviewValue(field: string, value: string) {
    if (value.trim() === '') return null
    if (['volume', 'count', 'pk_start', 'pk_end'].includes(field)) {
      const num = Number(value.replace(',', '.'))
      return Number.isFinite(num) ? num : value
    }
    return value
  }

  function updateCell(rowIndex: number, field: string, value: string) {
    onItemsChange(items.map((row, idx) => (
      idx === rowIndex ? { ...row, [field]: coercePreviewValue(field, value) } as T : row
    )))
  }

  function addRow() {
    onItemsChange([...items, Object.fromEntries(fields.map(field => [field, null])) as T])
  }

  function removeRow(rowIndex: number) {
    onItemsChange(items.filter((_, idx) => idx !== rowIndex))
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          {title} <span className="text-text-muted font-normal">({items.length})</span>
        </h2>
        {help && <BlockHelpButton help={help} />}
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="w-3 h-3" />
          Строка
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет записей</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-text-muted">
                {fields.map(f => (
                  <th key={f} className="px-1.5 py-1 font-medium">{f}</th>
                ))}
                <th className="w-8 px-1.5 py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-border/50">
                  {fields.map(f => {
                    const isPkField = f.toLowerCase().includes('pk') || f.toLowerCase().includes('пк')
                    const override = Boolean(it.pk_validation_override)
                    const context: PkValidationContext = {
                      sectionCode,
                      sectionBoundaries,
                      boundaryKind: 'main',
                    }
                    return (
                      <td key={f} className="px-1.5 py-1 min-w-[120px] align-top">
                        <input
                          value={it[f] != null && it[f] !== '' ? String(it[f]) : ''}
                          onChange={e => updateCell(i, f, e.target.value)}
                          placeholder="—"
                          className={isPkField ? pkInputClassName(it[f] as string | number | null | undefined, override, false, context) : inputCls}
                        />
                        {isPkField && (
                          <PkSoftHint
                            value={it[f] as string | number | null | undefined}
                            context={context}
                          />
                        )}
                      </td>
                    )
                  })}
                  <td className="px-1.5 py-1 text-right align-top">
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                      aria-label="Удалить строку"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function isTestPileKind(value?: string | null) {
  const text = (value || '').toLowerCase()
  return text.includes('test') || text.includes('trial') || text.includes('проб')
}

function normalizePileKind(value?: string | null): 'main' | 'test' {
  return isTestPileKind(value) ? 'test' : 'main'
}

type PileOperation = 'driving' | 'headcap'

const PILE_HEADCAP_WORK_TYPE_CODE = 'PILE_HEADCAP_INSTALLATION'
const WORK_BLOCK_EXCLUDED_WORK_TYPE_CODES = ['PILE_MAIN', 'PILE_TRIAL', PILE_HEADCAP_WORK_TYPE_CODE] as const
const WORK_BLOCK_EXCLUDED_WORK_TYPE_CODE_SET = new Set<string>(WORK_BLOCK_EXCLUDED_WORK_TYPE_CODES)

function normalizedWorkTypeCode(value?: string | null) {
  return String(value || '').trim().toUpperCase()
}

function isWorkBlockExcludedWorkTypeCode(value?: string | null) {
  return WORK_BLOCK_EXCLUDED_WORK_TYPE_CODE_SET.has(normalizedWorkTypeCode(value))
}

function filterWorkBlockReferenceSuggestions(suggestions?: ReferenceSuggestion[]) {
  return (suggestions || []).filter(item => !isWorkBlockExcludedWorkTypeCode(item.code))
}

const EMPTY_REFERENCE_EXCLUDE_CODES: readonly string[] = []

function isHeadcapPileOperationText(value?: string | null) {
  const text = (value || '').toLowerCase().replace(/ё/g, 'е')
  return text.includes('наголов') || text.includes('оголов') || text.includes('headcap') || text.includes('head cap')
}

function normalizePileOperation(value?: Partial<PileDrivingItem> | string | null): PileOperation {
  if (typeof value === 'string') {
    return value === PILE_HEADCAP_WORK_TYPE_CODE || isHeadcapPileOperationText(value) ? 'headcap' : 'driving'
  }
  const row = value || {}
  if ((row.work_type_code || '').toUpperCase() === PILE_HEADCAP_WORK_TYPE_CODE) return 'headcap'
  if (isHeadcapPileOperationText(row.pile_operation)) return 'headcap'
  return 'driving'
}

function pileOperationLabel(value?: Partial<PileDrivingItem> | string | null) {
  return normalizePileOperation(value) === 'headcap' ? 'Монтаж наголовников' : 'Забивка свай'
}

function pileOperationPatch(operation: PileOperation): Partial<PileDrivingItem> {
  return operation === 'headcap'
    ? {
      pile_operation: operation,
      work_type_code: PILE_HEADCAP_WORK_TYPE_CODE,
      report_equipment_unit_id: null,
      equipment_unit_id: null,
      equipment_label: '',
      equipment_type: '',
      unit_number: '',
      plate_number: '',
      pile_type: '',
      pile_length_label: '',
    }
    : { pile_operation: operation, work_type_code: null }
}

function isPipePileTarget(value?: Partial<PileFieldOption> | Partial<PileDrivingItem> | null) {
  return (value?.target_type || '').toLowerCase() === 'pipe' || String((value as Partial<PileDrivingItem> | undefined)?.field_id || '').startsWith('pipe:')
}

function pileTargetKindLabel(item: Partial<PileFieldOption> | Partial<PileDrivingItem>) {
  if (isPipePileTarget(item)) return 'ПЖБТ'
  return normalizePileKind(item.field_type) === 'test' ? 'Пробные' : 'Основные'
}

function pileTargetDisplayName(item: Partial<PileFieldOption> | Partial<PileDrivingItem>) {
  if (isPipePileTarget(item)) {
    const objectCode = item.object_code ? ` · ${item.object_code}` : ''
    return `${item.object_name || item.field_code || 'ПЖБТ'}${objectCode}`
  }
  return item.field_code || 'поле н/д'
}

type TempRoadEditableStatusKey = Exclude<TempRoadFillStatusKey, 'no_work'>

const fillStatusFields = TEMP_ROAD_FILL_STATUS_DEFINITIONS.filter(
  (field): field is FillStatusDefinition<TempRoadEditableStatusKey> => field.key !== 'no_work',
)

const mainlineFillStatusFields = MAINLINE_FILL_STATUS_DEFINITIONS.filter(
  (field): field is FillStatusDefinition<Exclude<MainlineFillStatusKey, 'no_work'>> => field.key !== 'no_work',
)

function FillStatusPreviewSection({
  sectionCode,
  items,
  sections,
  roads,
  sectionBoundaries,
  onItemsChange,
}: {
  sectionCode?: string | null
  items: FillStatusItem[]
  sections: Section[]
  roads: TempRoadOption[]
  sectionBoundaries: SectionBoundary[]
  onItemsChange: (items: FillStatusItem[]) => void
}) {
  const editableItems = useMemo(() => normalizeTempRoadFillItems(items), [items])

  function commitRows(next: FillStatusItem[]) {
    onItemsChange(next.map(row => singleStatusTempRoadRow(row)))
  }

  function updateRow(index: number, patch: Partial<FillStatusItem>) {
    commitRows(editableItems.map((row, i) => i === index ? singleStatusTempRoadRow({ ...row, ...patch }) : row))
  }

  function addRow() {
    commitRows([
      ...editableItems,
      singleStatusTempRoadRow({
        road_id: null,
        road_code: '',
        road_name: '',
        section_code: sectionCode || '',
        status_type: 'pioneer_fill',
        pk_ranges: '',
        rail_pk_ranges: '',
        pk_validation_override: false,
        comment: '',
      }),
    ])
  }

  function removeRow(index: number) {
    commitRows(editableItems.filter((_, i) => i !== index))
  }

  function applyRoad(index: number, roadId: string) {
    const road = roads.find(item => item.id === roadId)
    updateRow(index, {
      road_id: road?.id || null,
      road_code: road?.road_code || '',
      road_name: road?.road_name || '',
      section_code: road?.section_code || editableItems[index]?.section_code || sectionCode || '',
    })
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          Отсыпка временных притрассовых автомобильных дорог <span className="text-text-muted font-normal">({editableItems.length})</span>
        </h2>
        <BlockHelpButton help={REPORT_HELP.fill_statuses} />
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="w-3 h-3" />
          Строка
        </button>
      </div>

      {editableItems.length === 0 ? (
        <p className="text-xs text-text-muted">Нет строк отсыпки. Добавьте строку, выберите участок, автодорогу, статус и диапазон пикетажа.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[1360px] w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-text-muted">
                <th className="w-40 px-1.5 py-1 font-medium">Участок</th>
                <th className="w-64 px-1.5 py-1 font-medium">Автодорога</th>
                <th className="w-64 px-1.5 py-1 font-medium">Статус</th>
                <th className="w-72 px-1.5 py-1 font-medium">ПК автодороги</th>
                <th className="w-72 px-1.5 py-1 font-medium">ПК ВСЖМ</th>
                <th className="w-64 px-1.5 py-1 font-medium">Примечание</th>
                <th className="w-8 px-1.5 py-1" />
              </tr>
            </thead>
            <tbody>
              {editableItems.map((row, index) => {
                const currentSection = row.section_code || sectionCode || ''
                const status = tempRoadEditableStatus(row.status_type)
                const adContext: PkValidationContext = {
                  sectionCode: currentSection,
                  sectionBoundaries,
                  boundaryKind: 'temp_roads',
                  roadBoundary: roadBoundaryFor(row, roads),
                }
                const railContext: PkValidationContext = {
                  sectionCode: currentSection,
                  sectionBoundaries,
                  boundaryKind: 'temp_roads',
                  roadBoundary: roadRailBoundaryFor(row, roads),
                }
                return (
                  <tr key={index} className="border-t border-border/50 align-top">
                    <td className="px-1.5 py-1">
                      <select value={currentSection} onChange={e => updateRow(index, { section_code: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {sections.map(section => (
                          <option key={section.code} value={section.code}>{section.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1.5 py-1">
                      <select value={row.road_id || ''} onChange={e => applyRoad(index, e.target.value)} className={inputCls}>
                        <option value="">— выбрать —</option>
                        {roads.map(road => (
                          <option key={road.id} value={road.id}>
                            {road.road_name || road.road_code}
                          </option>
                        ))}
                      </select>
                      {row.road_code && <div className="mt-1 text-[10px] text-text-muted">{row.road_code}</div>}
                    </td>
                    <td className="px-1.5 py-1">
                      <select
                        value={status}
                        onChange={e => updateRow(index, { status_type: e.target.value as TempRoadEditableStatusKey })}
                        className={inputCls}
                        title={TEMP_ROAD_FILL_STATUS_BY_KEY[status]?.description}
                      >
                        {fillStatusFields.map(field => (
                          <option key={field.key} value={field.key}>{field.label}</option>
                        ))}
                      </select>
                      <div className="mt-1 text-[10px] leading-snug text-text-muted">
                        {TEMP_ROAD_FILL_STATUS_BY_KEY[status]?.description}
                      </div>
                    </td>
                    <td className="px-1.5 py-1">
                      <textarea
                        value={row.pk_ranges || ''}
                        onChange={e => updateRow(index, { pk_ranges: e.target.value })}
                        rows={3}
                        placeholder="ПК12+00 - ПК12+50"
                        className={`${pkTextareaClassName(row.pk_ranges, adContext)} h-20 resize-y font-mono leading-snug`}
                      />
                      <FillPkSoftHint value={row.pk_ranges} context={adContext} />
                    </td>
                    <td className="px-1.5 py-1">
                      <textarea
                        value={row.rail_pk_ranges || ''}
                        onChange={e => updateRow(index, { rail_pk_ranges: e.target.value })}
                        rows={3}
                        placeholder="ПК2702+00 - ПК2702+50"
                        className={`${pkTextareaClassName(row.rail_pk_ranges, railContext)} h-20 resize-y font-mono leading-snug`}
                      />
                      <FillPkSoftHint value={row.rail_pk_ranges} context={railContext} />
                    </td>
                    <td className="px-1.5 py-1">
                      <textarea
                        value={row.comment || ''}
                        onChange={e => updateRow(index, { comment: e.target.value })}
                        rows={3}
                        placeholder="при необходимости"
                        className={`${inputCls} h-20 resize-y`}
                      />
                    </td>
                    <td className="px-1.5 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                        aria-label="Удалить строку"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}


function MainlineFillStatusPreviewSection({
  sectionCode,
  items,
  sections,
  sectionBoundaries,
  onItemsChange,
}: {
  sectionCode?: string | null
  items: MainlineFillStatusItem[]
  sections: Section[]
  sectionBoundaries: SectionBoundary[]
  onItemsChange: (items: MainlineFillStatusItem[]) => void
}) {
  function updateRow(index: number, patch: Partial<MainlineFillStatusItem>) {
    onItemsChange(items.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function addRow() {
    onItemsChange([
      ...items,
      {
        section_code: sectionCode || '',
        status_type: 'prep_works',
        pk_ranges: '',
        pk_validation_override: false,
        comment: '',
      },
    ])
  }

  function removeRow(index: number) {
    onItemsChange(items.filter((_, i) => i !== index))
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          Отсыпка путей основного хода <span className="text-text-muted font-normal">({items.length})</span>
        </h2>
        <BlockHelpButton help={REPORT_HELP.mainline_fill_statuses} />
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="w-3 h-3" />
          Строка
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет строк отсыпки ОХ. Добавьте строку, выберите статус и введите ПК в границах участка из шапки.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-text-muted">
                <th className="w-40 px-1.5 py-1 font-medium">Участок</th>
                <th className="w-72 px-1.5 py-1 font-medium">Статус</th>
                <th className="w-72 px-1.5 py-1 font-medium">ПК основного хода</th>
                <th className="w-64 px-1.5 py-1 font-medium">Примечание</th>
                <th className="w-8 px-1.5 py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((row, index) => {
                const currentSection = row.section_code || sectionCode || ''
                const context: PkValidationContext = {
                  sectionCode: currentSection,
                  sectionBoundaries,
                  boundaryKind: 'main',
                }
                return (
                  <tr key={index} className="border-t border-border/50 align-top">
                    <td className="px-1.5 py-1">
                      <select value={currentSection} onChange={e => updateRow(index, { section_code: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {sections.map(section => (
                          <option key={section.code} value={section.code}>{section.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1.5 py-1">
                      <select
                        value={row.status_type || 'prep_works'}
                        onChange={e => updateRow(index, { status_type: e.target.value as MainlineFillStatusKey })}
                        className={inputCls}
                        title={MAINLINE_FILL_STATUS_BY_KEY[(row.status_type || 'prep_works') as MainlineFillStatusKey]?.description}
                      >
                        {mainlineFillStatusFields.map(field => (
                          <option key={field.key} value={field.key}>{field.label}</option>
                        ))}
                      </select>
                      <div className="mt-1 text-[10px] leading-snug text-text-muted">
                        {MAINLINE_FILL_STATUS_BY_KEY[(row.status_type || 'prep_works') as MainlineFillStatusKey]?.description}
                      </div>
                    </td>
                    <td className="px-1.5 py-1">
                      <textarea
                        value={row.pk_ranges || ''}
                        onChange={e => updateRow(index, { pk_ranges: e.target.value })}
                        rows={3}
                        placeholder="ПК2702+00 - ПК2703+50"
                        className={`${pkTextareaClassName(row.pk_ranges, context)} h-20 resize-y font-mono leading-snug`}
                      />
                      <FillPkSoftHint value={row.pk_ranges} context={context} />
                    </td>
                    <td className="px-1.5 py-1">
                      <textarea
                        value={row.comment || ''}
                        onChange={e => updateRow(index, { comment: e.target.value })}
                        rows={3}
                        placeholder="при необходимости"
                        className={`${inputCls} h-20 resize-y`}
                      />
                    </td>
                    <td className="px-1.5 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                        aria-label="Удалить строку"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function StockpilePreviewSection({
  items,
  onItemsChange,
}: {
  items: StockpilePreviewItem[]
  onItemsChange: (items: StockpilePreviewItem[]) => void
}) {
  const { data, isLoading, isError } = useQuery<{ rows: StockpileOption[] }>({
    queryKey: ['report-stockpiles', 'all'],
    queryFn: () => fetch('/api/wip/reports/stockpiles').then(r => r.json()),
  })
  const stockpiles = data?.rows || []

  function updateRow(index: number, patch: Partial<StockpilePreviewItem>) {
    onItemsChange(items.map((row, i) => i === index ? { ...row, ...patch } : row))
  }
  function addRow() {
    onItemsChange([...items, { existing_stockpile_id: null, name: '', material: '', material_code: '', pk_raw_text: '', volume: '', unit: 'м3', action: 'snapshot' }])
  }
  function removeRow(index: number) {
    onItemsChange(items.filter((_, i) => i !== index))
  }
  function applyStockpile(index: number, id: string) {
    const stockpile = stockpiles.find(item => item.id === id)
    if (!stockpile) {
      updateRow(index, { existing_stockpile_id: null, existing_object_id: null, name: '', pk_raw_text: '', material: '', material_code: '' })
      return
    }
    updateRow(index, {
      existing_stockpile_id: stockpile.stockpile_id || null,
      existing_object_id: stockpile.object_id || null,
      name: stockpile.name || stockpile.object_name || '',
      existing_object_name: stockpile.object_name || stockpile.name || '',
      material: stockpile.material || '',
      material_code: stockpile.material_code || '',
      pk_raw_text: stockpile.pk_label || stockpile.pk_raw_text || '',
      pk_start: stockpile.pk_start ?? null,
      pk_end: stockpile.pk_end ?? null,
      unit: items[index]?.unit || 'м3',
      action: 'snapshot',
    })
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">Накопители <span className="text-text-muted font-normal">({items.length})</span></h2>
        <BlockHelpButton help={REPORT_HELP.stockpiles} />
        <button type="button" onClick={addRow} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface">
          <Plus className="w-3 h-3" /> Добавить накопитель
        </button>
      </div>
      {isError && <p className="mb-2 text-xs text-red-600">Не удалось загрузить справочник накопителей</p>}
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет записей. Если среза накопителей в смене не было, блок оставляем пустым.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-text-muted">
                <th className="px-1.5 py-1 font-medium">Накопитель из БД</th>
                <th className="px-1.5 py-1 font-medium">Материал</th>
                <th className="px-1.5 py-1 font-medium">ПК</th>
                <th className="px-1.5 py-1 font-medium">Объем на дату</th>
                <th className="px-1.5 py-1 font-medium">Ед.</th>
                <th className="w-8 px-1.5 py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((row, i) => (
                <tr key={i} className="border-t border-border/50 align-top">
                  <td className="px-1.5 py-1 min-w-[280px]">
                    <select value={row.existing_stockpile_id || row.existing_object_id || ''} onChange={event => applyStockpile(i, event.target.value)} className={inputCls}>
                      <option value="">{isLoading ? 'Загрузка...' : '— выбрать накопитель —'}</option>
                      {stockpiles.map(stockpile => (
                        <option key={stockpile.id} value={stockpile.id}>{stockpile.name || stockpile.object_name} · {stockpile.pk_label || 'ПК н/д'} · {stockpile.material || stockpile.material_code || 'материал н/д'}</option>
                      ))}
                    </select>
                    <div className="mt-1 text-[11px] text-text-muted">{row.name || 'Выберите созданный накопитель из БД'}</div>
                  </td>
                  <td className="px-1.5 py-1 min-w-[150px] text-text-secondary">{row.material || row.material_code || '—'}</td>
                  <td className="px-1.5 py-1 min-w-[140px] font-mono text-text-secondary">{row.pk_raw_text || '—'}</td>
                  <td className="px-1.5 py-1 min-w-[110px]"><input value={row.volume ?? ''} onChange={event => updateRow(i, { volume: event.target.value })} className={inputCls} /></td>
                  <td className="px-1.5 py-1 min-w-[80px]"><input value={row.unit || 'м3'} onChange={event => updateRow(i, { unit: event.target.value })} className={inputCls} /></td>
                  <td className="px-1.5 py-1 text-right"><button type="button" onClick={() => removeRow(i)} className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-red-50 text-text-muted hover:text-red-600" aria-label="Удалить строку"><X className="w-3.5 h-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PileDrivingPreviewSection({
  sectionCode,
  items,
  pileControlMode = false,
  onItemsChange,
}: {
  sectionCode?: string | null
  items: PileDrivingItem[]
  reportDate?: string
  pileControlMode?: boolean
  onItemsChange: (items: PileDrivingItem[]) => void
}) {
  const sectionParam = sectionCode || 'all'
  const { data, isLoading, isError } = useQuery<{ rows: PileFieldOption[] }>({
    queryKey: ['report-pile-fields', sectionParam],
    queryFn: () => fetch(`/api/wip/reports/pile-fields?section=${encodeURIComponent(sectionParam)}`).then(r => r.json()),
  })
  const fields = data?.rows || []
  const { data: equipmentData, isLoading: isEquipmentLoading } = useQuery<{ rows: PileEquipmentOption[] }>({
    queryKey: ['report-pile-equipment', 'deduped'],
    queryFn: () => fetch('/api/wip/reports/pile-equipment').then(r => r.json()),
  })
  const equipmentOptions = equipmentData?.rows || []

  function updateRow(index: number, patch: Partial<PileDrivingItem>) {
    onItemsChange(items.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function addRow() {
    onItemsChange([...items, {
      field_id: null,
      field_code: '',
      pile_kind: 'main',
      pile_operation: 'driving',
      work_type_code: null,
      count: '',
      report_equipment_unit_id: null,
      comment: '',
    }])
  }

  function removeRow(index: number) {
    onItemsChange(items.filter((_, i) => i !== index))
  }

  function selectedField(row: PileDrivingItem) {
    if (row.field_id) {
      const exact = fields.find(field => field.id === row.field_id)
      if (exact) return exact
    }
    const sameCode = fields.filter(field => field.field_code === row.field_code)
    if (!sameCode.length) return undefined
    const desiredKind = normalizePileKind(row.pile_kind || row.field_type)
    const byPk = sameCode.find(field => {
      const rowPk = row.pk_start === null || row.pk_start === undefined || row.pk_start === '' ? null : Number(row.pk_start)
      return rowPk !== null && Number.isFinite(rowPk) && field.pk_start !== null && field.pk_start !== undefined && Number(field.pk_start) === rowPk
    })
    if (byPk) return byPk
    return sameCode.find(field => normalizePileKind(field.field_type) === desiredKind) || sameCode[0]
  }

  function applyOperation(index: number, operation: PileOperation) {
    const current = items[index]
    const field = selectedField(current)
    const patch = pileOperationPatch(operation)
    if (operation === 'driving' && isPipePileTarget(field)) {
      patch.work_type_code = field?.work_type_code || current.work_type_code || null
    }
    if (operation === 'headcap' && isPipePileTarget(field)) {
      Object.assign(patch, {
        field_id: null,
        field_code: '',
        field_type: '',
        target_type: '',
        object_id: null,
        object_code: null,
        object_name: null,
        pipe_pile_spec_id: null,
        pk_start: null,
        pk_end: null,
        pk_text: '',
      })
    }
    updateRow(index, patch)
  }

  function applyEquipment(index: number, equipmentId: string) {
    const equipment = equipmentOptions.find(item => item.report_equipment_unit_id === equipmentId)
    if (!equipment) {
      updateRow(index, {
        report_equipment_unit_id: null,
        equipment_unit_id: null,
        equipment_label: '',
        equipment_type: '',
        unit_number: '',
        plate_number: '',
        ownership_type: '',
        contractor_name: '',
      })
      return
    }
    updateRow(index, {
      report_equipment_unit_id: equipment.report_equipment_unit_id,
      equipment_unit_id: equipment.equipment_unit_id || null,
      equipment_label: equipment.label,
      equipment_type: equipment.equipment_type || '',
      unit_number: equipment.unit_number || '',
      plate_number: equipment.plate_number || '',
      ownership_type: equipment.ownership_type || '',
      contractor_name: equipment.contractor || '',
    })
  }

  function applyField(index: number, fieldId: string) {
    const field = fields.find(item => item.id === fieldId)
    if (!field) {
      updateRow(index, {
        field_id: null,
        field_code: '',
        field_type: '',
        pk_start: null,
        pk_end: null,
        pk_text: '',
        pile_type: '',
        pile_length_label: '',
      })
      return
    }
    const current = items[index]
    const isHeadcap = normalizePileOperation(current) === 'headcap'
    const isPipe = isPipePileTarget(field)
    updateRow(index, {
      field_id: field.id,
      field_code: field.field_code,
      field_type: field.field_type || '',
      target_type: field.target_type || 'pile_field',
      object_id: field.object_id || null,
      object_code: field.object_code || null,
      object_name: field.object_name || null,
      pipe_pile_spec_id: field.pipe_pile_spec_id || null,
      work_type_code: isPipe ? field.work_type_code || null : (isHeadcap ? PILE_HEADCAP_WORK_TYPE_CODE : null),
      pile_operation: isPipe ? 'driving' : (isHeadcap ? 'headcap' : current.pile_operation || 'driving'),
      pk_start: field.pk_start ?? null,
      pk_end: field.pk_end ?? null,
      pk_text: field.pk_label || field.pk_raw_text || '',
      pile_kind: normalizePileKind(field.field_type) || normalizePileKind(current.pile_kind),
      pile_type: isHeadcap && !isPipe ? '' : field.pile_type || '',
      pile_length_label: isHeadcap && !isPipe ? '' : field.pile_length_label || '',
    })
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          Свайные работы <span className="text-text-muted font-normal">({items.length})</span>
        </h2>
        <BlockHelpButton help={REPORT_HELP.piles} />
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="w-3 h-3" />
          Строка
        </button>
      </div>
      {isError && (
        <p className="mb-2 text-xs text-red-600">Не удалось загрузить справочник свайных полей</p>
      )}
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет записей. Если свайных работ в смене не было, блок оставляем пустым.</p>
      ) : (
        <div className="space-y-3">
          {items.map((row, i) => {
            const field = selectedField(row)
            const operation = normalizePileOperation(row)
            return (
              <div key={i} className="rounded-md border border-border bg-bg-surface/40 p-3">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="text-[10px] uppercase tracking-wide text-text-muted">Строка {i + 1}</div>
                  <div className="inline-flex overflow-hidden rounded-md border border-border bg-white p-0.5" aria-label="Операция свайной работы">
                    {(['driving', 'headcap'] as const).map(option => (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={operation === option}
                        onClick={() => applyOperation(i, option)}
                        className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${operation === option ? 'bg-accent-red text-white shadow-sm' : 'text-text-secondary hover:bg-bg-surface'}`}
                      >
                        {option === 'headcap' ? 'Монтаж наголовников' : 'Забивка свай'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                    aria-label="Удалить строку"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(8rem,0.5fr)_minmax(7rem,0.4fr)_minmax(0,0.85fr)] 2xl:items-start">
                  <label className="block min-w-0">
                    <span className="text-[10px] uppercase tracking-wide text-text-muted">Свайное поле / пикет</span>
                    <select
                      value={field?.id || ''}
                      onChange={e => applyField(i, e.target.value)}
                      className={inputCls}
                    >
                      <option value="">{isLoading ? 'Загрузка...' : '— выбрать поле —'}</option>
                      {!field && row.field_code && (
                        <option value="" disabled>{row.field_code} · не найдено в справочнике</option>
                      )}
                      {fields.filter(item => operation !== 'headcap' || !isPipePileTarget(item)).map(item => (
                        <option key={item.id} value={item.id}>
                          {pileTargetKindLabel(item)} · {pileTargetDisplayName(item)} · {item.pk_label || item.pk_raw_text || 'ПК н/д'} · {item.pile_length_label || item.pile_type || 'длина н/д'}
                        </option>
                      ))}
                    </select>
                    {field && (
                      <div className="mt-1 text-[10px] text-text-muted">
                        {isPipePileTarget(field) ? 'ПЖБТ' : 'План'}: {field.pile_count ?? '—'} шт · остаток: {field.remaining_count ?? '—'} шт · {field.section_code || 'участок н/д'}
                      </div>
                    )}
                  </label>
                  {operation === 'driving' && (
                    <label className="block min-w-0">
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">Сваебойка / СБУ</span>
                      <select
                        value={row.report_equipment_unit_id || ''}
                        onChange={e => applyEquipment(i, e.target.value)}
                        className={inputCls}
                      >
                        <option value="">{isEquipmentLoading ? 'Загрузка...' : '— не выбрана —'}</option>
                        {row.report_equipment_unit_id && !equipmentOptions.some(item => item.report_equipment_unit_id === row.report_equipment_unit_id) && (
                          <option value={row.report_equipment_unit_id}>{row.equipment_label || 'выбранная техника вне текущего списка'}</option>
                        )}
                        {equipmentOptions.map(item => (
                          <option key={item.report_equipment_unit_id} value={item.report_equipment_unit_id}>{item.label}</option>
                        ))}
                      </select>
                      {!isEquipmentLoading && equipmentOptions.length === 0 && (
                        <div className="mt-1 text-[10px] text-text-muted">В М-отчетах сваебойная техника не найдена.</div>
                      )}
                    </label>
                  )}
                  {operation === 'driving' && (
                    <div className="block min-w-0">
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">Тип свай</span>
                      <div className="flex h-9 items-center rounded-md border border-border bg-white px-2 text-sm text-text-primary">
                        {normalizePileKind(row.pile_kind || field?.field_type) === 'test' ? 'Пробные' : 'Основные'}
                      </div>
                      {!pileControlMode && <div className="mt-1 text-[10px] text-text-muted">Определяется выбранной строкой справочника</div>}
                    </div>
                  )}
                  <label className="block min-w-0">
                    <span className="whitespace-nowrap text-[10px] uppercase tracking-wide text-text-muted">Количество, шт</span>
                    <input
                      value={row.count ?? ''}
                      onChange={e => updateRow(i, { count: e.target.value })}
                      placeholder="0"
                      className={inputCls}
                    />
                  </label>
                  {operation === 'driving' && (
                    <label className="block min-w-0">
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">Тип/длина свай</span>
                      <input
                        value={row.pile_length_label || row.pile_type || ''}
                        onChange={e => updateRow(i, { pile_type: e.target.value, pile_length_label: e.target.value })}
                        placeholder="из справочника"
                        className={inputCls}
                      />
                    </label>
                  )}
                  </div>
                  <label className="mt-3 block min-w-0">
                    <span className="text-[10px] uppercase tracking-wide text-text-muted">Примечание</span>
                    <textarea
                      value={row.comment || ''}
                      onChange={e => updateRow(i, { comment: e.target.value })}
                      placeholder="примечание по свайной работе"
                      rows={2}
                      className={`${inputCls} min-h-[4.5rem] resize-y py-2`}
                    />
                  </label>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ReferenceSelect({
  value,
  suggestions,
  contextSuggestions,
  kind,
  sectionCode,
  sourceText,
  defaultProductivityEnabled = true,
  excludeCodes = EMPTY_REFERENCE_EXCLUDE_CODES,
  placeholder,
  onChange,
}: {
  value?: string | null
  suggestions?: ReferenceSuggestion[]
  contextSuggestions?: ReferenceSuggestion[]
  kind: AliasKind
  sectionCode?: string | null
  sourceText?: string | null
  defaultProductivityEnabled?: boolean
  excludeCodes?: readonly string[]
  placeholder: string
  onChange: (code: string, suggestion?: ReferenceSuggestion) => void
}) {
  const [searchText, setSearchText] = useState('')
  const [remoteResult, setRemoteResult] = useState<{ query: string; items: ReferenceSuggestion[] }>({ query: '', items: [] })
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'create' | 'alias' | null>(null)
  const searchQuery = searchText.trim() || (!value ? (sourceText || '').trim() : '')
  const excludedCodeSet = useMemo(
    () => new Set(excludeCodes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean)),
    [excludeCodes],
  )
  const isExcludedCode = useCallback(
    (code?: string | null) => excludedCodeSet.has(String(code || '').trim().toUpperCase()),
    [excludedCodeSet],
  )
  const remoteOptions = useMemo(
    () => (open && searchQuery.length >= 2 && remoteResult.query === searchQuery
      ? remoteResult.items.filter(item => !isExcludedCode(item.code))
      : []),
    [isExcludedCode, open, remoteResult.items, remoteResult.query, searchQuery],
  )
  const baseOptions = useMemo(
    () => mergeReferenceSuggestions(
      suggestions,
      contextSuggestions?.map(item => ({ ...item, source: item.source || 'current_report' })),
    ).filter(item => !isExcludedCode(item.code)),
    [contextSuggestions, isExcludedCode, suggestions],
  )

  const options = useMemo(() => {
    const byCode = new Map<string, ReferenceSuggestion>()
    for (const item of baseOptions) {
      if (item.code) byCode.set(item.code, item)
    }
    for (const item of remoteOptions) {
      if (item.code) byCode.set(item.code, item)
    }
    if (value && !isExcludedCode(value) && !byCode.has(value)) {
      byCode.set(value, { code: value, label: value, source: 'selected' })
    }
    return Array.from(byCode.values())
  }, [baseOptions, isExcludedCode, remoteOptions, value])

  const selected = value ? options.find(s => s.code === value) : undefined
  const selectedLabel = selected ? selected.label || selected.code : ''
  const inputValue = open ? searchText : selectedLabel

  useEffect(() => {
    const q = searchQuery
    if (!open || q.length < 2) return
    const ctrl = new AbortController()
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        kind,
        q,
        limit: '12',
      })
      if (sectionCode) params.set('section', sectionCode)
      try {
        const res = await fetch(`/api/wip/reports/reference-search?${params.toString()}`, { signal: ctrl.signal })
        if (!res.ok) return
        const data = await res.json()
        setRemoteResult({ query: q, items: Array.isArray(data) ? data.filter(item => !isExcludedCode(item?.code)) : [] })
      } catch {
        if (!ctrl.signal.aborted) setRemoteResult({ query: q, items: [] })
      }
    }, 180)
    return () => {
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [isExcludedCode, kind, open, searchQuery, sectionCode])

  function choose(s: ReferenceSuggestion) {
    if (isExcludedCode(s.code)) return
    onChange(s.code, s)
    setSearchText(s.label || s.code)
    setOpen(false)
  }

  return (
    <div className="relative">
      <input
        value={inputValue}
        placeholder={placeholder}
        title={selected?.label || inputValue || placeholder}
        onFocus={() => {
          setSearchText(selectedLabel)
          setOpen(true)
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={e => {
          const next = e.target.value
          setSearchText(next)
          setOpen(true)
          if (!next.trim()) onChange('', undefined)
        }}
        className={inputCls}
      />
      {open && options.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-white shadow-lg">
          {options.map(s => (
            <button
              key={s.code}
              type="button"
              onMouseDown={e => {
                e.preventDefault()
                choose(s)
              }}
              className={`block w-full px-2 py-1.5 text-left text-xs hover:bg-bg-surface ${
                s.code === value ? 'bg-bg-surface text-text-primary' : 'text-text-secondary'
              }`}
            >
              <span className="block whitespace-normal break-words font-medium leading-snug">{s.label}</span>
              <span className="block whitespace-normal break-words text-[10px] text-text-muted">
                {s.code}{s.score != null ? ` · ${Math.round(s.score * 100)}%` : ''}{s.table ? ` · ${s.table}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setDialog('create')}
          className="inline-flex items-center gap-1 rounded border border-border bg-white px-1.5 py-0.5 text-[10px] font-medium text-text-muted hover:border-accent-red/40 hover:text-accent-red"
        >
          <Plus className="w-2.5 h-2.5" />
          Добавить в БД
        </button>
        {value && (sourceText || searchText) && (
          <button
            type="button"
            onClick={() => setDialog('alias')}
            className="inline-flex items-center gap-1 rounded border border-border bg-white px-1.5 py-0.5 text-[10px] font-medium text-text-muted hover:border-accent-red/40 hover:text-accent-red"
          >
            <Plus className="w-2.5 h-2.5" />
            Алиас
          </button>
        )}
      </div>
      {dialog === 'create' && (
        <ReferenceCreateModal
          kind={kind}
          sourceText={sourceText || searchText}
          sectionCode={sectionCode}
          defaultProductivityEnabled={defaultProductivityEnabled}
          onClose={() => setDialog(null)}
          onSaved={suggestion => {
            choose(suggestion)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'alias' && value && (
        <ReferenceAliasModal
          kind={kind}
          aliasText={sourceText || searchText}
          canonicalCode={value}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function CandidateHint({ suggestions }: { suggestions?: ReferenceSuggestion[] }) {
  const items = (suggestions ?? []).slice(0, 3)
  if (!items.length) return null
  return (
    <div className="mt-1 space-y-1">
      {items.map(s => (
        <div
          key={s.code}
          className="rounded border border-border bg-white px-2 py-1 text-[11px] text-text-muted"
          title={s.table || undefined}
        >
          <div className="whitespace-normal break-words leading-snug text-text-secondary">{s.label}</div>
          <div className="mt-0.5 whitespace-normal break-words text-[10px]">{s.code}{s.score != null ? ` · ${Math.round(s.score * 100)}%` : ''}</div>
        </div>
      ))}
    </div>
  )
}

class EquipmentSuggestionErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Equipment suggestion render error', error, info)
    fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        message: `Equipment suggestion render error: ${error.message}`,
        stack: error.stack || '',
        component_stack: info.componentStack || '',
        path: window.location.pathname + window.location.search,
        user_agent: window.navigator.userAgent,
      }),
    }).catch(() => undefined)
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          Подсказки техники не отрисовались. Номер можно оставить вручную.
        </div>
      )
    }
    return this.props.children
  }
}

function EquipmentSuggestionSelect<T extends PreviewItem>({
  row,
  onApply,
}: {
  row: T
  onApply: (suggestion: EquipmentSuggestion) => void
}) {
  const number = equipmentNumber(row)
  const owner = String(row.owner || row.contractor_name || '').trim()
  const externalOwner = isExternalOwnerText(owner) || row.ownership_type === 'hired'
  const equipmentType = String(row.equipment_type || '').trim()
  const vehicle = String(row.vehicle || '').trim()
  const { data: remoteSuggestions, isFetching } = useQuery<EquipmentSuggestion[]>({
    queryKey: ['equipment-search', number, owner, row.ownership_type || '', equipmentType, vehicle],
    enabled: number.length >= 2 && !externalOwner,
    queryFn: async () => {
      const params = new URLSearchParams({ q: number, limit: '12' })
      if (owner) params.set('owner', owner)
      if (row.ownership_type) params.set('ownership_type', String(row.ownership_type))
      if (equipmentType) params.set('equipment_type', equipmentType)
      if (vehicle) params.set('vehicle', vehicle)
      const res = await fetch(`/api/wip/reports/equipment-search?${params.toString()}`)
      if (!res.ok) return []
      const data: unknown = await res.json().catch(() => [])
      if (Array.isArray(data)) return equipmentSuggestionList(data)
      if (data && typeof data === 'object') {
        const rows = (data as { rows?: unknown }).rows
        if (Array.isArray(rows)) return equipmentSuggestionList(rows)
      }
      return []
    },
  })
  if (externalOwner) {
    return (
      <div className="mt-1 rounded border border-border bg-bg-surface px-2 py-1 text-[11px] text-text-muted">
        Сторонняя техника: справочник ЖДС не подставляется
      </div>
    )
  }
  const suggestions = mergeEquipmentSuggestions(
    row.equipment_suggestions as EquipmentSuggestion[] | undefined,
    remoteSuggestions,
  ).filter(s => equipmentSuggestionId(s))
  if (!suggestions.length) {
    if (isFetching) {
      return (
        <div className="mt-1 rounded border border-border bg-white px-2 py-1 text-[11px] text-text-muted">
          Ищу технику по номеру {number}…
        </div>
      )
    }
    if (row.equipment_match_status === 'unmatched') {
      return (
        <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          Техника по номеру не найдена в справочнике.
        </div>
      )
    }
    return null
  }
  const selectedId = String(row.equipment_unit_id || '')
  const isAmbiguous = suggestions.length > 1
  const selected = suggestions.find(s => equipmentSuggestionId(s) === selectedId)

  return (
    <div className={`mt-2 rounded border px-2 py-1.5 text-[11px] ${
      isAmbiguous ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
    }`}>
      <div className="mb-1 font-medium">
        {isAmbiguous ? `Найдено несколько единиц по номеру ${number}` : 'Техника найдена в справочнике'}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
        {suggestions.map(s => {
          const id = equipmentSuggestionId(s)
          const active = id === selectedId
          const label = s.label || [
            s.equipment_type,
            s.brand_model,
            s.unit_number ? `б/н ${s.unit_number}` : null,
            s.plate_number ? `г/н ${s.plate_number}` : null,
          ].filter(Boolean).join(' · ')
          return (
            <button
              key={id}
              type="button"
              onClick={() => onApply(s)}
              className={`rounded border px-2 py-1.5 text-left transition-colors ${
                active
                  ? 'border-emerald-400 bg-emerald-100 text-emerald-900'
                  : 'border-border bg-white text-text-secondary hover:border-accent-red/40 hover:text-text-primary'
              }`}
            >
              <span className="block text-xs font-medium leading-snug">{label}</span>
              <span className="block mt-0.5 text-[10px] text-text-muted">
                {equipmentStatusLabel(s.status)}
                {s.source ? ` · ${s.source}` : ''}
                {equipmentMatchedIdentifiers(s).length ? ` · ${equipmentMatchedIdentifiers(s).join(', ')}` : ''}
              </span>
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="mt-1 text-[10px] leading-snug text-text-muted">
          {equipmentStatusLabel(selected.status)}
          {selected.location ? ` · ${selected.location}` : ''}
          {selected.source ? ` · источник: ${selected.source}` : ''}
        </div>
      )}
    </div>
  )
}

function extractPkText(value?: string | null) {
  const text = value || ''
  const withPk = text.match(/ПК\s*\d{3,5}(?:\s*\+\s*\d+(?:[,.]\d+)?)?/i)
  if (withPk) return withPk[0].replace(/\s+/g, ' ').trim()
  const bare = text.match(/\b\d{4}(?:\s*\+\s*\d+(?:[,.]\d+)?)?\b/)
  return bare ? `ПК ${bare[0].replace(/\s+/g, '')}` : ''
}

function pkCodePart(pkText: string) {
  return pkText.match(/(\d{3,5})/)?.[1] || ''
}

function inferObjectDefaults(sourceText?: string | null) {
  const text = (sourceText || '').toLowerCase()
  if (text.includes('накоп')) return { objectTypeCode: 'STOCKPILE' }
  if (text.includes('карьер')) return { objectTypeCode: 'BORROW_PIT' }
  if (text.includes('отвал')) return { objectTypeCode: 'TEMP_DUMP' }
  if ((text.includes('старт') || text.includes('погруж') || text.includes('сва')) && text.includes('площад')) {
    return { objectTypeCode: 'PILE_DRIVING_PAD' }
  }
  if (text.includes('иссо') || (text.includes('площад') && text.includes('проезд'))) {
    return { objectTypeCode: 'ISSO_ACCESS' }
  }
  if (text.includes('технолог')) return { objectTypeCode: 'TECH_ROAD' }
  if (text.includes('дорог') || text.includes('ад') || text.includes('впд')) return { objectTypeCode: 'TEMP_ROAD' }
  return { objectTypeCode: 'OTHER' }
}

function suggestedReferenceName(kind: AliasKind, sourceText?: string | null) {
  const text = (sourceText || '').trim()
  const pk = extractPkText(text)
  if (kind === 'object' && pk && /площад|иссо|проезд/i.test(text)) {
    return `Устройство площадки и проезда к ИССО ${pk.replace(/ПК\s*/i, 'ПК ')}`
  }
  return text
}

function suggestedReferenceCode(kind: AliasKind, sourceText?: string | null, objectTypeCode?: string) {
  const pk = pkCodePart(extractPkText(sourceText))
  if (kind === 'object' && pk) return `${objectTypeCode || 'OBJ'}_${pk}`
  return ''
}

function suggestedObjectTypeDraft(sourceText?: string | null) {
  const text = (sourceText || '').toLowerCase()
  if ((text.includes('старт') || text.includes('погруж') || text.includes('сва')) && text.includes('площад')) {
    return {
      code: 'PILE_DRIVING_PAD',
      name: 'Стартовая площадка погружения свай',
    }
  }
  return { code: '', name: '' }
}

function ReferenceCreateModal({
  kind,
  sourceText,
  sectionCode,
  defaultProductivityEnabled = true,
  onClose,
  onSaved,
}: {
  kind: AliasKind
  sourceText?: string | null
  sectionCode?: string | null
  defaultProductivityEnabled?: boolean
  onClose: () => void
  onSaved: (suggestion: ReferenceSuggestion) => void
}) {
  const qc = useQueryClient()
  const objectDefaults = useMemo(() => inferObjectDefaults(sourceText), [sourceText])
  const initialName = suggestedReferenceName(kind, sourceText)
  const initialPk = extractPkText(sourceText)
  const [name, setName] = useState(initialName)
  const [code, setCode] = useState(suggestedReferenceCode(kind, sourceText, objectDefaults.objectTypeCode))
  const [aliasText, setAliasText] = useState((sourceText || '').trim())
  const [defaultUnit, setDefaultUnit] = useState(kind === 'work_type' || kind === 'material' ? 'м3' : '')
  const [analyticsTag, setAnalyticsTag] = useState('')
  const [productivityEnabled, setProductivityEnabled] = useState(defaultProductivityEnabled)
  const [objectTypeCode, setObjectTypeCode] = useState(objectDefaults.objectTypeCode)
  const [objectTypeDialogOpen, setObjectTypeDialogOpen] = useState(false)
  const [pkStart, setPkStart] = useState(initialPk)
  const [pkEnd, setPkEnd] = useState(initialPk)
  const [comment, setComment] = useState(sectionCode ? `created from report preview, ${sectionCode}` : 'created from report preview')
  const [allowCreateNewReference, setAllowCreateNewReference] = useState(false)

  const { data: meta } = useQuery<ReferenceMeta>({
    queryKey: ['report-reference-meta'],
    queryFn: () => fetch('/api/wip/reports/reference-meta').then(r => r.json()),
  })

  const duplicateSearch = useMemo(() => {
    const values = [name, aliasText, code].map(value => value.trim()).filter(Boolean)
    return values.find(value => value.length >= 2) || ''
  }, [name, aliasText, code])

  useEffect(() => {
    if (kind === 'object') setAllowCreateNewReference(false)
  }, [kind, duplicateSearch])

  const duplicateCandidatesQuery = useQuery<ReferenceDedupCandidatesResponse>({
    queryKey: ['reference-dedup-candidates', kind, duplicateSearch],
    enabled: duplicateSearch.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/wip/settings/dedup/references?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(duplicateSearch)}&limit=8`)
      if (!res.ok) return { rows: [] }
      return (await res.json()) as ReferenceDedupCandidatesResponse
    },
  })
  function candidateLooksDeleted(candidate: ReferenceDedupCandidate): boolean {
    const label = String(candidate.label || '')
    const lowered = label.toLowerCase()
    return lowered.includes('дубл') || lowered.includes('удал')
  }

  const duplicateCandidates = (duplicateCandidatesQuery.data?.rows || [])
    .filter(candidate => String(candidate.code || '').trim())
    .filter(candidate => kind !== 'object' || candidate.is_active !== false)
    .filter(candidate => kind !== 'object' || !candidateLooksDeleted(candidate))
    .slice(0, 6)
  const duplicateLookupPending = kind === 'object' && duplicateSearch.length >= 2 && duplicateCandidatesQuery.isFetching
  const createBlockedByCandidates = kind === 'object' && duplicateCandidates.length > 0 && !allowCreateNewReference

  function candidateLabel(candidate: ReferenceDedupCandidate): string {
    const candidateCode = String(candidate.code || '').trim()
    const candidateName = String(candidate.label || '').trim()
    if (candidateCode && candidateName && candidateCode !== candidateName) return `${candidateName} · ${candidateCode}`
    return candidateName || candidateCode || candidate.id
  }

  function candidateToSuggestion(candidate: ReferenceDedupCandidate): ReferenceSuggestion {
    return {
      code: String(candidate.code || '').trim(),
      label: String(candidate.label || candidate.code || '').trim(),
      source: 'existing_reference',
      table: kind,
      default_unit: candidate.default_unit || undefined,
      analytics_tag: candidate.analytics_tag || undefined,
      productivity_enabled: candidate.productivity_enabled ?? undefined,
    }
  }

  const useExistingMutation = useMutation({
    mutationFn: async (candidate: ReferenceDedupCandidate) => {
      const canonicalCode = String(candidate.code || '').trim()
      if (!canonicalCode) throw new Error('У выбранной записи нет кода')
      const alias = (aliasText.trim() || sourceText?.trim() || name.trim()).trim()
      if (alias) {
        const res = await fetch('/api/wip/settings/aliases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            canonical_code: canonicalCode,
            alias_text: alias,
            kind,
            notes: 'selected existing reference during create',
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({ detail: 'Ошибка сохранения алиаса' }))
          throw new Error(e.detail || 'Ошибка сохранения алиаса')
        }
      }
      return candidateToSuggestion(candidate)
    },
    onSuccess: suggestion => {
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
      onSaved(suggestion)
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wip/reports/reference-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          code: code.trim() || null,
          name: name.trim(),
          alias_text: aliasText.trim() || null,
          default_unit: defaultUnit.trim() || null,
          analytics_tag: analyticsTag.trim() || null,
          productivity_enabled: productivityEnabled,
          object_type_code: objectTypeCode,
          section_code: sectionCode || null,
          force_create: kind === 'object' ? allowCreateNewReference : true,
          pk_start: pkStart.trim() || null,
          pk_end: pkEnd.trim() || null,
          pk_raw_text: pkStart.trim() || null,
          comment: comment.trim() || null,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка создания' }))
        const detail = e.detail
        const message = typeof detail === 'string' ? detail : detail?.message
        throw new Error(message || 'Ошибка создания')
      }
      return (await res.json()) as ReferenceSuggestion
    },
    onSuccess: suggestion => {
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
      onSaved(suggestion)
    },
  })

  const createDisabled = !name.trim() || createMutation.isPending || duplicateLookupPending || createBlockedByCandidates

  const titleByKind: Record<AliasKind, string> = {
    work_type: 'Добавить работу в БД',
    material: 'Добавить материал в БД',
    object: 'Добавить объект / направление в БД',
  }
  const objectTypeOptions = (() => {
    const rows = meta?.object_types || []
    if (objectTypeCode && !rows.some(t => t.code === objectTypeCode)) {
      return [{ code: objectTypeCode, name: objectTypeCode }, ...rows]
    }
    return rows.length ? rows : [{ code: objectTypeCode || 'OTHER', name: objectTypeCode || 'OTHER' }]
  })()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={e => e.stopPropagation()}>
      <div className="w-full max-w-2xl rounded-lg border border-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-heading font-semibold text-text-primary">{titleByKind[kind]}</h3>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] gap-3">
            <label className="block min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">Код</span>
              <input value={code} onChange={e => setCode(e.target.value)} placeholder="можно пустым" className={inputCls} />
            </label>
            <label className="block min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">Название</span>
              <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
            </label>
          </div>

          {duplicateCandidates.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-amber-900">Существующие совпадения</div>
                <div className="text-[10px] font-medium text-amber-800">{duplicateCandidates.length}</div>
              </div>
              <div className="mt-2 space-y-1.5">
                {duplicateCandidates.map(candidate => (
                  <div key={candidate.id} className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-2 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-text-primary" title={candidateLabel(candidate)}>{candidateLabel(candidate)}</div>
                      <div className="text-[10px] text-text-muted">
                        {candidate.ref_count || 0} ссылок{candidate.analytics_tag ? ` · ${candidate.analytics_tag}` : ''}{candidate.review_tag ? ` · ${candidate.review_tag}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => useExistingMutation.mutate(candidate)}
                      disabled={useExistingMutation.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-text-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-text-secondary disabled:opacity-40"
                    >
                      <Check className="h-3 w-3" />
                      Использовать существующий
                    </button>
                  </div>
                ))}
              </div>
              {useExistingMutation.error ? <div className="mt-2 text-[11px] text-red-600">{(useExistingMutation.error as Error).message}</div> : null}
            </div>
          )}

          {(kind === 'work_type' || kind === 'material') && (
            <div className="grid grid-cols-1 md:grid-cols-[120px] gap-3">
              <label className="block min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Ед.</span>
                <input value={defaultUnit} onChange={e => setDefaultUnit(e.target.value)} className={inputCls} />
              </label>
            </div>
          )}

          {kind === 'work_type' && (
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-3">
              <label className="block min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Тег работы</span>
                <input
                  list="reference-create-work-tags"
                  value={analyticsTag}
                  onChange={e => setAnalyticsTag(e.target.value)}
                  placeholder="например: Песок (Насыпь)"
                  className={`${inputCls} ${!analyticsTag.trim() ? 'border-amber-300 bg-amber-50/40' : ''}`}
                />
                <datalist id="reference-create-work-tags">
                  {(meta?.work_tags || []).map(tag => <option key={tag} value={tag} />)}
                </datalist>
              </label>
              <label className="inline-flex items-center gap-2 rounded border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={productivityEnabled}
                  onChange={e => setProductivityEnabled(e.target.checked)}
                />
                Учитывать в расчете производительности
              </label>
            </div>
          )}

          {kind === 'object' && (
            <>
              <div className="grid grid-cols-1 gap-3">
                <label className="block min-w-0">
                  <span className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-text-muted">
                    <span>Тип объекта</span>
                    <button
                      type="button"
                      onClick={e => {
                        e.preventDefault()
                        setObjectTypeDialogOpen(true)
                      }}
                      className="inline-flex items-center gap-1 rounded border border-border bg-white px-1.5 py-0.5 font-medium normal-case tracking-normal text-text-muted hover:border-accent-red/40 hover:text-accent-red"
                    >
                      <Plus className="w-2.5 h-2.5" />
                      Новый тип
                    </button>
                  </span>
                  <select value={objectTypeCode} onChange={e => {
                    const next = e.target.value
                    setObjectTypeCode(next)
                    if (!code.trim() && pkCodePart(extractPkText(sourceText))) {
                      setCode(suggestedReferenceCode(kind, sourceText, next))
                    }
                  }} className={inputCls}>
                    {objectTypeOptions.map(t => (
                      <option key={t.code} value={t.code}>{t.name} · {t.code}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">ПК начало</span>
                  <input value={pkStart} onChange={e => setPkStart(e.target.value)} placeholder="ПК2750 или ПК2750+00" className={pkInputClassName(pkStart)} />
                  <PkSoftHint value={pkStart} />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">ПК конец</span>
                  <input value={pkEnd} onChange={e => setPkEnd(e.target.value)} placeholder="если не задан, будет как начало" className={pkInputClassName(pkEnd)} />
                  <PkSoftHint value={pkEnd} />
                </label>
              </div>
              <label className="block min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Комментарий</span>
                <input value={comment} onChange={e => setComment(e.target.value)} className={inputCls} />
              </label>
            </>
          )}

          <label className="block min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Фраза из отчёта для алиаса</span>
            <input value={aliasText} onChange={e => setAliasText(e.target.value)} placeholder="можно пустым" className={inputCls} />
          </label>

          {kind === 'object' && duplicateCandidates.length > 0 && (
            <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={allowCreateNewReference}
                onChange={e => setAllowCreateNewReference(e.target.checked)}
                className="mt-0.5"
              />
              <span>Создать новый объект, несмотря на найденные совпадения</span>
            </label>
          )}

          {duplicateLookupPending && <p className="text-xs text-text-muted">Проверяю похожие объекты…</p>}

          {createMutation.isError && (
            <p className="text-xs text-red-600">{(createMutation.error as Error)?.message}</p>
          )}
        </div>
        {kind === 'object' && objectTypeDialogOpen && (
          <ObjectTypeCreateModal
            sourceText={sourceText}
            onClose={() => setObjectTypeDialogOpen(false)}
            onSaved={type => {
              setObjectTypeCode(type.code)
              setObjectTypeDialogOpen(false)
            }}
          />
        )}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Отмена</button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createDisabled}
            title={createBlockedByCandidates ? 'Сначала выберите существующий объект или подтвердите создание новой записи' : undefined}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            {createMutation.isPending ? 'Создаем…' : duplicateLookupPending ? 'Проверяю…' : createBlockedByCandidates ? 'Подтвердите создание' : 'Создать и выбрать'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ObjectTypeCreateModal({
  sourceText,
  onClose,
  onSaved,
}: {
  sourceText?: string | null
  onClose: () => void
  onSaved: (type: ObjectTypeMeta) => void
}) {
  const qc = useQueryClient()
  const draft = useMemo(() => suggestedObjectTypeDraft(sourceText), [sourceText])
  const [code, setCode] = useState(draft.code)
  const [name, setName] = useState(draft.name)
  const [mapEnabled, setMapEnabled] = useState(true)
  const [workAccountingEnabled, setWorkAccountingEnabled] = useState(true)
  const [materialAccountingEnabled, setMaterialAccountingEnabled] = useState(false)
  const [isLinear, setIsLinear] = useState(false)
  const [accountingNote, setAccountingNote] = useState('created from report preview')

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wip/reports/object-type-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          map_enabled: mapEnabled,
          work_accounting_enabled: workAccountingEnabled,
          material_accounting_enabled: materialAccountingEnabled,
          is_linear: isLinear,
          accounting_note: accountingNote.trim() || null,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка создания типа объекта' }))
        throw new Error(e.detail || 'Ошибка создания типа объекта')
      }
      return (await res.json()) as ObjectTypeMeta
    },
    onSuccess: type => {
      qc.invalidateQueries({ queryKey: ['report-reference-meta'] })
      onSaved(type)
    },
  })

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={e => e.stopPropagation()}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-heading font-semibold text-text-primary">Добавить тип объекта</h3>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] gap-3">
            <label className="block min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">Код типа</span>
              <input value={code} onChange={e => setCode(e.target.value)} placeholder="PILE_DRIVING_PAD" className={inputCls} />
            </label>
            <label className="block min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">Название</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Стартовая площадка погружения свай" className={inputCls} />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-text-secondary">
            <label className="inline-flex items-center gap-2 rounded border border-border bg-bg-surface px-2 py-1.5">
              <input type="checkbox" checked={mapEnabled} onChange={e => setMapEnabled(e.target.checked)} />
              На карте
            </label>
            <label className="inline-flex items-center gap-2 rounded border border-border bg-bg-surface px-2 py-1.5">
              <input type="checkbox" checked={workAccountingEnabled} onChange={e => setWorkAccountingEnabled(e.target.checked)} />
              Учет работ
            </label>
            <label className="inline-flex items-center gap-2 rounded border border-border bg-bg-surface px-2 py-1.5">
              <input type="checkbox" checked={materialAccountingEnabled} onChange={e => setMaterialAccountingEnabled(e.target.checked)} />
              Учет материалов
            </label>
            <label className="inline-flex items-center gap-2 rounded border border-border bg-bg-surface px-2 py-1.5">
              <input type="checkbox" checked={isLinear} onChange={e => setIsLinear(e.target.checked)} />
              Линейный объект
            </label>
          </div>
          <label className="block min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Примечание</span>
            <input value={accountingNote} onChange={e => setAccountingNote(e.target.value)} className={inputCls} />
          </label>
          {createMutation.isError && (
            <p className="text-xs text-red-600">{(createMutation.error as Error)?.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Отмена</button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={!code.trim() || !name.trim() || createMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            {createMutation.isPending ? 'Создаем…' : 'Создать тип'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReferenceAliasModal({
  kind,
  aliasText,
  canonicalCode,
  onClose,
  onSaved,
}: {
  kind: AliasKind
  aliasText?: string | null
  canonicalCode: string
  onClose: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [alias, setAlias] = useState((aliasText || '').trim())
  const { data: aliasList, isFetching: aliasesLoading } = useQuery<{ rows: AliasRow[] }>({
    queryKey: ['aliases-list'],
    queryFn: async () => {
      const res = await fetch('/api/wip/settings/aliases')
      if (!res.ok) return { rows: [] }
      return res.json()
    },
  })
  const existingAliases = useMemo(() => (aliasList?.rows || [])
    .filter(row => row.kind === kind && row.canonical_code === canonicalCode)
    .sort((a, b) => a.alias_text.localeCompare(b.alias_text, 'ru')),
    [aliasList?.rows, canonicalCode, kind],
  )

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wip/settings/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_code: canonicalCode,
          alias_text: alias.trim(),
          kind,
          notes: 'created from report preview',
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка сохранения алиаса' }))
        throw new Error(e.detail || 'Ошибка сохранения алиаса')
      }
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
      onSaved()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/wip/settings/aliases/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка удаления алиаса' }))
        throw new Error(e.detail || 'Ошибка удаления алиаса')
      }
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
      qc.invalidateQueries({ queryKey: ['report-preview'] })
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={e => e.stopPropagation()}>
      <div className="w-full max-w-md rounded-lg border border-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-heading font-semibold text-text-primary">Связать алиас</h3>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Фраза из отчёта</span>
            <input value={alias} onChange={e => setAlias(e.target.value)} className={inputCls} />
          </label>
          <div className="rounded border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-secondary">
            {kind} → <span className="font-mono text-text-primary">{canonicalCode}</span>
          </div>
          <div className="rounded border border-border bg-white">
            <div className="border-b border-border px-2 py-1.5 text-[10px] uppercase tracking-wide text-text-muted">
              Существующие алиасы
            </div>
            {aliasesLoading ? (
              <div className="px-2 py-2 text-xs text-text-muted">Загрузка...</div>
            ) : existingAliases.length ? (
              <div className="max-h-40 overflow-auto divide-y divide-border">
                {existingAliases.map(row => (
                  <div key={row.id} className="flex items-start gap-2 px-2 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-text-primary">{row.alias_text}</div>
                      {row.notes && <div className="mt-0.5 break-words text-[10px] text-text-muted">{row.notes}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(row.id)}
                      disabled={deleteMutation.isPending}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      title="Удалить алиас"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-2 py-2 text-xs text-text-muted">Для этого значения алиасов пока нет</div>
            )}
          </div>
          {saveMutation.isError && (
            <p className="text-xs text-red-600">{(saveMutation.error as Error)?.message}</p>
          )}
          {deleteMutation.isError && (
            <p className="text-xs text-red-600">{(deleteMutation.error as Error)?.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Отмена</button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!alias.trim() || saveMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-burg disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            {saveMutation.isPending ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

function WorksPreviewSection({
  sectionCode,
  title,
  items,
  referenceContext,
  workTags,
  sectionBoundaries,
  extractionNumbers,
  onItemsChange,
}: {
  sectionCode?: string | null
  title: string
  items: WorkPreviewItem[]
  referenceContext: ReferenceContext
  workTags: string[]
  sectionBoundaries: SectionBoundary[]
  extractionNumbers?: ExtractionNumberMaps
  onItemsChange: (items: WorkPreviewItem[]) => void
}) {
  function updateRow(index: number, patch: Partial<WorkPreviewItem>) {
    onItemsChange(items.map((row, i) => i === index ? { ...row, ...patch } : row))
  }
  function emptyWorkRow(): WorkPreviewItem {
    return {
      work_name: '',
      constructive: '',
      work_type_code: '',
      object_code: '',
      constructive_code: '',
      volume: '',
      unit: 'м3',
      analytics_tag: '',
      pk_rail_start: '',
      pk_rail_end: '',
      pk_rail_raw: '',
      pk_ad_raw: '',
      productivity_enabled: true,
      equipment: [],
    }
  }
  function addRow() {
    onItemsChange([...items, emptyWorkRow()])
  }
  function insertRowAfter(index: number) {
    onItemsChange([
      ...items.slice(0, index + 1),
      emptyWorkRow(),
      ...items.slice(index + 1),
    ])
  }
  function removeRow(index: number) {
    onItemsChange(items.filter((_, i) => i !== index))
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          {title} <span className="text-text-muted font-normal">({items.length})</span>
        </h2>
        <BlockHelpButton help={REPORT_HELP.works} />
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
        >
          <Plus className="w-3 h-3" />
          Строка
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет записей</p>
      ) : (
        <div className="space-y-3">
          {items.map((row, i) => {
            const rowWorkTypeForbidden = isWorkBlockExcludedWorkTypeCode(row.work_type_code) || row.work_block_forbidden
            const workTypeSuggestionsForBlock = filterWorkBlockReferenceSuggestions(row.work_type_suggestions)
            const workTypeContextForBlock = filterWorkBlockReferenceSuggestions(referenceContext.work_type)
            const effectiveWorkTypeCode = rowWorkTypeForbidden ? '' : row.work_type_code
            const workSuggestion = selectedReferenceSuggestion(
              effectiveWorkTypeCode,
              mergeReferenceSuggestions(workTypeSuggestionsForBlock, workTypeContextForBlock),
              row.work_name,
            )
            const dbWorkTag = effectiveWorkTypeCode ? (workSuggestion?.analytics_tag || '') : ''
            const dbWorkUnit = effectiveWorkTypeCode ? (workSuggestion?.default_unit || row.unit || '') : (row.unit || '')
            const objectSuggestion = selectedReferenceSuggestion(row.object_code || row.constructive_code, row.object_suggestions, row.constructive)
            const railPkContext: PkValidationContext = {
              sectionCode,
              sectionBoundaries,
              boundaryKind: 'main',
              objectBoundary: objectBoundaryFromSuggestion(objectSuggestion || undefined),
            }
            const rowNumber = extractionNumbers?.works.get(row) ?? i + 1
            return (
            <div key={i} className="rounded-md border border-border bg-bg-surface/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <SourceTraceBadge number={rowNumber} label="работа" tone="work" line={sourceLineOf(row)} />
                <label className="inline-flex items-center gap-1.5 rounded border border-border bg-white px-2 py-1 text-[11px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={row.productivity_enabled !== false}
                    onChange={e => updateRow(i, { productivity_enabled: e.target.checked })}
                  />
                  Учитывать в производительности
                </label>
                <button
                  type="button"
                  onClick={() => insertRowAfter(i)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
                >
                  <Plus className="h-3 w-3" />
                  Вставить ниже
                </button>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                  aria-label="Удалить строку"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Работа из отчёта</span>
                  <input value={row.work_name || ''} onChange={e => updateRow(i, { work_name: e.target.value, work_type_selection_mode: '' })} className={inputCls} />
                  <CandidateHint suggestions={workTypeSuggestionsForBlock} />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Объект из отчёта</span>
                  <input value={row.constructive || ''} onChange={e => updateRow(i, { constructive: e.target.value, object_selection_mode: '' })} className={inputCls} />
                  <CandidateHint suggestions={row.object_suggestions} />
                </label>
              </div>
              <div className="mt-3 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_140px_100px] gap-3 items-start">
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Тип работы БД</span>
                  <ReferenceSelect
                    value={effectiveWorkTypeCode}
                    suggestions={workTypeSuggestionsForBlock}
                    contextSuggestions={workTypeContextForBlock}
                    kind="work_type"
                    sectionCode={sectionCode}
                    sourceText={row.work_name}
                    defaultProductivityEnabled={row.productivity_enabled !== false}
                    excludeCodes={WORK_BLOCK_EXCLUDED_WORK_TYPE_CODES}
                    placeholder="— выбрать —"
                    onChange={(code, suggestion) => {
                      if (isWorkBlockExcludedWorkTypeCode(code)) return
                      const selected = suggestion || selectedReferenceSuggestion(
                        code,
                        mergeReferenceSuggestions(workTypeSuggestionsForBlock, workTypeContextForBlock),
                        row.work_name,
                      ) || undefined
                      const patch: Partial<WorkPreviewItem> = {
                        work_type_code: code,
                        work_type_selection_mode: code ? 'manual' : '',
                        work_type_suggestions: rememberReferenceSelection(row.work_type_suggestions, code, selected, row.work_name),
                        work_block_forbidden: false,
                        work_block_forbidden_message: '',
                        analytics_tag: code ? (selected?.analytics_tag || '') : '',
                        unit: code ? (selected?.default_unit || row.unit || '') : '',
                      }
                      if (code && selected?.label && !String(row.work_name || '').trim()) {
                        patch.work_name = selected.label
                      }
                      if (code && typeof selected?.productivity_enabled === 'boolean') {
                        patch.productivity_enabled = selected.productivity_enabled
                      }
                      updateRow(i, patch)
                    }}
                  />
                  {rowWorkTypeForbidden && (
                    <p className="mt-1 text-[10px] leading-snug text-red-600">
                      {row.work_block_forbidden_message || 'Забивку основных/пробных свай и монтаж наголовников нужно вводить в блоке «Свайные работы».'}
                    </p>
                  )}
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Объект БД</span>
                  <ReferenceSelect
                    value={row.object_code || row.constructive_code}
                    suggestions={row.object_suggestions}
                    contextSuggestions={referenceContext.object}
                    kind="object"
                    sectionCode={sectionCode}
                    sourceText={row.constructive}
                    placeholder="— выбрать —"
                    onChange={(code, suggestion) => updateRow(i, {
                      object_code: code,
                      constructive_code: code,
                      object_selection_mode: code ? 'manual' : '',
                      constructive: row.constructive || suggestion?.label || '',
                      object_suggestions: rememberReferenceSelection(row.object_suggestions, code, suggestion, row.constructive),
                    })}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Тег работы</span>
                  <input
                    list={`work-analytics-tags-${i}`}
                    value={dbWorkTag}
                    readOnly
                    placeholder="Без тега"
                    title="Тег задается у вида работы во вкладке База данных"
                    className={`${inputCls} bg-bg-surface text-text-muted cursor-not-allowed`}
                  />
                  <datalist id={`work-analytics-tags-${i}`}>
                    {workTags.map(tag => <option key={tag} value={tag} />)}
                  </datalist>
                  <div className="mt-1 text-[10px] text-text-muted">Задается в БД</div>
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Объём</span>
                  <input value={row.volume ?? ''} onChange={e => updateRow(i, { volume: e.target.value })} className={inputCls} />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">Ед.</span>
                  <input
                    value={dbWorkUnit}
                    readOnly
                    placeholder="—"
                    title="Единица измерения задается у вида работы во вкладке База данных"
                    className={`${inputCls} bg-bg-surface text-text-muted cursor-not-allowed`}
                  />
                  <div className="mt-1 text-[10px] text-text-muted">Задается в БД</div>
                </label>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">ПК ВСЖМ начало</span>
                  <input
                    value={row.pk_rail_start ?? ''}
                    onChange={e => updateRow(i, { pk_rail_start: e.target.value })}
                    placeholder="ПК2702+00"
                    className={pkInputClassName(row.pk_rail_start, row.pk_validation_override, false, railPkContext)}
                  />
                  <PkSoftHint value={row.pk_rail_start} context={railPkContext} />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">ПК ВСЖМ конец</span>
                  <input
                    value={row.pk_rail_end ?? ''}
                    onChange={e => updateRow(i, { pk_rail_end: e.target.value })}
                    placeholder="если пусто, будет как начало"
                    className={pkInputClassName(row.pk_rail_end, row.pk_validation_override, false, railPkContext)}
                  />
                  <PkSoftHint value={row.pk_rail_end} context={railPkContext} />
                </label>
                <label className="block min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">ПК АД / примечание</span>
                  <input
                    value={row.pk_ad_raw || ''}
                    onChange={e => updateRow(i, { pk_ad_raw: e.target.value })}
                    placeholder="при наличии"
                    className={pkInputClassName(row.pk_ad_raw, row.pk_validation_override, true)}
                  />
                  <PkSoftHint value={row.pk_ad_raw} textOnlyAllowed />
                </label>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
                <input
                  value={row.equipment_type || row.vehicle || ''}
                  onChange={e => updateRow(i, { equipment_type: e.target.value, vehicle: e.target.value })}
                  placeholder="Тип"
                  className={inputCls}
                />
                {isHiredEquipmentRow(row) ? (
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={hiredEquipmentCount(row)}
                    onChange={e => updateRow(i, patchHiredEquipmentCount(row, e.target.value))}
                    onKeyDown={preventInputSubmitOnEnter}
                    placeholder="Число техники"
                    className={inputCls}
                  />
                ) : (
                  <input
                    value={equipmentNumber(row)}
                    onChange={e => updateRow(i, patchEquipmentNumber(row, e.target.value))}
                    onKeyDown={preventInputSubmitOnEnter}
                    placeholder="Госномер / борт"
                    className={inputCls}
                  />
                )}
                <input
                  value={row.owner || row.contractor_name || ''}
                  onChange={e => updateRow(i, patchEquipmentOwner(row, e.target.value))}
                  placeholder="Принадлежность"
                  className={inputCls}
                />
                <input
                  type="number"
                  min="0.01"
                  max="11"
                  step="0.25"
                  value={row.work_hours ?? ''}
                  onChange={e => updateRow(i, { work_hours: e.target.value })}
                  onKeyDown={preventInputSubmitOnEnter}
                  placeholder="Время работы, ч (11)"
                  aria-label="Время работы, часов"
                  className={inputCls}
                />
              </div>
              {!isHiredEquipmentRow(row) && (
                <EquipmentSuggestionErrorBoundary resetKey={`work-${i}-${equipmentNumber(row)}`}>
                  <EquipmentSuggestionSelect
                    row={row}
                    onApply={suggestion => updateRow(i, applyEquipmentSuggestion(row, suggestion))}
                  />
                </EquipmentSuggestionErrorBoundary>
              )}
            </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function TransportPreviewSection({
  sectionCode,
  items,
  referenceContext,
  extractionNumbers,
  onItemsChange,
}: {
  sectionCode?: string | null
  items: TransportItem[]
  referenceContext: ReferenceContext
  extractionNumbers?: ExtractionNumberMaps
  onItemsChange: (items: TransportItem[]) => void
}) {
  function updateUnit(index: number, patch: Partial<TransportItem>) {
    onItemsChange(items.map((unit, i) => i === index ? { ...unit, ...patch } : unit))
  }
  function updateTrip(unitIndex: number, tripIndex: number, patch: Partial<TransportTrip>) {
    onItemsChange(items.map((unit, i) => {
      if (i !== unitIndex) return unit
      const trips = (unit.trips || []).map((trip, j) => j === tripIndex ? { ...trip, ...patch } : trip)
      return { ...unit, trips }
    }))
  }
  function addDriver() {
    onItemsChange([...items, { vehicle: '', equipment_type: 'самосвал', reported_number: '', unit_number: '', plate_number: '', plate: '', owner: '', trips: [] }])
  }
  function addTrip(unitIndex: number) {
    onItemsChange(items.map((unit, i) => i === unitIndex
      ? { ...unit, trips: [...(unit.trips || []), { material: '', from: '', to: '', volume: '', unit: 'м3', trips: '', haul_distance_km: '' }] }
      : unit))
  }
  function removeTrip(unitIndex: number, tripIndex: number) {
    onItemsChange(items.map((unit, i) => i === unitIndex
      ? { ...unit, trips: (unit.trips || []).filter((_, j) => j !== tripIndex) }
      : unit))
  }
  function removeDriver(unitIndex: number) {
    onItemsChange(items.filter((_, i) => i !== unitIndex))
  }

  return (
    <section className="bg-white border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-sm font-heading font-semibold text-text-primary flex-1">
          Перевозки <span className="text-text-muted font-normal">({items.reduce((sum, d) => sum + (d.trips || []).length, 0)} рейс-строк)</span>
        </h2>
        <BlockHelpButton help={REPORT_HELP.transport} />
        <button type="button" onClick={addDriver} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-secondary hover:bg-bg-surface">
          <Plus className="w-3 h-3" />
          Самосвал
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">Нет записей</p>
      ) : (
        <div className="space-y-3">
          {items.map((unit, unitIndex) => {
            const unitNumber = extractionNumbers?.transport.get(unit) ?? unitIndex + 1
            return (
            <div key={unitIndex} className="rounded-md border border-border bg-bg-surface/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <SourceTraceBadge number={unitNumber} label="перевозка" tone="transport" line={transportSourceLine(unit)} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2">
                <input
                  value={unit.equipment_type || unit.vehicle || ''}
                  onChange={e => updateUnit(unitIndex, { equipment_type: e.target.value, vehicle: e.target.value })}
                  placeholder="Тип"
                  className={inputCls}
                />
                {isHiredEquipmentRow(unit) ? (
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={hiredEquipmentCount(unit)}
                    onChange={e => updateUnit(unitIndex, patchHiredEquipmentCount(unit, e.target.value))}
                    onKeyDown={preventInputSubmitOnEnter}
                    placeholder="Число техники"
                    className={inputCls}
                  />
                ) : (
                  <input
                    value={equipmentNumber(unit)}
                    onChange={e => updateUnit(unitIndex, patchEquipmentNumber(unit, e.target.value))}
                    onKeyDown={preventInputSubmitOnEnter}
                    placeholder="Госномер / борт"
                    className={inputCls}
                  />
                )}
                <input value={unit.owner || ''} onChange={e => updateUnit(unitIndex, patchEquipmentOwner(unit, e.target.value))} placeholder="Принадлежность" className={inputCls} />
              </div>
              {!isHiredEquipmentRow(unit) && (
                <EquipmentSuggestionErrorBoundary resetKey={`transport-${unitIndex}-${equipmentNumber(unit)}`}>
                  <EquipmentSuggestionSelect
                    row={unit}
                    onApply={suggestion => updateUnit(unitIndex, applyEquipmentSuggestion(unit, suggestion))}
                  />
                </EquipmentSuggestionErrorBoundary>
              )}
              <div className="space-y-2">
                {(unit.trips || []).map((trip, tripIndex) => (
                  <div key={tripIndex} className="rounded-md border border-border/70 bg-white p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <SourceTraceBadge number={`${unitNumber}.${tripIndex + 1}`} label="рейс" tone="transport" line={sourceLineOf(trip)} />
                      <button
                        type="button"
                        onClick={() => removeTrip(unitIndex, tripIndex)}
                        className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded hover:bg-red-50 text-text-muted hover:text-red-600"
                        aria-label="Удалить рейс"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Материал из отчёта</span>
                        <input value={trip.material || ''} onChange={e => updateTrip(unitIndex, tripIndex, { material: e.target.value, material_selection_mode: '' })} className={inputCls} />
                        <ReferenceSelect
                          value={trip.material_code}
                          suggestions={trip.material_suggestions}
                          contextSuggestions={referenceContext.material}
                          kind="material"
                          sectionCode={sectionCode}
                          sourceText={trip.material}
                          placeholder="материал БД"
                          onChange={(code, suggestion) => updateTrip(unitIndex, tripIndex, {
                            material_code: code,
                            material_selection_mode: code ? 'manual' : '',
                            material: trip.material || suggestion?.label || '',
                            material_suggestions: rememberReferenceSelection(trip.material_suggestions, code, suggestion, trip.material),
                          })}
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Откуда</span>
                        <input value={trip.from || ''} onChange={e => updateTrip(unitIndex, tripIndex, { from: e.target.value, from_location: e.target.value, from_object_selection_mode: '' })} className={inputCls} />
                        <ReferenceSelect
                          value={trip.from_object_code}
                          suggestions={trip.from_object_suggestions}
                          contextSuggestions={referenceContext.object}
                          kind="object"
                          sectionCode={sectionCode}
                          sourceText={trip.from}
                          placeholder="объект БД"
                          onChange={(code, suggestion) => updateTrip(unitIndex, tripIndex, {
                            from_object_code: code,
                            from_object_selection_mode: code ? 'manual' : '',
                            from: trip.from || suggestion?.label || '',
                            from_location: trip.from_location || trip.from || suggestion?.label || '',
                            from_object_suggestions: rememberReferenceSelection(trip.from_object_suggestions, code, suggestion, trip.from),
                          })}
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Куда</span>
                        <input value={trip.to || ''} onChange={e => updateTrip(unitIndex, tripIndex, { to: e.target.value, to_location: e.target.value, to_object_selection_mode: '' })} className={inputCls} />
                        <ReferenceSelect
                          value={trip.to_object_code}
                          suggestions={trip.to_object_suggestions}
                          contextSuggestions={referenceContext.object}
                          kind="object"
                          sectionCode={sectionCode}
                          sourceText={trip.to}
                          placeholder="объект БД"
                          onChange={(code, suggestion) => updateTrip(unitIndex, tripIndex, {
                            to_object_code: code,
                            to_object_selection_mode: code ? 'manual' : '',
                            to: trip.to || suggestion?.label || '',
                            to_location: trip.to_location || trip.to || suggestion?.label || '',
                            to_object_suggestions: rememberReferenceSelection(trip.to_object_suggestions, code, suggestion, trip.to),
                          })}
                        />
                      </label>
                    </div>
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 xl:grid-cols-[140px_100px_100px_120px_140px] gap-2">
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Объём</span>
                        <input value={trip.volume ?? ''} onChange={e => updateTrip(unitIndex, tripIndex, { volume: e.target.value })} className={inputCls} />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Ед.</span>
                        <input value={(trip.unit as string) || 'м3'} onChange={e => updateTrip(unitIndex, tripIndex, { unit: e.target.value })} className={inputCls} />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Рейсы</span>
                        <input value={trip.trips ?? ''} onChange={e => updateTrip(unitIndex, tripIndex, { trips: e.target.value, trip_count: e.target.value })} className={inputCls} />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Плечо, км</span>
                        <input value={trip.haul_distance_km ?? ''} onChange={e => updateTrip(unitIndex, tripIndex, { haul_distance_km: e.target.value })} className={inputCls} />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">Время работы, ч</span>
                        <input
                          type="number"
                          min="0.01"
                          max="11"
                          step="0.25"
                          value={trip.work_hours ?? ''}
                          onChange={e => updateTrip(unitIndex, tripIndex, { work_hours: e.target.value })}
                          onKeyDown={preventInputSubmitOnEnter}
                          placeholder="11"
                          className={inputCls}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between gap-2">
                <button type="button" onClick={() => addTrip(unitIndex)} className="text-[11px] font-semibold text-accent-red hover:underline">+ рейс</button>
                <button type="button" onClick={() => removeDriver(unitIndex)} className="text-[11px] font-semibold text-text-muted hover:text-red-600">удалить самосвал</button>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function sectionLabel(code?: string | null) {
  return code ? code.replace('UCH_', '№') : '—'
}

const inputCls = "w-full rounded border border-border bg-white px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-red/50"

// ── detail modal ────────────────────────────────────────────────────────

interface ReportPreviewResponse {
  available: boolean
  reason?: string
  meta: {
    id: string
    report_date: string | null
    shift: string | null
    section_code: string | null
    section_name: string | null
    source_type: string | null
    source_reference: string | null
    status?: string | null
    review_tag?: string | null
    uploaded_by_username?: string | null
  }
  parsed?: ParsedPayload
}

function ReportDetailModal({
  reportId,
  onClose,
  onCollapse,
}: {
  reportId: string
  onClose: () => void
  onCollapse: () => void
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const canReviewReports = hasReportReviewRights(user)
  const canEditConfirmedReports = hasReportEditRights(user)
  const [draftPayload, setDraftPayload] = useState<ParsedPayload | null>(null)
  const [isCollapseSaving, setIsCollapseSaving] = useState(false)
  const [collapseSaveError, setCollapseSaveError] = useState('')
  const hydratedReportIdRef = useRef<string | null>(null)
  const latestDraftPayloadRef = useRef<ParsedPayload | null>(null)
  const extractedScrollRef = useRef<HTMLDivElement>(null)
  const rawScrollRef = useRef<HTMLDivElement>(null)
  const setDraftPayloadSynced = useCallback((next: ParsedPayload | null) => {
    latestDraftPayloadRef.current = next
    setDraftPayload(next)
  }, [])

  const { data, isLoading, isError } = useQuery<ReportPreviewResponse>({
    queryKey: ['report-preview', reportId],
    queryFn: () => fetch(`/api/wip/reports/${reportId}/preview`).then(r => r.json()),
  })

  const meta = data?.meta
  const parsed = data?.parsed
  const status = meta?.status || null
  const isOwner = Boolean(meta?.uploaded_by_username && user?.username === meta.uploaded_by_username)
  const editable = Boolean(meta && (
    ((canReviewReports || isOwner) && (status === 'pending_review' || status === 'review'))
    || (canEditConfirmedReports && (status === 'confirmed' || status === 'approved'))
  ))
  const sourceFilename = meta?.source_reference || 'stored-report'
  const currentPayload = draftPayload ?? parsed ?? null
  const title = meta
    ? `Отчёт ${meta.report_date ?? '—'} / смена ${shiftLabel(meta.shift ?? '')} / ${meta.section_name ?? '—'}`
    : 'Отчёт'

  useEffect(() => {
    if (hydratedReportIdRef.current !== reportId) {
      hydratedReportIdRef.current = reportId
      setDraftPayloadSynced(parsed ?? null)
      setCollapseSaveError('')
    } else if (!draftPayload && parsed) {
      setDraftPayloadSynced(parsed)
    }
  }, [draftPayload, parsed, reportId, setDraftPayloadSynced])

  const collapseWithSave = useCallback(async () => {
    if (isCollapseSaving) return
    const payloadToSave = latestDraftPayloadRef.current ?? currentPayload
    if (!editable || !payloadToSave) {
      onCollapse()
      return
    }
    setCollapseSaveError('')
    setIsCollapseSaving(true)
    try {
      const res = await fetch(`/api/wip/reports/${reportId}/review-payload`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReportPayloadBody(payloadToSave, sourceFilename)),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: 'Ошибка сохранения черновика' }))
        throw new Error(body.detail || 'Ошибка сохранения черновика')
      }
      await res.json().catch(() => null)
      await qc.invalidateQueries({ queryKey: ['reports-list'] })
      await qc.invalidateQueries({ queryKey: ['wip'] })
      await qc.invalidateQueries({ queryKey: ['report-preview', reportId] })
      setIsCollapseSaving(false)
      onCollapse()
    } catch (err) {
      setCollapseSaveError(err instanceof Error ? err.message : 'Ошибка сохранения черновика')
      setIsCollapseSaving(false)
    }
  }, [currentPayload, editable, isCollapseSaving, onCollapse, qc, reportId, sourceFilename])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void collapseWithSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapseWithSave])

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    void collapseWithSave()
  }

  return (
    <div
      onMouseDown={handleBackdropMouseDown}
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-1 sm:p-2"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full flex flex-col"
        style={{ width: 'calc(100vw - 16px)', maxWidth: 'none', maxHeight: 'calc(100vh - 16px)', height: 'calc(100vh - 16px)' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 text-accent-red shrink-0" />
            <h2 className="text-sm font-heading font-semibold text-text-primary leading-tight break-words">{title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => void collapseWithSave()}
              disabled={isCollapseSaving}
              className="text-text-muted hover:text-text-primary p-1 disabled:opacity-50"
              aria-label="Свернуть"
              title={isCollapseSaving ? 'Сохраняем черновик...' : 'Свернуть'}
            >
              <Minimize2 className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary p-1"
              aria-label="Закрыть"
              title="Закрыть"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        {collapseSaveError && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
            {collapseSaveError}
          </div>
        )}

        <div className="flex flex-col md:grid md:grid-cols-[minmax(760px,2fr)_minmax(460px,1fr)] gap-0 flex-1 min-h-0 overflow-hidden md:overflow-x-auto md:overflow-y-hidden">
          {/* LEFT — extracted */}
          <div
            ref={extractedScrollRef}
            className="order-2 min-h-0 flex-[3_1_0] overflow-y-auto overflow-x-hidden border-t border-border p-4 md:order-1 md:min-w-[760px] md:border-r md:border-t-0"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <h3 className="text-xs uppercase tracking-wide text-text-muted mb-3 sticky top-0 bg-white py-1 z-10">
              Извлечённые параметры
            </h3>
            {isLoading && <p className="text-text-muted text-sm">Загрузка…</p>}
            {isError && <p className="text-red-500 text-sm">Ошибка загрузки</p>}
            {data && !data.available && (
              <p className="text-text-muted text-sm">{data.reason}</p>
            )}
            {currentPayload && editable && (
              <PreviewPane
                parsed={currentPayload}
                sourceFilename={sourceFilename}
                existingReportId={reportId}
                existingReportStatus={status}
                onImported={onClose}
                onPayloadChange={setDraftPayloadSynced}
              />
            )}
            {parsed && !editable && (
              <>
                <ShiftSummaryPanel payload={parsed} />
                <ExtractedView parsed={parsed} />
              </>
            )}
          </div>

          {/* RIGHT — raw highlighted */}
          <div
            ref={rawScrollRef}
            className="order-1 min-h-0 flex-[2_1_0] overflow-y-auto overflow-x-hidden border-b border-border bg-bg-surface p-4 md:order-2 md:min-w-[460px] md:border-b-0"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <h3 className="text-xs uppercase tracking-wide text-text-muted mb-3 sticky top-0 bg-bg-surface py-1 z-10">
              Исходник отчета
            </h3>
            {(currentPayload?.raw_text || parsed?.raw_text)
              ? <HighlightedRaw text={currentPayload?.raw_text || parsed?.raw_text || ''} parsed={currentPayload || parsed} />
              : <p className="text-text-muted text-sm">Исходный текст недоступен</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function ExtractedView({ parsed }: { parsed: ParsedPayload }) {
  const h = parsed.header
  const extractionNumbers = useMemo(() => buildExtractionNumberMaps(parsed), [parsed])
  const transport = useMemo(
    () => transportInSourceOrder(parsed.transport || []),
    [parsed.transport],
  )
  const works = useMemo(
    () => worksInSourceOrder([...(parsed.main_works || []), ...(parsed.aux_works || [])]),
    [parsed.main_works, parsed.aux_works],
  )
  return (
    <div className="space-y-4 text-sm">
      {parsed.aliases && <AliasSummaryBar summary={parsed.aliases} />}

      <div>
        <div className="font-semibold text-text-primary">
          {h.report_date} · {shiftLabel(h.shift)} · {h.section_name || h.section_code || '—'}
        </div>
        {(parsed.human_summary?.constructives || h.constructives) && (
          <div className="text-xs text-text-muted font-mono mt-0.5">Конструктивы: {parsed.human_summary?.constructives || h.constructives}</div>
        )}
        {parsed.human_summary?.delivery_info && (
          <div className="text-xs text-text-muted font-mono mt-0.5">Завоз: {parsed.human_summary.delivery_info}</div>
        )}
        {(parsed.warnings || []).length > 0 && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
            {(parsed.warnings || []).map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}
      </div>

      {/* Transport */}
      <section>
        <h4 className="text-xs font-semibold text-text-primary mb-1.5">
          Перевозка <span className="text-text-muted font-normal">({transport.length})</span>
        </h4>
        <div className="space-y-2">
          {transport.map((d, i) => {
            const unitNumber = extractionNumbers.transport.get(d) ?? i + 1
            return (
            <div key={i} className="border border-border rounded px-2 py-1.5 bg-bg-surface/40">
              <div className="flex flex-wrap items-center gap-1 text-xs text-text-secondary font-mono">
                <SourceTraceBadge number={unitNumber} label="перевозка" tone="transport" line={transportSourceLine(d)} />
                <span>{d.vehicle || d.equipment_type || 'Техника'}</span>
                <span className="text-text-muted">({isHiredEquipmentRow(d) ? `число ${hiredEquipmentCount(d) || 1}` : `номер ${equipmentNumber(d) || '—'}`}); {d.owner}</span>
              </div>
              {(d.trips || []).length > 0 && (
                <ul className="mt-1 text-xs text-text-secondary space-y-1">
                  {(d.trips || []).map((t, j) => (
                    <li key={j} className="font-mono flex flex-wrap items-center gap-1">
                      <SourceTraceBadge number={`${unitNumber}.${j + 1}`} label="рейс" tone="transport" line={sourceLineOf(t)} compact />
                      <AliasTerm
                        text={t.material}
                        code={t.material_code}
                        kind="material"
                        tone="amber"
                      />
                      {t.from && t.to && (
                        <>
                          <span className="text-text-muted">·</span>
                          <AliasTerm text={t.from} code={t.from_object_code} kind="object" />
                          <span className="text-text-muted">→</span>
                          <AliasTerm text={t.to} code={t.to_object_code} kind="object" />
                        </>
                      )}
                      {t.volume != null && <span className="text-text-muted">· {t.volume} м³</span>}
                      {t.trips != null && <span className="text-text-muted">/ {t.trips} рейс.</span>}
                      {t.haul_distance_km != null && t.haul_distance_km !== '' && <span className="text-text-muted">· плечо {t.haul_distance_km} км</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            )
          })}
        </div>
      </section>

      <WorksSection title="Работы" items={works} extractionNumbers={extractionNumbers} />

      {/* Problems */}
      {parsed.problems && (
        <section>
          <h4 className="text-xs font-semibold text-text-primary mb-1.5">Проблемные вопросы</h4>
          <p className="text-xs text-text-secondary whitespace-pre-wrap">{parsed.problems}</p>
        </section>
      )}

      {(parsed.stockpiles || []).length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-text-primary mb-1.5">Накопители</h4>
          <ul className="text-xs font-mono space-y-1">
            {(parsed.stockpiles || []).map((s, i) => (
              <li key={i} className="text-text-secondary">
                {s.name} · {s.pk_raw_text || 'ПК н/д'} · {s.volume ?? '—'} {s.unit || ''}
                {s.needs_create && <span className="text-amber-700"> · будет создан после подтверждения</span>}
                {s.existing_object_name && <span className="text-emerald-700"> · найден: {s.existing_object_name}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(parsed.piles || []).length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-text-primary mb-1.5">Свайные работы</h4>
          <ul className="text-xs font-mono space-y-1">
            {(parsed.piles || []).map((p, i) => (
              <li key={i} className="text-text-secondary">
                {p.field_code || 'поле н/д'} · {pileOperationLabel(p)} · {p.pile_kind === 'test' ? 'пробные' : 'основные'} · {p.count ?? '—'} шт · {p.pile_length_label || p.pile_type || 'длина н/д'}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function sourceLineOf(item: PreviewItem): number | null {
  const source = item._source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const rawLine = (source as Record<string, unknown>).line
  const line = typeof rawLine === 'number' ? rawLine : Number(rawLine)
  return Number.isFinite(line) ? line : null
}

function worksInSourceOrder<T extends PreviewItem>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, line: sourceLineOf(item) }))
    .sort((a, b) => {
      if (a.line != null && b.line != null && a.line !== b.line) return a.line - b.line
      if (a.line != null && b.line == null) return -1
      if (a.line == null && b.line != null) return 1
      return a.index - b.index
    })
    .map(row => row.item)
}

function minSourceLine(items: PreviewItem[] | undefined): number | null {
  const lines = (items || []).map(sourceLineOf).filter((line): line is number => line != null)
  return lines.length ? Math.min(...lines) : null
}

function transportSourceLine(item: TransportItem): number | null {
  return sourceLineOf(item) ?? minSourceLine(item.trips)
}

function transportInSourceOrder(items: TransportItem[]): TransportItem[] {
  return items
    .map((item, index) => ({ item, index, line: transportSourceLine(item) }))
    .sort((a, b) => {
      if (a.line != null && b.line != null && a.line !== b.line) return a.line - b.line
      if (a.line != null && b.line == null) return -1
      if (a.line == null && b.line != null) return 1
      return a.index - b.index
    })
    .map(row => row.item)
}

type ExtractionTone = 'work' | 'transport'

interface ExtractionNumberMaps {
  works: Map<PreviewItem, number>
  transport: Map<PreviewItem, number>
}

function buildExtractionNumberMaps(parsed?: ParsedPayload | null): ExtractionNumberMaps {
  const maps: ExtractionNumberMaps = { works: new Map(), transport: new Map() }
  if (!parsed) return maps
  const entries: Array<{ item: PreviewItem; kind: ExtractionTone; line: number | null; fallback: number }> = []
  let fallback = 0
  for (const unit of parsed.transport || []) {
    entries.push({ item: unit, kind: 'transport', line: transportSourceLine(unit), fallback: fallback++ })
  }
  for (const work of [...(parsed.main_works || []), ...(parsed.aux_works || [])]) {
    entries.push({ item: work, kind: 'work', line: sourceLineOf(work), fallback: fallback++ })
  }
  entries
    .sort((a, b) => {
      if (a.line != null && b.line != null && a.line !== b.line) return a.line - b.line
      if (a.line != null && b.line == null) return -1
      if (a.line == null && b.line != null) return 1
      return a.fallback - b.fallback
    })
    .forEach((entry, index) => {
      if (entry.kind === 'work') maps.works.set(entry.item, index + 1)
      else maps.transport.set(entry.item, index + 1)
    })
  return maps
}

function SourceTraceBadge({
  number: _number,
  label: _label,
  line,
  compact: _compact = false,
}: {
  number: number | string
  label: string
  tone: ExtractionTone
  line?: number | null
  compact?: boolean
}) {
  const sourceLine = line ?? '-'
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border bg-white px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
      <span>стр. {sourceLine}</span>
    </span>
  )
}

function WorksSection({ title, items, extractionNumbers }: { title: string; items: WorkPreviewItem[]; extractionNumbers?: ExtractionNumberMaps }) {
  if (!items.length) return null
  return (
    <section>
      <h4 className="text-xs font-semibold text-text-primary mb-1.5">
        {title} <span className="text-text-muted font-normal">({items.length})</span>
      </h4>
      <ul className="space-y-1">
        {items.map((w, i) => {
          const rowNumber = extractionNumbers?.works.get(w) ?? i + 1
          const objectCode = w.object_code ?? w.constructive_code ?? null
          const pkA = w.pk_rail_start != null && w.pk_rail_end != null
            ? `ПК ${w.pk_rail_start}–${w.pk_rail_end}` : null
          const equipmentLabel = [
            w.vehicle || w.equipment_type,
            isHiredEquipmentRow(w) ? `число ${hiredEquipmentCount(w) || 1}` : (equipmentNumber(w) ? `номер ${equipmentNumber(w)}` : null),
            w.owner || w.contractor_name || null,
          ].filter(Boolean).join(' · ')
          return (
            <li key={i} className="border border-border rounded px-2 py-1 text-xs bg-bg-surface/40">
              <div className="flex flex-wrap items-center gap-1 text-text-primary">
                <SourceTraceBadge number={rowNumber} label="работа" tone="work" line={sourceLineOf(w)} compact />
                <AliasTerm text={w.work_name} code={w.work_type_code} kind="work_type" />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-text-secondary font-mono">
                <span className="text-text-muted">Объект:</span>
                <AliasTerm text={w.constructive || 'Объект не задан'} code={objectCode} kind="object" tone="pink" />
              </div>
              {equipmentLabel && <div className="text-text-secondary font-mono">{equipmentLabel}</div>}
              <div className="text-text-muted font-mono">
                {pkA && <span className="text-purple-700">{pkA}</span>}
                {w.volume != null && <> · {w.volume} {w.unit || ''}</>}
                {w.volume_note && <> ({w.volume_note})</>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── alias summary + inline add ──────────────────────────────────────────

function AliasSummaryBar({ summary }: { summary: AliasesSummary }) {
  const { total_items, resolved, unresolved, unresolved_samples } = summary
  const ok = unresolved === 0
  return (
    <div
      title={unresolved_samples.length ? 'Требуют добавления:\n' + unresolved_samples.join('\n') : ''}
      className={`rounded-md border px-2.5 py-1.5 text-xs font-mono flex items-center gap-2 ${
        ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
          : 'border-red-300 bg-red-50 text-accent-red'
      }`}
    >
      <span className="font-semibold">Алиасы:</span>
      <span>✓ {resolved} из {total_items} распознано</span>
      {unresolved > 0 && <span>· {unresolved} требуют добавления</span>}
    </div>
  )
}

function AliasTerm({
  text,
  code,
  kind,
  tone,
}: {
  text: string | null | undefined
  code: string | null | undefined
  kind: AliasKind
  tone?: 'amber' | 'pink'
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  if (!text) return <span className="text-text-muted">—</span>

  if (code) {
    const toneCls =
      tone === 'amber' ? 'text-amber-700'
        : tone === 'pink' ? 'text-pink-700'
        : 'text-text-primary'
    return <span className={toneCls}>{text}</span>
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <span className="bg-red-50 text-accent-red border border-red-300 rounded px-1">
        {text}
      </span>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-0.5 text-[10px] text-accent-red hover:text-accent-burg
                   border border-red-200 hover:border-accent-red rounded px-1 py-0.5 bg-white"
        title="Добавить в словарь алиасов"
      >
        <Plus className="w-2.5 h-2.5" />
        в словарь
      </button>
      {open && (
        <AliasAddPopover
          initialText={text}
          initialKind={kind}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false)
            // Invalidate everything that depends on alias resolution.
            qc.invalidateQueries({ queryKey: ['aliases-list'] })
            qc.invalidateQueries({ queryKey: ['report-preview'] })
          }}
        />
      )}
    </span>
  )
}

function AliasAddPopover({
  initialText,
  initialKind,
  onClose,
  onSaved,
}: {
  initialText: string
  initialKind: AliasKind
  onClose: () => void
  onSaved: () => void
}) {
  const [aliasText, setAliasText] = useState(initialText)
  const [kind, setKind] = useState<AliasKind>(initialKind)
  const [canonicalCode, setCanonicalCode] = useState('')

  const placeholderByKind: Record<AliasKind, string> = {
    work_type: 'AREA_GRADING',
    material: 'SAND',
    object: 'VPD_048',
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wip/settings/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_code: canonicalCode.trim(),
          alias_text: aliasText.trim(),
          kind,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка сохранения' }))
        throw new Error(e.detail || 'Ошибка сохранения')
      }
      return res.json()
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div
      onClick={e => e.stopPropagation()}
      className="absolute z-20 top-full left-0 mt-1 w-72 bg-white border border-border rounded-md
                 shadow-lg p-2 text-xs font-sans"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold text-text-primary">Новый алиас</span>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Закрыть">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <label className="block mb-1.5">
        <span className="text-text-muted">alias_text</span>
        <input
          type="text"
          value={aliasText}
          onChange={e => setAliasText(e.target.value)}
          className="w-full mt-0.5 bg-bg-surface border border-border rounded px-1.5 py-1 font-mono
                     focus:outline-none focus:border-accent-red/50"
        />
      </label>
      <label className="block mb-1.5">
        <span className="text-text-muted">kind</span>
        <select
          value={kind}
          onChange={e => setKind(e.target.value as AliasKind)}
          className="w-full mt-0.5 bg-bg-surface border border-border rounded px-1.5 py-1
                     focus:outline-none focus:border-accent-red/50"
        >
          <option value="work_type">work_type</option>
          <option value="material">material</option>
          <option value="object">object</option>
        </select>
      </label>
      <label className="block mb-2">
        <span className="text-text-muted">canonical_code</span>
        <input
          type="text"
          value={canonicalCode}
          onChange={e => setCanonicalCode(e.target.value)}
          placeholder={placeholderByKind[kind]}
          className="w-full mt-0.5 bg-bg-surface border border-border rounded px-1.5 py-1 font-mono
                     focus:outline-none focus:border-accent-red/50"
        />
      </label>
      {saveMutation.isError && (
        <p className="text-red-500 text-[11px] mb-1.5">{(saveMutation.error as Error)?.message}</p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button
          onClick={onClose}
          className="px-2 py-1 text-text-muted hover:text-text-primary"
        >
          Отмена
        </button>
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!canonicalCode.trim() || !aliasText.trim() || saveMutation.isPending}
          className="inline-flex items-center gap-1 bg-accent-red hover:bg-accent-burg text-white
                     px-2 py-1 rounded disabled:opacity-50"
        >
          <Check className="w-3 h-3" />
          {saveMutation.isPending ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}

function HighlightedRaw({ text, parsed }: { text: string; parsed?: ParsedPayload | null }) {
  void parsed
  const dashMarkerRe = /^-\s*(.+?)\s*-$/
  const constrRe = /^-\s*(АД\s*[\d.]+(?:\s*№\s*\d+(?:\.\d+)?)?)\s*-$/i
  const vehicleRe = /^(.+?)\s*\(([^)]+)\);\s*(.+)$/
  const matRe = /^\/(.+?)\/\s*$/
  const pkLine = /ПК\s*\d+[+]\d/i

  const lines = text.split('\n')
  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
      {lines.map((line, i) => {
        let cls = ''
        if (constrRe.test(line)) cls = 'bg-pink-100 text-pink-900'
        else if (dashMarkerRe.test(line)) cls = 'bg-sky-100 text-sky-900'
        else if (matRe.test(line)) cls = 'bg-amber-100 text-amber-900'
        else if (vehicleRe.test(line)) cls = 'bg-emerald-100 text-emerald-900'
        else if (pkLine.test(line)) cls = 'bg-purple-100 text-purple-900'
        return (
          <div key={i} className={cls ? `${cls} px-1 rounded-sm` : ''}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}
