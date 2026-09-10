/** Route picket from the API (/api/geo/pickets) */
export interface Picket {
  pk_number: number
  pk_name: string
  latitude: number
  longitude: number
}

/** Construction section from the API (/api/geo/sections) */
export interface Section {
  id: number
  code: string
  name: string
  map_color: string
  pk_start: number
  pk_end: number
  /** Some sections have discontinuous ranges (e.g. section 3) */
  ranges: [number, number][]
}

/** Generic map object (pipe, overpass, bridge, intersection) */
export interface MapObject {
  id: string | number
  type: 'pipe' | 'overpass' | 'bridge' | 'intersection_fin' | 'intersection_prop' | 'stockpile' | 'borrow_pit'
  name: string
  pk_start: number | null
  pk_end: number | null
  latitude: number | null
  longitude: number | null
  description: string | null
  section_code: string | null
  /** Network name for intersections */
  network_name: string | null
  /** Owner / balance holder for intersections */
  owner: string | null
  /** Length in meters for bridges */
  length_m: number | null
}

/** Pile field from the API (/api/geo/pile-fields) */
export interface PileField {
  id: string | number
  section_number: number
  piles_count: number
  pk_start: number
  pk_end: number
  name: string | null
}

/** Keys for object type filtering */
export type ObjectTypeKey = 'pipe' | 'overpass' | 'bridge' | 'pile_field' | 'intersection_fin' | 'intersection_prop' | 'stockpile' | 'borrow_pit'

export type LatLng = [number, number]
