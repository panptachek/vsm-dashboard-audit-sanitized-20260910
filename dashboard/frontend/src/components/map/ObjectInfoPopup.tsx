/**
 * ObjectInfoPopup — содержимое Leaflet-popup для объектов на карте.
 * Ленится: при первом рендере вызывает /api/wip/map/object-info.
 */
import { useQuery } from '@tanstack/react-query'
import { formatPK } from '../../utils/geometry'

interface Props {
  /** object_code или field_code */
  id: string
  /** object_type.code (PIPE/BRIDGE/MAIN_TRACK/…) или 'pile_field' */
  type: string
  /** YYYY-MM-DD */
  dateISO: string
  /** Заголовок для fallback-а пока загружается */
  fallbackTitle?: string
  fallbackSubtitle?: string
}

interface WorkSummaryRow {
  work_code?: string | null
  work: string
  unit: string | null
  project_volume: number | null
  completed_volume: number
  completion_pct: number | null
}

interface WorkTotalsRow {
  project_volume: number | null
  completed_volume: number
  completion_pct: number | null
}

interface ObjectInfoResponse {
  kind: 'object' | 'pile_field'
  // Pile field
  field_code?: string
  field_type?: string
  pile_type?: string
  pile_count?: number
  dynamic_test_count?: number
  project_works?: { work_code?: string | null; work: string; unit: string; project_volume: number }[]
  // Object
  type_code?: string
  type_name?: string
  object_code?: string
  name?: string
  pk_start?: number | null
  pk_end?: number | null
  pk_raw_text?: string | null
  cumulative?: { work: string; unit: string; volume: number }[]
  day?: { work: string; unit: string; volume: number }[]
  works_summary?: WorkSummaryRow[]
  works_total?: WorkTotalsRow
  quarry_shipments?: { material: string; unit: string; volume: number; trips?: number; date?: string }[]
  stockpile_balances?: {
    stockpile_id: string
    stockpile_name: string
    material: string
    snapshot_date: string | null
    volume: number | null
    unit: string
    report_id?: string | null
  }[]
  recent_movements?: { material: string; movement_type: string; volume: number; count: number }[]
}

/** Format number with thousand separators: 12500 → "12 500". */
function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n)
}

function formatDbPK(pk: number | null | undefined): string {
  if (pk == null || !Number.isFinite(pk)) return '—'
  const normalized = Math.abs(pk) >= 10_000 ? pk / 100 : pk
  return formatPK(normalized)
}

const PILE_WORK_LABELS: Record<string, string> = {
  PILE_MAIN: 'Забивка основных свай',
  PILE_TRIAL: 'Забивка пробных свай',
  PILE_DYNTEST: 'Динамические испытания свай',
}

function pileLengthLabel(pileType: string | null | undefined): string | null {
  const value = String(pileType ?? '').trim()
  const match = value.match(/С\s*(\d{3})/i)
  if (!match) return null
  const length = Number(match[1]) / 10
  return `${Number.isInteger(length) ? length.toFixed(0) : length.toFixed(1)} м`
}

function workLabel(row: { work: string; work_code?: string | null }, pileType?: string | null): string {
  const code = String(row.work_code ?? '').trim()
  const raw = String(row.work ?? '').trim()
  const rawAsCode = PILE_WORK_LABELS[raw] ? raw : ''
  const effectiveCode = code || rawAsCode
  const base = PILE_WORK_LABELS[effectiveCode] ?? raw
  const length = pileLengthLabel(pileType)
  if ((effectiveCode === 'PILE_MAIN' || effectiveCode === 'PILE_TRIAL') && length && !base.includes(length)) {
    return `${base} ${length}`
  }
  return base || 'Работа'
}

export function ObjectInfoPopup({ id, type, dateISO, fallbackTitle, fallbackSubtitle }: Props) {
  const { data, isLoading, error } = useQuery<ObjectInfoResponse>({
    queryKey: ['wip-map-object-info', id, type, dateISO],
    queryFn: () =>
      fetch(`/api/wip/map/object-info?id=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}&date=${dateISO}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div style={{ minWidth: 360, fontSize: 14 }}>
        <strong>{fallbackTitle ?? '…'}</strong>
        <div style={{ color: '#888', marginTop: 4 }}>загружаем…</div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div style={{ minWidth: 360, fontSize: 14 }}>
        <strong>{fallbackTitle ?? id}</strong>
        {fallbackSubtitle && <div style={{ color: '#666', fontSize: 12 }}>{fallbackSubtitle}</div>}
        <div style={{ color: '#c22', marginTop: 4 }}>Нет данных</div>
      </div>
    )
  }

  if (data.kind === 'pile_field') {
    return (
      <div style={{ minWidth: 420, maxWidth: 680, fontSize: 14 }}>
        <strong>Свайное поле {data.field_code}</strong>
        <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
          {data.pk_start != null && data.pk_end != null
            ? `${formatDbPK(data.pk_start)} — ${formatDbPK(data.pk_end)}`
            : (data.pk_raw_text ?? '—')}
        </div>
        <table style={tblStyle}>
          <tbody>
            <tr><td style={tdL}>Тип поля</td><td style={tdR}>{data.field_type === 'main' ? 'основное' : 'пробное'}</td></tr>
            <tr><td style={tdL}>Тип свай</td><td style={tdR}>{data.pile_type}</td></tr>
            <tr><td style={tdL}>Свай</td><td style={tdR}>{data.pile_count}</td></tr>
            <tr><td style={tdL}>Испытаний</td><td style={tdR}>{data.dynamic_test_count ?? 0}</td></tr>
          </tbody>
        </table>
        {data.works_summary && data.works_summary.length > 0 ? (
          <div style={{ marginTop: 6 }}>
            <div style={hdr}>Работы: план / факт на дату</div>
            <table style={tblStyle}>
              <thead>
                <tr>
                  <th style={{ ...tdL, fontWeight: 600 }}>Работа</th>
                  <th style={{ ...tdR, fontWeight: 600 }}>Проект</th>
                  <th style={{ ...tdR, fontWeight: 600 }}>Факт</th>
                  <th style={{ ...tdR, fontWeight: 600 }}>%</th>
                </tr>
              </thead>
              <tbody>
                {data.works_summary.map((r, i) => (
                  <tr key={i}>
                    <td style={tdL}>{workLabel(r, data.pile_type)}</td>
                    <td style={tdR}>{r.project_volume != null ? `${fmt(r.project_volume)} ${r.unit ?? ''}` : '—'}</td>
                    <td style={tdR}>{fmt(r.completed_volume ?? 0)} {r.unit ?? ''}</td>
                    <td style={tdR}>{r.completion_pct != null ? `${Math.round(r.completion_pct)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data.project_works && data.project_works.length > 0 ? (
          <div style={{ marginTop: 6 }}>
            <div style={hdr}>Плановые объёмы</div>
            <table style={tblStyle}>
              <tbody>
                {data.project_works.map((r, i) => (
                  <tr key={i}>
                    <td style={tdL}>{workLabel(r, data.pile_type)}</td>
                    <td style={tdR}>{fmt(r.project_volume)} {r.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ marginTop: 6, color: '#888', fontSize: 12 }}>Нет данных по работам</div>
        )}
      </div>
    )
  }

  // kind === 'object' — формат ПК всегда «ПК####+##.##», игнорируем pk_raw_text
  // из БД (там может лежать «323730.67-324037.27» — сырые метры).
  const pkRange = data.pk_start != null
    ? `${formatDbPK(data.pk_start)}${data.pk_end != null ? ` — ${formatDbPK(data.pk_end)}` : ''}`
    : (data.pk_raw_text ?? null)

  return (
    <div style={{ minWidth: 420, maxWidth: 680, fontSize: 14 }}>
      <strong>{data.name ?? data.object_code}</strong>
      <div style={{ color: '#666', fontSize: 12 }}>{data.type_name}</div>
      {pkRange && <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>{pkRange}</div>}

      {data.works_summary && data.works_summary.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>Работы: план / факт</div>
          <table style={tblStyle}>
            <thead>
              <tr>
                <th style={thL}>Работа</th>
                <th style={thR}>Проект</th>
                <th style={thR}>Факт</th>
                <th style={thR}>%</th>
              </tr>
            </thead>
            <tbody>
              {data.works_summary.map((r, i) => (
                <tr key={i}>
                  <td style={tdL}>{workLabel(r, data.pile_type)}</td>
                  <td style={tdR}>
                    {r.project_volume != null ? `${fmt(r.project_volume)} ${r.unit ?? ''}` : '—'}
                  </td>
                  <td style={tdR}>
                    {r.completed_volume > 0 ? `${fmt(r.completed_volume)} ${r.unit ?? ''}` : '—'}
                  </td>
                  <td style={tdR}>{r.completion_pct != null ? `${r.completion_pct}%` : '—'}</td>
                </tr>
              ))}
              {data.works_total && (
                <tr>
                  <td style={tdTotalL}>Итого по объекту</td>
                  <td style={tdTotalR}>
                    {data.works_total.project_volume != null ? fmt(data.works_total.project_volume) : '—'}
                  </td>
                  <td style={tdTotalR}>{fmt(data.works_total.completed_volume)}</td>
                  <td style={tdTotalR}>
                    {data.works_total.completion_pct != null ? `${data.works_total.completion_pct}%` : '—'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data.works_summary && data.works_summary.length === 0 && (
        <div style={{ marginTop: 6, color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          Нет плановых объёмов
        </div>
      )}

      {data.day && data.day.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>За {dateISO}</div>
          <table style={tblStyle}>
            <tbody>
              {data.day.map((r, i) => (
                <tr key={i}>
                  <td style={tdL}>{workLabel(r, data.pile_type)}</td>
                  <td style={tdR}>{r.volume} {r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.cumulative && data.cumulative.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>Накопительно</div>
          <table style={tblStyle}>
            <tbody>
              {data.cumulative.slice(0, 8).map((r, i) => (
                <tr key={i}>
                  <td style={tdL}>{workLabel(r, data.pile_type)}</td>
                  <td style={tdR}>{r.volume} {r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.quarry_shipments && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>Вывоз на {dateISO}</div>
          {data.quarry_shipments.length > 0 ? (
            <table style={tblStyle}>
              <tbody>
                {data.quarry_shipments.map((r, i) => (
                  <tr key={i}>
                    <td style={tdL}>{r.material}</td>
                    <td style={tdR}>{fmt(r.volume)} {r.unit}{r.trips ? ` · ${r.trips} рейс.` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#888', fontSize: 12 }}>На выбранную дату вывоза не найдено</div>
          )}
        </div>
      )}

      {data.stockpile_balances && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>Остаток накопителя</div>
          {data.stockpile_balances.length > 0 ? (
            <table style={tblStyle}>
              <tbody>
                {data.stockpile_balances.map((r, i) => (
                  <tr key={r.stockpile_id || i}>
                    <td style={tdL}>
                      <div>{r.material}</div>
                      <div style={{ color: '#888', fontSize: 11 }}>
                        {pkRange ? `${pkRange} · ` : ''}{r.snapshot_date ? `срез ${r.snapshot_date}` : 'срез не найден'}
                      </div>
                    </td>
                    <td style={tdR}>{r.volume == null ? '—' : `${fmt(r.volume)} ${r.unit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#888', fontSize: 12 }}>Для накопителя нет срезов остатков</div>
          )}
        </div>
      )}

      {data.recent_movements && data.recent_movements.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={hdr}>Движение материала (30 дн.)</div>
          <table style={tblStyle}>
            <tbody>
              {data.recent_movements.map((r, i) => (
                <tr key={i}>
                  <td style={tdL}>{r.material}</td>
                  <td style={tdR}>{r.volume} · {r.count}шт</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const tblStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
}
// Текстовая колонка «Работа» — обычный шрифт.
const tdL: React.CSSProperties = { padding: '4px 6px', borderBottom: '1px solid #eee', color: '#333' }
// Числовые — моно.
const tdR: React.CSSProperties = {
  padding: '4px 6px', borderBottom: '1px solid #eee', textAlign: 'right', whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, monospace',
}
const thL: React.CSSProperties = {
  padding: '4px 6px', borderBottom: '1px solid #ccc', textAlign: 'left',
  fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase',
}
const thR: React.CSSProperties = {
  padding: '4px 6px', borderBottom: '1px solid #ccc', textAlign: 'right', whiteSpace: 'nowrap',
  fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase',
}
const hdr: React.CSSProperties = {
  fontSize: 11, textTransform: 'uppercase', letterSpacing: 0,
  color: '#888', fontWeight: 700, marginBottom: 2,
}
// Итог по объекту — выделенный стиль в духе Excel: двойная отсечка сверху, серый фон, bold.
const tdTotalL: React.CSSProperties = {
  padding: '5px 6px', borderTop: '2px solid #333', background: '#f3f4f6',
  color: '#111', fontWeight: 700,
}
const tdTotalR: React.CSSProperties = {
  padding: '5px 6px', borderTop: '2px solid #333', background: '#f3f4f6',
  textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700,
  fontFamily: 'ui-monospace, monospace',
}
