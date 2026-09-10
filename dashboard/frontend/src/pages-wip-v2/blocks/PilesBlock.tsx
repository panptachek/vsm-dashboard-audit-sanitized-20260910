/**
 * Блок «Свайные работы»: KPI карточки + таблица по участкам (с начала / факт / проект).
 * Проект = статический каталог свайных полей из pile_fields.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Columns3 } from 'lucide-react'
import { ACTIVE_SECTION_CODES, sectionCodeToNumber } from '../../lib/sections'

interface PileRow {
  id: string
  field_code: string | null
  field_type: 'main' | 'test' | string
  pile_type: string | null
  pile_count: number | null
  dynamic_test_count: number | null
  section_code: string
  pk_start: number | null
  pk_end: number | null
  is_demo?: boolean
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))
const PILES_STALE_MS = 5 * 60_000

interface SecStats {
  main: number
  test: number
  dyn: number
}

export function PilesBlock({
  from, to, planLabel = 'Проект',
}: { from: string; to: string; view: 'table'|'cards'|'timeline'; planLabel?: string }) {
  const { data, isLoading } = useQuery<{
    rows: PileRow[]
    fact_by_section?: Record<string, { main: number; test: number; dyn: number }>
    fact_totals?: { main: number; test: number; dyn: number }
    cumulative_by_section?: Record<string, { main: number; test: number; dyn: number }>
    cumulative_totals?: { main: number; test: number; dyn: number }
    plan_by_section?: Record<string, { main: number; test: number; dyn: number }>
    plan_totals?: { main: number; test: number; dyn: number }
  }>({
    queryKey: ['wip', 'piles', from, to],
    queryFn: () => fetch(`/api/wip/piles?from=${from}&to=${to}`).then(r => r.json()),
    staleTime: PILES_STALE_MS,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  // Для обычного Обзора оставляем проект из pile_fields. Для Дашборда
  // planLabel="План" означает календарный план из pile_plan_periods за выбранный период.
  const { projectBySec, projectTotals, factBySec, factTotals, cumulativeBySec } = useMemo(() => {
    const rows = data?.rows ?? []
    const catalogBySec: Record<string, SecStats> = {}
    const catalogTotals: SecStats = { main: 0, test: 0, dyn: 0 }
    for (const r of rows) {
      const sec = r.section_code
      catalogBySec[sec] ??= { main: 0, test: 0, dyn: 0 }
      const cnt = r.pile_count ?? 0
      if (r.field_type === 'test') {
        catalogBySec[sec].test += cnt
        catalogTotals.test += cnt
      } else {
        catalogBySec[sec].main += cnt
        catalogTotals.main += cnt
      }
      const dc = r.dynamic_test_count ?? 0
      catalogBySec[sec].dyn += dc
      catalogTotals.dyn += dc
    }
    const usePlan = planLabel === 'План'
    const projectBySec = usePlan ? (data?.plan_by_section ?? {}) : catalogBySec
    const projectTotals = usePlan ? (data?.plan_totals ?? { main: 0, test: 0, dyn: 0 }) : catalogTotals
    const factBySec = data?.fact_by_section ?? {}
    const factTotals = data?.fact_totals ?? { main: 0, test: 0, dyn: 0 }
    const cumulativeBySec = data?.cumulative_by_section ?? {}
    return { projectBySec, projectTotals, factBySec, factTotals, cumulativeBySec }
  }, [data, planLabel])

  if (isLoading || !data) {
    return <div className="bg-white border border-border rounded-xl p-5 h-40 animate-pulse" />
  }

  // Группировка по номеру участка 1..8 (UCH_31+UCH_32 → №3)
  const sectionNums = [1, 2, 3, 4, 5, 6, 7, 8]
  const projectByNum: Record<number, SecStats> = {}
  const factByNum: Record<number, SecStats> = {}
  const cumulativeByNum: Record<number, SecStats> = {}
  for (const code of ACTIVE_SECTION_CODES) {
    const n = sectionCodeToNumber(code)
    projectByNum[n] ??= { main: 0, test: 0, dyn: 0 }
    factByNum[n] ??= { main: 0, test: 0, dyn: 0 }
    cumulativeByNum[n] ??= { main: 0, test: 0, dyn: 0 }
    const p = projectBySec[code]; const f = factBySec[code]; const c = cumulativeBySec[code]
    if (p) { projectByNum[n].main += p.main; projectByNum[n].test += p.test; projectByNum[n].dyn += p.dyn }
    if (f) { factByNum[n].main += f.main; factByNum[n].test += f.test; factByNum[n].dyn += f.dyn }
    if (c) { cumulativeByNum[n].main += c.main; cumulativeByNum[n].test += c.test; cumulativeByNum[n].dyn += c.dyn }
  }

  const planValue = (value: number) => planLabel === 'План' && value <= 0 ? '—' : fmt(value)
  const isDashboardPlan = planLabel === 'План'
  const totalFact = (factTotals.main || 0) + (factTotals.test || 0)
  const totalPlan = (projectTotals.main || 0) + (projectTotals.test || 0)

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Columns3 className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Свайные работы
        </h2>
        <span className="text-xs text-text-muted">
          факт за период · {planLabel.toLowerCase()} {planLabel === 'План' ? 'за период' : 'с начала'} · прогресс
        </span>
      </div>

      {/* KPI cards: проект = pile_fields catalog, факт = daily_work_items за период */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <KpiCard label="СВАИ ОСНОВНЫЕ" fact={factTotals.main} project={projectTotals.main} planLabel={planLabel} />
        <KpiCard label="СВАИ ПРОБНЫЕ" fact={factTotals.test} project={projectTotals.test} planLabel={planLabel} />
        {isDashboardPlan ? (
          <KpiCard label="СВАИ ВСЕГО" fact={totalFact} project={totalPlan} planLabel={planLabel} />
        ) : (
          <KpiCard label="ДИНАМ. ИСПЫТАНИЯ" fact={factTotals.dyn} project={projectTotals.dyn} planLabel={planLabel} />
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-text-muted uppercase tracking-wider text-[10px]">
              <th className="text-left py-2 pr-3 font-semibold">УЧ.</th>
              <th colSpan={3} className="text-center py-2 px-2 font-semibold border-l border-border/60">ОСНОВНЫЕ, ШТ</th>
              <th colSpan={3} className="text-center py-2 px-2 font-semibold border-l border-border/60">ПРОБНЫЕ, ШТ</th>
              {!isDashboardPlan && <th colSpan={2} className="text-center py-2 px-2 font-semibold border-l border-border/60">ДИН. ИСП.</th>}
            </tr>
            <tr className="text-text-muted uppercase tracking-wider text-[10px]">
              <th className="text-left py-1 pr-3 font-normal"></th>
              <th className="text-right py-1 px-2 font-normal border-l border-border/60">С НАЧАЛА</th>
              <th className="text-right py-1 px-2 font-normal">ФАКТ</th>
              <th className="text-right py-1 px-2 font-normal">{planLabel.toUpperCase()}</th>
              <th className="text-right py-1 px-2 font-normal border-l border-border/60">С НАЧАЛА</th>
              <th className="text-right py-1 px-2 font-normal">ФАКТ</th>
              <th className="text-right py-1 px-2 font-normal">{planLabel.toUpperCase()}</th>
              {!isDashboardPlan && (
                <>
                  <th className="text-right py-1 px-2 font-normal border-l border-border/60">ФАКТ</th>
                  <th className="text-right py-1 px-2 font-normal">{planLabel.toUpperCase()}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sectionNums.map(n => {
              const p = projectByNum[n]
              const f = factByNum[n]
              const c = cumulativeByNum[n]
              return (
                <tr key={n} className="border-t border-border/60">
                  <td className="py-2 pr-3 font-semibold text-text-primary">№{n}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary border-l border-border/60">{fmt(c.main)}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">{fmt(f.main)}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">{planValue(p.main)}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary border-l border-border/60">{fmt(c.test)}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">{fmt(f.test)}</td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">{planValue(p.test)}</td>
                  {!isDashboardPlan && (
                    <>
                      <td className="py-2 px-2 text-right font-mono text-text-secondary border-l border-border/60">{fmt(f.dyn)}</td>
                      <td className="py-2 px-2 text-right font-mono text-text-secondary">{planValue(p.dyn)}</td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[11px] text-text-muted">
        {planLabel === 'План' ? 'План — календарные значения из pile_plan_periods за выбранный период.' : <>Проект — SUM(pile_count) из <code className="font-mono bg-bg-surface px-1 rounded">pile_fields</code>.</>}
        Факт — SUM(volume) из <code className="font-mono bg-bg-surface px-1 rounded">daily_work_items</code> за период по work_types {isDashboardPlan ? 'PILE_MAIN/PILE_TRIAL' : 'PILE_MAIN/PILE_TRIAL/PILE_DYNTEST'}. Если факт = 0 — свайные работы ещё не размечены в суточных отчётах.
      </div>
    </section>
  )
}

function KpiCard({ label, fact, project, planLabel }: { label: string; fact: number; project: number; planLabel: string }) {
  const pct = project > 0 ? Math.round((fact / project) * 100) : 0
  return (
    <div className="border border-border rounded-lg p-4 bg-white">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">
        {label}
      </div>
      <div className="font-heading font-bold text-[34px] leading-none tracking-tight text-text-primary">
        {fmt(fact)}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-text-muted">
        факт за период
      </div>
      <div className="mt-2 flex items-baseline gap-1 text-[12px] font-mono text-text-secondary">
        <span className="text-text-muted">{planLabel}:</span>
        <span className="text-text-primary">{project > 0 ? fmt(project) : '—'}</span>
        <span className="text-text-muted mx-1">·</span>
        <span className="text-[#16a34a] font-semibold">{project > 0 ? `${pct}%` : '—'}</span>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-bg-surface overflow-hidden">
        <div className="h-full bg-[#16a34a]" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}
