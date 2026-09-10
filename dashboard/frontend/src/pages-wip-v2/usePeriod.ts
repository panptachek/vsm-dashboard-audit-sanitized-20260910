import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export type Preset = 'today' | 'week' | 'month' | 'inception' | 'custom'

const INCEPTION = '2025-08-01'

function isoLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateFromIso(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function isoDateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return isoLocalDate(d)
}

function isoYesterday(): string {
  return isoDateOffset(-1)
}

function calendarWeekStartIso(baseIso: string): string {
  const d = dateFromIso(baseIso)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return isoLocalDate(d)
}

function calendarMonthStartIso(baseIso: string): string {
  const d = dateFromIso(baseIso)
  return isoLocalDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

export function usePeriod(): {
  from: string
  to: string
  preset: Preset
  setPreset: (p: Preset) => void
  setRange: (from: string, to: string) => void
} {
  const [sp, setSp] = useSearchParams()
  const yd = isoYesterday()
  const from = sp.get('from') ?? yd
  const to = sp.get('to') ?? yd

  const preset: Preset = useMemo(() => {
    if (from === to && from === yd) return 'today'
    if (from === calendarWeekStartIso(yd) && to === yd) return 'week'
    if (from === calendarMonthStartIso(yd) && to === yd) return 'month'
    if (from === INCEPTION && to === yd) return 'inception'
    return 'custom'
  }, [from, to, yd])

  const setRange = useCallback((f: string, t: string) => {
    setSp(prev => { const n = new URLSearchParams(prev); n.set('from', f); n.set('to', t); return n })
  }, [setSp])

  const setPreset = useCallback((p: Preset) => {
    const yd = isoYesterday()
    if (p === 'today') setRange(yd, yd)
    else if (p === 'week') {
      setRange(calendarWeekStartIso(yd), yd)
    } else if (p === 'month') {
      setRange(calendarMonthStartIso(yd), yd)
    } else if (p === 'inception') {
      setRange(INCEPTION, yd)
    }
  }, [setRange])

  return { from, to, preset, setPreset, setRange }
}
