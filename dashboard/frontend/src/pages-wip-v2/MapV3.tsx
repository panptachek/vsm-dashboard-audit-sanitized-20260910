/**
 * MapV3 — карта ВСМ с восстановленным «богатым» дизайном из components/map
 * + выдвижной слева фильтр + слой техники на объектах.
 *
 * Фильтры (транзиентные, не сохраняются):
 *   - Дата (для слоя техники), по умолчанию вчера.
 *   - Участок (мультивыбор UCH_1..UCH_8 или «все»).
 *   - Диапазон ПК (от/до в целых пикетах).
 *   - Тип объектов (checkbox-ы).
 *   - Тип техники (checkbox-ы).
 */
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CalendarDays, Eye, EyeOff, Layers, RotateCcw, SlidersHorizontal, X,
  Route,
} from 'lucide-react'

import { VsmMap } from '../components/map/VsmMap'
import type { EquipKey } from '../components/map/EquipmentLayer'
import type { ObjectTypeKey } from '../types/geo'

type LucideIcon = React.ComponentType<{ className?: string; style?: React.CSSProperties }>
type ObjectSymbol = 'bridge' | 'pipe' | 'overpass' | 'pile_field' | 'intersection_fin' | 'intersection_prop' | 'stockpile' | 'borrow_pit'

// В БД участок 3 разбит на UCH_31 (до уч.4) и UCH_32 (после уч.4), т. к. уч.4
// географически внутри уч.3. Для UI объединяем: чекбокс «Уч. 3» тоггает обе
// группы разом. Пользователю не видно 3_1 / 3_2.
const SECTIONS_UI: { key: string; codes: string[]; label: string }[] = [
  { key: '1', codes: ['UCH_1'], label: 'Уч. 1' },
  { key: '2', codes: ['UCH_2'], label: 'Уч. 2' },
  { key: '3', codes: ['UCH_3'], label: 'Уч. 3' },
  { key: '4', codes: ['UCH_4'], label: 'Уч. 4' },
  { key: '5', codes: ['UCH_5'], label: 'Уч. 5' },
  { key: '6', codes: ['UCH_6'], label: 'Уч. 6' },
  { key: '7', codes: ['UCH_7'], label: 'Уч. 7' },
  { key: '8', codes: ['UCH_8'], label: 'Уч. 8' },
]
const ALL_SECTIONS = SECTIONS_UI.flatMap(s => s.codes)

// Для pile_field используем pile_driver.svg (копёр) вместо lucide Anchor.
// 'temp_road' — псевдо-ключ, не в ObjectTypeKey, обрабатываем отдельно.
const OBJ_TYPES: {
  key: ObjectTypeKey | 'temp_road'
  label: string
  Icon?: LucideIcon
  symbol?: ObjectSymbol
  color: string
}[] = [
  { key: 'bridge',            label: 'Мосты',                           symbol: 'bridge',             color: '#1f2937' },
  { key: 'pipe',              label: 'Трубы',                           symbol: 'pipe',               color: '#f97316' },
  { key: 'overpass',          label: 'Путепроводы (ИССО)',              symbol: 'overpass',           color: '#1d4ed8' },
  { key: 'pile_field',        label: 'Свайные поля',                    symbol: 'pile_field',         color: '#007fff' },
  { key: 'intersection_fin',  label: 'Пересечения (фин.)',              symbol: 'intersection_fin',   color: '#16a34a' },
  { key: 'intersection_prop', label: 'Пересечения (имущ.)',             symbol: 'intersection_prop',  color: '#c026d3' },
  { key: 'stockpile',         label: 'Накопители',                      symbol: 'stockpile',          color: '#a16207' },
  { key: 'borrow_pit',        label: 'Карьеры',                         symbol: 'borrow_pit',         color: '#7c2d12' },
  { key: 'temp_road',         label: 'Временные притрассовые дороги',   Icon: Route,                  color: '#0891b2' },
]

// Лёгкая палитра секций для свотчей в фильтре (совпадает со стилем map highlights).
const SECTION_SWATCH: Record<string, string> = {
  '1': '#ef4444', '2': '#f59e0b', '3': '#eab308', '4': '#22c55e',
  '5': '#06b6d4', '6': '#3b82f6', '7': '#8b5cf6', '8': '#ec4899',
}

const EQUIP_TYPES: { key: EquipKey; label: string }[] = [
  { key: 'dump_truck', label: 'Самосвал' },
  { key: 'excavator', label: 'Экскаватор' },
  { key: 'bulldozer', label: 'Бульдозер' },
  { key: 'motor_grader', label: 'Автогрейдер' },
  { key: 'road_roller', label: 'Каток' },
  { key: 'pile_driver', label: 'Копёр' },
]

function yesterdayISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function DatePill({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white/95 px-2.5 text-neutral-900 shadow-lg backdrop-blur">
      <CalendarDays className="h-3.5 w-3.5 shrink-0" />
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 min-w-[128px] cursor-pointer bg-transparent font-mono text-[12px] font-semibold text-neutral-900 outline-none"
        aria-label="Дата карты"
      />
    </div>
  )
}

function LegendItem({
  label,
  color,
  Icon,
  symbol,
}: {
  label: string
  color: string
  Icon?: LucideIcon
  symbol?: ObjectSymbol
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded border border-neutral-200 bg-white/60 px-1.5 py-1">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-200 bg-white/60">
        {symbol
          ? <ObjectGlyph symbol={symbol} color={color} />
          : Icon && <Icon className="h-3.5 w-3.5" style={{ color }} />}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: color }} />
      <span className="min-w-0 text-[10px] font-medium leading-tight text-neutral-700">{label}</span>
    </div>
  )
}

function ObjectGlyph({ symbol, color }: { symbol: ObjectSymbol; color: string }) {
  if (symbol === 'bridge') {
    return (
      <svg viewBox="0 0 28 20" className="h-5 w-6" aria-hidden="true">
        <path d="M3 7h22M3 13h22M5 4l-2 3M25 7l-2-3M5 16l-2-3M25 13l-2 3" fill="none" stroke={color} strokeWidth="2" strokeLinecap="square" />
      </svg>
    )
  }
  if (symbol === 'pipe') {
    return (
      <svg viewBox="0 0 22 28" className="h-5 w-5" aria-hidden="true">
        <rect x="8" y="3" width="6" height="22" rx="1.5" fill="#fff7ed" stroke={color} strokeWidth="2" />
        <path d="M5 8h12M5 20h12M11 6v16" fill="none" stroke="#1a1a1a" strokeWidth="1.4" strokeLinecap="square" />
      </svg>
    )
  }
  if (symbol === 'overpass') {
    return (
      <svg viewBox="0 0 24 30" className="h-5 w-5" aria-hidden="true">
        <path d="M8 3v24M16 3v24M5 8h14M5 15h14M5 22h14" fill="none" stroke={color} strokeWidth="2" strokeLinecap="square" />
      </svg>
    )
  }
  if (symbol === 'pile_field') {
    return (
      <svg viewBox="0 0 28 20" className="h-5 w-6" aria-hidden="true">
        <rect x="3" y="5" width="22" height="10" fill="none" stroke={color} strokeWidth="2" />
        <path d="M3 9h22M3 12h22" fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    )
  }
  if (symbol === 'stockpile') {
    return (
      <svg viewBox="0 0 30 24" className="h-5 w-6" aria-hidden="true">
        <path d="M3 19c3-7 6-11 10-11 2 0 3.5 1.2 5 3 1.1-2 2.6-3 4.5-3 2.1 0 3.7 2.1 4.5 11H3Z" fill="#fef3c7" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        <path d="M8 18c2-3 3.7-4.5 5.2-4.5M18 18c1.3-2.2 2.7-3.4 4.2-3.4" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (symbol === 'borrow_pit') {
    return (
      <svg viewBox="0 0 30 24" className="h-5 w-6" aria-hidden="true">
        <path d="M4 7h22l-3 12H7L4 7Z" fill="#fff7ed" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        <path d="M8 10h14M9 14h12M10 18h10" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  const dashed = symbol === 'intersection_prop' ? '5 3' : undefined
  return (
    <svg viewBox="0 0 24 30" className="h-5 w-5" aria-hidden="true">
      <path d="M12 3v24M5 9h14M5 21h14" fill="none" stroke={color} strokeWidth="2" strokeLinecap="square" strokeDasharray={dashed} />
      <rect x="9" y="12" width="6" height="6" fill="#fff" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

export default function MapV3() {
  const [open, setOpen] = useState(false)

  const [dateISO, setDateISO] = useState<string>(yesterdayISO())
  const [sections, setSections] = useState<Set<string>>(new Set(ALL_SECTIONS))
  const [pkFrom, setPkFrom] = useState<string>('')
  const [pkTo, setPkTo] = useState<string>('')
  const [objTypes, setObjTypes] = useState<Set<ObjectTypeKey>>(
    new Set(OBJ_TYPES.filter((t) => t.key !== 'temp_road').map((t) => t.key) as ObjectTypeKey[]),
  )
  const [showTempRoads, setShowTempRoads] = useState<boolean>(false)
  const [equipTypes, setEquipTypes] = useState<Set<EquipKey>>(
    new Set(EQUIP_TYPES.map((t) => t.key)),
  )

  // Toggles a UI-section: flips ALL of its raw codes together (UCH_31/UCH_32 etc).
  const toggleSectionUI = useCallback((codes: string[]) => {
    setSections((prev) => {
      const next = new Set(prev)
      const allIn = codes.every((c) => next.has(c))
      if (allIn) codes.forEach((c) => next.delete(c))
      else codes.forEach((c) => next.add(c))
      return next
    })
  }, [])
  const selectAllSections = useCallback(() => setSections(new Set(ALL_SECTIONS)), [])
  const clearSections = useCallback(() => setSections(new Set()), [])

  const toggleObjType = useCallback((k: ObjectTypeKey | 'temp_road') => {
    if (k === 'temp_road') {
      setShowTempRoads((v) => !v)
      return
    }
    setObjTypes((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])
  const toggleEquipType = useCallback((k: EquipKey) => {
    setEquipTypes((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const pkRange = useMemo<[number | null, number | null]>(() => {
    const from = pkFrom.trim() ? Number(pkFrom) : null
    const to = pkTo.trim() ? Number(pkTo) : null
    return [Number.isFinite(from) ? from : null, Number.isFinite(to) ? to : null]
  }, [pkFrom, pkTo])

  const enabledSectionCodes = sections.size === ALL_SECTIONS.length ? null : sections

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-neutral-100 lg:h-full">
      {/* Top workbar */}
      <div className="absolute left-3 right-3 top-3 z-[1100] flex items-start justify-between gap-1.5 lg:left-4 lg:right-20">
        <button
          onClick={() => setOpen(true)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-neutral-200
                     bg-white/95 px-3 text-xs font-semibold text-neutral-900 shadow-lg backdrop-blur
                     transition-colors hover:bg-white"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Фильтр карты
        </button>

        <DatePill value={dateISO} onChange={setDateISO} />
      </div>

      {/* Map */}
      <div className="absolute inset-0">
        <VsmMap
          equipmentDateISO={dateISO}
          enabledEquipmentTypes={equipTypes}
          enabledSectionCodes={enabledSectionCodes}
          pkRange={pkRange}
          objectTypeFilterOverride={objTypes}
          enableTempRoads={showTempRoads}
          hideBuiltInControls
        />
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 right-[30%] z-[1000] hidden rounded-md border border-neutral-200 bg-white/45 p-1.5 shadow-lg backdrop-blur-sm xl:block">
        <div className="mb-1 flex items-start justify-between gap-2">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            <Layers className="h-3 w-3" />
            Условные обозначения ВСЖМ
          </div>
          <div className="text-[8px] font-medium leading-tight text-neutral-400">проектные знаки</div>
        </div>
        <div className="grid grid-cols-4 gap-1 2xl:grid-cols-5">
          {OBJ_TYPES.map((item) => (
            <LegendItem
              key={item.key}
              label={item.label}
              color={item.color}
              Icon={item.Icon}
              symbol={item.symbol}
            />
          ))}
        </div>
      </div>

      {/* Slide-out filter drawer */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[1200] bg-black/20"
            />
            {/* Panel — wider for larger text/icons (was 320px) */}
            <motion.aside
              key="panel"
              initial={{ x: -420 }}
              animate={{ x: 0 }}
              exit={{ x: -420 }}
              transition={{ type: 'spring', stiffness: 280, damping: 30 }}
              className="fixed bottom-0 left-0 top-0 z-[1201] flex w-[min(420px,calc(100vw-24px))] flex-col
                         border-r border-neutral-200 bg-white shadow-2xl"
            >
              <div className="border-b border-neutral-200 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                      ВСМ-1
                    </div>
                    <h2 className="mt-1 text-sm font-heading font-semibold text-neutral-950">
                      Управление картой
                    </h2>
                  </div>
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded-md p-2 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-950"
                    aria-label="Закрыть"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase text-neutral-400">Участки</div>
                    <div className="text-sm font-semibold text-neutral-900">{sections.size}/{ALL_SECTIONS.length}</div>
                  </div>
                  <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase text-neutral-400">Объекты</div>
                    <div className="text-sm font-semibold text-neutral-900">{objTypes.size}/{OBJ_TYPES.length - 1}</div>
                  </div>
                  <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase text-neutral-400">Техника</div>
                    <div className="text-sm font-semibold text-neutral-900">{equipTypes.size}/{EQUIP_TYPES.length}</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 py-1.5">
                <button
                  onClick={() => {
                    setSections(new Set(ALL_SECTIONS))
                    setDateISO(yesterdayISO())
                    setPkFrom('')
                    setPkTo('')
                    setObjTypes(new Set(OBJ_TYPES.filter((t) => t.key !== 'temp_road').map((t) => t.key) as ObjectTypeKey[]))
                    setShowTempRoads(false)
                    setEquipTypes(new Set(EQUIP_TYPES.map((t) => t.key)))
                  }}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-semibold text-neutral-600 transition-colors hover:bg-white hover:text-neutral-950"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Сбросить
                </button>
                <button
                  onClick={() => setShowTempRoads((v) => !v)}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    showTempRoads
                      ? 'bg-cyan-100 text-cyan-950'
                      : 'bg-white text-neutral-600 hover:text-neutral-950'
                  }`}
                >
                  {showTempRoads ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  Временные АД
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3 text-sm">
                {/* Участок */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      Участок
                    </span>
                    <div className="flex gap-3 text-xs">
                      <button onClick={selectAllSections} className="font-semibold text-red-700 hover:underline">
                        все
                      </button>
                      <button onClick={clearSections} className="text-neutral-500 hover:underline">
                        снять
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SECTIONS_UI.map(({ key, codes, label }) => {
                      const checked = codes.every((c) => sections.has(c))
                      return (
                        <label key={key} className={`flex cursor-pointer items-center gap-1.5 rounded-md border p-1.5 transition-colors ${
                          checked ? 'border-neutral-300 bg-neutral-50' : 'border-transparent hover:bg-neutral-50'
                        }`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSectionUI(codes)}
                            className="h-4 w-4 accent-red-700"
                          />
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: SECTION_SWATCH[key] ?? '#9ca3af' }}
                          />
                          <span className="min-w-0 text-xs leading-tight break-words">{label}</span>
                        </label>
                      )
                    })}
                  </div>
                </section>

                {/* Диапазон ПК */}
                <section>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Диапазон ПК
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      placeholder="от"
                      value={pkFrom}
                      onChange={(e) => setPkFrom(e.target.value)}
                      className="min-h-9 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-400"
                    />
                    <span className="text-neutral-400">—</span>
                    <input
                      type="number"
                      placeholder="до"
                      value={pkTo}
                      onChange={(e) => setPkTo(e.target.value)}
                      className="min-h-9 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-400"
                    />
                  </div>
                </section>

                {/* Тип объектов */}
                <section>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Объекты
                  </div>
                  <div className="flex flex-col gap-1">
                    {OBJ_TYPES.map(({ key, label, Icon, symbol, color }) => {
                      const checked = key === 'temp_road' ? showTempRoads : objTypes.has(key as ObjectTypeKey)
                      return (
                        <label key={key} className={`flex cursor-pointer items-start gap-1.5 rounded-md border p-1.5 transition-colors ${
                          checked ? 'border-neutral-300 bg-neutral-50' : 'border-transparent hover:bg-neutral-50'
                        }`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleObjType(key)}
                            className="h-4 w-4 accent-red-700"
                          />
                          <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ background: color }}
                          />
                          {symbol
                            ? <ObjectGlyph symbol={symbol} color={color} />
                            : Icon && <Icon className="w-4 h-4 text-neutral-500" />}
                          <span className="min-w-0 flex-1 text-xs leading-tight break-words">{label}</span>
                          {key === 'temp_road' && !checked && (
                            <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500">
                              off
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </section>

                {/* Тип техники */}
                <section>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Техника
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {EQUIP_TYPES.map((t) => (
                      <label key={t.key} className={`flex cursor-pointer items-center gap-1.5 rounded-md border p-1.5 transition-colors ${
                        equipTypes.has(t.key) ? 'border-neutral-300 bg-neutral-50' : 'border-transparent hover:bg-neutral-50'
                      }`}>
                        <input
                          type="checkbox"
                          checked={equipTypes.has(t.key)}
                          onChange={() => toggleEquipType(t.key)}
                          className="h-4 w-4 accent-red-700"
                        />
                        <img
                          src={`/icons/${t.key}.svg`}
                          alt=""
                          className="w-4 h-4 opacity-90"
                        />
                        <span className="min-w-0 text-xs leading-tight break-words">{t.label}</span>
                      </label>
                    ))}
                  </div>
                </section>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
