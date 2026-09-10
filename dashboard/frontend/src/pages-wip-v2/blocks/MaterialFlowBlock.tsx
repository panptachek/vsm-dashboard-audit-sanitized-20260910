/**
 * Material movement blocks.
 * Two views are rendered on dashboards:
 * - «Возка с карьеров»: all non-zero movements whose source is a quarry.
 * - «Перевозка»: stockpile/constructive transfers grouped by material and dispatch point.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Truck, X } from 'lucide-react'
import { sectionCodeToUILabel } from '../../lib/sections'

const MATERIAL_FLOW_STALE_MS = 5 * 60_000
const MATERIAL_FLOW_GC_MS = 15 * 60_000

type Material = string
type LaborBucket = 'own' | 'almaz' | 'hire'
type Mode = 'sections' | 'sources' | 'labor'
type FlowKind = 'quarry' | 'transfer'

interface Row {
  section_code: string
  source_report_id?: string | null
  report_date?: string | null
  report_date_from?: string | null
  report_date_to?: string | null
  submitted_at?: string | null
  source_reference?: string | null
  material: Material
  quarry_id: string | null
  quarry_name: string | null
  source_object_id?: string | null
  source_group_key?: string | null
  source_object_name?: string | null
  source_object_code?: string | null
  source_object_type_code?: string | null
  source_object_type_name?: string | null
  source_kind?: 'quarry' | 'stockpile' | 'object' | 'unknown' | string | null
  destination_object_id?: string | null
  destination_object_name?: string | null
  destination_object_code?: string | null
  destination_object_type_code?: string | null
  destination_object_type_name?: string | null
  destination_kind?: 'quarry' | 'stockpile' | 'object' | 'unknown' | string | null
  contractor_id: string | null
  contractor_name: string | null
  contractor_short: string | null
  contractor_kind: 'own' | 'subcontractor' | 'supplier'
  contractor_bucket?: 'zhds' | 'almaz' | 'hire'
  volume: number
  trips: number
  haul_distance_km?: number | null
  ton_km?: number | null
  haul_distance_missing_count?: number
  equipment_count?: number
  movement_type?: string
  movement_label?: string
  shift?: string
  synthetic?: boolean
}

interface MaterialMeta {
  key: string
  label: string
  color: string
  total: number
}

interface Agg {
  byMaterial: Record<string, number>
  byLabor: Record<LaborBucket, number>
  byMaterialLabor: Record<string, Record<LaborBucket, number>>
  total: number
}

interface TableRow {
  key: string
  label: string
  hint?: string
  agg: Agg
  rows: Row[]
}

interface DrilldownState {
  mode: Mode
  key: string
  label: string
  kind: FlowKind
  rows: Row[]
  materials: MaterialMeta[]
}

const BUCKET_COLOR: Record<LaborBucket, string> = {
  own: '#1a1a1a',
  almaz: '#dc2626',
  hire: '#7f1d1d',
}

const LABOR_COLUMNS: { key: LaborBucket; label: string }[] = [
  { key: 'own', label: 'ЖДС' },
  { key: 'almaz', label: 'АЛМАЗ' },
  { key: 'hire', label: 'Наёмники' },
]

const MATERIAL_ORDER = ['SAND', 'COARSE_SAND', 'SHPGS', 'SHPS', 'CRUSHED_STONE', 'SCHEBEN', 'PGS', 'SOIL', 'PEAT']
const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))

function formatPlainDate(value?: string | null): string {
  const raw = String(value || '').slice(0, 10)
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (match) return `${match[3]}.${match[2]}.${match[1]}`
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU')
}

function formatSubmittedAt(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function QuarryMaterialFlowBlock(props: Omit<MaterialFlowBlockProps, 'kind'>) {
  return <MaterialFlowBlock {...props} kind="quarry" />
}

export function TransferMaterialFlowBlock(props: Omit<MaterialFlowBlockProps, 'kind'>) {
  return <MaterialFlowBlock {...props} kind="transfer" />
}

interface MaterialFlowBlockProps {
  from: string
  to: string
  view: 'table' | 'cards' | 'timeline'
  endpoint?: string
  kind?: FlowKind
}

export function MaterialFlowBlock({ from, to, endpoint, kind = 'quarry' }: MaterialFlowBlockProps) {
  const [mode, setMode] = useState<Mode>('sections')
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null)

  const dataUrl = endpoint ?? `/api/wip/material-flow?from=${from}&to=${to}`
  const { data, isLoading } = useQuery<{ rows: Row[]; fallback_used?: boolean; note?: string | null }>({
    queryKey: ['wip', 'material-flow', kind, dataUrl, from, to],
    queryFn: () => fetch(dataUrl).then(r => r.json()),
    staleTime: MATERIAL_FLOW_STALE_MS,
    gcTime: MATERIAL_FLOW_GC_MS,
    refetchOnWindowFocus: false,
  })

  const { rows, totals, materials, bySection, bySource, byLabor } = useMemo(() => {
    const rs = (data?.rows ?? []).filter(row => rowMatchesKind(row, kind))
    const totals = emptyAgg()
    const materialTotals: Record<string, number> = {}
    const bySection: Record<string, { agg: Agg; rows: Row[] }> = {}
    const bySource: Record<string, { label: string; hint?: string; agg: Agg; rows: Row[] }> = {}
    const byLabor: Record<LaborBucket, { agg: Agg; rows: Row[] }> = {
      own: { agg: emptyAgg(), rows: [] },
      almaz: { agg: emptyAgg(), rows: [] },
      hire: { agg: emptyAgg(), rows: [] },
    }

    for (const row of rs) {
      const bucket = bucketOf(row)
      const material = materialKey(row.material)
      addRow(totals, row, bucket)
      materialTotals[material] = (materialTotals[material] || 0) + rowVolume(row)

      const section = isKnownSection(row.section_code) ? row.section_code : '—'
      bySection[section] ??= { agg: emptyAgg(), rows: [] }
      addRow(bySection[section].agg, row, bucket)
      bySection[section].rows.push(row)

      const sourceKey = sourceGroupKey(row)
      bySource[sourceKey] ??= { label: sourceDisplayName(row), hint: sourceTypeLabel(row), agg: emptyAgg(), rows: [] }
      addRow(bySource[sourceKey].agg, row, bucket)
      bySource[sourceKey].rows.push(row)

      addRow(byLabor[bucket].agg, row, bucket)
      byLabor[bucket].rows.push(row)
    }

    const materials = Object.entries(materialTotals)
      .filter(([, total]) => total > 0)
      .map(([key, total]) => ({ key, label: materialLabel(key), color: materialColor(key), total }))
      .sort((a, b) => {
        const ai = MATERIAL_ORDER.indexOf(a.key)
        const bi = MATERIAL_ORDER.indexOf(b.key)
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        return b.total - a.total || a.label.localeCompare(b.label, 'ru')
      })

    return { rows: rs, totals, materials, bySection, bySource, byLabor }
  }, [data, kind])

  if (isLoading || !data) {
    return <div className="h-40 animate-pulse rounded-xl border border-border bg-white p-5" />
  }

  const tableRows: TableRow[] = (() => {
    if (mode === 'sections') {
      return Object.entries(bySection)
        .map(([code, item]) => ({ key: code, label: isKnownSection(code) ? sectionCodeToUILabel(code) : 'Без участка', agg: item.agg, rows: item.rows }))
        .sort((a, b) => b.agg.total - a.agg.total)
    }
    if (mode === 'sources') {
      return Object.entries(bySource)
        .map(([key, item]) => ({ key, label: item.label, hint: item.hint, agg: item.agg, rows: item.rows }))
        .sort((a, b) => b.agg.total - a.agg.total)
    }
    return (['own', 'almaz', 'hire'] as LaborBucket[])
      .map(bucket => ({ key: bucket, label: laborLabel(bucket), agg: byLabor[bucket].agg, rows: byLabor[bucket].rows }))
      .filter(row => row.agg.total > 0)
  })()

  const maxTotal = Math.max(1, ...tableRows.map(row => row.agg.total))
  const title = kind === 'quarry' ? 'Возка с карьеров' : 'Перевозка'
  const subtitle = kind === 'quarry'
    ? 'начальная точка: карьер'
    : 'накопитель-конструктив, накопитель-накопитель, конструктив-накопитель, конструктив-конструктив'
  const firstColLabel = mode === 'sections' ? 'Участок' : mode === 'sources' ? 'Отправление' : 'Силы'
  const materialColumnCount = materials.length ? materials.length * LABOR_COLUMNS.length : 1
  const tableColSpan = 2 + materialColumnCount

  return (
    <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Truck className="h-5 w-5 text-text-primary" strokeWidth={2} />
        <div className="min-w-0">
          <h2 className="font-heading text-base font-semibold uppercase tracking-wide text-gray-800">{title}</h2>
          <div className="text-[11px] text-text-muted">{subtitle}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-text-secondary">
          <span>Σ <span className="text-text-primary">{fmt(totals.total)}</span> м³</span>
          {materials.slice(0, 6).map(material => (
            <span key={material.key} className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: material.color }} />
              <span>{material.label} <span className="text-text-primary">{fmt(material.total)}</span></span>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-bg-surface p-1">
          <TabChip active={mode === 'sections'} onClick={() => setMode('sections')}>по участкам</TabChip>
          <TabChip active={mode === 'sources'} onClick={() => setMode('sources')}>по отправлению</TabChip>
          <TabChip active={mode === 'labor'} onClick={() => setMode('labor')}>по силам</TabChip>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs">
        {materials.map(material => <LegendChip key={material.key} color={material.color} label={material.label} />)}
        {materials.length > 0 && <span className="text-text-muted">·</span>}
        <LegendChip color={BUCKET_COLOR.own} label="ЖДС" />
        <LegendChip color={BUCKET_COLOR.almaz} label="АЛМАЗ" />
        <LegendChip color={BUCKET_COLOR.hire} label="Наёмники" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-text-muted">
              <th rowSpan={2} className="min-w-[180px] py-2 pr-4 text-left align-bottom font-semibold">{firstColLabel}</th>
              {materials.length > 0 ? materials.map(material => (
                <th key={material.key} colSpan={LABOR_COLUMNS.length} className="border-l border-border/70 px-2 py-2 text-center font-semibold">
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: material.color }} />
                    {material.label}, м³
                  </span>
                </th>
              )) : <th rowSpan={2} className="px-2 py-2 text-right align-bottom font-semibold">Материал, м³</th>}
              <th rowSpan={2} className="min-w-[220px] border-l border-border py-2 pl-3 text-right align-bottom font-semibold">Итого, м³</th>
            </tr>
            {materials.length > 0 && (
              <tr className="text-[10px] uppercase tracking-wider text-text-muted">
                {materials.flatMap(material => LABOR_COLUMNS.map(bucket => (
                  <th key={`${material.key}:${bucket.key}`} className="min-w-[96px] border-l border-border/40 px-2 py-1.5 text-right font-semibold">
                    <span className="inline-flex items-center justify-end gap-1">
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: BUCKET_COLOR[bucket.key] }} />
                      {bucket.label}
                    </span>
                  </th>
                )))}
              </tr>
            )}
          </thead>
          <tbody>
            {tableRows.length === 0 && (
              <tr>
                <td colSpan={tableColSpan} className="py-8 text-center text-xs text-text-muted">Нет данных за выбранный период.</td>
              </tr>
            )}
            {tableRows.map(({ key, label, hint, agg, rows: rowItems }) => (
              <tr
                key={key}
                role="button"
                tabIndex={0}
                onClick={() => setDrilldown({ mode, key, label, kind, rows: rowItems, materials })}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setDrilldown({ mode, key, label, kind, rows: rowItems, materials })
                  }
                }}
                className="cursor-pointer border-t border-border/60 hover:bg-bg-surface/60 focus:bg-bg-surface/60 focus:outline-none"
                title="Открыть детализацию"
              >
                <td className="py-3 pr-4">
                  <div className="font-semibold text-text-primary">{label}</div>
                  {hint && <div className="mt-0.5 text-[10px] text-text-muted">{hint}</div>}
                </td>
                {materials.length > 0 ? materials.flatMap(material => LABOR_COLUMNS.map(bucket => {
                  const value = agg.byMaterialLabor[material.key]?.[bucket.key] || 0
                  return (
                    <td key={`${material.key}:${bucket.key}`} className="border-l border-border/40 px-2 py-3 text-right font-mono text-text-secondary">
                      {value ? fmt(value) : '—'}
                    </td>
                  )
                })) : <td className="px-2 py-3 text-right font-mono text-text-muted">—</td>}
                <td className="border-l border-border py-3 pl-3">
                  <TotalBar agg={agg} materials={materials} maxTotal={maxTotal} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <div className="mt-2 text-[11px] text-text-muted">Данные за период отсутствуют.</div>}
      {drilldown && <MaterialFlowDrilldown drilldown={drilldown} onClose={() => setDrilldown(null)} />}
    </section>
  )
}

function MaterialFlowDrilldown({ drilldown, onClose }: { drilldown: DrilldownState; onClose: () => void }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const groups = useMemo(() => {
    const byKey: Record<string, { key: string; label: string; hint?: string; agg: Agg; rows: Row[] }> = {}
    for (const row of drilldown.rows) {
      const group = secondaryGroupKey(drilldown.mode, row)
      byKey[group.key] ??= { key: group.key, label: group.label, hint: group.hint, agg: emptyAgg(), rows: [] }
      addRow(byKey[group.key].agg, row, bucketOf(row))
      byKey[group.key].rows.push(row)
    }
    return Object.values(byKey).sort((a, b) => b.agg.total - a.agg.total)
  }, [drilldown])
  const activeGroup = groups.find(group => group.key === selectedKey) || groups[0] || null
  const detailRows = useMemo(
    () => [...(activeGroup?.rows ?? drilldown.rows)].sort(compareDetailRows),
    [activeGroup?.rows, drilldown.rows],
  )
  const total = drilldown.rows.reduce((sum, row) => sum + rowVolume(row), 0)

  return (
    <div className="fixed inset-y-0 left-0 right-0 z-[100] flex items-center justify-center bg-black/45 p-3 sm:p-4 lg:left-64">
      <div className="flex max-h-[calc(100vh-24px)] w-full max-w-none flex-col rounded-lg border border-border bg-white shadow-xl sm:max-h-[calc(100vh-32px)]">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-heading font-bold text-text-primary">{drilldown.kind === 'quarry' ? 'Возка с карьеров' : 'Перевозка'} · {drilldown.label}</div>
            <div className="text-xs text-text-muted">{fmt(total)} м³ · {fmt(drilldown.rows.reduce((sum, row) => sum + Number(row.trips || 0), 0))} рейсов · {drilldown.rows.length} строк</div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-text-muted hover:bg-bg-surface hover:text-text-primary" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-auto border-b border-border p-3 md:border-b-0 md:border-r">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Сводка</div>
            <div className="space-y-1">
              {groups.map(group => {
                const active = activeGroup?.key === group.key
                return (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => setSelectedKey(group.key)}
                    className={`w-full rounded-md px-3 py-2 text-left transition ${active ? 'bg-red-50 ring-1 ring-accent-red/20' : 'hover:bg-bg-surface'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-semibold text-text-primary">{group.label}</span>
                      <span className="shrink-0 font-mono text-xs text-text-primary">{fmt(group.agg.total)}</span>
                    </div>
                    {group.hint && <div className="mt-0.5 truncate text-[10px] text-text-muted">{group.hint}</div>}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
                      {drilldown.materials.map(material => group.agg.byMaterial[material.key] > 0 && (
                        <span key={material.key}>{material.label} {fmt(group.agg.byMaterial[material.key])}</span>
                      ))}
                      {LABOR_COLUMNS.map(bucket => group.agg.byLabor[bucket.key] > 0 && (
                        <span key={bucket.key}>{bucket.label} {fmt(group.agg.byLabor[bucket.key])}</span>
                      ))}
                      <span>{group.rows.length} строк</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="min-h-0 overflow-auto p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-xs font-semibold text-text-primary">{activeGroup?.label || 'Детализация'}</div>
              <div className="shrink-0 rounded bg-bg-surface px-2 py-1 text-[11px] font-semibold text-text-muted">{detailRows.length} строк</div>
            </div>
            <table className="w-full border-collapse text-left text-[11px]">
              <thead className="sticky top-0 bg-white text-text-muted shadow-sm">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Отчет</th>
                  <th className="px-2 py-1.5 font-semibold">Участок</th>
                  <th className="px-2 py-1.5 font-semibold">Отправление</th>
                  <th className="px-2 py-1.5 font-semibold">Куда</th>
                  <th className="px-2 py-1.5 font-semibold">Материал</th>
                  <th className="px-2 py-1.5 font-semibold">Направление</th>
                  <th className="px-2 py-1.5 font-semibold">Смена</th>
                  <th className="px-2 py-1.5 font-semibold">Силы</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Техника</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Рейсы</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Плечо, км</th>
                  <th className="px-2 py-1.5 text-right font-semibold">м³·км</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Объем</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((row, idx) => {
                  const matKey = materialKey(row.material)
                  return (
                    <tr key={`${row.source_report_id || row.report_date || row.report_date_from || 'synthetic'}-${row.section_code}-${row.source_object_id || row.quarry_id || row.source_object_name}-${row.destination_object_id || row.destination_object_name}-${row.material}-${row.movement_type}-${row.shift}-${row.contractor_short}-${idx}`} className="border-t border-border align-top">
                      <td className="whitespace-nowrap px-2 py-1.5 text-text-muted" title={row.source_reference || undefined}>
                        <div className="font-mono text-text-secondary">{reportDateLabel(row)}</div>
                        {reportSubLabel(row) && <div className="mt-0.5 max-w-[160px] truncate text-[10px] text-text-muted">{reportSubLabel(row)}</div>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-text-muted">{isKnownSection(row.section_code) ? sectionCodeToUILabel(row.section_code) : 'Без участка'}</td>
                      <td className="px-2 py-1.5 text-text-primary">{sourceDisplayName(row)}</td>
                      <td className="px-2 py-1.5 text-text-primary">{destinationDisplayName(row)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-text-muted"><span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: materialColor(matKey) }} />{materialLabel(matKey)}</span></td>
                      <td className="px-2 py-1.5 text-text-muted">{row.movement_label || directionLabel(row)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-text-muted">{shiftLabel(row.shift)}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{row.contractor_short || row.contractor_name || laborLabel(bucketOf(row))}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-text-muted">{fmt(row.equipment_count || 0)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-text-muted">{fmt(row.trips || 0)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-text-muted">{row.haul_distance_km != null ? Number(row.haul_distance_km).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-text-muted">{row.ton_km != null ? fmt(Number(row.ton_km || 0)) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono font-semibold text-text-primary">{fmt(rowVolume(row))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!detailRows.length && <div className="py-8 text-center text-sm text-text-muted">Нет строк</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function emptyAgg(): Agg {
  return { byMaterial: {}, byLabor: { own: 0, almaz: 0, hire: 0 }, byMaterialLabor: {}, total: 0 }
}

function rowVolume(row: Row): number {
  return Number(row.volume || 0)
}

function addRow(agg: Agg, row: Row, bucket: LaborBucket) {
  const volume = rowVolume(row)
  if (volume <= 0) return
  const material = materialKey(row.material)
  agg.byMaterial[material] = (agg.byMaterial[material] || 0) + volume
  agg.byLabor[bucket] += volume
  agg.byMaterialLabor[material] ??= { own: 0, almaz: 0, hire: 0 }
  agg.byMaterialLabor[material][bucket] += volume
  agg.total += volume
}

function bucketOf(row: Row): LaborBucket {
  if (row.contractor_bucket === 'zhds') return 'own'
  if (row.contractor_bucket === 'almaz') return 'almaz'
  if (row.contractor_bucket === 'hire') return 'hire'
  if (row.contractor_kind === 'own') return 'own'
  if ((row.contractor_short ?? row.contractor_name ?? '').toUpperCase().includes('АЛМАЗ')) return 'almaz'
  return 'hire'
}

function rowMatchesKind(row: Row, kind: FlowKind): boolean {
  if (rowVolume(row) <= 0) return false
  const startsFromQuarry = sourceKind(row) === 'quarry'
  return kind === 'quarry' ? startsFromQuarry : !startsFromQuarry
}

function isKnownSection(code?: string | null): boolean {
  return /^UCH_\d+/.test(code || '')
}

function sourceKind(row: Row): string {
  if (row.source_kind) return row.source_kind
  const type = String(row.source_object_type_code || '').toUpperCase()
  if (type === 'BORROW_PIT') return 'quarry'
  if (type === 'STOCKPILE') return 'stockpile'
  if (row.quarry_name) return 'quarry'
  if (row.source_object_id || row.source_object_name) return 'object'
  return 'unknown'
}

function destinationKind(row: Row): string {
  if (row.destination_kind) return row.destination_kind
  const type = String(row.destination_object_type_code || '').toUpperCase()
  if (type === 'BORROW_PIT') return 'quarry'
  if (type === 'STOCKPILE') return 'stockpile'
  if (row.destination_object_id || row.destination_object_name) return 'object'
  return 'unknown'
}

function typeKindLabel(kind: string): string {
  if (kind === 'quarry') return 'карьер'
  if (kind === 'stockpile') return 'накопитель'
  if (kind === 'object') return 'конструктив'
  return 'не задано'
}

function quarryNameKey(value?: string | null): string {
  const raw = String(value || '').trim().toLowerCase().replace(/ё/g, 'е')
  const stripped = raw.replace(/^карьер\s+/i, '').replace(/["«»]/g, '').replace(/[^0-9a-zа-я]+/g, ' ').replace(/\s+/g, ' ').trim()
  const normalized = stripped
    .replace(/(^|\s)(?:миголо[шщ]и|милогоши)(?=\s|$)/gu, '$1миголощи')
    .replace(/\s+(щпгс|щпс|пгс|песок|sand|shpgs|shps)$/u, '')
  if (normalized === 'маяки') return 'южные маяки'
  return normalized
}

function canonicalQuarryName(value?: string | null): string {
  const raw = String(value || '').trim()
  const stripped = raw.replace(/^карьер\s+/i, '').replace(/\s+/g, ' ').trim()
  const key = quarryNameKey(stripped || raw)
  if (key === 'южные маяки') return 'Южные Маяки'
  if (key === 'миголощи') return 'Миголощи'
  return stripped || raw || '—'
}

function sourceGroupKey(row: Row): string {
  if (sourceKind(row) === 'quarry') return `quarry:${quarryNameKey(sourceDisplayName(row))}`
  if (row.source_group_key) return row.source_group_key
  return row.source_object_id || row.quarry_id || sourceDisplayName(row)
}

function sourceTypeLabel(row: Row): string {
  const kind = sourceKind(row)
  const type = row.source_object_type_name || row.source_object_type_code || typeKindLabel(kind)
  return String(type || '').toLowerCase() === typeKindLabel(kind) ? typeKindLabel(kind) : `${typeKindLabel(kind)} · ${type}`
}

function sourceDisplayName(row: Row): string {
  const name = row.quarry_name || row.source_object_name || row.source_object_code || '—'
  const kind = sourceKind(row)
  if (kind === 'quarry') return canonicalQuarryName(name)
  if (kind === 'unknown') return name
  const type = row.source_object_type_name || row.source_object_type_code
  return type && name !== '—' ? `${name} (${type})` : name
}

function destinationDisplayName(row: Row): string {
  const name = row.destination_object_name || row.destination_object_code || '—'
  const kind = destinationKind(row)
  if (kind === 'unknown') return name
  const type = row.destination_object_type_name || row.destination_object_type_code || typeKindLabel(kind)
  return type && name !== '—' ? `${name} (${type})` : name
}

function materialKey(material?: Material | null): string {
  const raw = String(material || '').trim()
  const upper = raw.toUpperCase().replace(/Ё/g, 'Е')
  if (!upper) return 'UNKNOWN'
  if (upper === 'COARSE_SAND' || (upper.includes('КРУПН') && upper.includes('ПЕС'))) return 'COARSE_SAND'
  if (upper === 'SAND' || upper.includes('ПЕС')) return 'SAND'
  if (upper === 'SHPGS' || upper.includes('ЩПГС')) return 'SHPGS'
  if (upper === 'SHPS' || upper.includes('ЩПС')) return 'SHPS'
  if (upper === 'PGS' || upper.includes('ПГС')) return 'PGS'
  if (upper === 'CRUSHED_STONE' || upper === 'SCHEBEN' || upper.includes('ЩЕБ')) return 'CRUSHED_STONE'
  if (upper === 'SOIL' || upper.includes('ГРУНТ')) return 'SOIL'
  if (upper === 'PEAT' || upper.includes('ТОРФ')) return 'PEAT'
  return upper
}

function materialLabel(key: string): string {
  const labels: Record<string, string> = {
    SAND: 'Песок',
    COARSE_SAND: 'Крупный песок',
    SHPGS: 'ЩПГС',
    SHPS: 'ЩПС',
    PGS: 'ПГС',
    CRUSHED_STONE: 'Щебень',
    SCHEBEN: 'Щебень',
    SOIL: 'Грунт',
    PEAT: 'Торф',
    UNKNOWN: 'Материал',
  }
  return labels[key] || key
}

function materialColor(key: string): string {
  const colors: Record<string, string> = {
    SAND: '#d8aa2a',
    COARSE_SAND: '#0f766e',
    SHPGS: '#2563eb',
    SHPS: '#2563eb',
    CRUSHED_STONE: '#111827',
    SCHEBEN: '#111827',
    PGS: '#f97316',
    PEAT: '#7c2d12',
    SOIL: '#dc2626',
  }
  if (colors[key]) return colors[key]
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 360
  return `hsl(${hash}, 58%, 43%)`
}

function laborLabel(bucket: LaborBucket): string {
  if (bucket === 'own') return 'ЖДС'
  if (bucket === 'almaz') return 'ООО «АЛМАЗ»'
  return 'Наёмники'
}

function shiftLabel(value?: string | null): string {
  if (value === 'day') return 'день'
  if (value === 'night') return 'ночь'
  return '—'
}

function reportDateLabel(row: Row): string {
  if (row.report_date) return formatPlainDate(row.report_date)
  const from = row.report_date_from ? formatPlainDate(row.report_date_from) : ''
  const to = row.report_date_to ? formatPlainDate(row.report_date_to) : ''
  if (from && to && from !== to) return `${from} - ${to}`
  return from || to || '—'
}

function reportSubLabel(row: Row): string {
  const submitted = formatSubmittedAt(row.submitted_at)
  if (submitted) return `подан ${submitted}`
  if (row.synthetic) return 'расчетный период'
  return row.source_reference || ''
}

function compareDetailRows(a: Row, b: Row): number {
  const left = a.report_date || a.report_date_from || ''
  const right = b.report_date || b.report_date_from || ''
  return left.localeCompare(right)
    || String(a.section_code || '').localeCompare(String(b.section_code || ''))
    || sourceDisplayName(a).localeCompare(sourceDisplayName(b), 'ru')
    || destinationDisplayName(a).localeCompare(destinationDisplayName(b), 'ru')
    || materialKey(a.material).localeCompare(materialKey(b.material), 'ru')
}

function directionLabel(row: Row): string {
  if (row.movement_type === 'pit_to_constructive') return 'карьер-конструктив'
  if (row.movement_type === 'pit_to_stockpile') return 'карьер-накопитель'
  if (row.movement_type === 'stockpile_to_constructive') return 'накопитель-конструктив'
  if (row.movement_type === 'stockpile_to_stockpile') return 'накопитель-накопитель'
  if (row.movement_type === 'constructive_to_stockpile') return 'конструктив-накопитель'
  if (row.movement_type === 'constructive_to_constructive') return 'конструктив-конструктив'
  return row.movement_type || '—'
}

function secondaryGroupKey(mode: Mode, row: Row): { key: string; label: string; hint?: string } {
  if (mode === 'sections') {
    const sourceKey = sourceGroupKey(row)
    return { key: `source:${sourceKey}:${row.movement_type || ''}`, label: `${sourceDisplayName(row)} · ${row.movement_label || directionLabel(row)}`, hint: sourceTypeLabel(row) }
  }
  if (mode === 'sources') {
    const label = isKnownSection(row.section_code) ? sectionCodeToUILabel(row.section_code) : 'Без участка'
    return { key: `section:${row.section_code || 'none'}`, label }
  }
  const label = `${isKnownSection(row.section_code) ? sectionCodeToUILabel(row.section_code) : 'Без участка'} · ${sourceDisplayName(row)}`
  return { key: `labor:${row.section_code || 'none'}:${sourceGroupKey(row)}`, label, hint: row.movement_label || directionLabel(row) }
}

function TabChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs font-medium transition ${active ? 'bg-slate-800 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:text-text-primary'}`}
    >
      {children}
    </button>
  )
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-[3px]" style={{ background: color }} />
      <span className="text-text-secondary">{label}</span>
    </span>
  )
}

function TotalBar({ agg, materials, maxTotal }: { agg: Agg; materials: MaterialMeta[]; maxTotal: number }) {
  const width = agg.total > 0 ? Math.max(10, (agg.total / maxTotal) * 100) : 0
  return (
    <div className="flex w-full flex-col items-end gap-1">
      <div className="relative h-2.5 w-full overflow-hidden rounded-sm bg-bg-surface" style={{ maxWidth: `${width}%`, marginLeft: 'auto' }}>
        <div className="flex h-full w-full">
          {materials.map(material => agg.byMaterial[material.key] > 0 && (
            <div key={material.key} style={{ width: `${(agg.byMaterial[material.key] / agg.total) * 100}%`, background: material.color }} />
          ))}
        </div>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-sm bg-bg-surface" style={{ maxWidth: `${width}%`, marginLeft: 'auto' }}>
        <div className="flex h-full w-full">
          {(['own', 'almaz', 'hire'] as LaborBucket[]).map(bucket => agg.byLabor[bucket] > 0 && (
            <div key={bucket} style={{ width: `${(agg.byLabor[bucket] / agg.total) * 100}%`, background: BUCKET_COLOR[bucket] }} />
          ))}
        </div>
      </div>
      <span className="inline-block rounded-sm bg-text-primary px-2 py-0.5 font-mono text-[11px] text-white">{fmt(agg.total)}</span>
    </div>
  )
}
