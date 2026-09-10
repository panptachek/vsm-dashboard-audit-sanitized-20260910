import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CalendarDays, CheckCircle2, Clock3, LandPlot, Trophy, X } from 'lucide-react'
import { useAuth } from '../auth'
import './pileControlPrimavera.css'

type Priority = 'green' | 'yellow' | 'red'
type DisplayMode = 'day' | 'cumulative'

interface IntervalFacts {
  main: number
  test: number
  dyn: number
  headcaps: number
  total: number
  plan_main: number
  plan_test: number
  plan_dyn: number
  plan_headcaps: number
  plan_total: number
}

interface ControlInterval {
  key: string
  label: string
  start: string
  end: string
}

interface ControlSection {
  code: string
  label: string
  main: number
  test: number
  dyn: number
  headcaps: number
  total: number
  plan_total: number
  intervals: Record<string, IntervalFacts>
}

interface ControlProblem {
  id: string
  report_id: string
  issue_index?: number
  section_code?: string | null
  section_name?: string | null
  priority: Priority
  text: string
  reported_at: string
  expires_at: string
  created_by?: string | null
}


interface PileFieldDetail {
  section_code?: string | null
  field_code?: string | null
  pk_label?: string | null
}

interface PileFactDetail {
  report_id?: string | null
  work_item_id?: string | null
  segment_id?: string | null
  reported_at: string
  interval_key?: string | null
  interval_label?: string | null
  section_code?: string | null
  section_label?: string | null
  work_code?: string | null
  work_name?: string | null
  kind: 'main' | 'test' | 'dyn' | 'headcaps'
  count: number
  field_code?: string | null
  field_type?: string | null
  pile_type?: string | null
  pk_label?: string | null
  equipment_label?: string | null
  equipment_keys?: string | null
  equipment_unit_numbers?: string | null
  equipment_plate_numbers?: string | null
  equipment_contractors?: string | null
  sender_name?: string | null
  uploaded_by_username?: string | null
  created_at?: string | null
}

interface PileFactFieldSummary {
  key: string
  time_label: string
  interval_label?: string | null
  section_label: string
  field_label: string
  kind: PileFactDetail['kind']
  total: number
  rows: number
}

interface EquipmentRatingItem {
  rank: number
  equipment_key: string
  label: string
  equipment_type: string
  brand_model?: string
  unit_number?: string
  plate_number?: string
  contractor?: string
  main: number
  test: number
  total: number
  day_total?: number
  night_total?: number
  status?: string | null
  status_source?: string | null
  status_date?: string | null
  status_comment?: string | null
  work_items: number
  sections: string[]
  fields?: PileFieldDetail[]
}

interface PileControlResponse {
  date: string
  mode?: DisplayMode
  period_label?: string
  interval_hours: number
  intervals: ControlInterval[]
  sections: ControlSection[]
  totals_by_interval: Record<string, IntervalFacts>
  problems: ControlProblem[]
  equipment_rating: EquipmentRatingItem[]
  fact_details?: PileFactDetail[]
}

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmt(value: number | null | undefined): string {
  return Math.round(Number(value || 0)).toLocaleString('ru-RU')
}

function fmtRate(value: number | null | undefined): string {
  return Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })
}


function sectionTone(section: ControlSection): 'red' | 'amber' | 'green' {
  if (section.total <= 0) return 'red'
  if (section.plan_total > 0 && section.total < section.plan_total) return 'amber'
  return 'green'
}

function intervalLevel(value: number, maxValue: number): number {
  if (value <= 0) return 0
  return Math.min(4, Math.ceil((value / Math.max(1, maxValue)) * 4))
}

function priorityLabel(priority: Priority): string {
  if (priority === 'red') return 'Красный'
  if (priority === 'yellow') return 'Желтый'
  return 'Зеленый'
}

function timeLabel(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

function sectionShortLabel(code: string): string {
  const match = String(code || '').match(/\d+/)
  return match ? `уч. ${match[0]}` : String(code || '').trim()
}

async function fetchPileControl(date: string, intervalHours: number, mode: DisplayMode, allTime = false): Promise<PileControlResponse> {
  const params = new URLSearchParams({ date, interval_hours: String(intervalHours), mode })
  if (allTime) params.set('all_time', '1')
  const res = await fetch(`/api/wip/pile-control/summary?${params.toString()}`)
  if (!res.ok) throw new Error(`Failed to fetch pile control: ${res.status}`)
  return res.json().catch(() => ({ ok: true }))
}

async function resolvePileControlProblem(problem: ControlProblem) {
  const issueIndex = problem.issue_index ?? Number(String(problem.id || '').split(':').pop())
  if (!problem.report_id || !Number.isFinite(issueIndex)) throw new Error('Не удалось определить проблемный вопрос')
  const res = await fetch(`/api/wip/pile-control/problems/${encodeURIComponent(problem.report_id)}/${issueIndex}/resolve`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Ошибка снятия вопроса' }))
    throw new Error(body.detail || 'Ошибка снятия вопроса')
  }
  return res.json()
}

const ZERO_FACTS: IntervalFacts = {
  main: 0,
  test: 0,
  dyn: 0,
  headcaps: 0,
  total: 0,
  plan_main: 0,
  plan_test: 0,
  plan_dyn: 0,
  plan_headcaps: 0,
  plan_total: 0,
}

function sumFacts(rows: Array<Partial<IntervalFacts> | undefined>): IntervalFacts {
  return rows.reduce((acc, row) => ({
    main: acc.main + Number(row?.main || 0),
    test: acc.test + Number(row?.test || 0),
    dyn: acc.dyn + Number(row?.dyn || 0),
    headcaps: acc.headcaps + Number(row?.headcaps || 0),
    total: acc.total + Number(row?.total || 0),
    plan_main: acc.plan_main + Number(row?.plan_main || 0),
    plan_test: acc.plan_test + Number(row?.plan_test || 0),
    plan_dyn: acc.plan_dyn + Number(row?.plan_dyn || 0),
    plan_headcaps: acc.plan_headcaps + Number(row?.plan_headcaps || 0),
    plan_total: acc.plan_total + Number(row?.plan_total || 0),
  }), { ...ZERO_FACTS })
}

function intervalStartHour(interval: ControlInterval): number {
  const match = String(interval.start || '').match(/T(\d{2}):/)
  return match ? Number(match[1]) : 0
}

function isDayShiftInterval(interval: ControlInterval): boolean {
  const hour = intervalStartHour(interval)
  return hour >= 8 && hour < 20
}

function sectionFactsForIntervals(section: ControlSection, intervals: ControlInterval[]): IntervalFacts {
  return sumFacts(intervals.map(interval => section.intervals[interval.key]))
}

function factsFromSection(section: ControlSection): IntervalFacts {
  return {
    ...ZERO_FACTS,
    main: Number(section.main || 0),
    test: Number(section.test || 0),
    dyn: Number(section.dyn || 0),
    headcaps: Number(section.headcaps || 0),
    total: Number(section.total || 0),
    plan_total: Number(section.plan_total || 0),
  }
}

function pileFactKindLabel(kind: PileFactDetail['kind'] | string | null | undefined): string {
  if (kind === 'main') return 'Основные'
  if (kind === 'test') return 'Пробные'
  if (kind === 'dyn') return 'Дин. испытания'
  if (kind === 'headcaps') return 'Оголовки'
  return 'Факт'
}

function factFieldLabel(detail: PileFactDetail): string {
  return [detail.field_code || 'Поле н/д', detail.pile_type, detail.pk_label].filter(Boolean).join(' · ')
}

function factEquipmentLabel(detail: PileFactDetail): string {
  return detail.equipment_label || [
    detail.equipment_unit_numbers ? `борт ${detail.equipment_unit_numbers}` : '',
    detail.equipment_plate_numbers ? `гос. ${detail.equipment_plate_numbers}` : '',
    detail.equipment_contractors || '',
  ].filter(Boolean).join(' · ')
}

function splitDetailTokens(value: string | null | undefined): string[] {
  return String(value || '')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizedDetailToken(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function equipmentDetailMatches(detail: PileFactDetail, item: EquipmentRatingItem): boolean {
  const equipmentKey = normalizedDetailToken(item.equipment_key)
  if (equipmentKey && splitDetailTokens(detail.equipment_keys).some(token => normalizedDetailToken(token) === equipmentKey)) return true

  const unitNumber = normalizedDetailToken(item.unit_number)
  if (unitNumber && splitDetailTokens(detail.equipment_unit_numbers).some(token => normalizedDetailToken(token) === unitNumber)) return true

  const plateNumber = normalizedDetailToken(item.plate_number)
  if (plateNumber && splitDetailTokens(detail.equipment_plate_numbers).some(token => normalizedDetailToken(token) === plateNumber)) return true

  const contractor = normalizedDetailToken(item.contractor)
  if (contractor && splitDetailTokens(detail.equipment_contractors).some(token => normalizedDetailToken(token) === contractor)) return true

  return false
}

function factsFromDetails(rows: PileFactDetail[]): IntervalFacts {
  return rows.reduce((acc, row) => {
    const amount = Number(row.count || 0)
    if (row.kind === 'test') acc.test += amount
    else if (row.kind === 'dyn') acc.dyn += amount
    else if (row.kind === 'headcaps') acc.headcaps += amount
    else acc.main += amount
    if (row.kind !== 'headcaps') acc.total += amount
    return acc
  }, { ...ZERO_FACTS })
}

function sectionSummariesFromDetails(rows: PileFactDetail[], fallbackSections: ControlSection[]): Array<{ code: string; label: string; facts: IntervalFacts }> {
  const labels = new Map(fallbackSections.map(section => [section.code, section.label]))
  const byCode = new Map<string, { code: string; label: string; rows: PileFactDetail[] }>()
  for (const detail of rows) {
    const code = String(detail.section_code || '')
    const label = detail.section_label || labels.get(code) || sectionShortLabel(code) || 'Участок н/д'
    const current = byCode.get(code) || { code, label, rows: [] }
    current.rows.push(detail)
    byCode.set(code, current)
  }
  return [...byCode.values()]
    .map(item => ({ code: item.code, label: item.label, facts: factsFromDetails(item.rows) }))
    .sort((a, b) => Number(b.facts.total || 0) - Number(a.facts.total || 0) || a.label.localeCompare(b.label, 'ru'))
}

function buildFieldSummaries(rows: PileFactDetail[]): PileFactFieldSummary[] {
  const byKey = new Map<string, PileFactFieldSummary>()
  for (const detail of rows) {
    const sectionLabel = detail.section_label || sectionShortLabel(String(detail.section_code || ''))
    const fieldLabel = factFieldLabel(detail)
    const time = timeLabel(detail.reported_at)
    const intervalLabel = detail.interval_label || ''
    const key = [time, intervalLabel, detail.section_code || sectionLabel, fieldLabel, detail.kind].join('|')
    const current = byKey.get(key) || {
      key,
      time_label: time || intervalLabel || 'время н/д',
      interval_label: intervalLabel,
      section_label: sectionLabel,
      field_label: fieldLabel,
      kind: detail.kind,
      total: 0,
      rows: 0,
    }
    current.total += Number(detail.count || 0)
    current.rows += 1
    byKey.set(key, current)
  }
  return [...byKey.values()].sort((a, b) => {
    const time = String(a.time_label || '').localeCompare(String(b.time_label || ''))
    if (time) return time
    const section = a.section_label.localeCompare(b.section_label, 'ru')
    if (section) return section
    return a.field_label.localeCompare(b.field_label, 'ru')
  })
}

function uniqueFactDetailCount(rows: PileFactDetail[], selector: (detail: PileFactDetail) => string): number {
  const values = new Set<string>()
  for (const detail of rows) {
    const value = selector(detail).trim()
    if (value) values.add(value)
  }
  return values.size
}

function detailMatchesFilter(detail: PileFactDetail, filter?: FactDetailFilter): boolean {
  if (!filter) return true
  if (filter.sectionCodes?.length && !filter.sectionCodes.includes(String(detail.section_code || ''))) return false
  if (filter.intervalKeys?.length && !filter.intervalKeys.includes(String(detail.interval_key || ''))) return false
  if (filter.kinds?.length && !filter.kinds.includes(detail.kind)) return false
  return true
}

function sortFactDetails(rows: PileFactDetail[]): PileFactDetail[] {
  return [...rows].sort((a, b) => {
    const time = String(a.reported_at || '').localeCompare(String(b.reported_at || ''))
    if (time) return time
    const section = String(a.section_code || '').localeCompare(String(b.section_code || ''), 'ru')
    if (section) return section
    const field = String(a.field_code || '').localeCompare(String(b.field_code || ''), 'ru')
    if (field) return field
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })
}

type FactScope = 'total' | 'day' | 'night'

interface PileFactModalState {
  title: string
  subtitle?: string
  facts: IntervalFacts
  sections: Array<{ code: string; label: string; facts: IntervalFacts }>
  fieldScope?: FactScope
  details: PileFactDetail[]
}

interface FactDetailFilter {
  sectionCodes?: string[]
  intervalKeys?: string[]
  kinds?: Array<PileFactDetail['kind']>
}

export default function PileControlPage({ standalone = false }: { standalone?: boolean }) {
  const [date, setDate] = useState(todayISO())
  const [intervalHours, setIntervalHours] = useState(3)
  const [factModal, setFactModal] = useState<PileFactModalState | null>(null)
  const [resolveError, setResolveError] = useState('')
  const { user, isAdmin } = useAuth()
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error } = useQuery<PileControlResponse>({
    queryKey: ['pile-control-summary', date, intervalHours, 'day'],
    queryFn: () => fetchPileControl(date, intervalHours, 'day'),
  })
  const intervals = data?.intervals ?? []
  const sections = useMemo(() => (data?.sections ?? []), [data])
  const factDetails = useMemo(() => sortFactDetails(data?.fact_details ?? []), [data?.fact_details])
  const factTotals = useMemo(() => sumFacts(sections.map(section => ({
    main: section.main,
    test: section.test,
    dyn: section.dyn,
    headcaps: section.headcaps,
    total: section.total,
    plan_total: section.plan_total,
  }))), [sections])
  const dayIntervals = useMemo(() => intervals.filter(isDayShiftInterval), [intervals])
  const nightIntervals = useMemo(() => intervals.filter(interval => !isDayShiftInterval(interval)), [intervals])
  const dayFacts = useMemo(() => sumFacts(dayIntervals.map(interval => data?.totals_by_interval?.[interval.key])), [data?.totals_by_interval, dayIntervals])
  const nightFacts = useMemo(() => sumFacts(nightIntervals.map(interval => data?.totals_by_interval?.[interval.key])), [data?.totals_by_interval, nightIntervals])
  const resolveProblemMutation = useMutation({
    mutationFn: resolvePileControlProblem,
    onMutate: () => setResolveError(''),
    onSuccess: (_result, problem) => {
      queryClient.setQueryData<PileControlResponse>(['pile-control-summary', date, intervalHours, 'day'], current => current
        ? { ...current, problems: current.problems.filter(item => item.id !== problem.id) }
        : current)
      return queryClient.invalidateQueries({ queryKey: ['pile-control-summary'] })
    },
    onError: error => setResolveError(error instanceof Error ? error.message : 'Не удалось отметить вопрос решенным'),
  })

  function filteredFactDetails(filter?: FactDetailFilter): PileFactDetail[] {
    return factDetails.filter(detail => detailMatchesFilter(detail, filter))
  }

  function openFactModal(title: string, subtitle: string | undefined, facts: IntervalFacts, sourceSections = sections, detailFilter?: FactDetailFilter) {
    const sectionCodes = sourceSections.map(section => section.code)
    const effectiveFilter: FactDetailFilter = {
      ...detailFilter,
      sectionCodes: detailFilter?.sectionCodes ?? sectionCodes,
    }
    setFactModal({
      title,
      subtitle,
      facts,
      fieldScope: 'total',
      details: filteredFactDetails(effectiveFilter),
      sections: sourceSections.map(section => ({
        code: section.code,
        label: section.label,
        facts: 'intervals' in section ? {
          ...ZERO_FACTS,
          main: Number(section.main || 0),
          test: Number(section.test || 0),
          dyn: Number(section.dyn || 0),
          headcaps: Number(section.headcaps || 0),
          total: Number(section.total || 0),
          plan_total: Number(section.plan_total || 0),
        } : ZERO_FACTS,
      })),
    })
  }

  function openShiftModal(title: string, subtitle: string, facts: IntervalFacts, shiftIntervals: ControlInterval[], fieldScope: FactScope) {
    const intervalKeys = shiftIntervals.map(interval => interval.key)
    setFactModal({
      title,
      subtitle,
      facts,
      fieldScope,
      details: filteredFactDetails({ intervalKeys }),
      sections: sections.map(section => ({
        code: section.code,
        label: section.label,
        facts: sectionFactsForIntervals(section, shiftIntervals),
      })),
    })
  }

  function openSectionFacts(section: ControlSection) {
    openFactModal(`${section.label} · факт за сутки`, data?.period_label, factsFromSection(section), [section], { sectionCodes: [section.code] })
  }

  function openIntervalFacts(section: ControlSection, interval: ControlInterval, facts: IntervalFacts) {
    setFactModal({
      title: `${section.label} · ${interval.label}`,
      subtitle: `${interval.start.replace('T', ' ').slice(0, 16)}-${interval.end.replace('T', ' ').slice(11, 16)}`,
      facts,
      fieldScope: isDayShiftInterval(interval) ? 'day' : 'night',
      details: filteredFactDetails({ sectionCodes: [section.code], intervalKeys: [interval.key] }),
      sections: [{ code: section.code, label: section.label, facts }],
    })
  }

  function openEquipmentFacts(item: EquipmentRatingItem, scope: FactScope) {
    const intervalKeys = scope === 'day'
      ? dayIntervals.map(interval => interval.key)
      : scope === 'night'
        ? nightIntervals.map(interval => interval.key)
        : undefined
    const details = factDetails.filter(detail => {
      if (!equipmentDetailMatches(detail, item)) return false
      if (detail.kind !== 'main' && detail.kind !== 'test') return false
      if (intervalKeys?.length && !intervalKeys.includes(String(detail.interval_key || ''))) return false
      return true
    })
    const facts = factsFromDetails(details)
    const fallbackTotal = scope === 'day' ? Number(item.day_total || 0) : scope === 'night' ? Number(item.night_total || 0) : Number(item.total || 0)
    if (facts.total <= 0 && fallbackTotal > 0) facts.total = fallbackTotal
    const scopeLabel = scope === 'day' ? 'день 08:00-20:00' : scope === 'night' ? 'ночь 20:00-08:00' : 'сутки'
    setFactModal({
      title: `${item.label} · ${scopeLabel}`,
      subtitle: data?.period_label,
      facts,
      fieldScope: scope,
      details,
      sections: sectionSummariesFromDetails(details, sections),
    })
  }

  return (
    <div className={`pc-page ${standalone ? 'pc-page--standalone' : ''}`}>
      <header className="pc-appbar">
        <div className="flex min-w-0 items-center gap-3">
          <LandPlot className="h-6 w-6 shrink-0 text-white" />
          <div className="titles">
            <h1>Контроль свай</h1>
            <div className="sub">Операционные сутки 08:00-08:00 с разбивкой по временным промежуткам.</div>
          </div>
        </div>
        <div className="controls">
          <label className="control">
            <CalendarDays className="h-4 w-4" />
            <input type="date" value={date} onChange={event => setDate(event.target.value)} />
          </label>
          <label className="control">
            <Clock3 className="h-4 w-4" />
            <select value={intervalHours} onChange={event => setIntervalHours(Number(event.target.value))}>
              <option value={1}>1 час</option>
              <option value={2}>2 часа</option>
              <option value={3}>3 часа</option>
              <option value={4}>4 часа</option>
              <option value={6}>6 часов</option>
              <option value={12}>12 часов</option>
            </select>
          </label>
        </div>
      </header>

      {isLoading ? (
        <div className="h-72 animate-pulse rounded-lg border border-border bg-white" />
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error instanceof Error ? error.message : 'Ошибка загрузки контроля свай'}</div>
      ) : data ? (
        <>
          <ProblemsStrip
            problems={data.problems}
            currentUsername={user?.username || null}
            isAdmin={isAdmin}
            resolvingId={resolveProblemMutation.isPending ? resolveProblemMutation.variables?.id || null : null}
            resolveError={resolveError}
            onResolve={problem => resolveProblemMutation.mutate(problem)}
          />

          <div className="pc-kpis">
            <SummaryCard label="Факт за сутки" value={`${fmt(factTotals.total)} шт`} tone={factTotals.total > 0 ? 'ok' : 'warn'} onClick={() => openFactModal('Факт за сутки', data.period_label, factTotals)} />
            <SummaryCard label="Факт за день" value={`${fmt(dayFacts.total)} шт`} sub="08:00-20:00" tone={dayFacts.total > 0 ? 'ok' : 'warn'} onClick={() => openShiftModal('Факт за день', '08:00-20:00', dayFacts, dayIntervals, 'day')} />
            <SummaryCard label="Факт за ночь" value={`${fmt(nightFacts.total)} шт`} sub="20:00-08:00" tone={nightFacts.total > 0 ? 'ok' : 'warn'} onClick={() => openShiftModal('Факт за ночь', '20:00-08:00', nightFacts, nightIntervals, 'night')} />
            <SummaryCard
              label="Основные"
              value={`${fmt(factTotals.main)} шт`}
              onClick={() => setFactModal({
                title: 'Основные сваи',
                subtitle: data.period_label,
                facts: { ...ZERO_FACTS, main: factTotals.main, total: factTotals.main },
                fieldScope: 'total',
                details: filteredFactDetails({ kinds: ['main'] }),
                sections: sections.map(section => ({ code: section.code, label: section.label, facts: { ...ZERO_FACTS, main: section.main, total: section.main } })),
              })}
            />
            <SummaryCard
              label="Пробные"
              value={`${fmt(factTotals.test)} шт`}
              onClick={() => setFactModal({
                title: 'Пробные сваи',
                subtitle: data.period_label,
                facts: { ...ZERO_FACTS, test: factTotals.test, total: factTotals.test },
                fieldScope: 'total',
                details: filteredFactDetails({ kinds: ['test'] }),
                sections: sections.map(section => ({ code: section.code, label: section.label, facts: { ...ZERO_FACTS, test: section.test, total: section.test } })),
              })}
            />
          </div>

          <section className="space-y-3">
            <SectionTitle title="Интервальные карточки" subtitle={`шаг ${data.interval_hours} ч`} />
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {sections.map(section => (
                <SectionIntervalCard
                  key={section.code}
                  section={section}
                  intervals={intervals}
                  onOpenFacts={(interval, facts) => openIntervalFacts(section, interval, facts)}
                  onOpenSectionFacts={() => openSectionFacts(section)}
                />
              ))}
            </div>
          </section>

          <IntervalMatrix intervals={intervals} sections={sections} onOpenFacts={openIntervalFacts} onOpenSectionFacts={openSectionFacts} />

          <PileEquipmentPark rating={data.equipment_rating || []} isLoading={isLoading} periodLabel={data.period_label || data.date} onOpenFacts={openEquipmentFacts} />

          <PilePedestalBlock data={data} rating={data.equipment_rating || []} isLoading={isLoading} />
          <PileFactModal state={factModal} onClose={() => setFactModal(null)} />
        </>
      ) : null}
    </div>
  )
}



function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="pc-section-title">{title}</div>
      <div className="h-px min-w-8 flex-1 bg-[var(--pc-border)]" />
      <div className="text-right text-[11px] font-medium text-[var(--pc-text-2)]">{subtitle}</div>
    </div>
  )
}

function SummaryCard({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'crit'; onClick?: () => void }) {
  const className = `pc-kpi ${tone || ''} ${onClick ? 'pc-kpi--button' : ''}`
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={`Детализация: ${label}`} aria-label={`Детализация: ${label}, ${value}`}>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {sub ? <div className="hint">{sub}</div> : null}
      </button>
    )
  }
  return (
    <div className={className}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="hint">{sub}</div> : null}
    </div>
  )
}

function isOwnEquipmentItem(item: EquipmentRatingItem): boolean {
  const contractor = String(item.contractor || '').trim().toLowerCase().replace('ё', 'е')
  return contractor === 'ждс' || contractor === 'ооо ждс' || contractor.includes('желдорстрой')
}

function equipmentUnitSortKey(item: EquipmentRatingItem): [number, number, string, number, string, string, string] {
  const unit = String(item.unit_number || '').trim()
  const plate = String(item.plate_number || '').trim()
  const numericUnit = /^\d+$/.test(unit)
  const hasUnit = Boolean(unit)
  const ownerBucket = isOwnEquipmentItem(item) ? 0 : 1
  const group = numericUnit && ownerBucket === 0
    ? 0
    : numericUnit
      ? 1
      : hasUnit && ownerBucket === 0
        ? 2
        : hasUnit
          ? 3
          : ownerBucket === 0
            ? 4
            : 5
  return [
    group,
    numericUnit ? Number(unit) : Number.MAX_SAFE_INTEGER,
    unit,
    ownerBucket,
    ownerBucket ? String(item.contractor || '').trim().toLowerCase() : '',
    String(item.brand_model || item.equipment_type || item.label || '').trim().toLowerCase(),
    plate,
  ]
}

function equipmentStatusLabel(status?: string | null): string {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'working') return 'в работе'
  if (normalized === 'repair') return 'ремонт'
  if (normalized === 'standby') return 'ожидание'
  if (normalized === 'idle') return 'простой'
  if (normalized === 'unknown') return 'статус н/д'
  return status ? String(status) : 'статус н/д'
}

function equipmentStatusClass(status?: string | null): string {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'working') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (normalized === 'repair') return 'border-red-200 bg-red-50 text-red-700'
  if (normalized === 'standby' || normalized === 'idle') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
}

const PILE_EQUIPMENT_DAY_SCALE_MAX = 40

function PileEquipmentPark({
  rating,
  isLoading,
  periodLabel,
  onOpenFacts,
}: {
  rating: EquipmentRatingItem[]
  isLoading: boolean
  periodLabel: string
  onOpenFacts?: (item: EquipmentRatingItem, scope: FactScope) => void
}) {
  const sortedRating = useMemo(() => [...rating].sort((a, b) => {
    const ka = equipmentUnitSortKey(a)
    const kb = equipmentUnitSortKey(b)
    return ka[0] - kb[0]
      || ka[1] - kb[1]
      || ka[2].localeCompare(kb[2], 'ru')
      || ka[3] - kb[3]
      || ka[4].localeCompare(kb[4], 'ru')
      || ka[5].localeCompare(kb[5], 'ru')
      || ka[6].localeCompare(kb[6], 'ru')
  }), [rating])
  const maxDayFact = PILE_EQUIPMENT_DAY_SCALE_MAX
  if (isLoading) return <div className="pc-section h-48 animate-pulse" />
  return (
    <section className="pc-section">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LandPlot className="h-4 w-4 text-[var(--pc-accent)]" />
        <h2>Парк установок</h2>
        <span className="ml-auto text-xs text-[var(--pc-text-2)]">{periodLabel}</span>
      </div>
      {sortedRating.length === 0 ? (
        <div className="pc-empty">Данных по установкам пока нет.</div>
      ) : (
        <div className="space-y-2">
          {sortedRating.map(item => {
            const sectionLabel = (item.sections || []).map(sectionShortLabel).filter(Boolean).join(', ')
            const fieldLabel = (item.fields || []).map(field => {
              const section = field.section_code ? sectionShortLabel(field.section_code) : ''
              const fieldName = field.field_code ? `поле ${field.field_code}` : ''
              return [section, fieldName, field.pk_label].filter(Boolean).join(' · ')
            }).filter(Boolean).join('; ')
            const details = [
              item.equipment_type,
              item.brand_model,
              item.unit_number ? `борт ${item.unit_number}` : null,
              item.plate_number ? `гос ${item.plate_number}` : null,
              item.contractor,
              !fieldLabel && sectionLabel ? `участки: ${sectionLabel}` : null,
            ].filter(Boolean).join(' · ')
            const dayFact = Number(item.day_total || 0)
            const fillPct = maxDayFact > 0 ? Math.max(0, Math.min(100, dayFact / maxDayFact * 100)) : 0
            const statusMeta = [item.status_source, item.status_date].filter(Boolean).join(' · ')
            return (
              <div key={item.equipment_key || item.label} className="pc-rank-row">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(300px,auto)] md:items-start">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--pc-text)]">{item.label}</div>
                    <div className="mt-0.5 text-xs text-[var(--pc-text-2)]">{details || 'единица техники'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className={`inline-flex rounded border px-1.5 py-0.5 font-semibold ${equipmentStatusClass(item.status)}`}>{equipmentStatusLabel(item.status)}</span>
                      {statusMeta ? <span className="text-[var(--pc-text-2)]">{statusMeta}</span> : null}
                      {item.status_comment ? <span className="text-[var(--pc-text-2)]">· {item.status_comment}</span> : null}
                    </div>
                    {fieldLabel ? <div className="mt-1 text-xs font-medium text-[var(--pc-text)]">Работает: {fieldLabel}</div> : null}
                  </div>
                  <div>
                    <div className="grid grid-cols-3 gap-2 text-right">
                      <EquipmentFactButton label="Всего" value={item.total} detailLabel={`${item.label}, всего`} textTone="strong" onClick={onOpenFacts && item.total > 0 ? () => onOpenFacts(item, 'total') : undefined} />
                      <EquipmentFactButton label="День" value={item.day_total} detailLabel={`${item.label}, день`} onClick={onOpenFacts && Number(item.day_total || 0) > 0 ? () => onOpenFacts(item, 'day') : undefined} />
                      <EquipmentFactButton label="Ночь" value={item.night_total} detailLabel={`${item.label}, ночь`} onClick={onOpenFacts && Number(item.night_total || 0) > 0 ? () => onOpenFacts(item, 'night') : undefined} />
                    </div>
                    <div className="mt-2">
                      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase text-[var(--pc-text-2)]">
                        <span>Шкала дневной забивки</span>
                        <span className="font-mono">{fmt(dayFact)} / {fmt(maxDayFact)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#E3E8EE]">
                        <div className="h-full rounded-full bg-[var(--pc-crit)]" style={{ width: `${fillPct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}


function EquipmentFactButton({
  label,
  value,
  detailLabel,
  textTone = 'muted',
  onClick,
}: {
  label: string
  value: number | null | undefined
  detailLabel?: string
  textTone?: 'strong' | 'muted'
  onClick?: () => void
}) {
  const className = `pc-equipment-fact-button ${onClick ? 'pc-equipment-fact-button--active' : ''}`
  const valueClass = textTone === 'strong' ? 'text-[var(--pc-text)]' : 'text-[var(--pc-text-2)]'
  if (!onClick) {
    return (
      <div className={className}>
        <div className="text-[10px] font-semibold uppercase text-[var(--pc-text-2)]">{label}</div>
        <div className={`font-mono text-lg font-semibold ${valueClass}`}>{fmt(value)}</div>
      </div>
    )
  }
  return (
    <button type="button" className={className} onClick={onClick} title={`Детализация: ${detailLabel || label}`} aria-label={`Детализация: ${detailLabel || label}, ${fmt(value)} шт`}>
      <div className="text-[10px] font-semibold uppercase text-[var(--pc-text-2)]">{label}</div>
      <div className={`font-mono text-lg font-semibold ${valueClass}`}>{fmt(value)}</div>
    </button>
  )
}

function PilePedestalBlock({
  data,
  rating,
  isLoading,
}: {
  data?: PileControlResponse
  rating: EquipmentRatingItem[]
  isLoading: boolean
}) {
  const equipmentBySection = new Map<string, Set<string>>()
  for (const item of rating || []) {
    const equipmentKey = item.equipment_key || item.label
    const sectionCodes = new Set<string>()
    for (const field of item.fields || []) {
      if (field.section_code) sectionCodes.add(String(field.section_code))
    }
    if (sectionCodes.size === 0) {
      for (const section of item.sections || []) {
        if (section) sectionCodes.add(String(section))
      }
    }
    for (const sectionCode of sectionCodes) {
      if (!equipmentBySection.has(sectionCode)) equipmentBySection.set(sectionCode, new Set<string>())
      equipmentBySection.get(sectionCode)?.add(equipmentKey)
    }
  }

  const leaders = (data?.sections ?? [])
    .map(section => {
      const drivenTotal = Number(section.main || 0) + Number(section.test || 0)
      const installations = equipmentBySection.get(section.code)?.size || 0
      const productivity = installations > 0 ? drivenTotal / installations : 0
      return { ...section, drivenTotal, installations, productivity }
    })
    .filter(section => section.drivenTotal > 0)
    .sort((a, b) => b.productivity - a.productivity || b.drivenTotal - a.drivenTotal || a.label.localeCompare(b.label, 'ru'))
    .slice(0, 3)
  const slots = [
    { place: 2, leader: leaders[1], height: 'h-28', tone: 'bg-[#E3E8EE]', label: 'II' },
    { place: 1, leader: leaders[0], height: 'h-36', tone: 'bg-[var(--pc-navy)] text-white', label: 'I' },
    { place: 3, leader: leaders[2], height: 'h-24', tone: 'bg-[#F0D6C2]', label: 'III' },
  ]
  if (isLoading) return <div className="pc-section h-56 animate-pulse" />
  return (
    <section className="pc-section">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Trophy className="h-4 w-4 text-[var(--pc-accent)]" />
        <h2>Пьедестал участков</h2>
        <span className="ml-auto text-xs text-[var(--pc-text-2)]">{data?.period_label || 'эффективность за текущие сутки'}</span>
      </div>
      <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
        {slots.map(slot => (
          <div key={slot.place} className="flex min-h-[205px] flex-col justify-end rounded-md border border-[var(--pc-border)] bg-[#F6F8FA] p-3">
            {slot.leader ? (
              <>
                <div className="mb-2 text-center">
                  <div className="text-[11px] font-semibold uppercase text-[var(--pc-text-2)]">{slot.place === 1 ? 'Чемпион' : `${slot.place} место`}</div>
                  <div className="mt-1 text-base font-bold text-[var(--pc-text)]">{slot.leader.label}</div>
                  <div className="font-mono text-lg font-bold text-[var(--pc-navy)]">{fmtRate(slot.leader.productivity)} шт/уст.</div>
                  <div className="text-xs text-[var(--pc-text-2)]">{fmt(slot.leader.drivenTotal)} шт · {fmt(slot.leader.installations)} уст.</div>
                  <div className="text-xs text-[var(--pc-text-2)]">осн. {fmt(slot.leader.main)} · проб. {fmt(slot.leader.test)}</div>
                </div>
                <div className={`${slot.height} ${slot.tone} flex items-center justify-center rounded-t-md text-3xl font-bold shadow-sm`}>{slot.label}</div>
              </>
            ) : (
              <>
                <div className="mb-2 text-center text-xs text-[var(--pc-text-2)]">Нет данных</div>
                <div className={`${slot.height} flex items-center justify-center rounded-t-md bg-white text-2xl font-bold text-[var(--pc-text-2)]`}>{slot.label}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function ProblemsStrip({
  problems,
  currentUsername,
  isAdmin,
  resolvingId,
  resolveError,
  onResolve,
}: {
  problems: ControlProblem[]
  currentUsername: string | null
  isAdmin: boolean
  resolvingId?: string | null
  resolveError?: string
  onResolve: (problem: ControlProblem) => void
}) {
  return (
    <section className="pc-section">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-[var(--pc-crit)]" />
        <h2>Проблемные вопросы</h2>
        <span className="text-xs text-[var(--pc-text-2)]">активны 24 часа</span>
      </div>
      {resolveError ? <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{resolveError}</div> : null}
      {problems.length === 0 ? (
        <div className="pc-issue--empty">Активных проблемных вопросов нет.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          {problems.map(problem => {
            const canResolve = isAdmin || Boolean(currentUsername && problem.created_by === currentUsername)
            return (
              <div key={problem.id} className={`pc-issue pc-issue--${problem.priority}`}>
                <div className="top">
                  <span>{priorityLabel(problem.priority)}</span>
                  <span>{problem.section_name || problem.section_code || 'участок н/д'}</span>
                </div>
                <div className="text">{problem.text}</div>
                <div className="meta">{timeLabel(problem.reported_at)} · до {timeLabel(problem.expires_at)}{problem.created_by ? ` · ${problem.created_by}` : ''}</div>
                {canResolve ? (
                  <button
                    type="button"
                    onClick={() => onResolve(problem)}
                    disabled={resolvingId === problem.id}
                    className="mt-2 inline-flex items-center gap-1 rounded border border-white/70 bg-white px-2 py-1 text-[11px] font-semibold text-[var(--pc-text)] hover:border-[var(--pc-ok)] hover:text-[var(--pc-ok)] disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {resolvingId === problem.id ? 'Отмечаем...' : 'Решен'}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SectionIntervalCard({
  section,
  intervals,
  onOpenFacts,
  onOpenSectionFacts,
}: {
  section: ControlSection
  intervals: ControlInterval[]
  onOpenFacts: (interval: ControlInterval, facts: IntervalFacts) => void
  onOpenSectionFacts: () => void
}) {
  const maxValue = Math.max(1, ...intervals.map(interval => Number(section.intervals[interval.key]?.total || 0)))
  const tone = sectionTone(section)
  return (
    <div className="pc-section">
      <div className="pc-uchastok-head">
        <div className="name">
          <span className={`pc-dot ${tone}`} />
          <span>{section.label}</span>
        </div>
        <button type="button" className="pc-total-pill pc-total-pill--button" onClick={onOpenSectionFacts} title={`Детализация: ${section.label}`} aria-label={`Детализация: ${section.label}, ${fmt(section.total)} шт`}>{fmt(section.total)} шт</button>
      </div>
      {section.total <= 0 ? (
        <div className="pc-empty">Нет поданных данных по участку за выбранные сутки.</div>
      ) : (
        <div className="pc-heat">
          {intervals.map(interval => {
            const facts = section.intervals[interval.key]
            const value = Number(facts?.total || 0)
            return (
              <button key={interval.key} type="button" className="pc-cell text-left" data-level={intervalLevel(value, maxValue)} onClick={() => onOpenFacts(interval, facts || ZERO_FACTS)} title={`Детализация: ${section.label}, ${interval.label}`} aria-label={`Детализация: ${section.label}, ${interval.label}, ${fmt(value)} шт`}>
                <div className="t">{interval.label}</div>
                <div className="v">{fmt(value)}<em>шт</em></div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


function PileFactModal({ state, onClose }: { state: PileFactModalState | null; onClose: () => void }) {
  if (!state) return null
  const activeSections = state.sections
    .filter(section => Number(section.facts.total || section.facts.main || section.facts.test || section.facts.dyn || section.facts.headcaps || 0) > 0)
    .sort((a, b) => Number(b.facts.total || 0) - Number(a.facts.total || 0))
  const details = sortFactDetails(state.details || [])
  const fieldSummaries = buildFieldSummaries(details)
  const uniqueTimes = uniqueFactDetailCount(details, detail => timeLabel(detail.reported_at))
  const uniqueFields = uniqueFactDetailCount(details, detail => factFieldLabel(detail))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div className="max-h-[86vh] w-full max-w-5xl overflow-auto rounded-lg border border-[var(--pc-border)] bg-white shadow-xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--pc-border)] px-4 py-3">
          <div>
            <h3 className="text-base font-bold text-[var(--pc-text)]">{state.title}</h3>
            {state.subtitle ? <div className="text-xs text-[var(--pc-text-2)]">{state.subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-[var(--pc-text-2)] hover:bg-[#F6F8FA] hover:text-[var(--pc-text)]" aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <FactPill label="Всего" value={state.facts.total} />
            <FactPill label="Основные" value={state.facts.main} />
            <FactPill label="Пробные" value={state.facts.test} />
            <FactPill label="Дин. испытания" value={state.facts.dyn} />
            <FactPill label="Оголовки" value={state.facts.headcaps} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <FactPill label="Времен" value={uniqueTimes} />
            <FactPill label="Полей" value={uniqueFields} />
            <FactPill label="Исходных строк" value={details.length} />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pc-text-2)]">Время забивки и поля</div>
              <span className="rounded border border-[var(--pc-border)] bg-[#F6F8FA] px-2 py-0.5 text-[11px] font-semibold text-[var(--pc-text-2)]">строк: {fieldSummaries.length}</span>
            </div>
            {fieldSummaries.length ? (
              <div className="overflow-auto rounded border border-[var(--pc-border)]">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-[#F6F8FA] text-xs uppercase tracking-wide text-[var(--pc-text-2)]">
                    <tr>
                      <th className="px-3 py-2 text-left">Время забивки</th>
                      <th className="px-3 py-2 text-left">Участок</th>
                      <th className="px-3 py-2 text-left">Поле / пикетаж</th>
                      <th className="px-3 py-2 text-left">Вид</th>
                      <th className="px-3 py-2 text-right">Кол-во</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldSummaries.map(summary => (
                      <tr key={summary.key} className="border-t border-[var(--pc-border)] align-top">
                        <td className="whitespace-nowrap px-3 py-2">
                          <div className="font-mono text-xs">{summary.time_label}</div>
                          {summary.interval_label ? <div className="mt-0.5 text-[11px] text-[var(--pc-text-2)]">{summary.interval_label}</div> : null}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-semibold">{summary.section_label}</td>
                        <td className="px-3 py-2">{summary.field_label}</td>
                        <td className="whitespace-nowrap px-3 py-2">{pileFactKindLabel(summary.kind)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold">{fmt(summary.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="pc-empty">Нет привязки к полям по выбранной карточке.</div>}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--pc-text-2)]">Участки</div>
            {activeSections.length ? (
              <div className="overflow-auto rounded border border-[var(--pc-border)]">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-[#F6F8FA] text-xs uppercase tracking-wide text-[var(--pc-text-2)]">
                    <tr>
                      <th className="px-3 py-2 text-left">Участок</th>
                      <th className="px-3 py-2 text-right">Всего</th>
                      <th className="px-3 py-2 text-right">Основные</th>
                      <th className="px-3 py-2 text-right">Пробные</th>
                      <th className="px-3 py-2 text-right">Дин.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSections.map(section => (
                      <tr key={section.code} className="border-t border-[var(--pc-border)]">
                        <td className="px-3 py-2 font-semibold">{section.label}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(section.facts.total)}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(section.facts.main)}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(section.facts.test)}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(section.facts.dyn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="pc-empty">Нет факта по выбранному периоду.</div>}
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pc-text-2)]">Детализация забивки</div>
              <span className="rounded border border-[var(--pc-border)] bg-[#F6F8FA] px-2 py-0.5 text-[11px] font-semibold text-[var(--pc-text-2)]">строк: {details.length}</span>
            </div>
            {details.length ? (
              <div className="overflow-auto rounded border border-[var(--pc-border)]">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-[#F6F8FA] text-xs uppercase tracking-wide text-[var(--pc-text-2)]">
                    <tr>
                      <th className="px-3 py-2 text-left">Время</th>
                      <th className="px-3 py-2 text-left">Участок</th>
                      <th className="px-3 py-2 text-left">Поле</th>
                      <th className="px-3 py-2 text-left">Вид</th>
                      <th className="px-3 py-2 text-right">Кол-во</th>
                      <th className="px-3 py-2 text-left">Техника</th>
                      <th className="px-3 py-2 text-left">Автор</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((detail, index) => {
                      const author = [detail.sender_name, detail.uploaded_by_username].filter(Boolean).join(' · ')
                      const equipment = factEquipmentLabel(detail)
                      return (
                        <tr key={`${detail.report_id || ''}-${detail.work_item_id || ''}-${detail.segment_id || ''}-${index}`} className="border-t border-[var(--pc-border)] align-top">
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{timeLabel(detail.reported_at)}</td>
                          <td className="whitespace-nowrap px-3 py-2 font-semibold">{detail.section_label || sectionShortLabel(String(detail.section_code || ''))}</td>
                          <td className="px-3 py-2">{factFieldLabel(detail)}</td>
                          <td className="whitespace-nowrap px-3 py-2">{pileFactKindLabel(detail.kind)}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold">{fmt(detail.count)}</td>
                          <td className="px-3 py-2 text-xs text-[var(--pc-text-2)]">{equipment || 'техника н/д'}</td>
                          <td className="px-3 py-2 text-xs text-[var(--pc-text-2)]">{author || 'автор н/д'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="pc-empty">Нет детальных строк по выбранной карточке.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function FactPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-[var(--pc-border)] bg-[#F6F8FA] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--pc-text-2)]">{label}</div>
      <div className="font-mono text-lg font-bold text-[var(--pc-text)]">{fmt(value)}</div>
    </div>
  )
}

function IntervalMatrix({
  intervals,
  sections,
  onOpenFacts,
  onOpenSectionFacts,
}: {
  intervals: ControlInterval[]
  sections: ControlSection[]
  onOpenFacts: (section: ControlSection, interval: ControlInterval, facts: IntervalFacts) => void
  onOpenSectionFacts: (section: ControlSection) => void
}) {
  return (
    <section className="pc-section overflow-hidden">
      <div className="mb-4">
        <h2>Матрица контроля</h2>
      </div>
      <div className="overflow-auto">
        <table className="pc-matrix">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 text-left">Участок</th>
              {intervals.map(interval => <th key={interval.key} className="text-right">{interval.label}</th>)}
              <th className="text-right">Итого</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(section => (
              <tr key={section.code}>
                <td className="sticky left-0 bg-white font-semibold">{section.label}</td>
                {intervals.map(interval => {
                  const facts = section.intervals[interval.key]
                  const value = Number(facts?.total || 0)
                  return (
                    <td key={interval.key} className={`${value > 0 ? 'hot' : 'zero'} text-right font-mono`}>
                      <button
                        type="button"
                        className="pc-matrix-value"
                        onClick={() => onOpenFacts(section, interval, facts || ZERO_FACTS)}
                        aria-label={`${section.label}, ${interval.label}: ${fmt(value)} шт`}
                      >
                        {fmt(value)}
                      </button>
                    </td>
                  )
                })}
                <td className="total text-right font-mono">
                  <button
                    type="button"
                    className="pc-matrix-value"
                    onClick={() => onOpenSectionFacts(section)}
                    aria-label={`${section.label}, итого: ${fmt(section.total)} шт`}
                  >
                    {fmt(section.total)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
