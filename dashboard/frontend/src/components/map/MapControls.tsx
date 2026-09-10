import { useState, useCallback } from 'react'
import { useMap } from 'react-leaflet'
import { Search } from 'lucide-react'
import type { Picket, Section } from '../../types/geo'
import type { ObjectTypeKey } from '../../types/geo'
import { getLatLngByPicketage, parsePicketage } from '../../utils/geometry'
import { sectionCodeToUILabel } from '../../lib/sections'

const OBJECT_TYPE_LABELS: { key: ObjectTypeKey; label: string }[] = [
  { key: 'pipe', label: 'Трубы' },
  { key: 'overpass', label: 'Путепроводы' },
  { key: 'bridge', label: 'Мосты' },
  { key: 'pile_field', label: 'Свайные поля' },
  { key: 'intersection_fin', label: 'Пересечения ЖДС' },
  { key: 'intersection_prop', label: 'Пересечения балансодержатель' },
]

interface MapControlsProps {
  pickets: Picket[]
  sections: Section[]
  activeSection: string | null
  onSectionSelect: (code: string | null) => void
  enabledObjectTypes: Set<ObjectTypeKey>
  onToggleObjectType: (key: ObjectTypeKey) => void
}

/**
 * Map overlay controls: section quick-nav buttons and PK search.
 */
export function MapControls({
  pickets,
  sections,
  activeSection,
  onSectionSelect,
  enabledObjectTypes,
  onToggleObjectType,
}: MapControlsProps) {
  const map = useMap()
  const [searchValue, setSearchValue] = useState('')
  const [searchError, setSearchError] = useState(false)

  const handleSectionClick = useCallback(
    (section: Section) => {
      if (activeSection === section.code) {
        // Deselect
        onSectionSelect(null)
        // Fit to all pickets
        if (pickets.length > 0) {
          const lats = pickets.map((p) => p.latitude)
          const lngs = pickets.map((p) => p.longitude)
          map.fitBounds([
            [Math.min(...lats), Math.min(...lngs)],
            [Math.max(...lats), Math.max(...lngs)],
          ], { padding: [30, 30] })
        }
      } else {
        onSectionSelect(section.code)
        // Fly to section bounds
        const ranges = section.ranges ?? [[section.pk_start, section.pk_end]]
        const pkMin = Math.min(...ranges.map(([s]) => s))
        const pkMax = Math.max(...ranges.map(([, e]) => e))

        const p1 = getLatLngByPicketage(pickets, pkMin)
        const p2 = getLatLngByPicketage(pickets, pkMax)
        if (p1 && p2) {
          map.fitBounds([p1, p2], { padding: [50, 50] })
        }
      }
    },
    [map, pickets, activeSection, onSectionSelect]
  )

  const handleSearch = useCallback(() => {
    setSearchError(false)
    const pk = parsePicketage(searchValue)
    if (pk == null) {
      setSearchError(true)
      return
    }
    const pos = getLatLngByPicketage(pickets, pk)
    if (!pos) {
      setSearchError(true)
      return
    }
    map.flyTo(pos, 14, { duration: 0.8 })
  }, [searchValue, pickets, map])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch()
    },
    [handleSearch]
  )

  return (
    <div className="absolute top-3 left-3 z-[1000] flex flex-col gap-2 max-w-[320px]">
      {/* Section buttons */}
      <div className="bg-white/90 backdrop-blur-sm rounded-lg border border-border p-3 shadow-xl">
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wider">
          Участки
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => {
              onSectionSelect(null)
              if (pickets.length > 0) {
                const lats = pickets.map((p) => p.latitude)
                const lngs = pickets.map((p) => p.longitude)
                map.fitBounds([
                  [Math.min(...lats), Math.min(...lngs)],
                  [Math.max(...lats), Math.max(...lngs)],
                ], { padding: [30, 30] })
              }
            }}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
              activeSection == null
                ? 'bg-accent-red text-white'
                : 'bg-white border border-border text-text-muted hover:text-text-primary hover:bg-bg-surface'
            }`}
          >
            Все
          </button>
          {sections.map((sec) => (
            <button
              key={sec.code}
              onClick={() => handleSectionClick(sec)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                activeSection === sec.code
                  ? 'text-white font-semibold ring-1 ring-black/10'
                  : 'text-text-secondary hover:text-text-primary hover:brightness-110'
              }`}
              style={{
                backgroundColor:
                  activeSection === sec.code
                    ? sec.map_color
                    : `${sec.map_color}22`,
              }}
            >
              {sectionCodeToUILabel(sec.code)}
            </button>
          ))}
        </div>
      </div>

      {/* PK Search */}
      <div className="bg-white/90 backdrop-blur-sm rounded-lg border border-border p-3 shadow-xl">
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wider">
          Поиск по ПК
        </div>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={searchValue}
            onChange={(e) => {
              setSearchValue(e.target.value)
              setSearchError(false)
            }}
            onKeyDown={handleKeyDown}
            placeholder="ПК2900 или 2900"
            className={`flex-1 px-2.5 py-1.5 rounded text-xs bg-white border text-text-primary
              placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent-red/50
              ${searchError ? 'border-red-500' : 'border-border'}`}
          />
          <button
            onClick={handleSearch}
            className="px-2.5 py-1.5 rounded bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
            title="Найти"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>
        {searchError && (
          <div className="text-[10px] text-red-500 mt-1">
            Пикет не найден
          </div>
        )}
      </div>

      {/* Object type filters */}
      <div className="bg-white/90 backdrop-blur-sm rounded-lg border border-border p-3 shadow-xl">
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wider">
          Объекты
        </div>
        <div className="flex flex-col gap-1">
          {OBJECT_TYPE_LABELS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer text-xs text-text-secondary hover:text-text-primary">
              <input
                type="checkbox"
                checked={enabledObjectTypes.has(key)}
                onChange={() => onToggleObjectType(key)}
                className="accent-accent-red w-3 h-3"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
