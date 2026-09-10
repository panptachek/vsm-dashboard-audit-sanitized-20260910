import { useMemo } from 'react'
import { Marker, Polyline } from 'react-leaflet'
import L from 'leaflet'
import type { Picket, LatLng } from '../../types/geo'
import {
  getPerpendicularEnds,
  getLatLngByPicketage,
  getTangentAngle,
  getMarkHalfLenDeg,
  getScaleByZoom,
} from '../../utils/geometry'

interface PicketMarkersProps {
  pickets: Picket[]
  zoom: number
  /** Highlight pickets in these PK ranges (yellow marks) */
  highlightRanges?: [number, number][]
}

interface MarkData {
  pk: number
  ends: [LatLng, LatLng]
  center: LatLng
  isKm: boolean
  highlighted: boolean
}

// ---------------------------------------------------------------------------
// Offset a point perpendicular to the route, choosing "below" on screen
// (i.e., the side with smaller latitude = lower on the map in web Mercator)
// ---------------------------------------------------------------------------

function offsetPointBelow(
  pickets: Picket[],
  pk: number,
  offsetDeg: number,
): LatLng | null {
  const center = getLatLngByPicketage(pickets, pk)
  if (!center) return null
  const angle = getTangentAngle(pickets, pk)
  const perp = angle + Math.PI / 2
  const cosLat = Math.cos((center[0] * Math.PI) / 180)

  // Compute both candidate points
  const dLng = Math.cos(perp) * offsetDeg / cosLat
  const dLat = -Math.sin(perp) * offsetDeg

  const ptA: LatLng = [center[0] + dLat, center[1] + dLng]
  const ptB: LatLng = [center[0] - dLat, center[1] - dLng]

  // "Below" on screen in Leaflet = smaller latitude (south)
  // Pick the point with smaller latitude
  return ptA[0] < ptB[0] ? ptA : ptB
}

// ---------------------------------------------------------------------------
// Build a one-sided tick below the axis (from axis outward on one side)
// ---------------------------------------------------------------------------

function getOneSidedTickEnds(
  pickets: Picket[],
  pkNumber: number,
  tickLen: number,
): [LatLng, LatLng] | null {
  const onAxis = getLatLngByPicketage(pickets, pkNumber)
  if (!onAxis) return null
  const offAxis = offsetPointBelow(pickets, pkNumber, tickLen)
  if (!offAxis) return null
  return [onAxis, offAxis]
}

// ---------------------------------------------------------------------------
// DivIcon factory for kilometer posts
// ---------------------------------------------------------------------------

/**
 * Build a kilometer-post icon.
 *
 * The red/white half-circle must have its **dividing diameter perpendicular
 * to the track axis** at the marker point. `axisAngleDeg` is the angle of
 * the axis tangent in screen-space degrees (0 = east, 90 = south in Leaflet's
 * screen coords). The linear-gradient line inside a CSS box runs at 180deg
 * (top→bottom) by default; we rotate the gradient by `axisAngleDeg` so the
 * split line follows the axis direction, leaving the two halves on opposite
 * sides of the axis — i.e. the diameter is perpendicular to the axis.
 */
function makeKmIcon(pkNum: number, scale: number, axisAngleDeg: number): L.DivIcon {
  // Красно-белый значок с внутренней диагональю, перпендикулярной касательной
  // к оси трассы + ножка-leader в 2 диаметра до точки присоединения на оси.
  const diameter = Math.round(14 * scale)
  const fontSize = Math.round(11 * scale)
  const leaderPx = diameter * 2            // длина ножки = 2 диаметра
  // Нормаль к оси в экранных координатах: axis + 90° (смещение вниз-справа от оси).
  // Ось в скринспейсе: 0° = восток, +90° = юг (y инвертирован у Leaflet).
  const normalRad = (axisAngleDeg + 90) * Math.PI / 180
  const dx = leaderPx * Math.cos(normalRad)
  const dy = leaderPx * Math.sin(normalRad)
  // Строим icon как контейнер, внутри которого в (0,0) — точка присоединения
  // (lat/lng), а сам круг смещён на (dx, dy).
  // Чтобы красно-белая диагональ круга была ⟂ оси, крутим сам div.
  const CANVAS = Math.max(32, leaderPx + diameter + 32)  // bounding box
  const cx = CANVAS / 2
  const cy = CANVAS / 2
  return L.divIcon({
    className: '',
    html: `<svg width="${CANVAS}" height="${CANVAS}" style="overflow:visible;pointer-events:none;position:relative">
      <!-- leader line: from origin (axis attachment) to circle center -->
      <line x1="${cx}" y1="${cy}" x2="${cx + dx}" y2="${cy + dy}"
            stroke="#ff0000" stroke-width="${Math.max(1, Math.round(1.3 * scale))}" />
      <!-- red/white circle: rotated so diameter ⟂ axis -->
      <g transform="translate(${cx + dx} ${cy + dy}) rotate(${axisAngleDeg})">
        <circle r="${diameter / 2}" fill="#ffffff" stroke="#ff0000" stroke-width="1"/>
        <path d="M 0 ${-diameter / 2} A ${diameter / 2} ${diameter / 2} 0 0 1 0 ${diameter / 2} Z" fill="#ff0000"/>
      </g>
      <!-- pk label under circle -->
      <text x="${cx + dx}" y="${cy + dy + diameter / 2 + fontSize + 2}"
            text-anchor="middle"
            font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="600" fill="#ff0000">${pkNum}</text>
    </svg>`,
    iconSize: [CANVAS, CANVAS],
    iconAnchor: [cx, cy],   // точка (cx,cy) на карте = точка присоединения к оси
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Kilometer posts shown as red/white half-circle markers + PK label,
 * positioned BELOW the axis with a dashed leader line (#999, 1px).
 * Visibility by zoom level:
 *   zoom < 9    : km posts every 20 PK
 *   zoom >= 9   : km posts every 10 PK
 *   zoom < 13   : no tick marks
 *   zoom 13-14  : tick marks every 5 PK (no labels)
 *   zoom >= 15  : tick marks every 1 PK (no labels), ticks below axis
 */
export function PicketMarkers({ pickets, zoom, highlightRanges }: PicketMarkersProps) {
  const halfLen = useMemo(() => getMarkHalfLenDeg(zoom), [zoom])
  const scale = useMemo(() => getScaleByZoom(zoom), [zoom])

  // Km post step: every 20 PK at zoom < 9, every 10 PK at zoom >= 9
  const kmStep = zoom < 9 ? 20 : 10

  // Offset for positioning km labels along the normal to the axis (in degrees).
  // Leader line length ≈ 2× the diameter of the km circle icon.
  const kmBelowOffset = halfLen * 3.5

  const marks = useMemo<MarkData[]>(() => {
    if (!pickets || pickets.length < 2) return []

    const isHighlighted = (pk: number) => {
      if (!highlightRanges) return false
      return highlightRanges.some(([s, e]) => pk >= s && pk <= e)
    }

    let tickStep: number | null
    if (zoom >= 15) {
      tickStep = 1
    } else if (zoom >= 13) {
      tickStep = 5
    } else {
      tickStep = null
    }

    const result: MarkData[] = []
    const minPk = Math.ceil(pickets[0].pk_number)
    const maxPk = Math.floor(pickets[pickets.length - 1].pk_number)

    // Add km posts at kmStep interval
    const kmStart = Math.ceil(minPk / kmStep) * kmStep
    for (let pkNum = kmStart; pkNum <= maxPk; pkNum += kmStep) {
      const ends = getPerpendicularEnds(pickets, pkNum, halfLen)
      if (!ends) continue
      const center: LatLng = [
        (ends[0][0] + ends[1][0]) / 2,
        (ends[0][1] + ends[1][1]) / 2,
      ]
      result.push({
        pk: pkNum,
        ends,
        center,
        isKm: true,
        highlighted: isHighlighted(pkNum),
      })
    }

    // Add tick marks if visible at this zoom
    if (tickStep != null) {
      const tickStart = Math.ceil(minPk / tickStep) * tickStep
      for (let pkNum = tickStart; pkNum <= maxPk; pkNum += tickStep) {
        if (pkNum % kmStep === 0) continue
        if (zoom >= 15) {
          const tickEnds = getOneSidedTickEnds(pickets, pkNum, halfLen * 0.7)
          if (!tickEnds) continue
          const center: LatLng = [
            (tickEnds[0][0] + tickEnds[1][0]) / 2,
            (tickEnds[0][1] + tickEnds[1][1]) / 2,
          ]
          result.push({
            pk: pkNum,
            ends: tickEnds,
            center,
            isKm: false,
            highlighted: isHighlighted(pkNum),
          })
        } else {
          const ends = getPerpendicularEnds(pickets, pkNum, halfLen)
          if (!ends) continue
          const center: LatLng = [
            (ends[0][0] + ends[1][0]) / 2,
            (ends[0][1] + ends[1][1]) / 2,
          ]
          result.push({
            pk: pkNum,
            ends,
            center,
            isKm: false,
            highlighted: isHighlighted(pkNum),
          })
        }
      }
    }

    return result
  }, [pickets, halfLen, highlightRanges, zoom, kmStep])

  // Split into km posts and tick marks
  const kmPosts = useMemo(() => marks.filter((m) => m.isKm), [marks])
  const ticks = useMemo(() => marks.filter((m) => !m.isKm), [marks])

  // Km post leader lines: from axis to below-axis position
  const kmLeaderLines = useMemo(() => {
    return kmPosts.map((km) => {
      const axisPos = getLatLngByPicketage(pickets, km.pk)
      const belowPos = offsetPointBelow(pickets, km.pk, kmBelowOffset)
      if (!axisPos || !belowPos) return null
      return { pk: km.pk, line: [axisPos, belowPos] as [LatLng, LatLng], belowPos }
    }).filter(Boolean) as { pk: number; line: [LatLng, LatLng]; belowPos: LatLng }[]
  }, [kmPosts, pickets, kmBelowOffset])

  // Km post icons — orient red/white split perpendicular to the axis.
  // getTangentAngle returns radians in screen-space convention
  // (0 = east, +pi/2 = south since y is inverted). Convert to degrees for CSS.
  const kmIcons = useMemo(() => {
    const icons = new Map<number, L.DivIcon>()
    for (const km of kmPosts) {
      const axisRad = getTangentAngle(pickets, km.pk)
      const axisDeg = (axisRad * 180) / Math.PI
      icons.set(km.pk, makeKmIcon(km.pk, scale, axisDeg))
    }
    return icons
  }, [kmPosts, pickets, scale])

  // Tick weight
  const tickWeight5 = Math.max(1, Math.round(1.5 * scale))
  const tickWeight1 = Math.max(1, Math.round(1 * scale))

  return (
    <>
      {/* Tick marks (non-km, no labels) */}
      {ticks.map((mark) => {
        const is5pk = mark.pk % 5 === 0
        return (
          <Polyline
            key={`tick-${mark.pk}`}
            positions={mark.ends}
            pathOptions={{
              color: mark.highlighted ? '#FFEB3B' : '#ef4444',
              weight: is5pk ? tickWeight5 : tickWeight1,
              opacity: 0.7,
            }}
            interactive={false}
          />
        )
      })}

      {/* Kilometer posts: tick line on axis + leader line + DivIcon marker below */}
      {kmPosts.map((mark) => {
        const leader = kmLeaderLines.find((l) => l.pk === mark.pk)
        return (
          <span key={`km-${mark.pk}`}>
            {/* Tick on axis */}
            <Polyline
              positions={mark.ends}
              pathOptions={{
                color: mark.highlighted ? '#FFEB3B' : '#ef4444',
                weight: mark.highlighted ? Math.max(3, Math.round(3 * scale)) : Math.max(2, Math.round(2 * scale)),
                opacity: 0.9,
              }}
              interactive={false}
            />
            {/* DivIcon-SVG сам рисует ножку от (cx,cy)=точка_оси до круга со смещением
                в 2 диаметра. Маркер якорится в точку оси. */}
            {leader && (
              <Marker
                position={getLatLngByPicketage(pickets, mark.pk) ?? leader.belowPos}
                icon={kmIcons.get(mark.pk)!}
                interactive={false}
              />
            )}
          </span>
        )
      })}
    </>
  )
}
