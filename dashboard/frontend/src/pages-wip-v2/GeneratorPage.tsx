import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarDays, CheckSquare, Download, FileSpreadsheet, FileText, Layers, Loader2, Save, Search, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react'

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

interface PipelineExportJob {
  job_id: string
  status: 'queued' | 'running' | 'ready' | 'error'
  ready: boolean
  message?: string | null
  error?: string | null
  download_url?: string | null
  filename?: string | null
  stage_label?: string | null
  progress_percent?: number | null
  elapsed_seconds?: number | null
  eta_seconds?: number | null
  estimated_total_seconds?: number | null
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

const GENERAL_PLAN_STORAGE_KEY = 'vsm.generator.generalEquipmentPlan.v1'
const configurableReportKeys = ['dim', 'mstroy', 'mstroy_graph', 'general']
const sectionConfigurableReportKeys = new Set(['dim', 'mstroy', 'general'])
const quarryTotalsReportKeys = new Set(['dim', 'mstroy', 'general'])
const groupingReportKeys = new Set(['mstroy', 'general'])
const reportSectionOrder = [
  'temp_roads',
  'main_track',
  'pile_access',
  'pile_fields',
  'pipes',
  'isso_access',
  'tech_roads',
  'service_roads',
  'station_tracks',
  'traction_substations',
  'material_hauls',
  'uncategorized',
  'materials',
]
const reportSectionLabels: Record<string, string> = {
  temp_roads: 'Временные притрассовые дороги',
  main_track: 'Земляное полотно ОХ',
  pile_access: 'Стартовые площадки и проезды',
  pile_fields: 'Участки усиления',
  pipes: 'Водопропускные трубы ПЖБТ',
  isso_access: 'Проезды и площадки ИССО',
  tech_roads: 'Технологические проезды',
  service_roads: 'Содержание',
  station_tracks: 'Станционные пути',
  traction_substations: 'Тяговые подстанции',
  material_hauls: 'Вывоз с карьеров',
  uncategorized: 'Вне категорий',
  materials: 'Материалы',
}
const reportSettingsHints: Record<string, string> = {
  reinforcement_sections: 'PDF по участкам усиления: сводка, производственные календари и поставка свай отдельной страницей.',
  dim: 'Пикетажная логика ДиМ: отрезки ОХ, ИССО и смежные объекты.',
  mstroy: 'Табличный МСтрой: те же блоки данных, с выбором группировки.',
  mstroy_graph: 'Графический МСтрой: листы и строки задаются шаблоном, здесь доступны дата накопления и фильтры фактов.',
  general: 'Общий отчет: объектная структура без жесткой пикетажной нарезки.',
}

const fallbackReports: PipelineReport[] = [
  { key: 'temp_roads', label: 'Отчет по отсыпке за дату', description: 'Временные притрассовые дороги', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'reinforcement_sections', label: 'Отчет по участкам усиления за дату', description: 'Сводка, производственные календари и поставка свай', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'isso_support', label: 'Отсыпка площадок ИССО PDF', description: 'Расширенный отчет с карточками по каждому ИССО за выбранный месяц', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'mainline_structural_scheme', label: 'Структурная схема ОХ PDF', description: 'A3 PDF по участкам ОХ: объекты, РД, даты и статусы отсыпки', file_type: 'pdf', period_mode: 'date_to' },
  { key: 'dim', label: 'Отчет ДиМ', description: 'Форма ДиМ', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'mstroy', label: 'Отчет МСтрой', description: 'Форма МСтрой', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'mstroy_graph', label: 'МСтрой графический отчет', description: 'Графический XLSX по шаблону МСтрой', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'general', label: 'Общий отчет', description: 'Общая форма', file_type: 'xlsx', period_mode: 'range', supports_cumulative_as_of_end_date: true, supports_daily_pk_details: true },
  { key: 'simple_section_report', label: 'Простой отчет по участкам', description: 'Перевозки и работы за период без внутренних кодов', file_type: 'xlsx', period_mode: 'range' },
  { key: 'transport_section_report', label: 'Перевозный отчет по участкам', description: 'Перевозки за период: детальные карьеры, укрупненные накопители/конструктивы, недельные и месячные объемы', file_type: 'xlsx', period_mode: 'range' },
  { key: 'financial_plan_fact', label: 'Финансовый план-факт', description: 'Плановые и фактически выполненные работы за период: объемы, ПК, расценки, суммы и разница по участкам', file_type: 'xlsx', period_mode: 'range' },
  { key: 'equipment', label: 'Отчет по технике', description: 'Техника по объектам и участкам', file_type: 'xlsx', period_mode: 'date_to' },
  { key: 'general_exact_pdf', label: 'Генеральный отчет pdf', description: 'Аналитика Генерального отчета', file_type: 'pdf', period_mode: 'date_to', supports_general_equipment_plan_inputs: true },
  { key: 'general_exact_xlsx', label: 'Генеральный отчет xlsx', description: 'Аналитика Генерального отчета', file_type: 'xlsx', period_mode: 'date_to', supports_general_equipment_plan_inputs: true },
  { key: 'admin_dumptruck', label: 'Административный отчет', description: 'Административный XLSX по самосвалам за выбранную дату', file_type: 'xlsx', period_mode: 'date_to' },
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

function normalizeSavedGeneralPlanForm(value: unknown): GeneralPlanForm {
  const form = buildEmptyGeneralPlanForm()
  if (!value || typeof value !== 'object') return form
  const saved = value as Partial<Record<GeneralEquipmentKey, Partial<Record<GeneralPlanShiftKey, Record<string, unknown>>>>>
  GENERAL_PLAN_EQUIPMENT.forEach(({ key }) => {
    GENERAL_PLAN_SHIFTS.forEach(({ key: shiftKey }) => {
      GENERAL_PLAN_SECTION_CODES.forEach(sectionCode => {
        const raw = saved[key]?.[shiftKey]?.[sectionCode]
        form[key][shiftKey][sectionCode] = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
      })
    })
  })
  return form
}

function loadGeneralPlanForm(): GeneralPlanForm {
  if (typeof window === 'undefined') return buildEmptyGeneralPlanForm()
  try {
    const raw = window.localStorage.getItem(GENERAL_PLAN_STORAGE_KEY)
    return raw ? normalizeSavedGeneralPlanForm(JSON.parse(raw)) : buildEmptyGeneralPlanForm()
  } catch {
    return buildEmptyGeneralPlanForm()
  }
}

function saveGeneralPlanForm(form: GeneralPlanForm) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GENERAL_PLAN_STORAGE_KEY, JSON.stringify(form))
  } catch {
    // localStorage can be unavailable in private or locked-down browser contexts.
  }
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

function reportSupportsCumulativeAsOfEndDate(report: PipelineReport) {
  return Boolean(report.supports_cumulative_as_of_end_date ?? report.supports_daily_pk_details)
}

function reportSupportsGeneralPlanInputs(report: PipelineReport) {
  return Boolean(report.supports_general_equipment_plan_inputs)
}

function reportSupportsQuarryTotals(reportKey: string) {
  return quarryTotalsReportKeys.has(reportKey)
}

function reportSupportsGrouping(reportKey: string) {
  return groupingReportKeys.has(reportKey)
}

function reportSupportsSectionConfig(reportKey: string) {
  return sectionConfigurableReportKeys.has(reportKey)
}

function reportSettingHint(reportKey: string) {
  return reportSettingsHints[reportKey] || 'Параметры применяются при следующей генерации файла.'
}

function sortedReportSections(sections: GeneratorReportSectionParameter[]) {
  const knownOrder = new Map(reportSectionOrder.map((id, index) => [id, index]))
  return [...sections]
    .filter(section => knownOrder.has(section.id))
    .sort((a, b) => (knownOrder.get(a.id) ?? 999) - (knownOrder.get(b.id) ?? 999))
}

function reportSectionLabel(section: GeneratorReportSectionParameter) {
  return reportSectionLabels[section.id] || section.title || section.id
}

function formatDateTime(value?: string | null) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function GeneratorPage() {
  const queryClient = useQueryClient()
  const [selectedSections, setSelectedSections] = useState<string[]>(['all'])
  const [dateFrom, setDateFrom] = useState(calendarWeekStartIso())
  const [dateTo, setDateTo] = useState(isoDateOffset(-1))
  const [activeReportKey, setActiveReportKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cacheClearMessage, setCacheClearMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [pipelineProgress, setPipelineProgress] = useState<PipelineExportJob | null>(null)
  const [cacheClearBusy, setCacheClearBusy] = useState(false)
  const [tagSelection, setTagSelection] = useState<string[] | null>(null)
  const [objectSelection, setObjectSelection] = useState<string[] | null>(null)
  const [cumulativeAsOfEndByReport, setCumulativeAsOfEndByReport] = useState<Record<string, boolean>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportParameterDraft, setReportParameterDraft] = useState<GeneratorReportParametersResponse | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [generalPlanExpanded, setGeneralPlanExpanded] = useState(false)
  const [generalPlanForm, setGeneralPlanForm] = useState<GeneralPlanForm>(() => loadGeneralPlanForm())

  useEffect(() => {
    saveGeneralPlanForm(generalPlanForm)
  }, [generalPlanForm])

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
  })

  const { data: reportParameters, isFetching: reportParametersFetching } = useQuery<GeneratorReportParametersResponse>({
    queryKey: ['wip', 'generator', 'report-parameters'],
    queryFn: async () => {
      const res = await fetch('/api/wip/generator/report-parameters')
      if (!res.ok) throw new Error('Не удалось загрузить параметры отчетов')
      return res.json()
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    const next = normalizeReportParametersDraft(reportParameters)
    if (next) setReportParameterDraft(next)
  }, [reportParameters?.updated_at, reportParameters?.reports])

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
  const invalidRange = dateFrom > dateTo

  const reportParameterDirty = useMemo(
    () => Boolean(reportParameters && reportParameterDraft) && JSON.stringify(reportParameters?.reports ?? {}) !== JSON.stringify(reportParameterDraft?.reports ?? {}),
    [reportParameters, reportParameterDraft],
  )

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

  function toggleCumulativeAsOfEnd(reportKey: string) {
    setCumulativeAsOfEndByReport(prev => ({
      ...prev,
      [reportKey]: !(prev[reportKey] ?? Boolean((reportParameterDraft?.reports?.[reportKey] ?? reportParameters?.reports?.[reportKey])?.cumulative_as_of_end_date)),
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

  async function saveReportParameters() {
    if (!reportParameterDraft) return
    setSettingsSaving(true)
    setError(null)
    setStatusMessage(null)
    try {
      const res = await fetch('/api/wip/generator/report-parameters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports: reportParameterDraft.reports }),
      })
      if (!res.ok) throw new Error(await responseErrorText(res, 'Не удалось сохранить параметры отчетов'))
      const saved = await res.json() as GeneratorReportParametersResponse
      queryClient.setQueryData(['wip', 'generator', 'report-parameters'], saved)
      setReportParameterDraft(normalizeReportParametersDraft(saved))
      setStatusMessage('Настройки отчетов сохранены')
      window.setTimeout(() => setStatusMessage(null), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSettingsSaving(false)
    }
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

  async function downloadPipeline(report: PipelineReport) {
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
      if (reportSupportsCumulativeAsOfEndDate(report)) {
        body.cumulative_as_of_end_date = cumulativeAsOfEndByReport[report.key] ?? Boolean(savedReportParameters?.cumulative_as_of_end_date)
      }
      if (reportSupportsGeneralPlanInputs(report) && generalPlanPayload) {
        body.general_equipment_plan_counts = generalPlanPayload
      }
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
        } else if (savedReportParameters?.object_type_codes?.length || savedReportParameters?.object_codes?.length) {
          body.object_type_codes = savedReportParameters.object_type_codes ?? []
          body.object_codes = savedReportParameters.object_codes ?? []
        }
      }

      if (supportsBackgroundExport(report.key)) {
        let job = await startPipelineExportJob(body)
        setPipelineProgress(job)
        setStatusMessage(job.message || 'Файл поставлен в очередь генерации')
        job = await waitForPipelineExportJob(body, job, nextJob => {
          setPipelineProgress(nextJob)
          setStatusMessage(nextJob.message || 'Файл генерируется на сервере')
        })
        setPipelineProgress(job)
        setStatusMessage(job.message || 'Файл готов, скачиваю...')
        if (!job.download_url) throw pipelineExportError('Файл готов, но ссылка на скачивание не получена')
        let res = await fetch(job.download_url)
        if (!res.ok && (res.status === 404 || res.status === 409)) {
          setStatusMessage('Файл восстанавливается из кеша, пробую скачать повторно...')
          job = await waitForPipelineExportJob(
            body,
            await startPipelineExportJob(body),
            nextJob => {
              setPipelineProgress(nextJob)
              setStatusMessage(nextJob.message || 'Файл генерируется на сервере')
            },
          )
          setPipelineProgress(job)
          if (!job.download_url) throw pipelineExportError('Файл готов, но ссылка на скачивание не получена')
          res = await fetch(job.download_url)
        }
        if (!res.ok) throw pipelineExportError(await responseErrorText(res, 'Не удалось скачать готовый файл'), res.status)
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
    setCacheClearMessage(null)
    try {
      const res = await fetch('/api/wip/generator/xlsx-cache/clear', { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { removed_files?: number; removed_bytes?: number; detail?: string }
      if (!res.ok) throw new Error(body.detail || 'Не удалось сбросить кеш')
      const mb = ((body.removed_bytes ?? 0) / 1024 / 1024).toFixed(1)
      setCacheClearMessage(`Кеш XLSX сброшен: файлов ${body.removed_files ?? 0}, ${mb} МБ`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCacheClearBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-bg-primary">
      <div className="border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 text-accent-red" />
            <h1 className="font-heading text-xl font-bold text-text-primary">Генератор</h1>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-semibold text-text-primary hover:border-accent-red/40"
          >
            <Settings className="h-4 w-4 text-text-muted" />
            Настройки отчетов
          </button>
        </div>
      </div>

      <div className="max-w-6xl space-y-4 p-4 sm:p-6">
        {settingsOpen && (
          <ReportSettingsModal
            reports={reports.filter(report => configurableReportKeys.includes(report.key))}
            draft={reportParameterDraft}
            isFetching={reportParametersFetching}
            isDirty={reportParameterDirty}
            isSaving={settingsSaving}
            tagOptions={tagOptions}
            objectOptions={objectOptions}
            dateFrom={dateFrom}
            dateTo={dateTo}
            selectedSections={selectedSections}
            onClose={() => setSettingsOpen(false)}
            onSave={saveReportParameters}
            onUpdateReport={updateReportParameter}
            onUpdateSection={updateReportParameterSection}
          />
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {cacheClearMessage && (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            {cacheClearMessage}
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
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Дата по</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} />
            </label>
          </div>
          {invalidRange && <div className="mt-2 text-xs text-accent-red">Дата начала позже даты окончания</div>}
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
                <p className="mt-1 text-xs text-text-muted">
                  Эти поля пробрасываются только в Генеральный отчет PDF/XLSX и заполняют строки планового количества техники по участкам.
                </p>
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
                                  onChange={e => updateGeneralPlanValue(equipment.key, shift.key, section.code, e.target.value)}
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
                      {report.description && (
                        <p className="mt-2 text-xs text-text-muted">{report.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadPipeline(report)}
                      disabled={Boolean(activeReportKey) || invalidRange}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-accent-red px-3 text-sm font-semibold text-white hover:bg-accent-burg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      <span>{busy ? 'Готовлю...' : 'Скачать'}</span>
                    </button>
                  </div>
                  {reportSupportsCumulativeAsOfEndDate(report) && (
                    <label className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        checked={Boolean(cumulativeAsOfEndByReport[report.key])}
                        onChange={() => toggleCumulativeAsOfEnd(report.key)}
                        className="mt-0.5 h-4 w-4 rounded border-border text-accent-red focus:ring-accent-red"
                      />
                      <span>Накопительные итоги по состоянию на последний день.</span>
                    </label>
                  )}
                  {supportsWorkFilters(report.key) && (
                    <div className="relative mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
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
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function ReportSettingsModal({
  reports,
  draft,
  isFetching,
  isDirty,
  isSaving,
  tagOptions,
  objectOptions,
  dateFrom,
  dateTo,
  selectedSections,
  onClose,
  onSave,
  onUpdateReport,
  onUpdateSection,
}: {
  reports: PipelineReport[]
  draft: GeneratorReportParametersResponse | null
  isFetching: boolean
  isDirty: boolean
  isSaving: boolean
  tagOptions: CheckOption[]
  objectOptions: CheckOption[]
  dateFrom: string
  dateTo: string
  selectedSections: string[]
  onClose: () => void
  onSave: () => void
  onUpdateReport: (reportKey: string, updater: (report: GeneratorReportParameter) => GeneratorReportParameter) => void
  onUpdateSection: (reportKey: string, sectionId: string, updater: (section: GeneratorReportSectionParameter) => GeneratorReportSectionParameter) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/30 p-3 sm:p-6">
      <div className="w-full max-w-6xl rounded-lg border border-border bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-white px-4 py-3">
          <div>
            <h2 className="font-heading text-base font-bold text-text-primary">Параметры XLSX-отчетов</h2>
            <div className="mt-1 text-xs text-text-muted">
              {isFetching ? 'Обновляю параметры...' : draft?.updated_at ? `Обновлено ${formatDateTime(draft.updated_at)}${draft.updated_by ? ` · ${draft.updated_by}` : ''}` : 'Параметры по умолчанию'}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDirty && <span className="text-xs font-medium text-amber-700">Есть несохраненные изменения</span>}
            <button
              type="button"
              onClick={onSave}
              disabled={!draft || !isDirty || isSaving}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent-red px-3 text-sm font-semibold text-white hover:bg-accent-burg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Сохранить
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-white text-text-muted hover:text-text-primary"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {!draft ? (
            <div className="h-72 animate-pulse rounded-md bg-bg-surface" />
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {reports.map(report => {
                const params = draft.reports[report.key]
                if (!params) return null
                const objectSelection = composeObjectSelection(params.object_type_codes ?? [], params.object_codes ?? [])
                return (
                  <div key={report.key} className="rounded-lg border border-border bg-bg-primary/20 p-3">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">{report.label}</h3>
                        <div className="mt-1 text-xs text-text-muted">{report.key} · {report.file_type.toUpperCase()}</div>
                        <div className="mt-2 text-xs leading-snug text-text-secondary">{reportSettingHint(report.key)}</div>
                      </div>
                      <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-text-muted">{report.period_mode === 'range' ? 'Период' : 'Дата'}</span>
                    </div>

                    <div className="grid gap-2 md:grid-cols-2">
                      {reportSupportsCumulativeAsOfEndDate(report) && (
                        <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text-primary">
                          <span className="font-semibold">Накопительные итоги на последний день</span>
                          <input
                            type="checkbox"
                            checked={params.cumulative_as_of_end_date}
                            onChange={event => onUpdateReport(report.key, current => ({
                              ...current,
                              cumulative_as_of_end_date: event.target.checked,
                              show_daily_pk_details: event.target.checked,
                            }))}
                            className="h-4 w-4 rounded border-border text-accent-red focus:ring-accent-red"
                          />
                        </label>
                      )}
                      {reportSupportsQuarryTotals(report.key) && (
                        <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text-primary">
                          <span className="font-semibold">Итоги по карьерам</span>
                          <input
                            type="checkbox"
                            checked={params.include_quarry_totals}
                            onChange={event => onUpdateReport(report.key, current => ({ ...current, include_quarry_totals: event.target.checked }))}
                            className="h-4 w-4 rounded border-border text-accent-red focus:ring-accent-red"
                          />
                        </label>
                      )}
                      {reportSupportsGrouping(report.key) && (
                        <label className="block rounded-md border border-border bg-white p-2 md:col-span-2">
                          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Группировка</span>
                          <select
                            value={params.grouping}
                            onChange={event => onUpdateReport(report.key, current => ({ ...current, grouping: event.target.value === 'sections' ? 'sections' : 'objects' }))}
                            className={inputCls}
                          >
                            <option value="objects">По объектам</option>
                            <option value="sections">По участкам</option>
                          </select>
                        </label>
                      )}
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <div className="relative">
                        <FilterButton
                          label="Фильтр по работам"
                          options={tagOptions}
                          selection={params.work_tags.length ? params.work_tags : null}
                          dateFrom={dateFrom}
                          dateTo={dateTo}
                          selectedSections={selectedSections}
                          onChange={next => onUpdateReport(report.key, current => ({ ...current, work_tags: next ?? [] }))}
                        />
                      </div>
                      <div className="relative">
                        <FilterButton
                          label="Фильтр по объектам и типам"
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
                    </div>

                    {reportSupportsSectionConfig(report.key) && (
                      <div className="mt-3 rounded-md border border-border bg-white p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Состав отчета</div>
                          <div className="text-[11px] text-text-muted">Пустой фильтр выше = все факты</div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {sortedReportSections(params.sections).map(section => (
                            <button
                              key={section.id}
                              type="button"
                              onClick={() => onUpdateSection(report.key, section.id, current => ({ ...current, enabled: !current.enabled }))}
                              className={`flex min-h-10 items-center justify-between gap-3 rounded-md border px-2 py-1.5 text-left text-xs ${
                                section.enabled
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                  : 'border-border bg-bg-surface text-text-muted'
                              }`}
                            >
                              <span className="font-semibold">{reportSectionLabel(section)}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${section.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-white text-text-muted'}`}>
                                {section.enabled ? 'Вкл' : 'Выкл'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
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
  return reportKey === 'dim' || reportKey === 'mstroy' || reportKey === 'mstroy_graph' || reportKey === 'general' || reportKey === 'general_exact_xlsx' || reportKey === 'admin_dumptruck' || reportKey === 'financial_plan_fact'
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

async function waitForPipelineExportJob(
  body: Record<string, unknown>,
  initialJob: PipelineExportJob,
  onStatus: (job: PipelineExportJob) => void,
) {
  let job = initialJob
  while (!job.ready) {
    if (job.status === 'error') throw pipelineExportError(job.error || job.message || 'Не удалось сгенерировать файл')
    await sleep(2500)
    try {
      job = await fetchPipelineExportJob(job.job_id)
      onStatus(job)
    } catch (err) {
      if (isTransientPipelineExportError(err)) {
        onStatus({ ...job, message: 'Связь с API восстанавливается, повторяю проверку статуса...' })
        continue
      }
      if (!isRecoverablePipelineExportError(err)) throw err
      job = await startPipelineExportJob(body)
      onStatus(job)
    }
  }
  return job
}

function PipelineProgressPanel({ progress }: { progress: PipelineExportJob }) {
  const percent = typeof progress.progress_percent === 'number'
    ? Math.max(0, Math.min(100, progress.progress_percent))
    : null
  const barWidth = `${percent ?? 6}%`
  const stage = progress.stage_label || progress.message || (progress.status === 'queued' ? 'Ожидание генерации' : 'Генерация файла')
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 font-semibold">{stage}</div>
        {percent !== null ? <div className="font-mono text-[12px] text-blue-800">{percent}%</div> : null}
      </div>
      <div className="h-2 overflow-hidden rounded bg-white">
        <div className="h-full rounded bg-accent-red transition-[width] duration-500" style={{ width: barWidth }} />
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

function compactNumber(value?: number | string | null) {
  const n = Number(value || 0)
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const inputCls = 'h-9 w-full rounded-md border border-border bg-white px-2 text-sm text-text-primary focus:border-accent-red/50 focus:outline-none'

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
  onChange,
}: {
  label: string
  options: CheckOption[]
  selection: string[] | null
  dateFrom: string
  dateTo: string
  selectedSections: string[]
  onChange: (next: string[] | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [detailOption, setDetailOption] = useState<CheckOption | null>(null)
  const activeValues = selection ?? options.map(option => option.value)
  const activeSet = new Set(activeValues)
  const allSelected = selection === null || activeValues.length === options.length
  const caption = allSelected ? 'Все' : `${activeValues.length}/${options.length}`
  const detailParams = useMemo(() => {
    if (!detailOption?.detailKind || !detailOption.detailValue) return null
    const params = new URLSearchParams({ from: dateFrom, to: dateTo })
    if (!selectedSections.includes('all')) params.set('section', selectedSections.join(','))
    if (detailOption.detailKind === 'tag') params.set('tag', detailOption.detailValue)
    if (detailOption.detailKind === 'object_type') params.set('object_type_code', detailOption.detailValue)
    if (detailOption.detailKind === 'object') params.set('object_code', detailOption.detailValue)
    return params.toString()
  }, [dateFrom, dateTo, detailOption, selectedSections])

  const { data: detailData, isFetching: detailLoading } = useQuery<WorkFactRowsResponse>({
    queryKey: ['wip', 'generator', 'filter-detail', detailOption?.value, detailParams],
    queryFn: async () => {
      if (!detailParams) throw new Error('Не выбрана детализация')
      const res = await fetch(`/api/wip/analytics/work-tag-fact-rows?${detailParams}`)
      if (!res.ok) throw new Error('Не удалось загрузить строки')
      return res.json()
    },
    enabled: open && Boolean(detailParams),
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
        <div className="absolute left-0 top-10 z-50 flex h-[min(620px,80vh)] w-4/5 min-w-[360px] max-w-[calc(100vw-2rem)] resize flex-col overflow-auto rounded-lg border border-border bg-white p-2 shadow-lg">
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
          <div className="grid min-h-0 flex-1 gap-2 md:grid-cols-[320px_minmax(0,1fr)]">
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
                    onClick={() => setDetailOption(option)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setDetailOption(option)
                      }
                    }}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition ${focused ? 'bg-red-50 ring-1 ring-accent-red/20' : 'hover:bg-bg-surface'}`}
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
                    <Search className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${focused ? 'text-accent-red' : 'text-text-muted'}`} />
                  </div>
                )
              })}
            </div>
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
          </div>
        </div>
      )}
    </div>
  )
}
