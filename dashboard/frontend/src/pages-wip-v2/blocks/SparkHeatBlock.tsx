/**
 * Спарклайн + мини-хит-мэп для категории работ.
 * Спарклайн: SVG polyline с анимированным draw + точка на последнем значении.
 * Хит-мэп: сетка (день × участок), интенсивность — по value/max, анимация fade-in.
 */
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { useRef, useState } from 'react'

interface Point { date: string; value: number }
interface Cell { date: string; section: string; value: number }
interface Resp {
  from: string; to: string
  days: string[]; sections: string[]
  timeseries: Point[]; heatmap: Cell[]
}

const nf = new Intl.NumberFormat('ru-RU')
const fmt = (n: number) => nf.format(Math.round(n))

export function SparkHeatBlock({
  from, to, category,
}: { from: string; to: string; category: string }) {
  const { data } = useQuery<Resp>({
    queryKey: ['wip', 'timeseries', from, to, category],
    queryFn: () =>
      fetch(`/api/wip/analytics/works-timeseries?from=${from}&to=${to}&category=${category}`)
        .then(r => r.json()),
    staleTime: 60_000,
  })
  if (!data) return <div className="h-32 bg-bg-surface/30 rounded-md animate-pulse" />

  const ts = data.timeseries
  const maxTs = Math.max(1, ...ts.map(p => p.value))
  const last = ts[ts.length - 1]?.value ?? 0
  // Тренд — сравнение последних 7 дней vs предыдущие 7.
  const last7 = ts.slice(-7).reduce((s, p) => s + p.value, 0)
  const prev7 = ts.slice(-14, -7).reduce((s, p) => s + p.value, 0)
  const deltaPct = prev7 > 0 ? (last7 - prev7) / prev7 * 100 : null

  return (
    <div className="space-y-3">
      <Sparkline points={ts} maxVal={maxTs} />
      <div className="flex items-baseline gap-2 text-[11px] font-mono">
        <span className="text-text-muted">последний:</span>
        <span className="text-text-primary font-semibold">{fmt(last)}</span>
        {deltaPct != null && (
          <span className={deltaPct > 0 ? 'text-[#16a34a]' : 'text-accent-red'}>
            {deltaPct > 0 ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(0)}% к прошлой неделе
          </span>
        )}
      </div>
      <Heatmap data={data} />
    </div>
  )
}

function Sparkline({ points, maxVal }: { points: Point[]; maxVal: number }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  if (points.length < 2) return <div className="h-14 bg-bg-surface/30 rounded" />
  const W = 240, H = 48, PAD = 4
  const step = (W - PAD * 2) / Math.max(1, points.length - 1)
  const yOf = (v: number) => H - PAD - (v / maxVal) * (H - PAD * 2)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${PAD + i * step} ${yOf(p.value)}`).join(' ')
  const area = `${path} L ${W - PAD} ${H - PAD} L ${PAD} ${H - PAD} Z`
  const lastX = PAD + (points.length - 1) * step
  const lastY = yOf(points[points.length - 1].value)
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(points.length - 1, Math.round((x - PAD) / step)))
    setHover({ i, x: PAD + i * step, y: yOf(points[i].value) })
  }
  const hovP = hover ? points[hover.i] : null
  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" className="block"
           onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="sparkgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dc2626" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#dc2626" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path d={area} fill="url(#sparkgrad)"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }} />
        <motion.path d={path} fill="none" stroke="#dc2626" strokeWidth="1.5"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} />
        <motion.circle cx={lastX} cy={lastY} r={3} fill="#dc2626"
          initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.9, duration: 0.2 }} />
        {hover && (
          <>
            <line x1={hover.x} y1={PAD} x2={hover.x} y2={H - PAD}
                  stroke="#dc2626" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.6" />
            <circle cx={hover.x} cy={hover.y} r={2.5} fill="#dc2626" />
          </>
        )}
      </svg>
      {hovP && (
        <div className="absolute -top-7 bg-[#1a1a1a] text-white text-[10px] font-mono px-2 py-0.5 rounded pointer-events-none"
             style={{ left: `${(hover!.x / W) * 100}%`, transform: 'translateX(-50%)' }}>
          {hovP.date} · {fmt(hovP.value)}
        </div>
      )}
    </div>
  )
}

function heatmapSectionLabel(section: string): string {
  if (section === '—') return 'Без участка'
  return section.replace('UCH_', '№')
}

function Heatmap({ data }: { data: Resp }) {
  const max = Math.max(1, ...data.heatmap.map(c => c.value))
  const cellByKey: Record<string, number> = {}
  for (const c of data.heatmap) cellByKey[`${c.date}|${c.section}`] = c.value
  // Сокращение дней для экрана — шаг через каждые N, если > 21.
  const days = data.days.length > 21
    ? data.days.filter((_, i) => i % 2 === 0)
    : data.days
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-text-muted mb-1">По участкам × дням</div>
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-0.5">
          {data.sections.map(sec => (
            <div key={sec} className="flex items-center gap-1">
              <span className="text-[9px] font-mono text-text-muted w-6 shrink-0">{heatmapSectionLabel(sec)}</span>
              <div className="flex gap-0.5">
                {days.map((d, i) => {
                  const v = cellByKey[`${d}|${sec}`] ?? 0
                  const alpha = v > 0 ? Math.max(0.12, v / max) : 0
                  return (
                    <motion.div key={d} className="w-2.5 h-2.5 rounded-[1px]"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.01 * i, duration: 0.2 }}
                      style={{ background: v > 0 ? `rgba(220,38,38,${alpha})` : '#f4f4f5' }}
                      title={`${heatmapSectionLabel(sec)} · ${d}: ${fmt(v)}`}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
