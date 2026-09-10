import { useMemo } from 'react'
import { Polyline, Tooltip } from 'react-leaflet'
import type { Picket, Section, LatLng } from '../../types/geo'
import { getLatLngByPicketage } from '../../utils/geometry'

interface SectionHighlightProps {
  pickets: Picket[]
  sections: Section[]
  /** Actively selected section code, or null for all */
  activeSection?: string | null
  /** External multi-select filter. null means all sections are active. */
  activeSections?: Set<string> | null
}

/**
 * Colored overlay for each construction section.
 * Each section is rendered as a thick semi-transparent polyline along the route
 * using its map_color. Section bounds are indicated with tooltips.
 */
export function SectionHighlight({ pickets, sections, activeSection, activeSections = null }: SectionHighlightProps) {
  const sectionPolylines = useMemo(() => {
    if (!pickets || pickets.length < 2 || !sections) return []

    return sections.flatMap((section) => {
      const ranges = section.ranges ?? [[section.pk_start, section.pk_end]]
      return ranges.map((range, rangeIdx) => {
        const [pkStart, pkEnd] = range
        const points: LatLng[] = []

        // Start point
        const startPt = getLatLngByPicketage(pickets, pkStart)
        if (startPt) points.push(startPt)

        // Intermediate pickets within range
        const iStart = Math.ceil(pkStart)
        const iEnd = Math.floor(pkEnd)
        for (let pk = iStart; pk <= iEnd; pk++) {
          const pt = getLatLngByPicketage(pickets, pk)
          if (pt) points.push(pt)
        }

        // End point
        const endPt = getLatLngByPicketage(pickets, pkEnd)
        if (endPt) points.push(endPt)

        const isActive = activeSections
          ? activeSections.has(section.code)
          : (activeSection === section.code || activeSection == null)

        return {
          key: `${section.code}-r${rangeIdx}`,
          positions: points,
          color: section.map_color,
          name: section.name,
          code: section.code,
          pkStart,
          pkEnd,
          isActive,
        }
      })
    })
  }, [pickets, sections, activeSection, activeSections])

  if (sectionPolylines.length === 0) return null

  return (
    <>
      {sectionPolylines.map((seg) => (
        <Polyline
          key={seg.key}
          positions={seg.positions}
          pathOptions={{
            color: seg.color,
            weight: 10,
            opacity: seg.isActive ? 0.35 : 0.1,
            lineCap: 'butt',
          }}
        >
          <Tooltip sticky>
            <div style={{ fontSize: 12, lineHeight: 1.4 }}>
              <strong style={{ color: seg.color }}>{seg.name}</strong>
              <br />
              {`\u041F\u041A${Math.floor(seg.pkStart)} \u2014 \u041F\u041A${Math.floor(seg.pkEnd)}`}
            </div>
          </Tooltip>
        </Polyline>
      ))}
    </>
  )
}
