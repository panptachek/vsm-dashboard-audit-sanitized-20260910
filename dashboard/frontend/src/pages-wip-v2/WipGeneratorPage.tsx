import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Layers,
  Loader2,
  Plus,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { useAuth } from '../auth'
import { hasSettingsManagerRights } from '../access'

interface PipelineReport {
  key: string
  label: string
  description: string
  file_type: 'pdf' | 'xlsx'
  period_mode: 'date_to' | 'range' | 'pipeline_default'
  supports_cumulative_as_of_end_date?: boolean
  supports_daily_pk_details?: boolean
  supports_general_equipment_plan_inputs?: boolean
}

interface PipelineExportJob {
  job_id: string
  status: 'queued' | 'running' | 'ready' | 'error' | string
  ready: boolean
  download_url?: string | null
  filename?: string | null
  message?: string | null
  error?: string | null
  size_bytes?: number | null
  stage_label?: string | null
  progress_percent?: number | null
  elapsed_seconds?: number | null
  eta_seconds?: number | null
  estimated_total_seconds?: number | null
}

interface SectionOption {
  code: string
  name: string
  sort_order: number | null
}

interface GeneratorOptions {
  pipeline_reports?: PipelineReport[]
  sections: SectionOption[]
}

interface WorkFilterOptions {
  tags: { name: string; fact_count?: number; units?: string[] }[]
  object_types: { code: string; name: string; fact_count?: number }[]
  objects: {
    code: string
    name: string
    object_type_code?: string
    object_type_name?: string
    section_codes?: string[]
    section_names?: string[]
    fact_count?: number
  }[]
}

interface CheckOption {
  value: string
  label: string
  hint?: string
  detailKind?: 'tag' | 'object_type' | 'object'
  detailValue?: string
}

interface WorkFactRow {
  id: string
  date?: string | null
  section_code?: string | null
  work_type_name?: string | null
  object_name?: string | null
  object_type_name?: string | null
  unit?: string | null
  volume?: number | null
}

interface WorkFactRowsResponse {
  total: number
  rows: WorkFactRow[]
}

interface GeneralReportFilters {
  tags: string[]
  object_type_codes: string[]
  object_codes: string[]
  from_object_type_codes: string[]
  from_object_codes: string[]
  to_object_type_codes: string[]
  to_object_codes: string[]
  quarry_labels: string[]
  materials: string[]
  movement_types: string[]
  source_buckets: string[]
  equipment_classes: string[]
}

interface GeneralReportRowConfig {
  id: string
  code?: string | null
  label?: string | null
  source?: string | null
  enabled?: boolean
  include_in_totals?: boolean
  filters?: Partial<GeneralReportFilters> | null
}

interface GeneralReportBlockConfig {
  id: string
  title?: string | null
  kind?: string | null
  enabled?: boolean
  rows: GeneralReportRowConfig[]
}

interface GeneralReportConfigResponse {
  version: number
  rows?: unknown[]
  blocks: GeneralReportBlockConfig[]
  quarry_options: CheckOption[]
  source_options: CheckOption[]
  material_options: CheckOption[]
  movement_options: CheckOption[]
  equipment_options: CheckOption[]
  object_options: CheckOption[]
  updated_by?: string | null
  updated_at?: string | null
}

type ReportGroupingMode = 'sections' | 'objects'

interface GeneratorReportSectionParameter {
  id: string
  title: string
  enabled: boolean
}

interface GeneratorReportParameter {
  cumulative_as_of_end_date: boolean
  show_daily_pk_details: boolean
  include_quarry_totals: boolean
  grouping: ReportGroupingMode
  work_tags: string[]
  object_type_codes: string[]
  object_codes: string[]
  sections: GeneratorReportSectionParameter[]
}

interface GeneratorReportParametersResponse {
  version: number
  reports: Record<string, GeneratorReportParameter>
  updated_by?: string | null
  updated_at?: string | null
}

interface GeneralReportRowDebugRow {
  id: string
  date?: string | null
  section_code?: string | null
  kind?: string | null
  label?: string | null
  work_type_name?: string | null
  object_name?: string | null
  object_type_name?: string | null
  source_name?: string | null
  source_object_type_name?: string | null
  destination_name?: string | null
  destination_object_type_name?: string | null
  material?: string | null
  movement_label?: string | null
  source_bucket?: string | null
  contractor_name?: string | null
  plate_number?: string | null
  unit_number?: string | null
  shift?: string | null
  unit?: string | null
  volume?: number | null
}

interface GeneralReportRowDebugResponse {
  from: string
  to: string
  kind: 'work_summary' | 'top_quarries' | 'equipment_day' | string
  block_id?: string | null
  row_id?: string | null
  row_label?: string | null
  total: number
  rows: GeneralReportRowDebugRow[]
}

type UnresolvedStatus = 'matched' | 'implicit' | 'unresolved'

interface GeneralReportUnresolvedSummary {
  status: UnresolvedStatus
  label: string
  row_count: number
  total_volume: number
}

interface GeneralReportUnresolvedRow {
  id: string
  date?: string | null
  section_code?: string | null
  status: UnresolvedStatus
  status_label: string
  label?: string | null
  work_type_name?: string | null
  work_type_code?: string | null
  object_name?: string | null
  object_code?: string | null
  object_type_code?: string | null
  object_type_name?: string | null
  resolved_code?: string | null
  resolved_label?: string | null
  source_bucket?: string | null
  contractor_name?: string | null
  shift?: string | null
  unit?: string | null
  volume?: number | null
}

interface GeneralReportUnresolvedResponse {
  from: string
  to: string
  limit: number
  statuses: UnresolvedStatus[]
  truncated: boolean
  summary: GeneralReportUnresolvedSummary[]
  rows: GeneralReportUnresolvedRow[]
}

type GeneratorTabKey = 'export' | 'parameters' | 'unresolved'

const fallbackReports: PipelineReport[] = [
  { key: 'temp_roads', label: 'Отчет по отсыпке за дату', description: 'Временные притрассовые дороги', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'reinforcement_sections', label: 'Отчет по участкам усиления за дату', description: 'Сводка, производственные календари и поставка свай', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'isso_support', label: 'Отсыпка площадок ИССО PDF', description: 'Расширенный отчет с карточками по каждому ИССО за выбранный месяц', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'mainline_structural_scheme', label: 'Структурная схема ОХ PDF', description: 'A3 PDF по участкам ОХ: объекты, РД, даты и статусы отсыпки', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'dim', label: 'Отчет ДиМ', description: 'Форма ДиМ', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'mstroy', label: 'Отчет МСтрой', description: 'Форма МСтрой', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'general', label: 'Общий отчет', description: 'Общая форма', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'simple_section_report', label: 'Простой отчет по участкам', description: 'Перевозки и работы за период без внутренних кодов', file_type: 'xlsx', period_mode: 'range' },
  { key: 'transport_section_report', label: 'Перевозный отчет по участкам', description: 'Перевозки за период: детальные карьеры, укрупненные накопители/конструктивы, недельные и месячные объемы', file_type: 'xlsx', period_mode: 'range' },
  { key: 'financial_plan_fact', label: 'Финансовый план-факт', description: 'Плановые и фактически выполненные работы за период: объемы, ПК, расценки, суммы и разница по участкам', file_type: 'xlsx', period_mode: 'range' },
  { key: 'equipment', label: 'Отчет по технике', description: 'Техника по объектам и участкам', file_type: 'xlsx', period_mode: 'date_to' },
  { key: 'pile_daily_breakdown', label: 'Ведомость участков усиления', description: 'Сваи/ПЖБТ: активность, план/факт по дням, сводный лист', file_type: 'xlsx', period_mode: 'range' },
  { key: 'general_exact_pdf', label: 'Генеральный отчет pdf', description: 'PDF основной таблицы Аналитика из БД через pipeline Генерального отчета', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'general_exact_xlsx', label: 'Генеральный отчет xlsx', description: 'XLSX основной таблицы Аналитика из БД через pipeline Генерального отчета', file_type: 'xlsx', period_mode: 'date_to' },
]

const unresolvedStatusOrder: UnresolvedStatus[] = ['matched', 'implicit', 'unresolved']
const configurableReportKeys = ['dim', 'mstroy', 'mstroy_graph', 'general']
const builtInBlockIds = new Set(['top_quarries', 'work_summary', 'equipment_day'])
const inputCls = 'h-9 w-full rounded-md border border-border bg-white px-2 text-sm text-text-primary focus:border-accent-red/50 focus:outline-none'
const textAreaCls = 'min-h-[72px] w-full rounded-md border border-border bg-white px-2 py-2 text-sm text-text-primary focus:border-accent-red/50 focus:outline-none'

type RowRef = { blockId: string; rowId: string }

type GeneralEquipmentKey = 'dump_truck' | 'excavator' | 'bulldozer'
type GeneralPlanShiftKey = 'day' | 'night'
type GeneralPlanForm = Record<GeneralEquipmentKey, Record<GeneralPlanShiftKey, Record<string, string>>>

const GENERAL_PLAN_SECTION_CODES = ['UCH_1', 'UCH_2', 'UCH_3', 'UCH_4', 'UCH_5', 'UCH_6', 'UCH_7', 'UCH_8'] as const
const GENERAL_PLAN_SHIFTS: Array<{ key: GeneralPlanShiftKey; label: string }> = [
  { key: 'day', label: 'День' },
  { key: 'night', label: 'Ночь' },
]
const GENERAL_PLAN_EQUIPMENT: Array<{ key: GeneralEquipmentKey; label: string; hint: string }> = [
  { key: 'dump_truck', label: 'Самосвалы', hint: 'Плановое количество самосвалов' },
  { key: 'excavator', label: 'Экскаваторы', hint: 'Плановое количество экскаваторов' },
  { key: 'bulldozer', label: 'Бульдозеры', hint: 'Плановое количество бульдозеров' },
]

function isoDateOffset(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateFromIso(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function calendarWeekStartIso(baseIso = isoDateOffset(-1)) {
  const d = dateFromIso(baseIso)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthStartIso(baseIso = isoDateOffset(-1)) {
  const d = dateFromIso(baseIso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function formatDate(value: string) {
  const [year, month, day] = value.split('-')
  return `${day}.${month}.${year}`
}

function filenameFromDisposition(header: string | null) {
  if (!header) return null
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8?.[1]) return decodeURIComponent(utf8[1])
  const ascii = header.match(/filename="([^"]+)"/i)
  return ascii?.[1] ?? null
}

function toggleList(list: string[], value: string) {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}

function buildEmptyGeneralPlanForm(): GeneralPlanForm {
  const form = {} as GeneralPlanForm
  GENERAL_PLAN_EQUIPMENT.forEach(({ key }) => {
    form[key] = { day: {}, night: {} }
    GENERAL_PLAN_SHIFTS.forEach(({ key: shiftKey }) => {
      GENERAL_PLAN_SECTION_CODES.forEach(sectionCode => {
        form[key][shiftKey][sectionCode] = ''
      })
    })
  })
  return form
}

function mergeGeneralPlanSections(sections: SectionOption[]) {
  return GENERAL_PLAN_SECTION_CODES.map((code, index) => {
    const section = sections.find(item => item.code === code)
    return {
      code,
      label: section?.name || `Участок ${index + 1}`,
      shortLabel: code.replace('UCH_', '№'),
    }
  })
}

function normalizeGeneralPlanPayload(form: GeneralPlanForm) {
  const payload: Record<string, Record<string, Record<string, number>>> = {}
  GENERAL_PLAN_EQUIPMENT.forEach(({ key }) => {
    GENERAL_PLAN_SHIFTS.forEach(({ key: shiftKey }) => {
      GENERAL_PLAN_SECTION_CODES.forEach(sectionCode => {
        const raw = form[key][shiftKey][sectionCode]?.trim().replace(',', '.')
        if (!raw) return
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0) return
        payload[key] ??= {}
        payload[key][shiftKey] ??= {}
        payload[key][shiftKey][sectionCode] = value
      })
    })
  })
  return Object.keys(payload).length ? payload : null
}

function normalizeReportParametersDraft(value?: GeneratorReportParametersResponse | null): GeneratorReportParametersResponse | null {
  if (!value?.reports) return null
  return {
    version: value.version || 1,
    reports: Object.fromEntries(
      Object.entries(value.reports).map(([key, report]) => [
        key,
        {
          cumulative_as_of_end_date: Boolean(report.cumulative_as_of_end_date ?? report.show_daily_pk_details),
          show_daily_pk_details: Boolean(report.cumulative_as_of_end_date ?? report.show_daily_pk_details),
          include_quarry_totals: report.include_quarry_totals !== false,
          grouping: report.grouping === 'sections' ? 'sections' : 'objects',
          work_tags: [...(report.work_tags ?? [])],
          object_type_codes: [...(report.object_type_codes ?? [])],
          object_codes: [...(report.object_codes ?? [])],
          sections: (report.sections ?? []).map(section => ({
            id: section.id,
            title: section.title,
            enabled: section.enabled !== false,
          })),
        },
      ]),
    ),
    updated_by: value.updated_by,
    updated_at: value.updated_at,
  }
}

function normalizeFilters(filters?: Partial<GeneralReportFilters> | null): GeneralReportFilters {
  return {
    tags: [...(filters?.tags ?? [])],
    object_type_codes: [...(filters?.object_type_codes ?? [])],
    object_codes: [...(filters?.object_codes ?? [])],
    from_object_type_codes: [...(filters?.from_object_type_codes ?? [])],
    from_object_codes: [...(filters?.from_object_codes ?? [])],
    to_object_type_codes: [...(filters?.to_object_type_codes ?? [])],
    to_object_codes: [...(filters?.to_object_codes ?? [])],
    quarry_labels: [...(filters?.quarry_labels ?? [])],
    materials: [...(filters?.materials ?? [])],
    movement_types: [...(filters?.movement_types ?? [])],
    source_buckets: [...(filters?.source_buckets ?? [])],
    equipment_classes: [...(filters?.equipment_classes ?? [])],
  }
}

function normalizeRow(row: GeneralReportRowConfig): GeneralReportRowConfig {
  return {
    id: row.id,
    code: row.code ?? '',
    label: row.label ?? '',
    source: row.source ?? '',
    enabled: row.enabled !== false,
    include_in_totals: row.include_in_totals !== false,
    filters: normalizeFilters(row.filters),
  }
}

function normalizeBlock(block: GeneralReportBlockConfig): GeneralReportBlockConfig {
  return {
    id: block.id,
    title: block.title ?? '',
    kind: block.kind ?? '',
    enabled: block.enabled !== false,
    rows: (block.rows ?? []).map(normalizeRow),
  }
}

function cloneBlocks(blocks: GeneralReportBlockConfig[]) {
  return blocks.map(block => normalizeBlock(block))
}

function blockSignature(blocks: GeneralReportBlockConfig[]) {
  return JSON.stringify(cloneBlocks(blocks))
}

function composeObjectSelection(typeCodes: string[], objectCodes: string[]) {
  return [
    ...typeCodes.map(code => `type:${code}`),
    ...objectCodes.map(code => `object:${code}`),
  ]
}

function splitObjectScopes(values: string[]) {
  const objectTypeCodes: string[] = []
  const objectCodes: string[] = []
  values.forEach(value => {
    if (value.startsWith('type:')) objectTypeCodes.push(value.slice(5))
    if (value.startsWith('object:')) objectCodes.push(value.slice(7))
  })
  return { objectTypeCodes, objectCodes }
}

function createCustomRow(source: 'work_category' | 'top_quarry' | 'equipment_count' = 'work_category', idPrefix = 'row') {
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return normalizeRow({
    id: `${idPrefix}_${nonce}`,
    code: `${idPrefix}_${nonce}`,
    label: 'Новая строка',
    source,
    enabled: true,
    include_in_totals: true,
    filters: normalizeFilters(),
  })
}

function createCustomBlock(existing: GeneralReportBlockConfig[]) {
  let index = existing.filter(block => block.kind === 'custom').length + 1
  let id = `custom_${index}`
  while (existing.some(block => block.id === id)) {
    index += 1
    id = `custom_${index}`
  }
  return normalizeBlock({
    id,
    title: `Дополнительный блок ${index}`,
    kind: 'custom',
    enabled: true,
    rows: [createCustomRow('work_category', id)],
  })
}

function firstRowRef(blocks: GeneralReportBlockConfig[]): RowRef | null {
  for (const block of blocks) {
    const row = block.rows.find(item => item.enabled !== false) ?? block.rows[0]
    if (row) return { blockId: block.id, rowId: row.id }
  }
  return null
}

function hasRow(blocks: GeneralReportBlockConfig[], ref: RowRef | null) {
  if (!ref) return false
  return blocks.some(block => block.id === ref.blockId && block.rows.some(row => row.id === ref.rowId))
}

function blockLabel(block: GeneralReportBlockConfig) {
  if (block.kind === 'top_quarries') return 'Возка'
  if (block.kind === 'work_summary') return 'Основные работы'
  if (block.kind === 'equipment_day') return 'Техника'
  return 'Доп. блок'
}

function rowSourceKind(block: GeneralReportBlockConfig, row: GeneralReportRowConfig): 'work_summary' | 'top_quarries' | 'equipment_day' {
  const raw = row.source || block.kind || 'work_summary'
  if (raw === 'top_quarry' || raw === 'top_quarries') return 'top_quarries'
  if (raw === 'equipment_count' || raw === 'equipment_day') return 'equipment_day'
  return 'work_summary'
}

function sourceModeLabel(value: string) {
  if (value === 'top_quarry') return 'Возка / верхняя таблица'
  if (value === 'equipment_count') return 'Техника / количество'
  return 'Работы / объем'
}

function sourceBucketLabel(value?: string | null) {
  if (!value) return '—'
  return {
    own: 'Свои силы',
    vad: 'ВАД',
    subcontractor: 'Субподряд',
    mixed: 'Смешанно',
    unknown: 'Не заполнено',
  }[value] ?? value
}

export default function WipGeneratorPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const canManageSettings = hasSettingsManagerRights(user)

  const [activeTab, setActiveTab] = useState<GeneratorTabKey>('export')
  const [selectedSections, setSelectedSections] = useState<string[]>(['all'])
  const [dateFrom, setDateFrom] = useState(calendarWeekStartIso())
  const [dateTo, setDateTo] = useState(isoDateOffset(-1))
  const [activeReportKey, setActiveReportKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [pipelineProgress, setPipelineProgress] = useState<PipelineExportJob | null>(null)
  const [cacheClearBusy, setCacheClearBusy] = useState(false)
  const [tagSelection, setTagSelection] = useState<string[] | null>(null)
  const [objectSelection, setObjectSelection] = useState<string[] | null>(null)
  const [cumulativeAsOfEndDate, setCumulativeAsOfEndDate] = useState(false)
  const [generalPlanExpanded, setGeneralPlanExpanded] = useState(false)
  const [generalPlanForm, setGeneralPlanForm] = useState<GeneralPlanForm>(() => buildEmptyGeneralPlanForm())
  const [reportParameterDraft, setReportParameterDraft] = useState<GeneratorReportParametersResponse | null>(null)
  const [draftBlocks, setDraftBlocks] = useState<GeneralReportBlockConfig[]>([])
  const [selectedRowRef, setSelectedRowRef] = useState<RowRef | null>(null)
  const [unresolvedStatuses, setUnresolvedStatuses] = useState<UnresolvedStatus[]>(['implicit', 'unresolved'])
  const invalidRange = dateFrom > dateTo

  const { data, isLoading } = useQuery<GeneratorOptions>({
    queryKey: ['wip', 'generator', 'options'],
    queryFn: async () => {
      const res = await fetch('/api/wip/generator/options')
      if (!res.ok) throw new Error('Не удалось загрузить настройки генератора')
      return res.json()
    },
  })

  const { data: filterOptions } = useQuery<WorkFilterOptions>({
    queryKey: ['wip', 'analytics', 'work-filter-options', dateFrom, dateTo, selectedSections.join('|')],
    queryFn: async () => {
      const params = new URLSearchParams({ from: dateFrom, to: dateTo })
      if (!selectedSections.includes('all')) params.set('section', selectedSections.join(','))
      const res = await fetch(`/api/wip/analytics/work-filter-options?${params}`)
      if (!res.ok) throw new Error('Не удалось загрузить фильтры работ')
      return res.json()
    },
    staleTime: 120_000,
    enabled: !invalidRange,
  })

  const {
    data: generalConfig,
    isLoading: configLoading,
    isFetching: configFetching,
    error: generalConfigError,
  } = useQuery<GeneralReportConfigResponse>({
    queryKey: ['wip', 'generator', 'general-report-config'],
    queryFn: async () => {
      const res = await fetch('/api/wip/generator/general-report-config')
      if (!res.ok) throw new Error('Не удалось загрузить конфигурацию конструктора')
      return res.json()
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: activeTab !== 'export',
  })

  useEffect(() => {
    if (!generalConfig?.blocks) return
    const nextBlocks = cloneBlocks(generalConfig.blocks)
    setDraftBlocks(nextBlocks)
    setSelectedRowRef(prev => {
      if (hasRow(nextBlocks, prev)) return prev
      return firstRowRef(nextBlocks)
    })
  }, [generalConfig?.updated_at, generalConfig?.blocks])

  const rowPreviewQuery = useQuery<GeneralReportRowDebugResponse>({
    queryKey: ['wip', 'generator', 'row-preview', dateFrom, dateTo, selectedSections.join('|'), selectedRowRef?.blockId, selectedRowRef?.rowId],
    queryFn: async () => {
      if (!selectedRowRef) throw new Error('Строка не выбрана')
      const params = new URLSearchParams({ from: dateFrom, to: dateTo, limit: '40' })
      if (!selectedSections.includes('all')) params.set('section', selectedSections.join(','))
      params.set('block_id', selectedRowRef.blockId)
      params.set('row_id', selectedRowRef.rowId)
      const res = await fetch(`/api/wip/generator/general-report-row-debug?${params}`)
      if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось получить превью строки'))
      return res.json()
    },
    enabled: activeTab === 'parameters' && !invalidRange && Boolean(selectedRowRef),
    staleTime: 30_000,
  })

  const {
    data: reportParameters,
    isFetching: reportParametersFetching,
    error: reportParametersError,
  } = useQuery<GeneratorReportParametersResponse>({
    queryKey: ['wip', 'generator', 'report-parameters'],
    queryFn: async () => {
      const res = await fetch('/api/wip/generator/report-parameters')
      if (!res.ok) throw new Error('Не удалось загрузить параметры отчетов')
      return res.json()
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: activeTab === 'parameters',
  })

  useEffect(() => {
    const next = normalizeReportParametersDraft(reportParameters)
    if (next) setReportParameterDraft(next)
  }, [reportParameters?.updated_at, reportParameters?.reports])

  const unresolvedQuery = useQuery<GeneralReportUnresolvedResponse>({
    queryKey: ['wip', 'generator', 'unresolved', dateFrom, dateTo, selectedSections.join('|'), unresolvedStatuses.join('|')],
    queryFn: async () => {
      const params = new URLSearchParams({ from: dateFrom, to: dateTo, limit: '250' })
      if (!selectedSections.includes('all')) params.set('section', selectedSections.join(','))
      unresolvedStatuses.forEach(status => params.append('status', status))
      const res = await fetch(`/api/wip/generator/general-report-unresolved?${params}`)
      if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось получить очередь неразобранных фактов'))
      return res.json()
    },
    enabled: activeTab === 'unresolved' && !invalidRange,
    staleTime: 30_000,
  })

  const reports = useMemo(() => data?.pipeline_reports?.length ? data.pipeline_reports : fallbackReports, [data?.pipeline_reports])
  const sections = useMemo(() => data?.sections ?? [], [data?.sections])
  const generalPlanSections = useMemo(() => mergeGeneralPlanSections(sections), [sections])
  const generalPlanPayload = useMemo(() => normalizeGeneralPlanPayload(generalPlanForm), [generalPlanForm])
  const hasGeneralPlanReports = useMemo(() => reports.some(reportSupportsGeneralPlanInputs), [reports])
  const tagOptions = useMemo<CheckOption[]>(() => (
    filterOptions?.tags?.map(tag => ({
      value: tag.name,
      label: tag.name,
      hint: `${tag.fact_count ?? 0} строк${tag.units?.length ? ` · ${tag.units.join(', ')}` : ''}`,
      detailKind: 'tag',
      detailValue: tag.name,
    })) ?? []
  ), [filterOptions?.tags])
  const objectOptions = useMemo<CheckOption[]>(() => {
    const typeOptions = filterOptions?.object_types?.map(type => ({
      value: `type:${type.code}`,
      label: `Тип: ${type.name}`,
      hint: `${type.fact_count ?? 0} строк`,
      detailKind: 'object_type' as const,
      detailValue: type.code,
    })) ?? []
    const concreteOptions = filterOptions?.objects?.map(obj => ({
      value: `object:${obj.code}`,
      label: obj.name || obj.code,
      hint: `${objectSectionHint(obj)} · ${obj.fact_count ?? 0} строк`,
      detailKind: 'object' as const,
      detailValue: obj.code,
    })) ?? []
    return [...typeOptions, ...concreteOptions]
  }, [filterOptions?.object_types, filterOptions?.objects])

  const configObjectOptions = useMemo(() => generalConfig?.object_options ?? [], [generalConfig?.object_options])
  const configSourceOptions = useMemo(() => generalConfig?.source_options ?? [], [generalConfig?.source_options])
  const configQuarryOptions = useMemo(() => generalConfig?.quarry_options ?? [], [generalConfig?.quarry_options])
  const configMaterialOptions = useMemo(() => generalConfig?.material_options ?? [], [generalConfig?.material_options])
  const configMovementOptions = useMemo(() => generalConfig?.movement_options ?? [], [generalConfig?.movement_options])
  const configEquipmentOptions = useMemo(() => generalConfig?.equipment_options ?? [], [generalConfig?.equipment_options])

  const savedSignature = useMemo(() => blockSignature(generalConfig?.blocks ?? []), [generalConfig?.blocks])
  const draftSignature = useMemo(() => blockSignature(draftBlocks), [draftBlocks])
  const configDirty = Boolean(generalConfig) && savedSignature !== draftSignature
  const reportParameterSavedSignature = useMemo(() => JSON.stringify(reportParameters?.reports ?? {}), [reportParameters?.reports])
  const reportParameterDraftSignature = useMemo(() => JSON.stringify(reportParameterDraft?.reports ?? {}), [reportParameterDraft?.reports])
  const reportParameterDirty = Boolean(reportParameters && reportParameterDraft) && reportParameterSavedSignature !== reportParameterDraftSignature

  function applyPeriod(from: string, to: string) {
    setDateFrom(from)
    setDateTo(to)
  }

  function toggleSection(sectionCode: string) {
    setSelectedSections(prev => {
      if (sectionCode === 'all') return ['all']
      const withoutAll = prev.filter(code => code !== 'all')
      const next = toggleList(withoutAll, sectionCode)
      return next.length ? next : ['all']
    })
  }

  function updateGeneralPlanValue(equipmentKey: GeneralEquipmentKey, shiftKey: GeneralPlanShiftKey, sectionCode: string, value: string) {
    setGeneralPlanForm(prev => ({
      ...prev,
      [equipmentKey]: {
        ...prev[equipmentKey],
        [shiftKey]: {
          ...prev[equipmentKey][shiftKey],
          [sectionCode]: value,
        },
      },
    }))
  }

  function updateReportParameter(reportKey: string, updater: (report: GeneratorReportParameter) => GeneratorReportParameter) {
    setReportParameterDraft(prev => {
      if (!prev?.reports?.[reportKey]) return prev
      return {
        ...prev,
        reports: {
          ...prev.reports,
          [reportKey]: updater(prev.reports[reportKey]),
        },
      }
    })
  }

  function updateReportParameterSection(reportKey: string, sectionId: string, updater: (section: GeneratorReportSectionParameter) => GeneratorReportSectionParameter) {
    updateReportParameter(reportKey, report => ({
      ...report,
      sections: report.sections.map(section => section.id === sectionId ? updater(section) : section),
    }))
  }

  function addReportParameterSection(reportKey: string) {
    updateReportParameter(reportKey, report => {
      let index = report.sections.filter(section => section.id.startsWith('custom_')).length + 1
      let id = `custom_${index}`
      while (report.sections.some(section => section.id === id)) {
        index += 1
        id = `custom_${index}`
      }
      return {
        ...report,
        sections: [...report.sections, { id, title: `Дополнительный раздел ${index}`, enabled: true }],
      }
    })
  }

  function removeReportParameterSection(reportKey: string, sectionId: string) {
    updateReportParameter(reportKey, report => ({
      ...report,
      sections: report.sections.filter(section => section.id !== sectionId),
    }))
  }

  function replaceBlocks(updater: (prev: GeneralReportBlockConfig[]) => GeneralReportBlockConfig[]) {
    setDraftBlocks(prev => {
      const next = cloneBlocks(updater(prev))
      setSelectedRowRef(current => {
        if (hasRow(next, current)) return current
        return firstRowRef(next)
      })
      return next
    })
  }

  function updateBlock(blockId: string, updater: (block: GeneralReportBlockConfig) => GeneralReportBlockConfig) {
    replaceBlocks(prev => prev.map(block => block.id === blockId ? normalizeBlock(updater(block)) : block))
  }

  function updateRow(blockId: string, rowId: string, updater: (row: GeneralReportRowConfig) => GeneralReportRowConfig) {
    updateBlock(blockId, block => ({
      ...block,
      rows: block.rows.map(row => row.id === rowId ? normalizeRow(updater(row)) : row),
    }))
  }

  function moveBlock(blockId: string, direction: -1 | 1) {
    replaceBlocks(prev => {
      const index = prev.findIndex(block => block.id === blockId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return next
    })
  }

  function removeBlock(blockId: string) {
    replaceBlocks(prev => prev.filter(block => block.id !== blockId))
  }

  function addCustomBlock() {
    replaceBlocks(prev => [...prev, createCustomBlock(prev)])
  }

  function addRowToBlock(blockId: string, source?: 'work_category' | 'top_quarry' | 'equipment_count') {
    updateBlock(blockId, block => ({
      ...block,
      rows: [...block.rows, createCustomRow(source ?? (block.id === 'top_quarries' ? 'top_quarry' : 'work_category'), block.id)],
    }))
  }

  function removeRow(blockId: string, rowId: string) {
    updateBlock(blockId, block => ({
      ...block,
      rows: block.rows.filter(row => row.id !== rowId),
    }))
  }

  async function downloadPipeline(report: PipelineReport) {
    if (dateFrom > dateTo) {
      setError(`Период указан наоборот: дата с ${formatDate(dateFrom)} позже даты по ${formatDate(dateTo)}. Для накопительного итога не нужно выбирать весь период вручную: он считается от первого факта до последнего факта автоматически.`)
      return
    }
    setActiveReportKey(report.key)
    setError(null)
    setStatusMessage(null)
    setPipelineProgress(null)
    try {
      const body: Record<string, unknown> = {
        report_key: report.key,
        section_codes: selectedSections,
        date_from: dateFrom,
        date_to: dateTo,
      }
      const savedReportParameters = reportParameterDraft?.reports?.[report.key] ?? reportParameters?.reports?.[report.key]
      if (supportsWorkFilters(report.key)) {
        if (tagSelection !== null) {
          body.work_tags = tagSelection
        } else if (savedReportParameters?.work_tags?.length) {
          body.work_tags = savedReportParameters.work_tags
        }
        if (objectSelection !== null) {
          const scopes = splitObjectScopes(objectSelection)
          body.object_type_codes = scopes.objectTypeCodes
          body.object_codes = scopes.objectCodes
        } else if ((savedReportParameters?.object_type_codes?.length || savedReportParameters?.object_codes?.length)) {
          body.object_type_codes = savedReportParameters.object_type_codes ?? []
          body.object_codes = savedReportParameters.object_codes ?? []
        }
      }
      if (supportsCumulativeAsOfEndDate(report)) {
        body.cumulative_as_of_end_date = savedReportParameters ? savedReportParameters.cumulative_as_of_end_date : cumulativeAsOfEndDate
      }
      if (reportSupportsGeneralPlanInputs(report) && generalPlanPayload) {
        body.general_equipment_plan_counts = generalPlanPayload
      }

      if (supportsBackgroundExport(report.key)) {
        let job = await startPipelineExportJob(body)
        setPipelineProgress(job)
        setStatusMessage(job.message || 'Файл поставлен в очередь генерации')
        while (!job.ready) {
          if (job.status === 'error') throw new Error(job.error || job.message || 'Не удалось сгенерировать файл')
          await sleep(2500)
          try {
            job = await fetchPipelineExportJob(job.job_id)
          } catch (err) {
            if (isTransientPipelineExportError(err)) {
              setStatusMessage('Связь с API восстанавливается, повторяю проверку статуса...')
              continue
            }
            if (!isRecoverablePipelineExportError(err)) throw err
            job = await startPipelineExportJob(body)
          }
          setPipelineProgress(job)
          setStatusMessage(job.message || (job.status === 'running' ? 'Файл генерируется на сервере' : 'Файл ожидает генерации'))
        }
        setPipelineProgress(job)
        if (!job.download_url) throw new Error('Файл готов, но ссылка на скачивание не получена')
        const res = await fetch(job.download_url)
        if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось скачать готовый файл'))
        await saveDownloadResponse(res, job.filename || `${report.key}.${report.file_type}`)
        setStatusMessage('Скачивание началось')
        return
      }

      const res = await fetch('/api/wip/generator/pipeline-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await responseErrorText(res, 'Ошибка генерации'))
      await saveDownloadResponse(res, `${report.key}.${report.file_type}`)
    } catch (err) {
      setError(downloadErrorText(err))
    } finally {
      setActiveReportKey(null)
      window.setTimeout(() => {
        setStatusMessage(null)
        setPipelineProgress(null)
      }, 2500)
    }
  }

  async function clearXlsxCache() {
    setCacheClearBusy(true)
    setError(null)
    setStatusMessage(null)
    try {
      const res = await fetch('/api/wip/generator/xlsx-cache/clear', { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { removed_files?: number; removed_bytes?: number; detail?: string }
      if (!res.ok) throw new Error(body.detail || 'Не удалось сбросить кеш')
      const mb = ((body.removed_bytes ?? 0) / 1024 / 1024).toFixed(1)
      setStatusMessage(`Кеш XLSX сброшен: файлов ${body.removed_files ?? 0}, ${mb} МБ`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCacheClearBusy(false)
    }
  }

  const saveReportParametersMutation = useMutation({
    mutationFn: async () => {
      if (!reportParameterDraft) throw new Error('Параметры отчетов еще не загружены')
      const res = await fetch('/api/wip/generator/report-parameters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports: reportParameterDraft.reports }),
      })
      if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось сохранить параметры отчетов'))
      return res.json() as Promise<GeneratorReportParametersResponse>
    },
    onMutate: () => {
      setError(null)
      setStatusMessage(null)
    },
    onSuccess: saved => {
      queryClient.setQueryData(['wip', 'generator', 'report-parameters'], saved)
      setReportParameterDraft(normalizeReportParametersDraft(saved))
      setStatusMessage('Параметры отчетов сохранены')
      window.setTimeout(() => setStatusMessage(null), 2500)
    },
    onError: err => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })

  const saveConfigMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wip/generator/general-report-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [], blocks: draftBlocks }),
      })
      if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось сохранить конфигурацию конструктора'))
      return res.json() as Promise<GeneralReportConfigResponse>
    },
    onMutate: () => {
      setError(null)
      setStatusMessage(null)
    },
    onSuccess: saved => {
      queryClient.setQueryData(['wip', 'generator', 'general-report-config'], saved)
      setDraftBlocks(cloneBlocks(saved.blocks))
      setSelectedRowRef(prev => hasRow(saved.blocks, prev) ? prev : firstRowRef(saved.blocks))
      void queryClient.invalidateQueries({ queryKey: ['wip', 'generator', 'row-preview'] })
      void queryClient.invalidateQueries({ queryKey: ['wip', 'generator', 'unresolved'] })
      setStatusMessage('Конфигурация Генератора WIP сохранена')
      window.setTimeout(() => setStatusMessage(null), 2500)
    },
    onError: err => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })

  return (
    <div className="flex min-h-full flex-col bg-bg-primary">
      <div className="border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 text-accent-red" />
            <div>
              <h1 className="font-heading text-xl font-bold text-text-primary">Генератор WIP</h1>
              <p className="text-xs text-text-muted">Экспорт отчетов, операторская настройка конструктора и очередь неразобранных фактов.</p>
            </div>
          </div>
          {activeTab === 'parameters' && generalConfig && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span>{configDirty ? 'Есть несохраненные изменения' : 'Изменений нет'}</span>
              {generalConfig.updated_at && <span>· обновлено {formatDateTime(generalConfig.updated_at)}</span>}
              {generalConfig.updated_by && <span>· {generalConfig.updated_by}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-[1680px] space-y-4 p-4 sm:p-6">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {statusMessage && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
            {statusMessage}
          </div>
        )}
        {pipelineProgress ? <PipelineProgressPanel progress={pipelineProgress} /> : null}

        <section className="rounded-lg border border-border bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-text-muted" />
            <h2 className="font-heading text-sm font-semibold text-text-primary">Период</h2>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <Chip active={dateFrom === isoDateOffset(-1) && dateTo === isoDateOffset(-1)} onClick={() => applyPeriod(isoDateOffset(-1), isoDateOffset(-1))}>Вчера</Chip>
            <Chip active={dateFrom === isoDateOffset(0) && dateTo === isoDateOffset(0)} onClick={() => applyPeriod(isoDateOffset(0), isoDateOffset(0))}>Сегодня</Chip>
            <Chip active={dateFrom === calendarWeekStartIso() && dateTo === isoDateOffset(-1)} onClick={() => applyPeriod(calendarWeekStartIso(), isoDateOffset(-1))}>Неделя</Chip>
            <Chip active={dateFrom === monthStartIso() && dateTo === isoDateOffset(-1)} onClick={() => applyPeriod(monthStartIso(), isoDateOffset(-1))}>Месяц</Chip>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-md">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Дата с</span>
              <input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Дата по</span>
              <input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} className={inputCls} />
            </label>
          </div>
          {invalidRange && <div className="mt-2 text-xs text-accent-red">Дата начала позже даты окончания. Накопительный итог в XLSX считается отдельно, от первого факта до последнего факта.</div>}
        </section>

        <section className="rounded-lg border border-border bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <Layers className="h-4 w-4 text-text-muted" />
            <h2 className="font-heading text-sm font-semibold text-text-primary">Участки</h2>
          </div>
          {isLoading ? (
            <div className="h-9 animate-pulse rounded-md bg-bg-surface" />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Chip active={selectedSections.includes('all')} onClick={() => toggleSection('all')}>Все</Chip>
              {sections.map(section => (
                <Chip key={section.code} active={selectedSections.includes(section.code)} onClick={() => toggleSection(section.code)} title={section.name}>
                  {section.code.replace('UCH_', '№')}
                </Chip>
              ))}
            </div>
          )}
        </section>

        {hasGeneralPlanReports && (
          <section className="rounded-lg border border-border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <CheckSquare className="h-4 w-4 text-text-muted" />
                  <h2 className="font-heading text-sm font-semibold text-text-primary">Генеральный отчет · плановая техника</h2>
                </div>
                <p className="mt-1 text-xs text-text-muted">Эти поля используются в Генеральном отчете PDF/XLSX для планового количества техники по участкам.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setGeneralPlanExpanded(prev => !prev)}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-text-muted hover:border-accent-red/40 hover:text-text-primary"
                >
                  {generalPlanExpanded ? 'Скрыть поля' : 'Показать поля'}
                </button>
                <button
                  type="button"
                  onClick={() => setGeneralPlanForm(buildEmptyGeneralPlanForm())}
                  disabled={!generalPlanPayload}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-text-muted hover:border-accent-red/40 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Очистить
                </button>
              </div>
            </div>
            {generalPlanExpanded && (
              <div className="mt-4 space-y-4">
                {GENERAL_PLAN_EQUIPMENT.map(equipment => (
                  <div key={equipment.key} className="rounded-lg border border-border/80 bg-bg-surface/40 p-3">
                    <div className="mb-3">
                      <h3 className="text-sm font-semibold text-text-primary">{equipment.label}</h3>
                      <p className="text-xs text-text-muted">{equipment.hint}</p>
                    </div>
                    <div className="space-y-3">
                      {GENERAL_PLAN_SHIFTS.map(shift => (
                        <div key={shift.key}>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{shift.label}</div>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                            {generalPlanSections.map(section => (
                              <label key={`${equipment.key}-${shift.key}-${section.code}`} className="block rounded-md border border-border bg-white p-2">
                                <span className="mb-1 block text-[11px] font-semibold text-text-primary">{section.shortLabel}</span>
                                <span className="mb-2 block text-[11px] text-text-muted">{section.label}</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  inputMode="numeric"
                                  value={generalPlanForm[equipment.key][shift.key][section.code]}
                                  onChange={event => updateGeneralPlanValue(equipment.key, shift.key, section.code, event.target.value)}
                                  className={inputCls}
                                  placeholder="0"
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="rounded-lg border border-border bg-white p-4">
          <div className="flex flex-wrap gap-2">
            <TabButton active={activeTab === 'export'} icon={<Download className="h-4 w-4" />} onClick={() => setActiveTab('export')}>
              Экспорт
            </TabButton>
            <TabButton active={activeTab === 'parameters'} icon={<Settings2 className="h-4 w-4" />} onClick={() => setActiveTab('parameters')}>
              Параметры
            </TabButton>
            <TabButton active={activeTab === 'unresolved'} icon={<ClipboardList className="h-4 w-4" />} onClick={() => setActiveTab('unresolved')}>
              Неразобранные факты
            </TabButton>
          </div>
        </section>

        {activeTab === 'export' && (
          <section className="rounded-lg border border-border bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 text-text-muted" />
                <h2 className="font-heading text-sm font-semibold text-text-primary">Отчеты</h2>
              </div>
              <button
                type="button"
                onClick={clearXlsxCache}
                disabled={cacheClearBusy || Boolean(activeReportKey)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-text-muted hover:border-accent-red/40 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title="Сбросить кеш XLSX для ДиМ, МСтрой и Общего отчета"
              >
                {cacheClearBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>{cacheClearBusy ? 'Сбрасываю...' : 'Сбросить кеш'}</span>
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {reports.map(report => {
                const busy = activeReportKey === report.key
                const Icon = report.file_type === 'xlsx' ? FileSpreadsheet : FileText
                return (
                  <div key={report.key} className="rounded-lg border border-border bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-accent-red" />
                          <h3 className="truncate text-sm font-semibold text-text-primary">{report.label}</h3>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                          <span className="rounded-md bg-bg-surface px-2 py-0.5 font-medium uppercase">{report.file_type}</span>
                          <span>{periodText(report, dateFrom, dateTo)}</span>
                        </div>
                        <p className="mt-2 text-[12px] text-text-secondary">{report.description}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => downloadPipeline(report)}
                        disabled={Boolean(activeReportKey) || invalidRange}
                        title={invalidRange ? 'Исправь период: дата начала должна быть не позже даты окончания' : undefined}
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-accent-red px-3 text-sm font-semibold text-white hover:bg-accent-burg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        <span>{busy ? 'Готовлю...' : 'Скачать'}</span>
                      </button>
                    </div>
                    {(supportsCumulativeAsOfEndDate(report) || supportsWorkFilters(report.key)) && (
                      <div className="relative mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        {supportsCumulativeAsOfEndDate(report) && (
                          <label className="mr-2 inline-flex min-h-8 items-start gap-2 rounded-md border border-border bg-bg-surface px-2.5 py-2 text-xs text-text-primary">
                            <input
                              type="checkbox"
                              checked={cumulativeAsOfEndDate}
                              onChange={event => setCumulativeAsOfEndDate(event.target.checked)}
                              className="mt-0.5 h-3.5 w-3.5 rounded border-border text-accent-red focus:ring-accent-red"
                            />
                            <span>
                              <span className="block font-semibold">Накопительно на последний день</span>
                              <span className="block text-[11px] text-text-muted">Отчет строится по последней выбранной дате с накопительным итогом на нее</span>
                            </span>
                          </label>
                        )}
                        {supportsWorkFilters(report.key) && (
                          <>
                            <FilterButton
                              label="Теги"
                              options={tagOptions}
                              selection={tagSelection}
                              dateFrom={dateFrom}
                              dateTo={dateTo}
                              selectedSections={selectedSections}
                              onChange={setTagSelection}
                            />
                            <FilterButton
                              label="Объекты"
                              options={objectOptions}
                              selection={objectSelection}
                              dateFrom={dateFrom}
                              dateTo={dateTo}
                              selectedSections={selectedSections}
                              onChange={setObjectSelection}
                            />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {activeTab === 'parameters' && (
          <section className="space-y-4 rounded-lg border border-border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-heading text-sm font-semibold text-text-primary">Параметры отчетов</h2>
                <p className="mt-1 max-w-4xl text-xs text-text-muted">
                  Сохраненные правила применяются к ДиМ, МСтрой и Общему отчету при следующей генерации.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => saveReportParametersMutation.mutate()}
                  disabled={!canManageSettings || !reportParameterDirty || saveReportParametersMutation.isPending}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-accent-red px-3 text-sm font-semibold text-white hover:bg-accent-burg disabled:cursor-not-allowed disabled:opacity-50"
                  title={!canManageSettings ? 'Нет прав на сохранение настроек' : undefined}
                >
                  {saveReportParametersMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Сохранить параметры
                </button>
              </div>
            </div>

            {reportParametersError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
                {reportParametersError instanceof Error ? reportParametersError.message : String(reportParametersError)}
              </div>
            )}

            <ReportParametersPanel
              reports={reports.filter(report => configurableReportKeys.includes(report.key))}
              draft={reportParameterDraft}
              isFetching={reportParametersFetching}
              canManageSettings={canManageSettings}
              tagOptions={tagOptions}
              objectOptions={configObjectOptions.length ? configObjectOptions : objectOptions}
              dateFrom={dateFrom}
              dateTo={dateTo}
              selectedSections={selectedSections}
              onUpdateReport={updateReportParameter}
              onUpdateSection={updateReportParameterSection}
              onAddSection={addReportParameterSection}
              onRemoveSection={removeReportParameterSection}
            />

            <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-4">
              <div>
                <h2 className="font-heading text-sm font-semibold text-text-primary">Конструктор строк и блоков</h2>
                <p className="mt-1 max-w-4xl text-xs text-text-muted">
                  Редактор блоков, строк и фильтров с предпросмотром фактов по выбранному периоду и участкам.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={addCustomBlock}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-semibold text-text-primary hover:border-accent-red/40"
                >
                  <Plus className="h-4 w-4" />
                  Добавить блок
                </button>
                <button
                  type="button"
                  onClick={() => saveConfigMutation.mutate()}
                  disabled={!canManageSettings || !configDirty || saveConfigMutation.isPending}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-accent-red px-3 text-sm font-semibold text-white hover:bg-accent-burg disabled:cursor-not-allowed disabled:opacity-50"
                  title={!canManageSettings ? 'Нет прав на сохранение настроек' : undefined}
                >
                  {saveConfigMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Сохранить
                </button>
              </div>
            </div>

            {!canManageSettings && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                У тебя только просмотр конструктора. Для записи нужно право «Изменение настроек».
              </div>
            )}

            {generalConfigError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
                {generalConfigError instanceof Error ? generalConfigError.message : String(generalConfigError)}
              </div>
            )}

            {configLoading ? (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.9fr)]">
                <div className="h-[520px] animate-pulse rounded-lg bg-bg-surface" />
                <div className="h-[520px] animate-pulse rounded-lg bg-bg-surface" />
              </div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.9fr)]">
                <div className="space-y-4">
                  {draftBlocks.map((block, blockIndex) => {
                    const canAddRow = block.id === 'top_quarries' || block.kind === 'custom'
                    const canDeleteBlock = !builtInBlockIds.has(block.id)
                    return (
                      <div key={block.id} className="rounded-xl border border-border bg-bg-primary/20 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(220px,1fr)_150px]">
                            <label className="block min-w-0">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Заголовок блока</span>
                              <input
                                value={block.title ?? ''}
                                onChange={event => updateBlock(block.id, current => ({ ...current, title: event.target.value }))}
                                className={inputCls}
                              />
                            </label>
                            <div className="flex flex-wrap items-end gap-2">
                              <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-text-muted">{blockLabel(block)}</span>
                              {configFetching && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <TogglePill active={block.enabled !== false} onClick={() => updateBlock(block.id, current => ({ ...current, enabled: !(current.enabled !== false) }))} label={block.enabled !== false ? 'Включен' : 'Выключен'} />
                            <IconButton disabled={blockIndex === 0} onClick={() => moveBlock(block.id, -1)} title="Поднять блок"><ArrowUp className="h-4 w-4" /></IconButton>
                            <IconButton disabled={blockIndex === draftBlocks.length - 1} onClick={() => moveBlock(block.id, 1)} title="Опустить блок"><ArrowDown className="h-4 w-4" /></IconButton>
                            {canAddRow && (
                              <button
                                type="button"
                                onClick={() => addRowToBlock(block.id)}
                                className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-white px-2 text-xs font-semibold text-text-primary hover:border-accent-red/40"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Строка
                              </button>
                            )}
                            {canDeleteBlock && (
                              <IconButton onClick={() => removeBlock(block.id)} title="Удалить блок"><Trash2 className="h-4 w-4" /></IconButton>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 space-y-3">
                          {block.rows.map((row, rowIndex) => {
                            const rowKind = rowSourceKind(block, row)
                            const activeObjectSelection = composeObjectSelection((row.filters as GeneralReportFilters).object_type_codes, (row.filters as GeneralReportFilters).object_codes)
                            const activeFromSelection = composeObjectSelection((row.filters as GeneralReportFilters).from_object_type_codes, (row.filters as GeneralReportFilters).from_object_codes)
                            const activeToSelection = composeObjectSelection((row.filters as GeneralReportFilters).to_object_type_codes, (row.filters as GeneralReportFilters).to_object_codes)
                            const isSelected = selectedRowRef?.blockId === block.id && selectedRowRef?.rowId === row.id
                            const canDeleteRow = block.kind === 'custom' || (block.id === 'top_quarries' && !String(row.code || '').trim())
                            return (
                              <div key={row.id} className={`rounded-lg border p-3 ${isSelected ? 'border-accent-red/50 bg-red-50/30' : 'border-border bg-white'}`}>
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)]">
                                    <label className="block min-w-0">
                                      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Подпись строки</span>
                                      <input
                                        value={row.label ?? ''}
                                        onChange={event => updateRow(block.id, row.id, current => ({ ...current, label: event.target.value }))}
                                        className={inputCls}
                                      />
                                    </label>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                      <label className="block">
                                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Код</span>
                                        <input
                                          value={row.code ?? ''}
                                          onChange={event => updateRow(block.id, row.id, current => ({ ...current, code: event.target.value }))}
                                          disabled={block.id === 'work_summary' || block.id === 'equipment_day'}
                                          className={`${inputCls} disabled:bg-bg-surface disabled:text-text-muted`}
                                        />
                                      </label>
                                      <label className="block">
                                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Источник</span>
                                        <select
                                          value={row.source || (block.id === 'top_quarries' ? 'top_quarry' : block.id === 'equipment_day' ? 'equipment_count' : 'work_category')}
                                          disabled={block.id === 'work_summary' || block.id === 'top_quarries' || block.id === 'equipment_day'}
                                          onChange={event => updateRow(block.id, row.id, current => ({ ...current, source: event.target.value }))}
                                          className={`${inputCls} disabled:bg-bg-surface disabled:text-text-muted`}
                                        >
                                          <option value="work_category">{sourceModeLabel('work_category')}</option>
                                          <option value="top_quarry">{sourceModeLabel('top_quarry')}</option>
                                          <option value="equipment_count">{sourceModeLabel('equipment_count')}</option>
                                        </select>
                                      </label>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <TogglePill active={row.enabled !== false} onClick={() => updateRow(block.id, row.id, current => ({ ...current, enabled: !(current.enabled !== false) }))} label={row.enabled !== false ? 'Вкл' : 'Выкл'} />
                                    <TogglePill active={row.include_in_totals !== false} onClick={() => updateRow(block.id, row.id, current => ({ ...current, include_in_totals: !(current.include_in_totals !== false) }))} label={row.include_in_totals !== false ? 'В итогах' : 'Без итогов'} />
                                    <button
                                      type="button"
                                      onClick={() => setSelectedRowRef({ blockId: block.id, rowId: row.id })}
                                      className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-semibold ${isSelected ? 'border-accent-red bg-red-50 text-accent-red' : 'border-border bg-white text-text-primary hover:border-accent-red/40'}`}
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                      Превью
                                    </button>
                                    {canDeleteRow && (
                                      <IconButton onClick={() => removeRow(block.id, row.id)} title="Удалить строку"><Trash2 className="h-4 w-4" /></IconButton>
                                    )}
                                  </div>
                                </div>

                                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                                  <FilterField
                                    label="Теги"
                                    options={tagOptions}
                                    selection={(row.filters as GeneralReportFilters).tags.length ? (row.filters as GeneralReportFilters).tags : null}
                                    dateFrom={dateFrom}
                                    dateTo={dateTo}
                                    selectedSections={selectedSections}
                                    onChange={next => updateRow(block.id, row.id, current => ({
                                      ...current,
                                      filters: { ...(current.filters ?? normalizeFilters()), tags: next ?? [] },
                                    }))}
                                  />
                                  <FilterField
                                    label="Источники"
                                    options={configSourceOptions}
                                    selection={(row.filters as GeneralReportFilters).source_buckets.length ? (row.filters as GeneralReportFilters).source_buckets : null}
                                    dateFrom={dateFrom}
                                    dateTo={dateTo}
                                    selectedSections={selectedSections}
                                    showDetails={false}
                                    onChange={next => updateRow(block.id, row.id, current => ({
                                      ...current,
                                      filters: { ...(current.filters ?? normalizeFilters()), source_buckets: next ?? [] },
                                    }))}
                                  />

                                  {rowKind === 'work_summary' && (
                                    <FilterField
                                      label="Объекты / типы"
                                      options={configObjectOptions}
                                      selection={activeObjectSelection.length ? activeObjectSelection : null}
                                      dateFrom={dateFrom}
                                      dateTo={dateTo}
                                      selectedSections={selectedSections}
                                      onChange={next => {
                                        const scopes = splitObjectScopes(next ?? [])
                                        updateRow(block.id, row.id, current => ({
                                          ...current,
                                          filters: {
                                            ...(current.filters ?? normalizeFilters()),
                                            object_type_codes: scopes.objectTypeCodes,
                                            object_codes: scopes.objectCodes,
                                          },
                                        }))
                                      }}
                                    />
                                  )}

                                  {rowKind === 'top_quarries' && (
                                    <>
                                      <FilterField
                                        label="Карьеры"
                                        options={configQuarryOptions}
                                        selection={(row.filters as GeneralReportFilters).quarry_labels.length ? (row.filters as GeneralReportFilters).quarry_labels : null}
                                        dateFrom={dateFrom}
                                        dateTo={dateTo}
                                        selectedSections={selectedSections}
                                        showDetails={false}
                                        onChange={next => updateRow(block.id, row.id, current => ({
                                          ...current,
                                          filters: { ...(current.filters ?? normalizeFilters()), quarry_labels: next ?? [] },
                                        }))}
                                      />
                                      <FilterField
                                        label="Материалы"
                                        options={configMaterialOptions}
                                        selection={(row.filters as GeneralReportFilters).materials.length ? (row.filters as GeneralReportFilters).materials : null}
                                        dateFrom={dateFrom}
                                        dateTo={dateTo}
                                        selectedSections={selectedSections}
                                        showDetails={false}
                                        onChange={next => updateRow(block.id, row.id, current => ({
                                          ...current,
                                          filters: { ...(current.filters ?? normalizeFilters()), materials: next ?? [] },
                                        }))}
                                      />
                                      <FilterField
                                        label="Вид движения"
                                        options={configMovementOptions}
                                        selection={(row.filters as GeneralReportFilters).movement_types.length ? (row.filters as GeneralReportFilters).movement_types : null}
                                        dateFrom={dateFrom}
                                        dateTo={dateTo}
                                        selectedSections={selectedSections}
                                        showDetails={false}
                                        onChange={next => updateRow(block.id, row.id, current => ({
                                          ...current,
                                          filters: { ...(current.filters ?? normalizeFilters()), movement_types: next ?? [] },
                                        }))}
                                      />
                                      <FilterField
                                        label="Откуда"
                                        options={configObjectOptions}
                                        selection={activeFromSelection.length ? activeFromSelection : null}
                                        dateFrom={dateFrom}
                                        dateTo={dateTo}
                                        selectedSections={selectedSections}
                                        onChange={next => {
                                          const scopes = splitObjectScopes(next ?? [])
                                          updateRow(block.id, row.id, current => ({
                                            ...current,
                                            filters: {
                                              ...(current.filters ?? normalizeFilters()),
                                              from_object_type_codes: scopes.objectTypeCodes,
                                              from_object_codes: scopes.objectCodes,
                                            },
                                          }))
                                        }}
                                      />
                                      <FilterField
                                        label="Куда"
                                        options={configObjectOptions}
                                        selection={activeToSelection.length ? activeToSelection : null}
                                        dateFrom={dateFrom}
                                        dateTo={dateTo}
                                        selectedSections={selectedSections}
                                        onChange={next => {
                                          const scopes = splitObjectScopes(next ?? [])
                                          updateRow(block.id, row.id, current => ({
                                            ...current,
                                            filters: {
                                              ...(current.filters ?? normalizeFilters()),
                                              to_object_type_codes: scopes.objectTypeCodes,
                                              to_object_codes: scopes.objectCodes,
                                            },
                                          }))
                                        }}
                                      />
                                    </>
                                  )}

                                  {rowKind === 'equipment_day' && (
                                    <FilterField
                                      label="Классы техники"
                                      options={configEquipmentOptions}
                                      selection={(row.filters as GeneralReportFilters).equipment_classes.length ? (row.filters as GeneralReportFilters).equipment_classes : null}
                                      dateFrom={dateFrom}
                                      dateTo={dateTo}
                                      selectedSections={selectedSections}
                                      showDetails={false}
                                      onChange={next => updateRow(block.id, row.id, current => ({
                                        ...current,
                                        filters: { ...(current.filters ?? normalizeFilters()), equipment_classes: next ?? [] },
                                      }))}
                                    />
                                  )}
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
                                  <span className="rounded bg-bg-surface px-2 py-1">Источник: {sourceModeLabel(row.source || (rowKind === 'top_quarries' ? 'top_quarry' : rowKind === 'equipment_day' ? 'equipment_count' : 'work_category'))}</span>
                                  <span className="rounded bg-bg-surface px-2 py-1">Строка #{rowIndex + 1}</span>
                                  {block.kind === 'custom' && <span className="rounded bg-bg-surface px-2 py-1">WIP доп. блок</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
                  <div className="rounded-xl border border-border bg-white p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-text-primary">Превью выбранной строки</div>
                        <div className="text-xs text-text-muted">Текущий период и участки применяются сразу, без сохранения.</div>
                      </div>
                      {rowPreviewQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                    </div>
                    {invalidRange ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Исправь период, чтобы получить превью строки.</div>
                    ) : rowPreviewQuery.error ? (
                      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
                        {rowPreviewQuery.error instanceof Error ? rowPreviewQuery.error.message : String(rowPreviewQuery.error)}
                      </div>
                    ) : rowPreviewQuery.isLoading || !rowPreviewQuery.data ? (
                      <div className="h-64 animate-pulse rounded-lg bg-bg-surface" />
                    ) : (
                      <GeneralReportPreviewPanel data={rowPreviewQuery.data} />
                    )}
                  </div>

                  <div className="rounded-xl border border-border bg-white p-4 text-xs text-text-muted">
                    <div className="font-semibold text-text-primary">Что уже можно оператору</div>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      <li>Включать/выключать блоки и строки.</li>
                      <li>Менять заголовки и бизнес-фильтры без вмешательства в код.</li>
                      <li>Добавлять дополнительные WIP-блоки для ручной группировки.</li>
                      <li>Сразу видеть фактические строки, которые попадут в выбранную настройку.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'unresolved' && (
          <section className="space-y-4 rounded-lg border border-border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-heading text-sm font-semibold text-text-primary">Очередь неразобранных фактов</h2>
                <p className="mt-1 max-w-4xl text-xs text-text-muted">
                  Показывает факты, которые уже явно настроены, пойманы типовой логикой или пока не попали ни в одну строку конструктора.
                  Это рабочий список для добора правил без AI-эвристик.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {unresolvedStatusOrder.map(status => (
                  <Chip
                    key={status}
                    active={unresolvedStatuses.includes(status)}
                    onClick={() => setUnresolvedStatuses(prev => {
                      const next = prev.includes(status) ? prev.filter(item => item !== status) : [...prev, status]
                      return next.length ? next as UnresolvedStatus[] : [status]
                    })}
                  >
                    {unresolvedStatusCaption(status)}
                  </Chip>
                ))}
              </div>
            </div>

            {invalidRange ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Исправь период, чтобы получить очередь фактов.</div>
            ) : unresolvedQuery.isLoading ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="h-24 animate-pulse rounded-lg bg-bg-surface" />
                  <div className="h-24 animate-pulse rounded-lg bg-bg-surface" />
                  <div className="h-24 animate-pulse rounded-lg bg-bg-surface" />
                </div>
                <div className="h-72 animate-pulse rounded-lg bg-bg-surface" />
              </div>
            ) : unresolvedQuery.error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
                {unresolvedQuery.error instanceof Error ? unresolvedQuery.error.message : String(unresolvedQuery.error)}
              </div>
            ) : unresolvedQuery.data ? (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  {unresolvedQuery.data.summary.map(item => (
                    <div key={item.status} className="rounded-lg border border-border bg-bg-primary/20 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">{item.label}</div>
                      <div className="mt-2 text-2xl font-semibold text-text-primary">{compactNumber(item.row_count)}</div>
                      <div className="mt-1 text-xs text-text-muted">Объем: {compactNumber(item.total_volume)}</div>
                    </div>
                  ))}
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                  <div className="overflow-auto">
                    <table className="min-w-full border-collapse text-left text-sm">
                      <thead className="bg-bg-surface text-text-muted">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Статус</th>
                          <th className="px-3 py-2 font-semibold">Дата</th>
                          <th className="px-3 py-2 font-semibold">Участок</th>
                          <th className="px-3 py-2 font-semibold">Факт</th>
                          <th className="px-3 py-2 font-semibold">Объект</th>
                          <th className="px-3 py-2 font-semibold">Куда попадает</th>
                          <th className="px-3 py-2 font-semibold">Источник</th>
                          <th className="px-3 py-2 text-right font-semibold">Объем</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unresolvedQuery.data.rows.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="px-3 py-6 text-center text-sm text-text-muted">По выбранному фильтру строк нет.</td>
                          </tr>
                        ) : unresolvedQuery.data.rows.map(row => (
                          <tr key={row.id} className="border-t border-border align-top">
                            <td className="px-3 py-2"><StatusBadge status={row.status}>{row.status_label}</StatusBadge></td>
                            <td className="whitespace-nowrap px-3 py-2 text-text-muted">{formatShortDate(row.date)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-text-muted">{sectionLabel(row.section_code)}</td>
                            <td className="px-3 py-2 text-text-primary">
                              <div className="font-medium">{row.label || row.work_type_name || '—'}</div>
                              <div className="text-xs text-text-muted">{row.work_type_name || '—'}</div>
                            </td>
                            <td className="px-3 py-2 text-text-muted">
                              <div>{row.object_name || '—'}</div>
                              <div className="text-xs">{row.object_type_name || '—'}{row.object_code ? ` · ${row.object_code}` : ''}</div>
                            </td>
                            <td className="px-3 py-2 text-text-primary">
                              {row.resolved_label ? (
                                <>
                                  <div className="font-medium">{row.resolved_label}</div>
                                  {row.resolved_code && <div className="text-xs text-text-muted">{row.resolved_code}</div>}
                                </>
                              ) : '—'}
                            </td>
                            <td className="px-3 py-2 text-text-muted">
                              <div>{sourceBucketLabel(row.source_bucket)}</div>
                              <div className="text-xs">{row.contractor_name || '—'}</div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-text-primary">{compactNumber(row.volume)} {row.unit || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {unresolvedQuery.data.truncated && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Показаны первые {unresolvedQuery.data.limit} строк. Для точечной настройки сузь период или участки.
                  </div>
                )}
              </>
            ) : null}
          </section>
        )}
      </div>
    </div>
  )
}

function ReportParametersPanel({
  reports,
  draft,
  isFetching,
  canManageSettings,
  tagOptions,
  objectOptions,
  dateFrom,
  dateTo,
  selectedSections,
  onUpdateReport,
  onUpdateSection,
  onAddSection,
  onRemoveSection,
}: {
  reports: PipelineReport[]
  draft: GeneratorReportParametersResponse | null
  isFetching: boolean
  canManageSettings: boolean
  tagOptions: CheckOption[]
  objectOptions: CheckOption[]
  dateFrom: string
  dateTo: string
  selectedSections: string[]
  onUpdateReport: (reportKey: string, updater: (report: GeneratorReportParameter) => GeneratorReportParameter) => void
  onUpdateSection: (reportKey: string, sectionId: string, updater: (section: GeneratorReportSectionParameter) => GeneratorReportSectionParameter) => void
  onAddSection: (reportKey: string) => void
  onRemoveSection: (reportKey: string, sectionId: string) => void
}) {
  if (!draft) {
    return <div className="h-64 animate-pulse rounded-lg bg-bg-surface" />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>{isFetching ? 'Обновляю параметры...' : 'Параметры загружены'}</span>
        {draft.updated_at && <span>· обновлено {formatDateTime(draft.updated_at)}</span>}
        {draft.updated_by && <span>· {draft.updated_by}</span>}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {reports.map(report => {
          const params = draft.reports[report.key]
          if (!params) return null
          const objectSelection = composeObjectSelection(params.object_type_codes ?? [], params.object_codes ?? [])
          return (
            <div key={report.key} className="rounded-xl border border-border bg-bg-primary/20 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">{report.label}</h3>
                  <div className="mt-1 text-xs text-text-muted">{report.file_type.toUpperCase()} · {report.period_mode === 'range' ? 'период' : 'дата'}</div>
                </div>
                <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-text-muted">{report.key}</span>
              </div>

              <div className="space-y-2">
                {supportsCumulativeAsOfEndDate(report) && (
                  <ToggleRow
                    label="Накопительные итоги по состоянию на последний день"
                    active={params.cumulative_as_of_end_date}
                    disabled={!canManageSettings}
                    onChange={active => onUpdateReport(report.key, current => ({
                      ...current,
                      cumulative_as_of_end_date: active,
                      show_daily_pk_details: active,
                    }))}
                  />
                )}
                <ToggleRow
                  label="Итоги по карьерам"
                  active={params.include_quarry_totals}
                  disabled={!canManageSettings}
                  onChange={active => onUpdateReport(report.key, current => ({ ...current, include_quarry_totals: active }))}
                />
                {(report.key === 'mstroy' || report.key === 'general') && (
                  <label className="block rounded-md border border-border bg-white p-2">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Группировка</span>
                    <select
                      value={params.grouping}
                      disabled={!canManageSettings}
                      onChange={event => onUpdateReport(report.key, current => ({ ...current, grouping: event.target.value === 'objects' ? 'objects' : 'sections' }))}
                      className={`${inputCls} disabled:bg-bg-surface disabled:text-text-muted`}
                    >
                      <option value="sections">По участкам</option>
                      <option value="objects">По объектам</option>
                    </select>
                  </label>
                )}
              </div>

              <div className="mt-3 grid gap-2">
                <FilterField
                  label="Работы"
                  options={tagOptions}
                  selection={params.work_tags.length ? params.work_tags : null}
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  selectedSections={selectedSections}
                  onChange={next => onUpdateReport(report.key, current => ({ ...current, work_tags: next ?? [] }))}
                />
                <FilterField
                  label="Объекты / типы"
                  options={objectOptions}
                  selection={objectSelection.length ? objectSelection : null}
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  selectedSections={selectedSections}
                  onChange={next => {
                    const scopes = splitObjectScopes(next ?? [])
                    onUpdateReport(report.key, current => ({
                      ...current,
                      object_type_codes: scopes.objectTypeCodes,
                      object_codes: scopes.objectCodes,
                    }))
                  }}
                />
              </div>

              <div className="mt-4 rounded-lg border border-border bg-white p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Разделы отчета</div>
                  <button
                    type="button"
                    onClick={() => onAddSection(report.key)}
                    disabled={!canManageSettings}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-semibold text-text-primary hover:border-accent-red/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Раздел
                  </button>
                </div>
                <div className="space-y-2">
                  {params.sections.map(section => {
                    const custom = section.id.startsWith('custom_')
                    return (
                      <div key={section.id} className="grid gap-2 rounded-md border border-border bg-bg-surface/50 p-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                        <button
                          type="button"
                          disabled={!canManageSettings}
                          onClick={() => onUpdateSection(report.key, section.id, current => ({ ...current, enabled: !current.enabled }))}
                          className={`h-8 rounded-md px-2 text-[11px] font-semibold ${section.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-white text-text-muted'} disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          {section.enabled ? 'Вкл' : 'Выкл'}
                        </button>
                        <input
                          value={section.title}
                          disabled={!canManageSettings}
                          onChange={event => onUpdateSection(report.key, section.id, current => ({ ...current, title: event.target.value }))}
                          className={`${inputCls} disabled:bg-bg-surface disabled:text-text-muted`}
                        />
                        {custom ? (
                          <IconButton disabled={!canManageSettings} onClick={() => onRemoveSection(report.key, section.id)} title="Удалить раздел"><Trash2 className="h-4 w-4" /></IconButton>
                        ) : (
                          <span className="flex h-8 items-center rounded bg-white px-2 font-mono text-[10px] text-text-muted">{section.id}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToggleRow({ label, active, disabled, onChange }: { label: string; active: boolean; disabled?: boolean; onChange: (active: boolean) => void }) {
  return (
    <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text-primary">
      <span className="font-semibold">{label}</span>
      <input
        type="checkbox"
        checked={active}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-border text-accent-red focus:ring-accent-red disabled:opacity-50"
      />
    </label>
  )
}

function GeneralReportPreviewPanel({ data }: { data: GeneralReportRowDebugResponse }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-lg bg-bg-surface p-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Блок</div>
          <div className="font-semibold text-text-primary">{previewKindLabel(data.kind)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Строка</div>
          <div className="font-semibold text-text-primary">{data.row_label || data.row_id || '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Итог</div>
          <div className="font-semibold text-text-primary">{compactNumber(data.total)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Выборка</div>
          <div className="font-semibold text-text-primary">{data.rows.length} строк</div>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="max-h-[560px] overflow-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-white text-text-muted shadow-sm">
              <tr>
                <th className="px-2 py-2 font-semibold">Дата</th>
                <th className="px-2 py-2 font-semibold">Участок</th>
                <th className="px-2 py-2 font-semibold">Факт</th>
                <th className="px-2 py-2 font-semibold">Контекст</th>
                <th className="px-2 py-2 font-semibold">Источник</th>
                <th className="px-2 py-2 text-right font-semibold">Объем</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-text-muted">Факты по строке не найдены.</td>
                </tr>
              ) : data.rows.map(row => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-2 py-2 text-text-muted">{formatShortDate(row.date)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-text-muted">{sectionLabel(row.section_code)}</td>
                  <td className="px-2 py-2 text-text-primary">
                    <div className="font-medium">{row.label || row.work_type_name || row.material || row.plate_number || '—'}</div>
                    {row.work_type_name && <div className="text-[11px] text-text-muted">{row.work_type_name}</div>}
                  </td>
                  <td className="px-2 py-2 text-text-muted">
                    <div>{row.object_name || row.source_name || row.material || row.object_type_name || '—'}</div>
                    {(row.destination_name || row.plate_number || row.unit_number) && (
                      <div className="text-[11px]">
                        {[row.destination_name, row.plate_number, row.unit_number].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-text-muted">
                    <div>{sourceBucketLabel(row.source_bucket)}</div>
                    <div className="text-[11px]">{row.contractor_name || '—'}</div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-text-primary">{compactNumber(row.volume)} {row.unit || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const transientApiStatuses = new Set([502, 503, 504])

function responseErrorText(res: Response, fallback: string) {
  return (async () => {
    if (isTransientApiStatus(res.status)) return transientApiErrorText(fallback)
    const contentType = res.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json')
      ? await res.json().catch(() => ({ detail: fallback }))
      : { detail: await res.text().catch(() => fallback) }
    return cleanErrorText(errorDetailText((body as { detail?: unknown }).detail), fallback)
  })()
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

function pipelineExportError(message: string, status?: number) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

function isTransientApiStatus(status?: number) {
  return transientApiStatuses.has(Number(status))
}

function isTransientPipelineExportError(err: unknown) {
  if (err instanceof TypeError) return true
  const status = err && typeof err === 'object' && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : 0
  return isTransientApiStatus(status)
}

function isRecoverablePipelineExportError(err: unknown) {
  const status = err && typeof err === 'object' && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : 0
  return status === 404 || status === 409
}

async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { attempts?: number; delayMs?: number } = {},
) {
  const attempts = Math.max(1, options.attempts ?? 3)
  const delayMs = Math.max(100, options.delayMs ?? 1200)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(input, init)
      if (!isTransientApiStatus(res.status) || attempt === attempts) return res
    } catch (err) {
      if (attempt === attempts) throw err
    }
    await sleep(delayMs * attempt)
  }
  throw new TypeError('API временно недоступен')
}

async function startPipelineExportJob(body: Record<string, unknown>) {
  const res = await fetchWithTransientRetry('/api/wip/generator/pipeline-export-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { attempts: 6, delayMs: 1500 })
  if (!res.ok) throw pipelineExportError(await responseErrorText(res, 'Не удалось поставить файл в очередь генерации'), res.status)
  return res.json() as Promise<PipelineExportJob>
}

async function fetchPipelineExportJob(jobId: string) {
  const res = await fetchWithTransientRetry(`/api/wip/generator/pipeline-export-jobs/${encodeURIComponent(jobId)}`, undefined, { attempts: 3, delayMs: 1200 })
  if (!res.ok) throw pipelineExportError(await responseErrorText(res, 'Не удалось получить статус генерации'), res.status)
  return res.json() as Promise<PipelineExportJob>
}

function PipelineProgressPanel({ progress }: { progress: PipelineExportJob }) {
  const percent = typeof progress.progress_percent === 'number'
    ? Math.max(0, Math.min(100, progress.progress_percent))
    : null
  const stage = progress.stage_label || progress.message || (progress.status === 'queued' ? 'Ожидание генерации' : 'Генерация файла')
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 font-semibold">{stage}</div>
        {percent !== null ? <div className="font-mono text-[12px] text-blue-800">{percent}%</div> : null}
      </div>
      <div className="h-2 overflow-hidden rounded bg-white">
        <div className="h-full rounded bg-accent-red transition-[width] duration-500" style={{ width: `${percent ?? 6}%` }} />
      </div>
      <div className="mt-2 grid gap-2 text-[11px] text-blue-900/80 sm:grid-cols-3">
        <span>Прошло: {formatDuration(progress.elapsed_seconds)}</span>
        <span>Осталось: {formatDuration(progress.eta_seconds)}</span>
        <span>Оценка: {formatDuration(progress.estimated_total_seconds)}</span>
      </div>
    </div>
  )
}

function formatDuration(seconds?: number | null) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`
  if (minutes > 0) return `${minutes} мин ${String(secs).padStart(2, '0')} сек`
  return `${secs} сек`
}

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function errorDetailText(detail: unknown) {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'msg' in item) return String((item as { msg?: unknown }).msg ?? '')
      return ''
    }).filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return 'Ошибка генерации'
}

function cleanErrorText(message: string, fallback: string) {
  const value = message.trim()
  if (!value || looksLikeHtmlError(value)) return fallback
  return value
}

function looksLikeHtmlError(value: string) {
  return /<\s*html[\s>]/i.test(value) || /<\s*body[\s>]/i.test(value) || /<\s*title[\s>]/i.test(value)
}

function transientApiErrorText(fallback: string) {
  return `${fallback}: API временно недоступен. Обычно это короткое окно обновления сервиса; повтори запуск через минуту.`
}

function downloadErrorText(err: unknown) {
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return 'Не удалось получить ответ от API. Если генерация попала в момент обновления сервиса, повтори запуск через минуту.'
  }
  return err instanceof Error ? err.message : String(err)
}

function periodText(report: PipelineReport, dateFrom: string, dateTo: string) {
  if (report.period_mode === 'date_to') return `Дата: ${formatDate(dateTo)}`
  if (report.period_mode === 'range') return `${formatDate(dateFrom)} - ${formatDate(dateTo)}`
  return report.description
}

function supportsWorkFilters(reportKey: string) {
  return reportKey === 'dim' || reportKey === 'mstroy' || reportKey === 'mstroy_graph' || reportKey === 'general'
}

function supportsBackgroundExport(reportKey: string) {
  return reportKey === 'dim' || reportKey === 'mstroy' || reportKey === 'mstroy_graph' || reportKey === 'general' || reportKey === 'general_exact_xlsx' || reportKey === 'financial_plan_fact'
}

function supportsCumulativeAsOfEndDate(report: PipelineReport) {
  return Boolean(report.supports_cumulative_as_of_end_date ?? report.supports_daily_pk_details)
}

function reportSupportsGeneralPlanInputs(report: PipelineReport) {
  return Boolean(report.supports_general_equipment_plan_inputs)
}

function sectionLabel(value?: string | null) {
  return value ? value.replace('UCH_', '№') : '—'
}

function objectSectionHint(obj: { section_codes?: string[]; section_names?: string[] }) {
  const codes = Array.from(new Set((obj.section_codes || []).filter(Boolean)))
  if (codes.length) {
    const values = codes.map(sectionLabel)
    return `${codes.length > 1 ? 'Участки' : 'Участок'}: ${values.join(', ')}`
  }
  const names = Array.from(new Set((obj.section_names || []).filter(Boolean)))
  if (names.length) return `${names.length > 1 ? 'Участки' : 'Участок'}: ${names.join(', ')}`
  return 'Участок не указан'
}

function formatShortDate(value?: string | null) {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}`
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

function compactNumber(value?: number | string | null) {
  const n = Number(value || 0)
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function previewKindLabel(value?: string | null) {
  if (value === 'top_quarries') return 'Возка'
  if (value === 'equipment_day') return 'Техника'
  return 'Основные работы'
}

function unresolvedStatusCaption(status: UnresolvedStatus) {
  return {
    matched: 'Явно настроено',
    implicit: 'Типовая логика',
    unresolved: 'Неразобрано',
  }[status]
}

function TabButton({ active, icon, onClick, children }: { active: boolean; icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold transition ${active ? 'bg-accent-red text-white' : 'border border-border bg-white text-text-primary hover:border-accent-red/40'}`}
    >
      {icon}
      {children}
    </button>
  )
}

function TogglePill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center rounded-md px-2 text-xs font-semibold ${active ? 'bg-emerald-100 text-emerald-800' : 'bg-bg-surface text-text-muted'}`}
    >
      {label}
    </button>
  )
}

function IconButton({ disabled, onClick, title, children }: { disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-white text-text-muted hover:border-accent-red/40 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function StatusBadge({ status, children }: { status: UnresolvedStatus; children: React.ReactNode }) {
  const cls = status === 'unresolved'
    ? 'border-red-200 bg-red-50 text-red-700'
    : status === 'implicit'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${cls}`}>{children}</span>
}

function FilterField({ label, ...rest }: {
  label: string
  options: CheckOption[]
  selection: string[] | null
  dateFrom: string
  dateTo: string
  selectedSections: string[]
  showDetails?: boolean
  onChange: (next: string[] | null) => void
}) {
  return (
    <div className="rounded-md border border-border bg-bg-surface/60 p-2">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <FilterButton label={label} {...rest} />
    </div>
  )
}

function Chip({ active, onClick, children, title }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
        active
          ? 'bg-text-primary text-white'
          : 'border border-border bg-white text-text-muted hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

function FilterButton({
  label,
  options,
  selection,
  dateFrom,
  dateTo,
  selectedSections,
  showDetails = true,
  onChange,
}: {
  label: string
  options: CheckOption[]
  selection: string[] | null
  dateFrom: string
  dateTo: string
  selectedSections: string[]
  showDetails?: boolean
  onChange: (next: string[] | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [detailOption, setDetailOption] = useState<CheckOption | null>(null)
  const activeValues = selection ?? options.map(option => option.value)
  const activeSet = new Set(activeValues)
  const allSelected = selection === null || activeValues.length === options.length
  const caption = allSelected ? 'Все' : `${activeValues.length}/${options.length}`
  const canShowDetails = showDetails && options.some(option => option.detailKind)
  const detailParams = useMemo(() => {
    if (!canShowDetails || !detailOption?.detailKind || !detailOption.detailValue) return null
    const params = new URLSearchParams({ from: dateFrom, to: dateTo })
    if (!selectedSections.includes('all')) params.set('section', selectedSections.join(','))
    if (detailOption.detailKind === 'tag') params.set('tag', detailOption.detailValue)
    if (detailOption.detailKind === 'object_type') params.set('object_type_code', detailOption.detailValue)
    if (detailOption.detailKind === 'object') params.set('object_code', detailOption.detailValue)
    return params.toString()
  }, [canShowDetails, dateFrom, dateTo, detailOption, selectedSections])

  const { data: detailData, isFetching: detailLoading } = useQuery<WorkFactRowsResponse>({
    queryKey: ['wip', 'generator', 'filter-detail', detailOption?.value, detailParams],
    queryFn: async () => {
      if (!detailParams) throw new Error('Не выбрана детализация')
      const res = await fetch(`/api/wip/analytics/work-tag-fact-rows?${detailParams}`)
      if (!res.ok) throw new Error('Не удалось загрузить строки')
      return res.json()
    },
    enabled: open && canShowDetails && Boolean(detailParams),
    staleTime: 60_000,
  })

  function toggle(value: string) {
    const base = selection ?? options.map(option => option.value)
    const next = base.includes(value) ? base.filter(item => item !== value) : [...base, value]
    onChange(next.length === options.length ? null : next)
  }

  function close() {
    setOpen(false)
    setDetailOption(null)
  }

  return (
    <div className="static">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-text-primary hover:border-accent-red/40"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-text-muted" />
        <span>{label}</span>
        <span className="rounded bg-bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">{caption}</span>
      </button>
      {open && (
        <div className={`absolute left-0 top-10 z-50 flex h-[min(620px,80vh)] max-w-[calc(100vw-2rem)] resize flex-col overflow-auto rounded-lg border border-border bg-white p-2 shadow-lg ${canShowDetails ? 'w-4/5 min-w-[360px]' : 'w-80 min-w-[280px]'}`}>
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
            <div className="text-xs font-semibold text-text-primary">{label}</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onChange(null)} className="rounded px-2 py-1 text-[11px] font-medium text-text-muted hover:bg-bg-surface">
                Все
              </button>
              <button type="button" onClick={() => onChange([])} className="rounded px-2 py-1 text-[11px] font-medium text-text-muted hover:bg-bg-surface">
                Снять
              </button>
              <button type="button" onClick={close} className="rounded px-1.5 py-1 text-text-muted hover:bg-bg-surface" aria-label="Закрыть">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className={`grid min-h-0 flex-1 gap-2 ${canShowDetails ? 'md:grid-cols-[320px_minmax(0,1fr)]' : ''}`}>
            <div className="min-h-0 space-y-1 overflow-auto pr-1">
              {options.length === 0 ? (
                <div className="px-2 py-3 text-xs text-text-muted">Нет доступных значений</div>
              ) : options.map(option => {
                const active = activeSet.has(option.value)
                const focused = detailOption?.value === option.value
                return (
                  <div
                    key={option.value}
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (canShowDetails) setDetailOption(option) }}
                    onKeyDown={event => {
                      if (canShowDetails && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault()
                        setDetailOption(option)
                      }
                    }}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition ${focused && canShowDetails ? 'bg-red-50 ring-1 ring-accent-red/20' : 'hover:bg-bg-surface'}`}
                  >
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        toggle(option.value)
                      }}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${active ? 'border-accent-red bg-accent-red text-white' : 'border-border bg-white text-transparent'}`}
                      aria-pressed={active}
                      aria-label={active ? 'Снять выбор' : 'Выбрать'}
                    >
                      <CheckSquare className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-xs font-medium leading-snug text-text-primary">{option.label}</span>
                      {option.hint && <span className="mt-0.5 block break-words text-[11px] leading-snug text-text-muted">{option.hint}</span>}
                    </span>
                    {canShowDetails && <Search className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${focused ? 'text-accent-red' : 'text-text-muted'}`} />}
                  </div>
                )
              })}
            </div>
            {canShowDetails && (
              <div className="flex min-h-0 flex-col rounded-md border border-border bg-bg-surface p-2">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-text-primary">{detailOption?.label || 'Детализация'}</div>
                    {detailOption?.hint && <div className="text-[11px] text-text-muted">{detailOption.hint}</div>}
                  </div>
                  {detailData && <div className="shrink-0 rounded bg-white px-2 py-1 text-[11px] font-semibold text-text-muted">{compactNumber(detailData.total)}</div>}
                </div>
                {detailLoading ? (
                  <div className="h-56 animate-pulse rounded bg-white" />
                ) : !detailOption ? (
                  <div className="flex h-56 items-center justify-center rounded bg-white px-3 text-center text-xs text-text-muted">Строка не выбрана</div>
                ) : !detailData?.rows?.length ? (
                  <div className="flex h-56 items-center justify-center rounded bg-white px-3 text-center text-xs text-text-muted">Строки не найдены</div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto rounded bg-white">
                    <table className="w-full border-collapse text-left text-[11px]">
                      <thead className="sticky top-0 bg-white text-text-muted shadow-sm">
                        <tr>
                          <th className="px-2 py-1.5 font-semibold">Дата</th>
                          <th className="px-2 py-1.5 font-semibold">Участок</th>
                          <th className="px-2 py-1.5 font-semibold">Работа</th>
                          <th className="px-2 py-1.5 font-semibold">Объект</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Объем</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailData.rows.map(row => (
                          <tr key={row.id} className="border-t border-border align-top">
                            <td className="whitespace-nowrap px-2 py-1.5 text-text-muted">{formatShortDate(row.date)}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-text-muted">{sectionLabel(row.section_code)}</td>
                            <td className="px-2 py-1.5 text-text-primary">{row.work_type_name || '—'}</td>
                            <td className="px-2 py-1.5 text-text-muted">{row.object_name || row.object_type_name || '—'}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-text-primary">{compactNumber(row.volume)} {row.unit || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
