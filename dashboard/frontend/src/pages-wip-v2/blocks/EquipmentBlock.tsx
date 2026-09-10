/**
 * Блок «Производительность техники» (на вкладке Аналитика).
 * Для каждого типа техники — строка с заголовком + горизонтальная сетка
 * 8 карточек (№1..№8). В тултипе — детализация по видам работ / материалам.
 *
 * Нормы и расчёт приходят из /api/wip/mechanization/aggregates,
 * который использует настройки производительности механизации.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Truck, X } from 'lucide-react'
import { sectionCodeToNumber } from '../../lib/sections'

interface WorkTypeDetail {
  wt_code: string
  wt_name: string
  norm_code: string
  norm_per_shift: number
  norm_unit: string
  fact_volume: number
  days: number
  shifts: number
  avg_units: number
  expected: number
  work_hours_total?: number
  percent: number | null
}

interface MaterialDetail {
  material: string
  quarry: string | null
  norm_per_shift: number | null
  norm_formula: string | null
  include_pit_to_stockpile: boolean | null
  fact_in_norm: number
  fact_off_norm: number
  trips_in_norm: number
  trips_off_norm: number
  days: number
  shifts: number
  avg_units: number
  expected: number
  work_hours_total?: number
  percent: number | null
}

interface EquipRow {
  section_code: string
  equipment_type: string
  percent: number | null
  avg_units: number
  work_days_total: number
  work_shifts_total: number
  work_hours_total?: number
  fact_volume_total_m3: number
  fact_volume_total_m2: number
  mileage_km_total?: number
  engine_hours_total?: number
  fuel_liters_total?: number
  operation_metric_rows?: number
  operation_work_shifts?: number
  by_work_type?: WorkTypeDetail[]
  by_material?: MaterialDetail[]
}

interface UnitWorkDetail {
  kind: 'work' | 'movement'
  date: string
  shift: string
  section: string
  object_code?: string | null
  object_name?: string | null
  object_type_code?: string | null
  object_type_name?: string | null
  work: string
  wt_code?: string | null
  material_code?: string | null
  material_name?: string | null
  movement_type?: string | null
  fact: number
  unit: string
  trips?: number | null
  source_volume?: number | null
  source_unit?: string | null
  source_trips?: number | null
  haul_distance_km?: number | null
  work_hours?: number | null
  reference_norm?: number | null
  norm?: number | null
  norm_unit?: string | null
  norm_code?: string | null
  norm_name?: string | null
  percent?: number | null
  participates_in_productivity: boolean
  exclusion_reason?: string | null
  work_type_productivity_enabled?: boolean
  row_productivity_enabled?: boolean
}

interface UnitDetail {
  unit_key: string
  equipment_type: string
  productivity_equipment_type: string
  brand_model: string
  plate_number: string
  unit_number: string
  ownership: string
  contractor: string
  section_code: string
  fact_total: number
  expected_total: number
  work_hours_total?: number
  percent: number | null
  shifts_with_details: number
  included_details: number
  excluded_details: number
  mileage_km_total?: number
  engine_hours_total?: number
  fuel_liters_total?: number
  operation_metric_rows?: number
  operation_work_shifts?: number
  details: UnitWorkDetail[]
}

interface EquipmentDetailPayload {
  from: string
  to: string
  bucket: string
  section_code: string
  equipment_type: string
  units: UnitDetail[]
  totals: {
    units: number
    details: number
    included_details: number
    excluded_details: number
  }
  calculation_logic?: string[]
}

const ORDER = ['самосвал', 'экскаватор', 'бульдозер', 'автогрейдер', 'каток'] as const
type EquipKey = typeof ORDER[number]

const LABEL: Record<EquipKey, string> = {
  'самосвал':    'Самосвал',
  'экскаватор':  'Экскаватор',
  'бульдозер':   'Бульдозер',
  'автогрейдер': 'Автогрейдер',
  'каток':       'Каток',
}

// Иконки техники — используем те же SVG, что и на карте (/public/icons/).
const ICON_SRC: Record<EquipKey, string> = {
  'самосвал':    '/icons/dump_truck.svg',
  'экскаватор':  '/icons/excavator.svg',
  'бульдозер':   '/icons/bulldozer.svg',
  'автогрейдер': '/icons/motor_grader.svg',
  'каток':       '/icons/road_roller.svg',
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))
const fmtN = (n: number, d = 1) => nf.format(Number(n.toFixed(d)))

const MATERIAL_DISPLAY: Record<string, string> = {
  SAND: 'Песок',
  COARSE_SAND: 'Крупный песок',
  SHPGS: 'ЩПГС',
  SHPS: 'ЩПС',
  PGS: 'ПГС',
  CRUSHED_STONE: 'Щебень',
  SCHEBEN: 'Щебень',
  SOIL: 'Грунт',
  PEAT: 'Торф',
}

const MOVEMENT_DISPLAY: Record<string, string> = {
  pit_to_stockpile: 'карьер - накопитель',
  pit_to_constructive: 'карьер - конструктив',
  stockpile_to_constructive: 'накопитель - конструктив',
  stockpile_to_stockpile: 'накопитель - накопитель',
  constructive_to_constructive: 'конструктив - конструктив',
  constructive_to_stockpile: 'конструктив - накопитель',
  stockpile_to_dump: 'накопитель - отвал',
  pit_to_dump: 'карьер - отвал',
  dump_to_constructive: 'отвал - конструктив',
}

function displayTechnicalName(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  if (!raw) return '—'
  const upper = raw.toUpperCase()
  if (MATERIAL_DISPLAY[upper]) return MATERIAL_DISPLAY[upper]
  if (MOVEMENT_DISPLAY[raw]) return MOVEMENT_DISPLAY[raw]

  let text = raw
  Object.entries(MATERIAL_DISPLAY).forEach(([code, label]) => {
    text = text.replace(new RegExp(`(^|[^\p{L}\p{N}_])${code}($|[^\p{L}\p{N}_])`, 'giu'), `$1${label}$2`)
  })
  Object.entries(MOVEMENT_DISPLAY).forEach(([code, label]) => {
    text = text.replaceAll(code, label)
  })
  text = text
    .replace(/\bsoil\b/gi, 'грунт')
    .replace(/\bmaterial\b/gi, 'материал')
    .replace(/\bnorm\b/gi, 'норма')
  return text
}

function pctColor(p: number | null): string {
  if (p == null) return '#737373'
  if (p >= 95) return '#16a34a'
  if (p >= 75) return '#f59e0b'
  return '#dc2626'
}

const EQUIPMENT_BLOCK_STALE_MS = 5 * 60_000

export function EquipmentBlock({ from, to, bucket = 'own' }: { from: string; to: string; view: string; bucket?: string }) {
  const order: EquipKey[] = [...ORDER]
  const { data, isLoading } = useQuery<{ rows: EquipRow[] }>({
    queryKey: ['wip', 'mechanization-aggregates', from, to, bucket],
    queryFn: () => fetch(`/api/wip/mechanization/aggregates?from=${from}&to=${to}&bucket=${bucket}`).then(r => r.json()),
    staleTime: EQUIPMENT_BLOCK_STALE_MS,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  const grouped = useMemo(() => {
    const g: Record<string, Record<number, EquipRow>> = {}
    for (const r of data?.rows ?? []) {
      const t = r.equipment_type.toLowerCase()
      g[t] ??= {}
      let n: number
      try { n = sectionCodeToNumber(r.section_code) } catch { continue }
      g[t][n] = r
    }
    return g
  }, [data])

  if (isLoading || !data) {
    return <div className="bg-white border border-border rounded-xl p-5 h-40 animate-pulse" />
  }

  return (
    <section className="bg-white border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-5">
        <Truck className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Производительность техники
        </h2>
        <span className="text-xs text-text-muted">
          данные с вкладки «Механизация» · нормы из «Настроек» · нулевые смены учитываются как 0%
        </span>
      </div>

      <div className="space-y-6">
        {order.map(key => (
          <EquipRowRow key={key} eqKey={key} bySection={grouped[key] ?? {}} from={from} to={to} bucket={bucket} />
        ))}
      </div>
    </section>
  )
}

function EquipRowRow({ eqKey, bySection, from, to, bucket }: { eqKey: EquipKey; bySection: Record<number, EquipRow>; from: string; to: string; bucket: string }) {
  const iconSrc = ICON_SRC[eqKey]
  const nums = [1, 2, 3, 4, 5, 6, 7, 8]
  const avgPercent = useMemo(() => {
    const rows = Object.values(bySection).filter(row => row.percent != null)
    if (!rows.length) return null
    const shiftWeight = rows.reduce((sum, row) => sum + Math.max(0, Number(row.work_shifts_total || 0)), 0)
    if (shiftWeight > 0) {
      return rows.reduce((sum, row) => sum + Number(row.percent || 0) * Math.max(0, Number(row.work_shifts_total || 0)), 0) / shiftWeight
    }
    return rows.reduce((sum, row) => sum + Number(row.percent || 0), 0) / rows.length
  }, [bySection])
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        {iconSrc ? (
          <img src={iconSrc} alt="" className="w-6 h-6 self-center" />
        ) : (
          <Truck className="w-5 h-5 text-text-primary self-center" strokeWidth={2} />
        )}
        <h3 className="font-heading font-semibold text-[12px] uppercase tracking-wider text-text-primary">
          {LABEL[eqKey]}
        </h3>
        <span className="rounded border border-border bg-bg-surface px-2 py-0.5 text-[10px] font-mono font-semibold" style={{ color: pctColor(avgPercent) }}>
          средняя: {avgPercent == null ? '—' : `${Math.round(avgPercent)}%`}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {nums.map(n => <SectionCard key={n} num={n} row={bySection[n]} from={from} to={to} bucket={bucket} />)}
      </div>
    </div>
  )
}

function SectionCard({ num, row, from, to, bucket }: { num: number; row: EquipRow | undefined; from: string; to: string; bucket: string }) {
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  // Для карточек в правой половине сетки (№5..№8) якорим тултип справа,
  // чтобы не уезжал за границу экрана.
  const anchorRight = num >= 5
  if (!row) {
    return (
      <div className="border border-border rounded-lg p-3 bg-white min-h-[88px] flex flex-col">
        <div className="text-[11px] font-semibold text-text-muted">№{num}</div>
        <div className="mt-auto text-text-muted text-sm">—</div>
      </div>
    )
  }
  const factLabel = row.fact_volume_total_m3 > 0 && row.fact_volume_total_m2 > 0
    ? `${fmt(row.fact_volume_total_m3)} м³ + ${fmt(row.fact_volume_total_m2)} м²`
    : row.fact_volume_total_m3 > 0
      ? `${fmt(row.fact_volume_total_m3)} м³`
      : row.fact_volume_total_m2 > 0
        ? `${fmt(row.fact_volume_total_m2)} м²`
        : '—'

  return (
    <div
      className="relative border border-border rounded-lg p-3 bg-white min-h-[88px] flex flex-col cursor-pointer transition-colors hover:border-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => setOpen(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setOpen(true)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="text-[11px] font-semibold text-text-muted">№{num}</div>
      <div
        className="font-heading font-bold leading-none mt-1"
        style={{ color: pctColor(row.percent), fontSize: 30 }}
      >
        {row.percent == null ? '—' : `${Math.round(row.percent)}%`}
      </div>
      <div className="mt-0.5 font-mono text-[24px] font-semibold leading-none text-text-primary whitespace-nowrap">
        {fmt(Number(row.fuel_liters_total || 0))} л
      </div>
      <div className="mt-auto text-[10px] font-mono text-text-muted pt-1">
        {factLabel} · {fmtN(Number(row.work_hours_total || 0), 1)} ч · {fmtN(row.avg_units, 1)} ед. · {row.work_shifts_total} см.
      </div>

      {hover && !open && (
        <div className={`absolute z-40 top-full mt-1 overflow-x-auto p-3 bg-[#1a1a1a] text-white rounded-lg shadow-xl text-[11px] leading-snug w-[min(calc(100vw-40px),1080px)] ${anchorRight ? 'right-0' : 'left-0'}`}>
          <div className="font-semibold mb-1 text-accent-red uppercase tracking-wider">
            {row.equipment_type} · №{num} · {row.percent == null ? '—' : Math.round(row.percent) + '%'} · {fmt(Number(row.fuel_liters_total || 0))} л
          </div>
          {row.by_work_type && row.by_work_type.length > 0 && (
            <WorkTypeTable rows={row.by_work_type} />
          )}
          {row.by_material && row.by_material.length > 0 && (
            <MaterialTable rows={row.by_material} />
          )}
          <div className="text-neutral-400 mt-2 text-[10px]">
            Процент считается по нормируемым работам: факт / сменная норма. В количестве техники учитываются только единицы, привязанные к нормируемой работе в смене.
          </div>
        </div>
      )}
      {open && (
        <EquipmentDetailModal
          row={row}
          sectionNum={num}
          from={from}
          to={to}
          bucket={bucket}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function shiftLabel(value: string | null | undefined): string {
  const raw = String(value || '').toLowerCase()
  if (raw === 'night') return 'ночь'
  if (raw === 'day') return 'день'
  return raw || '—'
}

function unitTitle(unit: UnitDetail): string {
  const parts = [
    displayTechnicalName(unit.equipment_type),
    unit.brand_model && unit.brand_model !== '—' ? unit.brand_model : null,
    unit.unit_number && unit.unit_number !== '—' ? `б/н ${unit.unit_number}` : null,
    unit.plate_number && unit.plate_number !== '—' ? `г/н ${unit.plate_number}` : null,
  ]
  return parts.filter(Boolean).join(' · ') || 'Единица техники'
}

function detailObjectLabel(detail: UnitWorkDetail): string {
  if (detail.object_name) return detail.object_name
  return '—'
}

function detailParams(detail: UnitWorkDetail): string {
  const flags: string[] = []
  if (detail.kind === 'movement') {
    if (detail.trips != null) flags.push(`${fmt(Number(detail.trips))} рейс.`)
    if (detail.haul_distance_km != null) flags.push(`плечо ${fmtN(Number(detail.haul_distance_km), 1)} км`)
  }
  return flags.join(' · ')
}

function detailReason(detail: UnitWorkDetail): string {
  const raw = detail.exclusion_reason || ''
  if (!raw) return 'учтено в нормируемом факте'
  return raw
    .split(';')
    .map(part => {
      const text = part.trim()
      if (/нет нормы для/i.test(text)) return 'нет нормы для этого вида техники и работы'
      return text
    })
    .filter(Boolean)
    .join('; ')
}

function EquipmentDetailModal({
  row,
  sectionNum,
  from,
  to,
  bucket,
  onClose,
}: {
  row: EquipRow
  sectionNum: number
  from: string
  to: string
  bucket: string
  onClose: () => void
}) {
  const params = new URLSearchParams({
    from,
    to,
    bucket,
    section_code: row.section_code,
    equipment_type: row.equipment_type,
  })
  const { data, isLoading, error } = useQuery<EquipmentDetailPayload, Error>({
    queryKey: ['wip', 'mechanization-aggregate-detail', from, to, bucket, row.section_code, row.equipment_type],
    queryFn: () => fetch(`/api/wip/mechanization/aggregates/detail?${params.toString()}`).then(async response => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.detail || 'Не удалось загрузить детализацию производительности')
      }
      return response.json()
    }),
    staleTime: EQUIPMENT_BLOCK_STALE_MS,
    gcTime: 15 * 60_000,
  })

  return (
    <div
      className="fixed inset-y-0 left-0 right-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:p-4 lg:left-64"
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
    >
      <div
        className="flex max-h-[calc(100dvh-1rem)] w-full flex-col rounded-lg border border-border bg-white shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Производительность техники · участок №{sectionNum}
            </div>
            <div className="mt-1 font-heading text-lg font-bold text-text-primary">
              {displayTechnicalName(row.equipment_type)}
            </div>
            <div className="mt-1 max-w-[1100px] text-xs leading-relaxed text-text-muted">
              {from} - {to} · единиц техники: {data?.totals.units ?? '—'} · строк фактов в расчете: {data?.totals.included_details ?? '—'} · строк фактов вне расчета: {data?.totals.excluded_details ?? '—'}.
              В расчете - привязанные к технике работы/перевозки с включенным флагом производительности, положительным фактом и нормой; вне расчета - привязанные строки, которые не вошли в процент по причине в таблице.
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
          {isLoading && <div className="h-28 animate-pulse rounded-lg bg-bg-surface" />}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error.message}</div>}
          {!isLoading && !error && data && (
            <>
              {data.units.length === 0 ? (
                <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-text-muted">
                  Для этой карточки нет привязанных к технике работ или перевозок.
                </div>
              ) : (
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full min-w-[1180px] text-xs">
                    <thead className="sticky top-0 z-10 bg-bg-surface text-[10px] uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left">Дата</th>
                        <th className="px-3 py-2 text-left">Объект / маршрут</th>
                        <th className="px-3 py-2 text-left">Работа</th>
                        <th className="px-3 py-2 text-right">Время</th>
                        <th className="px-3 py-2 text-right">Факт</th>
                        <th className="px-3 py-2 text-right">Норма</th>
                        <th className="px-3 py-2 text-right">%</th>
                        <th className="px-3 py-2 text-left">Участвует в расчете производительности</th>
                        <th className="px-3 py-2 text-left">Параметры / причина</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.units.flatMap(unit => [
                        <tr key={`${unit.unit_key}-head`} className="border-t border-border bg-white">
                          <td colSpan={9} className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-text-primary">{unitTitle(unit)}</span>
                              <span className="rounded border border-border bg-bg-surface px-2 py-0.5 font-mono text-[10px] text-text-muted">
                                {unit.percent == null ? '—' : `${Math.round(unit.percent)}%`}
                              </span>
                              <span className="text-[11px] text-text-muted">
                                время {fmtN(Number(unit.work_hours_total || 0), 1)} ч · факт {fmt(unit.fact_total)} · норма {fmt(unit.expected_total)} · смен {unit.shifts_with_details}
                              </span>
                              <span className="text-[11px] text-text-muted">
                                расход {fmt(Number(unit.fuel_liters_total || 0))} л · моточасы {fmtN(Number(unit.engine_hours_total || 0), 1)} · пробег {fmt(Number(unit.mileage_km_total || 0))} км
                              </span>
                            </div>
                          </td>
                        </tr>,
                        ...unit.details.map((detail, index) => (
                          <tr key={`${unit.unit_key}-${detail.kind}-${detail.date}-${detail.shift}-${detail.wt_code}-${index}`} className="border-t border-border/70 align-top">
                            <td className="whitespace-nowrap px-3 py-2 font-mono">
                              <div>{detail.date}</div>
                              <div className="text-[10px] text-text-muted">{shiftLabel(detail.shift)}</div>
                            </td>
                            <td className="max-w-[240px] px-3 py-2">
                              <div className="break-words text-text-primary">{detailObjectLabel(detail)}</div>
                              {detail.object_type_name && <div className="mt-0.5 text-[10px] text-text-muted">{displayTechnicalName(detail.object_type_name)}</div>}
                            </td>
                            <td className="max-w-[260px] px-3 py-2">
                              <div className="break-words text-text-primary">{displayTechnicalName(detail.work)}</div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                              {fmtN(Number(detail.work_hours ?? 11), 1)} ч
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                              {fmt(Number(detail.fact || 0))} {detail.unit || ''}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                              {detail.norm == null ? '—' : `${fmt(Number(detail.norm))} ${detail.norm_unit || ''}/см`}
                              {detail.reference_norm != null && Number(detail.reference_norm) !== Number(detail.norm) && (
                                <div className="text-[10px] text-text-muted">справочно {fmt(Number(detail.reference_norm))} / 11 ч</div>
                              )}
                              {detail.norm_name && <div className="text-[10px] text-text-muted">{displayTechnicalName(detail.norm_name)}</div>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold" style={{ color: pctColor(detail.percent ?? null) }}>
                              {detail.percent == null ? '—' : `${Math.round(detail.percent)}%`}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${detail.participates_in_productivity ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-600'}`}>
                                {detail.participates_in_productivity ? 'Да' : 'Нет'}
                              </span>
                            </td>
                            <td className="max-w-[260px] px-3 py-2 text-[11px] text-text-muted">
                              <div>{detailReason(detail)}</div>
                              {detailParams(detail) && <div className="mt-0.5 font-mono">{detailParams(detail)}</div>}
                            </td>
                          </tr>
                        )),
                      ])}
                    </tbody>
                  </table>
                </div>
              )}

            </>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkTypeTable({ rows }: { rows: WorkTypeDetail[] }) {
  return (
    <table className="w-full min-w-[760px] text-[10.5px] font-mono">
      <thead className="text-neutral-400">
        <tr>
          <th className="text-left pb-1">Работа</th>
          <th className="text-right pb-1">Норма/см</th>
          <th className="text-right pb-1">Норма (ожид.)</th>
          <th className="text-right pb-1">Факт</th>
          <th className="text-right pb-1">Часы</th>
          <th className="text-right pb-1">См.</th>
          <th className="text-right pb-1">Ед./см</th>
          <th className="text-right pb-1">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(w => (
          <tr key={w.wt_code} className="text-neutral-200 border-t border-neutral-700">
            <td className="text-left py-1 pr-3 text-[10px] leading-tight whitespace-normal break-words min-w-[220px]" title={displayTechnicalName(w.wt_name)}>
              {displayTechnicalName(w.wt_name)}
            </td>
            <td className="text-right py-1">{fmt(w.norm_per_shift)} {w.norm_unit}</td>
            <td className="text-right py-1 whitespace-nowrap">
              <div>{w.expected > 0 ? fmt(w.expected) : '—'}</div>
              {w.expected > 0 && (
                <div className="text-[9px] text-neutral-400">
                  {fmtN(Number(w.work_hours_total || 0), 1)} ч / 11 × {fmt(w.norm_per_shift)}
                </div>
              )}
            </td>
            <td className="text-right py-1">{fmt(w.fact_volume)}</td>
            <td className="text-right py-1">{fmtN(Number(w.work_hours_total || 0), 1)}</td>
            <td className="text-right py-1">{w.shifts}</td>
            <td className="text-right py-1">{fmtN(w.avg_units, 1)}</td>
            <td className="text-right py-1 font-semibold" style={{ color: pctColor(w.percent) }}>
              {w.percent == null ? '—' : Math.round(w.percent) + '%'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MaterialTable({ rows }: { rows: MaterialDetail[] }) {
  return (
    <table className="w-full min-w-[760px] text-[10.5px] font-mono">
      <thead className="text-neutral-400">
        <tr>
          <th className="text-left pb-1">Материал</th>
          <th className="text-left pb-1">Карьер</th>
          <th className="text-right pb-1">Норма</th>
          <th className="text-right pb-1">Норма (ожид.)</th>
          <th className="text-right pb-1">Факт (в норме)</th>
          <th className="text-right pb-1">Часы</th>
          <th className="text-right pb-1">Вне нормы</th>
          <th className="text-right pb-1">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(m => (
          <tr key={m.material} className="text-neutral-200 border-t border-neutral-700">
            <td className="text-left py-1 pr-2">{displayTechnicalName(m.material)}</td>
            <td className="text-left py-1 pr-3 text-[10px] whitespace-normal break-words min-w-[220px]" title={m.quarry ?? ''}>
              {m.quarry ?? '—'}
            </td>
            <td className="text-right py-1 whitespace-nowrap">
              <div>{m.norm_per_shift == null ? '—' : `${fmt(m.norm_per_shift)} м³/см`}</div>
              {m.norm_formula && <div className="text-[9px] text-neutral-400">{displayTechnicalName(m.norm_formula)}</div>}
            </td>
            <td className="text-right py-1 whitespace-nowrap">
              <div>{m.expected > 0 ? fmt(m.expected) : '—'}</div>
              {m.expected > 0 && (
                <div className="text-[9px] text-neutral-400">
                  {fmtN(m.avg_units, 1)}×{fmt(m.norm_per_shift ?? 0)}×{m.shifts}см
                </div>
              )}
            </td>
            <td className="text-right py-1">{fmt(m.fact_in_norm)}</td>
            <td className="text-right py-1">{m.work_hours_total == null ? '—' : fmtN(m.work_hours_total, 1)}</td>
            <td className="text-right py-1 text-neutral-400">{fmt(m.fact_off_norm)}</td>
            <td className="text-right py-1 font-semibold" style={{ color: pctColor(m.percent) }}>
              {m.percent == null ? '—' : Math.round(m.percent) + '%'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
