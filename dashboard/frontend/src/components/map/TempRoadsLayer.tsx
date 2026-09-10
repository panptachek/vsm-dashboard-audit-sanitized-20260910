/**
 * Слой временных притрассовых дорог на карте.
 * Рисует каждую дорогу как полилинию по её точкам (/api/wip/map/temp-roads).
 * Все дороги — одним нейтральным цветом; подпись-код показывается при zoom>=14.
 */
import { useQuery } from '@tanstack/react-query'
import { Polyline, Popup, Tooltip } from 'react-leaflet'

interface RoadPoint { lat: number; lng: number; pk_label?: string | null }
interface TempRoad {
  road_code: string
  road_name: string
  length_m: number | null
  points: RoadPoint[]
}

// Нейтральный цвет для всех временных дорог — не конкурирует с объектами на карте.
const ROAD_COLOR = '#0891b2'
const ROAD_WEIGHT = 3

export function TempRoadsLayer({ enabled = true }: { enabled?: boolean }) {
  const { data } = useQuery<{ roads: TempRoad[] }>({
    queryKey: ['wip', 'map', 'temp-roads'],
    queryFn: () => fetch('/api/wip/map/temp-roads').then(r => r.json()),
    enabled,
    staleTime: 5 * 60_000,
  })
  if (!enabled || !data?.roads) return null

  return (
    <>
      {data.roads.map((road) => {
        if (road.points.length < 2) return null
        const positions = road.points.map(p => [p.lat, p.lng] as [number, number])
        return (
          <Polyline
            key={road.road_code}
            positions={positions}
            pathOptions={{ color: ROAD_COLOR, weight: ROAD_WEIGHT, opacity: 0.85 }}
          >
            {/* Подпись-код поверх линии; показывается при zoom>=14 через CSS-клас. */}
            <Tooltip permanent direction="auto" className="temp-road-label">
              {road.road_code}
            </Tooltip>
            <Popup>
              <div style={{ minWidth: 180, fontSize: 12 }}>
                <strong style={{ color: ROAD_COLOR }}>{road.road_code}</strong>
                {road.road_name && road.road_name !== road.road_code && (
                  <div style={{ color: '#666', fontSize: 11 }}>{road.road_name}</div>
                )}
                {road.length_m != null && (
                  <div style={{ marginTop: 4 }}>
                    Длина: <b>{(road.length_m / 1000).toFixed(2)} км</b>
                  </div>
                )}
                <div style={{ marginTop: 2, color: '#888', fontSize: 10 }}>
                  {road.points.length} точек
                </div>
              </div>
            </Popup>
          </Polyline>
        )
      })}
    </>
  )
}
