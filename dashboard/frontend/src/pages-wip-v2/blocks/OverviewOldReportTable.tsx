/**
 * Режим «Таблица» на Обзоре — по мотивам исходной сводной таблицы
 * «Информация по производительности автосамосвалов» (старый отчёт).
 * Показывает per-участок × (карьер/направление/подрядчик): кол-во техники Д/Н,
 * факт выработки Д/Н и итог за сутки. Разные категории строк выделены цветом.
 * Источник: /api/wip/material-flow + /api/wip/equipment-productivity.
 */
import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table2 } from 'lucide-react'

interface Row {
  section_code: string
  material: string
  quarry_id: string | null
  quarry_name: string | null
  contractor_id: string | null
  contractor_name: string | null
  contractor_short: string | null
  contractor_kind: 'own' | 'subcontractor' | 'supplier'
  contractor_bucket?: 'zhds' | 'almaz' | 'hire'
  volume: number
  trips: number
  equipment_count?: number
  shift?: 'day' | 'night' | string
  movement_type?: string
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => (n > 0 ? nf.format(Math.round(n)) : '0')

function isAlmaz(r: Row): boolean {
  return (r.contractor_short || r.contractor_name || '').toUpperCase().includes('АЛМАЗ')
}
function isOwn(r: Row): boolean {
  return r.contractor_kind === 'own' || r.contractor_bucket === 'zhds'
}

// Палитра для категорий строк (как в оригинале PDF — полосы по направлению)
const CAT_COLORS: Record<string, string> = {
  'quarry_to_stockpile':      'bg-amber-50',       // карьер → накопитель (жёлтый)
  'quarry_to_constructive':   'bg-orange-50',      // карьер → конструктив
  'stockpile_to_constructive':'bg-purple-50',      // накопитель → конструктив
  'almaz_stockpile':          'bg-blue-50',        // АЛМАЗ накопитель
  'hired':                    'bg-emerald-50',     // наёмный транспорт
  'shpgs':                    'bg-cyan-50',        // ЩПС/ЩПГС
  'default':                  'bg-bg-surface/30',
}

function classify(r: Row): string {
  const mat = (r.material || '').toUpperCase()
  const mt = r.movement_type
  if (mat === 'SHPGS') return 'shpgs'
  if (isAlmaz(r)) return 'almaz_stockpile'
  if (!isOwn(r)) return 'hired'
  if (mt === 'pit_to_stockpile') return 'quarry_to_stockpile'
  if (mt === 'pit_to_constructive') return 'quarry_to_constructive'
  if (mt === 'stockpile_to_constructive') return 'stockpile_to_constructive'
  return 'default'
}

function directionLabel(r: Row): string {
  const mt = r.movement_type || ''
  if (mt === 'pit_to_stockpile') return 'в накопитель'
  if (mt === 'pit_to_constructive') return 'в земполотно (с карьера)'
  if (mt === 'stockpile_to_constructive') return 'в земполотно с накопителя'
  if (mt === 'constructive_to_stockpile') return 'конструктив → накопитель'
  return mt || '—'
}

function matLabel(m: string): string {
  const u = (m || '').toUpperCase()
  if (u === 'SAND') return 'Песок'
  if (u === 'SHPGS') return 'ЩПС/ЩПГС'
  if (u === 'PEAT') return 'Торф'
  if (u === 'SOIL') return 'Грунт'
  return m || '—'
}

function contractorLabel(r: Row): string {
  if (isOwn(r)) return 'ЖДС'
  if (isAlmaz(r)) return 'АЛМАЗ'
  return r.contractor_name || r.contractor_short || 'наёмн.'
}

interface GroupKey {
  section: string
  material: string
  quarry_name: string | null
  movement_type: string | undefined
  contractor: string
}

interface AggRow {
  key: GroupKey
  day_units: number; night_units: number
  day_vol: number; night_vol: number
  day_trips: number; night_trips: number
}

export function OverviewOldReportTable({ to }: { to: string }) {
  const [date, setDate] = useState(to)

  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['wip', 'material-flow', date],
    queryFn: () => fetch(`/api/wip/material-flow?from=${date}&to=${date}`).then(r => r.json()),
  })

  const sections = useMemo(() => {
    const rows = data?.rows ?? []
    const byKey: Record<string, AggRow> = {}
    for (const r of rows) {
      const k: GroupKey = {
        section: r.section_code,
        material: (r.material || '').toUpperCase(),
        quarry_name: r.quarry_name,
        movement_type: r.movement_type,
        contractor: contractorLabel(r),
      }
      const keyStr = `${k.section}|${k.material}|${k.quarry_name ?? ''}|${k.movement_type ?? ''}|${k.contractor}`
      const prev = byKey[keyStr] ?? {
        key: k,
        day_units: 0, night_units: 0,
        day_vol: 0, night_vol: 0,
        day_trips: 0, night_trips: 0,
      }
      const isDay = r.shift === 'day'
      const isNight = r.shift === 'night'
      if (isDay) {
        prev.day_vol += r.volume
        prev.day_trips += r.trips
        prev.day_units += r.equipment_count ?? 0
      } else if (isNight) {
        prev.night_vol += r.volume
        prev.night_trips += r.trips
        prev.night_units += r.equipment_count ?? 0
      } else {
        prev.day_vol += r.volume
        prev.day_trips += r.trips
        prev.day_units += r.equipment_count ?? 0
      }
      byKey[keyStr] = prev
    }
    // group by section
    const by_section: Record<string, AggRow[]> = {}
    for (const agg of Object.values(byKey)) {
      (by_section[agg.key.section] ??= []).push(agg)
    }
    // sort rows in each section: quarry_name → movement_type
    for (const sec of Object.keys(by_section)) {
      by_section[sec].sort((a, b) => {
        if (a.key.material !== b.key.material) return matLabel(a.key.material).localeCompare(matLabel(b.key.material), 'ru')
        const qa = a.key.quarry_name || 'я'; const qb = b.key.quarry_name || 'я'
        if (qa !== qb) return qa.localeCompare(qb, 'ru')
        return (a.key.movement_type || '').localeCompare(b.key.movement_type || '')
      })
    }
    return by_section
  }, [data])

  const sectionOrder = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']

  return (
    <section className="bg-white border border-border rounded-xl shadow-sm overflow-hidden print:shadow-none">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border bg-bg-surface/40">
        <Table2 className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Информация по производительности автосамосвалов
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-text-muted">дата:</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="px-2 py-1 text-[12px] border border-border rounded-md bg-white font-mono"
          />
        </div>
      </div>

      {isLoading || !data ? (
        <div className="h-40 animate-pulse bg-bg-surface" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-text-muted uppercase tracking-wider text-[9.5px] border-b border-border bg-bg-surface">
                <th className="text-left py-2 pl-3 pr-2 font-semibold">Уч.</th>
                <th className="text-left py-2 px-2 font-semibold">Карьер</th>
                <th className="text-left py-2 px-2 font-semibold">Материал</th>
                <th className="text-left py-2 px-2 font-semibold">Направление</th>
                <th className="text-left py-2 px-2 font-semibold">Силы</th>
                <th className="text-right py-2 px-2 font-semibold">Тех. день</th>
                <th className="text-right py-2 px-2 font-semibold">Тех. ночь</th>
                <th className="text-right py-2 px-2 font-semibold">Факт день</th>
                <th className="text-right py-2 px-2 font-semibold">Факт ночь</th>
                <th className="text-right py-2 px-2 font-semibold border-l border-border">Итого за сутки</th>
              </tr>
            </thead>
            <tbody>
              {sectionOrder.map(sec => {
                const rows = sections[sec] ?? []
                if (rows.length === 0) return null
                const materialTotals = Object.values(rows.reduce<Record<string, { material: string; day: number; night: number }>>((acc, r) => {
                  const key = r.key.material || 'OTHER'
                  acc[key] ??= { material: key, day: 0, night: 0 }
                  acc[key].day += r.day_vol
                  acc[key].night += r.night_vol
                  return acc
                }, {})).sort((a, b) => matLabel(a.material).localeCompare(matLabel(b.material), 'ru'))
                return (
                  <Fragment key={sec}>
                    {rows.map((agg, i) => {
                      const cat = classify({
                        section_code: agg.key.section, material: agg.key.material,
                        quarry_name: agg.key.quarry_name, contractor_name: agg.key.contractor,
                        contractor_short: agg.key.contractor,
                        contractor_kind: agg.key.contractor === 'ЖДС' ? 'own' : 'subcontractor',
                        volume: 0, trips: 0, movement_type: agg.key.movement_type,
                        contractor_id: null, quarry_id: null,
                      } as Row)
                      const bg = CAT_COLORS[cat] ?? CAT_COLORS.default
                      return (
                        <tr key={`${sec}-${i}`} className={`${bg} border-b border-border/50`}>
                          {i === 0 && (
                            <td rowSpan={rows.length + materialTotals.length} className="align-top py-2 pl-3 pr-2 font-bold text-text-primary bg-white border-r border-border">
                              {sec.replace('UCH_', '№')}
                            </td>
                          )}
                          <td className="py-1.5 px-2">{agg.key.quarry_name ?? '—'}</td>
                          <td className="py-1.5 px-2 text-text-secondary">{matLabel(agg.key.material)}</td>
                          <td className="py-1.5 px-2 text-text-secondary text-[11px]">{directionLabel({
                            section_code: '', material: '', quarry_id: null, quarry_name: null,
                            contractor_id: null, contractor_name: null, contractor_short: null,
                            contractor_kind: 'own', volume: 0, trips: 0, movement_type: agg.key.movement_type
                          })}</td>
                          <td className="py-1.5 px-2 text-text-primary font-medium">{agg.key.contractor}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-text-secondary">{agg.day_units || '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-text-secondary">{agg.night_units || '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-text-secondary">{fmt(agg.day_vol)}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-text-secondary">{fmt(agg.night_vol)}</td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold border-l border-border">
                            {fmt(agg.day_vol + agg.night_vol)}
                          </td>
                        </tr>
                      )
                    })}
                    {materialTotals.map(total => (
                      <tr key={`${sec}-${total.material}-total`} className="bg-text-primary/5 font-bold">
                        <td colSpan={6} className="py-2 px-2 text-right text-text-primary">
                          Итого по участку {sec.replace('UCH_', '№')} · {matLabel(total.material)}:
                        </td>
                        <td className="py-2 px-2 text-right font-mono">{fmt(total.day)}</td>
                        <td className="py-2 px-2 text-right font-mono">{fmt(total.night)}</td>
                        <td className="py-2 px-2 text-right font-mono border-l border-border">{fmt(total.day + total.night)}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <DayTotalsFooter date={date} />

      <div className="p-3 text-[11px] text-text-muted border-t border-border">
        Источник: <code>material_movements</code> за выбранную дату. Цвета строк:
        жёлтый — карьер→накопитель, оранжевый — карьер→конструктив,
        фиолетовый — накопитель→конструктив, голубой — ЩПС/ЩПГС, зелёный — наёмный транспорт.
      </div>
    </section>
  )
}

interface DayTotals {
  date: string
  equipment_working: Record<string, number>
  equipment_repair: Record<string, number>
  equipment_working_total: number
  equipment_repair_total: number
  materials: Record<string, { own: number; almaz: number; hired: number; total: number; trips: number }>
  grand: { own: number; almaz: number; hired: number; total: number; trips: number }
}

function DayTotalsFooter({ date }: { date: string }) {
  const { data } = useQuery<DayTotals>({
    queryKey: ['wip', 'overview', 'day-totals', date],
    queryFn: () => fetch(`/api/wip/overview/day-totals?date=${date}`).then(r => r.json()),
  })
  if (!data) return null
  const matOrder = ['SAND', 'SHPGS', 'SOIL', 'PEAT']
  const matLabelFn = (m: string) =>
    m === 'SAND' ? 'Песок' : m === 'SHPGS' ? 'ЩПС/ЩПГС' :
    m === 'SOIL' ? 'Грунт' : m === 'PEAT' ? 'Торф' : m
  return (
    <div className="border-t-2 border-text-primary/30 bg-bg-surface/50">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 text-[12px]">
        {/* Техника */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2 font-semibold">
            Техника в сутки
          </div>
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left py-0.5">Тип</th>
                <th className="text-right py-0.5">В работе</th>
                <th className="text-right py-0.5 text-accent-red">В простое</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(new Set([
                ...Object.keys(data.equipment_working),
                ...Object.keys(data.equipment_repair),
              ])).sort().map(et => (
                <tr key={et} className="border-t border-border/40">
                  <td className="py-0.5 text-text-secondary">{et}</td>
                  <td className="py-0.5 text-right text-text-primary">{data.equipment_working[et] ?? 0}</td>
                  <td className="py-0.5 text-right text-accent-red">{data.equipment_repair[et] ?? 0}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-bold">
                <td className="py-1">Σ</td>
                <td className="py-1 text-right">{data.equipment_working_total}</td>
                <td className="py-1 text-right text-accent-red">{data.equipment_repair_total}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Итоги по материалам */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2 font-semibold">
            По материалам (возка), м³
          </div>
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left py-0.5">Материал</th>
                <th className="text-right py-0.5">Объём</th>
                <th className="text-right py-0.5">Рейсов</th>
              </tr>
            </thead>
            <tbody>
              {matOrder.filter(m => data.materials[m]).map(m => (
                <tr key={m} className="border-t border-border/40">
                  <td className="py-0.5 text-text-secondary">{matLabelFn(m)}</td>
                  <td className="py-0.5 text-right text-text-primary">{fmt(data.materials[m].total)}</td>
                  <td className="py-0.5 text-right text-text-muted">{data.materials[m].trips}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-bold">
                <td className="py-1">Σ</td>
                <td className="py-1 text-right">{fmt(data.grand.total)}</td>
                <td className="py-1 text-right">{data.grand.trips}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Итоги по силам */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2 font-semibold">
            По силам (возка), м³
          </div>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              <tr className="border-t border-border/40">
                <td className="py-0.5 text-text-secondary">ЖДС</td>
                <td className="py-0.5 text-right text-text-primary">{fmt(data.grand.own)}</td>
              </tr>
              <tr className="border-t border-border/40">
                <td className="py-0.5 text-text-secondary">АЛМАЗ</td>
                <td className="py-0.5 text-right text-text-primary">{fmt(data.grand.almaz)}</td>
              </tr>
              <tr className="border-t border-border/40">
                <td className="py-0.5 text-text-secondary">Наёмные</td>
                <td className="py-0.5 text-right text-text-primary">{fmt(data.grand.hired)}</td>
              </tr>
              <tr className="border-t border-border font-bold">
                <td className="py-1">Σ всего</td>
                <td className="py-1 text-right">{fmt(data.grand.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Итого по всем участкам — одной строкой */}
      <div className="px-4 pb-3 text-[12px] font-bold flex items-baseline gap-3">
        <span className="text-text-muted uppercase tracking-wider text-[10px]">
          Итого по всем участкам:
        </span>
        <span className="font-mono">{fmt(data.grand.total)} м³</span>
        <span className="text-text-muted font-normal">
          · техника в работе {data.equipment_working_total} ед. · в простое {data.equipment_repair_total} ед.
        </span>
      </div>
    </div>
  )
}
