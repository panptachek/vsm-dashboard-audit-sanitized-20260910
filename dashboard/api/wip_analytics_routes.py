"""
Analytics & Map endpoints — дополнение к wip_routes.py.
Подключение в api/main.py:
    from wip_analytics_routes import router as wip_analytics_router
    app.include_router(wip_analytics_router)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import calendar
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from auth import require_settings_manager

from main import get_conn, query, query_one  # noqa: E402
from wip_routes import (  # noqa: E402
    _approved_report_exists,
    _dashboard_section_num,
    _dashboard_response_cache_generation,
    _dashboard_response_cache_get,
    _dashboard_response_cache_mark,
    _dashboard_response_cache_key,
    _dashboard_response_cache_set,
    _dashboard_response_cache_should_serve_stale,
    _dashboard_response_cache_stale_payload,
    _dashboard_response_cache_build_or_wait,
    _dashboard_synthetic_transport_rows_for_period,
    _ensure_dashboard_response_cache_table,
    _expand_sections,
    _format_pk_range_excel,
    _merge_section,
    _movement_type_label,
    _non_pile_control_report_condition,
    _parse_range,
    _quarry_display_name,
    _quarry_label_key,
    SECTION_FALLBACK_COLORS,
    _statement_rates_for_row,
    _statement_scope_cte,
    _statement_work_type_amount,
    _statement_work_type_rate_map,
    _temp_roads_status_payload,
    dashboard_material_flow,
)

router = APIRouter(prefix="/api/wip", tags=["wip-analytics"])

WORK_CARD_CONFIG_KEY = "analytics.work_metric_cards.v1"
ANALYTICS_INCEPTION_DATE = date_cls(2025, 8, 1)
ANALYTICS_SYNTHETIC_DAY_SHARE = 0.6
ANALYTICS_SYNTHETIC_NIGHT_SHARE = 0.4
DASHBOARD_SHORT_CACHE_TTL_SECONDS = int(os.getenv("DASHBOARD_SHORT_CACHE_TTL_SECONDS", "60"))
_DASHBOARD_SHORT_CACHE_LOCK = threading.Lock()
_DAILY_SUMMARY_CACHE: dict[tuple, tuple[float, dict]] = {}
_TEMP_ROADS_STAGE3_CACHE: dict[tuple, tuple[float, dict]] = {}


def _dashboard_short_cache_get(cache: dict[tuple, tuple[float, dict]], key: tuple) -> Optional[dict]:
    if DASHBOARD_SHORT_CACHE_TTL_SECONDS <= 0:
        return None
    now = time.monotonic()
    with _DASHBOARD_SHORT_CACHE_LOCK:
        cached = cache.get(key)
        if not cached:
            return None
        created_at, payload = cached
        if now - created_at > DASHBOARD_SHORT_CACHE_TTL_SECONDS:
            cache.pop(key, None)
            return None
        return payload


def _dashboard_short_cache_set(cache: dict[tuple, tuple[float, dict]], key: tuple, payload: dict) -> dict:
    if DASHBOARD_SHORT_CACHE_TTL_SECONDS <= 0:
        return payload
    with _DASHBOARD_SHORT_CACHE_LOCK:
        cache[key] = (time.monotonic(), payload)
    return payload


WORK_ANALYTICS_TAG_BY_CODE = {
    "EMBANKMENT_CONSTRUCTION": "Песок (Насыпь)",
    "WEAK_SOIL_REPLACEMENT": "Песок (Замена)",
    "PAVEMENT_SANDING": "Песок (ДСО)",
    "TOPSOIL_STRIPPING": "ПРС",
    "EARTH_EXCAVATION": "Выемка",
    "EXCAVATION_MAIN": "Выемка",
    "PEAT_REMOVAL": "Выторфовка",
    "CRUSHED_STONE_PLACEMENT": "ЩПС",
    "FIRST_PROTECTIVE_LAYER": "ЩПС",
    "SECOND_PROTECTIVE_LAYER": "ПГС",
    "GEOTEXTILE_LAYER_DO": "Геотекстиль (ДСО)",
    "GEOTEXTILE_LAYER": "Геотекстиль",
    "SLOPE_FORMATION_CC": "Щебень",
    "SHOULDER_BACKFILL": "Песок (Обочины)",
    "ZS1": "ЗС",
    "ZS2": "ЗС",
    "PILE_MAIN": "ОсСваи",
    "PILE_TRIAL": "ПрСваи",
    "PILE_DYNTEST": "ДинИ",
    "PILE_HEADCAP_INSTALLATION": "Оголовки свай",
    "FLEXIBLE_GRILLAGE_GEOTEXTILE": "Геотекстиль свай",
}

_WORK_ANALYTICS_SCHEMA_READY = False
_WORK_ANALYTICS_SCHEMA_LOCK = threading.Lock()
WORK_TAG_EXPR = "COALESCE(NULLIF(BTRIM(dwi.analytics_tag), ''), NULLIF(BTRIM(wt.analytics_tag), ''))"
DASHBOARD_SEG_WORK_TAG_EXPR = (
    "COALESCE(NULLIF(BTRIM(seg.analytics_tag), ''), "
    "NULLIF(BTRIM(dwi.analytics_tag), ''), "
    "NULLIF(BTRIM(wt.analytics_tag), ''), wt.name, dwi.work_name_raw)"
)
DAILY_SUMMARY_SAND_WORK_CODES = {
    "EMBANKMENT_CONSTRUCTION",
    "WEAK_SOIL_REPLACEMENT",
    "PAVEMENT_SANDING",
    "SHOULDER_BACKFILL",
}
DAILY_SUMMARY_SAND_TAGS = {"Песок (Насыпь)", "Песок (ДСО)", "Песок (Замена)", "Песок (Обочины)"}
DAILY_SUMMARY_EXCAVATION_WORK_CODES = {"EARTH_EXCAVATION", "EXCAVATION_MAIN", "PEAT_REMOVAL"}
DAILY_SUMMARY_EXCAVATION_TAGS = {"Выемка", "Выторфовка"}
DAILY_SUMMARY_OH_OBJECT_TYPE_CODES = {
    "MAIN_TRACK",
    "STATION_TRACK",
    "PILE_FIELD",
    "TRACTION_SUBSTATION",
}
DAILY_SUMMARY_TP_OBJECT_CODES = {"PTP_4", "PTP_8", "TRACTION_SUBSTATION_2905", "STATION_TRACK_3294"}
DAILY_SUMMARY_TEMP_ROAD_OBJECT_TYPE_CODES = {
    "TEMP_ROAD",
    "VPD",
    "VAD",
    "SERVICE_ROAD",
    "TECH_ROAD",
    "TEMP_ROAD_PIPE",
}


class AnalyticsWorkCardConfig(BaseModel):
    id: str
    label: str
    tags: list[str] = []
    scopes: list[str] = []
    units: list[str] = []


class AnalyticsWorkCardConfigBody(BaseModel):
    cards: list[AnalyticsWorkCardConfig]


def _ensure_pile_field_object_links(cur) -> None:
    cur.execute("ALTER TABLE pile_fields ADD COLUMN IF NOT EXISTS object_id uuid REFERENCES objects(id)")
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pile_fields_object_id
        ON pile_fields(object_id)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_daily_work_item_segments_pile_field
        ON daily_work_item_segments(pile_field_id)
        """
    )
    cur.execute(
        """
        INSERT INTO object_types (
          id, code, name, sort_order, is_active, map_enabled,
          work_accounting_enabled, material_accounting_enabled, is_linear,
          accounting_note, review_tag
        )
        VALUES (
          gen_random_uuid(), 'PILE_FIELD', 'Свайное поле', 30, true, true,
          true, false, true, 'synced from pile_fields', 'auto:pile_field_sync'
        )
        ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name,
            sort_order = LEAST(object_types.sort_order, EXCLUDED.sort_order),
            is_active = true,
            map_enabled = true,
            work_accounting_enabled = true,
            material_accounting_enabled = false,
            is_linear = true
        """
    )
    cur.execute(
        """
        WITH pile_type AS (
          SELECT id FROM object_types WHERE code = 'PILE_FIELD' LIMIT 1
        ),
        eligible_fields AS (
          SELECT pf.*
          FROM pile_fields pf
          WHERE NULLIF(BTRIM(pf.field_code), '') IS NOT NULL
            AND (
              pf.is_demo IS NOT TRUE
              OR EXISTS (
                SELECT 1
                FROM daily_work_item_segments seg
                JOIN daily_work_items dwi ON dwi.id = seg.daily_work_item_id
                WHERE seg.pile_field_id = pf.id
                  AND seg.is_demo IS NOT TRUE
                  AND dwi.is_demo IS NOT TRUE
              )
            )
        ),
        grouped AS (
          SELECT BTRIM(field_code) AS field_code,
                 ('PF_' || regexp_replace(BTRIM(field_code), '[[:space:]]+', '', 'g'))::varchar(100) AS object_code,
                 ('Свайное поле ' || BTRIM(field_code))::varchar(255) AS object_name,
                 MIN(LEAST(pk_start, pk_end)) AS pk_start,
                 MAX(GREATEST(pk_start, pk_end)) AS pk_end,
                 STRING_AGG(DISTINCT NULLIF(BTRIM(pk_raw_text), ''), '; ' ORDER BY NULLIF(BTRIM(pk_raw_text), '')) AS pk_raw_text
          FROM eligible_fields
          GROUP BY BTRIM(field_code)
        )
        INSERT INTO objects (id, object_code, name, object_type_id, is_active, comment, review_tag)
        SELECT gen_random_uuid(),
               g.object_code,
               g.object_name,
               pt.id,
               true,
               'synced from pile_fields',
               'auto:pile_field_sync'
        FROM grouped g
        CROSS JOIN pile_type pt
        ON CONFLICT (object_code) DO UPDATE
        SET name = EXCLUDED.name,
            object_type_id = EXCLUDED.object_type_id,
            is_active = true
        """
    )
    cur.execute(
        """
        WITH pile_type AS (
          SELECT id FROM object_types WHERE code = 'PILE_FIELD' LIMIT 1
        ),
        eligible_codes AS (
          SELECT DISTINCT ('PF_' || regexp_replace(BTRIM(pf.field_code), '[[:space:]]+', '', 'g'))::varchar(100) AS object_code
          FROM pile_fields pf
          WHERE NULLIF(BTRIM(pf.field_code), '') IS NOT NULL
            AND (
              pf.is_demo IS NOT TRUE
              OR EXISTS (
                SELECT 1
                FROM daily_work_item_segments seg
                JOIN daily_work_items dwi ON dwi.id = seg.daily_work_item_id
                WHERE seg.pile_field_id = pf.id
                  AND seg.is_demo IS NOT TRUE
                  AND dwi.is_demo IS NOT TRUE
              )
            )
        )
        UPDATE objects o
        SET is_active = false
        FROM pile_type pt
        WHERE o.object_type_id = pt.id
          AND o.review_tag = 'auto:pile_field_sync'
          AND NOT EXISTS (
            SELECT 1 FROM eligible_codes ec WHERE ec.object_code = o.object_code
          )
        """
    )
    cur.execute(
        """
        UPDATE pile_fields pf
        SET object_id = o.id
        FROM objects o
        JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'PILE_FIELD'
        WHERE o.object_code = 'PF_' || regexp_replace(BTRIM(pf.field_code), '[[:space:]]+', '', 'g')
          AND (
            pf.is_demo IS NOT TRUE
            OR EXISTS (
              SELECT 1
              FROM daily_work_item_segments seg
              JOIN daily_work_items dwi ON dwi.id = seg.daily_work_item_id
              WHERE seg.pile_field_id = pf.id
                AND seg.is_demo IS NOT TRUE
                AND dwi.is_demo IS NOT TRUE
            )
          )
          AND (pf.object_id IS NULL OR pf.object_id IS DISTINCT FROM o.id)
        """
    )
    cur.execute(
        """
        WITH eligible_fields AS (
          SELECT pf.*
          FROM pile_fields pf
          WHERE pf.object_id IS NOT NULL
            AND (
              pf.is_demo IS NOT TRUE
              OR EXISTS (
                SELECT 1
                FROM daily_work_item_segments seg
                JOIN daily_work_items dwi ON dwi.id = seg.daily_work_item_id
                WHERE seg.pile_field_id = pf.id
                  AND seg.is_demo IS NOT TRUE
                  AND dwi.is_demo IS NOT TRUE
              )
            )
        ),
        grouped AS (
          SELECT object_id,
                 MIN(LEAST(pk_start, pk_end)) AS pk_start,
                 MAX(GREATEST(pk_start, pk_end)) AS pk_end,
                 STRING_AGG(DISTINCT NULLIF(BTRIM(pk_raw_text), ''), '; ' ORDER BY NULLIF(BTRIM(pk_raw_text), '')) AS pk_raw_text
          FROM eligible_fields
          GROUP BY object_id
        )
        INSERT INTO object_segments (id, object_id, pk_start, pk_end, pk_raw_text, comment, review_tag)
        SELECT gen_random_uuid(),
               g.object_id,
               g.pk_start,
               g.pk_end,
               COALESCE(g.pk_raw_text, 'ПК ' || g.pk_start::text || ' - ' || g.pk_end::text),
               'synced from pile_fields',
               'auto:pile_field_sync'
        FROM grouped g
        WHERE g.pk_start IS NOT NULL
          AND g.pk_end IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM object_segments os
            WHERE os.object_id = g.object_id
          )
        """
    )
    cur.execute(
        """
        WITH segment_object AS (
          SELECT DISTINCT ON (seg.daily_work_item_id)
                 seg.daily_work_item_id,
                 pf.object_id
          FROM daily_work_item_segments seg
          JOIN pile_fields pf ON pf.id = seg.pile_field_id
          WHERE seg.is_demo IS NOT TRUE
            AND pf.object_id IS NOT NULL
          ORDER BY seg.daily_work_item_id, seg.id
        )
        UPDATE daily_work_items dwi
        SET object_id = segment_object.object_id
        FROM segment_object
        WHERE dwi.id = segment_object.daily_work_item_id
          AND dwi.is_demo IS NOT TRUE
          AND (dwi.object_id IS NULL OR dwi.object_id IS DISTINCT FROM segment_object.object_id)
        """
    )


def _work_analytics_schema_prepared() -> bool:
    try:
        rows = query(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('work_types', 'daily_work_items', 'daily_work_item_segments')
              AND column_name = 'analytics_tag'
            """,
        )
        have_columns = {(row.get("table_name"), row.get("column_name")) for row in rows}
        tags_table = query_one(
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'work_analytics_tags'
            ) AS exists
            """,
        )
    except Exception:
        return False
    return (
        bool(tags_table and tags_table.get("exists"))
        and ("work_types", "analytics_tag") in have_columns
        and ("daily_work_items", "analytics_tag") in have_columns
        and ("daily_work_item_segments", "analytics_tag") in have_columns
    )


def _ensure_work_analytics_schema() -> None:
    global _WORK_ANALYTICS_SCHEMA_READY
    if _WORK_ANALYTICS_SCHEMA_READY:
        return
    with _WORK_ANALYTICS_SCHEMA_LOCK:
        if _WORK_ANALYTICS_SCHEMA_READY:
            return
        if _work_analytics_schema_prepared():
            _WORK_ANALYTICS_SCHEMA_READY = True
            return
        conn = get_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute("ALTER TABLE work_types ADD COLUMN IF NOT EXISTS analytics_tag TEXT")
                    cur.execute("ALTER TABLE daily_work_items ADD COLUMN IF NOT EXISTS analytics_tag TEXT")
                    cur.execute("ALTER TABLE daily_work_item_segments ADD COLUMN IF NOT EXISTS analytics_tag TEXT")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS work_analytics_tags (
                          name text PRIMARY KEY,
                          is_active boolean NOT NULL DEFAULT true,
                          created_at timestamptz NOT NULL DEFAULT now()
                        )
                        """
                    )
                    for tag in sorted(set(WORK_ANALYTICS_TAG_BY_CODE.values())):
                        cur.execute(
                            """
                            INSERT INTO work_analytics_tags (name)
                            VALUES (%s)
                            ON CONFLICT (name) DO UPDATE SET is_active = true
                            """,
                            (tag,),
                        )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_daily_work_items_analytics_tag
                        ON daily_work_items(analytics_tag)
                        """
                    )
                    cur.execute(
                        """
                        WITH ranked AS (
                          SELECT work_type_id,
                                 BTRIM(analytics_tag) AS analytics_tag,
                                 COUNT(*) AS cnt,
                                 ROW_NUMBER() OVER (
                                   PARTITION BY work_type_id
                                   ORDER BY COUNT(*) DESC, BTRIM(analytics_tag)
                                 ) AS rn
                          FROM daily_work_items
                          WHERE NULLIF(BTRIM(analytics_tag), '') IS NOT NULL
                          GROUP BY work_type_id, BTRIM(analytics_tag)
                        )
                        UPDATE work_types wt
                        SET analytics_tag = ranked.analytics_tag
                        FROM ranked
                        WHERE ranked.work_type_id = wt.id
                          AND ranked.rn = 1
                          AND NULLIF(BTRIM(COALESCE(wt.analytics_tag, '')), '') IS NULL
                        """
                    )
                    cur.execute(
                        """
                        UPDATE work_types wt
                        SET analytics_tag = CASE wt.code
                          WHEN 'EMBANKMENT_CONSTRUCTION' THEN 'Песок (Насыпь)'
                          WHEN 'WEAK_SOIL_REPLACEMENT' THEN 'Песок (Замена)'
                          WHEN 'PAVEMENT_SANDING' THEN 'Песок (ДСО)'
                          WHEN 'TOPSOIL_STRIPPING' THEN 'ПРС'
                          WHEN 'EARTH_EXCAVATION' THEN 'Выемка'
                          WHEN 'EXCAVATION_MAIN' THEN 'Выемка'
                          WHEN 'PEAT_REMOVAL' THEN 'Выторфовка'
                          WHEN 'CRUSHED_STONE_PLACEMENT' THEN 'ЩПС'
                          WHEN 'FIRST_PROTECTIVE_LAYER' THEN 'ЩПС'
                          WHEN 'SECOND_PROTECTIVE_LAYER' THEN 'ПГС'
                          WHEN 'GEOTEXTILE_LAYER_DO' THEN 'Геотекстиль (ДСО)'
                          WHEN 'GEOTEXTILE_LAYER' THEN 'Геотекстиль'
                          WHEN 'SLOPE_FORMATION_CC' THEN 'Щебень'
                          WHEN 'SHOULDER_BACKFILL' THEN 'Песок (Обочины)'
                          WHEN 'ZS1' THEN 'ЗС'
                          WHEN 'ZS2' THEN 'ЗС'
                          WHEN 'PILE_MAIN' THEN 'ОсСваи'
                          WHEN 'PILE_TRIAL' THEN 'ПрСваи'
                          WHEN 'PILE_DYNTEST' THEN 'ДинИ'
                          WHEN 'PILE_HEADCAP_INSTALLATION' THEN 'Оголовки свай'
                          WHEN 'FLEXIBLE_GRILLAGE_GEOTEXTILE' THEN 'Геотекстиль свай'
                          ELSE NULL
                        END
                        WHERE NULLIF(BTRIM(COALESCE(wt.analytics_tag, '')), '') IS NULL
                        """
                    )
                    _ensure_pile_field_object_links(cur)
                    cur.execute(
                        """
                        UPDATE daily_work_items dwi
                        SET analytics_tag = NULLIF(BTRIM(wt.analytics_tag), '')
                        FROM work_types wt
                        WHERE wt.id = dwi.work_type_id
                          AND NULLIF(BTRIM(COALESCE(dwi.analytics_tag, '')), '') IS NULL
                          AND NULLIF(BTRIM(COALESCE(wt.analytics_tag, '')), '') IS NOT NULL
                        """
                    )
                    cur.execute(
                        """
                        UPDATE daily_work_item_segments seg
                        SET analytics_tag = dwi.analytics_tag
                        FROM daily_work_items dwi
                        WHERE dwi.id = seg.daily_work_item_id
                          AND COALESCE(seg.analytics_tag, '') IS DISTINCT FROM COALESCE(dwi.analytics_tag, '')
                        """
                    )
                    cur.execute(
                        """
                        INSERT INTO work_analytics_tags (name)
                        SELECT name
                        FROM (
                          SELECT DISTINCT BTRIM(analytics_tag) AS name
                          FROM work_types
                          WHERE NULLIF(BTRIM(analytics_tag), '') IS NOT NULL
                          UNION
                          SELECT DISTINCT BTRIM(analytics_tag) AS name
                          FROM daily_work_items
                          WHERE NULLIF(BTRIM(analytics_tag), '') IS NOT NULL
                        ) src
                        ON CONFLICT (name) DO UPDATE SET is_active = true
                        """
                    )
            _WORK_ANALYTICS_SCHEMA_READY = True
        finally:
            conn.close()




def _analytics_table_exists(table_name: str) -> bool:
    row = query_one(
        """
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = %s
        ) AS exists
        """,
        (table_name,),
    )
    return bool(row and row.get("exists"))


def _csv_values(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _analytics_object_group_clause(values: list[str], object_type_alias: str = "ot") -> Optional[str]:
    clauses: list[str] = []
    normalized = {str(value or "").strip().lower() for value in values}
    if "main_track" in normalized:
        clauses.append(f"{object_type_alias}.code = 'MAIN_TRACK'")
    if "temp_road" in normalized:
        clauses.append(f"{object_type_alias}.code IN ('TEMP_ROAD', 'VPD', 'VAD')")
    if "other" in normalized:
        clauses.append(f"({object_type_alias}.code IS NULL OR {object_type_alias}.code NOT IN ('MAIN_TRACK', 'TEMP_ROAD', 'VPD', 'VAD'))")
    return "(" + " OR ".join(clauses) + ")" if clauses else None


def _analytics_segment_count_alias(segment_alias: str) -> str:
    return f"{segment_alias}_count"


def _analytics_segment_volume_expr(segment_alias: str = "seg_eff") -> str:
    count_alias = _analytics_segment_count_alias(segment_alias)
    initial_sum_expr = (
        f"({count_alias}.volume_segment_sum + "
        f"({count_alias}.missing_volume_cnt * COALESCE(dwi.volume, 0) / NULLIF({count_alias}.cnt, 0)))"
    )
    segment_initial_expr = (
        f"CASE "
        f"WHEN {segment_alias}.volume_segment IS NOT NULL THEN {segment_alias}.volume_segment "
        f"ELSE COALESCE(dwi.volume, 0) / NULLIF({count_alias}.cnt, 0) END"
    )
    return (
        f"CASE "
        f"WHEN {segment_alias}.id IS NULL THEN COALESCE(dwi.volume, 0) "
        f"WHEN {count_alias}.cnt > 0 AND {initial_sum_expr} <> 0 "
        f"THEN COALESCE(dwi.volume, 0) * ({segment_initial_expr}) / {initial_sum_expr} "
        f"WHEN {count_alias}.cnt > 0 THEN COALESCE(dwi.volume, 0) / {count_alias}.cnt "
        f"ELSE COALESCE(dwi.volume, 0) END"
    )


def _effective_section_join(segment_alias: str = "seg_eff") -> str:
    """Map analytics facts to display sections without dropping unsegmented rows.

    The report section is the source of truth for organizational analytics. PK
    and object ranges are used only when a fact row has no report section.
    """
    count_alias = _analytics_segment_count_alias(segment_alias)
    return f"""
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::numeric AS cnt,
                 COALESCE(SUM(CASE WHEN {count_alias}_src.volume_segment IS NOT NULL THEN {count_alias}_src.volume_segment ELSE 0 END), 0)::numeric AS volume_segment_sum,
                 COUNT(*) FILTER (WHERE {count_alias}_src.volume_segment IS NULL)::numeric AS missing_volume_cnt
          FROM daily_work_item_segments {count_alias}_src
          WHERE {count_alias}_src.daily_work_item_id = dwi.id
            AND {count_alias}_src.is_demo IS NOT TRUE
        ) {count_alias} ON true
        LEFT JOIN daily_work_item_segments {segment_alias}
          ON {segment_alias}.daily_work_item_id = dwi.id
         AND {segment_alias}.is_demo IS NOT TRUE
        LEFT JOIN LATERAL (
          SELECT MIN(os.pk_start) AS pk_start, MAX(os.pk_end) AS pk_end
          FROM object_segments os
          WHERE os.object_id = o.id
        ) ob_eff ON true
        LEFT JOIN daily_reports dr_eff_section
          ON dr_eff_section.id = dwi.daily_report_id
        LEFT JOIN construction_sections cs_report
          ON cs_report.id = COALESCE(dwi.section_id, dr_eff_section.section_id)
         AND cs_report.is_active IS NOT FALSE
        LEFT JOIN LATERAL (
          SELECT COALESCE(({segment_alias}.pk_start + {segment_alias}.pk_end) / 2.0, {segment_alias}.pk_start, {segment_alias}.pk_end) AS segment_pk,
                 COALESCE((ob_eff.pk_start + ob_eff.pk_end) / 2.0, ob_eff.pk_start, ob_eff.pk_end) AS object_pk
        ) road_pk ON true
        LEFT JOIN LATERAL (
          SELECT (
            road_pk.segment_pk IS NOT NULL
            AND ob_eff.pk_start IS NOT NULL
            AND ob_eff.pk_end IS NOT NULL
            AND road_pk.segment_pk >= LEAST(ob_eff.pk_start, ob_eff.pk_end)
            AND road_pk.segment_pk <= GREATEST(ob_eff.pk_start, ob_eff.pk_end)
          ) AS segment_in_object
        ) road_scope ON true
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN ot.code = 'TEMP_ROAD' THEN COALESCE(
              CASE WHEN road_scope.segment_in_object THEN road_pk.segment_pk ELSE NULL END,
              road_pk.object_pk,
              road_pk.segment_pk
            )
            ELSE COALESCE(
              (COALESCE({segment_alias}.pk_start, ob_eff.pk_start) + COALESCE({segment_alias}.pk_end, ob_eff.pk_end)) / 2.0,
              COALESCE({segment_alias}.pk_start, ob_eff.pk_start),
              COALESCE({segment_alias}.pk_end, ob_eff.pk_end)
            )
          END AS section_pk
        ) section_point ON true
        LEFT JOIN LATERAL (
          SELECT csv.section_id
          FROM construction_section_versions csv
          WHERE csv.is_current
            AND csv.boundary_kind = CASE
              WHEN ot.code = 'TEMP_ROAD' THEN 'temp_roads'
              WHEN ot.code IN ('PILE_FIELD', 'PILE_DRIVING_PAD', 'ISSO_ACCESS', 'PIPE', 'BRIDGE', 'OVERPASS', 'TECH_ROAD') THEN 'piles_pipes'
              ELSE 'main'
            END
            AND section_point.section_pk IS NOT NULL
            AND section_point.section_pk >= LEAST(csv.pk_start, csv.pk_end)
            AND section_point.section_pk < GREATEST(csv.pk_start, csv.pk_end)
          ORDER BY csv.pk_start, csv.pk_end
          LIMIT 1
        ) effective_section ON true
        LEFT JOIN construction_sections cs_override
          ON cs_override.code = CASE
            WHEN o.object_code IN ('ASP_2840', 'BRIDGE_282952') THEN 'UCH_3'
            ELSE NULL
          END
         AND cs_override.is_active IS NOT FALSE
        LEFT JOIN construction_sections cs_eff
          ON cs_eff.id = COALESCE(
            cs_report.id,
            cs_override.id,
            effective_section.section_id
          )
         AND cs_eff.is_active IS NOT FALSE
    """


def _ensure_dashboard_settings_schema() -> None:
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_settings (
                      key text PRIMARY KEY,
                      payload jsonb NOT NULL,
                      updated_by text,
                      updated_at timestamptz NOT NULL DEFAULT now()
                    )
                    """
                )
    finally:
        conn.close()


def _clean_string_list(values: list[str], limit: int = 80) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values[:limit]:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _normalize_work_card_config(card: AnalyticsWorkCardConfig) -> dict:
    scopes = [
        scope
        for scope in _clean_string_list(card.scopes)
        if scope.startswith("type:") or scope.startswith("object:")
    ]
    return {
        "id": str(card.id or "").strip()[:80],
        "label": str(card.label or "").strip()[:160],
        "tags": _clean_string_list(card.tags),
        "scopes": scopes,
        "units": _clean_string_list(card.units),
    }


@router.get("/analytics/work-card-config")
def analytics_work_card_config():
    _ensure_dashboard_settings_schema()
    row = query_one(
        """
        SELECT payload, updated_by, updated_at
        FROM dashboard_settings
        WHERE key = %s
        """,
        (WORK_CARD_CONFIG_KEY,),
    )
    if not row:
        return {"cards": None, "updated_by": None, "updated_at": None}
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    updated_at = row.get("updated_at")
    return {
        "cards": payload.get("cards") if isinstance(payload.get("cards"), list) else None,
        "updated_by": row.get("updated_by"),
        "updated_at": updated_at.isoformat() if hasattr(updated_at, "isoformat") else updated_at,
    }


@router.put("/analytics/work-card-config")
def save_analytics_work_card_config(
    body: AnalyticsWorkCardConfigBody,
    manager=Depends(require_settings_manager),
):
    _ensure_dashboard_settings_schema()
    cards = [
        normalized
        for normalized in (_normalize_work_card_config(card) for card in body.cards[:40])
        if normalized["id"] and normalized["label"]
    ]
    payload = {"cards": cards}
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO dashboard_settings (key, payload, updated_by, updated_at)
                    VALUES (%s, %s::jsonb, %s, now())
                    ON CONFLICT (key) DO UPDATE
                    SET payload = EXCLUDED.payload,
                        updated_by = EXCLUDED.updated_by,
                        updated_at = now()
                    RETURNING updated_at
                    """,
                    (WORK_CARD_CONFIG_KEY, json.dumps(payload, ensure_ascii=False), manager.username),
                )
                updated_at = cur.fetchone()[0]
        return {
            "cards": cards,
            "updated_by": manager.username,
            "updated_at": updated_at.isoformat() if hasattr(updated_at, "isoformat") else updated_at,
        }
    finally:
        conn.close()


@router.get("/analytics/work-filter-options")
def analytics_work_filter_options(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
):
    _ensure_work_analytics_schema()
    d_from, d_to = _parse_range(date_from, date_to)
    section_codes = _expand_sections(section)
    tag_expr = WORK_TAG_EXPR
    where = [
        "dwi.report_date BETWEEN %s AND %s",
        _approved_report_exists("dwi"),
        f"{tag_expr} IS NOT NULL",
        "dwi.is_demo IS NOT TRUE",
    ]
    params: list = [d_from, d_to]
    if section_codes:
        where.append("cs_eff.code = ANY(%s)")
        params.append(section_codes)
    where_sql = " AND ".join(where)
    effective_section_join = _effective_section_join("seg_eff")
    tags = query(
        f"""
        SELECT tag AS name,
               COUNT(DISTINCT dwi_id)::int AS fact_count,
               ARRAY_AGG(DISTINCT unit ORDER BY unit) AS units
        FROM (
          SELECT dwi.id AS dwi_id,
                 {tag_expr} AS tag,
                 COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) AS unit
          FROM daily_work_items dwi
          JOIN work_types wt ON wt.id = dwi.work_type_id AND wt.is_active IS NOT FALSE
          JOIN objects o ON o.id = dwi.object_id AND o.is_active IS NOT FALSE
          JOIN object_types ot ON ot.id = o.object_type_id AND ot.is_active IS NOT FALSE
          {effective_section_join}
          WHERE {where_sql}
        ) src
        GROUP BY tag
        ORDER BY tag
        """,
        params,
    )
    catalog_tags = query(
        """
        SELECT name
        FROM work_analytics_tags
        WHERE is_active IS TRUE
        ORDER BY name
        """
    )
    tags_by_name = {str(row.get("name") or ""): dict(row) for row in tags if row.get("name")}
    for row in catalog_tags:
        name = str(row.get("name") or "").strip()
        if name and name not in tags_by_name:
            tags_by_name[name] = {"name": name, "fact_count": 0, "units": []}
    tags = sorted(tags_by_name.values(), key=lambda row: str(row.get("name") or ""))

    object_types = query(
        f"""
        SELECT ot.code, ot.name, COUNT(DISTINCT dwi.id)::int AS fact_count
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id AND wt.is_active IS NOT FALSE
        JOIN objects o ON o.id = dwi.object_id AND o.is_active IS NOT FALSE
        JOIN object_types ot ON ot.id = o.object_type_id AND ot.is_active IS NOT FALSE
        {effective_section_join}
        WHERE {where_sql}
          AND ot.code IS NOT NULL
        GROUP BY ot.code, ot.name, ot.sort_order
        ORDER BY ot.sort_order NULLS LAST, ot.name
        """,
        params,
    )
    objects = query(
        f"""
        SELECT o.object_code AS code,
               o.name,
               ot.code AS object_type_code,
               ot.name AS object_type_name,
               ARRAY_AGG(DISTINCT cs_eff.code ORDER BY cs_eff.code) AS section_codes,
               ARRAY_AGG(DISTINCT cs_eff.name ORDER BY cs_eff.name) AS section_names,
               COUNT(DISTINCT dwi.id)::int AS fact_count
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id AND wt.is_active IS NOT FALSE
        JOIN objects o ON o.id = dwi.object_id AND o.is_active IS NOT FALSE
        JOIN object_types ot ON ot.id = o.object_type_id AND ot.is_active IS NOT FALSE
        {effective_section_join}
        WHERE {where_sql}
        GROUP BY o.object_code, o.name, ot.code, ot.name
        ORDER BY MIN(cs_eff.sort_order) NULLS LAST, ot.name, o.name, o.object_code
        """,
        params,
    )
    units = query(
        f"""
        SELECT COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) AS unit,
               COUNT(DISTINCT dwi.id)::int AS fact_count
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id AND wt.is_active IS NOT FALSE
        JOIN objects o ON o.id = dwi.object_id AND o.is_active IS NOT FALSE
        JOIN object_types ot ON ot.id = o.object_type_id AND ot.is_active IS NOT FALSE
        {effective_section_join}
        WHERE {where_sql}
        GROUP BY COALESCE(NULLIF(dwi.unit, ''), wt.default_unit)
        ORDER BY unit
        """,
        params,
    )
    return {
        "tags": tags,
        "object_types": object_types,
        "objects": objects,
        "units": units,
    }


@router.get("/analytics/work-tag-summary")
def analytics_work_tag_summary(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
    tags: Optional[str] = None,
    object_types: Optional[str] = None,
    objects: Optional[str] = None,
    object_group: Optional[str] = None,
    units: Optional[str] = None,
):
    _ensure_work_analytics_schema()
    d_from, d_to = _parse_range(date_from, date_to)
    section_codes = _expand_sections(section)
    tag_values = _csv_values(tags)
    object_type_values = _csv_values(object_types)
    object_values = _csv_values(objects)
    object_group_values = _csv_values(object_group)
    unit_values = _csv_values(units)
    tag_expr = WORK_TAG_EXPR

    where = [
        "dwi.report_date BETWEEN %s AND %s",
        _approved_report_exists("dwi"),
        f"{tag_expr} IS NOT NULL",
        "dwi.is_demo IS NOT TRUE",
        "wt.is_active IS NOT FALSE",
    ]
    params: list = [d_from, d_to]
    if section_codes:
        where.append("cs_eff.code = ANY(%s)")
        params.append(section_codes)
    if tag_values:
        where.append(f"{tag_expr} = ANY(%s)")
        params.append(tag_values)
    if object_type_values:
        where.append("ot.code = ANY(%s)")
        params.append(object_type_values)
    object_group_clause = _analytics_object_group_clause(object_group_values, "ot")
    if object_group_clause:
        where.append(object_group_clause)
    if object_values:
        where.append("o.object_code = ANY(%s)")
        params.append(object_values)
    if unit_values:
        where.append("COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) = ANY(%s)")
        params.append(unit_values)

    effective_section_join = _effective_section_join("seg")
    seg_volume_expr = _analytics_segment_volume_expr("seg")
    rows = query(
        f"""
        SELECT {tag_expr} AS tag,
               COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) AS unit,
               ot.code AS object_type_code,
               ot.name AS object_type_name,
               o.object_code,
               o.name AS object_name,
               cs_eff.code AS section_code,
               COUNT(DISTINCT dwi.id)::int AS fact_count,
               SUM({seg_volume_expr})::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {effective_section_join}
        WHERE {' AND '.join(where)}
        GROUP BY {tag_expr}, COALESCE(NULLIF(dwi.unit, ''), wt.default_unit),
                 ot.code, ot.name, o.object_code, o.name, cs_eff.code
        ORDER BY tag, unit, ot.name NULLS LAST, o.name NULLS LAST, cs_eff.code
        """,
        params,
    )
    daily_rows = query(
        f"""
        SELECT dwi.report_date,
               cs_eff.code AS section_code,
               SUM({seg_volume_expr})::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {effective_section_join}
        WHERE {' AND '.join(where)}
        GROUP BY dwi.report_date, cs_eff.code
        ORDER BY dwi.report_date, cs_eff.code
        """,
        params,
    )

    plan_rows = []
    if _analytics_table_exists("planned_work_items"):
        plan_tag_expr = "COALESCE(NULLIF(BTRIM(wt.analytics_tag), ''))"
        plan_where = [
            "pwi.is_active IS NOT FALSE",
            f"{plan_tag_expr} IS NOT NULL",
            "wt.is_active IS NOT FALSE",
            "o.is_active IS NOT FALSE",
            "ot.is_active IS NOT FALSE",
            "((pwi.period_start IS NULL AND pwi.period_end IS NULL AND %s::date = %s::date) OR (pwi.period_start IS NOT NULL AND pwi.period_end IS NOT NULL AND pwi.period_start <= %s::date AND pwi.period_end >= %s::date))",
        ]
        plan_params: list = [d_from, d_to, d_to, d_from]
        if section_codes:
            plan_where.append("cs_eff.code = ANY(%s)")
            plan_params.append(section_codes)
        if tag_values:
            plan_where.append(f"{plan_tag_expr} = ANY(%s)")
            plan_params.append(tag_values)
        if object_type_values:
            plan_where.append("ot.code = ANY(%s)")
            plan_params.append(object_type_values)
        plan_object_group_clause = _analytics_object_group_clause(object_group_values, "ot")
        if plan_object_group_clause:
            plan_where.append(plan_object_group_clause)
        if object_values:
            plan_where.append("o.object_code = ANY(%s)")
            plan_params.append(object_values)
        if unit_values:
            plan_where.append("COALESCE(NULLIF(pwi.unit, ''), wt.default_unit) = ANY(%s)")
            plan_params.append(unit_values)
        plan_rows = query(
            f"""
            SELECT {plan_tag_expr} AS tag,
                   COALESCE(NULLIF(pwi.unit, ''), wt.default_unit) AS unit,
                   cs_eff.code AS section_code,
                   SUM(
                     CASE
                       WHEN pwi.period_start IS NULL AND pwi.period_end IS NULL THEN
                         CASE WHEN %s::date = %s::date THEN COALESCE(pwi.planned_volume, 0) ELSE 0 END
                       ELSE COALESCE(pwi.planned_volume, 0)
                         * GREATEST(0, (LEAST(pwi.period_end, %s::date) - GREATEST(pwi.period_start, %s::date) + 1))::numeric
                         / GREATEST(1, (pwi.period_end - pwi.period_start + 1))::numeric
                     END
                   )::numeric AS planned_volume
            FROM planned_work_items pwi
            JOIN work_types wt ON wt.id = pwi.work_type_id
            JOIN objects o ON o.id = pwi.object_id
            JOIN object_types ot ON ot.id = o.object_type_id
            LEFT JOIN LATERAL (
              SELECT csv.section_id
              FROM construction_section_versions csv
              WHERE csv.is_current
                AND pwi.pk_start IS NOT NULL
                AND pwi.pk_end IS NOT NULL
                AND csv.boundary_kind = CASE
                  WHEN ot.code = 'TEMP_ROAD' THEN 'temp_roads'
                  WHEN ot.code IN ('PILE_FIELD', 'PILE_DRIVING_PAD', 'ISSO_ACCESS', 'PIPE', 'BRIDGE', 'OVERPASS', 'TECH_ROAD') THEN 'piles_pipes'
                  ELSE 'main'
                END
                AND ((pwi.pk_start + pwi.pk_end) / 2.0) >= LEAST(csv.pk_start, csv.pk_end)
                AND ((pwi.pk_start + pwi.pk_end) / 2.0) < GREATEST(csv.pk_start, csv.pk_end)
              ORDER BY csv.pk_start, csv.pk_end
              LIMIT 1
            ) effective_section ON true
            LEFT JOIN construction_sections cs_override
              ON cs_override.code = CASE
                WHEN o.object_code IN ('ASP_2840', 'BRIDGE_282952') THEN 'UCH_3'
                ELSE NULL
              END
             AND cs_override.is_active IS NOT FALSE
            LEFT JOIN construction_sections cs_eff
              ON cs_eff.id = COALESCE(cs_override.id, effective_section.section_id)
             AND cs_eff.is_active IS NOT FALSE
            WHERE {' AND '.join(plan_where)}
            GROUP BY {plan_tag_expr}, COALESCE(NULLIF(pwi.unit, ''), wt.default_unit), cs_eff.code
            """,
            [d_from, d_to, d_to, d_from, *plan_params],
        )

    chart: dict[tuple[str, str], dict] = {}
    by_section: dict[tuple[str, str, str], float] = {}
    daily_totals: dict[str, float] = {}
    heatmap_rows = []
    table_rows = []
    total = 0.0
    plan_total = 0.0
    plan_by_section: dict[tuple[str, str, str], float] = {}
    for r in plan_rows:
        planned = float(r.get("planned_volume") or 0)
        if planned <= 0:
            continue
        plan_total += planned
        tag = r.get("tag") or "Без тега"
        unit = r.get("unit") or "—"
        section_code = _merge_section(r.get("section_code")) or r.get("section_code") or "—"
        plan_by_section[(tag, unit, section_code)] = plan_by_section.get((tag, unit, section_code), 0.0) + planned
    for r in rows:
        volume = float(r["volume"] or 0)
        total += volume
        tag = r["tag"] or "Без тега"
        unit = r["unit"] or "—"
        key = (tag, unit)
        chart_row = chart.setdefault(key, {"tag": tag, "unit": unit, "label": f"{tag}, {unit}", "volume": 0.0})
        chart_row["volume"] += volume
        section_code = _merge_section(r.get("section_code")) or r.get("section_code") or "—"
        by_section[(tag, unit, section_code)] = by_section.get((tag, unit, section_code), 0.0) + volume
        table_rows.append({
            "tag": tag,
            "unit": unit,
            "object_type_code": r.get("object_type_code"),
            "object_type_name": r.get("object_type_name") or "—",
            "object_code": r.get("object_code"),
            "object_name": r.get("object_name") or "—",
            "section_code": section_code,
            "fact_count": int(r.get("fact_count") or 0),
            "volume": round(volume, 1),
        })

    chart_rows = []
    for row in chart.values():
        row["volume"] = round(float(row["volume"] or 0), 1)
        chart_rows.append(row)
    chart_rows.sort(key=lambda item: item["volume"], reverse=True)

    section_rows = [
        {"tag": tag, "unit": unit, "section_code": section_code, "volume": round(value, 1)}
        for (tag, unit, section_code), value in sorted(by_section.items())
    ]
    plan_section_rows = [
        {"tag": tag, "unit": unit, "section_code": section_code, "planned_volume": round(value, 1)}
        for (tag, unit, section_code), value in sorted(plan_by_section.items())
    ]
    for r in daily_rows:
        day = r["report_date"].isoformat() if r.get("report_date") else None
        if not day:
            continue
        value = float(r["volume"] or 0)
        section_code = _merge_section(r.get("section_code")) or r.get("section_code") or "—"
        daily_totals[day] = daily_totals.get(day, 0.0) + value
        heatmap_rows.append({
            "date": day,
            "section_code": section_code,
            "volume": round(value, 1),
        })
    timeseries = [
        {"date": day, "volume": round(value, 1)}
        for day, value in sorted(daily_totals.items())
    ]

    return {
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "total": round(total, 1),
        "plan_total": round(plan_total, 1),
        "rows": table_rows,
        "chart": chart_rows,
        "by_section": section_rows,
        "plan_by_section": plan_section_rows,
        "timeseries": timeseries,
        "heatmap": heatmap_rows,
    }


@router.get("/analytics/work-tag-fact-rows")
def analytics_work_tag_fact_rows(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
    tag: Optional[str] = None,
    unit: Optional[str] = None,
    object_code: Optional[str] = None,
    object_type_code: Optional[str] = None,
    object_group: Optional[str] = None,
    object_missing: bool = False,
):
    _ensure_work_analytics_schema()
    d_from, d_to = _parse_range(date_from, date_to)
    section_codes = _expand_sections(section)
    object_group_values = _csv_values(object_group)
    tag_expr = WORK_TAG_EXPR

    where = [
        "dwi.report_date BETWEEN %s AND %s",
        _approved_report_exists("dwi"),
        f"{tag_expr} IS NOT NULL",
        "dwi.is_demo IS NOT TRUE",
        "wt.is_active IS NOT FALSE",
    ]
    params: list = [d_from, d_to]
    if section_codes:
        where.append("cs_eff.code = ANY(%s)")
        params.append(section_codes)
    if tag:
        where.append(f"{tag_expr} = %s")
        params.append(tag)
    if unit:
        where.append("COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) = %s")
        params.append(unit)
    if object_code:
        where.append("o.object_code = %s")
        params.append(object_code)
    elif object_type_code:
        where.append("ot.code = %s")
        params.append(object_type_code)
    else:
        object_group_clause = _analytics_object_group_clause(object_group_values, "ot")
        if object_group_clause:
            where.append(object_group_clause)
    if object_missing:
        where.append("o.object_code IS NULL")

    effective_section_join = _effective_section_join("seg")
    rows = query(
        f"""
        SELECT COALESCE(seg.id::text, dwi.id::text) AS id,
               dwi.report_date,
               {tag_expr} AS tag,
               wt.code AS work_type_code,
               wt.name AS work_type_name,
               COALESCE(NULLIF(dwi.unit, ''), wt.default_unit) AS unit,
               {_analytics_segment_volume_expr("seg")}::numeric AS volume,
               cs_eff.code AS section_code,
               o.object_code,
               o.name AS object_name,
               ot.code AS object_type_code,
               ot.name AS object_type_name,
               dwi.shift,
               COALESCE(dwi.contractor_name, '') AS contractor_name,
               COALESCE(dwi.comment, '') AS comment
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {effective_section_join}
        WHERE {' AND '.join(where)}
        ORDER BY dwi.report_date, wt.name, o.name NULLS LAST, COALESCE(seg.id::text, dwi.id::text)
        """,
        params,
    )
    total = 0.0
    out = []
    for r in rows:
        volume = float(r.get("volume") or 0)
        total += volume
        out.append({
            "id": r.get("id"),
            "date": r["report_date"].isoformat() if r.get("report_date") else None,
            "tag": r.get("tag") or "",
            "work_type_code": r.get("work_type_code"),
            "work_type_name": r.get("work_type_name") or r.get("work_type_code") or "—",
            "unit": r.get("unit") or "—",
            "volume": round(volume, 2),
            "section_code": _merge_section(r.get("section_code")) or r.get("section_code") or "—",
            "object_code": r.get("object_code"),
            "object_name": r.get("object_name") or "—",
            "object_type_code": r.get("object_type_code"),
            "object_type_name": r.get("object_type_name") or "—",
            "shift": r.get("shift"),
            "contractor_name": r.get("contractor_name") or "",
            "comment": r.get("comment") or "",
        })
    return {
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "total": round(total, 2),
        "rows": out,
    }


# ── analytics summary ───────────────────────────────────────────────────

@router.get("/analytics/summary")
def analytics_summary(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
):
    """
    Возвращает абсолютные числа (без процентов) в разрезе категорий:
      sand, soil, shps, transport — и по каждой разбивка
      {total, by_section, by_shift, plan, fact, by_contractor}.
    На фронте процент вычисляется только в прогресс-барах (fact/plan).
    """
    d_from, d_to = _parse_range(date_from, date_to)
    codes = _expand_sections(section)

    where_mm = ["mm.report_date >= %s", "mm.report_date <= %s", _approved_report_exists("mm")]
    params_mm: list = [d_from, d_to]
    if codes:
        where_mm.append("cs.code = ANY(%s)")
        params_mm.append(codes)

    # Транспорт: факт перевозок в м³/рейсах по материалу × участку × смене × подрядчику
    rows = query(
        f"""
        SELECT m.code            AS material,
               cs.code           AS section_code,
               mm.shift,
               c.kind            AS contractor_kind,
               c.short_name      AS contractor_short,
               SUM(mm.volume)::numeric AS volume,
               SUM(mm.trip_count)::int AS trips
        FROM material_movements mm
        JOIN daily_reports dr ON dr.id = mm.daily_report_id
        JOIN materials m ON m.id = mm.material_id
        LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
        LEFT JOIN contractors c ON c.id = mm.contractor_id
        WHERE {' AND '.join(where_mm)}
          AND mm.movement_type IN ('pit_to_constructive','pit_to_stockpile')
        GROUP BY m.code, cs.code, mm.shift, c.kind, c.short_name
        """,
        params_mm,
    )

    MAT_CAT = {'SAND': 'sand', 'COARSE_SAND': 'sand', 'SOIL': 'soil', 'SHPGS': 'shps', 'PEAT': 'peat'}
    SECTIONS_ALL = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8','—']

    def empty_cat() -> dict:
        return {
            'fact': 0.0, 'plan': 0.0,
            'trips': 0,
            'by_section': {s: 0.0 for s in SECTIONS_ALL},
            'by_shift': {'day': 0.0, 'night': 0.0},
            'by_contractor': {'own': 0.0, 'almaz': 0.0, 'other_hired': 0.0},
        }

    cats: dict[str, dict] = {
        'sand': empty_cat(),
        'soil': empty_cat(),
        'shps': empty_cat(),
        'peat': empty_cat(),
        'transport': empty_cat(),  # агрегат всех материалов
    }

    for r in rows:
        cat = MAT_CAT.get(r['material'])
        v = float(r['volume'] or 0)
        t = int(r['trips'] or 0)
        sec = r['section_code']
        shift = r['shift'] if r['shift'] in ('day', 'night') else 'day'
        if r['contractor_kind'] == 'own':
            bucket = 'own'
        elif (r['contractor_short'] or '').upper() == 'АЛМАЗ':
            bucket = 'almaz'
        else:
            bucket = 'other_hired'

        for target in filter(None, [cat, 'transport']):
            c = cats[target]
            c['fact'] += v
            c['trips'] += t
            c['by_shift'][shift] += v
            c['by_contractor'][bucket] += v
            if sec in c['by_section']:
                c['by_section'][sec] += v

    # План по материалам — из project_work_items × materials
    plan_rows = query(
        """
        SELECT m.code AS material,
               COALESCE(SUM(pwi.project_volume), 0)::numeric AS plan
        FROM project_work_items pwi
        JOIN work_types wt ON wt.id = pwi.work_type_id
        LEFT JOIN materials m ON m.code =
          CASE wt.code
            WHEN 'EMBANKMENT_CONSTRUCTION' THEN 'SAND'
            WHEN 'PAVEMENT_SANDING'        THEN 'SAND'
            WHEN 'WEAK_SOIL_REPLACEMENT'   THEN 'SAND'
            WHEN 'EARTH_EXCAVATION'        THEN 'SOIL'
            WHEN 'CRUSHED_STONE_PLACEMENT' THEN 'SHPGS'
            ELSE NULL
          END
        WHERE m.code IS NOT NULL
        GROUP BY m.code
        """
    )
    for r in plan_rows:
        cat = MAT_CAT.get(r['material'])
        if cat and cat in cats:
            cats[cat]['plan'] = float(r['plan'] or 0)
    cats['transport']['plan'] = cats['sand']['plan']

    # Округление
    for c in cats.values():
        c['fact'] = round(c['fact'], 1)
        c['plan'] = round(c['plan'], 1)
        c['by_shift'] = {k: round(v, 1) for k, v in c['by_shift'].items()}
        c['by_section'] = {k: round(v, 1) for k, v in c['by_section'].items()}
        c['by_contractor'] = {k: round(v, 1) for k, v in c['by_contractor'].items()}

    return {
        'from': d_from.isoformat(),
        'to': d_to.isoformat(),
        'categories': cats,
        'sections': SECTIONS_ALL,
    }


@router.get("/analytics/works-details")
def analytics_works_details(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    category: str = Query(...),
    section: Optional[str] = None,
):
    """Rows that compose a main-work category value for a clicked section bar."""
    d_from, d_to = _parse_range(date_from, date_to)
    cat = category.upper()
    if cat not in WORKS_CATEGORIES and cat not in {"TRANSPORT", "ALL"}:
        raise HTTPException(400, "Неизвестная категория")
    codes = _expand_sections(section)
    rules = _analytics_rules()

    rows: list[dict] = []
    if cat in {"SAND", "SHPS", "TRANSPORT", "ALL"}:
        where = ["mm.report_date BETWEEN %s AND %s", _approved_report_exists("mm")]
        params: list = [d_from, d_to]
        if codes:
            where.append("cs.code = ANY(%s)")
            params.append(codes)
        if cat == "SAND":
            where.append("mat.code IN ('SAND', 'COARSE_SAND')")
            where.append("mm.movement_type IN ('pit_to_constructive', 'stockpile_to_constructive')")
        elif cat == "SHPS":
            where.append("mat.code = 'SHPGS'")
            where.append("mm.movement_type IN ('pit_to_constructive', 'stockpile_to_constructive')")
        rows_raw = query(
            f"""
            SELECT
              mm.id::text AS id,
              mm.report_date,
              COALESCE(cs.code, '—') AS section_code,
              mat.code AS material_code,
              mat.name AS material_name,
              mm.movement_type,
              src.name AS from_name,
              dst.name AS to_name,
              mm.unit,
              mm.volume,
              mm.shift,
              COALESCE(mm.contractor_name, '') AS contractor_name
            FROM material_movements mm
            JOIN daily_reports dr ON dr.id = mm.daily_report_id
            LEFT JOIN materials mat ON mat.id = mm.material_id
            LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
            LEFT JOIN objects src ON src.id = mm.from_object_id
            LEFT JOIN objects dst ON dst.id = mm.to_object_id
            WHERE {' AND '.join(where)}
            ORDER BY mm.report_date, cs.code, src.name, dst.name
            """,
            params,
        )
        for r in rows_raw:
            if cat in {"TRANSPORT", "ALL"}:
                effective_cat = "TRANSPORT"
            else:
                effective_cat = "SAND" if r["material_code"] in {"SAND", "COARSE_SAND"} else ("SHPS" if r["material_code"] == "SHPGS" else cat)
            source_code = str(r["id"])
            included = _rule_included(rules, effective_cat, "material_movement", source_code)
            rows.append({
                "id": r["id"],
                "source_kind": "material_movement",
                "source_code": source_code,
                "category_code": effective_cat,
                "included": included,
                "date": r["report_date"].isoformat() if r.get("report_date") else None,
                "section_code": _merge_section(r.get("section_code")) or r.get("section_code"),
                "work_name": f"{r['material_name'] or r['material_code']} · {_movement_type_label(r['movement_type'])}",
                "object_name": f"{r.get('from_name') or '—'} → {r.get('to_name') or '—'}",
                "unit": r.get("unit") or "м3",
                "volume": round(float(r["volume"] or 0), 2),
                "shift": r.get("shift"),
                "contractor_name": r.get("contractor_name"),
            })
    else:
        wt_codes, object_type_codes = WORKS_CATEGORIES[cat]
        where = ["dwi.report_date BETWEEN %s AND %s", "wt.code = ANY(%s)", _approved_report_exists("dwi")]
        params = [d_from, d_to, list(wt_codes)]
        if codes:
            where.append("cs.code = ANY(%s)")
            params.append(codes)
        if object_type_codes:
            where.append("ot.code = ANY(%s)")
            params.append(list(object_type_codes))
        rows_raw = query(
            f"""
            SELECT
              dwi.id::text AS id,
              dwi.report_date,
              COALESCE(cs.code, '—') AS section_code,
              wt.code AS wt_code,
              wt.name AS wt_name,
              obj.name AS object_name,
              ot.code AS object_type_code,
              dwi.unit,
              dwi.volume,
              dwi.shift,
              COALESCE(dwi.contractor_name, '') AS contractor_name
            FROM daily_work_items dwi
            JOIN daily_reports dr ON dr.id = dwi.daily_report_id
            JOIN work_types wt ON wt.id = dwi.work_type_id
            LEFT JOIN construction_sections cs ON cs.id = COALESCE(dwi.section_id, dr.section_id)
            LEFT JOIN objects obj ON obj.id = dwi.object_id
            LEFT JOIN object_types ot ON ot.id = obj.object_type_id
            WHERE {' AND '.join(where)}
            ORDER BY dwi.report_date, cs.code, wt.name, obj.name
            """,
            params,
        )
        for r in rows_raw:
            source_code = str(r["id"])
            included = _rule_included(rules, cat, "daily_work_item", source_code)
            rows.append({
                "id": r["id"],
                "source_kind": "daily_work_item",
                "source_code": source_code,
                "category_code": cat,
                "included": included,
                "date": r["report_date"].isoformat() if r.get("report_date") else None,
                "section_code": _merge_section(r.get("section_code")) or r.get("section_code"),
                "work_name": r.get("wt_name") or r.get("wt_code"),
                "object_name": r.get("object_name") or r.get("object_type_code") or "—",
                "unit": r.get("unit"),
                "volume": round(float(r["volume"] or 0), 2),
                "shift": r.get("shift"),
                "contractor_name": r.get("contractor_name"),
            })

    total = sum(r["volume"] for r in rows if r["included"])
    return {"from": d_from.isoformat(), "to": d_to.isoformat(), "category": cat, "section": section, "total": round(total, 2), "rows": rows}


@router.patch("/analytics/work-category-rule")
def patch_analytics_work_category_rule(body: AnalyticsRulePatch, _manager=Depends(require_settings_manager)):
    _ensure_analytics_rules_table()
    category = (body.category_code or "").strip().upper()
    source_kind = (body.source_kind or "").strip()
    source_code = (body.source_code or "").strip()
    if not category or not source_kind or not source_code:
        raise HTTPException(400, "category_code, source_kind и source_code обязательны")
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO analytics_work_category_rules
                      (category_code, source_kind, source_code, included, comment, updated_at, updated_by)
                    VALUES (%s, %s, %s, %s, %s, now(), %s)
                    ON CONFLICT (category_code, source_kind, source_code) DO UPDATE
                    SET included = EXCLUDED.included,
                        comment = EXCLUDED.comment,
                        updated_at = now(),
                        updated_by = EXCLUDED.updated_by
                    """,
                    (category, source_kind, source_code, bool(body.included), body.comment, body.updated_by or "dashboard"),
                )
        return {"ok": True, "category_code": category, "source_kind": source_kind, "source_code": source_code, "included": bool(body.included)}
    finally:
        conn.close()


# ── analytics works summary (показатели по основным работам) ──────────

# Семантическое соответствие UI-категории → (work_type_codes, object_type_codes).
# object_type_codes=None → любые типы объектов.
WORKS_CATEGORIES = {
    'SAND':     (['EMBANKMENT_CONSTRUCTION', 'PAVEMENT_SANDING'], None),
    'PRS':      (['TOPSOIL_STRIPPING'], None),
    'VYEMKA':   (['EARTH_EXCAVATION'], ['TEMP_ROAD']),
    'VYEMKA_OH':(['EARTH_EXCAVATION'], ['MAIN_TRACK']),
    'PEAT_VAD': (['PEAT_REMOVAL'], ['TEMP_ROAD']),
    'PEAT_OH':  (['PEAT_REMOVAL'], ['MAIN_TRACK']),
    'SCHEBEN':  ([], None),                                    # отдельный материал/правило учета
    'SHPS':     (['CRUSHED_STONE_PLACEMENT', 'FIRST_PROTECTIVE_LAYER'], None),
}

WORKS_CATEGORY_TAGS = {
    'SAND': {'Песок (Насыпь)', 'Песок (ДСО)', 'Песок (Замена)', 'Песок (Обочины)'},
    'PRS': {'ПРС'},
    'VYEMKA': {'Выемка'},
    'VYEMKA_OH': {'Выемка'},
    'PEAT_VAD': {'Выторфовка'},
    'PEAT_OH': {'Выторфовка'},
    'SCHEBEN': {'Щебень'},
    'SHPS': {'ЩПС', 'ЩПГС'},
}

WORKS_OBJECT_GROUP_SPLITS = {
    'SAND': (set(WORKS_CATEGORIES['SAND'][0]), WORKS_CATEGORY_TAGS['SAND']),
    'VYEMKA': ({'EARTH_EXCAVATION'}, {'Выемка'}),
    'PEAT': ({'PEAT_REMOVAL'}, {'Выторфовка'}),
}


class AnalyticsRulePatch(BaseModel):
    category_code: str
    source_kind: str
    source_code: str
    included: bool
    comment: Optional[str] = None
    updated_by: Optional[str] = None


def _ensure_analytics_rules_table() -> None:
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_work_category_rules (
                      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                      category_code text NOT NULL,
                      source_kind text NOT NULL,
                      source_code text NOT NULL,
                      included boolean NOT NULL DEFAULT true,
                      comment text,
                      updated_at timestamptz NOT NULL DEFAULT now(),
                      updated_by text,
                      UNIQUE (category_code, source_kind, source_code)
                    )
                    """
                )
    finally:
        conn.close()


def _analytics_rules() -> dict[tuple[str, str, str], bool]:
    try:
        rows = query(
            """
            SELECT category_code, source_kind, source_code, included
            FROM analytics_work_category_rules
            """
        )
    except Exception:
        return {}
    return {
        (str(r["category_code"]), str(r["source_kind"]), str(r["source_code"])): bool(r["included"])
        for r in rows
    }


def _rule_included(rules: dict[tuple[str, str, str], bool], category: str, source_kind: str, source_code: str) -> bool:
    return rules.get((category, source_kind, source_code), True)


@router.get("/analytics/works-summary")
def analytics_works_summary(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
):
    """
    «Показатели по основным работам»: факт и план по категориям работ
    (sand=насыпь песком+ДО, PRS=срезка, VYEMKA=выемка на ВПД, VYEMKA_OH=выемка ОХ,
    shps=ЩПС/ЩПГС работы). Возвращает тот же shape, что и analytics/summary,
    только факт считается из daily_work_items (реальные работы, не перевозка).
    Плюс отдельная категория `transport` — из material_movements (сохранена).
    """
    d_from, d_to = _parse_range(date_from, date_to)
    codes = _expand_sections(section)

    SECTIONS_ALL = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8','—']

    def empty_object_group() -> dict[str, float]:
        return {'main_track': 0.0, 'temp_road': 0.0, 'other': 0.0}

    def empty_cat() -> dict:
        return {
            'fact': 0.0, 'plan': 0.0,
            'trips': 0,
            'by_section': {s: 0.0 for s in SECTIONS_ALL},
            'by_shift': {'day': 0.0, 'night': 0.0},
            'by_contractor': {'own': 0.0, 'almaz': 0.0, 'other_hired': 0.0},
            'by_object_group': empty_object_group(),
            'by_section_object_group': {s: empty_object_group() for s in SECTIONS_ALL},
        }

    def empty_object_group_summary() -> dict:
        return {
            'by_object_group': empty_object_group(),
            'by_section_object_group': {s: empty_object_group() for s in SECTIONS_ALL},
        }

    def object_group_for_summary(object_type_code: Optional[str]) -> str:
        code = (object_type_code or '').upper()
        if code == 'MAIN_TRACK':
            return 'main_track'
        if code in {'TEMP_ROAD', 'VPD', 'VAD'}:
            return 'temp_road'
        return 'other'

    def split_rule_category(split_key: str, object_group: str) -> str:
        if split_key == 'VYEMKA':
            return 'VYEMKA_OH' if object_group == 'main_track' else 'VYEMKA'
        if split_key == 'PEAT':
            return 'PEAT_OH' if object_group == 'main_track' else 'PEAT_VAD'
        return split_key

    cats: dict[str, dict] = {k: empty_cat() for k in list(WORKS_CATEGORIES.keys()) + ['transport']}
    object_group_summary: dict[str, dict] = {k: empty_object_group_summary() for k in WORKS_OBJECT_GROUP_SPLITS}
    rules = _analytics_rules()

    # 1. Факты работ из daily_work_items × object_types × contractors
    where_dwi = ["dwi.report_date BETWEEN %s AND %s", _approved_report_exists("dwi")]
    params_dwi: list = [d_from, d_to]
    if codes:
        where_dwi.append("cs_eff.code = ANY(%s)")
        params_dwi.append(codes)
    effective_section_join = _effective_section_join("seg")
    seg_volume_expr = _analytics_segment_volume_expr("seg")
    work_rows = query(
        f"""
        SELECT dwi.id::text      AS item_id,
               wt.code           AS wt_code,
               {WORK_TAG_EXPR}   AS analytics_tag,
               cs_eff.code        AS section_code,
               COALESCE(LOWER(dwi.shift), 'day') AS shift,
               ot.code            AS object_type_code,
               LOWER(COALESCE(dwi.contractor_name, '')) AS contractor_name_lower,
               dwi.labor_source_type AS labor_src,
               {seg_volume_expr}::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {effective_section_join}
        WHERE {' AND '.join(where_dwi)}
        """,
        params_dwi,
    )

    for r in work_rows:
        v = float(r['volume'] or 0)
        sec = _merge_section(r.get('section_code')) or r.get('section_code') or '—'
        shift = r['shift'] if r['shift'] in ('day','night') else 'day'
        contr = r['contractor_name_lower'] or ''
        if r['labor_src'] == 'own':
            bucket = 'own'
        elif 'алмаз' in contr:
            bucket = 'almaz'
        else:
            bucket = 'other_hired'
        object_group = object_group_for_summary(r.get('object_type_code'))
        tag = (r.get('analytics_tag') or '').strip()
        for split_key, (split_wt_codes, split_tags) in WORKS_OBJECT_GROUP_SPLITS.items():
            matched_by_code = bool(split_wt_codes) and r['wt_code'] in split_wt_codes
            matched_by_tag = bool(tag) and tag in split_tags
            if not (matched_by_code or matched_by_tag):
                continue
            rule_category = split_rule_category(split_key, object_group)
            if not _rule_included(rules, rule_category, 'daily_work_item', str(r['item_id'])):
                continue
            split = object_group_summary[split_key]
            split['by_object_group'][object_group] += v
            if sec in split['by_section_object_group']:
                split['by_section_object_group'][sec][object_group] += v
        for cat_key, (wt_codes, object_type_codes) in WORKS_CATEGORIES.items():
            tag = (r.get('analytics_tag') or '').strip()
            category_tags = WORKS_CATEGORY_TAGS.get(cat_key, set())
            matched_by_code = bool(wt_codes) and r['wt_code'] in wt_codes
            matched_by_tag = bool(tag) and tag in category_tags
            if not (matched_by_code or matched_by_tag):
                continue
            if object_type_codes and r['object_type_code'] not in object_type_codes:
                continue
            if not _rule_included(rules, cat_key, 'daily_work_item', str(r['item_id'])):
                continue
            c = cats[cat_key]
            c['fact'] += v
            c['by_shift'][shift] += v
            c['by_contractor'][bucket] += v
            if sec in c['by_section']:
                c['by_section'][sec] += v
            if cat_key == 'SAND':
                c['by_object_group'][object_group] += v
                if sec in c['by_section_object_group']:
                    c['by_section_object_group'][sec][object_group] += v

    # 2. Транспорт — отдельная категория из material_movements (не перезаписывается работами)
    where_mm = ["mm.report_date BETWEEN %s AND %s", _approved_report_exists("mm")]
    params_mm: list = [d_from, d_to]
    if codes:
        where_mm.append("cs.code = ANY(%s)")
        params_mm.append(codes)
    tr_rows = query(
        f"""
        SELECT mm.id::text AS item_id,
               mat.code AS material,
               cs.code AS section_code,
               LOWER(COALESCE(mm.shift, 'day')) AS shift,
               LOWER(COALESCE(mm.contractor_name, '')) AS contractor_name_lower,
               mm.labor_source_type AS labor_src,
               mm.movement_type,
               mm.volume::numeric AS volume,
               COALESCE(mm.trip_count, 0)::int AS trips
        FROM material_movements mm
        JOIN daily_reports dr ON dr.id = mm.daily_report_id
        LEFT JOIN materials mat ON mat.id = mm.material_id
        LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
        WHERE {' AND '.join(where_mm)}
        """,
        params_mm,
    )
    tr = cats['transport']
    for r in tr_rows:
        v = float(r['volume'] or 0)
        t = int(r['trips'] or 0)
        sec = _merge_section(r.get('section_code')) or r.get('section_code') or '—'
        shift = r['shift'] if r['shift'] in ('day','night') else 'day'
        contr = r['contractor_name_lower'] or ''
        if r['labor_src'] == 'own':
            bucket = 'own'
        elif 'алмаз' in contr:
            bucket = 'almaz'
        else:
            bucket = 'other_hired'
        material = (r['material'] or '').upper()
        movement_type = r['movement_type']
        source_code = str(r['item_id'])
        if _rule_included(rules, 'TRANSPORT', 'material_movement', source_code):
            tr['fact'] += v
            tr['trips'] += t
            tr['by_shift'][shift] += v
            tr['by_contractor'][bucket] += v
            if sec in tr['by_section']:
                tr['by_section'][sec] += v
    # 3. План — из project_work_items, группируем по типам объектов там, где это важно.
    plan_rows = query(
        """
        SELECT wt.code AS wt_code,
               ot.code AS object_type_code,
               COALESCE(SUM(pwi.project_volume), 0)::numeric AS plan
        FROM project_work_items pwi
        JOIN work_types wt ON wt.id = pwi.work_type_id
        LEFT JOIN objects obj ON obj.id = pwi.object_id
        LEFT JOIN object_types ot ON ot.id = obj.object_type_id
        GROUP BY wt.code, ot.code
        """
    )
    for cat_key, (wt_codes, object_type_codes) in WORKS_CATEGORIES.items():
        plan = 0.0
        for r in plan_rows:
            if r['wt_code'] not in wt_codes:
                continue
            if object_type_codes and r['object_type_code'] not in object_type_codes:
                continue
            plan += float(r['plan'] or 0)
        cats[cat_key]['plan'] = round(plan, 1)
    cats['transport']['plan'] = cats['SAND']['plan']

    # Округление
    for c in cats.values():
        c['fact'] = round(c['fact'], 1)
        c['by_shift'] = {k: round(v, 1) for k, v in c['by_shift'].items()}
        c['by_section'] = {k: round(v, 1) for k, v in c['by_section'].items()}
        c['by_contractor'] = {k: round(v, 1) for k, v in c['by_contractor'].items()}
        c['by_object_group'] = {k: round(v, 1) for k, v in c['by_object_group'].items()}
        c['by_section_object_group'] = {
            section_code: {k: round(v, 1) for k, v in group.items()}
            for section_code, group in c['by_section_object_group'].items()
        }
    for split in object_group_summary.values():
        split['by_object_group'] = {k: round(v, 1) for k, v in split['by_object_group'].items()}
        split['by_section_object_group'] = {
            section_code: {k: round(v, 1) for k, v in group.items()}
            for section_code, group in split['by_section_object_group'].items()
        }

    return {
        'from': d_from.isoformat(),
        'to': d_to.isoformat(),
        'categories': cats,
        'object_group_summary': object_group_summary,
        'sections': SECTIONS_ALL,
    }


def _analytics_quarry_group_key(quarry_name: object, fallback_id: object = None) -> str:
    key = _quarry_label_key(_quarry_display_name(quarry_name))
    if key:
        return f"quarry:{key}"
    return str(fallback_id or "quarry:unknown")


def _analytics_material_list(materials: object) -> list[str]:
    if isinstance(materials, str):
        return [part.strip() for part in materials.split(",") if part.strip()]
    if isinstance(materials, (list, tuple, set)):
        return [str(part).strip() for part in materials if str(part).strip()]
    return []


def _analytics_contractor_bucket(
    labor_source_type: object = None,
    contractor_name: object = None,
    contractor_bucket: object = None,
) -> str:
    bucket = str(contractor_bucket or "").strip().lower()
    if bucket == "zhds" or str(labor_source_type or "").strip().lower() == "own":
        return "own"
    contractor = str(contractor_name or "").strip().lower().replace("ё", "е")
    if bucket == "almaz" or "алмаз" in contractor:
        return "almaz"
    return "hired"


def _analytics_section_matches(section_code: object, codes: Optional[list[str]]) -> bool:
    if not codes:
        return True
    raw = str(section_code or "").strip()
    merged = _merge_section(raw) or raw
    return raw in codes or merged in codes


def _analytics_float(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _analytics_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _analytics_add_quarry_aggregate(
    grouped: dict[str, dict],
    *,
    label_index: Optional[dict[str, str]] = None,
    prefer_label_index: bool = False,
    quarry_id: object = None,
    quarry_name: object = None,
    volume: object = 0,
    movement_type: object = None,
    shift: object = None,
    section_code: object = None,
    contractor_name: object = "",
    labor_source_type: object = None,
    contractor_bucket: object = None,
    materials: object = None,
    trips: object = 0,
    lat: object = None,
    lng: object = None,
    synthetic: bool = False,
) -> None:
    v = _analytics_float(volume)
    if v <= 0:
        return
    display_name = _quarry_display_name(quarry_name)
    label_key = _analytics_quarry_group_key(display_name, quarry_id)
    if label_index and label_key in label_index:
        group_key = label_index[label_key]
    elif quarry_id:
        group_key = str(quarry_id)
    else:
        group_key = label_key
    if label_index is not None:
        label_index.setdefault(label_key, group_key)
    item = grouped.setdefault(group_key, {
        'quarry_id': str(quarry_id or f"synthetic:{label_key}"),
        'quarry_name': display_name,
        'material': set(),
        'volume': 0.0,
        'trips': 0,
        'by_shift': {'day': 0.0, 'night': 0.0},
        'by_direction': {},
        'by_contractor': {'own': 0.0, 'almaz': 0.0, 'hired': 0.0},
        'by_section': {},
        'items': [],
        'lat': _analytics_float(lat) if lat else None,
        'lng': _analytics_float(lng) if lng else None,
    })
    if quarry_id and str(item.get('quarry_id') or '').startswith('synthetic:'):
        item['quarry_id'] = str(quarry_id)
    if item.get('lat') is None and lat:
        item['lat'] = _analytics_float(lat)
    if item.get('lng') is None and lng:
        item['lng'] = _analytics_float(lng)

    item['volume'] += v
    item['trips'] += _analytics_int(trips)
    shift_key = str(shift or '').strip().lower()
    if shift_key not in ('day', 'night'):
        shift_key = 'day'
    item['by_shift'][shift_key] += v

    movement_code = str(movement_type or '') or None
    direction = _movement_type_label(movement_code)
    item['by_direction'][direction] = item['by_direction'].get(direction, 0.0) + v

    section_value = str(section_code or '').strip()
    section_display = _merge_section(section_value) or section_value or '—'
    item['by_section'][section_display] = item['by_section'].get(section_display, 0.0) + v

    bucket = _analytics_contractor_bucket(labor_source_type, contractor_name, contractor_bucket)
    item['by_contractor'][bucket] += v

    for mat in _analytics_material_list(materials):
        item['material'].add(mat)

    item['items'].append({
        'movement_type': movement_code,
        'movement_label': direction,
        'shift': shift_key,
        'section_code': section_display,
        'contractor_bucket': bucket,
        'contractor_name': contractor_name,
        'material': ','.join(_analytics_material_list(materials)),
        'volume': round(v, 1),
        'trips': _analytics_int(trips),
        'synthetic': synthetic,
    })


# ── analytics donut: volume per quarry ─────────────────────────────────

@router.get("/analytics/quarry-donut")
def analytics_quarry_donut(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
    material: Optional[str] = None,
    source_type: Optional[str] = Query(None, description="quarry | stockpile; default — все"),
):
    """Донат-диаграмма: объёмы по источникам (карьеры/накопители).

    source_type:
      quarry    — только from_object_type = BORROW_PIT (реальные карьеры)
      stockpile — только STOCKPILE (накопители)
      (none)    — всё вместе (back-compat).
    """
    d_from, d_to = _parse_range(date_from, date_to)
    codes = _expand_sections(section)

    where = ["mm.report_date >= %s", "mm.report_date <= %s", _approved_report_exists("mm")]
    params: list = [d_from, d_to]
    if codes:
        where.append("cs.code = ANY(%s)")
        params.append(codes)
    if material:
        where.append("m.code = %s")
        params.append(material)
    if source_type == 'quarry':
        # Возка именно с карьеров: карьер → накопитель и карьер → конструктив.
        where.append("ot.code = 'BORROW_PIT'")
        where.append("mm.movement_type IN ('pit_to_stockpile', 'pit_to_constructive')")
    elif source_type == 'stockpile':
        where.append("ot.code = 'STOCKPILE'")
        where.append("mm.movement_type IN ('stockpile_to_constructive', 'stockpile_to_stockpile')")

    rows = query(
        f"""
        SELECT pit.id          AS quarry_id,
               pit.name         AS quarry_name,
               os.start_lat     AS start_lat,
               os.start_lng     AS start_lng,
               mm.movement_type,
               LOWER(COALESCE(mm.shift, 'day')) AS shift,
               COALESCE(mm.contractor_name, '') AS contractor_name,
               mm.labor_source_type,
               cs.code AS section_code,
               SUM(mm.volume)::numeric AS volume,
               SUM(mm.trip_count)::int AS trips,
               STRING_AGG(DISTINCT m.code, ',' ORDER BY m.code) AS materials
        FROM material_movements mm
        JOIN daily_reports dr ON dr.id = mm.daily_report_id
        JOIN materials m ON m.id = mm.material_id
        LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
        LEFT JOIN objects pit ON pit.id = mm.from_object_id
        LEFT JOIN object_types ot ON ot.id = pit.object_type_id
        LEFT JOIN LATERAL (
            SELECT start_lat, start_lng
            FROM object_segments
            WHERE object_id = pit.id
            ORDER BY pk_start
            LIMIT 1
        ) os ON true
        WHERE {' AND '.join(where)}
          AND pit.id IS NOT NULL
        GROUP BY pit.id, pit.name, os.start_lat, os.start_lng,
                 mm.movement_type, mm.shift, mm.contractor_name, mm.labor_source_type, cs.code
        ORDER BY volume DESC
        """,
        params,
    )

    grouped: dict[str, dict] = {}
    grouped_by_label: dict[str, str] = {}
    for r in rows:
        _analytics_add_quarry_aggregate(
            grouped,
            label_index=grouped_by_label,
            quarry_id=r.get('quarry_id'),
            quarry_name=r.get('quarry_name'),
            volume=r.get('volume'),
            movement_type=r.get('movement_type'),
            shift=r.get('shift'),
            section_code=r.get('section_code'),
            contractor_name=r.get('contractor_name'),
            labor_source_type=r.get('labor_source_type'),
            materials=r.get('materials'),
            trips=r.get('trips'),
            lat=r.get('start_lat'),
            lng=r.get('start_lng'),
        )

    include_synthetic = source_type == 'quarry' and d_from <= ANALYTICS_INCEPTION_DATE
    synthetic_materials = {str(material).upper()} if material else None
    if include_synthetic:
        for row in _dashboard_synthetic_transport_rows_for_period(d_from, d_to, synthetic_materials):
            if material and str(row.get('material') or '').upper() != str(material).upper():
                continue
            if not _analytics_section_matches(row.get('section_code'), codes):
                continue
            base_volume = _analytics_float(row.get('volume'))
            _analytics_add_quarry_aggregate(
                grouped,
                label_index=grouped_by_label,
                prefer_label_index=True,
                quarry_id=None,
                quarry_name=row.get('quarry_name') or row.get('source_object_name'),
                volume=base_volume * ANALYTICS_SYNTHETIC_DAY_SHARE,
                movement_type=row.get('movement_type'),
                shift='day',
                section_code=row.get('section_code'),
                contractor_name=row.get('contractor_name'),
                labor_source_type=row.get('labor_source_type'),
                contractor_bucket=row.get('contractor_bucket'),
                materials=row.get('material'),
                trips=0,
                synthetic=True,
            )
            _analytics_add_quarry_aggregate(
                grouped,
                label_index=grouped_by_label,
                prefer_label_index=True,
                quarry_id=None,
                quarry_name=row.get('quarry_name') or row.get('source_object_name'),
                volume=base_volume * ANALYTICS_SYNTHETIC_NIGHT_SHARE,
                movement_type=row.get('movement_type'),
                shift='night',
                section_code=row.get('section_code'),
                contractor_name=row.get('contractor_name'),
                labor_source_type=row.get('labor_source_type'),
                contractor_bucket=row.get('contractor_bucket'),
                materials=row.get('material'),
                trips=0,
                synthetic=True,
            )
    total = sum(float(item['volume'] or 0) for item in grouped.values())
    out = []
    for item in grouped.values():
        v = float(item['volume'] or 0)
        item['material'] = ','.join(sorted(item['material']))
        item['volume'] = round(v, 1)
        item['share'] = round(v / total * 100, 1) if total > 0 else 0
        item['by_shift'] = {k: round(val, 1) for k, val in item['by_shift'].items()}
        item['by_direction'] = {k: round(val, 1) for k, val in item['by_direction'].items()}
        item['by_contractor'] = {k: round(val, 1) for k, val in item['by_contractor'].items()}
        item['by_section'] = {k: round(val, 1) for k, val in item['by_section'].items()}
        out.append(item)
    out.sort(key=lambda item: item['volume'], reverse=True)
    return {'total': round(total, 1), 'rows': out}


# ── analytics timeseries (за период, по дням per-category) ─────────────

@router.get("/analytics/works-timeseries")
def works_timeseries(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    category: str = Query("SAND"),
):
    """Ряд (дата, факт) per-category для спарклайна + heatmap (дата × участок).

    category: SAND | PRS | VYEMKA | VYEMKA_OH | SCHEBEN | SHPS | TRANSPORT
    """
    d_from, d_to = _parse_range(date_from, date_to)
    spec = WORKS_CATEGORIES.get(category.upper())
    if category.upper() == 'TRANSPORT' or spec is None:
        # Перевозка = material_movements (всё)
        rows = query(
            f"""
            SELECT mm.report_date AS d, cs.code AS sec, SUM(mm.volume)::numeric AS v
            FROM material_movements mm
            JOIN daily_reports dr ON dr.id = mm.daily_report_id
            LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
            WHERE mm.report_date BETWEEN %s AND %s
              AND {_approved_report_exists("mm")}
            GROUP BY mm.report_date, cs.code
            """, (d_from, d_to))
    else:
        wt_codes, object_type_codes = spec
        tag_expr = WORK_TAG_EXPR
        category_tags = sorted(WORKS_CATEGORY_TAGS.get(category.upper(), set()))
        where = ["dwi.report_date BETWEEN %s AND %s", _approved_report_exists("dwi"), "dwi.is_demo IS NOT TRUE"]
        params: list = [d_from, d_to]
        match_clauses: list[str] = []
        if wt_codes:
            match_clauses.append("wt.code = ANY(%s)")
            params.append(list(wt_codes))
        if category_tags:
            match_clauses.append(f"{tag_expr} = ANY(%s)")
            params.append(category_tags)
        if match_clauses:
            where.append("(" + " OR ".join(match_clauses) + ")")
        if object_type_codes:
            where.append("ot.code = ANY(%s)")
            params.append(list(object_type_codes))
        effective_section_join = _effective_section_join("seg")
        seg_volume_expr = _analytics_segment_volume_expr("seg")
        rows = query(
            f"""
            SELECT dwi.report_date AS d, cs_eff.code AS sec, SUM({seg_volume_expr})::numeric AS v
            FROM daily_work_items dwi
            JOIN work_types wt ON wt.id = dwi.work_type_id
            LEFT JOIN objects o ON o.id = dwi.object_id
            LEFT JOIN object_types ot ON ot.id = o.object_type_id
            {effective_section_join}
            WHERE {' AND '.join(where)}
            GROUP BY dwi.report_date, cs_eff.code
            """, params)

    by_day: dict[str, float] = {}
    by_day_sec: dict[tuple, float] = {}
    for r in rows:
        d = r['d'].isoformat()
        sec = _merge_section(r['sec']) or r['sec'] or '—'
        v = float(r['v'] or 0)
        by_day[d] = by_day.get(d, 0) + v
        by_day_sec[(d, sec)] = by_day_sec.get((d, sec), 0) + v
    # Заполняем пустые дни нулями.
    days = []
    cur = d_from
    while cur <= d_to:
        days.append(cur.isoformat())
        cur += timedelta(days=1)
    sections_all = ['UCH_1','UCH_2','UCH_3','UCH_4','UCH_5','UCH_6','UCH_7','UCH_8']
    if any(sec == '—' for (_day, sec) in by_day_sec.keys()):
        sections_all.append('—')
    timeseries = [{'date': d, 'value': round(by_day.get(d, 0), 1)} for d in days]
    heatmap = []
    for d in days:
        for sec in sections_all:
            v = by_day_sec.get((d, sec), 0)
            heatmap.append({'date': d, 'section': sec, 'value': round(v, 1)})
    return {'from': d_from.isoformat(), 'to': d_to.isoformat(),
            'category': category, 'days': days, 'sections': sections_all,
            'timeseries': timeseries, 'heatmap': heatmap}


# ── section rating: monthly bar-chart race ─────────────────────────────

SECTION_RATING_ACTUAL_TRANSPORT_START = date_cls(2026, 6, 2)
SECTION_RATING_TEMP_ROAD_SYNTHETIC_ANCHOR = date_cls(2026, 9, 15)
SECTION_RATING_SECTION_CODES = [f"UCH_{idx}" for idx in range(1, 9)]
SECTION_RATING_LEADERS = {
    1: "Шундеев Е.В.",
    2: "Мадиев А.Б.",
    3: "Ряузов А.Ю.",
    4: "Семенов В.В.",
    5: "Надыкто Н.В.",
    6: "Мифтахов Р.М.",
    7: "Бегунок М.Н.",
    8: "Демидов А.В.",
}
SECTION_RATING_METRICS = [
    {"key": "sand_delivery", "label": "Завоз песка", "unit": "м³", "digits": 0},
    {"key": "pile_driving", "label": "Погружение свай", "unit": "шт", "digits": 0},
    {"key": "shpgs_delivery", "label": "Завоз ЩПГС", "unit": "м³", "digits": 0},
    {"key": "temp_road_km", "label": "Пройдено притрассовых автодорог", "unit": "км", "digits": 2},
    {"key": "excavation", "label": "Разработка выемки", "unit": "м³", "digits": 0},
]
SECTION_RATING_PILE_BACKDATE_SOURCE_MONTH = date_cls(2026, 4, 1)
SECTION_RATING_PILE_BACKDATE_ROWS = [
    (date_cls(2026, 1, 29), 18, "UCH_2"),
    (date_cls(2026, 1, 29), 54, "UCH_1"),
    (date_cls(2026, 1, 29), 84, "UCH_1"),
    (date_cls(2026, 1, 29), 18, "UCH_5"),
    (date_cls(2026, 1, 29), 18, "UCH_4"),
    (date_cls(2026, 1, 29), 60, "UCH_7"),
    (date_cls(2026, 1, 29), 56, "UCH_1"),
    (date_cls(2026, 2, 12), 10, "UCH_1"),
    (date_cls(2026, 2, 13), 80, "UCH_4"),
    (date_cls(2026, 2, 13), 152, "UCH_1"),
    (date_cls(2026, 3, 3), 10, "UCH_1"),
    (date_cls(2026, 3, 4), 10, "UCH_1"),
    (date_cls(2026, 3, 5), 10, "UCH_1"),
    (date_cls(2026, 3, 7), 2, "UCH_1"),
    (date_cls(2026, 3, 9), 10, "UCH_1"),
    (date_cls(2026, 3, 10), 6, "UCH_1"),
    (date_cls(2026, 3, 11), 3, "UCH_1"),
    (date_cls(2026, 3, 12), 6, "UCH_1"),
    (date_cls(2026, 3, 13), 4, "UCH_1"),
    (date_cls(2026, 3, 14), 4, "UCH_1"),
    (date_cls(2026, 3, 15), 5, "UCH_1"),
    (date_cls(2026, 3, 16), 4, "UCH_1"),
    (date_cls(2026, 3, 17), 5, "UCH_1"),
    (date_cls(2026, 3, 19), 1, "UCH_1"),
    (date_cls(2026, 3, 20), 6, "UCH_1"),
    (date_cls(2026, 3, 21), 3, "UCH_1"),
    (date_cls(2026, 3, 22), 3, "UCH_1"),
]
_SECTION_RATING_CACHE: dict[tuple, tuple[float, dict]] = {}


def _section_rating_default_to() -> date_cls:
    row = query_one(
        """
        SELECT MAX(report_date) AS report_date
        FROM daily_reports
        WHERE COALESCE(is_demo, false) IS FALSE
          AND COALESCE(status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
        """
    )
    return (row or {}).get("report_date") or (date_cls.today() - timedelta(days=1))


def _section_rating_parse_range(date_from: Optional[str], date_to: Optional[str]) -> tuple[date_cls, date_cls]:
    d_to = date_cls.fromisoformat(date_to) if date_to else _section_rating_default_to()
    d_from = date_cls.fromisoformat(date_from) if date_from else date_cls(d_to.year, 1, 1)
    if d_from > d_to:
        d_from, d_to = d_to, d_from
    return d_from, d_to


def _section_rating_month_slices(d_from: date_cls, d_to: date_cls) -> list[tuple[date_cls, date_cls]]:
    slices: list[tuple[date_cls, date_cls]] = []
    cur = date_cls(d_from.year, d_from.month, 1)
    while cur <= d_to:
        month_end = date_cls(cur.year, cur.month, calendar.monthrange(cur.year, cur.month)[1])
        start = max(d_from, cur)
        end = min(d_to, month_end)
        if start <= end:
            slices.append((start, end))
        cur = date_cls(cur.year + (1 if cur.month == 12 else 0), 1 if cur.month == 12 else cur.month + 1, 1)
    return slices


def _section_rating_zero_values() -> dict[str, float]:
    return {code: 0.0 for code in SECTION_RATING_SECTION_CODES}


def _section_rating_add(values: dict[str, float], section_code: object, volume: object) -> None:
    code = _merge_section(str(section_code or "").strip()) or str(section_code or "").strip()
    if code not in values:
        return
    try:
        amount = float(volume or 0)
    except (TypeError, ValueError):
        amount = 0.0
    if amount:
        values[code] += amount


def _section_rating_sections() -> list[dict[str, Any]]:
    rows = query(
        """
        SELECT code, name, sort_order, map_color
        FROM construction_sections
        WHERE is_active IS NOT FALSE
        ORDER BY sort_order NULLS LAST, code
        """
    )
    by_code: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = _merge_section(row.get("code")) or row.get("code")
        if code not in SECTION_RATING_SECTION_CODES or code in by_code:
            continue
        num = _dashboard_section_num(code) or int(code.replace("UCH_", ""))
        by_code[code] = {
            "sectionCode": code,
            "sectionNumber": num,
            "sectionName": row.get("name") or f"Участок №{num}",
            "leaderName": SECTION_RATING_LEADERS.get(num),
            "color": row.get("map_color") or SECTION_FALLBACK_COLORS.get(code, "#64748b"),
        }
    for num in range(1, 9):
        code = f"UCH_{num}"
        by_code.setdefault(
            code,
            {
                "sectionCode": code,
                "sectionNumber": num,
                "sectionName": f"Участок №{num}",
                "leaderName": SECTION_RATING_LEADERS.get(num),
                "color": SECTION_FALLBACK_COLORS.get(code, "#64748b"),
            },
        )
    return [by_code[f"UCH_{num}"] for num in range(1, 9)]


def _section_rating_material_increment(material_code: str, d_from: date_cls, d_to: date_cls) -> dict[str, float]:
    values = _section_rating_zero_values()
    if d_from > d_to:
        return values
    synthetic_to = min(d_to, SECTION_RATING_ACTUAL_TRANSPORT_START - timedelta(days=1))
    if d_from <= synthetic_to:
        for row in _dashboard_synthetic_transport_rows_for_period(d_from, synthetic_to, {material_code}):
            if str(row.get("material") or "").upper() != material_code:
                continue
            if row.get("movement_type") not in {"pit_to_stockpile", "pit_to_constructive"}:
                continue
            _section_rating_add(values, row.get("section_code"), row.get("volume"))
    actual_from = max(d_from, SECTION_RATING_ACTUAL_TRANSPORT_START)
    if actual_from <= d_to:
        rows = query(
            f"""
            SELECT cs.code AS section_code,
                   SUM(mm.volume)::numeric AS volume
            FROM material_movements mm
            JOIN materials m ON m.id = mm.material_id
            LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, (
                SELECT dr.section_id FROM daily_reports dr WHERE dr.id = mm.daily_report_id
            ))
            WHERE mm.report_date BETWEEN %s AND %s
              AND mm.is_demo IS NOT TRUE
              AND {_approved_report_exists("mm")}
              AND UPPER(COALESCE(m.code, '')) = %s
              AND mm.movement_type IN ('pit_to_stockpile', 'pit_to_constructive')
            GROUP BY cs.code
            """,
            [actual_from, d_to, material_code],
        )
        for row in rows:
            _section_rating_add(values, row.get("section_code"), row.get("volume"))
    return values


def _section_rating_material_monthly(
    material_code: str,
    d_from: date_cls,
    d_to: date_cls,
    month_slices: list[tuple[date_cls, date_cls]],
    sand_distribution_monthly: Optional[dict[str, dict[str, float]]] = None,
) -> dict[str, dict[str, float]]:
    by_month = {start.isoformat(): _section_rating_zero_values() for start, _end in month_slices}
    if d_from > d_to:
        return by_month

    synthetic_to = min(d_to, SECTION_RATING_ACTUAL_TRANSPORT_START - timedelta(days=1))
    if d_from <= synthetic_to:
        synthetic_section_totals = _section_rating_zero_values()
        for row in _dashboard_synthetic_transport_rows_for_period(d_from, synthetic_to, {material_code}):
            if str(row.get("material") or "").upper() != material_code:
                continue
            if row.get("movement_type") not in {"pit_to_stockpile", "pit_to_constructive"}:
                continue
            _section_rating_add(synthetic_section_totals, row.get("section_code"), row.get("volume"))

        distribution = sand_distribution_monthly or _section_rating_work_monthly(
            d_from,
            synthetic_to,
            codes=DAILY_SUMMARY_SAND_WORK_CODES,
            tags=DAILY_SUMMARY_SAND_TAGS,
            patterns=["%пес%"],
        )
        for code, total in synthetic_section_totals.items():
            if total <= 0:
                continue
            denom = sum(float(month_values.get(code) or 0) for month_values in distribution.values())
            if denom > 0:
                for month_key, month_values in distribution.items():
                    if month_key in by_month:
                        by_month[month_key][code] += total * float(month_values.get(code) or 0) / denom
            else:
                total_days = max((synthetic_to - d_from).days + 1, 1)
                for month_start, month_end in month_slices:
                    overlap_start = max(month_start, d_from)
                    overlap_end = min(month_end, synthetic_to)
                    if overlap_start <= overlap_end:
                        by_month[month_start.isoformat()][code] += total * ((overlap_end - overlap_start).days + 1) / total_days

    actual_from = max(d_from, SECTION_RATING_ACTUAL_TRANSPORT_START)
    if actual_from <= d_to:
        rows = query(
            f"""
            SELECT date_trunc('month', mm.report_date)::date AS month_start,
                   cs.code AS section_code,
                   SUM(mm.volume)::numeric AS volume
            FROM material_movements mm
            JOIN materials m ON m.id = mm.material_id
            LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, (
                SELECT dr.section_id FROM daily_reports dr WHERE dr.id = mm.daily_report_id
            ))
            WHERE mm.report_date BETWEEN %s AND %s
              AND mm.is_demo IS NOT TRUE
              AND {_approved_report_exists("mm")}
              AND UPPER(COALESCE(m.code, '')) = %s
              AND mm.movement_type IN ('pit_to_stockpile', 'pit_to_constructive')
            GROUP BY date_trunc('month', mm.report_date)::date, cs.code
            """,
            [actual_from, d_to, material_code],
        )
        for row in rows:
            key = row.get("month_start").isoformat() if row.get("month_start") else None
            if key in by_month:
                _section_rating_add(by_month[key], row.get("section_code"), row.get("volume"))
    return by_month


def _section_rating_work_monthly(
    d_from: date_cls,
    d_to: date_cls,
    *,
    codes: set[str],
    tags: set[str],
    patterns: list[str],
    scope: str = "all",
) -> dict[str, dict[str, float]]:
    by_month = {start.isoformat(): _section_rating_zero_values() for start, _end in _section_rating_month_slices(d_from, d_to)}
    if d_from > d_to:
        return by_month
    object_type_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code)"
    object_code_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code)"
    scope_clause, scope_params = _dashboard_kpi_scope_clause(scope, object_type_expr, object_code_expr)
    tag_expr = DASHBOARD_SEG_WORK_TAG_EXPR
    seg_volume_expr = _analytics_segment_volume_expr("seg")
    match_clauses: list[str] = []
    params: list[Any] = [d_from, d_to]
    if codes:
        match_clauses.append("wt.code = ANY(%s)")
        params.append(list(codes))
    if tags:
        match_clauses.append(f"{tag_expr} = ANY(%s)")
        params.append(list(tags))
    if patterns:
        match_clauses.append(f"LOWER({tag_expr}) LIKE ANY(%s)")
        params.append(patterns)
    params.extend(scope_params)
    rows = query(
        f"""
        SELECT date_trunc('month', dwi.report_date)::date AS month_start,
               cs_eff.code AS section_code,
               SUM({seg_volume_expr})::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {_effective_section_join('seg')}
        LEFT JOIN pile_fields pf_detail ON pf_detail.id = seg.pile_field_id
        WHERE dwi.report_date BETWEEN %s AND %s
          AND dwi.is_demo IS NOT TRUE
          AND {_approved_report_exists("dwi")}
          AND ({' OR '.join(match_clauses) if match_clauses else 'false'})
          AND {scope_clause}
        GROUP BY date_trunc('month', dwi.report_date)::date, cs_eff.code
        """,
        params,
    )
    for row in rows:
        key = row.get("month_start").isoformat() if row.get("month_start") else None
        if key in by_month:
            _section_rating_add(by_month[key], row.get("section_code"), row.get("volume"))
    return by_month


def _section_rating_combine_monthly(
    month_slices: list[tuple[date_cls, date_cls]],
    *sources: dict[str, dict[str, float]],
) -> dict[str, dict[str, float]]:
    combined = {start.isoformat(): _section_rating_zero_values() for start, _end in month_slices}
    for source in sources:
        for month_key, values in (source or {}).items():
            if month_key not in combined:
                continue
            for code, value in (values or {}).items():
                if code not in combined[month_key]:
                    continue
                try:
                    combined[month_key][code] += float(value or 0)
                except (TypeError, ValueError):
                    continue
    return combined



def _section_rating_apply_pile_backdate_corrections(
    monthly: dict[str, dict[str, float]],
) -> dict[str, dict[str, float]]:
    source_key = SECTION_RATING_PILE_BACKDATE_SOURCE_MONTH.isoformat()
    for actual_date, count, section_code in SECTION_RATING_PILE_BACKDATE_ROWS:
        actual_key = date_cls(actual_date.year, actual_date.month, 1).isoformat()
        amount = float(count or 0)
        if actual_key in monthly and section_code in monthly[actual_key]:
            monthly[actual_key][section_code] += amount
        if source_key in monthly and section_code in monthly[source_key]:
            monthly[source_key][section_code] -= amount
    return monthly

def _section_rating_temp_road_candidate_dates() -> list[date_cls]:
    rows = query(
        """
        SELECT DISTINCT d
        FROM (
          SELECT status_date::date AS d
          FROM temporary_road_status_segments
          WHERE status_date IS NOT NULL
            AND COALESCE(is_demo, false) IS FALSE
            AND COALESCE(review_tag, '') = ''
          UNION ALL
          SELECT effective_date::date AS d
          FROM temporary_road_state_corrections
          WHERE effective_date IS NOT NULL
        ) src
        WHERE d IS NOT NULL
        ORDER BY d
        """
    )
    return [row.get("d") for row in rows if row.get("d")]


def _section_rating_temp_road_first_date() -> Optional[date_cls]:
    row = query_one(
        """
        SELECT MIN(status_date)::date AS first_date
        FROM temporary_road_status_segments
        WHERE status_date IS NOT NULL
          AND status_type = ANY(%s)
          AND COALESCE(is_demo, false) IS FALSE
          AND COALESCE(review_tag, '') = ''
        """,
        [list(TEMP_ROAD_STAGE3_STATUSES)],
    )
    first_date = row.get("first_date") if row and row.get("first_date") else None
    if first_date and sum(_section_rating_temp_road_values(first_date).values()) > 0:
        return first_date
    for candidate in _section_rating_temp_road_candidate_dates():
        if sum(_section_rating_temp_road_values(candidate).values()) > 0:
            return candidate
    return None


def _section_rating_temp_road_values(as_of: date_cls) -> dict[str, float]:
    values = _section_rating_zero_values()
    payload = _temp_roads_stage3_from_status_payload(as_of)
    source = payload.get("combined") if isinstance(payload.get("combined"), dict) else payload
    for row in source.get("sections") or []:
        section_num = row.get("section")
        code = f"UCH_{section_num}" if isinstance(section_num, int) else None
        if code in values:
            values[code] = float(row.get("passable_m") or 0) / 1000.0
    return values


def _section_rating_rank_rows(values: dict[str, float], section_meta: list[dict[str, Any]], digits: int) -> list[dict[str, Any]]:
    meta_by_code = {row["sectionCode"]: row for row in section_meta}
    rows = []
    for code in SECTION_RATING_SECTION_CODES:
        meta = meta_by_code[code]
        rows.append({
            **meta,
            "value": round(float(values.get(code) or 0.0), digits),
        })
    rows.sort(key=lambda row: (-float(row["value"] or 0), int(row["sectionNumber"] or 999)))
    for idx, row in enumerate(rows, start=1):
        row["rank"] = idx
    return rows


@router.get("/dashboard/section-rating-race")
def dashboard_section_rating_race(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    d_from, d_to = _section_rating_parse_range(date_from, date_to)
    if (d_to - d_from).days > 1095:
        raise HTTPException(status_code=422, detail="Период рейтинга не должен превышать 3 года")
    fingerprint = f"g{_dashboard_response_cache_generation()}"
    cache_key = (
        "section-rating-race:v8",
        d_from.isoformat(),
        d_to.isoformat(),
        fingerprint,
    )
    cached = _dashboard_short_cache_get(_SECTION_RATING_CACHE, cache_key)
    if cached is not None:
        return cached
    persistent_key = _dashboard_response_cache_key({
        "endpoint": "section_rating_race",
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
    })
    cached = _dashboard_response_cache_get("section_rating_race.v8", persistent_key, fingerprint)
    if cached is not None:
        return _dashboard_short_cache_set(_SECTION_RATING_CACHE, cache_key, cached)

    section_meta = _section_rating_sections()
    slices = _section_rating_month_slices(d_from, d_to)
    synthetic_to = min(d_to, SECTION_RATING_ACTUAL_TRANSPORT_START - timedelta(days=1))
    sand_distribution_monthly = (
        _section_rating_work_monthly(
            d_from,
            synthetic_to,
            codes=DAILY_SUMMARY_SAND_WORK_CODES,
            tags=DAILY_SUMMARY_SAND_TAGS,
            patterns=["%пес%"],
        )
        if d_from <= synthetic_to
        else {}
    )
    sand_monthly = _section_rating_material_monthly("SAND", d_from, d_to, slices, sand_distribution_monthly)
    shpgs_monthly = _section_rating_material_monthly("SHPGS", d_from, d_to, slices, sand_distribution_monthly)
    pile_monthly = _section_rating_apply_pile_backdate_corrections(_section_rating_work_monthly(
        d_from,
        d_to,
        codes={"PILE_MAIN", "PILE_TRIAL"},
        tags={"ОсСваи", "ПрСваи"},
        patterns=[],
    ))
    excavation_monthly = _section_rating_work_monthly(
        d_from,
        d_to,
        codes=DAILY_SUMMARY_EXCAVATION_WORK_CODES,
        tags=DAILY_SUMMARY_EXCAVATION_TAGS,
        patterns=["%выем%", "%выторф%"],
    )
    road_embankment_vad_monthly = _section_rating_work_monthly(
        d_from,
        d_to,
        codes={"EMBANKMENT_CONSTRUCTION"},
        tags={"Песок (Насыпь)"},
        patterns=["%насып%"],
        scope="vad",
    )
    road_fallback_distribution_monthly = _section_rating_combine_monthly(
        slices,
        road_embankment_vad_monthly,
    )

    first_road_date = _section_rating_temp_road_first_date()
    road_anchor_date = SECTION_RATING_TEMP_ROAD_SYNTHETIC_ANCHOR
    road_fallback_target = _section_rating_temp_road_values(road_anchor_date) if road_anchor_date else _section_rating_zero_values()
    road_fallback_denominator = _section_rating_zero_values()
    if road_anchor_date and d_from < road_anchor_date:
        fallback_to = min(d_to, road_anchor_date - timedelta(days=1))
        if d_from <= fallback_to:
            road_embankment_vad_before_anchor_monthly = _section_rating_work_monthly(
                d_from,
                fallback_to,
                codes={"EMBANKMENT_CONSTRUCTION"},
                tags={"Песок (Насыпь)"},
                patterns=["%насып%"],
                scope="vad",
            )
            road_fallback_denominator_monthly = _section_rating_combine_monthly(
                slices,
                road_embankment_vad_before_anchor_monthly,
            )
            for values in road_fallback_denominator_monthly.values():
                for code, value in values.items():
                    road_fallback_denominator[code] += max(0.0, float(value or 0))
    road_fallback_total_denominator = sum(road_fallback_denominator.values())

    cumulative = {
        "sand_delivery": _section_rating_zero_values(),
        "pile_driving": _section_rating_zero_values(),
        "shpgs_delivery": _section_rating_zero_values(),
        "temp_road_km": _section_rating_zero_values(),
        "excavation": _section_rating_zero_values(),
    }
    road_fallback_cumulative = _section_rating_zero_values()
    frames = []
    metric_digits = {str(item["key"]): int(item["digits"]) for item in SECTION_RATING_METRICS}

    for month_start, frame_end in slices:
        month_key = month_start.isoformat()
        for code in SECTION_RATING_SECTION_CODES:
            cumulative["sand_delivery"][code] += sand_monthly.get(month_key, {}).get(code, 0.0)
            cumulative["shpgs_delivery"][code] += shpgs_monthly.get(month_key, {}).get(code, 0.0)
            cumulative["pile_driving"][code] += pile_monthly.get(month_key, {}).get(code, 0.0)
            cumulative["excavation"][code] += excavation_monthly.get(month_key, {}).get(code, 0.0)
            road_fallback_cumulative[code] += max(0.0, road_fallback_distribution_monthly.get(month_key, {}).get(code, 0.0))

        if road_anchor_date and frame_end >= road_anchor_date:
            cumulative["temp_road_km"] = _section_rating_temp_road_values(frame_end)
        elif road_anchor_date:
            total_progress = (
                sum(max(0.0, value) for value in road_fallback_cumulative.values()) / road_fallback_total_denominator
                if road_fallback_total_denominator > 0
                else 0.0
            )
            for code in SECTION_RATING_SECTION_CODES:
                denom = road_fallback_denominator.get(code) or 0.0
                section_cumulative = max(0.0, road_fallback_cumulative[code])
                progress = section_cumulative / denom if denom > 0 else total_progress
                cumulative["temp_road_km"][code] = road_fallback_target.get(code, 0.0) * max(0.0, min(progress, 1.0))

        frame_metrics = {
            metric["key"]: _section_rating_rank_rows(
                cumulative[str(metric["key"])],
                section_meta,
                metric_digits[str(metric["key"])],
            )
            for metric in SECTION_RATING_METRICS
        }
        frames.append({
            "date": frame_end.isoformat(),
            "monthStart": month_start.isoformat(),
            "label": f"{frame_end.month:02d}.{frame_end.year}",
            "metrics": frame_metrics,
        })

    latest_frame = frames[-1] if frames else {"metrics": {}}
    totals = {}
    for metric in SECTION_RATING_METRICS:
        key = str(metric["key"])
        rows = latest_frame.get("metrics", {}).get(key, [])
        total = sum(float(row.get("value") or 0) for row in rows)
        leader = rows[0] if rows else None
        totals[key] = {
            "total": round(total, int(metric["digits"])),
            "leaderSectionCode": leader.get("sectionCode") if leader else None,
            "leaderName": leader.get("leaderName") if leader else None,
        }

    payload = {
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "transportActualFrom": SECTION_RATING_ACTUAL_TRANSPORT_START.isoformat(),
        "tempRoadFirstDataAt": road_anchor_date.isoformat() if road_anchor_date else None,
        "tempRoadActualFirstDataAt": first_road_date.isoformat() if first_road_date else None,
        "tempRoadSyntheticAnchorAt": SECTION_RATING_TEMP_ROAD_SYNTHETIC_ANCHOR.isoformat(),
        "tempRoadFallbackBasis": "vad_embankment_monthly",
        "sections": section_meta,
        "metrics": SECTION_RATING_METRICS,
        "frames": frames,
        "totals": totals,
    }
    payload = _dashboard_response_cache_set("section_rating_race.v8", persistent_key, fingerprint, payload)
    return _dashboard_short_cache_set(_SECTION_RATING_CACHE, cache_key, payload)


# ── daily summary + per-section temp-roads stats ──────────────────────

TEMP_ROAD_STAGE3_STATUSES = ("pioneer_fill", "subgrade_not_to_grade", "dso", "ready_for_shpgs", "shpgs_done")


def _as_float(value, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _range_tuple(start, end):
    if start is None or end is None:
        return None
    a = _as_float(start)
    b = _as_float(end)
    if abs(b - a) < 0.01:
        return None
    return (min(a, b), max(a, b))


def _merge_temp_road_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    clean = sorted((min(a, b), max(a, b)) for a, b in ranges if abs(b - a) >= 0.01)
    if not clean:
        return []
    out = [list(clean[0])]
    for start, end in clean[1:]:
        if start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(start, end) for start, end in out]


def _subtract_temp_road_ranges(
    universe: tuple[float, float],
    ranges: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    u_start, u_end = min(universe), max(universe)
    cursor = u_start
    out: list[tuple[float, float]] = []
    for start, end in _merge_temp_road_ranges(ranges):
        if end <= u_start:
            continue
        if start >= u_end:
            break
        start = max(start, u_start)
        end = min(end, u_end)
        if start > cursor:
            out.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < u_end:
        out.append((cursor, u_end))
    return out


def _intersect_temp_road_length(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    start = max(min(a_start, a_end), min(b_start, b_end))
    end = min(max(a_start, a_end), max(b_start, b_end))
    return max(0.0, end - start)


def _sum_ranges(ranges: list[tuple[float, float]]) -> float:
    return sum(abs(end - start) for start, end in ranges)


def _temp_roads_stage3_from_status_payload(date_to: date_cls) -> dict:
    """Build Dashboard stage3 from the same payload that renders temp-road schemes."""
    cache_key = ("stage3:v2", date_to.isoformat(), f"g{_dashboard_response_cache_generation()}")
    cached = _dashboard_short_cache_get(_TEMP_ROADS_STAGE3_CACHE, cache_key)
    if cached is not None:
        return cached

    status_payload = _temp_roads_status_payload(date_to.isoformat(), include_display_excluded=True)

    def empty_accumulator() -> dict:
        return {
            "totals": {
                "total_length_m": 0.0,
                "passable_m": 0.0,
                "completed_m": 0.0,
                "ready_m": 0.0,
                "ready_plus_done_m": 0.0,
            },
            "sections": {
                n: {
                    "length_m": 0.0,
                    "passable_m": 0.0,
                    "completed_m": 0.0,
                    "ready_m": 0.0,
                    "ready_plus_done_m": 0.0,
                    "details": [],
                }
                for n in range(1, 9)
            },
        }

    def add_to_accumulator(
        acc: dict,
        *,
        road: dict,
        group: str,
        road_length: float,
        passable_m: float,
        ready_m: float,
        done_m: float,
        no_work: list[tuple[float, float]],
        ready_ranges: list[tuple[float, float]],
        done_ranges: list[tuple[float, float]],
    ) -> None:
        totals = acc["totals"]
        totals["total_length_m"] += road_length
        totals["passable_m"] += passable_m
        totals["ready_m"] += ready_m
        totals["completed_m"] += done_m
        totals["ready_plus_done_m"] += ready_m + done_m

        for section in road.get("sections") or []:
            section_num = section.get("section_num")
            if not isinstance(section_num, int) or section_num not in acc["sections"]:
                continue
            section_range = _range_tuple(section.get("ad_pk_start"), section.get("ad_pk_end"))
            if not section_range:
                continue
            section_length = abs(section_range[1] - section_range[0])
            section_no_work = sum(
                _intersect_temp_road_length(start, end, section_range[0], section_range[1])
                for start, end in no_work
            )
            section_ready = sum(
                _intersect_temp_road_length(start, end, section_range[0], section_range[1])
                for start, end in ready_ranges
            )
            section_done = sum(
                _intersect_temp_road_length(start, end, section_range[0], section_range[1])
                for start, end in done_ranges
            )
            section_passable = max(0.0, section_length - section_no_work)
            section_ready_done = section_ready + section_done
            bucket = acc["sections"][section_num]
            bucket["length_m"] += section_length
            bucket["passable_m"] += section_passable
            bucket["ready_m"] += section_ready
            bucket["completed_m"] += section_done
            bucket["ready_plus_done_m"] += section_ready_done
            if section_length > 0:
                bucket["details"].append({
                    "group": group,
                    "road_id": str(road.get("id") or ""),
                    "road_code": road.get("code"),
                    "road_name": road.get("name"),
                    "section": section_num,
                    "section_code": section.get("section_code"),
                    "section_name": section.get("section_name"),
                    "ad_pk_start": round(section_range[0], 2),
                    "ad_pk_end": round(section_range[1], 2),
                    "rail_pk_start": _as_float(section.get("rail_pk_start"), None),
                    "rail_pk_end": _as_float(section.get("rail_pk_end"), None),
                    "length_m": round(section_length, 2),
                    "passable_m": round(section_passable, 2),
                    "ready_m": round(section_ready, 2),
                    "completed_m": round(section_done, 2),
                    "ready_plus_done_m": round(section_ready_done, 2),
                })

    def finalize_accumulator(acc: dict) -> dict:
        totals = acc["totals"]
        total_length = totals["total_length_m"]
        sections_out = []
        for section_num in range(1, 9):
            section = acc["sections"][section_num]
            length = section["length_m"]
            passable = section["passable_m"]
            ready_m = section["ready_m"]
            done_m = section["completed_m"]
            ready_done = section["ready_plus_done_m"]
            details = sorted(
                section["details"],
                key=lambda item: (
                    0 if item.get("group") == "project" else 1,
                    str(item.get("road_code") or ""),
                    float(item.get("ad_pk_start") or 0),
                ),
            )
            sections_out.append({
                "section": section_num,
                "length_m": round(length, 2),
                "passable_m": round(passable, 2),
                "passable_pct": round(passable / length * 100, 1) if length > 0 else 0,
                "completed_m": round(done_m, 2),
                "ready_m": round(ready_m, 2),
                "ready_plus_done_m": round(ready_done, 2),
                "pct_ready_plus_done": round(ready_done / length * 100, 1) if length > 0 else 0,
                "details": details,
            })
        return {
            "total_length_m": round(total_length, 2),
            "passable_m": round(totals["passable_m"], 2),
            "completed_m": round(totals["completed_m"], 2),
            "ready_m": round(totals["ready_m"], 2),
            "ready_plus_done_m": round(totals["ready_plus_done_m"], 2),
            "passable_pct": round(totals["passable_m"] / total_length * 100, 1) if total_length > 0 else 0,
            "completed_pct": round(totals["completed_m"] / total_length * 100, 1) if total_length > 0 else 0,
            "ready_pct": round(totals["ready_m"] / total_length * 100, 1) if total_length > 0 else 0,
            "ready_plus_done_pct": round(totals["ready_plus_done_m"] / total_length * 100, 1) if total_length > 0 else 0,
            "sections": sections_out,
        }

    accumulators = {
        "project": empty_accumulator(),
        "driveways": empty_accumulator(),
        "combined": empty_accumulator(),
    }

    for road in status_payload.get("roads", []):
        road_range = _range_tuple(road.get("ad_pk_start"), road.get("ad_pk_end"))
        if not road_range:
            continue
        road_length = _as_float(road.get("length_m"), abs(road_range[1] - road_range[0]))
        by_status: dict[str, list[tuple[float, float]]] = {status: [] for status in TEMP_ROAD_STAGE3_STATUSES}
        covered: list[tuple[float, float]] = []
        for segment in road.get("segments") or []:
            status = segment.get("status_type")
            if status not in by_status:
                continue
            segment_range = _range_tuple(
                segment.get("ad_pk_start", segment.get("pk_start")),
                segment.get("ad_pk_end", segment.get("pk_end")),
            )
            if not segment_range:
                continue
            by_status[status].append(segment_range)
            covered.append(segment_range)

        covered = _merge_temp_road_ranges(covered)
        no_work = _subtract_temp_road_ranges(road_range, covered)
        passable_m = max(0.0, road_length - _sum_ranges(no_work))
        ready_ranges = _merge_temp_road_ranges(by_status["ready_for_shpgs"])
        done_ranges = _merge_temp_road_ranges(by_status["shpgs_done"])
        ready_m = _sum_ranges(ready_ranges)
        done_m = _sum_ranges(done_ranges)
        group = "project" if road.get("display_in_dashboard") is not False else "driveways"
        for key in (group, "combined"):
            add_to_accumulator(
                accumulators[key],
                road=road,
                group=group,
                road_length=road_length,
                passable_m=passable_m,
                ready_m=ready_m,
                done_m=done_m,
                no_work=no_work,
                ready_ranges=ready_ranges,
                done_ranges=done_ranges,
            )

    project_payload = finalize_accumulator(accumulators["project"])
    driveways_payload = finalize_accumulator(accumulators["driveways"])
    combined_payload = finalize_accumulator(accumulators["combined"])
    payload = {
        **project_payload,
        "project": project_payload,
        "driveways": driveways_payload,
        "combined": combined_payload,
    }
    return _dashboard_short_cache_set(_TEMP_ROADS_STAGE3_CACHE, cache_key, payload)


DAILY_SUMMARY_CACHE_VERSION = "daily-summary:v8"
DAILY_SUMMARY_HISTORY_ENDPOINT = "daily_summary.history.v1"
DAILY_SUMMARY_CURRENT_ENDPOINT = "daily_summary.current.v1"
DAILY_SUMMARY_SPLIT_ENDPOINT = "daily_summary.split.v1"
DAILY_SUMMARY_DIRECT_ENDPOINT = "daily_summary.v3"


def _daily_summary_current_month_start() -> date_cls:
    today = date_cls.today()
    return date_cls(today.year, today.month, 1)


def _daily_summary_table_fingerprint_piece(
    name: str,
    table_name: str,
    where_sql: str = "",
    params: tuple[object, ...] = (),
) -> dict[str, str]:
    exists = query_one("SELECT to_regclass(%s) IS NOT NULL AS exists", [f"public.{table_name}"])
    if not exists or not exists.get("exists"):
        return {"name": name, "missing": "1", "rows": "0", "max_xmin": "0"}
    where_clause = f"WHERE {where_sql}" if where_sql else ""
    row = query_one(
        f"""
        SELECT COUNT(*)::text AS rows,
               COALESCE(MAX(xmin::text::bigint), 0)::text AS max_xmin
        FROM {table_name}
        {where_clause}
        """,
        params,
    ) or {}
    return {
        "name": name,
        "rows": str(row.get("rows") or "0"),
        "max_xmin": str(row.get("max_xmin") or "0"),
    }


def _daily_summary_joined_fingerprint_piece(
    name: str,
    sql: str,
    params: tuple[object, ...],
) -> dict[str, str]:
    row = query_one(sql, params) or {}
    return {
        "name": name,
        "rows": str(row.get("rows") or "0"),
        "max_xmin": str(row.get("max_xmin") or "0"),
        "max_related_xmin": str(row.get("max_related_xmin") or "0"),
    }


def _daily_summary_period_fingerprint(d_from: date_cls, d_to: date_cls, *, include_stage3: bool) -> str:
    report_filter = (
        "COALESCE(dr_scope.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review') "
        f"AND {_non_pile_control_report_condition('dr_scope')}"
    )
    pieces = [
        _daily_summary_joined_fingerprint_piece(
            "daily_work_items",
            f"""
            SELECT COUNT(*)::text AS rows,
                   COALESCE(MAX(dwi.xmin::text::bigint), 0)::text AS max_xmin,
                   COALESCE(MAX(dr_scope.xmin::text::bigint), 0)::text AS max_related_xmin
            FROM daily_work_items dwi
            JOIN daily_reports dr_scope ON dr_scope.id = dwi.daily_report_id
            WHERE dwi.report_date BETWEEN %s AND %s
              AND {report_filter}
            """,
            (d_from, d_to),
        ),
        _daily_summary_joined_fingerprint_piece(
            "material_movements",
            f"""
            SELECT COUNT(*)::text AS rows,
                   COALESCE(MAX(mm.xmin::text::bigint), 0)::text AS max_xmin,
                   COALESCE(MAX(dr_scope.xmin::text::bigint), 0)::text AS max_related_xmin
            FROM material_movements mm
            JOIN daily_reports dr_scope ON dr_scope.id = mm.daily_report_id
            WHERE mm.report_date BETWEEN %s AND %s
              AND {report_filter}
            """,
            (d_from, d_to),
        ),
        _daily_summary_joined_fingerprint_piece(
            "daily_report_problems",
            f"""
            SELECT COUNT(*)::text AS rows,
                   COALESCE(MAX(p.xmin::text::bigint), 0)::text AS max_xmin,
                   COALESCE(MAX(dr_scope.xmin::text::bigint), 0)::text AS max_related_xmin
            FROM daily_report_problems p
            JOIN daily_reports dr_scope ON dr_scope.id = p.daily_report_id
            WHERE dr_scope.report_date BETWEEN %s AND %s
              AND {report_filter}
            """,
            (d_from, d_to),
        ),
        _daily_summary_table_fingerprint_piece("work_types", "work_types"),
        _daily_summary_table_fingerprint_piece("materials", "materials"),
        _daily_summary_table_fingerprint_piece("objects", "objects"),
        _daily_summary_table_fingerprint_piece("object_types", "object_types"),
        _daily_summary_table_fingerprint_piece("object_segments", "object_segments"),
        _daily_summary_table_fingerprint_piece("daily_work_item_segments", "daily_work_item_segments"),
        _daily_summary_table_fingerprint_piece("construction_sections", "construction_sections"),
    ]
    if include_stage3:
        pieces.extend([
            _daily_summary_table_fingerprint_piece("temporary_roads", "temporary_roads"),
            _daily_summary_table_fingerprint_piece("temporary_road_pk_mappings", "temporary_road_pk_mappings"),
            _daily_summary_table_fingerprint_piece(
                "construction_section_versions",
                "construction_section_versions",
                "boundary_kind = 'temp_roads' AND is_current IS TRUE",
            ),
            _daily_summary_table_fingerprint_piece(
                "temporary_road_status_segments",
                "temporary_road_status_segments",
                "status_date <= %s AND COALESCE(is_demo, false) IS FALSE AND COALESCE(review_tag, '') = ''",
                (d_to,),
            ),
            _daily_summary_table_fingerprint_piece(
                "temporary_road_state_corrections",
                "temporary_road_state_corrections",
                "effective_date <= %s",
                (d_to,),
            ),
        ])
    stable = json.dumps(
        {
            "version": DAILY_SUMMARY_CACHE_VERSION,
            "from": d_from.isoformat(),
            "to": d_to.isoformat(),
            "include_stage3": include_stage3,
            "pieces": pieces,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return f"{DAILY_SUMMARY_CACHE_VERSION}:{hashlib.sha256(stable.encode('utf-8')).hexdigest()}"


def _daily_summary_persistent_cache_get(
    endpoint: str,
    persistent_key: str,
    fingerprint: str,
    *,
    ignore_ttl: bool = False,
) -> Optional[dict]:
    if not ignore_ttl:
        return _dashboard_response_cache_get(endpoint, persistent_key, fingerprint)
    try:
        _ensure_dashboard_response_cache_table()
        row = query_one(
            """
            SELECT payload
            FROM dashboard_response_cache
            WHERE endpoint = %s
              AND cache_key = %s
              AND fingerprint = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            [endpoint, persistent_key, fingerprint],
        )
    except Exception as exc:
        print(f"[daily-summary-cache] stable cache read failed: {exc}", flush=True)
        return None
    payload = row.get("payload") if row else None
    return payload if isinstance(payload, dict) else None


def _dashboard_normalized_text(value: object) -> str:
    return str(value or "").strip().lower().replace("ё", "е")


def _dashboard_is_sand_work(wt_code: object, analytics_tag: object) -> bool:
    code = str(wt_code or "").strip().upper()
    tag = str(analytics_tag or "").strip()
    normalized = _dashboard_normalized_text(tag)
    return code in DAILY_SUMMARY_SAND_WORK_CODES or tag in DAILY_SUMMARY_SAND_TAGS or "пес" in normalized


def _dashboard_is_excavation_work(wt_code: object, analytics_tag: object) -> bool:
    code = str(wt_code or "").strip().upper()
    tag = str(analytics_tag or "").strip()
    normalized = _dashboard_normalized_text(tag)
    return (
        code in DAILY_SUMMARY_EXCAVATION_WORK_CODES
        or tag in DAILY_SUMMARY_EXCAVATION_TAGS
        or "выем" in normalized
        or "выторф" in normalized
    )


def _dashboard_is_oh_object(object_type_code: object, object_code: object = None) -> bool:
    obj_type = str(object_type_code or "").strip().upper()
    obj_code = str(object_code or "").strip().upper()
    return obj_type in DAILY_SUMMARY_OH_OBJECT_TYPE_CODES or obj_code in DAILY_SUMMARY_TP_OBJECT_CODES


def _dashboard_is_vad_object(object_type_code: object, object_code: object = None) -> bool:
    obj_type = str(object_type_code or "").strip().upper()
    obj_code = str(object_code or "").strip().upper()
    return obj_type in DAILY_SUMMARY_TEMP_ROAD_OBJECT_TYPE_CODES and obj_code not in DAILY_SUMMARY_TP_OBJECT_CODES


def _daily_summary_work_object_totals(d_from: date_cls, d_to: date_cls) -> dict[str, float]:
    totals = {
        "sand_oh_m3": 0.0,
        "sand_vad_m3": 0.0,
        "sand_other_m3": 0.0,
        "excavation_oh_m3": 0.0,
        "excavation_vad_m3": 0.0,
        "excavation_other_m3": 0.0,
        "excavation_total_m3": 0.0,
    }
    seg_volume_expr = _analytics_segment_volume_expr("seg")
    rows = query(
        f"""
        SELECT wt.code AS wt_code,
               {DASHBOARD_SEG_WORK_TAG_EXPR} AS analytics_tag,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code) AS object_type_code,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code) AS object_code,
               SUM({seg_volume_expr})::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {_effective_section_join('seg')}
        LEFT JOIN pile_fields pf_detail ON pf_detail.id = seg.pile_field_id
        WHERE dwi.report_date BETWEEN %s AND %s
          AND {_approved_report_exists("dwi")}
          AND dwi.is_demo IS NOT TRUE
          AND (
            wt.code = ANY(%s)
            OR {DASHBOARD_SEG_WORK_TAG_EXPR} = ANY(%s)
            OR LOWER({DASHBOARD_SEG_WORK_TAG_EXPR}) LIKE ANY(%s)
            OR wt.code = ANY(%s)
            OR {DASHBOARD_SEG_WORK_TAG_EXPR} = ANY(%s)
            OR LOWER({DASHBOARD_SEG_WORK_TAG_EXPR}) LIKE ANY(%s)
          )
        GROUP BY wt.code, {DASHBOARD_SEG_WORK_TAG_EXPR},
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code),
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code)
        """,
        (
            d_from,
            d_to,
            list(DAILY_SUMMARY_SAND_WORK_CODES),
            list(DAILY_SUMMARY_SAND_TAGS),
            ["%пес%"],
            list(DAILY_SUMMARY_EXCAVATION_WORK_CODES),
            list(DAILY_SUMMARY_EXCAVATION_TAGS),
            ["%выем%", "%выторф%"],
        ),
    )
    for row in rows:
        object_type_code = row.get("object_type_code")
        object_code = row.get("object_code")
        volume = float(row.get("volume") or 0)
        is_sand = _dashboard_is_sand_work(row.get("wt_code"), row.get("analytics_tag"))
        is_excavation = _dashboard_is_excavation_work(row.get("wt_code"), row.get("analytics_tag"))
        is_oh = _dashboard_is_oh_object(object_type_code, object_code)
        is_vad = _dashboard_is_vad_object(object_type_code, object_code)
        if is_sand:
            if is_oh:
                totals["sand_oh_m3"] += volume
            elif is_vad:
                totals["sand_vad_m3"] += volume
            else:
                totals["sand_other_m3"] += volume
        if is_excavation:
            totals["excavation_total_m3"] += volume
            if is_oh:
                totals["excavation_oh_m3"] += volume
            elif is_vad:
                totals["excavation_vad_m3"] += volume
            else:
                totals["excavation_other_m3"] += volume
    return {key: round(value, 1) for key, value in totals.items()}


def _build_daily_summary_payload(d_from: date_cls, d_to: date_cls, *, include_stage3: bool = True) -> dict:
    # 1) Работы за сутки — sum volume по wt_code
    work_rows = query(
        f"""
        SELECT wt.code AS wt_code, wt.name AS wt_name,
               MAX(COALESCE(dwi.unit, wt.default_unit)) AS unit,
               MAX(COALESCE(NULLIF(BTRIM(dwi.analytics_tag), ''), NULLIF(BTRIM(wt.analytics_tag), ''))) AS analytics_tag,
               SUM(dwi.volume)::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        WHERE dwi.report_date BETWEEN %s AND %s
          AND {_approved_report_exists("dwi")}
        GROUP BY wt.code, wt.name
        """,
        (d_from, d_to),
    )
    works_by_code = {r['wt_code']: {
        'name': r['wt_name'], 'unit': r['unit'],
        'analytics_tag': r.get('analytics_tag'),
        'volume': float(r['volume'] or 0),
    } for r in work_rows}

    def pick(codes: list[str]) -> float:
        return sum(works_by_code.get(c, {}).get('volume', 0) for c in codes)

    # 2) Возка материалов за сутки — разбивка по contractor
    mm_rows = query(
        f"""
        SELECT mat.code AS mat,
               mm.labor_source_type AS labor_src,
               LOWER(COALESCE(mm.contractor_name, '')) AS contractor_name,
               mm.movement_type,
               SUM(mm.volume)::numeric AS v
        FROM material_movements mm
        LEFT JOIN materials mat ON mat.id = mm.material_id
        WHERE mm.report_date BETWEEN %s AND %s
          AND {_approved_report_exists("mm")}
        GROUP BY mat.code, mm.labor_source_type, mm.contractor_name, mm.movement_type
        """,
        (d_from, d_to),
    )
    def empty_split() -> dict[str, float]:
        return {'own': 0.0, 'almaz': 0.0, 'hired': 0.0, 'total': 0.0}

    mat_by_contractor: dict[str, dict[str, float]] = {}
    sand_quarry_by_contractor: dict[str, float] = empty_split()
    shpgs_quarry_by_contractor: dict[str, float] = empty_split()
    soil_transport_by_contractor: dict[str, float] = empty_split()
    for r in mm_rows:
        mat = (r['mat'] or 'OTHER').upper()
        v = float(r['v'] or 0)
        movement_type = r.get('movement_type')
        contr = r['contractor_name'] or ''
        if r['labor_src'] == 'own':
            bucket = 'own'
        elif 'алмаз' in contr:
            bucket = 'almaz'
        else:
            bucket = 'hired'
        mat_by_contractor.setdefault(mat, {'own': 0.0, 'almaz': 0.0, 'hired': 0.0, 'total': 0.0})
        mat_by_contractor[mat][bucket] += v
        mat_by_contractor[mat]['total'] += v
        if mat in ('SAND', 'COARSE_SAND') and movement_type in ('pit_to_stockpile', 'pit_to_constructive'):
            sand_quarry_by_contractor[bucket] += v
            sand_quarry_by_contractor['total'] += v
        if mat == 'SHPGS' and movement_type in ('pit_to_stockpile', 'pit_to_constructive'):
            shpgs_quarry_by_contractor[bucket] += v
            shpgs_quarry_by_contractor['total'] += v
        if mat in ('SOIL', 'PEAT'):
            soil_transport_by_contractor[bucket] += v
            soil_transport_by_contractor['total'] += v

    # 3) Сваи — из daily_work_items PILE_*
    piles = {
        'main':  works_by_code.get('PILE_MAIN', {}).get('volume', 0),
        'trial': works_by_code.get('PILE_TRIAL', {}).get('volume', 0),
        'dyntest': works_by_code.get('PILE_DYNTEST', {}).get('volume', 0),
    }

    sand_work_m3 = sum(
        float(item.get('volume') or 0)
        for code, item in works_by_code.items()
        if code in DAILY_SUMMARY_SAND_WORK_CODES
           or str(item.get('analytics_tag') or '').strip() in DAILY_SUMMARY_SAND_TAGS
           or 'пес' in str(item.get('analytics_tag') or item.get('name') or code).lower()
    )
    excavation_m3 = sum(
        float(item.get('volume') or 0)
        for code, item in works_by_code.items()
        if code in DAILY_SUMMARY_EXCAVATION_WORK_CODES
           or str(item.get('analytics_tag') or '').strip() in DAILY_SUMMARY_EXCAVATION_TAGS
    )
    work_object_totals = _daily_summary_work_object_totals(d_from, d_to)

    summary = {
        'prs_m3':     pick(['TOPSOIL_STRIPPING']),
        'vyemka_m3':  round(work_object_totals.get('excavation_total_m3') or excavation_m3, 1),
        'shpgs_m3':   pick(['CRUSHED_STONE_PLACEMENT', 'FIRST_PROTECTIVE_LAYER']),
        'sand_work_m3': round(sand_work_m3, 1),
        'work_object_totals': work_object_totals,
        'sand_transport': mat_by_contractor.get('SAND', {'own': 0, 'almaz': 0, 'hired': 0, 'total': 0}),
        'sand_quarry_transport': sand_quarry_by_contractor,
        'shpgs_transport': shpgs_quarry_by_contractor,
        'soil_transport': soil_transport_by_contractor,
        'piles': {
            'main': int(piles['main']),
            'trial': int(piles['trial']),
            'dyntest': int(piles['dyntest']),
            'total': int(piles['main']) + int(piles['trial']),
        },
    }

    # 4) Проблемные вопросы за сутки
    problems = query(
        """
        SELECT cs.code AS section_code, dr.report_date, p.problem_text
        FROM daily_report_problems p
        JOIN daily_reports dr ON dr.id = p.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE dr.report_date BETWEEN %s AND %s
          AND COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
          AND NOT (
            COALESCE(dr.source_type, '') = 'web_pile_control'
            OR COALESCE(dr.review_payload->'review_flags', '[]'::jsonb) ?| ARRAY['isso', 'контроль свай']
          )
        ORDER BY cs.code, p.sort_order
        """,
        (d_from, d_to),
    )
    problem_list = [{
        'section_code': _merge_section(p['section_code']) or p['section_code'] or '—',
        'date': p['report_date'].isoformat(),
        'text': p['problem_text'],
    } for p in problems]

    stage3 = _temp_roads_stage3_from_status_payload(d_to) if include_stage3 else {}

    return {
        'from': d_from.isoformat(),
        'to': d_to.isoformat(),
        'summary': summary,
        'problems': problem_list,
        'stage3': stage3,
    }


def _daily_summary_cached_payload(
    d_from: date_cls,
    d_to: date_cls,
    *,
    persistent_endpoint: str,
    key_endpoint: str,
    include_stage3: bool = True,
    stable_persistent: bool = False,
) -> dict:
    stage3_key = "stage3" if include_stage3 else "no-stage3"
    fast_cache_key = (
        persistent_endpoint,
        "fast",
        d_from.isoformat(),
        d_to.isoformat(),
        stage3_key,
        f"g{_dashboard_response_cache_generation()}",
    )
    allow_stale_cache = _dashboard_response_cache_should_serve_stale()
    if allow_stale_cache:
        cached = _dashboard_short_cache_get(_DAILY_SUMMARY_CACHE, fast_cache_key)
        if cached is not None:
            return cached

    fingerprint = _daily_summary_period_fingerprint(d_from, d_to, include_stage3=include_stage3)
    cache_key = (persistent_endpoint, d_from.isoformat(), d_to.isoformat(), stage3_key, fingerprint)
    if allow_stale_cache:
        cached = _dashboard_short_cache_get(_DAILY_SUMMARY_CACHE, cache_key)
        if cached is not None:
            return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, cached)

    persistent_key = _dashboard_response_cache_key({
        "endpoint": key_endpoint,
        "from": d_from,
        "to": d_to,
        "include_stage3": include_stage3,
    })
    cached = _daily_summary_persistent_cache_get(
        persistent_endpoint,
        persistent_key,
        fingerprint,
        ignore_ttl=stable_persistent,
    )
    if cached is not None:
        marked = _dashboard_response_cache_mark(cached, status="fresh", fingerprint=fingerprint)
        payload = _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, cache_key, marked)
        return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, payload)
    stale = _dashboard_response_cache_stale_payload(
        persistent_endpoint,
        persistent_key,
        fingerprint,
        _daily_summary_cached_payload,
        d_from,
        d_to,
        persistent_endpoint=persistent_endpoint,
        key_endpoint=key_endpoint,
        include_stage3=include_stage3,
        stable_persistent=stable_persistent,
        short_cache=_DAILY_SUMMARY_CACHE,
        short_cache_key=cache_key,
    )
    if stale is not None:
        return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, stale)

    marked = _dashboard_response_cache_build_or_wait(
        persistent_endpoint,
        persistent_key,
        fingerprint,
        lambda: _build_daily_summary_payload(d_from, d_to, include_stage3=include_stage3),
        cache_get_fn=lambda: _daily_summary_persistent_cache_get(
            persistent_endpoint,
            persistent_key,
            fingerprint,
            ignore_ttl=stable_persistent,
        ),
        short_cache=_DAILY_SUMMARY_CACHE,
        short_cache_key=cache_key,
    )
    return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, marked)


def _daily_summary_sum_split(payloads: list[dict], key: str) -> float:
    return sum(float((payload.get('summary') or {}).get(key) or 0) for payload in payloads)


def _daily_summary_sum_contractor_split(payloads: list[dict], key: str) -> dict[str, float]:
    result = {'own': 0.0, 'almaz': 0.0, 'hired': 0.0, 'total': 0.0}
    for payload in payloads:
        split = (payload.get('summary') or {}).get(key) or {}
        for bucket in result:
            result[bucket] += float(split.get(bucket) or 0)
    return result


def _daily_summary_sum_work_object_totals(payloads: list[dict]) -> dict[str, float]:
    result = {
        "sand_oh_m3": 0.0,
        "sand_vad_m3": 0.0,
        "sand_other_m3": 0.0,
        "excavation_oh_m3": 0.0,
        "excavation_vad_m3": 0.0,
        "excavation_other_m3": 0.0,
        "excavation_total_m3": 0.0,
    }
    for payload in payloads:
        totals = (payload.get('summary') or {}).get('work_object_totals') or {}
        for key in result:
            result[key] += float(totals.get(key) or 0)
    return {key: round(value, 1) for key, value in result.items()}


def _daily_summary_merge_payloads(d_from: date_cls, d_to: date_cls, payloads: list[dict]) -> dict:
    piles_main = sum(int(((payload.get('summary') or {}).get('piles') or {}).get('main') or 0) for payload in payloads)
    piles_trial = sum(int(((payload.get('summary') or {}).get('piles') or {}).get('trial') or 0) for payload in payloads)
    piles_dyntest = sum(int(((payload.get('summary') or {}).get('piles') or {}).get('dyntest') or 0) for payload in payloads)
    problems = [problem for payload in payloads for problem in (payload.get('problems') or [])]
    stage3 = next((payload.get('stage3') for payload in reversed(payloads) if payload.get('stage3')), {})
    return {
        'from': d_from.isoformat(),
        'to': d_to.isoformat(),
        'summary': {
            'prs_m3': _daily_summary_sum_split(payloads, 'prs_m3'),
            'vyemka_m3': _daily_summary_sum_split(payloads, 'vyemka_m3'),
            'shpgs_m3': _daily_summary_sum_split(payloads, 'shpgs_m3'),
            'sand_work_m3': round(_daily_summary_sum_split(payloads, 'sand_work_m3'), 1),
            'work_object_totals': _daily_summary_sum_work_object_totals(payloads),
            'sand_transport': _daily_summary_sum_contractor_split(payloads, 'sand_transport'),
            'sand_quarry_transport': _daily_summary_sum_contractor_split(payloads, 'sand_quarry_transport'),
            'shpgs_transport': _daily_summary_sum_contractor_split(payloads, 'shpgs_transport'),
            'soil_transport': _daily_summary_sum_contractor_split(payloads, 'soil_transport'),
            'piles': {
                'main': piles_main,
                'trial': piles_trial,
                'dyntest': piles_dyntest,
                'total': piles_main + piles_trial,
            },
        },
        'problems': problems,
        'stage3': stage3,
    }


def _daily_summary_split_payload(d_from: date_cls, d_to: date_cls, current_month_start: date_cls) -> dict:
    fast_cache_key = (
        DAILY_SUMMARY_SPLIT_ENDPOINT,
        "fast",
        d_from.isoformat(),
        d_to.isoformat(),
        current_month_start.isoformat(),
        f"g{_dashboard_response_cache_generation()}",
    )
    allow_stale_cache = _dashboard_response_cache_should_serve_stale()
    if allow_stale_cache:
        cached = _dashboard_short_cache_get(_DAILY_SUMMARY_CACHE, fast_cache_key)
        if cached is not None:
            return cached

    fingerprint = _daily_summary_period_fingerprint(d_from, d_to, include_stage3=True)
    cache_key = (
        DAILY_SUMMARY_SPLIT_ENDPOINT,
        d_from.isoformat(),
        d_to.isoformat(),
        current_month_start.isoformat(),
        fingerprint,
    )
    if allow_stale_cache:
        cached = _dashboard_short_cache_get(_DAILY_SUMMARY_CACHE, cache_key)
        if cached is not None:
            return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, cached)

    persistent_key = _dashboard_response_cache_key({
        "endpoint": "daily_summary_split",
        "from": d_from,
        "to": d_to,
        "current_month_start": current_month_start,
    })
    cached = _dashboard_response_cache_get(DAILY_SUMMARY_SPLIT_ENDPOINT, persistent_key, fingerprint)
    if cached is not None:
        marked = _dashboard_response_cache_mark(cached, status="fresh", fingerprint=fingerprint)
        payload = _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, cache_key, marked)
        return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, payload)
    stale = _dashboard_response_cache_stale_payload(
        DAILY_SUMMARY_SPLIT_ENDPOINT,
        persistent_key,
        fingerprint,
        _daily_summary_split_payload,
        d_from,
        d_to,
        current_month_start,
        short_cache=_DAILY_SUMMARY_CACHE,
        short_cache_key=cache_key,
    )
    if stale is not None:
        return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, stale)

    def build_split_payload() -> dict:
        history_to = current_month_start - timedelta(days=1)
        history_payload = _daily_summary_cached_payload(
            d_from,
            history_to,
            persistent_endpoint=DAILY_SUMMARY_HISTORY_ENDPOINT,
            key_endpoint="daily_summary_history",
            include_stage3=False,
            stable_persistent=True,
        )
        current_payload = _daily_summary_cached_payload(
            current_month_start,
            d_to,
            persistent_endpoint=DAILY_SUMMARY_CURRENT_ENDPOINT,
            key_endpoint="daily_summary_current",
            include_stage3=True,
        )
        return _daily_summary_merge_payloads(d_from, d_to, [history_payload, current_payload])

    marked = _dashboard_response_cache_build_or_wait(
        DAILY_SUMMARY_SPLIT_ENDPOINT,
        persistent_key,
        fingerprint,
        build_split_payload,
        short_cache=_DAILY_SUMMARY_CACHE,
        short_cache_key=cache_key,
    )
    return _dashboard_short_cache_set(_DAILY_SUMMARY_CACHE, fast_cache_key, marked)


@router.get("/analytics/daily-summary")
def daily_summary(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    """Сводка «Выполнение за период»: работы, возка, сваи, проблемы + срез 3 этапа на дату to."""
    d_from, d_to = _parse_range(date_from, date_to)
    current_month_start = _daily_summary_current_month_start()
    if d_from < current_month_start <= d_to:
        return _daily_summary_split_payload(d_from, d_to, current_month_start)
    if d_to < current_month_start:
        return _daily_summary_cached_payload(
            d_from,
            d_to,
            persistent_endpoint=DAILY_SUMMARY_HISTORY_ENDPOINT,
            key_endpoint="daily_summary_history",
            include_stage3=True,
            stable_persistent=True,
        )
    return _daily_summary_cached_payload(
        d_from,
        d_to,
        persistent_endpoint=DAILY_SUMMARY_DIRECT_ENDPOINT,
        key_endpoint="daily_summary",
        include_stage3=True,
    )


def _dashboard_kpi_section_label(section_code: Optional[str], section_name: Optional[str] = None) -> str:
    sec_num = _dashboard_section_num(section_code)
    if sec_num is not None:
        return f"Участок №{sec_num}"
    code = str(section_code or "").strip()
    if code == "ALL":
        return "Все участки"
    name = str(section_name or "").strip()
    if name:
        match = re.search(r"уч(?:асток)?\.?\s*№?\s*(\d+)", name, flags=re.IGNORECASE)
        if match:
            return f"Участок №{int(match.group(1))}"
        return name
    return code or "Без участка"


def _dashboard_kpi_section_sort_key(section_code: Optional[str]) -> tuple:
    sec_num = _dashboard_section_num(section_code)
    return (sec_num is None, sec_num or 9999, str(section_code or ""))


def _dashboard_kpi_completion_pct(fact_volume: object, plan_volume: object) -> Optional[float]:
    plan = float(plan_volume or 0)
    if abs(plan) < 0.000001:
        return None
    return round(float(fact_volume or 0) / plan * 100, 1)


def _dashboard_kpi_scope_clause(scope: str, object_type_sql: str, object_code_sql: str) -> tuple[str, list]:
    if scope == "oh":
        return f"({object_type_sql} = ANY(%s) OR {object_code_sql} = ANY(%s))", [
            list(DAILY_SUMMARY_OH_OBJECT_TYPE_CODES),
            list(DAILY_SUMMARY_TP_OBJECT_CODES),
        ]
    if scope == "vad":
        return f"({object_type_sql} = ANY(%s) AND ({object_code_sql} IS NULL OR {object_code_sql} <> ALL(%s)))", [
            list(DAILY_SUMMARY_TEMP_ROAD_OBJECT_TYPE_CODES),
            list(DAILY_SUMMARY_TP_OBJECT_CODES),
        ]
    if scope == "other":
        return (
            f"NOT ((COALESCE({object_type_sql} = ANY(%s), false) OR COALESCE({object_code_sql} = ANY(%s), false)) OR (COALESCE({object_type_sql} = ANY(%s), false) AND NOT COALESCE({object_code_sql} = ANY(%s), false)))",
            [
                list(DAILY_SUMMARY_OH_OBJECT_TYPE_CODES),
                list(DAILY_SUMMARY_TP_OBJECT_CODES),
                list(DAILY_SUMMARY_TEMP_ROAD_OBJECT_TYPE_CODES),
                list(DAILY_SUMMARY_TP_OBJECT_CODES),
            ],
        )
    return "1=1", []


DASHBOARD_KPI_WORK_METRICS = {
    "sand_oh": {
        "label": "Отсыпка песка ОХ",
        "codes": DAILY_SUMMARY_SAND_WORK_CODES,
        "tags": DAILY_SUMMARY_SAND_TAGS,
        "scope": "oh",
        "unit": "м³",
    },
    "sand_vad": {
        "label": "Отсыпка песка ВАД",
        "codes": DAILY_SUMMARY_SAND_WORK_CODES,
        "tags": DAILY_SUMMARY_SAND_TAGS,
        "scope": "vad",
        "unit": "м³",
    },
    "sand_other": {
        "label": "Отсыпка песка прочее",
        "codes": DAILY_SUMMARY_SAND_WORK_CODES,
        "tags": DAILY_SUMMARY_SAND_TAGS,
        "scope": "other",
        "unit": "м³",
    },
    "excavation_total": {
        "label": "Разработка выемки итого",
        "codes": DAILY_SUMMARY_EXCAVATION_WORK_CODES,
        "tags": DAILY_SUMMARY_EXCAVATION_TAGS,
        "scope": "all",
        "unit": "м³",
    },
    "excavation_oh": {
        "label": "Выемка ОХ",
        "codes": DAILY_SUMMARY_EXCAVATION_WORK_CODES,
        "tags": DAILY_SUMMARY_EXCAVATION_TAGS,
        "scope": "oh",
        "unit": "м³",
    },
    "excavation_vad": {
        "label": "Выемка ВАД",
        "codes": DAILY_SUMMARY_EXCAVATION_WORK_CODES,
        "tags": DAILY_SUMMARY_EXCAVATION_TAGS,
        "scope": "vad",
        "unit": "м³",
    },
    "excavation_other": {
        "label": "Разработка выемки прочее",
        "codes": DAILY_SUMMARY_EXCAVATION_WORK_CODES,
        "tags": DAILY_SUMMARY_EXCAVATION_TAGS,
        "scope": "other",
        "unit": "м³",
    },
    "piles": {
        "label": "Забитые сваи",
        "codes": {"PILE_MAIN", "PILE_TRIAL"},
        "tags": {"ОсСваи", "ПрСваи"},
        "scope": "all",
        "unit": "шт",
    },
}


def _dashboard_kpi_metric_patterns(config: dict) -> list[str]:
    codes = set(config.get("codes") or [])
    if codes == DAILY_SUMMARY_SAND_WORK_CODES:
        return ["%пес%"]
    if codes == DAILY_SUMMARY_EXCAVATION_WORK_CODES:
        return ["%выем%", "%выторф%"]
    return []


def _dashboard_kpi_plan_rows(config: dict, d_from: date_cls, d_to: date_cls) -> list[dict]:
    if not _analytics_table_exists("planned_work_items"):
        return []
    object_type_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, so.object_type_code)"
    object_type_name_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'Свайное поле' END, so.object_type_name)"
    object_code_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, so.object_code)"
    object_id_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.id::text END, so.id::text)"
    object_name_expr = "COALESCE(CASE WHEN pf_detail.field_code IS NOT NULL THEN 'Свайное поле ' || pf_detail.field_code END, NULLIF(so.object_name, ''), 'Без объекта')"
    tag_expr = "COALESCE(NULLIF(BTRIM(wt.analytics_tag), ''), wt.name)"
    scope_clause, scope_params = _dashboard_kpi_scope_clause(str(config["scope"]), object_type_expr, object_code_expr)
    return query(
        _statement_scope_cte()
        + f"""
        , scoped_plan AS (
          SELECT pwi.id::text AS plan_item_id,
                 COUNT(*) OVER (PARTITION BY pwi.id)::numeric AS section_row_count,
                 wt.code AS work_type_code,
                 COALESCE(NULLIF(wt.name, ''), wt.code) AS work_type_name,
                 so.section_code,
                 so.section_name,
                 {object_type_expr} AS object_type_code,
                 {object_type_name_expr} AS object_type_name,
                 {object_id_expr} AS object_id,
                 COALESCE(NULLIF({object_code_expr}, ''), '—') AS object_code,
                 {object_name_expr} AS object_name,
                 COALESCE(pwi.pk_start, so.object_pk_start) AS plan_pk_start,
                 COALESCE(pwi.pk_end, so.object_pk_end) AS plan_pk_end,
                 so.pk_start AS section_pk_start,
                 so.pk_end AS section_pk_end,
                 CASE
                   WHEN pwi.period_start IS NULL AND pwi.period_end IS NULL THEN NULL
                   ELSE LEAST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start))
                 END AS period_start_eff,
                 CASE
                   WHEN pwi.period_start IS NULL AND pwi.period_end IS NULL THEN NULL
                   ELSE GREATEST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start))
                 END AS period_end_eff,
                 COALESCE(pwi.planned_volume, 0)::numeric AS planned_volume
          FROM planned_work_items pwi
          JOIN object_sections so ON so.id = pwi.object_id
          JOIN work_types wt ON wt.id = pwi.work_type_id
          LEFT JOIN pile_fields pf_detail ON pf_detail.id = pwi.source_pile_field_id
          WHERE COALESCE(pwi.is_active, true) IS TRUE
            AND wt.is_active IS NOT FALSE
            AND (
              wt.code = ANY(%s)
              OR {tag_expr} = ANY(%s)
              OR LOWER({tag_expr}) LIKE ANY(%s)
            )
            AND {scope_clause}
            AND NOT (
              wt.code = ANY(%s)
              AND pwi.source_reference = 'project_work_items:total'
            )
            AND (
              (pwi.period_start IS NULL AND pwi.period_end IS NULL AND %s::date <= %s::date)
              OR (
                COALESCE(pwi.period_start, pwi.period_end) IS NOT NULL
                AND LEAST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start)) <= %s::date
                AND GREATEST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start)) >= %s::date
              )
            )
        )
        SELECT section_code,
               section_name,
               object_type_code,
               object_type_name,
               object_id,
               object_code,
               object_name,
               'plan'::text AS detail_kind,
               plan_item_id,
               NULL::text AS report_id,
               NULL::date AS report_date,
               NULL::text AS shift,
               work_type_code,
               work_type_name,
               period_start_eff AS plan_period_start,
               period_end_eff AS plan_period_end,
               0::int AS fact_count,
               0::numeric AS volume,
               (
                 planned_volume
                 * CASE
                     WHEN period_start_eff IS NULL AND period_end_eff IS NULL
                       THEN CASE WHEN %s::date <= %s::date THEN 1::numeric ELSE 0::numeric END
                     ELSE GREATEST(0, (LEAST(period_end_eff, %s::date) - GREATEST(period_start_eff, %s::date) + 1))::numeric
                          / GREATEST(1, (period_end_eff - period_start_eff + 1))::numeric
                   END
                 * CASE
                     WHEN plan_pk_start IS NOT NULL
                      AND plan_pk_end IS NOT NULL
                      AND section_pk_start IS NOT NULL
                      AND section_pk_end IS NOT NULL
                      AND ABS(plan_pk_end - plan_pk_start) >= 0.001
                       THEN GREATEST(
                         0,
                         LEAST(GREATEST(plan_pk_start, plan_pk_end), GREATEST(section_pk_start, section_pk_end))
                         - GREATEST(LEAST(plan_pk_start, plan_pk_end), LEAST(section_pk_start, section_pk_end))
                       ) / NULLIF(ABS(plan_pk_end - plan_pk_start), 0)
                     ELSE 1::numeric / NULLIF(section_row_count, 0)
                   END
               )::numeric AS plan_volume
        FROM scoped_plan
        """,
        [
            list(config["codes"]),
            list(config["tags"]),
            _dashboard_kpi_metric_patterns(config),
            *scope_params,
            ["PILE_MAIN", "PILE_TRIAL", "PILE_DYNTEST", "PILE_HEADCAP_INSTALLATION"],
            d_from,
            ANALYTICS_INCEPTION_DATE,
            d_to,
            d_from,
            d_from,
            ANALYTICS_INCEPTION_DATE,
            d_to,
            d_from,
        ],
    )


def _dashboard_kpi_detail_payload(
    *,
    metric: str,
    label: str,
    unit: str,
    d_from: date_cls,
    d_to: date_cls,
    source_rows: list[dict],
) -> dict:
    row_map: dict[tuple, dict] = {}
    for source in source_rows:
        volume = float(source.get("volume") or 0)
        plan_volume = float(source.get("plan_volume") or 0)
        if abs(volume) < 0.000001 and abs(plan_volume) < 0.000001:
            continue
        section_code = _merge_section(source.get("section_code")) or source.get("section_code") or "—"
        object_type_code = source.get("object_type_code") or "—"
        object_type_name = source.get("object_type_name") or ("Без типа" if object_type_code == "—" else object_type_code)
        object_code = source.get("object_code") or source.get("object_id") or source.get("object_name") or "—"
        object_name = source.get("object_name") or object_code or "Без объекта"
        key = (section_code, object_type_code, object_code, object_name)
        row = row_map.setdefault(key, {
            "section_code": section_code,
            "section_label": _dashboard_kpi_section_label(section_code, source.get("section_name")),
            "object_type_code": object_type_code,
            "object_type_name": object_type_name,
            "object_id": source.get("object_id"),
            "object_code": object_code,
            "object_name": object_name,
            "volume": 0.0,
            "plan_volume": 0.0,
            "fact_count": 0,
            "details": [],
        })
        row["volume"] += volume
        row["plan_volume"] += plan_volume
        row["fact_count"] += int(source.get("fact_count") or 0)
        source_details = source.get("details") if isinstance(source.get("details"), list) else []
        if source_details:
            row["details"].extend(dict(item) for item in source_details if isinstance(item, dict))
        detail_kind = str(source.get("detail_kind") or "").strip().lower()
        if detail_kind in {"fact", "plan"}:
            report_date = source.get("report_date")
            plan_period_start = source.get("plan_period_start")
            plan_period_end = source.get("plan_period_end")
            row["details"].append({
                "kind": detail_kind,
                "object_name": object_name,
                "work_type_name": source.get("work_type_name") or source.get("work_type_code") or "Работа",
                "volume": round(volume if detail_kind == "fact" else plan_volume, 3),
                "report_date": report_date.isoformat() if hasattr(report_date, "isoformat") else report_date,
                "shift": source.get("shift"),
                "report_id": source.get("report_id"),
                "plan_item_id": source.get("plan_item_id"),
                "period_start": plan_period_start.isoformat() if hasattr(plan_period_start, "isoformat") else plan_period_start,
                "period_end": plan_period_end.isoformat() if hasattr(plan_period_end, "isoformat") else plan_period_end,
            })

    rows = []
    for row in row_map.values():
        fact_volume = round(float(row["volume"]), 3)
        plan_volume = round(float(row["plan_volume"]), 3)
        row["details"].sort(key=lambda item: (
            0 if item.get("kind") == "fact" else 1,
            str(item.get("report_date") or item.get("period_start") or ""),
            str(item.get("work_type_name") or ""),
        ))
        rows.append({
            **row,
            "volume": fact_volume,
            "plan_volume": plan_volume,
            "completion_pct": _dashboard_kpi_completion_pct(fact_volume, plan_volume),
        })
    rows.sort(key=lambda row: (
        _dashboard_kpi_section_sort_key(row.get("section_code")),
        str(row.get("object_type_name") or row.get("object_type_code") or ""),
        str(row.get("object_name") or row.get("object_code") or ""),
    ))

    section_map: dict[str, dict] = {}
    for row in rows:
        section_code = row["section_code"]
        section = section_map.setdefault(section_code, {
            "section_code": section_code,
            "section_label": row["section_label"],
            "volume": 0.0,
            "plan_volume": 0.0,
            "fact_count": 0,
            "object_types": {},
        })
        section["volume"] += float(row["volume"] or 0)
        section["plan_volume"] += float(row.get("plan_volume") or 0)
        section["fact_count"] += int(row.get("fact_count") or 0)
        type_key = str(row.get("object_type_code") or "—")
        type_slot = section["object_types"].setdefault(type_key, {
            "object_type_code": row.get("object_type_code"),
            "object_type_name": row.get("object_type_name"),
            "volume": 0.0,
            "plan_volume": 0.0,
            "fact_count": 0,
            "objects": [],
        })
        type_slot["volume"] += float(row["volume"] or 0)
        type_slot["plan_volume"] += float(row.get("plan_volume") or 0)
        type_slot["fact_count"] += int(row.get("fact_count") or 0)
        type_slot["objects"].append(row)

    sections = []
    for section in section_map.values():
        object_types = []
        for type_slot in section["object_types"].values():
            type_slot["objects"].sort(key=lambda row: str(row.get("object_name") or row.get("object_code") or ""))
            fact_volume = round(float(type_slot["volume"] or 0), 3)
            plan_volume = round(float(type_slot["plan_volume"] or 0), 3)
            object_types.append({
                **type_slot,
                "volume": fact_volume,
                "plan_volume": plan_volume,
                "completion_pct": _dashboard_kpi_completion_pct(fact_volume, plan_volume),
            })
        object_types.sort(key=lambda row: str(row.get("object_type_name") or row.get("object_type_code") or ""))
        fact_volume = round(float(section["volume"] or 0), 3)
        plan_volume = round(float(section["plan_volume"] or 0), 3)
        sections.append({
            **section,
            "volume": fact_volume,
            "plan_volume": plan_volume,
            "completion_pct": _dashboard_kpi_completion_pct(fact_volume, plan_volume),
            "object_types": object_types,
        })
    sections.sort(key=lambda row: _dashboard_kpi_section_sort_key(row.get("section_code")))
    fact_total = round(sum(float(row.get("volume") or 0) for row in rows), 3)
    plan_total = round(sum(float(row.get("plan_volume") or 0) for row in rows), 3)

    return {
        "metric": metric,
        "label": label,
        "unit": unit,
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "total": fact_total,
        "fact_total": fact_total,
        "plan_total": plan_total,
        "completion_pct": _dashboard_kpi_completion_pct(fact_total, plan_total),
        "rows": rows,
        "sections": sections,
    }


def _dashboard_kpi_sand_delivery_object_rows(d_from: date_cls, d_to: date_cls) -> list[dict]:
    rows = query(
        f"""
        SELECT cs.code AS section_code,
               cs.name AS section_name,
               dst_ot.code AS object_type_code,
               dst_ot.name AS object_type_name,
               dst.id::text AS object_id,
               dst.object_code AS object_code,
               COALESCE(NULLIF(dst.name, ''), dst.object_code, 'Без объекта') AS object_name,
               'fact'::text AS detail_kind,
               dr.id::text AS report_id,
               mm.report_date,
               mm.shift,
               'SAND_DELIVERY'::text AS work_type_code,
               'Завоз песка'::text AS work_type_name,
               COUNT(*)::int AS fact_count,
               SUM(mm.volume)::numeric AS volume
        FROM material_movements mm
        JOIN daily_reports dr ON dr.id = mm.daily_report_id
        JOIN materials m ON m.id = mm.material_id
        LEFT JOIN construction_sections cs ON cs.id = COALESCE(mm.section_id, dr.section_id)
        LEFT JOIN objects dst ON dst.id = mm.to_object_id
        LEFT JOIN object_types dst_ot ON dst_ot.id = dst.object_type_id
        WHERE mm.report_date BETWEEN %s AND %s
          AND COALESCE(mm.is_demo, false) IS FALSE
          AND COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
          AND {_non_pile_control_report_condition("dr")}
          AND UPPER(COALESCE(m.code, '')) = 'SAND'
          AND mm.movement_type IN ('pit_to_constructive', 'stockpile_to_constructive')
          AND COALESCE(mm.volume, 0) > 0
        GROUP BY cs.code, cs.name, dst_ot.code, dst_ot.name, dst.id, dst.object_code, dst.name,
                 dr.id, mm.report_date, mm.shift
        """,
        [d_from, d_to],
    )
    return [
        {
            "section_code": _merge_section(row.get("section_code")) or row.get("section_code") or "—",
            "section_name": row.get("section_name"),
            "destination_object_type_code": row.get("object_type_code") or "OBJECT",
            "destination_object_type_name": row.get("object_type_name") or "Объект",
            "destination_object_id": row.get("object_id"),
            "destination_object_code": row.get("object_code") or row.get("object_id") or row.get("object_name"),
            "destination_object_name": row.get("object_name") or row.get("object_code") or "Без объекта",
            "detail_kind": row.get("detail_kind"),
            "report_id": row.get("report_id"),
            "report_date": row.get("report_date"),
            "shift": row.get("shift"),
            "work_type_code": row.get("work_type_code"),
            "work_type_name": row.get("work_type_name"),
            "volume": float(row.get("volume") or 0),
            "fact_count": int(row.get("fact_count") or 0),
        }
        for row in rows
    ]


def _dashboard_kpi_work_detail(metric: str, d_from: date_cls, d_to: date_cls) -> dict:
    config = DASHBOARD_KPI_WORK_METRICS.get(metric)
    if not config:
        raise HTTPException(status_code=404, detail="Unknown dashboard KPI metric")
    object_type_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code)"
    object_type_name_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'Свайное поле' END, ot.name)"
    object_code_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code)"
    object_id_expr = "COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.id::text END, o.id::text)"
    object_name_expr = "COALESCE(CASE WHEN pf_detail.field_code IS NOT NULL THEN 'Свайное поле ' || pf_detail.field_code END, NULLIF(o.name, ''), 'Без объекта')"
    tag_expr = DASHBOARD_SEG_WORK_TAG_EXPR
    scope_clause, scope_params = _dashboard_kpi_scope_clause(str(config["scope"]), object_type_expr, object_code_expr)
    seg_volume_expr = _analytics_segment_volume_expr("seg")
    patterns = _dashboard_kpi_metric_patterns(config)
    rows = query(
        f"""
        SELECT cs_eff.code AS section_code,
               cs_eff.name AS section_name,
               {object_type_expr} AS object_type_code,
               {object_type_name_expr} AS object_type_name,
               {object_id_expr} AS object_id,
               COALESCE(NULLIF({object_code_expr}, ''), '—') AS object_code,
               {object_name_expr} AS object_name,
               'fact'::text AS detail_kind,
               dwi.daily_report_id::text AS report_id,
               dwi.report_date,
               dwi.shift,
               wt.code AS work_type_code,
               COALESCE(NULLIF(wt.name, ''), NULLIF(dwi.work_name_raw, ''), wt.code) AS work_type_name,
               NULL::text AS plan_item_id,
               NULL::date AS plan_period_start,
               NULL::date AS plan_period_end,
               COUNT(DISTINCT dwi.id)::int AS fact_count,
               SUM({seg_volume_expr})::numeric AS volume
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {_effective_section_join('seg')}
        LEFT JOIN pile_fields pf_detail ON pf_detail.id = seg.pile_field_id
        WHERE dwi.report_date BETWEEN %s AND %s
          AND {_approved_report_exists("dwi")}
          AND dwi.is_demo IS NOT TRUE
          AND wt.is_active IS NOT FALSE
          AND (wt.code = ANY(%s) OR {tag_expr} = ANY(%s) OR LOWER({tag_expr}) LIKE ANY(%s))
          AND {scope_clause}
        GROUP BY cs_eff.code, cs_eff.name, {object_type_expr}, {object_type_name_expr},
                 {object_id_expr},
                 COALESCE(NULLIF({object_code_expr}, ''), '—'),
                 {object_name_expr}, dwi.daily_report_id, dwi.report_date, dwi.shift,
                 wt.code, wt.name, dwi.work_name_raw
        """,
        [
            d_from,
            d_to,
            list(config["codes"]),
            list(config["tags"]),
            patterns,
            *scope_params,
        ],
    )
    plan_rows = _dashboard_kpi_plan_rows(config, d_from, d_to)
    return _dashboard_kpi_detail_payload(
        metric=metric,
        label=str(config["label"]),
        unit=str(config["unit"]),
        d_from=d_from,
        d_to=d_to,
        source_rows=[*rows, *plan_rows],
    )


def _dashboard_kpi_material_detail(metric: str, d_from: date_cls, d_to: date_cls) -> dict:
    material_code = "SAND"
    data = dashboard_material_flow(d_from.isoformat(), d_to.isoformat())
    source_grouped: dict[tuple, dict] = {}
    for item in data.get("rows") or []:
        if str(item.get("material") or "").upper() != material_code:
            continue
        if item.get("movement_type") not in {"pit_to_stockpile", "pit_to_constructive"}:
            continue
        volume = float(item.get("volume") or 0)
        if volume <= 0:
            continue
        object_type_code = item.get("source_object_type_code") or ("BORROW_PIT" if item.get("quarry_name") else "SOURCE")
        object_type_name = item.get("source_object_type_name") or ("Карьер" if object_type_code == "BORROW_PIT" else "Источник")
        object_name = item.get("quarry_name") or item.get("source_object_name") or item.get("source_group_key") or "Источник не указан"
        object_code = item.get("source_object_code") or item.get("source_group_key") or item.get("quarry_id") or item.get("source_object_id") or object_name
        key = ("ALL", object_type_code, object_code, object_name)
        row = source_grouped.setdefault(key, {
            "section_code": "ALL",
            "section_name": "Все участки",
            "object_type_code": object_type_code,
            "object_type_name": object_type_name,
            "object_id": item.get("source_object_id") or item.get("quarry_id"),
            "object_code": object_code,
            "object_name": object_name,
            "volume": 0.0,
            "fact_count": 0,
            "details": [],
        })
        row["volume"] += volume
        row["fact_count"] += 1
        row["details"].append({
            "kind": "fact",
            "object_name": object_name,
            "work_type_name": "Вывоз песка",
            "volume": round(volume, 3),
            "report_date": item.get("report_date") or item.get("report_date_from"),
            "shift": item.get("shift"),
            "report_id": item.get("source_report_id"),
        })
    object_grouped: dict[tuple, dict] = {}
    object_fact_rows = _dashboard_kpi_sand_delivery_object_rows(d_from, d_to)
    for item in object_fact_rows:
        volume = float(item.get("volume") or 0)
        if volume <= 0:
            continue
        object_id = item.get("destination_object_id")
        object_name = item.get("destination_object_name") or item.get("destination_object_code")
        if not object_id and not object_name:
            continue
        section_code = _merge_section(item.get("section_code")) or item.get("section_code") or "—"
        object_type_code = item.get("destination_object_type_code") or "OBJECT"
        object_type_name = item.get("destination_object_type_name") or "Объект"
        object_code = item.get("destination_object_code") or object_id or object_name or "—"
        object_name = object_name or object_code or "Без объекта"
        key = (section_code, object_type_code, object_code, object_name)
        row = object_grouped.setdefault(key, {
            "section_code": section_code,
            "section_name": None,
            "object_type_code": object_type_code,
            "object_type_name": object_type_name,
            "object_id": object_id,
            "object_code": object_code,
            "object_name": object_name,
            "volume": 0.0,
            "fact_count": 0,
            "details": [],
        })
        row["volume"] += volume
        row["fact_count"] += 1
        report_date = item.get("report_date")
        row["details"].append({
            "kind": "fact",
            "object_name": object_name,
            "work_type_name": item.get("work_type_name") or "Завоз песка",
            "volume": round(volume, 3),
            "report_date": report_date.isoformat() if hasattr(report_date, "isoformat") else report_date,
            "shift": item.get("shift"),
            "report_id": item.get("report_id"),
        })
    plan_config = {
        "codes": DAILY_SUMMARY_SAND_WORK_CODES,
        "tags": DAILY_SUMMARY_SAND_TAGS,
        "scope": "all",
    }
    source_payload = _dashboard_kpi_detail_payload(
        metric=metric,
        label="Вывоз песка с карьеров",
        unit="м³",
        d_from=d_from,
        d_to=d_to,
        source_rows=list(source_grouped.values()),
    )
    object_payload = _dashboard_kpi_detail_payload(
        metric=metric,
        label="Завоз песка",
        unit="м³",
        d_from=d_from,
        d_to=d_to,
        source_rows=[*object_grouped.values(), *_dashboard_kpi_plan_rows(plan_config, d_from, d_to)],
    )
    object_payload["source_total"] = source_payload.get("fact_total", source_payload.get("total", 0))
    object_payload["source_fact_total"] = source_payload.get("fact_total", source_payload.get("total", 0))
    object_payload["source_rows"] = source_payload.get("rows", [])
    object_payload["source_sections"] = source_payload.get("sections", [])
    return object_payload


@router.get("/dashboard/kpi-detail")
def dashboard_kpi_detail(
    metric: str,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    d_from, d_to = _parse_range(date_from, date_to)
    if metric == "sand_delivery":
        return _dashboard_kpi_material_detail(metric, d_from, d_to)
    return _dashboard_kpi_work_detail(metric, d_from, d_to)


def _dashboard_money_month_starts(d_from: date_cls, d_to: date_cls) -> list[date_cls]:
    cursor = date_cls(d_from.year, d_from.month, 1)
    result = []
    while cursor <= d_to:
        result.append(cursor)
        if cursor.month == 12:
            cursor = date_cls(cursor.year + 1, 1, 1)
        else:
            cursor = date_cls(cursor.year, cursor.month + 1, 1)
    return result


def _dashboard_money_amount(row: dict, rate_map: dict[str, dict[str, object]], field: str, volume: float) -> tuple[float, bool]:
    if abs(volume) < 0.000001:
        return 0.0, False
    amount_row = dict(row)
    amount_row[field] = volume
    rates = _statement_rates_for_row(amount_row, rate_map)
    amount, missing, _regions = _statement_work_type_amount(amount_row, rates, field)
    if not missing and amount is not None:
        return float(amount or 0), False
    available_rates = [float(rate) for rate in rates.values() if rate is not None]
    if available_rates:
        return round(volume * (sum(available_rates) / len(available_rates)), 2), False
    return float(amount or 0), bool(missing)


def _dashboard_money_has_any_rate(rate_map: dict[str, dict[str, object]], work_type_id: object) -> bool:
    entry = rate_map.get(str(work_type_id or ""), {})
    base_rates = dict(entry.get("base") or {})
    if any(value is not None for value in base_rates.values()):
        return True
    length_rates = dict(entry.get("lengths") or {})
    for rates in length_rates.values():
        if any(value is not None for value in dict(rates or {}).values()):
            return True
    return False


ISSO_SUPPORT_MONTH_SHORT_BY_NUM = {
    1: "янв.",
    2: "фев.",
    3: "мар.",
    4: "апр.",
    5: "май",
    6: "июн.",
    7: "июл.",
    8: "авг.",
    9: "сен.",
    10: "окт.",
    11: "нояб.",
    12: "дек.",
}
ISSO_SUPPORT_FACT_SITE_FIELD_BY_MONTH = {
    6: "fact_june_sites",
    7: "fact_july_sites",
    8: "fact_august_sites",
    9: "fact_september_sites",
    10: "fact_october_sites",
    11: "fact_november_sites",
    12: "fact_december_sites",
}
ISSO_SUPPORT_MONTH_NUM_BY_SHORT = {short: month for month, short in ISSO_SUPPORT_MONTH_SHORT_BY_NUM.items()}
ISSO_SUPPORT_FILL_MATERIAL_LABELS = {
    "sand": "отсыпано в песке",
    "shpgs": "отсыпано в ЩПГС",
}


def _dashboard_isso_int(value: Any) -> int:
    if value in (None, "", False):
        return 0
    try:
        return int(round(float(value)))
    except Exception:
        return 0


def _dashboard_isso_support_ranges(value: Any) -> list[tuple[int, int]]:
    text = str(value or "").replace("\xa0", " ").strip()
    ranges: list[tuple[int, int]] = []
    for match in re.finditer(r"(\d+)\s*(?:[-–—]\s*(\d+))?", text):
        start = _dashboard_isso_int(match.group(1))
        end = _dashboard_isso_int(match.group(2) or match.group(1))
        if start <= 0 or end <= 0:
            continue
        ranges.append((min(start, end), max(start, end)))
    return ranges


def _dashboard_isso_support_overlaps(value: Any, start: int, end: int) -> bool:
    return any(item_start <= end and item_end >= start for item_start, item_end in _dashboard_isso_support_ranges(value))


def _dashboard_isso_object_pk_number(object_name: Any, object_code: Any = "") -> int:
    text = f"{object_name or ''} {object_code or ''}".lower().replace("ё", "е")
    match = re.search(r"пк\s*0*(\d{3,5})", text)
    return _dashboard_isso_int(match.group(1)) if match else 0


def _dashboard_isso_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, "", 0):
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "да", "истина"}


def _dashboard_isso_normalize_rd_status(value: Any) -> str:
    text = str(value or "").strip().lower().replace("ё", "е")
    if text in {"missing", "нет", "no", "no_rd"}:
        return "missing"
    return "available"


def _dashboard_isso_rd_missing(rd_status: str, remark: str) -> bool:
    remark_norm = str(remark or "").lower().replace("ё", "е")
    remark_norm = re.sub(r"[^0-9a-zа-я]+", " ", remark_norm)
    return rd_status == "missing" or bool(re.search(r"(?:^| )(?:нет рд|рд нет)(?: |$)", remark_norm))


def _dashboard_isso_work_status(
    rd_status: str,
    remark: str,
    work_activity_count: int,
    sites_total: int,
    sites_done: int = 0,
    sites_sand_done: int = 0,
) -> str:
    if sites_total > 0 and sites_sand_done > 0:
        return "sand"
    if _dashboard_isso_rd_missing(rd_status, remark):
        return "no_rd"
    if sites_total > 0 and sites_done >= sites_total:
        return "ready"
    if sites_total > 0 and sites_done > 0:
        return "shpgs_partial"
    if sites_total <= 0:
        return "gray"
    return "idle_with_rd"


def _dashboard_isso_json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value in (None, "", b""):
        return {}
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _dashboard_isso_month_num_from_value(value: Any) -> int:
    if isinstance(value, (date_cls, datetime)):
        return int(value.month)
    text = str(value or "").strip().lower()
    if not text:
        return 0
    iso_match = re.match(r"^(\d{4})-(\d{1,2})", text)
    if iso_match:
        return int(iso_match.group(2))
    if text in ISSO_SUPPORT_MONTH_NUM_BY_SHORT:
        return ISSO_SUPPORT_MONTH_NUM_BY_SHORT[text]
    for month_num, short in ISSO_SUPPORT_MONTH_SHORT_BY_NUM.items():
        if short and short in text:
            return month_num
    for month_num in range(1, 13):
        label = _dashboard_isso_month_label(date_cls(2026, month_num, 1)).split()[0].lower()
        if label in text:
            return month_num
    return 0


def _dashboard_isso_fact_month_map(raw: dict[str, Any], year: int) -> dict[int, int]:
    months: dict[int, int] = {}
    fact_months = raw.get("fact_months")
    if isinstance(fact_months, dict):
        for key, value in fact_months.items():
            month_num = _dashboard_isso_month_num_from_value(key)
            sites = _dashboard_isso_int(value)
            if month_num and sites > 0:
                months[month_num] = sites
    elif isinstance(fact_months, list):
        for item in fact_months:
            if not isinstance(item, dict):
                continue
            month_num = _dashboard_isso_month_num_from_value(item.get("value") or item.get("month") or item.get("label"))
            sites = _dashboard_isso_int(item.get("sites") or item.get("value_count"))
            if month_num and sites > 0:
                months[month_num] = sites
    for month_num, field in ISSO_SUPPORT_FACT_SITE_FIELD_BY_MONTH.items():
        sites = _dashboard_isso_int(raw.get(field))
        if sites > 0:
            months[month_num] = sites
    return months


def _dashboard_isso_fact_material_map(raw: dict[str, Any]) -> dict[int, str]:
    materials: dict[int, str] = {}
    raw_materials = raw.get("fact_material_by_month")
    if not isinstance(raw_materials, dict):
        return materials
    for key, value in raw_materials.items():
        month_num = _dashboard_isso_month_num_from_value(key)
        material = str(value or "").strip().lower()
        if month_num and material in ISSO_SUPPORT_FILL_MATERIAL_LABELS:
            materials[month_num] = material
    return materials


def _dashboard_isso_effective_sites_done(raw: dict[str, Any]) -> int:
    raw_sites_done = _dashboard_isso_int(raw.get("sites_done"))
    if raw_sites_done > 0:
        return raw_sites_done
    return sum(_dashboard_isso_fact_month_map(raw, date_cls.today().year).values())


def _dashboard_isso_month_done(raw: dict[str, Any], target_month: date_cls) -> int:
    return _dashboard_isso_fact_month_map(raw, target_month.year).get(target_month.month, 0)


def _dashboard_isso_month_material(raw: dict[str, Any], target_month: date_cls) -> str:
    return _dashboard_isso_fact_material_map(raw).get(target_month.month, "shpgs")


def _dashboard_isso_month_material_counts(raw: dict[str, Any], target_month: date_cls) -> tuple[int, int]:
    sites = _dashboard_isso_month_done(raw, target_month)
    if _dashboard_isso_month_material(raw, target_month) == "sand":
        return sites, 0
    return 0, sites


def _dashboard_isso_fact_months(raw: dict[str, Any], year: int) -> list[dict[str, Any]]:
    months = []
    material_map = _dashboard_isso_fact_material_map(raw)
    for month_num, sites in sorted(_dashboard_isso_fact_month_map(raw, year).items()):
        month_value = date_cls(year, month_num, 1)
        material_kind = material_map.get(month_num, "shpgs")
        months.append({
            "value": month_value.isoformat(),
            "label": _dashboard_isso_month_label(month_value),
            "sites": sites,
            "material_kind": material_kind,
            "material_label": ISSO_SUPPORT_FILL_MATERIAL_LABELS[material_kind],
        })
    return months


def _dashboard_isso_material_counts(raw: dict[str, Any], year: int) -> tuple[int, int]:
    sand_done = _dashboard_isso_int(raw.get("sites_sand_done"))
    if "sites_done" in raw:
        shpgs_done = _dashboard_isso_int(raw.get("sites_done"))
    elif "sites_shpgs_done" in raw:
        shpgs_done = _dashboard_isso_int(raw.get("sites_shpgs_done"))
    else:
        shpgs_done = sum(_dashboard_isso_fact_month_map(raw, year).values())
    return sand_done, shpgs_done


def _dashboard_isso_fill_materials(sand_done: int, shpgs_done: int) -> list[dict[str, Any]]:
    materials = []
    if sand_done > 0:
        materials.append({"kind": "sand", "label": ISSO_SUPPORT_FILL_MATERIAL_LABELS["sand"], "sites": sand_done})
    if shpgs_done > 0:
        materials.append({"kind": "shpgs", "label": ISSO_SUPPORT_FILL_MATERIAL_LABELS["shpgs"], "sites": shpgs_done})
    return materials


def _dashboard_isso_support_label(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = text.lower().replace("ё", "е")
    if normalized.startswith("опор"):
        return text
    cleaned = text.replace("оп.", "").replace("Оп.", "").strip(" ;,.-")
    if not cleaned:
        return text
    if any(mark in cleaned for mark in ("-", "–", ",", ";", "\n")):
        return f"Опоры {cleaned}"
    return f"Опора {cleaned}"


def _dashboard_isso_ms11_scope(raw: dict[str, Any]) -> bool:
    for key in ("ms11_scope", "ms11_executor", "ms11_contractor"):
        if key in raw:
            return _dashboard_isso_bool(raw.get(key))
    executor_text = " ".join(str(raw.get(key) or "") for key in ("executor_text", "contractor_text", "executor", "contractor"))
    normalized_executor = executor_text.lower().replace(" ", "").replace("_", "-").replace("—", "-").replace("–", "-")
    if "мс-11" in normalized_executor or "мс11" in normalized_executor:
        return True
    scope_text = " ".join(str(raw.get(key) or "") for key in ("remark", "production_note"))
    normalized_scope = scope_text.lower().replace(" ", "").replace("_", "-").replace("—", "-").replace("–", "-")
    return "силамимс-11" in normalized_scope or "силамимс11" in normalized_scope


def _dashboard_isso_ms11_working(raw: dict[str, Any]) -> bool:
    return _dashboard_isso_bool(raw.get("ms11_working"))


def _dashboard_isso_ms11_bridge_work(raw: dict[str, Any]) -> bool:
    return _dashboard_isso_bool(raw.get("ms11_bridge_work"))


def _dashboard_isso_month_label(value: date_cls) -> str:
    labels = {
        1: "январь", 2: "февраль", 3: "март", 4: "апрель", 5: "май", 6: "июнь",
        7: "июль", 8: "август", 9: "сентябрь", 10: "октябрь", 11: "ноябрь", 12: "декабрь",
    }
    return f"{labels.get(value.month, value.strftime('%m'))} {value.year}"


def _dashboard_isso_parse_month(value: Optional[str], fallback: date_cls) -> date_cls:
    if not value:
        return fallback
    try:
        parsed = date_cls.fromisoformat(str(value)[:10])
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid month, expected YYYY-MM-DD") from exc
    return date_cls(parsed.year, parsed.month, 1)


def _dashboard_isso_pk_text(value: Any) -> str:
    if value is None:
        return ""
    try:
        pk_m = float(value)
    except (TypeError, ValueError):
        return ""
    pk = int(pk_m // 100)
    plus = pk_m - pk * 100
    return f"ПК{pk}+{plus:05.2f}".replace(".", ",")


def _dashboard_isso_pk_label(pk_start: Any, pk_end: Any, object_type: str = "", object_code: str = "") -> str:
    start = _dashboard_isso_pk_text(pk_start)
    end = _dashboard_isso_pk_text(pk_end)
    norm_type = (object_type or "").lower().replace("ё", "е")
    norm_code = (object_code or "").upper()
    is_overpass = "путепровод" in norm_type or "overpass" in norm_type or norm_code.startswith("OVERPASS")
    if is_overpass:
        return start or end
    if start and end and start != end:
        return f"{start} - {end}"
    return start or end


def _dashboard_isso_empty_payload(
    d_from: date_cls,
    d_to: date_cls,
    *,
    detail: str = "",
    target_month: Optional[date_cls] = None,
) -> dict:
    target_month = target_month or date_cls(d_to.year, d_to.month, 1)
    return {
        "available": False,
        "detail": detail,
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "target_month": target_month.isoformat(),
        "target_month_label": _dashboard_isso_month_label(target_month),
        "months": [],
        "snapshot": None,
        "totals": {
            "objects": 0,
            "supports_total": 0,
            "supports_done": 0,
            "fact_supports_total": 0,
            "sites_total": 0,
            "sites_done": 0,
            "sites_sand_done": 0,
            "sites_shpgs_done": 0,
            "current_month_plan": 0,
            "current_month_done": 0,
            "current_month_sand_done": 0,
            "current_month_shpgs_done": 0,
        },
        "sections": [],
    }


def _dashboard_isso_object_sort_key(item: dict[str, Any]) -> tuple:
    return (
        _dashboard_kpi_section_sort_key(item.get("section_code")),
        _dashboard_isso_int(item.get("object_no")) or 9999,
        float(item.get("pk_start_m") or item.get("source_pk_m") or 1e12),
        str(item.get("object_name") or item.get("object_code") or ""),
    )


@router.get("/dashboard/isso-support")
def dashboard_isso_support(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    month: Optional[str] = Query(None),
):
    d_from, d_to = _parse_range(date_from, date_to)
    default_month = date_cls(d_to.year, d_to.month, 1)
    target_month = _dashboard_isso_parse_month(month, default_month)
    month_filter_active = bool(month) and target_month != default_month
    required_tables = (
        "isso_front_transfer_snapshots",
        "isso_front_transfer_lines",
        "isso_front_transfer_monthly_plan",
        "isso_object_front_attributes",
    )
    if not all(_analytics_table_exists(table) for table in required_tables):
        return _dashboard_isso_empty_payload(
            d_from,
            d_to,
            detail="ISSO support tables are not available",
            target_month=target_month,
        )

    snapshot = query_one(
        """
        SELECT id::text AS id,
               snapshot_date::text AS snapshot_date,
               source_filename,
               source_reference,
               title,
               review_status,
               created_at::text AS created_at,
               comment
        FROM isso_front_transfer_snapshots
        ORDER BY snapshot_date DESC, created_at DESC
        LIMIT 1
        """
    )
    if not snapshot:
        return _dashboard_isso_empty_payload(
            d_from,
            d_to,
            detail="ISSO snapshot not found",
            target_month=target_month,
        )
    snapshot_id = str(snapshot.get("id") or "")
    target_short = ISSO_SUPPORT_MONTH_SHORT_BY_NUM.get(target_month.month, "")

    line_rows = query(
        f"""
        WITH bounds AS (
            SELECT cs.code, cs.name, csv.pk_start, csv.pk_end
            FROM construction_section_versions csv
            JOIN construction_sections cs ON cs.id = csv.section_id
            WHERE csv.is_current AND csv.boundary_kind = 'main'
        ),
        access_base AS MATERIALIZED (
            SELECT access_o.id,
                   access_o.object_code,
                   access_o.name,
                   MIN(LEAST(access_os.pk_start, access_os.pk_end)) AS pk_start,
                   MAX(GREATEST(access_os.pk_start, access_os.pk_end)) AS pk_end
            FROM objects access_o
            JOIN object_types access_ot ON access_ot.id = access_o.object_type_id
                                      AND access_ot.code = 'ISSO_ACCESS'
            LEFT JOIN object_segments access_os ON access_os.object_id = access_o.id
            WHERE COALESCE(access_o.is_active, true) IS TRUE
            GROUP BY access_o.id, access_o.object_code, access_o.name
        ),
        approved_reports AS MATERIALIZED (
            SELECT dr.id
            FROM daily_reports dr
            WHERE COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
              AND {_non_pile_control_report_condition("dr")}
        ),
        work_activity AS MATERIALIZED (
            SELECT object_id,
                   COUNT(*)::int AS work_activity_count,
                   MAX(report_date)::date AS last_work_date
            FROM (
                SELECT dwi.object_id, dwi.report_date
                FROM daily_work_items dwi
                JOIN access_base access_dwi ON access_dwi.id = dwi.object_id
                JOIN approved_reports ar ON ar.id = dwi.daily_report_id
                WHERE dwi.object_id IS NOT NULL
                  AND dwi.report_date <= %s
                  AND COALESCE(dwi.is_demo, false) IS FALSE
                  AND COALESCE(dwi.volume, 0) <> 0
                UNION ALL
                SELECT mm.to_object_id AS object_id, mm.report_date
                FROM material_movements mm
                JOIN access_base access_to ON access_to.id = mm.to_object_id
                JOIN approved_reports ar ON ar.id = mm.daily_report_id
                WHERE mm.to_object_id IS NOT NULL
                  AND mm.report_date <= %s
                  AND COALESCE(mm.is_demo, false) IS FALSE
                  AND COALESCE(mm.volume, 0) <> 0
                UNION ALL
                SELECT mm.from_object_id AS object_id, mm.report_date
                FROM material_movements mm
                JOIN access_base access_from ON access_from.id = mm.from_object_id
                JOIN approved_reports ar ON ar.id = mm.daily_report_id
                WHERE mm.from_object_id IS NOT NULL
                  AND mm.report_date <= %s
                  AND COALESCE(mm.is_demo, false) IS FALSE
                  AND COALESCE(mm.volume, 0) <> 0
            ) activity
            GROUP BY object_id
        ),
        access_objects AS MATERIALIZED (
            SELECT access_base.id,
                   access_base.object_code,
                   access_base.name,
                   access_base.pk_start,
                   access_base.pk_end,
                   COALESCE(MAX(wa.work_activity_count), 0)::int AS work_activity_count,
                   MAX(wa.last_work_date)::date AS last_work_date
            FROM access_base
            LEFT JOIN work_activity wa ON wa.object_id = access_base.id
            GROUP BY access_base.id, access_base.object_code, access_base.name, access_base.pk_start, access_base.pk_end
        )
        SELECT l.id::text AS line_id,
               l.source_row,
               l.rd_status,
               l.rd_available_text,
               l.remark,
               l.raw_payload,
               o.object_code,
               o.name AS object_name_db,
               COALESCE(b.code, 'NO_SECTION') AS section_code,
               COALESCE(b.name, 'Без участка') AS section_name,
               a.source_pk_m::float AS source_pk_m,
               os.pk_start::float AS pk_start_m,
               os.pk_end::float AS pk_end_m,
               a.source_no,
               a.source_scope,
               a.source_name,
               access_match.id::text AS work_object_id,
               access_match.object_code AS work_object_code,
               access_match.name AS work_object_name,
               COALESCE(access_match.work_activity_count, 0)::int AS work_activity_count,
               access_match.last_work_date::text AS last_work_date
        FROM isso_front_transfer_lines l
        JOIN objects o ON o.id = l.object_id
        LEFT JOIN isso_object_front_attributes a ON a.id = l.object_attribute_id
        LEFT JOIN LATERAL (
            SELECT *
            FROM object_segments os
            WHERE os.object_id = o.id
            ORDER BY os.pk_start NULLS LAST
            LIMIT 1
        ) os ON true
        LEFT JOIN LATERAL (
            SELECT ao.*
            FROM access_objects ao
            WHERE ao.object_code = LEFT('ISSO_ACCESS_' || regexp_replace(o.object_code, '[^0-9A-Za-zА-Яа-я_]+', '_', 'g'), 100)
               OR (
                    ao.pk_start IS NOT NULL
                AND ao.pk_end IS NOT NULL
                AND os.pk_start IS NOT NULL
                AND os.pk_end IS NOT NULL
                AND ao.pk_start <= GREATEST(os.pk_start, os.pk_end)
                AND ao.pk_end >= LEAST(os.pk_start, os.pk_end)
               )
               OR (
                    ao.pk_start IS NOT NULL
                AND ao.pk_end IS NOT NULL
                AND a.source_pk_m IS NOT NULL
                AND a.source_pk_m BETWEEN LEAST(ao.pk_start, ao.pk_end) AND GREATEST(ao.pk_start, ao.pk_end)
               )
            ORDER BY
                CASE WHEN ao.object_code = LEFT('ISSO_ACCESS_' || regexp_replace(o.object_code, '[^0-9A-Za-zА-Яа-я_]+', '_', 'g'), 100) THEN 0 ELSE 1 END,
                ao.work_activity_count DESC,
                ABS(
                    COALESCE(a.source_pk_m, (os.pk_start + os.pk_end) / 2, 1e12)
                    - COALESCE((ao.pk_start + ao.pk_end) / 2, ao.pk_start, ao.pk_end, 1e12)
                ),
                ao.object_code
            LIMIT 1
        ) access_match ON true
        LEFT JOIN bounds b ON COALESCE(a.source_pk_m, (os.pk_start + os.pk_end) / 2) >= b.pk_start
                          AND COALESCE(a.source_pk_m, (os.pk_start + os.pk_end) / 2) < b.pk_end
        WHERE l.snapshot_id = %s::uuid
        ORDER BY COALESCE(a.source_pk_m, 1e12), a.source_no, l.source_row
        """,
        (d_to, d_to, d_to, snapshot_id),
    )
    plan_rows = query(
        """
        SELECT p.id::text AS plan_id,
               p.line_id::text AS line_id,
               p.plan_month::date AS plan_month,
               p.month_label,
               p.support_range_text,
               p.raw_payload
        FROM isso_front_transfer_monthly_plan p
        JOIN isso_front_transfer_lines l ON l.id = p.line_id
        WHERE l.snapshot_id = %s::uuid
        ORDER BY p.plan_month, p.id
        """,
        (snapshot_id,),
    )

    plan_by_line: dict[str, dict[str, int]] = {}
    plan_supports_by_line: dict[str, dict[str, list[str]]] = {}
    available_months: dict[str, date_cls] = {target_month.isoformat(): target_month}
    for plan in plan_rows:
        raw = _dashboard_isso_json_obj(plan.get("raw_payload"))
        plan_month = plan.get("plan_month")
        if isinstance(plan_month, date_cls):
            plan_month = date_cls(plan_month.year, plan_month.month, 1)
        else:
            try:
                parsed_month = date_cls.fromisoformat(str(plan_month)[:10])
                plan_month = date_cls(parsed_month.year, parsed_month.month, 1)
            except Exception:
                continue
        available_months[plan_month.isoformat()] = plan_month
        short = ISSO_SUPPORT_MONTH_SHORT_BY_NUM.get(plan_month.month)
        if not short:
            continue
        line_id = str(plan.get("line_id") or "")
        line_plan = plan_by_line.setdefault(line_id, {})
        line_plan[short] = line_plan.get(short, 0) + _dashboard_isso_int(raw.get("planned_sites"))
        support_text = str(
            plan.get("support_range_text")
            or raw.get("support_label")
            or raw.get("support_range_text")
            or ""
        ).strip()
        if support_text:
            month_supports = plan_supports_by_line.setdefault(line_id, {}).setdefault(short, [])
            if support_text not in month_supports:
                month_supports.append(support_text)
    months = [
        {"value": item.isoformat(), "label": _dashboard_isso_month_label(item)}
        for item in sorted(available_months.values())
    ]
    prepared_line_rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for rec in line_rows:
        raw = _dashboard_isso_json_obj(rec.get("raw_payload"))
        prepared_line_rows.append((rec, raw))
    target_materials = {
        _dashboard_isso_month_material(raw, target_month)
        for _, raw in prepared_line_rows
        if isinstance(raw.get("fact_material_by_month"), dict)
        and target_month.month in _dashboard_isso_fact_material_map(raw)
    }
    if len(target_materials) == 1:
        target_month_material_kind = next(iter(target_materials))
    elif target_materials:
        target_month_material_kind = "mixed"
    else:
        target_month_material_kind = "shpgs"

    object_map: dict[tuple, dict[str, Any]] = {}
    for rec, raw in prepared_line_rows:
        line_id = str(rec.get("line_id") or "")
        object_code = str(rec.get("object_code") or "").strip()
        month_plan = plan_by_line.get(line_id, {})
        month_supports = plan_supports_by_line.get(line_id, {})
        current_month_plan = _dashboard_isso_int(month_plan.get(target_short)) if target_short else 0
        current_month_done = _dashboard_isso_month_done(raw, target_month)
        current_month_sand_done, current_month_shpgs_done = _dashboard_isso_month_material_counts(raw, target_month)
        target_support_label = _dashboard_isso_support_label(
            "; ".join(month_supports.get(target_short, [])) if target_short else ""
        )
        ms11_scope = _dashboard_isso_ms11_scope(raw)
        ms11_working = _dashboard_isso_ms11_working(raw)
        ms11_bridge_work = _dashboard_isso_ms11_bridge_work(raw)
        if month_filter_active and current_month_plan <= 0 and current_month_done <= 0 and not target_support_label and not ms11_scope and not ms11_working and not ms11_bridge_work:
            continue
        section_code = _merge_section(rec.get("section_code")) or rec.get("section_code") or "NO_SECTION"
        section_label = _dashboard_kpi_section_label(section_code, rec.get("section_name"))
        object_no = _dashboard_isso_int(raw.get("object_no") or rec.get("source_no"))
        object_name = str(raw.get("object_name") or rec.get("source_name") or rec.get("object_name_db") or "ИССО").strip()
        object_type = str(raw.get("object_type") or rec.get("source_scope") or "ИССО").strip()
        pk_start_m = rec.get("pk_start_m") if rec.get("pk_start_m") is not None else rec.get("source_pk_m")
        pk_end_m = rec.get("pk_end_m") if rec.get("pk_end_m") is not None else rec.get("source_pk_m")
        key = (object_no, object_name, object_type, object_code)
        item = object_map.setdefault(key, {
            "object_no": object_no,
            "object_code": object_code,
            "object_name": object_name,
            "object_type": object_type,
            "section_code": section_code,
            "section_label": section_label,
            "source_pk_m": rec.get("source_pk_m"),
            "pk_start_m": pk_start_m,
            "pk_end_m": pk_end_m,
            "pk_label": _dashboard_isso_pk_label(pk_start_m, pk_end_m, object_type, object_code),
            "supports_total": 0,
            "supports_done": 0,
            "fact_supports_total": 0,
            "sites_total": 0,
            "sites_done": 0,
            "sites_sand_done": 0,
            "sites_shpgs_done": 0,
            "current_month_plan": 0,
            "current_month_done": 0,
            "current_month_sand_done": 0,
            "current_month_shpgs_done": 0,
            "rows": [],
        })
        rd_status = _dashboard_isso_normalize_rd_status(rec.get("rd_status") or raw.get("rd_status") or rec.get("rd_available_text"))
        remark = str(rec.get("remark") or raw.get("remark") or "").strip()
        sites_total = _dashboard_isso_int(raw.get("sites_total"))
        sites_sand_done, sites_shpgs_done = _dashboard_isso_material_counts(raw, target_month.year)
        sites_done = sites_shpgs_done
        ms11_started = _dashboard_isso_bool(raw.get("ms11_started"))
        work_activity_count = _dashboard_isso_int(rec.get("work_activity_count"))
        row_status = _dashboard_isso_work_status(
            rd_status,
            remark,
            work_activity_count,
            sites_total,
            sites_done,
            sites_sand_done,
        )
        display_support_label = target_support_label or _dashboard_isso_support_label(
            raw.get("support_label")
            or raw.get("transferred_supports_text")
            or raw.get("required_sequence_text")
        )
        fill_materials = _dashboard_isso_fill_materials(sites_sand_done, sites_shpgs_done)
        primary_material = fill_materials[0] if fill_materials else {"kind": "", "label": ""}
        support_row = {
            "line_id": line_id,
            "row_num": _dashboard_isso_int(raw.get("row_num") or rec.get("source_row")),
            "support_label": display_support_label,
            "target_month_support_label": target_support_label,
            "supports_total": _dashboard_isso_int(raw.get("supports_total")),
            "supports_done": _dashboard_isso_int(raw.get("supports_ready")),
            "fact_supports": _dashboard_isso_int(raw.get("fact_supports")),
            "fact_june_sites": _dashboard_isso_int(raw.get("fact_june_sites")),
            "fact_july_sites": _dashboard_isso_int(raw.get("fact_july_sites")),
            "fact_august_sites": _dashboard_isso_int(raw.get("fact_august_sites")),
            "fact_months": _dashboard_isso_fact_months(raw, target_month.year),
            "sites_total": sites_total,
            "sites_done": sites_done,
            "sites_sand_done": sites_sand_done,
            "sites_shpgs_done": sites_shpgs_done,
            "current_month_plan": current_month_plan,
            "current_month_done": current_month_done,
            "current_month_sand_done": current_month_sand_done,
            "current_month_shpgs_done": current_month_shpgs_done,
            "rd_status": rd_status,
            "status": row_status,
            "work_activity_count": work_activity_count,
            "last_work_date": str(rec.get("last_work_date") or "").strip(),
            "work_object_code": str(rec.get("work_object_code") or "").strip(),
            "work_object_name": str(rec.get("work_object_name") or "").strip(),
            "road_sand": str(raw.get("road_sand") or "").strip(),
            "road_shps": str(raw.get("road_shps") or "").strip(),
            "site_sand": str(raw.get("site_sand") or "").strip(),
            "site_shps": str(raw.get("site_shps") or "").strip(),
            "ms11_started": ms11_started,
            "ms11_scope": ms11_scope,
            "ms11_working": ms11_working,
            "ms11_bridge_work": ms11_bridge_work,
            "fill_material_kind": primary_material["kind"],
            "fill_material_label": primary_material["label"],
            "fill_materials": fill_materials,
            "deadline": str(raw.get("deadline") or "-").strip(),
            "letter": str(raw.get("letter") or "").strip(),
            "remark": remark,
        }
        item["supports_total"] += support_row["supports_total"]
        item["supports_done"] += support_row["supports_done"]
        item["fact_supports_total"] += support_row["fact_supports"]
        item["sites_total"] += support_row["sites_total"]
        item["sites_done"] += support_row["sites_done"]
        item["sites_sand_done"] += support_row["sites_sand_done"]
        item["sites_shpgs_done"] += support_row["sites_shpgs_done"]
        item["current_month_plan"] += support_row["current_month_plan"]
        item["current_month_done"] += support_row["current_month_done"]
        item["current_month_sand_done"] += support_row["current_month_sand_done"]
        item["current_month_shpgs_done"] += support_row["current_month_shpgs_done"]
        item["rows"].append(support_row)

    objects = sorted(object_map.values(), key=_dashboard_isso_object_sort_key)
    section_map: dict[str, dict[str, Any]] = {}
    for item in objects:
        section = section_map.setdefault(item["section_code"], {
            "section_code": item["section_code"],
            "section_label": item["section_label"],
            "objects": 0,
            "supports_total": 0,
            "supports_done": 0,
            "fact_supports_total": 0,
            "sites_total": 0,
            "sites_done": 0,
            "sites_sand_done": 0,
            "sites_shpgs_done": 0,
            "current_month_plan": 0,
            "current_month_done": 0,
            "current_month_sand_done": 0,
            "current_month_shpgs_done": 0,
            "issos": [],
        })
        section["objects"] += 1
        for key in (
            "supports_total",
            "supports_done",
            "fact_supports_total",
            "sites_total",
            "sites_done",
            "sites_sand_done",
            "sites_shpgs_done",
            "current_month_plan",
            "current_month_done",
            "current_month_sand_done",
            "current_month_shpgs_done",
        ):
            section[key] += int(item.get(key) or 0)
        section["issos"].append(item)

    sections = sorted(section_map.values(), key=lambda row: _dashboard_kpi_section_sort_key(row.get("section_code")))
    totals = {
        "objects": len(objects),
        "supports_total": sum(int(item.get("supports_total") or 0) for item in objects),
        "supports_done": sum(int(item.get("supports_done") or 0) for item in objects),
        "fact_supports_total": sum(int(item.get("fact_supports_total") or 0) for item in objects),
        "sites_total": sum(int(item.get("sites_total") or 0) for item in objects),
        "sites_done": sum(int(item.get("sites_done") or 0) for item in objects),
        "sites_sand_done": sum(int(item.get("sites_sand_done") or 0) for item in objects),
        "sites_shpgs_done": sum(int(item.get("sites_shpgs_done") or 0) for item in objects),
        "current_month_plan": sum(int(item.get("current_month_plan") or 0) for item in objects),
        "current_month_done": sum(int(item.get("current_month_done") or 0) for item in objects),
        "current_month_sand_done": sum(int(item.get("current_month_sand_done") or 0) for item in objects),
        "current_month_shpgs_done": sum(int(item.get("current_month_shpgs_done") or 0) for item in objects),
    }
    return {
        "available": True,
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "target_month": target_month.isoformat(),
        "target_month_label": _dashboard_isso_month_label(target_month),
        "target_month_material_kind": target_month_material_kind,
        "months": months,
        "snapshot": snapshot,
        "totals": totals,
        "sections": sections,
    }


@router.get("/dashboard/money-plan-fact")
def dashboard_money_plan_fact(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    d_from, d_to = _parse_range(date_from, date_to)
    rate_map = _statement_work_type_rate_map()
    row_map: dict[tuple, dict] = {}
    missing_work_type_map: dict[str, dict] = {}
    plan_total = 0.0
    fact_total = 0.0

    def add_money_row(source: dict, *, plan_volume: float = 0.0, fact_volume: float = 0.0) -> None:
        nonlocal plan_total, fact_total
        if abs(plan_volume) < 0.000001 and abs(fact_volume) < 0.000001:
            return
        plan_amount, plan_missing = _dashboard_money_amount(source, rate_map, "dashboard_plan_volume", plan_volume)
        fact_amount, fact_missing = _dashboard_money_amount(source, rate_map, "dashboard_fact_volume", fact_volume)
        plan_total += plan_amount
        fact_total += fact_amount
        section_code = _merge_section(source.get("section_code")) or source.get("section_code") or "—"
        key = (
            section_code,
            source.get("object_type_code") or "—",
            source.get("object_id") or source.get("object_code") or source.get("object_name") or "—",
            source.get("work_type_id") or source.get("work_type_code") or source.get("work_type_name") or "—",
        )
        has_any_rate = _dashboard_money_has_any_rate(rate_map, source.get("work_type_id"))
        if not has_any_rate:
            work_type_key = str(source.get("work_type_id") or source.get("work_type_code") or source.get("work_type_name") or "—")
            missing_slot = missing_work_type_map.setdefault(work_type_key, {
                "work_type_id": source.get("work_type_id"),
                "work_type_code": source.get("work_type_code") or "—",
                "work_type_name": source.get("work_type_name") or source.get("category_label") or "Работа",
                "unit": source.get("unit") or "—",
                "plan_volume": 0.0,
                "fact_volume": 0.0,
                "_row_keys": set(),
                "_section_codes": set(),
                "_object_keys": set(),
            })
            missing_slot["plan_volume"] += plan_volume
            missing_slot["fact_volume"] += fact_volume
            missing_slot["_row_keys"].add(key)
            missing_slot["_section_codes"].add(section_code)
            missing_slot["_object_keys"].add(source.get("object_id") or source.get("object_code") or source.get("object_name") or "—")
        slot = row_map.setdefault(key, {
            "section_code": section_code,
            "section_label": _dashboard_kpi_section_label(section_code, source.get("section_name")),
            "object_type_code": source.get("object_type_code") or "—",
            "object_type_name": source.get("object_type_name") or "Без типа",
            "object_code": source.get("object_code") or "—",
            "object_name": source.get("object_name") or "Без объекта",
            "work_type_code": source.get("work_type_code") or "—",
            "work_type_name": source.get("work_type_name") or source.get("category_label") or "Работа",
            "unit": source.get("unit") or "—",
            "plan_volume": 0.0,
            "fact_volume": 0.0,
            "plan_amount": 0.0,
            "fact_amount": 0.0,
            "missing_rate": False,
        })
        slot["plan_volume"] += plan_volume
        slot["fact_volume"] += fact_volume
        slot["plan_amount"] += plan_amount
        slot["fact_amount"] += fact_amount
        slot["missing_rate"] = bool(slot["missing_rate"] or plan_missing or fact_missing)

    if _analytics_table_exists("planned_work_items"):
        plan_rows = query(
            _statement_scope_cte()
            + """
        , scoped_plan AS (
          SELECT pwi.id::text AS plan_item_id,
                 COUNT(*) OVER (PARTITION BY pwi.id)::numeric AS section_row_count,
                 so.section_code,
                 so.section_name,
                 so.id::text AS object_id,
                 so.object_code,
                 so.object_name,
                 so.object_type_code,
                 so.object_type_name,
                 wt.id::text AS work_type_id,
                 wt.code AS work_type_code,
                 wt.name AS work_type_name,
                 COALESCE(NULLIF(pwi.unit, ''), wt.default_unit, 'шт') AS unit,
                 COALESCE(pwi.pk_start, so.object_pk_start) AS plan_pk_start,
                 COALESCE(pwi.pk_end, so.object_pk_end) AS plan_pk_end,
                 so.pk_start AS section_pk_start,
                 so.pk_end AS section_pk_end,
                 COALESCE(pwi.pk_start, so.object_pk_start, so.pk_start) AS pk_start,
                 COALESCE(pwi.pk_end, so.object_pk_end, so.pk_end) AS pk_end,
                 CASE
                   WHEN pwi.period_start IS NULL AND pwi.period_end IS NULL THEN NULL
                   ELSE LEAST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start))
                 END AS period_start_eff,
                 CASE
                   WHEN pwi.period_start IS NULL AND pwi.period_end IS NULL THEN NULL
                   ELSE GREATEST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start))
                 END AS period_end_eff,
                 COALESCE(pwi.planned_volume, 0)::numeric AS planned_volume
          FROM planned_work_items pwi
          JOIN object_sections so ON so.id = pwi.object_id
          JOIN work_types wt ON wt.id = pwi.work_type_id
          WHERE COALESCE(pwi.is_active, true) IS TRUE
            AND wt.is_active IS NOT FALSE
            AND (
              (pwi.period_start IS NULL AND pwi.period_end IS NULL AND %s::date <= %s::date)
              OR (
                COALESCE(pwi.period_start, pwi.period_end) IS NOT NULL
                AND LEAST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start)) <= %s::date
                AND GREATEST(COALESCE(pwi.period_start, pwi.period_end), COALESCE(pwi.period_end, pwi.period_start)) >= %s::date
              )
            )
        )
        SELECT section_code,
               section_name,
               object_id,
               object_code,
               object_name,
               object_type_code,
               object_type_name,
               work_type_id,
               work_type_code,
               work_type_name,
               unit,
               pk_start,
               pk_end,
               (
                 planned_volume
                 * CASE
                     WHEN period_start_eff IS NULL AND period_end_eff IS NULL
                       THEN CASE WHEN %s::date <= %s::date THEN 1::numeric ELSE 0::numeric END
                     ELSE GREATEST(0, (LEAST(period_end_eff, %s::date) - GREATEST(period_start_eff, %s::date) + 1))::numeric
                          / GREATEST(1, (period_end_eff - period_start_eff + 1))::numeric
                   END
                 * CASE
                     WHEN plan_pk_start IS NOT NULL
                      AND plan_pk_end IS NOT NULL
                      AND section_pk_start IS NOT NULL
                      AND section_pk_end IS NOT NULL
                      AND ABS(plan_pk_end - plan_pk_start) >= 0.001
                       THEN GREATEST(
                         0,
                         LEAST(GREATEST(plan_pk_start, plan_pk_end), GREATEST(section_pk_start, section_pk_end))
                         - GREATEST(LEAST(plan_pk_start, plan_pk_end), LEAST(section_pk_start, section_pk_end))
                       ) / NULLIF(ABS(plan_pk_end - plan_pk_start), 0)
                     ELSE 1::numeric / NULLIF(section_row_count, 0)
                   END
               )::numeric AS plan_volume
        FROM scoped_plan
            """,
            [
                d_from,
                ANALYTICS_INCEPTION_DATE,
                d_to,
                d_from,
                d_from,
                ANALYTICS_INCEPTION_DATE,
                d_to,
                d_from,
            ],
        )
        for row in plan_rows:
            add_money_row(row, plan_volume=float(row.get("plan_volume") or 0))

    seg_volume_expr = _analytics_segment_volume_expr("seg")
    fact_rows = query(
        f"""
        SELECT cs_eff.code AS section_code,
               cs_eff.name AS section_name,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.id::text END, o.id::text) AS object_id,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code) AS object_code,
               COALESCE(CASE WHEN pf_detail.field_code IS NOT NULL THEN 'Свайное поле ' || pf_detail.field_code END, NULLIF(o.name, ''), 'Без объекта') AS object_name,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code) AS object_type_code,
               COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'Свайное поле' END, ot.name) AS object_type_name,
               wt.id::text AS work_type_id,
               wt.code AS work_type_code,
               wt.name AS work_type_name,
               COALESCE(NULLIF(dwi.unit, ''), wt.default_unit, 'шт') AS unit,
               COALESCE(seg.pk_start, ob_eff.pk_start) AS pk_start,
               COALESCE(seg.pk_end, ob_eff.pk_end) AS pk_end,
               SUM({seg_volume_expr})::numeric AS fact_volume
        FROM daily_work_items dwi
        JOIN daily_reports dr ON dr.id = dwi.daily_report_id
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        {_effective_section_join('seg')}
        LEFT JOIN pile_fields pf_detail ON pf_detail.id = seg.pile_field_id
        WHERE dwi.report_date BETWEEN %s AND %s
          AND dwi.is_demo IS NOT TRUE
          AND wt.is_active IS NOT FALSE
          AND {_approved_report_exists("dwi")}
        GROUP BY cs_eff.code, cs_eff.name,
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.id::text END, o.id::text),
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN pf_detail.field_code END, o.object_code),
                 COALESCE(CASE WHEN pf_detail.field_code IS NOT NULL THEN 'Свайное поле ' || pf_detail.field_code END, NULLIF(o.name, ''), 'Без объекта'),
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'PILE_FIELD' END, ot.code),
                 COALESCE(CASE WHEN pf_detail.id IS NOT NULL THEN 'Свайное поле' END, ot.name),
                 wt.id, wt.code, wt.name,
                 COALESCE(NULLIF(dwi.unit, ''), wt.default_unit, 'шт'),
                 COALESCE(seg.pk_start, ob_eff.pk_start),
                 COALESCE(seg.pk_end, ob_eff.pk_end)
        """,
        [d_from, d_to],
    )
    for row in fact_rows:
        add_money_row(row, fact_volume=float(row.get("fact_volume") or 0))

    rows = []
    for row in row_map.values():
        rows.append({
            **row,
            "plan_volume": round(float(row.get("plan_volume") or 0), 3),
            "fact_volume": round(float(row.get("fact_volume") or 0), 3),
            "plan_amount": round(float(row.get("plan_amount") or 0), 2),
            "fact_amount": round(float(row.get("fact_amount") or 0), 2),
        })
    rows.sort(key=lambda row: (
        _dashboard_kpi_section_sort_key(row.get("section_code")),
        str(row.get("object_type_name") or row.get("object_type_code") or ""),
        str(row.get("object_name") or row.get("object_code") or ""),
        str(row.get("work_type_name") or row.get("work_type_code") or ""),
    ))

    missing_work_types = []
    for item in missing_work_type_map.values():
        missing_work_types.append({
            "work_type_id": item.get("work_type_id"),
            "work_type_code": item.get("work_type_code") or "—",
            "work_type_name": item.get("work_type_name") or "Работа",
            "unit": item.get("unit") or "—",
            "plan_volume": round(float(item.get("plan_volume") or 0), 3),
            "fact_volume": round(float(item.get("fact_volume") or 0), 3),
            "row_count": len(item.get("_row_keys") or []),
            "section_count": len(item.get("_section_codes") or []),
            "object_count": len(item.get("_object_keys") or []),
        })
    missing_work_types.sort(key=lambda row: (
        -abs(float(row.get("plan_volume") or 0) + float(row.get("fact_volume") or 0)),
        str(row.get("work_type_name") or row.get("work_type_code") or ""),
    ))
    missing_row_count = sum(1 for row in rows if row.get("missing_rate"))

    section_map: dict[str, dict] = {}
    for row in rows:
        section = section_map.setdefault(row["section_code"], {
            "section_code": row["section_code"],
            "section_label": row["section_label"],
            "plan_amount": 0.0,
            "fact_amount": 0.0,
            "rows": [],
        })
        section["plan_amount"] += float(row.get("plan_amount") or 0)
        section["fact_amount"] += float(row.get("fact_amount") or 0)
        section["rows"].append(row)

    sections = [
        {
            **section,
            "plan_amount": round(float(section.get("plan_amount") or 0), 2),
            "fact_amount": round(float(section.get("fact_amount") or 0), 2),
        }
        for section in section_map.values()
    ]
    sections.sort(key=lambda row: _dashboard_kpi_section_sort_key(row.get("section_code")))
    return {
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "plan_total": round(plan_total, 2),
        "fact_total": round(fact_total, 2),
        "missing_rate_count": len(missing_work_types),
        "missing_work_type_count": len(missing_work_types),
        "missing_row_count": missing_row_count,
        "missing_work_types": missing_work_types,
        "rows": rows,
        "sections": sections,
    }


# ── analytics stockpile balances ───────────────────────────────────────

@router.get("/analytics/stockpile-balances")
def analytics_stockpile_balances(
    as_of: Optional[str] = Query(None, description="YYYY-MM-DD; если позже максимума — берём максимум"),
):
    """Состояние накопителей на выбранную дату.

    Источник истины — последний срез остатков из блока "Накопители" в отчетах
    по каждому участку. Внутри среза показываются только ненулевые остатки:
    если накопитель пропал из нового среза участка или пришел с нулем, старая
    строка больше не подтягивается из истории.
    Движения материалов здесь не суммируются: они описывают оборот, а не состояние.
    """
    requested_date = None
    if as_of:
        try:
            requested_date = date_cls.fromisoformat(as_of)
        except Exception:
            requested_date = None

    max_row = query_one(
        """
        SELECT MAX(snapshot_date) AS max_date
        FROM stockpile_balance_snapshots
        WHERE balance_volume IS NOT NULL
        """
    )
    max_date = max_row["max_date"] if max_row else None
    if max_date is None:
        return {
            "as_of": as_of,
            "effective_date": None,
            "max_date": None,
            "rows": [],
            "note": "нет срезов состояния накопителей",
        }

    upper_date = requested_date or max_date
    note = None
    if upper_date > max_date:
        note = f"Запрошенная дата {upper_date.isoformat()} позже последнего среза — показываем состояние на {max_date.isoformat()}"
        upper_date = max_date

    eff_row = query_one(
        """
        SELECT MAX(snapshot_date) AS effective_date
        FROM stockpile_balance_snapshots
        WHERE snapshot_date <= %s
          AND balance_volume IS NOT NULL
        """,
        (upper_date,),
    )
    effective_date = eff_row["effective_date"] if eff_row else None
    if effective_date is None:
        return {
            "as_of": as_of,
            "effective_date": None,
            "max_date": max_date.isoformat(),
            "rows": [],
            "note": f"на дату {upper_date.isoformat()} и раньше нет срезов состояния накопителей",
        }

    rows = query(
        """
        WITH sp AS (
          SELECT sp.id AS stockpile_id,
                 sp.name AS stockpile_name,
                 sp.object_id,
                 o.name AS object_name,
                 COALESCE(m.code,
                   CASE
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%пес%%' THEN 'SAND'
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%торф%%' THEN 'PEAT'
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%ЩПГС%%' OR COALESCE(sp.name, o.name, '') ILIKE '%%ЩПС%%' OR COALESCE(sp.name, o.name, '') ILIKE '%%щеб%%' THEN 'SHPGS'
                     ELSE 'OTHER'
                   END
                 ) AS material_code,
                 COALESCE(m.name,
                   CASE
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%пес%%' THEN 'Песок'
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%торф%%' THEN 'Торф'
                     WHEN COALESCE(sp.name, o.name, '') ILIKE '%%ЩПГС%%' OR COALESCE(sp.name, o.name, '') ILIKE '%%ЩПС%%' OR COALESCE(sp.name, o.name, '') ILIKE '%%щеб%%' THEN 'ЩПГС'
                     ELSE 'Материал'
                   END
                 ) AS material_name,
                 os.pk_start,
                 os.pk_end,
                 os.pk_raw_text,
                 NULLIF((regexp_match(COALESCE(sp.name, o.name, ''), 'участок[[:space:]]*№?[[:space:]]*([[:digit:]]+)', 'i'))[1], '')::int AS name_section_num
          FROM stockpiles sp
          LEFT JOIN objects o ON o.id = sp.object_id
          LEFT JOIN materials m ON m.id = sp.material_id
          LEFT JOIN LATERAL (
            SELECT pk_start, pk_end, pk_raw_text
            FROM object_segments os
            WHERE os.object_id = sp.object_id
            ORDER BY os.pk_start NULLS LAST
            LIMIT 1
          ) os ON true
          WHERE sp.is_active IS NOT FALSE
        ),
        snapshots AS (
          SELECT sp.stockpile_id,
                 COALESCE(sp.stockpile_name, sp.object_name, 'Накопитель') AS stockpile_name,
                 COALESCE(
                   NULLIF(regexp_replace(section_scope.code, '[^0-9]', '', 'g'), '')::int,
                   sp.name_section_num
                 ) AS sec_num,
                 sp.material_code,
                 sp.material_name,
                 s.snapshot_date,
                 s.unit,
                 s.balance_volume,
                 s.review_tag,
                 sp.pk_start,
                 sp.pk_end,
                 sp.pk_raw_text
          FROM stockpile_balance_snapshots s
          JOIN sp ON sp.stockpile_id = s.stockpile_id
          LEFT JOIN LATERAL (
            SELECT cs.code
            FROM construction_section_versions csv
            JOIN construction_sections cs ON cs.id = csv.section_id
            WHERE csv.is_current = true
              AND csv.boundary_kind = 'main'
              AND sp.pk_start IS NOT NULL
              AND ((sp.pk_start + COALESCE(sp.pk_end, sp.pk_start)) / 2.0) BETWEEN csv.pk_start AND csv.pk_end
            ORDER BY cs.sort_order NULLS LAST, cs.code
            LIMIT 1
          ) section_scope ON true
          WHERE s.snapshot_date <= %s
            AND s.balance_volume IS NOT NULL
        ),
        section_latest AS (
          SELECT sec_num, MAX(snapshot_date) AS snapshot_date
          FROM snapshots
          GROUP BY sec_num
        )
        SELECT s.stockpile_id,
               s.stockpile_name,
               s.sec_num,
               s.material_code,
               s.material_name,
               s.snapshot_date,
               s.unit,
               s.balance_volume::numeric AS balance,
               COALESCE(s.review_tag, '') <> '' AS is_pending_review,
                 CASE
                   WHEN s.review_tag ~ '^pending_admin_review:[0-9a-fA-F-]{36}$'
                     THEN substring(s.review_tag from 'pending_admin_review:([0-9a-fA-F-]{36})')
                 ELSE NULL
               END AS report_id,
               s.pk_start,
               s.pk_end,
               s.pk_raw_text
        FROM snapshots s
        JOIN section_latest sl
          ON sl.sec_num IS NOT DISTINCT FROM s.sec_num
         AND sl.snapshot_date = s.snapshot_date
        WHERE s.balance_volume::numeric <> 0
        ORDER BY s.sec_num NULLS LAST, s.material_code, s.stockpile_name
        """,
        (effective_date,),
    )

    out = []
    for r in rows:
        out.append({
            "stockpile_id": str(r["stockpile_id"]),
            "stockpile_name": r["stockpile_name"] or "—",
            "section_num": int(r["sec_num"]) if r["sec_num"] else None,
            "pk_start": float(r["pk_start"]) if r.get("pk_start") is not None else None,
            "pk_end": float(r["pk_end"]) if r.get("pk_end") is not None else None,
            "pk_raw_text": r.get("pk_raw_text"),
            "pk_label": _format_pk_range_excel(r.get("pk_start"), r.get("pk_end"), r.get("pk_raw_text")) or None,
            "material_code": r["material_code"] or "OTHER",
            "material_name": r["material_name"] or "Материал",
            "inbound": 0.0,
            "outbound": 0.0,
            "balance": round(float(r["balance"] or 0), 1),
            "unit": r["unit"] or "м3",
            "snapshot_date": r["snapshot_date"].isoformat() if r["snapshot_date"] else None,
            "report_id": str(r["report_id"]) if r.get("report_id") else None,
            "is_pending_review": bool(r.get("is_pending_review")),
            "review_status": "pending_review" if r.get("is_pending_review") else "confirmed",
        })
    return {
        "as_of": as_of,
        "effective_date": effective_date.isoformat(),
        "max_date": max_date.isoformat(),
        "note": note,
        "rows": out,
    }


# ── map: всё для карты v2 ──────────────────────────────────────────────

@router.get("/map/markers")
def map_markers():
    """
    Единый запрос для карты: карьеры, свайные поля, мосты, ИССО,
    накопители, базы. Каждое — с типом, координатами, лейблом.
    Под обозначения из `Условные обозначения.html`.
    """
    objects = query(
        """
        SELECT o.id, o.object_code, o.name,
               ot.code AS type_code, ot.name AS type_name,
               os.pk_start, os.pk_end, os.pk_raw_text,
               os.start_lat, os.start_lng, os.end_lat, os.end_lng
        FROM objects o
        JOIN object_types ot ON ot.id = o.object_type_id
        LEFT JOIN object_segments os ON os.object_id = o.id
        WHERE os.start_lat IS NOT NULL
        ORDER BY ot.code, os.pk_start
        """
    )
    piles = query(
        """
        SELECT id, field_code, field_type, pile_type,
               pk_start, pk_end, pile_count, dynamic_test_count,
               start_lat, start_lng, end_lat, end_lng
        FROM pile_fields
        WHERE start_lat IS NOT NULL
        ORDER BY pk_start
        """
    )
    roads = query(
        """
        SELECT tr.id,
               tr.road_code AS code,
               tr.road_name AS name,
               tr.ad_start_pk AS ad_pk_start,
               tr.ad_end_pk   AS ad_pk_end,
               NULL::text      AS geojson
        FROM temporary_roads tr
        """
    )

    # Cast numerics → floats
    def _coord(r: dict, *keys: str) -> None:
        for k in keys:
            if r.get(k) is not None:
                r[k] = float(r[k])

    for r in objects: _coord(r, 'pk_start','pk_end','start_lat','start_lng','end_lat','end_lng')
    for r in piles:   _coord(r, 'pk_start','pk_end','start_lat','start_lng','end_lat','end_lng')
    for r in roads:   _coord(r, 'ad_pk_start','ad_pk_end')

    # Километровые точки вдоль оси (каждые 1000 м = 10 ПК)
    km_posts = query(
        """
        SELECT pk_number, latitude, longitude
        FROM route_pickets
        WHERE pk_number %% 10 = 0
        ORDER BY pk_number
        """
    )
    for p in km_posts:
        p['latitude']  = float(p['latitude'])
        p['longitude'] = float(p['longitude'])

    return {
        'objects': objects,
        'piles': piles,
        'temp_roads': roads,
        'km_posts': km_posts,
    }


# ── map: equipment on pickets ───────────────────────────────────────────

@router.get("/map/equipment")
def map_equipment(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    section: Optional[str] = None,
):
    """
    Агрегат по технике, привязанной к пикетам.
    Группировка: section_code × equipment_type.
    pk — середина диапазона участка (из construction_section_versions).

    Возвращает [{pk, sec, type, count}]:
      pk    — целый ПК (середина секции) — для отрисовки на карте;
      sec   — section_code (UCH_31 / UCH_32 раздельно, UI сливает);
      type  — нормализованный код: dump/excav/dozer/grader/roller/loader;
      count — суммарное число единиц со статусом working.
    """
    d_from, d_to = _parse_range(date_from, date_to)
    codes = _expand_sections(section)

    where = [
        "dr.report_date >= %s",
        "dr.report_date <= %s",
        "reu.status = 'working'",
        "COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')",
        _non_pile_control_report_condition("dr"),
    ]
    params: list = [d_from, d_to]
    if codes:
        where.append("cs.code = ANY(%s)")
        params.append(codes)

    # Нормализация типа техники: в БД — русские, на карте — латинские коды
    type_case = """
      CASE LOWER(reu.equipment_type)
        WHEN 'самосвал'     THEN 'dump'
        WHEN 'экскаватор'   THEN 'excav'
        WHEN 'бульдозер'    THEN 'dozer'
        WHEN 'автогрейдер'  THEN 'grader'
        WHEN 'грейдер'      THEN 'grader'
        WHEN 'каток'        THEN 'roller'
        WHEN 'погрузчик'    THEN 'loader'
        WHEN 'фр.погрузчик' THEN 'loader'
        ELSE 'other'
      END
    """

    rows = query(
        f"""
        SELECT
          cs.code AS section_code,
          {type_case} AS equip_type,
          COUNT(*)::int AS count,
          (csv.pk_start + csv.pk_end) / 2 AS mid_pk
        FROM report_equipment_units reu
        JOIN daily_reports dr ON dr.id = reu.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        LEFT JOIN construction_section_versions csv
          ON csv.section_id = cs.id AND csv.is_current = true AND csv.boundary_kind = 'main'
        WHERE {' AND '.join(where)}
          AND cs.code IS NOT NULL
        GROUP BY cs.code, {type_case}, csv.pk_start, csv.pk_end
        ORDER BY cs.code, equip_type
        """,
        params,
    )

    out = []
    for r in rows:
        if r['equip_type'] == 'other':
            continue
        mid = float(r['mid_pk']) if r['mid_pk'] is not None else None
        out.append({
            'sec': r['section_code'],
            'type': r['equip_type'],
            'count': int(r['count']),
            # pk — округляем до целого пикета (1 ПК = 100 единиц pk_start)
            'pk': round(mid / 100) if mid is not None else None,
        })
    return {'from': d_from.isoformat(), 'to': d_to.isoformat(), 'rows': out}
