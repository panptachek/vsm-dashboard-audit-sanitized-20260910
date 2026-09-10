// После миграции 24.04.2026 UCH_3 — единый код (раньше был разбит на UCH_31/UCH_32).
export const ACTIVE_SECTION_CODES = [
  'UCH_1', 'UCH_2', 'UCH_3', 'UCH_4',
  'UCH_5', 'UCH_6', 'UCH_7', 'UCH_8',
] as const;

export type SectionCode = typeof ACTIVE_SECTION_CODES[number];

export function sectionCodeToNumber(code: string): number {
  const m = code.match(/^UCH_(\d)/);
  if (!m) throw new Error(`Unknown section code: ${code}`);
  return parseInt(m[1], 10);
}

export function sectionCodeToUILabel(code: string): string {
  if (!code || code === '—') return 'Без участка';
  try {
    return `Участок №${sectionCodeToNumber(code)}`;
  } catch {
    return code;
  }
}

export function sectionCodeToUILabelSafe(code: string | null | undefined, fallback = 'Без участка'): string {
  if (!code || code === '—') return fallback;
  return sectionCodeToUILabel(code);
}

/** Для SQL WHERE: список всех кодов участка N */
export function sectionNumberToCodes(n: number): string[] {
  return [`UCH_${n}`];
}
