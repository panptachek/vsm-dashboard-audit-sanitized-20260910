/**
 * Страница «Настройки».
 * Блок 1 — справочник нормативов производительности (4 категории, батч-сохранение per-группа).
 * Блок 2 — словарь алиасов работ/материалов (CRUD).
 *
 * Данные берутся из /api/wip/settings/norms и /api/wip/settings/aliases.
 * Мутации инвалидируют react-query ключи, чтобы следующий запрос перечитал свежее.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings as SettingsIcon, Save, Trash2, Plus, Pencil, Check, X, Download, Upload, FileSpreadsheet, BookOpen, FileText, ChevronDown, ShieldCheck, KeyRound, Megaphone, Mail, Send, CalendarDays, Loader2, ArrowUp, ArrowDown, Eye, EyeOff, RotateCcw } from 'lucide-react'
import { useAuth } from '../auth'
import { SIDEBAR_NAV_ITEM_BY_PATH, SIDEBAR_NAV_ITEMS, mergeSidebarSettings, type SidebarSettingsItem, type SidebarSettingsPayload } from '../navigation'

// ── types ─────────────────────────────────────────────────────────────────

interface WorkTypeNorm {
  equipment_type: string
  work_type_code: string
  work_type_codes?: string[]
  name: string | null
  norm_name?: string | null
  norm: number
  unit: string | null
  code: string | null
  productivity_enabled: boolean
}
interface WorkOption {
  id: string
  code: string
  name: string | null
  default_unit?: string | null
  analytics_tag?: string | null
  productivity_enabled?: boolean
}
interface SandSectionNorm {
  section: number
  trips: number
  m3_per_trip: number
}
interface GenericNorm { norm_m3_per_shift: number }
interface NormsData {
  work_types: WorkTypeNorm[]
  work_options: WorkOption[]
  equipment_types: string[]
  sand_pit: SandSectionNorm[]
  sand_stockpile: SandSectionNorm[]
  generic: GenericNorm
}
type DedupKind = 'work_type' | 'material' | 'object'
interface DedupReference {
  id: string
  code: string | null
  label: string | null
  default_unit?: string | null
  analytics_tag?: string | null
  review_tag?: string | null
  is_active?: boolean | null
  ref_count?: number
}
interface DedupReferencesResponse { rows: DedupReference[] }
interface DedupPreview {
  kind: DedupKind
  source: DedupReference
  target: DedupReference
  source_counts: Record<string, number>
  target_counts: Record<string, number>
}
interface DedupMigrateResponse {
  kind: DedupKind
  target: DedupReference
  sources: Array<{ source: DedupReference; counts: Record<string, number> }>
}
interface BoundaryKindOption {
  key: string
  label: string
}
interface SectionOption {
  code: string
  name: string
  sort_order: number | null
}
interface SectionBoundaryRow {
  id?: string
  boundary_kind: string
  section_code: string
  section_name?: string
  pk_start: number
  pk_end: number
  pk_raw_text: string | null
  comment: string | null
}
interface SectionBoundariesData {
  boundary_kinds: BoundaryKindOption[]
  sections: SectionOption[]
  rows: SectionBoundaryRow[]
}
interface QuarryOption {
  id: string
  code: string
  name: string
  latitude: number | null
  longitude: number | null
}
interface HaulDistanceRow {
  section_code: string
  quarry_object_id: string
  quarry_code?: string
  quarry_name?: string
  distance_km: number | null
}
interface HaulDistancesData {
  sections: SectionOption[]
  quarries: QuarryOption[]
  rows: HaulDistanceRow[]
}
interface CompactionCoefficientRow {
  id: string
  object_codes: string[]
  object_type_codes: string[]
  work_codes: string[]
  tags: string[]
  coefficient: number
  notes?: string | null
  sort_order?: number | null
}
interface CompactionOption { code: string; name: string; object_type_code?: string | null; object_type_name?: string | null; analytics_tag?: string | null }
interface CompactionTagOption { name: string }
interface CompactionCoefficientsData {
  rows: CompactionCoefficientRow[]
  objects: CompactionOption[]
  object_types: CompactionOption[]
  works: CompactionOption[]
  tags: CompactionTagOption[]
}

type DashboardImportKind = 'people' | 'report_m' | 'equipment_operation' | 'accommodation'
interface DashboardImportResponse {
  ok?: boolean
  source_filename?: string
  report_date?: string
  sheet_name?: string
  snapshot_id?: string
  cards?: number
  row_count?: number
  position_rows?: number
  summary?: Record<string, number>
  count?: number
  total_equipment_units?: number
  metric_rows_inserted?: number
  matched_equipment_units?: number
  created_equipment_units?: number
  fuel_liters_total?: number
  mileage_km_total?: number
  engine_hours_total?: number
  reports?: Array<{ daily_report_id?: string; equipment_units?: number }>
}

interface DailyReportInstructionUploadResponse {
  ok?: boolean
  filename?: string
  source_filename?: string
  size_bytes?: number
  updated_at?: string
  uploaded_by?: string
  backup_filename?: string | null
}

interface UserAccessRow {
  username: string
  password: string
  role: 'admin' | 'user'
  base_role?: 'admin' | 'user'
  source: string
  pages: string[]
  page_labels: string[]
  permissions: string[]
  override?: boolean
}
interface UserAccessData {
  rows: UserAccessRow[]
  page_labels: Record<string, string>
  known_permissions?: string[]
}

interface DashboardAnnouncementItem {
  id: string
  enabled: boolean
  title: string
  message: string
  tone: 'info' | 'warning' | 'critical' | 'success'
  target_paths: string[]
}

interface DashboardAnnouncementSettings {
  items: DashboardAnnouncementItem[]
  updated_by?: string | null
  updated_at?: string | null
}

interface DailyReportEmailFileOption {
  key: string
  label: string
  description?: string
  file_type?: string
  period_mode?: string
  kind?: string
  configurable_date?: boolean
  supports_cumulative_as_of_end_date?: boolean
  supports_cache_reuse?: boolean
}

interface DailyReportEmailReportConfig {
  date_mode: 'day_before_send' | 'custom'
  date?: string | null
  date_from?: string | null
  cumulative_as_of_end_date: boolean
  use_cache?: boolean
}

interface DailyReportEmailGroup {
  id: string
  name: string
  enabled: boolean
  recipients: string[]
  cc: string[]
  report_keys: string[]
  report_configs: Record<string, DailyReportEmailReportConfig>
  subject_prefix: string
}

interface DailyReportEmailSettings {
  enabled: boolean
  send_time_local: string
  groups: DailyReportEmailGroup[]
  file_options: DailyReportEmailFileOption[]
  updated_by?: string | null
  updated_at?: string | null
}

interface DailyReportEmailGroupDraft extends Omit<DailyReportEmailGroup, 'recipients' | 'cc'> {
  recipientsText: string
  ccText: string
}

interface DailyReportEmailDraft {
  enabled: boolean
  send_time_local: string
  groups: DailyReportEmailGroupDraft[]
}

interface DailyReportEmailSendResponse {
  ok: boolean
  queued?: boolean
  send_id?: string
  dry_run?: boolean
  send_date?: string
  generated_files?: Array<{ key: string; label?: string; filename?: string; size_bytes?: number; report_date?: string | null; report_date_from?: string | null; cumulative_as_of_end_date?: boolean; from_cache?: boolean; cache_mode?: string | null; cache_created_at?: string | null }>
  groups?: Array<{ id?: string; name?: string; recipient_count?: number; attachment_count?: number; sent?: boolean }>
  sent_groups?: number
  status?: DailyReportEmailSendStatus
}

interface DailyReportEmailSendStatus {
  status: 'idle' | 'running' | 'success' | 'error' | string
  running: boolean
  stage?: string | null
  stage_label?: string | null
  message?: string | null
  error?: string | null
  started_at?: string | null
  current_step_started_at?: string | null
  current_step_estimated_seconds?: number | null
  completed_estimated_seconds?: number | null
  total_estimated_seconds?: number | null
  progress_percent?: number | null
  elapsed_seconds?: number | null
  eta_seconds?: number | null
  estimated_total_seconds?: number | null
  completed_steps?: number | null
  total_steps?: number | null
  current_file_label?: string | null
  current_group_name?: string | null
  generated_files?: Array<{ key: string; label?: string; filename?: string; size_bytes?: number; report_date?: string | null; report_date_from?: string | null; cumulative_as_of_end_date?: boolean }>
  groups?: Array<{ id?: string; name?: string; recipient_count?: number; attachment_count?: number; sent?: boolean }>
  dry_run?: boolean
}

interface IssoSupportReportSettingsRow {
  row_key: string
  plan_id?: string | null
  object_code: string
  plan_month: string
  section_code: string
  section_name: string
  source_name: string
  object_name: string
  pk_text: string
  source_support_range_text: string
  source_rd_status: 'available' | 'missing' | 'unknown' | string
  source_remark: string
  support_range_text: string
  rd_status: 'available' | 'missing' | 'unknown' | string
  remark: string
  has_override?: boolean
}

interface IssoSupportReportMonth {
  month: string
  label?: string | null
  row_count?: number | null
}

interface IssoSupportReportSettingsResponse {
  target_month: string
  months?: IssoSupportReportMonth[]
  updated_by?: string | null
  updated_at?: string | null
  snapshot?: {
    id?: string
    snapshot_date?: string | null
    source_filename?: string | null
    source_reference?: string | null
    title?: string | null
    review_status?: string | null
    created_at?: string | null
    comment?: string | null
  }
  rows: IssoSupportReportSettingsRow[]
}

interface IssoSupportReportRowGroup {
  key: string
  first: IssoSupportReportSettingsRow
  byMonth: Record<string, IssoSupportReportSettingsRow>
}

interface AliasRow {
  id: string
  canonical_code: string
  alias_text: string
  kind: 'work_type' | 'material' | 'object'
  notes: string | null
  created_at: string | null
}

const ALIAS_KINDS: AliasRow['kind'][] = ['work_type', 'material', 'object']
const ALIAS_KIND_LABELS: Record<AliasRow['kind'], string> = {
  work_type: 'Работа',
  material: 'Материал',
  object: 'Объект / направление',
}
const ISSO_RD_STATUS_OPTIONS = [
  { value: 'available', label: 'Есть' },
  { value: 'missing', label: 'Нет' },
  { value: 'unknown', label: 'Неизвестно' },
] as const

function issoStatusLabel(value: string | null | undefined) {
  const found = ISSO_RD_STATUS_OPTIONS.find(option => option.value === value)
  return found?.label ?? (value || '—')
}

function issoMonthLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const [year, month] = value.slice(0, 7).split('-')
  if (!year || !month) return value
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ru-RU', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date).replace('.', '')
}

function issoSupportBaseKey(row: IssoSupportReportSettingsRow): string {
  return [
    row.object_code || row.object_name || row.plan_id || 'object',
    row.source_name || 'source',
    row.pk_text || 'pk',
    row.section_code || row.section_name || 'section',
  ].join('||')
}

function groupIssoSupportRows(rows: IssoSupportReportSettingsRow[]): IssoSupportReportRowGroup[] {
  const groups = new Map<string, IssoSupportReportRowGroup>()
  for (const row of rows) {
    const baseKey = issoSupportBaseKey(row)
    let key = baseKey
    let duplicateIndex = 2
    while (groups.has(key) && groups.get(key)!.byMonth[row.plan_month]) {
      key = `${baseKey}||${duplicateIndex}`
      duplicateIndex += 1
    }
    const group = groups.get(key) ?? { key, first: row, byMonth: {} }
    group.byMonth[row.plan_month] = row
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (
    String(a.first.section_name || a.first.section_code || '').localeCompare(String(b.first.section_name || b.first.section_code || ''), 'ru') ||
    String(a.first.source_name || '').localeCompare(String(b.first.source_name || ''), 'ru') ||
    String(a.first.object_name || a.first.object_code || '').localeCompare(String(b.first.object_name || b.first.object_code || ''), 'ru') ||
    String(a.first.pk_text || '').localeCompare(String(b.first.pk_text || ''), 'ru')
  ))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emailListToText(values: string[] | null | undefined): string {
  return (values || []).join('\n')
}

function emailTextToList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function defaultDailyReportEmailReportConfig(option?: DailyReportEmailFileOption | null): DailyReportEmailReportConfig {
  return {
    date_mode: 'day_before_send',
    date: null,
    date_from: null,
    cumulative_as_of_end_date: true,
    use_cache: false,
  }
}

function defaultDailyReportEmailReportDate(): string {
  const value = new Date()
  value.setDate(value.getDate() - 1)
  return value.toISOString().slice(0, 10)
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function defaultDailyReportEmailRangeStart(dateTo = defaultDailyReportEmailReportDate()): string {
  return shiftIsoDate(dateTo, -6)
}

function formatDailyReportEmailDate(value: string | null | undefined): string {
  const raw = String(value || '').slice(0, 10)
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return raw || '—'
  return `${match[3]}.${match[2]}.${match[1]}`
}

function dailyReportEmailDateSummary(option: DailyReportEmailFileOption, config: DailyReportEmailReportConfig): string {
  const dateTo = config.date_mode === 'custom' && config.date
    ? config.date
    : defaultDailyReportEmailReportDate()
  const totalsLabel = option.supports_cumulative_as_of_end_date && config.cumulative_as_of_end_date !== false
    ? 'накопительные итоги'
    : 'итоги'
  if (option.period_mode === 'range') {
    const dateFrom = config.date_mode === 'custom' && config.date_from
      ? config.date_from
      : defaultDailyReportEmailRangeStart(dateTo)
    return `период ${formatDailyReportEmailDate(dateFrom)} - ${formatDailyReportEmailDate(dateTo)}, ${totalsLabel} на ${formatDailyReportEmailDate(dateTo)}`
  }
  return `${totalsLabel} на ${formatDailyReportEmailDate(dateTo)}`
}

function dailyReportEmailAttachmentDateText(option: DailyReportEmailFileOption, config: DailyReportEmailReportConfig): string {
  if (option.kind === 'system') {
    if (option.period_mode === 'send_date') return 'актуален на дату отправки'
    if (option.period_mode === 'static') return 'без даты'
  }
  const base = dailyReportEmailDateSummary(option, config)
  return base
}

function dailyReportEmailMessageBody(group: DailyReportEmailGroupDraft, fileOptionByKey: Map<string, DailyReportEmailFileOption>): string {
  const lines = [
    'Добрый день!',
    '',
    'Во вложении файлы ежедневной рассылки служебной отчетности:',
  ]
  if (group.report_keys.length === 0) {
    lines.push('- файлы не выбраны')
    return lines.join('\n')
  }
  for (const reportKey of group.report_keys) {
    const option = fileOptionByKey.get(reportKey)
    if (!option) {
      lines.push(`- ${reportKey}`)
      continue
    }
    const config = group.report_configs?.[reportKey] || defaultDailyReportEmailReportConfig()
    const dateText = dailyReportEmailAttachmentDateText(option, config)
    lines.push(`- ${option.label}${dateText ? ` — ${dateText}` : ''}`)
  }
  return lines.join('\n')
}

function formatProgressDuration(seconds?: number | null) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`
  if (minutes > 0) return `${minutes} мин ${String(secs).padStart(2, '0')} сек`
  return `${secs} сек`
}

function timestampMs(value?: string | null) {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function smoothDailyReportEmailStatus(status?: DailyReportEmailSendStatus | null): DailyReportEmailSendStatus | null {
  if (!status) return null
  if (!status.running || status.status !== 'running') return status
  const now = Date.now()
  const startedAt = timestampMs(status.started_at)
  const currentStepStartedAt = timestampMs(status.current_step_started_at)
  const totalEstimate = Number(status.estimated_total_seconds ?? status.total_estimated_seconds ?? 0)
  const elapsed = startedAt !== null
    ? Math.max(0, Math.round((now - startedAt) / 1000))
    : status.elapsed_seconds

  if (!Number.isFinite(totalEstimate) || totalEstimate <= 0 || currentStepStartedAt === null) {
    return { ...status, elapsed_seconds: elapsed }
  }

  const completedEstimate = Number(status.completed_estimated_seconds ?? 0)
  const stepEstimateRaw = Number(status.current_step_estimated_seconds ?? totalEstimate)
  const stepEstimate = Number.isFinite(stepEstimateRaw) && stepEstimateRaw > 0 ? stepEstimateRaw : totalEstimate
  const stepElapsed = Math.max(0, (now - currentStepStartedAt) / 1000)
  const effectiveDone = completedEstimate + Math.min(stepElapsed, stepEstimate * 0.95)
  const localPercent = Math.max(0, Math.min(99, Math.round((effectiveDone / totalEstimate) * 100)))
  const serverPercent = Number(status.progress_percent ?? 0)
  return {
    ...status,
    elapsed_seconds: elapsed,
    eta_seconds: Math.max(0, Math.round(totalEstimate - effectiveDone)),
    estimated_total_seconds: Math.round(totalEstimate),
    progress_percent: Math.max(serverPercent, localPercent),
  }
}

function newDailyReportEmailGroup(index: number): DailyReportEmailGroupDraft {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id: `group_${stamp}`,
    name: index === 0 ? 'Основная группа' : `Группа ${index + 1}`,
    enabled: true,
    recipientsText: '',
    ccText: '',
    report_keys: [],
    report_configs: {},
    subject_prefix: 'VSM: ежедневные отчеты',
  }
}

function emailGroupToDraft(group: DailyReportEmailGroup, index: number): DailyReportEmailGroupDraft {
  return {
    id: group.id || `group_${index + 1}`,
    name: group.name || (index === 0 ? 'Основная группа' : `Группа ${index + 1}`),
    enabled: group.enabled !== false,
    recipientsText: emailListToText(group.recipients),
    ccText: emailListToText(group.cc),
    report_keys: Array.isArray(group.report_keys) ? group.report_keys : [],
    report_configs: group.report_configs && typeof group.report_configs === 'object' ? group.report_configs : {},
    subject_prefix: group.subject_prefix || 'VSM: ежедневные отчеты',
  }
}

function emailDraftGroupToPayload(group: DailyReportEmailGroupDraft): DailyReportEmailGroup {
  return {
    id: group.id,
    name: group.name,
    enabled: group.enabled,
    recipients: emailTextToList(group.recipientsText),
    cc: emailTextToList(group.ccText),
    report_keys: group.report_keys,
    report_configs: group.report_configs || {},
    subject_prefix: group.subject_prefix,
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((data as { detail?: string }).detail || `HTTP ${response.status}`)
  }
  return data as T
}

function normalizeNorms(data: Partial<NormsData> | null | undefined): NormsData | null {
  if (!data) return null
  const genericNorm = Number(data.generic?.norm_m3_per_shift ?? 0)
  return {
    work_types: Array.isArray(data.work_types) ? data.work_types : [],
    work_options: Array.isArray(data.work_options) ? data.work_options : [],
    equipment_types: Array.isArray(data.equipment_types) ? data.equipment_types : [],
    sand_pit: Array.isArray(data.sand_pit) ? data.sand_pit : [],
    sand_stockpile: Array.isArray(data.sand_stockpile) ? data.sand_stockpile : [],
    generic: { norm_m3_per_shift: Number.isFinite(genericNorm) ? genericNorm : 0 },
  }
}

// ── small UI helpers ──────────────────────────────────────────────────────

function Section(props: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? true)
  return (
    <section className="bg-white border border-border rounded-xl shadow-sm">
      <div className={`px-4 py-3 flex items-center gap-3 ${collapsed ? '' : 'border-b border-border'}`}>
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-text-primary"
          aria-label={collapsed ? 'Развернуть блок' : 'Свернуть блок'}
          title={collapsed ? 'Развернуть' : 'Свернуть'}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </button>
        <div className="flex-1">
          <h2 className="text-[15px] font-heading font-bold text-text-primary">{props.title}</h2>
          {props.subtitle && !collapsed && (
            <p className="text-[11px] text-text-muted mt-0.5">{props.subtitle}</p>
          )}
        </div>
        {props.right}
      </div>
      {!collapsed && <div className="p-4">{props.children}</div>}
    </section>
  )
}

function SaveButton({ onClick, disabled, loading, label = 'Сохранить' }: {
  onClick: () => void; disabled?: boolean; loading?: boolean; label?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-accent-red text-white hover:bg-accent-burg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <Save className="w-3.5 h-3.5" />
      {loading ? 'Сохранение…' : label}
    </button>
  )
}

function DownloadLink({ href, icon: Icon, title, description, filename, apiDownload = false }: {
  href: string
  icon: typeof BookOpen
  title: string
  description: string
  filename: string
  apiDownload?: boolean
}) {
  const [downloading, setDownloading] = useState(false)

  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!apiDownload) return
    event.preventDefault()
    if (downloading) return
    setDownloading(true)
    try {
      const response = await fetch(href)
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({})) as { detail?: string }
        throw new Error(errorBody.detail || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch (error) {
      window.alert(`Не удалось скачать файл: ${errorMessage(error)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <a
      href={href}
      download={filename}
      onClick={handleClick}
      aria-busy={downloading}
      className="group flex min-w-0 items-start gap-3 rounded-lg border border-border bg-white px-4 py-3 text-left shadow-sm transition-colors hover:border-accent-red/40 hover:bg-red-50/30"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-surface text-accent-red group-hover:bg-white">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-snug text-text-primary">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-text-muted">{description}</span>
      </span>
      {downloading ? (
        <span className="shrink-0 text-[11px] font-semibold text-accent-red">...</span>
      ) : (
        <Download className="h-4 w-4 shrink-0 text-text-muted group-hover:text-accent-red" />
      )}
    </a>
  )
}

// ── Norms blocks ──────────────────────────────────────────────────────────

type NormDraftRow = WorkTypeNorm & { draft_id: string; work_type_codes: string[] }

function WorkTypesTable({ rows, workOptions, equipmentTypes, onSave, saving, canEdit }: {
  rows: WorkTypeNorm[]
  workOptions: WorkOption[]
  equipmentTypes: string[]
  onSave: (rows: WorkTypeNorm[]) => void
  saving: boolean
  canEdit: boolean
}) {
  const ET_ORDER: Record<string, number> = {
    'экскаватор': 1, 'бульдозер': 2, 'автогрейдер': 3, 'каток': 4, 'самосвал': 5,
  }
  const workByCode = useMemo(() => new Map(workOptions.map(work => [work.code, work])), [workOptions])

  function rowWorkCodes(row: WorkTypeNorm): string[] {
    const raw = Array.isArray(row.work_type_codes) ? row.work_type_codes : [row.work_type_code]
    return raw.map(code => String(code || '').trim()).filter(Boolean)
  }

  function sortDraftRows(arr: NormDraftRow[]): NormDraftRow[] {
    return [...arr].sort((a, b) => {
      const da = ET_ORDER[(a.equipment_type || '').toLowerCase()] ?? 99
      const db = ET_ORDER[(b.equipment_type || '').toLowerCase()] ?? 99
      if (da !== db) return da - db
      return String(a.norm_name || a.name || a.work_type_codes[0] || '').localeCompare(String(b.norm_name || b.name || b.work_type_codes[0] || ''), 'ru')
    })
  }

  function toDraftRows(sourceRows: WorkTypeNorm[]): NormDraftRow[] {
    const groups = new Map<string, NormDraftRow>()
    for (const row of sourceRows) {
      const equipment = String(row.equipment_type || '').trim().toLowerCase()
      const unit = row.unit || 'м³'
      const norm = Number(row.norm || 0)
      const productivity = row.productivity_enabled !== false
      const code = row.code || ''
      const normName = String(row.norm_name || '').trim() || workNames(rowWorkCodes(row)) || row.name || code || 'Норма'
      const key = `${equipment}|${unit}|${norm}|${productivity}|${code}|${normName}`
      const codes = rowWorkCodes(row)
      let draft = groups.get(key)
      if (!draft) {
        draft = {
          ...row,
          draft_id: `norm:${key}`,
          equipment_type: equipment,
          work_type_code: codes[0] || '',
          work_type_codes: [],
          unit,
          norm_name: normName,
          norm,
          code,
          productivity_enabled: productivity,
        }
        groups.set(key, draft)
      }
      for (const workCode of codes) {
        if (workCode && !draft.work_type_codes.includes(workCode)) draft.work_type_codes.push(workCode)
      }
    }
    return sortDraftRows([...groups.values()].map(row => ({
      ...row,
      name: workNames(row.work_type_codes) || row.name || null,
      norm_name: String(row.norm_name || '').trim() || workNames(row.work_type_codes) || row.name || 'Норма',
    })))
  }

  function workNames(codes: string[]): string {
    return codes.map(code => workByCode.get(code)?.name || code).filter(Boolean).join(', ')
  }

  const initialDraft = useMemo(() => toDraftRows(rows), [rows, workByCode])
  const sourceSignature = JSON.stringify(initialDraft)
  const [draft, setDraft] = useState<NormDraftRow[]>(() => initialDraft)
  useEffect(() => { setDraft(initialDraft) }, [sourceSignature])

  const equipmentOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of [...equipmentTypes, ...draft.map(row => row.equipment_type)]) {
      const text = String(value || '').trim().toLowerCase()
      if (!text || seen.has(text)) continue
      seen.add(text)
      result.push(text)
    }
    return result.length ? result : ['экскаватор', 'бульдозер', 'автогрейдер', 'каток', 'самосвал']
  }, [equipmentTypes, draft])

  const flattenedKeys = draft.flatMap(row => row.work_type_codes.map(code => `${String(row.equipment_type || '').trim().toLowerCase()}|${code}`))
  const duplicateKeys = new Set(flattenedKeys.filter((key, index) => key !== '|' && flattenedKeys.indexOf(key) !== index))
  const hasDuplicates = duplicateKeys.size > 0
  const hasInvalid = draft.some(row => !String(row.equipment_type || '').trim() || !String(row.norm_name || '').trim() || !row.work_type_codes.length || !Number.isFinite(Number(row.norm)))
  const dirty = JSON.stringify(draft) !== sourceSignature

  function update(i: number, patch: Partial<NormDraftRow>) {
    setDraft(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  function applyWorks(i: number, codes: string[]) {
    const cleanCodes = [...new Set(codes.map(code => String(code || '').trim()).filter(Boolean))]
    const firstWork = cleanCodes.map(code => workByCode.get(code)).find(Boolean)
    update(i, {
      work_type_code: cleanCodes[0] || '',
      work_type_codes: cleanCodes,
      name: workNames(cleanCodes) || null,
      norm_name: draft[i]?.norm_name || workNames(cleanCodes) || firstWork?.name || 'Норма',
      unit: draft[i]?.unit || firstWork?.default_unit || 'м³',
      productivity_enabled: draft[i]?.productivity_enabled ?? firstWork?.productivity_enabled ?? true,
    })
  }

  function addRow() {
    const equipment = equipmentOptions[0] || 'экскаватор'
    const used = new Set(flattenedKeys)
    const work = workOptions.find(option => !used.has(`${equipment}|${option.code}`)) || workOptions[0]
    setDraft(prev => ([
      ...prev,
      {
        equipment_type: equipment,
        draft_id: `new:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        work_type_code: work?.code || '',
        work_type_codes: work?.code ? [work.code] : [],
        name: work?.name || null,
        norm_name: work?.name ? `Норма: ${work.name}` : 'Новая норма',
        norm: 0,
        unit: work?.default_unit || 'м³',
        code: '',
        productivity_enabled: work?.productivity_enabled ?? true,
      },
    ]))
  }

  function removeRow(i: number) {
    setDraft(prev => prev.filter((_, idx) => idx !== i))
  }

  function saveRows() {
    const payload = sortDraftRows(draft).map(({ draft_id: _draftId, ...row }) => ({
      ...row,
      work_type_code: row.work_type_codes[0] || '',
      name: workNames(row.work_type_codes) || row.name || null,
      norm_name: String(row.norm_name || '').trim() || workNames(row.work_type_codes) || row.name || 'Норма',
      code: row.code || '',
    }))
    onSave(payload)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-text-muted">
          Одна строка нормы может действовать сразу на несколько заведенных работ. Код нормы ведется автоматически и в интерфейсе не редактируется.
        </div>
        <button
          type="button"
          onClick={addRow}
          disabled={!canEdit}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить норму
        </button>
      </div>
      <datalist id="settings-work-equipment-types">
        {equipmentOptions.map(option => <option key={option} value={option} />)}
      </datalist>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-[12px]">
          <thead className="bg-bg-surface">
            <tr className="text-text-muted uppercase tracking-wider text-[10px] border-b border-border">
              <th className="text-left py-2 px-2 font-semibold">Название нормы</th>
              <th className="text-left py-2 px-2 font-semibold">Техника</th>
              <th className="text-left py-2 px-2 font-semibold">Работы из БД</th>
              <th className="text-left py-2 px-2 font-semibold">Ед.</th>
              <th className="text-right py-2 px-2 font-semibold">Норма</th>
              <th className="text-center py-2 px-2 font-semibold">Учитывать</th>
              <th className="w-10 py-2 px-2" />
            </tr>
          </thead>
          <tbody>
            {draft.map((r, i) => {
              const rowDuplicates = r.work_type_codes.filter(code => duplicateKeys.has(`${String(r.equipment_type || '').trim().toLowerCase()}|${code}`))
              return (
                <tr key={r.draft_id} className={`border-b border-border/60 ${rowDuplicates.length ? 'bg-amber-50/60' : ''}`}>
                  <td className="py-1.5 px-2 align-top">
                    <input
                      type="text"
                      value={r.norm_name || ''}
                      disabled={!canEdit}
                      onChange={e => update(i, { norm_name: e.target.value })}
                      className="w-56 rounded border border-border px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-red"
                      placeholder="Например, разработка грунта"
                    />
                  </td>
                  <td className="py-1.5 px-2 align-top">
                    <input
                      list="settings-work-equipment-types"
                      type="text"
                      value={r.equipment_type || ''}
                      disabled={!canEdit}
                      onChange={e => update(i, { equipment_type: e.target.value.toLowerCase() })}
                      className="w-32 rounded border border-border px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-red"
                    />
                  </td>
                  <td className="py-1.5 px-2 align-top">
                    <select
                      multiple
                      size={5}
                      value={r.work_type_codes}
                      disabled={!canEdit}
                      onChange={e => applyWorks(i, Array.from(e.target.selectedOptions).map(option => option.value))}
                      className="w-full rounded border border-border bg-white px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-red"
                    >
                      {workOptions.map(work => (
                        <option key={work.code} value={work.code}>{work.name || work.code} · {work.code}</option>
                      ))}
                    </select>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-text-muted">
                      <span>{r.work_type_codes.length ? `${r.work_type_codes.length} работ` : 'без работ'}</span>
                      {rowDuplicates.length > 0 && <span className="font-semibold text-amber-700">дубль: {rowDuplicates.join(', ')}</span>}
                    </div>
                  </td>
                  <td className="py-1.5 px-2 align-top">
                    <input
                      type="text" value={r.unit ?? ''}
                      disabled={!canEdit}
                      onChange={e => update(i, { unit: e.target.value })}
                      className="w-16 rounded border border-border px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-red"
                    />
                  </td>
                  <td className="py-1.5 px-2 text-right align-top">
                    <input
                      type="number" step="0.1" value={r.norm}
                      disabled={!canEdit}
                      onChange={e => update(i, { norm: Number(e.target.value) })}
                      className="w-24 rounded border border-border px-1.5 py-1 text-right font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-red"
                    />
                  </td>
                  <td className="py-1.5 px-2 text-center align-top">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={r.productivity_enabled !== false}
                      onChange={e => update(i, { productivity_enabled: e.target.checked })}
                      className="mt-1 h-4 w-4 accent-red-700"
                      title="Если выключено, факт этой работы не попадет в расчет производительности техники"
                    />
                  </td>
                  <td className="py-1.5 px-2 text-right align-top">
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      disabled={!canEdit}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40"
                      title="Удалить норму"
                      aria-label="Удалить норму"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {(hasDuplicates || hasInvalid) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {hasDuplicates ? 'Одна и та же пара техника + работа выбрана в нескольких нормах. ' : ''}
          {hasInvalid ? 'Заполни название нормы, тип техники, хотя бы одну работу и числовую норму.' : ''}
        </div>
      )}
      <div className="flex justify-end">
        <SaveButton onClick={saveRows} disabled={!canEdit || !dirty || hasDuplicates || hasInvalid} loading={saving} />
      </div>
    </div>
  )
}

const DEDUP_KIND_OPTIONS: Array<{ kind: DedupKind; label: string; hint: string }> = [
  { kind: 'work_type', label: 'Работы', hint: 'планы, факты, дефолты типов объектов, сваи' },
  { kind: 'object', label: 'Объекты', hint: 'планы, факты, сегменты, перевозки, сваи' },
  { kind: 'material', label: 'Материалы', hint: 'перевозки и накопители' },
]

function dedupReferenceLabel(ref: DedupReference | null | undefined): string {
  if (!ref) return '—'
  const code = String(ref.code || '').trim()
  const label = String(ref.label || '').trim()
  if (code && label && code !== label) return `${label} · ${code}`
  return label || code || ref.id
}

function tableRefCountLabel(ref: DedupReference): string {
  const count = Number(ref.ref_count || 0)
  if (count === 1) return '1 ссылка'
  if (count > 1 && count < 5) return `${count} ссылки`
  return `${count} ссылок`
}

function dedupTableLabel(key: string): string {
  const labels: Record<string, string> = {
    'daily_work_items.work_type_id': 'факты работ',
    'daily_work_items.object_id': 'факты работ по объекту',
    'planned_work_items.work_type_id': 'месячные планы работ',
    'planned_work_items.object_id': 'месячные планы по объекту',
    'project_work_items.work_type_id': 'проектные объемы работ',
    'project_work_items.object_id': 'проектные объемы по объекту',
    'constructive_work_types.work_type_id': 'работы конструктивов',
    'object_type_work_type_defaults.work_type_id': 'дефолтные работы типов объектов',
    'pipe_pile_specs.work_type_id': 'спеки свай по работе',
    'pipe_pile_specs.object_id': 'спеки свай по объекту',
    'material_movements.material_id': 'перевозки материала',
    'material_movements.from_object_id': 'перевозки из объекта',
    'material_movements.to_object_id': 'перевозки в объект',
    'stockpiles.material_id': 'накопители материала',
    'stockpiles.object_id': 'накопители объекта',
    'constructives.object_id': 'конструктивы объекта',
    'object_map_points.object_id': 'точки карты',
    'object_segments.object_id': 'пикетажные сегменты',
    'pile_fields.object_id': 'свайные поля',
    'temporary_roads.object_id': 'временные дороги',
    'temporary_road_status_segments.object_id': 'статусы временных дорог',
    'section_quarry_haul_distances.quarry_object_id': 'плечи возки карьеров',
    'isso_front_transfer_lines.object_id': 'переносы фронтов ИССО',
    'isso_object_front_attributes.object_id': 'атрибуты фронтов ИССО',
  }
  return labels[key] || key.replaceAll('_', ' ')
}

function ReferenceDedupBlock() {
  const qc = useQueryClient()
  const [kind, setKind] = useState<DedupKind>('work_type')
  const [sourceQuery, setSourceQuery] = useState('')
  const [targetQuery, setTargetQuery] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [targetId, setTargetId] = useState('')
  const [deleteSources, setDeleteSources] = useState(true)
  const [includeState, setIncludeState] = useState<{ signature: string; tables: string[] }>({ signature: '', tables: [] })
  const [lastResult, setLastResult] = useState<DedupMigrateResponse | null>(null)

  useEffect(() => {
    setSourceIds([])
    setTargetId('')
    setIncludeState({ signature: '', tables: [] })
    setLastResult(null)
  }, [kind])

  const sourceRefs = useQuery<DedupReferencesResponse>({
    queryKey: ['wip', 'settings', 'dedup', 'references', kind, 'source', sourceQuery],
    queryFn: () => fetchJson<DedupReferencesResponse>(`/api/wip/settings/dedup/references?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(sourceQuery)}&limit=500`),
    staleTime: 30_000,
  })
  const targetRefs = useQuery<DedupReferencesResponse>({
    queryKey: ['wip', 'settings', 'dedup', 'references', kind, 'target', targetQuery],
    queryFn: () => fetchJson<DedupReferencesResponse>(`/api/wip/settings/dedup/references?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(targetQuery)}&limit=500`),
    staleTime: 30_000,
  })

  const previewSourceId = sourceIds[0] || ''
  const preview = useQuery<DedupPreview>({
    queryKey: ['wip', 'settings', 'dedup', 'preview', kind, previewSourceId, targetId],
    queryFn: () => fetchJson<DedupPreview>(`/api/wip/settings/dedup/preview?kind=${encodeURIComponent(kind)}&source_id=${encodeURIComponent(previewSourceId)}&target_id=${encodeURIComponent(targetId)}`),
    enabled: Boolean(previewSourceId && targetId),
    staleTime: 10_000,
  })

  const tableKeys = useMemo(() => {
    const counts = preview.data ? { ...preview.data.source_counts, ...preview.data.target_counts } : {}
    return Object.keys(counts).sort((a, b) => dedupTableLabel(a).localeCompare(dedupTableLabel(b), 'ru'))
  }, [preview.data])
  const previewSignature = `${kind}:${previewSourceId}:${targetId}`
  useEffect(() => {
    if (!preview.data) return
    const selected = tableKeys.filter(key => Number(preview.data?.source_counts[key] || 0) > 0)
    setIncludeState(prev => prev.signature === previewSignature ? prev : { signature: previewSignature, tables: selected.length ? selected : tableKeys })
  }, [preview.data, previewSignature, tableKeys])
  const includeTables = includeState.signature === previewSignature ? includeState.tables : []

  const deleteRefMut = useMutation({
    mutationFn: async (row: DedupReference) => fetchJson<{ ok: boolean }>(`/api/wip/settings/dedup/references/${encodeURIComponent(kind)}/${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setLastResult(null)
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'dedup'] })
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'norms'] })
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
    },
  })

  const migrateMut = useMutation({
    mutationFn: async () => fetchJson<DedupMigrateResponse>('/api/wip/settings/dedup/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        source_ids: sourceIds,
        target_id: targetId,
        include_tables: includeTables,
        delete_sources: deleteSources,
      }),
    }),
    onSuccess: result => {
      setLastResult(result)
      setSourceIds([])
      setIncludeState({ signature: '', tables: [] })
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'dedup'] })
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'norms'] })
      qc.invalidateQueries({ queryKey: ['aliases-list'] })
    },
  })

  const sourceRows = sourceRefs.data?.rows ?? []
  const targetRows = targetRefs.data?.rows ?? []
  const selectedKind = DEDUP_KIND_OPTIONS.find(option => option.kind === kind)
  const selectedSourceLabels = sourceRows.filter(row => sourceIds.includes(row.id))

  function toggleSource(id: string, checked: boolean) {
    setLastResult(null)
    setSourceIds(prev => {
      if (checked) return prev.includes(id) ? prev : [...prev, id]
      return prev.filter(value => value !== id)
    })
  }

  function toggleTable(key: string, checked: boolean) {
    setIncludeState(prev => {
      const tables = prev.signature === previewSignature ? prev.tables : includeTables
      return {
        signature: previewSignature,
        tables: checked ? [...new Set([...tables, key])] : tables.filter(value => value !== key),
      }
    })
  }

  function DeleteEmptyReferenceButton({ row }: { row: DedupReference }) {
    const refCount = Number(row.ref_count || 0)
    return (
      <button
        type="button"
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          if (refCount > 0) return
          if (window.confirm(`Удалить пустую запись: ${dedupReferenceLabel(row)}?`)) deleteRefMut.mutate(row)
        }}
        disabled={refCount > 0 || deleteRefMut.isPending}
        className="shrink-0 rounded border border-border bg-white px-2 py-1 text-[10px] font-semibold text-text-muted hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-35"
        title={refCount > 0 ? 'Удалить можно только записи без ссылок и фактов' : 'Удалить пустую запись'}
      >
        Удалить
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Справочник</span>
          <select value={kind} onChange={event => setKind(event.target.value as DedupKind)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100">
            {DEDUP_KIND_OPTIONS.map(option => <option key={option.kind} value={option.kind}>{option.label}</option>)}
          </select>
        </label>
        <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-[12px] text-text-secondary">
          Переносит выбранные ссылки с дублей на целевую запись и пишет аудит в <span className="font-mono">reference_dedup_audit</span>. Затрагиваемые связи: {selectedKind?.hint}.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Список откуда переносим</span>
            <input value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} placeholder="фильтр по коду или названию" className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            {sourceRefs.isLoading ? <div className="p-3 text-xs text-text-muted">Загрузка...</div> : null}
            {!sourceRefs.isLoading && sourceRows.length === 0 ? <div className="p-3 text-xs text-text-muted">Ничего не найдено.</div> : null}
            {sourceRows.map(row => (
              <label key={row.id} className={`flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-0 ${row.id === targetId ? 'bg-bg-surface text-text-muted' : 'hover:bg-bg-surface/70'}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-red-700"
                  checked={sourceIds.includes(row.id)}
                  disabled={row.id === targetId}
                  onChange={event => toggleSource(row.id, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-text-primary" title={dedupReferenceLabel(row)}>{dedupReferenceLabel(row)}</span>
                  <span className="block text-[10px] text-text-muted">{tableRefCountLabel(row)}{row.review_tag ? ` · ${row.review_tag}` : ''}</span>
                </span>
                <DeleteEmptyReferenceButton row={row} />
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Список куда переносим</span>
            <input value={targetQuery} onChange={event => setTargetQuery(event.target.value)} placeholder="фильтр по коду или названию" className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent-red focus:ring-2 focus:ring-red-100" />
          </label>
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            {targetRefs.isLoading ? <div className="p-3 text-xs text-text-muted">Загрузка...</div> : null}
            {!targetRefs.isLoading && targetRows.length === 0 ? <div className="p-3 text-xs text-text-muted">Ничего не найдено.</div> : null}
            {targetRows.map(row => (
              <label key={row.id} className={`flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-0 ${sourceIds.includes(row.id) ? 'bg-bg-surface text-text-muted' : 'hover:bg-bg-surface/70'}`}>
                <input
                  type="radio"
                  name="dedup-target"
                  className="mt-0.5 h-4 w-4 accent-red-700"
                  checked={targetId === row.id}
                  disabled={sourceIds.includes(row.id)}
                  onChange={() => {
                    setLastResult(null)
                    setTargetId(row.id)
                    setSourceIds(prev => prev.filter(value => value !== row.id))
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-text-primary" title={dedupReferenceLabel(row)}>{dedupReferenceLabel(row)}</span>
                  <span className="block text-[10px] text-text-muted">{tableRefCountLabel(row)}{row.analytics_tag ? ` · ${row.analytics_tag}` : ''}</span>
                </span>
                <DeleteEmptyReferenceButton row={row} />
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-[12px] text-text-secondary">
        Источники: {selectedSourceLabels.length ? selectedSourceLabels.map(dedupReferenceLabel).join('; ') : 'не выбраны'}
        <br />
        Цель: {dedupReferenceLabel(targetRows.find(row => row.id === targetId) || preview.data?.target)}
      </div>

      {preview.data && (
        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-text-primary">
            Предпросмотр ссылок{sourceIds.length > 1 ? ' по первому выбранному дублю; при запуске те же типы ссылок применятся ко всем выбранным дублям' : ''}
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[560px] text-[12px]">
              <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-2 py-2 text-left font-semibold">Связь</th>
                  <th className="px-2 py-2 text-right font-semibold">У дубля</th>
                  <th className="px-2 py-2 text-right font-semibold">У цели</th>
                  <th className="px-2 py-2 text-center font-semibold">Перенести</th>
                </tr>
              </thead>
              <tbody>
                {tableKeys.map(key => {
                  const checked = includeTables.includes(key)
                  return (
                    <tr key={key} className="border-t border-border/60">
                      <td className="px-2 py-1.5 text-text-primary">{dedupTableLabel(key)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{preview.data?.source_counts[key] || 0}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{preview.data?.target_counts[key] || 0}</td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={checked} onChange={event => toggleTable(key, event.target.checked)} className="h-4 w-4 accent-red-700" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={deleteSources} onChange={event => setDeleteSources(event.target.checked)} />
          Удалить дубли после переноса, если ссылок не осталось
        </label>
        <button
          type="button"
          onClick={() => migrateMut.mutate()}
          disabled={!sourceIds.length || !targetId || !includeTables.length || migrateMut.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-semibold text-white hover:bg-accent-burg disabled:opacity-40"
        >
          <ShieldCheck className="h-4 w-4" />
          {migrateMut.isPending ? 'Миграция...' : 'Перенести выбранное'}
        </button>
      </div>

      {deleteRefMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(deleteRefMut.error)}</div> : null}
      {migrateMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(migrateMut.error)}</div> : null}
      {lastResult ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-green-800">
          Готово: обработано {lastResult.sources.length} дубл.; целевая запись — {dedupReferenceLabel(lastResult.target)}.
        </div>
      ) : null}
    </div>
  )
}

function SandSectionTable({ rows, title, onSave, saving, canEdit }: {
  rows: SandSectionNorm[]
  title: string
  onSave: (rows: SandSectionNorm[]) => void
  saving: boolean
  canEdit: boolean
}) {
  const [draft, setDraft] = useState<SandSectionNorm[]>(rows)
  useEffect(() => { setDraft(rows) }, [rows])
  const dirty = JSON.stringify(draft) !== JSON.stringify(rows)

  function update(i: number, patch: Partial<SandSectionNorm>) {
    setDraft(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-text-muted">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-bg-surface">
            <tr className="text-text-muted uppercase tracking-wider text-[10px] border-b border-border">
              <th className="text-left py-2 px-2 font-semibold">Участок</th>
              <th className="text-right py-2 px-2 font-semibold">Рейсов / смена</th>
              <th className="text-right py-2 px-2 font-semibold">м³ / рейс</th>
              <th className="text-right py-2 px-2 font-semibold">Норма смены (м³)</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((r, i) => (
              <tr key={r.section} className="border-b border-border/60">
                <td className="py-1.5 px-2 font-mono font-semibold">№{r.section}</td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number" step="1" value={r.trips}
                    disabled={!canEdit}
                    onChange={e => update(i, { trips: Number(e.target.value) })}
                    className="w-20 text-right font-mono text-[12px] border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent-red"
                  />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number" step="0.5" value={r.m3_per_trip}
                    disabled={!canEdit}
                    onChange={e => update(i, { m3_per_trip: Number(e.target.value) })}
                    className="w-20 text-right font-mono text-[12px] border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent-red"
                  />
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-text-muted">
                  {Math.round((r.trips || 0) * (r.m3_per_trip || 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <SaveButton onClick={() => onSave(draft)} disabled={!canEdit || !dirty} loading={saving} />
      </div>
    </div>
  )
}

function GenericTruckBlock({ value, onSave, saving, canEdit }: {
  value: number
  onSave: (v: number) => void
  saving: boolean
  canEdit: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const dirty = draft !== value

  return (
    <div className="flex items-end gap-3">
      <div>
        <label className="block text-[11px] text-text-muted mb-1">Норма, м³ / смена / ед.</label>
        <input
          type="number" step="1" value={draft}
          disabled={!canEdit}
          onChange={e => setDraft(Number(e.target.value))}
          className="w-32 text-right font-mono text-[13px] border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent-red"
        />
      </div>
      <SaveButton onClick={() => onSave(draft)} disabled={!canEdit || !dirty} loading={saving} />
      <p className="text-[11px] text-text-muted flex-1">
        Применяется к «прочей перевозке»: торф, ЩПС/ЩПГС, щебень, перемещение накопитель↔накопитель и т. д.
      </p>
    </div>
  )
}

function SectionBoundariesBlock({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError, error } = useQuery<SectionBoundariesData>({
    queryKey: ['wip', 'settings', 'section-boundaries'],
    queryFn: () => fetchJson<SectionBoundariesData>('/api/wip/settings/section-boundaries'),
    staleTime: 60_000,
  })
  const kinds = data?.boundary_kinds ?? []
  const sections = data?.sections ?? []
  const [kind, setKind] = useState('main')
  const sourceRows = (data?.rows ?? []).filter(row => row.boundary_kind === kind)
  const sourceKey = sourceRows.map(row => `${row.id}:${row.pk_start}:${row.pk_end}:${row.comment ?? ''}`).join('|')

  if (isLoading) {
    return <div className="h-32 animate-pulse rounded-md bg-bg-surface" />
  }
  if (isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
        Не удалось загрузить границы участков: {errorMessage(error)}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {kinds.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => setKind(item.key)}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${
              kind === item.key
                ? 'bg-text-primary text-white'
                : 'border border-border bg-white text-text-muted hover:text-text-primary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <SectionBoundaryEditor
        key={`${kind}:${sourceKey}`}
        kind={kind}
        sourceRows={sourceRows}
        sections={sections}
        canEdit={canEdit}
      />
    </div>
  )
}

function SectionBoundaryEditor({
  kind,
  sourceRows,
  sections,
  canEdit,
}: {
  kind: string
  sourceRows: SectionBoundaryRow[]
  sections: SectionOption[]
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<SectionBoundaryRow[]>(() => sourceRows.map(row => ({ ...row })))
  const dirty = JSON.stringify(draft) !== JSON.stringify(sourceRows)
  const sectionOptions = [...sections]
  for (const row of draft) {
    if (row.section_code && !sectionOptions.some(section => section.code === row.section_code)) {
      sectionOptions.push({
        code: row.section_code,
        name: row.section_name || row.section_code.replace('UCH_', 'Участок '),
        sort_order: null,
      })
    }
  }
  sectionOptions.sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999) || a.code.localeCompare(b.code))

  const saveMut = useMutation({
    mutationFn: async () => fetchJson('/api/wip/settings/section-boundaries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boundary_kind: kind,
        rows: draft.map(row => ({
          section_code: row.section_code,
          pk_start: Number(row.pk_start) || 0,
          pk_end: Number(row.pk_end) || 0,
          pk_raw_text: row.pk_raw_text || '',
          comment: row.comment || '',
        })),
      }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wip', 'settings', 'section-boundaries'] }),
  })

  function updateRow(index: number, patch: Partial<SectionBoundaryRow>) {
    setDraft(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function addRow(after?: number) {
    const sourceRow = after == null ? null : draft[after]
    const sectionCode = sourceRow?.section_code || sectionOptions[0]?.code || 'UCH_1'
    const pkStart = Number(sourceRow?.pk_end ?? 0) || 0
    const row: SectionBoundaryRow = {
      boundary_kind: kind,
      section_code: sectionCode,
      section_name: sourceRow?.section_name,
      pk_start: pkStart,
      pk_end: pkStart,
      pk_raw_text: '',
      comment: '',
    }
    setDraft(prev => {
      if (after == null) return [...prev, row]
      const next = [...prev]
      next.splice(after + 1, 0, row)
      return next
    })
  }

  function removeRow(index: number) {
    setDraft(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-bg-surface">
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-muted">
              <th className="px-2 py-2 text-left font-semibold">Участок</th>
              <th className="px-2 py-2 text-right font-semibold">PK start</th>
              <th className="px-2 py-2 text-right font-semibold">PK end</th>
              <th className="px-2 py-2 text-left font-semibold">Текст</th>
              <th className="px-2 py-2 text-left font-semibold">Комментарий</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {draft.map((row, index) => (
              <tr key={`${row.id || 'new'}-${index}`} className="border-b border-border/60">
                <td className="px-2 py-1.5">
                  <select
                    value={row.section_code}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { section_code: e.target.value })}
                    className="w-28 rounded border border-border px-1.5 py-1 text-[12px]"
                  >
                    {sectionOptions.map(section => (
                      <option key={section.code} value={section.code}>
                        {section.code.replace('UCH_', '№')}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    step="0.01"
                    value={row.pk_start}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { pk_start: Number(e.target.value) })}
                    className="w-28 rounded border border-border px-1.5 py-1 text-right font-mono text-[12px]"
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    step="0.01"
                    value={row.pk_end}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { pk_end: Number(e.target.value) })}
                    className="w-28 rounded border border-border px-1.5 py-1 text-right font-mono text-[12px]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={row.pk_raw_text || ''}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { pk_raw_text: e.target.value })}
                    placeholder="ПК2640+22 - ПК2754+22"
                    className="w-56 rounded border border-border px-1.5 py-1 text-[12px]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={row.comment || ''}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { comment: e.target.value })}
                    className="w-full min-w-48 rounded border border-border px-1.5 py-1 text-[12px]"
                  />
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => addRow(index)}
                    className="p-1 text-text-muted hover:text-text-primary disabled:opacity-40"
                    title="Добавить сегмент ниже"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={!canEdit || draft.length <= 1}
                    onClick={() => removeRow(index)}
                    className="p-1 text-accent-red hover:bg-red-50 disabled:opacity-40"
                    title="Удалить сегмент"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => addRow()}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-bg-surface disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Сегмент
        </button>
        <SaveButton
          onClick={() => saveMut.mutate()}
          disabled={!canEdit || !dirty || draft.length === 0}
          loading={saveMut.isPending}
        />
      </div>
    </>
  )
}

// ── Aliases block ─────────────────────────────────────────────────────────

function AliasesBlock() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery<{ rows: AliasRow[] }>({
    queryKey: ['wip', 'settings', 'aliases'],
    queryFn: () => fetchJson<{ rows: AliasRow[] }>('/api/wip/settings/aliases'),
    staleTime: 60_000,
  })
  const rows = Array.isArray(data?.rows) ? data.rows : []

  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<AliasRow>>({})
  const [newRow, setNewRow] = useState<Partial<AliasRow>>({
    canonical_code: '', alias_text: '', kind: 'work_type', notes: '',
  })
  const [err, setErr] = useState<string | null>(null)

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['wip', 'settings', 'aliases'] })
  }

  const createMut = useMutation({
    mutationFn: async (body: Partial<AliasRow>) => {
      const r = await fetch('/api/wip/settings/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: 'Ошибка' }))).detail || 'Ошибка')
      return r.json()
    },
    onSuccess: () => {
      setNewRow({ canonical_code: '', alias_text: '', kind: 'work_type', notes: '' })
      setErr(null)
      invalidate()
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  })

  const patchMut = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Partial<AliasRow> }) => {
      const r = await fetch(`/api/wip/settings/aliases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: 'Ошибка' }))).detail || 'Ошибка')
      return r.json()
    },
    onSuccess: () => { setEditId(null); setEditDraft({}); invalidate() },
    onError: (e: unknown) => setErr(errorMessage(e)),
  })

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/wip/settings/aliases/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error('Не удалось удалить')
      return r.json()
    },
    onSuccess: invalidate,
  })

  function startEdit(row: AliasRow) {
    setEditId(row.id)
    setEditDraft({ ...row })
  }

  return (
    <div className="space-y-3">
      {err && (
        <div className="text-[12px] text-accent-red bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-bg-surface">
            <tr className="text-text-muted uppercase tracking-wider text-[10px] border-b border-border">
              <th className="text-left py-2 px-2 font-semibold">Канонический код</th>
              <th className="text-left py-2 px-2 font-semibold">Алиас</th>
              <th className="text-left py-2 px-2 font-semibold">Тип</th>
              <th className="text-left py-2 px-2 font-semibold">Примечание</th>
              <th className="w-28"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="py-6 text-center text-text-muted">Загрузка…</td></tr>
            )}
            {isError && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-accent-red">
                  Не удалось загрузить алиасы: {errorMessage(error)}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-text-muted">Алиасов пока нет.</td></tr>
            )}
            {rows.map((row, idx, arr) => {
              const isEd = editId === row.id
              // Визуальная группировка: показываем канонический код только у первой
              // записи в группе (одинаковый kind+canonical_code подряд благодаря
              // сортировке на бэкенде). Для остальных — левая рамка вместо кода.
              const prev = idx > 0 ? arr[idx - 1] : null
              const isGroupStart = !prev || prev.kind !== row.kind || prev.canonical_code !== row.canonical_code
              const next = idx < arr.length - 1 ? arr[idx + 1] : null
              const isGroupEnd = !next || next.kind !== row.kind || next.canonical_code !== row.canonical_code
              const hasDuplicates = !isGroupStart || (!!next && next.kind === row.kind && next.canonical_code === row.canonical_code)
              return (
                <tr
                  key={row.id}
                  className={`align-top ${isGroupEnd ? 'border-b border-border/60' : ''} ${hasDuplicates ? 'bg-amber-50/30' : ''}`}
                >
                  <td className={`py-1.5 px-2 font-mono ${!isGroupStart ? 'text-text-muted/60' : ''}`}>
                    {isEd ? (
                      <input
                        type="text" value={editDraft.canonical_code ?? ''}
                        onChange={e => setEditDraft(p => ({ ...p, canonical_code: e.target.value }))}
                        className="w-40 text-[12px] border border-border rounded px-1.5 py-0.5"
                      />
                    ) : (isGroupStart ? row.canonical_code : <span className="text-[11px]">↳</span>)}
                  </td>
                  <td className="py-1.5 px-2">
                    {isEd ? (
                      <input
                        type="text" value={editDraft.alias_text ?? ''}
                        onChange={e => setEditDraft(p => ({ ...p, alias_text: e.target.value }))}
                        className="w-56 text-[12px] border border-border rounded px-1.5 py-0.5"
                      />
                    ) : row.alias_text}
                  </td>
                  <td className="py-1.5 px-2">
                    {isEd ? (
                      <select
                        value={editDraft.kind ?? row.kind}
                        onChange={e => setEditDraft(p => ({ ...p, kind: e.target.value as AliasRow['kind'] }))}
                        className="text-[12px] border border-border rounded px-1 py-0.5"
                      >
                        {ALIAS_KINDS.map(k => <option key={k} value={k}>{ALIAS_KIND_LABELS[k]}</option>)}
                      </select>
                    ) : ALIAS_KIND_LABELS[row.kind]}
                  </td>
                  <td className="py-1.5 px-2 text-text-secondary">
                    {isEd ? (
                      <input
                        type="text" value={editDraft.notes ?? ''}
                        onChange={e => setEditDraft(p => ({ ...p, notes: e.target.value }))}
                        className="w-full text-[12px] border border-border rounded px-1.5 py-0.5"
                      />
                    ) : (row.notes || '—')}
                  </td>
                  <td className="py-1.5 px-2 text-right whitespace-nowrap">
                    {isEd ? (
                      <>
                        <button
                          onClick={() => patchMut.mutate({ id: row.id, body: editDraft })}
                          className="p-1 text-[#16a34a] hover:bg-green-50 rounded"
                          title="Сохранить"
                        ><Check className="w-4 h-4" /></button>
                        <button
                          onClick={() => { setEditId(null); setEditDraft({}) }}
                          className="p-1 text-text-muted hover:bg-bg-surface rounded"
                          title="Отмена"
                        ><X className="w-4 h-4" /></button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(row)}
                          className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-surface rounded"
                          title="Редактировать"
                        ><Pencil className="w-4 h-4" /></button>
                        <button
                          onClick={() => { if (confirm(`Удалить алиас «${row.alias_text}»?`)) deleteMut.mutate(row.id) }}
                          className="p-1 text-accent-red hover:bg-red-50 rounded"
                          title="Удалить"
                        ><Trash2 className="w-4 h-4" /></button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="border border-dashed border-border rounded-lg p-3 bg-bg-surface/30">
        <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
          Добавить алиас
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-[10px] text-text-muted">Канонический код</label>
            <input
              type="text" placeholder="напр. UNPRF_SOIL"
              value={newRow.canonical_code ?? ''}
              onChange={e => setNewRow(p => ({ ...p, canonical_code: e.target.value }))}
              className="w-44 text-[12px] border border-border rounded px-2 py-1"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted">Алиас (как пишет пользователь)</label>
            <input
              type="text" placeholder="напр. торф"
              value={newRow.alias_text ?? ''}
              onChange={e => setNewRow(p => ({ ...p, alias_text: e.target.value }))}
              className="w-56 text-[12px] border border-border rounded px-2 py-1"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted">Тип</label>
            <select
              value={newRow.kind ?? 'work_type'}
              onChange={e => setNewRow(p => ({ ...p, kind: e.target.value as AliasRow['kind'] }))}
              className="text-[12px] border border-border rounded px-2 py-1"
            >
              {ALIAS_KINDS.map(k => <option key={k} value={k}>{ALIAS_KIND_LABELS[k]}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10px] text-text-muted">Примечание</label>
            <input
              type="text" placeholder="необязательно"
              value={newRow.notes ?? ''}
              onChange={e => setNewRow(p => ({ ...p, notes: e.target.value }))}
              className="w-full text-[12px] border border-border rounded px-2 py-1"
            />
          </div>
          <button
            type="button"
            disabled={!newRow.canonical_code || !newRow.alias_text || createMut.isPending}
            onClick={() => createMut.mutate(newRow)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-accent-red text-white hover:bg-accent-burg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            Добавить
          </button>
        </div>
      </div>
    </div>
  )
}

function HaulDistancesBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery<HaulDistancesData>({
    queryKey: ['wip', 'settings', 'haul-distances'],
    queryFn: () => fetchJson<HaulDistancesData>('/api/wip/settings/haul-distances'),
    staleTime: 60_000,
  })
  const [activeSection, setActiveSection] = useState<string>('')
  const [draft, setDraft] = useState<HaulDistanceRow[]>([])
  const [quarryDraft, setQuarryDraft] = useState<QuarryOption[]>([])

  /* eslint-disable react-hooks/set-state-in-effect -- hydrate editable drafts from fetched settings data. */
  useEffect(() => {
    if (!data) return
    setDraft(data.rows ?? [])
    setQuarryDraft((data.quarries ?? []).map(quarry => ({ ...quarry })))
    setActiveSection(prev => prev || data.sections[0]?.code || '')
  }, [data])
  /* eslint-enable react-hooks/set-state-in-effect */

  const saveMut = useMutation({
    mutationFn: async (rows: HaulDistanceRow[]) => fetchJson('/api/wip/settings/haul-distances', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: rows
          .filter(row => row.section_code && row.quarry_object_id && Number(row.distance_km || 0) > 0)
          .map(row => ({
            section_code: row.section_code,
            quarry_object_id: row.quarry_object_id,
            distance_km: Number(row.distance_km),
          })),
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'haul-distances'] })
      qc.invalidateQueries({ queryKey: ['wip', 'tv-dashboard'] })
    },
  })
  const saveQuarriesMut = useMutation({
    mutationFn: async (rows: QuarryOption[]) => fetchJson('/api/wip/settings/quarries', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: rows.map(row => ({
          id: row.id,
          latitude: row.latitude,
          longitude: row.longitude,
        })),
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'haul-distances'] })
      qc.invalidateQueries({ queryKey: ['geo-objects'] })
    },
  })

  if (isLoading) return <div className="h-36 animate-pulse rounded-lg bg-bg-surface" />
  if (isError || !data) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
        Не удалось загрузить плечи возки: {errorMessage(error)}
      </div>
    )
  }

  const activeRows = draft
    .map((row, index) => ({ row, index }))
    .filter(item => item.row.section_code === activeSection)
  const usedQuarries = new Set(activeRows.map(item => item.row.quarry_object_id).filter(Boolean))
  const firstFreeQuarry = data.quarries.find(q => !usedQuarries.has(q.id)) ?? data.quarries[0]
  const sourceQuarryKey = data.quarries
    .map(quarry => `${quarry.id}:${quarry.latitude ?? ''}:${quarry.longitude ?? ''}`)
    .join('|')
  const draftQuarryKey = quarryDraft
    .map(quarry => `${quarry.id}:${quarry.latitude ?? ''}:${quarry.longitude ?? ''}`)
    .join('|')
  const quarriesDirty = sourceQuarryKey !== draftQuarryKey

  function updateRow(index: number, patch: Partial<HaulDistanceRow>) {
    setDraft(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function updateQuarry(index: number, patch: Partial<QuarryOption>) {
    setQuarryDraft(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function addRow() {
    if (!activeSection || !firstFreeQuarry) return
    setDraft(prev => [...prev, {
      section_code: activeSection,
      quarry_object_id: firstFreeQuarry.id,
      quarry_code: firstFreeQuarry.code,
      quarry_name: firstFreeQuarry.name,
      distance_km: null,
    }])
  }

  function deleteRow(index: number) {
    setDraft(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-4">
      {!canEdit && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Плечи возки доступны только для просмотра. Изменять их могут учетные записи admin и user.
        </div>
      )}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[12px] font-semibold text-text-primary">Координаты карьеров для карты</div>
            <div className="text-[11px] text-text-muted">Широта и долгота нужны для отрисовки карьеров как точек вне оси трассы.</div>
          </div>
          <SaveButton
            onClick={() => saveQuarriesMut.mutate(quarryDraft)}
            disabled={!canEdit || !quarriesDirty}
            loading={saveQuarriesMut.isPending}
          />
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[620px] text-[12px]">
            <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Карьер</th>
                <th className="px-3 py-2 text-right font-semibold">Широта</th>
                <th className="px-3 py-2 text-right font-semibold">Долгота</th>
              </tr>
            </thead>
            <tbody>
              {quarryDraft.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-5 text-center text-text-muted">Карьеры не найдены.</td>
                </tr>
              ) : quarryDraft.map((quarry, index) => (
                <tr key={quarry.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-text-primary">{quarry.name}</div>
                    <div className="font-mono text-[10px] uppercase tracking-wide text-text-muted">{quarry.code}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="-90"
                      max="90"
                      step="0.000001"
                      value={quarry.latitude ?? ''}
                      disabled={!canEdit}
                      onChange={e => updateQuarry(index, { latitude: e.target.value === '' ? null : Number(e.target.value) })}
                      className="h-8 w-36 rounded-md border border-border bg-white px-2 text-right font-mono text-[12px] focus:border-accent-red/50 focus:outline-none disabled:bg-bg-surface"
                      placeholder="58.123456"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="0.000001"
                      value={quarry.longitude ?? ''}
                      disabled={!canEdit}
                      onChange={e => updateQuarry(index, { longitude: e.target.value === '' ? null : Number(e.target.value) })}
                      className="h-8 w-36 rounded-md border border-border bg-white px-2 text-right font-mono text-[12px] focus:border-accent-red/50 focus:outline-none disabled:bg-bg-surface"
                      placeholder="33.123456"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.sections.map(section => (
          <button
            key={section.code}
            type="button"
            onClick={() => setActiveSection(section.code)}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${activeSection === section.code ? 'bg-text-primary text-white' : 'border border-border bg-white text-text-muted hover:text-text-primary'}`}
          >
            {section.code.replace('UCH_', 'Участок №')}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-[12px]">
          <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Карьер</th>
              <th className="px-3 py-2 text-left font-semibold">Плечо возки, км</th>
              <th className="w-12 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-text-muted">
                  Для участка пока не задано ни одного карьера.
                </td>
              </tr>
            ) : activeRows.map(({ row, index }) => (
              <tr key={`${row.section_code}-${row.quarry_object_id}-${index}`} className="border-t border-border">
                <td className="px-3 py-2">
                  <select
                    value={row.quarry_object_id}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { quarry_object_id: e.target.value })}
                    className="h-8 w-full rounded-md border border-border bg-white px-2 text-[12px] focus:border-accent-red/50 focus:outline-none disabled:bg-bg-surface"
                  >
                    {data.quarries.map(quarry => (
                      <option key={quarry.id} value={quarry.id}>
                        {quarry.name} ({quarry.code})
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={row.distance_km ?? ''}
                    disabled={!canEdit}
                    onChange={e => updateRow(index, { distance_km: e.target.value === '' ? null : Number(e.target.value) })}
                    className="h-8 w-36 rounded-md border border-border bg-white px-2 text-[12px] focus:border-accent-red/50 focus:outline-none disabled:bg-bg-surface"
                    placeholder="например 12.5"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => deleteRow(index)}
                    disabled={!canEdit}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40"
                    title="Удалить строку"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={addRow}
          disabled={!canEdit || !firstFreeQuarry}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text-primary hover:border-accent-red/40 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить карьер
        </button>
        <SaveButton
          onClick={() => saveMut.mutate(draft)}
          disabled={!canEdit}
          loading={saveMut.isPending}
        />
      </div>
    </div>
  )
}

function selectedValues(event: React.ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.currentTarget.selectedOptions).map(option => option.value).filter(Boolean)
}

function optionLabelByCode(options: CompactionOption[], code: string): string {
  const option = options.find(item => item.code === code)
  return option ? `${option.name} · ${option.code}` : code
}

function selectedOptionSummary(values: string[], options: CompactionOption[], fallback: string): string {
  if (!values.length) return fallback
  return values.map(value => optionLabelByCode(options, value)).join(', ')
}

function selectedTextSummary(values: string[], fallback: string): string {
  return values.length ? values.join(', ') : fallback
}

function CompactionMultiSelect({
  label,
  summary,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string
  summary: string
  value: string[]
  disabled: boolean
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  children: ReactNode
}) {
  return (
    <label className="min-w-0 rounded-lg border border-border bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
        <span className="shrink-0 text-[10px] text-text-muted">Ctrl/Shift для выбора</span>
      </div>
      <div
        className="mb-2 max-h-16 overflow-auto rounded-md bg-bg-surface/70 px-2 py-1.5 text-[11px] leading-4 text-text-secondary"
        title={summary}
      >
        {summary}
      </div>
      <select
        multiple
        disabled={disabled}
        value={value}
        onChange={onChange}
        className="h-44 w-full rounded-md border border-border bg-white px-2 py-1.5 text-[12px] leading-5 text-text-primary disabled:bg-bg-surface"
      >
        {children}
      </select>
    </label>
  )
}

function CompactionCoefficientsBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<CompactionCoefficientsData>({
    queryKey: ['wip', 'settings', 'compaction-coefficients'],
    queryFn: () => fetchJson<CompactionCoefficientsData>('/api/wip/settings/compaction-coefficients'),
    staleTime: 60_000,
  })
  const [draft, setDraft] = useState<CompactionCoefficientRow[]>([])

  useEffect(() => {
    if (data) setDraft(data.rows || [])
  }, [data])

  const saveMut = useMutation({
    mutationFn: async (rows: CompactionCoefficientRow[]) => {
      const r = await fetch('/api/wip/settings/compaction-coefficients', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: 'Ошибка сохранения' }))
        throw new Error(e.detail || 'Ошибка сохранения')
      }
      return r.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'compaction-coefficients'] })
      qc.invalidateQueries({ queryKey: ['wip', 'generator'] })
    },
  })

  function updateRow(index: number, patch: Partial<CompactionCoefficientRow>) {
    setDraft(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  function addRow() {
    setDraft(prev => [...prev, {
      id: `new-${Date.now()}`,
      object_codes: [],
      object_type_codes: [],
      work_codes: [],
      tags: [],
      coefficient: 1,
      notes: '',
    }])
  }

  if (isLoading) return <div className="h-32 animate-pulse rounded-md bg-bg-surface" />
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(error)}</div>

  const objects = data?.objects ?? []
  const objectTypes = data?.object_types ?? []
  const works = data?.works ?? []
  const tags = data?.tags ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-text-muted">
          Вводится Купл как материал / работа (&gt;1): во сколько раз материала больше, чем объема работы. Контрольная формула: Vработы × Купл = Vматериала. В отчетах ДИМ, Общий и Мстрой рабочая строка считается как материал / Купл; строка материала остается как есть. Если совпадения нет — пересчета нет (Купл=1); справочные коэффициенты не используются.
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={addRow} disabled={!canEdit} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
          <SaveButton onClick={() => saveMut.mutate(draft)} disabled={!canEdit} loading={saveMut.isPending} />
        </div>
      </div>
      {draft.length === 0 ? (
        <div className="rounded-lg border border-border px-3 py-8 text-center text-[12px] text-text-muted">
          Строк пока нет. Добавьте Купл, если нужно применить коэффициент к отчетам.
        </div>
      ) : (
        <div className="space-y-3">
          {draft.map((row, index) => {
            const objectTypeSummary = selectedOptionSummary(row.object_type_codes, objectTypes, 'Все типы объектов')
            const objectSummary = selectedOptionSummary(row.object_codes, objects, 'Все объекты')
            const workSummary = selectedOptionSummary(row.work_codes, works, 'Все работы')
            const tagSummary = selectedTextSummary(row.tags, 'Все теги')
            return (
              <div key={row.id || index} className="rounded-xl border border-border bg-bg-surface/40 p-3 shadow-sm">
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Правило Купл №{index + 1}</div>
                    <div className="mt-1 text-[12px] text-text-secondary">
                      {objectTypeSummary}; {objectSummary}; {workSummary}; {tagSummary}
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[150px_minmax(260px,1fr)_40px] lg:w-[620px]">
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">Купл</span>
                      <input
                        type="number"
                        step="0.001"
                        min="1"
                        value={row.coefficient}
                        disabled={!canEdit}
                        onChange={event => updateRow(index, { coefficient: Number(event.target.value) })}
                        className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-mono text-[13px] disabled:bg-bg-surface"
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">Комментарий</span>
                      <input
                        type="text"
                        value={row.notes || ''}
                        disabled={!canEdit}
                        onChange={event => updateRow(index, { notes: event.target.value })}
                        className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-[13px] disabled:bg-bg-surface"
                        placeholder="для чего правило"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setDraft(prev => prev.filter((_, i) => i !== index))}
                      className="mt-4 inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:opacity-40 sm:mt-5"
                      title="Удалить"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <CompactionMultiSelect
                    label="Типы объектов"
                    summary={objectTypeSummary}
                    value={row.object_type_codes}
                    disabled={!canEdit}
                    onChange={event => updateRow(index, { object_type_codes: selectedValues(event) })}
                  >
                    {objectTypes.map(option => (
                      <option key={option.code} value={option.code}>{option.name} · {option.code}</option>
                    ))}
                  </CompactionMultiSelect>
                  <CompactionMultiSelect
                    label="Объекты"
                    summary={objectSummary}
                    value={row.object_codes}
                    disabled={!canEdit}
                    onChange={event => updateRow(index, { object_codes: selectedValues(event) })}
                  >
                    {objects.map(option => (
                      <option key={option.code} value={option.code}>{option.name} · {option.code}</option>
                    ))}
                  </CompactionMultiSelect>
                  <CompactionMultiSelect
                    label="Работы"
                    summary={workSummary}
                    value={row.work_codes}
                    disabled={!canEdit}
                    onChange={event => updateRow(index, { work_codes: selectedValues(event) })}
                  >
                    {works.map(option => (
                      <option key={option.code} value={option.code}>{option.name} · {option.code}</option>
                    ))}
                  </CompactionMultiSelect>
                  <CompactionMultiSelect
                    label="Теги"
                    summary={tagSummary}
                    value={row.tags}
                    disabled={!canEdit}
                    onChange={event => updateRow(index, { tags: selectedValues(event) })}
                  >
                    {tags.map(option => (
                      <option key={option.name} value={option.name}>{option.name}</option>
                    ))}
                  </CompactionMultiSelect>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


const DASHBOARD_INPUT_IMPORTS: Array<{
  kind: DashboardImportKind
  title: string
  description: string
  endpoint: string
}> = [
  {
    kind: 'people',
    title: 'Отчет по людям',
    description: 'Обновляет численность на вкладке Дашборд: итоги, участки и офисы с детализацией по должностям.',
    endpoint: '/api/wip/dashboard/people/import',
  },
  {
    kind: 'report_m',
    title: 'Отчет М',
    description: 'Обновляет срез техники для блока «Пульс техники» без записи работ и перевозок.',
    endpoint: '/api/wip/reports/mechanization-report-m/import',
  },
  {
    kind: 'equipment_operation',
    title: 'Сводная таблица техники',
    description: 'Импортирует лист «Сачков»: пробег, моточасы и расход топлива по справочнику техники.',
    endpoint: '/api/wip/reports/equipment-operation/import',
  },
  {
    kind: 'accommodation',
    title: 'Отчет по гостиницам',
    description: 'Обновляет вкладку «Размещение персонала»: гостиницы, квартиры, общежития и столовые.',
    endpoint: '/api/wip/reports/personnel-accommodation/import',
  },
]

function dashboardImportNumber(value: unknown): string {
  const numberValue = Number(value ?? 0)
  return Number.isFinite(numberValue) ? numberValue.toLocaleString('ru-RU') : '0'
}

function dashboardImportResultText(kind: DashboardImportKind, result: DashboardImportResponse): string {
  if (kind === 'people') {
    return [
      result.report_date ? `срез ${result.report_date}` : null,
      `устроено ${dashboardImportNumber(result.summary?.hired)}`,
      `должностей ${dashboardImportNumber(result.position_rows)}`,
    ].filter(Boolean).join(' · ')
  }
  if (kind === 'accommodation') {
    return [
      result.report_date ? `срез ${result.report_date}` : null,
      `строк ${dashboardImportNumber(result.row_count)}`,
      `размещено ${dashboardImportNumber(result.summary?.total_residents)}`,
    ].filter(Boolean).join(' · ')
  }
  if (kind === 'equipment_operation') {
    return [
      result.report_date ? `срез ${result.report_date}` : null,
      `строк ${dashboardImportNumber(result.metric_rows_inserted ?? result.row_count)}`,
      `топливо ${dashboardImportNumber(result.fuel_liters_total)} л`,
      `создано ${dashboardImportNumber(result.created_equipment_units)}`,
    ].filter(Boolean).join(' · ')
  }
  return [
    `отчетов ${dashboardImportNumber(result.count ?? result.reports?.length ?? 0)}`,
    `ед. техники ${dashboardImportNumber(result.total_equipment_units)}`,
  ].join(' · ')
}

function DashboardInputDataBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const inputRefs = {
    people: useRef<HTMLInputElement>(null),
    report_m: useRef<HTMLInputElement>(null),
    equipment_operation: useRef<HTMLInputElement>(null),
    accommodation: useRef<HTMLInputElement>(null),
  }
  const instructionInputRef = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState<Partial<Record<DashboardImportKind, DashboardImportResponse>>>({})
  const [instructionResult, setInstructionResult] = useState<DailyReportInstructionUploadResponse | null>(null)
  const [instructionError, setInstructionError] = useState<string | null>(null)
  const [instructionDownloading, setInstructionDownloading] = useState(false)

  const importMut = useMutation({
    mutationFn: async (input: { kind: DashboardImportKind; endpoint: string; file: File }) => {
      const fd = new FormData()
      fd.append('file', input.file)
      const res = await fetch(input.endpoint, { method: 'POST', body: fd })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка импорта' }))
        throw new Error(e.detail || 'Ошибка импорта')
      }
      return { kind: input.kind, data: await res.json() as DashboardImportResponse }
    },
    onSuccess: ({ kind, data }) => {
      setResults(prev => ({ ...prev, [kind]: data }))
      qc.invalidateQueries({ queryKey: ['wip', 'dashboard'] })
      qc.invalidateQueries({ queryKey: ['wip', 'dashboard', 'staff'] })
      qc.invalidateQueries({ queryKey: ['wip', 'overview', 'equipment-pulse'] })
      qc.invalidateQueries({ queryKey: ['wip', 'mechanization'] })
      qc.invalidateQueries({ queryKey: ['wip', 'mechanization-aggregates'] })
      qc.invalidateQueries({ queryKey: ['wip', 'mechanization-fuel-aggregates'] })
      qc.invalidateQueries({ queryKey: ['wip', 'personnel-accommodation'] })
      qc.invalidateQueries({ queryKey: ['reports-list'] })
    },
  })

  const instructionUploadMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/wip/settings/daily-report-review-instruction.docx', { method: 'POST', body: fd })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Ошибка загрузки инструкции' }))
        throw new Error(e.detail || 'Ошибка загрузки инструкции')
      }
      return await res.json() as DailyReportInstructionUploadResponse
    },
    onSuccess: data => {
      setInstructionResult(data)
      setInstructionError(null)
    },
  })

  function handleInstructionFile(file?: File | null) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.docx')) {
      instructionUploadMut.reset()
      setInstructionResult(null)
      setInstructionError('Загрузите файл инструкции в формате .docx')
      return
    }
    setInstructionError(null)
    instructionUploadMut.reset()
    instructionUploadMut.mutate(file)
  }

  async function handleInstructionDownload() {
    if (instructionDownloading) return
    setInstructionDownloading(true)
    try {
      const response = await fetch('/api/wip/settings/daily-report-review-instruction.docx')
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({})) as { detail?: string }
        throw new Error(errorBody.detail || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = 'Памятка по проверке сменного отчета при загрузке в дашборд.docx'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch (error) {
      window.alert(`Не удалось скачать файл: ${errorMessage(error)}`)
    } finally {
      setInstructionDownloading(false)
    }
  }

  function handleFile(kind: DashboardImportKind, endpoint: string, file?: File | null) {
    if (!file) return
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xlsm')) {
      setResults(prev => ({ ...prev, [kind]: { ok: false, source_filename: file.name } }))
      importMut.reset()
      return
    }
    importMut.mutate({ kind, endpoint, file })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg-surface p-4">
          <input
            ref={instructionInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={event => {
              handleInstructionFile(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-white text-accent-red">
              <BookOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 basis-72">
              <div className="text-sm font-heading font-semibold text-text-primary">Инструкция по сменным отчетам</div>
              <div className="mt-1 text-[12px] leading-relaxed text-text-muted">
                Загрузка новой Word-инструкции на сервер. После сохранения она используется в рассылке и при скачивании памятки.
              </div>
              {instructionResult?.ok ? (
                <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[12px] font-medium text-emerald-800">
                  Загружено: {instructionResult.source_filename || instructionResult.filename || 'инструкция'} · {Math.round((instructionResult.size_bytes || 0) / 1024)} КБ
                </div>
              ) : null}
              {instructionError || instructionUploadMut.error ? (
                <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[12px] text-accent-red">
                  {instructionError || errorMessage(instructionUploadMut.error)}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={instructionDownloading}
                onClick={handleInstructionDownload}
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-white px-4 text-xs font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
              >
                {instructionDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {instructionDownloading ? 'Скачиваю...' : 'Скачать текущую'}
              </button>
              <button
                type="button"
                disabled={!canEdit || instructionUploadMut.isPending}
                onClick={() => instructionInputRef.current?.click()}
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-white px-4 text-xs font-semibold text-text-primary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
              >
                {instructionUploadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {instructionUploadMut.isPending ? 'Загружаю...' : 'Загрузить DOCX'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {DASHBOARD_INPUT_IMPORTS.map(spec => {
          const isUploading = importMut.isPending && importMut.variables?.kind === spec.kind
          const result = results[spec.kind]
          return (
            <div key={spec.kind} className="rounded-lg border border-border bg-bg-surface p-4">
              <input
                ref={inputRefs[spec.kind]}
                type="file"
                accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
                className="hidden"
                onChange={event => {
                  handleFile(spec.kind, spec.endpoint, event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-white text-accent-red">
                  <FileSpreadsheet className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1 basis-72">
                  <div className="text-sm font-heading font-semibold text-text-primary">{spec.title}</div>
                  <div className="mt-1 text-[12px] leading-relaxed text-text-muted">{spec.description}</div>
                  {result && result.ok !== false ? (
                    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[12px] font-medium text-emerald-800">
                      Импортировано: {dashboardImportResultText(spec.kind, result)}
                    </div>
                  ) : result ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[12px] text-amber-800">
                      Загрузите файл .xlsx или .xlsm
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={!canEdit || isUploading}
                  onClick={() => inputRefs[spec.kind].current?.click()}
                  className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-white px-4 text-xs font-semibold text-text-primary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  {isUploading ? 'Загрузка...' : 'Загрузить XLSX'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {!canEdit ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Загрузка доступна пользователям с правом изменения настроек.
        </div>
      ) : null}
      {importMut.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
          {errorMessage(importMut.error)}
        </div>
      ) : null}
    </div>
  )
}

function sidebarDraftFromPayload(payload?: SidebarSettingsPayload | null): SidebarSettingsItem[] {
  return mergeSidebarSettings(payload?.items)
}

function SidebarSettingsBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<SidebarSettingsPayload>({
    queryKey: ['wip', 'settings', 'sidebar'],
    queryFn: () => fetchJson<SidebarSettingsPayload>('/api/wip/settings/sidebar'),
    staleTime: 60_000,
  })
  const [draft, setDraft] = useState<SidebarSettingsItem[]>(() => sidebarDraftFromPayload(null))

  useEffect(() => {
    setDraft(sidebarDraftFromPayload(data))
  }, [data])

  const saveMut = useMutation({
    mutationFn: async () => fetchJson<SidebarSettingsPayload>('/api/wip/settings/sidebar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: draft.map(item => ({ path: item.path, enabled: item.path === '/settings' ? true : item.enabled })) }),
    }),
    onSuccess: saved => {
      setDraft(sidebarDraftFromPayload(saved))
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'sidebar'] })
    },
  })

  const savedDraft = sidebarDraftFromPayload(data)
  const dirty = JSON.stringify(draft.map(item => ({ path: item.path, enabled: item.enabled }))) !== JSON.stringify(savedDraft.map(item => ({ path: item.path, enabled: item.enabled })))

  function move(path: string, direction: -1 | 1) {
    setDraft(prev => {
      const index = prev.findIndex(item => item.path === path)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return next.map((row, rowIndex) => ({ ...row, sort_order: rowIndex }))
    })
  }

  function toggle(path: string) {
    if (path === '/settings') return
    setDraft(prev => prev.map(item => item.path === path ? { ...item, enabled: !item.enabled } : item))
  }

  function resetDefault() {
    setDraft(SIDEBAR_NAV_ITEMS.map((item, index) => ({ path: item.to, enabled: true, sort_order: index, fixed: item.to === '/settings' })))
  }

  if (isLoading) return <div className="h-44 animate-pulse rounded-md bg-bg-surface" />
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">Не удалось загрузить настройки сайдбара: {errorMessage(error)}</div>

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-text-muted">
          В меню показываются включенные здесь страницы, если у пользователя есть доступ к ним.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canEdit || saveMut.isPending}
            onClick={resetDefault}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-[12px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Сбросить
          </button>
          <button
            type="button"
            disabled={!canEdit || !dirty || saveMut.isPending}
            onClick={() => saveMut.mutate()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-red px-3 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" /> {saveMut.isPending ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="grid grid-cols-[88px_minmax(0,1fr)_120px] gap-2 border-b border-border bg-bg-surface px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted sm:grid-cols-[96px_minmax(0,1fr)_minmax(150px,220px)_120px]">
          <div>Порядок</div>
          <div>Вкладка</div>
          <div className="hidden sm:block">Путь</div>
          <div className="text-right">В меню</div>
        </div>
        <div className="divide-y divide-border">
          {draft.map((item, index) => {
            const nav = SIDEBAR_NAV_ITEM_BY_PATH.get(item.path)
            if (!nav) return null
            const Icon = nav.icon
            const fixed = item.path === '/settings' || item.fixed
            return (
              <div key={item.path} className={`grid grid-cols-[88px_minmax(0,1fr)_120px] items-center gap-2 px-3 py-2 text-sm sm:grid-cols-[96px_minmax(0,1fr)_minmax(150px,220px)_120px] ${item.enabled ? 'bg-white' : 'bg-neutral-50 text-text-muted'}`}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title="Поднять"
                    disabled={!canEdit || index === 0 || saveMut.isPending}
                    onClick={() => move(item.path, -1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-white text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Опустить"
                    disabled={!canEdit || index === draft.length - 1 || saveMut.isPending}
                    onClick={() => move(item.path, 1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-white text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className={`h-4 w-4 shrink-0 ${item.enabled ? 'text-accent-red' : 'text-text-muted'}`} />
                  <span className="min-w-0 truncate font-medium text-text-primary" title={nav.label}>{nav.label}</span>
                  {fixed ? <span className="rounded bg-bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">всегда</span> : null}
                </div>
                <div className="hidden truncate font-mono text-[12px] text-text-muted sm:block" title={item.path}>{item.path}</div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    title={item.enabled ? 'Скрыть из меню' : 'Показать в меню'}
                    disabled={!canEdit || fixed || saveMut.isPending}
                    onClick={() => toggle(item.path)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${item.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-border bg-white text-text-muted hover:border-accent-red/40 hover:text-accent-red'}`}
                  >
                    {item.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    {item.enabled ? 'Есть' : 'Скрыта'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {data?.updated_at ? (
        <div className="text-[11px] text-text-muted">
          Обновлено: {new Date(data.updated_at).toLocaleString('ru-RU')}{data.updated_by ? `, ${data.updated_by}` : ''}
        </div>
      ) : null}
      {saveMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-accent-red">{errorMessage(saveMut.error)}</div> : null}
    </div>
  )
}

const ACCESS_PERMISSION_LABELS: Record<string, string> = {
  'settings:write': 'Изменение настроек',
  'reports:review': 'Проверка отчетов',
  'reports:edit': 'Редактирование отчетов',
  'reports:input': 'Ввод отчетов',
  'pile:control': 'Контроль свай',
  'pile:input': 'Ввод свай',
  'statements:project:write': 'Редактирование проектных данных в ведомостях',
}

const USER_ACCESS_VIEW_REPORT_PATHS = ['/', '/map', '/analytics', '/section-rating', '/mechanization', '/personnel-accommodation', '/reinforcement', '/zem-polotno', '/structural-schemes', '/reports']

function defaultPagesForRole(role: UserAccessRow['role'], pageLabels: Record<string, string>): string[] {
  const available = Object.keys(pageLabels)
  if (role === 'admin') return available
  return USER_ACCESS_VIEW_REPORT_PATHS.filter(path => available.includes(path))
}

function defaultPermissionsForRole(role: UserAccessRow['role'], knownPermissions: string[]): string[] {
  if (role === 'admin') return [...knownPermissions]
  return ['reports:input'].filter(permission => knownPermissions.includes(permission))
}

function UserAccessBlock() {
  const { data, isLoading, isError, error } = useQuery<UserAccessData>({
    queryKey: ['auth', 'users-access'],
    queryFn: () => fetchJson<UserAccessData>('/api/auth/users-access'),
    staleTime: 60_000,
  })
  const rows = data?.rows ?? []
  const knownPermissions = data?.known_permissions?.length ? data.known_permissions : Object.keys(ACCESS_PERMISSION_LABELS)

  if (isLoading) return <div className="h-44 animate-pulse rounded-md bg-bg-surface" />
  if (isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
        Не удалось загрузить доступы: {errorMessage(error)}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-bg-surface px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted"><ShieldCheck className="h-3.5 w-3.5" />Всего учеток</div>
          <div className="mt-1 font-heading text-2xl font-bold text-text-primary">{rows.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-surface px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted"><ShieldCheck className="h-3.5 w-3.5" />Администраторы</div>
          <div className="mt-1 font-heading text-2xl font-bold text-text-primary">{rows.filter(row => row.role === 'admin').length}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-surface px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted"><KeyRound className="h-3.5 w-3.5" />Редактирование</div>
          <div className="mt-1 text-xs font-medium text-text-secondary">Изменения сохраняются в persistent JSON и применяются после обновления сессии.</div>
        </div>
      </div>

      <UserAccessCreatePanel pageLabels={data?.page_labels ?? {}} knownPermissions={knownPermissions} />

      <div className="space-y-3">
        {rows.map(row => (
          <UserAccessEditableRow key={row.username} row={row} pageLabels={data?.page_labels ?? {}} knownPermissions={knownPermissions} />
        ))}
      </div>
    </div>
  )
}

function UserAccessCreatePanel({
  pageLabels,
  knownPermissions,
}: {
  pageLabels: Record<string, string>
  knownPermissions: string[]
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState({
    username: '',
    role: 'user' as UserAccessRow['role'],
    pages: defaultPagesForRole('user', pageLabels),
    permissions: defaultPermissionsForRole('user', knownPermissions),
  })
  const [created, setCreated] = useState<UserAccessRow | null>(null)
  const pageEntries = Object.entries(pageLabels)

  useEffect(() => {
    setDraft(prev => ({
      ...prev,
      pages: prev.pages.length ? prev.pages.filter(path => path in pageLabels) : defaultPagesForRole(prev.role, pageLabels),
      permissions: prev.permissions.filter(permission => knownPermissions.includes(permission)),
    }))
  }, [knownPermissions, pageLabels])

  const createMut = useMutation({
    mutationFn: async () => fetchJson<UserAccessRow>('/api/auth/users-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: draft.username.trim(),
        role: draft.role,
        pages: draft.pages,
        permissions: draft.permissions,
      }),
    }),
    onSuccess: row => {
      setCreated(row)
      setDraft(prev => ({ ...prev, username: '' }))
      qc.invalidateQueries({ queryKey: ['auth', 'users-access'] })
    },
  })

  function changeRole(role: UserAccessRow['role']) {
    setDraft(prev => ({
      ...prev,
      role,
      pages: defaultPagesForRole(role, pageLabels),
      permissions: defaultPermissionsForRole(role, knownPermissions),
    }))
  }

  function togglePage(path: string) {
    setDraft(prev => ({
      ...prev,
      pages: prev.pages.includes(path) ? prev.pages.filter(item => item !== path) : [...prev.pages, path],
    }))
  }

  function togglePermission(permission: string) {
    setDraft(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permission) ? prev.permissions.filter(item => item !== permission) : [...prev.permissions, permission],
    }))
  }

  return (
    <div className="rounded-xl border border-accent-red/20 bg-white p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-heading font-bold text-text-primary"><Plus className="h-4 w-4 text-accent-red" />Новая учетная запись</div>
          <div className="mt-1 text-[11px] text-text-muted">Пароль создается автоматически и сохраняется вместе с учеткой.</div>
        </div>
        <button
          type="button"
          disabled={!draft.username.trim() || createMut.isPending}
          onClick={() => createMut.mutate()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent-red px-3 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> {createMut.isPending ? 'Создаем...' : 'Создать'}
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(180px,1fr)_140px]">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-muted">Логин</span>
          <input
            value={draft.username}
            onChange={event => setDraft(prev => ({ ...prev, username: event.target.value }))}
            placeholder="new_user"
            className="h-9 w-full rounded-md border border-border bg-white px-2 font-mono text-[12px] text-text-primary"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-muted">Роль</span>
          <select value={draft.role} onChange={event => changeRole(event.target.value as UserAccessRow['role'])} className="h-9 w-full rounded-md border border-border bg-white px-2 text-[12px] text-text-primary">
            <option value="admin">admin</option>
            <option value="user">user</option>
          </select>
        </label>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Страницы</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, pages: Object.keys(pageLabels) }))} className="text-[10px] font-semibold text-accent-red hover:underline">Все</button>
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, pages: [] }))} className="text-[10px] font-semibold text-text-muted hover:underline">Очистить</button>
              <span className="text-[10px] text-text-muted">{draft.pages.length} выбрано</span>
            </div>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {pageEntries.map(([path, label]) => (
              <label key={path} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-[11px] text-text-secondary hover:border-accent-red/30">
                <input type="checkbox" checked={draft.pages.includes(path)} onChange={() => togglePage(path)} />
                <span className="min-w-0 truncate" title={`${label} (${path})`}>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Права</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, permissions: [...knownPermissions] }))} className="text-[10px] font-semibold text-accent-red hover:underline">Все</button>
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, permissions: [] }))} className="text-[10px] font-semibold text-text-muted hover:underline">Очистить</button>
              <span className="text-[10px] text-text-muted">{draft.permissions.length} выбрано</span>
            </div>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {knownPermissions.map(permission => (
              <label key={permission} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-[11px] text-text-secondary hover:border-accent-red/30">
                <input type="checkbox" checked={draft.permissions.includes(permission)} onChange={() => togglePermission(permission)} />
                <span className="min-w-0 truncate" title={permission}>{ACCESS_PERMISSION_LABELS[permission] || permission}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {created ? (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          Создан пользователь <span className="font-mono font-semibold">{created.username}</span>. Пароль: <code className="rounded bg-white px-2 py-1 font-mono text-[11px] text-text-primary">{created.password}</code>
        </div>
      ) : null}
      {createMut.error ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-accent-red">{errorMessage(createMut.error)}</div> : null}
    </div>
  )
}


function UserAccessEditableRow({
  row,
  pageLabels,
  knownPermissions,
}: {
  row: UserAccessRow
  pageLabels: Record<string, string>
  knownPermissions: string[]
}) {
  const qc = useQueryClient()
  const { user, refreshUser } = useAuth()
  const [draft, setDraft] = useState({ role: row.role, pages: row.pages, permissions: row.permissions })
  useEffect(() => {
    setDraft({ role: row.role, pages: row.pages, permissions: row.permissions })
  }, [row])

  const saveMut = useMutation({
    mutationFn: async () => fetchJson<UserAccessRow>(`/api/auth/users-access/${encodeURIComponent(row.username)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }),
    onSuccess: saved => {
      setDraft({ role: saved.role, pages: saved.pages, permissions: saved.permissions })
      qc.setQueryData<UserAccessData>(['auth', 'users-access'], old => old
        ? { ...old, rows: old.rows.map(item => item.username === saved.username ? saved : item) }
        : old)
      qc.invalidateQueries({ queryKey: ['auth', 'users-access'] })
      if (saved.username === user?.username) void refreshUser()
    },
  })

  const dirty = draft.role !== row.role || draft.pages.join('|') !== row.pages.join('|') || draft.permissions.join('|') !== row.permissions.join('|')
  const pageEntries = Object.entries(pageLabels)

  function togglePage(path: string) {
    setDraft(prev => ({
      ...prev,
      pages: prev.pages.includes(path) ? prev.pages.filter(item => item !== path) : [...prev.pages, path],
    }))
  }
  function togglePermission(permission: string) {
    setDraft(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permission) ? prev.permissions.filter(item => item !== permission) : [...prev.permissions, permission],
    }))
  }

  return (
    <div className="rounded-xl border border-border bg-white p-3 shadow-sm">
      <div className="grid gap-3 lg:grid-cols-[minmax(180px,260px)_150px_1fr_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-text-primary">{row.username}</span>
            {row.override ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">override</span> : null}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-text-muted">Пароль</div>
          <code className="mt-0.5 inline-block rounded bg-bg-surface px-2 py-1 font-mono text-[11px] text-text-primary">{row.password}</code>
        </div>

        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-muted">Роль</span>
          <select value={draft.role} onChange={event => setDraft(prev => ({ ...prev, role: event.target.value as UserAccessRow['role'] }))} className="h-9 w-full rounded-md border border-border bg-white px-2 text-[12px] text-text-primary">
            <option value="admin">admin</option>
            <option value="user">user</option>
          </select>
        </label>

        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Источник</div>
          <div className="rounded-md border border-border bg-bg-surface px-2 py-2 font-mono text-[11px] text-text-secondary">{row.source}</div>
        </div>

        <div className="flex items-end justify-start lg:justify-end">
          <button type="button" disabled={!dirty || saveMut.isPending} onClick={() => saveMut.mutate()} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent-red px-3 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
            <Save className="h-3.5 w-3.5" /> {saveMut.isPending ? '...' : 'Сохранить'}
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Страницы</div>
            <div className="text-[10px] text-text-muted">{draft.pages.length} выбрано</div>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {pageEntries.map(([path, label]) => (
              <label key={path} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-[11px] text-text-secondary hover:border-accent-red/30">
                <input type="checkbox" checked={draft.pages.includes(path)} onChange={() => togglePage(path)} />
                <span className="min-w-0 truncate" title={`${label} (${path})`}>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Права</div>
            <div className="text-[10px] text-text-muted">{draft.permissions.length} выбрано</div>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {knownPermissions.map(permission => (
              <label key={permission} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-[11px] text-text-secondary hover:border-accent-red/30">
                <input type="checkbox" checked={draft.permissions.includes(permission)} onChange={() => togglePermission(permission)} />
                <span className="min-w-0 truncate" title={permission}>{ACCESS_PERMISSION_LABELS[permission] || permission}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      {saveMut.error ? <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-accent-red">{errorMessage(saveMut.error)}</div> : null}
    </div>
  )
}


function newAnnouncementItem(index = 0): DashboardAnnouncementItem {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `announcement-${Date.now()}-${index}`,
    enabled: false,
    title: '',
    message: '',
    tone: 'info',
    target_paths: [],
  }
}

function announcementSettingsDraft(data?: DashboardAnnouncementSettings): DashboardAnnouncementSettings {
  return {
    items: (data?.items || []).map((item, index) => ({
      id: item.id || `announcement-${index + 1}`,
      enabled: Boolean(item.enabled),
      title: item.title || '',
      message: item.message || '',
      tone: item.tone || 'info',
      target_paths: Array.isArray(item.target_paths) ? item.target_paths.slice(0, 1) : [],
    })),
    updated_by: data?.updated_by,
    updated_at: data?.updated_at,
  }
}

function AnnouncementBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<DashboardAnnouncementSettings>({
    queryKey: ['wip', 'settings', 'announcement'],
    queryFn: () => fetchJson<DashboardAnnouncementSettings>('/api/wip/settings/announcement'),
    staleTime: 30_000,
  })
  const [draft, setDraft] = useState<DashboardAnnouncementSettings>({ items: [] })
  useEffect(() => {
    if (data) setDraft(announcementSettingsDraft(data))
  }, [data])
  const saveMut = useMutation({
    mutationFn: async () => fetchJson<DashboardAnnouncementSettings>('/api/wip/settings/announcement', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: draft.items }),
    }),
    onSuccess: saved => {
      setDraft(announcementSettingsDraft(saved))
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'announcement'] })
      qc.invalidateQueries({ queryKey: ['wip', 'announcement', 'active'] })
    },
  })

  function updateItem(index: number, patch: Partial<DashboardAnnouncementItem>) {
    setDraft(prev => ({
      ...prev,
      items: prev.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }

  if (isLoading) return <div className="h-36 animate-pulse rounded-md bg-bg-surface" />
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">Не удалось загрузить оповещение: {errorMessage(error)}</div>

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-text-muted">
          {data?.updated_at ? <>Обновил {data.updated_by || '—'} · {String(data.updated_at).slice(0, 16).replace('T', ' ')}</> : 'Изменений пока нет'}
        </div>
        <button type="button" onClick={() => setDraft(prev => ({ ...prev, items: [...prev.items, newAnnouncementItem(prev.items.length)] }))} disabled={!canEdit} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-semibold text-text-secondary hover:border-accent-red/50 hover:text-accent-red disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" />Добавить
        </button>
      </div>
      {draft.items.length === 0 ? <div className="border-y border-border px-3 py-5 text-center text-sm text-text-muted">Оповещений нет</div> : null}
      <div className="divide-y divide-border border-y border-border">
        {draft.items.map((item, index) => {
          const selectedPath = item.target_paths[0] || '*'
          return (
            <div key={item.id} className="grid gap-3 py-3 lg:grid-cols-[240px_minmax(0,1fr)_36px]">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <input type="checkbox" checked={item.enabled} disabled={!canEdit} onChange={event => updateItem(index, { enabled: event.target.checked })} />
                  Показывать
                </label>
                <label className="block text-xs text-text-muted">
                  Вкладка
                  <select value={selectedPath} disabled={!canEdit} onChange={event => updateItem(index, { target_paths: event.target.value === '*' ? [] : [event.target.value] })} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                    <option value="*">Все вкладки</option>
                    {SIDEBAR_NAV_ITEMS.map(option => <option key={option.to} value={option.to}>{option.label}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-text-muted">
                  Тон
                  <select value={item.tone} disabled={!canEdit} onChange={event => updateItem(index, { tone: event.target.value as DashboardAnnouncementItem['tone'] })} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                    <option value="info">Информация</option>
                    <option value="warning">Предупреждение</option>
                    <option value="critical">Критично</option>
                    <option value="success">Готово</option>
                  </select>
                </label>
              </div>
              <div className="space-y-2">
                <input value={item.title} disabled={!canEdit} onChange={event => updateItem(index, { title: event.target.value })} className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:bg-bg-surface" placeholder="Заголовок оповещения" />
                <textarea value={item.message} disabled={!canEdit} onChange={event => updateItem(index, { message: event.target.value })} rows={5} className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:bg-bg-surface" placeholder="Текст оповещения" />
              </div>
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, items: prev.items.filter((_, itemIndex) => itemIndex !== index) }))} disabled={!canEdit} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-text-muted hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-40" title="Удалить оповещение">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-text-muted"><Megaphone className="h-4 w-4" /> Активные оповещения показываются над выбранными вкладками.</div>
        <SaveButton onClick={() => saveMut.mutate()} disabled={!canEdit} loading={saveMut.isPending} />
      </div>
      {saveMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(saveMut.error)}</div> : null}
    </div>
  )
}

function DailyReportEmailSettingsBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<DailyReportEmailSettings>({
    queryKey: ['wip', 'settings', 'daily-report-email'],
    queryFn: () => fetchJson<DailyReportEmailSettings>('/api/wip/settings/daily-report-email'),
    staleTime: 30_000,
  })
  const [draft, setDraft] = useState<DailyReportEmailDraft>({
    enabled: false,
    send_time_local: '07:00',
    groups: [newDailyReportEmailGroup(0)],
  })
  const [reportModal, setReportModal] = useState<{ groupId: string; reportKey: string } | null>(null)
  const [sendStatusTick, setSendStatusTick] = useState(0)
  const [sendUseCache, setSendUseCache] = useState(false)
  useEffect(() => {
    if (!data) return
    const groups = data.groups?.length ? data.groups.map(emailGroupToDraft) : [newDailyReportEmailGroup(0)]
    setDraft({
      enabled: Boolean(data.enabled),
      send_time_local: data.send_time_local || '07:00',
      groups,
    })
  }, [data])

  const fileOptions = data?.file_options ?? []
  const fileOptionByKey = useMemo(() => new Map(fileOptions.map(option => [option.key, option])), [fileOptions])
  const recipientsCount = draft.groups.reduce((sum, group) => sum + emailTextToList(group.recipientsText).length, 0)
  const activeGroupsCount = draft.groups.filter(group => group.enabled).length
  const selectedCacheReusableFileCount = useMemo(() => {
    const keys = new Set<string>()
    for (const group of draft.groups) {
      if (!group.enabled) continue
      for (const reportKey of group.report_keys) {
        const option = fileOptionByKey.get(reportKey)
        if (option?.kind === 'generator' && option.supports_cache_reuse) {
          keys.add(reportKey)
        }
      }
    }
    return keys.size
  }, [draft.groups, fileOptionByKey])
  const sendUseCacheEffective = sendUseCache && selectedCacheReusableFileCount > 0
  useEffect(() => {
    if (selectedCacheReusableFileCount === 0 && sendUseCache) {
      setSendUseCache(false)
    }
  }, [selectedCacheReusableFileCount, sendUseCache])
  const modalGroup = reportModal ? draft.groups.find(group => group.id === reportModal.groupId) : null
  const modalOption = reportModal ? fileOptionByKey.get(reportModal.reportKey) : null
  const modalBaseConfig = modalGroup && reportModal
    ? (modalGroup.report_configs?.[reportModal.reportKey] || defaultDailyReportEmailReportConfig(modalOption))
    : defaultDailyReportEmailReportConfig(modalOption)
  const modalConfig = modalBaseConfig
  const sendStatusQueryKey = ['wip', 'settings', 'daily-report-email', 'send-status'] as const

  function buildDailyReportEmailPayload(options: { cacheReuseOverride?: boolean } = {}) {
    const cacheReuseOverride = options.cacheReuseOverride
    return {
      enabled: draft.enabled,
      send_time_local: draft.send_time_local || '07:00',
      groups: draft.groups.map(group => {
        const payload = emailDraftGroupToPayload(group)
        if (typeof cacheReuseOverride !== 'boolean') {
          return payload
        }
        const reportConfigs = { ...(payload.report_configs || {}) }
        for (const reportKey of payload.report_keys || []) {
          const option = fileOptionByKey.get(reportKey)
          if (option?.kind === 'generator' && option.supports_cache_reuse) {
            reportConfigs[reportKey] = {
              ...(reportConfigs[reportKey] || defaultDailyReportEmailReportConfig(option)),
              use_cache: cacheReuseOverride,
            }
          }
        }
        return { ...payload, report_configs: reportConfigs }
      }),
    }
  }

  function updateGroup(groupId: string, updater: (group: DailyReportEmailGroupDraft) => DailyReportEmailGroupDraft) {
    setDraft(prev => ({
      ...prev,
      groups: prev.groups.map(group => group.id === groupId ? updater(group) : group),
    }))
  }

  function addGroup() {
    const nextIndex = draft.groups.length
    const group = newDailyReportEmailGroup(nextIndex)
    setDraft(prev => ({ ...prev, groups: [...prev.groups, group] }))
  }

  function removeGroup(groupId: string) {
    setDraft(prev => {
      const groups = prev.groups.filter(group => group.id !== groupId)
      return { ...prev, groups: groups.length ? groups : [newDailyReportEmailGroup(0)] }
    })
    setReportModal(current => current?.groupId === groupId ? null : current)
  }

  function toggleGroupFile(groupId: string, reportKey: string, option?: DailyReportEmailFileOption) {
    updateGroup(groupId, group => {
      const selected = group.report_keys.includes(reportKey)
      const nextConfigs = { ...(group.report_configs || {}) }
      if (selected) {
        delete nextConfigs[reportKey]
      } else if ((option || fileOptionByKey.get(reportKey))?.kind === 'generator') {
        const effectiveOption = option || fileOptionByKey.get(reportKey)
        nextConfigs[reportKey] = nextConfigs[reportKey] || defaultDailyReportEmailReportConfig(effectiveOption)
      }
      return {
        ...group,
        report_keys: selected
          ? group.report_keys.filter(key => key !== reportKey)
          : [...group.report_keys, reportKey],
        report_configs: nextConfigs,
      }
    })
  }

  function selectAllGroupFiles(groupId: string) {
    updateGroup(groupId, group => {
      const nextConfigs = { ...(group.report_configs || {}) }
      for (const option of fileOptions) {
        if (option.kind === 'generator') {
          nextConfigs[option.key] = nextConfigs[option.key] || defaultDailyReportEmailReportConfig(option)
        }
      }
      return { ...group, report_keys: fileOptions.map(option => option.key), report_configs: nextConfigs }
    })
  }

  function handleFileCardClick(groupId: string, option: DailyReportEmailFileOption) {
    if (!canEdit) return
    const group = draft.groups.find(item => item.id === groupId)
    const selected = Boolean(group?.report_keys.includes(option.key))
    if (option.kind === 'generator') {
      if (!selected) {
        toggleGroupFile(groupId, option.key, option)
      }
      setReportModal({ groupId, reportKey: option.key })
      return
    }
    toggleGroupFile(groupId, option.key, option)
  }

  function updateReportConfig(groupId: string, reportKey: string, patch: Partial<DailyReportEmailReportConfig>) {
    const option = fileOptionByKey.get(reportKey)
    updateGroup(groupId, group => ({
      ...group,
      report_configs: {
        ...(group.report_configs || {}),
        [reportKey]: {
          ...(group.report_configs?.[reportKey] || defaultDailyReportEmailReportConfig(option)),
          ...patch,
        },
      },
    }))
  }

  function setReportDateMode(groupId: string, reportKey: string, option: DailyReportEmailFileOption, mode: DailyReportEmailReportConfig['date_mode']) {
    if (mode === 'day_before_send') {
      updateReportConfig(groupId, reportKey, { date_mode: 'day_before_send', date: null, date_from: null })
      return
    }
    const current = draft.groups.find(group => group.id === groupId)?.report_configs?.[reportKey] || defaultDailyReportEmailReportConfig(option)
    const fallback = defaultDailyReportEmailReportDate()
    const dateTo = current.date || fallback
    updateReportConfig(groupId, reportKey, {
      date_mode: 'custom',
      date: dateTo,
      date_from: option.period_mode === 'range' ? (current.date_from || defaultDailyReportEmailRangeStart(dateTo)) : null,
    })
  }

  const saveMut = useMutation({
    mutationFn: async () => fetchJson<DailyReportEmailSettings>('/api/wip/settings/daily-report-email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDailyReportEmailPayload({ cacheReuseOverride: false })),
    }),
    onSuccess: saved => {
      const groups = saved.groups?.length ? saved.groups.map(emailGroupToDraft) : [newDailyReportEmailGroup(0)]
      setDraft({
        enabled: Boolean(saved.enabled),
        send_time_local: saved.send_time_local || '07:00',
        groups,
      })
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'daily-report-email'] })
    },
  })

  const sendMut = useMutation({
    mutationFn: async ({ useCache }: { useCache: boolean }) => fetchJson<DailyReportEmailSendResponse>('/api/wip/settings/daily-report-email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDailyReportEmailPayload({ cacheReuseOverride: useCache })),
    }),
    onMutate: () => {
      qc.setQueryData<DailyReportEmailSendStatus>(sendStatusQueryKey, {
        status: 'running',
        running: true,
        stage: 'queued',
        stage_label: 'Подготовка рассылки',
        message: 'Рассылка запускается',
        progress_percent: 0,
        elapsed_seconds: 0,
        eta_seconds: null,
        estimated_total_seconds: null,
      })
    },
    onSuccess: sent => {
      if (sent.status) qc.setQueryData<DailyReportEmailSendStatus>(sendStatusQueryKey, sent.status)
      qc.invalidateQueries({ queryKey: sendStatusQueryKey })
    },
  })
  const sendStatusQuery = useQuery<DailyReportEmailSendStatus>({
    queryKey: sendStatusQueryKey,
    queryFn: () => fetchJson<DailyReportEmailSendStatus>('/api/wip/settings/daily-report-email/send-status'),
    staleTime: 1000,
    refetchInterval: query => query.state.data?.running ? 2000 : false,
    refetchIntervalInBackground: true,
  })
  const liveSendStatus = sendStatusQuery.data ?? sendMut.data?.status ?? qc.getQueryData<DailyReportEmailSendStatus>(sendStatusQueryKey)
  useEffect(() => {
    if (!liveSendStatus?.running) return undefined
    const timer = window.setInterval(() => setSendStatusTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [liveSendStatus?.running])
  const displaySendStatus = useMemo(() => smoothDailyReportEmailStatus(liveSendStatus), [liveSendStatus, sendStatusTick])
  const sendRunning = sendMut.isPending || Boolean(displaySendStatus?.running)

  if (isLoading) return <div className="h-48 animate-pulse rounded-md bg-bg-surface" />
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">Не удалось загрузить рассылку: {errorMessage(error)}</div>

  return (
    <div className="space-y-4">
      <div className="max-w-[360px] rounded-lg border border-border bg-bg-surface p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <input type="checkbox" checked={draft.enabled} disabled={!canEdit} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
            Включить рассылку
          </label>
          <label className="mt-3 block text-xs text-text-muted">
            Время отправки
            <input
              type="time"
              value={draft.send_time_local}
              disabled={!canEdit}
              onChange={event => setDraft(prev => ({ ...prev, send_time_local: event.target.value }))}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-text-primary disabled:bg-bg-surface"
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md border border-border bg-white px-2 py-1.5">
              <div className="font-semibold text-text-primary">{activeGroupsCount}</div>
              <div className="text-text-muted">активных групп</div>
            </div>
            <div className="rounded-md border border-border bg-white px-2 py-1.5">
              <div className="font-semibold text-text-primary">{recipientsCount}</div>
              <div className="text-text-muted">получателей</div>
            </div>
          </div>
          {data?.updated_at ? <div className="mt-3 text-[11px] text-text-muted">Обновил {data.updated_by || '—'} · {String(data.updated_at).slice(0, 16).replace('T', ' ')}</div> : null}
      </div>

      <div className="space-y-3">
        {draft.groups.map((group, index) => (
          <div key={group.id} className="rounded-lg border border-border bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <input type="checkbox" checked={group.enabled} disabled={!canEdit} onChange={event => updateGroup(group.id, item => ({ ...item, enabled: event.target.checked }))} />
                Группа
              </label>
              <input
                value={group.name}
                disabled={!canEdit}
                onChange={event => updateGroup(group.id, item => ({ ...item, name: event.target.value }))}
                className="min-w-[220px] flex-1 rounded-md border border-border px-3 py-1.5 text-sm font-semibold text-text-primary disabled:bg-bg-surface"
                placeholder={`Группа ${index + 1}`}
              />
              <span className="rounded-md bg-bg-surface px-2 py-1 text-[11px] text-text-muted">{emailTextToList(group.recipientsText).length} адресов</span>
              <span className="rounded-md bg-bg-surface px-2 py-1 text-[11px] text-text-muted">{group.report_keys.length} файлов</span>
              <button
                type="button"
                onClick={() => removeGroup(group.id)}
                disabled={!canEdit || draft.groups.length <= 1}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-50 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="Удалить группу"
                title="Удалить группу"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="space-y-3">
                <label className="block text-xs text-text-muted">
                  Получатели
                  <textarea
                    value={group.recipientsText}
                    disabled={!canEdit}
                    onChange={event => updateGroup(group.id, item => ({ ...item, recipientsText: event.target.value }))}
                    rows={4}
                    className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                    placeholder="mail@example.ru"
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block text-xs text-text-muted">
                    Копия
                    <textarea
                      value={group.ccText}
                      disabled={!canEdit}
                      onChange={event => updateGroup(group.id, item => ({ ...item, ccText: event.target.value }))}
                      rows={3}
                      className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                      placeholder="cc@example.ru"
                    />
                  </label>
                  <label className="block text-xs text-text-muted md:col-span-2">
                    Текст письма
                    <textarea
                      value={dailyReportEmailMessageBody(group, fileOptionByKey)}
                      readOnly
                      rows={6}
                      className="mt-1 w-full rounded-md border border-border bg-bg-surface/60 px-3 py-2 text-sm text-text-primary"
                    />
                  </label>
                </div>
                <label className="block text-xs text-text-muted">
                  Префикс темы
                  <input
                    value={group.subject_prefix}
                    disabled={!canEdit}
                    onChange={event => updateGroup(group.id, item => ({ ...item, subject_prefix: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                    placeholder="VSM: ежедневные отчеты"
                  />
                </label>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-text-primary">Файлы для отправки</div>
                  <button
                    type="button"
                    onClick={() => selectAllGroupFiles(group.id)}
                    disabled={!canEdit || fileOptions.length === 0}
                    className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-text-muted hover:text-text-primary disabled:opacity-40"
                  >
                    Выбрать все
                  </button>
                </div>
                <div className="grid max-h-80 gap-2 overflow-auto pr-1 md:grid-cols-2">
                  {fileOptions.map(option => {
                    const checked = group.report_keys.includes(option.key)
                    const baseConfig = group.report_configs?.[option.key] || defaultDailyReportEmailReportConfig(option)
                    const config = baseConfig
                    const Icon = option.file_type === 'pdf' || option.file_type === 'docx' ? FileText : FileSpreadsheet
                    const dateText = dailyReportEmailDateSummary(option, config)
                    return (
                      <div
                        key={option.key}
                        role="button"
                        tabIndex={canEdit ? 0 : -1}
                        onClick={() => handleFileCardClick(group.id, option)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleFileCardClick(group.id, option)
                          }
                        }}
                        className={`flex min-w-0 cursor-pointer gap-2 rounded-md border px-2 py-2 text-[11px] ${checked ? 'border-accent-red/40 bg-red-50/50' : 'border-border bg-bg-surface/40 hover:border-accent-red/30'} ${canEdit ? '' : 'cursor-not-allowed opacity-60'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!canEdit}
                          onClick={event => event.stopPropagation()}
                          onChange={() => {
                            toggleGroupFile(group.id, option.key, option)
                            if (!checked && option.kind === 'generator') {
                              setReportModal({ groupId: group.id, reportKey: option.key })
                            }
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-red-700"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 font-semibold text-text-primary">
                            <Icon className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate" title={option.label}>{option.label}</span>
                            {option.kind === 'generator' ? <CalendarDays className="h-3 w-3 shrink-0 text-text-muted" /> : null}
                          </span>
                          <span className="mt-0.5 block text-text-muted">{String(option.file_type || '').toUpperCase()} · {option.period_mode || 'период'}</span>
                          {checked && option.kind === 'generator' ? (
                            <span className="mt-1 block rounded-sm bg-white/70 px-1.5 py-1 text-[10px] text-text-secondary">
                              {dateText}
                            </span>
                          ) : null}
                          {checked && option.kind === 'generator' && option.supports_cache_reuse && sendUseCacheEffective ? (
                            <span className="mt-1 inline-flex rounded-sm bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-text-primary">
                              Кеш разрешен
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )
                  })}
                  {fileOptions.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-text-muted">Список файлов не загружен.</div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={addGroup}
          disabled={!canEdit}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-[12px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить группу
        </button>
        <div className="flex items-center gap-2 text-[12px] text-text-muted"><Mail className="h-4 w-4" /> Каждая группа получит отдельное письмо со своим набором файлов.</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-white px-3 text-[12px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red">
            <input
              type="checkbox"
              checked={sendUseCacheEffective}
              disabled={!canEdit || sendRunning || selectedCacheReusableFileCount === 0}
              onChange={event => setSendUseCache(event.target.checked)}
              className="h-4 w-4 accent-red-700"
            />
            Использовать кеш
          </label>
          <button
            type="button"
            onClick={() => sendMut.mutate({ useCache: sendUseCacheEffective })}
            disabled={!canEdit || sendRunning}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-3 text-[12px] font-semibold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sendRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {sendRunning ? 'Рассылка…' : 'Разослать'}
          </button>
          <SaveButton onClick={() => saveMut.mutate()} disabled={!canEdit || saveMut.isPending} loading={saveMut.isPending} />
        </div>
      </div>

      {saveMut.isSuccess ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">Настройки рассылки сохранены.</div> : null}
      {saveMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(saveMut.error)}</div> : null}
      {sendMut.data && !sendMut.data.queued ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          Рассылка выполнена: групп {sendMut.data.groups?.length ?? 0}, файлов сгенерировано {sendMut.data.generated_files?.length ?? 0}{sendMut.data.dry_run ? ' · тестовый режим без SMTP-отправки' : ''}.
        </div>
      ) : null}
      {displaySendStatus && displaySendStatus.status !== 'idle' ? <DailyReportEmailProgressPanel status={displaySendStatus} /> : null}
      {sendMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(sendMut.error)}</div> : null}

      {reportModal && modalOption && modalGroup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 py-6">
          <div className="w-full max-w-[680px] rounded-lg border border-border bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-[13px] font-semibold text-text-primary">{modalOption.label}</div>
                <div className="mt-0.5 text-[11px] text-text-muted">{modalGroup.name}</div>
              </div>
              <button
                type="button"
                onClick={() => setReportModal(null)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-text-primary"
                aria-label="Закрыть"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-3 px-4 py-3">
              <label className="flex items-center gap-2 text-[12px] text-text-primary">
                <input
                  type="radio"
                  checked={modalConfig.date_mode !== 'custom'}
                  disabled={!canEdit}
                  onChange={() => setReportDateMode(reportModal.groupId, reportModal.reportKey, modalOption, 'day_before_send')}
                  className="accent-red-700"
	                />
	                Стандарт: {dailyReportEmailDateSummary(modalOption, {
	                  ...defaultDailyReportEmailReportConfig(),
	                  cumulative_as_of_end_date: modalConfig.cumulative_as_of_end_date,
	                  use_cache: modalConfig.use_cache,
	                })}
	              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-primary">
                <input
                  type="radio"
                  checked={modalConfig.date_mode === 'custom'}
                  disabled={!canEdit}
                  onChange={() => setReportDateMode(reportModal.groupId, reportModal.reportKey, modalOption, 'custom')}
                  className="accent-red-700"
                />
                {modalOption.period_mode === 'range' ? 'Свой период' : 'Конкретная дата'}
              </label>
              {modalOption.period_mode === 'range' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-[11px] text-text-muted">
                    Дата начала
                    <input
                      type="date"
                      value={modalConfig.date_from || defaultDailyReportEmailRangeStart(modalConfig.date || defaultDailyReportEmailReportDate())}
                      max={modalConfig.date || undefined}
                      disabled={!canEdit || modalConfig.date_mode !== 'custom'}
                      onChange={event => updateReportConfig(reportModal.groupId, reportModal.reportKey, { date_mode: 'custom', date_from: event.target.value })}
                      className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                    />
                  </label>
                  <label className="block text-[11px] text-text-muted">
                    Дата окончания
                    <input
                      type="date"
                      value={modalConfig.date || defaultDailyReportEmailReportDate()}
                      min={modalConfig.date_from || undefined}
                      disabled={!canEdit || modalConfig.date_mode !== 'custom'}
                      onChange={event => updateReportConfig(reportModal.groupId, reportModal.reportKey, { date_mode: 'custom', date: event.target.value })}
                      className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                    />
                  </label>
                </div>
              ) : (
                <input
                  type="date"
                  value={modalConfig.date || defaultDailyReportEmailReportDate()}
                  disabled={!canEdit || modalConfig.date_mode !== 'custom'}
                  onChange={event => updateReportConfig(reportModal.groupId, reportModal.reportKey, { date_mode: 'custom', date: event.target.value, date_from: null })}
                  className="w-full rounded-md border border-border px-3 py-2 text-sm text-text-primary disabled:bg-bg-surface"
                />
              )}
              {modalOption.supports_cumulative_as_of_end_date ? (
                <label className="flex items-center gap-2 rounded-md border border-border bg-bg-surface/50 px-3 py-2 text-[12px] text-text-primary">
                  <input
                    type="checkbox"
                    checked={modalConfig.cumulative_as_of_end_date !== false}
                    disabled={!canEdit}
                    onChange={event => updateReportConfig(reportModal.groupId, reportModal.reportKey, { cumulative_as_of_end_date: event.target.checked })}
                    className="accent-red-700"
                  />
                  Накопительные итоги на дату окончания
                </label>
              ) : null}
            </div>
            <div className="flex justify-end border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setReportModal(null)}
                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[12px] font-semibold text-text-secondary hover:border-accent-red/40 hover:text-accent-red"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DailyReportEmailProgressPanel({ status }: { status: DailyReportEmailSendStatus }) {
  const percent = typeof status.progress_percent === 'number'
    ? Math.max(0, Math.min(100, status.progress_percent))
    : null
  const isError = status.status === 'error'
  const isDone = status.status === 'success'
  const toneClass = isError
    ? 'border-red-200 bg-red-50 text-red-800'
    : isDone
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-blue-200 bg-blue-50 text-blue-900'
  const barClass = isError ? 'bg-accent-red' : isDone ? 'bg-emerald-600' : 'bg-accent-red'
  const stage = status.stage_label || status.message || (status.running ? 'Рассылка выполняется' : 'Статус рассылки')
  const detail = status.current_file_label
    ? `Файл: ${status.current_file_label}`
    : status.current_group_name
      ? `Группа: ${status.current_group_name}`
      : status.message
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">{stage}</div>
          {detail ? <div className="mt-0.5 text-[11px] opacity-80">{detail}</div> : null}
        </div>
        {percent !== null ? <div className="font-mono text-[12px]">{percent}%</div> : null}
      </div>
      <div className="h-2 overflow-hidden rounded bg-white">
        <div className={`h-full rounded transition-[width] duration-500 ${barClass}`} style={{ width: `${percent ?? 6}%` }} />
      </div>
      <div className="mt-2 grid gap-2 text-[11px] opacity-85 sm:grid-cols-4">
        <span>Этапы: {status.completed_steps ?? 0}/{status.total_steps ?? '—'}</span>
        <span>Прошло: {formatProgressDuration(status.elapsed_seconds)}</span>
        <span>Осталось: {formatProgressDuration(status.eta_seconds)}</span>
        <span>Оценка: {formatProgressDuration(status.estimated_total_seconds)}</span>
      </div>
      {status.error ? <div className="mt-2 text-[11px] font-semibold">{status.error}</div> : null}
    </div>
  )
}

function IssoSupportReportSettingsBlock({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, error, isFetching } = useQuery<IssoSupportReportSettingsResponse>({
    queryKey: ['wip', 'settings', 'isso-support-report', 'all-months'],
    queryFn: () => fetchJson<IssoSupportReportSettingsResponse>('/api/wip/settings/isso-support-report?all_months=true'),
    staleTime: 60_000,
  })
  const [draft, setDraft] = useState<IssoSupportReportSettingsRow[]>([])

  useEffect(() => {
    setDraft((data?.rows ?? []).map(row => ({ ...row })))
  }, [data?.target_month, data?.rows])

  const months = useMemo<IssoSupportReportMonth[]>(() => {
    const fromApi = data?.months ?? []
    const source: IssoSupportReportMonth[] = fromApi.length
      ? fromApi
      : [...new Set((data?.rows ?? draft).map(row => row.plan_month).filter(Boolean))].map(month => ({ month }))
    return [...source]
      .filter(month => month.month)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(month => ({ ...month, label: month.label || issoMonthLabel(month.month) }))
  }, [data?.months, data?.rows, draft])

  const sourceRowsByKey = new Map((data?.rows ?? []).map(row => [row.row_key, row]))
  const overrideRows = draft.filter(row => {
    const source = sourceRowsByKey.get(row.row_key)
    if (!source) return false
    return row.support_range_text !== source.source_support_range_text
      || row.rd_status !== source.source_rd_status
      || row.remark !== source.source_remark
  })
  const dirtyRows = draft.filter(row => {
    const source = sourceRowsByKey.get(row.row_key)
    if (!source) return false
    return row.support_range_text !== source.support_range_text
      || row.rd_status !== source.rd_status
      || row.remark !== source.remark
  })
  const dirtyRowKeys = new Set(dirtyRows.map(row => row.row_key))
  const groupedRows = useMemo(() => groupIssoSupportRows(draft), [draft])

  const saveMut = useMutation({
    mutationFn: async (rows: IssoSupportReportSettingsRow[]) => fetchJson<IssoSupportReportSettingsResponse>('/api/wip/settings/isso-support-report', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        months: months.map(month => month.month),
        rows: rows.map(row => ({
          row_key: row.row_key,
          plan_id: row.plan_id,
          object_code: row.object_code,
          plan_month: row.plan_month,
          section_code: row.section_code,
          section_name: row.section_name,
          source_name: row.source_name,
          object_name: row.object_name,
          pk_text: row.pk_text,
          support_range_text: row.support_range_text,
          rd_status: row.rd_status,
          remark: row.remark,
        })),
      }),
    }),
    onSuccess: saved => {
      setDraft(saved.rows.map(row => ({ ...row })))
      qc.invalidateQueries({ queryKey: ['wip', 'settings', 'isso-support-report'] })
    },
  })

  function updateRow(rowKey: string, patch: Partial<IssoSupportReportSettingsRow>) {
    setDraft(prev => prev.map(row => row.row_key === rowKey ? { ...row, ...patch } : row))
  }

  if (isLoading && !data) return <div className="h-40 animate-pulse rounded-md bg-bg-surface" />
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(error)}</div>

  const snapshotDate = data?.snapshot?.snapshot_date?.slice(0, 10) || '—'
  const sourceFile = data?.snapshot?.source_filename || data?.snapshot?.title || '—'
  const tableMinWidth = Math.max(900 + months.length * 330, 1250)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 text-[12px] text-text-muted">
          <div>Корректировки сохраняются по месяцам и применяются при генерации PDF ИССО.</div>
          <div>Снимок: <span className="font-medium text-text-primary">{snapshotDate}</span> · источник: <span className="font-medium text-text-primary">{sourceFile}</span></div>
          <div>Месяцев: <span className="font-medium text-text-primary">{months.length || 0}</span> · строк объектов: <span className="font-medium text-text-primary">{groupedRows.length || 0}</span></div>
          {data?.updated_at && (
            <div>Последнее сохранение: <span className="font-medium text-text-primary">{data.updated_at.slice(0, 19).replace('T', ' ')}</span>{data.updated_by ? ` · ${data.updated_by}` : ''}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDraft((data?.rows ?? []).map(row => ({ ...row })))}
            disabled={!draft.length || saveMut.isPending}
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-[12px] font-semibold text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Сбросить черновик
          </button>
          <SaveButton onClick={() => saveMut.mutate(overrideRows)} disabled={!canEdit || dirtyRows.length === 0} loading={saveMut.isPending} label="Сохранить корректировки" />
        </div>
      </div>

      {!canEdit && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Блок открыт только для просмотра. Сохранять корректировки могут учетные записи admin и user.
        </div>
      )}

      {isFetching && <div className="text-[12px] text-text-muted">Обновляю данные месяцев...</div>}

      {groupedRows.length === 0 || months.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-text-muted">
          В последнем снимке нет строк плана передачи опор.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[12px]" style={{ minWidth: tableMinWidth }}>
            <thead className="bg-bg-surface text-text-muted">
              <tr>
                <th className="sticky left-0 z-20 w-[260px] min-w-[260px] border-r border-border bg-bg-surface px-3 py-2 font-semibold">Участок / объект</th>
                <th className="sticky left-[260px] z-20 w-[220px] min-w-[220px] border-r border-border bg-bg-surface px-3 py-2 font-semibold">Источник / ПК</th>
                {months.map(month => (
                  <th key={month.month} className="min-w-[330px] border-r border-border px-3 py-2 align-top font-semibold">
                    <div className="text-text-primary">{month.label || issoMonthLabel(month.month)}</div>
                    <div className="mt-0.5 text-[10px] font-normal text-text-muted">{month.row_count ?? 0} строк</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupedRows.map(group => (
                <tr key={group.key} className="border-t border-border align-top">
                  <td className="sticky left-0 z-10 border-r border-border bg-white px-3 py-3">
                    <div className="font-semibold text-text-primary">{group.first.object_name || group.first.object_code || '—'}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{group.first.section_name || group.first.section_code || 'Без участка'} · {group.first.object_code || 'без кода'}</div>
                  </td>
                  <td className="sticky left-[260px] z-10 border-r border-border bg-white px-3 py-3 text-[11px] text-text-secondary">
                    <div>{group.first.source_name || '—'}</div>
                    <div className="mt-1 text-text-muted">ПК: {group.first.pk_text || '—'}</div>
                  </td>
                  {months.map(month => {
                    const row = group.byMonth[month.month]
                    if (!row) {
                      return <td key={month.month} className="border-r border-border bg-bg-surface/50 px-3 py-3 text-[11px] text-text-muted">Нет строки в месяце</td>
                    }
                    const source = sourceRowsByKey.get(row.row_key)
                    const isDirty = dirtyRowKeys.has(row.row_key)
                    const hasOverride = Boolean(source?.has_override)
                    return (
                      <td key={row.row_key} className="border-r border-border px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {(hasOverride || isDirty) && <span className="inline-flex rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">{isDirty ? 'Несохраненная правка' : 'Сохраненная правка'}</span>}
                        </div>
                        <label className="block">
                          <span className="text-[10px] uppercase tracking-wide text-text-muted">График передачи опор</span>
                          <input
                            type="text"
                            value={row.support_range_text || ''}
                            disabled={!canEdit}
                            onChange={event => updateRow(row.row_key, { support_range_text: event.target.value })}
                            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-[12px] text-text-primary disabled:bg-bg-surface"
                            placeholder="например, 1-12"
                          />
                          <span className="mt-1 block text-[10px] text-text-muted">Из снимка: {row.source_support_range_text || '—'}</span>
                        </label>
                        <label className="mt-2 block">
                          <span className="text-[10px] uppercase tracking-wide text-text-muted">РД</span>
                          <select
                            value={row.rd_status || 'unknown'}
                            disabled={!canEdit}
                            onChange={event => updateRow(row.row_key, { rd_status: event.target.value })}
                            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-[12px] text-text-primary disabled:bg-bg-surface"
                          >
                            {ISSO_RD_STATUS_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <span className="mt-1 block text-[10px] text-text-muted">Из снимка: {issoStatusLabel(row.source_rd_status)}</span>
                        </label>
                        <label className="mt-2 block">
                          <span className="text-[10px] uppercase tracking-wide text-text-muted">Примечания</span>
                          <textarea
                            value={row.remark || ''}
                            disabled={!canEdit}
                            onChange={event => updateRow(row.row_key, { remark: event.target.value })}
                            rows={2}
                            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-[12px] text-text-primary disabled:bg-bg-surface"
                            placeholder="Комментарий для PDF"
                          />
                          <span className="mt-1 block whitespace-pre-wrap text-[10px] text-text-muted">Из снимка: {row.source_remark || '—'}</span>
                        </label>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {saveMut.error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">{errorMessage(saveMut.error)}</div> : null}
    </div>
  )
}


// ── Page ──────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const qc = useQueryClient()
  const { isAdmin, isUserEquivalent } = useAuth()
  const canManageSettings = isUserEquivalent
  const { data: normsResponse, isLoading, isError, error } = useQuery<Partial<NormsData>>({
    queryKey: ['wip', 'settings', 'norms'],
    queryFn: () => fetchJson<Partial<NormsData>>('/api/wip/settings/norms'),
    staleTime: 60_000,
  })
  const norms = normalizeNorms(normsResponse)

  function invalidateNorms() {
    qc.invalidateQueries({ queryKey: ['wip', 'settings', 'norms'] })
    // Нормы используются в /equipment-productivity и /mechanization — инвалидируем и их.
    qc.invalidateQueries({ queryKey: ['wip', 'mechanization'] })
    qc.invalidateQueries({ queryKey: ['wip', 'equipment-productivity'] })
  }

  const patchMut = useMutation({
    mutationFn: async (body: Partial<{ work_types: WorkTypeNorm[]; sand_pit: SandSectionNorm[]; sand_stockpile: SandSectionNorm[]; generic: GenericNorm }>) => {
      const r = await fetch('/api/wip/settings/norms', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: 'Ошибка сохранения' }))
        throw new Error(e.detail || 'Ошибка сохранения')
      }
      return r.json()
    },
    onSuccess: invalidateNorms,
  })

  return (
    <div className="flex flex-col min-h-full bg-bg-primary">
      <div className="px-4 sm:px-6 py-3 flex items-center gap-3 border-b border-border bg-white">
        <SettingsIcon className="w-5 h-5 text-accent-red" />
        <h1 className="text-xl font-heading font-bold text-text-primary">Настройки</h1>
      </div>

      <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
        {isAdmin && (
          <Section
            title="Доступы и права учетных записей"
            subtitle="Страницы управляют видимостью разделов, права разрешают действия."
          >
            <UserAccessBlock />
          </Section>
        )}

        {isAdmin && (
          <Section
            title="Настройки сайдбара"
            subtitle="Порядок и видимость ссылок в левом меню."
          >
            <SidebarSettingsBlock canEdit={isAdmin} />
          </Section>
        )}

        {isAdmin && (
          <Section
            title="Оповещения"
            subtitle="Отдельные сообщения для всех вкладок или выбранного раздела."
          >
            <AnnouncementBlock canEdit={isAdmin} />
          </Section>
        )}

        {isAdmin && (
          <Section
            title="Ежедневная рассылка отчетов"
            subtitle="Адреса получателей для автоматической отправки сгенерированных отчетов."
          >
            <DailyReportEmailSettingsBlock canEdit={isAdmin} />
          </Section>
        )}

        {isAdmin && (
          <Section
            title="Миграция дублей справочников"
            subtitle="Ручной перенос выбранных ссылок между работами, объектами и материалами с аудитом в БД."
            defaultCollapsed
          >
            <ReferenceDedupBlock />
          </Section>
        )}

        <Section
          title="Файлы для заполнения отчета"
          subtitle="Инструкция, текстовые шаблоны и Excel-шаблон открываются как обычные файлы, без записи в БД."
        >
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-semibold">Дата обновления инструкций и шаблонов: 20.08.2026.</div>
            <div>
              Во всех перевозках обязательно указывайте плечо возки. Для ЖДС/ЖЕЛДОРСТРОЙ указывайте номер техники,
              для сторонней/наемной техники указывайте число единиц техники, максимум 50 в одной строке.
              Перед добавлением новой работы, объекта или материала проверяйте дубли; текущие списки работ и объектов есть в Excel-шаблоне.
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <DownloadLink
              href="/api/wip/settings/daily-report-template.xlsx"
              filename="Excel-шаблон сменного отчета.xlsx"
              icon={FileSpreadsheet}
              title="Табличный шаблон с инструкцией"
              description="Excel-шаблон на одном листе: ввод отчета, подсказки и актуальные справочники."
              apiDownload
            />
            <DownloadLink
              href="/templates/daily_report_text_template_readable.txt"
              filename="Текстовый шаблон сменного отчета.txt"
              icon={FileText}
              title="Текстовый шаблон с инструкцией"
              description="Готовый текстовый пример с правилами заполнения в начале файла."
            />
            <DownloadLink
              href="/templates/daily_report_shift_instructions.txt"
              filename="Инструкция по заполнению сменного отчета.txt"
              icon={BookOpen}
              title="Отдельная инструкция"
              description="Полные правила заполнения: шапка, перевозки, работы, отсыпка, сваи и техника."
            />
          </div>
        </Section>

        {isLoading ? (
          <div className="h-40 bg-white border border-border rounded-xl animate-pulse" />
        ) : isError || !norms ? (
          <Section
            title="Справочник нормативов производительности"
            subtitle="Настройки не загружены, но страница остается доступной."
          >
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-accent-red">
              Не удалось загрузить настройки: {errorMessage(error)}
            </div>
          </Section>
        ) : (
          <>
            <Section
              title="Справочник нормативов производительности"
              subtitle="Нормы смен per-единица техники. Применяются немедленно на следующем запросе."
            >
              <div className="space-y-6">
                {!canManageSettings && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    Нормы доступны только для просмотра. Изменять их могут учетные записи admin и user.
                  </div>
                )}
                <div>
                  <div className="text-[12px] font-semibold text-text-primary mb-2">
                    Экскаваторы / бульдозеры / автогрейдер / каток — по видам работ
                  </div>
                  <WorkTypesTable
                    key={norms.work_types.map(r => `${r.equipment_type}:${r.work_type_code}:${r.norm_name ?? ''}:${r.norm}:${r.unit ?? ''}:${r.productivity_enabled}`).join('|')}
                    rows={norms.work_types}
                    workOptions={norms.work_options}
                    equipmentTypes={norms.equipment_types}
                    saving={patchMut.isPending}
                    canEdit={canManageSettings}
                    onSave={rows => patchMut.mutate({ work_types: rows })}
                  />
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-text-primary mb-2">
                    Самосвалы: карьер → накопитель / конструктив (песок)
                  </div>
                  <SandSectionTable
                    rows={norms.sand_pit}
                    title="Для участков, где ЖДС возит с карьера напрямую. Уч. №6 — наёмники, норма не задана."
                    saving={patchMut.isPending}
                    canEdit={canManageSettings}
                    onSave={rows => patchMut.mutate({ sand_pit: rows })}
                  />
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-text-primary mb-2">
                    Самосвалы: накопитель → конструктив (песок)
                  </div>
                  <SandSectionTable
                    rows={norms.sand_stockpile}
                    title="Нормы смен per участок."
                    saving={patchMut.isPending}
                    canEdit={canManageSettings}
                    onSave={rows => patchMut.mutate({ sand_stockpile: rows })}
                  />
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-text-primary mb-2">
                    Универсальная норма «прочей перевозки»
                  </div>
                  <GenericTruckBlock
                    value={norms.generic.norm_m3_per_shift}
                    saving={patchMut.isPending}
                    canEdit={canManageSettings}
                    onSave={v => patchMut.mutate({ generic: { norm_m3_per_shift: v } })}
                  />
                </div>
              </div>
            </Section>

            <Section
              title="Ввод данных в Дашборд"
              subtitle="Загрузка XLSX-источников для блоков численности и пульса техники."
            >
              <DashboardInputDataBlock canEdit={canManageSettings} />
            </Section>

            <Section
              title="Ввод данных по РД"
              subtitle="Локальный Windows-инструмент для проверки распознанных ВОР/ведомостей и выгрузки XLSX для загрузки в дашборд."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <DownloadLink
                  href="/api/db-admin/rd-intake-portable.zip"
                  filename="Инструмент ввода РД для Windows.zip"
                  icon={FileSpreadsheet}
                  title="Скачать инструмент РД"
                  description="Portable ZIP для Windows со свежими справочниками из БД."
                  apiDownload
                />
              </div>
            </Section>

            <Section
              title="Коэффициенты уплотнения"
              subtitle="Последняя строка применяется в отчетах ДиМ, МСтрой и Общем отчете ко всем материалам и работам."
            >
              <CompactionCoefficientsBlock canEdit={canManageSettings} />
            </Section>

            <Section
              title="Плечи возки песка"
              subtitle="Для каждого участка задаются расстояния от действующих карьеров. Эти данные используются в TV-индексе общего зачета."
            >
              <HaulDistancesBlock canEdit={canManageSettings} />
            </Section>

            <Section
              title="Границы участков"
              subtitle="Три набора границ: основной ход, притрассовые дороги, свайные поля и водопропускные трубы. Участок №3 можно хранить двумя сегментами."
            >
              <SectionBoundariesBlock canEdit={canManageSettings} />
            </Section>

            <Section
              title="Корректировки отчета ИССО"
              subtitle="Ручная корректировка данных PDF-отчета: состояние РД, график передачи опор и примечания по выбранному месяцу."
            >
              <IssoSupportReportSettingsBlock canEdit={canManageSettings} />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
