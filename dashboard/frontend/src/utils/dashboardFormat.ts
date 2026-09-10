export function formatNumber(value: number | null | undefined, digits = 0): string {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(safe);
}

export function formatM3(value: number | null | undefined, digits = 0): string {
  return `${formatNumber(value, digits)} м³`;
}

export function formatHours(value: number | null | undefined, digits = 0): string {
  return `${formatNumber(value, digits)} ч`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${formatNumber(Number(value), digits)}%`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function dateRangeLabel(start: string, end: string): string {
  if (!start && !end) return '';
  if (start === end) return start;
  return `${start} — ${end}`;
}
