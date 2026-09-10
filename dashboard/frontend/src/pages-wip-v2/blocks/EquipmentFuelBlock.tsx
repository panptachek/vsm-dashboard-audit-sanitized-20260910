import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Fuel, Truck, X } from 'lucide-react'
import { sectionCodeToNumber } from '../../lib/sections'

interface FuelRow {
  section_code: string
  equipment_type: string
  mileage_km_total: number
  engine_hours_total: number
  fuel_liters_total: number
  operation_metric_rows: number
  operation_work_shifts: number
  operation_units_count?: number
}

interface FuelPayload {
  from: string
  to: string
  bucket: string
  total_fuel_liters: number
  total_mileage_km: number
  total_engine_hours: number
  rows: FuelRow[]
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(Number.isFinite(n) ? n : 0))
const fmtN = (n: number, d = 1) => nf.format(Number((Number.isFinite(n) ? n : 0).toFixed(d)))
const FUEL_BLOCK_STALE_MS = 5 * 60_000
const MAIN_TYPES = ['самосвал', 'экскаватор', 'бульдозер', 'автогрейдер', 'каток'] as const
type MainFuelType = typeof MAIN_TYPES[number]
type FuelGroupKey = MainFuelType | 'other'

const MAIN_LABELS: Record<MainFuelType, string> = {
  'самосвал': 'Самосвал',
  'экскаватор': 'Экскаватор',
  'бульдозер': 'Бульдозер',
  'автогрейдер': 'Автогрейдер',
  'каток': 'Каток',
}

const ICON_SRC: Record<MainFuelType, string> = {
  'самосвал': '/icons/dump_truck.svg',
  'экскаватор': '/icons/excavator.svg',
  'бульдозер': '/icons/bulldozer.svg',
  'автогрейдер': '/icons/motor_grader.svg',
  'каток': '/icons/road_roller.svg',
}

interface FuelCell {
  section_code: string
  mileage_km_total: number
  engine_hours_total: number
  fuel_liters_total: number
  operation_metric_rows: number
  operation_work_shifts: number
  operation_units_count: number
  details: FuelRow[]
}

interface FuelGroup {
  key: FuelGroupKey
  label: string
  bySection: Record<number, FuelCell>
  fuel: number
}

function displayName(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  if (!raw) return 'Не указано'
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

function productivityType(value: string | null | undefined): FuelGroupKey {
  const text = String(value || '').trim().toLowerCase().replace('ё', 'е')
  if (!text) return 'other'
  if (text.includes('самос') || text.includes('dump') || text.includes('truck')) return 'самосвал'
  if (text.includes('экскав')) return 'экскаватор'
  if (text.includes('бульд')) return 'бульдозер'
  if (text.includes('грейдер') || text.includes('grader')) return 'автогрейдер'
  if (text.includes('каток') || text.includes('roller')) return 'каток'
  return 'other'
}

function emptyFuelCell(sectionCode: string): FuelCell {
  return {
    section_code: sectionCode,
    mileage_km_total: 0,
    engine_hours_total: 0,
    fuel_liters_total: 0,
    operation_metric_rows: 0,
    operation_work_shifts: 0,
    operation_units_count: 0,
    details: [],
  }
}

function addFuelRow(target: FuelCell, row: FuelRow) {
  target.mileage_km_total += Number(row.mileage_km_total || 0)
  target.engine_hours_total += Number(row.engine_hours_total || 0)
  target.fuel_liters_total += Number(row.fuel_liters_total || 0)
  target.operation_metric_rows += Number(row.operation_metric_rows || 0)
  target.operation_work_shifts += Number(row.operation_work_shifts || 0)
  target.operation_units_count += Number(row.operation_units_count || 0)
  target.details.push(row)
}

function hasFuelCellData(row: FuelCell | undefined): row is FuelCell {
  if (!row) return false
  return row.details.length > 0
}

export function EquipmentFuelBlock({ from, to, bucket = 'all' }: { from: string; to: string; bucket?: string }) {
  const { data, isLoading } = useQuery<FuelPayload>({
    queryKey: ['wip', 'mechanization-fuel-aggregates', from, to, bucket],
    queryFn: () => fetch(`/api/wip/mechanization/fuel-aggregates?from=${from}&to=${to}&bucket=${bucket}`).then(r => r.json()),
    staleTime: FUEL_BLOCK_STALE_MS,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  const grouped = useMemo(() => {
    const byType: Record<FuelGroupKey, Record<number, FuelCell>> = {
      'самосвал': {},
      'экскаватор': {},
      'бульдозер': {},
      'автогрейдер': {},
      'каток': {},
      other: {},
    }
    const totals = new Map<FuelGroupKey, number>()
    for (const row of data?.rows ?? []) {
      let sectionNumber: number
      try { sectionNumber = sectionCodeToNumber(row.section_code) } catch { continue }
      const key = productivityType(row.equipment_type)
      byType[key][sectionNumber] ??= emptyFuelCell(row.section_code)
      addFuelRow(byType[key][sectionNumber], row)
      totals.set(key, (totals.get(key) || 0) + Number(row.fuel_liters_total || 0))
    }
    const main = MAIN_TYPES.map(key => ({
      key,
      label: MAIN_LABELS[key],
      bySection: byType[key],
      fuel: totals.get(key) || 0,
    }))
    const otherFuel = totals.get('other') || 0
    const otherHasRows = Object.values(byType.other).some(row => row.details.length > 0)
    return otherHasRows
      ? [...main, { key: 'other' as const, label: 'Иные категории', bySection: byType.other, fuel: otherFuel }]
      : main
  }, [data?.rows])
  const hasRows = (data?.rows ?? []).length > 0

  if (isLoading || !data) {
    return <div className="bg-white border border-border rounded-xl p-5 h-40 animate-pulse" />
  }

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm">
      <div className="flex flex-wrap items-start gap-3 mb-5">
        <div className="flex items-center gap-2 mr-auto">
          <Fuel className="w-5 h-5 text-text-primary" strokeWidth={2} />
          <div>
            <h2 className="text-base font-semibold text-gray-800 font-heading tracking-wide uppercase">
              Расход топлива
            </h2>
            <div className="text-[11px] text-text-muted font-mono">
              пробег, моточасы и расход из эксплуатационных отчетов
            </div>
          </div>
        </div>
        <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Всего</div>
          <div className="font-heading text-lg font-bold text-text-primary">{fmt(data.total_fuel_liters)} л</div>
        </div>
      </div>

      {!hasRows ? (
        <div className="rounded-md border border-border bg-bg-surface px-4 py-8 text-center text-sm text-text-muted">
          Нет эксплуатационных метрик за выбранный период.
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(group => (
            <FuelTypeRow key={group.key} group={group} />
          ))}
        </div>
      )}
    </section>
  )
}

function FuelTypeRow({ group }: { group: FuelGroup }) {
  const nums = [1, 2, 3, 4, 5, 6, 7, 8]
  const iconSrc = group.key !== 'other' ? ICON_SRC[group.key] : null
  const totalFuel = Object.values(group.bySection).reduce((sum, row) => sum + Number(row.fuel_liters_total || 0), 0)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        {iconSrc ? (
          <img src={iconSrc} alt="" className="h-6 w-6" />
        ) : (
          <Truck className="w-5 h-5 text-text-primary" strokeWidth={2} />
        )}
        <h3 className="font-heading font-semibold text-[12px] uppercase tracking-wider text-text-primary">
          {group.label}
        </h3>
        <span className="rounded border border-border bg-bg-surface px-2 py-0.5 text-[10px] font-mono font-semibold text-text-primary">
          {fmt(totalFuel)} л
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {nums.map(num => <FuelSectionCard key={num} num={num} row={group.bySection[num]} groupLabel={group.label} />)}
      </div>
    </div>
  )
}

function FuelSectionCard({ num, row, groupLabel }: { num: number; row?: FuelCell; groupLabel: string }) {
  const [open, setOpen] = useState(false)
  if (!row) {
    return (
      <div className="border border-border rounded-lg bg-white p-2.5 min-h-[92px] flex flex-col">
        <div className="text-[11px] font-semibold text-text-muted">№{num}</div>
        <div className="mt-auto text-text-muted text-sm">—</div>
      </div>
    )
  }
  return (
    <div
      className="relative border border-border rounded-lg bg-white p-2.5 min-h-[92px] flex flex-col cursor-pointer transition-colors hover:border-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
      onClick={() => setOpen(true)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setOpen(true)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="text-[11px] font-semibold text-text-muted">№{num}</div>
      <div className="mt-1 whitespace-nowrap font-heading text-[22px] font-bold leading-none text-text-primary">
        {fmt(Number(row.fuel_liters_total || 0))}
        <span className="ml-1 align-baseline font-mono text-[10px] font-semibold">л</span>
      </div>
      <div className="mt-1 whitespace-nowrap text-[10px] font-mono font-semibold text-text-primary">
        {fmt(Number(row.operation_units_count || 0))} ед. техники
      </div>
      <div className="mt-auto text-[10px] font-mono text-text-muted pt-1">
        {fmtN(Number(row.engine_hours_total || 0), 1)} мч · {fmt(Number(row.mileage_km_total || 0))} км
      </div>
      {open && hasFuelCellData(row) && (
        <FuelDetailModal row={row} sectionNum={num} groupLabel={groupLabel} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

function FuelDetailModal({
  row,
  sectionNum,
  groupLabel,
  onClose,
}: {
  row: FuelCell
  sectionNum: number
  groupLabel: string
  onClose: () => void
}) {
  const rows = [...row.details].sort((a, b) => Number(b.fuel_liters_total || 0) - Number(a.fuel_liters_total || 0) || displayName(a.equipment_type).localeCompare(displayName(b.equipment_type), 'ru'))
  return (
    <div
      className="fixed inset-y-0 left-0 right-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:p-4 lg:left-64"
      onClick={event => {
        event.stopPropagation()
        onClose()
      }}
    >
      <div
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col rounded-lg border border-border bg-white shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Расход топлива · участок №{sectionNum}
            </div>
            <div className="mt-1 font-heading text-lg font-bold text-text-primary">{groupLabel}</div>
            <div className="mt-1 text-xs text-text-muted">
              {fmt(row.fuel_liters_total)} л · {fmtN(row.engine_hours_total, 1)} мч · {fmt(row.mileage_km_total)} км · {fmt(row.operation_units_count)} ед. техники
            </div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded border border-border bg-white text-text-muted hover:text-text-primary"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Категория</th>
                  <th className="px-2 py-2 text-right">Ед. техники</th>
                  <th className="px-2 py-2 text-right">Расход</th>
                  <th className="px-2 py-2 text-right">Моточасы</th>
                  <th className="px-2 py-2 text-right">Пробег</th>
                  <th className="px-3 py-2 text-right">Строк метрик</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(detail => (
                  <tr key={`${detail.section_code}|${detail.equipment_type}`} className="border-t border-border/70">
                    <td className="px-3 py-2 font-semibold text-text-primary">{displayName(detail.equipment_type)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(Number(detail.operation_units_count || 0))}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(Number(detail.fuel_liters_total || 0))} л</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtN(Number(detail.engine_hours_total || 0), 1)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(Number(detail.mileage_km_total || 0))} км</td>
                    <td className="px-3 py-2 text-right font-mono text-text-muted">{fmt(Number(detail.operation_metric_rows || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
