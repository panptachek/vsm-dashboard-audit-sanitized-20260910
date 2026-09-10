import { useMemo, useCallback } from 'react'
import { Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { LeafletMouseEvent } from 'leaflet'
import type { Picket, LatLng } from '../../types/geo'
import { findPicketageAtPoint, formatPicketage } from '../../utils/geometry'

interface TrassaLayerProps {
  pickets: Picket[]
  /** Highlight segments in a given PK range (optional) */
  highlightRanges?: [number, number][]
}

/**
 * Static red polyline rendering the route alignment from pickets.
 * On click, interpolates the PK position and shows a popup (red, bold, JetBrains Mono).
 * No animation, no hover effects — purely static line.
 */
export function TrassaLayer({ pickets, highlightRanges }: TrassaLayerProps) {
  const map = useMap()

  // Build the full polyline coordinates
  const positions = useMemo<LatLng[]>(
    () => pickets.map((p) => [p.latitude, p.longitude] as LatLng),
    [pickets]
  )

  // Determine if a PK number is inside any highlight range
  const isHighlighted = useCallback(
    (pk: number) => {
      if (!highlightRanges) return false
      return highlightRanges.some(([s, e]) => pk >= s && pk <= e)
    },
    [highlightRanges]
  )

  // Build segments for highlight awareness
  const segments = useMemo(() => {
    if (!highlightRanges || highlightRanges.length === 0) {
      return [{ positions, highlighted: false, key: 'all' }]
    }

    // Group consecutive picket pairs by highlight state
    const result: { positions: LatLng[]; highlighted: boolean; key: string }[] = []
    let currentHighlight = isHighlighted(pickets[0]?.pk_number ?? 0)
    let currentPositions: LatLng[] = [[pickets[0].latitude, pickets[0].longitude]]

    for (let i = 1; i < pickets.length; i++) {
      const segHighlight =
        isHighlighted(pickets[i - 1].pk_number) || isHighlighted(pickets[i].pk_number)

      if (segHighlight !== currentHighlight) {
        // Close current segment
        result.push({
          positions: currentPositions,
          highlighted: currentHighlight,
          key: `seg-${result.length}`,
        })
        // Overlap by one point for continuity
        currentPositions = [[pickets[i - 1].latitude, pickets[i - 1].longitude]]
        currentHighlight = segHighlight
      }

      currentPositions.push([pickets[i].latitude, pickets[i].longitude])
    }

    result.push({
      positions: currentPositions,
      highlighted: currentHighlight,
      key: `seg-${result.length}`,
    })

    return result
  }, [pickets, positions, highlightRanges, isHighlighted])

  const handleClick = useCallback(
    (e: LeafletMouseEvent) => {
      const { lat, lng } = e.latlng

      const bestPk = findPicketageAtPoint(pickets, lat, lng)
      if (bestPk == null) return

      const formatted = formatPicketage(bestPk)

      const popup = L.popup()
        .setLatLng(e.latlng)
        .setContent(
          `<div style="text-align:center;font-weight:bold;font-size:16px;color:#dc2626;font-family:'JetBrains Mono',monospace;">${formatted}</div>`
        )
        .openOn(map)

      // Auto-close after 5 seconds
      setTimeout(() => map.closePopup(popup), 5000)
    },
    [pickets, map]
  )

  if (pickets.length < 2) return null

  return (
    <>
      {segments.map((seg) => (
        <Polyline
          key={seg.key}
          positions={seg.positions}
          pathOptions={{
            color: seg.highlighted ? '#FFEB3B' : '#ef4444',
            weight: seg.highlighted ? 6 : 4,
            opacity: highlightRanges && !seg.highlighted ? 0.3 : 0.85,
          }}
          eventHandlers={{
            click: handleClick,
          }}
        />
      ))}
    </>
  )
}
