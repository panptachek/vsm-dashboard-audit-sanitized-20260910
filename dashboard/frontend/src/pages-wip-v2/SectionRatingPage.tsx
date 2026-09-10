import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import { CalendarDays, Clock3, FileText, Info, Loader2, Medal, Percent, RefreshCw, Save, Trophy, X } from 'lucide-react'
import { useAuth } from '../auth'

type RatingScope = 'zp' | 'isso'
type RatingPeriod = 'day' | 'week' | 'custom'

interface SectionMeta {
  section_code: string
  section_number: number
  section_name: string
  sort_order: number | null
}

interface SectionRatingRow extends SectionMeta {
  rank: number | null
  total_score: number | null
  metrics_available: number
  reports: number
  edit_reports: number
  changed_units: number
  comparable_units: number
  changed_percent: number | null
  edit_score: number | null
  upload_score: number | null
  upload_reports: number
  late_upload_reports: number
  mstroy_difference_percent: number | null
  mstroy_score: number | null
  mstroy_entries: number
  mstroy_comment: string | null
  mstroy_updated_at: string | null
  mstroy_updated_by: string | null
}

interface SectionRatingResponse {
  scope: RatingScope
  scope_label: string
  period: RatingPeriod
  date: string | null
  date_from: string
  date_to: string
  generated_at: string
  sections: SectionMeta[]
  leaderboard: SectionRatingRow[]
  winner: SectionRatingRow | null
}

interface MstroyInputRow {
  id: string | null
  rating_date: string
  scope: RatingScope
  section_code: string
  difference_percent: number | null
  score: number | null
  comment: string | null
  updated_by: string | null
  updated_at: string | null
}

interface MstroyInputsResponse {
  rating_date: string
  scope: RatingScope
  scope_label: string
  sections: SectionMeta[]
  rows: MstroyInputRow[]
}

interface ReportUserFlag {
  key: string
  label: string
  color: string
  updated_by?: string
  updated_at?: string
}

interface SectionRatingDetailRow {
  report_id: string
  report_date: string | null
  shift: string | null
  source_type: string | null
  source_reference: string | null
  uploaded_by_username: string | null
  user_flags: ReportUserFlag[]
  uploaded_at: string | null
  uploaded_at_msk: string | null
  upload_score: number | null
  is_late_upload: boolean
  edit_metric_available: boolean
  changed_percent: number | null
  changed_units: number
  comparable_units: number
  added_rows: number
  removed_rows: number
  changed_rows: number
  changed_fields: number
  day3_snapshot_at: string | null
  day3_snapshot_at_msk: string | null
  calculated_at: string | null
}

interface SectionRatingDetailsResponse {
  scope: RatingScope
  scope_label: string
  period: RatingPeriod
  date: string | null
  date_from: string
  date_to: string
  section: SectionMeta
  summary: {
    reports: number
    edit_reports: number
    changed_units: number
    comparable_units: number
    changed_percent: number | null
    upload_score: number | null
    late_upload_reports: number
  }
  rows: SectionRatingDetailRow[]
}

interface DraftRow {
  difference: string
  comment: string
}

interface SaveMstroyVariables {
  scope: RatingScope
  sectionCode: string
}

interface DetailSelection {
  scope: RatingScope
  scopeLabel: string
  row: SectionRatingRow
}

const SCOPES: Array<{ key: RatingScope; label: string }> = [
  { key: 'zp', label: 'ЗП' },
  { key: 'isso', label: 'ИССО' },
]

const scoreNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 0 })
const percentNf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 })
const dateTimeNf = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof data === 'object' && data && 'detail' in data ? (data as { detail?: unknown }).detail : undefined
    throw new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`)
  }
  return data as T
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'последняя дата с метрикой'
  const [year, month, day] = value.split('-')
  return year && month && day ? `${day}.${month}.${year}` : value
}

function formatPeriod(data?: SectionRatingResponse): string {
  if (!data) return ''
  if (data.date_from === data.date_to) return formatDate(data.date_from)
  return `${formatDate(data.date_from)} - ${formatDate(data.date_to)}`
}

function formatDateRange(dateFrom: string | null | undefined, dateTo: string | null | undefined): string {
  if (!dateFrom && !dateTo) return ''
  if (dateFrom === dateTo) return formatDate(dateFrom)
  return `${formatDate(dateFrom)} - ${formatDate(dateTo)}`
}

function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return scoreNf.format(value)
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${percentNf.format(value)}%`
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : dateTimeNf.format(parsed)
}

function shiftLabel(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'day') return 'день'
  if (normalized === 'night') return 'ночь'
  return value || '—'
}

function scoreTone(value: number | null | undefined): string {
  if (value == null) return 'text-text-muted'
  if (value >= 85) return 'text-[#15803d]'
  if (value >= 60) return 'text-[#b45309]'
  return 'text-accent-red'
}

function scoreBarColor(value: number | null | undefined): string {
  if (value == null) return 'bg-neutral-300'
  if (value >= 85) return 'bg-[#16a34a]'
  if (value >= 60) return 'bg-[#f59e0b]'
  return 'bg-accent-red'
}

function parseDraftPercent(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : NaN
}

function previewMstroyScore(value: string): number | null {
  const parsed = parseDraftPercent(value)
  if (parsed == null || !Number.isFinite(parsed)) return null
  return Math.max(0, Math.min(100, 100 - parsed))
}

function buildRatingUrl(scope: RatingScope, period: RatingPeriod, date: string, dateFrom: string, dateTo: string): string {
  const params = new URLSearchParams({ scope, period, refresh_due: 'false' })
  if (period === 'custom') {
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
  } else if (date) {
    params.set('date', date)
  }
  return `/api/wip/reports/section-rating?${params.toString()}`
}

function buildDetailsUrl(scope: RatingScope, sectionCode: string, period: RatingPeriod, date: string, dateFrom: string, dateTo: string): string {
  const params = new URLSearchParams({ scope, section_code: sectionCode, period })
  if (period === 'custom') {
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
  } else if (date) {
    params.set('date', date)
  }
  return `/api/wip/reports/section-rating/details?${params.toString()}`
}

function rankBadgeClass(rank: number | null): string {
  if (rank === 1) return 'bg-[#fef3c7] text-[#92400e] ring-[#f59e0b]'
  if (rank === 2) return 'bg-[#f3f4f6] text-[#374151] ring-[#9ca3af]'
  if (rank === 3) return 'bg-[#ffedd5] text-[#9a3412] ring-[#c2410c]'
  return 'bg-white text-text-primary ring-border'
}

function rankRowClass(rank: number | null): string {
  if (rank === 1) return 'bg-[#fffbeb]'
  if (rank === 2) return 'bg-[#f8fafc]'
  if (rank === 3) return 'bg-[#fff7ed]'
  return 'hover:bg-bg-surface/70'
}

function normalizeReportFlagColor(value?: string | null) {
  const color = (value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#64748b'
}

function reportFlagStyle(flag: ReportUserFlag) {
  const color = normalizeReportFlagColor(flag.color)
  return { borderColor: color, color, backgroundColor: `${color}18` }
}

function MetricPill({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className="rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-text-muted">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold text-text-primary">{value}</div>
    </div>
  )
}

function ScoreBar({ value }: { value: number | null | undefined }) {
  const width = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className="h-2 w-full rounded-full bg-neutral-200">
      <div className={`h-2 rounded-full ${scoreBarColor(value)}`} style={{ width: `${width}%` }} />
    </div>
  )
}

function ModeButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded-md px-3 text-sm font-semibold transition-colors ${
        active ? 'bg-accent-burg text-white shadow-sm' : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

function RatingBoard({
  title,
  data,
  isLoading,
  isFetching,
  error,
  onRefresh,
  onSelectRow,
}: {
  title: string
  data?: SectionRatingResponse
  isLoading: boolean
  isFetching: boolean
  error: unknown
  onRefresh: () => void
  onSelectRow: (row: SectionRatingRow) => void
}) {
  const rows = data?.leaderboard || []
  return (
    <section className="rounded-xl border border-border bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="font-heading text-lg font-bold text-text-primary">{title}</h2>
          <div className="mt-1 text-sm text-text-muted">{formatPeriod(data)}</div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-semibold text-text-secondary hover:bg-bg-surface disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[1120px] w-full border-collapse text-sm">
          <thead className="bg-bg-surface text-left text-[11px] uppercase text-text-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Место</th>
              <th className="px-4 py-3 font-semibold">Участок</th>
              <th className="px-4 py-3 font-semibold">Итоговый балл</th>
              <th className="px-4 py-3 font-semibold">Баллы за правки</th>
              <th className="px-4 py-3 font-semibold">Баллы за время</th>
              <th className="px-4 py-3 font-semibold">Баллы за МСтрой</th>
              <th className="px-4 py-3 font-semibold">Учитывается отчетов</th>
              <th className="px-4 py-3 font-semibold">Отчетов после 12</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-text-muted">
                  <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                  Загрузка рейтинга...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-accent-red">{(error as Error).message}</td>
              </tr>
            ) : rows.length ? (
              rows.map(row => (
                <tr
                  key={row.section_code}
                  role="button"
                  tabIndex={0}
                  aria-label={`Детализация ${row.section_name}`}
                  onClick={() => onSelectRow(row)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectRow(row)
                    }
                  }}
                  className={`${rankRowClass(row.rank)} cursor-pointer outline-none focus:bg-bg-surface focus:ring-2 focus:ring-inset focus:ring-accent-red/30`}
                >
                  <td className="px-4 py-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ring-1 ${rankBadgeClass(row.rank)}`}>
                      {row.rank || '—'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-text-primary">{row.section_name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className={`mb-1 text-lg font-bold ${scoreTone(row.total_score)}`}>{formatScore(row.total_score)}</div>
                    <ScoreBar value={row.total_score} />
                  </td>
                  <td className={`px-4 py-3 font-semibold ${scoreTone(row.edit_score)}`}>{formatScore(row.edit_score)}</td>
                  <td className={`px-4 py-3 font-semibold ${scoreTone(row.upload_score)}`}>{formatScore(row.upload_score)}</td>
                  <td className={`px-4 py-3 font-semibold ${scoreTone(row.mstroy_score)}`}>{formatScore(row.mstroy_score)}</td>
                  <td className="px-4 py-3 text-text-primary">
                    <div className="font-semibold">{row.reports}</div>
                  </td>
                  <td className="px-4 py-3 text-text-primary">{row.late_upload_reports}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-text-muted">Нет данных за выбранный период</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MstroyInputPanel({
  title,
  mstroyDate,
  data,
  fallbackSections,
  draftRows,
  isLoading,
  saveError,
  savingSection,
  onDraftChange,
  onSave,
}: {
  title: string
  mstroyDate: string
  data?: MstroyInputsResponse
  fallbackSections: SectionMeta[]
  draftRows: Record<string, DraftRow>
  isLoading: boolean
  saveError: string
  savingSection: SaveMstroyVariables | null
  onDraftChange: (sectionCode: string, patch: Partial<DraftRow>) => void
  onSave: (sectionCode: string) => void
}) {
  const sections = data?.sections || fallbackSections
  return (
    <div className="rounded-xl border border-border bg-white shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h2 className="font-heading text-lg font-bold text-text-primary">{title}</h2>
        <div className="mt-1 text-sm text-text-muted">Дата ввода: {formatDate(mstroyDate)}</div>
      </div>
      {saveError && <div className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-accent-red">{saveError}</div>}
      <div className="overflow-x-auto p-4">
        <table className="min-w-[680px] w-full border-collapse text-sm">
          <thead className="bg-bg-surface text-left text-[11px] uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Участок</th>
              <th className="px-3 py-2 font-semibold">Расхождение, %</th>
              <th className="px-3 py-2 font-semibold">Балл</th>
              <th className="px-3 py-2 font-semibold">Комментарий</th>
              <th className="px-3 py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">Загрузка...</td>
              </tr>
            ) : sections.length ? (
              sections.map(section => {
                const draft = draftRows[section.section_code] || { difference: '', comment: '' }
                const previewScore = previewMstroyScore(draft.difference)
                const isSaving = savingSection?.sectionCode === section.section_code
                return (
                  <tr key={section.section_code}>
                    <td className="px-3 py-2 font-semibold text-text-primary">{section.section_name}</td>
                    <td className="px-3 py-2">
                      <input
                        value={draft.difference}
                        onChange={event => onDraftChange(section.section_code, { difference: event.target.value })}
                        inputMode="decimal"
                        className="h-9 w-32 rounded-md border border-border px-2 text-sm"
                        placeholder="0"
                      />
                    </td>
                    <td className={`px-3 py-2 font-semibold ${scoreTone(previewScore)}`}>{formatScore(previewScore)}</td>
                    <td className="px-3 py-2">
                      <input
                        value={draft.comment}
                        onChange={event => onDraftChange(section.section_code, { comment: event.target.value })}
                        className="h-9 w-full rounded-md border border-border px-2 text-sm"
                        placeholder="Примечание"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onSave(section.section_code)}
                        disabled={!mstroyDate || Boolean(savingSection)}
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-slate-800 px-3 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                        title={draft.difference.trim() ? 'Сохранить' : 'Очистить значение'}
                      >
                        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        OK
                      </button>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">Нет списка участков</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ReportDetailsModal({
  selection,
  data,
  isLoading,
  error,
  onClose,
}: {
  selection: DetailSelection
  data?: SectionRatingDetailsResponse
  isLoading: boolean
  error: unknown
  onClose: () => void
}) {
  const rows = data?.rows || []
  const summary = data?.summary
  function openReport(row: SectionRatingDetailRow) {
    if (!row.report_id) return
    window.location.assign(`/reports?report_id=${encodeURIComponent(row.report_id)}`)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6" onClick={onClose}>
      <div
        className="mx-auto flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Детализация отчетов ${selection.row.section_name}`}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase text-text-muted">{selection.scopeLabel}</div>
            <h2 className="mt-1 font-heading text-xl font-bold text-text-primary">{selection.row.section_name}</h2>
            <div className="mt-1 text-sm text-text-muted">{formatDateRange(data?.date_from, data?.date_to)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-accent-red"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto">
          <div className="grid gap-3 border-b border-border bg-bg-surface/50 p-4 md:grid-cols-4">
            <MetricPill icon={FileText} label="Учитывается отчетов" value={summary ? String(summary.reports) : '—'} />
            <MetricPill icon={Percent} label="Есть метрика правок" value={summary ? String(summary.edit_reports) : '—'} />
            <MetricPill icon={Percent} label="Средний % исправлений" value={formatPercent(summary?.changed_percent)} />
            <MetricPill icon={Clock3} label="Отчетов после 12" value={summary ? String(summary.late_upload_reports) : '—'} />
          </div>

          <div className="overflow-x-auto p-4">
            <table className="min-w-[1260px] w-full border-collapse text-sm">
              <thead className="bg-bg-surface text-left text-[11px] uppercase text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Дата отчета</th>
                  <th className="px-3 py-2 font-semibold">Смена</th>
                  <th className="px-3 py-2 font-semibold">Отчет</th>
                  <th className="px-3 py-2 font-semibold">Автор</th>
                  <th className="px-3 py-2 font-semibold">Флаги</th>
                  <th className="px-3 py-2 font-semibold">Загружен МСК</th>
                  <th className="px-3 py-2 font-semibold">Снимок 3-го дня</th>
                  <th className="px-3 py-2 font-semibold">% исправлено</th>
                  <th className="px-3 py-2 font-semibold">Изменено / учитывается</th>
                  <th className="px-3 py-2 font-semibold">После 12</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-text-muted">
                      <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      Загрузка деталей...
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-accent-red">{(error as Error).message}</td>
                  </tr>
                ) : rows.length ? (
                  rows.map(row => (
                    <tr
                      key={row.report_id}
                      role="link"
                      tabIndex={0}
                      aria-label={`Открыть отчет ${row.source_reference || row.report_id}`}
                      onClick={() => openReport(row)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openReport(row)
                        }
                      }}
                      className="cursor-pointer outline-none hover:bg-bg-surface/70 focus:bg-bg-surface focus:ring-2 focus:ring-inset focus:ring-accent-red/30"
                    >
                      <td className="px-3 py-2 font-semibold text-text-primary">{formatDate(row.report_date)}</td>
                      <td className="px-3 py-2 text-text-primary">{shiftLabel(row.shift)}</td>
                      <td className="px-3 py-2">
                        <div className="max-w-md break-words font-semibold text-text-primary">{row.source_reference || `Отчет ${row.report_id.slice(0, 8)}`}</div>
                      </td>
                      <td className="px-3 py-2 text-text-primary">{row.uploaded_by_username || '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex max-w-[220px] flex-wrap gap-1">
                          {(row.user_flags || []).length ? row.user_flags.map(flag => (
                            <span
                              key={`${row.report_id}:${flag.key}:${flag.label}`}
                              className="inline-flex max-w-full items-center rounded border px-2 py-0.5 text-[11px] font-semibold"
                              style={reportFlagStyle(flag)}
                              title={flag.updated_by ? `Поставил: ${flag.updated_by}` : undefined}
                            >
                              <span className="truncate">{flag.label}</span>
                            </span>
                          )) : <span className="text-text-muted">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-text-primary">{formatDateTime(row.uploaded_at_msk || row.uploaded_at)}</td>
                      <td className="px-3 py-2 text-text-primary">{formatDateTime(row.day3_snapshot_at_msk || row.day3_snapshot_at)}</td>
                      <td className={`px-3 py-2 font-semibold ${row.edit_metric_available ? scoreTone(100 - (row.changed_percent || 0)) : 'text-text-muted'}`}>
                        {row.edit_metric_available ? formatPercent(row.changed_percent) : 'н/д'}
                      </td>
                      <td className="px-3 py-2 text-text-primary">
                        {row.edit_metric_available ? `${row.changed_units} / ${row.comparable_units}` : 'нет снимка'}
                      </td>
                      <td className={`px-3 py-2 font-semibold ${row.is_late_upload ? 'text-accent-red' : 'text-text-primary'}`}>
                        {row.is_late_upload ? 'да' : 'нет'}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-text-muted">Нет отчетов за выбранный период</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SectionRatingPage() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [period, setPeriod] = useState<RatingPeriod>('day')
  const [date, setDate] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [mstroyDate, setMstroyDate] = useState('')
  const [draftRowsByScope, setDraftRowsByScope] = useState<Record<RatingScope, Record<string, DraftRow>>>({ zp: {}, isso: {} })
  const [saveErrorByScope, setSaveErrorByScope] = useState<Record<RatingScope, string>>({ zp: '', isso: '' })
  const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null)

  const zpRatingUrl = useMemo(() => buildRatingUrl('zp', period, date, dateFrom, dateTo), [date, dateFrom, dateTo, period])
  const issoRatingUrl = useMemo(() => buildRatingUrl('isso', period, date, dateFrom, dateTo), [date, dateFrom, dateTo, period])
  const detailsUrl = useMemo(
    () => detailSelection ? buildDetailsUrl(detailSelection.scope, detailSelection.row.section_code, period, date, dateFrom, dateTo) : '',
    [date, dateFrom, dateTo, detailSelection, period],
  )
  const zpRatingQuery = useQuery<SectionRatingResponse>({
    queryKey: ['wip', 'section-rating', 'zp', period, date, dateFrom, dateTo],
    queryFn: () => fetchJson<SectionRatingResponse>(zpRatingUrl),
  })
  const issoRatingQuery = useQuery<SectionRatingResponse>({
    queryKey: ['wip', 'section-rating', 'isso', period, date, dateFrom, dateTo],
    queryFn: () => fetchJson<SectionRatingResponse>(issoRatingUrl),
  })
  const detailQuery = useQuery<SectionRatingDetailsResponse>({
    queryKey: ['wip', 'section-rating', 'details', detailSelection?.scope, detailSelection?.row.section_code, period, date, dateFrom, dateTo],
    queryFn: () => fetchJson<SectionRatingDetailsResponse>(detailsUrl),
    enabled: Boolean(detailSelection && detailsUrl),
  })

  useEffect(() => {
    if (!mstroyDate && (zpRatingQuery.data?.date_to || issoRatingQuery.data?.date_to)) {
      setMstroyDate(zpRatingQuery.data?.date_to || issoRatingQuery.data?.date_to || '')
    }
  }, [issoRatingQuery.data?.date_to, mstroyDate, zpRatingQuery.data?.date_to])

  const zpMstroyQuery = useQuery<MstroyInputsResponse>({
    queryKey: ['wip', 'section-rating', 'mstroy', 'zp', mstroyDate],
    queryFn: () => fetchJson<MstroyInputsResponse>(`/api/wip/reports/section-rating/mstroy?scope=zp&rating_date=${mstroyDate}`),
    enabled: isAdmin && Boolean(mstroyDate),
  })
  const issoMstroyQuery = useQuery<MstroyInputsResponse>({
    queryKey: ['wip', 'section-rating', 'mstroy', 'isso', mstroyDate],
    queryFn: () => fetchJson<MstroyInputsResponse>(`/api/wip/reports/section-rating/mstroy?scope=isso&rating_date=${mstroyDate}`),
    enabled: isAdmin && Boolean(mstroyDate),
  })

  useEffect(() => {
    if (!zpMstroyQuery.data) return
    setDraftRowsByScope(prev => ({ ...prev, zp: mstroyDraftFromRows(zpMstroyQuery.data.rows) }))
  }, [zpMstroyQuery.data])

  useEffect(() => {
    if (!issoMstroyQuery.data) return
    setDraftRowsByScope(prev => ({ ...prev, isso: mstroyDraftFromRows(issoMstroyQuery.data.rows) }))
  }, [issoMstroyQuery.data])

  const saveMstroyMutation = useMutation<unknown, Error, SaveMstroyVariables>({
    mutationFn: async ({ scope, sectionCode }) => {
      const draft = draftRowsByScope[scope][sectionCode] || { difference: '', comment: '' }
      const difference = parseDraftPercent(draft.difference)
      if (Number.isNaN(difference)) throw new Error('Процент расхождения должен быть числом')
      if (difference != null && (difference < 0 || difference > 1000)) throw new Error('Процент расхождения должен быть от 0 до 1000')
      return fetchJson('/api/wip/reports/section-rating/mstroy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating_date: mstroyDate,
          scope,
          section_code: sectionCode,
          difference_percent: difference,
          comment: draft.comment,
          delete: difference == null,
        }),
      })
    },
    onSuccess: (_data, variables) => {
      setSaveErrorByScope(prev => ({ ...prev, [variables.scope]: '' }))
      void qc.invalidateQueries({ queryKey: ['wip', 'section-rating'] })
    },
    onError: (error, variables) => setSaveErrorByScope(prev => ({ ...prev, [variables.scope]: error.message })),
  })

  const zpRows = zpRatingQuery.data?.leaderboard || []
  const issoRows = issoRatingQuery.data?.leaderboard || []
  const allRows = [...zpRows, ...issoRows]
  const scoredRows = allRows.filter(row => row.total_score != null)
  const totalReports = allRows.reduce((sum, row) => sum + row.reports, 0)
  const averageScore = scoredRows.length ? scoredRows.reduce((sum, row) => sum + (row.total_score || 0), 0) / scoredRows.length : null
  const missingMstroy = allRows.filter(row => row.mstroy_score == null).length
  const savingSection = saveMstroyMutation.isPending ? saveMstroyMutation.variables || null : null

  function updateDraft(scope: RatingScope, sectionCode: string, patch: Partial<DraftRow>) {
    setDraftRowsByScope(prev => ({
      ...prev,
      [scope]: {
        ...prev[scope],
        [sectionCode]: {
          difference: prev[scope][sectionCode]?.difference || '',
          comment: prev[scope][sectionCode]?.comment || '',
          ...patch,
        },
      },
    }))
  }

  return (
    <div className="min-h-dvh w-full bg-bg-primary px-4 py-5 pb-24 lg:px-6">
      <div className="w-full space-y-5">
        <section className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-[#7f1d1d] text-white">
                  <Trophy className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="font-heading text-2xl font-bold text-text-primary">Рейтинг инженеров</h1>
                  <div className="mt-1 text-sm text-text-muted">ЗП и ИССО по дисциплине сменных отчетов</div>
                </div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[auto_1fr] xl:min-w-[620px]">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-text-muted">Период</div>
                <div className="inline-flex rounded-lg border border-border bg-white p-1">
                  <ModeButton active={period === 'day'} onClick={() => setPeriod('day')}>День</ModeButton>
                  <ModeButton active={period === 'week'} onClick={() => setPeriod('week')}>Неделя</ModeButton>
                  <ModeButton active={period === 'custom'} onClick={() => setPeriod('custom')}>Период</ModeButton>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {period === 'custom' ? (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-semibold uppercase text-text-muted">С даты</span>
                      <input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} className="h-10 w-full rounded-md border border-border px-3 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-semibold uppercase text-text-muted">По дату</span>
                      <input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} className="h-10 w-full rounded-md border border-border px-3 text-sm" />
                    </label>
                  </>
                ) : (
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-[11px] font-semibold uppercase text-text-muted">{period === 'week' ? 'Дата окончания недели' : 'Дата'}</span>
                    <input type="date" value={date} onChange={event => setDate(event.target.value)} className="h-10 w-full rounded-md border border-border px-3 text-sm" />
                  </label>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-5">
          <MetricPill icon={Medal} label="Лидер ЗП" value={zpRatingQuery.data?.winner ? `Участок ${zpRatingQuery.data.winner.section_number}` : '—'} />
          <MetricPill icon={Medal} label="Лидер ИССО" value={issoRatingQuery.data?.winner ? `Участок ${issoRatingQuery.data.winner.section_number}` : '—'} />
          <MetricPill icon={FileText} label="Учитывается отчетов" value={String(totalReports)} />
          <MetricPill icon={Trophy} label="Средний балл" value={formatScore(averageScore)} />
          <MetricPill icon={Info} label="Без МСтроя" value={`${missingMstroy} из 16`} />
        </div>

        <div className="grid w-full gap-4">
          <RatingBoard
            title="ЗП"
            data={zpRatingQuery.data}
            isLoading={zpRatingQuery.isLoading}
            isFetching={zpRatingQuery.isFetching}
            error={zpRatingQuery.isError ? zpRatingQuery.error : null}
            onRefresh={() => void zpRatingQuery.refetch()}
            onSelectRow={row => setDetailSelection({ scope: 'zp', scopeLabel: 'ЗП', row })}
          />
          <RatingBoard
            title="ИССО"
            data={issoRatingQuery.data}
            isLoading={issoRatingQuery.isLoading}
            isFetching={issoRatingQuery.isFetching}
            error={issoRatingQuery.isError ? issoRatingQuery.error : null}
            onRefresh={() => void issoRatingQuery.refetch()}
            onSelectRow={row => setDetailSelection({ scope: 'isso', scopeLabel: 'ИССО', row })}
          />
        </div>

        {isAdmin && (
          <>
            <section className="rounded-xl border border-border bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="font-heading text-lg font-bold text-text-primary">МСтрой сходимость</h2>
                  <div className="mt-1 text-sm text-text-muted">Ручной процент расхождения по каждому участку; чем меньше расхождение, тем выше балл</div>
                </div>
                <label className="block w-full max-w-xs">
                  <span className="mb-1 block text-[11px] font-semibold uppercase text-text-muted">Дата ввода</span>
                  <input type="date" value={mstroyDate} onChange={event => setMstroyDate(event.target.value)} className="h-10 w-full rounded-md border border-border px-3 text-sm" />
                </label>
              </div>
            </section>

            <div className="grid w-full gap-4">
              {SCOPES.map(scopeItem => (
                <MstroyInputPanel
                  key={scopeItem.key}
                  title={`МСтрой · ${scopeItem.label}`}
                  mstroyDate={mstroyDate}
                  data={scopeItem.key === 'zp' ? zpMstroyQuery.data : issoMstroyQuery.data}
                  fallbackSections={(scopeItem.key === 'zp' ? zpRatingQuery.data?.sections : issoRatingQuery.data?.sections) || []}
                  draftRows={draftRowsByScope[scopeItem.key]}
                  isLoading={scopeItem.key === 'zp' ? zpMstroyQuery.isLoading : issoMstroyQuery.isLoading}
                  saveError={saveErrorByScope[scopeItem.key]}
                  savingSection={savingSection?.scope === scopeItem.key ? savingSection : null}
                  onDraftChange={(sectionCode, patch) => updateDraft(scopeItem.key, sectionCode, patch)}
                  onSave={sectionCode => saveMstroyMutation.mutate({ scope: scopeItem.key, sectionCode })}
                />
              ))}
            </div>
          </>
        )}

        <section className="rounded-xl border border-border bg-white shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-heading text-lg font-bold text-text-primary">Расчет</h2>
            <div className="mt-1 text-sm text-text-muted">Формулы текущей версии рейтинга</div>
          </div>
          <div className="grid divide-y divide-border text-sm lg:grid-cols-4 lg:divide-x lg:divide-y-0">
            <div className="flex gap-3 px-4 py-3">
              <Percent className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>
                <div className="font-semibold text-text-primary">Правки</div>
                <div className="mt-1 text-text-muted">Балл = 100 - взвешенный процент изменений между загрузкой и снимком на третий день.</div>
              </div>
            </div>
            <div className="flex gap-3 px-4 py-3">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>
                <div className="font-semibold text-text-primary">Время загрузки</div>
                <div className="mt-1 text-text-muted">В 09:00 МСК = 100 баллов; к 12:00 МСК линейно снижается до 0; после 12:00 МСК = 0.</div>
              </div>
            </div>
            <div className="flex gap-3 px-4 py-3">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>
                <div className="font-semibold text-text-primary">МСтрой</div>
                <div className="mt-1 text-text-muted">Балл = 100 - вручную внесенный процент расхождения с МСтроем.</div>
              </div>
            </div>
            <div className="flex gap-3 px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>
                <div className="font-semibold text-text-primary">Итог</div>
                <div className="mt-1 text-text-muted">Итоговый балл считается как среднее доступных показателей; если МСтрой за период не внесен, он не штрафует участок.</div>
              </div>
            </div>
          </div>
        </section>
      </div>
      {detailSelection ? (
        <ReportDetailsModal
          selection={detailSelection}
          data={detailQuery.data}
          isLoading={detailQuery.isLoading || detailQuery.isFetching}
          error={detailQuery.isError ? detailQuery.error : null}
          onClose={() => setDetailSelection(null)}
        />
      ) : null}
    </div>
  )
}

function mstroyDraftFromRows(rows: MstroyInputRow[]): Record<string, DraftRow> {
  const next: Record<string, DraftRow> = {}
  for (const row of rows) {
    next[row.section_code] = {
      difference: row.difference_percent == null ? '' : String(row.difference_percent).replace('.', ','),
      comment: row.comment || '',
    }
  }
  return next
}
