import { useMemo, useState, useCallback } from 'react'
import { Polyline, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Picket, MapObject, PileField, ObjectTypeKey } from '../../types/geo'
import {
  getLatLngByPicketage,
  getTangentAngle,
  getPerpendicularEnds,
  formatPicketage,
  offsetPolylineLatLngs,
} from '../../utils/geometry'
import { ObjectInfoPopup } from './ObjectInfoPopup'

type LatLng = [number, number]

interface ObjectsLayerProps {
  pickets: Picket[]
  objects: MapObject[]
  pileFields: PileField[]
  zoom: number
  enabledObjectTypes: Set<ObjectTypeKey>
  /** Дата для запросов детальной информации (popup). YYYY-MM-DD. */
  infoDateISO?: string
}

function typeToDbCode(t: string): string {
  const m: Record<string, string> = {
    pipe: 'PIPE', overpass: 'OVERPASS', bridge: 'BRIDGE',
    intersection_fin: 'INTERSECTION_FIN', intersection_prop: 'INTERSECTION_PROP',
    stockpile: 'STOCKPILE', borrow_pit: 'BORROW_PIT',
  }
  return m[t] || t.toUpperCase()
}

// ---------------------------------------------------------------------------
// SVG templates for PERPENDICULAR objects (fixed pixel size, zoom-independent)
// ---------------------------------------------------------------------------

/** Culvert: compact perpendicular pipe sign. Default orientation is vertical;
 * rotating by the track tangent keeps it perpendicular to the route axis. */
function svgPipe(color: string, sw: number = 2): string {
  return `<svg width="18" height="42" viewBox="0 0 18 42" xmlns="http://www.w3.org/2000/svg">
    <rect x="5" y="3" width="8" height="36" rx="2" fill="#fff7ed" stroke="${color}" stroke-width="${sw}"/>
    <line x1="3" y1="10" x2="15" y2="10" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <line x1="3" y1="32" x2="15" y2="32" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <line x1="9" y1="8" x2="9" y2="34" stroke="#1a1a1a" stroke-width="1.2" stroke-linecap="square"/>
  </svg>`
}

/** Overpass: perpendicular road deck, distinct from culvert. */
function svgOverpass(color: string, sw: number = 2): string {
  return `<svg width="22" height="46" viewBox="0 0 22 46" xmlns="http://www.w3.org/2000/svg">
    <line x1="7" y1="3" x2="7" y2="43" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <line x1="15" y1="3" x2="15" y2="43" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <line x1="3" y1="9" x2="19" y2="9" stroke="#1a1a1a" stroke-width="1.4" stroke-linecap="square"/>
    <line x1="3" y1="23" x2="19" y2="23" stroke="#1a1a1a" stroke-width="1.4" stroke-linecap="square"/>
    <line x1="3" y1="37" x2="19" y2="37" stroke="#1a1a1a" stroke-width="1.4" stroke-linecap="square"/>
    <path d="M7 3h8M7 43h8" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
  </svg>`
}

/** Intersection: perpendicular crossing sign; dashed for proposed crossings. */
function svgIntersection(color: string, sw: number, dashed: boolean): string {
  const dash = dashed ? ' stroke-dasharray="5 4"' : ''
  return `<svg width="22" height="46" viewBox="0 0 22 46" xmlns="http://www.w3.org/2000/svg">
    <line x1="11" y1="2" x2="11" y2="44" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"${dash}/>
    <line x1="4" y1="12" x2="18" y2="12" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <line x1="4" y1="34" x2="18" y2="34" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>
    <rect x="7" y="19" width="8" height="8" fill="#ffffff" stroke="${color}" stroke-width="1.5"/>
  </svg>`
}

/** Stockpile: mound/terricon marker. */
function svgStockpile(color: string, sw: number = 2): string {
  return `<svg width="38" height="32" viewBox="0 0 38 32" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 27h32" stroke="#422006" stroke-width="2" stroke-linecap="round"/>
    <path d="M5 26.5c3.2-7.2 7.1-10.8 11.5-10.8s7.2 3.8 9 10.8H5z" fill="#fef3c7" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>
    <path d="M16 26.5c2.3-10.8 5.7-16.2 10.4-16.2 4.2 0 7 5.4 8.6 16.2H16z" fill="#fde68a" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>
    <path d="M19 18.5h8.5M14 22.5h16" stroke="#92400e" stroke-width="1.3" stroke-linecap="round" opacity=".8"/>
    <circle cx="27" cy="8" r="2.2" fill="${color}"/>
  </svg>`
}

/** Borrow pit/quarry: stepped earth cut marker. */
function svgBorrowPit(color: string, sw: number = 2): string {
  return `<svg width="38" height="32" viewBox="0 0 38 32" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 8h30l-4 6h-7l-4 6h-7l-5 7H2z" fill="#ffedd5" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>
    <path d="M8 14h15M11 20h13M6 27h25" stroke="#9a3412" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M28 7l4-4M31 7l4-4" stroke="${color}" stroke-width="1.7" stroke-linecap="round"/>
  </svg>`
}

function makeIcon(svg: string, w: number, h: number, angleDeg: number, active: boolean): L.DivIcon {
  const hitW = Math.max(w + 24, 44)
  const hitH = Math.max(h + 24, 54)
  const ring = active
    ? `filter:drop-shadow(0 0 6px #dc2626) drop-shadow(0 0 10px #dc2626);`
    : ''
  return L.divIcon({
    className: active ? 'vsm-obj-active' : '',
    html: `<div style="position:relative;width:${hitW}px;height:${hitH}px;pointer-events:auto;cursor:pointer;">
      <div style="position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;transform:translate(-50%,-50%) rotate(${angleDeg}deg);${ring}">
        ${svg}
      </div>
    </div>`,
    iconSize: [hitW, hitH],
    iconAnchor: [hitW / 2, hitH / 2],
  })
}

function iconHitSize(w: number, h: number): { hitW: number; hitH: number } {
  return { hitW: Math.max(w + 24, 44), hitH: Math.max(h + 24, 54) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPk(pk: number): string { return formatPicketage(pk) }
function fmtPkRange(s: number | null, e: number | null): string {
  if (s == null) return 'координаты заданы вручную'
  return e != null && e !== s ? `${fmtPk(s)} — ${fmtPk(e)}` : fmtPk(s)
}

/** Build axis polyline points between two PKs */
function buildAxisPoints(pickets: Picket[], pkStart: number, pkEnd: number): LatLng[] {
  const pts: LatLng[] = []
  const lo = Math.min(pkStart, pkEnd)
  const hi = Math.max(pkStart, pkEnd)
  const s = getLatLngByPicketage(pickets, lo)
  if (s) pts.push(s as LatLng)
  for (let pk = Math.ceil(lo); pk <= Math.floor(hi); pk++) {
    if (Math.abs(pk - lo) < 0.001 || Math.abs(pk - hi) < 0.001) continue
    const p = getLatLngByPicketage(pickets, pk)
    if (p) pts.push(p as LatLng)
  }
  const e = getLatLngByPicketage(pickets, hi)
  if (e) pts.push(e as LatLng)
  return pts
}

/** Cross-axis offset in degrees for a given pixel width at current zoom */
function crossOffsetDeg(zoom: number, px: number): number {
  const degPerPx = 360 / (256 * Math.pow(2, zoom)) / 0.53
  return px * degPerPx
}

function mapTypeCode(t: string): string {
  const m: Record<string, string> = {
    PIPE: 'pipe', OVERPASS: 'overpass', BRIDGE: 'bridge',
    INTERSECTION_FIN: 'intersection_fin', INTERSECTION_PROP: 'intersection_prop',
    STOCKPILE: 'stockpile', BORROW_PIT: 'borrow_pit',
  }
  return m[t] || t.toLowerCase()
}

function typeToFilter(t: string): ObjectTypeKey | null {
  const valid: ObjectTypeKey[] = ['pipe', 'overpass', 'bridge', 'intersection_fin', 'intersection_prop', 'stockpile', 'borrow_pit']
  return valid.includes(t as ObjectTypeKey) ? t as ObjectTypeKey : null
}

function typeLabel(t: string): string {
  const labels: Record<string, string> = {
    pipe: 'Труба',
    overpass: 'Путепровод',
    intersection_fin: 'Пересечение, фин.',
    intersection_prop: 'Пересечение, имущ.',
    bridge: 'Мост',
    stockpile: 'Накопитель',
    borrow_pit: 'Карьер',
  }
  return labels[mapTypeCode(t)] ?? t
}

interface ObjectChoice {
  key: string
  obj: MapObject
  title: string
  subtitle: string
}

interface PerpendicularMarker {
  key: string
  obj: MapObject
  pos: LatLng
  icon: L.DivIcon
  hitW: number
  hitH: number
}

function objectChoice(key: string, obj: MapObject): ObjectChoice {
  return {
    key,
    obj,
    title: obj.name || typeLabel(obj.type),
    subtitle: `${typeLabel(obj.type)} · ${fmtPkRange(obj.pk_start, obj.pk_end)}`,
  }
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  const pad = 6
  return Math.abs(a.x - b.x) * 2 <= a.w + b.w + pad * 2
    && Math.abs(a.y - b.y) * 2 <= a.h + b.h + pad * 2
}

function ObjectChooserPopup({
  choices,
  detailKey,
  dateISO,
  onChoose,
  onBack,
}: {
  choices: ObjectChoice[]
  detailKey: string | null
  dateISO: string
  onChoose: (key: string) => void
  onBack: () => void
}) {
  const selectedChoice = detailKey ? choices.find(c => c.key === detailKey) : null
  if (choices.length > 1 && !selectedChoice) {
    return (
      <div style={{ minWidth: 360, maxWidth: 520, fontSize: 13 }}>
        <strong>Выберите объект</strong>
        <div style={{ color: '#666', fontSize: 12, marginTop: 3, marginBottom: 8 }}>
          В этой точке перекрываются {choices.length} обозначения.
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {choices.map(choice => (
            <button
              key={choice.key}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onChoose(choice.key)
              }}
              style={{
                appearance: 'none',
                border: '1px solid #e5e7eb',
                background: '#fff',
                borderRadius: 6,
                padding: '7px 8px',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{choice.title}</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>{choice.subtitle}</div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const choice = selectedChoice ?? choices[0]
  return (
    <div>
      {choices.length > 1 && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onBack()
          }}
          style={{
            appearance: 'none',
            border: 0,
            background: 'transparent',
            color: '#991b1b',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            padding: '0 0 6px',
          }}
        >
          ← к списку объектов
        </button>
      )}
      <ObjectInfoPopup
        id={String(choice.obj.id)}
        type={typeToDbCode(choice.obj.type)}
        dateISO={dateISO}
        fallbackTitle={choice.obj.name}
        fallbackSubtitle={fmtPkRange(choice.obj.pk_start, choice.obj.pk_end)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ObjectsLayer({ pickets, objects, pileFields, zoom, enabledObjectTypes, infoDateISO }: ObjectsLayerProps) {
  const map = useMap()
  // `selected` tracks which object's popup is currently open, so we can apply
  // a red glow/ring to it. Leaflet popup onClose clears it.
  const [selected, setSelected] = useState<string | null>(null)
  const [popupDetailKey, setPopupDetailKey] = useState<string | null>(null)
  const handleClick = useCallback((id: string) => {
    setSelected(id)
    setPopupDetailKey(null)
  }, [])
  const handleClose = useCallback((id: string) => {
    setSelected((p) => (p === id ? null : p))
    setPopupDetailKey(null)
  }, [])
  const today = new Date().toISOString().slice(0, 10)
  const dateISO = infoDateISO ?? today

  // Cross-axis offset for along-axis objects (bridges, pile fields)
  const offset = useMemo(() => crossOffsetDeg(zoom, 2), [zoom])
  const whiskerOff = useMemo(() => crossOffsetDeg(zoom, 3), [zoom])

  // ═══════════════════════════════════════════════════════════════════════
  // PERPENDICULAR objects: pipe, overpass, intersection → DivIcon Marker
  // ═══════════════════════════════════════════════════════════════════════
  const perpMarkers = useMemo(() => {
    if (!pickets.length) return []
    return objects.map(obj => {
      const tc = mapTypeCode(obj.type)
      const fk = typeToFilter(tc)
      if (fk && !enabledObjectTypes.has(fk)) return null
      if (tc === 'bridge') return null // handled separately

      let svg: string, w: number, h: number
      const scale = zoom >= 18 ? 1.15 : 1
      if (tc === 'pipe') { svg = svgPipe('#f97316', 2); w = 18; h = 42 }
      else if (tc === 'overpass') { svg = svgOverpass('#1d4ed8', 2); w = 22; h = 46 }
      else if (tc === 'intersection_fin') { svg = svgIntersection('#16a34a', 2, false); w = 22; h = 46 }
      else if (tc === 'intersection_prop') { svg = svgIntersection('#c026d3', 2, true); w = 22; h = 46 }
      else if (tc === 'stockpile') { svg = svgStockpile('#a16207', 2); w = 38; h = 32 }
      else if (tc === 'borrow_pit') { svg = svgBorrowPit('#7c2d12', 2); w = 38; h = 32 }
      else return null
      w = Math.round(w * scale)
      h = Math.round(h * scale)

      const minZoom = tc === 'borrow_pit' ? 9 : tc === 'stockpile' ? 11 : 13
      if (zoom < minZoom) return null // hide dense project signs at low zoom

      const explicitPos = obj.latitude != null && obj.longitude != null
        ? [obj.latitude, obj.longitude] as LatLng
        : null
      const pk = obj.pk_start == null
        ? null
        : obj.pk_end != null
          ? (obj.pk_start + obj.pk_end) / 2
          : obj.pk_start
      const pos = explicitPos ?? (pk != null ? getLatLngByPicketage(pickets, pk) : null)
      if (!pos) return null
      const tang = pk != null ? getTangentAngle(pickets, pk) : 0
      // Perpendicular: SVG line is vertical, axis goes horizontal → rotate by tangent
      const deg = (tc === 'stockpile' || tc === 'borrow_pit') ? 0 : tang * 180 / Math.PI
      const key = `perp-${obj.id}`
      const { hitW, hitH } = iconHitSize(w, h)
      return { key, obj, pos: pos as LatLng, icon: makeIcon(svg, w, h, deg, selected === key), hitW, hitH }
    }).filter(Boolean) as PerpendicularMarker[]
  }, [objects, pickets, zoom, enabledObjectTypes, selected])

  const overlapChoicesByKey = useMemo(() => {
    const out = new Map<string, ObjectChoice[]>()
    if (perpMarkers.length <= 1) {
      for (const marker of perpMarkers) out.set(marker.key, [objectChoice(marker.key, marker.obj)])
      return out
    }

    const projected = perpMarkers.map(marker => {
      const point = map.latLngToLayerPoint(L.latLng(marker.pos[0], marker.pos[1]))
      return {
        marker,
        rect: { x: point.x, y: point.y, w: marker.hitW, h: marker.hitH },
      }
    })
    const parent = projected.map((_, index) => index)
    const find = (index: number): number => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]]
        index = parent[index]
      }
      return index
    }
    const join = (a: number, b: number) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[rb] = ra
    }

    for (let i = 0; i < projected.length; i++) {
      for (let j = i + 1; j < projected.length; j++) {
        if (overlap(projected[i].rect, projected[j].rect)) join(i, j)
      }
    }

    const groups = new Map<number, ObjectChoice[]>()
    projected.forEach(({ marker }, index) => {
      const root = find(index)
      const choice = objectChoice(marker.key, marker.obj)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root)!.push(choice)
    })
    for (const group of groups.values()) {
      group.sort((a, b) =>
        (a.obj.pk_start ?? 0) - (b.obj.pk_start ?? 0)
        || typeLabel(a.obj.type).localeCompare(typeLabel(b.obj.type), 'ru')
        || a.title.localeCompare(b.title, 'ru'))
      for (const choice of group) out.set(choice.key, group)
    }
    return out
  }, [perpMarkers, map])

  // ═══════════════════════════════════════════════════════════════════════
  // BRIDGES — two offset polylines along axis + whiskers at ends
  // ═══════════════════════════════════════════════════════════════════════
  const bridgeData = useMemo(() => {
    if (!enabledObjectTypes.has('bridge') || !pickets.length) return []
    return objects.filter(o => mapTypeCode(o.type) === 'bridge' && o.pk_start != null && o.pk_end != null && o.pk_end !== o.pk_start)
      .map(obj => {
        if (obj.pk_start == null || obj.pk_end == null) return null
        const axis = buildAxisPoints(pickets, obj.pk_start, obj.pk_end)
        if (axis.length < 2) return null
        const upper = offsetPolylineLatLngs(axis, offset)
        const lower = offsetPolylineLatLngs(axis, -offset)
        // Bridge whiskers at both ends (outward at 45°)
        const startEnds = getPerpendicularEnds(pickets, obj.pk_start, whiskerOff)
        const endEnds = getPerpendicularEnds(pickets, obj.pk_end, whiskerOff)
        const whiskers: LatLng[][] = []
        if (startEnds) {
          whiskers.push([upper[0], startEnds[0] as LatLng])
          whiskers.push([lower[0], startEnds[1] as LatLng])
        }
        if (endEnds) {
          whiskers.push([upper[upper.length - 1], endEnds[0] as LatLng])
          whiskers.push([lower[lower.length - 1], endEnds[1] as LatLng])
        }
        return { obj, upper, lower, whiskers, key: `br-${obj.id}` }
      }).filter(Boolean) as {
        obj: MapObject; upper: LatLng[]; lower: LatLng[]; whiskers: LatLng[][]; key: string
      }[]
  }, [objects, pickets, offset, whiskerOff, enabledObjectTypes])

  // ═══════════════════════════════════════════════════════════════════════
  // PILE FIELDS — rectangle along axis (upper+lower+caps) + 2 cross lines
  // ═══════════════════════════════════════════════════════════════════════
  const pileData = useMemo(() => {
    if (!enabledObjectTypes.has('pile_field') || !pickets.length) return []
    return pileFields.map(pf => {
      const axis = buildAxisPoints(pickets, pf.pk_start, pf.pk_end)
      if (axis.length < 2) return null
      // Outer rectangle: 2 parallel lines along axis (top + bottom edges)
      const upper = offsetPolylineLatLngs(axis, offset)
      const lower = offsetPolylineLatLngs(axis, -offset)
      // Two inner dividers parallel to axis (above and below center):
      // Places them at 1/3 and 2/3 of cross-axis height
      const innerUpper = offsetPolylineLatLngs(axis, offset / 3)
      const innerLower = offsetPolylineLatLngs(axis, -offset / 3)
      // End caps (perpendicular to axis, connecting top edge to bottom edge)
      const startCap = getPerpendicularEnds(pickets, pf.pk_start, offset)
      const endCap = getPerpendicularEnds(pickets, pf.pk_end, offset)
      return { pf, upper, lower, innerUpper, innerLower, startCap, endCap, key: `pf-${pf.id}` }
    }).filter(Boolean) as {
      pf: PileField; upper: LatLng[]; lower: LatLng[]; innerUpper: LatLng[]; innerLower: LatLng[]
      startCap: LatLng[] | null; endCap: LatLng[] | null; key: string
    }[]
  }, [pileFields, pickets, offset, enabledObjectTypes])

  return (
    <>
      {/* ── Perpendicular objects (pipe, overpass, intersection) ── */}
      {perpMarkers.map(({ key, obj, pos, icon }) => (
        <Marker
          key={key}
          position={pos}
          icon={icon}
          eventHandlers={{
            click: () => handleClick(key),
            popupclose: () => handleClose(key),
          }}
        >
          <Popup minWidth={420} maxWidth={680}>
            <ObjectChooserPopup
              choices={overlapChoicesByKey.get(key) ?? [objectChoice(key, obj)]}
              detailKey={popupDetailKey}
              dateISO={dateISO}
              onChoose={(choiceKey) => {
                setSelected(choiceKey)
                setPopupDetailKey(choiceKey)
              }}
              onBack={() => setPopupDetailKey(null)}
            />
          </Popup>
        </Marker>
      ))}

      {/* ── Bridges ── */}
      {bridgeData.map(({ obj, upper, lower, whiskers, key }) => {
        const isActive = selected === key
        const lineColor = isActive ? '#dc2626' : '#000'
        const lineWeight = isActive ? 2.5 : 1.5
        return (
          <span key={key}>
            <Polyline positions={upper} pathOptions={{ color: lineColor, weight: lineWeight }} interactive={false} />
            <Polyline positions={lower} pathOptions={{ color: lineColor, weight: lineWeight }} interactive={false} />
            {whiskers.map((w, i) => (
              <Polyline key={`${key}-w${i}`} positions={w} pathOptions={{ color: lineColor, weight: isActive ? 2 : 1.2 }} interactive={false} />
            ))}
            {/* Invisible hit area */}
            <Polyline positions={upper} pathOptions={{ color: '#000', weight: 24, opacity: 0 }}
              eventHandlers={{
                click: () => handleClick(key),
                popupclose: () => handleClose(key),
              }}>
              <Popup minWidth={420} maxWidth={680}>
                <ObjectInfoPopup
                  id={String(obj.id)}
                  type={typeToDbCode(obj.type)}
                  dateISO={dateISO}
                  fallbackTitle={obj.name}
                  fallbackSubtitle={`Мост · ${fmtPkRange(obj.pk_start, obj.pk_end)}`}
                />
              </Popup>
            </Polyline>
          </span>
        )
      })}

      {/* ── Pile fields ── */}
      {pileData.map(({ pf, upper, lower, innerUpper, innerLower, startCap, endCap, key }) => {
        const isActive = selected === key
        const lineColor = isActive ? '#dc2626' : '#007fff'
        const outerWeight = isActive ? 2.5 : 1.2
        const innerWeight = isActive ? 2 : 1
        return (
          <span key={key}>
            {/* Outer rectangle: top + bottom + caps */}
            <Polyline positions={upper} pathOptions={{ color: lineColor, weight: outerWeight }} interactive={false} />
            <Polyline positions={lower} pathOptions={{ color: lineColor, weight: outerWeight }} interactive={false} />
            {startCap && <Polyline positions={startCap} pathOptions={{ color: lineColor, weight: outerWeight }} interactive={false} />}
            {endCap && <Polyline positions={endCap} pathOptions={{ color: lineColor, weight: outerWeight }} interactive={false} />}
            {/* Two inner parallel dividers along axis (above + below center) */}
            <Polyline positions={innerUpper} pathOptions={{ color: lineColor, weight: innerWeight }} interactive={false} />
            <Polyline positions={innerLower} pathOptions={{ color: lineColor, weight: innerWeight }} interactive={false} />
            {/* Hit area */}
            <Polyline positions={upper} pathOptions={{ color: '#007fff', weight: 24, opacity: 0 }}
              eventHandlers={{
                click: () => handleClick(key),
                popupclose: () => handleClose(key),
              }}>
              <Popup minWidth={420} maxWidth={680}>
                <ObjectInfoPopup
                  id={String(pf.id)}
                  type="pile_field"
                  dateISO={dateISO}
                  fallbackTitle={pf.name || 'Свайное поле'}
                  fallbackSubtitle={fmtPkRange(pf.pk_start, pf.pk_end)}
                />
              </Popup>
            </Polyline>
          </span>
        )
      })}
    </>
  )
}
