"""
Map-specific endpoints for the /map page (v3).

Подключение в api/main.py:
    from wip_map_routes import router as wip_map_router
    app.include_router(wip_map_router)

Эндпоинты:
  GET /api/wip/map/equipment-positions?date=YYYY-MM-DD
    Позиции техники на дату. Для каждой группы
    (equipment_type × объект/pk × участок) одна запись с latitude/longitude,
    списком units.

  GET /api/wip/map/object-info?id=<object_code_or_field_code>&date=YYYY-MM-DD&type=<kind>
    Детали по объекту для popup карты.
"""
from __future__ import annotations

import re
from datetime import date as date_cls
from typing import Optional

from fastapi import APIRouter, Query, HTTPException

from main import query, query_one  # noqa: E402

router = APIRouter(prefix="/api/wip/map", tags=["wip-map"])

_PILE_WORK_LABELS = {
    'PILE_MAIN': 'Забивка основных свай',
    'PILE_TRIAL': 'Забивка пробных свай',
    'PILE_DYNTEST': 'Динамические испытания свай',
}


def _pile_control_report_condition(report_alias: str = 'dr') -> str:
    return (
        f"(COALESCE({report_alias}.source_type, '') = 'web_pile_control' "
        f"OR COALESCE({report_alias}.review_payload->'review_flags', '[]'::jsonb) ?| ARRAY['isso', 'контроль свай'])"
    )


def _approved_non_pile_control_report_condition(report_alias: str = 'dr') -> str:
    return (
        f"COALESCE({report_alias}.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review') "
        f"AND NOT {_pile_control_report_condition(report_alias)}"
    )


def _map_column_exists(table_name: str, column_name: str) -> bool:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", table_name or ""):
        return False
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", column_name or ""):
        return False
    try:
        row = query_one(
            """
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
            ) AS exists
            """,
            (table_name, column_name),
        )
    except Exception:
        return False
    return bool(row and row.get("exists"))


def _temp_road_project_where(alias: str = "tr") -> str:
    if _map_column_exists("temporary_roads", "display_in_dashboard"):
        return f"COALESCE({alias}.display_in_dashboard, true) IS TRUE"
    return "TRUE"


def _pile_length_label(pile_type: Optional[str]) -> Optional[str]:
    value = (pile_type or '').strip()
    if not value:
        return None
    text = value.upper().replace('C', 'С')
    # Composite marks are stored as e.g. С140.35-НС.6+С140.35-ВС.6;
    # displayed length is the total length of all components (28 м), not the first part.
    if ';' not in text:
        matches = [int(m) for m in re.findall(r'С\s*(\d{2,3})', text, re.IGNORECASE)]
        if matches:
            length_m = sum(matches) / 10
            return f"{length_m:g} м"
        direct = re.fullmatch(r"\s*(\d{1,2})(?:[\.,]0+)?\s*(?:м)?\s*", text, re.IGNORECASE)
        if direct:
            return f"{int(direct.group(1)):g} м"
    return None


def _pile_work_label(code: str, fallback: Optional[str], pile_type: Optional[str]) -> str:
    base = _PILE_WORK_LABELS.get(code) or fallback or code
    if code in ('PILE_MAIN', 'PILE_TRIAL'):
        length = _pile_length_label(pile_type)
        if length and length not in base:
            return f"{base} {length}"
    return base


# Нормализация типа техники: БД-шные русские/англ → канонический код.
_EQUIP_NORM_SQL = """
  CASE LOWER(reu.equipment_type)
    WHEN 'самосвал'      THEN 'dump_truck'
    WHEN 'dump_truck'    THEN 'dump_truck'
    WHEN 'экскаватор'    THEN 'excavator'
    WHEN 'excavator'     THEN 'excavator'
    WHEN 'бульдозер'     THEN 'bulldozer'
    WHEN 'bulldozer'     THEN 'bulldozer'
    WHEN 'автогрейдер'   THEN 'motor_grader'
    WHEN 'грейдер'       THEN 'motor_grader'
    WHEN 'motor_grader'  THEN 'motor_grader'
    WHEN 'каток'         THEN 'road_roller'
    WHEN 'виброкаток'    THEN 'road_roller'
    WHEN 'road_roller'   THEN 'road_roller'
    WHEN 'копер'         THEN 'pile_driver'
    WHEN 'копёр'         THEN 'pile_driver'
    WHEN 'pile_driver'   THEN 'pile_driver'
    ELSE 'other'
  END
"""


@router.get("/equipment-positions")
def equipment_positions(date: str = Query(...)):
    """
    Для заданной даты собираем позиции техники по объектам.

    Источники:
      1) work_item_equipment_usage → daily_work_items → object_segments.
      2) material_movement_equipment_usage → material_movements (from_object_id) →
         object_segments.

    Так как daily_work_item_segments пустая, pk берём из object_segments
    (первый сегмент объекта), а координаты — из его start_lat/start_lng.
    Если у объекта нет координат, позиция из серединного ПК участка,
    расчёт lat/lng по route_pickets (берём ближайший пикет).
    """
    try:
        d = date_cls.fromisoformat(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid date: {exc}") from exc

    # ── 1. Работы: для каждой usage-записи вычисляем позицию + метаданные ──
    # Фолбек через секцию по её mid_pk, затем ближайший picket.
    work_rows = query(
        f"""
        WITH first_seg AS (
          SELECT DISTINCT ON (object_id)
                 object_id, pk_start, pk_end, start_lat, start_lng
          FROM object_segments
          ORDER BY object_id, pk_start
        )
        SELECT
          dwi.id            AS work_id,
          reu.id            AS unit_id,
          cs.code           AS section_code,
          ot.code           AS object_type,
          o.object_code     AS object_code,
          o.name            AS object_name,
          fs.pk_start       AS obj_pk_start,
          fs.pk_end         AS obj_pk_end,
          fs.start_lat      AS obj_lat,
          fs.start_lng      AS obj_lng,
          csv.pk_start      AS sec_pk_start,
          csv.pk_end        AS sec_pk_end,
          wt.name           AS work_name,
          dwi.volume        AS volume,
          dwi.unit          AS unit,
          COALESCE(NULLIF(reu.contractor_name, ''), dwi.contractor_name, '') AS contractor,
          reu.equipment_type AS raw_type,
          {_EQUIP_NORM_SQL}  AS eq_type,
          reu.plate_number   AS plate,
          reu.unit_number    AS unit_number,
          reu.ownership_type AS ownership_type,
          reu.brand_model    AS brand,
          wieu.worked_volume AS worked_volume,
          wieu.trips_count   AS trips
        FROM work_item_equipment_usage wieu
        JOIN daily_work_items dwi ON dwi.id = wieu.daily_work_item_id
        JOIN report_equipment_units reu ON reu.id = wieu.report_equipment_unit_id
        JOIN objects o ON o.id = dwi.object_id
        JOIN object_types ot ON ot.id = o.object_type_id
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN construction_sections cs ON cs.id = dwi.section_id
        LEFT JOIN construction_section_versions csv
          ON csv.section_id = cs.id AND csv.is_current = true AND csv.boundary_kind = 'main'
        LEFT JOIN first_seg fs ON fs.object_id = dwi.object_id
        WHERE dwi.report_date = %s
        """,
        (d,),
    )

    # ── 2. Возка материала: позицию берём с from_object (карьер/накопитель) ──
    mov_rows = query(
        f"""
        WITH first_seg AS (
          SELECT DISTINCT ON (object_id)
                 object_id, pk_start, pk_end, start_lat, start_lng
          FROM object_segments
          ORDER BY object_id, pk_start
        )
        SELECT
          mm.id             AS mov_id,
          reu.id            AS unit_id,
          cs.code           AS section_code,
          ot.code           AS from_type,
          ofrom.object_code AS from_code,
          ofrom.name        AS from_name,
          fs.pk_start       AS obj_pk_start,
          fs.pk_end         AS obj_pk_end,
          fs.start_lat      AS obj_lat,
          fs.start_lng      AS obj_lng,
          csv.pk_start      AS sec_pk_start,
          csv.pk_end        AS sec_pk_end,
          m.name            AS material,
          mm.volume         AS volume,
          mm.unit           AS unit,
          COALESCE(NULLIF(reu.contractor_name, ''), mm.contractor_name, '') AS contractor,
          reu.equipment_type AS raw_type,
          {_EQUIP_NORM_SQL}  AS eq_type,
          reu.plate_number   AS plate,
          reu.unit_number    AS unit_number,
          reu.ownership_type AS ownership_type,
          reu.brand_model    AS brand,
          mmeu.worked_volume AS worked_volume,
          mmeu.trips_count   AS trips
        FROM material_movement_equipment_usage mmeu
        JOIN material_movements mm ON mm.id = mmeu.material_movement_id
        JOIN report_equipment_units reu ON reu.id = mmeu.report_equipment_unit_id
        JOIN objects ofrom ON ofrom.id = mm.from_object_id
        JOIN object_types ot ON ot.id = ofrom.object_type_id
        JOIN materials m ON m.id = mm.material_id
        LEFT JOIN construction_sections cs ON cs.id = mm.section_id
        LEFT JOIN construction_section_versions csv
          ON csv.section_id = cs.id AND csv.is_current = true AND csv.boundary_kind = 'main'
        LEFT JOIN first_seg fs ON fs.object_id = mm.from_object_id
        WHERE mm.report_date = %s
        """,
        (d,),
    )

    # pickets для фолбека — кэшируем
    pickets = query(
        "SELECT pk_number, latitude, longitude FROM route_pickets ORDER BY pk_number"
    )
    picket_list = [(int(p['pk_number']), float(p['latitude']), float(p['longitude']))
                   for p in pickets]

    def find_coord_by_pk(pk: float) -> tuple[float, float] | None:
        """Ближайший picket по pk (pk здесь — это ПК в единицах «сотых», т.е. pk_start из БД)."""
        if not picket_list:
            return None
        # pk в БД хранится как pk_number * 100 + m, ПК=1 → 100.00 в таблице. route_pickets.pk_number — целый.
        target = pk / 100.0
        best = min(picket_list, key=lambda p: abs(p[0] - target))
        return (best[1], best[2])

    # Агрегация: ключ (section, object_code, eq_type)
    groups: dict[tuple, dict] = {}

    def _get_position(obj_lat, obj_lng, obj_pk_start, sec_pk_start, sec_pk_end):
        """Возвращает (lat, lng, pk) с фолбэками."""
        pk_val: float | None = None
        if obj_pk_start is not None:
            pk_val = float(obj_pk_start)
        elif sec_pk_start is not None and sec_pk_end is not None:
            pk_val = (float(sec_pk_start) + float(sec_pk_end)) / 2.0

        if obj_lat is not None and obj_lng is not None:
            return float(obj_lat), float(obj_lng), pk_val
        if pk_val is not None:
            coord = find_coord_by_pk(pk_val)
            if coord:
                return coord[0], coord[1], pk_val
        return None, None, pk_val

    def _add_unit(g: dict, row: dict, work_name: str, volume: float, total_volume: float, unit: str) -> None:
        plate = row.get('plate') or ''
        unit_number = row.get('unit_number') or ''
        unit_key = plate or unit_number or str(row.get('unit_id') or '')
        row_volume = float(volume or 0)
        row_total = float(total_volume or 0)
        trips = int(row.get('trips') or 0)
        slot = g['units_by_plate'].get(unit_key)
        if slot is None:
            g['units_by_plate'][unit_key] = {
                'plate': plate,
                'unit_number': unit_number,
                'brand': row.get('brand') or '',
                'work_name': work_name,
                'volume': row_volume,
                'total_volume': row_total,
                'unit': unit or '',
                'contractor': row.get('contractor') or '',
                'ownership_type': row.get('ownership_type') or 'unknown',
                'trips': trips,
            }
            return
        if work_name and work_name not in slot['work_name']:
            slot['work_name'] = f"{slot['work_name']}; {work_name}" if slot['work_name'] else work_name
        slot['volume'] += row_volume
        slot['total_volume'] += row_total
        slot['trips'] += trips
        if not slot.get('contractor') and row.get('contractor'):
            slot['contractor'] = row.get('contractor') or ''
        if (slot.get('ownership_type') or 'unknown') == 'unknown' and row.get('ownership_type'):
            slot['ownership_type'] = row.get('ownership_type') or 'unknown'

    # Работы
    for r in work_rows:
        if r['eq_type'] == 'other':
            continue
        lat, lng, pk = _get_position(
            r['obj_lat'], r['obj_lng'],
            r['obj_pk_start'], r['sec_pk_start'], r['sec_pk_end'],
        )
        if lat is None or lng is None:
            continue
        key = (r['section_code'] or '', r['object_code'] or '', r['eq_type'])
        g = groups.setdefault(key, {
            'latitude': lat,
            'longitude': lng,
            'pk': int(pk / 100) if pk is not None else None,
            'pk_raw': float(pk) if pk is not None else None,
            'section_code': r['section_code'],
            'object_code': r['object_code'],
            'object_name': r['object_name'],
            'object_type': r['object_type'],
            'equipment_type': r['eq_type'],
            'count': 0,
            'units_by_plate': {},
        })
        _add_unit(
            g,
            r,
            r['work_name'] or '',
            float(r['worked_volume']) if r['worked_volume'] is not None else (float(r['volume']) if r['volume'] is not None else 0.0),
            float(r['volume']) if r['volume'] is not None else 0.0,
            r['unit'] or '',
        )

    # Возка
    for r in mov_rows:
        if r['eq_type'] == 'other':
            continue
        lat, lng, pk = _get_position(
            r['obj_lat'], r['obj_lng'],
            r['obj_pk_start'], r['sec_pk_start'], r['sec_pk_end'],
        )
        if lat is None or lng is None:
            continue
        key = (r['section_code'] or '', r['from_code'] or '', r['eq_type'])
        g = groups.setdefault(key, {
            'latitude': lat,
            'longitude': lng,
            'pk': int(pk / 100) if pk is not None else None,
            'pk_raw': float(pk) if pk is not None else None,
            'section_code': r['section_code'],
            'object_code': r['from_code'],
            'object_name': r['from_name'],
            'object_type': r['from_type'],
            'equipment_type': r['eq_type'],
            'count': 0,
            'units_by_plate': {},
        })
        _add_unit(
            g,
            r,
            f"Возка {r['material'] or ''}".strip(),
            float(r['worked_volume']) if r['worked_volume'] is not None else (float(r['volume']) if r['volume'] is not None else 0.0),
            float(r['volume']) if r['volume'] is not None else 0.0,
            r['unit'] or '',
        )

    # Собрать ответ
    out = []
    for (_sec, _obj, _eq), g in groups.items():
        units = []
        for plate, info in g['units_by_plate'].items():
            pct = None
            if info['total_volume'] and info['volume']:
                try:
                    pct = round(float(info['volume']) / float(info['total_volume']) * 100.0, 1)
                except ZeroDivisionError:
                    pct = None
            volume = round(info['volume'], 2)
            unit = info['unit'] or ''
            units.append({
                'plate': info['plate'],
                'unit_number': info.get('unit_number') or '',
                'brand': info['brand'],
                'work_name': info['work_name'],
                'volume': volume,
                'unit': unit,
                'percent': pct,
                'productivity': pct,
                'productivity_label': f"{pct:g}%" if pct is not None else '—',
                'ownership_type': info.get('ownership_type') or 'unknown',
                'contractor': info['contractor'],
                'trips': info['trips'],
            })
        out.append({
            'latitude': g['latitude'],
            'longitude': g['longitude'],
            'pk': g['pk'],
            'section_code': g['section_code'],
            'object_code': g['object_code'],
            'object_name': g['object_name'],
            'object_type': g['object_type'],
            'equipment_type': g['equipment_type'],
            'count': len(units),
            'units': units,
        })

    return {'date': d.isoformat(), 'rows': out}


@router.get("/object-info")
def object_info(
    id: str = Query(..., description="object_code или field_code"),
    date: Optional[str] = Query(None),
    type: Optional[str] = Query(None, description="object_type.code или 'pile_field'"),
):
    """
    Детализация объекта для popup на карте.

    type:
      - pile_field          → pile_fields (id = field_code)
      - MAIN_TRACK          → сегмент основного хода: work totals за дату и кумулятив
      - BRIDGE / PIPE / OVERPASS / INTERSECTION_* → meta из objects+object_segments
      - BORROW_PIT / STOCKPILE → последние material_movements
    """
    d = date_cls.fromisoformat(date) if date else date_cls.today()

    if type == 'pile_field':
        row = query_one(
            """
            SELECT id, field_code, field_type, pile_type, pile_count,
                   dynamic_test_count, pk_start, pk_end, pk_raw_text,
                   start_lat, start_lng
            FROM pile_fields
            WHERE (field_code = %s OR id::text = %s)
              AND is_demo IS NOT TRUE
            ORDER BY pk_start NULLS LAST
            LIMIT 1
            """,
            (id, id),
        )
        if not row:
            raise HTTPException(status_code=404, detail="pile field not found")

        # Для свайных полей проектные значения лежат в самой карточке поля:
        # pile_count / dynamic_test_count. В project_work_items нет объекта
        # с object_code=field_code, поэтому прежняя связка оставляла PILE_MAIN
        # без проектного объёма.
        work_type_rows = query(
            """
            SELECT code, name, default_unit
            FROM work_types
            WHERE code = ANY(%s)
            """,
            (['PILE_MAIN', 'PILE_TRIAL', 'PILE_DYNTEST'],),
        )
        work_meta = {r['code']: r for r in work_type_rows}

        # Факт per work_type на дату <= d (накопительно).
        fact_rows = query(
            f"""
            SELECT wt.code AS wt_code,
                   MIN(wt.name) AS work,
                   COALESCE(NULLIF(dwi.unit, ''), wt.default_unit, 'шт') AS unit,
                   SUM(COALESCE(seg.volume_segment, dwi.volume, 0))::numeric AS v
            FROM daily_work_items dwi
            JOIN daily_reports dr ON dr.id = dwi.daily_report_id
            JOIN work_types wt ON wt.id = dwi.work_type_id
            JOIN daily_work_item_segments seg ON seg.daily_work_item_id = dwi.id
            WHERE seg.pile_field_id = %s AND dwi.report_date <= %s
              AND COALESCE(dwi.is_demo, false) IS FALSE
              AND COALESCE(seg.is_demo, false) IS FALSE
              AND {_approved_non_pile_control_report_condition('dr')}
            GROUP BY wt.code, COALESCE(NULLIF(dwi.unit, ''), wt.default_unit, 'шт')
            """,
            (row['id'], d),
        )
        fact_by_wt: dict[str, dict] = {}
        for r in fact_rows:
            code = r['wt_code']
            slot = fact_by_wt.setdefault(code, {
                'work': r['work'],
                'unit': r['unit'] or 'шт',
                'done': 0.0,
            })
            slot['done'] += float(r['v'] or 0)

        field_type = str(row['field_type'] or '').lower()
        primary_work_code = 'PILE_TRIAL' if ('trial' in field_type or 'test' in field_type or 'проб' in field_type) else 'PILE_MAIN'
        planned: list[tuple[str, float]] = []
        if row['pile_count'] is not None:
            planned.append((primary_work_code, float(row['pile_count'] or 0)))
        if row['dynamic_test_count'] is not None and float(row['dynamic_test_count'] or 0) > 0:
            planned.append(('PILE_DYNTEST', float(row['dynamic_test_count'] or 0)))

        # Собираем combined works_summary с project + completed + %.
        works_summary: list[dict] = []
        project_works: list[dict] = []
        for wt_code, proj in planned:
            meta = work_meta.get(wt_code) or {}
            fact = fact_by_wt.pop(wt_code, None)
            unit = (meta.get('default_unit') or (fact or {}).get('unit') or 'шт')
            done = float((fact or {}).get('done') or 0.0)
            label = _pile_work_label(wt_code, meta.get('name'), row['pile_type'])
            project_works.append({
                'work_code': wt_code,
                'work': label,
                'unit': unit,
                'project_volume': proj,
            })
            works_summary.append({
                'work_code': wt_code,
                'work': label,
                'unit': unit,
                'project_volume': proj, 'completed_volume': done,
                'completion_pct': round(done / proj * 100, 1) if proj > 0 else None,
            })
        # Факты по тем work_type, которых нет в проекте — добавляем с project=null.
        for wt_code, fact in fact_by_wt.items():
            works_summary.append({
                'work_code': wt_code,
                'work': _pile_work_label(wt_code, fact.get('work'), row['pile_type']),
                'unit': fact.get('unit') or 'шт',
                'project_volume': None,
                'completed_volume': float(fact.get('done') or 0),
                'completion_pct': None,
            })

        return {
            'kind': 'pile_field',
            'field_code': row['field_code'],
            'field_type': row['field_type'],
            'pile_type': row['pile_type'],
            'pile_count': row['pile_count'],
            'dynamic_test_count': row['dynamic_test_count'] or 0,
            'pk_start': float(row['pk_start']) if row['pk_start'] is not None else None,
            'pk_end': float(row['pk_end']) if row['pk_end'] is not None else None,
            'pk_raw_text': row['pk_raw_text'],
            'date': d.isoformat(),
            'works_summary': works_summary,
            'works_total': {
                'project_volume': sum(w['project_volume'] or 0 for w in works_summary if w['project_volume'] is not None) or None,
                'completed_volume': sum(w['completed_volume'] or 0 for w in works_summary),
            },
            # Оставлено для обратной совместимости.
            'project_works': project_works,
        }

    # Все остальные — по object_code
    obj = query_one(
        """
        SELECT o.id, o.object_code, o.name, ot.code AS type_code, ot.name AS type_name,
               os.pk_start, os.pk_end, os.pk_raw_text
        FROM objects o
        JOIN object_types ot ON ot.id = o.object_type_id
        LEFT JOIN object_segments os ON os.object_id = o.id
        WHERE o.object_code = %s
          AND o.is_active IS NOT FALSE
          AND ot.is_active IS NOT FALSE
        ORDER BY os.pk_start NULLS LAST
        LIMIT 1
        """,
        (id,),
    )
    if not obj:
        raise HTTPException(status_code=404, detail="object not found")

    res: dict = {
        'kind': 'object',
        'type_code': obj['type_code'],
        'type_name': obj['type_name'],
        'object_code': obj['object_code'],
        'name': obj['name'],
        'pk_start': float(obj['pk_start']) if obj['pk_start'] is not None else None,
        'pk_end': float(obj['pk_end']) if obj['pk_end'] is not None else None,
        'pk_raw_text': obj['pk_raw_text'],
    }

    # Для линейных и точечных строительных объектов собираем сводку
    # план vs факт по типам работ (project_work_items vs daily_work_items).
    if obj['type_code'] in ('MAIN_TRACK', 'TEMP_ROAD', 'BRIDGE', 'PIPE', 'OVERPASS'):
        # Кумулятивные работы до даты включительно
        cum = query(
            """
            SELECT wt.name AS work, dwi.unit, SUM(dwi.volume)::numeric AS v
            FROM daily_work_items dwi
            JOIN work_types wt ON wt.id = dwi.work_type_id
            WHERE dwi.object_id = %s AND dwi.report_date <= %s
            GROUP BY wt.name, dwi.unit
            ORDER BY v DESC
            """,
            (obj['id'], d),
        )
        day = query(
            """
            SELECT wt.name AS work, dwi.unit, SUM(dwi.volume)::numeric AS v
            FROM daily_work_items dwi
            JOIN work_types wt ON wt.id = dwi.work_type_id
            WHERE dwi.object_id = %s AND dwi.report_date = %s
            GROUP BY wt.name, dwi.unit
            ORDER BY v DESC
            """,
            (obj['id'], d),
        )
        res['cumulative'] = [
            {'work': r['work'], 'unit': r['unit'], 'volume': round(float(r['v'] or 0), 2)}
            for r in cum
        ]
        res['day'] = [
            {'work': r['work'], 'unit': r['unit'], 'volume': round(float(r['v'] or 0), 2)}
            for r in day
        ]

        # Сводка план/факт/% по типам работ.
        # FULL OUTER JOIN, чтобы показать и план-строки без факта, и наоборот.
        # Агрегируем по work_type_id (единица — из плана, иначе из факта).
        summary = query(
            """
            WITH plan AS (
                SELECT pwi.work_type_id,
                       MIN(wt.name) AS work,
                       MIN(pwi.unit) AS unit,
                       SUM(pwi.project_volume)::numeric AS project_volume
                FROM project_work_items pwi
                JOIN work_types wt ON wt.id = pwi.work_type_id
                WHERE pwi.object_id = %s
                GROUP BY pwi.work_type_id
            ),
            fact AS (
                SELECT dwi.work_type_id,
                       MIN(wt.name) AS work,
                       MIN(dwi.unit) AS unit,
                       SUM(dwi.volume)::numeric AS completed_volume
                FROM daily_work_items dwi
                JOIN work_types wt ON wt.id = dwi.work_type_id
                WHERE dwi.object_id = %s AND dwi.report_date <= %s
                GROUP BY dwi.work_type_id
            )
            SELECT COALESCE(plan.work, fact.work) AS work,
                   COALESCE(plan.unit, fact.unit) AS unit,
                   plan.project_volume,
                   fact.completed_volume
            FROM plan
            FULL OUTER JOIN fact ON fact.work_type_id = plan.work_type_id
            ORDER BY plan.project_volume DESC NULLS LAST,
                     fact.completed_volume DESC NULLS LAST
            """,
            (obj['id'], obj['id'], d),
        )
        works_summary = []
        total_plan = 0.0
        total_fact = 0.0
        for r in summary:
            pv = float(r['project_volume'] or 0)
            cv = float(r['completed_volume'] or 0)
            pct = round(cv / pv * 100.0, 1) if pv > 0 else None
            works_summary.append({
                'work': r['work'],
                'unit': r['unit'],
                'project_volume': round(pv, 2) if r['project_volume'] is not None else None,
                'completed_volume': round(cv, 2),
                'completion_pct': pct,
            })
            total_plan += pv
            total_fact += cv
        res['works_summary'] = works_summary
        res['works_total'] = {
            'project_volume': round(total_plan, 2) if total_plan > 0 else None,
            'completed_volume': round(total_fact, 2),
            'completion_pct': round(total_fact / total_plan * 100.0, 1) if total_plan > 0 else None,
        }
    if obj['type_code'] in ('BORROW_PIT', 'STOCKPILE'):
        mov = query(
            """
            SELECT m.name AS material, mm.movement_type, SUM(mm.volume)::numeric AS v,
                   COUNT(*) AS n
            FROM material_movements mm
            JOIN materials m ON m.id = mm.material_id
            WHERE (mm.from_object_id = %s OR mm.to_object_id = %s)
              AND mm.report_date <= %s
              AND mm.report_date >= %s - INTERVAL '30 days'
            GROUP BY m.name, mm.movement_type
            ORDER BY v DESC
            """,
            (obj['id'], obj['id'], d, d),
        )
        res['recent_movements'] = [
            {'material': r['material'], 'movement_type': r['movement_type'],
             'volume': round(float(r['v'] or 0), 2), 'count': int(r['n'])}
            for r in mov
        ]

    if obj['type_code'] == 'BORROW_PIT':
        shipments = query(
            """
            SELECT m.name AS material, COALESCE(NULLIF(mm.unit, ''), m.default_unit, 'м3') AS unit,
                   SUM(mm.volume)::numeric AS volume,
                   COALESCE(SUM(mm.trip_count), 0)::int AS trips
            FROM material_movements mm
            JOIN materials m ON m.id = mm.material_id
            WHERE mm.from_object_id = %s
              AND mm.report_date = %s
              AND COALESCE(mm.is_demo, false) IS FALSE
              AND COALESCE(mm.review_tag, '') = ''
              AND mm.movement_type IN ('pit_to_stockpile', 'pit_to_constructive')
            GROUP BY m.name, COALESCE(NULLIF(mm.unit, ''), m.default_unit, 'м3')
            ORDER BY volume DESC
            """,
            (obj['id'], d),
        )
        res['quarry_shipments'] = [
            {
                'material': r['material'] or 'Материал',
                'unit': r['unit'] or 'м3',
                'volume': round(float(r['volume'] or 0), 2),
                'trips': int(r['trips'] or 0),
                'date': d.isoformat(),
            }
            for r in shipments
        ]

    if obj['type_code'] == 'STOCKPILE':
        balances = query(
            """
              SELECT sp.id AS stockpile_id, sp.name AS stockpile_name,
                     m.name AS material, s.snapshot_date, s.balance_volume, s.unit,
                     COALESCE(s.review_tag, '') <> '' AS is_pending_review,
                     CASE
                       WHEN s.review_tag ~ '^pending_admin_review:[0-9a-fA-F-]{36}$'
                         THEN substring(s.review_tag from 'pending_admin_review:([0-9a-fA-F-]{36})')
                       ELSE NULL
                     END AS report_id
              FROM stockpiles sp
              JOIN materials m ON m.id = sp.material_id
              LEFT JOIN LATERAL (
                SELECT snapshot_date, balance_volume, unit, review_tag
                FROM stockpile_balance_snapshots s
                WHERE s.stockpile_id = sp.id
                  AND s.snapshot_date <= %s
                  AND COALESCE(s.is_demo, false) IS FALSE
                ORDER BY s.snapshot_date DESC
                LIMIT 1
              ) s ON true
            WHERE sp.object_id = %s
              AND sp.is_active IS NOT FALSE
            ORDER BY m.name, sp.name
            """,
            (d, obj['id']),
        )
        res['stockpile_balances'] = [
            {
                'stockpile_id': str(r['stockpile_id']),
                'stockpile_name': r['stockpile_name'] or obj['name'],
                  'material': r['material'] or 'Материал',
                  'snapshot_date': r['snapshot_date'].isoformat() if r.get('snapshot_date') else None,
                  'volume': round(float(r['balance_volume'] or 0), 2) if r.get('balance_volume') is not None else None,
                  'unit': r['unit'] or 'м3',
                  'is_pending_review': bool(r.get('is_pending_review')),
                  'review_status': 'pending_review' if r.get('is_pending_review') else 'confirmed',
                  'report_id': str(r['report_id']) if r.get('report_id') else None,
              }
            for r in balances
        ]

    return res


# ── temp roads polyline ────────────────────────────────────────────────

@router.get("/temp-roads")
def temp_roads_polylines():
    """Возвращает полилинии временных притрассовых дорог (координаты точек).

    Shape:
      { roads: [
          { road_code, road_name, length_m, points: [{lat, lng, pk_label?}] }
        ] }
    """
    rows = query(
        f"""
        SELECT trp.road_code, tr.road_name,
               ABS(tr.ad_end_pk - tr.ad_start_pk) AS length_m,
               trp.seq_no, trp.latitude, trp.longitude, trp.pk_label
        FROM temp_road_points trp
        LEFT JOIN temporary_roads tr ON tr.id = trp.road_id
        WHERE {_temp_road_project_where('tr')}
        ORDER BY trp.road_code, trp.seq_no
        """
    )
    by_road: dict[str, dict] = {}
    for r in rows:
        code = r['road_code']
        entry = by_road.setdefault(code, {
            'road_code': code, 'road_name': r['road_name'] or code,
            'length_m': float(r['length_m']) if r['length_m'] is not None else None,
            'points': []
        })
        entry['points'].append({
            'lat': float(r['latitude']),
            'lng': float(r['longitude']),
            'pk_label': r['pk_label'],
        })
    return {'roads': list(by_road.values())}
