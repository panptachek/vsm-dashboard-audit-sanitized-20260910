/**
 * Общий селектор периода для WIP v2.
 * Пресеты: день / неделя / месяц / с начала / диапазон.
 * Состояние — в URL (?from=YYYY-MM-DD&to=YYYY-MM-DD).
 */
import { Calendar } from 'lucide-react'
import { usePeriod } from './usePeriod'
import type { Preset } from './usePeriod'

export function PeriodBar() {
  const { from, to, preset, setPreset, setRange } = usePeriod()
  const chip = (p: Preset, label: string) => (
    <button
      key={p}
      onClick={() => setPreset(p)}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
        preset === p
          ? 'bg-slate-800 text-white'
          : 'bg-white text-gray-600 border border-gray-200 hover:bg-neutral-100'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="no-print sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-border px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-text-muted mr-2">Период</span>
      {chip('today', 'Сегодня')}
      {chip('week', 'Неделя')}
      {chip('month', 'Месяц')}
      {chip('inception', 'С начала')}
      <div className="flex items-center gap-2 ml-auto">
        <Calendar className="w-4 h-4 text-text-muted" />
        <input type="date" value={from} onChange={e => setRange(e.target.value, to)}
          className="px-2 py-1 text-xs font-mono border border-border rounded-md bg-white" />
        <span className="text-text-muted text-xs">—</span>
        <input type="date" value={to} onChange={e => setRange(from, e.target.value)}
          className="px-2 py-1 text-xs font-mono border border-border rounded-md bg-white" />
      </div>
    </div>
  )
}
