/**
 * EquipmentLayer — маркеры техники на карте.
 *
 * Данные: /api/wip/map/equipment-positions?date=YYYY-MM-DD
 * На каждую группу (объект × тип техники) — один div-маркер с иконкой типа +
 * бейдж счётчика. Клик — popup с таблицей единиц.
 */
import { useMemo } from 'react'
import { Marker, Popup, useMap } from 'react-leaflet'
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import { formatPK } from '../../utils/geometry'

export type EquipKey =
  | 'dump_truck'
  | 'excavator'
  | 'bulldozer'
  | 'motor_grader'
  | 'road_roller'
  | 'pile_driver'

const ICON_MAP: Record<EquipKey, string> = {
  dump_truck: '/icons/dump_truck.svg',
  excavator: '/icons/excavator.svg',
  bulldozer: '/icons/bulldozer.svg',
  motor_grader: '/icons/motor_grader.svg',
  road_roller: '/icons/road_roller.svg',
  pile_driver: '/icons/pile_driver.svg',
}

const LABEL: Record<EquipKey, string> = {
  dump_truck: 'Самосвал',
  excavator: 'Экскаватор',
  bulldozer: 'Бульдозер',
  motor_grader: 'Автогрейдер',
  road_roller: 'Каток',
  pile_driver: 'Копёр',
}

const TYPE_ACCENT: Record<EquipKey, string> = {
  dump_truck: '#dc2626',
  excavator: '#f59e0b',
  bulldozer: '#ca8a04',
  motor_grader: '#2563eb',
  road_roller: '#16a34a',
  pile_driver: '#7c3aed',
}

function ownershipLabel(unit: Pick<Unit, 'ownership_type' | 'contractor'>): string {
  const ownership = (unit.ownership_type || '').toLowerCase()
  const contractor = (unit.contractor || '').trim()
  const normalized = contractor.toLowerCase().replace('ё', 'е')
  if (ownership === 'own' || normalized === 'ждс' || normalized.includes('ооо ждс')) return 'ЖДС'
  if (normalized.includes('алмаз')) return 'АЛМАЗ'
  if (contractor) return contractor
  if (ownership === 'hired') return 'наемная'
  return ''
}

function plateWithOwnership(unit: Unit): string {
  const plate = unit.plate || '—'
  const owner = ownershipLabel(unit)
  return owner && owner !== 'ЖДС' ? `${plate} (${owner})` : plate
}

interface Unit {
  plate: string
  unit_number?: string
  brand: string
  work_name: string
  volume: number
  unit: string
  percent: number | null
  productivity_label?: string
  ownership_type?: string
  contractor: string
  trips: number
}

export interface EquipmentPosition {
  latitude: number
  longitude: number
  pk: number | null
  section_code: string | null
  object_code: string | null
  object_name: string | null
  object_type: string | null
  equipment_type: EquipKey
  count: number
  units: Unit[]
}

interface EquipmentResponse {
  date: string
  rows: EquipmentPosition[]
}

interface Props {
  dateISO: string
  enabledTypes: Set<EquipKey>
  enabledSections: Set<string> | null  // null → all
  pkMin?: number | null
  pkMax?: number | null
}

function buildIcon(type: EquipKey, count: number): L.DivIcon {
  const iconUrl = ICON_MAP[type]
  const accent = TYPE_ACCENT[type]
  // Industrial plate marker. Always axis-aligned: equipment is a state marker,
  // not a linear object, so it must stay readable regardless of route angle.
  const html = `
    <div style="
      position: relative;
      width: 58px; height: 48px;
      background: linear-gradient(180deg, #ffffff 0%, #f4f4f5 100%);
      border: 2px solid #1a1a1a;
      border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      overflow: visible;
    ">
      <div style="
        position:absolute; left:0; top:0; bottom:0; width:7px;
        background:${accent};
        border-radius:4px 0 0 4px;
        border-right:2px solid #1a1a1a;
      "></div>
      <div style="
        position:absolute; left:11px; right:6px; top:5px; bottom:5px;
        display:flex; align-items:center; justify-content:center;
      ">
        <img src="${iconUrl}" style="width: 40px; height: 34px; display: block;" alt="${LABEL[type]}" />
      </div>
      ${count > 1 ? `<span style="
        position: absolute;
        top: -8px; right: -8px;
        min-width: 22px; height: 22px;
        padding: 0 6px;
        background: #dc2626;
        color: white;
        border: 2px solid white;
        border-radius: 11px;
        font-size: 13px;
        font-weight: 700;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        display: flex; align-items: center; justify-content: center;
        line-height: 1;
      ">${count}</span>` : ''}
    </div>
  `
  return L.divIcon({
    html,
    className: 'vsm-equip-icon',
    iconSize: [58, 48],
    iconAnchor: [29, 24],
  })
}

export function EquipmentLayer({ dateISO, enabledTypes, enabledSections, pkMin, pkMax }: Props) {
  const map = useMap()

  const { data } = useQuery<EquipmentResponse>({
    queryKey: ['wip-map-equip', dateISO],
    queryFn: () =>
      fetch(`/api/wip/map/equipment-positions?date=${dateISO}`).then((r) => {
        if (!r.ok) throw new Error('failed')
        return r.json()
      }),
    staleTime: 30_000,
    enabled: !!dateISO,
  })

  // Разнос пересекающихся маркеров одинаковой группы (по (lat,lng) + тип).
  // Если несколько типов техники на одной точке — разводим по кругу.
  const rows = useMemo(() => {
    const raw = (data?.rows ?? []).filter((r) => {
      if (!enabledTypes.has(r.equipment_type)) return false
      if (enabledSections && r.section_code && !enabledSections.has(r.section_code)) return false
      if (pkMin != null && r.pk != null && r.pk < pkMin) return false
      if (pkMax != null && r.pk != null && r.pk > pkMax) return false
      return true
    })

    const shifted = raw.map((r) => {
      const objectType = (r.object_type || '').toUpperCase()
      if (objectType === 'STOCKPILE') {
        return { ...r, latitude: r.latitude + 0.0012, longitude: r.longitude + 0.0018 }
      }
      if (objectType === 'BORROW_PIT') {
        return { ...r, latitude: r.latitude - 0.001, longitude: r.longitude + 0.0015 }
      }
      return r
    })

    // Группируем по точке (с округлением), раскладываем по окружности
    const byPoint = new Map<string, EquipmentPosition[]>()
    for (const r of shifted) {
      const key = `${r.latitude.toFixed(4)}_${r.longitude.toFixed(4)}`
      const arr = byPoint.get(key) ?? []
      arr.push(r)
      byPoint.set(key, arr)
    }

    const offsetDeg = 0.0015 // ~ 150 м
    const out: (EquipmentPosition & { lat: number; lng: number })[] = []
    for (const group of byPoint.values()) {
      if (group.length === 1) {
        out.push({ ...group[0], lat: group[0].latitude, lng: group[0].longitude })
      } else {
        group.forEach((r, i) => {
          const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2
          out.push({
            ...r,
            lat: r.latitude + Math.sin(angle) * offsetDeg,
            lng: r.longitude + Math.cos(angle) * offsetDeg * 1.6,
          })
        })
      }
    }
    return out
  }, [data, enabledTypes, enabledSections, pkMin, pkMax])

  if (!rows.length) return null

  return (
    <>
      {rows.map((r, idx) => (
        <Marker
          key={`${r.section_code}-${r.object_code}-${r.equipment_type}-${idx}`}
          position={[r.lat, r.lng]}
          icon={buildIcon(r.equipment_type, r.count)}
          eventHandlers={{
            click: () => {
              map.setView([r.lat, r.lng], Math.max(map.getZoom(), 13), { animate: true })
            },
          }}
        >
          <Popup maxWidth={580} minWidth={540}>
            <div style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {LABEL[r.equipment_type]} · {r.count} ед.
              </div>
              <div style={{ color: '#666', marginBottom: 8, fontSize: 11 }}>
                {r.object_name ?? r.object_code ?? '—'}
                {r.pk != null ? ` · ${formatPK(r.pk)}` : ''}
                {r.section_code ? ` · ${r.section_code}` : ''}
              </div>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, monospace',
                  tableLayout: 'fixed',
                }}
              >
                <colgroup>
                  <col style={{ width: 92 }} />
                  <col style={{ width: 66 }} />
                  <col style={{ width: 94 }} />
                  <col style={{ width: 188 }} />
                  <col style={{ width: 86 }} />
                </colgroup>
                <thead>
                  <tr style={{ background: '#f5f5f5' }}>
                    <th style={th}>Гос.№</th>
                    <th style={th}>Борт</th>
                    <th style={th}>Марка</th>
                    <th style={th}>Работа</th>
                    <th style={{ ...th, textAlign: 'right' }}>Произв.</th>
                  </tr>
                </thead>
                <tbody>
                  {r.units.map((u, i) => (
                    <tr key={`${u.plate}-${i}`}>
                      <td style={td} title={ownershipLabel(u)}>{plateWithOwnership(u)}</td>
                      <td style={td}>{u.unit_number || '—'}</td>
                      <td style={td}>{u.brand || '—'}</td>
                      <td style={tdWrap}>{u.work_name || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {u.percent == null ? '—' : `${u.percent}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '4px 6px',
  borderBottom: '1px solid #ddd',
  fontWeight: 600,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#555',
}
const td: React.CSSProperties = {
  padding: '4px 6px',
  borderBottom: '1px solid #eee',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
// For the «Работа» column — wrap, break long words, no ellipsis.
const tdWrap: React.CSSProperties = {
  padding: '4px 6px',
  borderBottom: '1px solid #eee',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  maxWidth: 160,
}
