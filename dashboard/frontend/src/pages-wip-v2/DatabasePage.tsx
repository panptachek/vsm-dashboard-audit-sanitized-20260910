import { useMemo, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Boxes, Check, Database, KeyRound, Layers3, Link2, ListFilter, Plus, RefreshCw, Save, Search, Table2, Tags, Trash2, Truck, X } from 'lucide-react'
import { useAuth } from '../auth'
import { hasSettingsManagerRights } from '../access'
import {
  MAINLINE_FILL_STATUS_BY_KEY,
  MAINLINE_FILL_STATUS_DEFINITIONS,
  TEMP_ROAD_FILL_STATUS_DEFINITIONS,
  type MainlineFillStatusKey,
} from './fillStatusMeta'

type DbValue = string | number | boolean | null | Record<string, unknown> | unknown[]
type DbRow = Record<string, DbValue>

interface DbTable {
  name: string
  label: string
  rows: number
  editable: boolean
}

interface DbColumn {
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
}

interface DbRelation {
  constraint_name: string
  source_table: string
  source_column: string
  target_table: string
  target_column: string
  on_delete: string
}

interface DbSchema {
  table: string
  label: string
  primary_key: string[]
  columns: DbColumn[]
  foreign_keys: DbRelation[]
  incoming_refs: DbRelation[]
  indexes: { indexname: string; indexdef: string }[]
}

interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  diff: { column: string; before: DbValue; after: DbValue }[]
  before?: DbRow | null
  after?: DbRow | null
}

interface Suggestion {
  value: string
  label: string | null
  count: number
}

interface AliasRow {
  id: string
  canonical_code: string
  alias_text: string
  kind: 'work_type' | 'material' | 'object'
  notes: string | null
}

interface ReferenceNameRow {
  kind: 'object' | 'work_type' | 'material' | 'constructive' | 'object_type' | 'temporary_road'
  kind_label: string
  code: string
  name: string
  data?: DbRow
  table?: string
  code_column?: string
  name_column?: string
}

interface OverviewSectionRef {
  id: string
  code: string
  name: string
  sort_order: number | null
  boundary_kinds?: string | null
}

interface OverviewObject {
  id: string
  code: string
  name: string
  is_active: boolean
  comment?: string | null
  created_at?: string | null
  object_type_code: string
  object_type_name: string
  constructive_code?: string | null
  constructive_name?: string | null
  pk_label?: string | null
  sections: OverviewSectionRef[]
  project_item_count: number
  work_type_count: number
  work_tags?: string | null
}

interface OverviewObjectType {
  id: string
  code: string
  name: string
  sort_order: number | null
  is_active: boolean
  map_enabled: boolean
  work_accounting_enabled: boolean
  material_accounting_enabled: boolean
  is_linear: boolean
  accounting_note?: string | null
  created_at?: string | null
  object_count: number
  active_object_count: number
}

interface OverviewSection {
  id: string
  code: string
  name: string
  sort_order: number | null
  is_active: boolean
  map_color?: string | null
  created_at?: string | null
  boundaries: { boundary_kind: string; pk_label?: string | null }[]
}

interface OverviewWorkType {
  id: string
  code: string
  name: string
  default_unit: string
  created_at?: string | null
  analytics_tag?: string | null
  is_active: boolean
  show_in_timeline: boolean
  productivity_enabled: boolean
  project_item_count: number
  object_count: number
}

interface OverviewMaterial {
  id: string
  code: string
  name: string
  default_unit: string
  created_at?: string | null
  movement_count: number
  section_count: number
  movement_volume: number
  stockpile_count: number
}

interface OverviewTempRoad {
  id: string
  code: string
  name: string
  road_type?: string | null
  ad_start_pk?: number | null
  ad_end_pk?: number | null
  rail_start_pk?: number | null
  rail_end_pk?: number | null
  ad_pk_label?: string | null
  rail_pk_label?: string | null
  display_in_dashboard: boolean
  can_translate_to_rail: boolean
  comment?: string | null
  created_at?: string | null
  updated_at?: string | null
  section_id?: string | null
  section_code?: string | null
  section_name?: string | null
  status_segment_count: number
  latest_status_date?: string | null
  correction_count: number
  latest_correction_date?: string | null
}

type TempRoadStatusType = 'pioneer_fill' | 'subgrade_not_to_grade' | 'dso' | 'ready_for_shpgs' | 'shpgs_done' | 'no_work'

interface TempRoadCorrectionRoad {
  id: string
  code: string
  name: string
  effective_date?: string | null
  ad_pk_start?: number | null
  ad_pk_end?: number | null
  rail_pk_start?: number | null
  rail_pk_end?: number | null
  display_in_dashboard?: boolean | null
  display_locked?: boolean | null
  display_locked_reason?: string | null
  segments: Array<{ status_type: TempRoadStatusType; ad_pk_start?: number | null; ad_pk_end?: number | null; rail_pk_start?: number | null; rail_pk_end?: number | null }>
}

interface TempRoadCorrectionRow {
  id: string
  road_id: string
  road_code: string
  road_name: string
  effective_date: string
  action: string
  status_type: TempRoadStatusType
  input_pk_system: 'road' | 'rail' | 'both'
  road_pk_start?: number | null
  road_pk_end?: number | null
  rail_pk_start?: number | null
  rail_pk_end?: number | null
  comment?: string | null
  created_at?: string | null
}

interface MainlineFillSectionRow {
  section_id: string
  section_code: string
  section_name: string
  pk_start?: number | null
  pk_end?: number | null
  ranges?: Array<{ pk_start: number; pk_end: number }>
  effective_date?: string | null
  segments: Array<{ status_type: MainlineFillStatusKey; pk_start?: number | null; pk_end?: number | null }>
}

interface MainlineFillCorrectionRow {
  id: string
  section_id: string
  section_code: string
  section_name: string
  effective_date: string
  action: string
  status_type: MainlineFillStatusKey
  pk_start?: number | null
  pk_end?: number | null
  comment?: string | null
  created_at?: string | null
}

interface PileDeliveryDay {
  plan: number
  fact: number
}

interface PileDeliverySummaryRow {
  supplier: string
  spec_display: string
  spec_code?: string | null
  length_m?: number | null
  placement_side?: 'ns' | 'vs' | null
  days: Record<string, PileDeliveryDay>
  month_plan: number
  month_fact: number
}

interface PileDeliverySummaryPayload {
  available: boolean
  date: string
  month: string
  days: string[]
  rows: PileDeliverySummaryRow[]
  totals_by_day: Record<string, PileDeliveryDay>
  totals: {
    day_plan: number
    day_fact: number
    month_plan: number
    month_fact: number
    delta_day: number
    delta_month: number
  }
  legend: string[]
}

interface PileDeliverySpecOption {
  spec_code: string
  display_name: string
  length_m?: number | null
  placement_side?: 'ns' | 'vs' | null
}

interface PileDeliveryDatabaseRow {
  id: string
  delivery_date: string
  supplier_name: string
  supplier_code?: string | null
  raw_spec_text: string
  spec_code?: string | null
  spec_display: string
  length_m?: number | null
  placement_side?: 'ns' | 'vs' | null
  planned_qty: number
  actual_qty: number
  source_reference?: string | null
  comment?: string | null
  updated_at?: string | null
}

interface PileDeliveryDatabasePayload {
  available: boolean
  date: string
  specs_ready: boolean
  specs: PileDeliverySpecOption[]
  rows: PileDeliveryDatabaseRow[]
  totals: {
    day_plan: number
    day_fact: number
    row_count: number
  }
  summary: PileDeliverySummaryPayload
}

interface PileDeliveryDraftRow {
  localId: string
  supplier_name: string
  raw_spec_text: string
  planned_qty: string
  actual_qty: string
  source_reference: string
  comment: string
}

interface ReferenceOverviewData {
  summary: { key: string; label: string; count: number; active_count: number }[]
  objects: OverviewObject[]
  object_types: OverviewObjectType[]
  sections: OverviewSection[]
  work_types: OverviewWorkType[]
  materials: OverviewMaterial[]
  temporary_roads: OverviewTempRoad[]
}

interface WorkFilterOptions {
  tags: { name?: string; fact_count: number }[]
  object_types: unknown[]
  objects: unknown[]
  units: unknown[]
}

const REFERENCE_EDIT_FIELDS: Record<ReferenceNameRow['kind'], { key: string; label: string; kind?: 'text' | 'bool' }[]> = {
  object: [
    { key: 'object_type_code', label: 'Тип объекта' },
    { key: 'pk_start', label: 'ПК начало' },
    { key: 'pk_end', label: 'ПК конец' },
    { key: 'pk_raw_text', label: 'Пикетаж текстом' },
    { key: 'comment', label: 'Комментарий' },
    { key: 'is_active', label: 'Активен', kind: 'bool' },
  ],
  work_type: [
    { key: 'default_unit', label: 'Ед. изм.' },
    { key: 'analytics_tag', label: 'Тег аналитики' },
    { key: 'productivity_enabled', label: 'Учитывать в производительности', kind: 'bool' },
    { key: 'show_in_timeline', label: 'Показывать в таймлайне', kind: 'bool' },
    { key: 'is_active', label: 'Активен', kind: 'bool' },
  ],
  material: [
    { key: 'default_unit', label: 'Ед. изм.' },
  ],
  constructive: [
    { key: 'object_code', label: 'Объект' },
    { key: 'comment', label: 'Комментарий' },
    { key: 'is_active', label: 'Активен', kind: 'bool' },
  ],
  object_type: [
    { key: 'map_enabled', label: 'Показывать на карте', kind: 'bool' },
    { key: 'work_accounting_enabled', label: 'Учет работ', kind: 'bool' },
    { key: 'material_accounting_enabled', label: 'Учет материалов', kind: 'bool' },
    { key: 'is_linear', label: 'Линейный объект', kind: 'bool' },
    { key: 'accounting_note', label: 'Комментарий' },
    { key: 'is_active', label: 'Активен', kind: 'bool' },
  ],
  temporary_road: [
    { key: 'section_code', label: 'Участок' },
    { key: 'ad_start_pk', label: 'АД ПК начало' },
    { key: 'ad_end_pk', label: 'АД ПК конец' },
    { key: 'rail_start_pk', label: 'ВСЖМ ПК начало' },
    { key: 'rail_end_pk', label: 'ВСЖМ ПК конец' },
    { key: 'display_in_dashboard', label: 'Проектная а/д', kind: 'bool' },
    { key: 'can_translate_to_rail', label: 'Перевод AD↔ВСЖМ', kind: 'bool' },
    { key: 'road_type', label: 'Тип дороги' },
    { key: 'comment', label: 'Комментарий' },
  ],
}

interface EditState {
  row: DbRow
  column: DbColumn
  rawValue: string
  validation?: ValidationResult
  error?: string
  pkOverride?: boolean
}

const PROTECTED_COLUMNS = new Set(['created_at', 'updated_at', 'approved_at'])
const MACHINE_COLUMN_RE = /(^id$|_id$|^code$|_code$|^work_group$|review_tag|created_at|updated_at|approved_at|source_reference)/i

function isReadableColumn(columnName: string): boolean {
  return !MACHINE_COLUMN_RE.test(columnName)
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(data.detail || res.statusText)
  }
  return res.json()
}

function stringifyCell(value: DbValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function displayCell(value: DbValue, columnName?: string): string {
  if (columnName && isPkColumn(columnName)) {
    const parsed = parsePkForUi(value as string | number | null | undefined)
    if (parsed !== null) {
      const formatted = formatPkForUi(parsed)
      return formatted.length > 90 ? `${formatted.slice(0, 90)}...` : formatted || '—'
    }
  }
  const text = stringifyCell(value)
  return text.length > 90 ? `${text.slice(0, 90)}...` : text || '—'
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '0'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(value))
}

function defaultFillCorrectionDate(): string {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return date.toISOString().slice(0, 10)
}

function pileDeliveryMonthLabel(value?: string | null): string {
  if (!value) return '—'
  const [year, month] = value.split('-')
  const monthIndex = Number(month) - 1
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
  if (!Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return value
  return `${names[monthIndex]} ${year}`
}

function pileDeliveryDraftId(): string {
  return `pile-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

function pileDeliveryDraftQty(value?: number | null): string {
  if (value === null || value === undefined) return ''
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-9) return ''
  return Number.isInteger(numeric) ? String(numeric) : String(numeric)
}

function createPileDeliveryDraftRow(row?: Partial<PileDeliveryDatabaseRow>): PileDeliveryDraftRow {
  return {
    localId: row?.id || pileDeliveryDraftId(),
    supplier_name: row?.supplier_name || '',
    raw_spec_text: row?.raw_spec_text || row?.spec_display || '',
    planned_qty: pileDeliveryDraftQty(row?.planned_qty),
    actual_qty: pileDeliveryDraftQty(row?.actual_qty),
    source_reference: row?.source_reference || 'dashboard',
    comment: row?.comment || '',
  }
}

function parsePileDeliveryQtyInput(value: string): number {
  const text = value.trim()
  if (!text) return 0
  const numeric = Number(text.replace(',', '.'))
  return Number.isFinite(numeric) ? numeric : 0
}

function pileDeliveryComparableRows(rows: PileDeliveryDraftRow[]): string {
  return JSON.stringify(rows.map(row => ({
    supplier_name: row.supplier_name.trim(),
    raw_spec_text: row.raw_spec_text.trim(),
    planned_qty: row.planned_qty.trim(),
    actual_qty: row.actual_qty.trim(),
    source_reference: row.source_reference.trim(),
    comment: row.comment.trim(),
  })))
}

function relationNumber(value: DbValue | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function relationText(value: DbValue | undefined): string {
  return displayCell((value ?? null) as DbValue)
}

function relationRawText(value: DbValue | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function formatRelationDate(value: DbValue | undefined): string {
  if (!value) return '—'
  const raw = String(value)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('ru-RU').format(parsed)
}

function formatRelationDateTime(value: DbValue | undefined): string {
  if (!value) return '—'
  const raw = String(value)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(parsed)
}

function referenceCreatedAtSortValue(value?: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function relationShiftLabel(value: DbValue | undefined): string {
  const key = String(value ?? '')
  if (key === 'day') return 'День'
  if (key === 'night') return 'Ночь'
  return key || '—'
}

function relationStatusLabel(value: DbValue | undefined): string {
  const key = String(value ?? '')
  if (key === 'approved') return 'Подтвержден'
  if (key === 'confirmed') return 'Внесен'
  if (key === 'pending_review') return 'На проверке'
  return key || '—'
}

function relationLaborLabel(value: DbValue | undefined): string {
  const key = String(value ?? '')
  if (key === 'own') return 'ЖДС'
  if (key === 'hired') return 'Наемные'
  if (key === 'mixed') return 'Смешанные'
  return key || '—'
}

function textMatches(query: string, values: Array<string | number | boolean | null | undefined>): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return values.some(value => String(value ?? '').toLowerCase().includes(needle))
}

function compactSections(sections: OverviewSectionRef[]): string {
  if (!sections.length) return '—'
  return sections.map(section => section.code.replace(/^UCH_/, 'Уч. ')).join(', ')
}

function statusText(active: boolean): string {
  return active ? 'активен' : 'выкл.'
}


const PK_VALUE_COLUMN_RE = /(^|_)(pk|пк)(_|$)|pk_(?:start|end|raw)|(?:rail|road|ad)_pk|(?:start|end)_pk/i

function isPkColumn(columnName: string): boolean {
  return PK_VALUE_COLUMN_RE.test(columnName)
}

function parsePkForUi(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? (Math.abs(value) < 10000 ? value * 100 : value) : null
  const raw = String(value).trim().replace(/ё/g, 'е')
  if (!raw) return null
  const normalized = raw.replace(',', '.')
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const num = Number(normalized)
    return Number.isFinite(num) ? (Math.abs(num) < 10000 ? num * 100 : num) : null
  }
  const matches = Array.from(raw.matchAll(/(?:п\s*\.?\s*к\s*\.?\s*(?:[А-ЯA-Z]{1,8}\s*)?(?:[:：]\s*)?)?(\d{1,5})(?:\s*\+\s*(\d{1,3}(?:[,.]\d+)?))?/gi))
    .filter(match => /п\s*\.?\s*к/i.test(match[0]) || raw.includes('+'))
  const match = matches[0]
  if (!match) return null
  const picket = Number(match[1])
  const plus = Number(String(match[2] || '0').replace(',', '.'))
  if (!Number.isFinite(picket) || !Number.isFinite(plus)) return null
  return picket * 100 + plus
}

function formatPkForUi(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  const pk = Math.floor(value / 100)
  const plus = value - pk * 100
  const plusText = Number.isInteger(plus)
    ? String(plus).padStart(2, '0')
    : plus.toFixed(2).replace('.', ',')
  return `ПК${pk}+${plusText}`
}

function validatePkForUi(value: string | number | null | undefined, columnName = ''): { status: 'empty' | 'ok' | 'warning' | 'error'; message?: string } {
  const raw = value === null || value === undefined ? '' : String(value).trim()
  if (!raw) return { status: 'empty' }
  const parsed = parsePkForUi(value)
  const textOnly = /raw|text|label/i.test(columnName)
  if (parsed === null) {
    return {
      status: textOnly ? 'warning' : 'error',
      message: textOnly
        ? 'Пикетаж останется текстом; проверь формат вручную или включи override.'
        : 'Не смог распознать пикетаж для числового поля. Введи ПК2702+00 или 270200.',
    }
  }
  const label = formatPkForUi(parsed)
  if (/^\d+(?:[,.]\d+)?$/.test(raw)) {
    const num = Number(raw.replace(',', '.'))
    if (Number.isFinite(num) && Math.abs(num) < 10000) {
      return { status: 'warning', message: `Голое число будет сохранено как ${label}. Если это осознанно — включи override.` }
    }
    return { status: 'warning', message: `Похоже на внутренний формат БД; человеку читается как ${label}. Можно оставить через override.` }
  }
  return { status: 'ok', message: `Будет сохранено как ${label}` }
}

function hasUnacknowledgedPkWarning(value: string | number | null | undefined, columnName: string, override?: boolean): boolean {
  if (!isPkColumn(columnName)) return false
  const check = validatePkForUi(value, columnName)
  return (check.status === 'warning' || check.status === 'error') && !override
}

function PkSoftHint({
  value,
  columnName,
  override,
  onOverrideChange,
}: {
  value: string | number | null | undefined
  columnName: string
  override?: boolean
  onOverrideChange: (value: boolean) => void
}) {
  if (!isPkColumn(columnName)) return null
  const check = validatePkForUi(value, columnName)
  if (check.status === 'empty') return null
  if (check.status === 'ok') return <Message tone="info" text={check.message || ''} />
  const hard = check.status === 'error' && !/raw|text|label/i.test(columnName)
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${hard ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
      <div>{check.message}</div>
      {!hard && (
        <label className="mt-1 inline-flex items-center gap-1.5 font-semibold">
          <input type="checkbox" checked={Boolean(override)} onChange={e => onOverrideChange(e.target.checked)} />
          override: сохранить осознанно
        </label>
      )}
    </div>
  )
}

function coerceValue(column: DbColumn, value: string): DbValue {
  if (value.trim() === '') return null
  const type = `${column.data_type} ${column.udt_name}`.toLowerCase()
  if (type.includes('bool')) return ['true', '1', 'yes', 'да'].includes(value.trim().toLowerCase())
  if (type.includes('int') || type.includes('numeric') || type.includes('double') || type.includes('real')) {
    if (isPkColumn(column.column_name)) {
      const pk = parsePkForUi(value)
      if (pk !== null) return pk
    }
    const num = Number(value.replace(',', '.'))
    return Number.isFinite(num) ? num : value
  }
  if (type.includes('json')) return JSON.parse(value)
  return value
}

function Section(props: { title: string; icon?: ComponentType<{ className?: string }>; children: ReactNode; right?: ReactNode }) {
  const Icon = props.icon
  return (
    <section className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-4 py-3 border-b border-border flex items-center gap-3">
        {Icon && <Icon className="w-4 h-4 text-accent-red" />}
        <h2 className="text-[15px] font-heading font-bold text-text-primary flex-1">{props.title}</h2>
        {props.right}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  )
}

export default function DatabasePage() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [selectedTable, setSelectedTable] = useState<string>('')
  const [edit, setEdit] = useState<EditState | null>(null)

  const tablesQuery = useQuery({
    queryKey: ['db-admin-tables'],
    queryFn: () => apiJson<{ tables: DbTable[] }>('/api/db-admin/tables'),
  })

  const activeTable = selectedTable || tablesQuery.data?.tables[0]?.name || ''

  const schemaQuery = useQuery({
    queryKey: ['db-admin-schema', activeTable],
    queryFn: () => apiJson<DbSchema>(`/api/db-admin/tables/${activeTable}/schema`),
    enabled: Boolean(activeTable),
  })

  const rowsQuery = useQuery({
    queryKey: ['db-admin-rows', activeTable],
    queryFn: () => apiJson<{ rows: DbRow[]; limit: number; offset: number }>(`/api/db-admin/tables/${activeTable}/rows?limit=150`),
    enabled: Boolean(activeTable),
  })

  const validateMutation = useMutation({
    mutationFn: async (state: EditState) => {
      const schema = schemaQuery.data
      if (!schema) throw new Error('Схема не загружена')
      const value = coerceValue(state.column, state.rawValue)
      const pk = Object.fromEntries(schema.primary_key.map(col => [col, state.row[col]]))
      return apiJson<ValidationResult>(`/api/db-admin/tables/${activeTable}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', pk, values: { [state.column.column_name]: value } }),
      })
    },
    onSuccess: data => setEdit(prev => prev ? { ...prev, validation: data, error: undefined } : prev),
    onError: error => setEdit(prev => prev ? { ...prev, error: (error as Error).message } : prev),
  })

  const applyMutation = useMutation({
    mutationFn: async (state: EditState) => {
      const schema = schemaQuery.data
      if (!schema) throw new Error('Схема не загружена')
      const value = coerceValue(state.column, state.rawValue)
      const pk = Object.fromEntries(schema.primary_key.map(col => [col, state.row[col]]))
      return apiJson<ValidationResult>(`/api/db-admin/tables/${activeTable}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          pk,
          values: { [state.column.column_name]: value },
          confirmed: true,
          changed_by: 'dashboard',
        }),
      })
    },
    onSuccess: () => {
      setEdit(null)
      qc.invalidateQueries({ queryKey: ['db-admin-rows', activeTable] })
      qc.invalidateQueries({ queryKey: ['db-admin-tables'] })
    },
    onError: error => setEdit(prev => prev ? { ...prev, error: (error as Error).message } : prev),
  })

  const schema = schemaQuery.data
  const rows = rowsQuery.data?.rows ?? []
  const readableColumns = schema?.columns.filter(col => isReadableColumn(col.column_name)) ?? []
  const selected = tablesQuery.data?.tables.find(t => t.name === activeTable)
  const tableEditable = Boolean(selected?.editable)
  const sectionScope = typeof edit?.row.section_id === 'string' ? edit.row.section_id : ''

  const suggestionsQuery = useQuery({
    queryKey: ['db-admin-suggestions', activeTable, edit?.column.column_name, sectionScope],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '30' })
      if (sectionScope) params.set('section_id', sectionScope)
      return apiJson<{ suggestions: Suggestion[] }>(
        `/api/db-admin/tables/${activeTable}/columns/${edit?.column.column_name}/suggestions?${params.toString()}`,
      )
    },
    enabled: Boolean(edit && activeTable),
    staleTime: 30_000,
  })

  const editableColumns = useMemo(() => {
    if (!schema || !tableEditable || !isAdmin) return new Set<string>()
    return new Set(
      schema.columns
        .filter(col => !schema.primary_key.includes(col.column_name) && !PROTECTED_COLUMNS.has(col.column_name))
        .map(col => col.column_name),
    )
  }, [schema, tableEditable, isAdmin])

  function beginEdit(row: DbRow, column: DbColumn) {
    if (!isAdmin || !editableColumns.has(column.column_name)) return
    setEdit({ row, column, rawValue: stringifyCell(row[column.column_name]) })
  }

  return (
    <div className="p-4 md:p-6 pb-24 space-y-5">
      <div className="flex items-center gap-3">
        <Database className="w-6 h-6 text-accent-red" />
        <div className="flex-1">
          <h1 className="font-heading text-2xl font-bold text-text-primary">База данных</h1>
          <p className="text-sm text-text-muted mt-0.5">Ручные корректировки с предварительной проверкой</p>
        </div>
        <button
          type="button"
          onClick={() => {
            qc.invalidateQueries({ queryKey: ['db-admin-tables'] })
            qc.invalidateQueries({ queryKey: ['db-admin-schema', activeTable] })
            qc.invalidateQueries({ queryKey: ['db-admin-rows', activeTable] })
            qc.invalidateQueries({ queryKey: ['db-admin-reference-overview'] })
            qc.invalidateQueries({ queryKey: ['db-admin-reference-names'] })
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold border border-border bg-white hover:bg-bg-surface"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Обновить
        </button>
      </div>

      <ReferenceOverview />

      <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-5">
        <Section title="Таблицы" icon={Database}>
          {tablesQuery.isLoading && <div className="text-sm text-text-muted">Загрузка...</div>}
          {tablesQuery.isError && <div className="text-sm text-red-600">{(tablesQuery.error as Error).message}</div>}
          <div className="space-y-1">
            {tablesQuery.data?.tables.map(table => (
              <button
                key={table.name}
                type="button"
                onClick={() => {
                  setSelectedTable(table.name)
                  setEdit(null)
                }}
                className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
                  activeTable === table.name
                    ? 'border-accent-red bg-red-50 text-text-primary'
                    : 'border-transparent hover:border-border hover:bg-bg-surface text-text-secondary'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="text-[13px] font-semibold flex-1">{table.label}</div>
                  {!table.editable && (
                    <span className="text-[9px] uppercase tracking-wide border border-border rounded px-1.5 py-0.5 text-text-muted">
                      просмотр
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-text-muted">{table.name} · {table.rows}</div>
              </button>
            ))}
          </div>
        </Section>

        <div className="space-y-5 min-w-0">
          <Section
            title={selected ? `${selected.label} · ${selected.name}` : 'Таблица'}
            icon={KeyRound}
            right={schema && (
              <div className="flex items-center gap-2">
                {!tableEditable && (
                  <span className="text-[10px] uppercase tracking-wide border border-border rounded px-1.5 py-0.5 text-text-muted">
                    только чтение
                  </span>
                )}
                <span className="text-[11px] font-mono text-text-muted">
                  PK: {schema.primary_key.join(', ') || '—'}
                </span>
              </div>
            )}
          >
            {schemaQuery.isLoading && <div className="text-sm text-text-muted">Загрузка схемы...</div>}
            {schemaQuery.isError && <div className="text-sm text-red-600">{(schemaQuery.error as Error).message}</div>}
            {schema && (
              <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="bg-bg-surface text-text-muted uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="text-left py-2 px-2 font-semibold">Колонка</th>
                        <th className="text-left py-2 px-2 font-semibold">Тип</th>
                        <th className="text-left py-2 px-2 font-semibold">Null</th>
                        <th className="text-left py-2 px-2 font-semibold">Default</th>
                      </tr>
                    </thead>
                    <tbody>
                      {readableColumns.map(col => (
                        <tr key={col.column_name} className="border-b border-border/60">
                          <td className="py-1.5 px-2 font-mono text-text-primary">
                            {col.column_name}
                            {schema.primary_key.includes(col.column_name) && <span className="ml-1 text-accent-red">PK</span>}
                          </td>
                          <td className="py-1.5 px-2 text-text-secondary">{col.data_type}</td>
                          <td className="py-1.5 px-2 text-text-secondary">{col.is_nullable}</td>
                          <td className="py-1.5 px-2 text-text-muted font-mono max-w-[360px] break-words">{col.column_default || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3">
                  <RelationList title="Исходящие связи" relations={schema.foreign_keys} />
                  <RelationList title="Входящие связи" relations={schema.incoming_refs} />
                </div>
              </div>
            )}
          </Section>

          <Section title="Данные" icon={Database}>
            {rowsQuery.isLoading && <div className="text-sm text-text-muted">Загрузка строк...</div>}
            {rowsQuery.isError && <div className="text-sm text-red-600">{(rowsQuery.error as Error).message}</div>}
            {schema && (
              <div className="overflow-auto max-h-[68vh] border border-border rounded-lg">
                <table className="w-full text-[12px] font-mono">
                  <thead className="bg-bg-surface sticky top-0 z-10">
                    <tr className="text-text-muted text-left">
                      {readableColumns.map(col => (
                        <th key={col.column_name} className="px-2 py-2 font-semibold whitespace-nowrap border-b border-border">
                          {col.column_name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={schema.primary_key.map(col => stringifyCell(row[col])).join('|') || rowIndex} className="border-b border-border/50 hover:bg-bg-surface/70">
                        {readableColumns.map(col => {
                          const editable = editableColumns.has(col.column_name)
                          return (
                            <td
                              key={col.column_name}
                              onDoubleClick={() => beginEdit(row, col)}
                              className={`px-2 py-1.5 align-top min-w-[120px] max-w-[260px] ${
                                editable ? 'cursor-text text-text-primary' : 'text-text-muted bg-neutral-50/60'
                              }`}
                              title={editable ? 'Двойной клик для редактирования' : undefined}
                            >
                              <span className="block break-words">{displayCell(row[col.column_name], col.column_name)}</span>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <div className="p-4 text-sm text-text-muted">Нет строк</div>}
              </div>
            )}
          </Section>
        </div>
      </div>

      <PileDeliveryDatabaseSection />
      <TempRoadFillCorrectionsSection />

      {edit && (
        <div className="fixed inset-0 z-[80] bg-black/30 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl border border-border">
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
              <Save className="w-4 h-4 text-accent-red" />
              <div className="flex-1">
                <div className="text-sm font-heading font-bold text-text-primary">{activeTable}.{edit.column.column_name}</div>
                <div className="text-[11px] text-text-muted">{edit.column.data_type}</div>
              </div>
              <button type="button" onClick={() => setEdit(null)} className="p-1.5 rounded hover:bg-bg-surface">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {suggestionsQuery.data?.suggestions.length ? (
                <select
                  value=""
                  onChange={e => {
                    if (!e.target.value) return
                    setEdit(prev => prev ? {
                      ...prev,
                      rawValue: e.target.value,
                      validation: undefined,
                      error: undefined,
                    } : prev)
                  }}
                  className="w-full border border-border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-accent-red"
                >
                  <option value="">Популярные значения{sectionScope ? ' по участку' : ''}</option>
                  {suggestionsQuery.data.suggestions.map(item => (
                    <option key={`${item.value}:${item.count}`} value={item.value}>
                      {(item.label || item.value) === item.value
                        ? `${item.value} · ${item.count}`
                        : `${item.label} · ${item.value} · ${item.count}`}
                    </option>
                  ))}
                </select>
              ) : null}
              <textarea
                value={edit.rawValue}
                onChange={e => setEdit(prev => prev ? { ...prev, rawValue: e.target.value, validation: undefined, error: undefined, pkOverride: false } : prev)}
                rows={6}
                className={`w-full border rounded-md p-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-red ${hasUnacknowledgedPkWarning(edit.rawValue, edit.column.column_name, edit.pkOverride) ? 'border-amber-300 bg-amber-50/40' : 'border-border'}`}
              />
              <PkSoftHint
                value={edit.rawValue}
                columnName={edit.column.column_name}
                override={edit.pkOverride}
                onOverrideChange={checked => setEdit(prev => prev ? { ...prev, pkOverride: checked } : prev)}
              />
              {edit.error && <Message tone="error" text={edit.error} />}
              {edit.validation?.errors.map(err => <Message key={err} tone="error" text={err} />)}
              {edit.validation?.warnings.map(warn => <Message key={warn} tone="warning" text={warn} />)}
              {edit.validation?.ok && (
                <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 flex items-start gap-2">
                  <Check className="w-3.5 h-3.5 mt-0.5" />
                  Проверка пройдена, изменение можно сохранить.
                </div>
              )}
              {edit.validation?.diff.length ? (
                <div className="border border-border rounded-md overflow-hidden">
                  <table className="w-full text-[12px] font-mono">
                    <tbody>
                      {edit.validation.diff.map(item => (
                        <tr key={item.column} className="border-b last:border-0 border-border">
                          <td className="px-2 py-1.5 text-text-muted">{item.column}</td>
                          <td className="px-2 py-1.5 text-red-700 bg-red-50">{displayCell(item.before, item.column)}</td>
                          <td className="px-2 py-1.5 text-green-700 bg-green-50">{displayCell(item.after, item.column)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
            <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
              <button
                type="button"
                onClick={() => validateMutation.mutate(edit)}
                disabled={validateMutation.isPending || applyMutation.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold border border-border bg-white hover:bg-bg-surface disabled:opacity-50"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                Проверить
              </button>
              <button
                type="button"
                onClick={() => applyMutation.mutate(edit)}
                disabled={!edit.validation?.ok || hasUnacknowledgedPkWarning(edit.rawValue, edit.column.column_name, edit.pkOverride) || validateMutation.isPending || applyMutation.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-accent-red text-white hover:bg-accent-burg disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {applyMutation.isPending ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PileDeliveryDatabaseEditor({
  deliveryDate,
  rows,
  specs,
  summary,
  available,
  isAdmin,
}: {
  deliveryDate: string
  rows: PileDeliveryDatabaseRow[]
  specs: PileDeliverySpecOption[]
  summary: PileDeliverySummaryPayload
  available: boolean
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const initialRows = useMemo(() => rows.map(row => createPileDeliveryDraftRow(row)), [rows])
  const [draftRows, setDraftRows] = useState<PileDeliveryDraftRow[]>(() => initialRows)
  const initialRowsKey = useMemo(() => pileDeliveryComparableRows(initialRows), [initialRows])
  const draftRowsKey = useMemo(() => pileDeliveryComparableRows(draftRows), [draftRows])
  const hasChanges = initialRowsKey !== draftRowsKey
  const draftDayPlan = useMemo(() => draftRows.reduce((sum, row) => sum + parsePileDeliveryQtyInput(row.planned_qty), 0), [draftRows])
  const draftDayFact = useMemo(() => draftRows.reduce((sum, row) => sum + parsePileDeliveryQtyInput(row.actual_qty), 0), [draftRows])
  const specInfoByName = useMemo(
    () => new Map(specs.map(spec => [spec.display_name.trim().toUpperCase(), spec])),
    [specs],
  )

  const saveMutation = useMutation({
    mutationFn: () => apiJson<{ ok: boolean; date: string; saved: number }>('/api/wip/database/pile-deliveries', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delivery_date: deliveryDate,
        rows: draftRows
          .filter(row => row.supplier_name.trim() || row.raw_spec_text.trim() || row.planned_qty.trim() || row.actual_qty.trim() || row.comment.trim())
          .map(row => ({
            supplier_name: row.supplier_name.trim(),
            raw_spec_text: row.raw_spec_text.trim(),
            planned_qty: parsePileDeliveryQtyInput(row.planned_qty),
            actual_qty: parsePileDeliveryQtyInput(row.actual_qty),
            source_reference: row.source_reference.trim() || 'dashboard',
            comment: row.comment.trim() || null,
          })),
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-pile-deliveries'] })
      qc.invalidateQueries({ queryKey: ['pile-deliveries-summary'] })
    },
  })

  const updateRow = (localId: string, field: keyof PileDeliveryDraftRow, value: string) => {
    setDraftRows(current => current.map(row => (row.localId === localId ? { ...row, [field]: value } : row)))
  }

  const addRow = () => {
    setDraftRows(current => [...current, createPileDeliveryDraftRow()])
  }

  const removeRow = (localId: string) => {
    setDraftRows(current => current.filter(row => row.localId !== localId))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text-primary hover:bg-bg-surface"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить строку
        </button>
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={!isAdmin || !available || saveMutation.isPending || !hasChanges}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-burg disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {saveMutation.isPending ? 'Сохранение...' : 'Сохранить день'}
        </button>
      </div>

      {saveMutation.isError && <Message tone="error" text={(saveMutation.error as Error).message} />}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-border bg-bg-surface/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">План на день</div>
          <div className="mt-1 text-xl font-heading font-semibold text-text-primary">{formatNumber(draftDayPlan)}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-surface/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Факт на день</div>
          <div className="mt-1 text-xl font-heading font-semibold text-text-primary">{formatNumber(draftDayFact)}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-surface/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">План за месяц</div>
          <div className="mt-1 text-xl font-heading font-semibold text-text-primary">{formatNumber(summary?.totals.month_plan)}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-surface/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Факт за месяц</div>
          <div className="mt-1 text-xl font-heading font-semibold text-text-primary">{formatNumber(summary?.totals.month_fact)}</div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-[980px] w-full text-[12px]">
          <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-2 py-2 text-left font-semibold">Поставщик</th>
              <th className="px-2 py-2 text-left font-semibold">Типоразмер</th>
              <th className="px-2 py-2 text-left font-semibold">План, шт</th>
              <th className="px-2 py-2 text-left font-semibold">Факт, шт</th>
              <th className="px-2 py-2 text-left font-semibold">Комментарий</th>
              <th className="px-2 py-2 text-right font-semibold">Действие</th>
            </tr>
          </thead>
          <tbody>
            {draftRows.map(row => {
              const specInfo = specInfoByName.get(row.raw_spec_text.trim().toUpperCase())
              return (
                <tr key={row.localId} className="border-b border-border/60 align-top">
                  <td className="px-2 py-2">
                    <input
                      value={row.supplier_name}
                      onChange={e => updateRow(row.localId, 'supplier_name', e.target.value)}
                      placeholder="МС-11 / ПСК"
                      className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      value={row.raw_spec_text}
                      onChange={e => updateRow(row.localId, 'raw_spec_text', e.target.value)}
                      placeholder="12 м НС / 21 м"
                      list="pile-delivery-specs"
                      className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
                    />
                    <div className="mt-1 text-[10px] text-text-muted">
                      {specInfo
                        ? `${specInfo.spec_code}${specInfo.placement_side ? ` · ${specInfo.placement_side.toUpperCase()}` : ''}`
                        : 'Можно ввести произвольный текст, если справочник еще не знает типоразмер'}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.planned_qty}
                      onChange={e => updateRow(row.localId, 'planned_qty', e.target.value)}
                      placeholder="0"
                      className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.actual_qty}
                      onChange={e => updateRow(row.localId, 'actual_qty', e.target.value)}
                      placeholder="0"
                      className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      value={row.comment}
                      onChange={e => updateRow(row.localId, 'comment', e.target.value)}
                      placeholder="Необязательно"
                      className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeRow(row.localId)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-red-600"
                      title="Убрать строку"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              )
            })}
            {draftRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-text-muted">
                  По выбранной дате строк пока нет. Нажми «Добавить строку», чтобы внести первую поставку.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <datalist id="pile-delivery-specs">
        {specs.map(spec => (
          <option key={spec.spec_code} value={spec.display_name}>{spec.spec_code}</option>
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        <span>Строк в дне: {draftRows.length}</span>
        <span>•</span>
        <span>В блоке отчета показываются те же месячные итоги и дневные строки.</span>
        {hasChanges && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">Есть несохраненные изменения</span>}
      </div>
    </div>
  )
}

function PileDeliveryDatabaseSection() {
  const { isAdmin } = useAuth()
  const [deliveryDate, setDeliveryDate] = useState(defaultFillCorrectionDate())

  const dataQuery = useQuery({
    queryKey: ['db-admin-pile-deliveries', deliveryDate],
    queryFn: () => apiJson<PileDeliveryDatabasePayload>(`/api/wip/database/pile-deliveries?date=${deliveryDate}`),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })

  const summary = dataQuery.data?.summary
  const specs = useMemo(() => dataQuery.data?.specs ?? [], [dataQuery.data?.specs])

  return (
    <Section
      title="Поставка свай"
      icon={Truck}
      right={(
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
          {summary?.month && <span className="rounded-full border border-border px-2 py-0.5">Месяц: {pileDeliveryMonthLabel(summary.month)}</span>}
          <span className="rounded-full border border-border px-2 py-0.5">Дата: {formatDbDate(deliveryDate)}</span>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="text-sm text-text-secondary">
              Ручной ввод для блока <span className="font-semibold text-text-primary">«Поставка свай»</span> на странице участков усиления.
              Одна строка = один поставщик одного типоразмера свай на выбранную дату.
            </div>
            {!isAdmin && <Message tone="warning" text="Сохранять данные по поставке свай может только администратор." />}
            {dataQuery.data && !dataQuery.data.specs_ready && (
              <Message tone="warning" text="Справочник pile_delivery_specs еще не заполнен: можно вносить сырой текст типоразмера, но подсказок по плотности/стороне пока не будет." />
            )}
            {dataQuery.data && !dataQuery.data.available && (
              <Message tone="warning" text="Таблица pile_delivery_calendar еще не применена в БД. Раздел станет рабочим после миграции." />
            )}
          </div>
          <label className="text-[11px] text-text-muted">
            Дата поставки
            <input
              type="date"
              value={deliveryDate}
              onChange={e => setDeliveryDate(e.target.value)}
              className="mt-1 block rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary"
            />
          </label>
        </div>

        {dataQuery.isLoading && <div className="text-sm text-text-muted">Загрузка поставки свай...</div>}
        {dataQuery.isError && <Message tone="error" text={(dataQuery.error as Error).message} />}

        {dataQuery.data && (
          <PileDeliveryDatabaseEditor
            key={`${deliveryDate}:${dataQuery.dataUpdatedAt}`}
            deliveryDate={deliveryDate}
            rows={dataQuery.data.rows || []}
            specs={specs}
            summary={summary}
            available={dataQuery.data.available}
            isAdmin={isAdmin}
          />
        )}
      </div>
    </Section>
  )
}

const TEMP_ROAD_STATUS_LABELS: Record<TempRoadStatusType, string> = {
  pioneer_fill: 'Пионерка',
  subgrade_not_to_grade: 'ЗП в работе',
  dso: 'ДСО',
  ready_for_shpgs: 'Под ЩПГС',
  shpgs_done: 'ЩПГС уложен',
  no_work: 'Не в работе',
}

const TEMP_ROAD_STATUS_FIELDS = TEMP_ROAD_FILL_STATUS_DEFINITIONS.filter(item => item.key !== 'no_work') as Array<{ key: Exclude<TempRoadStatusType, 'no_work'>; label: string; shortLabel: string }>

function segmentRangesForStatus(
  segments: Array<{ status_type: string; ad_pk_start?: number | null; ad_pk_end?: number | null; rail_pk_start?: number | null; rail_pk_end?: number | null; pk_start?: number | null; pk_end?: number | null }>,
  statusType: string,
  coordinate: 'ad' | 'rail' | 'main' = 'ad',
): string {
  const ranges = segments
    .filter(segment => segment.status_type === statusType)
    .map(segment => {
      const start = coordinate === 'rail' ? segment.rail_pk_start : coordinate === 'main' ? segment.pk_start : segment.ad_pk_start
      const end = coordinate === 'rail' ? segment.rail_pk_end : coordinate === 'main' ? segment.pk_end : segment.ad_pk_end
      return formatPkRange(start ?? null, end ?? null)
    })
    .filter(Boolean)
  return ranges.length ? ranges.join('; ') : '—'
}

function formatDbDate(value?: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('ru-RU')
}

function formatPkPoint(value?: number | null): string {
  if (value === null || value === undefined) return ''
  const n = Math.round(Number(value) * 100) / 100
  if (!Number.isFinite(n)) return ''
  let pk = Math.floor(n / 100)
  let plus = Math.round((n - pk * 100) * 100) / 100
  if (plus >= 99.995) {
    pk += 1
    plus = 0
  }
  const plusText = Math.abs(plus - Math.round(plus)) < 0.005
    ? String(Math.round(plus)).padStart(2, '0')
    : plus.toFixed(2).replace('.', ',').replace(/0+$/, '').replace(/,$/, '').padStart(2, '0')
  return `ПК${pk}+${plusText}`
}

function formatPkRange(start?: number | null, end?: number | null): string {
  const startText = formatPkPoint(start)
  const endText = formatPkPoint(end)
  if (!startText || !endText) return '—'
  return startText === endText ? startText : `${startText}-${endText}`
}

function parseNullableNumber(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  if (/пк|\+/i.test(text)) {
    const match = text.replace(/\s+/g, '').match(/^(?:ПК)?(\d+)(?:\+(\d+(?:[,.]\d+)?))?$/i)
    if (!match) return null
    const pk = Number(match[1])
    const plus = Number((match[2] || '0').replace(',', '.'))
    return Number.isFinite(pk) && Number.isFinite(plus) ? pk * 100 + plus : null
  }
  const n = Number(text.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

type PkAllowedRange = { pk_start?: number | null; pk_end?: number | null }

function normalizedAllowedRanges(minValue?: number | null, maxValue?: number | null, ranges?: PkAllowedRange[]): Array<{ start: number; end: number }> {
  const fromRanges = (ranges || [])
    .filter(range => range.pk_start !== null && range.pk_start !== undefined && range.pk_end !== null && range.pk_end !== undefined)
    .map(range => ({ start: Math.min(Number(range.pk_start), Number(range.pk_end)), end: Math.max(Number(range.pk_start), Number(range.pk_end)) }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end))
  if (fromRanges.length) return fromRanges
  if (minValue !== null && minValue !== undefined && maxValue !== null && maxValue !== undefined) {
    return [{ start: Math.min(minValue, maxValue), end: Math.max(minValue, maxValue) }]
  }
  return []
}

function allowedRangesLabel(minValue?: number | null, maxValue?: number | null, ranges?: PkAllowedRange[]): string {
  return normalizedAllowedRanges(minValue, maxValue, ranges).map(range => formatPkRange(range.start, range.end)).join('; ')
}

function pkDraftTone(value: string, minValue?: number | null, maxValue?: number | null, ranges?: PkAllowedRange[]): string {
  const base = 'rounded-md border bg-white px-2 py-1.5 text-sm font-mono'
  if (!value.trim()) return `${base} border-border`
  const parsed = parseNullableNumber(value)
  if (parsed === null) return `${base} border-red-300 bg-red-50`
  const allowed = normalizedAllowedRanges(minValue, maxValue, ranges)
  if (allowed.length && !allowed.some(range => parsed >= range.start && parsed <= range.end)) return `${base} border-amber-300 bg-amber-50`
  return `${base} border-emerald-300 bg-emerald-50/50`
}

function pkDraftMessage(value: string, minValue?: number | null, maxValue?: number | null, ranges?: PkAllowedRange[]): string | null {
  if (!value.trim()) return null
  const parsed = parseNullableNumber(value)
  if (parsed === null) return 'ПК не распознан'
  const allowed = normalizedAllowedRanges(minValue, maxValue, ranges)
  if (allowed.length && !allowed.some(range => parsed >= range.start && parsed <= range.end)) return `ПК вне границ (${allowedRangesLabel(minValue, maxValue, ranges)})`
  return `Распознано: ${formatPkPoint(parsed)}`
}

function TempRoadFillCorrectionsSection() {
  const qc = useQueryClient()
  const { isAdmin, user } = useAuth()
  const canToggleRoadDisplay = Boolean(user && (isAdmin || hasSettingsManagerRights(user) || user.pages?.includes('/database')))
  const defaultDate = defaultFillCorrectionDate()
  const [roadId, setRoadId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(defaultDate)
  const [statusType, setStatusType] = useState<TempRoadStatusType>('ready_for_shpgs')
  const [roadPkStart, setRoadPkStart] = useState('')
  const [roadPkEnd, setRoadPkEnd] = useState('')
  const [railPkStart, setRailPkStart] = useState('')
  const [railPkEnd, setRailPkEnd] = useState('')
  const [comment, setComment] = useState('')
  const [editingRoadId, setEditingRoadId] = useState<string | null>(null)
  const [mode, setMode] = useState<'temp_roads' | 'mainline'>('temp_roads')

  const dataQuery = useQuery({
    queryKey: ['db-admin-temp-road-fill-corrections'],
    queryFn: () => apiJson<{ as_of: string; roads: TempRoadCorrectionRoad[]; corrections: TempRoadCorrectionRow[] }>('/api/wip/database/temp-road-fill-corrections'),
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: () => {
      const selectedRoadId = roadId || dataQuery.data?.roads[0]?.id || ''
      if (!selectedRoadId) throw new Error('Выберите временную дорогу')
      return apiJson<{ ok: boolean; id: string }>('/api/wip/database/temp-road-fill-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          road_id: selectedRoadId,
          effective_date: effectiveDate,
          status_type: statusType,
          action: statusType === 'no_work' ? 'clear_status' : 'set_status',
          input_pk_system: roadPkStart || roadPkEnd ? (railPkStart || railPkEnd ? 'both' : 'road') : 'rail',
          road_pk_start: parseNullableNumber(roadPkStart),
          road_pk_end: parseNullableNumber(roadPkEnd),
          rail_pk_start: parseNullableNumber(railPkStart),
          rail_pk_end: parseNullableNumber(railPkEnd),
          comment: comment.trim() || null,
        }),
      })
    },
    onSuccess: () => {
      setRoadPkStart('')
      setRoadPkEnd('')
      setRailPkStart('')
      setRailPkEnd('')
      setComment('')
      qc.invalidateQueries({ queryKey: ['db-admin-temp-road-fill-corrections'] })
      qc.invalidateQueries({ queryKey: ['wip', 'temp-roads'] })
      qc.invalidateQueries({ queryKey: ['wip', 'daily-summary'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiJson<{ ok: boolean }>(`/api/wip/database/temp-road-fill-corrections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-temp-road-fill-corrections'] })
      qc.invalidateQueries({ queryKey: ['wip', 'temp-roads'] })
      qc.invalidateQueries({ queryKey: ['wip', 'daily-summary'] })
    },
  })

  const displayMutation = useMutation({
    mutationFn: ({ roadId: targetRoadId, display }: { roadId: string; display: boolean }) => apiJson<{ ok: boolean }>(`/api/wip/database/temp-road-display/${targetRoadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_in_dashboard: display }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-temp-road-fill-corrections'] })
      qc.invalidateQueries({ queryKey: ['report-temp-roads'] })
      qc.invalidateQueries({ queryKey: ['wip', 'temp-roads'] })
      qc.invalidateQueries({ queryKey: ['wip', 'daily-summary'] })
    },
  })

  const roads = useMemo(() => dataQuery.data?.roads ?? [], [dataQuery.data?.roads])
  const corrections = useMemo(() => dataQuery.data?.corrections ?? [], [dataQuery.data?.corrections])
  const editingRoad = roads.find(road => road.id === editingRoadId)
  const selectedRoadCorrections = editingRoadId ? corrections.filter(row => row.road_id === editingRoadId) : []
  const latestDateByRoad = useMemo(() => {
    const result = new Map<string, string>()
    const putLatest = (roadKey: string, value?: string | null) => {
      const dateOnly = value?.slice(0, 10)
      if (!roadKey || !dateOnly) return
      const current = result.get(roadKey)
      if (!current || dateOnly > current) result.set(roadKey, dateOnly)
    }
    roads.forEach(road => putLatest(road.id, road.effective_date))
    corrections.forEach(row => {
      putLatest(row.road_id, row.effective_date)
      putLatest(row.road_id, row.created_at)
    })
    return result
  }, [roads, corrections])

  const openRoadEditor = (road: TempRoadCorrectionRoad) => {
    setRoadId(road.id)
    setEditingRoadId(road.id)
    setEffectiveDate(defaultFillCorrectionDate())
    setRoadPkStart('')
    setRoadPkEnd('')
    setRailPkStart('')
    setRailPkEnd('')
    setComment('')
  }

  return (
    <Section
      title="Данные по отсыпке"
      icon={Table2}
      right={<span className="text-[11px] font-mono text-text-muted">последние корректировки временных дорог</span>}
    >
      <div className="mb-4 inline-flex rounded-md border border-border bg-bg-surface p-1 text-xs">
        <button
          type="button"
          onClick={() => setMode('temp_roads')}
          className={`rounded px-3 py-1.5 font-semibold ${mode === 'temp_roads' ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
        >
          ВАД
        </button>
        <button
          type="button"
          onClick={() => setMode('mainline')}
          className={`rounded px-3 py-1.5 font-semibold ${mode === 'mainline' ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
        >
          ОХ
        </button>
      </div>
      {mode === 'mainline' ? (
        <MainlineFillCorrectionsPanel />
      ) : (
        <>
      {dataQuery.isLoading && <div className="text-sm text-text-muted">Загрузка данных по отсыпке...</div>}
      {dataQuery.isError && <Message tone="error" text={(dataQuery.error as Error).message} />}
      {displayMutation.error && <Message tone="error" text={(displayMutation.error as Error).message} />}
      {dataQuery.data && (
        <div className="space-y-4">
          {!canToggleRoadDisplay && (
            <Message tone="warning" text="Менять признак проектной а/д может пользователь с доступом к вкладке База данных." />
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-[1320px] w-full text-[12px]">
              <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-2 py-2 text-left font-semibold">Проектная а/д</th>
                  <th className="px-2 py-2 text-left font-semibold">АД</th>
                  <th className="px-2 py-2 text-left font-semibold">АД ПК</th>
                  {TEMP_ROAD_STATUS_FIELDS.map(field => (
                    <th key={field.key} className="px-2 py-2 text-left font-semibold">{field.shortLabel || field.label}</th>
                  ))}
                  <th className="px-2 py-2 text-left font-semibold">Последнее изменение</th>
                </tr>
              </thead>
              <tbody>
                {roads.map(road => {
                  const selected = editingRoadId === road.id
                  const lastDate = latestDateByRoad.get(road.id) || road.effective_date
                  const displayChecked = road.display_in_dashboard !== false
                  const displayDisabled = !canToggleRoadDisplay || displayMutation.isPending
                  const displayTitle = canToggleRoadDisplay
                    ? 'Проектная автодорога: считается как дорога во всех сводках и рисуется на главной. Снимите галочку для непроектного проезда.'
                    : 'Нужно право изменения данных по отсыпке'
                  return (
                    <tr
                      key={road.id}
                      onClick={() => openRoadEditor(road)}
                      className={`cursor-pointer border-b border-border/60 hover:bg-bg-surface/60 ${selected ? 'bg-red-50/50' : ''}`}
                    >
                      <td className="px-2 py-2">
                        <div className="inline-flex items-center gap-1.5" title={displayTitle}>
                          <input
                            type="checkbox"
                            checked={displayChecked}
                            disabled={displayDisabled}
                            onClick={event => event.stopPropagation()}
                            onChange={event => {
                              displayMutation.mutate({ roadId: road.id, display: event.target.checked })
                            }}
                            className="h-4 w-4 rounded border-border text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span className="text-[10px] font-semibold text-text-muted">{displayChecked ? 'проектная' : 'непроектный проезд'}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 font-semibold text-text-primary">{road.code}<div className="font-normal text-text-muted">{road.name}</div></td>
                      <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(road.ad_pk_start, road.ad_pk_end)}</td>
                      {TEMP_ROAD_STATUS_FIELDS.map(field => (
                        <td key={field.key} className="max-w-[190px] px-2 py-2 align-top font-mono text-[11px] text-text-secondary">
                          {segmentRangesForStatus(road.segments, field.key, 'ad')}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-text-secondary">{formatDbDate(lastDate)}</td>
                    </tr>
                  )
                })}
                {roads.length === 0 && (
                  <tr><td colSpan={TEMP_ROAD_STATUS_FIELDS.length + 4} className="px-2 py-4 text-center text-text-muted">Дорог нет</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {editingRoad && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              onClick={() => setEditingRoadId(null)}
            >
              <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-white shadow-xl" onClick={event => event.stopPropagation()}>
                <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-white p-4">
                  <div>
                    <h3 className="text-base font-heading font-semibold text-text-primary">{editingRoad.code} · {editingRoad.name}</h3>
                    <div className="mt-1 text-[11px] text-text-muted">
                      АД ПК {formatPkRange(editingRoad.ad_pk_start, editingRoad.ad_pk_end)} · ВСЖМ ПК {formatPkRange(editingRoad.rail_pk_start, editingRoad.rail_pk_end)} · последнее изменение {formatDbDate(latestDateByRoad.get(editingRoad.id) || editingRoad.effective_date)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingRoadId(null)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-text-primary"
                    title="Закрыть"
                    aria-label="Закрыть"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-4 p-4">
                  {!isAdmin && <Message tone="warning" text="Сохранять и удалять корректировки может только администратор." />}

                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[760px] text-[12px]">
                      <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                        <tr>
                          <th className="px-2 py-2 text-left font-semibold">Статус</th>
                          <th className="px-2 py-2 text-left font-semibold">АД ПК</th>
                          <th className="px-2 py-2 text-left font-semibold">ВСЖМ ПК</th>
                        </tr>
                      </thead>
                      <tbody>
                        {TEMP_ROAD_STATUS_FIELDS.map(field => (
                          <tr key={field.key} className="border-b border-border/60">
                            <td className="px-2 py-2 font-semibold text-text-primary">{field.label}</td>
                            <td className="px-2 py-2 font-mono text-text-secondary">{segmentRangesForStatus(editingRoad.segments, field.key, 'ad')}</td>
                            <td className="px-2 py-2 font-mono text-text-secondary">{segmentRangesForStatus(editingRoad.segments, field.key, 'rail')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
                    <div className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-text-primary">Корректировка выбранной дороги</div>
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="block text-[11px] text-text-muted">
                          Дата среза
                          <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm" />
                        </label>
                        <label className="block text-[11px] text-text-muted">
                          Статус
                          <select value={statusType} onChange={e => setStatusType(e.target.value as TempRoadStatusType)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                            {Object.entries(TEMP_ROAD_STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                          </select>
                        </label>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        <input value={roadPkStart} onChange={e => setRoadPkStart(e.target.value)} placeholder="АД ПК начало" className={pkDraftTone(roadPkStart, editingRoad.ad_pk_start, editingRoad.ad_pk_end)} />
                        <input value={roadPkEnd} onChange={e => setRoadPkEnd(e.target.value)} placeholder="АД ПК конец" className={pkDraftTone(roadPkEnd, editingRoad.ad_pk_start, editingRoad.ad_pk_end)} />
                        <input value={railPkStart} onChange={e => setRailPkStart(e.target.value)} placeholder="ВСЖМ ПК начало" className={pkDraftTone(railPkStart, editingRoad.rail_pk_start, editingRoad.rail_pk_end)} />
                        <input value={railPkEnd} onChange={e => setRailPkEnd(e.target.value)} placeholder="ВСЖМ ПК конец" className={pkDraftTone(railPkEnd, editingRoad.rail_pk_start, editingRoad.rail_pk_end)} />
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-[10px] text-text-muted sm:grid-cols-2 lg:grid-cols-4">
                        <div>{pkDraftMessage(roadPkStart, editingRoad.ad_pk_start, editingRoad.ad_pk_end)}</div>
                        <div>{pkDraftMessage(roadPkEnd, editingRoad.ad_pk_start, editingRoad.ad_pk_end)}</div>
                        <div>{pkDraftMessage(railPkStart, editingRoad.rail_pk_start, editingRoad.rail_pk_end)}</div>
                        <div>{pkDraftMessage(railPkEnd, editingRoad.rail_pk_start, editingRoad.rail_pk_end)}</div>
                      </div>
                      <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Комментарий" className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm" />
                      {mutation.error && <Message tone="error" text={(mutation.error as Error).message} />}
                      <button
                        type="button"
                        onClick={() => mutation.mutate()}
                        disabled={!isAdmin || mutation.isPending}
                        className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-burg disabled:opacity-50"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {mutation.isPending ? 'Сохранение...' : 'Сохранить корректировку'}
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-border">
                    <div className="border-b border-border bg-bg-surface px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-text-primary">История корректировок дороги</div>
                    <table className="w-full min-w-[820px] text-[12px]">
                      <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                        <tr>
                          <th className="px-2 py-2 text-left font-semibold">Дата</th>
                          <th className="px-2 py-2 text-left font-semibold">Статус</th>
                          <th className="px-2 py-2 text-left font-semibold">АД ПК</th>
                          <th className="px-2 py-2 text-left font-semibold">ВСЖМ ПК</th>
                          <th className="px-2 py-2 text-left font-semibold">Комментарий</th>
                          <th className="px-2 py-2 text-left font-semibold">Создано</th>
                          <th className="px-2 py-2 text-right font-semibold">Действие</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRoadCorrections.map(row => (
                          <tr key={row.id} className="border-b border-border/60">
                            <td className="px-2 py-2 text-text-secondary">{formatDbDate(row.effective_date)}</td>
                            <td className="px-2 py-2 text-text-secondary">{TEMP_ROAD_STATUS_LABELS[row.status_type] || row.status_type}</td>
                            <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(row.road_pk_start, row.road_pk_end)}</td>
                            <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(row.rail_pk_start, row.rail_pk_end)}</td>
                            <td className="px-2 py-2 text-text-muted">{row.comment || '—'}</td>
                            <td className="px-2 py-2 text-text-muted">{formatDbDate(row.created_at)}</td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => deleteMutation.mutate(row.id)}
                                disabled={!isAdmin || deleteMutation.isPending}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                                title="Удалить корректировку"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {selectedRoadCorrections.length === 0 && (
                          <tr><td colSpan={7} className="px-2 py-4 text-center text-text-muted">Корректировок по этой дороге нет</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
        </>
      )}
    </Section>
  )
}


function MainlineFillCorrectionsPanel() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const defaultDate = defaultFillCorrectionDate()
  const [sectionCode, setSectionCode] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(defaultDate)
  const [statusType, setStatusType] = useState<MainlineFillStatusKey>('prep_works')
  const [pkStart, setPkStart] = useState('')
  const [pkEnd, setPkEnd] = useState('')
  const [comment, setComment] = useState('')

  const dataQuery = useQuery({
    queryKey: ['db-admin-mainline-fill-corrections'],
    queryFn: () => apiJson<{ as_of: string; schema_ready: boolean; sections: MainlineFillSectionRow[]; corrections: MainlineFillCorrectionRow[] }>('/api/wip/database/mainline-fill-corrections'),
    staleTime: 30_000,
  })

  const sections = dataQuery.data?.sections ?? []
  const selectedSection = sections.find(section => section.section_code === (sectionCode || sections[0]?.section_code))
  const mainlineStatusFields = MAINLINE_FILL_STATUS_DEFINITIONS.filter(item => item.key !== 'no_work')

  const mutation = useMutation({
    mutationFn: () => {
      const selectedCode = sectionCode || sections[0]?.section_code || ''
      if (!selectedCode) throw new Error('Выберите участок')
      const parsedStart = parseNullableNumber(pkStart)
      const parsedEnd = parseNullableNumber(pkEnd)
      if (parsedStart === null || parsedEnd === null) throw new Error('Укажите корректный ПК начала и конца')
      return apiJson<{ ok: boolean; id: string }>('/api/wip/database/mainline-fill-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section_code: selectedCode,
          effective_date: effectiveDate,
          status_type: statusType,
          action: statusType === 'no_work' ? 'clear_status' : 'set_status',
          pk_start: parsedStart,
          pk_end: parsedEnd,
          comment: comment.trim() || null,
        }),
      })
    },
    onSuccess: () => {
      setPkStart('')
      setPkEnd('')
      setComment('')
      qc.invalidateQueries({ queryKey: ['db-admin-mainline-fill-corrections'] })
      qc.invalidateQueries({ queryKey: ['wip', 'mainline-fill'] })
      qc.invalidateQueries({ queryKey: ['wip', 'daily-summary'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiJson<{ ok: boolean }>(`/api/wip/database/mainline-fill-corrections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-mainline-fill-corrections'] })
      qc.invalidateQueries({ queryKey: ['wip', 'mainline-fill'] })
      qc.invalidateQueries({ queryKey: ['wip', 'daily-summary'] })
    },
  })

  if (dataQuery.isLoading) return <div className="text-sm text-text-muted">Загрузка данных ОХ...</div>
  if (dataQuery.isError) return <Message tone="error" text={(dataQuery.error as Error).message} />

  return (
    <div className="space-y-4">
      {!dataQuery.data?.schema_ready && (
        <Message tone="warning" text="Таблицы ОХ еще не применены в БД. Просмотр границ доступен, сохранение корректировок включится после миграции." />
      )}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-[1120px] w-full text-[12px]">
            <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-2 py-2 text-left font-semibold">Участок</th>
                <th className="px-2 py-2 text-left font-semibold">Границы ПК</th>
                {mainlineStatusFields.map(field => (
                  <th key={field.key} className="px-2 py-2 text-left font-semibold">{field.shortLabel || field.label}</th>
                ))}
                <th className="px-2 py-2 text-left font-semibold">Срез</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(section => {
                const selected = (sectionCode || sections[0]?.section_code) === section.section_code
                return (
                  <tr
                    key={section.section_id}
                    onClick={() => setSectionCode(section.section_code)}
                    className={`cursor-pointer border-b border-border/60 hover:bg-bg-surface/60 ${selected ? 'bg-red-50/50' : ''}`}
                  >
                    <td className="px-2 py-2 font-semibold text-text-primary">{section.section_code}<div className="font-normal text-text-muted">{section.section_name}</div></td>
                    <td className="px-2 py-2 font-mono text-text-secondary">{(section.ranges || []).map(range => formatPkRange(range.pk_start, range.pk_end)).join('; ') || formatPkRange(section.pk_start, section.pk_end)}</td>
                    {mainlineStatusFields.map(field => (
                      <td key={field.key} className="max-w-[190px] px-2 py-2 align-top font-mono text-[11px] text-text-secondary">
                        {segmentRangesForStatus(section.segments, field.key, 'main')}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-text-secondary">{formatDbDate(section.effective_date)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-text-primary">Ввод / корректировка ОХ</div>
          {!isAdmin && <Message tone="warning" text="Сохранять корректировки может только администратор." />}
          <div className="space-y-2">
            <label className="block text-[11px] text-text-muted">
              Участок
              <select value={sectionCode || sections[0]?.section_code || ''} onChange={e => setSectionCode(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary">
                {sections.map(section => <option key={section.section_id} value={section.section_code}>{section.section_code} · {section.section_name}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[11px] text-text-muted">
                Дата
                <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm" />
              </label>
              <label className="block text-[11px] text-text-muted">
                Статус
                <select value={statusType} onChange={e => setStatusType(e.target.value as MainlineFillStatusKey)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                  {mainlineStatusFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
                  <option value="no_work">Не в работе / очистить статус</option>
                </select>
              </label>
            </div>
            <div className="text-[11px] leading-snug text-text-muted">{MAINLINE_FILL_STATUS_BY_KEY[statusType]?.description}</div>
            <div className="grid grid-cols-2 gap-2">
              <input value={pkStart} onChange={e => setPkStart(e.target.value)} placeholder="ПК начало" className={pkDraftTone(pkStart, selectedSection?.pk_start, selectedSection?.pk_end, selectedSection?.ranges)} />
              <input value={pkEnd} onChange={e => setPkEnd(e.target.value)} placeholder="ПК конец" className={pkDraftTone(pkEnd, selectedSection?.pk_start, selectedSection?.pk_end, selectedSection?.ranges)} />
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted">
              <div>{pkDraftMessage(pkStart, selectedSection?.pk_start, selectedSection?.pk_end, selectedSection?.ranges)}</div>
              <div>{pkDraftMessage(pkEnd, selectedSection?.pk_start, selectedSection?.pk_end, selectedSection?.ranges)}</div>
            </div>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Комментарий" className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm" />
            {mutation.error && <Message tone="error" text={(mutation.error as Error).message} />}
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={!isAdmin || !dataQuery.data?.schema_ready || mutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-burg disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {mutation.isPending ? 'Сохранение...' : 'Сохранить данные ОХ'}
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-2 py-2 text-left font-semibold">Дата</th>
              <th className="px-2 py-2 text-left font-semibold">Участок</th>
              <th className="px-2 py-2 text-left font-semibold">Статус</th>
              <th className="px-2 py-2 text-left font-semibold">ПК</th>
              <th className="px-2 py-2 text-left font-semibold">Комментарий</th>
              <th className="px-2 py-2 text-right font-semibold">Действие</th>
            </tr>
          </thead>
          <tbody>
            {(dataQuery.data?.corrections || []).map(row => (
              <tr key={row.id} className="border-b border-border/60">
                <td className="px-2 py-2 text-text-secondary">{formatDbDate(row.effective_date)}</td>
                <td className="px-2 py-2 font-semibold text-text-primary">{row.section_code}</td>
                <td className="px-2 py-2 text-text-secondary">{MAINLINE_FILL_STATUS_BY_KEY[row.status_type]?.label || row.status_type}</td>
                <td className="px-2 py-2 font-mono text-text-secondary">{formatPkRange(row.pk_start, row.pk_end)}</td>
                <td className="px-2 py-2 text-text-muted">{row.comment || '—'}</td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(row.id)}
                    disabled={!isAdmin || deleteMutation.isPending}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    title="Удалить корректировку"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {(dataQuery.data?.corrections || []).length === 0 && (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-text-muted">Корректировок нет</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RelationList({ title, relations }: { title: string; relations: DbRelation[] }) {
  return (
    <div className="border border-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary mb-2">
        <Link2 className="w-3.5 h-3.5 text-accent-red" />
        {title}
      </div>
      {relations.length === 0 ? (
        <div className="text-[11px] text-text-muted">—</div>
      ) : (
        <div className="space-y-1.5">
          {relations.map(rel => (
            <div key={`${rel.constraint_name}:${rel.source_column}:${rel.target_column}`} className="text-[11px] font-mono text-text-secondary">
              {rel.source_table}.{rel.source_column} → {rel.target_table}.{rel.target_column}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type OverviewMode = 'types' | 'sections' | 'works' | 'materials' | 'temp_roads' | 'recent'
type ReferenceEditorKind = 'object' | 'work_type' | 'material' | 'object_type' | 'temporary_road'
type FreshEntityKind = Extract<ReferenceEditorKind, 'object' | 'work_type' | 'material' | 'temporary_road'>
type ReferenceEditorTarget = {
  kind: ReferenceEditorKind
  code: string
  name: string
  data: DbRow
}
type FreshReferenceEntity = {
  kind: FreshEntityKind
  kindLabel: string
  id: string
  code: string
  name: string
  created_at?: string | null
  detail: string
  metric: string
  is_active?: boolean
  data: OverviewObject | OverviewWorkType | OverviewMaterial | OverviewTempRoad
}

function freshEntityTable(kind: FreshEntityKind): 'objects' | 'work_types' | 'materials' | 'temporary_roads' {
  if (kind === 'object') return 'objects'
  if (kind === 'work_type') return 'work_types'
  if (kind === 'temporary_road') return 'temporary_roads'
  return 'materials'
}

function ReferenceOverview() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [mode, setMode] = useState<OverviewMode>('types')
  const [q, setQ] = useState('')
  const [selectedType, setSelectedType] = useState('all')
  const [selectedSection, setSelectedSection] = useState('all')
  const [selectedWorkTag, setSelectedWorkTag] = useState('all')
  const [editorTarget, setEditorTarget] = useState<ReferenceEditorTarget | null>(null)

  const overviewQuery = useQuery({
    queryKey: ['db-admin-reference-overview'],
    queryFn: () => apiJson<ReferenceOverviewData>('/api/db-admin/reference-overview'),
    staleTime: 30_000,
  })

  const data = overviewQuery.data
  const objects = useMemo(() => data?.objects ?? [], [data?.objects])
  const objectTypes = useMemo(() => data?.object_types ?? [], [data?.object_types])
  const sections = useMemo(() => data?.sections ?? [], [data?.sections])
  const workTypes = useMemo(() => data?.work_types ?? [], [data?.work_types])
  const materials = useMemo(() => data?.materials ?? [], [data?.materials])
  const temporaryRoads = useMemo(() => data?.temporary_roads ?? [], [data?.temporary_roads])

  const deleteFreshEntityMutation = useMutation({
    mutationFn: async (row: FreshReferenceEntity) => {
      const result = await apiJson<ValidationResult>(`/api/db-admin/tables/${freshEntityTable(row.kind)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          pk: { id: row.id },
          values: {},
          confirmed: true,
          changed_by: 'dashboard',
        }),
      })
      if (!result.ok) {
        const detail = result.errors?.length ? result.errors.join('; ') : 'Не удалось удалить справочник'
        throw new Error(detail)
      }
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-reference-overview'] })
      qc.invalidateQueries({ queryKey: ['db-admin-tables'] })
      qc.invalidateQueries({ queryKey: ['db-admin-rows'] })
      qc.invalidateQueries({ queryKey: ['wip'] })
    },
  })

  const sectionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const object of objects) {
      for (const section of object.sections) {
        counts.set(section.id, (counts.get(section.id) ?? 0) + 1)
      }
    }
    return counts
  }, [objects])

  const workTags = useMemo(() => {
    const tags = new Map<string, { key: string; label: string; count: number }>()
    for (const work of workTypes) {
      const key = work.analytics_tag || '__none__'
      const label = work.analytics_tag || 'Без тега'
      tags.set(key, { key, label, count: (tags.get(key)?.count ?? 0) + 1 })
    }
    return Array.from(tags.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  }, [workTypes])

  const objectsByType = useMemo(() => objects.filter(object => {
    if (selectedType !== 'all' && object.object_type_code !== selectedType) return false
    return textMatches(q, [
      object.code,
      object.name,
      object.object_type_name,
      object.object_type_code,
      object.constructive_name,
      object.pk_label,
      compactSections(object.sections),
      object.work_tags,
      object.created_at,
    ])
  }), [objects, q, selectedType])

  const objectsBySection = useMemo(() => objects.filter(object => {
    if (selectedSection !== 'all' && !object.sections.some(section => section.id === selectedSection)) return false
    return textMatches(q, [
      object.code,
      object.name,
      object.object_type_name,
      object.object_type_code,
      object.constructive_name,
      object.pk_label,
      compactSections(object.sections),
      object.work_tags,
      object.created_at,
    ])
  }), [objects, q, selectedSection])

  const filteredWorkTypes = useMemo(() => workTypes.filter(work => {
    const tagKey = work.analytics_tag || '__none__'
    if (selectedWorkTag !== 'all' && tagKey !== selectedWorkTag) return false
    return textMatches(q, [
      work.code,
      work.name,
      work.default_unit,
      work.analytics_tag,
      work.object_count,
      work.project_item_count,
      work.created_at,
    ])
  }), [workTypes, q, selectedWorkTag])

  const filteredMaterials = useMemo(() => materials.filter(material => textMatches(q, [
    material.code,
    material.name,
    material.default_unit,
    material.movement_count,
    material.stockpile_count,
    material.created_at,
  ])), [materials, q])

  const filteredTempRoads = useMemo(() => temporaryRoads.filter(road => textMatches(q, [
    road.code,
    road.name,
    road.road_type,
    road.section_code,
    road.section_name,
    road.ad_pk_label,
    road.rail_pk_label,
    road.display_in_dashboard ? 'проектная дорога' : 'непроектный проезд',
    road.created_at,
  ])), [temporaryRoads, q])

  const recentEntities = useMemo(() => {
    const rows: FreshReferenceEntity[] = [
      ...objects.map(object => ({
        kind: 'object' as const,
        kindLabel: 'Объект',
        id: object.id,
        code: object.code,
        name: object.name,
        created_at: object.created_at,
        detail: [object.object_type_name, object.pk_label, compactSections(object.sections)].filter(Boolean).join(' · '),
        metric: `${formatNumber(object.project_item_count)} поз. проекта`,
        is_active: object.is_active,
        data: object,
      })),
      ...workTypes.map(work => ({
        kind: 'work_type' as const,
        kindLabel: 'Работа',
        id: work.id,
        code: work.code,
        name: work.name,
        created_at: work.created_at,
        detail: [work.analytics_tag || 'Без тега', work.default_unit].filter(Boolean).join(' · '),
        metric: `${formatNumber(work.object_count)} объектов`,
        is_active: work.is_active,
        data: work,
      })),
      ...materials.map(material => ({
        kind: 'material' as const,
        kindLabel: 'Материал',
        id: material.id,
        code: material.code,
        name: material.name,
        created_at: material.created_at,
        detail: material.default_unit || '—',
        metric: `${formatNumber(material.movement_count)} перевозок`,
        data: material,
      })),
      ...temporaryRoads.map(road => ({
        kind: 'temporary_road' as const,
        kindLabel: 'Временная дорога',
        id: road.id,
        code: road.code,
        name: road.name,
        created_at: road.created_at,
        detail: [road.display_in_dashboard ? 'проектная а/д' : 'непроектный проезд', road.section_code, road.ad_pk_label].filter(Boolean).join(' · '),
        metric: `${formatNumber(road.status_segment_count)} статусов`,
        is_active: road.display_in_dashboard,
        data: road,
      })),
    ]
    return rows.sort((a, b) => {
      const byDate = referenceCreatedAtSortValue(b.created_at) - referenceCreatedAtSortValue(a.created_at)
      if (byDate) return byDate
      const byKind = a.kindLabel.localeCompare(b.kindLabel, 'ru')
      return byKind || a.name.localeCompare(b.name, 'ru') || a.code.localeCompare(b.code, 'ru')
    })
  }, [objects, workTypes, materials, temporaryRoads])

  const filteredRecentEntities = useMemo(() => recentEntities.filter(entity => textMatches(q, [
    entity.kindLabel,
    entity.code,
    entity.name,
    entity.created_at,
    entity.detail,
    entity.metric,
  ])), [recentEntities, q])

  const activeRowsCount = mode === 'types'
    ? objectsByType.length
    : mode === 'sections'
      ? objectsBySection.length
      : mode === 'works'
        ? filteredWorkTypes.length
        : mode === 'materials'
          ? filteredMaterials.length
          : mode === 'temp_roads'
            ? filteredTempRoads.length
            : filteredRecentEntities.length

  function openEditor(kind: ReferenceEditorKind, row: DbRow & { code?: string; name?: string }) {
    const code = String(row.code || '')
    if (!code || code === 'all') return
    setEditorTarget({ kind, code, name: String(row.name || code), data: row })
  }

  function deleteFreshEntity(row: FreshReferenceEntity) {
    if (!window.confirm(`Удалить ${row.kindLabel.toLowerCase()} «${row.name}»?`)) return
    deleteFreshEntityMutation.mutate(row)
  }

  return (
    <Section
      title="Обзор справочников"
      icon={Layers3}
      right={data && (
        <div className="hidden lg:flex items-center gap-1.5">
          {data.summary.map(item => (
            <span key={item.key} className="text-[11px] text-text-muted border border-border rounded-md px-2 py-1 bg-white">
              {item.label}: <b className="text-text-primary">{formatNumber(item.count)}</b>
            </span>
          ))}
        </div>
      )}
    >
      {overviewQuery.isLoading && <div className="text-sm text-text-muted">Загрузка обзора...</div>}
      {overviewQuery.isError && <Message tone="error" text={(overviewQuery.error as Error).message} />}
      {data && (
        <div className="space-y-4">
          <div className="flex flex-col xl:flex-row gap-3 xl:items-center">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 flex-1">
              <OverviewModeButton active={mode === 'types'} icon={Boxes} label="Объекты по типам" onClick={() => setMode('types')} />
              <OverviewModeButton active={mode === 'sections'} icon={ListFilter} label="Объекты по участкам" onClick={() => setMode('sections')} />
              <OverviewModeButton active={mode === 'works'} icon={Tags} label="Работы по группам" onClick={() => setMode('works')} />
              <OverviewModeButton active={mode === 'materials'} icon={Table2} label="Материалы" onClick={() => setMode('materials')} />
              <OverviewModeButton active={mode === 'temp_roads'} icon={Truck} label="Временные дороги" onClick={() => setMode('temp_roads')} />
              <OverviewModeButton active={mode === 'recent'} icon={RefreshCw} label="Свежие сущности" onClick={() => setMode('recent')} />
            </div>
            <div className="relative xl:w-[340px]">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Поиск по коду, названию, пикетажу"
                className="w-full border border-border rounded-md pl-8 pr-2 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-accent-red"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
            <span className="font-semibold text-text-primary">Найдено: {formatNumber(activeRowsCount)}</span>
            {mode === 'types' && (
              <select
                value={selectedType}
                onChange={e => setSelectedType(e.target.value)}
                className="border border-border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-accent-red"
              >
                <option value="all">Все типы объектов</option>
                {objectTypes.map(type => (
                  <option key={type.code} value={type.code}>
                    {type.name} · {type.object_count}
                  </option>
                ))}
              </select>
            )}
            {mode === 'sections' && (
              <select
                value={selectedSection}
                onChange={e => setSelectedSection(e.target.value)}
                className="border border-border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-accent-red"
              >
                <option value="all">Все участки</option>
                {sections.map(section => (
                  <option key={section.id} value={section.id}>
                    {section.name} · {sectionCounts.get(section.id) ?? 0}
                  </option>
                ))}
              </select>
            )}
            {mode === 'works' && (
              <select
                value={selectedWorkTag}
                onChange={e => setSelectedWorkTag(e.target.value)}
                className="border border-border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-accent-red"
              >
                <option value="all">Все теги работ</option>
                {workTags.map(tag => (
                  <option key={tag.key} value={tag.key}>
                    {tag.label} · {tag.count}
                  </option>
                ))}
              </select>
            )}
          </div>

          {deleteFreshEntityMutation.isError && <Message tone="error" text={(deleteFreshEntityMutation.error as Error).message} />}

          {mode === 'types' && (
            <div className="grid grid-cols-1 2xl:grid-cols-[420px_minmax(0,1fr)] gap-3">
              <div className="overflow-auto max-h-[520px] border border-border rounded-lg">
                <table className="w-full min-w-[400px] text-[12px]">
                  <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-2 font-semibold">Тип объекта</th>
                      <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
                      <th className="text-right px-2 py-2 font-semibold">Объекты</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ObjectTypeRow
                      active={selectedType === 'all'}
                      label="Все типы объектов"
                      code="all"
                      count={objects.length}
                      activeCount={objects.filter(object => object.is_active).length}
                      createdAt={null}
                      flags={[]}
                      onClick={() => setSelectedType('all')}
                    />
                    {objectTypes.map(type => (
                      <ObjectTypeRow
                        key={type.code}
                        active={selectedType === type.code}
                        label={type.name}
                        code={type.code}
                        count={type.object_count}
                        activeCount={type.active_object_count}
                        createdAt={type.created_at}
                        flags={[
                          type.map_enabled ? 'карта' : '',
                          type.work_accounting_enabled ? 'работы' : '',
                          type.material_accounting_enabled ? 'мат.' : '',
                          type.is_linear ? 'линейный' : '',
                        ].filter(Boolean)}
                        onClick={() => {
                          setSelectedType(type.code)
                          openEditor('object_type', type as unknown as DbRow & { code: string; name: string })
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <ObjectsReadableTable rows={objectsByType} onOpen={row => openEditor('object', {
                ...row,
                code: row.code,
                name: row.name,
              } as unknown as DbRow & { code: string; name: string })} />
            </div>
          )}

          {mode === 'sections' && (
            <div className="grid grid-cols-1 2xl:grid-cols-[420px_minmax(0,1fr)] gap-3">
              <div className="overflow-auto max-h-[520px] border border-border rounded-lg">
                <table className="w-full min-w-[400px] text-[12px]">
                  <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-2 font-semibold">Участок</th>
                      <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
                      <th className="text-right px-2 py-2 font-semibold">Объекты</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SectionOverviewRow
                      active={selectedSection === 'all'}
                      label="Все участки"
                      code="all"
                      count={objects.length}
                      createdAt={null}
                      boundaries={[]}
                      onClick={() => setSelectedSection('all')}
                    />
                    {sections.map(section => (
                      <SectionOverviewRow
                        key={section.id}
                        active={selectedSection === section.id}
                        label={section.name}
                        code={section.code}
                        count={sectionCounts.get(section.id) ?? 0}
                        createdAt={section.created_at}
                        boundaries={section.boundaries}
                        onClick={() => setSelectedSection(section.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <ObjectsReadableTable rows={objectsBySection} onOpen={row => openEditor('object', {
                ...row,
                code: row.code,
                name: row.name,
              } as unknown as DbRow & { code: string; name: string })} />
            </div>
          )}

          {mode === 'works' && <WorkTypesReadableTable rows={filteredWorkTypes} onOpen={row => openEditor('work_type', {
            ...row,
            code: row.code,
            name: row.name,
          } as unknown as DbRow & { code: string; name: string })} />}

          {mode === 'materials' && <MaterialsReadableTable rows={filteredMaterials} onOpen={row => openEditor('material', {
            ...row,
            code: row.code,
            name: row.name,
          } as unknown as DbRow & { code: string; name: string })} />}

          {mode === 'temp_roads' && <TempRoadsReadableTable rows={filteredTempRoads} onOpen={row => openEditor('temporary_road', {
            ...row,
            code: row.code,
            name: row.name,
          } as unknown as DbRow & { code: string; name: string })} />}

          {mode === 'recent' && <FreshEntitiesReadableTable
            rows={filteredRecentEntities}
            isAdmin={isAdmin}
            deleting={deleteFreshEntityMutation.isPending}
            onDelete={deleteFreshEntity}
            onOpen={row => openEditor(row.kind, {
              ...row.data,
              code: row.code,
              name: row.name,
            } as unknown as DbRow & { code: string; name: string })}
          />}
        </div>
      )}
      {editorTarget && <ReferenceEntityModal target={editorTarget} onClose={() => setEditorTarget(null)} />}
    </Section>
  )
}

function OverviewModeButton(props: { active: boolean; icon: ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  const Icon = props.icon
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border text-[12px] font-semibold transition-colors ${
        props.active
          ? 'border-accent-red bg-red-50 text-text-primary'
          : 'border-border bg-white text-text-secondary hover:bg-bg-surface'
      }`}
    >
      <Icon className="w-4 h-4" />
      <span className="truncate">{props.label}</span>
    </button>
  )
}

function ObjectTypeRow(props: {
  active: boolean
  label: string
  code: string
  count: number
  activeCount: number
  createdAt?: string | null
  flags: string[]
  onClick: () => void
}) {
  return (
    <tr
      onClick={props.onClick}
      className={`border-t border-border/60 cursor-pointer ${props.active ? 'bg-red-50/70' : 'hover:bg-bg-surface/70'}`}
    >
      <td className="px-2 py-2 align-top">
        <div className="font-semibold text-text-primary">{props.label}</div>
        {props.flags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {props.flags.map(flag => <SmallBadge key={flag}>{flag}</SmallBadge>)}
          </div>
        )}
      </td>
      <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(props.createdAt)}</td>
      <td className="px-2 py-2 text-right align-top">
        <div className="font-semibold text-text-primary">{formatNumber(props.count)}</div>
        <div className="text-[11px] text-text-muted">активных {formatNumber(props.activeCount)}</div>
      </td>
    </tr>
  )
}

function SectionOverviewRow(props: {
  active: boolean
  label: string
  code: string
  count: number
  createdAt?: string | null
  boundaries: { boundary_kind: string; pk_label?: string | null }[]
  onClick: () => void
}) {
  const boundaryText = props.boundaries
    .map(boundary => `${boundary.boundary_kind}: ${boundary.pk_label || '—'}`)
    .join(' · ')
  return (
    <tr
      onClick={props.onClick}
      className={`border-t border-border/60 cursor-pointer ${props.active ? 'bg-red-50/70' : 'hover:bg-bg-surface/70'}`}
    >
      <td className="px-2 py-2 align-top">
        <div className="font-semibold text-text-primary">{props.label}</div>
        {boundaryText && <div className="text-[11px] text-text-muted mt-1 leading-snug">{boundaryText}</div>}
      </td>
      <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(props.createdAt)}</td>
      <td className="px-2 py-2 text-right align-top font-semibold text-text-primary">{formatNumber(props.count)}</td>
    </tr>
  )
}

function ObjectsReadableTable({ rows, onOpen }: { rows: OverviewObject[]; onOpen?: (row: OverviewObject) => void }) {
  return (
    <div className="overflow-auto max-h-[520px] border border-border rounded-lg">
      <table className="w-full text-[12px] min-w-[1060px]">
        <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-2 font-semibold">Объект</th>
            <th className="text-left px-2 py-2 font-semibold">Тип</th>
            <th className="text-left px-2 py-2 font-semibold">Участки</th>
            <th className="text-left px-2 py-2 font-semibold">Пикетаж</th>
            <th className="text-left px-2 py-2 font-semibold">Работы</th>
            <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
            <th className="text-left px-2 py-2 font-semibold">Статус</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-text-muted">Нет строк</td></tr>}
          {rows.map(row => (
            <tr
              key={row.id}
              onClick={() => onOpen?.(row)}
              className="border-t border-border/60 hover:bg-bg-surface/60 cursor-pointer"
            >
              <td className="px-2 py-2 align-top">
                <div className="font-semibold text-text-primary">{row.name}</div>
                {row.constructive_name && (
                  <div className="text-[11px] text-text-muted mt-1">{row.constructive_name}</div>
                )}
              </td>
              <td className="px-2 py-2 align-top">
                <div className="text-text-primary">{row.object_type_name}</div>
              </td>
              <td className="px-2 py-2 align-top text-text-secondary">{compactSections(row.sections)}</td>
              <td className="px-2 py-2 align-top text-text-secondary whitespace-nowrap">{row.pk_label || '—'}</td>
              <td className="px-2 py-2 align-top">
                <div className="text-text-primary">{formatNumber(row.project_item_count)} поз.</div>
                <div className="text-[11px] text-text-muted">{row.work_tags || '—'}</div>
              </td>
              <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(row.created_at)}</td>
              <td className="px-2 py-2 align-top">
                <SmallBadge tone={row.is_active ? 'green' : 'gray'}>{statusText(row.is_active)}</SmallBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WorkTypesReadableTable({ rows, onOpen }: { rows: OverviewWorkType[]; onOpen?: (row: OverviewWorkType) => void }) {
  return (
    <div className="overflow-auto max-h-[560px] border border-border rounded-lg">
      <table className="w-full text-[12px] min-w-[900px]">
        <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-2 font-semibold">Вид работ</th>
            <th className="text-left px-2 py-2 font-semibold">Тег</th>
            <th className="text-left px-2 py-2 font-semibold">Ед.</th>
            <th className="text-right px-2 py-2 font-semibold">Объекты</th>
            <th className="text-right px-2 py-2 font-semibold">Проект</th>
            <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
            <th className="text-left px-2 py-2 font-semibold">Флаги</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-text-muted">Нет строк</td></tr>}
          {rows.map(row => (
            <tr
              key={row.id}
              onClick={() => onOpen?.(row)}
              className="border-t border-border/60 hover:bg-bg-surface/60 cursor-pointer"
            >
              <td className="px-2 py-2 align-top">
                <div className="font-semibold text-text-primary">{row.name}</div>
              </td>
              <td className="px-2 py-2 align-top">
                <div className="text-text-secondary">{row.analytics_tag || 'Без тега'}</div>
              </td>
              <td className="px-2 py-2 align-top text-text-secondary">{row.default_unit}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.object_count)}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.project_item_count)}</td>
              <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(row.created_at)}</td>
              <td className="px-2 py-2 align-top">
                <div className="flex flex-wrap gap-1">
                  <SmallBadge tone={row.is_active ? 'green' : 'gray'}>{statusText(row.is_active)}</SmallBadge>
                  {row.productivity_enabled && <SmallBadge>производ.</SmallBadge>}
                  {row.show_in_timeline && <SmallBadge>таймлайн</SmallBadge>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MaterialsReadableTable({ rows, onOpen }: { rows: OverviewMaterial[]; onOpen?: (row: OverviewMaterial) => void }) {
  return (
    <div className="overflow-auto max-h-[560px] border border-border rounded-lg">
      <table className="w-full text-[12px] min-w-[880px]">
        <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-2 font-semibold">Материал</th>
            <th className="text-left px-2 py-2 font-semibold">Ед.</th>
            <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
            <th className="text-right px-2 py-2 font-semibold">Перевозки</th>
            <th className="text-right px-2 py-2 font-semibold">Участки</th>
            <th className="text-right px-2 py-2 font-semibold">Объем</th>
            <th className="text-right px-2 py-2 font-semibold">Накопители</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-text-muted">Нет строк</td></tr>}
          {rows.map(row => (
            <tr
              key={row.id}
              onClick={() => onOpen?.(row)}
              className="border-t border-border/60 hover:bg-bg-surface/60 cursor-pointer"
            >
              <td className="px-2 py-2 align-top">
                <div className="font-semibold text-text-primary">{row.name}</div>
              </td>
              <td className="px-2 py-2 align-top text-text-secondary">{row.default_unit}</td>
              <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(row.created_at)}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.movement_count)}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.section_count)}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.movement_volume)}</td>
              <td className="px-2 py-2 align-top text-right text-text-primary">{formatNumber(row.stockpile_count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TempRoadsReadableTable({ rows, onOpen }: { rows: OverviewTempRoad[]; onOpen?: (row: OverviewTempRoad) => void }) {
  return (
    <div className="overflow-auto max-h-[560px] border border-border rounded-lg">
      <table className="w-full text-[12px] min-w-[1120px]">
        <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-2 font-semibold">Дорога</th>
            <th className="text-left px-2 py-2 font-semibold">Режим</th>
            <th className="text-left px-2 py-2 font-semibold">Участок</th>
            <th className="text-left px-2 py-2 font-semibold">АД ПК</th>
            <th className="text-left px-2 py-2 font-semibold">ВСЖМ ПК</th>
            <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
            <th className="text-right px-2 py-2 font-semibold">Статусы</th>
            <th className="text-left px-2 py-2 font-semibold">Последний статус</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="px-2 py-6 text-center text-text-muted">Нет строк</td></tr>}
          {rows.map(row => {
            const readyForDashboard = row.display_in_dashboard !== false && Boolean(row.ad_start_pk != null && row.ad_end_pk != null)
            return (
              <tr
                key={row.id}
                onClick={() => onOpen?.(row)}
                className="border-t border-border/60 hover:bg-bg-surface/60 cursor-pointer"
              >
                <td className="px-2 py-2 align-top">
                  <div className="font-semibold text-text-primary">{row.name}</div>
                  <div className="font-mono text-[10px] text-text-muted">{row.code}</div>
                </td>
                <td className="px-2 py-2 align-top">
                  <div className="flex flex-wrap gap-1">
                    <SmallBadge tone={row.display_in_dashboard ? 'green' : 'gray'}>{row.display_in_dashboard ? 'проектная а/д' : 'непроектный проезд'}</SmallBadge>
                    <SmallBadge tone={readyForDashboard ? 'green' : 'gray'}>{readyForDashboard ? 'схема готова' : 'нет схемы'}</SmallBadge>
                  </div>
                </td>
                <td className="px-2 py-2 align-top text-text-secondary">{row.section_code || '—'}{row.section_name ? <div className="text-[10px] text-text-muted">{row.section_name}</div> : null}</td>
                <td className="px-2 py-2 align-top font-mono text-text-secondary">{row.ad_pk_label || '—'}</td>
                <td className="px-2 py-2 align-top font-mono text-text-secondary">{row.rail_pk_label || '—'}</td>
                <td className="px-2 py-2 align-top whitespace-nowrap text-text-secondary">{formatRelationDateTime(row.created_at)}</td>
                <td className="px-2 py-2 align-top text-right font-mono text-text-primary">{formatNumber(row.status_segment_count)}</td>
                <td className="px-2 py-2 align-top text-text-secondary">{formatRelationDate(row.latest_status_date || row.latest_correction_date)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FreshEntitiesReadableTable({
  rows,
  isAdmin,
  deleting,
  onOpen,
  onDelete,
}: {
  rows: FreshReferenceEntity[]
  isAdmin: boolean
  deleting: boolean
  onOpen?: (row: FreshReferenceEntity) => void
  onDelete?: (row: FreshReferenceEntity) => void
}) {
  return (
    <div className="overflow-auto max-h-[620px] border border-border rounded-lg">
      <table className="w-full text-[12px] min-w-[980px]">
        <thead className="bg-bg-surface sticky top-0 z-10 text-text-muted uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-2 font-semibold">Тип</th>
            <th className="text-left px-2 py-2 font-semibold">Сущность</th>
            <th className="text-left px-2 py-2 font-semibold">Код</th>
            <th className="text-left px-2 py-2 font-semibold">Детали</th>
            <th className="text-left px-2 py-2 font-semibold">Дата добавления</th>
            <th className="text-left px-2 py-2 font-semibold">Использование</th>
            <th className="text-right px-2 py-2 font-semibold">Действие</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-text-muted">Нет строк</td></tr>}
          {rows.map(row => (
            <tr
              key={`${row.kind}:${row.id}`}
              onClick={() => onOpen?.(row)}
              className="border-t border-border/60 hover:bg-bg-surface/60 cursor-pointer"
            >
              <td className="px-2 py-2 align-top">
                <SmallBadge tone={row.kind === 'material' ? 'gray' : row.kind === 'object' ? 'green' : 'red'}>{row.kindLabel}</SmallBadge>
              </td>
              <td className="px-2 py-2 align-top">
                <div className="font-semibold text-text-primary">{row.name}</div>
                {row.is_active !== undefined && <div className="mt-1"><SmallBadge tone={row.is_active ? 'green' : 'gray'}>{statusText(row.is_active)}</SmallBadge></div>}
              </td>
              <td className="px-2 py-2 align-top font-mono text-text-secondary">{row.code}</td>
              <td className="px-2 py-2 align-top text-text-secondary">{row.detail || '—'}</td>
              <td className="px-2 py-2 align-top whitespace-nowrap text-text-primary">{formatRelationDateTime(row.created_at)}</td>
              <td className="px-2 py-2 align-top text-text-secondary">{row.metric}</td>
              <td className="px-2 py-2 align-top text-right">
                <button
                  type="button"
                  onClick={event => { event.stopPropagation(); onDelete?.(row) }}
                  disabled={!isAdmin || deleting}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40"
                  title="Удалить"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReferenceAliasRow({ row, isAdmin, onChanged }: { row: AliasRow; isAdmin: boolean; onChanged: () => void }) {
  const [value, setValue] = useState(row.alias_text)
  const saveMutation = useMutation({
    mutationFn: () => apiJson(`/api/wip/settings/aliases/${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias_text: value.trim() }),
    }),
    onSuccess: onChanged,
  })
  const deleteMutation = useMutation({
    mutationFn: () => fetch(`/api/wip/settings/aliases/${encodeURIComponent(row.id)}`, { method: 'DELETE' }).then(async response => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: string }
        throw new Error(body.detail || `HTTP ${response.status}`)
      }
    }),
    onSuccess: onChanged,
  })
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
      <input value={value} onChange={event => setValue(event.target.value)} disabled={!isAdmin} className="min-w-0 rounded-md border border-border px-2 py-1 text-xs disabled:bg-bg-surface" />
      <button type="button" onClick={() => saveMutation.mutate()} disabled={!isAdmin || !value.trim() || value.trim() === row.alias_text || saveMutation.isPending} className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40">OK</button>
      <button type="button" onClick={() => deleteMutation.mutate()} disabled={!isAdmin || deleteMutation.isPending} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40" title="Удалить алиас"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}

function ReferenceAliasesEditor({ target, isAdmin }: { target: ReferenceEditorTarget; isAdmin: boolean }) {
  const qc = useQueryClient()
  const aliasKind = target.kind === 'work_type' || target.kind === 'material' || target.kind === 'object' ? target.kind : null
  const [newAlias, setNewAlias] = useState('')
  const aliasesQuery = useQuery<{ rows: AliasRow[] }>({
    queryKey: ['aliases-list'],
    queryFn: () => apiJson<{ rows: AliasRow[] }>('/api/wip/settings/aliases'),
    enabled: Boolean(aliasKind),
    staleTime: 30_000,
  })
  const rows = (aliasesQuery.data?.rows || []).filter(row => row.kind === aliasKind && row.canonical_code === target.code)
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['aliases-list'] })
    qc.invalidateQueries({ queryKey: ['wip'] })
  }
  const createMutation = useMutation({
    mutationFn: () => apiJson('/api/wip/settings/aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: aliasKind, canonical_code: target.code, alias_text: newAlias.trim() }),
    }),
    onSuccess: () => { setNewAlias(''); invalidate() },
  })
  if (!aliasKind) return null
  return (
    <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Алиасы парсера</div>
          <div className="text-[11px] text-text-muted">Редактируются прямо из справочника.</div>
        </div>
        <Tags className="h-4 w-4 text-text-muted" />
      </div>
      <div className="space-y-2">
        {aliasesQuery.isLoading ? (
          <div className="text-xs text-text-muted">Загрузка...</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-text-muted">Алиасов пока нет.</div>
        ) : rows.map(row => <ReferenceAliasRow key={row.id} row={row} isAdmin={isAdmin} onChanged={invalidate} />)}
      </div>
      <div className="mt-3 flex gap-2">
        <input value={newAlias} onChange={event => setNewAlias(event.target.value)} disabled={!isAdmin} placeholder="новый алиас" className="min-w-0 flex-1 rounded-md border border-border bg-white px-2 py-1.5 text-xs disabled:bg-bg-surface" />
        <button type="button" onClick={() => createMutation.mutate()} disabled={!isAdmin || !newAlias.trim() || createMutation.isPending} className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40">Добавить</button>
      </div>
    </div>
  )
}

function ReferenceEntityModal({ target, onClose }: { target: ReferenceEditorTarget; onClose: () => void }) {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [draftName, setDraftName] = useState(String(target.name || ''))
  const [draftValues, setDraftValues] = useState<Record<string, DbValue>>(() => {
    const fields = REFERENCE_EDIT_FIELDS[target.kind] || []
    return Object.fromEntries(fields.map(field => {
      const value = target.data[field.key] ?? ''
      return [field.key, isPkColumn(field.key) && typeof value === 'number' ? formatPkForUi(value) : value]
    })) as Record<string, DbValue>
  })
  const [pkOverride, setPkOverride] = useState(false)

  const tagOptionsQuery = useQuery({
    queryKey: ['wip', 'analytics-work-filter-options'],
    queryFn: () => apiJson<WorkFilterOptions>('/api/wip/analytics/work-filter-options'),
    staleTime: 30_000,
    enabled: target.kind === 'work_type',
  })

  const relationsQuery = useQuery({
    queryKey: ['db-admin-reference-relations', target.kind, target.code],
    queryFn: () => apiJson<{ rows: DbRow[] }>(
      `/api/db-admin/reference-relations?kind=${encodeURIComponent(target.kind)}&code=${encodeURIComponent(target.code)}`,
    ),
    staleTime: 30_000,
  })

  const factsQuery = useQuery({
    queryKey: ['db-admin-reference-facts', target.kind, target.code],
    queryFn: () => apiJson<{ rows: DbRow[] }>(
      `/api/db-admin/reference-facts?kind=${encodeURIComponent(target.kind)}&code=${encodeURIComponent(target.code)}`,
    ),
    staleTime: 30_000,
    enabled: target.kind !== 'temporary_road',
  })

  const saveMutation = useMutation({
    mutationFn: () => apiJson<{ ok: boolean; row: DbRow }>('/api/db-admin/reference-details', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: target.kind,
        code: target.code,
        values: { name: draftName.trim(), ...draftValues },
        changed_by: 'dashboard',
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-admin-reference-overview'] })
      qc.invalidateQueries({ queryKey: ['db-admin-reference-relations'] })
      qc.invalidateQueries({ queryKey: ['db-admin-rows'] })
      qc.invalidateQueries({ queryKey: ['wip'] })
      onClose()
    },
  })

  const fields = REFERENCE_EDIT_FIELDS[target.kind] || []
  const title = target.kind === 'object'
    ? 'Объект'
    : target.kind === 'work_type'
      ? 'Работа'
      : target.kind === 'material'
        ? 'Материал'
        : target.kind === 'temporary_road'
          ? 'Временная дорога'
          : 'Тип объекта'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-4">
      <div className="flex max-h-[88vh] w-full max-w-7xl flex-col rounded-xl border border-border bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Save className="h-4 w-4 text-accent-red" />
          <div className="min-w-0 flex-1">
            <div className="font-heading text-sm font-bold text-text-primary">{title}: {target.name}</div>
            <div className="text-[11px] text-text-muted">Редактирование атрибутов и связанные данные</div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 hover:bg-bg-surface">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-auto p-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="space-y-3">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">Название</span>
              <input
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-red"
              />
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {fields.map(field => {
                return (
                  <label key={field.key} className="block min-w-0">
                    <span className="flex min-h-[1.75rem] items-end text-[10px] uppercase leading-tight tracking-wide text-text-muted">{field.label}</span>
                    {field.kind === 'bool' ? (
                      <select
                        value={String(Boolean(draftValues[field.key]))}
                        onChange={e => setDraftValues(v => ({ ...v, [field.key]: e.target.value === 'true' }))}
                        className="mt-1 h-9 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-red"
                      >
                        <option value="true">Да</option>
                        <option value="false">Нет</option>
                      </select>
                    ) : (
                      <>
                        <input
                          list={field.key === 'analytics_tag' ? 'db-work-analytics-tags' : undefined}
                          value={stringifyCell(draftValues[field.key])}
                          onChange={e => { setDraftValues(v => ({ ...v, [field.key]: e.target.value })); if (isPkColumn(field.key)) setPkOverride(false) }}
                          className={`mt-1 h-9 w-full rounded-md border px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-red ${hasUnacknowledgedPkWarning(stringifyCell(draftValues[field.key]), field.key, pkOverride) ? 'border-amber-300 bg-amber-50/40' : 'border-border'}`}
                        />
                        {field.key === 'analytics_tag' && (
                          <datalist id="db-work-analytics-tags">
                            {(tagOptionsQuery.data?.tags || []).map(tag => <option key={tag.name} value={tag.name} />)}
                          </datalist>
                        )}
                        <PkSoftHint value={stringifyCell(draftValues[field.key])} columnName={field.key} override={pkOverride} onOverrideChange={setPkOverride} />
                      </>
                    )}
                  </label>
                )
              })}
            </div>
            {saveMutation.isError && <Message tone="error" text={(saveMutation.error as Error).message} />}
            {!isAdmin && <Message tone="warning" text="Редактировать справочники может только администратор." />}
            <ReferenceAliasesEditor target={target} isAdmin={isAdmin} />
          </div>

          <div className="min-w-0 space-y-4">
            {target.kind !== 'temporary_road' && (
              <ReferenceFactsTable rows={factsQuery.data?.rows || []} loading={factsQuery.isLoading} error={factsQuery.isError} />
            )}
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">
                {target.kind === 'object'
                  ? 'Работы этого объекта с ненулевым объемом'
                  : target.kind === 'work_type'
                    ? 'Объекты с ненулевым объемом по этой работе'
                    : target.kind === 'object_type'
                      ? 'Объекты этого типа'
                      : target.kind === 'temporary_road'
                        ? 'Статусы и корректировки временной дороги'
                        : 'Движения материала по участкам'}
              </div>
              <ReferenceRelationsTable kind={target.kind} targetCode={target.code} rows={relationsQuery.data?.rows || []} loading={relationsQuery.isLoading} />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-bg-surface">
            Закрыть
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!isAdmin || !draftName.trim() || fields.some(field => hasUnacknowledgedPkWarning(stringifyCell(draftValues[field.key]), field.key, pkOverride)) || saveMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-burg disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saveMutation.isPending ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}


function referenceFactKindLabel(row: DbRow): string {
  const kind = String(row.fact_kind || '')
  if (kind === 'material_movement') return 'Перевозка'
  return 'Работа'
}

function referenceFactName(row: DbRow): string {
  const material = relationText(row.material_name)
  const work = relationText(row.work_type_name)
  if (String(row.fact_kind || '') === 'material_movement') return material !== '—' ? material : work
  return work
}

type ReferenceFactSortKey = 'date' | 'type' | 'object' | 'name' | 'volume' | 'pk' | 'section' | 'source' | 'status'

function referenceFactSortValue(row: DbRow, key: ReferenceFactSortKey): string | number {
  if (key === 'date') return Date.parse(String(row.report_date || '')) || 0
  if (key === 'type') return referenceFactKindLabel(row)
  if (key === 'object') return `${relationText(row.object_name)} ${relationText(row.object_code)}`
  if (key === 'name') return `${referenceFactName(row)} ${relationText(row.work_type_code || row.material_code)}`
  if (key === 'volume') return relationNumber(row.volume)
  if (key === 'pk') return relationText(row.pk_label)
  if (key === 'section') return relationText(row.section_name)
  if (key === 'source') return `${relationText(row.labor_source_type)} ${relationText(row.contractor_name)}`
  if (key === 'status') return relationText(row.report_status)
  return ''
}

function ReferenceFactsTable({ rows, loading, error }: { rows: DbRow[]; loading: boolean; error?: boolean }) {
  const [sort, setSort] = useState<{ key: ReferenceFactSortKey; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' })
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = referenceFactSortValue(a, sort.key)
      const bv = referenceFactSortValue(b, sort.key)
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv), 'ru', { numeric: true, sensitivity: 'base' })
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort])
  const sortHeader = (key: ReferenceFactSortKey, label: string, align: 'left' | 'right' = 'left') => (
    <button
      type="button"
      onClick={() => setSort(current => current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'volume' ? 'desc' : 'asc' })}
      className={`inline-flex w-full items-center gap-1 ${align === 'right' ? 'justify-end text-right' : 'justify-start text-left'} font-semibold hover:text-text-primary`}
    >
      <span>{label}</span>
      <span className="text-[9px] text-text-muted">{sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
    </button>
  )
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-text-muted">Ненулевые факты из отчетов</div>
        <SmallBadge tone="gray">{formatNumber(rows.length)}</SmallBadge>
      </div>
      {loading ? (
        <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Загрузка фактов...</div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Не удалось загрузить факты</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Ненулевых фактов не найдено.</div>
      ) : (
        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[1180px] text-[12px]">
            <thead className="sticky top-0 bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-2 py-2">{sortHeader('date', 'Дата')}</th>
                <th className="px-2 py-2">{sortHeader('type', 'Тип')}</th>
                <th className="px-2 py-2">{sortHeader('object', 'Объект')}</th>
                <th className="px-2 py-2">{sortHeader('name', 'Работа / материал')}</th>
                <th className="px-2 py-2">{sortHeader('volume', 'Факт', 'right')}</th>
                <th className="px-2 py-2">{sortHeader('pk', 'ПК / фрагмент')}</th>
                <th className="px-2 py-2">{sortHeader('section', 'Участок')}</th>
                <th className="px-2 py-2">{sortHeader('source', 'Силы')}</th>
                <th className="px-2 py-2">{sortHeader('status', 'Статус')}</th>
                <th className="px-2 py-2 text-left font-semibold">Отчет</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, idx) => {
                const reportId = relationText(row.report_id)
                return (
                  <tr key={`${relationText(row.fact_kind)}-${relationText(row.fact_id)}-${idx}`} className="border-t border-border/60">
                    <td className="px-2 py-2 align-top text-text-primary">{formatRelationDate(row.report_date)}</td>
                    <td className="px-2 py-2 align-top"><SmallBadge tone={String(row.fact_kind || '') === 'material_movement' ? 'gray' : 'red'}>{referenceFactKindLabel(row)}</SmallBadge></td>
                    <td className="px-2 py-2 align-top text-text-secondary">
                      <div className="font-semibold text-text-primary">{relationText(row.object_name)}</div>
                      <div className="text-[10px] text-text-muted">{relationText(row.object_code)}</div>
                    </td>
                    <td className="px-2 py-2 align-top text-text-secondary">
                      <div className="font-semibold text-text-primary">{referenceFactName(row)}</div>
                      <div className="text-[10px] text-text-muted">{relationText(row.work_type_code || row.material_code)} {relationText(row.analytics_tag) !== '—' ? `· ${relationText(row.analytics_tag)}` : ''}</div>
                    </td>
                    <td className="px-2 py-2 align-top text-right font-mono font-semibold text-text-primary">{formatNumber(relationNumber(row.volume))} {relationText(row.unit)}</td>
                    <td className="px-2 py-2 align-top text-text-secondary">{relationText(row.pk_label)}</td>
                    <td className="px-2 py-2 align-top text-text-secondary">{relationText(row.section_name)}</td>
                    <td className="px-2 py-2 align-top text-text-secondary">
                      <div>{relationLaborLabel(row.labor_source_type)}</div>
                      <div className="text-[10px] text-text-muted">{relationText(row.contractor_name)}</div>
                    </td>
                    <td className="px-2 py-2 align-top text-text-secondary">{relationStatusLabel(row.report_status)}</td>
                    <td className="px-2 py-2 align-top">
                      {reportId !== '—' ? (
                        <a
                          href={`/reports?report_id=${encodeURIComponent(reportId)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          Открыть
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ReferenceRelationsTable({
  kind,
  targetCode,
  rows,
  loading,
}: {
  kind: ReferenceEditorKind
  targetCode?: string
  rows: DbRow[]
  loading: boolean
}) {
  const [selectedRelation, setSelectedRelation] = useState<DbRow | null>(null)
  const selectedObjectCode = kind === 'work_type'
    ? relationRawText(selectedRelation?.object_code)
    : kind === 'object'
      ? relationRawText(selectedRelation?.object_code || targetCode || '')
      : ''
  const selectedWorkCode = kind === 'work_type'
    ? relationRawText(targetCode || '')
    : kind === 'object'
      ? relationRawText(selectedRelation?.work_type_code)
      : ''
  const detailQuery = useQuery<{ rows: DbRow[] }>({
    queryKey: ['db-admin-work-type-object-detail', selectedWorkCode, selectedObjectCode],
    queryFn: () => apiJson<{ rows: DbRow[] }>(
      `/api/db-admin/reference-relations/work-type-object-detail?work_code=${encodeURIComponent(selectedWorkCode)}&object_code=${encodeURIComponent(selectedObjectCode)}`,
    ),
    enabled: (kind === 'work_type' || kind === 'object') && Boolean(selectedWorkCode) && Boolean(selectedObjectCode),
    staleTime: 30_000,
  })

  if (loading) return <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Загрузка...</div>
  if (!rows.length) return <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Нет связанных строк</div>

  if (kind === 'object' || kind === 'work_type') {
    const primaryHeader = kind === 'work_type' ? 'Объект' : 'Работа'
    const secondaryHeader = kind === 'work_type' ? 'Тип объекта' : 'Тег'
    return (
      <>
        <div className="max-h-[520px] overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[1040px] text-[12px]">
            <thead className="sticky top-0 bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-2 py-2 text-left font-semibold">{primaryHeader}</th>
                <th className="px-2 py-2 text-left font-semibold">{secondaryHeader}</th>
                <th className="px-2 py-2 text-right font-semibold">Проект</th>
                <th className="px-2 py-2 text-right font-semibold">Факт</th>
                <th className="px-2 py-2 text-right font-semibold">Отчетов</th>
                <th className="px-2 py-2 text-left font-semibold">Последний факт</th>
                <th className="px-2 py-2 text-left font-semibold">Ед.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const fact = relationNumber(row.fact_volume)
                const project = relationNumber(row.project_volume)
                const primaryName = kind === 'work_type' ? relationText(row.object_name) : relationText(row.work_type_name)
                const primaryCode = kind === 'work_type' ? relationText(row.object_code) : relationText(row.work_type_code)
                const secondaryValue = kind === 'work_type' ? relationText(row.object_type_name) : relationText(row.analytics_tag)
                return (
                  <tr
                    key={`${relationText(row.object_code)}-${relationText(row.work_type_code)}-${idx}`}
                    onClick={() => setSelectedRelation(row)}
                    className="cursor-pointer border-t border-border/60 hover:bg-bg-surface/70"
                    title="Открыть детализацию по отчетам"
                  >
                    <td className="px-2 py-2 align-top text-text-primary">
                      <div className="font-semibold">{primaryName}</div>
                      <div className="text-[10px] text-text-muted">{primaryCode}</div>
                    </td>
                    <td className="px-2 py-2 align-top text-text-secondary">{secondaryValue}</td>
                    <td className="px-2 py-2 align-top text-right font-mono text-text-secondary">{formatNumber(project)}</td>
                    <td className="px-2 py-2 align-top text-right font-mono font-semibold text-text-primary">{formatNumber(fact)}</td>
                    <td className="px-2 py-2 align-top text-right font-mono text-text-secondary">{formatNumber(relationNumber(row.fact_report_count))}</td>
                    <td className="px-2 py-2 align-top text-text-secondary">{formatRelationDate(row.last_fact_date)}</td>
                    <td className="px-2 py-2 align-top text-text-muted">{relationText(row.unit)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {selectedRelation && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4" onClick={() => setSelectedRelation(null)}>
            <div className="flex max-h-[82vh] w-full max-w-6xl flex-col rounded-xl border border-border bg-white shadow-xl" onClick={event => event.stopPropagation()}>
              <div className="flex items-start gap-3 border-b border-border px-4 py-3">
                <Link2 className="mt-0.5 h-4 w-4 text-accent-red" />
                <div className="min-w-0 flex-1">
                  <div className="font-heading text-sm font-bold text-text-primary">
                    {relationText(selectedRelation.object_name)} · {relationText(selectedRelation.object_code)} · {relationText(selectedRelation.work_type_name)}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    Фактические строки этой работы из отчетов. Проект: {formatNumber(relationNumber(selectedRelation.project_volume))} {relationText(selectedRelation.unit)}, факт: {formatNumber(relationNumber(selectedRelation.fact_volume))} {relationText(selectedRelation.unit)}.
                  </div>
                </div>
                <button type="button" onClick={() => setSelectedRelation(null)} className="rounded p-1.5 hover:bg-bg-surface">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 overflow-auto p-4">
                {detailQuery.isLoading ? (
                  <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Загрузка детализации...</div>
                ) : detailQuery.isError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Не удалось загрузить детализацию</div>
                ) : (detailQuery.data?.rows || []).length === 0 ? (
                  <div className="rounded-lg border border-border p-4 text-sm text-text-muted">Фактических строк в отчетах для этой пары объект/работа нет.</div>
                ) : (
                  <table className="w-full min-w-[1120px] text-[12px]">
                    <thead className="sticky top-0 bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold">Дата отчета</th>
                        <th className="px-2 py-2 text-left font-semibold">Ввод</th>
                        <th className="px-2 py-2 text-left font-semibold">Смена</th>
                        <th className="px-2 py-2 text-left font-semibold">Участок</th>
                        <th className="px-2 py-2 text-right font-semibold">Объем</th>
                        <th className="px-2 py-2 text-left font-semibold">ПК</th>
                        <th className="px-2 py-2 text-left font-semibold">Силы</th>
                        <th className="px-2 py-2 text-left font-semibold">Статус</th>
                        <th className="px-2 py-2 text-left font-semibold">Источник</th>
                        <th className="px-2 py-2 text-left font-semibold">Отчет</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detailQuery.data?.rows || []).map((row, idx) => {
                        const reportId = relationText(row.report_id)
                        return (
                          <tr key={`${reportId}-${relationText(row.daily_work_item_id)}-${idx}`} className="border-t border-border/60">
                            <td className="px-2 py-2 align-top text-text-primary">{formatRelationDate(row.report_date)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">{formatRelationDateTime(row.created_at)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">{relationShiftLabel(row.shift)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">{relationText(row.section_name)}</td>
                            <td className="px-2 py-2 align-top text-right font-mono font-semibold text-text-primary">{formatNumber(relationNumber(row.volume))} {relationText(row.unit)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">{relationText(row.pk_label)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">
                              <div>{relationLaborLabel(row.labor_source_type)}</div>
                              <div className="text-[10px] text-text-muted">{relationText(row.contractor_name)}</div>
                            </td>
                            <td className="px-2 py-2 align-top text-text-secondary">{relationStatusLabel(row.report_status)}</td>
                            <td className="px-2 py-2 align-top text-text-secondary">
                              <div>{relationText(row.source_type)}</div>
                              <div className="text-[10px] text-text-muted">{relationText(row.uploaded_by_username)}</div>
                            </td>
                            <td className="px-2 py-2 align-top">
                              <a
                                href={`/reports?report_id=${encodeURIComponent(reportId)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red"
                              >
                                <Link2 className="h-3.5 w-3.5" />
                                Открыть
                              </a>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </>
    )
  }
  if (kind === 'object_type') {
    return <SimpleRelationTable rows={rows} columns={[
      ['object_name', 'Объект'],
      ['pk_label', 'Пикетаж'],
      ['project_item_count', 'Работы'],
      ['is_active', 'Статус'],
    ]} />
  }
  if (kind === 'temporary_road') {
    return <SimpleRelationTable rows={rows} columns={[
      ['source', 'Источник'],
      ['status_type', 'Статус'],
      ['segment_count', 'Сегменты'],
      ['length_m', 'Длина, м'],
      ['first_date', 'Первая дата'],
      ['latest_date', 'Последняя дата'],
    ]} />
  }
  return <SimpleRelationTable rows={rows} columns={[
    ['section_name', 'Участок'],
    ['movement_volume', 'Объем'],
    ['movement_count', 'Перевозки'],
    ['stockpile_count', 'Накопители'],
  ]} />
}

function SimpleRelationTable({ rows, columns }: { rows: DbRow[]; columns: [string, string][] }) {
  return (
    <div className="max-h-[460px] overflow-auto rounded-lg border border-border">
      <table className="w-full min-w-[620px] text-[12px]">
        <thead className="sticky top-0 bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            {columns.map(([, label]) => <th key={label} className="px-2 py-2 text-left font-semibold">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} className="border-t border-border/60">
              {columns.map(([key]) => {
                const value = row[key] as DbValue
                const text = typeof value === 'boolean' ? statusText(value) : displayCell(value)
                return <td key={key} className="px-2 py-2 align-top text-text-secondary">{text}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SmallBadge({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'green' | 'gray' }) {
  const cls = tone === 'green'
    ? 'border-green-200 bg-green-50 text-green-800'
    : tone === 'gray'
      ? 'border-border bg-bg-surface text-text-muted'
      : 'border-red-100 bg-red-50 text-accent-burg'
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {children}
    </span>
  )
}

function Message({ tone, text }: { tone: 'error' | 'warning' | 'info'; text: string }) {
  const cls = tone === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : tone === 'info'
      ? 'border-green-200 bg-green-50 text-green-800'
      : 'border-amber-200 bg-amber-50 text-amber-800'
  return (
    <div className={`rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${cls}`}>
      {tone === 'info' ? <Check className="w-3.5 h-3.5 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
      {text}
    </div>
  )
}
