import { useState, useMemo, useCallback, useEffect } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents, LayersControl } from 'react-leaflet'
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import type { Picket, Section, MapObject, PileField, ObjectTypeKey } from '../../types/geo'
import { TrassaLayer } from './TrassaLayer'
import { PicketMarkers } from './PicketMarkers'
import { SectionHighlight } from './SectionHighlight'
import { ObjectsLayer } from './ObjectsLayer'
import { MapControls } from './MapControls'
import { EquipmentLayer, type EquipKey } from './EquipmentLayer'
import { TempRoadsLayer } from './TempRoadsLayer'

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

async function fetchPickets(): Promise<Picket[]> {
  const res = await fetch('/api/geo/pickets')
  if (!res.ok) throw new Error(`Failed to fetch pickets: ${res.status}`)
  return res.json()
}

async function fetchSections(): Promise<Section[]> {
  const res = await fetch('/api/geo/sections')
  if (!res.ok) throw new Error(`Failed to fetch sections: ${res.status}`)
  const raw = await res.json()
  // Group by code to build ranges array (some sections have multiple version rows)
  const byCode = new Map<string, Section>()
  for (const r of raw) {
    if (!r.pk_start || !r.pk_end) continue
    const pkS = Number(r.pk_start) / 100
    const pkE = Number(r.pk_end) / 100
    if (!byCode.has(r.code)) {
      byCode.set(r.code, {
        id: 0, code: r.code, name: r.name, map_color: r.map_color || '#64748b',
        pk_start: pkS, pk_end: pkE, ranges: [[pkS, pkE]],
      })
    } else {
      const sec = byCode.get(r.code)!
      sec.ranges.push([pkS, pkE])
      sec.pk_start = Math.min(sec.pk_start, pkS)
      sec.pk_end = Math.max(sec.pk_end, pkE)
    }
  }
  return Array.from(byCode.values())
}

async function fetchObjects(): Promise<MapObject[]> {
  const res = await fetch('/api/geo/objects')
  if (!res.ok) throw new Error(`Failed to fetch objects: ${res.status}`)
  const raw = await res.json()
  // Transform API shape (type_code, object_code) to component shape (type, name)
  const typeMap: Record<string, MapObject['type']> = {
    PIPE: 'pipe', OVERPASS: 'overpass', BRIDGE: 'bridge',
    INTERSECTION_FIN: 'intersection_fin', INTERSECTION_PROP: 'intersection_prop',
    STOCKPILE: 'stockpile', BORROW_PIT: 'borrow_pit',
  }
  return raw
    .filter((o: Record<string, unknown>) => o.pk_start != null || (o.latitude != null && o.longitude != null))
    .map((o: Record<string, unknown>) => {
      const mappedType = typeMap[o.type_code as string]
      if (!mappedType) return null
      return {
      id: o.object_code,
      type: mappedType,
      name: o.name ?? o.object_code,
      pk_start: o.pk_start != null ? Number(o.pk_start) / 100 : null,  // DB stores as decimal ПК*100+offset → convert to PK number
      pk_end: o.pk_end != null ? Number(o.pk_end) / 100 : null,
      latitude: o.latitude != null ? Number(o.latitude) : null,
      longitude: o.longitude != null ? Number(o.longitude) : null,
      description: o.type_name ?? null,
      section_code: null,
      network_name: (o.network_name as string) ?? null,
      owner: (o.owner as string) ?? null,
      length_m: o.length_m != null ? Number(o.length_m) : null,
      }
    })
    .filter(Boolean) as MapObject[]
}

async function fetchPileFields(): Promise<PileField[]> {
  const res = await fetch('/api/geo/pile-fields')
  if (!res.ok) throw new Error(`Failed to fetch pile fields: ${res.status}`)
  const raw = await res.json()
  return raw
    .filter((p: Record<string, unknown>) => p.pk_start != null && p.pk_end != null)
    .map((p: Record<string, unknown>) => ({
      id: p.id ?? p.field_code ?? p.pk_start,
      section_number: 0,
      piles_count: Number(p.pile_count) || 0,
      pk_start: Number(p.pk_start) / 100,
      pk_end: Number(p.pk_end) / 100,
      name: p.field_code ? `Свайное поле ${p.field_code}` : null,
    })) as PileField[]
}

// ---------------------------------------------------------------------------
// Zoom tracker (inner component that uses useMapEvents)
// ---------------------------------------------------------------------------

/**
 * Adds a Leaflet zoom control in the top-right corner.
 * We disable the built-in `zoomControl` on MapContainer and mount this so
 * the +/- buttons don't collide with the top-left "Фильтр" button.
 */
function ZoomControlTopRight() {
  const map = useMap()
  useEffect(() => {
    const ctrl = L.control.zoom({ position: 'topright' })
    ctrl.addTo(map)
    return () => { ctrl.remove() }
  }, [map])
  return null
}

function ZoomTracker({ onZoomChange }: { onZoomChange: (z: number) => void }) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom())
    },
  })

  useEffect(() => {
    onZoomChange(map.getZoom())
  }, [map, onZoomChange])

  return null
}

// ---------------------------------------------------------------------------
// Default center and zoom (midpoint of the route)
// ---------------------------------------------------------------------------

const DEFAULT_CENTER: [number, number] = [58.14, 33.55]
const DEFAULT_ZOOM = 9

// ---------------------------------------------------------------------------
// Tile providers
// ---------------------------------------------------------------------------
// NOTE: Яндекс-тайлы используют свою проекцию (yandex-map-projection,
// грубо EPSG:3395 вместо общепринятой EPSG:3857 OpenStreetMap/CartoDB).
// Чтобы показывать их точно, нужен proj4leaflet + L.Proj.CRS — это ~+100 КБ
// в бандле и отдельная MapContainer-инстанция под каждую CRS.
// Мы используем стандартную EPSG:3857, поэтому яндекс-тайлы могут смещаться
// на ~1–2 км на широте Петербурга. Для обзорной карты это приемлемо;
// при необходимости точной привязки — переключаться на OSM/CartoDB.
const TILE_PROVIDERS = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: 'abc',
    maxZoom: 19,
  },
  yandexSat: {
    url: 'https://sat0{s}.maps.yandex.net/tiles?l=sat&v=3.1080.0&x={x}&y={y}&z={z}',
    attribution: '&copy; <a href="https://yandex.ru/maps/">Яндекс</a>',
    subdomains: '1234',
    maxZoom: 19,
  },
  yandexMap: {
    // core-renderer-tiles — публичный endpoint без версии, всегда свежий.
    url: 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU',
    attribution: '&copy; <a href="https://yandex.ru/maps/">Яндекс</a>',
    subdomains: '',
    maxZoom: 19,
  },
  cartoLight: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
} as const

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface VsmMapProps {
  /** Дата для слоя техники (YYYY-MM-DD). Если не задана — слой скрыт. */
  equipmentDateISO?: string | null
  /** Включённые типы техники (ключи canonical). null/undefined — все. */
  enabledEquipmentTypes?: Set<EquipKey> | null
  /** Набор section_code (raw) для фильтра; null/undefined — все. */
  enabledSectionCodes?: Set<string> | null
  /** Диапазон ПК [min, max] — скрывает маркеры вне диапазона. */
  pkRange?: [number | null, number | null]
  /** Внешний override фильтра типов объектов. */
  objectTypeFilterOverride?: Set<ObjectTypeKey> | null
  /** Скрыть встроенную плавающую панель MapControls (слева — участки/поиск/объекты). */
  hideBuiltInControls?: boolean
  /** Отрисовывать ли слой временных притрассовых дорог. */
  enableTempRoads?: boolean
}

export function VsmMap({
  equipmentDateISO = null,
  enabledEquipmentTypes = null,
  enabledSectionCodes = null,
  pkRange,
  objectTypeFilterOverride = null,
  hideBuiltInControls = false,
  enableTempRoads = true,
}: VsmMapProps = {}) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [activeSection, setActiveSection] = useState<string | null>(null)

  // Object type visibility filters (all enabled by default)
  const ALL_OBJECT_TYPES: ObjectTypeKey[] = ['pipe', 'overpass', 'bridge', 'pile_field', 'intersection_fin', 'intersection_prop', 'stockpile', 'borrow_pit']
  const [enabledObjectTypesInternal, setEnabledObjectTypesInternal] = useState<Set<ObjectTypeKey>>(() => {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('objects')
    if (raw) {
      const keys = raw.split(',').filter((k): k is ObjectTypeKey => ALL_OBJECT_TYPES.includes(k as ObjectTypeKey))
      return new Set(keys)
    }
    return new Set(ALL_OBJECT_TYPES)
  })
  // Если задан override из родителя — используем его
  const enabledObjectTypes = objectTypeFilterOverride ?? enabledObjectTypesInternal
  const setEnabledObjectTypes = setEnabledObjectTypesInternal

  const handleToggleObjectType = useCallback((key: ObjectTypeKey) => {
    setEnabledObjectTypes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [setEnabledObjectTypes])

  // Data queries
  const {
    data: pickets = [],
    isLoading: picketsLoading,
  } = useQuery<Picket[]>({
    queryKey: ['geo-pickets'],
    queryFn: fetchPickets,
    staleTime: 5 * 60_000,
  })

  const {
    data: sections = [],
    isLoading: sectionsLoading,
  } = useQuery<Section[]>({
    queryKey: ['geo-sections'],
    queryFn: fetchSections,
    staleTime: 5 * 60_000,
  })

  const { data: objects = [] } = useQuery<MapObject[]>({
    queryKey: ['geo-objects'],
    queryFn: fetchObjects,
    staleTime: 5 * 60_000,
  })

  const { data: pileFields = [] } = useQuery<PileField[]>({
    queryKey: ['geo-pile-fields'],
    queryFn: fetchPileFields,
    staleTime: 5 * 60_000,
  })

  // Compute bounds from pickets
  const bounds = useMemo(() => {
    if (pickets.length === 0) return null
    const lats = pickets.map((p) => p.latitude)
    const lngs = pickets.map((p) => p.longitude)
    return [
      [Math.min(...lats), Math.min(...lngs)] as [number, number],
      [Math.max(...lats), Math.max(...lngs)] as [number, number],
    ] as [[number, number], [number, number]]
  }, [pickets])

  // Compute highlight ranges for active section
  const highlightRanges = useMemo<[number, number][] | undefined>(() => {
    if (!activeSection) return undefined
    const sec = sections.find((s) => s.code === activeSection)
    if (!sec) return undefined
    return sec.ranges ?? [[sec.pk_start, sec.pk_end]]
  }, [activeSection, sections])

  const handleZoomChange = useCallback((z: number) => {
    setZoom(z)
  }, [])

  const isLoading = picketsLoading || sectionsLoading

  return (
    <div className="relative w-full h-full">
      {isLoading && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-accent-red border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-muted">
              Загрузка карты...
            </span>
          </div>
        </div>
      )}

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        bounds={bounds ?? undefined}
        boundsOptions={{ padding: [30, 30] }}
        className="w-full h-full"
        zoomControl={false}
        attributionControl={false}
      >
        <ZoomControlTopRight />

        <LayersControl position="bottomright">
          <LayersControl.BaseLayer checked name="OSM">
            <TileLayer
              url={TILE_PROVIDERS.osm.url}
              attribution={TILE_PROVIDERS.osm.attribution}
              subdomains={TILE_PROVIDERS.osm.subdomains}
              maxZoom={TILE_PROVIDERS.osm.maxZoom}
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Яндекс.Спутник">
            <TileLayer
              url={TILE_PROVIDERS.yandexSat.url}
              attribution={TILE_PROVIDERS.yandexSat.attribution}
              subdomains={TILE_PROVIDERS.yandexSat.subdomains}
              maxZoom={TILE_PROVIDERS.yandexSat.maxZoom}
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Яндекс.Схема">
            <TileLayer
              url={TILE_PROVIDERS.yandexMap.url}
              attribution={TILE_PROVIDERS.yandexMap.attribution}
              subdomains={TILE_PROVIDERS.yandexMap.subdomains}
              maxZoom={TILE_PROVIDERS.yandexMap.maxZoom}
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="CartoDB Positron">
            <TileLayer
              url={TILE_PROVIDERS.cartoLight.url}
              attribution={TILE_PROVIDERS.cartoLight.attribution}
              subdomains={TILE_PROVIDERS.cartoLight.subdomains}
              maxZoom={TILE_PROVIDERS.cartoLight.maxZoom}
            />
          </LayersControl.BaseLayer>
        </LayersControl>

        <ZoomTracker onZoomChange={handleZoomChange} />

        {/* Section highlight (below route) */}
        {sections.length > 0 && pickets.length > 0 && (
          <SectionHighlight
            pickets={pickets}
            sections={sections}
            activeSection={activeSection}
            activeSections={enabledSectionCodes}
          />
        )}

        {/* Route polyline */}
        {pickets.length >= 2 && (
          <TrassaLayer
            pickets={pickets}
            highlightRanges={highlightRanges}
          />
        )}

        {/* Picket marks */}
        {pickets.length >= 2 && (
          <PicketMarkers
            pickets={pickets}
            zoom={zoom}
            highlightRanges={highlightRanges}
          />
        )}

        {/* Objects */}
        {pickets.length >= 2 && (objects.length > 0 || pileFields.length > 0) && (
          <ObjectsLayer
            pickets={pickets}
            objects={objects}
            pileFields={pileFields}
            zoom={zoom}
            enabledObjectTypes={enabledObjectTypes}
            infoDateISO={equipmentDateISO ?? undefined}
          />
        )}

        {/* Временные притрассовые дороги */}
        <TempRoadsLayer enabled={enableTempRoads} />

        {/* Equipment layer (filter-driven) */}
        {equipmentDateISO && (
          <EquipmentLayer
            dateISO={equipmentDateISO}
            enabledTypes={enabledEquipmentTypes ?? new Set<EquipKey>([
              'dump_truck', 'excavator', 'bulldozer', 'motor_grader', 'road_roller', 'pile_driver',
            ])}
            enabledSections={enabledSectionCodes}
            pkMin={pkRange?.[0] ?? null}
            pkMax={pkRange?.[1] ?? null}
          />
        )}

        {/* Controls overlay */}
        {!hideBuiltInControls && pickets.length > 0 && sections.length > 0 && (
          <MapControls
            pickets={pickets}
            sections={sections}
            activeSection={activeSection}
            onSectionSelect={setActiveSection}
            enabledObjectTypes={enabledObjectTypes}
            onToggleObjectType={handleToggleObjectType}
          />
        )}
      </MapContainer>
    </div>
  )
}
