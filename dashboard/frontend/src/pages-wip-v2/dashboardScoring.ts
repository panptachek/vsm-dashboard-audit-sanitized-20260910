export const DASHBOARD_SCORE_WEIGHTS = {
  sandDelivered: 0.24,
  sandPlaced: 0.24,
  pilesDriven: 0.18,
  accessRoadEmbankmentRate: 0.18,
  equipmentUptime: 0.16,
} as const

export type DashboardScoreKey = keyof typeof DASHBOARD_SCORE_WEIGHTS

export interface ScoreInputs {
  sandDelivered: number
  sandPlaced: number
  pilesDriven: number
  accessRoadEmbankmentRate: number
  equipmentUptime: number
  dataQualityPenalty?: number
}

export interface ScoreBreakdown {
  score: number
  penalty: number
  components: Record<DashboardScoreKey, number>
  contributions: Record<DashboardScoreKey, number>
}

const SCORE_CAP = 150

export function clampScore(value: number, cap = SCORE_CAP): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, cap)
}

export function normalizeToBest(value: number, best: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(best) || best <= 0 || value <= 0) return 0
  return clampScore((value / best) * 100)
}

export function calculateDashboardScore(inputs: ScoreInputs): ScoreBreakdown {
  const components: Record<DashboardScoreKey, number> = {
    sandDelivered: clampScore(inputs.sandDelivered),
    sandPlaced: clampScore(inputs.sandPlaced),
    pilesDriven: clampScore(inputs.pilesDriven),
    accessRoadEmbankmentRate: clampScore(inputs.accessRoadEmbankmentRate),
    equipmentUptime: clampScore(inputs.equipmentUptime),
  }
  const contributions = Object.fromEntries(
    (Object.keys(DASHBOARD_SCORE_WEIGHTS) as DashboardScoreKey[]).map(key => [
      key,
      components[key] * DASHBOARD_SCORE_WEIGHTS[key],
    ]),
  ) as Record<DashboardScoreKey, number>
  const penalty = Math.max(0, inputs.dataQualityPenalty || 0)
  const rawScore = Object.values(contributions).reduce((sum, value) => sum + value, 0) - penalty
  return {
    score: round1(Math.max(0, rawScore)),
    penalty: round1(penalty),
    components: roundRecord(components),
    contributions: roundRecord(contributions),
  }
}

export function formatCompact(value: number | string): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function formatRuNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits })
}

export function formatIsoDate(value: string): string {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}.${year}`
}

export function round1(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
}

function roundRecord<T extends string>(record: Record<T, number>): Record<T, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, round1(Number(value))]),
  ) as Record<T, number>
}
