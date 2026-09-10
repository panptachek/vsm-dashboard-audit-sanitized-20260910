import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CalendarDays, Hammer, LandPlot, Sigma, Truck, X } from 'lucide-react'

type ApiMode = 'cumulative' | 'date'
type TotalScope = 'month' | 'all'

interface SectionKpi {
  code: string
  label: string
  main: number
  test: number
  dyn?: number
  headcaps?: number
  total: number
  plan_main?: number
  plan_test?: number
  plan_dyn?: number
  plan_headcaps?: number
  plan_total?: number
  month_plan_main?: number
  month_plan_test?: number
  month_plan_dyn?: number
  month_plan_headcaps?: number
  month_plan_total?: number
  project_main?: number
  project_test?: number
  project_dyn?: number
  project_total?: number
  delta?: number
  month_delta?: number
  project_delta?: number
}

interface PileLengthFact {
  length_m?: number | null
  count: number
}

interface DayFacts {
  main: number
  test: number
  dyn?: number
  headcaps?: number
  total: number
  plan_main?: number
  plan_test?: number
  plan_dyn?: number
  plan_headcaps?: number
  plan_total?: number
  fact_lengths?: PileLengthFact[]
  fact_details?: ReinforcementDetail[]
  plan_details?: ReinforcementDetail[]
}

interface ReinforcementDetailPileRig {
  key: string
  name: string
  unit_number?: string | null
  plate_number?: string | null
  ownership_label?: string | null
  piles_count?: number
  notes?: string[]
}

interface ReinforcementDetail {
  section_code: string
  field_name: string
  pk_range: string
  pk_ranges?: string[]
  segments?: number
  main: number
  test: number
  dyn: number
  headcaps: number
  total: number
  project_main?: number
  project_test?: number
  project_dyn?: number
  project_total?: number
  report_count: number
  first_date?: string | null
  last_date?: string | null
  pile_rigs?: ReinforcementDetailPileRig[]
}

interface ReinforcementResponse {
  date: string
  mode: ApiMode
  plan_available: boolean
  sections: SectionKpi[]
  calendar: {
    month: string
    days: string[]
    rows: { code: string; label: string; days: Record<string, DayFacts> }[]
    totals_by_day: Record<string, DayFacts>
  }
  dynamic: { date: string; plan: number; by_section: Record<string, number>; total: number }[]
  details?: {
    month?: Record<string, ReinforcementDetail[]>
    all?: Record<string, ReinforcementDetail[]>
  } | null
  pile_rigs?: ReinforcementPileRigs | null
}

interface PileDeliveryDay {
  plan: number
  fact: number
}

interface PileDeliveryRow {
  supplier: string
  spec_display: string
  spec_code?: string | null
  spec_code_display?: string | null
  length_m?: number | null
  placement_side?: 'ns' | 'vs' | null
  days: Record<string, PileDeliveryDay>
  month_plan: number
  month_fact: number
}

interface PileDeliverySummary {
  available: boolean
  date: string
  month: string
  days: string[]
  rows: PileDeliveryRow[]
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

type PileRigStatus = 'performing_plan' | 'working' | 'idle' | string

interface ReinforcementPileRigSectionRef {
  key: string
  name: string
  unit_number?: string | null
  plate_number?: string | null
  ownership_label?: string | null
  status: PileRigStatus
  piles_count: number
  rank?: number | null
}

interface ReinforcementPileRigDetail {
  section_code: string
  section_label: string
  field_name: string
  main: number
  test: number
  total: number
  report_count: number
  first_date?: string | null
  last_date?: string | null
  notes?: string[]
}

interface ReinforcementPileRig extends ReinforcementPileRigSectionRef {
  plate_number?: string | null
  contractor_name?: string | null
  working_sections?: string[]
  working_days?: string[]
  notes?: string[]
  details: ReinforcementPileRigDetail[]
}

interface ReinforcementPileRigs {
  period: { from: string; to: string }
  items: ReinforcementPileRig[]
  by_section: Record<string, ReinforcementPileRigSectionRef[]>
}

interface CalendarCellPopupState {
  title: string
  day: string
  facts: DayFacts
  color?: string
  kind?: 'piles' | 'headcaps'
}

const EMPTY_DAY_FACTS: DayFacts = {
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
  fact_lengths: [],
  fact_details: [],
  plan_details: [],
}

const SECTION_COLORS = ['#dc2626', '#f59e0b', '#eab308', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777']
const WEEKDAY_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']
const CALENDAR_PLAN_LABEL_CLASS = 'border-sky-200 bg-sky-50 text-sky-900'
const CALENDAR_PLAN_TOTAL_CLASS = 'border-sky-200 bg-sky-50 font-mono font-semibold text-sky-900'
const CALENDAR_PLAN_MARKER_CLASS = 'bg-sky-500'

function reportDefaultDateISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU')
}

function signed(n: number): string {
  const rounded = Math.round(n)
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('ru-RU')}`
}

function dayLabel(value: string): string {
  const [, m, d] = value.split('-')
  return `${d}.${m}`
}

function monthLabel(value: string): string {
  const [year, month] = value.split('-')
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
  const idx = Number(month) - 1
  return `${names[idx] ?? month} ${year}`
}

function dateObj(iso: string): Date {
  return new Date(`${iso}T00:00:00`)
}

function sectionNumber(code: string): number {
  const n = Number(code.replace(/\D/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 1
}

function colorForSection(code: string): string {
  return SECTION_COLORS[(sectionNumber(code) - 1) % SECTION_COLORS.length]
}

function pct(fact: number, plan: number): number {
  return plan > 0 ? Math.max(0, Math.min(100, Math.round(fact / plan * 100))) : 0
}

function validFactLengths(lengths?: PileLengthFact[]): PileLengthFact[] {
  return (lengths ?? []).filter(item => (item.count ?? 0) > 0)
}

function pileLengthLabel(item: PileLengthFact): string {
  return `${item.length_m != null ? `${fmt(item.length_m)}м` : 'н/д'}×${fmt(item.count)}`
}

function factLengthsText(lengths?: PileLengthFact[]): string {
  return validFactLengths(lengths).map(pileLengthLabel).join(' · ')
}

function factLengthsCompactText(lengths?: PileLengthFact[]): string {
  const valid = validFactLengths(lengths)
  if (valid.length === 0) return ''
  const first = pileLengthLabel(valid[0])
  return valid.length > 1 ? `${first} +${valid.length - 1}` : first
}

function cleanPileSpecLabel(value?: string | null): string {
  const cleaned = String(value || '')
    .replace(/\bPILE[_\s-]*/gi, '')
    .replace(/[_\s-]+$/g, '')
    .trim()
  return cleaned || 'Свая н/д'
}

function progressTone(value: number, plan: number): 'ok' | 'warn' | 'risk' | 'empty' {
  if (plan <= 0) return value > 0 ? 'ok' : 'empty'
  if (value <= 0) return 'empty'
  const p = value / plan
  if (p >= 1) return 'ok'
  if (p >= 0.75) return 'warn'
  return 'risk'
}

function toneClasses(tone: 'ok' | 'warn' | 'risk' | 'empty'): { text: string; bar: string; bg: string } {
  if (tone === 'ok') return { text: 'text-emerald-700', bar: 'bg-emerald-600', bg: 'bg-emerald-50 border-emerald-200' }
  if (tone === 'warn') return { text: 'text-amber-700', bar: 'bg-amber-500', bg: 'bg-amber-50 border-amber-200' }
  if (tone === 'risk') return { text: 'text-red-700', bar: 'bg-red-600', bg: 'bg-red-50 border-red-200' }
  return { text: 'text-text-muted', bar: 'bg-neutral-300', bg: 'bg-neutral-50 border-border' }
}

function missedPulseClasses(days: number): { box: string; dot: string; text: string; badge: string } {
  if (days <= 0) {
    return {
      box: 'border-emerald-200 bg-emerald-50',
      dot: '#16a34a',
      text: 'text-emerald-800',
      badge: 'bg-white/80 text-emerald-700',
    }
  }
  if (days === 1) {
    return {
      box: 'border-red-200 bg-red-50',
      dot: '#dc2626',
      text: 'text-red-800',
      badge: 'bg-red-100 text-red-800',
    }
  }
  if (days <= 3) {
    return {
      box: 'border-rose-300 bg-rose-100',
      dot: '#e11d48',
      text: 'text-rose-900',
      badge: 'bg-white/70 text-rose-900',
    }
  }
  return {
    box: 'border-red-950 bg-red-950',
    dot: '#991b1b',
    text: 'text-white',
    badge: 'bg-white/15 text-white',
  }
}

function consecutiveMissedDays(
  code: string,
  days: string[],
  selectedDate: string,
  rows: ReinforcementResponse['calendar']['rows'],
): number {
  let endIndex = -1
  for (let i = 0; i < days.length; i++) {
    if (days[i] <= selectedDate) endIndex = i
  }
  if (endIndex < 0) return 0
  const row = rows.find(r => r.code === code)
  if (!row) return 0
  let misses = 0
  for (let i = endIndex; i >= 0; i--) {
    const day = days[i]
    const plan = row.days[day]?.plan_total ?? 0
    if (plan <= 0) break
    const value = row?.days[day]?.total ?? 0
    if (value >= plan) break
    misses += 1
  }
  return misses
}

function sumRowUntil(row: { days: Record<string, DayFacts> }, days: string[], selectedDate: string): number {
  return days
    .filter(day => day <= selectedDate)
    .reduce((sum, day) => sum + (row.days[day]?.total ?? 0), 0)
}

function sumPlanRowUntil(row: { days: Record<string, DayFacts> }, days: string[], selectedDate: string): number {
  return days
    .filter(day => day <= selectedDate)
    .reduce((sum, day) => sum + (row.days[day]?.plan_total ?? 0), 0)
}

function sectionProjectPileTotal(section?: SectionKpi): number {
  if (!section) return 0
  if (section.project_total !== undefined && section.project_total !== null) return Number(section.project_total || 0)
  return Number(section.project_main || 0) + Number(section.project_test || 0)
}

function detailProjectPileTotal(detail: ReinforcementDetail): number {
  if (detail.project_total !== undefined && detail.project_total !== null) return Number(detail.project_total || 0)
  return Number(detail.project_main || 0) + Number(detail.project_test || 0)
}

function sumHeadcapRowUntil(row: { days: Record<string, DayFacts> }, days: string[], selectedDate: string): number {
  return days
    .filter(day => day <= selectedDate)
    .reduce((sum, day) => sum + (row.days[day]?.headcaps ?? 0), 0)
}

function sumHeadcapPlanRowUntil(row: { days: Record<string, DayFacts> }, days: string[], selectedDate: string): number {
  return days
    .filter(day => day <= selectedDate)
    .reduce((sum, day) => sum + (row.days[day]?.plan_headcaps ?? 0), 0)
}

function sectionFactForScope(
  code: string,
  scope: TotalScope,
  selectedDate: string,
  calendarDays: string[],
  calendarRows: ReinforcementResponse['calendar']['rows'],
  cumulativeSections: SectionKpi[],
): number {
  if (scope === 'all') {
    const section = cumulativeSections.find(s => s.code === code)
    return section ? section.main + section.test : 0
  }
  const row = calendarRows.find(r => r.code === code)
  return row ? sumRowUntil(row, calendarDays, selectedDate) : 0
}

function sectionPlanForScope(
  code: string,
  scope: TotalScope,
  selectedDate: string,
  calendarDays: string[],
  calendarRows: ReinforcementResponse['calendar']['rows'],
  cumulativeSections: SectionKpi[],
): number {
  if (scope === 'all') {
    return sectionProjectPileTotal(cumulativeSections.find(s => s.code === code))
  }
  const row = calendarRows.find(r => r.code === code)
  return row ? sumPlanRowUntil(row, calendarDays, selectedDate) : 0
}

async function fetchReinforcement(date: string, mode: ApiMode): Promise<ReinforcementResponse> {
  const res = await fetch(`/api/wip/reinforcement-sections/summary?date=${date}&mode=${mode}`)
  if (!res.ok) throw new Error(`Failed to fetch reinforcement summary: ${res.status}`)
  return res.json()
}

async function fetchPileDeliveries(date: string): Promise<PileDeliverySummary> {
  const res = await fetch(`/api/wip/pile-deliveries/summary?date=${date}`)
  if (!res.ok) throw new Error(`Failed to fetch pile deliveries summary: ${res.status}`)
  return res.json()
}

function detailsForSection(detailsBySection: Record<string, ReinforcementDetail[]> | undefined, code: string): ReinforcementDetail[] {
  const items = detailsBySection?.[code]
  return Array.isArray(items) ? items : []
}

function detailPkRanges(detail: ReinforcementDetail): string[] {
  if (Array.isArray(detail.pk_ranges) && detail.pk_ranges.length > 0) {
    return detail.pk_ranges.filter(Boolean)
  }
  return [detail.pk_range || 'ПК н/д']
}

export default function ReinforcementSectionsBoard() {
  const [date, setDate] = useState(reportDefaultDateISO())
  const [scope, setScope] = useState<TotalScope>('month')
  const [openTotalDetail, setOpenTotalDetail] = useState<string | null>(null)

  const { data: dailyData, isLoading: dailyLoading } = useQuery<ReinforcementResponse>({
    queryKey: ['reinforcement-sections-summary', date, 'date'],
    queryFn: () => fetchReinforcement(date, 'date'),
  })

  const { data: cumulativeData, isLoading: cumulativeLoading } = useQuery<ReinforcementResponse>({
    queryKey: ['reinforcement-sections-summary', date, 'cumulative'],
    queryFn: () => fetchReinforcement(date, 'cumulative'),
  })

  const { data: pileDeliveryData } = useQuery<PileDeliverySummary>({
    queryKey: ['pile-deliveries-summary', date],
    queryFn: () => fetchPileDeliveries(date),
  })

  const calendarRows = useMemo(() => dailyData?.calendar.rows ?? [], [dailyData])
  const calendarDays = useMemo(() => dailyData?.calendar.days ?? [], [dailyData])

  const monthlyPlanBySection = useMemo(() => Object.fromEntries(
    calendarRows.map(row => [
      row.code,
      calendarDays.reduce((sum, day) => (
        sum + (row.days[day]?.plan_total ?? 0)
      ), 0),
    ]),
  ), [calendarRows, calendarDays])

  const dailyPlan = useMemo(() => Object.fromEntries(
    calendarRows.map(row => [
      row.code,
      row.days[date]?.plan_total ?? 0,
    ]),
  ), [calendarRows, date])

  const dailyFact = useMemo(() => Object.fromEntries(
    (dailyData?.sections ?? []).map(section => [section.code, section.total]),
  ), [dailyData])

  const monthFactBySection = useMemo(() => Object.fromEntries(
    calendarRows.map(row => [
      row.code,
      calendarDays.reduce((sum, day) => sum + (row.days[day]?.total ?? 0), 0),
    ]),
  ), [calendarRows, calendarDays])

  const dailySections = useMemo(() => {
    const sections = dailyData?.sections ?? []
    return sections.filter(section => (dailyPlan[section.code] ?? 0) > 0 || (section.total ?? 0) > 0)
  }, [dailyData, dailyPlan])

  const monthActiveSections = useMemo(() => {
    const sections = dailyData?.sections ?? []
    return sections.filter(section => (monthlyPlanBySection[section.code] ?? 0) > 0 || (monthFactBySection[section.code] ?? 0) > 0)
  }, [dailyData, monthFactBySection, monthlyPlanBySection])

  const monthTotalSections = useMemo(() => dailyData?.sections ?? [], [dailyData])
  const monthTotalCodes = useMemo(() => new Set(monthTotalSections.map(section => section.code)), [monthTotalSections])
  const allFactSections = useMemo(() => {
    const sections = cumulativeData?.sections ?? []
    return sections.filter(section => (section.main + section.test) > 0 || sectionProjectPileTotal(section) > 0)
  }, [cumulativeData])
  const totalSections = scope === 'all' ? allFactSections : monthTotalSections
  const totalSectionCodes = useMemo(() => new Set(totalSections.map(section => section.code)), [totalSections])
  const totalDailyPlan = monthActiveSections.reduce((sum, section) => sum + (dailyPlan[section.code] ?? 0), 0)
  const totalDailyFact = monthActiveSections.reduce((sum, section) => sum + (dailyFact[section.code] ?? 0), 0)
  const totalDailyDelta = totalDailyFact - totalDailyPlan
  const monthPlanToDate = (dailyData?.calendar.rows ?? [])
    .filter(row => monthTotalCodes.has(row.code))
    .reduce((sum, row) => sum + sumPlanRowUntil(row, calendarDays, date), 0)
  const monthFactToDate = (dailyData?.calendar.rows ?? [])
    .filter(row => monthTotalCodes.has(row.code))
    .reduce((sum, row) => sum + sumRowUntil(row, calendarDays, date), 0)
  const allFact = (cumulativeData?.sections ?? [])
    .filter(section => totalSectionCodes.has(section.code))
    .reduce((sum, section) => sum + section.main + section.test, 0)
  const allProject = (cumulativeData?.sections ?? [])
    .filter(section => totalSectionCodes.has(section.code))
    .reduce((sum, section) => sum + sectionProjectPileTotal(section), 0)
  const totalFact = scope === 'month' ? monthFactToDate : allFact
  const totalPlan = scope === 'month' ? monthPlanToDate : allProject
  const totalDelta = totalFact - totalPlan
  const detailsBySection = (cumulativeData?.details?.[scope] ?? {}) as Record<string, ReinforcementDetail[]>
  const totalDetails = useMemo(
    () => totalSections.flatMap(section => detailsForSection(detailsBySection, section.code)),
    [detailsBySection, totalSections],
  )
  const pileRigs = dailyData?.pile_rigs ?? cumulativeData?.pile_rigs ?? null

  const isLoading = dailyLoading || cumulativeLoading || !dailyData || !cumulativeData

  return (
    <div className="space-y-5 p-4 pb-24 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <LandPlot className="h-6 w-6 text-accent-red" />
        <div className="min-w-[240px] flex-1">
          <h1 className="font-heading text-2xl font-bold text-text-primary">Участки усиления</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Суточная забивка, нарастающий итог и производственный календарь по участкам с месячным планом.
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm shadow-sm">
          <CalendarDays className="h-4 w-4 text-accent-red" />
          <input
            type="date"
            value={date}
            onChange={event => setDate(event.target.value)}
            className="bg-transparent font-mono text-sm outline-none"
          />
        </label>
      </div>

      {isLoading ? (
        <div className="h-72 animate-pulse rounded-lg border border-border bg-white" />
      ) : (
        <>
          <PulseStrip
            sections={monthActiveSections}
            dailyPlan={dailyPlan}
            totalDailyPlan={totalDailyPlan}
            totalDailyFact={totalDailyFact}
            totalDailyDelta={totalDailyDelta}
            days={calendarDays}
            selectedDate={date}
            calendarRows={dailyData.calendar.rows}
          />

          <section className="space-y-3">
            <SectionTitle title="Суточный отчет" subtitle={`факт за ${dayLabel(date)} рядом с планом на день`} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {dailySections.map(section => (
                <DailySectionCard
                  key={section.code}
                  section={section}
                  dayPlan={dailyPlan[section.code] ?? 0}
                  dayPlanMain={section.plan_main ?? 0}
                  dayPlanTest={section.plan_test ?? 0}
                />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionTitle title="Нарастающий итог" subtitle={scope === 'month' ? 'текущий месяц' : 'за все время по БД'} />
              <div className="inline-flex rounded-md border border-border bg-white p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => setScope('month')}
                  className={`rounded px-3 py-1.5 text-xs font-semibold ${scope === 'month' ? 'bg-slate-900 text-white' : 'text-text-secondary hover:bg-bg-surface'}`}
                >
                  Текущий месяц
                </button>
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className={`rounded px-3 py-1.5 text-xs font-semibold ${scope === 'all' ? 'bg-slate-900 text-white' : 'text-text-secondary hover:bg-bg-surface'}`}
                >
                  Нарастающий итог
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {totalSections.map(section => {
                  const fact = sectionFactForScope(
                    section.code,
                    scope,
                    date,
                    calendarDays,
                    dailyData.calendar.rows,
                    cumulativeData.sections,
                  )
                  const plan = sectionPlanForScope(
                    section.code,
                    scope,
                    date,
                    calendarDays,
                    dailyData.calendar.rows,
                    cumulativeData.sections,
                  )
                  const detailKey = `${scope}:${section.code}`
                  return (
                    <TotalMiniCard
                      key={section.code}
                      section={section}
                      fact={fact}
                      plan={plan}
                      showPlan={scope === 'month' || plan > 0}
                      planLabel={scope === 'all' ? 'Проект' : 'План'}
                      details={detailsForSection(detailsBySection, section.code)}
                      open={openTotalDetail === detailKey}
                      onToggle={() => setOpenTotalDetail(value => value === detailKey ? null : detailKey)}
                    />
                  )
                })}
              </div>
              <TotalSummaryCard
                scope={scope}
                fact={totalFact}
                plan={totalPlan}
                delta={totalDelta}
                showPlan={scope === 'month' || totalPlan > 0}
                planLabel={scope === 'all' ? 'Проект' : 'План'}
                details={totalDetails}
                open={openTotalDetail === `${scope}:total`}
                onToggle={() => setOpenTotalDetail(value => value === `${scope}:total` ? null : `${scope}:total`)}
              />
            </div>
          </section>

          <ProductionCalendar
            date={date}
            month={dailyData.calendar.month}
            days={calendarDays}
            rows={dailyData.calendar.rows}
            totalsByDay={dailyData.calendar.totals_by_day}
            cumulativeSections={cumulativeData.sections}
            details={cumulativeData.details ?? null}
            pileDeliverySummary={pileDeliveryData}
            pileRigs={pileRigs}
          />
        </>
      )}
    </div>
  )
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">{title}</div>
      <div className="h-px min-w-8 flex-1 bg-border" />
      <div className="text-right text-[11px] font-medium text-text-muted">{subtitle}</div>
    </div>
  )
}

function PulseStrip({
  sections,
  dailyPlan,
  totalDailyPlan,
  totalDailyFact,
  totalDailyDelta,
  days,
  selectedDate,
  calendarRows,
}: {
  sections: SectionKpi[]
  dailyPlan: Record<string, number>
  totalDailyPlan: number
  totalDailyFact: number
  totalDailyDelta: number
  days: string[]
  selectedDate: string
  calendarRows: ReinforcementResponse['calendar']['rows']
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto rounded-lg border border-border bg-white px-3 py-2 shadow-sm">
      <div className="flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        <Activity className="h-4 w-4 shrink-0 text-accent-red" />
        <span className="whitespace-nowrap">Пульс</span>
      </div>
      <div className="flex min-w-max flex-1 items-center gap-1.5">
        {sections.map(section => {
          const plan = dailyPlan[section.code] ?? 0
          const valuePct = pct(section.total, plan)
          const missedDays = consecutiveMissedDays(section.code, days, selectedDate, calendarRows)
          const pulse = missedPulseClasses(missedDays)
          return (
            <div key={section.code} className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 ${pulse.box}`}>
              <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: pulse.dot }} />
              <span className={`whitespace-nowrap text-[11px] font-semibold ${pulse.text}`}>№{sectionNumber(section.code)}</span>
              <span className={`font-mono text-[11px] font-semibold ${pulse.text}`}>{valuePct}%</span>
              {missedDays > 0 && (
                <span className={`rounded px-1 py-0.5 font-mono text-[10px] font-semibold ${pulse.badge}`}>
                  {missedDays}д
                </span>
              )}
            </div>
          )
        })}
        <div className="shrink-0 rounded border border-red-100 bg-red-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-red-800">
          План день: {fmt(totalDailyPlan)} шт
        </div>
        <div className="shrink-0 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-800">
          Факт день: {fmt(totalDailyFact)} шт
        </div>
        <div className={`shrink-0 rounded border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
          totalDailyDelta >= 0
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          Разница день: {signed(totalDailyDelta)} шт
        </div>
      </div>
    </div>
  )
}

function DailySectionCard({
  section,
  dayPlan,
  dayPlanMain,
  dayPlanTest,
}: {
  section: SectionKpi
  dayPlan: number
  dayPlanMain: number
  dayPlanTest: number
}) {
  const fact = section.main + section.test
  const valuePct = pct(fact, dayPlan)
  const tone = progressTone(fact, dayPlan)
  const toneCls = toneClasses(tone)
  const color = colorForSection(section.code)
  return (
    <div className="relative flex min-h-[205px] flex-col overflow-hidden rounded-lg border border-border bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="absolute right-3 top-1 font-heading text-5xl font-bold leading-none text-neutral-100">
        {sectionNumber(section.code)}
      </div>
      <div className="relative flex h-full flex-col">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{section.label}</div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <MetricBlock label="План день" value={dayPlan} muted compact />
          <MetricBlock label="Факт" value={fact} compact />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-muted">
          <div className="min-w-0 whitespace-nowrap">осн. {fmt(section.main)} / {fmt(dayPlanMain)}</div>
          <div className="min-w-0 whitespace-nowrap text-right">проб. {fmt(section.test)} / {fmt(dayPlanTest)}</div>
        </div>
        <div className="mt-auto pt-3">
          <div className="mb-1 flex justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            <span>Выполнение</span>
            <span className={toneCls.text}>{valuePct}%</span>
          </div>
          <div className="reinforcement-pulse-track h-2 overflow-hidden rounded-full border border-border bg-bg-surface">
            <div
              className={`reinforcement-pulse-fill h-full ${toneCls.bar}`}
              style={{ width: `${valuePct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function MetricBlock({
  label,
  value,
  muted = false,
  compact = false,
}: {
  label: string
  value: number
  muted?: boolean
  compact?: boolean
}) {
  return (
    <div className="min-w-0 rounded-md bg-bg-surface px-2 py-2 text-center">
      <div className="text-[10px] font-semibold uppercase text-text-muted">{label}</div>
      <div className={`mt-1 font-heading font-bold leading-none tracking-normal ${compact ? 'text-[30px]' : 'text-4xl'} ${muted ? 'text-text-secondary' : 'text-text-primary'}`}>
        {fmt(value)}
      </div>
    </div>
  )
}

function TotalMiniCard({
  section,
  fact,
  plan,
  showPlan,
  planLabel = 'План',
  details,
  open,
  onToggle,
}: {
  section: SectionKpi
  fact: number
  plan: number
  showPlan: boolean
  planLabel?: string
  details: ReinforcementDetail[]
  open: boolean
  onToggle: () => void
}) {
  const delta = fact - plan
  const tone = delta >= 0 ? 'text-emerald-700' : delta >= -Math.max(1, plan * 0.1) ? 'text-amber-700' : 'text-red-700'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="w-full rounded-lg border border-border bg-white p-3 text-left shadow-sm ring-offset-2 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
      >
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorForSection(section.code) }} />
          <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-muted">{section.label}</div>
        </div>
        {showPlan ? (
          <div className="mt-2 text-[11px] text-text-muted">{planLabel}: {fmt(plan)}</div>
        ) : (
          <div className="mt-2 text-[11px] text-text-muted">Факт за все время</div>
        )}
        <div className="mt-1 font-heading text-3xl font-bold leading-none text-text-primary">{fmt(fact)}</div>
        {showPlan && <div className={`mt-1 font-mono text-xs font-semibold ${tone}`}>{signed(delta)} шт</div>}
      </button>
      {open && <PileDetailPopup title={section.label} details={details} planLabel={planLabel} onClose={onToggle} />}
    </div>
  )
}

function TotalSummaryCard({
  scope,
  fact,
  plan,
  delta,
  showPlan,
  planLabel = 'План',
  details,
  open,
  onToggle,
}: {
  scope: TotalScope
  fact: number
  plan: number
  delta: number
  showPlan: boolean
  planLabel?: string
  details: ReinforcementDetail[]
  open: boolean
  onToggle: () => void
}) {
  const tone = delta >= 0 ? 'text-emerald-700' : delta >= -Math.max(1, plan * 0.1) ? 'text-amber-700' : 'text-red-700'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="w-full rounded-lg border border-red-100 bg-white p-5 text-left shadow-sm ring-offset-2 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
      >
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          <Sigma className="h-4 w-4 text-accent-red" />
          Итого · {scope === 'month' ? 'текущий месяц' : 'нарастающий итог'}
        </div>
        <div className={showPlan ? 'grid grid-cols-2 items-end gap-4' : 'grid grid-cols-1 items-end gap-4'}>
          {showPlan && (
            <div className="min-w-0 text-center">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{planLabel}</div>
              <div className="mt-1 whitespace-nowrap font-heading text-[28px] font-bold leading-none text-text-secondary">{fmt(plan)}</div>
            </div>
          )}
          <div className="min-w-0 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Факт</div>
            <div className="mt-1 whitespace-nowrap font-heading text-[38px] font-bold leading-none text-text-primary">{fmt(fact)}</div>
          </div>
        </div>
        {showPlan && (
          <div className={`mt-3 text-center font-mono text-sm font-semibold ${tone}`}>
            {signed(delta)} шт отклонение
          </div>
        )}
      </button>
      {open && <PileDetailPopup title="Итого" details={details} planLabel={planLabel} onClose={onToggle} />}
    </div>
  )
}

function detailDateLabel(detail: ReinforcementDetail): string {
  if (detail.first_date && detail.last_date && detail.first_date !== detail.last_date) {
    return `${dayLabel(detail.first_date)}-${dayLabel(detail.last_date)}`
  }
  return detail.last_date ? dayLabel(detail.last_date) : ''
}

function detailBreakdown(detail: ReinforcementDetail): string {
  const parts = []
  if (detail.main > 0) parts.push(`осн. ${fmt(detail.main)}`)
  if (detail.test > 0) parts.push(`проб. ${fmt(detail.test)}`)
  if (detail.dyn > 0) parts.push(`дин. ${fmt(detail.dyn)}`)
  if (detail.headcaps > 0) parts.push(`нагол. ${fmt(detail.headcaps)}`)
  return parts.join(' · ') || 'факта нет'
}

function detailProjectBreakdown(detail: ReinforcementDetail): string {
  const parts = []
  if ((detail.project_main ?? 0) > 0) parts.push(`осн. ${fmt(detail.project_main ?? 0)}`)
  if ((detail.project_test ?? 0) > 0) parts.push(`проб. ${fmt(detail.project_test ?? 0)}`)
  if ((detail.project_dyn ?? 0) > 0) parts.push(`дин. ${fmt(detail.project_dyn ?? 0)}`)
  return parts.join(' · ') || 'проекта нет'
}

function detailSectionLabel(code?: string | null): string {
  if (!code) return 'Участок н/д'
  return `Участок №${sectionNumber(code)}`
}

function DetailPileRigList({ rigs }: { rigs?: ReinforcementDetailPileRig[] }) {
  const items = (rigs ?? []).filter(rig => rig?.name || rig?.unit_number || rig?.plate_number)
  if (items.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map(rig => (
        <span
          key={rig.key}
          className="max-w-full truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] text-text-secondary"
          title={`${rig.name || 'Установка'}${rig.unit_number ? ` · б/н ${rig.unit_number}` : ''}${rig.plate_number ? ` · г/н ${rig.plate_number}` : ''}`}
        >
          <span className="font-semibold">{rig.name || 'Установка'}</span>
          {rig.unit_number && <span> · <span className="font-mono font-bold">б/н {rig.unit_number}</span></span>}
          {!rig.unit_number && rig.plate_number && <span> · <span className="font-mono font-bold">г/н {rig.plate_number}</span></span>}
        </span>
      ))}
    </div>
  )
}

function PileDetailPopup({
  title,
  details,
  planLabel = 'Проект',
  onClose,
}: {
  title: string
  details: ReinforcementDetail[]
  planLabel?: string
  onClose: () => void
}) {
  const factTotal = details.reduce((sum, item) => sum + Number(item.total || 0), 0)
  const projectTotal = details.reduce((sum, item) => sum + detailProjectPileTotal(item), 0)
  const hasProject = projectTotal > 0 || details.some(item => Number(item.project_dyn || 0) > 0)
  const sortedDetails = [...details].sort((a, b) => (
    sectionNumber(a.section_code) - sectionNumber(b.section_code)
    || String(a.field_name || '').localeCompare(String(b.field_name || ''), 'ru')
    || String(a.pk_range || '').localeCompare(String(b.pk_range || ''), 'ru')
  ))
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-white shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">{title}: поля и пикеты</h3>
            <div className="mt-1 text-xs text-text-muted">Детализация по выбранному режиму</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted transition hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(88vh-64px)] overflow-y-auto p-4">
          <div className={`mb-3 grid grid-cols-2 gap-2 ${hasProject ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {hasProject && <CalendarPopupMetric label={planLabel} value={projectTotal} tone="plan" />}
            <CalendarPopupMetric label="Факт" value={factTotal} tone="fact" />
            {hasProject && <CalendarPopupMetric label="Отклонение" value={factTotal - projectTotal} signedValue tone={factTotal >= projectTotal ? 'neutral' : 'fact'} />}
            <CalendarPopupMetric label="Полей" value={details.length} tone="neutral" />
          </div>
          {details.length === 0 ? (
            <div className="rounded border border-dashed border-border bg-bg-surface px-3 py-3 text-sm text-text-muted">
              Детализации по полям нет.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[920px] text-xs">
                <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Участок</th>
                    <th className="px-3 py-2 text-left font-semibold">Поле / пикетаж</th>
                    {hasProject && <th className="px-3 py-2 text-right font-semibold">{planLabel}</th>}
                    <th className="px-3 py-2 text-right font-semibold">Факт</th>
                    <th className="px-3 py-2 text-left font-semibold">Состав</th>
                    <th className="px-3 py-2 text-left font-semibold">Отчеты</th>
                    <th className="px-3 py-2 text-left font-semibold">Сваебойки</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedDetails.map((detail, index) => {
                    const pkRanges = detailPkRanges(detail)
                    return (
                      <tr key={`${detail.section_code}-${detail.field_name}-${detail.pk_range}-${index}`} className="border-t border-border/70 align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-semibold text-text-primary">{detailSectionLabel(detail.section_code)}</td>
                        <td className="px-3 py-2 text-text-primary">
                          <div className="font-semibold">{detail.field_name || 'Поле н/д'}</div>
                          <div className="mt-1 space-y-0.5 font-mono text-[11px] text-text-muted">
                            {pkRanges.map(pk => <div key={pk}>{pk}</div>)}
                          </div>
                        </td>
                        {hasProject && (
                          <td className="px-3 py-2 text-right">
                            <div className="font-mono font-semibold text-sky-900">{fmt(detailProjectPileTotal(detail))}</div>
                            <div className="mt-1 text-[10px] text-text-muted">{detailProjectBreakdown(detail)}</div>
                          </td>
                        )}
                        <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{fmt(detail.total)}</td>
                        <td className="px-3 py-2 text-text-muted">{detailBreakdown(detail)}</td>
                        <td className="px-3 py-2 text-text-muted">
                          <div>{detail.report_count > 0 ? `${fmt(detail.report_count)} отч.` : 'отчетов нет'}</div>
                          <div className="mt-1 font-mono text-[11px]">{detailDateLabel(detail) || 'период н/д'}</div>
                        </td>
                        <td className="px-3 py-2"><DetailPileRigList rigs={detail.pile_rigs} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function hasPileCalendarActivity(row: ReinforcementResponse['calendar']['rows'][number], days: string[]): boolean {
  return days.some(day => {
    const facts = row.days[day] ?? EMPTY_DAY_FACTS
    return (facts.total ?? 0) > 0 || (facts.plan_total ?? 0) > 0
  })
}

function hasHeadcapCalendarActivity(row: ReinforcementResponse['calendar']['rows'][number], days: string[]): boolean {
  return days.some(day => {
    const facts = row.days[day] ?? EMPTY_DAY_FACTS
    return (facts.headcaps ?? 0) > 0 || (facts.plan_headcaps ?? 0) > 0
  })
}

function asHeadcapDetail(detail: ReinforcementDetail): ReinforcementDetail {
  const headcaps = detail.headcaps ?? 0
  return {
    ...detail,
      main: 0,
      test: 0,
      dyn: 0,
      total: headcaps,
      project_main: 0,
      project_test: 0,
      project_dyn: 0,
      project_total: 0,
      pile_rigs: [],
    }
  }

function asHeadcapFacts(facts?: DayFacts): DayFacts {
  const src = facts ?? EMPTY_DAY_FACTS
  const factDetails = (src.fact_details ?? [])
    .filter(detail => (detail.headcaps ?? 0) > 0)
    .map(asHeadcapDetail)
  const planDetails = (src.plan_details ?? [])
    .filter(detail => (detail.headcaps ?? 0) > 0)
    .map(asHeadcapDetail)
  return {
    ...src,
    main: 0,
    test: 0,
    dyn: 0,
    total: src.headcaps ?? 0,
    plan_main: 0,
    plan_test: 0,
    plan_dyn: 0,
    plan_total: src.plan_headcaps ?? 0,
    fact_lengths: [],
    fact_details: factDetails,
    plan_details: planDetails,
  }
}

function headcapDetailsForSection(detailsBySection: Record<string, ReinforcementDetail[]> | undefined, code: string): ReinforcementDetail[] {
  return detailsForSection(detailsBySection, code)
    .filter(detail => (detail.headcaps ?? 0) > 0)
    .map(asHeadcapDetail)
}

function HeadcapTotalsSection({
  date,
  month,
  days,
  rows,
  cumulativeSections,
  details,
}: {
  date: string
  month: string
  days: string[]
  rows: ReinforcementResponse['calendar']['rows']
  cumulativeSections: SectionKpi[]
  details?: ReinforcementResponse['details'] | null
}) {
  const [scope, setScope] = useState<TotalScope>('month')
  const [openDetail, setOpenDetail] = useState<string | null>(null)
  const monthRows = useMemo(
    () => rows.filter(row => hasHeadcapCalendarActivity(row, days)),
    [days, rows],
  )
  const monthSections = useMemo<SectionKpi[]>(() => monthRows.map(row => ({
    code: row.code,
    label: row.label,
    main: 0,
    test: 0,
    dyn: 0,
    headcaps: sumHeadcapRowUntil(row, days, date),
    total: sumHeadcapRowUntil(row, days, date),
  })), [date, days, monthRows])
  const monthPlanBySection = useMemo(() => Object.fromEntries(
    monthRows.map(row => [row.code, sumHeadcapPlanRowUntil(row, days, date)]),
  ), [date, days, monthRows])
  const monthFactBySection = useMemo(() => Object.fromEntries(
    monthRows.map(row => [row.code, sumHeadcapRowUntil(row, days, date)]),
  ), [date, days, monthRows])
  const cumulativeHeadcapSections = useMemo(
    () => cumulativeSections.filter(section => (section.headcaps ?? 0) > 0),
    [cumulativeSections],
  )
  const visibleSections = scope === 'month' ? monthSections : cumulativeHeadcapSections
  const detailsBySection = (details?.[scope] ?? {}) as Record<string, ReinforcementDetail[]>
  const totalDetails = useMemo(
    () => visibleSections.flatMap(section => headcapDetailsForSection(detailsBySection, section.code)),
    [detailsBySection, visibleSections],
  )
  const totalFact = visibleSections.reduce((sum, section) => {
    if (scope === 'month') return sum + (monthFactBySection[section.code] ?? 0)
    return sum + (section.headcaps ?? 0)
  }, 0)
  const totalPlan = scope === 'month'
    ? visibleSections.reduce((sum, section) => sum + (monthPlanBySection[section.code] ?? 0), 0)
    : 0
  const totalDelta = totalFact - totalPlan

  if (visibleSections.length === 0) {
    return (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle title="Монтаж наголовников" subtitle={scope === 'month' ? `текущий месяц · ${monthLabel(month)}` : 'за все время по БД'} />
          <HeadcapScopeSwitch scope={scope} onScopeChange={setScope} />
        </div>
        <div className="rounded-lg border border-dashed border-border bg-white px-4 py-3 text-sm text-text-muted shadow-sm">
          Данных по монтажу наголовников для выбранного режима пока нет.
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle title="Монтаж наголовников" subtitle={scope === 'month' ? `текущий месяц · ${monthLabel(month)}` : 'за все время по БД'} />
        <HeadcapScopeSwitch scope={scope} onScopeChange={setScope} />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {visibleSections.map(section => {
            const fact = scope === 'month' ? (monthFactBySection[section.code] ?? 0) : (section.headcaps ?? 0)
            const plan = scope === 'month' ? (monthPlanBySection[section.code] ?? 0) : 0
            const detailKey = `headcaps:${scope}:${section.code}`
            return (
              <TotalMiniCard
                key={section.code}
                section={section}
                fact={fact}
                plan={plan}
                showPlan={scope === 'month'}
                details={headcapDetailsForSection(detailsBySection, section.code)}
                open={openDetail === detailKey}
                onToggle={() => setOpenDetail(value => value === detailKey ? null : detailKey)}
              />
            )
          })}
        </div>
        <TotalSummaryCard
          scope={scope}
          fact={totalFact}
          plan={totalPlan}
          delta={totalDelta}
          showPlan={scope === 'month'}
          details={totalDetails}
          open={openDetail === `headcaps:${scope}:total`}
          onToggle={() => setOpenDetail(value => value === `headcaps:${scope}:total` ? null : `headcaps:${scope}:total`)}
        />
      </div>
    </section>
  )
}

function HeadcapScopeSwitch({
  scope,
  onScopeChange,
}: {
  scope: TotalScope
  onScopeChange: (scope: TotalScope) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-white p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onScopeChange('month')}
        className={`rounded px-3 py-1.5 text-xs font-semibold ${scope === 'month' ? 'bg-slate-900 text-white' : 'text-text-secondary hover:bg-bg-surface'}`}
      >
        Текущий месяц
      </button>
      <button
        type="button"
        onClick={() => onScopeChange('all')}
        className={`rounded px-3 py-1.5 text-xs font-semibold ${scope === 'all' ? 'bg-slate-900 text-white' : 'text-text-secondary hover:bg-bg-surface'}`}
      >
        Нарастающий итог
      </button>
    </div>
  )
}

function ProductionCalendar({
  date,
  month,
  days,
  rows,
  totalsByDay,
  cumulativeSections,
  details,
  pileDeliverySummary,
  pileRigs,
}: {
  date: string
  month: string
  days: string[]
  rows: ReinforcementResponse['calendar']['rows']
  totalsByDay: Record<string, DayFacts>
  cumulativeSections: SectionKpi[]
  details?: ReinforcementResponse['details'] | null
  pileDeliverySummary?: PileDeliverySummary
  pileRigs?: ReinforcementPileRigs | null
}) {
  const [calendarPopup, setCalendarPopup] = useState<CalendarCellPopupState | null>(null)
  const [selectedRig, setSelectedRig] = useState<ReinforcementPileRig | null>(null)
  const pileRows = rows.filter(row => hasPileCalendarActivity(row, days))

  return (
    <section className="space-y-3">
      <SectionTitle title="Производственный календарь" subtitle={monthLabel(month)} />
      <div className="overflow-x-auto rounded-lg border border-border bg-white p-3 shadow-sm">
        <div
          className="grid gap-1 text-[11px]"
          style={{ gridTemplateColumns: `minmax(190px, 220px) repeat(${days.length}, minmax(52px, 1fr)) 64px` }}
        >
          <div className="sticky left-0 z-20 flex min-h-9 items-center rounded border border-border bg-bg-surface px-2 font-semibold uppercase tracking-wide text-text-muted">
            Участок
          </div>
          {days.map(day => (
            <DayHeader key={day} day={day} selected={day === date} />
          ))}
          <div className="flex min-h-9 items-center justify-center rounded border border-border bg-bg-surface font-semibold uppercase text-text-muted">
            Итого
          </div>

          {pileRows.map(row => {
            const rowTotal = days.reduce((sum, day) => sum + (row.days[day]?.total ?? 0), 0)
            const rowPlanTotal = days.reduce((sum, day) => sum + (row.days[day]?.plan_total ?? 0), 0)
            return (
              <RowFragment key={row.code}>
                <div className="sticky left-0 z-10 flex min-h-8 min-w-0 items-center gap-2 rounded border border-border bg-white px-2 font-semibold text-text-primary">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorForSection(row.code) }} />
                  <span className="truncate">{row.label}</span>
                </div>
                {days.map(day => {
                  const facts = row.days[day] ?? EMPTY_DAY_FACTS
                  return (
                    <CalendarCell
                      key={`${row.code}-${day}`}
                      day={day}
                      selectedDate={date}
                      value={facts.total ?? 0}
                      plan={facts.plan_total ?? 0}
                      facts={facts}
                      onOpen={() => setCalendarPopup({ title: row.label, day, facts, color: colorForSection(row.code), kind: 'piles' })}
                    />
                  )
                })}
                <div className="flex min-h-8 items-center justify-center rounded border border-border bg-bg-surface font-mono font-semibold text-text-primary">
                  {rowTotal > 0 ? fmt(rowTotal) : '—'}
                </div>
                <div className={`sticky left-0 z-10 flex min-h-7 items-center gap-2 rounded border px-2 text-[10px] font-semibold uppercase tracking-wide ${CALENDAR_PLAN_LABEL_CLASS}`}>
                  <span className={`h-2.5 w-2.5 rounded-sm ${CALENDAR_PLAN_MARKER_CLASS}`} />
                  <span className="whitespace-nowrap">План</span>
                </div>
                {days.map(day => {
                  const facts = row.days[day] ?? EMPTY_DAY_FACTS
                  return (
                    <CalendarPlanCell
                      key={`${row.code}-${day}-plan`}
                      day={day}
                      selectedDate={date}
                      value={facts.plan_total ?? 0}
                      onOpen={() => setCalendarPopup({ title: row.label, day, facts, color: colorForSection(row.code), kind: 'piles' })}
                    />
                  )
                })}
                <div className={`flex min-h-7 items-center justify-center rounded border ${CALENDAR_PLAN_TOTAL_CLASS}`}>
                  {rowPlanTotal > 0 ? fmt(rowPlanTotal) : '—'}
                </div>
              </RowFragment>
            )
          })}

          <div className="sticky left-0 z-10 flex min-h-9 items-center rounded border border-red-100 bg-red-50 px-2 font-semibold uppercase tracking-wide text-red-800">
            Итого
          </div>
          {days.map(day => {
            const facts = totalsByDay[day] ?? EMPTY_DAY_FACTS
            const value = facts.total ?? 0
            return (
              <CalendarTotalCell
                key={`total-${day}`}
                day={day}
                selectedDate={date}
                value={value}
                plan={facts.plan_total ?? 0}
                facts={facts}
                onOpen={() => setCalendarPopup({ title: 'Итого', day, facts, kind: 'piles' })}
              />
            )
          })}
          <div className="flex min-h-9 items-center justify-center rounded border border-red-100 bg-red-50 font-mono font-semibold text-red-800">
            {fmt(days.reduce((sum, day) => sum + (totalsByDay[day]?.total ?? 0), 0))}
          </div>
          <div className={`sticky left-0 z-10 flex min-h-7 items-center gap-2 rounded border px-2 text-[10px] font-semibold uppercase tracking-wide ${CALENDAR_PLAN_LABEL_CLASS}`}>
            <span className={`h-2.5 w-2.5 rounded-sm ${CALENDAR_PLAN_MARKER_CLASS}`} />
            <span className="whitespace-nowrap">Итого план</span>
          </div>
          {days.map(day => {
            const facts = totalsByDay[day] ?? EMPTY_DAY_FACTS
            return (
              <CalendarPlanCell
                key={`total-${day}-plan`}
                day={day}
                selectedDate={date}
                value={facts.plan_total ?? 0}
                onOpen={() => setCalendarPopup({ title: 'Итого план', day, facts, kind: 'piles' })}
              />
            )
          })}
          <div className={`flex min-h-7 items-center justify-center rounded border ${CALENDAR_PLAN_TOTAL_CLASS}`}>
            {fmt(days.reduce((sum, day) => sum + (totalsByDay[day]?.plan_total ?? 0), 0))}
          </div>
        </div>
      </div>
      {calendarPopup && <CalendarCellModal cell={calendarPopup} onClose={() => setCalendarPopup(null)} />}
      <HeadcapInstallationBlock
        date={date}
        month={month}
        days={days}
        rows={rows}
        totalsByDay={totalsByDay}
        cumulativeSections={cumulativeSections}
        details={details}
        onOpenCell={cell => setCalendarPopup(cell)}
      />
      <PileRigCardsBlock pileRigs={pileRigs} onOpen={setSelectedRig} />
      {selectedRig && <PileRigDetailModal rig={selectedRig} onClose={() => setSelectedRig(null)} />}
      <PileDeliveryBlock date={date} summary={pileDeliverySummary} />
    </section>
  )
}

function pileRigToneClasses(status: PileRigStatus): string {
  if (status === 'performing_plan') return 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-500'
  if (status === 'working') return 'border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-500'
  return 'border-border bg-white text-text-primary hover:border-red-200'
}

function pileRigStatusLabel(status: PileRigStatus): string {
  if (status === 'performing_plan') return 'есть забивка, план выполнен'
  if (status === 'working') return 'есть забивка'
  return 'факта забивки нет'
}

function PileRigCardsBlock({
  pileRigs,
  onOpen,
}: {
  pileRigs?: ReinforcementPileRigs | null
  onOpen: (rig: ReinforcementPileRig) => void
}) {
  const items = pileRigs?.items ?? []
  if (!pileRigs) return null
  return (
    <div className="space-y-3">
      <SectionTitle title="Сваебойные установки" subtitle="статус по сменным отчетам" />
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-4 py-3 text-sm text-text-muted shadow-sm">
          Сваебойные установки в каталоге/сменных отчетах не найдены.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-white p-3 shadow-sm">
          {items.map(rig => {
            const primaryNumber = rig.unit_number ? `б/н ${rig.unit_number}` : rig.plate_number ? `г/н ${rig.plate_number}` : ''
            return (
              <button
                key={rig.key}
                type="button"
                onClick={() => onOpen(rig)}
                className={`inline-flex min-w-[190px] max-w-[300px] flex-row items-start gap-3 rounded-md border px-3 py-2 text-left shadow-sm ring-offset-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 ${pileRigToneClasses(rig.status)}`}
                title={`${rig.name}${rig.unit_number ? ` · б/н ${rig.unit_number}` : ''}${rig.plate_number ? ` · г/н ${rig.plate_number}` : ''}`}
              >
                <span className="shrink-0 font-mono text-3xl font-bold leading-none tabular-nums">
                  {rig.rank ?? '-'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold leading-tight">{rig.name}</span>
                  {primaryNumber && (
                    <span className="mt-1 block font-mono text-[12px] font-bold leading-tight">
                      {primaryNumber}
                    </span>
                  )}
                  {rig.unit_number && rig.plate_number && <span className="mt-0.5 block font-mono text-[10px] leading-tight opacity-80">г/н {rig.plate_number}</span>}
                  <span className="mt-0.5 block text-[10px] font-semibold uppercase opacity-80">{rig.ownership_label || 'Не указано'}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PileRigDetailModal({ rig, onClose }: { rig: ReinforcementPileRig; onClose: () => void }) {
  const details = rig.details ?? []
  const total = details.reduce((sum, row) => sum + Number(row.total || 0), 0)
  const notesByKey = new Map<string, string>()
  const noteCandidates = [...(rig.notes ?? []), ...details.flatMap(row => row.notes ?? [])]
  noteCandidates.forEach(note => {
    const value = String(note || '').trim()
    if (!value) return
    const key = value.toLowerCase().replace(/\s+/g, ' ')
    if (!notesByKey.has(key)) notesByKey.set(key, value)
  })
  const notes = Array.from(notesByKey.values())
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-white shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Hammer className="h-4 w-4 shrink-0 text-accent-red" />
              <h3 className="truncate text-sm font-semibold text-text-primary">{rig.name}</h3>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
              {rig.unit_number && <span className="font-mono">б/н {rig.unit_number}</span>}
              {rig.plate_number && <span className="font-mono">г/н {rig.plate_number}</span>}
              <span>{rig.ownership_label || 'Не указано'}</span>
              <span>{pileRigStatusLabel(rig.status)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted transition hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[calc(86vh-64px)] overflow-y-auto p-4">
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CalendarPopupMetric label="Всего" value={total} tone="fact" />
            <CalendarPopupMetric label="Основные" value={details.reduce((sum, row) => sum + Number(row.main || 0), 0)} tone="neutral" />
            <CalendarPopupMetric label="Пробные" value={details.reduce((sum, row) => sum + Number(row.test || 0), 0)} tone="neutral" />
            <CalendarPopupMetric label="Полей" value={details.length} tone="neutral" />
          </div>
          {notes.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Примечания</div>
              <div className="mt-1 space-y-1 text-sm text-amber-950">
                {notes.map(note => <div key={note}>{note}</div>)}
              </div>
            </div>
          )}
          {details.length === 0 ? (
            <div className="rounded border border-dashed border-border bg-bg-surface px-3 py-3 text-sm text-text-muted">
              Фактической привязки к забивке свай за выбранный месяц нет.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-xs">
                <thead className="bg-bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Участок</th>
                    <th className="px-3 py-2 text-left font-semibold">Поле</th>
                    <th className="px-3 py-2 text-right font-semibold">Основные</th>
                    <th className="px-3 py-2 text-right font-semibold">Пробные</th>
                    <th className="px-3 py-2 text-right font-semibold">Всего</th>
                    <th className="px-3 py-2 text-left font-semibold">Примечания</th>
                  </tr>
                </thead>
                <tbody>
                  {details.map((detail, index) => (
                    <tr key={`${detail.section_code}-${detail.field_name}-${index}`} className="border-t border-border/70">
                      <td className="px-3 py-2 font-semibold text-text-primary">{detail.section_label || detail.section_code}</td>
                      <td className="px-3 py-2 text-text-primary">{detail.field_name || 'Поле н/д'}</td>
                      <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(detail.main)}</td>
                      <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(detail.test)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{fmt(detail.total)}</td>
                      <td className="px-3 py-2 text-text-secondary">
                        {(detail.notes ?? []).length > 0 ? (detail.notes ?? []).join('; ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function HeadcapInstallationBlock({
  date,
  month,
  days,
  rows,
  totalsByDay,
  cumulativeSections,
  details,
  onOpenCell,
}: {
  date: string
  month: string
  days: string[]
  rows: ReinforcementResponse['calendar']['rows']
  totalsByDay: Record<string, DayFacts>
  cumulativeSections: SectionKpi[]
  details?: ReinforcementResponse['details'] | null
  onOpenCell: (cell: CalendarCellPopupState) => void
}) {
  const headcapRows = rows.filter(row => hasHeadcapCalendarActivity(row, days))
  const monthPlan = days.reduce((sum, day) => sum + (totalsByDay[day]?.plan_headcaps ?? 0), 0)
  const monthFact = days.reduce((sum, day) => sum + (totalsByDay[day]?.headcaps ?? 0), 0)

  return (
    <div className="space-y-3">
      <HeadcapTotalsSection
        date={date}
        month={month}
        days={days}
        rows={rows}
        cumulativeSections={cumulativeSections}
        details={details}
      />

      <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
        <Hammer className="h-4 w-4 text-accent-red" />
        <span>Календарь монтажа наголовников</span>
        <div className="h-px min-w-8 flex-1 bg-border" />
        <span className="text-right font-medium normal-case tracking-normal">{monthLabel(month)}</span>
      </div>

      {headcapRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-4 py-3 text-sm text-text-muted shadow-sm">
          Данных и плана по монтажу наголовников за {monthLabel(month)} пока нет.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
            <div className="overflow-x-auto">
              <div
                className="grid gap-1 text-[11px]"
                style={{ gridTemplateColumns: `minmax(190px, 220px) repeat(${days.length}, minmax(52px, 1fr)) 64px` }}
              >
                <div className="sticky left-0 z-20 flex min-h-9 items-center rounded border border-border bg-bg-surface px-2 font-semibold uppercase tracking-wide text-text-muted">
                  Участок
                </div>
                {days.map(day => (
                  <DayHeader key={`headcap-${day}`} day={day} selected={day === date} />
                ))}
                <div className="flex min-h-9 items-center justify-center rounded border border-border bg-bg-surface font-semibold uppercase text-text-muted">
                  Итого
                </div>

                {headcapRows.map(row => {
                  const rowFactTotal = days.reduce((sum, day) => sum + (row.days[day]?.headcaps ?? 0), 0)
                  const rowPlanTotal = days.reduce((sum, day) => sum + (row.days[day]?.plan_headcaps ?? 0), 0)
                  return (
                    <RowFragment key={`headcap-${row.code}`}>
                      <div className="sticky left-0 z-10 flex min-h-8 min-w-0 items-center gap-2 rounded border border-border bg-white px-2 font-semibold text-text-primary">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorForSection(row.code) }} />
                        <span className="truncate">{row.label}</span>
                      </div>
                      {days.map(day => {
                        const facts = asHeadcapFacts(row.days[day])
                        return (
                          <CalendarCell
                            key={`headcap-${row.code}-${day}`}
                            day={day}
                            selectedDate={date}
                            value={facts.total ?? 0}
                            plan={facts.plan_total ?? 0}
                            facts={facts}
                            title="Поля и пикеты наголовников"
                            onOpen={() => onOpenCell({ title: row.label, day, facts, color: colorForSection(row.code), kind: 'headcaps' })}
                          />
                        )
                      })}
                      <div className="flex min-h-8 items-center justify-center rounded border border-border bg-bg-surface font-mono font-semibold text-text-primary">
                        {rowFactTotal > 0 ? fmt(rowFactTotal) : '—'}
                      </div>
                      <div className={`sticky left-0 z-10 flex min-h-7 items-center gap-2 rounded border px-2 text-[10px] font-semibold uppercase tracking-wide ${CALENDAR_PLAN_LABEL_CLASS}`}>
                        <span className={`h-2.5 w-2.5 rounded-sm ${CALENDAR_PLAN_MARKER_CLASS}`} />
                        <span className="whitespace-nowrap">План</span>
                      </div>
                      {days.map(day => {
                        const facts = asHeadcapFacts(row.days[day])
                        return (
                          <CalendarPlanCell
                            key={`headcap-${row.code}-${day}-plan`}
                            day={day}
                            selectedDate={date}
                            value={facts.plan_total ?? 0}
                            title="План монтажа наголовников"
                            onOpen={() => onOpenCell({ title: row.label, day, facts, color: colorForSection(row.code), kind: 'headcaps' })}
                          />
                        )
                      })}
                      <div className={`flex min-h-7 items-center justify-center rounded border ${CALENDAR_PLAN_TOTAL_CLASS}`}>
                        {rowPlanTotal > 0 ? fmt(rowPlanTotal) : '—'}
                      </div>
                    </RowFragment>
                  )
                })}

                <div className="sticky left-0 z-10 flex min-h-9 items-center rounded border border-red-100 bg-red-50 px-2 font-semibold uppercase tracking-wide text-red-800">
                  Итого
                </div>
                {days.map(day => {
                  const facts = asHeadcapFacts(totalsByDay[day])
                  return (
                    <CalendarTotalCell
                      key={`headcap-total-${day}`}
                      day={day}
                      selectedDate={date}
                      value={facts.total ?? 0}
                      plan={facts.plan_total ?? 0}
                      facts={facts}
                      title="Итого монтаж наголовников"
                      onOpen={() => onOpenCell({ title: 'Итого', day, facts, kind: 'headcaps' })}
                    />
                  )
                })}
                <div className="flex min-h-9 items-center justify-center rounded border border-red-100 bg-red-50 font-mono font-semibold text-red-800">
                  {monthFact > 0 ? fmt(monthFact) : '—'}
                </div>
                <div className={`sticky left-0 z-10 flex min-h-7 items-center gap-2 rounded border px-2 text-[10px] font-semibold uppercase tracking-wide ${CALENDAR_PLAN_LABEL_CLASS}`}>
                  <span className={`h-2.5 w-2.5 rounded-sm ${CALENDAR_PLAN_MARKER_CLASS}`} />
                  <span className="whitespace-nowrap">Итого план</span>
                </div>
                {days.map(day => {
                  const facts = asHeadcapFacts(totalsByDay[day])
                  return (
                    <CalendarPlanCell
                      key={`headcap-total-${day}-plan`}
                      day={day}
                      selectedDate={date}
                      value={facts.plan_total ?? 0}
                      title="Итого план монтажа наголовников"
                      onOpen={() => onOpenCell({ title: 'Итого план', day, facts, kind: 'headcaps' })}
                    />
                  )
                })}
                <div className={`flex min-h-7 items-center justify-center rounded border ${CALENDAR_PLAN_TOTAL_CLASS}`}>
                  {monthPlan > 0 ? fmt(monthPlan) : '—'}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function deliveryTone(day: string, selectedDate: string, plan: number, fact: number): 'ok' | 'warn' | 'risk' | 'empty' {
  if (day > selectedDate) return 'empty'
  if (plan <= 0) return fact > 0 ? 'ok' : 'empty'
  if (fact >= plan) return 'ok'
  if (fact > 0) return 'warn'
  return 'risk'
}

const DELIVERY_SUPPLIER_COL_WIDTH = 184
const DELIVERY_TYPE_COL_WIDTH = 124
const DELIVERY_KIND_COL_WIDTH = 72
const DELIVERY_DAY_COL_WIDTH = 44
const DELIVERY_TOTAL_COL_WIDTH = 64

function PileDeliveryBlock({ date, summary }: { date: string; summary?: PileDeliverySummary }) {
  if (!summary) return null

  const deliveryGridMinWidth = DELIVERY_SUPPLIER_COL_WIDTH
    + DELIVERY_TYPE_COL_WIDTH
    + DELIVERY_KIND_COL_WIDTH
    + summary.days.length * DELIVERY_DAY_COL_WIDTH
    + DELIVERY_TOTAL_COL_WIDTH
    + Math.max(0, summary.days.length + 3) * 4
  const typeColumnLeft = DELIVERY_SUPPLIER_COL_WIDTH
  const kindColumnLeft = DELIVERY_SUPPLIER_COL_WIDTH + DELIVERY_TYPE_COL_WIDTH

  return (
    <div className="space-y-3">
      <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
        <Truck className="h-4 w-4 text-accent-red" />
        <span>Поставка свай</span>
        <div className="h-px min-w-8 flex-1 bg-border" />
        <span className="text-right font-medium normal-case tracking-normal">{monthLabel(summary.month)}</span>
      </div>

      {!summary.available ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-4 py-3 text-sm text-text-muted shadow-sm">
          Блок готов, но таблица `pile_delivery_calendar` еще не создана на этой БД.
        </div>
      ) : summary.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-4 py-3 text-sm text-text-muted shadow-sm">
          Данных по поставке свай за {monthLabel(summary.month)} пока нет.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <DeliveryMetricCard label="План день" value={summary.totals.day_plan} tone="plan" />
            <DeliveryMetricCard label="Факт день" value={summary.totals.day_fact} tone="fact" />
            <DeliveryMetricCard label="План месяц" value={summary.totals.month_plan} tone="plan" />
            <DeliveryMetricCard label="Факт месяц" value={summary.totals.month_fact} sub={`Δ ${signed(summary.totals.delta_month)} шт`} tone={summary.totals.delta_month >= 0 ? 'ok' : 'fact'} />
          </div>
          <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
            <div className="overflow-x-auto">
              <div
                className="grid gap-1 text-[10px]"
                style={{
                  gridTemplateColumns: `${DELIVERY_SUPPLIER_COL_WIDTH}px ${DELIVERY_TYPE_COL_WIDTH}px ${DELIVERY_KIND_COL_WIDTH}px repeat(${summary.days.length}, ${DELIVERY_DAY_COL_WIDTH}px) ${DELIVERY_TOTAL_COL_WIDTH}px`,
                  minWidth: deliveryGridMinWidth,
                }}
              >
                <div className="sticky left-0 z-20 flex min-h-8 items-center whitespace-nowrap rounded border border-border bg-bg-surface px-2 font-semibold uppercase tracking-wide text-text-muted">
                  Поставщик
                </div>
                <div
                  className="sticky z-20 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-border bg-bg-surface px-1 font-semibold uppercase tracking-wide text-text-muted"
                  style={{ left: typeColumnLeft }}
                >
                  Тип
                </div>
                <div
                  className="sticky z-20 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-border bg-bg-surface px-1 font-semibold uppercase tracking-wide text-text-muted"
                  style={{ left: kindColumnLeft }}
                >
                  План/Факт
                </div>
                {summary.days.map(day => (
                  <DayHeader key={`delivery-${day}`} day={day} selected={day === date} />
                ))}
                <div className="flex min-h-9 items-center justify-center rounded border border-border bg-bg-surface font-semibold uppercase text-text-muted">
                  Итого
                </div>

                {summary.rows.map(row => {
                  const specLabel = cleanPileSpecLabel(row.spec_display)
                  return (
                    <RowFragment key={`${row.supplier}-${row.spec_display}-${row.spec_code ?? 'na'}`}>
                      <div
                        className="sticky left-0 z-10 flex min-h-8 min-w-0 items-center whitespace-nowrap rounded border border-border bg-white px-2 font-semibold text-text-primary"
                        style={{ gridRow: 'span 2 / span 2' }}
                      >
                        <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap" title={row.supplier}>{row.supplier}</span>
                      </div>
                      <div
                        className="sticky z-10 flex min-h-8 min-w-0 items-center justify-center whitespace-nowrap rounded border border-border bg-white px-1 font-semibold text-text-primary"
                        style={{ gridRow: 'span 2 / span 2', left: typeColumnLeft }}
                      >
                        <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-center" title={specLabel}>{specLabel}</span>
                      </div>
                      <div className="sticky z-10 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-amber-100 bg-amber-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
                        style={{ left: kindColumnLeft }}>
                        План
                      </div>
                      {summary.days.map(day => (
                        <PileDeliveryPlanCell
                          key={`${row.supplier}-${row.spec_display}-${day}-plan`}
                          day={day}
                          selectedDate={date}
                          value={row.days[day]?.plan ?? 0}
                        />
                      ))}
                      <div className="flex min-h-8 items-center justify-center rounded border border-amber-100 bg-amber-50 font-mono font-semibold text-amber-800">
                        {row.month_plan > 0 ? fmt(row.month_plan) : '·'}
                      </div>
                      <div className="sticky z-10 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-border bg-bg-surface px-1 text-[9px] font-semibold uppercase tracking-wide text-text-muted"
                        style={{ left: kindColumnLeft }}>
                        Факт
                      </div>
                      {summary.days.map(day => {
                        const plan = row.days[day]?.plan ?? 0
                        const fact = row.days[day]?.fact ?? 0
                        return (
                          <PileDeliveryFactCell
                            key={`${row.supplier}-${row.spec_display}-${day}-fact`}
                            day={day}
                            selectedDate={date}
                            plan={plan}
                            fact={fact}
                          />
                        )
                      })}
                      <div className="flex min-h-8 items-center justify-center rounded border border-border bg-bg-surface font-mono font-semibold text-text-primary">
                        {row.month_fact > 0 ? fmt(row.month_fact) : '·'}
                      </div>
                    </RowFragment>
                  )
                })}

                <div
                  className="sticky left-0 z-10 flex min-h-8 items-center whitespace-nowrap rounded border border-red-100 bg-red-50 px-2 font-semibold uppercase tracking-wide text-red-800"
                  style={{ gridRow: 'span 2 / span 2' }}
                >
                  Итого
                </div>
                <div
                  className="sticky z-10 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-red-100 bg-red-50 px-1 font-semibold text-red-800"
                  style={{ gridRow: 'span 2 / span 2', left: typeColumnLeft }}
                >
                  Все
                </div>
                <div className="sticky z-10 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-red-100 bg-red-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-red-800"
                  style={{ left: kindColumnLeft }}>
                  План
                </div>
                {summary.days.map(day => (
                  <PileDeliveryPlanCell
                    key={`delivery-total-${day}-plan`}
                    day={day}
                    selectedDate={date}
                    value={summary.totals_by_day[day]?.plan ?? 0}
                    totalRow
                  />
                ))}
                <div className="flex min-h-8 items-center justify-center rounded border border-red-100 bg-red-50 font-mono font-semibold text-red-800">
                  {summary.totals.month_plan > 0 ? fmt(summary.totals.month_plan) : '·'}
                </div>
                <div className="sticky z-10 flex min-h-8 items-center justify-center whitespace-nowrap rounded border border-red-100 bg-red-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-red-800"
                  style={{ left: kindColumnLeft }}>
                  Факт
                </div>
                {summary.days.map(day => (
                  <PileDeliveryFactCell
                    key={`delivery-total-${day}-fact`}
                    day={day}
                    selectedDate={date}
                    plan={summary.totals_by_day[day]?.plan ?? 0}
                    fact={summary.totals_by_day[day]?.fact ?? 0}
                    totalRow
                  />
                ))}
                <div className="flex min-h-8 items-center justify-center rounded border border-red-100 bg-red-50 font-mono font-semibold text-red-800">
                  {summary.totals.month_fact > 0 ? fmt(summary.totals.month_fact) : '·'}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DeliveryMetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: number
  sub?: string
  tone: 'plan' | 'fact' | 'ok'
}) {
  const toneCls = tone === 'plan'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-red-100 bg-red-50 text-red-900'
  return (
    <div className={`rounded-lg border p-3 shadow-sm ${toneCls}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-2 font-heading text-2xl font-bold">{fmt(value)}</div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  )
}

function PileDeliveryPlanCell({
  day,
  selectedDate,
  value,
  totalRow = false,
}: {
  day: string
  selectedDate: string
  value: number
  totalRow?: boolean
}) {
  const selected = day === selectedDate
  return (
    <div className={`flex min-h-8 items-center justify-center rounded border px-0.5 font-mono text-[10px] font-semibold tabular-nums whitespace-nowrap ${
      totalRow
        ? 'border-red-100 bg-red-50 text-red-800'
        : selected
          ? 'border-amber-300 bg-amber-100 text-amber-900'
          : 'border-amber-100 bg-amber-50 text-amber-800'
    }`}>
      {value > 0 ? fmt(value) : '·'}
    </div>
  )
}

function PileDeliveryFactCell({
  day,
  selectedDate,
  plan,
  fact,
  totalRow = false,
}: {
  day: string
  selectedDate: string
  plan: number
  fact: number
  totalRow?: boolean
}) {
  const future = day > selectedDate
  const selected = day === selectedDate
  const tone = deliveryTone(day, selectedDate, plan, fact)
  const toneCls = toneClasses(tone)
  return (
    <div className={`flex min-h-8 items-center justify-center rounded border px-0.5 text-center font-mono text-[10px] font-semibold leading-tight ${
      totalRow
        ? 'border-red-100 bg-red-50 text-red-800'
        : selected
          ? 'border-red-300 bg-red-50 text-red-800'
          : toneCls.bg
    } ${future ? 'text-neutral-300' : totalRow ? '' : toneCls.text}`}>
      <span>{future ? '' : fact > 0 ? fmt(fact) : plan > 0 ? '0' : '·'}</span>
    </div>
  )
}

function RowFragment({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function DayHeader({ day, selected }: { day: string; selected: boolean }) {
  const d = dateObj(day)
  const weekend = d.getDay() === 0 || d.getDay() === 6
  return (
    <div className={`flex min-h-9 flex-col items-center justify-center rounded border px-1 ${
      selected ? 'border-red-300 bg-red-50 text-red-800' : weekend ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-border bg-bg-surface text-text-muted'
    }`}>
      <span className="font-mono text-xs font-semibold">{day.split('-')[2]}</span>
      <span className="text-[9px] font-semibold uppercase">{WEEKDAY_SHORT[d.getDay()]}</span>
    </div>
  )
}

function calendarDetailBreakdown(detail: ReinforcementDetail, emptyLabel: string): string {
  const parts = []
  if (detail.main > 0) parts.push(`осн. ${fmt(detail.main)}`)
  if (detail.test > 0) parts.push(`проб. ${fmt(detail.test)}`)
  if (detail.dyn > 0) parts.push(`дин. ${fmt(detail.dyn)}`)
  if (detail.headcaps > 0) parts.push(`нагол. ${fmt(detail.headcaps)}`)
  return parts.join(' · ') || emptyLabel
}

function CalendarCellModal({ cell, onClose }: { cell: CalendarCellPopupState; onClose: () => void }) {
  const kind = cell.kind ?? 'piles'
  const factDetails = Array.isArray(cell.facts.fact_details) ? cell.facts.fact_details : []
  const planDetails = Array.isArray(cell.facts.plan_details) ? cell.facts.plan_details : []
  const lengthText = factLengthsText(cell.facts.fact_lengths)
  const factTotal = cell.facts.total ?? 0
  const planTotal = cell.facts.plan_total ?? 0
  const fieldCount = new Set([...factDetails, ...planDetails].map(detail => `${detail.section_code}:${detail.field_name}:${detail.pk_range}`)).size

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-white shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {cell.color && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: cell.color }} />}
              <h3 className="truncate text-sm font-semibold text-text-primary">{cell.title}</h3>
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {dayLabel(cell.day)} · {kind === 'headcaps' ? 'поля и пикеты наголовников' : 'поля, пикеты и длины свай'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted transition hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[calc(86vh-64px)] overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CalendarPopupMetric label="План" value={planTotal} tone="plan" />
            <CalendarPopupMetric label="Факт" value={factTotal} tone="fact" />
            <CalendarPopupMetric label="Отклонение" value={factTotal - planTotal} signedValue tone={factTotal >= planTotal ? 'ok' : 'risk'} />
            {kind === 'headcaps'
              ? <CalendarPopupMetric label="Поля" value={fieldCount} suffix="шт." tone="neutral" />
              : <CalendarPopupMetric label="Длины" value={validFactLengths(cell.facts.fact_lengths).length} suffix="тип." tone="neutral" />
            }
          </div>

          {kind !== 'headcaps' && lengthText && (
            <div className="mt-3 rounded border border-border bg-bg-surface px-3 py-2 text-xs text-text-primary">
              <span className="font-semibold">Длины свай: </span>
              <span className="font-mono text-text-muted">{lengthText}</span>
            </div>
          )}

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <CalendarDetailPanel
              title="Планируют"
              details={planDetails}
              emptyText="Плановой детализации по полям нет."
              emptyBreakdown="плана нет"
              tone="plan"
              showPileRigs={false}
            />
            <CalendarDetailPanel
              title={kind === 'headcaps' ? 'Смонтировали' : 'Забили'}
              details={factDetails}
              emptyText="Фактической детализации по полям нет."
              emptyBreakdown="факта нет"
              tone="fact"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function CalendarPopupMetric({
  label,
  value,
  suffix,
  signedValue = false,
  tone,
}: {
  label: string
  value: number
  suffix?: string
  signedValue?: boolean
  tone: 'plan' | 'fact' | 'ok' | 'risk' | 'neutral'
}) {
  const cls = tone === 'plan'
    ? 'border-amber-100 bg-amber-50 text-amber-900'
    : tone === 'fact'
      ? 'border-red-100 bg-red-50 text-red-900'
      : tone === 'ok'
        ? 'border-emerald-100 bg-emerald-50 text-emerald-900'
        : tone === 'risk'
          ? 'border-red-200 bg-red-50 text-red-900'
          : 'border-border bg-bg-surface text-text-primary'
  const display = signedValue ? signed(value) : fmt(value)
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 font-mono text-base font-semibold">{display}{suffix ? ` ${suffix}` : ''}</div>
    </div>
  )
}

function CalendarDetailPanel({
  title,
  details,
  emptyText,
  emptyBreakdown,
  tone,
  showPileRigs = true,
}: {
  title: string
  details: ReinforcementDetail[]
  emptyText: string
  emptyBreakdown: string
  tone: 'plan' | 'fact'
  showPileRigs?: boolean
}) {
  const total = details.reduce((sum, item) => sum + (item.total || 0), 0)
  const titleCls = tone === 'plan' ? 'text-amber-800' : 'text-red-800'
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className={`text-[11px] font-semibold uppercase tracking-wide ${titleCls}`}>{title}</div>
        <div className="font-mono text-xs font-semibold text-text-muted">{fmt(total)} шт</div>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {details.length === 0 ? (
          <div className="rounded border border-dashed border-border bg-bg-surface px-2 py-2 text-xs text-text-muted">{emptyText}</div>
        ) : details.map((detail, index) => (
          <CalendarDetailRow key={`${title}-${detail.section_code}-${detail.field_name}-${detail.pk_range}-${index}`} detail={detail} emptyBreakdown={emptyBreakdown} showPileRigs={showPileRigs} />
        ))}
      </div>
    </div>
  )
}

function CalendarDetailRow({
  detail,
  emptyBreakdown,
  showPileRigs = true,
}: {
  detail: ReinforcementDetail
  emptyBreakdown: string
  showPileRigs?: boolean
}) {
  const pkRanges = detailPkRanges(detail)
  const visiblePkRanges = pkRanges.slice(0, 4)
  return (
    <div className="rounded border border-border bg-bg-surface px-2 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 font-semibold text-text-primary">
          <div className="truncate">{detail.field_name}</div>
          <div className="mt-0.5 space-y-0.5 font-mono text-[11px] font-medium text-text-muted">
            {visiblePkRanges.map(pk => <div key={pk} className="truncate">{pk}</div>)}
            {pkRanges.length > visiblePkRanges.length && (
              <div className="text-[10px] font-semibold text-text-muted">+{pkRanges.length - visiblePkRanges.length} пикетажей</div>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right font-mono font-semibold text-text-primary">{fmt(detail.total)} шт</div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
        <span>{calendarDetailBreakdown(detail, emptyBreakdown)}</span>
        <span className="shrink-0">{detailDateLabel(detail)}</span>
      </div>
      {showPileRigs && <DetailPileRigList rigs={detail.pile_rigs} />}
    </div>
  )
}

function CalendarCell({
  day,
  selectedDate,
  value,
  plan,
  facts,
  title = 'Поля, пикеты и длины свай',
  onOpen,
}: {
  day: string
  selectedDate: string
  value: number
  plan: number
  facts: DayFacts
  title?: string
  onOpen: () => void
}) {
  const future = day > selectedDate
  const selected = day === selectedDate
  const tone = future ? 'empty' : progressTone(value, plan)
  const toneCls = toneClasses(tone)
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`flex min-h-8 min-w-0 items-center justify-center overflow-hidden rounded border px-1 py-1 text-center font-mono text-[11px] font-semibold tabular-nums transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 ${
        selected ? 'border-red-300 bg-red-50' : toneCls.bg
      } ${future ? 'text-neutral-300' : toneCls.text}`}
    >
      <span className="block w-full truncate leading-none">{future ? '' : value > 0 ? fmt(value) : '·'}</span>
    </button>
  )
}

function CalendarPlanCell({
  day,
  selectedDate,
  value,
  title = 'Поля, пикеты и длины свай',
  onOpen,
}: {
  day: string
  selectedDate: string
  value: number
  title?: string
  onOpen: () => void
}) {
  const selected = day === selectedDate
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`flex min-h-7 items-center justify-center rounded border px-0.5 font-mono text-[10px] font-semibold tabular-nums whitespace-nowrap transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
        selected ? 'border-sky-400 bg-sky-100 text-sky-950' : 'border-sky-200 bg-sky-50 text-sky-900'
      }`}
    >
      {value > 0 ? fmt(value) : '·'}
    </button>
  )
}

function CalendarTotalCell({
  day,
  selectedDate,
  value,
  plan,
  facts,
  title = 'Поля, пикеты и длины свай',
  onOpen,
}: {
  day: string
  selectedDate: string
  value: number
  plan: number
  facts: DayFacts
  title?: string
  onOpen: () => void
}) {
  const future = day > selectedDate
  const selected = day === selectedDate
  const tone = future ? 'empty' : progressTone(value, plan)
  const toneCls = toneClasses(tone)
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`flex min-h-8 min-w-0 items-center justify-center overflow-hidden rounded border px-1 py-1 text-center font-mono text-[11px] font-semibold tabular-nums transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 ${
        selected ? 'border-red-300 bg-red-50' : toneCls.bg
      } ${future ? 'text-neutral-300' : toneCls.text}`}
    >
      <span className="block w-full truncate leading-none">{future ? '—' : value > 0 ? fmt(value) : '—'}</span>
    </button>
  )
}
