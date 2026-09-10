import type { Picket, LatLng } from '../types/geo'

// ---------------------------------------------------------------------------
// Picketage formatting / parsing
// ---------------------------------------------------------------------------

/**
 * Format a numeric picketage value into human-readable "ПК2640+86.30" form.
 * The integer part is the PK number, the fractional part is metres / 100.
 * Output: ПК{km}+{metres to 2 decimals}
 */
export function formatPicketage(value: number): string {
  const km = Math.floor(value)
  const metres = (value - km) * 100
  // Pad to 5 chars, e.g. "02.72", "86.30"
  const mStr = metres.toFixed(2).padStart(5, '0')
  return `\u041F\u041A${km}+${mStr}`
}

/**
 * Format an integer PK number (e.g. 3298) into the full picket format
 * "ПК3298+00.00".
 */
export function formatPK(pk: number | null | undefined): string {
  if (pk == null || !Number.isFinite(pk)) return '—'
  const major = Math.floor(pk)
  const minor = (pk - major) * 100
  return `ПК${major}+${minor.toFixed(2).padStart(5, '0')}`
}

/**
 * Parse various picketage string formats into a single float:
 *   "PK2640+23.5" | "2640+23.5" | "264023.5" (sheet format) | "2640.0235"
 */
export function parsePicketage(value: string | number | null | undefined): number | null {
  if (value == null) return null
  let s = String(value).trim()
  if (!s) return null

  s = s.replace(/\s+/g, '')

  // Pure number
  if (/^[0-9]+([.,][0-9]+)?$/.test(s)) {
    s = s.replace(',', '.')
    const num = parseFloat(s)
    if (!Number.isFinite(num)) return null

    // Very large numbers are metres
    if (num >= 1_000_000) return num / 1000.0

    // Frequent sheet format: km*100 + metres  (e.g. 264086.29 = PK2640+86.29)
    if (num >= 10_000) {
      const km = Math.floor(num / 100)
      const metres = num - km * 100
      return km + metres / 1000.0
    }

    return num
  }

  // Strip leading "PK" / "\u041F\u041A" (Cyrillic)
  s = s.replace(/^(\u041F\u041A|PK)/i, '')
  const m = s.match(/^(\d+)([+-])(\d+(?:[.,]\d+)?)$/)
  if (m) {
    const km = parseInt(m[1], 10)
    const sign = m[2] === '-' ? -1 : 1
    const metres = parseFloat(m[3].replace(',', '.'))
    if (!Number.isFinite(km) || !Number.isFinite(metres)) return null
    return km + sign * (metres / 1000.0)
  }

  return null
}

// ---------------------------------------------------------------------------
// Interpolation along the picket polyline
// ---------------------------------------------------------------------------

/**
 * Given a sorted pickets array and a fractional PK number, return interpolated
 * [lat, lng] using binary search + linear interpolation.
 * Pure-geometry version (no map projection needed).
 */
export function getLatLngByPicketage(pickets: Picket[], pkNumber: number): LatLng | null {
  if (!pickets || pickets.length === 0) return null

  // Clamp to bounds
  if (pkNumber <= pickets[0].pk_number) {
    return [pickets[0].latitude, pickets[0].longitude]
  }
  if (pkNumber >= pickets[pickets.length - 1].pk_number) {
    const p = pickets[pickets.length - 1]
    return [p.latitude, p.longitude]
  }

  // Binary search for the right bracket
  let lo = 0
  let hi = pickets.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (pickets[mid].pk_number < pkNumber) lo = mid
    else hi = mid
  }

  const left = pickets[lo]
  const right = pickets[hi]
  const span = right.pk_number - left.pk_number
  const t = span === 0 ? 0 : (pkNumber - left.pk_number) / span

  const lat = left.latitude + (right.latitude - left.latitude) * t
  const lng = left.longitude + (right.longitude - left.longitude) * t
  return [lat, lng]
}

// ---------------------------------------------------------------------------
// Tangent angle
// ---------------------------------------------------------------------------

/**
 * Get the tangent angle (in radians, screen-space convention: right=0, down=pi/2)
 * at a given picketage along the route.
 * Uses pickets neighbours to approximate the direction.
 */
export function getTangentAngle(pickets: Picket[], pkNumber: number): number {
  if (!pickets || pickets.length < 2) return 0

  const pkFloor = Math.floor(pkNumber)
  const pkCeil = Math.ceil(pkNumber)

  let aPk = pkFloor
  let bPk = pkCeil
  if (aPk === bPk) {
    aPk = pkFloor - 1
    bPk = pkCeil + 1
  }

  const a = getLatLngByPicketage(pickets, aPk)
  const b = getLatLngByPicketage(pickets, bPk)
  if (!a || !b) return 0

  // Use simple projected coords (lat => y inverted for screen, lng => x)
  // Since we work with small deltas, treating lat/lng as linear is fine.
  const dx = b[1] - a[1]  // longitude difference ~ x
  const dy = -(b[0] - a[0])  // latitude difference, inverted for screen y
  return Math.atan2(dy, dx)
}

// ---------------------------------------------------------------------------
// Perpendicular mark endpoints
// ---------------------------------------------------------------------------

/**
 * Return two [lat, lng] points forming a line perpendicular to the route
 * at the given picketage. `halfLenDeg` controls the perpendicular extent
 * in approximate degrees.
 */
export function getPerpendicularEnds(
  pickets: Picket[],
  pkNumber: number,
  halfLenDeg: number
): [LatLng, LatLng] | null {
  const center = getLatLngByPicketage(pickets, pkNumber)
  if (!center) return null

  const angle = getTangentAngle(pickets, pkNumber)
  const perp = angle + Math.PI / 2

  // Convert to lat/lng offsets. We use cos(lat) correction for longitude.
  const cosLat = Math.cos((center[0] * Math.PI) / 180)
  const dLng = Math.cos(perp) * halfLenDeg / cosLat
  const dLat = -Math.sin(perp) * halfLenDeg  // negative because screen y is inverted

  const p1: LatLng = [center[0] - dLat, center[1] - dLng]
  const p2: LatLng = [center[0] + dLat, center[1] + dLng]
  return [p1, p2]
}

/**
 * Scale factor for picket mark sizes based on zoom level.
 * Matches the original: pow(2, (zoom - 12) / 3), clamped [0.55, 2.4].
 */
export function getMarkScaleByZoom(zoom: number): number {
  const scale = Math.pow(2, (zoom - 12) / 3)
  return Math.max(0.55, Math.min(2.4, scale))
}

/**
 * Adaptive scale factor for map symbols based on zoom level.
 * pow(2, (zoom - 12) / 3), clamped [0.35, 3.0].
 */
export function getScaleByZoom(zoom: number): number {
  const scale = Math.pow(2, (zoom - 12) / 3)
  return Math.max(0.35, Math.min(3.0, scale))
}

/**
 * Compute the approximate degree-length of a perpendicular mark for a given zoom.
 * At zoom 12, the mark is about 0.0004 degrees half-length.
 */
export function getMarkHalfLenDeg(zoom: number): number {
  const base = 0.0004
  // Inverse of zoom: at higher zoom we want the marks to appear roughly constant
  // on screen, so we shrink them as zoom grows.
  return base * Math.pow(2, 12 - zoom)
}

// ---------------------------------------------------------------------------
// Segment interpolation (click on polyline)
// ---------------------------------------------------------------------------

/**
 * Given a click point and two pickets forming a segment, interpolate the
 * PK value at the click position (using simple projection).
 */
export function interpolatePicketageOnSegment(
  clickLat: number,
  clickLng: number,
  pk1: Picket,
  pk2: Picket
): number {
  // Project to flat coordinates
  const dx1 = clickLng - pk1.longitude
  const dy1 = clickLat - pk1.latitude
  const dxSeg = pk2.longitude - pk1.longitude
  const dySeg = pk2.latitude - pk1.latitude

  const segLenSq = dxSeg * dxSeg + dySeg * dySeg
  if (segLenSq === 0) return pk1.pk_number

  const t = Math.max(0, Math.min(1, (dx1 * dxSeg + dy1 * dySeg) / segLenSq))
  return pk1.pk_number + (pk2.pk_number - pk1.pk_number) * t
}

/**
 * Find which segment of the pickets array a given lat/lng falls closest to,
 * and return the interpolated PK number.
 */
export function findPicketageAtPoint(
  pickets: Picket[],
  lat: number,
  lng: number
): number | null {
  if (!pickets || pickets.length < 2) return null

  let bestDist = Infinity
  let bestPk = pickets[0].pk_number

  for (let i = 0; i < pickets.length - 1; i++) {
    const pk1 = pickets[i]
    const pk2 = pickets[i + 1]

    // Project click onto segment
    const dxSeg = pk2.longitude - pk1.longitude
    const dySeg = pk2.latitude - pk1.latitude
    const segLenSq = dxSeg * dxSeg + dySeg * dySeg
    if (segLenSq === 0) continue

    const dx = lng - pk1.longitude
    const dy = lat - pk1.latitude
    const t = Math.max(0, Math.min(1, (dx * dxSeg + dy * dySeg) / segLenSq))

    const projLng = pk1.longitude + t * dxSeg
    const projLat = pk1.latitude + t * dySeg
    const dist = (projLng - lng) ** 2 + (projLat - lat) ** 2

    if (dist < bestDist) {
      bestDist = dist
      bestPk = pk1.pk_number + (pk2.pk_number - pk1.pk_number) * t
    }
  }

  return bestPk
}

// ---------------------------------------------------------------------------
// Polyline offset (for parallel lines along axis)
// ---------------------------------------------------------------------------

/**
 * Offset a polyline laterally by a given distance in degrees.
 * Positive offset = right side of travel direction, negative = left.
 * For each segment, compute the perpendicular and shift both endpoints.
 * Adjacent segments are averaged at shared vertices for smooth joins.
 */
export function offsetPolylineLatLngs(
  points: LatLng[],
  offsetDeg: number,
): LatLng[] {
  if (points.length < 2) return points.map((p) => [...p] as LatLng)

  // For each segment compute the unit perpendicular (pointing "right" of direction)
  const normals: { nx: number; ny: number }[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][1] - points[i][1] // lng diff
    const dy = points[i + 1][0] - points[i][0] // lat diff
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) {
      normals.push({ nx: 0, ny: 0 })
    } else {
      // perpendicular to (dx, dy) is (dy, -dx) — this is "right" side
      normals.push({ nx: dy / len, ny: -dx / len })
    }
  }

  const result: LatLng[] = []
  for (let i = 0; i < points.length; i++) {
    let nx: number
    let ny: number
    if (i === 0) {
      nx = normals[0].nx
      ny = normals[0].ny
    } else if (i === points.length - 1) {
      nx = normals[normals.length - 1].nx
      ny = normals[normals.length - 1].ny
    } else {
      // Average normals of adjacent segments for smooth join
      nx = (normals[i - 1].nx + normals[i].nx) / 2
      ny = (normals[i - 1].ny + normals[i].ny) / 2
      const nLen = Math.sqrt(nx * nx + ny * ny)
      if (nLen > 0) {
        nx /= nLen
        ny /= nLen
      }
    }
    // Apply cos(lat) correction to lng component
    const cosLat = Math.cos((points[i][0] * Math.PI) / 180)
    const dLat = nx * offsetDeg
    const dLng = ny * offsetDeg / (cosLat || 1)
    result.push([points[i][0] + dLat, points[i][1] + dLng])
  }

  return result
}
