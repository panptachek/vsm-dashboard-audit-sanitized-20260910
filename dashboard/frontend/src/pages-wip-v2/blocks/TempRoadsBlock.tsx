/**
 * Блок «Схемы отсыпки временных автодорог».
 * Каждая карточка — SVG-схема в стиле суточного PDF-отчёта:
 *   6 треков (Пионерка, ЗП в работе, ДСО, Под ЩПГС, ЗП готово, Не в работе),
 *   ось ПК с тиками и подписями, границы ВСЖМ/АД, статистика и легенда.
 * «Не в работе» вычисляется как ВСЖМ-спан минус объединение остальных сегментов.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { FileDown, Layers, X } from 'lucide-react'
import {
  MAINLINE_FILL_STATUS_BY_KEY,
  MAINLINE_FILL_STATUS_DEFINITIONS,
  TEMP_ROAD_FILL_STATUS_BY_KEY,
  TEMP_ROAD_FILL_STATUS_DEFINITIONS,
  type MainlineFillStatusKey,
  type TempRoadFillStatusKey,
} from '../fillStatusMeta'

const TEMP_ROADS_STALE_MS = 5 * 60_000
const TEMP_ROADS_GC_MS = 15 * 60_000

export type TempRoadSchemeStatusType =
  | 'shpgs_done'
  | 'ready_for_shpgs'
  | 'dso'
  | 'subgrade_not_to_grade'
  | 'pioneer_fill'
  | 'no_work'
  | string

export interface TempRoadSchemeSegment {
  // Старые поля — координата на текущей оси (rail, если rail-мэппинг есть, иначе AD).
  pk_start: number; pk_end: number
  // Новые поля — обе координаты, чтобы длины считать всегда в АД (как в PDF).
  ad_pk_start?: number | null; ad_pk_end?: number | null
  rail_pk_start?: number | null; rail_pk_end?: number | null
  status_type: TempRoadSchemeStatusType; is_demo?: boolean
}
interface RoadSectionRange {
  section_code: string
  section_name?: string | null
  section_num?: number | null
  ad_pk_start: number
  ad_pk_end: number
  rail_pk_start?: number | null
  rail_pk_end?: number | null
}

type MainlineWorkMetricKey = 'prs' | 'peat_removal' | 'weak_soil_replacement' | 'excavation' | 'embankment'

interface MainlineWorkTotal {
  key: MainlineWorkMetricKey | string
  label: string
  volume_m3: number
}

interface MainlineWorkDetailRow {
  date: string
  metric_key: MainlineWorkMetricKey | string
  label: string
  volume_m3: number
  shift?: string | null
  work_type_code?: string | null
  work_type_name?: string | null
  object_code?: string | null
  object_name?: string | null
  analytics_tag?: string | null
  pk_start?: number | null
  pk_end?: number | null
}

interface MainlineWorkDay {
  date: string
  totals: MainlineWorkTotal[]
  rows: MainlineWorkDetailRow[]
}

interface MainlineSegmentDay {
  date: string
  source?: 'report' | 'correction' | string | null
  action?: string | null
  status_type: MainlineFillStatusKey | string
  status_label: string
  pk_start?: number | null
  pk_end?: number | null
  length_m?: number | null
  comment?: string | null
}

interface MainlineRdDocument {
  id: string
  rd_code?: string | null
  rd_title?: string | null
  issued_at?: string | null
  pk_start?: number | null
  pk_end?: number | null
  comment?: string | null
}

interface MainlineScheduleRow {
  id: string
  schedule_label?: string | null
  required_start_date?: string | null
  required_finish_date?: string | null
  work_direction?: string | null
  pk_start?: number | null
  pk_end?: number | null
  comment?: string | null
}

interface MainlinePileSummary {
  planned_main?: number | null
  planned_trial?: number | null
  driven_main?: number | null
  driven_trial?: number | null
  pile_mark?: string | null
  pile_marks?: string[]
  pk_start?: number | null
  pk_end?: number | null
  available_from?: string | null
  source?: string | null
}

interface MainlineRelatedObject {
  section_id?: string | null
  section_code?: string | null
  object_id: string
  object_code?: string | null
  object_name?: string | null
  object_type_code?: string | null
  object_type_name?: string | null
  object_group: string
  object_group_label?: string | null
  pk_start: number
  pk_end: number
  object_pk_start?: number | null
  object_pk_end?: number | null
  clipped?: boolean
  rd_status?: 'issued' | 'partial' | 'missing' | string | null
  rd_label?: string | null
  rd_documents?: MainlineRdDocument[]
  schedule_rows?: MainlineScheduleRow[]
  required_start_date?: string | null
  required_finish_date?: string | null
  schedule_label?: string | null
  schedule_comment?: string | null
  communication_type?: string | null
  communications?: string | null
  object_comment?: string | null
  pile_summary?: MainlinePileSummary | null
}

interface MainlineRdSummary {
  issued?: number
  partial?: number
  missing?: number
}

interface MainlineSectionDetail {
  as_of: string
  section_id: string
  section_code: string
  section_name?: string | null
  ranges: Array<{ pk_start: number; pk_end: number }>
  work_totals: MainlineWorkTotal[]
  project_totals?: MainlineWorkTotal[]
  work_days: MainlineWorkDay[]
  segment_days: MainlineSegmentDay[]
  related_objects?: MainlineRelatedObject[]
  rd_documents?: MainlineRdDocument[]
  schedule_rows?: MainlineScheduleRow[]
  rd_summary?: MainlineRdSummary
  rd_schema_ready?: boolean
  schedule_schema_ready?: boolean
}

export interface TempRoadSchemeRoad {
  id: string; code: string; name: string
  ad_pk_start: number; ad_pk_end: number
  rail_pk_start: number | null; rail_pk_end: number | null
  length_m: number | null
  effective_date: string | null
  section_code?: string | null
  axis_label?: string
  axis_ranges?: Array<{ pk_start: number; pk_end: number }>
  sections?: RoadSectionRange[]
  work_totals?: MainlineWorkTotal[]
  related_objects?: MainlineRelatedObject[]
  rd_documents?: MainlineRdDocument[]
  schedule_rows?: MainlineScheduleRow[]
  rd_summary?: MainlineRdSummary
  segments: TempRoadSchemeSegment[]
}

interface MainlineSchemeSegment {
  pk_start: number
  pk_end: number
  status_type: MainlineFillStatusKey | string
  is_demo?: boolean
}

interface MainlineSchemeSection {
  section_id: string
  section_code: string
  section_name?: string | null
  sort_order?: number | null
  pk_start?: number | null
  pk_end?: number | null
  ranges?: Array<{ pk_start: number; pk_end: number }>
  segments: MainlineSchemeSegment[]
  work_totals?: MainlineWorkTotal[]
  related_objects?: MainlineRelatedObject[]
  rd_documents?: MainlineRdDocument[]
  schedule_rows?: MainlineScheduleRow[]
  rd_summary?: MainlineRdSummary
  effective_date?: string | null
}

interface UpdatedRow { road_code: string; status_type: TempRoadSchemeStatusType; last_updated: string }

type SchemeMode = 'temp_roads' | 'mainline'
type TrackKey = TempRoadFillStatusKey | MainlineFillStatusKey
type MainlineObjectSymbol = 'bridge' | 'pipe' | 'overpass' | 'pile_field' | 'intersection_fin' | 'intersection_prop' | 'other'

interface TrackConfig {
  tracks: TrackKey[]
  label: Record<string, string>
  help: Record<string, string>
  fill: Record<string, string>
  stroke: Record<string, string>
  mode: SchemeMode
  completedKeys: TrackKey[]
}

function buildTrackConfig(mode: SchemeMode): TrackConfig {
  const definitions = mode === 'mainline' ? MAINLINE_FILL_STATUS_DEFINITIONS : TEMP_ROAD_FILL_STATUS_DEFINITIONS
  return {
    tracks: definitions.map(item => item.key),
    label: Object.fromEntries(definitions.map(item => [item.key, item.shortLabel])),
    help: Object.fromEntries(definitions.map(item => [item.key, item.description])),
    fill: Object.fromEntries(definitions.map(item => [item.key, item.key === 'no_work' ? 'url(#hatch)' : item.fill])),
    stroke: Object.fromEntries(definitions.map(item => [item.key, item.stroke])),
    mode,
    completedKeys: mode === 'mainline'
      ? ['protective_layer_1', 'asphalt_layer']
      : ['ready_for_shpgs', 'shpgs_done'],
  }
}

const DEFAULT_TEMP_ROAD_TRACK_CONFIG = buildTrackConfig('temp_roads')
const MAINLINE_OBJECT_TYPE_META: Record<string, { label: string; symbol: MainlineObjectSymbol; color: string; fill: string; text: string }> = {
  PILE_FIELD: { label: 'Свайные поля', symbol: 'pile_field', color: '#007fff', fill: '#e0f2fe', text: '#075985' },
  BRIDGE: { label: 'ЖДМ и эстакады', symbol: 'bridge', color: '#111827', fill: '#f8fafc', text: '#111827' },
  OVERPASS: { label: 'Путепроводы', symbol: 'overpass', color: '#111827', fill: '#f8fafc', text: '#111827' },
  PIPE: { label: 'Водопропускные трубы', symbol: 'pipe', color: '#06b6d4', fill: '#ecfeff', text: '#0e7490' },
  INTERSECTION_FIN: { label: 'Пересечения', symbol: 'intersection_fin', color: '#7c3aed', fill: '#f5f3ff', text: '#5b21b6' },
  INTERSECTION_PROP: { label: 'Пересечения', symbol: 'intersection_prop', color: '#7c3aed', fill: '#f5f3ff', text: '#5b21b6' },
  RECONS_ROAD: { label: 'Пересечения', symbol: 'intersection_prop', color: '#7c3aed', fill: '#f5f3ff', text: '#5b21b6' },
}
const MAINLINE_OBJECT_LEGEND = ['BRIDGE', 'OVERPASS', 'PILE_FIELD', 'INTERSECTION_FIN', 'PIPE'] as const

function toTrack(st: string, config: TrackConfig): TrackKey | null {
  const key = st as TrackKey
  const exists = config.mode === 'mainline'
    ? Boolean(MAINLINE_FILL_STATUS_BY_KEY[key as MainlineFillStatusKey])
    : Boolean(TEMP_ROAD_FILL_STATUS_BY_KEY[key as TempRoadFillStatusKey])
  return exists && key !== 'no_work' ? key : null
}

function formatPk(pk100: number): string {
  const sign = pk100 < 0 ? '-' : ''
  const abs = Math.abs(pk100)
  const pk = Math.floor(abs / 100)
  const plus = abs - pk * 100
  return `${sign}ПК${pk}+${plus.toFixed(2).padStart(5, '0')}`
}

type Range = [number, number]

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as Range).sort((a, b) => a[0] - b[0])
  const out: Range[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]
    const last = out[out.length - 1]
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

function subtractRanges(universe: Range, ranges: Range[]): Range[] {
  const [uStart, uEnd] = universe
  const merged = mergeRanges(ranges)
  const out: Range[] = []
  let cursor = uStart
  for (const [s, e] of merged) {
    if (e <= uStart) continue
    if (s >= uEnd) break
    const ss = Math.max(s, uStart)
    const ee = Math.min(e, uEnd)
    if (ss > cursor) out.push([cursor, ss])
    cursor = Math.max(cursor, ee)
  }
  if (cursor < uEnd) out.push([cursor, uEnd])
  return out
}

function normalizeAllowedRanges(
  ranges: Array<{ pk_start: number; pk_end: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
): Range[] {
  const fallback: Range = [Math.min(fallbackStart, fallbackEnd), Math.max(fallbackStart, fallbackEnd)]
  const normalized = (ranges || [])
    .map(range => clampRange(range.pk_start, range.pk_end, fallback[0], fallback[1]))
    .filter((range): range is Range => Boolean(range))
  return normalized.length ? mergeRanges(normalized) : [fallback]
}

function subtractRangeSet(universes: Range[], ranges: Range[]): Range[] {
  return universes.flatMap(universe => subtractRanges(universe, ranges))
}

function clampRange(start: number, end: number, minValue: number, maxValue: number): Range | null {
  const a = Math.max(Math.min(start, end), Math.min(minValue, maxValue))
  const b = Math.min(Math.max(start, end), Math.max(minValue, maxValue))
  return b - a > 0.01 ? [a, b] : null
}

// Шаг подбирается так, чтобы на оси получалось ~8–15 подписей.
function pkTicks(pkStart: number, pkEnd: number): { pk: number; labelled: boolean }[] {
  const startPK = Math.ceil(pkStart / 100)
  const endPK = Math.floor(pkEnd / 100)
  const count = Math.max(0, endPK - startPK + 1)
  if (count <= 0) return []
  const steps = [1, 2, 5, 10, 20, 50]
  let step = 1
  for (const s of steps) {
    if (Math.ceil(count / s) <= 15) { step = s; break }
  }
  const ticks: { pk: number; labelled: boolean }[] = []
  for (let pk = startPK; pk <= endPK; pk++) {
    ticks.push({ pk, labelled: pk % step === 0 })
  }
  return ticks
}

// Участки по дороге. Сплит-дороги (АД8 №1, АД4 №8) принадлежат двум участкам.
const ROAD_TO_SECTIONS: Record<string, number[]> = {
  'АД9': [1], 'АД6': [1], 'АД5': [1], 'АД13': [1],
  'АД14': [2],
  'АД7': [3], 'АД15': [3], 'АД1': [3],
  'АД8 №1': [3, 4],
  'АД3': [4],
  'АД8 №2': [5], 'АД11': [5],
  'АД12': [6], 'АД2 №6': [6],
  'АД2 №7': [7], 'АД4 №7': [7],
  'АД4 №8': [7, 8],
  'АД4 №8.1': [8], 'АД4 №9': [8],
}

function sectionNumFromCode(code: string | null | undefined): number | null {
  const match = String(code || '').match(/^UCH_(\d+)$/)
  return match ? Number(match[1]) : null
}

function uniqueSections(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))))
}

export function parseTempRoadSchemeTitle(road: TempRoadSchemeRoad): { title: string; sectionNum: number | null; sections: number[] } {
  const raw = road.code || road.name || ''
  const m = raw.match(/^АД\s*(\d+(?:\.\d+)?)\s*(№\s*\d+(?:\.\d+)?)?$/i)
  let title = raw
  if (m) {
    const x = m[1]
    const y = (m[2] || '').replace(/\s+/g, '')
    title = y ? `АД${x} ${y}` : `АД${x}`
  }
  const configuredSections = uniqueSections((road.sections || []).map(section => section.section_num ?? sectionNumFromCode(section.section_code)))
  const sections = configuredSections.length ? configuredSections : (ROAD_TO_SECTIONS[raw] ?? [])
  return { title, sectionNum: sections[0] ?? null, sections }
}

function mainlineSchemeTitle(road: TempRoadSchemeRoad): { title: string; sectionNum: number | null; sections: number[] } {
  const sectionNum = sectionNumFromCode(road.code)
  const title = sectionNum ? `Участок ${sectionNum}` : (road.code || road.name)
  return { title, sectionNum, sections: sectionNum ? [sectionNum] : [] }
}

function mainlineSectionToSchemeRoad(section: MainlineSchemeSection): TempRoadSchemeRoad {
  const fallbackStart = section.pk_start ?? 0
  const fallbackEnd = section.pk_end ?? fallbackStart
  const ranges = normalizeAllowedRanges(section.ranges, fallbackStart, fallbackEnd)
  const pkStart = ranges.length ? Math.min(...ranges.map(range => range[0])) : Math.min(fallbackStart, fallbackEnd)
  const pkEnd = ranges.length ? Math.max(...ranges.map(range => range[1])) : Math.max(fallbackStart, fallbackEnd)
  const length = ranges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0)
  return {
    id: section.section_id,
    code: section.section_code,
    name: section.section_name || section.section_code,
    ad_pk_start: pkStart,
    ad_pk_end: pkEnd,
    rail_pk_start: null,
    rail_pk_end: null,
    length_m: length,
    effective_date: section.effective_date || null,
    section_code: section.section_code,
    axis_label: 'ОХ',
    axis_ranges: ranges.map(([start, end]) => ({ pk_start: start, pk_end: end })),
    work_totals: section.work_totals || [],
    related_objects: section.related_objects || [],
    rd_documents: section.rd_documents || [],
    schedule_rows: section.schedule_rows || [],
    rd_summary: section.rd_summary || {},
    segments: (section.segments || []).map(segment => ({
      pk_start: segment.pk_start,
      pk_end: segment.pk_end,
      ad_pk_start: segment.pk_start,
      ad_pk_end: segment.pk_end,
      status_type: segment.status_type,
      is_demo: Boolean(segment.is_demo),
    })),
  }
}

function roadForSection(road: TempRoadSchemeRoad, sectionFilter: number | 'all'): TempRoadSchemeRoad {
  if (sectionFilter === 'all') return road
  const ranges = (road.sections || []).filter(section => (section.section_num ?? sectionNumFromCode(section.section_code)) === sectionFilter)
  if (!ranges.length) return road
  const adStart = Math.min(...ranges.map(section => section.ad_pk_start))
  const adEnd = Math.max(...ranges.map(section => section.ad_pk_end))
  const railValues = ranges.flatMap(section => [section.rail_pk_start, section.rail_pk_end])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return {
    ...road,
    ad_pk_start: adStart,
    ad_pk_end: adEnd,
    rail_pk_start: railValues.length ? Math.min(...railValues) : road.rail_pk_start,
    rail_pk_end: railValues.length ? Math.max(...railValues) : road.rail_pk_end,
    length_m: Math.abs(adEnd - adStart),
  }
}

function formatMeters(m: number): string {
  const rounded = Math.round(m * 100) / 100
  const [i, f = '00'] = rounded.toFixed(2).split('.')
  // Пробельный разделитель тысяч как в PDF: "1 099.00"
  const iGrouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')
  return `${iGrouped}.${f}`
}

const volumeFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

function formatVolume(value: number | null | undefined): string {
  return volumeFormatter.format(Number(value || 0))
}

function formatDateLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value)
}

function shiftLabel(value: string | null | undefined): string {
  return String(value || '').toLowerCase() === 'night' ? 'Ночь' : 'День'
}

function formatPkRange(start: number | null | undefined, end: number | null | undefined): string {
  if (start == null || end == null) return 'ПК н/д'
  return `${formatPk(start)} — ${formatPk(end)}`
}

function formatPkRanges(
  ranges: Array<{ pk_start: number; pk_end: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
): string {
  const source = ranges?.length ? ranges : [{ pk_start: fallbackStart, pk_end: fallbackEnd }]
  return source.map(range => formatPkRange(range.pk_start, range.pk_end)).join(' · ')
}

function mainlineObjectTypeMeta(row: Pick<MainlineRelatedObject, 'object_type_code' | 'object_type_name'>) {
  return MAINLINE_OBJECT_TYPE_META[String(row.object_type_code || '').trim().toUpperCase()] || {
    label: row.object_type_name || 'Объект',
    symbol: 'other' as MainlineObjectSymbol,
    color: '#6b7280',
    fill: '#f3f4f6',
    text: '#374151',
  }
}

function mainlineObjectDisplay(row: MainlineRelatedObject): string {
  return row.object_name || row.object_type_name || mainlineObjectTypeMeta(row).label || 'Объект'
}

function mainlineObjectFullName(row: MainlineRelatedObject): string {
  return mainlineObjectDisplay(row)
}

function mainlineObjectHumanComment(value: string | null | undefined): string | null {
  const text = String(value || '').trim()
  if (!text) return null
  if (/(sync|synced|imported_at|xlsx_row|statement_reinforcement_sections|pile_catalog_full_sync|aug_book_authority_apply|reinforcement_statement)/i.test(text)) {
    return null
  }
  return text
}

function mainlineObjectShortLabel(row: MainlineRelatedObject): string {
  const text = mainlineObjectDisplay(row).replace(/\s+/g, ' ').trim()
  const code = String(row.object_type_code || '').trim().toUpperCase()
  if (code === 'PILE_FIELD') {
    const match = text.match(/(?:свайное\s+поле|^сп)\s*([0-9]+(?:[_-][0-9]+)?\s*[нНnN]?)/i)
    const number = (match?.[1] || text.replace(/^свайное\s+поле\s*/i, '')).replace(/\s+/g, '').replace(/-/, '_')
    return `СП ${number}`.replace(/[нn]$/i, 'Н')
  }
  return text.length > 34 ? `${text.slice(0, 31)}...` : text
}

function mainlineObjectCalloutLabel(row: MainlineRelatedObject): string {
  const text = mainlineObjectDisplay(row).replace(/\s+/g, ' ').trim()
  const hasPk = /ПК\s*\d+/i.test(text)
  if (hasPk) return text
  const pk = Number(row.pk_start)
  return Number.isFinite(pk) ? `${text} ${formatPk(Math.round(pk))}` : text
}

function wrapSvgCalloutLabel(text: string, maxChars = 22, maxLines = 2): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars || !current) {
      current = next
      continue
    }
    lines.push(current)
    current = word
    if (lines.length >= maxLines - 1) break
  }
  const usedWords = lines.join(' ').split(' ').filter(Boolean).length + (current ? current.split(' ').filter(Boolean).length : 0)
  const tail = words.slice(usedWords).join(' ')
  if (tail && current.length + tail.length + 1 <= maxChars) {
    current = `${current} ${tail}`
  } else if (tail) {
    const limit = Math.max(1, maxChars - 1)
    current = current.length > limit ? `${current.slice(0, limit).trim()}…` : `${current}…`
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines)
}

function estimateSvgLabelWidth(text: string, fontSize = 9): number {
  return Math.max(34, text.length * fontSize * 0.56 + 14)
}

interface SvgCalloutSource {
  key: string
  label: string
  lines?: string[]
  anchorX: number
  anchorY?: number
  color: string
  textColor?: string
  height?: number
}

interface SvgCallout extends SvgCalloutSource {
  x: number
  y: number
  width: number
  height: number
}

function layoutSvgCallouts(
  items: SvgCalloutSource[],
  minX: number,
  maxX: number,
  yStart: number,
  laneHeight: number,
  lanes: number,
  fontSize = 9,
  maxWidth = 150,
): SvgCallout[] {
  if (!items.length || lanes <= 0) return []
  const laneRights = Array.from({ length: lanes }, () => minX - 8)
  const sorted = [...items].sort((a, b) => a.anchorX - b.anchorX)
  const placed: SvgCallout[] = []
  sorted.forEach(item => {
    const lines = item.lines?.length ? item.lines : [item.label]
    const width = Math.min(maxWidth, Math.max(...lines.map(line => estimateSvgLabelWidth(line, fontSize))))
    const height = item.height || Math.max(12, lines.length * (fontSize + 2) + 5)
    let bestLane: number | null = null
    let bestX = Math.max(minX, Math.min(item.anchorX - width / 2, maxX - width))
    for (let lane = 0; lane < lanes; lane++) {
      const candidateX = Math.max(minX, Math.min(item.anchorX - width / 2, maxX - width))
      if (candidateX >= laneRights[lane] + 6) {
        bestLane = lane
        bestX = candidateX
        break
      }
      if (bestLane == null || laneRights[lane] < laneRights[bestLane]) bestLane = lane
    }
    if (bestLane == null) return
    const requiredX = Math.max(bestX, laneRights[bestLane] + 6)
    if (requiredX > maxX - width + 0.01) return
    bestX = Math.max(minX, Math.min(requiredX, maxX - width))
    laneRights[bestLane] = bestX + width
    placed.push({
      ...item,
      lines,
      x: bestX,
      y: yStart + bestLane * laneHeight,
      width,
      height,
    })
  })
  return placed
}

function mainlineScheduleDirection(row: MainlineScheduleRow): string {
  if (row.work_direction) return row.work_direction
  const start = row.required_start_date || ''
  const finish = row.required_finish_date || ''
  if (!start || !finish) return 'не определено'
  return start <= finish ? 'от меньшего ПК к большему' : 'от большего ПК к меньшему'
}

function rangeLength(ranges: Range[]): number {
  return ranges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0)
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const a = Math.min(aStart, aEnd)
  const b = Math.max(aStart, aEnd)
  const c = Math.min(bStart, bEnd)
  const d = Math.max(bStart, bEnd)
  if (Math.abs(b - a) < 0.01) return c <= a && a <= d
  if (Math.abs(d - c) < 0.01) return a <= c && c <= b
  return Math.min(b, d) - Math.max(a, c) > 0.01
}

function rangeIntersectsRanges(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some(([a, b]) => rangesOverlap(start, end, a, b))
}

function _clipClientRange(start: number | null | undefined, end: number | null | undefined, allowedRanges: Range[]): Range[] {
  if (start == null || end == null) return []
  return allowedRanges
    .map(([allowedStart, allowedEnd]) => clampRange(Number(start), Number(end), allowedStart, allowedEnd))
    .filter((range): range is Range => Boolean(range))
}

function isMainlineIssoGap(row: MainlineRelatedObject): boolean {
  const code = String(row.object_type_code || '').trim().toUpperCase()
  return code === 'BRIDGE' || code === 'OVERPASS'
}

function isMainlineStructuralObject(row: MainlineRelatedObject): boolean {
  const code = String(row.object_type_code || '').trim().toUpperCase()
  return code === 'PILE_FIELD' || code === 'PIPE' || code === 'BRIDGE' || code === 'OVERPASS' || code === 'INTERSECTION_FIN' || code === 'INTERSECTION_PROP' || code === 'RECONS_ROAD'
}

function isPileFieldObject(row: MainlineRelatedObject): boolean {
  return String(row.object_type_code || '').trim().toUpperCase() === 'PILE_FIELD'
}

function isCrossingObject(row: MainlineRelatedObject): boolean {
  const code = String(row.object_type_code || '').trim().toUpperCase()
  return code === 'INTERSECTION_FIN' || code === 'INTERSECTION_PROP' || code === 'RECONS_ROAD'
}

function mainlineObjectRenderPriority(row: MainlineRelatedObject): number {
  const code = String(row.object_type_code || '').trim().toUpperCase()
  if (code === 'PILE_FIELD') return 0
  if (code === 'BRIDGE') return 1
  if (code === 'OVERPASS') return 2
  if (code === 'PIPE') return 3
  if (code === 'INTERSECTION_FIN' || code === 'INTERSECTION_PROP' || code === 'RECONS_ROAD') return 4
  return 5
}

function canShowMainlineObjectCallout(row: MainlineRelatedObject): boolean {
  const code = String(row.object_type_code || '').trim().toUpperCase()
  return code === 'BRIDGE' || code === 'OVERPASS' || code === 'PIPE'
}

function pileSummaryTotal(summary: MainlinePileSummary | null | undefined, prefix: 'planned' | 'driven'): number {
  if (!summary) return 0
  return Number(summary[`${prefix}_main`] || 0) + Number(summary[`${prefix}_trial`] || 0)
}

function pileSummaryReady(summary: MainlinePileSummary | null | undefined): boolean {
  const planned = pileSummaryTotal(summary, 'planned')
  if (planned <= 0) return false
  return pileSummaryTotal(summary, 'driven') >= planned - 0.01
}

function formatCount(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '0'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value))
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch) {
    try { return decodeURIComponent(utfMatch[1].trim()) } catch { /* fall through */ }
  }
  const asciiMatch = header.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] || null
}

async function saveResponseFile(res: Response, fallbackFilename: string) {
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackFilename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function pipelineErrorText(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const detail = (body as { detail?: unknown }).detail
  if (Array.isArray(detail)) return detail.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('; ')
  if (typeof detail === 'string') return detail
  return fallback
}

export function TempRoadsBlock({ to, initialMode = 'temp_roads' }: {
  to: string
  view?: 'table'|'cards'|'timeline'
  initialMode?: SchemeMode
}) {
  const [schemeMode, setSchemeMode] = useState<SchemeMode>(initialMode)
  const [sectionFilter, setSectionFilter] = useState<number | 'all'>('all')
  const [detailRoad, setDetailRoad] = useState<TempRoadSchemeRoad | null>(null)
  const [detailObject, setDetailObject] = useState<MainlineRelatedObject | null>(null)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const trackConfig = useMemo(() => buildTrackConfig(schemeMode), [schemeMode])

  const tempRoadsQuery = useQuery<{ roads: TempRoadSchemeRoad[]; as_of: string }>({
    queryKey: ['wip', 'temp-roads', to],
    queryFn: () => fetch(`/api/wip/temp-roads/status?to=${to}`).then(r => r.json()),
    enabled: schemeMode === 'temp_roads',
    staleTime: TEMP_ROADS_STALE_MS,
    gcTime: TEMP_ROADS_GC_MS,
    refetchOnWindowFocus: false,
  })

  const mainlineQuery = useQuery<{ sections: MainlineSchemeSection[]; as_of: string; schema_ready: boolean; rd_schema_ready?: boolean; schedule_schema_ready?: boolean }>({
    queryKey: ['wip', 'mainline-fill', to],
    queryFn: () => fetch(`/api/wip/mainline-fill/status?to=${to}`).then(r => r.json()),
    enabled: schemeMode === 'mainline',
    staleTime: TEMP_ROADS_STALE_MS,
    gcTime: TEMP_ROADS_GC_MS,
    refetchOnWindowFocus: false,
  })

  const { data: updatedData } = useQuery<{ rows: UpdatedRow[] }>({
    queryKey: ['wip', 'temp-roads', 'updated'],
    queryFn: () => fetch(`/api/wip/temp-roads/updated`).then(r => r.json()),
    staleTime: 2 * 60_000,
    gcTime: TEMP_ROADS_GC_MS,
    refetchOnWindowFocus: false,
    enabled: schemeMode === 'temp_roads',
  })

  const roads = useMemo(() => {
    if (schemeMode === 'mainline') {
      return (mainlineQuery.data?.sections || []).map(mainlineSectionToSchemeRoad)
    }
    return tempRoadsQuery.data?.roads || []
  }, [mainlineQuery.data?.sections, schemeMode, tempRoadsQuery.data?.roads])

  const updatedMap = useMemo(() => {
    const m: Record<string, Partial<Record<TrackKey, string>>> = {}
    for (const r of updatedData?.rows ?? []) {
      const key = toTrack(r.status_type, trackConfig)
      if (!key) continue
      m[r.road_code] ??= {}
      const prev = m[r.road_code][key]
      if (!prev || r.last_updated > prev) m[r.road_code][key] = r.last_updated
    }
    return m
  }, [trackConfig, updatedData])

  async function downloadMainlinePdf() {
    setExportingPdf(true)
    setExportError(null)
    try {
      const sectionCodes = sectionFilter === 'all' ? ['all'] : [`UCH_${sectionFilter}`]
      const res = await fetch('/api/wip/generator/pipeline-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_key: 'mainline_structural_scheme',
          section_codes: sectionCodes,
          date_from: to,
          date_to: to,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(async () => ({ detail: await res.text().catch(() => '') }))
        throw new Error(pipelineErrorText(body, 'Не удалось сгенерировать PDF схемы ОХ'))
      }
      await saveResponseFile(res, `mainline_structural_scheme_${to}.pdf`)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportingPdf(false)
    }
  }

  const isLoading = schemeMode === 'mainline' ? mainlineQuery.isLoading : tempRoadsQuery.isLoading
  if (isLoading) {
    return (
      <section className="bg-white border border-border rounded-xl p-5 shadow-sm animate-pulse">
        <div className="h-6 w-64 bg-bg-surface rounded mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => <div key={i} className="h-44 bg-bg-surface rounded-lg" />)}
        </div>
      </section>
    )
  }

  const parsed = roads.map(road => ({
    road,
    ...(schemeMode === 'mainline' ? mainlineSchemeTitle(road) : parseTempRoadSchemeTitle(road)),
  }))
  const filtered = sectionFilter === 'all'
    ? parsed
    : parsed.filter(p => p.sections.includes(sectionFilter))
  const visibleRoads = filtered.map(item => ({
    ...item,
    road: schemeMode === 'temp_roads' ? roadForSection(item.road, sectionFilter) : item.road,
  }))
  const emptyMessage = schemeMode === 'mainline'
    ? 'Нет схем ОХ для выбранного участка.'
    : 'Нет АД для выбранного участка.'
  const subtitle = schemeMode === 'mainline'
    ? `${roads.length} участков ОХ · основной ход`
    : `${roads.length} АД · временные автодороги`

  return (
    <section className={`bg-white border border-border rounded-xl p-5 shadow-sm ${schemeMode === 'mainline' ? 'mainline-a3-print-root' : ''}`}>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Layers className="w-5 h-5 text-text-primary" strokeWidth={2} />
        <h2 className="text-base font-semibold text-gray-800 mb-2 font-heading tracking-wide uppercase">
          Структурные схемы земляного полотна
        </h2>
        <span className="text-xs text-text-muted">{subtitle}</span>

        <div className="ml-auto inline-flex rounded-md border border-border bg-bg-surface p-1 text-xs">
          <button
            type="button"
            onClick={() => { setSchemeMode('temp_roads'); setDetailRoad(null); setDetailObject(null); setExportError(null) }}
            className={`rounded px-3 py-1.5 font-semibold ${schemeMode === 'temp_roads' ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
          >
            АД
          </button>
          <button
            type="button"
            onClick={() => { setSchemeMode('mainline'); setDetailRoad(null); setDetailObject(null); setExportError(null) }}
            className={`rounded px-3 py-1.5 font-semibold ${schemeMode === 'mainline' ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
          >
            ОХ
          </button>
        </div>

        {schemeMode === 'mainline' && (
          <div className="no-print inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={downloadMainlinePdf}
              disabled={exportingPdf}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-text-primary transition hover:bg-bg-surface disabled:cursor-wait disabled:opacity-60"
              title="Сгенерировать PDF схем ОХ на сервере"
            >
              <FileDown className="h-3.5 w-3.5" strokeWidth={2} />
              {exportingPdf ? 'PDF...' : 'PDF'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1">
          <PillChip active={sectionFilter === 'all'} onClick={() => setSectionFilter('all')}>все</PillChip>
          {[1,2,3,4,5,6,7,8].map(n => (
            <PillChip key={n} active={sectionFilter === n} onClick={() => setSectionFilter(n)}>№{n}</PillChip>
          ))}
        </div>
      </div>

      <div className="mainline-status-legend flex flex-wrap items-center gap-4 mb-5 text-[11px]">
        {trackConfig.tracks.map(k => (
          <span key={k} className="flex items-center gap-1.5" title={trackConfig.help[k]}>
            <LegendSwatch k={k} config={trackConfig} />
            <span className="text-text-secondary">{trackConfig.label[k]}</span>
          </span>
        ))}
      </div>

      {schemeMode === 'mainline' && (
        <div className="mb-5 flex flex-wrap items-center gap-3 text-[11px]">
          {MAINLINE_OBJECT_LEGEND.map(typeCode => {
            const meta = MAINLINE_OBJECT_TYPE_META[typeCode]
            return (
              <span key={typeCode} className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-7 items-center justify-center rounded border border-border bg-white">
                  <svg viewBox="0 0 28 20" className="h-5 w-6" aria-hidden="true">
                    <MainlineObjectMarkerShape
                      row={{
                        object_id: typeCode,
                        object_type_code: typeCode,
                        object_group: typeCode === 'PILE_FIELD' ? 'pile_field' : typeCode === 'PIPE' ? 'pipe' : typeCode.startsWith('INTERSECTION') ? 'crossing' : 'isso',
                        pk_start: 0,
                        pk_end: 10,
                      }}
                      x={3}
                      y={2}
                      w={22}
                      h={16}
                      point={false}
                    />
                  </svg>
                </span>
                <span className="text-text-secondary">{meta.label}</span>
              </span>
            )
          })}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-sm text-text-muted py-8 text-center">{emptyMessage}</div>
      )}
      {schemeMode === 'mainline' && exportError && (
        <div className="no-print mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {exportError}
        </div>
      )}

      <div className="mainline-scheme-print-grid flex flex-col gap-5">
        {visibleRoads.map(({ road, title }) => (
          <TempRoadSchemeCard
            key={road.id}
            road={road}
            title={title}
            trackConfig={trackConfig}
            updated={updatedMap[road.code] ?? {}}
            onOpenDetails={schemeMode === 'mainline' ? () => setDetailRoad(road) : undefined}
            onOpenObjectDetails={schemeMode === 'mainline' ? setDetailObject : undefined}
          />
        ))}
      </div>

      {schemeMode === 'mainline' && detailObject && (
        <MainlineObjectDetailModal object={detailObject} onClose={() => setDetailObject(null)} />
      )}
      {schemeMode === 'mainline' && detailRoad && (
        <MainlineSchemeDetailModal road={detailRoad} to={to} onClose={() => setDetailRoad(null)} />
      )}
    </section>
  )
}

function LegendSwatch({ k, config }: { k: TrackKey; config: TrackConfig }) {
  if (k === 'no_work') {
    return (
      <span
        className="inline-block w-3.5 h-3 rounded-[2px] border border-[#6b7280]"
        style={{ background: 'repeating-linear-gradient(45deg, transparent 0 3px, #9ca3af 3px 4px)' }}
      />
    )
  }
  return (
    <span
      className="inline-block w-3.5 h-3 rounded-[2px]"
      style={{ background: config.fill[k], border: `1px solid ${config.stroke[k]}` }}
    />
  )
}

function PillChip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${
        active
          ? 'bg-slate-800 text-white'
          : 'bg-white text-gray-600 border border-gray-200 hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

interface PaintedSeg { track: TrackKey; absStart: number; absEnd: number; isDemo: boolean }

function StatTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 border-b border-border pb-1.5">
      <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 whitespace-nowrap font-mono text-[16px] font-semibold leading-tight text-text-primary">
        {value}{unit && <span className="ml-1 text-[12px] font-normal text-text-muted">{unit}</span>}
      </div>
    </div>
  )
}

function MainlineObjectMarkerShape({ row, x, y, w, h, point }: {
  row: MainlineRelatedObject
  x: number
  y: number
  w: number
  h: number
  point: boolean
}) {
  const meta = mainlineObjectTypeMeta(row)
  const cx = x + w / 2
  const symbolW = point ? Math.max(w, 9) : w
  const sx = point ? cx - symbolW / 2 : x

  if (meta.symbol === 'pile_field') {
    const topY = y + h * 0.28
    const midY = y + h * 0.50
    const bottomY = y + h * 0.72
    return (
      <g>
        <line x1={sx} y1={topY} x2={sx} y2={bottomY} stroke={meta.color} strokeWidth={1.1} />
        <line x1={sx + symbolW} y1={topY} x2={sx + symbolW} y2={bottomY} stroke={meta.color} strokeWidth={1.1} />
        <path d={`M${sx} ${topY}H${sx + symbolW * 0.30}M${sx + symbolW * 0.42} ${topY}H${sx + symbolW * 0.62}M${sx + symbolW * 0.74} ${topY}H${sx + symbolW}`} fill="none" stroke={meta.color} strokeWidth={1.0} />
        <line x1={sx} y1={midY} x2={sx + symbolW} y2={midY} stroke={meta.color} strokeWidth={1.1} />
        <path d={`M${sx} ${bottomY}H${sx + symbolW * 0.30}M${sx + symbolW * 0.42} ${bottomY}H${sx + symbolW * 0.62}M${sx + symbolW * 0.74} ${bottomY}H${sx + symbolW}`} fill="none" stroke={meta.color} strokeWidth={1.0} />
      </g>
    )
  }

  if (meta.symbol === 'bridge') {
    const y1 = y + h * 0.33
    const y2 = y + h * 0.67
    const skew = Math.min(symbolW * 0.12, 7)
    return (
      <g>
        <path d={`M${sx} ${y1}H${sx + symbolW}M${sx} ${y2}H${sx + symbolW}M${sx} ${y1}L${sx + skew} ${y1 - 5}M${sx + symbolW} ${y1}L${sx + symbolW - skew} ${y1 - 5}M${sx} ${y2}L${sx + skew} ${y2 + 5}M${sx + symbolW} ${y2}L${sx + symbolW - skew} ${y2 + 5}`} fill="none" stroke={meta.color} strokeWidth={1.4} strokeLinecap="square" />
      </g>
    )
  }

  if (meta.symbol === 'overpass') {
    const markW = Math.max(5, Math.min(9, symbolW))
    const lx = cx - markW / 2
    return (
      <g>
        <path d={`M${cx} ${y + 2}V${y + h - 2}M${lx} ${y + 6}L${cx} ${y + 2}L${lx + markW} ${y + 6}M${lx} ${y + h - 6}L${cx} ${y + h - 2}L${lx + markW} ${y + h - 6}`} fill="none" stroke={meta.color} strokeWidth={1.4} strokeLinecap="square" />
      </g>
    )
  }

  if (meta.symbol === 'pipe') {
    const markW = Math.max(4, Math.min(7, symbolW))
    const lx = cx - markW / 2
    return (
      <g>
        <path d={`M${cx} ${y + 2}V${y + h - 2}M${cx} ${y + 2}L${lx} ${y + 5}M${cx} ${y + 2}L${lx + markW} ${y + 5}M${cx} ${y + h - 2}L${lx} ${y + h - 5}M${cx} ${y + h - 2}L${lx + markW} ${y + h - 5}`} fill="none" stroke={meta.color} strokeWidth={1.4} strokeLinecap="square" />
      </g>
    )
  }

  if (meta.symbol === 'intersection_fin' || meta.symbol === 'intersection_prop') {
    const dash = meta.symbol === 'intersection_prop' ? '5 3' : undefined
    return (
      <g>
        <path d={`M${cx} ${y + 2}V${y + h * 0.34}M${cx} ${y + h * 0.66}V${y + h - 2}`} fill="none" stroke={meta.color} strokeWidth={1.4} strokeLinecap="square" strokeDasharray={dash} />
        <text x={cx} y={y + h * 0.50} fontSize={12} fontFamily="'JetBrains Mono', ui-monospace, monospace" fill={meta.color} stroke="#ffffff" strokeWidth={2.2} paintOrder="stroke" textAnchor="middle" dominantBaseline="middle">N</text>
      </g>
    )
  }

  return (
    <g>
      <rect x={sx} y={y + 4} width={symbolW} height={h - 8} rx={1.5} fill={meta.fill} stroke={meta.color} strokeWidth={1} />
    </g>
  )
}

function MainlineObjectOverlayShape({ row, x, y, w, h }: {
  row: MainlineRelatedObject
  x: number
  y: number
  w: number
  h: number
}) {
  const meta = mainlineObjectTypeMeta(row)
  const symbol = meta.symbol
  const cx = x + w / 2

  if (symbol === 'pile_field') {
    const topY = y + h * 0.28
    const midY = y + h * 0.50
    const bottomY = y + h * 0.72
    return (
      <g>
        <line x1={x} y1={topY} x2={x} y2={bottomY} stroke={meta.color} strokeWidth={1.35} />
        <line x1={x + w} y1={topY} x2={x + w} y2={bottomY} stroke={meta.color} strokeWidth={1.35} />
        <path d={`M${x} ${topY}H${x + w * 0.28}M${x + w * 0.38} ${topY}H${x + w * 0.62}M${x + w * 0.72} ${topY}H${x + w}`} fill="none" stroke={meta.color} strokeWidth={1.25} />
        <line x1={x} y1={midY} x2={x + w} y2={midY}
          stroke={meta.color} strokeWidth={1.35} />
        <path d={`M${x} ${bottomY}H${x + w * 0.28}M${x + w * 0.38} ${bottomY}H${x + w * 0.62}M${x + w * 0.72} ${bottomY}H${x + w}`} fill="none" stroke={meta.color} strokeWidth={1.25} />
      </g>
    )
  }

  if (symbol === 'bridge' || symbol === 'overpass') {
    if (symbol === 'overpass') {
      const markerW = Math.max(0.0001, Math.min(13, w))
      const lx = cx - markerW / 2
      const capY = Math.max(2, Math.min(3.5, h * 0.28))
      return (
        <g>
          <rect x={cx - markerW / 2} y={y + 1} width={markerW} height={Math.max(1, h - 2)} rx={Math.min(1.5, markerW / 2)} fill={meta.fill} stroke={meta.color} strokeWidth={0.7} opacity={0.62} />
          <path d={`M${cx} ${y + 0.5}V${y + h - 0.5}M${lx} ${y + capY}L${cx} ${y + 0.5}L${lx + markerW} ${y + capY}M${lx} ${y + h - capY}L${cx} ${y + h - 0.5}L${lx + markerW} ${y + h - capY}`}
            fill="none" stroke={meta.color} strokeWidth={1.5} strokeLinecap="square" />
        </g>
      )
    }
    const skew = Math.min(w * 0.12, 12)
    const topY = y + h * 0.32
    const bottomY = y + h * 0.68
    const whiskerY = Math.max(1.5, Math.min(3.5, h * 0.28))
    return (
      <g>
        <rect x={x} y={y + 1} width={w} height={Math.max(1, h - 2)} rx={1.5} fill="#ffffff" stroke={meta.color} strokeWidth={0.7} opacity={0.42} />
        <path d={`M${x} ${topY}H${x + w}M${x} ${bottomY}H${x + w}M${x} ${topY}L${x + skew} ${topY - whiskerY}M${x + w} ${topY}L${x + w - skew} ${topY - whiskerY}M${x} ${bottomY}L${x + skew} ${bottomY + whiskerY}M${x + w} ${bottomY}L${x + w - skew} ${bottomY + whiskerY}`}
          fill="none" stroke={meta.color} strokeWidth={1.5} strokeLinecap="square" />
      </g>
    )
  }

  if (symbol === 'pipe') {
    const lineW = Math.max(0.0001, Math.min(w, 9))
    const lx = cx - lineW / 2
    const capY = Math.max(2, Math.min(3.5, h * 0.28))
    return (
      <g>
        <ellipse cx={cx} cy={y + h / 2} rx={Math.max(0.00005, Math.min(4.2, lineW / 2))} ry={Math.max(2.5, h / 2 - 1)} fill={meta.fill} stroke={meta.color} strokeWidth={0.45} opacity={0.62} />
        <path d={`M${cx} ${y + 0.5}V${y + h - 0.5}M${cx} ${y + 0.5}L${lx} ${y + capY}M${cx} ${y + 0.5}L${lx + lineW} ${y + capY}M${cx} ${y + h - 0.5}L${lx} ${y + h - capY}M${cx} ${y + h - 0.5}L${lx + lineW} ${y + h - capY}`}
          fill="none" stroke={meta.color} strokeWidth={1.5} strokeLinecap="square" />
      </g>
    )
  }

  if (symbol === 'intersection_fin' || symbol === 'intersection_prop') {
    const localDash = symbol === 'intersection_prop' ? '6 4' : undefined
    const labelSize = Math.max(8, Math.min(12, h * 0.82))
    return (
      <g>
        <line x1={cx} y1={y} x2={cx} y2={y + h * 0.38}
          stroke={meta.color} strokeWidth={1.7} strokeDasharray={localDash} />
        <line x1={cx} y1={y + h * 0.62} x2={cx} y2={y + h}
          stroke={meta.color} strokeWidth={1.7} strokeDasharray={localDash} />
        <text x={cx} y={y + h * 0.50} fontSize={labelSize} fontFamily="'JetBrains Mono', ui-monospace, monospace" fill={meta.color} stroke="#ffffff" strokeWidth={2.0} paintOrder="stroke" textAnchor="middle" dominantBaseline="middle">N</text>
      </g>
    )
  }

  return (
    <rect x={x} y={y} width={w} height={h} rx={Math.min(2, w / 2)}
      fill={meta.fill} stroke={meta.color} strokeWidth={1.1} opacity={0.34} />
  )
}

export function TempRoadSchemeCard({ road, title, trackConfig = DEFAULT_TEMP_ROAD_TRACK_CONFIG, updated = {}, onOpenDetails, onOpenObjectDetails }: {
  road: TempRoadSchemeRoad
  title: string
  trackConfig?: TrackConfig
  updated?: Partial<Record<TrackKey, string>>
  onOpenDetails?: () => void
  onOpenObjectDetails?: (object: MainlineRelatedObject) => void
}) {
  // Ось: ВСЖМ если есть, иначе АД (напр. АД4 №8.1 без rail-мэппинга).
  const hasRail = road.rail_pk_start != null && road.rail_pk_end != null
  const axisStart = hasRail ? Math.min(road.rail_pk_start!, road.rail_pk_end!) : road.ad_pk_start
  const axisEnd   = hasRail ? Math.max(road.rail_pk_start!, road.rail_pk_end!) : road.ad_pk_end
  const span = Math.max(1, axisEnd - axisStart)
  const tracks = trackConfig.tracks
  const relatedObjects = trackConfig.mode === 'mainline' ? (road.related_objects || []) : []
  const showStructuralRows = trackConfig.mode === 'mainline'
  const adRoadStart = Math.min(road.ad_pk_start, road.ad_pk_end)
  const adRoadEnd = Math.max(road.ad_pk_start, road.ad_pk_end)
  const allowedAxisRanges = useMemo(
    () => normalizeAllowedRanges(road.axis_ranges, axisStart, axisEnd),
    [road.axis_ranges, axisStart, axisEnd],
  )
  const allowedAdRanges = useMemo(
    () => normalizeAllowedRanges(
      road.axis_label === 'ОХ' ? road.axis_ranges : undefined,
      adRoadStart,
      adRoadEnd,
    ),
    [road.axis_label, road.axis_ranges, adRoadStart, adRoadEnd],
  )
  const issoGapAxisRanges = useMemo(() => mergeRanges(
    relatedObjects
      .filter(isMainlineIssoGap)
      .flatMap(obj => {
        const start = Math.min(Number(obj.pk_start), Number(obj.pk_end))
        const end = Math.max(Number(obj.pk_start), Number(obj.pk_end))
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.01) return []
        return clampRange(start, end, axisStart, axisEnd) ? [clampRange(start, end, axisStart, axisEnd)!] : []
      }),
  ), [relatedObjects, axisStart, axisEnd])
  const earthworkAxisRanges = useMemo(
    () => showStructuralRows ? subtractRangeSet(allowedAxisRanges, issoGapAxisRanges) : allowedAxisRanges,
    [allowedAxisRanges, issoGapAxisRanges, showStructuralRows],
  )
  const earthworkAdRanges = useMemo(
    () => showStructuralRows ? subtractRangeSet(allowedAdRanges, issoGapAxisRanges) : allowedAdRanges,
    [allowedAdRanges, issoGapAxisRanges, showStructuralRows],
  )
  // Длина для статистики — сумма рабочих диапазонов; для ОХ это важно на участках с разрывом.
  const adSpan = Math.max(0, showStructuralRows ? rangeLength(earthworkAdRanges) : (road.length_m ?? Math.abs(road.ad_pk_end - road.ad_pk_start)))
  const lengthKm = adSpan / 1000

  // Сегменты: 5 известных статусов + производный «не в работе» из незакрытых диапазонов.
  // Позиционирование — в координатах оси (rail либо AD); длины в легенде — всегда в АД.
  const { painted, totals } = useMemo(() => {
    const totals = Object.fromEntries(trackConfig.tracks.map(key => [key, 0])) as Record<TrackKey, number>
    const out: PaintedSeg[] = []
    const coveredAxis: Range[] = []
    const coveredAd: Range[] = []
    for (const s of road.segments) {
      const t = toTrack(String(s.status_type), trackConfig)
      if (!t) continue
      const rawAxisRange = clampRange(s.pk_start, s.pk_end, axisStart, axisEnd)
      if (!rawAxisRange) continue
      const adRawA = s.ad_pk_start != null && s.ad_pk_end != null ? s.ad_pk_start : rawAxisRange[0]
      const adRawB = s.ad_pk_start != null && s.ad_pk_end != null ? s.ad_pk_end : rawAxisRange[1]
      const axisRanges = subtractRangeSet([rawAxisRange], showStructuralRows ? issoGapAxisRanges : [])
      for (const axisRange of axisRanges) {
        const adRange = clampRange(adRawA, adRawB, adRoadStart, adRoadEnd)
        if (!adRange) continue
        const clippedAdRange = clampRange(axisRange[0], axisRange[1], adRange[0], adRange[1]) || axisRange
        totals[t] = (totals[t] || 0) + clippedAdRange[1] - clippedAdRange[0]
        out.push({ track: t, absStart: axisRange[0], absEnd: axisRange[1], isDemo: !!s.is_demo })
        coveredAxis.push(axisRange)
        coveredAd.push(clippedAdRange)
      }
    }
    for (const [a, b] of subtractRangeSet(earthworkAxisRanges, coveredAxis)) {
      if (b - a < 0.01) continue
      out.push({ track: 'no_work', absStart: a, absEnd: b, isDemo: false })
    }
    for (const [a, b] of subtractRangeSet(earthworkAdRanges, coveredAd)) {
      if (b - a < 0.01) continue
      totals.no_work = (totals.no_work || 0) + b - a
    }
    return { painted: out, totals }
  }, [road, axisStart, axisEnd, trackConfig, adRoadStart, adRoadEnd, earthworkAxisRanges, earthworkAdRanges, issoGapAxisRanges, showStructuralRows])

  const lReady = trackConfig.completedKeys.reduce((sum, key) => sum + (totals[key] || 0), 0)
  const pctReady = adSpan > 0 ? (lReady / adSpan) * 100 : 0
  const ticks = useMemo(() => pkTicks(axisStart, axisEnd), [axisStart, axisEnd])

  // SVG-геометрия: ОХ показывает компактные строки "Ситуация / статусы / РД / ПК / даты".
  const VIEW_W = 1180, PAD_L = 128, PAD_R = 14
  const DRAW_W = VIEW_W - PAD_L - PAD_R
  const TRACK_H = 30, TRACK_GAP = 4
  const STRUCT_ROW_H = 18
  const SITUATION_ROW_H = showStructuralRows ? 64 : STRUCT_ROW_H
  const SITUATION_INSET = 3
  const STRUCT_ROW_GAP = 3
  const OBJECT_CALLOUT_LANES = showStructuralRows ? 2 : 0
  const OBJECT_CALLOUT_LANE_H = 23
  const OBJECT_CALLOUT_TOP_H = showStructuralRows ? OBJECT_CALLOUT_LANES * OBJECT_CALLOUT_LANE_H + 4 : 0
  const PK_CALLOUT_LANES = showStructuralRows ? 2 : 0
  const PK_CALLOUT_LANE_H = 12
  const PK_CALLOUT_H = showStructuralRows ? PK_CALLOUT_LANES * PK_CALLOUT_LANE_H + 3 : 0
  const SITUATION_Y0 = showStructuralRows ? OBJECT_CALLOUT_TOP_H + 18 : 24
  const TRACKS_Y0 = showStructuralRows ? SITUATION_Y0 + SITUATION_ROW_H + 6 : 24
  const TRACKS_H = tracks.length * TRACK_H + (tracks.length - 1) * TRACK_GAP
  const RD_ROW_Y = TRACKS_Y0 + TRACKS_H + 6
  const PK_ROW_Y = RD_ROW_Y + STRUCT_ROW_H + STRUCT_ROW_GAP
  const DATE_ROW_Y = PK_ROW_Y + STRUCT_ROW_H + STRUCT_ROW_GAP + PK_CALLOUT_H
  const AXIS_Y = showStructuralRows ? DATE_ROW_Y + STRUCT_ROW_H + 10 : TRACKS_Y0 + TRACKS_H + 8
  const BOTTOM_LABEL_Y = AXIS_Y + 38
  const VIEW_H = BOTTOM_LABEL_Y + 6

  const xOf = (pk100: number) => PAD_L + ((pk100 - axisStart) / span) * DRAW_W
  const trackY = (i: number) => TRACKS_Y0 + i * (TRACK_H + TRACK_GAP)
  const objectMarkers = useMemo(() => {
    const rawMarkers = relatedObjects.flatMap((obj, objectIndex) => {
      const sourceStart = Math.min(Number(obj.pk_start), Number(obj.pk_end))
      const sourceEnd = Math.max(Number(obj.pk_start), Number(obj.pk_end))
      if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) return []
      const point = sourceEnd - sourceStart < 0.01
      const visibleRanges: Range[] = point
        ? (allowedAxisRanges.some(([start, end]) => sourceStart >= start && sourceStart <= end) ? [[sourceStart, sourceStart]] : [])
        : _clipClientRange(sourceStart, sourceEnd, allowedAxisRanges)
      return visibleRanges.map(([start, end], rangeIndex) => {
        const xStart = xOf(start)
        const xEnd = xOf(end)
        const anchorX = Math.max(PAD_L, Math.min((xStart + xEnd) / 2, VIEW_W - PAD_R))
        return {
          key: `${obj.object_id}-${objectIndex}-${rangeIndex}`,
          obj,
          xStart,
          xEnd,
          anchorX,
          rangeStart: start,
          rangeEnd: end,
          point,
        }
      })
    })

    return rawMarkers.map(marker => {
      let visualW = Math.max(0.0001, marker.xEnd - marker.xStart)
      if (marker.point) {
        let nearestGap = Math.min(marker.anchorX - PAD_L, VIEW_W - PAD_R - marker.anchorX)
        for (const other of rawMarkers) {
          if (other.key === marker.key || rangesOverlap(marker.rangeStart, marker.rangeEnd, other.rangeStart, other.rangeEnd)) continue
          if (other.rangeEnd < marker.rangeStart) {
            nearestGap = Math.min(nearestGap, Math.max(0, marker.anchorX - other.xEnd))
          } else if (other.rangeStart > marker.rangeEnd) {
            nearestGap = Math.min(nearestGap, Math.max(0, other.xStart - marker.anchorX))
          }
        }
        visualW = Math.max(0.0001, Math.min(8, Number.isFinite(nearestGap) ? nearestGap * 0.72 : 8))
      }
      const visualX = marker.point ? marker.anchorX - visualW / 2 : marker.xStart
      const objectCode = String(marker.obj.object_type_code || '').trim().toUpperCase()
      const pointHitW = objectCode === 'PIPE' || objectCode === 'OVERPASS' ? 24 : (isCrossingObject(marker.obj) ? 20 : 18)
      const hitW = Math.min(DRAW_W, marker.point ? pointHitW : Math.max(10, visualW))
      const hitX = Math.max(PAD_L, Math.min(marker.anchorX - hitW / 2, VIEW_W - PAD_R - hitW))
      const y = SITUATION_Y0 + SITUATION_INSET
      return {
        ...marker,
        x: visualX,
        w: visualW,
        hitX,
        hitW,
        y,
        h: SITUATION_ROW_H - SITUATION_INSET * 2,
        hitY: SITUATION_Y0,
        hitH: SITUATION_ROW_H,
      }
    }).sort((a, b) => (
      Number(a.point) - Number(b.point)
      || mainlineObjectRenderPriority(a.obj) - mainlineObjectRenderPriority(b.obj)
      || a.anchorX - b.anchorX
    ))
  }, [relatedObjects, allowedAxisRanges, axisStart, axisEnd])
  const [hoverObjectIds, setHoverObjectIds] = useState<string[]>([])
  const hoverObjectIdSet = useMemo(() => new Set(hoverObjectIds), [hoverObjectIds])
  const [objectChoice, setObjectChoice] = useState<{
    x: number
    y: number
    objects: MainlineRelatedObject[]
  } | null>(null)
  const objectCallouts = useMemo(() => {
    if (!showStructuralRows || !hoverObjectIds.length) return []
    const seen = new Set<string>()
    const items = objectMarkers
      .filter(marker => hoverObjectIdSet.has(String(marker.obj.object_id)) && canShowMainlineObjectCallout(marker.obj))
      .filter(marker => {
        const id = String(marker.obj.object_id)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((marker, idx) => {
        const meta = mainlineObjectTypeMeta(marker.obj)
        const label = mainlineObjectCalloutLabel(marker.obj)
        const lines = wrapSvgCalloutLabel(label, 21, 2)
        return {
          key: `object-callout-${marker.obj.object_id}-${idx}`,
          label,
          lines,
          anchorX: marker.anchorX,
          anchorY: marker.y,
          color: meta.color,
          textColor: meta.text,
          height: lines.length > 1 ? 23 : 13,
        }
      })
    return layoutSvgCallouts(
      items,
      PAD_L,
      VIEW_W - PAD_R,
      18,
      OBJECT_CALLOUT_LANE_H,
      OBJECT_CALLOUT_LANES,
      8.5,
      132,
    )
  }, [hoverObjectIds.length, hoverObjectIdSet, objectMarkers, showStructuralRows])
  const pkRangeSegments = showStructuralRows ? (road.schedule_rows?.length ? road.schedule_rows : road.axis_ranges || []).flatMap((row, rowIndex) => (
    _clipClientRange(row.pk_start, row.pk_end, earthworkAxisRanges).map(([start, end], rangeIndex) => {
      const x = xOf(start)
      const w = Math.max(0.8, xOf(end) - x)
      return {
        key: `pk-label-${rowIndex}-${rangeIndex}`,
        start,
        end,
        x,
        w,
        label: formatPkRange(start, end),
      }
    })
  )) : []
  const pkCallouts = showStructuralRows ? layoutSvgCallouts(
    pkRangeSegments
      .filter(segment => segment.w <= 58)
      .map(segment => ({
        key: `pk-callout-${segment.key}`,
        label: segment.label,
        anchorX: segment.x + segment.w / 2,
        color: '#64748b',
        textColor: '#334155',
      })),
    PAD_L,
    VIEW_W - PAD_R,
    PK_ROW_Y + STRUCT_ROW_H + 4,
    PK_CALLOUT_LANE_H,
    PK_CALLOUT_LANES,
    8,
    132,
  ) : []
  const readinessSegments = useMemo(() => {
    if (!showStructuralRows) return [] as Array<{ start: number; end: number; color: string; label: string }>
    const workRanges = mergeRanges(painted.filter(p => p.track !== 'no_work').map(p => [p.absStart, p.absEnd] as Range))
    return (road.rd_documents || []).flatMap(doc => {
      const docRanges = _clipClientRange(doc.pk_start, doc.pk_end, earthworkAxisRanges)
      return docRanges.flatMap(([start, end]) => {
        const pileObjects = relatedObjects.filter(obj => (
          String(obj.object_group || '') === 'pile_field'
          && rangesOverlap(start, end, Number(obj.pk_start), Number(obj.pk_end))
        ))
        const pilesReady = pileObjects.length === 0 || pileObjects.every(obj => pileSummaryReady(obj.pile_summary))
        if (!pilesReady) return []
        const hasWork = rangeIntersectsRanges(start, end, workRanges)
        return [{
          start,
          end,
          color: hasWork ? '#facc15' : '#ef4444',
          label: hasWork ? 'РД + сваи готовы + работы идут' : 'РД + сваи готовы + работ нет',
        }]
      })
    })
  }, [earthworkAxisRanges, painted, relatedObjects, road.rd_documents, showStructuralRows])

  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{
    x: number; y: number; pk100: number; seg: PaintedSeg | null
  } | null>(null)

  function localSvgPoint(e: React.MouseEvent<SVGSVGElement>): { x: number; y: number; wrapX: number; wrapY: number } | null {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap) return null
    const rect = svg.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    const scale = rect.width / VIEW_W
    if (!scale) return null
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
      wrapX: e.clientX - wrapRect.left,
      wrapY: e.clientY - wrapRect.top,
    }
  }

  function objectCandidatesAt(localX: number, localY: number, includeNested = true) {
    if (!showStructuralRows || localY < SITUATION_Y0 || localY > SITUATION_Y0 + SITUATION_ROW_H) return []
    const structural = objectMarkers.filter(marker => isMainlineStructuralObject(marker.obj))
    const distanceToMarker = (marker: (typeof objectMarkers)[number]) => {
      if (marker.point) return Math.abs(localX - marker.anchorX)
      if (localX < marker.xStart) return marker.xStart - localX
      if (localX > marker.xEnd) return localX - marker.xEnd
      return 0
    }
    const direct = structural.filter(marker => localX >= marker.hitX && localX <= marker.hitX + marker.hitW)
    if (!direct.length) return []

    const pointCandidates = direct.filter(marker => marker.point && distanceToMarker(marker) <= 4)
    let seeds: typeof direct
    if (pointCandidates.length) {
      const nearestPoint = Math.min(...pointCandidates.map(distanceToMarker))
      seeds = pointCandidates.filter(marker => distanceToMarker(marker) <= nearestPoint + 0.6)
    } else {
      const exactRanges = direct.filter(marker => !marker.point && distanceToMarker(marker) <= 0.01)
      if (exactRanges.length) {
        seeds = exactRanges
      } else {
        const nearest = Math.min(...direct.map(distanceToMarker))
        seeds = direct.filter(marker => distanceToMarker(marker) <= nearest + 0.6)
      }
    }

    const sortCandidates = (a: (typeof objectMarkers)[number], b: (typeof objectMarkers)[number]) => (
      distanceToMarker(a) - distanceToMarker(b)
      || mainlineObjectRenderPriority(b.obj) - mainlineObjectRenderPriority(a.obj)
      || a.anchorX - b.anchorX
    )
    if (!includeNested) return [...seeds].sort(sortCandidates).slice(0, 1)

    const pkAtPointer = axisStart + ((localX - PAD_L) / DRAW_W) * span
    const seedKeys = new Set(seeds.map(marker => marker.key))
    const contextual = structural.filter(marker => {
      if (seedKeys.has(marker.key)) return false
      const atPointer = marker.point
        ? distanceToMarker(marker) <= 0.6
        : pkAtPointer >= marker.rangeStart - 0.01 && pkAtPointer <= marker.rangeEnd + 0.01
      return atPointer && seeds.some(seed => rangesOverlap(
        seed.rangeStart,
        seed.rangeEnd,
        marker.rangeStart,
        marker.rangeEnd,
      ))
    })
    const seedObjectIds = new Set(seeds.map(marker => String(marker.obj.object_id)))
    const unique = new Map<string, (typeof objectMarkers)[number]>()
    for (const marker of [...seeds, ...contextual]) {
      const id = String(marker.obj.object_id)
      if (!unique.has(id)) unique.set(id, marker)
    }
    return Array.from(unique.values())
      .sort((a, b) => (
        Number(!seedObjectIds.has(String(a.obj.object_id))) - Number(!seedObjectIds.has(String(b.obj.object_id)))
        || sortCandidates(a, b)
      ))
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const local = localSvgPoint(e)
    if (!local) return
    const localX = local.x
    const localY = local.y
    if (showStructuralRows && localY >= SITUATION_Y0 && localY <= SITUATION_Y0 + SITUATION_ROW_H) {
      const candidates = objectCandidatesAt(localX, localY, false)
      const nextIds = candidates.map(marker => String(marker.obj.object_id))
      setHoverObjectIds(previous => (
        previous.length === nextIds.length && previous.every((id, index) => id === nextIds[index]) ? previous : nextIds
      ))
      setHover(null)
      return
    }
    setHoverObjectIds([])
    if (localX < PAD_L || localX > VIEW_W - PAD_R) { setHover(null); return }
    if (localY < TRACKS_Y0 - 2 || localY > TRACKS_Y0 + TRACKS_H + 2) { setHover(null); return }
    const pk100 = axisStart + ((localX - PAD_L) / DRAW_W) * span
    const trackIdx = Math.min(
      tracks.length - 1,
      Math.max(0, Math.floor((localY - TRACKS_Y0) / (TRACK_H + TRACK_GAP))),
    )
    const track = tracks[trackIdx]
    const seg = painted.find(p => p.track === track && pk100 >= p.absStart && pk100 <= p.absEnd) ?? null
    setHover({
      x: local.wrapX,
      y: local.wrapY,
      pk100,
      seg,
    })
  }

  const topLeftLabel = hasRail ? formatPk(axisStart) : ''
  const topRightLabel = hasRail ? formatPk(axisEnd) : ''
  const bottomAxisLabel = road.axis_label || 'АД'
  const workTotals = road.work_totals || []
  const canOpenDetails = trackConfig.mode === 'mainline' && Boolean(onOpenDetails)

  function onDetailsKeyDown(e: React.KeyboardEvent<SVGSVGElement | HTMLButtonElement>) {
    if (!canOpenDetails) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenDetails?.()
    }
  }

  function onSvgClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!canOpenDetails) return
    const local = localSvgPoint(e)
    if (local && showStructuralRows && onOpenObjectDetails) {
      const candidates = objectCandidatesAt(local.x, local.y)
      if (candidates.length === 1) {
        setObjectChoice(null)
        onOpenObjectDetails(candidates[0].obj)
        return
      }
      if (candidates.length > 1) {
        setObjectChoice({
          x: Math.max(8, Math.min(local.wrapX, (wrapRef.current?.clientWidth || VIEW_W) - 220)),
          y: Math.max(8, local.wrapY - 4),
          objects: candidates.map(marker => marker.obj),
        })
        return
      }
    }
    setObjectChoice(null)
    onOpenDetails?.()
  }

  return (
    <div ref={wrapRef} className="relative border border-border rounded-lg p-4 bg-white">
      <div className="font-heading font-bold text-[14px] text-text-primary mb-2">
        {title} — {lengthKm.toFixed(2)} км
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        data-mainline-scheme-road={showStructuralRows ? road.code : undefined}
        className={`block select-none ${canOpenDetails ? 'cursor-pointer' : ''}`}
        onMouseMove={onMove}
        onMouseLeave={() => { setHover(null); setHoverObjectIds([]) }}
        onClick={onSvgClick}
        onKeyDown={onDetailsKeyDown}
        role={canOpenDetails ? 'button' : undefined}
        tabIndex={canOpenDetails ? 0 : undefined}
        aria-label={canOpenDetails ? `Открыть подробности ${title}` : undefined}
      >
        <defs>
          <pattern
            id={`hatch-${road.id}`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="#9ca3af" strokeWidth="1.2" />
          </pattern>
        </defs>

        {/* Верхние подписи ВСЖМ-ПК */}
        <text x={PAD_L} y={10} fontSize={14}
          fontFamily="'JetBrains Mono', ui-monospace, monospace"
          fill="#404040" textAnchor="start">{topLeftLabel}</text>
        {topRightLabel && (
          <text x={VIEW_W - PAD_R} y={10} fontSize={14}
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
            fill="#404040" textAnchor="end">{topRightLabel}</text>
        )}

        {/* Ситуация: объекты ОХ отдельной строкой поверх схемы */}
        {showStructuralRows && (
          <g>
            <text x={PAD_L - 8} y={SITUATION_Y0 + SITUATION_ROW_H / 2 + 4} fontSize={12}
              fontFamily="'Onest', system-ui, sans-serif" fill="#404040" textAnchor="end">
              Ситуация
            </text>
            {allowedAxisRanges.map(([start, end], idx) => (
              <rect key={`situation-bg-${idx}`} x={xOf(start)} y={SITUATION_Y0} width={Math.max(0.8, xOf(end) - xOf(start))} height={SITUATION_ROW_H}
                fill="#ffffff" stroke="#d1d5db" strokeWidth={0.6} />
            ))}
            {objectMarkers.map((marker, idx) => {
              const obj = marker.obj
              const typeMeta = mainlineObjectTypeMeta(obj)
              const isActiveObject = hoverObjectIdSet.has(String(obj.object_id)) || Boolean(objectChoice?.objects.some(item => item.object_id === obj.object_id))
              const title = [
                mainlineObjectFullName(obj),
                typeMeta.label || obj.object_group_label || 'Объект',
                formatPkRange(obj.pk_start, obj.pk_end),
                obj.required_start_date || obj.required_finish_date
                  ? `${formatDateLabel(obj.required_start_date)} - ${formatDateLabel(obj.required_finish_date)}`
                  : null,
              ].filter(Boolean).join(' · ')
              return (
                <g
                  key={`obj-situation-${marker.key}-${idx}`}
                  className={onOpenObjectDetails && isMainlineStructuralObject(obj) ? 'cursor-pointer' : undefined}
                  data-mainline-object-id={obj.object_id}
                  data-mainline-object-type={obj.object_type_code}
                  data-mainline-object-line="situation"
                  data-mainline-object-point={marker.point ? 'true' : 'false'}
                  data-mainline-object-range-start={marker.rangeStart.toFixed(3)}
                  data-mainline-object-range-end={marker.rangeEnd.toFixed(3)}
                  data-mainline-object-visual-x={marker.x.toFixed(5)}
                  data-mainline-object-visual-width={marker.w.toFixed(5)}
                  data-mainline-object-visual-y={marker.y.toFixed(3)}
                  data-mainline-object-visual-height={marker.h.toFixed(3)}
                >
                  <title>{title}</title>
                  {isActiveObject && (
                    <rect x={marker.x} y={marker.y - 1} width={marker.w} height={marker.h + 2}
                      rx={Math.min(2, marker.w / 2)} fill={typeMeta.fill} stroke={typeMeta.color} strokeWidth={1.2} opacity={0.72} pointerEvents="none" />
                  )}
                  <rect x={marker.hitX} y={marker.hitY} width={marker.hitW} height={marker.hitH}
                    fill="transparent" pointerEvents="all" />
                  <MainlineObjectOverlayShape row={obj} x={marker.x} y={marker.y} w={marker.w} h={marker.h} />
                </g>
              )
            })}
            {objectCallouts.map(callout => (
              <g key={callout.key} pointerEvents="none" data-mainline-object-callout={callout.key}>
                <path
                  d={`M${callout.anchorX} ${callout.anchorY ?? SITUATION_Y0}V${callout.y + callout.height}H${callout.x + callout.width / 2}`}
                  fill="none"
                  stroke={callout.color}
                  strokeWidth={0.7}
                  opacity={0.72}
                />
                <rect x={callout.x} y={callout.y} width={callout.width} height={callout.height}
                  rx={2} fill="#ffffff" stroke={callout.color} strokeWidth={0.7} />
                <text x={callout.x + callout.width / 2} y={callout.y + 8.5} fontSize={9}
                  fontFamily="'Onest', system-ui, sans-serif"
                  fill={callout.textColor || callout.color} textAnchor="middle">
                  {(callout.lines || [callout.label]).map((line, lineIndex) => (
                    <tspan key={`${callout.key}-line-${lineIndex}`} x={callout.x + callout.width / 2} dy={lineIndex === 0 ? 0 : 9.5}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            ))}
          </g>
        )}

        {/* Треки */}
        {tracks.map((k, i) => {
          const y = trackY(i)
          const fill = k === 'no_work' ? `url(#hatch-${road.id})` : trackConfig.fill[k]
          return (
            <g key={k}>
              <text x={PAD_L - 8} y={y + TRACK_H / 2 + 4} fontSize={14}
                fontFamily="'Onest', system-ui, sans-serif" fill="#404040" textAnchor="end">
                {trackConfig.label[k]}
              </text>
              {(showStructuralRows ? earthworkAxisRanges : allowedAxisRanges).map(([start, end], idx) => (
                <rect key={`track-bg-${k}-${idx}`} x={xOf(start)} y={y} width={Math.max(0.8, xOf(end) - xOf(start))} height={TRACK_H}
                  fill="white" stroke="#d1d5db" strokeWidth={0.6} />
              ))}
              {ticks.filter(t => t.labelled).map(t => (
                rangeIntersectsRanges(t.pk * 100, t.pk * 100, showStructuralRows ? earthworkAxisRanges : allowedAxisRanges) ? (
                  <line key={`g-${k}-${t.pk}`}
                    x1={xOf(t.pk * 100)} y1={y} x2={xOf(t.pk * 100)} y2={y + TRACK_H}
                    stroke="#e5e7eb" strokeWidth={0.5} strokeDasharray="2 2" />
                ) : null
              ))}
              {painted.filter(p => p.track === k).map((p, idx) => {
                const x = xOf(p.absStart)
                const w = Math.max(0.8, xOf(p.absEnd) - x)
                return (
                  <rect key={`s-${k}-${idx}`} x={x} y={y} width={w} height={TRACK_H}
                    fill={fill} stroke={trackConfig.stroke[k]} strokeWidth={0.8}
                    opacity={p.isDemo ? 0.75 : 1} />
                )
              })}
            </g>
          )
        })}

        {/* Выданная документация и готовность фронта работ только по сегментам ЗП */}
        {showStructuralRows && (
          <g>
            <text x={PAD_L - 8} y={RD_ROW_Y + STRUCT_ROW_H / 2 + 4} fontSize={12}
              fontFamily="'Onest', system-ui, sans-serif" fill="#404040" textAnchor="end">
              РД
            </text>
            {earthworkAxisRanges.map(([start, end], idx) => (
              <rect key={`rd-bg-${idx}`} x={xOf(start)} y={RD_ROW_Y} width={Math.max(0.8, xOf(end) - xOf(start))} height={STRUCT_ROW_H}
                fill="#ffffff" stroke="#d1d5db" strokeWidth={0.6} />
            ))}
            {(road.rd_documents || []).flatMap((doc, docIndex) => (
              _clipClientRange(doc.pk_start, doc.pk_end, earthworkAxisRanges).map(([start, end], rangeIndex) => {
                const x = xOf(start)
                const w = Math.max(0.8, xOf(end) - x)
                return (
                  <g key={`rd-${doc.id || docIndex}-${rangeIndex}`}>
                    <title>{[doc.rd_title || 'Выданная РД', formatPkRange(start, end), formatDateLabel(doc.issued_at)].join(' · ')}</title>
                    <rect x={x} y={RD_ROW_Y + 3} width={w} height={STRUCT_ROW_H - 6}
                      fill="#dcfce7" stroke="#15803d" strokeWidth={0.8} rx={1.5} />
                    {w > 42 && (
                      <text x={x + w / 2} y={RD_ROW_Y + STRUCT_ROW_H / 2 + 3} fontSize={8}
                        fontFamily="'Onest', system-ui, sans-serif" fill="#166534" textAnchor="middle">
                        {(doc.rd_title || 'РД выдана').slice(0, 24)}
                      </text>
                    )}
                  </g>
                )
              })
            ))}
            {readinessSegments.map((segment, idx) => {
              const x = xOf(segment.start)
              const w = Math.max(0.8, xOf(segment.end) - x)
              return (
                <g key={`ready-${idx}`}>
                  <title>{`${segment.label} · ${formatPkRange(segment.start, segment.end)}`}</title>
                  <rect x={x} y={RD_ROW_Y + 3} width={w} height={STRUCT_ROW_H - 6}
                    fill={segment.color} stroke={segment.color} strokeWidth={0.6} rx={1.5} opacity={0.72} />
                </g>
              )
            })}
          </g>
        )}

        {showStructuralRows && (
          <g>
            <text x={PAD_L - 8} y={PK_ROW_Y + STRUCT_ROW_H / 2 + 4} fontSize={12}
              fontFamily="'Onest', system-ui, sans-serif" fill="#404040" textAnchor="end">
              ПК
            </text>
            {earthworkAxisRanges.map(([start, end], idx) => (
              <rect key={`pk-row-${idx}`} x={xOf(start)} y={PK_ROW_Y} width={Math.max(0.8, xOf(end) - xOf(start))} height={STRUCT_ROW_H}
                fill="#ffffff" stroke="#d1d5db" strokeWidth={0.6} />
            ))}
            {pkRangeSegments.map(segment => (
              <g key={segment.key}>
                <rect x={segment.x} y={PK_ROW_Y + 3} width={segment.w} height={STRUCT_ROW_H - 6}
                  fill="#f8fafc" stroke="#64748b" strokeWidth={0.6} rx={1.5} />
                {segment.w > 58 && (
                  <text x={segment.x + segment.w / 2} y={PK_ROW_Y + STRUCT_ROW_H / 2 + 3} fontSize={9}
                    fontFamily="'JetBrains Mono', ui-monospace, monospace" fill="#334155" textAnchor="middle">
                    {segment.label}
                  </text>
                )}
              </g>
            ))}
            {pkCallouts.map(callout => (
              <g key={callout.key} pointerEvents="none">
                <path
                  d={`M${callout.anchorX} ${PK_ROW_Y + STRUCT_ROW_H}V${callout.y}H${callout.x + callout.width / 2}`}
                  fill="none"
                  stroke={callout.color}
                  strokeWidth={0.6}
                  opacity={0.7}
                />
                <rect x={callout.x} y={callout.y} width={callout.width} height={10}
                  rx={2} fill="#ffffff" stroke={callout.color} strokeWidth={0.6} />
                <text x={callout.x + callout.width / 2} y={callout.y + 7.5} fontSize={8}
                  fontFamily="'JetBrains Mono', ui-monospace, monospace" fill={callout.textColor || callout.color} textAnchor="middle">
                  {callout.label}
                </text>
              </g>
            ))}

            <text x={PAD_L - 8} y={DATE_ROW_Y + STRUCT_ROW_H / 2 + 4} fontSize={12}
              fontFamily="'Onest', system-ui, sans-serif" fill="#404040" textAnchor="end">
              Даты
            </text>
            {earthworkAxisRanges.map(([start, end], idx) => (
              <rect key={`date-row-bg-${idx}`} x={xOf(start)} y={DATE_ROW_Y} width={Math.max(0.8, xOf(end) - xOf(start))} height={STRUCT_ROW_H}
                fill="#ffffff" stroke="#d1d5db" strokeWidth={0.6} />
            ))}
            {(road.schedule_rows || []).flatMap((row, rowIndex) => (
              _clipClientRange(row.pk_start, row.pk_end, earthworkAxisRanges).map(([start, end], rangeIndex) => {
                const x = xOf(start)
                const w = Math.max(0.8, xOf(end) - x)
                const label = `${formatDateLabel(row.required_start_date)}-${formatDateLabel(row.required_finish_date)}`
                return (
                  <g key={`date-row-${row.id || rowIndex}-${rangeIndex}`}>
                    <title>{[row.schedule_label || 'Даты работ', formatPkRange(start, end), label].join(' · ')}</title>
                    <rect x={x} y={DATE_ROW_Y + 3} width={w} height={STRUCT_ROW_H - 6}
                      fill="#ede9fe" stroke="#7c3aed" strokeWidth={0.6} rx={1.5} />
                    {w > 54 && (
                      <text x={x + w / 2} y={DATE_ROW_Y + STRUCT_ROW_H / 2 + 3} fontSize={9}
                        fontFamily="'JetBrains Mono', ui-monospace, monospace" fill="#5b21b6" textAnchor="middle">
                        {label}
                      </text>
                    )}
                  </g>
                )
              })
            ))}
          </g>
        )}

        {/* Ось ПК */}
        <line x1={PAD_L} y1={AXIS_Y} x2={VIEW_W - PAD_R} y2={AXIS_Y}
          stroke="#9ca3af" strokeWidth={0.6} />
        {ticks.map(t => {
          const x = xOf(t.pk * 100)
          return (
            <g key={`t-${t.pk}`}>
              <line x1={x} y1={AXIS_Y} x2={x} y2={AXIS_Y + (t.labelled ? 5 : 3)}
                stroke="#9ca3af" strokeWidth={0.6} />
              {t.labelled && (
                <text x={x} y={AXIS_Y + 17} fontSize={11}
                  fontFamily="'JetBrains Mono', ui-monospace, monospace"
                  fill="#6b7280" textAnchor="middle">ПК{t.pk}</text>
              )}
            </g>
          )
        })}

        {/* Нижние подписи АД-ПК */}
        <text x={PAD_L} y={BOTTOM_LABEL_Y} fontSize={14}
          fontFamily="'JetBrains Mono', ui-monospace, monospace"
          fill="#404040" textAnchor="start">{bottomAxisLabel} {formatPk(road.ad_pk_start)}</text>
        <text x={VIEW_W - PAD_R} y={BOTTOM_LABEL_Y} fontSize={14}
          fontFamily="'JetBrains Mono', ui-monospace, monospace"
          fill="#404040" textAnchor="end">{bottomAxisLabel} {formatPk(road.ad_pk_end)}</text>
      </svg>

      {objectChoice && (
        <div
          className="absolute z-50 w-[220px] overflow-hidden rounded-md border border-border bg-white shadow-xl"
          style={{ left: objectChoice.x, top: objectChoice.y }}
          data-mainline-object-choice="true"
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          {objectChoice.objects.map(object => (
            <button
              key={object.object_id}
              type="button"
              className="flex w-full items-start gap-2 border-b border-border px-2.5 py-2 text-left text-xs last:border-0 hover:bg-bg-surface"
              data-mainline-object-choice-id={object.object_id}
              onClick={() => {
                setObjectChoice(null)
                onOpenObjectDetails?.(object)
              }}
            >
              <MainlineObjectGroupBadge row={object} />
              <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold text-text-primary">{mainlineObjectShortLabel(object)}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-text-muted">{formatPkRange(object.pk_start, object.pk_end)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Статистика */}
      <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-4">
        <StatTile label="L готово" value={formatMeters(lReady)} unit="м" />
        <StatTile label="% готово" value={pctReady.toFixed(1)} unit="%" />
        {trackConfig.mode === 'mainline' && workTotals.map(item => (
          <StatTile key={item.key} label={item.label} value={formatVolume(item.volume_m3)} unit="м³" />
        ))}
      </div>

      {/* Легенда с длинами */}
      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {tracks.map(k => {
          const content = (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <LegendSwatch k={k} config={trackConfig} />
                  <span className="truncate text-[11px] font-semibold text-text-primary">{trackConfig.label[k]}</span>
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-text-primary">{formatMeters(totals[k] || 0)} м</span>
              </div>
              <div className="mt-1 text-[10px] leading-snug text-text-muted">{trackConfig.help[k]}</div>
            </>
          )
          return canOpenDetails ? (
            <button
              key={k}
              type="button"
              onClick={onOpenDetails}
              onKeyDown={onDetailsKeyDown}
              className="min-h-[72px] rounded-md border border-border bg-white px-2.5 py-2 text-left transition hover:border-text-muted hover:bg-bg-surface"
              title={trackConfig.help[k]}
            >
              {content}
            </button>
          ) : (
            <span
              key={k}
              className="min-h-[72px] rounded-md border border-border bg-white px-2.5 py-2 text-left"
              title={trackConfig.help[k]}
            >
              {content}
            </span>
          )
        })}
      </div>

      {/* Кастомный тултип */}
      {hover && hover.seg && (
        <div
          className="absolute z-40 pointer-events-none -translate-x-1/2 -translate-y-full px-2 py-1.5 bg-[#1a1a1a] text-white rounded-md shadow-xl text-[10px] leading-snug whitespace-nowrap"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          <div className="font-mono font-semibold">{formatPk(hover.pk100)}</div>
          <div className="text-neutral-300">{trackConfig.label[hover.seg.track]}</div>
          {(() => {
            const key = hover.seg.track
            const ud = updated[key]
            if (ud) return <div className="text-neutral-400">обновлено {ud}</div>
            if (road.effective_date) return <div className="text-neutral-400">обновлено {road.effective_date}</div>
            return null
          })()}
        </div>
      )}
    </div>
  )
}

function MainlineObjectGroupBadge({ row }: { row: MainlineRelatedObject }) {
  const meta = mainlineObjectTypeMeta(row)
  return (
    <span
      className="inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: meta.fill, borderColor: meta.color, color: meta.text }}
    >
      {meta.label}
    </span>
  )
}

function MainlineObjectDetailModal({ object, onClose }: {
  object: MainlineRelatedObject
  onClose: () => void
}) {
  const meta = mainlineObjectTypeMeta(object)
  const summary = object.pile_summary
  const plannedMain = Number(summary?.planned_main || 0)
  const plannedTrial = Number(summary?.planned_trial || 0)
  const drivenMain = Number(summary?.driven_main || 0)
  const drivenTrial = Number(summary?.driven_trial || 0)
  const scheduleRows = object.schedule_rows || []
  const firstSchedule = scheduleRows[0]
  const objectCode = String(object.object_type_code || '').toUpperCase()
  const showPileStats = isPileFieldObject(object) || objectCode === 'PIPE'
  const showCommunications = !isPileFieldObject(object) && (isCrossingObject(object) || objectCode === 'PIPE')
  const objectComment = mainlineObjectHumanComment(object.object_comment)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-3"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-heading text-base font-bold text-text-primary">{mainlineObjectFullName(object)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <MainlineObjectGroupBadge row={object} />
              <span className="font-mono">{formatPkRange(object.pk_start, object.pk_end)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted hover:bg-bg-surface hover:text-text-primary"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4">
          {showPileStats && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <StatTile label="Основные сваи" value={`${formatCount(drivenMain)} / ${formatCount(plannedMain)}`} unit="забито / всего" />
              <StatTile label="Пробные сваи" value={`${formatCount(drivenTrial)} / ${formatCount(plannedTrial)}`} unit="забито / всего" />
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 text-xs md:grid-cols-2">
            <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Тип объекта</div>
              <div className="mt-1 text-text-primary">{meta.label || object.object_type_name || '—'}</div>
            </div>
            <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">ПК начала / ПК конца</div>
              <div className="mt-1 font-mono text-text-primary">{formatPkRange(object.pk_start, object.pk_end)}</div>
            </div>
            {showPileStats && (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Марка свай</div>
                <div className="mt-1 font-mono text-text-primary">{summary?.pile_mark || '—'}</div>
              </div>
            )}
            {isPileFieldObject(object) && (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Свайное поле объявлено</div>
                <div className="mt-1 font-mono text-text-primary">{formatDateLabel(summary?.available_from)}</div>
              </div>
            )}
            {showCommunications && (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Коммуникации</div>
                <div className="mt-1 text-text-primary">{object.communications || object.object_name || '—'}</div>
              </div>
            )}
          </div>

          {objectComment && (
            <div className="mt-3 rounded-md border border-border px-3 py-2 text-xs text-text-secondary">
              {objectComment}
            </div>
          )}

          <section className="mt-4">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-text-muted">Сроки производства работ</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-xs">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Начало производства работ</div>
                <div className="mt-1 font-mono text-text-primary">{formatDateLabel(firstSchedule?.required_start_date || object.required_start_date)}</div>
              </div>
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-xs">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Окончание производства работ</div>
                <div className="mt-1 font-mono text-text-primary">{formatDateLabel(firstSchedule?.required_finish_date || object.required_finish_date)}</div>
              </div>
            </div>
            {scheduleRows.length > 1 && (
              <div className="mt-3 overflow-hidden rounded-md border border-border">
                {scheduleRows.slice(1).map(row => (
                  <div key={row.id} className="border-b border-border px-3 py-2 text-xs last:border-0">
                    <div className="font-mono text-[11px] text-text-secondary">{formatPkRange(row.pk_start, row.pk_end)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-secondary">
                      {formatDateLabel(row.required_start_date)} — {formatDateLabel(row.required_finish_date)}
                    </div>
                    {row.comment && <div className="mt-0.5 text-[11px] text-text-muted">{row.comment}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function MainlineSchemeDetailModal({ road, to, onClose }: {
  road: TempRoadSchemeRoad
  to: string
  onClose: () => void
}) {
  const detailQuery = useQuery<MainlineSectionDetail>({
    queryKey: ['wip', 'mainline-fill', 'section-details', road.code, to],
    queryFn: async () => {
      const res = await fetch(`/api/wip/mainline-fill/sections/${encodeURIComponent(road.code)}/details?to=${encodeURIComponent(to)}`)
      if (!res.ok) throw new Error('Не удалось загрузить подробности участка ОХ')
      return res.json()
    },
    enabled: Boolean(road.code),
    staleTime: TEMP_ROADS_STALE_MS,
    gcTime: TEMP_ROADS_GC_MS,
    refetchOnWindowFocus: false,
  })
  const data = detailQuery.data
  const workTotals = data?.work_totals?.length ? data.work_totals : (road.work_totals || [])
  const projectTotals = data?.project_totals || []
  const projectTotalsByKey = useMemo(() => new Map(projectTotals.map(item => [item.key, item])), [projectTotals])
  const rdDocuments = data?.rd_documents?.length ? data.rd_documents : (road.rd_documents || [])
  const scheduleRows = data?.schedule_rows?.length ? data.schedule_rows : (road.schedule_rows || [])
  const detailTitle = mainlineSchemeTitle(road).title
  const detailRanges = normalizeAllowedRanges(data?.ranges?.length ? data.ranges : road.axis_ranges, road.ad_pk_start, road.ad_pk_end)
  const issuedRdRanges = rdDocuments.flatMap(doc => _clipClientRange(doc.pk_start, doc.pk_end, detailRanges))
  const rdCoverageRows: Array<{
    key: string
    pk_start: number
    pk_end: number
    hasRd: boolean
    rdCode: string
    issuedAt?: string | null
  }> = [
    ...rdDocuments.flatMap((doc, docIndex) => (
      _clipClientRange(doc.pk_start, doc.pk_end, detailRanges).map(([start, end], rangeIndex) => ({
        key: `rd-issued-${doc.id || docIndex}-${rangeIndex}`,
        pk_start: start,
        pk_end: end,
        hasRd: true,
        rdCode: doc.rd_code || doc.rd_title || 'РД выдана',
        issuedAt: doc.issued_at,
      }))
    )),
    ...subtractRangeSet(detailRanges, issuedRdRanges).map(([start, end], index) => ({
      key: `rd-missing-${index}`,
      pk_start: start,
      pk_end: end,
      hasRd: false,
      rdCode: '—',
      issuedAt: null,
    })),
  ].sort((a, b) => a.pk_start - b.pk_start)

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-heading text-base font-bold text-text-primary">{road.name || detailTitle}</div>
            <div className="mt-1 text-xs text-text-muted">
              {formatPkRanges(data?.ranges?.length ? data.ranges : road.axis_ranges, road.ad_pk_start, road.ad_pk_end)} · срез на {formatDateLabel(data?.as_of || to)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted hover:bg-bg-surface hover:text-text-primary"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-5">
            {workTotals.map(item => {
              const project = projectTotalsByKey.get(item.key)?.volume_m3 ?? 0
              return (
                <div key={item.key} className="min-w-0 border-b border-border pb-1.5">
                  <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-muted">{item.label}</div>
                  <div className="mt-0.5 font-mono text-[15px] font-semibold leading-tight text-text-primary">{formatVolume(item.volume_m3)} <span className="text-[11px] font-normal text-text-muted">м³ факт</span></div>
                  <div className="mt-0.5 font-mono text-[11px] leading-tight text-text-secondary">{formatVolume(project)} м³ проект</div>
                </div>
              )
            })}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="overflow-hidden rounded-md border border-border">
              <div className="bg-bg-surface px-3 py-2 text-xs font-bold uppercase tracking-wide text-text-muted">Сроки выполнения работ на участке</div>
              {scheduleRows.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-muted">Плановые сроки по сегментам не загружены.</div>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {scheduleRows.slice(0, 12).map(row => (
                    <div key={row.id} className="border-t border-border px-3 py-2 text-xs">
                      <div className="font-mono text-[11px] font-semibold text-text-primary">{formatPkRange(row.pk_start, row.pk_end)}</div>
                      <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[11px] text-text-secondary">
                        <span>{formatDateLabel(row.required_start_date)}</span>
                        <span>{formatDateLabel(row.required_finish_date)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">Направление: {mainlineScheduleDirection(row)}</div>
                      {row.schedule_label && <div className="mt-0.5 text-[11px] text-text-muted">{row.schedule_label}</div>}
                    </div>
                  ))}
                  {scheduleRows.length > 12 && (
                    <div className="border-t border-border px-3 py-2 text-[11px] text-text-muted">Показаны первые 12 строк из {scheduleRows.length}.</div>
                  )}
                </div>
              )}
            </section>
            <section className="overflow-hidden rounded-md border border-border">
              <div className="bg-bg-surface px-3 py-2 text-xs font-bold uppercase tracking-wide text-text-muted">Сегменты РД</div>
              {rdCoverageRows.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-muted">Сегменты РД по участку не найдены.</div>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {rdCoverageRows.slice(0, 14).map(row => (
                    <div key={row.key} className="border-t border-border px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-[11px] font-semibold text-text-primary">{formatPkRange(row.pk_start, row.pk_end)}</span>
                        <span className={row.hasRd ? 'text-green-700' : 'text-accent-red'}>{row.hasRd ? 'РД есть' : 'РД нет'}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-secondary">Шифр РД: {row.rdCode}</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">Дата выхода: {formatDateLabel(row.issuedAt)}</div>
                    </div>
                  ))}
                  {rdCoverageRows.length > 14 && (
                    <div className="border-t border-border px-3 py-2 text-[11px] text-text-muted">Показаны первые 14 строк из {rdCoverageRows.length}.</div>
                  )}
                </div>
              )}
            </section>
          </div>

          {detailQuery.isLoading && (
            <div className="py-8 text-center text-sm text-text-muted">Загрузка...</div>
          )}
          {detailQuery.isError && (
            <div className="py-8 text-center text-sm text-accent-red">Не удалось загрузить подробности участка ОХ.</div>
          )}

          {data && (
            <section className="mt-5 min-w-0">
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-text-muted">Работы на сегменте</h3>
                {data.work_days.length === 0 ? (
                  <div className="rounded-md border border-border px-3 py-4 text-sm text-text-muted">Нет объемов по участку.</div>
                ) : (
                  <div className="max-h-[56vh] space-y-3 overflow-y-auto pr-1">
                    {data.work_days.map(day => (
                      <div key={day.date} className="overflow-hidden rounded-md border border-border">
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-bg-surface px-3 py-2">
                          <span className="font-mono text-xs font-bold text-text-primary">{formatDateLabel(day.date)}</span>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                            {day.totals.filter(item => Number(item.volume_m3 || 0) !== 0).map(item => (
                              <span key={item.key}>{item.label}: <span className="font-mono text-text-primary">{formatVolume(item.volume_m3)}</span> м³</span>
                            ))}
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[760px] text-left text-xs">
                            <thead className="bg-white text-[10px] uppercase tracking-wide text-text-muted">
                              <tr>
                                <th className="px-3 py-2 font-semibold">Работа</th>
                                <th className="px-3 py-2 font-semibold">Объект</th>
                                <th className="px-3 py-2 font-semibold">Смена</th>
                                <th className="px-3 py-2 text-right font-semibold">м³</th>
                                <th className="px-3 py-2 font-semibold">ПК</th>
                              </tr>
                            </thead>
                            <tbody>
                              {day.rows.map((row, index) => (
                                <tr key={`${day.date}:${index}:${row.metric_key}:${row.volume_m3}`} className="border-t border-border">
                                  <td className="px-3 py-2 align-top">
                                    <div className="font-semibold text-text-primary">{row.label}</div>
                                    <div className="mt-0.5 text-[11px] text-text-muted">{row.work_type_name || row.analytics_tag || '—'}</div>
                                  </td>
                                  <td className="px-3 py-2 align-top text-text-secondary">
                                    {row.object_name || '—'}
                                  </td>
                                  <td className="px-3 py-2 align-top text-text-secondary">{shiftLabel(row.shift)}</td>
                                  <td className="px-3 py-2 text-right align-top font-mono font-semibold text-text-primary">{formatVolume(row.volume_m3)}</td>
                                  <td className="px-3 py-2 align-top font-mono text-[11px] text-text-secondary">{formatPkRange(row.pk_start, row.pk_end)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
