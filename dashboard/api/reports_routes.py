"""
Reports endpoints for the «Отчёты» tab.

Подключение в api/main.py:
    from reports_routes import router as reports_router
    app.include_router(reports_router)

Все эндпоинты под префиксом /api/wip/reports/*.
"""
from __future__ import annotations

import time
import threading
import uuid
import re
import json
import math
import hashlib
import os
import urllib.parse
from collections import Counter
from copy import copy, deepcopy
from datetime import date as date_cls, datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import load_workbook
from pydantic import BaseModel, Field

from main import get_conn, query, query_one  # noqa: E402
from auth import current_user, require_admin, require_settings_manager  # noqa: E402
from report_text_parser import parse_report_text, sanitize_personal_report_text, split_report_texts  # noqa: E402
from xlsx_report_adapter import xlsx_bytes_to_report_text  # noqa: E402

router = APIRouter(prefix="/api/wip/reports", tags=["wip-reports"])

REPORT_TEMPLATE_FILENAME = "daily_report_one_sheet_template.xlsx"
REPORT_TEMPLATE_DIR = Path(os.getenv("VSM_REPORT_TEMPLATE_DIR", "/app/public_templates"))


def _daily_report_template_path() -> Path:
    candidates = [
        REPORT_TEMPLATE_DIR / REPORT_TEMPLATE_FILENAME,
        Path(__file__).resolve().parent.parent / "frontend" / "public" / "templates" / REPORT_TEMPLATE_FILENAME,
        Path(__file__).resolve().parent.parent / "templates" / REPORT_TEMPLATE_FILENAME,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]



def _invalidate_dashboard_cache_after_report_write(reason: str) -> None:
    try:
        from wip_routes import _invalidate_dashboard_response_cache
        _invalidate_dashboard_response_cache(reason)
    except Exception as exc:
        print(f"[dashboard-cache] report invalidation failed ({reason}): {exc}", flush=True)

def _web_uploaded_by_username(source_type: Optional[str], username: Optional[str]) -> Optional[str]:
    if not username:
        return None
    return username if (source_type or "").strip().lower().startswith("web") else None


def _content_disposition(filename: str, fallback: str = "shift-report.xlsx") -> dict[str, str]:
    return {
        "Content-Disposition": f"attachment; filename={fallback}; filename*=UTF-8''{urllib.parse.quote(filename)}",
        "Cache-Control": "no-store",
    }


# ── Alias cache (TTL 60s) ───────────────────────────────────────────────
#
# Кэш алиасов: {kind: {alias_text_lower: canonical_code}}.
# Загружается из таблицы work_type_aliases (см. wip_routes.py).
_ALIAS_CACHE: dict[str, Any] = {"ts": 0.0, "by_kind": {}}
_ALIAS_TTL_SEC = 60.0
_REF_CACHE: dict[str, Any] = {"ts": 0.0, "by_kind": {}}
_REF_TTL_SEC = 60.0
_REVIEW_SCHEMA_READY = False
_REVIEW_SCHEMA_LOCK = threading.Lock()
_REPORT_QUALITY_WORKER_LOCK = threading.Lock()
_REPORT_QUALITY_WORKER_STARTED = False
_ALIAS_TABLE_READY = False
_REPORT_ALIAS_LEARNER_LOCK = threading.Lock()
_REPORT_ALIAS_LEARNER_STARTED = False

REPORT_QUALITY_METRIC_KIND = "uploaded_to_day3"
REPORT_QUALITY_SNAPSHOT_DAYS = 3
REPORT_QUALITY_EXCLUDED_SOURCE_TYPES = {
    "mechanization_report_m",
    "web_fill_report",
    "web_pile_control",
}
REPORT_QUALITY_MASTER_SOURCE_TYPES = {"web_upload", "web_manual", "web_text", "hermes"}
REPORT_QUALITY_DEFAULT_PILE_ACCOUNT_MARKERS = ("isso_",)
REPORT_QUALITY_DEFAULT_PILE_USERNAMES: set[str] = set()
REPORT_QUALITY_WORKER_INTERVAL_SECONDS = int(os.getenv("VSM_REPORT_QUALITY_WORKER_INTERVAL_SECONDS", "3600"))
REPORT_QUALITY_WORKER_INITIAL_DELAY_SECONDS = int(os.getenv("VSM_REPORT_QUALITY_WORKER_INITIAL_DELAY_SECONDS", "180"))
REPORT_QUALITY_DUE_LIMIT = int(os.getenv("VSM_REPORT_QUALITY_DUE_LIMIT", "300"))
REPORT_QUALITY_ENDPOINT_REFRESH_LIMIT = int(os.getenv("VSM_REPORT_QUALITY_ENDPOINT_REFRESH_LIMIT", "20"))
_REPORT_ALIAS_LEARNER_LAST_DATE: Optional[date_cls] = None
_REPORT_ALIAS_LEARNER_INTERVAL_SEC = int(os.getenv("VSM_REPORT_ALIAS_LEARN_INTERVAL_SECONDS", "86400"))
_REPORT_ALIAS_LEARNER_INITIAL_DELAY_SEC = int(os.getenv("VSM_REPORT_ALIAS_LEARN_INITIAL_DELAY_SECONDS", "120"))

SECTION_RATING_SECTION_CODES = tuple(f"UCH_{idx}" for idx in range(1, 9))
SECTION_RATING_MSK_TZ = timezone(timedelta(hours=3), name="MSK")
SECTION_RATING_UPLOAD_START_MINUTE = 9 * 60
SECTION_RATING_UPLOAD_DEADLINE_MINUTE = 12 * 60
SECTION_RATING_SCOPE_LABELS = {"zp": "ЗП", "isso": "ИССО"}
SECTION_RATING_SCORE_KEYS = ("edit_score", "upload_score", "mstroy_score")

REPORT_USER_FLAG_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
REPORT_USER_FLAG_PRESETS = {
    "checked": {"label": "Проверен", "color": "#16a34a"},
    "duplicate": {"label": "Дубль", "color": "#dc2626"},
    "attention": {"label": "Обратить внимание", "color": "#f59e0b"},
    "piles": {"label": "Сваи", "color": "#64748b"},
    "fill": {"label": "Отсыпка", "color": "#2563eb"},
}

PILE_WORK_TYPE_CODES = {"PILE_MAIN", "PILE_TRIAL"}
PILE_HEADCAP_WORK_TYPE_CODE = "PILE_HEADCAP_INSTALLATION"
REGULAR_WORK_BLOCK_FORBIDDEN_WORK_TYPE_CODES = PILE_WORK_TYPE_CODES | {PILE_HEADCAP_WORK_TYPE_CODE}
PILE_TEST_KIND_VALUES = {"test", "trial", "пробные", "пробная", "пробных", "пробн"}
PILE_MAIN_KIND_VALUES = {"main", "основные", "основная", "основных", "основн"}

FILL_STATUS_COLUMNS = {
    "pioneer_fill": "pioneer_fill",
    "subgrade_not_to_grade": "subgrade_not_to_grade",
    "dso": "dso",
    "ready_for_shpgs": "ready_for_shpgs",
    "shpgs_done": "shpgs_done",
}

TEMP_ROADS_DISPLAY_EXCLUDED_CODES = {"АД16", "АД17", "ТЕХПРОЕЗД К АД13"}

# Safety rails for hired equipment rows. Normal reports contain dozens of units,
# not hundreds; a large count usually means a board number was parsed as quantity.
MAX_HIRED_EQUIPMENT_EXPANSION = 50
MAX_REPORT_EQUIPMENT_UNITS = 500


def _sql_text_list(values: set[str]) -> str:
    return ", ".join("'" + value.replace("'", "''") + "'" for value in sorted(values))


def _reports_column_exists(table_name: str, column_name: str) -> bool:
    try:
        rows = query(
            """
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
            ) AS exists
            """,
            [table_name, column_name],
        )
    except Exception:
        return False
    return bool(rows and rows[0].get("exists"))


def _reports_column_exists_cur(cur, table_name: str, column_name: str) -> bool:
    cur.execute(
        """
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
        )
        """,
        (table_name, column_name),
    )
    row = cur.fetchone()
    return bool(row and row[0])


def _report_temp_roads_display_where(alias: str = "tr") -> str:
    if _reports_column_exists("temporary_roads", "display_in_dashboard"):
        return f"COALESCE({alias}.display_in_dashboard, true) IS TRUE"
    return "TRUE"


def _iter_temp_road_fill_status_inputs(row: dict[str, Any]) -> list[tuple[str, Any, str]]:
    explicit_status = str(row.get("status_type") or "").strip()
    valid_statuses = set(FILL_STATUS_COLUMNS.values())
    if explicit_status in valid_statuses:
        inputs: list[tuple[str, Any, str]] = []
        if str(row.get("pk_ranges") or "").strip():
            inputs.append((explicit_status, row.get("pk_ranges"), "road"))
        if str(row.get("rail_pk_ranges") or "").strip():
            inputs.append((explicit_status, row.get("rail_pk_ranges"), "rail"))
        if inputs:
            return inputs
    return [
        (status_type, row.get(field), "road")
        for field, status_type in FILL_STATUS_COLUMNS.items()
        if str(row.get(field) or "").strip()
    ]


def _store_temp_road_status_segment(
    cur,
    *,
    report_id: str,
    road: dict[str, Any],
    report_date: Any,
    status_type: str,
    pk_system: str,
    road_pk_start: Any,
    road_pk_end: Any,
    rail_pk_start: Any,
    rail_pk_end: Any,
    source_reference: Optional[str],
    comment: Optional[str],
    review_tag: Optional[str],
) -> bool:
    cur.execute(
        """UPDATE temporary_road_status_segments
           SET daily_report_id = %s,
               object_id = COALESCE(object_id, %s),
               source_reference = COALESCE(source_reference, %s),
               comment = COALESCE(comment, %s),
               review_tag = %s
           WHERE daily_report_id IS NULL
             AND review_tag = %s
             AND road_id = %s
             AND status_date = %s
             AND status_type = %s
             AND input_pk_system = %s
             AND COALESCE(road_pk_start, -1) = COALESCE(%s, -1)
             AND COALESCE(road_pk_end, -1) = COALESCE(%s, -1)
             AND COALESCE(rail_pk_start, -1) = COALESCE(%s, -1)
             AND COALESCE(rail_pk_end, -1) = COALESCE(%s, -1)
           RETURNING id""",
        (
            report_id,
            road.get("object_id"),
            source_reference,
            comment,
            review_tag,
            review_tag,
            road["id"],
            report_date,
            status_type,
            pk_system,
            road_pk_start,
            road_pk_end,
            rail_pk_start,
            rail_pk_end,
        ),
    )
    if cur.fetchone():
        return True
    cur.execute(
        """INSERT INTO temporary_road_status_segments
           (id, daily_report_id, road_id, object_id, status_date, status_type, input_pk_system,
            road_pk_start, road_pk_end, rail_pk_start, rail_pk_end,
            source_reference, comment, is_demo, review_tag)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, false, %s)
           ON CONFLICT DO NOTHING
           RETURNING id""",
        (
            str(uuid.uuid4()),
            report_id,
            road["id"],
            road.get("object_id"),
            report_date,
            status_type,
            pk_system,
            road_pk_start,
            road_pk_end,
            rail_pk_start,
            rail_pk_end,
            source_reference,
            comment,
            review_tag,
        ),
    )
    return bool(cur.fetchone())


MAINLINE_FILL_STATUS_TYPES = {
    "prep_works",
    "main_works",
    "protective_layer_2",
    "protective_layer_1",
    "asphalt_layer",
    "no_work",
}

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

WORK_ANALYTICS_TAG_PATTERN = re.compile(r"(?:^|[;\n\r])\s*(?:tag|тег)\s*=\s*([^;\n\r]+)", re.I)
MAIN_TRACK_OBJECT_CODE_BY_SECTION = {
    "UCH_1": "MAIN_001",
    "UCH_2": "MAIN_002",
    "UCH_31": "MAIN_031",
    "UCH_32": "MAIN_032",
    "UCH_4": "MAIN_004",
    "UCH_5": "MAIN_005",
    "UCH_6": "MAIN_006",
    "UCH_7": "MAIN_007",
    "UCH_8": "MAIN_008",
}


def _normalize_pile_field_type(value: Any) -> Optional[str]:
    text = str(value or "").strip().lower()
    if text in PILE_TEST_KIND_VALUES:
        return "test"
    if text in PILE_MAIN_KIND_VALUES:
        return "main"
    return None


def _desired_pile_field_type(row: dict[str, Any], *, default: Optional[str] = "main") -> Optional[str]:
    for key in ("pile_kind", "field_type"):
        resolved = _normalize_pile_field_type(row.get(key))
        if resolved:
            return resolved
    return default


def _main_track_mid_pk(pk_start: Any = None, pk_end: Any = None) -> Optional[float]:
    try:
        start = float(pk_start) if pk_start is not None else None
        end = float(pk_end) if pk_end is not None else start
        return ((start or 0.0) + (end or start or 0.0)) / 2.0 if start is not None else None
    except (TypeError, ValueError):
        return None


def _main_track_object_code_for_section(section_code: Optional[str], mid_pk: Optional[float]) -> Optional[str]:
    code = str(section_code or "")
    if code == "UCH_3":
        return "MAIN_031" if mid_pk is None or mid_pk < 292520 else "MAIN_032"
    return MAIN_TRACK_OBJECT_CODE_BY_SECTION.get(code)


def _is_pile_headcap_text(value: Any) -> bool:
    text = str(value or "").strip().lower().replace("ё", "е")
    return bool(re.search(r"(?:наголов|оголов|head\s*cap|headcap)", text))


def _is_pile_headcap_row(row: dict[str, Any]) -> bool:
    code = str(row.get("work_type_code") or row.get("pile_work_type_code") or "").strip().upper()
    if code == PILE_HEADCAP_WORK_TYPE_CODE:
        return True
    return any(
        _is_pile_headcap_text(row.get(key))
        for key in ("pile_operation", "operation", "work_name", "work_name_raw", "work_type_name")
    )


def _pile_row_work_type_code(row: dict[str, Any], field: Optional[dict[str, Any]] = None) -> str:
    field_work_code = str((field or {}).get("work_type_code") or "").strip().upper()
    if (field or {}).get("target_type") == "pipe" and field_work_code in PILE_WORK_TYPE_CODES:
        return field_work_code
    if _is_pile_headcap_row(row):
        return PILE_HEADCAP_WORK_TYPE_CODE
    if field_work_code in PILE_WORK_TYPE_CODES:
        return field_work_code
    pile_kind = str((field or {}).get("field_type") or row.get("field_type") or row.get("pile_kind") or "main").lower()
    return "PILE_TRIAL" if pile_kind in ("test", "trial", "пробные", "пробная") else "PILE_MAIN"


def _pile_work_name_for_code(code: str) -> str:
    if code == PILE_HEADCAP_WORK_TYPE_CODE:
        return "Установка наголовников"
    if code == "PILE_TRIAL":
        return "Забивка пробных свай"
    return "Забивка основных свай"


def _is_regular_work_block_forbidden_work_type(code: Any) -> bool:
    return str(code or "").strip().upper() in REGULAR_WORK_BLOCK_FORBIDDEN_WORK_TYPE_CODES


def _regular_work_block_forbidden_work_message(work_idx: int, row: dict[str, Any]) -> str:
    code = str(row.get("work_type_code") or "").strip().upper()
    work_label = _pile_work_name_for_code(code) if code else (row.get("work_name") or "свайная работа")
    return (
        f"работа №{work_idx}: {work_label} должна вводиться в блоке «Свайные работы», "
        "а не в обычном блоке «Работы»"
    )


def classify_material_movement_type(from_type: Optional[str], to_type: Optional[str]) -> str:
    """Classify material movement by endpoint object semantics.

    Route types are semantic, not parser-default labels: only BORROW_PIT is a
    quarry source, only STOCKPILE is a stockpile, and every other resolved
    object type is treated as a constructive. This keeps TEMP_ROAD → TECH_ROAD
    and MAIN_TRACK → TEMP_ROAD out of `pit_to_constructive`.
    """
    if from_type == "BORROW_PIT" and to_type == "STOCKPILE":
        return "pit_to_stockpile"
    if from_type == "BORROW_PIT":
        return "pit_to_constructive"
    if from_type == "STOCKPILE" and to_type == "STOCKPILE":
        return "stockpile_to_stockpile"
    if from_type == "STOCKPILE":
        return "stockpile_to_constructive"
    if to_type == "STOCKPILE":
        return "constructive_to_stockpile"
    if from_type and to_type:
        return "constructive_to_constructive"
    return "pit_to_constructive"


REPORT_REVIEW_REQUIRED_COLUMNS: dict[str, tuple[str, ...]] = {
    "daily_reports": ("review_tag", "review_payload", "initial_parse_payload", "uploaded_by_username", "user_flags"),
    "daily_report_review_payload_versions": (
        "daily_report_id",
        "daily_report_id_text",
        "version_no",
        "reason",
        "status",
        "review_payload",
        "initial_parse_payload",
        "payload_hash",
        "created_by",
        "created_at",
    ),
    "daily_report_quality_snapshots": (
        "daily_report_id",
        "daily_report_id_text",
        "snapshot_kind",
        "snapshot_payload",
        "payload_hash",
        "report_date",
        "shift",
        "source_type",
        "source_reference",
        "uploaded_by_username",
        "review_flags",
        "is_pile_shift_report",
        "snapshot_at",
        "captured_at",
        "captured_by",
        "capture_status",
    ),
    "daily_report_quality_metrics": (
        "daily_report_id",
        "daily_report_id_text",
        "metric_kind",
        "source_type",
        "source_reference",
        "report_date",
        "shift",
        "uploaded_by_username",
        "is_pile_shift_report",
        "uploaded_snapshot_id",
        "day3_snapshot_id",
        "snapshot_pair_hash",
        "comparable_units",
        "changed_units",
        "changed_percent",
        "added_rows",
        "removed_rows",
        "changed_rows",
        "changed_fields",
        "section_breakdown",
        "calculated_at",
    ),
    "daily_section_rating_mstroy_convergence": (
        "rating_date",
        "scope",
        "section_code",
        "difference_percent",
        "score",
        "comment",
        "created_by",
        "created_at",
        "updated_by",
        "updated_at",
    ),
    "daily_work_items": ("review_tag", "analytics_tag"),
    "material_movements": ("review_tag", "haul_distance_km", "haul_distance_source"),
    "report_equipment_units": ("review_tag", "equipment_unit_id"),
    "daily_work_item_segments": ("review_tag", "analytics_tag", "pile_field_id"),
    "material_movement_equipment_usage": ("review_tag",),
    "work_item_equipment_usage": ("review_tag",),
    "objects": ("review_tag",),
    "object_segments": ("review_tag",),
    "materials": ("review_tag",),
    "work_types": ("review_tag", "analytics_tag", "productivity_enabled"),
    "object_types": ("review_tag",),
    "stockpiles": ("review_tag",),
    "stockpile_balance_snapshots": ("review_tag",),
    "temporary_road_status_segments": ("review_tag", "daily_report_id"),
    "pile_fields": ("object_id",),
}

REPORT_REVIEW_REQUIRED_TABLES: tuple[str, ...] = (
    "parser_learning_cases",
    "daily_report_review_payload_versions",
    "daily_report_quality_snapshots",
    "daily_report_quality_metrics",
    "daily_section_rating_mstroy_convergence",
    "daily_report_staff_counts",
    "equipment_units",
    "equipment_unit_identifiers",
    "work_analytics_tags",
)
REPORT_REVIEW_REQUIRED_INDEXES: tuple[str, ...] = (
    "idx_temporary_road_status_segments_report",
    "temporary_road_status_segments_report_unique_idx",
    "temporary_road_status_segments_unowned_unique_idx",
)
REPORT_REVIEW_FORBIDDEN_INDEXES: tuple[str, ...] = (
    "temporary_road_status_segments_unique_idx",
)


def _report_review_schema_prepared() -> bool:
    try:
        rows = query(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = ANY(%s)
            """,
            (list(REPORT_REVIEW_REQUIRED_COLUMNS),),
        )
        have_columns = {(row.get("table_name"), row.get("column_name")) for row in rows}
        for table_name, columns in REPORT_REVIEW_REQUIRED_COLUMNS.items():
            for column in columns:
                if (table_name, column) not in have_columns:
                    return False
        rows = query(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY(%s)
            """,
            (list(REPORT_REVIEW_REQUIRED_TABLES),),
        )
        have_tables = {row.get("table_name") for row in rows}
        if not all(table_name in have_tables for table_name in REPORT_REVIEW_REQUIRED_TABLES):
            return False
        rows = query(
            """
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'temporary_road_status_segments'
            """,
        )
        have_indexes = {row.get("indexname") for row in rows}
        if any(index_name in have_indexes for index_name in REPORT_REVIEW_FORBIDDEN_INDEXES):
            return False
        rows = query(
            """
            SELECT conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND t.relname = 'material_movements'
              AND c.conname = 'material_movements_check'
            """
        )
        if rows:
            return False
        return all(index_name in have_indexes for index_name in REPORT_REVIEW_REQUIRED_INDEXES)
    except Exception:
        return False


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


def _ensure_report_review_schema() -> None:
    global _REVIEW_SCHEMA_READY
    if _REVIEW_SCHEMA_READY:
        return
    if _report_review_schema_prepared():
        _REVIEW_SCHEMA_READY = True
        _start_report_quality_snapshot_worker()
        return
    with _REVIEW_SCHEMA_LOCK:
        if _REVIEW_SCHEMA_READY:
            _start_report_quality_snapshot_worker()
            return
        if _report_review_schema_prepared():
            _REVIEW_SCHEMA_READY = True
            _start_report_quality_snapshot_worker()
            return
        conn = get_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute("SET LOCAL lock_timeout = '2s'")
                    cur.execute("SET LOCAL statement_timeout = '60s'")
                    cur.execute("SELECT pg_advisory_xact_lock(hashtext('vsm_report_review_schema'))")
                    cur.execute("""
                        ALTER TABLE daily_reports
                        ADD COLUMN IF NOT EXISTS review_tag TEXT
                    """)
                    cur.execute("""
                        ALTER TABLE daily_reports
                        ADD COLUMN IF NOT EXISTS review_payload JSONB
                    """)
                    cur.execute("""
                        ALTER TABLE daily_reports
                        ADD COLUMN IF NOT EXISTS initial_parse_payload JSONB
                    """)
                    cur.execute("""
                        ALTER TABLE daily_reports
                        ADD COLUMN IF NOT EXISTS uploaded_by_username TEXT
                    """)
                    cur.execute("""
                        ALTER TABLE daily_reports
                        ADD COLUMN IF NOT EXISTS user_flags JSONB DEFAULT '[]'::jsonb
                    """)
                    cur.execute("""
                        UPDATE daily_reports
                        SET user_flags = '[]'::jsonb
                        WHERE user_flags IS NULL
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS parser_learning_cases (
                          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                          daily_report_id UUID REFERENCES daily_reports(id) ON DELETE CASCADE,
                          report_date DATE,
                          shift TEXT,
                          section_code TEXT,
                          source_reference TEXT,
                          case_type TEXT NOT NULL,
                          item_path TEXT NOT NULL,
                          raw_fragment TEXT,
                          initial_value JSONB,
                          final_value JSONB,
                          status TEXT NOT NULL DEFAULT 'new'
                            CHECK (status IN ('new', 'reviewed', 'implemented', 'ignored')),
                          fingerprint TEXT NOT NULL UNIQUE,
                          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_parser_learning_cases_report
                        ON parser_learning_cases(daily_report_id)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_parser_learning_cases_status_created
                        ON parser_learning_cases(status, created_at DESC)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS daily_report_review_payload_versions (
                          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                          daily_report_id UUID REFERENCES daily_reports(id) ON DELETE SET NULL,
                          daily_report_id_text TEXT NOT NULL,
                          version_no INTEGER NOT NULL,
                          reason TEXT NOT NULL DEFAULT 'unspecified',
                          status TEXT,
                          review_payload JSONB,
                          initial_parse_payload JSONB,
                          payload_hash TEXT NOT NULL,
                          created_by TEXT,
                          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                          UNIQUE (daily_report_id_text, version_no)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_review_payload_versions_report
                        ON daily_report_review_payload_versions(daily_report_id_text, created_at DESC)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_review_payload_versions_hash
                        ON daily_report_review_payload_versions(daily_report_id_text, payload_hash)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS daily_report_quality_snapshots (
                          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                          daily_report_id UUID REFERENCES daily_reports(id) ON DELETE SET NULL,
                          daily_report_id_text TEXT NOT NULL,
                          snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('uploaded', 'day3')),
                          snapshot_payload JSONB NOT NULL,
                          payload_hash TEXT NOT NULL,
                          report_date DATE,
                          shift TEXT,
                          source_type TEXT,
                          source_reference TEXT,
                          uploaded_by_username TEXT,
                          review_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
                          is_pile_shift_report BOOLEAN NOT NULL DEFAULT false,
                          snapshot_at TIMESTAMPTZ NOT NULL,
                          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                          captured_by TEXT,
                          capture_status TEXT NOT NULL DEFAULT 'captured',
                          UNIQUE (daily_report_id_text, snapshot_kind)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_quality_snapshots_report
                        ON daily_report_quality_snapshots(daily_report_id_text, snapshot_kind)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_quality_snapshots_scope
                        ON daily_report_quality_snapshots(is_pile_shift_report, report_date)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS daily_report_quality_metrics (
                          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                          daily_report_id UUID REFERENCES daily_reports(id) ON DELETE SET NULL,
                          daily_report_id_text TEXT NOT NULL,
                          metric_kind TEXT NOT NULL DEFAULT 'uploaded_to_day3',
                          source_type TEXT,
                          source_reference TEXT,
                          report_date DATE,
                          shift TEXT,
                          uploaded_by_username TEXT,
                          is_pile_shift_report BOOLEAN NOT NULL DEFAULT false,
                          uploaded_snapshot_id UUID REFERENCES daily_report_quality_snapshots(id) ON DELETE SET NULL,
                          day3_snapshot_id UUID REFERENCES daily_report_quality_snapshots(id) ON DELETE SET NULL,
                          snapshot_pair_hash TEXT NOT NULL,
                          comparable_units INTEGER NOT NULL DEFAULT 0,
                          changed_units INTEGER NOT NULL DEFAULT 0,
                          changed_percent NUMERIC(6, 2) NOT NULL DEFAULT 0,
                          added_rows INTEGER NOT NULL DEFAULT 0,
                          removed_rows INTEGER NOT NULL DEFAULT 0,
                          changed_rows INTEGER NOT NULL DEFAULT 0,
                          changed_fields INTEGER NOT NULL DEFAULT 0,
                          section_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
                          calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                          UNIQUE (daily_report_id_text, metric_kind)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_quality_metrics_period
                        ON daily_report_quality_metrics(report_date, is_pile_shift_report, calculated_at DESC)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_quality_metrics_report
                        ON daily_report_quality_metrics(daily_report_id_text, metric_kind)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS daily_section_rating_mstroy_convergence (
                          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                          rating_date DATE NOT NULL,
                          scope TEXT NOT NULL CHECK (scope IN ('zp', 'isso')),
                          section_code TEXT NOT NULL,
                          difference_percent NUMERIC(7, 2) NOT NULL
                            CHECK (difference_percent >= 0 AND difference_percent <= 1000),
                          score NUMERIC(6, 2) NOT NULL
                            CHECK (score >= 0 AND score <= 100),
                          comment TEXT,
                          created_by TEXT,
                          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                          updated_by TEXT,
                          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                          UNIQUE (rating_date, scope, section_code)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_section_rating_mstroy_period
                        ON daily_section_rating_mstroy_convergence(scope, rating_date, section_code)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS daily_report_staff_counts (
                            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                            daily_report_id UUID NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
                            category TEXT NOT NULL,
                            count INTEGER NOT NULL DEFAULT 0,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            UNIQUE (daily_report_id, category)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_report_staff_counts_report
                        ON daily_report_staff_counts(daily_report_id)
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS equipment_units (
                          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                          equipment_type text NOT NULL,
                          brand_model text,
                          unit_number text,
                          plate_number text,
                          ownership_type text NOT NULL DEFAULT 'unknown'
                            CHECK (ownership_type IN ('own', 'hired', 'unknown')),
                          contractor_name text,
                          status text NOT NULL DEFAULT 'unknown'
                            CHECK (status IN ('working', 'repair', 'out', 'standby', 'unknown')),
                          source_name text,
                          source_date date,
                          source_reference text,
                          location text,
                          vin text,
                          drivers_count text,
                          repair_reason text,
                          stopped_at date,
                          planned_work_at date,
                          comment text,
                          is_active boolean NOT NULL DEFAULT true,
                          created_at timestamptz NOT NULL DEFAULT now(),
                          updated_at timestamptz NOT NULL DEFAULT now(),
                          review_tag text
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS equipment_unit_identifiers (
                          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                          equipment_unit_id uuid NOT NULL REFERENCES equipment_units(id) ON DELETE CASCADE,
                          identifier_type text NOT NULL CHECK (identifier_type IN ('unit', 'plate')),
                          raw_value text NOT NULL,
                          normalized_value text NOT NULL,
                          created_at timestamptz NOT NULL DEFAULT now(),
                          UNIQUE (equipment_unit_id, identifier_type, normalized_value)
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_equipment_unit_identifiers_norm
                        ON equipment_unit_identifiers(normalized_value)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_equipment_units_type_status
                        ON equipment_units(equipment_type, status)
                    """)
                    cur.execute("""
                        ALTER TABLE report_equipment_units
                        ADD COLUMN IF NOT EXISTS equipment_unit_id uuid REFERENCES equipment_units(id)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_report_equipment_units_master
                        ON report_equipment_units(equipment_unit_id)
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_work_items_report
                        ON daily_work_items(daily_report_id)
                    """)
                    cur.execute("""
                        DO $$
                        BEGIN
                          IF NOT EXISTS (
                            SELECT 1
                            FROM work_item_equipment_usage
                            GROUP BY daily_work_item_id
                            HAVING COUNT(*) > 1
                          ) THEN
                            CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_equipment_usage_one_per_work
                            ON work_item_equipment_usage(daily_work_item_id);
                          END IF;
                        END $$;
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_material_movements_report
                        ON material_movements(daily_report_id)
                    """)
                    cur.execute("""
                        ALTER TABLE work_item_equipment_usage
                        ADD COLUMN IF NOT EXISTS work_hours NUMERIC(5,2)
                    """)
                    cur.execute("""
                        ALTER TABLE material_movement_equipment_usage
                        ADD COLUMN IF NOT EXISTS work_hours NUMERIC(5,2)
                    """)
                    cur.execute("""
                        ALTER TABLE material_movements
                        DROP CONSTRAINT IF EXISTS material_movements_check
                    """)
                    for table in (
                        "daily_work_items",
                        "material_movements",
                        "report_equipment_units",
                        "daily_work_item_segments",
                        "material_movement_equipment_usage",
                        "work_item_equipment_usage",
                        "objects",
                        "object_segments",
                        "materials",
                        "work_types",
                        "object_types",
                        "stockpiles",
                        "stockpile_balance_snapshots",
                        "temporary_road_status_segments",
                    ):
                        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS review_tag TEXT")
                    cur.execute("""
                        ALTER TABLE temporary_road_status_segments
                        ADD COLUMN IF NOT EXISTS daily_report_id uuid REFERENCES daily_reports(id) ON DELETE CASCADE
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_temporary_road_status_segments_report
                        ON temporary_road_status_segments(daily_report_id)
                    """)
                    cur.execute("""
                        DROP INDEX IF EXISTS temporary_road_status_segments_unique_idx
                    """)
                    cur.execute("""
                        CREATE UNIQUE INDEX IF NOT EXISTS temporary_road_status_segments_report_unique_idx
                        ON temporary_road_status_segments(
                            daily_report_id,
                            road_id,
                            status_date,
                            status_type,
                            input_pk_system,
                            COALESCE(road_pk_start, -1),
                            COALESCE(road_pk_end, -1),
                            COALESCE(rail_pk_start, -1),
                            COALESCE(rail_pk_end, -1)
                        )
                        WHERE daily_report_id IS NOT NULL
                    """)
                    cur.execute("""
                        CREATE UNIQUE INDEX IF NOT EXISTS temporary_road_status_segments_unowned_unique_idx
                        ON temporary_road_status_segments(
                            road_id,
                            status_date,
                            status_type,
                            input_pk_system,
                            COALESCE(road_pk_start, -1),
                            COALESCE(road_pk_end, -1),
                            COALESCE(rail_pk_start, -1),
                            COALESCE(rail_pk_end, -1)
                        )
                        WHERE daily_report_id IS NULL
                    """)
                    if not _reports_column_exists_cur(cur, "material_movements", "haul_distance_km"):
                        cur.execute("""
                            ALTER TABLE material_movements
                            ADD COLUMN IF NOT EXISTS haul_distance_km NUMERIC
                        """)
                    if not _reports_column_exists_cur(cur, "material_movements", "haul_distance_source"):
                        cur.execute("""
                            ALTER TABLE material_movements
                            ADD COLUMN IF NOT EXISTS haul_distance_source TEXT
                        """)
                    cur.execute("""
                        ALTER TABLE daily_work_items
                        ADD COLUMN IF NOT EXISTS analytics_tag TEXT
                    """)
                    cur.execute("""
                        ALTER TABLE daily_work_item_segments
                        ADD COLUMN IF NOT EXISTS analytics_tag TEXT
                    """)
                    cur.execute("""
                        ALTER TABLE work_types
                        ADD COLUMN IF NOT EXISTS analytics_tag TEXT
                    """)
                    cur.execute("""
                        ALTER TABLE work_types
                        ADD COLUMN IF NOT EXISTS productivity_enabled boolean NOT NULL DEFAULT true
                    """)
                    cur.execute("""
                        UPDATE work_types
                        SET productivity_enabled = false
                        WHERE code IN ('GEOTEXTILE_LAYER', 'GEOTEXTILE_LAYER_DO', 'FLEXIBLE_GRILLAGE_GEOTEXTILE')
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS work_analytics_tags (
                          name text PRIMARY KEY,
                          is_active boolean NOT NULL DEFAULT true,
                          created_at timestamptz NOT NULL DEFAULT now()
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_daily_work_items_analytics_tag
                        ON daily_work_items(analytics_tag)
                    """)
                    _ensure_pile_field_object_links(cur)
            _REVIEW_SCHEMA_READY = True
            _start_report_quality_snapshot_worker()
        finally:
            conn.close()


LEARNING_PAYLOAD_KEYS = (
    "header",
    "transport",
    "main_works",
    "aux_works",
    "staff_counts",
    "park",
    "problems",
    "stockpiles",
    "piles",
    "fill_statuses",
    "mainline_fill_statuses",
)

LEARNING_DROP_KEYS = {
    "aliases",
    "warnings",
    "review_actions",
    "human_summary",
    "source",
    "raw_text",
    "initial_parse",
    "material_suggestions",
    "from_object_suggestions",
    "to_object_suggestions",
    "work_type_suggestions",
    "object_suggestions",
}


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return value


def _clean_learning_value(value: Any) -> Any:
    value = _jsonable(value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in LEARNING_DROP_KEYS:
                continue
            if key.endswith("_suggestions"):
                continue
            out[key] = _clean_learning_value(item)
        return out
    if isinstance(value, list):
        return [_clean_learning_value(item) for item in value]
    return value


def _learning_payload_snapshot(payload: Any) -> dict[str, Any]:
    src = _clean_learning_value(payload)
    if not isinstance(src, dict):
        return {}
    return {key: src.get(key) for key in LEARNING_PAYLOAD_KEYS if key in src}


def _stable_json(value: Any) -> str:
    return json.dumps(_clean_learning_value(value), ensure_ascii=False, sort_keys=True, default=str)


def _review_payload_history_hash(review_payload: Any, initial_parse_payload: Any) -> str:
    raw = json.dumps(
        {
            "review_payload": review_payload,
            "initial_parse_payload": initial_parse_payload,
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _snapshot_report_review_payload(
    cur,
    report_id: str,
    reason: str,
    created_by: Optional[str] = None,
) -> bool:
    """Persist the current editable payload before overwriting or deleting it."""
    cur.execute(
        """
        SELECT review_payload, initial_parse_payload, status
        FROM daily_reports
        WHERE id = %s
        FOR UPDATE
        """,
        (report_id,),
    )
    row = cur.fetchone()
    if not row:
        return False
    review_payload, initial_parse_payload, status = row
    if review_payload is None and initial_parse_payload is None:
        return False
    payload_hash = _review_payload_history_hash(review_payload, initial_parse_payload)
    report_id_text = str(report_id)
    cur.execute(
        """
        SELECT payload_hash
        FROM daily_report_review_payload_versions
        WHERE daily_report_id_text = %s
        ORDER BY version_no DESC
        LIMIT 1
        """,
        (report_id_text,),
    )
    latest = cur.fetchone()
    if latest and latest[0] == payload_hash:
        return False
    cur.execute(
        """
        SELECT COALESCE(MAX(version_no), 0) + 1
        FROM daily_report_review_payload_versions
        WHERE daily_report_id_text = %s
        """,
        (report_id_text,),
    )
    version_no = int((cur.fetchone() or [1])[0] or 1)
    cur.execute(
        """
        INSERT INTO daily_report_review_payload_versions (
            daily_report_id, daily_report_id_text, version_no, reason, status,
            review_payload, initial_parse_payload, payload_hash, created_by
        )
        VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
        ON CONFLICT (daily_report_id_text, version_no) DO NOTHING
        """,
        (
            report_id,
            report_id_text,
            version_no,
            reason or "unspecified",
            status,
            json.dumps(review_payload, ensure_ascii=False, default=str) if review_payload is not None else None,
            json.dumps(initial_parse_payload, ensure_ascii=False, default=str) if initial_parse_payload is not None else None,
            payload_hash,
            created_by,
        ),
    )
    return cur.rowcount > 0


def _learning_raw_fragment(row: Any) -> Optional[str]:
    if not isinstance(row, dict):
        return None
    source = row.get("_source")
    if isinstance(source, dict):
        text = str(source.get("text") or "").strip()
        if text:
            return text[:1000]
    for key in ("raw", "raw_text", "pk_raw_text", "pk_rail_raw", "comment"):
        text = str(row.get(key) or "").strip()
        if text:
            return text[:1000]
    return None


def _learning_row_signature(row: Any, section: str) -> str:
    if not isinstance(row, dict):
        return _stable_json(row)
    if section == "transport":
        trips = row.get("trips") if isinstance(row.get("trips"), list) else []
        first_trip = trips[0] if trips and isinstance(trips[0], dict) else {}
        parts = [
            row.get("plate_number") or row.get("plate") or row.get("unit_number") or row.get("reported_number"),
            first_trip.get("material") or first_trip.get("material_code"),
            first_trip.get("from") or first_trip.get("from_object_code"),
            first_trip.get("to") or first_trip.get("to_object_code"),
            first_trip.get("volume"),
        ]
    elif section in {"main_works", "aux_works"}:
        parts = [
            row.get("work_name") or row.get("work_type_code"),
            row.get("constructive") or row.get("object_code") or row.get("constructive_code"),
            row.get("pk_rail_raw") or row.get("pk_start"),
            row.get("volume"),
        ]
    elif section == "park":
        parts = [
            row.get("plate_number") or row.get("plate") or row.get("unit_number") or row.get("reported_number"),
            row.get("equipment_type"),
            row.get("status"),
        ]
    elif section == "stockpiles":
        parts = [row.get("name"), row.get("material"), row.get("pk_raw_text") or row.get("rounded_pk"), row.get("volume")]
    elif section == "piles":
        parts = [row.get("field_code"), row.get("pk_text") or row.get("pk_raw_text"), row.get("count")]
    elif section == "fill_statuses":
        parts = [row.get("road_code"), row.get("status_type"), row.get("pk_ranges"), row.get("rail_pk_ranges"), row.get("pioneer_fill"), row.get("subgrade_not_to_grade"), row.get("dso"), row.get("ready_for_shpgs"), row.get("shpgs_done")]
    elif section == "mainline_fill_statuses":
        parts = [row.get("section_code"), row.get("status_type"), row.get("pk_ranges")]
    elif section == "staff_counts":
        parts = [row.get("category"), row.get("count")]
    else:
        parts = [row]
    return "|".join(str(part or "").strip().lower() for part in parts)


def _learning_index_rows(rows: Any, section: str) -> dict[str, Any]:
    indexed: dict[str, Any] = {}
    if not isinstance(rows, list):
        return indexed
    for idx, row in enumerate(rows):
        signature = _learning_row_signature(row, section)
        key = signature or f"idx:{idx}"
        if key in indexed:
            key = f"{key}#{idx}"
        indexed[key] = row
    return indexed


def _learning_case(
    case_type: str,
    item_path: str,
    initial_value: Any,
    final_value: Any,
    *,
    raw_fragment: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "case_type": case_type,
        "item_path": item_path,
        "raw_fragment": raw_fragment,
        "initial_value": _clean_learning_value(initial_value),
        "final_value": _clean_learning_value(final_value),
    }


def _build_parser_learning_cases(initial_parse: Any, final_payload: Any) -> list[dict[str, Any]]:
    initial = _learning_payload_snapshot(initial_parse)
    final = _learning_payload_snapshot(final_payload)
    cases: list[dict[str, Any]] = []
    for section in LEARNING_PAYLOAD_KEYS:
        before = initial.get(section)
        after = final.get(section)
        if _stable_json(before) == _stable_json(after):
            continue
        if isinstance(before, list) or isinstance(after, list):
            before_rows = before if isinstance(before, list) else []
            after_rows = after if isinstance(after, list) else []
            if len(before_rows) != len(after_rows):
                cases.append(_learning_case(
                    "row_count_changed",
                    section,
                    {"count": len(before_rows)},
                    {"count": len(after_rows)},
                ))
            before_index = _learning_index_rows(before_rows, section)
            after_index = _learning_index_rows(after_rows, section)
            for key in sorted(set(after_index) - set(before_index)):
                cases.append(_learning_case(
                    "row_added",
                    f"{section}.{key}",
                    None,
                    after_index[key],
                    raw_fragment=_learning_raw_fragment(after_index[key]),
                ))
            for key in sorted(set(before_index) - set(after_index)):
                cases.append(_learning_case(
                    "row_removed",
                    f"{section}.{key}",
                    before_index[key],
                    None,
                    raw_fragment=_learning_raw_fragment(before_index[key]),
                ))
            for key in sorted(set(before_index) & set(after_index)):
                if _stable_json(before_index[key]) != _stable_json(after_index[key]):
                    cases.append(_learning_case(
                        "row_changed",
                        f"{section}.{key}",
                        before_index[key],
                        after_index[key],
                        raw_fragment=_learning_raw_fragment(before_index[key]) or _learning_raw_fragment(after_index[key]),
                    ))
        else:
            cases.append(_learning_case("field_changed", section, before, after))
    return cases[:300]


def _store_parser_learning_cases(
    cur,
    report_id: str,
    *,
    initial_parse: Any,
    final_payload: Any,
    report_date: date_cls,
    shift: str,
    section_code: Optional[str],
    source_reference: Optional[str],
) -> int:
    cur.execute("DELETE FROM parser_learning_cases WHERE daily_report_id = %s", (report_id,))
    if not initial_parse:
        return 0
    cases = _build_parser_learning_cases(initial_parse, final_payload)
    inserted = 0
    for case in cases:
        fingerprint_source = "|".join([
            report_id,
            case["case_type"],
            case["item_path"],
            _stable_json(case.get("initial_value")),
            _stable_json(case.get("final_value")),
        ])
        fingerprint = hashlib.sha1(fingerprint_source.encode("utf-8")).hexdigest()
        cur.execute(
            """
            INSERT INTO parser_learning_cases
              (daily_report_id, report_date, shift, section_code, source_reference,
               case_type, item_path, raw_fragment, initial_value, final_value, fingerprint)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
            ON CONFLICT (fingerprint) DO NOTHING
            """,
            (
                report_id,
                report_date,
                shift,
                section_code,
                source_reference,
                case["case_type"],
                case["item_path"],
                case.get("raw_fragment"),
                json.dumps(case.get("initial_value"), ensure_ascii=False, default=str),
                json.dumps(case.get("final_value"), ensure_ascii=False, default=str),
                fingerprint,
            ),
        )
        inserted += cur.rowcount
    return inserted


def _report_quality_source_allowed(source_type: Optional[str]) -> bool:
    source = str(source_type or "").strip().lower()
    return source in REPORT_QUALITY_MASTER_SOURCE_TYPES and source not in REPORT_QUALITY_EXCLUDED_SOURCE_TYPES


def _report_quality_env_pile_usernames() -> set[str]:
    raw = os.getenv("VSM_REPORT_QUALITY_PILE_USERNAMES", "")
    return {
        str(item or "").strip().lower()
        for item in raw.split(",")
        if str(item or "").strip()
    } | REPORT_QUALITY_DEFAULT_PILE_USERNAMES


def _report_quality_account_marks_pile_shift(username: Optional[str]) -> bool:
    value = str(username or "").strip().lower()
    if not value:
        return False
    if value in _report_quality_env_pile_usernames():
        return True
    return any(value.startswith(marker) for marker in REPORT_QUALITY_DEFAULT_PILE_ACCOUNT_MARKERS)


def _report_quality_review_flags(payload: Any) -> list[str]:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = None
    if not isinstance(payload, dict):
        return []
    raw_flags = payload.get("review_flags") or []
    if isinstance(raw_flags, list):
        return [str(flag).strip() for flag in raw_flags if str(flag or "").strip()]
    if isinstance(raw_flags, str) and raw_flags.strip():
        return [raw_flags.strip()]
    return []


def _report_quality_payload_marks_pile_shift(payload: Any) -> bool:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = None
    if not isinstance(payload, dict):
        return False
    flag_text = " ".join(_report_quality_review_flags(payload)).lower().replace("ё", "е")
    if any(marker in flag_text for marker in ("сва", "isso", "иссо")):
        return True
    piles = payload.get("piles")
    if isinstance(piles, list) and any(isinstance(row, dict) and any(str(value or "").strip() for value in row.values()) for row in piles):
        return True
    header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
    author = str(header.get("author") or "").strip().lower().replace("ё", "е")
    return "иссо" in author or "isso" in author


def _report_quality_is_pile_shift_report(
    review_payload: Any,
    uploaded_by_username: Optional[str],
    actor_username: Optional[str] = None,
) -> bool:
    return (
        _report_quality_payload_marks_pile_shift(review_payload)
        or _report_quality_account_marks_pile_shift(uploaded_by_username)
        or _report_quality_account_marks_pile_shift(actor_username)
    )


def _report_quality_snapshot_payload(payload: Any) -> dict[str, Any]:
    snapshot = _learning_payload_snapshot(payload)
    snapshot.pop("fill_statuses", None)
    snapshot.pop("mainline_fill_statuses", None)
    return snapshot


def _report_quality_payload_hash(payload: Any) -> str:
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


def _report_quality_flatten_value(prefix: str, value: Any, out: dict[str, Any]) -> None:
    value = _clean_learning_value(value)
    if isinstance(value, dict):
        if not value:
            out[prefix] = {}
            return
        for key in sorted(value):
            if key == "review_flags":
                continue
            _report_quality_flatten_value(f"{prefix}.{key}" if prefix else str(key), value[key], out)
        return
    if isinstance(value, list):
        out[prefix] = [_clean_learning_value(item) for item in value]
        return
    out[prefix] = value


def _report_quality_flatten_snapshot(payload: Any) -> tuple[dict[str, Any], dict[str, set[str]]]:
    snapshot = _report_quality_snapshot_payload(payload)
    flat: dict[str, Any] = {}
    rows_by_section: dict[str, set[str]] = {}
    for section in LEARNING_PAYLOAD_KEYS:
        if section in {"fill_statuses", "mainline_fill_statuses"}:
            continue
        if section not in snapshot:
            continue
        value = snapshot.get(section)
        if isinstance(value, list):
            indexed = _learning_index_rows(value, section)
            rows_by_section[section] = set(indexed)
            for row_key, row in indexed.items():
                row_prefix = f"{section}.{row_key}"
                flat[f"{row_prefix}.__present"] = True
                if isinstance(row, dict):
                    for key in sorted(row):
                        _report_quality_flatten_value(f"{row_prefix}.{key}", row[key], flat)
                else:
                    flat[f"{row_prefix}.__value"] = row
        else:
            _report_quality_flatten_value(section, value, flat)
    return flat, rows_by_section


def _report_quality_diff(uploaded_payload: Any, day3_payload: Any) -> dict[str, Any]:
    before, before_rows = _report_quality_flatten_snapshot(uploaded_payload)
    after, after_rows = _report_quality_flatten_snapshot(day3_payload)
    changed_paths = [
        path
        for path in sorted(set(before) | set(after))
        if _stable_json(before.get(path)) != _stable_json(after.get(path))
    ]
    row_sections = sorted(set(before_rows) | set(after_rows))
    added_rows = 0
    removed_rows = 0
    changed_rows = 0
    section_breakdown: dict[str, dict[str, int]] = {}
    for section in row_sections:
        before_keys = before_rows.get(section, set())
        after_keys = after_rows.get(section, set())
        added = len(after_keys - before_keys)
        removed = len(before_keys - after_keys)
        changed = 0
        for row_key in before_keys & after_keys:
            prefix = f"{section}.{row_key}."
            if any(path.startswith(prefix) and not path.endswith(".__present") for path in changed_paths):
                changed += 1
        section_breakdown[section] = {"added_rows": added, "removed_rows": removed, "changed_rows": changed}
        added_rows += added
        removed_rows += removed
        changed_rows += changed
    comparable_units = len(set(before) | set(after))
    changed_units = len(changed_paths)
    changed_percent = round((changed_units / comparable_units * 100.0), 2) if comparable_units else 0.0
    changed_fields = sum(1 for path in changed_paths if not path.endswith(".__present"))
    return {
        "comparable_units": comparable_units,
        "changed_units": changed_units,
        "changed_percent": changed_percent,
        "added_rows": added_rows,
        "removed_rows": removed_rows,
        "changed_rows": changed_rows,
        "changed_fields": changed_fields,
        "section_breakdown": section_breakdown,
    }


def _report_quality_load_report_row(cur, report_id: str, *, for_update: bool = False) -> Optional[dict[str, Any]]:
    cur.execute(
        f"""
        SELECT
          dr.id::text AS id,
          dr.report_date,
          dr.shift,
          dr.source_type,
          dr.source_reference,
          dr.uploaded_by_username,
          dr.review_payload,
          dr.initial_parse_payload,
          dr.created_at
        FROM daily_reports dr
        WHERE dr.id = %s
        LIMIT 1
        {'FOR UPDATE' if for_update else ''}
        """,
        (report_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "report_date": row[1],
        "shift": row[2],
        "source_type": row[3],
        "source_reference": row[4],
        "uploaded_by_username": row[5],
        "review_payload": row[6],
        "initial_parse_payload": row[7],
        "created_at": row[8],
    }


def _report_quality_upsert_snapshot(
    cur,
    report_row: dict[str, Any],
    snapshot_kind: str,
    payload: Any,
    *,
    snapshot_at: datetime,
    captured_by: Optional[str],
    capture_status: str = "captured",
    actor_username: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    if snapshot_kind not in {"uploaded", "day3"}:
        return None
    if not report_row or not _report_quality_source_allowed(report_row.get("source_type")):
        return None
    normalized_payload = _report_quality_snapshot_payload(payload)
    if not normalized_payload:
        return None
    report_id = str(report_row.get("id"))
    payload_hash = _report_quality_payload_hash(normalized_payload)
    review_payload = report_row.get("review_payload") or payload
    review_flags = _report_quality_review_flags(review_payload)
    is_pile_shift = _report_quality_is_pile_shift_report(
        review_payload,
        report_row.get("uploaded_by_username"),
        actor_username,
    )
    cur.execute(
        """
        INSERT INTO daily_report_quality_snapshots (
            daily_report_id, daily_report_id_text, snapshot_kind, snapshot_payload,
            payload_hash, report_date, shift, source_type, source_reference,
            uploaded_by_username, review_flags, is_pile_shift_report,
            snapshot_at, captured_by, capture_status
        )
        VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
        ON CONFLICT (daily_report_id_text, snapshot_kind) DO NOTHING
        RETURNING id::text, payload_hash, is_pile_shift_report
        """,
        (
            report_id,
            report_id,
            snapshot_kind,
            json.dumps(normalized_payload, ensure_ascii=False, default=str),
            payload_hash,
            report_row.get("report_date"),
            report_row.get("shift"),
            report_row.get("source_type"),
            report_row.get("source_reference"),
            report_row.get("uploaded_by_username"),
            json.dumps(review_flags, ensure_ascii=False, default=str),
            is_pile_shift,
            snapshot_at,
            captured_by,
            capture_status,
        ),
    )
    row = cur.fetchone()
    if row:
        return {"id": row[0], "payload_hash": row[1], "is_pile_shift_report": row[2], "inserted": True}
    cur.execute(
        """
        SELECT id::text, payload_hash, is_pile_shift_report
        FROM daily_report_quality_snapshots
        WHERE daily_report_id_text = %s AND snapshot_kind = %s
        LIMIT 1
        """,
        (report_id, snapshot_kind),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "payload_hash": row[1], "is_pile_shift_report": row[2], "inserted": False}


def _report_quality_capture_uploaded_snapshot(
    cur,
    report_id: str,
    *,
    uploaded_payload: Any,
    captured_by: Optional[str],
    actor_username: Optional[str] = None,
) -> bool:
    report_row = _report_quality_load_report_row(cur, report_id)
    if not report_row:
        return False
    snapshot_at = report_row.get("created_at") or datetime.now(timezone.utc)
    result = _report_quality_upsert_snapshot(
        cur,
        report_row,
        "uploaded",
        uploaded_payload or report_row.get("initial_parse_payload") or report_row.get("review_payload"),
        snapshot_at=snapshot_at,
        captured_by=captured_by,
        capture_status="captured",
        actor_username=actor_username,
    )
    return bool(result and result.get("inserted"))


def _report_quality_calculate_metric_for_report(cur, report_id_text: str) -> Optional[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          uploaded.id::text AS uploaded_snapshot_id,
          uploaded.snapshot_payload AS uploaded_payload,
          uploaded.payload_hash AS uploaded_hash,
          day3.id::text AS day3_snapshot_id,
          day3.snapshot_payload AS day3_payload,
          day3.payload_hash AS day3_hash,
          COALESCE(day3.daily_report_id, uploaded.daily_report_id) AS daily_report_id,
          uploaded.daily_report_id_text,
          COALESCE(day3.source_type, uploaded.source_type) AS source_type,
          COALESCE(day3.source_reference, uploaded.source_reference) AS source_reference,
          COALESCE(day3.report_date, uploaded.report_date) AS report_date,
          COALESCE(day3.shift, uploaded.shift) AS shift,
          COALESCE(day3.uploaded_by_username, uploaded.uploaded_by_username) AS uploaded_by_username,
          (COALESCE(day3.is_pile_shift_report, false) OR COALESCE(uploaded.is_pile_shift_report, false)) AS is_pile_shift_report
        FROM daily_report_quality_snapshots uploaded
        JOIN daily_report_quality_snapshots day3
          ON day3.daily_report_id_text = uploaded.daily_report_id_text
         AND day3.snapshot_kind = 'day3'
        WHERE uploaded.daily_report_id_text = %s
          AND uploaded.snapshot_kind = 'uploaded'
        LIMIT 1
        """,
        (report_id_text,),
    )
    row = cur.fetchone()
    if not row:
        return None
    (
        uploaded_snapshot_id,
        uploaded_payload,
        uploaded_hash,
        day3_snapshot_id,
        day3_payload,
        day3_hash,
        daily_report_id,
        daily_report_id_text,
        source_type,
        source_reference,
        report_date,
        shift,
        uploaded_by_username,
        is_pile_shift_report,
    ) = row
    diff = _report_quality_diff(uploaded_payload, day3_payload)
    snapshot_pair_hash = hashlib.sha256(f"{uploaded_hash}:{day3_hash}".encode("utf-8")).hexdigest()
    cur.execute(
        """
        INSERT INTO daily_report_quality_metrics (
            daily_report_id, daily_report_id_text, metric_kind, source_type,
            source_reference, report_date, shift, uploaded_by_username,
            is_pile_shift_report, uploaded_snapshot_id, day3_snapshot_id,
            snapshot_pair_hash, comparable_units, changed_units, changed_percent,
            added_rows, removed_rows, changed_rows, changed_fields, section_breakdown,
            calculated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, NOW())
        ON CONFLICT (daily_report_id_text, metric_kind) DO UPDATE
        SET daily_report_id = EXCLUDED.daily_report_id,
            source_type = EXCLUDED.source_type,
            source_reference = EXCLUDED.source_reference,
            report_date = EXCLUDED.report_date,
            shift = EXCLUDED.shift,
            uploaded_by_username = EXCLUDED.uploaded_by_username,
            is_pile_shift_report = EXCLUDED.is_pile_shift_report,
            uploaded_snapshot_id = EXCLUDED.uploaded_snapshot_id,
            day3_snapshot_id = EXCLUDED.day3_snapshot_id,
            snapshot_pair_hash = EXCLUDED.snapshot_pair_hash,
            comparable_units = EXCLUDED.comparable_units,
            changed_units = EXCLUDED.changed_units,
            changed_percent = EXCLUDED.changed_percent,
            added_rows = EXCLUDED.added_rows,
            removed_rows = EXCLUDED.removed_rows,
            changed_rows = EXCLUDED.changed_rows,
            changed_fields = EXCLUDED.changed_fields,
            section_breakdown = EXCLUDED.section_breakdown,
            calculated_at = NOW()
        WHERE daily_report_quality_metrics.snapshot_pair_hash IS DISTINCT FROM EXCLUDED.snapshot_pair_hash
        RETURNING id::text
        """,
        (
            daily_report_id,
            daily_report_id_text,
            REPORT_QUALITY_METRIC_KIND,
            source_type,
            source_reference,
            report_date,
            shift,
            uploaded_by_username,
            is_pile_shift_report,
            uploaded_snapshot_id,
            day3_snapshot_id,
            snapshot_pair_hash,
            diff["comparable_units"],
            diff["changed_units"],
            diff["changed_percent"],
            diff["added_rows"],
            diff["removed_rows"],
            diff["changed_rows"],
            diff["changed_fields"],
            json.dumps(diff["section_breakdown"], ensure_ascii=False, default=str),
        ),
    )
    cur.fetchone()
    return {
        "daily_report_id_text": daily_report_id_text,
        "snapshot_pair_hash": snapshot_pair_hash,
        **diff,
    }


def _report_quality_capture_day3_snapshot_for_report(
    cur,
    report_id: str,
    *,
    captured_by: Optional[str],
    actor_username: Optional[str] = None,
) -> bool:
    report_row = _report_quality_load_report_row(cur, report_id, for_update=True)
    if not report_row:
        return False
    created_at = report_row.get("created_at")
    if not isinstance(created_at, datetime):
        return False
    now = datetime.now(timezone.utc)
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    due_at = created_at + timedelta(days=REPORT_QUALITY_SNAPSHOT_DAYS)
    if now < due_at:
        _report_quality_capture_uploaded_snapshot(
            cur,
            report_id,
            uploaded_payload=report_row.get("initial_parse_payload") or report_row.get("review_payload"),
            captured_by=captured_by,
            actor_username=actor_username,
        )
        return False
    if not _report_quality_source_allowed(report_row.get("source_type")):
        return False
    _report_quality_capture_uploaded_snapshot(
        cur,
        report_id,
        uploaded_payload=report_row.get("initial_parse_payload") or report_row.get("review_payload"),
        captured_by=captured_by,
        actor_username=actor_username,
    )
    status = "late_backfill" if now - due_at > timedelta(hours=2) else "captured"
    result = _report_quality_upsert_snapshot(
        cur,
        report_row,
        "day3",
        report_row.get("review_payload"),
        snapshot_at=due_at,
        captured_by=captured_by,
        capture_status=status,
        actor_username=actor_username,
    )
    if result:
        _report_quality_calculate_metric_for_report(cur, str(report_row.get("id")))
    return bool(result and result.get("inserted"))


def _report_quality_refresh_due_snapshots(limit: int = REPORT_QUALITY_DUE_LIMIT, *, captured_by: str = "quality_worker") -> dict[str, int]:
    _ensure_report_review_schema()
    checked = 0
    captured = 0
    metrics = 0
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '45s'")
                cur.execute("SELECT pg_try_advisory_xact_lock(hashtext('vsm_report_quality_refresh'))")
                locked = cur.fetchone()
                if not locked or not locked[0]:
                    return {"checked": checked, "captured": captured, "metrics": metrics}
                cur.execute(
                    """
                    SELECT dr.id::text
                    FROM daily_reports dr
                    LEFT JOIN daily_report_quality_snapshots day3
                      ON day3.daily_report_id_text = dr.id::text
                     AND day3.snapshot_kind = 'day3'
                    WHERE day3.id IS NULL
                      AND COALESCE(dr.is_demo, false) IS NOT TRUE
                      AND dr.review_payload IS NOT NULL
                      AND LOWER(COALESCE(dr.source_type, '')) = ANY(%s)
                      AND dr.created_at <= NOW() - (%s || ' days')::interval
                    ORDER BY dr.created_at ASC
                    LIMIT %s
                    """,
                    (list(REPORT_QUALITY_MASTER_SOURCE_TYPES), str(REPORT_QUALITY_SNAPSHOT_DAYS), max(1, min(int(limit or 1), 2000))),
                )
                report_ids = [row[0] for row in cur.fetchall()]
                for report_id in report_ids:
                    checked += 1
                    if _report_quality_capture_day3_snapshot_for_report(cur, report_id, captured_by=captured_by):
                        captured += 1
                    metric = _report_quality_calculate_metric_for_report(cur, report_id)
                    if metric:
                        metrics += 1
        return {"checked": checked, "captured": captured, "metrics": metrics}
    finally:
        conn.close()


def _report_quality_worker_loop() -> None:
    if REPORT_QUALITY_WORKER_INITIAL_DELAY_SECONDS > 0:
        time.sleep(REPORT_QUALITY_WORKER_INITIAL_DELAY_SECONDS)
    while True:
        try:
            _report_quality_refresh_due_snapshots(REPORT_QUALITY_DUE_LIMIT, captured_by="quality_worker")
        except Exception as exc:
            print(f"[report-quality] worker failed: {exc}", flush=True)
        interval = max(300, REPORT_QUALITY_WORKER_INTERVAL_SECONDS)
        time.sleep(interval)


def _start_report_quality_snapshot_worker() -> None:
    global _REPORT_QUALITY_WORKER_STARTED
    if os.getenv("VSM_REPORT_QUALITY_WORKER_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        return
    if _REPORT_QUALITY_WORKER_STARTED:
        return
    with _REPORT_QUALITY_WORKER_LOCK:
        if _REPORT_QUALITY_WORKER_STARTED:
            return
        thread = threading.Thread(target=_report_quality_worker_loop, name="report-quality-worker", daemon=True)
        thread.start()
        _REPORT_QUALITY_WORKER_STARTED = True


def _require_report_quality_access(user: Any) -> None:
    if getattr(user, "role", None) == "admin":
        return
    permissions = set(getattr(user, "permissions", []) or [])
    if permissions & {"reports:review", "reports:edit"}:
        return
    raise HTTPException(403, "Метрика качества отчётов доступна пользователю с правом проверки или редактирования отчётов")


class SectionRatingMstroyBody(BaseModel):
    rating_date: str
    scope: str = "zp"
    section_code: str
    difference_percent: Optional[float] = None
    comment: Optional[str] = None
    delete: bool = False


def _section_rating_normalize_scope(scope: Optional[str]) -> tuple[str, bool]:
    key = str(scope or "zp").strip().lower().replace(" ", "")
    if key in {"zp", "зп", "regular", "shift", "земполотно", "земляноеполотно"}:
        return "zp", False
    if key in {"isso", "иссо", "piles", "pile", "сваи", "свайные"}:
        return "isso", True
    raise HTTPException(400, "scope должен быть zp|isso")


def _section_rating_normalize_period(period: Optional[str]) -> str:
    key = str(period or "day").strip().lower()
    if key in {"day", "daily", "день"}:
        return "day"
    if key in {"week", "weekly", "неделя"}:
        return "week"
    if key in {"custom", "period", "range", "период"}:
        return "custom"
    raise HTTPException(400, "period должен быть day|week|custom")


def _section_rating_parse_iso_date(value: Optional[str], field_name: str) -> Optional[date_cls]:
    if value is None or str(value).strip() == "":
        return None
    try:
        return date_cls.fromisoformat(str(value).strip())
    except ValueError:
        raise HTTPException(400, f"{field_name} должен быть YYYY-MM-DD")


def _section_rating_latest_metric_date(_pile_scope: bool) -> date_cls:
    latest: Optional[date_cls] = None
    try:
        row = query_one(
            """
            SELECT MAX(report_date) AS report_date
            FROM daily_reports
            WHERE COALESCE(is_demo, false) IS NOT TRUE
              AND LOWER(COALESCE(source_type, '')) = ANY(%s)
              AND report_date IS NOT NULL
            """,
            (list(REPORT_QUALITY_MASTER_SOURCE_TYPES),),
        )
        value = (row or {}).get("report_date")
        if isinstance(value, datetime):
            latest = value.date()
        elif isinstance(value, date_cls):
            latest = value
        elif value:
            latest = date_cls.fromisoformat(str(value))
    except Exception:
        pass
    return latest or date_cls.today()


def _section_rating_period_bounds(
    period: Optional[str],
    date_value: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    pile_scope: bool,
) -> tuple[str, date_cls, date_cls, Optional[date_cls]]:
    period_key = _section_rating_normalize_period(period)
    anchor = _section_rating_parse_iso_date(date_value, "date")
    latest = _section_rating_latest_metric_date(pile_scope)
    if period_key == "custom":
        d_from = _section_rating_parse_iso_date(date_from, "date_from")
        d_to = _section_rating_parse_iso_date(date_to, "date_to")
        if d_from is None and d_to is None:
            d_from = latest
            d_to = latest
        elif d_from is None:
            d_from = d_to
        elif d_to is None:
            d_to = d_from
        assert d_from is not None and d_to is not None
        if d_from > d_to:
            d_from, d_to = d_to, d_from
        return period_key, d_from, d_to, anchor
    anchor = anchor or latest
    if period_key == "week":
        return period_key, anchor - timedelta(days=6), anchor, anchor
    return period_key, anchor, anchor, anchor


def _section_rating_normalize_section_code(value: Any) -> Optional[str]:
    text = str(value or "").strip().upper().replace("УЧАСТОК", "").replace("УЧ.", "").replace("УЧ", "")
    text = text.replace("№", "").replace("-", "_").replace(" ", "_")
    if text in SECTION_RATING_SECTION_CODES:
        return text
    match = re.search(r"(\d+)", text)
    if not match:
        return None
    code = f"UCH_{int(match.group(1))}"
    return code if code in SECTION_RATING_SECTION_CODES else None


def _section_rating_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        value = float(value)
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _section_rating_clamp_score(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 2)


def _section_rating_upload_score(snapshot_at: Any) -> Optional[float]:
    if snapshot_at is None:
        return None
    value = snapshot_at
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    msk_value = value.astimezone(SECTION_RATING_MSK_TZ)
    minute = msk_value.hour * 60 + msk_value.minute + msk_value.second / 60.0 + msk_value.microsecond / 60_000_000.0
    if minute <= SECTION_RATING_UPLOAD_START_MINUTE:
        return 100.0
    if minute >= SECTION_RATING_UPLOAD_DEADLINE_MINUTE:
        return 0.0
    window = SECTION_RATING_UPLOAD_DEADLINE_MINUTE - SECTION_RATING_UPLOAD_START_MINUTE
    return _section_rating_clamp_score((SECTION_RATING_UPLOAD_DEADLINE_MINUTE - minute) / window * 100.0)


def _section_rating_mstroy_score(difference_percent: Any) -> Optional[float]:
    value = _section_rating_float(difference_percent)
    if value is None:
        return None
    return _section_rating_clamp_score(100.0 - value)


def _section_rating_average(values: list[float]) -> Optional[float]:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return None
    return round(sum(clean) / len(clean), 2)


def _section_rating_sections(cur) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT code, name, sort_order
        FROM construction_sections
        WHERE COALESCE(is_active, true) IS NOT FALSE
        ORDER BY sort_order NULLS LAST, code
        """
    )
    by_code: dict[str, dict[str, Any]] = {}
    for code_raw, name, sort_order in cur.fetchall():
        code = _section_rating_normalize_section_code(code_raw)
        if code not in SECTION_RATING_SECTION_CODES or code in by_code:
            continue
        number = int(code.replace("UCH_", ""))
        by_code[code] = {
            "section_code": code,
            "section_number": number,
            "section_name": name or f"Участок {number}",
            "sort_order": sort_order if sort_order is not None else number,
        }
    for number in range(1, 9):
        code = f"UCH_{number}"
        by_code.setdefault(
            code,
            {
                "section_code": code,
                "section_number": number,
                "section_name": f"Участок {number}",
                "sort_order": number,
            },
        )
    return [by_code[f"UCH_{number}"] for number in range(1, 9)]


def _section_rating_empty_accumulator() -> dict[str, Any]:
    return {
        "report_ids": set(),
        "edit_reports": 0,
        "changed_units": 0,
        "comparable_units": 0,
        "changed_percent_values": [],
        "upload_score_values": [],
        "upload_reports": 0,
        "late_upload_reports": 0,
        "mstroy_difference_values": [],
        "mstroy_score_values": [],
        "mstroy_entries": 0,
        "mstroy_comment": None,
        "mstroy_updated_at": None,
        "mstroy_updated_by": None,
    }


def _section_rating_upload_late(snapshot_at: Any) -> bool:
    if snapshot_at is None:
        return False
    value = snapshot_at
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    if not isinstance(value, datetime):
        return False
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    msk_value = value.astimezone(SECTION_RATING_MSK_TZ)
    minute = msk_value.hour * 60 + msk_value.minute + msk_value.second / 60.0 + msk_value.microsecond / 60_000_000.0
    return minute >= SECTION_RATING_UPLOAD_DEADLINE_MINUTE


def _section_rating_response_row(section: dict[str, Any], acc: dict[str, Any]) -> dict[str, Any]:
    reports = len(acc.get("report_ids") or set())
    comparable_units = int(acc["comparable_units"] or 0)
    changed_units = int(acc["changed_units"] or 0)
    if comparable_units > 0:
        changed_percent = round(changed_units / comparable_units * 100.0, 2)
    else:
        changed_percent = _section_rating_average(acc["changed_percent_values"])
    edit_score = _section_rating_clamp_score(100.0 - changed_percent) if changed_percent is not None else None
    upload_score = _section_rating_average(acc["upload_score_values"])
    mstroy_difference = _section_rating_average(acc["mstroy_difference_values"])
    mstroy_score = _section_rating_average(acc["mstroy_score_values"])
    score_values = [
        value
        for value in (edit_score, upload_score, mstroy_score)
        if value is not None
    ]
    total_score = _section_rating_average(score_values)
    return {
        **section,
        "rank": None,
        "total_score": total_score,
        "metrics_available": len(score_values),
        "reports": reports,
        "edit_reports": int(acc["edit_reports"] or 0),
        "changed_units": changed_units,
        "comparable_units": comparable_units,
        "changed_percent": changed_percent,
        "edit_score": edit_score,
        "upload_score": upload_score,
        "upload_reports": int(acc["upload_reports"] or 0),
        "late_upload_reports": int(acc["late_upload_reports"] or 0),
        "mstroy_difference_percent": mstroy_difference,
        "mstroy_score": mstroy_score,
        "mstroy_entries": int(acc["mstroy_entries"] or 0),
        "mstroy_comment": acc.get("mstroy_comment"),
        "mstroy_updated_at": acc.get("mstroy_updated_at"),
        "mstroy_updated_by": acc.get("mstroy_updated_by"),
    }


def _section_rating_mstroy_row_payload(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": row[0],
        "rating_date": _iso_date(row[1]),
        "scope": row[2],
        "section_code": row[3],
        "difference_percent": _section_rating_float(row[4]),
        "score": _section_rating_float(row[5]),
        "comment": row[6],
        "created_by": row[7],
        "created_at": row[8].isoformat() if row[8] else None,
        "updated_by": row[9],
        "updated_at": row[10].isoformat() if row[10] else None,
    }


def _section_rating_as_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _section_rating_iso_datetime(value: Any) -> Optional[str]:
    parsed = _section_rating_as_datetime(value)
    return parsed.isoformat() if parsed else None


def _section_rating_iso_datetime_msk(value: Any) -> Optional[str]:
    parsed = _section_rating_as_datetime(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(SECTION_RATING_MSK_TZ).isoformat()


def _section_rating_empty_report_detail(report_id: str) -> dict[str, Any]:
    return {
        "report_id": report_id,
        "report_date": None,
        "shift": None,
        "section_code": None,
        "source_type": None,
        "source_reference": None,
        "uploaded_by_username": None,
        "user_flags": [],
        "uploaded_at": None,
        "upload_score": None,
        "is_late_upload": False,
        "edit_metric_available": False,
        "changed_percent": None,
        "changed_units": 0,
        "comparable_units": 0,
        "added_rows": 0,
        "removed_rows": 0,
        "changed_rows": 0,
        "changed_fields": 0,
        "day3_snapshot_at": None,
        "calculated_at": None,
    }


def _section_rating_upsert_report_detail(report_map: dict[str, dict[str, Any]], report_id: Any) -> Optional[dict[str, Any]]:
    key = str(report_id or "").strip()
    if not key:
        return None
    if key not in report_map:
        report_map[key] = _section_rating_empty_report_detail(key)
    return report_map[key]


def _section_rating_apply_report_identity(
    detail: dict[str, Any],
    *,
    report_date: Any = None,
    shift: Any = None,
    section_code: Any = None,
    source_type: Any = None,
    source_reference: Any = None,
    uploaded_by_username: Any = None,
) -> None:
    normalized_section = _section_rating_normalize_section_code(section_code)
    if normalized_section:
        detail["section_code"] = normalized_section
    for key, value in (
        ("report_date", report_date),
        ("shift", shift),
        ("source_type", source_type),
        ("source_reference", source_reference),
        ("uploaded_by_username", uploaded_by_username),
    ):
        if value is not None and value != "" and not detail.get(key):
            detail[key] = value


def _section_rating_apply_upload(detail: dict[str, Any], uploaded_at: Any) -> None:
    if uploaded_at is None:
        return
    detail["uploaded_at"] = detail.get("uploaded_at") or uploaded_at
    if detail.get("upload_score") is None:
        detail["upload_score"] = _section_rating_upload_score(uploaded_at)
    detail["is_late_upload"] = bool(detail.get("is_late_upload") or _section_rating_upload_late(uploaded_at))


def _section_rating_apply_user_flags(detail: dict[str, Any], raw_flags: Any) -> None:
    flags = _normalize_report_user_flags(raw_flags)
    if flags:
        detail["user_flags"] = flags


def _section_rating_report_detail_payload(detail: dict[str, Any]) -> dict[str, Any]:
    return {
        "report_id": detail.get("report_id"),
        "report_date": _iso_date(detail.get("report_date")),
        "shift": detail.get("shift"),
        "section_code": detail.get("section_code"),
        "source_type": detail.get("source_type"),
        "source_reference": detail.get("source_reference"),
        "uploaded_by_username": detail.get("uploaded_by_username"),
        "user_flags": detail.get("user_flags") or [],
        "uploaded_at": _section_rating_iso_datetime(detail.get("uploaded_at")),
        "uploaded_at_msk": _section_rating_iso_datetime_msk(detail.get("uploaded_at")),
        "upload_score": detail.get("upload_score"),
        "is_late_upload": bool(detail.get("is_late_upload")),
        "edit_metric_available": bool(detail.get("edit_metric_available")),
        "changed_percent": detail.get("changed_percent"),
        "changed_units": int(detail.get("changed_units") or 0),
        "comparable_units": int(detail.get("comparable_units") or 0),
        "added_rows": int(detail.get("added_rows") or 0),
        "removed_rows": int(detail.get("removed_rows") or 0),
        "changed_rows": int(detail.get("changed_rows") or 0),
        "changed_fields": int(detail.get("changed_fields") or 0),
        "day3_snapshot_at": _section_rating_iso_datetime(detail.get("day3_snapshot_at")),
        "day3_snapshot_at_msk": _section_rating_iso_datetime_msk(detail.get("day3_snapshot_at")),
        "calculated_at": _section_rating_iso_datetime(detail.get("calculated_at")),
    }


def _section_rating_report_details_by_section(cur, pile_scope: bool, d_from: date_cls, d_to: date_cls) -> dict[str, list[dict[str, Any]]]:
    report_map: dict[str, dict[str, Any]] = {}
    cur.execute(
        """
        SELECT
          up.daily_report_id_text,
          up.report_date,
          up.snapshot_at,
          up.shift,
          up.source_type,
          up.source_reference,
          up.uploaded_by_username,
          dr.user_flags,
          COALESCE(
            cs.code,
            up.snapshot_payload #>> '{header,section_code}',
            up.snapshot_payload #>> '{meta,section_code}'
          ) AS section_code
        FROM daily_report_quality_snapshots up
        JOIN daily_reports dr ON dr.id = up.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE up.snapshot_kind = 'uploaded'
          AND COALESCE(dr.is_demo, false) IS NOT TRUE
          AND up.is_pile_shift_report = %s
          AND up.report_date >= %s
          AND up.report_date <= %s
          AND LOWER(COALESCE(up.source_type, '')) = ANY(%s)
        ORDER BY up.report_date, up.daily_report_id_text
        """,
        (pile_scope, d_from, d_to, list(REPORT_QUALITY_MASTER_SOURCE_TYPES)),
    )
    for row in cur.fetchall():
        detail = _section_rating_upsert_report_detail(report_map, row[0])
        if detail is None:
            continue
        _section_rating_apply_report_identity(
            detail,
            report_date=row[1],
            shift=row[3],
            source_type=row[4],
            source_reference=row[5],
            uploaded_by_username=row[6],
            section_code=row[8],
        )
        _section_rating_apply_user_flags(detail, row[7])
        _section_rating_apply_upload(detail, row[2])

    cur.execute(
        """
        SELECT
          dr.id::text,
          dr.report_date,
          dr.shift,
          dr.created_at,
          dr.review_payload,
          dr.initial_parse_payload,
          dr.uploaded_by_username,
          dr.source_type,
          dr.source_reference,
          dr.user_flags,
          COALESCE(
            cs.code,
            dr.review_payload #>> '{header,section_code}',
            dr.review_payload #>> '{meta,section_code}',
            dr.initial_parse_payload #>> '{header,section_code}',
            dr.initial_parse_payload #>> '{meta,section_code}'
          ) AS section_code
        FROM daily_reports dr
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        LEFT JOIN daily_report_quality_snapshots up
          ON up.daily_report_id_text = dr.id::text
         AND up.snapshot_kind = 'uploaded'
        WHERE up.id IS NULL
          AND COALESCE(dr.is_demo, false) IS NOT TRUE
          AND LOWER(COALESCE(dr.source_type, '')) = ANY(%s)
          AND dr.report_date >= %s
          AND dr.report_date <= %s
        ORDER BY dr.report_date, dr.id
        """,
        (list(REPORT_QUALITY_MASTER_SOURCE_TYPES), d_from, d_to),
    )
    for row in cur.fetchall():
        review_payload = row[4] or row[5]
        if _report_quality_is_pile_shift_report(review_payload, row[6]) is not pile_scope:
            continue
        detail = _section_rating_upsert_report_detail(report_map, row[0])
        if detail is None:
            continue
        _section_rating_apply_report_identity(
            detail,
            report_date=row[1],
            shift=row[2],
            source_type=row[7],
            source_reference=row[8],
            uploaded_by_username=row[6],
            section_code=row[10],
        )
        _section_rating_apply_user_flags(detail, row[9])
        _section_rating_apply_upload(detail, row[3])

    cur.execute(
        """
        SELECT
          m.daily_report_id_text,
          m.report_date,
          m.comparable_units,
          m.changed_units,
          m.changed_percent::float,
          up.snapshot_at,
          m.shift,
          COALESCE(m.source_type, up.source_type, d3.source_type) AS source_type,
          COALESCE(m.source_reference, up.source_reference, d3.source_reference) AS source_reference,
          COALESCE(m.uploaded_by_username, up.uploaded_by_username, d3.uploaded_by_username) AS uploaded_by_username,
          m.added_rows,
          m.removed_rows,
          m.changed_rows,
          m.changed_fields,
          d3.snapshot_at AS day3_snapshot_at,
          m.calculated_at,
          dr.user_flags,
          COALESCE(
            cs.code,
            up.snapshot_payload #>> '{header,section_code}',
            up.snapshot_payload #>> '{meta,section_code}',
            d3.snapshot_payload #>> '{header,section_code}',
            d3.snapshot_payload #>> '{meta,section_code}'
          ) AS section_code
        FROM daily_report_quality_metrics m
        JOIN daily_reports dr ON dr.id = m.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        LEFT JOIN daily_report_quality_snapshots up ON up.id = m.uploaded_snapshot_id
        LEFT JOIN daily_report_quality_snapshots d3 ON d3.id = m.day3_snapshot_id
        WHERE m.metric_kind = %s
          AND COALESCE(dr.is_demo, false) IS NOT TRUE
          AND m.is_pile_shift_report = %s
          AND m.report_date >= %s
          AND m.report_date <= %s
        ORDER BY m.report_date, m.daily_report_id_text
        """,
        (REPORT_QUALITY_METRIC_KIND, pile_scope, d_from, d_to),
    )
    for row in cur.fetchall():
        detail = _section_rating_upsert_report_detail(report_map, row[0])
        if detail is None:
            continue
        _section_rating_apply_report_identity(
            detail,
            report_date=row[1],
            shift=row[6],
            source_type=row[7],
            source_reference=row[8],
            uploaded_by_username=row[9],
            section_code=row[17],
        )
        _section_rating_apply_user_flags(detail, row[16])
        _section_rating_apply_upload(detail, row[5])
        detail["edit_metric_available"] = True
        detail["comparable_units"] = int(row[2] or 0)
        detail["changed_units"] = int(row[3] or 0)
        detail["changed_percent"] = _section_rating_float(row[4])
        detail["added_rows"] = int(row[10] or 0)
        detail["removed_rows"] = int(row[11] or 0)
        detail["changed_rows"] = int(row[12] or 0)
        detail["changed_fields"] = int(row[13] or 0)
        detail["day3_snapshot_at"] = row[14]
        detail["calculated_at"] = row[15]

    grouped: dict[str, list[dict[str, Any]]] = {code: [] for code in SECTION_RATING_SECTION_CODES}
    for detail in report_map.values():
        section_code = _section_rating_normalize_section_code(detail.get("section_code"))
        if section_code in grouped:
            detail["section_code"] = section_code
            grouped[section_code].append(detail)

    def sort_key(detail: dict[str, Any]) -> tuple[str, str, str]:
        return (
            _iso_date(detail.get("report_date")) or "",
            _section_rating_iso_datetime(detail.get("uploaded_at")) or "",
            str(detail.get("source_reference") or detail.get("report_id") or ""),
        )

    for rows in grouped.values():
        rows.sort(key=sort_key)
    return grouped


def _section_rating_report_details_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    comparable_units = sum(int(row.get("comparable_units") or 0) for row in rows if row.get("edit_metric_available"))
    changed_units = sum(int(row.get("changed_units") or 0) for row in rows if row.get("edit_metric_available"))
    if comparable_units > 0:
        changed_percent = round(changed_units / comparable_units * 100.0, 2)
    else:
        changed_percent = _section_rating_average([
            float(row["changed_percent"])
            for row in rows
            if row.get("edit_metric_available") and _section_rating_float(row.get("changed_percent")) is not None
        ])
    return {
        "reports": len(rows),
        "edit_reports": sum(1 for row in rows if row.get("edit_metric_available")),
        "changed_units": changed_units,
        "comparable_units": comparable_units,
        "changed_percent": changed_percent,
        "upload_score": _section_rating_average([
            float(row["upload_score"])
            for row in rows
            if _section_rating_float(row.get("upload_score")) is not None
        ]),
        "late_upload_reports": sum(1 for row in rows if row.get("is_late_upload")),
    }


def _section_rating_calculate(cur, scope_key: str, pile_scope: bool, d_from: date_cls, d_to: date_cls) -> dict[str, Any]:
    sections = _section_rating_sections(cur)
    acc_by_section = {section["section_code"]: _section_rating_empty_accumulator() for section in sections}
    report_details = _section_rating_report_details_by_section(cur, pile_scope, d_from, d_to)
    for section_code, rows in report_details.items():
        if section_code not in acc_by_section:
            continue
        acc = acc_by_section[section_code]
        for detail in rows:
            report_id = str(detail.get("report_id") or "")
            if report_id:
                acc["report_ids"].add(report_id)
            upload_score = _section_rating_float(detail.get("upload_score"))
            if upload_score is not None:
                acc["upload_reports"] += 1
                acc["upload_score_values"].append(upload_score)
                if detail.get("is_late_upload"):
                    acc["late_upload_reports"] += 1
            if detail.get("edit_metric_available"):
                acc["edit_reports"] += 1
                acc["comparable_units"] += int(detail.get("comparable_units") or 0)
                acc["changed_units"] += int(detail.get("changed_units") or 0)
                changed_percent = _section_rating_float(detail.get("changed_percent"))
                if changed_percent is not None:
                    acc["changed_percent_values"].append(changed_percent)

    cur.execute(
        """
        SELECT
          id::text,
          rating_date,
          scope,
          section_code,
          difference_percent::float,
          score::float,
          comment,
          created_by,
          created_at,
          updated_by,
          updated_at
        FROM daily_section_rating_mstroy_convergence
        WHERE scope = %s
          AND rating_date >= %s
          AND rating_date <= %s
        ORDER BY rating_date, section_code
        """,
        (scope_key, d_from, d_to),
    )
    mstroy_rows = [_section_rating_mstroy_row_payload(row) for row in cur.fetchall()]
    for row in mstroy_rows:
        section_code = _section_rating_normalize_section_code(row.get("section_code"))
        if section_code not in acc_by_section:
            continue
        acc = acc_by_section[section_code]
        difference_percent = _section_rating_float(row.get("difference_percent"))
        score = _section_rating_float(row.get("score"))
        if difference_percent is not None:
            acc["mstroy_difference_values"].append(difference_percent)
        if score is not None:
            acc["mstroy_score_values"].append(score)
        acc["mstroy_entries"] += 1
        acc["mstroy_comment"] = row.get("comment")
        acc["mstroy_updated_at"] = row.get("updated_at")
        acc["mstroy_updated_by"] = row.get("updated_by")

    rows = [_section_rating_response_row(section, acc_by_section[section["section_code"]]) for section in sections]
    rankable = [row for row in rows if row.get("total_score") is not None]
    rankable.sort(key=lambda item: (-(item.get("total_score") or -1), item.get("section_number") or 999))
    last_score: Optional[float] = None
    last_rank = 0
    for index, row in enumerate(rankable, start=1):
        score = row.get("total_score")
        if last_score is None or score != last_score:
            last_rank = index
            last_score = score
        row["rank"] = last_rank
    missing = [row for row in rows if row.get("total_score") is None]
    missing.sort(key=lambda item: item.get("section_number") or 999)
    return {
        "sections": sections,
        "leaderboard": rankable + missing,
        "winner": rankable[0] if rankable else None,
        "mstroy_rows": mstroy_rows,
    }


def _find_source_line(raw_text: str, needles: list[Any]) -> Optional[dict[str, Any]]:
    needle_texts = [str(value).strip().lower() for value in needles if str(value or "").strip()]
    if not needle_texts:
        return None
    lines = (raw_text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines()
    for idx, line in enumerate(lines, start=1):
        low = line.lower()
        if any(needle and needle in low for needle in needle_texts):
            return {"line": idx, "text": line.strip()}
    return None


def _attach_parser_source_metadata(parsed: dict[str, Any], raw_text: str) -> None:
    for unit in parsed.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        unit["_source"] = _find_source_line(raw_text, [
            unit.get("plate_number"),
            unit.get("unit_number"),
            unit.get("reported_number"),
            f"{unit.get('equipment_count')} а/с" if unit.get("equipment_count") else None,
        ])
        for trip in unit.get("trips") or []:
            if isinstance(trip, dict):
                trip["_source"] = _find_source_line(raw_text, [trip.get("from"), trip.get("to"), trip.get("volume")])
    for section in ("main_works", "aux_works"):
        for row in parsed.get(section) or []:
            if not isinstance(row, dict):
                continue
            row["_source"] = _find_source_line(raw_text, [row.get("work_name"), row.get("constructive"), row.get("pk_rail_raw")])
            for eq in row.get("equipment") or []:
                if isinstance(eq, dict):
                    eq["_source"] = _find_source_line(raw_text, [eq.get("plate_number"), eq.get("unit_number"), eq.get("reported_number")])
    for row in parsed.get("park") or []:
        if isinstance(row, dict):
            row["_source"] = _find_source_line(raw_text, [row.get("plate_number"), row.get("unit_number"), row.get("reported_number")])
    for row in parsed.get("stockpiles") or []:
        if isinstance(row, dict):
            row["_source"] = _find_source_line(raw_text, [row.get("name"), row.get("pk_raw_text")])


def _normalize_work_analytics_tag(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)
    return text[:120]


def _extract_work_analytics_tag(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, list):
        source = "; ".join(str(item) for item in value if item not in (None, ""))
    else:
        source = str(value)
    match = WORK_ANALYTICS_TAG_PATTERN.search(source)
    if not match:
        return None
    return _normalize_work_analytics_tag(match.group(1))


def _infer_work_analytics_tag(work_type_code: Optional[str], work_name: Any = None, comment: Any = None) -> Optional[str]:
    code = (work_type_code or "").strip()
    if code in PILE_WORK_TYPE_CODES:
        return None
    if code:
        try:
            rows = query(
                """
                SELECT analytics_tag
                FROM work_types
                WHERE code = %s
                  AND is_active = true
                LIMIT 1
                """,
                (code,),
            )
            if rows:
                tag = _normalize_work_analytics_tag(rows[0].get("analytics_tag"))
                if tag:
                    return tag
        except Exception:
            pass
    if code in WORK_ANALYTICS_TAG_BY_CODE:
        return WORK_ANALYTICS_TAG_BY_CODE[code]
    return None


def _work_analytics_tag_from_row(row: dict[str, Any]) -> Optional[str]:
    explicit = _normalize_work_analytics_tag(
        row.get("analytics_tag") or row.get("work_tag") or row.get("tag")
    )
    if explicit:
        return explicit
    comment = row.get("comment")
    return _infer_work_analytics_tag(row.get("work_type_code"), row.get("work_name"), comment)


def _upsert_work_analytics_tag(cur, tag: Optional[str]) -> None:
    if not tag:
        return
    cur.execute(
        """
        INSERT INTO work_analytics_tags (name)
        VALUES (%s)
        ON CONFLICT (name) DO UPDATE SET is_active = true
        """,
        (tag,),
    )


class ReferenceCreateBody(BaseModel):
    kind: str
    code: Optional[str] = None
    name: str
    alias_text: Optional[str] = None
    default_unit: Optional[str] = None
    analytics_tag: Optional[str] = None
    productivity_enabled: bool = True
    object_type_code: Optional[str] = None
    constructive_code: Optional[str] = None
    pk_start: Optional[Any] = None
    pk_end: Optional[Any] = None
    pk_raw_text: Optional[str] = None
    comment: Optional[str] = None
    section_code: Optional[str] = None
    force_create: bool = False


class ObjectTypeCreateBody(BaseModel):
    code: Optional[str] = None
    name: str
    map_enabled: bool = True
    work_accounting_enabled: bool = True
    material_accounting_enabled: bool = False
    is_linear: bool = False
    accounting_note: Optional[str] = None


class ReportUserFlagsBody(BaseModel):
    flags: list[dict[str, Any]] = Field(default_factory=list)


def _normalize_report_user_flags(raw_flags: Any, username: Optional[str] = None) -> list[dict[str, str]]:
    if isinstance(raw_flags, str):
        try:
            raw_flags = json.loads(raw_flags)
        except json.JSONDecodeError:
            raw_flags = []
    if not isinstance(raw_flags, list):
        return []

    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    updated_at = datetime.now(timezone.utc).isoformat()
    editor = (username or "").strip()

    for item in raw_flags[:8]:
        if isinstance(item, str):
            item = {"key": "custom", "label": item}
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "custom").strip().lower()[:32] or "custom"
        preset = REPORT_USER_FLAG_PRESETS.get(key)
        label = str(item.get("label") or (preset or {}).get("label") or "").strip()[:48]
        if not label:
            continue
        color = str(item.get("color") or (preset or {}).get("color") or "#64748b").strip()
        if not REPORT_USER_FLAG_COLOR_RE.match(color):
            color = "#64748b"
        dedupe_key = (key, label.lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        flag = {
            "key": key,
            "label": label,
            "color": color.lower(),
            "updated_at": str(item.get("updated_at") or updated_at)[:64],
        }
        updated_by = editor or str(item.get("updated_by") or "").strip()[:64]
        if updated_by:
            flag["updated_by"] = updated_by
        normalized.append(flag)
    return normalized


def load_aliases(force: bool = False) -> dict[str, dict[str, str]]:
    """Возвращает только однозначные нормализованные алиасы по каждому kind.

    Кэширует результат на _ALIAS_TTL_SEC секунд. При ошибке БД возвращает
    последний известный кэш (или пустой словарь на первом запуске).
    """
    now = time.time()
    if not force and (now - float(_ALIAS_CACHE["ts"])) < _ALIAS_TTL_SEC and _ALIAS_CACHE["by_kind"]:
        return _ALIAS_CACHE["by_kind"]  # type: ignore[return-value]
    try:
        rows = query("SELECT canonical_code, alias_text, kind FROM work_type_aliases")
    except Exception:
        return _ALIAS_CACHE["by_kind"]  # type: ignore[return-value]
    grouped: dict[str, dict[str, set[str]]] = {}
    for r in rows:
        kind = (r.get("kind") or "").strip()
        alias = _normalize_ref(r.get("alias_text"))
        canonical = (r.get("canonical_code") or "").strip()
        if not kind or not alias or not canonical:
            continue
        grouped.setdefault(kind, {}).setdefault(alias, set()).add(canonical)
    by_kind = {
        kind: {
            alias: next(iter(codes))
            for alias, codes in aliases.items()
            if len(codes) == 1
        }
        for kind, aliases in grouped.items()
    }
    _ALIAS_CACHE["by_kind"] = by_kind
    _ALIAS_CACHE["ts"] = now
    return by_kind


def _resolve(by_kind: dict[str, dict[str, str]], kind: str, text: Optional[str]) -> Optional[str]:
    """Ищет canonical_code для text в алиасах данного kind. None если нет."""
    if not text:
        return None
    key = _normalize_ref(text)
    if not key:
        return None
    aliases = by_kind.get("object" if kind == "object" else kind, {})
    return aliases.get(key)


def _normalize_ref(value: Any) -> str:
    value = str(value or "").lower().replace("ё", "е")
    value = value.replace("№", " ")
    value = re.sub(r"\bпк\s*(\d+)", r"пк \1", value)
    value = re.sub(r"[^0-9a-zа-я]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _compact_ref(value: Any) -> str:
    return _normalize_ref(value).replace(" ", "")


QUARRY_CANONICAL_REF_KEYS = {
    "маяки": "южные маяки",
    "пиррусс": "пирус",
    "пирусс": "пирус",
    "боровенка 3": "боровенка",
}


def _quarry_ref_key(value: Any) -> str:
    text = _normalize_ref(value)
    text = re.sub(r"^карьер\s+", "", text, flags=re.I).strip()
    return QUARRY_CANONICAL_REF_KEYS.get(text, text)


def _ref_tokens(value: Any) -> set[str]:
    return {token for token in _normalize_ref(value).split() if len(token) > 1}


def _safe_ref_code(value: Any, fallback_prefix: str, *, max_len: int = 100) -> str:
    raw = str(value or "").strip().upper()
    raw = raw.replace("Ё", "Е")
    raw = re.sub(r"[^0-9A-Z_]+", "_", raw)
    raw = re.sub(r"_+", "_", raw).strip("_")
    if not raw:
        raw = f"{fallback_prefix}_{uuid.uuid4().hex[:8]}".upper()
    return raw[:max_len]


_STRICT_PK_TOKEN_RE = re.compile(
    r"(?:(?P<prefix>п\s*\.?\s*к\s*\.?)\s*)?"
    r"(?P<picket>\d{1,7})"
    r"(?:\s*(?:\+|[,.])\s*(?P<plus>\d{1,3}(?:[,.]\d+)?))?",
    re.I,
)


def _strict_pk_value_from_parts(picket_text: str, plus_text: Optional[str] = None) -> Optional[float]:
    digits = re.sub(r"\D+", "", picket_text or "")
    if not digits:
        return None
    try:
        if plus_text is None and len(digits) >= 6:
            picket = int(digits[:-2])
            plus = float(digits[-2:])
        else:
            picket = int(digits)
            plus = float((plus_text or "0").replace(",", "."))
    except ValueError:
        return None
    if plus < 0 or plus >= 100:
        return None
    return picket * 100 + plus


def _strict_pk_values(value: Any) -> list[float]:
    if value is None:
        return []
    if isinstance(value, (int, float)):
        raw = float(value)
        return [raw * 100 if abs(raw) < 10000 else raw] if math.isfinite(raw) else []
    text = str(value or "").strip().lower().replace("ё", "е")
    if not text:
        return []
    text = text.replace("\u00a0", " ")
    text = text.replace("–", "-").replace("—", "-").replace("−", "-")
    compact = re.sub(r"\s+", "", text)
    if re.fullmatch(r"\d+(?:[,.]\d+)", compact):
        try:
            raw = float(compact.replace(",", "."))
        except ValueError:
            raw = math.nan
        if math.isfinite(raw) and abs(raw) >= 10000:
            return [raw]
    if re.fullmatch(r"\d{4,7}", compact):
        parsed = _strict_pk_value_from_parts(compact)
        return [parsed] if parsed is not None else []
    bare_range = bool(re.fullmatch(r"\d{4,7}(?:-\d{4,7})+", compact))
    values: list[float] = []
    previous_end: Optional[int] = None
    for m in _STRICT_PK_TOKEN_RE.finditer(text):
        token = m.group(0) or ""
        picket_text = m.group("picket") or ""
        plus_text = m.group("plus")
        has_prefix = bool(m.group("prefix")) or bool(re.search(r"п\s*\.?\s*к", token, re.I))
        has_plus = plus_text is not None or "+" in token
        has_dash_before = previous_end is not None and "-" in text[previous_end:m.start()]
        if not has_prefix and not has_plus and not bare_range and not (has_dash_before and len(picket_text) >= 4):
            previous_end = m.end()
            continue
        parsed = _strict_pk_value_from_parts(picket_text, plus_text)
        if parsed is None:
            previous_end = m.end()
            continue
        values.append(parsed)
        previous_end = m.end()
    return values


def _parse_pk_input(value: Any) -> Optional[float]:
    values = _strict_pk_values(value)
    return values[0] if values else None


def _normalize_pk_pair(start: Optional[float], end: Optional[float]) -> tuple[Optional[float], Optional[float]]:
    if start is not None and end is None:
        end = start
    if start is not None and end is not None and end < start:
        return end, start
    return start, end


_TEMP_ROAD_CODE_RE = re.compile(r"(?:^|[^А-ЯA-Z0-9])АД\s*[-№]?\s*(\d+(?:[.,.]\d+)*)", re.I)


def _compact_temp_road_code(value: Any) -> str:
    text = str(value or "").upper().replace("Ё", "Е").replace(",", ".")
    text = re.sub(r"\s+", "", text)
    text = text.replace("-", "").replace("№", "")
    return text


def _temp_road_code_from_text(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    match = _TEMP_ROAD_CODE_RE.search(f" {text}")
    if match:
        return _compact_temp_road_code(f"АД{match.group(1)}")
    compact = _compact_temp_road_code(text)
    return compact if compact.startswith("АД") and any(ch.isdigit() for ch in compact) else None


def _work_row_has_manual_rail_pk(row: dict[str, Any]) -> bool:
    has_rail_pk = any(_parse_pk_input(row.get(key)) is not None for key in ("pk_rail_start", "pk_start", "pk_rail_raw"))
    if not has_rail_pk:
        return False
    return str(row.get("pk_rail_source") or "").strip() != "auto_from_ad"


def _work_row_ad_pk(row: dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    raw_values = _strict_pk_values(row.get("pk_ad_raw"))
    if raw_values:
        start = raw_values[0]
        end = raw_values[1] if len(raw_values) > 1 else start
        return _normalize_pk_pair(start, end)
    start = _parse_pk_input(row.get("pk_ad_start"))
    end = _parse_pk_input(row.get("pk_ad_end")) if row.get("pk_ad_end") not in (None, "") else None
    return _normalize_pk_pair(start, end)


def _work_row_temp_road_candidates(row: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in ("road_code", "road", "temporary_road_code", "object_code", "constructive_code", "constructive", "object_name"):
        code = _temp_road_code_from_text(row.get(key))
        if code and code not in candidates:
            candidates.append(code)
    return candidates


def _load_temp_road_pk_mappings() -> dict[str, list[dict[str, Any]]]:
    try:
        rows = query(
            """
            SELECT tr.road_code,
                   COALESCE(m.mapping_type, 'road_axis') AS mapping_type,
                   COALESCE(m.ad_pk_start, tr.ad_start_pk)::numeric AS ad_pk_start,
                   COALESCE(m.ad_pk_end, tr.ad_end_pk)::numeric AS ad_pk_end,
                   COALESCE(m.rail_pk_start, tr.rail_start_pk)::numeric AS rail_pk_start,
                   COALESCE(m.rail_pk_end, tr.rail_end_pk)::numeric AS rail_pk_end
            FROM temporary_roads tr
            LEFT JOIN temporary_road_pk_mappings m ON m.road_id = tr.id
            WHERE COALESCE(m.ad_pk_start, tr.ad_start_pk) IS NOT NULL
              AND COALESCE(m.ad_pk_end, tr.ad_end_pk) IS NOT NULL
              AND COALESCE(m.rail_pk_start, tr.rail_start_pk) IS NOT NULL
              AND COALESCE(m.rail_pk_end, tr.rail_end_pk) IS NOT NULL
            UNION ALL
            SELECT tr.road_code,
                   'road_axis' AS mapping_type,
                   tr.ad_start_pk::numeric AS ad_pk_start,
                   tr.ad_end_pk::numeric AS ad_pk_end,
                   tr.rail_start_pk::numeric AS rail_pk_start,
                   tr.rail_end_pk::numeric AS rail_pk_end
            FROM temporary_roads tr
            WHERE tr.ad_start_pk IS NOT NULL
              AND tr.ad_end_pk IS NOT NULL
              AND tr.rail_start_pk IS NOT NULL
              AND tr.rail_end_pk IS NOT NULL
            """
        )
    except Exception:
        return {}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        code = _compact_temp_road_code(row.get("road_code"))
        if not code:
            continue
        try:
            mapping = {
                "mapping_type": row.get("mapping_type") or "road_axis",
                "ad_pk_start": float(row.get("ad_pk_start")),
                "ad_pk_end": float(row.get("ad_pk_end")),
                "rail_pk_start": float(row.get("rail_pk_start")),
                "rail_pk_end": float(row.get("rail_pk_end")),
            }
        except (TypeError, ValueError):
            continue
        if abs(mapping["ad_pk_end"] - mapping["ad_pk_start"]) < 1e-4:
            continue
        grouped.setdefault(code, []).append(mapping)
    return grouped


def _ad_range_contained_by_mapping(ad_start: float, ad_end: float, mapping: dict[str, Any]) -> bool:
    low = min(ad_start, ad_end)
    high = max(ad_start, ad_end)
    m_low = min(mapping["ad_pk_start"], mapping["ad_pk_end"])
    m_high = max(mapping["ad_pk_start"], mapping["ad_pk_end"])
    return m_low - 0.01 <= low and high <= m_high + 0.01


def _shift_local_ad_range_if_needed(ad_start: float, ad_end: float, mapping: dict[str, Any]) -> tuple[float, float, bool]:
    if _ad_range_contained_by_mapping(ad_start, ad_end, mapping):
        return ad_start, ad_end, False
    shifted_start = ad_start + mapping["ad_pk_start"]
    shifted_end = ad_end + mapping["ad_pk_start"]
    if _ad_range_contained_by_mapping(shifted_start, shifted_end, mapping):
        return shifted_start, shifted_end, True
    return ad_start, ad_end, False


def _select_temp_road_mapping(mappings: list[dict[str, Any]], ad_start: float, ad_end: float) -> Optional[dict[str, Any]]:
    if not mappings:
        return None
    type_priority = {"manual": 0, "segment_range": 1, "full_axis_range": 2, "road_axis": 3}

    def score(mapping: dict[str, Any]) -> tuple[int, float]:
        raw_contains = _ad_range_contained_by_mapping(ad_start, ad_end, mapping)
        shifted_start = ad_start + mapping["ad_pk_start"]
        shifted_end = ad_end + mapping["ad_pk_start"]
        shifted_contains = _ad_range_contained_by_mapping(shifted_start, shifted_end, mapping)
        if raw_contains:
            outside_penalty = 0
        elif shifted_contains:
            outside_penalty = 5
        else:
            outside_penalty = 1000
        span = abs(mapping["ad_pk_end"] - mapping["ad_pk_start"])
        return (outside_penalty + type_priority.get(str(mapping.get("mapping_type") or ""), 9), span)

    return sorted(mappings, key=score)[0]


def _ad_pk_to_rail_pk(ad_start: float, ad_end: float, mapping: dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    ad_axis_start = mapping["ad_pk_start"]
    ad_axis_end = mapping["ad_pk_end"]
    rail_axis_start = mapping["rail_pk_start"]
    rail_axis_end = mapping["rail_pk_end"]
    ad_span = ad_axis_end - ad_axis_start
    if abs(ad_span) < 1e-4:
        return None, None
    rail_span = rail_axis_end - rail_axis_start
    t0 = (ad_start - ad_axis_start) / ad_span
    t1 = (ad_end - ad_axis_start) / ad_span
    rail_start = rail_axis_start + t0 * rail_span
    rail_end = rail_axis_start + t1 * rail_span
    return _normalize_pk_pair(round(rail_start, 2), round(rail_end, 2))


def _enrich_payload_ad_rail_from_temp_roads(payload: Any) -> int:
    mappings_by_road = _load_temp_road_pk_mappings()
    if not mappings_by_road:
        return 0
    updated = 0
    for row in _payload_rows(payload, "main_works") + _payload_rows(payload, "aux_works"):
        if _work_row_has_manual_rail_pk(row):
            continue
        ad_start, ad_end = _work_row_ad_pk(row)
        if ad_start is None or ad_end is None:
            continue
        road_code = next((code for code in _work_row_temp_road_candidates(row) if code in mappings_by_road), None)
        if not road_code:
            continue
        mapping = _select_temp_road_mapping(mappings_by_road[road_code], ad_start, ad_end)
        if not mapping:
            continue
        calc_ad_start, calc_ad_end, shifted_ad = _shift_local_ad_range_if_needed(ad_start, ad_end, mapping)
        rail_start, rail_end = _ad_pk_to_rail_pk(calc_ad_start, calc_ad_end, mapping)
        if rail_start is None or rail_end is None:
            continue
        row["pk_ad_start"] = ad_start
        row["pk_ad_end"] = ad_end
        row["pk_rail_start"] = rail_start
        row["pk_rail_end"] = rail_end
        row["pk_start"] = rail_start
        row["pk_end"] = rail_end
        row["pk_rail_raw"] = _pk_range_label(rail_start, rail_end)
        row["pk_rail_source"] = "auto_from_ad"
        row["pk_rail_source_road_code"] = road_code
        row["pk_rail_source_ad_raw"] = row.get("pk_ad_raw") or _pk_range_label(ad_start, ad_end)
        row["pk_rail_source_ad_mode"] = "local_offset" if shifted_ad else "absolute"
        updated += 1
    return updated


def _parse_pk_ranges_text(value: Any) -> list[dict[str, Any]]:
    text = str(value or "").strip()
    if not text:
        return []
    ranges: list[dict[str, Any]] = []
    chunks = [part.strip() for part in re.split(r"[\n;]+", text) if part.strip()]
    for chunk in chunks:
        values = _strict_pk_values(chunk)
        idx = 0
        while idx < len(values):
            start = values[idx]
            end = values[idx + 1] if idx + 1 < len(values) else start
            idx += 2
            if end < start:
                start, end = end, start
            ranges.append({"start": start, "end": end, "raw": chunk})
    return ranges


def _payload_rows(payload: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        rows = payload.get(key)
    else:
        rows = getattr(payload, key, None)
    return [row for row in (rows or []) if isinstance(row, dict)]


def _has_pk_override(row: dict[str, Any]) -> bool:
    return bool(row.get("pk_validation_override") or row.get("pk_override") or row.get("boundary_override"))


def _pk_import_issue(value: Any, *, label: str) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return None if math.isfinite(float(value)) else f"{label}: нечисловой пикетаж"
    raw = str(value or "").strip()
    if not raw:
        return None
    if _parse_pk_input(raw) is None:
        return f"{label}: ошибка в пикетаже `{raw}`"
    return None


def _boundary_ranges(boundary: dict[str, Any]) -> list[tuple[float, float]]:
    raw_ranges = boundary.get("ranges")
    ranges: list[tuple[float, float]] = []
    if isinstance(raw_ranges, list):
        for item in raw_ranges:
            if not isinstance(item, dict):
                continue
            try:
                start = float(item["start"])
                end = float(item["end"])
            except (KeyError, TypeError, ValueError):
                continue
            ranges.append((min(start, end), max(start, end)))
    if not ranges:
        ranges.append((min(float(boundary["start"]), float(boundary["end"])), max(float(boundary["start"]), float(boundary["end"]))))
    return ranges


def _format_boundary_ranges(boundary: dict[str, Any]) -> str:
    return "; ".join(f"{_format_pk_db(start)} - {_format_pk_db(end)}" for start, end in _boundary_ranges(boundary))


def _pk_warning_issue(value: Any, boundary: Optional[dict[str, Any]], *, label: str) -> Optional[str]:
    if value in (None, "") or not boundary:
        return None
    ranges = _parse_pk_ranges_text(value)
    if not ranges:
        return None
    allowed_ranges = _boundary_ranges(boundary)
    for rng in ranges:
        start = float(rng["start"])
        end = float(rng["end"])
        if not any(start >= b_start and end <= b_end for b_start, b_end in allowed_ranges):
            return (
                f"{label}: проверьте пикетаж `{rng.get('raw') or value}` — выходит за "
                f"{boundary.get('label') or 'границы'} ({_format_boundary_ranges(boundary)})"
            )
    return None


def _payload_header_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        header = payload.get("header") or {}
    else:
        header = getattr(payload, "header", {}) or {}
    if hasattr(header, "dict"):
        return header.dict()
    if hasattr(header, "model_dump"):
        return header.model_dump()
    return header if isinstance(header, dict) else {}


def _load_pk_validation_boundaries() -> dict[str, Any]:
    section_bounds: dict[tuple[str, str], dict[str, Any]] = {}
    object_bounds: dict[str, dict[str, Any]] = {}
    road_bounds: dict[str, dict[str, Any]] = {}
    road_rail_bounds: dict[str, dict[str, Any]] = {}
    try:
        for row in query(
            """
            SELECT csv.boundary_kind, cs.code AS section_code, csv.pk_start, csv.pk_end
            FROM construction_section_versions csv
            JOIN construction_sections cs ON cs.id = csv.section_id
            WHERE csv.is_current = true
            ORDER BY csv.boundary_kind, cs.sort_order NULLS LAST, cs.code, csv.pk_start
            """
        ):
            start = min(float(row["pk_start"]), float(row["pk_end"]))
            end = max(float(row["pk_start"]), float(row["pk_end"]))
            key = (row["boundary_kind"], row["section_code"])
            boundary = section_bounds.setdefault(key, {
                "start": start,
                "end": end,
                "label": f"границы участка {row['section_code']}",
                "ranges": [],
            })
            boundary["start"] = min(float(boundary["start"]), start)
            boundary["end"] = max(float(boundary["end"]), end)
            boundary.setdefault("ranges", []).append({"start": start, "end": end})
    except Exception:
        pass
    try:
        for row in query(
            """
            SELECT o.object_code,
                   MIN(LEAST(os.pk_start, os.pk_end)) AS pk_start,
                   MAX(GREATEST(os.pk_start, os.pk_end)) AS pk_end,
                   o.name
            FROM objects o
            JOIN object_segments os ON os.object_id = o.id
            WHERE o.is_active IS NOT FALSE
              AND os.pk_start IS NOT NULL
              AND os.pk_end IS NOT NULL
            GROUP BY o.object_code, o.name
            """
        ):
            object_bounds[row["object_code"]] = {
                "start": row["pk_start"],
                "end": row["pk_end"],
                "label": f"границы объекта {row.get('name') or row['object_code']}",
            }
    except Exception:
        pass
    try:
        for row in query(
            """
            SELECT id::text AS id, road_code, road_name, ad_start_pk, ad_end_pk, rail_start_pk, rail_end_pk
            FROM temporary_roads
            """
        ):
            boundary = {
                "start": row["ad_start_pk"],
                "end": row["ad_end_pk"],
                "label": f"границы {row.get('road_name') or row.get('road_code')}",
            }
            rail_boundary = None
            if row.get("rail_start_pk") is not None and row.get("rail_end_pk") is not None:
                rail_boundary = {
                    "start": row["rail_start_pk"],
                    "end": row["rail_end_pk"],
                    "label": f"ВСЖМ-границы {row.get('road_name') or row.get('road_code')}",
                }
            if row.get("id"):
                road_bounds[str(row["id"])] = boundary
                if rail_boundary:
                    road_rail_bounds[str(row["id"])] = rail_boundary
            if row.get("road_code"):
                road_bounds[str(row["road_code"])] = boundary
                if rail_boundary:
                    road_rail_bounds[str(row["road_code"])] = rail_boundary
    except Exception:
        pass
    return {"sections": section_bounds, "objects": object_bounds, "roads": road_bounds, "road_rail": road_rail_bounds}


def _collect_import_pk_validation_issues(payload: Any, boundaries: Optional[dict[str, Any]] = None) -> list[dict[str, str]]:
    """Collect picketage errors/warnings without blocking operator save."""
    boundaries = boundaries or _load_pk_validation_boundaries()
    section_code = _payload_header_dict(payload).get("section_code") or ""
    section_main = boundaries["sections"].get(("main", section_code))
    section_temp_roads = boundaries["sections"].get(("temp_roads", section_code))
    issues: list[dict[str, str]] = []

    def add(level: str, message: Optional[str]) -> None:
        if message:
            issues.append({"level": level, "message": message})

    work_rows = _payload_rows(payload, "main_works") + _payload_rows(payload, "aux_works")
    for idx, row in enumerate(work_rows, start=1):
        object_boundary = boundaries["objects"].get(row.get("object_code") or row.get("constructive_code") or "")
        boundary = object_boundary or section_main
        for key, label in (
            ("pk_rail_start", "ПК ВСЖМ начало"),
            ("pk_start", "ПК ВСЖМ начало"),
            ("pk_rail_end", "ПК ВСЖМ конец"),
            ("pk_end", "ПК ВСЖМ конец"),
        ):
            value = row.get(key)
            add("error", _pk_import_issue(value, label=f"работа №{idx} {label}"))
            add("warning", _pk_warning_issue(value, boundary, label=f"работа №{idx} {label}"))
        add("error", _pk_import_issue(row.get("pk_ad_raw"), label=f"работа №{idx} ПК АД"))
    for idx, row in enumerate(_payload_rows(payload, "stockpiles"), start=1):
        raw = row.get("pk_raw_text")
        if row.get("pk_start") in (None, "") and row.get("rounded_pk") in (None, ""):
            add("error", _pk_import_issue(raw, label=f"накопитель №{idx} ПК"))
        add("warning", _pk_warning_issue(raw, section_main, label=f"накопитель №{idx} ПК"))
    for idx, row in enumerate(_payload_rows(payload, "fill_statuses"), start=1):
        road_key = str(row.get("road_id") or "")
        road_code_key = str(row.get("road_code") or "")
        road_boundary = (
            boundaries["roads"].get(road_key)
            or boundaries["roads"].get(road_code_key)
            or boundaries["sections"].get(("temp_roads", row.get("section_code") or section_code))
            or section_temp_roads
        )
        rail_boundary = (
            boundaries.get("road_rail", {}).get(road_key)
            or boundaries.get("road_rail", {}).get(road_code_key)
            or boundaries["sections"].get(("temp_roads", row.get("section_code") or section_code))
            or section_temp_roads
        )
        for status_type, raw, pk_system in _iter_temp_road_fill_status_inputs(row):
            if raw in (None, "") or not str(raw).strip():
                continue
            label = "ПК ВСЖМ" if pk_system == "rail" else "ПК АД"
            if not _parse_pk_ranges_text(raw):
                add("error", f"отсыпка ВАД №{idx} {label} {status_type}: ошибка в пикетаже `{str(raw).strip()[:80]}`")
                continue
            boundary = rail_boundary if pk_system == "rail" else road_boundary
            add("warning", _pk_warning_issue(raw, boundary, label=f"отсыпка ВАД №{idx} {label} {status_type}"))
    for idx, row in enumerate(_payload_rows(payload, "mainline_fill_statuses"), start=1):
        raw = row.get("pk_ranges")
        if raw in (None, "") or not str(raw).strip():
            continue
        boundary = boundaries["sections"].get(("main", row.get("section_code") or section_code)) or section_main
        if not _parse_pk_ranges_text(raw):
            add("error", f"отсыпка ОХ №{idx}: ошибка в пикетаже `{str(raw).strip()[:80]}`")
            continue
        add("warning", _pk_warning_issue(raw, boundary, label=f"отсыпка ОХ №{idx}"))
    return issues


def _pk_validation_summary(payload: Any) -> dict[str, Any]:
    issues = _collect_import_pk_validation_issues(payload)
    if any(issue["level"] == "error" for issue in issues):
        level = "error"
    elif any(issue["level"] == "warning" for issue in issues):
        level = "warning"
    else:
        level = None
    return {"level": level, "count": len(issues), "issues": issues[:20]}


def _assert_import_pk_validation(payload: Any) -> None:
    """Kept for compatibility: picketage issues are now review markers, not save blockers."""
    return None


def _reset_reference_caches() -> None:
    _REF_CACHE["ts"] = 0.0
    _REF_CACHE["by_kind"] = {}
    _ALIAS_CACHE["ts"] = 0.0
    _ALIAS_CACHE["by_kind"] = {}


def _ensure_alias_table(cur) -> None:
    global _ALIAS_TABLE_READY
    if _ALIAS_TABLE_READY:
        return
    cur.execute("SELECT to_regclass('public.work_type_aliases') IS NOT NULL")
    row = cur.fetchone()
    if row and row[0]:
        _ALIAS_TABLE_READY = True
        return
    cur.execute("SET LOCAL lock_timeout = '2s'")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS work_type_aliases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            canonical_code TEXT NOT NULL,
            alias_text TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    _ALIAS_TABLE_READY = True


def _upsert_reference_alias(cur, kind: str, alias_text: Optional[str], canonical_code: str) -> None:
    alias = (alias_text or "").strip()
    if not alias or not canonical_code:
        return
    _ensure_alias_table(cur)
    alias_key = _normalize_ref(alias)
    normalized_alias_sql = "BTRIM(regexp_replace(regexp_replace(regexp_replace(replace(replace(lower(alias_text), 'ё', 'е'), '№', ' '), '\\mпк\\s*([0-9]+)', 'пк \\1', 'g'), '[^0-9a-zа-я]+', ' ', 'g'), '\\s+', ' ', 'g'))"
    cur.execute(
        f"""
        UPDATE work_type_aliases
        SET canonical_code = %s,
            alias_text = %s,
            notes = %s
        WHERE kind = %s
          AND {normalized_alias_sql} = %s
        """,
        (canonical_code, alias, "created from report preview", kind, alias_key),
    )
    if cur.rowcount:
        return
    cur.execute(
        """
        INSERT INTO work_type_aliases (canonical_code, alias_text, kind, notes)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (canonical_code, alias, kind, "created from report preview"),
    )


def _upsert_learned_reference_alias(cur, kind: str, alias_text: Optional[str], canonical_code: Optional[str], notes: str) -> int:
    alias = re.sub(r"\s+", " ", str(alias_text or "").replace("\xa0", " ")).strip().strip("/")
    canonical = str(canonical_code or "").strip()
    normalized_kind = str(kind or "").strip()
    if not alias or not canonical or normalized_kind not in {"material", "object", "work_type"}:
        return 0
    if _normalize_ref(alias) == _normalize_ref(canonical):
        return 0
    _ensure_alias_table(cur)
    alias_key = _normalize_ref(alias)
    normalized_alias_sql = "BTRIM(regexp_replace(regexp_replace(regexp_replace(replace(replace(lower(alias_text), 'ё', 'е'), '№', ' '), '\\mпк\\s*([0-9]+)', 'пк \\1', 'g'), '[^0-9a-zа-я]+', ' ', 'g'), '\\s+', ' ', 'g'))"
    cur.execute(
        f"""
        SELECT canonical_code
        FROM work_type_aliases
        WHERE kind = %s
          AND {normalized_alias_sql} = %s
        LIMIT 1
        """,
        (normalized_kind, alias_key),
    )
    existing = cur.fetchone()
    if existing:
        existing_code = existing.get("canonical_code") if isinstance(existing, dict) else existing[0]
        if str(existing_code or "") != canonical:
            return 0
        cur.execute(
            f"""
            UPDATE work_type_aliases
            SET notes = %s
            WHERE canonical_code = %s
              AND kind = %s
              AND {normalized_alias_sql} = %s
            """,
            (notes, canonical, normalized_kind, alias_key),
        )
        return 0
    cur.execute(
        """
        INSERT INTO work_type_aliases (canonical_code, alias_text, kind, notes)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (canonical, alias, normalized_kind, notes),
    )
    return cur.rowcount


def _section_num_from_code(code: Optional[str]) -> Optional[int]:
    m = re.search(r"UCH_(\d+)", code or "")
    if not m:
        return None
    num = int(m.group(1))
    return 3 if num in (31, 32) else num


def _prepare_reference_entry(entry: dict[str, Any]) -> dict[str, Any]:
    aliases = entry.get("aliases") or [entry.get("label"), entry.get("code")]
    alias_match_data: list[dict[str, Any]] = []
    for alias in aliases:
        alias_norm = _normalize_ref(alias)
        if not alias_norm:
            continue
        alias_match_data.append({
            "norm": alias_norm,
            "compact": _compact_ref(alias),
            "tokens": _ref_tokens(alias_norm),
        })
    entry["_alias_match_data"] = alias_match_data
    entry["_code_norm"] = _normalize_ref(entry.get("code"))
    entry["_code_compact"] = _compact_ref(entry.get("code"))
    entry["_label_norm"] = _normalize_ref(entry.get("label"))
    return entry


def _object_aliases(code: str, name: str, object_type_code: Optional[str]) -> list[str]:
    aliases = [code, name]
    if object_type_code == "BORROW_PIT":
        stripped_quarry_name = re.sub(r"^\s*карьер\s+", "", str(name or ""), flags=re.I).strip()
        if stripped_quarry_name and stripped_quarry_name != name:
            aliases.append(stripped_quarry_name)
        extra_aliases = {
            "южные маяки": ["Маяки", "Южные Маяки", "карьер Южные Маяки"],
            "пирус": ["Пирус", "Пиррусс", "карьер Пирус", "карьер Пиррусс"],
            "боровенка": ["Боровенка", "Боровенка-3", "карьер Боровенка", "карьер Боровенка-3"],
            "зорька 2": ["Зорька 2", "Зорька-2", "карьер Зорька 2", "карьер Зорька-2"],
        }
        aliases.extend(extra_aliases.get(_quarry_ref_key(name), []))
    name_norm = _normalize_ref(name)
    pk_matches = re.findall(r"\bпк\s+(\d{3,5})\b", name_norm)
    for pk in pk_matches:
        aliases.extend([f"ПК{pk}", f"ПК {pk}"])
        if "площад" in name_norm:
            aliases.extend([f"площадка {pk}", f"площадка ПК{pk}", f"площадка ПК {pk}"])
    road_match = re.search(r"дорог[а-я]*\s+(\d+(?:\.\d+)*)", name_norm)
    if road_match:
        road_no = road_match.group(1)
        aliases.extend([f"АД {road_no}", f"АД{road_no}", f"ВПД {road_no}", f"дорога {road_no}"])
    section_match = re.search(r"участок\s+(\d+)", name_norm)
    if code.startswith("MAIN_") or object_type_code == "MAIN_TRACK":
        aliases.extend(["ОХ", "основной ход"])
        if section_match:
            aliases.append(f"основной ход участок {section_match.group(1)}")
    if code.startswith("STUFF_"):
        aliases.extend(["сопутствующее", "прочее", "работа на иссо", "иссо"])
    return aliases


def load_reference_catalog(force: bool = False) -> dict[str, list[dict[str, Any]]]:
    """DB-backed dictionaries used by parser preview suggestions.

    Кэш короткий: оператор видит актуальные справочники, но preview не делает
    несколько одинаковых запросов на каждую строку отчета.
    """
    now = time.time()
    if not force and (now - float(_REF_CACHE["ts"])) < _REF_TTL_SEC and _REF_CACHE["by_kind"]:
        return _REF_CACHE["by_kind"]  # type: ignore[return-value]
    _ensure_report_review_schema()

    by_kind: dict[str, list[dict[str, Any]]] = {
        "work_type": [],
        "material": [],
        "object": [],
    }
    try:
        for r in query(
            """
            SELECT code, name, default_unit, analytics_tag,
                   COALESCE(productivity_enabled, true) AS productivity_enabled
            FROM work_types
            WHERE is_active = true
            ORDER BY show_in_timeline DESC, analytics_tag NULLS LAST, name
            """
        ):
            code = str(r.get("code") or "").strip()
            name = str(r.get("name") or "").strip()
            if code and name:
                by_kind["work_type"].append({
                    "code": code,
                    "label": name,
                    "table": "work_types",
                    "default_unit": r.get("default_unit"),
                    "analytics_tag": r.get("analytics_tag"),
                    "productivity_enabled": r.get("productivity_enabled", True),
                    "aliases": [code, name],
                })
    except Exception:
        pass

    try:
        for r in query(
            """
            SELECT code, name, default_unit
            FROM materials
            ORDER BY CASE code WHEN 'SAND' THEN 0 WHEN 'COARSE_SAND' THEN 1 ELSE 2 END, name
            """
        ):
            code = str(r.get("code") or "").strip()
            name = str(r.get("name") or "").strip()
            if code and name:
                by_kind["material"].append({
                    "code": code,
                    "label": name,
                    "table": "materials",
                    "default_unit": r.get("default_unit"),
                    "aliases": [code, name],
                })
    except Exception:
        pass

    try:
        for r in query(
            """
            WITH seg AS (
              SELECT object_id,
                     MIN(LEAST(pk_start, pk_end)) AS pk_start,
                     MAX(GREATEST(pk_start, pk_end)) AS pk_end,
                     STRING_AGG(DISTINCT NULLIF(pk_raw_text, ''), '; ') AS pk_raw_text
              FROM object_segments
              WHERE pk_start IS NOT NULL
                AND pk_end IS NOT NULL
              GROUP BY object_id
            ),
            main_bounds AS (
              SELECT cs.code AS section_code,
                     csv.pk_start,
                     csv.pk_end,
                     csv.pk_raw_text,
                     ROW_NUMBER() OVER (PARTITION BY cs.code ORDER BY csv.pk_start, csv.pk_end) AS section_part
              FROM construction_section_versions csv
              JOIN construction_sections cs ON cs.id = csv.section_id
              WHERE csv.is_current = true
                AND csv.boundary_kind = 'main'
            ),
            object_base AS (
              SELECT o.object_code AS code,
                     o.name AS label,
                     ot.code AS object_type_code,
                     ot.name AS object_type_name,
                     seg.pk_start,
                     seg.pk_end,
                     seg.pk_raw_text,
                     CASE
                       WHEN o.object_code ~ '^MAIN_00([1-8])$' THEN 'UCH_' || substring(o.object_code FROM '^MAIN_00([1-8])$')
                       WHEN o.object_code IN ('MAIN_031','MAIN_032') THEN 'UCH_3'
                       WHEN o.object_code ~ 'UCH_([1-8])' THEN 'UCH_' || substring(o.object_code FROM 'UCH_([1-8])')
                       ELSE NULL
                     END AS code_section_code,
                     CASE
                       WHEN o.object_code IN ('ASP_2840', 'BRIDGE_282952') THEN 'UCH_3'
                       ELSE NULL
                     END AS section_override_code,
                     CASE
                       WHEN ot.code = 'TEMP_ROAD' THEN 'temp_roads'
                       WHEN ot.code IN ('PILE_FIELD','ISSO_ACCESS','BRIDGE','OVERPASS','PIPE','PILE_DRIVING_PAD','TECH_ROAD') THEN 'piles_pipes'
                       ELSE 'main'
                     END AS boundary_kind,
                     CASE
                       WHEN seg.pk_start IS NOT NULL AND seg.pk_end IS NOT NULL THEN (seg.pk_start + seg.pk_end) / 2.0
                       ELSE NULL
                     END AS midpoint
              FROM objects o
              LEFT JOIN object_types ot ON ot.id = o.object_type_id
              LEFT JOIN seg ON seg.object_id = o.id
              WHERE o.is_active = true
            )
            SELECT ob.code,
                   ob.label,
                   ob.object_type_code,
                   ob.object_type_name,
                   COALESCE(CASE WHEN ob.object_type_code = 'MAIN_TRACK' THEN mb.pk_start ELSE ob.pk_start END, ob.pk_start) AS pk_start,
                   COALESCE(CASE WHEN ob.object_type_code = 'MAIN_TRACK' THEN mb.pk_end ELSE ob.pk_end END, ob.pk_end) AS pk_end,
                   COALESCE(CASE WHEN ob.object_type_code = 'MAIN_TRACK' THEN mb.pk_raw_text ELSE ob.pk_raw_text END, ob.pk_raw_text) AS pk_raw_text,
                   COALESCE(
                     CASE WHEN ob.object_type_code = 'MAIN_TRACK' THEN ob.code_section_code ELSE COALESCE(ob.section_override_code, sec.section_code) END,
                     ob.section_override_code,
                     ob.code_section_code
                   ) AS section_code
            FROM object_base ob
            LEFT JOIN main_bounds mb
              ON ob.object_type_code = 'MAIN_TRACK'
             AND mb.section_code = ob.code_section_code
             AND (
                 (ob.code = 'MAIN_031' AND mb.section_part = 1)
              OR (ob.code = 'MAIN_032' AND mb.section_part = 2)
              OR (ob.code NOT IN ('MAIN_031','MAIN_032'))
             )
            LEFT JOIN LATERAL (
              SELECT cs.code AS section_code
              FROM construction_section_versions csv
              JOIN construction_sections cs ON cs.id = csv.section_id
              WHERE csv.is_current = true
                AND csv.boundary_kind = ob.boundary_kind
                AND ob.midpoint IS NOT NULL
                AND ob.midpoint BETWEEN LEAST(csv.pk_start, csv.pk_end) AND GREATEST(csv.pk_start, csv.pk_end)
              ORDER BY cs.sort_order NULLS LAST, cs.code, csv.pk_start
              LIMIT 1
            ) sec ON TRUE
            ORDER BY ob.label
            """
        ):
            code = str(r.get("code") or "").strip()
            label = str(r.get("label") or "").strip()
            if code and label:
                by_kind["object"].append({
                    "code": code,
                    "label": label,
                    "table": "objects",
                    "object_type_code": r.get("object_type_code"),
                    "object_type_name": r.get("object_type_name"),
                    "pk_start": float(r["pk_start"]) if r.get("pk_start") is not None else None,
                    "pk_end": float(r["pk_end"]) if r.get("pk_end") is not None else None,
                    "pk_raw_text": r.get("pk_raw_text"),
                    "section_code": r.get("section_code"),
                    "aliases": _object_aliases(code, label, r.get("object_type_code")),
                })
    except Exception:
        pass

    for entries in by_kind.values():
        for entry in entries:
            _prepare_reference_entry(entry)

    _REF_CACHE["by_kind"] = by_kind
    _REF_CACHE["ts"] = now
    return by_kind


def _entry_score(text: str, entry: dict[str, Any]) -> float:
    text_norm = _normalize_ref(text)
    text_compact = _compact_ref(text)
    if not text_norm:
        return 0.0
    text_tokens = _ref_tokens(text_norm)
    best = 0.0
    alias_match_data = entry.get("_alias_match_data")
    if not alias_match_data:
        alias_match_data = []
        for alias in entry.get("aliases") or [entry.get("label"), entry.get("code")]:
            alias_norm = _normalize_ref(alias)
            if alias_norm:
                alias_match_data.append({
                    "norm": alias_norm,
                    "compact": _compact_ref(alias),
                    "tokens": _ref_tokens(alias_norm),
                })
    for alias_data in alias_match_data:
        alias_norm = alias_data.get("norm") or ""
        alias_compact = alias_data.get("compact") or ""
        if not alias_norm:
            continue
        if text_norm == alias_norm or text_compact == alias_compact:
            best = max(best, 1.0)
            continue
        if len(text_norm) >= 3 and len(alias_norm) >= 3 and (text_norm in alias_norm or alias_norm in text_norm):
            best = max(best, 0.92)
        alias_tokens = alias_data.get("tokens") or set()
        if text_tokens and alias_tokens:
            overlap = len(text_tokens & alias_tokens)
            if overlap:
                best = max(best, 0.35 + 0.55 * (overlap / max(len(text_tokens), len(alias_tokens))))
    return best


def _entry_has_exact_alias(text: str, entry: dict[str, Any]) -> bool:
    """Return true only for an exact normalized alias, not a compact collision."""
    text_norm = _normalize_ref(text)
    if not text_norm:
        return False
    alias_match_data = entry.get("_alias_match_data")
    if alias_match_data:
        return any(text_norm == str(alias_data.get("norm") or "") for alias_data in alias_match_data)
    return any(
        text_norm == _normalize_ref(alias)
        for alias in entry.get("aliases") or [entry.get("label"), entry.get("code")]
    )


def _section_object_bonus(entry: dict[str, Any], section_code: Optional[str]) -> float:
    bonus = 0.0
    wanted_section = str(section_code or "").strip()
    entry_section = str(entry.get("section_code") or "").strip()
    if wanted_section and entry_section:
        bonus += 0.18 if wanted_section == entry_section else -0.08

    section_num = _section_num_from_code(section_code)
    if section_num is None:
        return bonus
    code = str(entry.get("code") or "")
    if code == f"MAIN_{section_num:03d}" or code == f"STUFF_{section_num}":
        bonus += 0.08
    if code == f"STOCK_00{section_num}" or code == f"STOCK_0{section_num}0":
        bonus += 0.04
    if section_num == 3 and code in {"MAIN_031", "MAIN_032"}:
        bonus += 0.08
    return bonus


def _entry_temp_road_alias_codes(entry: dict[str, Any]) -> set[str]:
    aliases = entry.get("aliases") or [entry.get("label"), entry.get("code")]
    codes: set[str] = set()
    for alias in aliases:
        code = _temp_road_code_from_text(alias)
        if code:
            codes.add(code)
    return codes


def _reference_candidates(
    kind: str,
    text: Optional[str],
    existing_code: Optional[str] = None,
    *,
    section_code: Optional[str] = None,
    limit: int = 6,
) -> list[dict[str, Any]]:
    if not text and not existing_code:
        return []
    catalog = load_reference_catalog().get(kind, [])
    scored: dict[str, dict[str, Any]] = {}
    existing_norm = _normalize_ref(existing_code)
    existing_compact = _compact_ref(existing_code)
    exact_temp_road_code = _temp_road_code_from_text(text) if kind == "object" else None

    for entry in catalog:
        code = str(entry.get("code") or "")
        label = str(entry.get("label") or "")
        exact_alias_match = _entry_has_exact_alias(str(text or ""), entry)
        score = _entry_score(str(text or ""), entry)
        source = "exact" if exact_alias_match else "fuzzy"
        if exact_alias_match:
            # A section hint may refine equal aliases, but a longer object name
            # containing this alias must not outrank the exact object itself.
            score = max(score, 1.2)
        if existing_norm and (
            existing_norm == (entry.get("_code_norm") or _normalize_ref(code))
            or existing_norm == (entry.get("_label_norm") or _normalize_ref(label))
            or existing_compact == (entry.get("_code_compact") or _compact_ref(code))
        ):
            score = max(score, 1.0)
            if not exact_alias_match:
                source = "selected"
        if exact_temp_road_code and exact_temp_road_code in _entry_temp_road_alias_codes(entry):
            score = max(score, 1.16)
            source = "exact"
        if kind == "object":
            score = score + _section_object_bonus(entry, section_code)
        if score < 0.35:
            continue
        current = scored.get(code)
        if current and current["score"] >= score:
            continue
        scored[code] = {
            "code": code,
            "label": label,
            "score": round(score, 3),
            "source": source,
            "table": entry.get("table"),
            "default_unit": entry.get("default_unit"),
            "analytics_tag": entry.get("analytics_tag"),
            "productivity_enabled": entry.get("productivity_enabled"),
            "object_type_code": entry.get("object_type_code"),
            "constructive_code": entry.get("constructive_code"),
            "constructive_name": entry.get("constructive_name"),
            "section_code": entry.get("section_code"),
            "pk_start": entry.get("pk_start"),
            "pk_end": entry.get("pk_end"),
            "pk_raw_text": entry.get("pk_raw_text"),
        }

    return sorted(
        scored.values(),
        key=lambda item: (item.get("source") != "exact", -item["score"], item["label"]),
    )[:limit]


def _select_reference_code(
    kind: str,
    existing_code: Optional[str],
    candidates: list[dict[str, Any]],
    *,
    section_code: Optional[str] = None,
) -> Optional[str]:
    if not candidates:
        return None
    existing_norm = _normalize_ref(existing_code)
    existing_compact = _compact_ref(existing_code)
    best = candidates[0]
    best_score = float(best.get("score") or 0)
    wanted_section = str(section_code or "").strip()
    selected: Optional[dict[str, Any]] = None
    for candidate in candidates:
        if existing_norm and (
            existing_norm == _normalize_ref(candidate.get("code"))
            or existing_norm == _normalize_ref(candidate.get("label"))
            or existing_compact == _compact_ref(candidate.get("code"))
        ):
            selected = candidate
            break
    if selected:
        selected_score = float(selected.get("score") or 0)
        selected_section = str(selected.get("section_code") or "").strip()
        best_section = str(best.get("section_code") or "").strip()
        if (
            best.get("code") != selected.get("code")
            and best.get("source") == "exact"
            and selected.get("source") != "exact"
        ):
            return best.get("code")
        # Deterministic parsers may prefill an object code from a partial route
        # token (e.g. `АД 14 ...` was reduced to `VPD_001`, or a bare
        # `накопитель песка` inherited a stockpile from another section). If the
        # DB-backed search finds a same-section candidate that fits the actual
        # label, prefer it over a parser prefill that points to another section.
        if (
            kind == "object"
            and wanted_section
            and best.get("code") != selected.get("code")
            and best_section == wanted_section
            and selected_section
            and selected_section != wanted_section
            and best_score >= 0.85
        ):
            return best.get("code")
        # Strong fuzzy evidence can also override a weak parser preselection even
        # when the object has no section metadata (e.g. quarries) or the selected
        # candidate came from a stale alias/code.
        if (
            best.get("code") != selected.get("code")
            and best_score >= 0.92
            and best_score - selected_score >= 0.08
        ):
            return best.get("code")
        return selected.get("code")
    if best_score >= 0.92:
        return best.get("code")
    return None


def _is_manual_reference_selection(row: dict[str, Any], *keys: str) -> bool:
    manual_values = {"manual", "user", "operator", "explicit"}
    for key in keys:
        value = row.get(key)
        if value is True:
            return True
        if str(value or "").strip().lower() in manual_values:
            return True
    return False


def _selected_reference_code(existing_code: Optional[str], candidates: list[dict[str, Any]]) -> Optional[str]:
    existing_norm = _normalize_ref(existing_code)
    existing_compact = _compact_ref(existing_code)
    if not existing_norm and not existing_compact:
        return None
    for candidate in candidates:
        candidate_code = candidate.get("code")
        if (
            existing_norm == _normalize_ref(candidate_code)
            or existing_norm == _normalize_ref(candidate.get("label"))
            or existing_compact == _compact_ref(candidate_code)
        ):
            return str(candidate_code or "").strip() or None
    return None


@router.get("/reference-search")
def reference_search(
    kind: str,
    q: str = "",
    section: Optional[str] = None,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """Manual DB dictionary search for parser review dropdowns."""
    normalized_kind = (kind or "").strip()
    if normalized_kind not in {"work_type", "material", "object"}:
        raise HTTPException(400, "Unsupported reference kind")
    query_text = (q or "").strip()
    if len(query_text) < 2:
        return []
    safe_limit = max(1, min(int(limit or 12), 30))
    return _reference_candidates(
        normalized_kind,
        query_text,
        section_code=section,
        limit=safe_limit,
    )


@router.get("/reference-meta")
def reference_meta() -> dict[str, Any]:
    """Small dictionaries for creating missing parser references inline."""
    _ensure_report_review_schema()
    return {
        "object_types": query(
            """
            SELECT code, name, map_enabled, work_accounting_enabled,
                   material_accounting_enabled, is_linear, accounting_note
            FROM object_types
            WHERE is_active = true
            ORDER BY name
            """
        ),
        "work_tags": [
            r["name"]
            for r in query(
                """
                SELECT name
                FROM work_analytics_tags
                WHERE is_active IS NOT FALSE
                UNION
                SELECT DISTINCT analytics_tag AS name
                FROM work_types
                WHERE NULLIF(BTRIM(analytics_tag), '') IS NOT NULL
                UNION
                SELECT DISTINCT analytics_tag AS name
                FROM daily_work_items
                WHERE NULLIF(BTRIM(analytics_tag), '') IS NOT NULL
                ORDER BY name
                """
            )
        ],
    }


@router.get("/temp-roads")
def report_temp_roads() -> list[dict[str, Any]]:
    """Temporary road dictionary for the fill-status report wizard block."""
    return query(
        f"""
        SELECT tr.id::text AS id,
               tr.road_code,
               tr.road_name,
               cs.code AS section_code,
               cs.name AS section_name,
               tr.ad_start_pk::numeric AS ad_start_pk,
               tr.ad_end_pk::numeric AS ad_end_pk,
               tr.rail_start_pk::numeric AS rail_start_pk,
               tr.rail_end_pk::numeric AS rail_end_pk,
               o.id::text AS object_id,
               o.object_code,
               o.name AS object_name
        FROM temporary_roads tr
        LEFT JOIN construction_sections cs ON cs.id = tr.section_id
        LEFT JOIN objects o ON o.id = tr.object_id
        ORDER BY COALESCE(cs.sort_order, 999), tr.rail_start_pk NULLS LAST, tr.road_code
        """
    )


@router.post("/object-type-create")
def object_type_create(body: ObjectTypeCreateBody) -> dict[str, Any]:
    """Create a missing object type directly from the report preview object modal."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    code = _safe_ref_code(body.code or name, "OBJECT_TYPE", max_len=50)
    note = (body.accounting_note or "").strip() or None

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT code, name, map_enabled, work_accounting_enabled,
                           material_accounting_enabled, is_linear, accounting_note
                    FROM object_types
                    WHERE code = %s
                    LIMIT 1
                    """,
                    (code,),
                )
                existing = cur.fetchone()
                if existing:
                    return {
                        "code": existing[0],
                        "name": existing[1],
                        "map_enabled": existing[2],
                        "work_accounting_enabled": existing[3],
                        "material_accounting_enabled": existing[4],
                        "is_linear": existing[5],
                        "accounting_note": existing[6],
                        "source": "existing",
                    }
                cur.execute(
                    """
                    INSERT INTO object_types (
                        code, name, map_enabled, work_accounting_enabled,
                        material_accounting_enabled, is_linear, accounting_note,
                        is_active, sort_order, review_tag
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, true, 100, %s)
                    RETURNING code, name, map_enabled, work_accounting_enabled,
                              material_accounting_enabled, is_linear, accounting_note
                    """,
                    (
                        code,
                        name[:255],
                        body.map_enabled,
                        body.work_accounting_enabled,
                        body.material_accounting_enabled,
                        body.is_linear,
                        note,
                        "pending_admin_review",
                    ),
                )
                row = cur.fetchone()
                _reset_reference_caches()
                return {
                    "code": row[0],
                    "name": row[1],
                    "map_enabled": row[2],
                    "work_accounting_enabled": row[3],
                    "material_accounting_enabled": row[4],
                    "is_linear": row[5],
                    "accounting_note": row[6],
                    "source": "created",
                }
    finally:
        conn.close()


@router.post("/reference-create")
def reference_create(body: ReferenceCreateBody) -> dict[str, Any]:
    """Create a missing DB reference directly from report preview."""
    kind = (body.kind or "").strip()
    if kind not in {"work_type", "material", "object"}:
        raise HTTPException(400, "Unsupported reference kind")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                if kind == "material":
                    code = _safe_ref_code(body.code, "MAT", max_len=50)
                    unit = (body.default_unit or "м3").strip()[:50]
                    cur.execute("SELECT code, name, default_unit FROM materials WHERE code = %s LIMIT 1", (code,))
                    row = cur.fetchone()
                    if not row:
                        cur.execute(
                            """
                            INSERT INTO materials (code, name, default_unit, review_tag)
                            VALUES (%s, %s, %s, %s)
                            RETURNING code, name, default_unit
                            """,
                            (code, name[:255], unit, "pending_admin_review"),
                        )
                        row = cur.fetchone()
                    _upsert_reference_alias(cur, kind, body.alias_text, code)
                    _reset_reference_caches()
                    return {
                        "code": row[0],
                        "label": row[1],
                        "table": "materials",
                        "default_unit": row[2],
                        "source": "created",
                    }

                if kind == "work_type":
                    code = _safe_ref_code(body.code, "WT")
                    unit = (body.default_unit or "м3").strip()[:50]
                    analytics_tag = _normalize_work_analytics_tag(body.analytics_tag)
                    cur.execute(
                        """
                        SELECT code, name, default_unit,
                               COALESCE(productivity_enabled, true), analytics_tag
                        FROM work_types
                        WHERE code = %s
                        LIMIT 1
                        """,
                        (code,),
                    )
                    row = cur.fetchone()
                    if not row:
                        cur.execute(
                            """
                            INSERT INTO work_types (
                                code, name, default_unit, analytics_tag,
                                productivity_enabled, is_active, show_in_timeline, review_tag
                            )
                            VALUES (%s, %s, %s, %s, %s, true, false, %s)
                            RETURNING code, name, default_unit, productivity_enabled, analytics_tag
                            """,
                            (
                                code,
                                name[:255],
                                unit,
                                analytics_tag,
                                bool(body.productivity_enabled),
                                "pending_admin_review",
                            ),
                        )
                        row = cur.fetchone()
                    elif analytics_tag and not row[4]:
                        cur.execute(
                            """
                            UPDATE work_types
                            SET analytics_tag = %s
                            WHERE code = %s
                            RETURNING code, name, default_unit,
                                      COALESCE(productivity_enabled, true), analytics_tag
                            """,
                            (analytics_tag, code),
                        )
                        row = cur.fetchone()
                    if analytics_tag:
                        _upsert_work_analytics_tag(cur, analytics_tag)
                    _upsert_reference_alias(cur, kind, body.alias_text, code)
                    _reset_reference_caches()
                    return {
                        "code": row[0],
                        "label": row[1],
                        "table": "work_types",
                        "default_unit": row[2],
                        "productivity_enabled": row[3],
                        "analytics_tag": row[4],
                        "source": "created",
                    }

                def _object_create_guard_candidates(object_code: str) -> list[dict[str, Any]]:
                    seeds = [body.alias_text, name, body.code, object_code]
                    scored: dict[str, dict[str, Any]] = {}
                    for seed in seeds:
                        if not str(seed or "").strip():
                            continue
                        for candidate in _reference_candidates(
                            "object",
                            str(seed),
                            None,
                            section_code=body.section_code,
                            limit=8,
                        ):
                            label = str(candidate.get("label") or "")
                            if "дубл" in label.lower() or "удал" in label.lower():
                                continue
                            score = float(candidate.get("score") or 0)
                            candidate_code = str(candidate.get("code") or "")
                            strong_code_match = bool(
                                object_code
                                and (
                                    _normalize_ref(candidate_code) == _normalize_ref(object_code)
                                    or _compact_ref(candidate_code) == _compact_ref(object_code)
                                )
                            )
                            if score < 0.72 and candidate.get("source") not in {"exact", "selected"} and not strong_code_match:
                                continue
                            current = scored.get(candidate_code)
                            if current and float(current.get("score") or 0) >= score:
                                continue
                            scored[candidate_code] = candidate
                    return sorted(scored.values(), key=lambda item: (-float(item.get("score") or 0), str(item.get("label") or "")))[:6]

                def _fetch_object_by_code(object_code: str):
                    cur.execute(
                        """
                        SELECT o.id, o.object_code, o.name, ot.code AS object_type_code,
                               c.code AS constructive_code, c.name AS constructive_name
                        FROM objects o
                        JOIN object_types ot ON ot.id = o.object_type_id
                        LEFT JOIN constructives c ON c.id = o.constructive_id
                        WHERE o.object_code = %s
                        LIMIT 1
                        """,
                        (object_code,),
                    )
                    return cur.fetchone()

                object_type_code = (body.object_type_code or "OTHER").strip()
                constructive_code = (body.constructive_code or "").strip() or None
                pk_start = _parse_pk_input(body.pk_start or body.pk_raw_text or name)
                pk_end = _parse_pk_input(body.pk_end) if body.pk_end not in (None, "") else pk_start
                if pk_start is not None and pk_end is None:
                    # Soft validation in the UI can intentionally leave a bad/unknown
                    # end value in place; do not let that become a NOT NULL DB error.
                    pk_end = pk_start
                pk_start, pk_end = _normalize_pk_pair(pk_start, pk_end)
                code_seed = body.code
                if not code_seed and pk_start is not None:
                    prefix = (constructive_code or object_type_code or "OBJ").upper()
                    code_seed = f"{prefix}_{int(round(pk_start / 100))}"
                code = _safe_ref_code(code_seed, "OBJ")

                cur.execute("SELECT id FROM object_types WHERE code = %s LIMIT 1", (object_type_code,))
                type_row = cur.fetchone()
                if not type_row:
                    raise HTTPException(400, f"object_type_code not found: {object_type_code}")
                constructive_id = None
                if constructive_code:
                    cur.execute("SELECT id FROM constructives WHERE code = %s LIMIT 1", (constructive_code,))
                    constructive_row = cur.fetchone()
                    if not constructive_row:
                        raise HTTPException(400, f"constructive_code not found: {constructive_code}")
                    constructive_id = constructive_row[0]

                row = _fetch_object_by_code(code)
                if not body.force_create and (not row or _normalize_ref(row[2]) != _normalize_ref(name)):
                    guard_candidates = _object_create_guard_candidates(code)
                    if guard_candidates:
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "message": "Похожие объекты уже есть в БД. Выберите существующий объект и сохраните алиас либо подтвердите создание новой записи.",
                                "candidates": guard_candidates,
                            },
                        )
                if row and _normalize_ref(row[2]) != _normalize_ref(name):
                    base_code = code
                    row = None
                    for suffix in range(2, 100):
                        suffix_text = f"_{suffix}"
                        candidate = f"{base_code[:100 - len(suffix_text)]}{suffix_text}"
                        candidate_row = _fetch_object_by_code(candidate)
                        if not candidate_row or _normalize_ref(candidate_row[2]) == _normalize_ref(name):
                            code = candidate
                            row = candidate_row
                            break
                    if row is None and code == base_code:
                        suffix_text = f"_{uuid.uuid4().hex[:8].upper()}"
                        code = f"{base_code[:100 - len(suffix_text)]}{suffix_text}"
                        row = _fetch_object_by_code(code)
                if not row:
                    object_id = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO objects (id, object_code, name, object_type_id, constructive_id, is_active, comment, review_tag)
                        VALUES (%s, %s, %s, %s, %s, true, %s, %s)
                        RETURNING id, object_code, name
                        """,
                        (
                            object_id,
                            code,
                            name[:255],
                            type_row[0],
                            constructive_id,
                            (body.comment or "created from report preview"),
                            "pending_admin_review",
                        ),
                    )
                    created = cur.fetchone()
                    row = (created[0], created[1], created[2], object_type_code, constructive_code, None)

                if pk_start is not None:
                    raw_pk = (body.pk_raw_text or _format_pk_db(pk_start) or "").strip() or None
                    cur.execute(
                        """
                        SELECT 1 FROM object_segments
                        WHERE object_id = %s AND pk_start = %s AND pk_end = %s
                        LIMIT 1
                        """,
                        (row[0], pk_start, pk_end),
                    )
                    if not cur.fetchone():
                        cur.execute(
                            """
                            INSERT INTO object_segments (object_id, pk_start, pk_end, pk_raw_text, comment, review_tag)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (row[0], pk_start, pk_end, raw_pk, "created from report preview", "pending_admin_review"),
                        )
                _upsert_reference_alias(cur, "object", body.alias_text, code)
                _reset_reference_caches()
                return {
                    "code": row[1],
                    "label": row[2],
                    "table": "objects",
                    "object_type_code": row[3],
                    "constructive_code": row[4],
                    "constructive_name": row[5],
                    "source": "created",
                }
    finally:
        conn.close()


def _ownership_from_owner(owner: Optional[str]) -> str:
    value = (owner or "").strip().lower().replace("ё", "е")
    # Quotes can be glued to the legal prefix (`ООО«ЖДС»`). Replacing them with
    # spaces preserves word boundaries so ЖДС is not misread as a subcontractor.
    value_norm = re.sub(r"[\"'«»“”„]+", " ", value)
    value_norm = re.sub(r"\s+", " ", value_norm).strip()
    if not value_norm:
        return "unknown"
    compact = re.sub(r"[^0-9a-zа-я]+", "", value_norm)
    own_markers = (
        "ждс",
        "ооо ждс",
        "желдорстрой",
        "ооо желдорстрой",
        "собственные силы",
        "собств. силы",
        "собственными силами",
        "свои силы",
        "силами ждс",
    )
    if (
        value_norm in own_markers
        or compact in {"ждс", "ооождс", "желдорстрой", "ооожелдорстрой"}
        or "собствен" in value_norm
        or re.search(r"(?:^|\b)(?:ооо\s+)?ждс(?:\b|$)", value_norm)
        or re.search(r"(?:^|\b)(?:ооо\s+)?желдорстрой(?:\b|$)", value_norm)
    ):
        return "own"
    return "hired"


def _is_external_equipment_owner(row: dict[str, Any]) -> bool:
    ownership = _clean_identifier(row.get("ownership_type")).lower()
    owner = _clean_identifier(row.get("owner") or row.get("contractor_name"))
    owner_ownership = _ownership_from_owner(owner) if owner else "unknown"
    if owner_ownership == "own":
        return False
    if ownership == "hired":
        return True
    return bool(owner and owner_ownership == "hired")


def _clean_identifier(value: Any) -> str:
    return str(value or "").strip().strip(";,. ")


_EQUIPMENT_PLATE_TRANSLIT = str.maketrans({
    "A": "А",
    "B": "В",
    "C": "С",
    "E": "Е",
    "H": "Н",
    "K": "К",
    "M": "М",
    "O": "О",
    "P": "Р",
    "T": "Т",
    "X": "Х",
    "Y": "У",
})


def _normalize_equipment_identifier(value: Any) -> str:
    raw = _clean_identifier(value).upper().replace("Ё", "Е")
    raw = raw.translate(_EQUIPMENT_PLATE_TRANSLIT)
    return re.sub(r"[^0-9A-ZА-Я]", "", raw)


_EQUIPMENT_FULL_PLATE_RE = re.compile(
    r"^(?:"
    r"[АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}|"
    r"[АВЕКМНОРСТУХ]?[0-9]{4}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}"
    r")$"
)


def _equipment_identifier_is_full_plate(value: Any) -> bool:
    return bool(_EQUIPMENT_FULL_PLATE_RE.fullmatch(_normalize_equipment_identifier(value)))


def _normalize_report_equipment_identifiers(row: dict[str, Any]) -> None:
    plate = _clean_identifier(row.get("plate_number") or row.get("plate"))
    unit_number = _clean_identifier(row.get("unit_number"))
    reported_number = _clean_identifier(row.get("reported_number"))
    if not plate and unit_number and _equipment_identifier_is_full_plate(unit_number):
        row["plate_number"] = unit_number
        row["plate"] = unit_number
        row["unit_number"] = None
        if not reported_number:
            row["reported_number"] = unit_number
        return
    if not plate and reported_number and _equipment_identifier_is_full_plate(reported_number):
        row["plate_number"] = reported_number
        row["plate"] = reported_number
    elif plate and not row.get("plate"):
        row["plate"] = plate


def _normalize_payload_equipment_identifiers(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        return
    for key in ("transport", "park"):
        rows = payload.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict):
                _normalize_report_equipment_identifiers(row)
    for key in ("main_works", "aux_works"):
        rows = payload.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            _normalize_report_equipment_identifiers(row)
            nested_rows = row.get("equipment")
            if not isinstance(nested_rows, list):
                continue
            for nested in nested_rows:
                if isinstance(nested, dict):
                    _normalize_report_equipment_identifiers(nested)


_EQUIPMENT_IDENTIFIER_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"б\s*/?\s*н|бн|борт(?:овой)?|"
    r"г\s*/?\s*н|гн|гос(?:номер)?|"
    r"с\s+номер(?:ом|ами)?|номер|№|no\.?|n"
    r")\s*[:№#-]?\s*",
    re.IGNORECASE,
)

_EQUIPMENT_TYPED_IDENTIFIER_RE = re.compile(
    r"^\s*(?:"
    r"экскаватор(?:-погрузчик)?|"
    r"каток|коток|виброкаток|"
    r"бульдозер|автогрейдер|грейдер|"
    r"самосвал|тягач|погрузчик"
    r")\s+[:№#-]?\s*(?P<identifier>-?[A-ZА-ЯЁ]?\d[0-9A-ZА-ЯЁ/-]*)\s*$",
    re.IGNORECASE,
)

_EQUIPMENT_IDENTIFIER_NORMALIZED_PREFIXES = (
    "БОРТОВОЙ",
    "БОРТ",
    "ГОСНОМЕР",
    "НОМЕР",
    "СНОМЕРОМ",
    "СНОМЕРАМИ",
    "БН",
    "ГН",
    "ГОС",
    "NO",
    "N",
)

_EQUIPMENT_IDENTIFIER_NORMALIZED_TYPE_PREFIXES = (
    "ЭКСКАВАТОРПОГРУЗЧИК",
    "ЭКСКАВАТОР",
    "ВИБРОКАТОК",
    "КАТОК",
    "КОТОК",
    "БУЛЬДОЗЕР",
    "АВТОГРЕЙДЕР",
    "ГРЕЙДЕР",
    "САМОСВАЛ",
    "ПОГРУЗЧИК",
    "ТЯГАЧ",
)


def _equipment_identifier_lookup_variants(value: Any) -> list[str]:
    raw = _clean_identifier(value)
    variants: list[str] = []

    def add(candidate: Any) -> None:
        normalized = _normalize_equipment_identifier(candidate)
        if normalized and normalized not in {"НД"} and normalized not in variants:
            variants.append(normalized)

    stripped = _EQUIPMENT_IDENTIFIER_PREFIX_RE.sub("", raw)
    if stripped != raw:
        add(stripped)
    typed = _EQUIPMENT_TYPED_IDENTIFIER_RE.match(raw)
    if typed:
        add(typed.group("identifier"))
    add(raw)
    normalized_raw = _normalize_equipment_identifier(raw)
    for prefix in _EQUIPMENT_IDENTIFIER_NORMALIZED_PREFIXES:
        if normalized_raw.startswith(prefix):
            tail = normalized_raw[len(prefix):]
            if len(tail) >= 2 and any(ch.isdigit() for ch in tail):
                add(tail)
    for prefix in _EQUIPMENT_IDENTIFIER_NORMALIZED_TYPE_PREFIXES:
        if normalized_raw.startswith(prefix):
            tail = normalized_raw[len(prefix):]
            if re.fullmatch(r"-?(?:\d|[A-ZА-Я]\d)[0-9A-ZА-Я/-]*", tail or ""):
                add(tail)
    return variants


def _equipment_identifier_keys(row: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    for prefix, fields in (("plate", ("plate_number", "plate")), ("unit", ("unit_number",))):
        for field in fields:
            value = _clean_identifier(row.get(field))
            if value and value.lower() not in {"н/д", "нд", "-", "—"}:
                variants = _equipment_identifier_lookup_variants(value)
                if not variants:
                    variants = [value.lower()]
                for normalized in variants:
                    key = f"{prefix}:{normalized}"
                    if key not in keys:
                        keys.append(key)
                break
    return keys


def _merge_equipment_payload_row(target: dict[str, Any], source: dict[str, Any]) -> None:
    target_status = _clean_identifier(target.get("status")).lower()
    source_status = _clean_identifier(source.get("status")).lower()
    if source_status and source_status != "unknown" and target_status in {"", "unknown"}:
        target["status"] = source.get("status")
    for field in (
        "equipment_type",
        "brand_model",
        "reported_number",
        "unit_number",
        "plate_number",
        "plate",
        "equipment_unit_id",
        "owner",
        "contractor_name",
        "ownership_type",
        "equipment_count",
        "hired_count",
        "count_units",
        "_equipment_row_key",
        "status_reason",
    ):
        if not target.get(field) and source.get(field):
            target[field] = source.get(field)
    if target.get("plate_number") and not target.get("plate"):
        target["plate"] = target.get("plate_number")
    if target.get("plate") and not target.get("plate_number"):
        target["plate_number"] = target.get("plate")
    source_comment = _clean_identifier(source.get("comment"))
    target_comment = _clean_identifier(target.get("comment"))
    if source_comment and source_comment != target_comment:
        target["comment"] = "; ".join(x for x in [target_comment, source_comment] if x)


def _coerce_equipment_count(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, str):
        text = value.strip().replace(" ", "").replace(",", ".")
        if not text:
            return 0
        value = text
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(number, 0)


def _row_equipment_count(row: dict[str, Any]) -> int:
    return _coerce_equipment_count(row.get("equipment_count") or row.get("hired_count") or row.get("count_units"))


def _source_line_hint(row: dict[str, Any]) -> str:
    source = row.get("_source")
    if isinstance(source, dict):
        text = str(source.get("text") or "").strip()
        if text:
            return text[:180]
    for field in ("vehicle", "equipment_type", "work_name", "constructive", "comment"):
        text = str(row.get(field) or "").strip()
        if text:
            return text[:180]
    return "строка техники без текста"


def _safe_equipment_insert_count(row: dict[str, Any], has_identifier: bool) -> int:
    if has_identifier:
        return 1
    equipment_count = _row_equipment_count(row)
    if equipment_count <= 0:
        return 0
    if equipment_count > MAX_HIRED_EQUIPMENT_EXPANSION:
        raise HTTPException(
            400,
            "Импорт остановлен: подозрительно большое количество наемной техники "
            f"({equipment_count}). Проверьте строку: {_source_line_hint(row)}",
        )
    return equipment_count


def _equipment_lookup_keys(row: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    row_key = _clean_identifier(row.get("_equipment_row_key"))
    if row_key:
        keys.append(f"row:{row_key}")
    master_id = _clean_identifier(row.get("equipment_unit_id"))
    if master_id:
        keys.append(f"master:{master_id}")
    keys.extend(_equipment_identifier_keys(row))
    return keys


def _register_equipment_ids(by_identifier: dict[str, list[str]], keys: list[str], equipment_ids: list[str]) -> None:
    for key in keys:
        bucket = by_identifier.setdefault(key, [])
        for equipment_id in equipment_ids:
            if equipment_id not in bucket:
                bucket.append(equipment_id)


def _lookup_equipment_ids(row: dict[str, Any], by_identifier: dict[str, list[str]]) -> list[str]:
    for key in _equipment_lookup_keys(row):
        ids = by_identifier.get(key)
        if ids:
            return list(ids)
    return []


def _lookup_equipment_id(row: dict[str, Any], by_identifier: dict[str, list[str]]) -> Optional[str]:
    ids = _lookup_equipment_ids(row, by_identifier)
    return ids[0] if ids else None


def _find_equipment_master_id_by_plate(cur, row: dict[str, Any]) -> Optional[str]:
    plate = _normalize_equipment_identifier(row.get("plate_number") or row.get("plate"))
    unit = _normalize_equipment_identifier(row.get("unit_number") or row.get("reported_number"))
    normalized_values = [value for value in dict.fromkeys([plate, unit]) if value and value not in {"НД", "НЕТ", "NONE", "NULL", "UNKNOWN"}]
    if not normalized_values:
        return None
    cur.execute(
        """
        SELECT eu.id::text AS id
        FROM equipment_unit_identifiers eui
        JOIN equipment_units eu ON eu.id = eui.equipment_unit_id
        WHERE eu.is_active IS NOT FALSE
          AND eui.identifier_type = 'plate'
          AND eui.normalized_value = ANY(%s)
        ORDER BY eu.source_date DESC NULLS LAST, eu.updated_at DESC NULLS LAST
        LIMIT 1
        """,
        (normalized_values,),
    )
    row_match = cur.fetchone()
    if row_match:
        return row_match["id"] if isinstance(row_match, dict) else row_match[0]
    cur.execute(
        """
        SELECT id::text AS id, plate_number
        FROM equipment_units
        WHERE is_active IS NOT FALSE
          AND NULLIF(BTRIM(plate_number), '') IS NOT NULL
        ORDER BY source_date DESC NULLS LAST, updated_at DESC NULLS LAST
        """
    )
    for candidate in cur.fetchall() or []:
        candidate_plate = _normalize_equipment_identifier(candidate["plate_number"] if isinstance(candidate, dict) else candidate[1])
        if candidate_plate in normalized_values:
            return candidate["id"] if isinstance(candidate, dict) else candidate[0]
    return None


def _resolve_report_equipment_master_id(cur, row: dict[str, Any]) -> Optional[str]:
    requested_id = _clean_identifier(row.get("equipment_unit_id"))
    requested_exists = False
    if requested_id and re.fullmatch(r"[0-9a-fA-F-]{36}", requested_id):
        cur.execute(
            """
            SELECT id::text AS id, is_active
            FROM equipment_units
            WHERE id = %s::uuid
            LIMIT 1
            """,
            (requested_id,),
        )
        found = cur.fetchone()
        if found:
            requested_exists = True
            found_id = found["id"] if isinstance(found, dict) else found[0]
            is_active = found["is_active"] if isinstance(found, dict) else found[1]
            if is_active is not False:
                return found_id

    fallback_id = _find_equipment_master_id_by_plate(cur, row)
    if fallback_id:
        return fallback_id
    return requested_id if requested_exists else None


def _equipment_lookup_values(row: dict[str, Any]) -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []
    reported = _clean_identifier(row.get("reported_number"))
    for reported_norm in _equipment_identifier_lookup_variants(reported):
        values.append(("reported", reported_norm))
    for identifier_type, fields in (("plate", ("plate_number", "plate")), ("unit", ("unit_number",))):
        for field in fields:
            raw = _clean_identifier(row.get(field))
            lookup_variants = _equipment_identifier_lookup_variants(raw)
            if lookup_variants:
                for normalized in lookup_variants:
                    values.append((identifier_type, normalized))
                break
    # If a report only gives a bare number, it may be either board or state
    # number. Search by normalized value across both identifier types.
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for identifier_type, normalized in values:
        key = f"{identifier_type}:{normalized}"
        if key not in seen:
            out.append((identifier_type, normalized))
            seen.add(key)
    return out


def _equipment_suggestion_identity_key(row: dict[str, Any]) -> str:
    plate = _normalize_equipment_identifier(row.get("plate_number") or row.get("plate"))
    if plate:
        return f"plate:{plate}"
    unit = _normalize_equipment_identifier(row.get("unit_number"))
    if unit:
        return f"unit:{unit}"
    master_id = _clean_identifier(row.get("equipment_unit_id") or row.get("id"))
    return f"master:{master_id}" if master_id else ""


def _equipment_matches_primary_identifier(row: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    """True only when the report number matches the master unit/plate itself.

    equipment_unit_identifiers can contain historical aliases. They are useful
    as manual hints, but should not silently rewrite a report row to a different
    board number.
    """
    suggestion_unit = _normalize_equipment_identifier(suggestion.get("unit_number"))
    suggestion_plate = _normalize_equipment_identifier(suggestion.get("plate_number") or suggestion.get("plate"))
    if not suggestion_unit and not suggestion_plate:
        return False
    for identifier_type, value in _equipment_lookup_values(row):
        if identifier_type == "unit" and suggestion_unit and value == suggestion_unit:
            return True
        if identifier_type == "plate" and suggestion_plate and value == suggestion_plate:
            return True
        if identifier_type == "reported" and value in {suggestion_unit, suggestion_plate}:
            return True
    return False


def _equipment_reported_identifier_fragments(row: dict[str, Any]) -> list[str]:
    fragments: list[str] = []
    for identifier_type, value in _equipment_lookup_values(row):
        if identifier_type != "reported":
            continue
        if value.isdigit() and 2 <= len(value) <= 4:
            fragments.append(value)
        elif len(value) >= 4 and any(ch.isdigit() for ch in value):
            fragments.append(value)
    return list(dict.fromkeys(fragments))


def _equipment_matches_primary_identifier_fragment(row: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    suggestion_values = [
        _normalize_equipment_identifier(suggestion.get("unit_number")),
        _normalize_equipment_identifier(suggestion.get("plate_number") or suggestion.get("plate")),
    ]
    suggestion_values = [value for value in suggestion_values if value]
    for fragment in _equipment_reported_identifier_fragments(row):
        if any(fragment in value or value in fragment for value in suggestion_values):
            return True
    return False


def _equipment_suggestion_is_stale_alias(row: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    if suggestion.get("primary_identifier_match"):
        return False
    fragments = _equipment_reported_identifier_fragments(row)
    if not fragments:
        return False
    return not _equipment_matches_primary_identifier_fragment(row, suggestion)


def _equipment_requested_type_terms(row: dict[str, Any]) -> list[str]:
    text = " ".join(
        _clean_identifier(row.get(field))
        for field in ("equipment_type", "vehicle", "reported_number", "unit_number")
        if _clean_identifier(row.get(field))
    ).lower().replace("ё", "е")
    if not text:
        return []
    terms: list[str] = []

    def add(*values: str) -> None:
        for value in values:
            if value and value not in terms:
                terms.append(value)

    if re.search(r"(?:^|\W)(?:вибро)?к[ао]ток(?:\W|$)", text):
        add("каток", "виброкаток")
    if "экскаватор" in text:
        add("экскаватор")
    if "сваеб" in text or "буров" in text or "кбург" in text:
        add("сваеб", "буров", "кбург")
    if "кран" in text:
        add("кран")
    if "автобус" in text or "вахтов" in text:
        add("автобус", "вахтов")
    if "бульдозер" in text:
        add("бульдозер")
    if "автогрейдер" in text or re.search(r"(?:^|\W)грейдер(?:\W|$)", text):
        add("автогрейдер", "грейдер")
    if "самосвал" in text or any(token in text for token in ("dump", "faw", "shacman", "шахман")):
        add("самосвал", "dump", "faw", "shacman", "шахман")
    if "тягач" in text:
        add("тягач")
    if "погрузчик" in text:
        add("погрузчик")
    return terms


_EQUIPMENT_GENERIC_MODEL_TOKENS = {
    "автобус",
    "автогрейдер",
    "борт",
    "бортовой",
    "буровая",
    "бульдозер",
    "вахтовый",
    "виброкаток",
    "гос",
    "госномер",
    "каток",
    "коток",
    "кран",
    "машина",
    "номер",
    "погрузчик",
    "седельный",
    "самосвал",
    "сваебойная",
    "сваебойно",
    "тягач",
    "экскаватор",
    "unit",
    "plate",
}


def _equipment_requested_model_terms(row: dict[str, Any]) -> list[str]:
    text = " ".join(
        _clean_identifier(row.get(field))
        for field in ("brand_model", "vehicle", "equipment_type", "reported_number")
        if _clean_identifier(row.get(field))
    ).lower().replace("ё", "е")
    terms: list[str] = []
    for token in re.findall(r"[0-9a-zа-я]+", text):
        if len(token) < 3 or token.isdigit() or token in _EQUIPMENT_GENERIC_MODEL_TOKENS:
            continue
        if token not in terms:
            terms.append(token)
    return terms


def _equipment_suggestion_matches_requested_model(row: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    terms = _equipment_requested_model_terms(row)
    if not terms:
        return False
    candidate = " ".join(
        _clean_identifier(suggestion.get(field)).lower().replace("ё", "е")
        for field in ("equipment_type", "brand_model")
        if _clean_identifier(suggestion.get(field))
    )
    return any(term in candidate for term in terms)


def _equipment_suggestion_matches_requested_type(row: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    terms = _equipment_requested_type_terms(row)
    if not terms:
        return False
    candidate = " ".join(
        _clean_identifier(suggestion.get(field)).lower().replace("ё", "е")
        for field in ("equipment_type", "brand_model")
        if _clean_identifier(suggestion.get(field))
    )
    return any(term in candidate for term in terms)


def _equipment_preferred_type_patterns(row: dict[str, Any]) -> list[str]:
    """Priority boost for ambiguous number matches.

    The same short number can match several machines. Reports use different
    defaults by context: transport rows normally mean dump trucks, while work
    rows normally mean excavators/bulldozers/graders. The boost is intentionally
    only one ORDER BY tier; all other active matches are still returned as lower
    priority suggestions for operator review.
    """
    patterns: list[str] = []
    explicit_type = _clean_identifier(row.get("equipment_type") or row.get("vehicle")).lower().replace("ё", "е")
    for term in _equipment_requested_type_terms(row):
        patterns.append(f"%{term}%")
    if explicit_type:
        patterns.append(f"%{explicit_type}%")
    context = _clean_identifier(row.get("_equipment_context") or row.get("context")).lower()
    if context == "transport":
        patterns.extend(["%самосвал%", "%dump%", "%faw%", "%shacman%", "%шахман%"])
    elif context == "work":
        patterns.extend(["%экскаватор%", "%каток%", "%виброкаток%", "%бульдозер%", "%автогрейдер%", "%грейдер%"])
    seen: set[str] = set()
    out: list[str] = []
    for pattern in patterns:
        if pattern and pattern not in seen:
            out.append(pattern)
            seen.add(pattern)
    return out


def _equipment_suggestions(row: dict[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    if _is_external_equipment_owner(row):
        return []
    lookup_values = _equipment_lookup_values(row)
    if not lookup_values:
        return []
    normalized_values = list(dict.fromkeys(value for _, value in lookup_values))
    preferred_type_patterns = _equipment_preferred_type_patterns(row)
    has_requested_type = bool(_equipment_requested_type_terms(row))
    has_requested_model = bool(_equipment_requested_model_terms(row))
    partial_values: list[str] = []
    for identifier_type, value in lookup_values:
        if identifier_type != "reported":
            continue
        if value.isdigit() and 2 <= len(value) <= 4:
            partial_values.append(value)
        elif len(value) >= 4 and any(ch.isdigit() for ch in value):
            partial_values.append(value)
    partial_patterns = [f"%{value}%" for value in dict.fromkeys(partial_values)]
    query_limit = max(1, min(max(limit * 4, limit), 80))
    try:
        rows = query(
            """
            SELECT
              eu.id::text AS id,
              eu.equipment_type,
              eu.brand_model,
              eu.unit_number,
              eu.plate_number,
              eu.ownership_type,
              eu.contractor_name,
              eu.status,
              eu.source_name,
              eu.source_date,
              eu.location,
              eu.updated_at,
              array_agg(DISTINCT eui.identifier_type || ':' || eui.raw_value) AS matched_identifiers
            FROM equipment_unit_identifiers eui
            JOIN equipment_units eu ON eu.id = eui.equipment_unit_id
            WHERE eu.is_active = true
              AND (
                eui.normalized_value = ANY(%s)
                OR (
                  %s::text[] <> '{}'
                  AND eui.normalized_value LIKE ANY(%s::text[])
                )
              )
            GROUP BY eu.id
            ORDER BY
              CASE WHEN BOOL_OR(eui.normalized_value = ANY(%s)) THEN 0 ELSE 1 END,
              CASE
                WHEN %s::text[] <> '{}' AND LOWER(COALESCE(eu.equipment_type, '') || ' ' || COALESCE(eu.brand_model, '')) LIKE ANY(%s::text[]) THEN 0
                ELSE 1
              END,
              CASE eu.status WHEN 'working' THEN 0 WHEN 'standby' THEN 1 WHEN 'repair' THEN 2 ELSE 3 END,
              eu.source_date DESC NULLS LAST,
              eu.updated_at DESC NULLS LAST,
              eu.equipment_type,
              eu.unit_number NULLS LAST,
              eu.plate_number NULLS LAST
            LIMIT %s
            """,
            [
                normalized_values,
                partial_patterns,
                partial_patterns,
                normalized_values,
                preferred_type_patterns,
                preferred_type_patterns,
                query_limit,
            ],
        )
    except Exception:
        return []
    suggestions: list[dict[str, Any]] = []
    seen_logical_units: set[str] = set()
    for r in rows:
        label_parts = [
            r.get("equipment_type"),
            r.get("brand_model"),
            f"б/н {r.get('unit_number')}" if r.get("unit_number") else None,
            f"г/н {r.get('plate_number')}" if r.get("plate_number") else None,
        ]
        suggestion = {
            "id": r.get("id"),
            "equipment_unit_id": r.get("id"),
            "label": " · ".join(str(x) for x in label_parts if x),
            "equipment_type": r.get("equipment_type"),
            "brand_model": r.get("brand_model"),
            "unit_number": r.get("unit_number"),
            "plate_number": r.get("plate_number"),
            "ownership_type": r.get("ownership_type"),
            "contractor_name": r.get("contractor_name"),
            "owner": r.get("contractor_name"),
            "status": r.get("status"),
            "source": r.get("source_name"),
            "location": r.get("location"),
            "matched_identifiers": r.get("matched_identifiers") or [],
        }
        suggestion["primary_identifier_match"] = _equipment_matches_primary_identifier(row, suggestion)
        suggestion["primary_identifier_fragment_match"] = _equipment_matches_primary_identifier_fragment(row, suggestion)
        if _equipment_suggestion_is_stale_alias(row, suggestion):
            continue
        if (
            has_requested_type
            and not suggestion["primary_identifier_match"]
            and not _equipment_suggestion_matches_requested_type(row, suggestion)
        ):
            continue
        logical_key = _equipment_suggestion_identity_key(suggestion)
        if logical_key and logical_key in seen_logical_units:
            continue
        if logical_key:
            seen_logical_units.add(logical_key)
        suggestions.append(suggestion)
        if len(suggestions) >= max(1, limit):
            break
    if has_requested_type:
        typed_suggestions = [
            suggestion
            for suggestion in suggestions
            if _equipment_suggestion_matches_requested_type(row, suggestion)
        ]
        if typed_suggestions:
            suggestions = typed_suggestions
    if has_requested_model:
        model_suggestions = [
            suggestion
            for suggestion in suggestions
            if _equipment_suggestion_matches_requested_model(row, suggestion)
        ]
        if model_suggestions:
            suggestions = model_suggestions
    suggestions.sort(
        key=lambda item: (
            0 if item.get("primary_identifier_match") else 1,
            0 if item.get("primary_identifier_fragment_match") else 1,
        )
    )
    return suggestions


def _apply_equipment_suggestion(row: dict[str, Any], suggestion: dict[str, Any]) -> None:
    row["equipment_unit_id"] = suggestion.get("equipment_unit_id") or suggestion.get("id")
    row["equipment_type"] = suggestion.get("equipment_type") or row.get("equipment_type")
    row["brand_model"] = suggestion.get("brand_model") or row.get("brand_model")
    row["vehicle"] = " ".join(x for x in [row.get("equipment_type"), row.get("brand_model")] if x)
    row["reported_number"] = row.get("reported_number") or suggestion.get("unit_number") or suggestion.get("plate_number")
    row["unit_number"] = suggestion.get("unit_number") or row.get("unit_number")
    row["plate_number"] = suggestion.get("plate_number") or row.get("plate_number") or row.get("plate")
    row["plate"] = row.get("plate_number")
    row["ownership_type"] = suggestion.get("ownership_type") or row.get("ownership_type")
    row["contractor_name"] = suggestion.get("contractor_name") or row.get("contractor_name")
    row["owner"] = row.get("owner") or suggestion.get("owner") or suggestion.get("contractor_name")
    current_status = _clean_identifier(row.get("status")).lower()
    if not current_status or current_status == "unknown":
        row["status"] = suggestion.get("status") or row.get("status")


def _enrich_equipment_row(row: dict[str, Any]) -> None:
    _normalize_report_equipment_identifiers(row)
    if _is_external_equipment_owner(row):
        row["equipment_suggestions"] = []
        row["equipment_match_status"] = "external_owner"
        row["ownership_type"] = row.get("ownership_type") or "hired"
        row["contractor_name"] = row.get("contractor_name") or row.get("owner")
        return
    suggestions = _equipment_suggestions(row)
    row["equipment_suggestions"] = suggestions
    if not suggestions:
        row["equipment_match_status"] = "unmatched" if _equipment_lookup_values(row) else "no_number"
        return
    selected_id = _clean_identifier(row.get("equipment_unit_id"))
    if selected_id:
        selected = next(
            (
                suggestion
                for suggestion in suggestions
                if _clean_identifier(suggestion.get("equipment_unit_id") or suggestion.get("id")) == selected_id
            ),
            None,
        )
        if selected:
            _apply_equipment_suggestion(row, selected)
            row["equipment_match_status"] = "resolved"
            return
    primary_type_matches = [
        suggestion
        for suggestion in suggestions
        if (
            (suggestion.get("primary_identifier_match") or suggestion.get("primary_identifier_fragment_match"))
            and _equipment_suggestion_matches_requested_type(row, suggestion)
        )
    ]
    if len(primary_type_matches) == 1:
        _apply_equipment_suggestion(row, primary_type_matches[0])
        row["equipment_match_status"] = "resolved"
        return
    if len(suggestions) == 1 and suggestions[0].get("primary_identifier_match"):
        _apply_equipment_suggestion(row, suggestions[0])
        row["equipment_match_status"] = "resolved"
        return
    row["equipment_match_status"] = "ambiguous"


@router.get("/equipment-search")
def equipment_search(
    q: str = "",
    owner: str = "",
    contractor_name: str = "",
    ownership_type: str = "",
    equipment_type: str = "",
    vehicle: str = "",
    context: str = "",
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Search equipment by the exact number typed in report review.

    The typed number is intentionally treated as ambiguous: it may be a board
    number or a shortened state plate fragment.
    """
    number = _clean_identifier(q)
    if len(number) < 2:
        return []
    return _equipment_suggestions(
        {
            "reported_number": number,
            "owner": owner,
            "contractor_name": contractor_name,
            "ownership_type": ownership_type,
            "equipment_type": equipment_type,
            "vehicle": vehicle,
            "_equipment_context": context,
        },
        limit=limit,
    )


def _format_pk_db(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        raw = float(value)
    except (TypeError, ValueError):
        return None
    pk = int(raw // 100)
    plus = raw - pk * 100
    if abs(plus - round(plus)) < 0.005:
        plus_text = f"{int(round(plus)):02d}"
    else:
        whole = int(plus)
        frac = f"{plus - whole:.2f}".split(".", 1)[1]
        plus_text = f"{whole:02d},{frac}"
    return f"ПК{pk}+{plus_text}"


_STOCKPILE_MATERIAL_LABELS = {
    "SAND": "песок",
    "COARSE_SAND": "крупный песок",
    "SHPGS": "ЩПГС",
    "SOIL": "грунт",
    "PEAT": "торф",
}


def _stockpile_material_label(material_code: Optional[str], raw_material: Any = None) -> str:
    code = (material_code or "").strip().upper()
    if code in _STOCKPILE_MATERIAL_LABELS:
        return _STOCKPILE_MATERIAL_LABELS[code]
    raw = re.sub(r"\s+", " ", str(raw_material or "").strip())
    raw = re.sub(r"(?i)^накопител[ья]?\s+", "", raw).strip()
    return raw or (code if code else "материал")


def _stockpile_canonical_name(material_code: Optional[str], pk_value: Any, raw_material: Any = None) -> str:
    """Owner-approved stockpile naming: `Накопитель <материал> ПК****`."""
    label = _stockpile_material_label(material_code, raw_material)
    pk_label = _format_pk_db(pk_value) or str(pk_value or "ПК н/д")
    pk_short = re.sub(r"\+00(?:[,]0+)?$", "", pk_label)
    return f"Накопитель {label} {pk_short}"


def _pile_length_label(pile_type: Optional[str]) -> str:
    value = (pile_type or "").strip()
    if not value:
        return "н/д"
    text = value.upper().replace("C", "С")
    # Составные сваи в каталоге хранятся как две марки через '+', например
    # С140.35-НС.6+С140.35-ВС.6. Для длины нужно суммировать обе части:
    # 140 дм + 140 дм = 28 м, а не показывать только первую 14 м.
    if ";" not in text:
        matches = [int(m) for m in re.findall(r"С\s*(\d{2,3})", text, re.I)]
        if matches:
            length_m = sum(matches) / 10
            return f"{length_m:g} м"
        direct = re.fullmatch(r"\s*(\d{1,2})(?:[\.,]0+)?\s*(?:м)?\s*", text, re.I)
        if direct:
            return f"{int(direct.group(1)):g} м"
    return value or "н/д"


def _strip_composite_ready_marker(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"\bсоставн\w*\s+(?:свая\s+)?готов\w*\b", "", text, flags=re.I)
    text = re.sub(r"\s*[-;,.]\s*(?=$)", "", text).strip()
    text = re.sub(r"\s{2,}", " ", text)
    return text


def _section_number_from_code(code: Optional[str]) -> Optional[int]:
    m = re.search(r"UCH_(\d+)", code or "")
    return int(m.group(1)) if m else None


def _iso_date(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None and hasattr(value, "isoformat") else (str(value) if value is not None else None)


def _selected_reference_candidate(
    kind: str,
    code: Optional[str],
    text: Optional[str] = None,
    *,
    section_code: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    if not code:
        return None
    candidates = _reference_candidates(kind, text or code, code, section_code=section_code, limit=12)
    code_norm = _normalize_ref(code)
    for candidate in candidates:
        if code_norm and code_norm == _normalize_ref(candidate.get("code")):
            return candidate
    return None


def _reference_candidate_for_code(kind: str, code: Optional[str]) -> Optional[dict[str, Any]]:
    code_text = str(code or "").strip()
    if not code_text:
        return None
    code_key = code_text.upper()
    for entry in load_reference_catalog().get(kind, []):
        entry_code = str(entry.get("code") or "").strip()
        entry_label = str(entry.get("label") or "").strip()
        if not entry_code:
            continue
        if entry_code.upper() == code_key:
            return {
                "code": entry_code,
                "label": entry_label or entry_code,
                "score": 1.0,
                "source": "selected",
                "table": entry.get("table"),
                "default_unit": entry.get("default_unit"),
                "analytics_tag": entry.get("analytics_tag"),
                "productivity_enabled": entry.get("productivity_enabled"),
                "object_type_code": entry.get("object_type_code"),
                "constructive_code": entry.get("constructive_code"),
                "constructive_name": entry.get("constructive_name"),
                "section_code": entry.get("section_code"),
                "pk_start": entry.get("pk_start"),
                "pk_end": entry.get("pk_end"),
                "pk_raw_text": entry.get("pk_raw_text"),
            }
    return None


def _prepend_reference_candidate(
    candidates: list[dict[str, Any]],
    selected: Optional[dict[str, Any]],
    *,
    limit: int = 12,
) -> list[dict[str, Any]]:
    if not selected:
        return candidates
    selected_code_norm = _normalize_ref(selected.get("code"))
    selected_code_compact = _compact_ref(selected.get("code"))
    merged = [dict(selected)]
    for candidate in candidates or []:
        candidate_code = candidate.get("code")
        if (
            selected_code_norm
            and (
                selected_code_norm == _normalize_ref(candidate_code)
                or selected_code_compact == _compact_ref(candidate_code)
            )
        ):
            continue
        merged.append(candidate)
    return merged[:limit]


def _manual_reference_code_and_suggestions(
    kind: str,
    text: Optional[str],
    existing_code: Optional[str],
    candidates: list[dict[str, Any]],
    *,
    limit: int = 12,
) -> tuple[Optional[str], list[dict[str, Any]]]:
    """Preserve an operator-selected code while refreshing its display metadata."""
    selected_code = str(existing_code or "").strip()
    if not selected_code:
        return None, candidates
    selected = _reference_candidate_for_code(kind, selected_code)
    if selected:
        return selected.get("code"), _prepend_reference_candidate(candidates, selected, limit=limit)
    selected = {
        "code": selected_code,
        "label": str(text or selected_code),
        "score": 1.0,
        "source": "selected",
        "table": {"material": "materials", "object": "objects", "work_type": "work_types"}.get(kind),
    }
    return selected_code, _prepend_reference_candidate(candidates, selected, limit=limit)


def _set_payload_reference_manual(
    row: dict[str, Any],
    *,
    kind: str,
    code_key: str,
    selection_mode_key: str,
    suggestions_key: Optional[str] = None,
    code: Optional[str] = None,
    label: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> bool:
    selected_code = str(code if code is not None else row.get(code_key) or "").strip()
    if not selected_code:
        return False
    row[code_key] = selected_code
    row[selection_mode_key] = "manual"
    row[f"{code_key}_manual"] = True
    if suggestions_key:
        selected = _reference_candidate_for_code(kind, selected_code) or {
            "code": selected_code,
            "label": str(label or selected_code),
            "score": 1.0,
            "source": "stored_db",
            "table": {"material": "materials", "object": "objects", "work_type": "work_types"}.get(kind),
        }
        if extra:
            selected.update({key: value for key, value in extra.items() if value is not None})
        existing = row.get(suggestions_key) if isinstance(row.get(suggestions_key), list) else []
        row[suggestions_key] = _prepend_reference_candidate(existing, selected, limit=12)
    return True


def _mark_existing_payload_reference_codes_manual(payload: dict[str, Any]) -> dict[str, Any]:
    """Treat codes received in a reviewed payload as fixed operator choices."""
    if not isinstance(payload, dict):
        return payload
    for unit in payload.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        for trip in unit.get("trips") or []:
            if not isinstance(trip, dict):
                continue
            _set_payload_reference_manual(
                trip,
                kind="material",
                code_key="material_code",
                selection_mode_key="material_selection_mode",
                suggestions_key="material_suggestions",
                label=trip.get("material"),
            )
            _set_payload_reference_manual(
                trip,
                kind="object",
                code_key="from_object_code",
                selection_mode_key="from_object_selection_mode",
                suggestions_key="from_object_suggestions",
                label=trip.get("from"),
            )
            _set_payload_reference_manual(
                trip,
                kind="object",
                code_key="to_object_code",
                selection_mode_key="to_object_selection_mode",
                suggestions_key="to_object_suggestions",
                label=trip.get("to"),
            )

    for collection_key in ("main_works", "aux_works"):
        for work in payload.get(collection_key) or []:
            if not isinstance(work, dict):
                continue
            _set_payload_reference_manual(
                work,
                kind="work_type",
                code_key="work_type_code",
                selection_mode_key="work_type_selection_mode",
                suggestions_key="work_type_suggestions",
                label=work.get("work_name"),
            )
            object_code = work.get("object_code") or work.get("constructive_code")
            if object_code:
                work["object_code"] = object_code
                work["constructive_code"] = object_code
            _set_payload_reference_manual(
                work,
                kind="object",
                code_key="object_code",
                selection_mode_key="object_selection_mode",
                suggestions_key="object_suggestions",
                label=work.get("constructive"),
            )
            if work.get("object_code"):
                work["constructive_code"] = work.get("object_code")

    for stockpile in payload.get("stockpiles") or []:
        if isinstance(stockpile, dict):
            _set_payload_reference_manual(
                stockpile,
                kind="material",
                code_key="material_code",
                selection_mode_key="material_selection_mode",
                suggestions_key="material_suggestions",
                label=stockpile.get("material"),
            )
    return payload


def _refresh_payload_reference_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Attach current DB reference metadata to editable report payloads.

    Pending reports can live for days while reference cards change. The review UI
    must show current work tags/default units by selected work_type_code, not the
    stale JSON captured when the report was first uploaded.
    """
    header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
    section_code = header.get("section_code")
    aliases = load_aliases()
    candidates_cache: dict[tuple[str, str, str, str, int], list[dict[str, Any]]] = {}

    def cached_candidates(
        kind: str,
        text: Optional[str],
        existing_code: Optional[str],
        *,
        limit: int = 12,
        ) -> list[dict[str, Any]]:
        key = (kind, str(text or ""), str(existing_code or ""), str(section_code or ""), limit)
        if key not in candidates_cache:
            candidates_cache[key] = _reference_candidates(
                kind,
                text,
                existing_code,
                section_code=section_code,
                limit=limit,
            )
        return candidates_cache[key]

    def resolve_reference(
        kind: str,
        text: Optional[str],
        existing_code: Optional[str],
        *,
        limit: int = 12,
    ) -> tuple[Optional[str], list[dict[str, Any]]]:
        alias_code = _resolve(aliases, kind, text)
        preferred_code = alias_code or existing_code
        candidates = cached_candidates(kind, text, preferred_code, limit=limit)
        if alias_code and existing_code and alias_code != existing_code:
            text_norm = _normalize_ref(text)
            existing_norm = _normalize_ref(existing_code)
            existing_is_exact_canonical = any(
                existing_norm
                and existing_norm == _normalize_ref(candidate.get("code"))
                and text_norm
                and text_norm in {
                    _normalize_ref(candidate.get("label")),
                    _normalize_ref(candidate.get("code")),
                }
                for candidate in candidates
            )
            if existing_is_exact_canonical:
                preferred_code = existing_code
        code = _select_reference_code(kind, preferred_code, candidates, section_code=section_code)
        return code, candidates

    for unit in payload.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        for trip in unit.get("trips") or []:
            if not isinstance(trip, dict):
                continue
            for kind, text_key, code_key, suggestions_key, selection_mode_key in (
                ("material", "material", "material_code", "material_suggestions", "material_selection_mode"),
                ("object", "from", "from_object_code", "from_object_suggestions", "from_object_selection_mode"),
                ("object", "to", "to_object_code", "to_object_suggestions", "to_object_selection_mode"),
            ):
                if _is_manual_reference_selection(trip, selection_mode_key, f"{code_key}_manual"):
                    code, suggestions = _manual_reference_code_and_suggestions(
                        kind,
                        trip.get(text_key),
                        trip.get(code_key),
                        cached_candidates(kind, trip.get(text_key), trip.get(code_key), limit=12),
                        limit=12,
                    )
                    if not code:
                        code, suggestions = resolve_reference(
                            kind,
                            trip.get(text_key),
                            trip.get(code_key),
                            limit=12,
                        )
                else:
                    code, suggestions = resolve_reference(
                        kind,
                        trip.get(text_key),
                        trip.get(code_key),
                        limit=12,
                    )
                if code:
                    trip[code_key] = code
                trip[suggestions_key] = suggestions

    for collection_key in ("main_works", "aux_works"):
        for work in payload.get(collection_key) or []:
            if not isinstance(work, dict):
                continue
            if _is_manual_reference_selection(work, "work_type_selection_mode", "work_type_code_manual"):
                work_code, work_suggestions = _manual_reference_code_and_suggestions(
                    "work_type",
                    work.get("work_name"),
                    work.get("work_type_code"),
                    cached_candidates("work_type", work.get("work_name"), work.get("work_type_code"), limit=12),
                    limit=12,
                )
                if not work_code:
                    work_code, work_suggestions = resolve_reference(
                        "work_type",
                        work.get("work_name"),
                        work.get("work_type_code"),
                        limit=12,
                    )
            else:
                work_code, work_suggestions = resolve_reference(
                    "work_type",
                    work.get("work_name"),
                    work.get("work_type_code"),
                    limit=12,
                )
            work["work_type_suggestions"] = work_suggestions
            if work_code:
                work["work_type_code"] = work_code
            work_code_norm = _normalize_ref(work_code)
            work_code_compact = _compact_ref(work_code)
            selected_work = next(
                (
                    suggestion
                    for suggestion in work_suggestions
                    if work_code_norm and (
                        work_code_norm == _normalize_ref(suggestion.get("code"))
                        or work_code_norm == _normalize_ref(suggestion.get("label"))
                        or work_code_compact == _compact_ref(suggestion.get("code"))
                    )
                ),
                None,
                )
            if selected_work:
                work["analytics_tag"] = selected_work.get("analytics_tag")
                if selected_work.get("default_unit"):
                    work["unit"] = selected_work.get("default_unit")
                if selected_work.get("productivity_enabled") is not None:
                    work["productivity_enabled"] = bool(selected_work.get("productivity_enabled"))
            object_code = work.get("object_code") or work.get("constructive_code")
            if _is_manual_reference_selection(work, "object_selection_mode", "object_code_manual"):
                object_code, object_suggestions = _manual_reference_code_and_suggestions(
                    "object",
                    work.get("constructive"),
                    object_code,
                    cached_candidates("object", work.get("constructive"), object_code, limit=12),
                    limit=12,
                )
                if not object_code:
                    object_code, object_suggestions = resolve_reference(
                        "object",
                        work.get("constructive"),
                        object_code,
                        limit=12,
                    )
            else:
                object_code, object_suggestions = resolve_reference(
                    "object",
                    work.get("constructive"),
                    object_code,
                    limit=12,
                )
            work["object_suggestions"] = object_suggestions
            if object_code:
                work["object_code"] = object_code
                work["constructive_code"] = object_code

    for stockpile in payload.get("stockpiles") or []:
        if not isinstance(stockpile, dict):
            continue
        if _is_manual_reference_selection(stockpile, "material_selection_mode", "material_code_manual"):
            material_code, material_suggestions = _manual_reference_code_and_suggestions(
                "material",
                stockpile.get("material"),
                stockpile.get("material_code"),
                cached_candidates("material", stockpile.get("material"), stockpile.get("material_code"), limit=12),
                limit=12,
            )
            if not material_code:
                material_code, material_suggestions = resolve_reference(
                    "material",
                    stockpile.get("material"),
                    stockpile.get("material_code"),
                    limit=12,
                )
        else:
            material_code, material_suggestions = resolve_reference(
                "material",
                stockpile.get("material"),
                stockpile.get("material_code"),
                limit=12,
            )
        if material_code:
            stockpile["material_code"] = material_code
        stockpile["material_suggestions"] = material_suggestions
    return payload


def _coerce_payload_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _payload_transport_trips(payload: dict[str, Any]) -> list[dict[str, Any]]:
    trips: list[dict[str, Any]] = []
    for unit in payload.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        for trip in unit.get("trips") or []:
            if isinstance(trip, dict):
                trips.append(trip)
    return trips


def _payload_regular_work_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for collection_key in ("main_works", "aux_works"):
        for work in payload.get(collection_key) or []:
            if isinstance(work, dict):
                rows.append(work)
    return rows


def _payload_pile_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [row for row in payload.get("piles") or [] if isinstance(row, dict)]


def _overlay_text_key(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip().casefold().replace("ё", "е")


def _overlay_unit_key(value: Any) -> str:
    return _overlay_text_key(value)


def _overlay_decimal_key(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    raw = str(value).replace("\xa0", " ").replace(" ", "").replace(",", ".").strip()
    if not raw:
        return None
    try:
        decimal_value = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    if not decimal_value.is_finite():
        return None
    normalized = format(decimal_value.normalize(), "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def _overlay_int_key(value: Any) -> Optional[str]:
    decimal_key = _overlay_decimal_key(value)
    if decimal_key is None:
        return None
    try:
        decimal_value = Decimal(decimal_key)
    except (InvalidOperation, ValueError):
        return None
    if decimal_value != decimal_value.to_integral_value():
        return None
    return str(int(decimal_value))


def _work_overlay_signature(row: dict[str, Any], *, db_row: bool = False) -> Optional[tuple[str, str, str]]:
    text = _overlay_text_key(row.get("work_name_raw") if db_row else (row.get("work_name") or row.get("name") or row.get("work_name_raw")))
    volume = _overlay_decimal_key(row.get("volume"))
    unit = _overlay_unit_key(row.get("unit") or row.get("default_unit"))
    if not text or volume is None or not unit:
        return None
    return (text, volume, unit)


def _transport_overlay_signature(row: dict[str, Any], *, db_row: bool = False) -> Optional[tuple[str, str, str]]:
    volume = _overlay_decimal_key(row.get("volume"))
    unit = _overlay_unit_key(row.get("unit"))
    trip_count = _overlay_int_key(row.get("trip_count"))
    if volume is None or not unit or trip_count is None:
        return None
    return (volume, unit, trip_count)


def _unique_overlay_pairs(
    payload_rows: list[dict[str, Any]],
    db_rows: list[dict[str, Any]],
    payload_signature,
    db_signature,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    payload_by_signature: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    db_by_signature: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for row in payload_rows:
        signature = payload_signature(row)
        if signature is not None:
            payload_by_signature.setdefault(signature, []).append(row)
    for row in db_rows:
        signature = db_signature(row)
        if signature is not None:
            db_by_signature.setdefault(signature, []).append(row)
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for signature, payload_matches in payload_by_signature.items():
        db_matches = db_by_signature.get(signature) or []
        if len(payload_matches) == 1 and len(db_matches) == 1:
            pairs.append((payload_matches[0], db_matches[0]))
    return pairs


def _overlay_row_snapshot(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)


def _overlay_payload_with_report_db_facts(report_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Restore editable payload references from materialized DB facts when safe."""
    if not isinstance(payload, dict):
        return payload
    payload = deepcopy(payload)
    summary: dict[str, Any] = {
        "source": "daily_report_fact_rows",
        "report_id": str(report_id),
        "transport_trips": {"payload": 0, "db": 0, "updated": 0},
        "regular_works": {"payload": 0, "db": 0, "updated": 0},
        "piles": {"payload": 0, "db": 0, "updated": 0},
        "warnings": [],
    }

    transport_trips = _payload_transport_trips(payload)
    transport_rows = query(
        """
        SELECT
          mm.volume,
          mm.unit,
          mm.trip_count,
          m.code AS material_code,
          m.name AS material_name,
          fo.object_code AS from_object_code,
          fo.name AS from_name,
          tob.object_code AS to_object_code,
          tob.name AS to_name,
          mmeu.work_hours
        FROM material_movements mm
        LEFT JOIN materials m ON m.id = mm.material_id
        LEFT JOIN objects fo ON fo.id = mm.from_object_id
        LEFT JOIN objects tob ON tob.id = mm.to_object_id
        LEFT JOIN LATERAL (
          SELECT work_hours
          FROM material_movement_equipment_usage
          WHERE material_movement_id = mm.id
          ORDER BY created_at NULLS LAST
          LIMIT 1
        ) mmeu ON true
        WHERE mm.daily_report_id = %s
        ORDER BY mm.created_at, mm.id
        """,
        [report_id],
    )
    summary["transport_trips"]["payload"] = len(transport_trips)
    summary["transport_trips"]["db"] = len(transport_rows)
    if transport_trips and transport_rows:
        transport_pairs = _unique_overlay_pairs(
            transport_trips,
            transport_rows,
            _transport_overlay_signature,
            lambda row: _transport_overlay_signature(row, db_row=True),
        )
        if len(transport_pairs) < min(len(transport_trips), len(transport_rows)):
            summary["warnings"].append(
                "transport_unmatched_or_ambiguous: "
                f"payload={len(transport_trips)} db={len(transport_rows)} matched={len(transport_pairs)}"
            )
        for trip, row in transport_pairs:
            before = _overlay_row_snapshot(trip)
            changed = False
            db_work_hours = float(row["work_hours"]) if row.get("work_hours") is not None else None
            changed = trip.get("work_hours") != db_work_hours or changed
            trip["work_hours"] = db_work_hours
            changed = _set_payload_reference_manual(
                trip,
                kind="material",
                code_key="material_code",
                selection_mode_key="material_selection_mode",
                suggestions_key="material_suggestions",
                code=row.get("material_code"),
                label=row.get("material_name"),
            ) or changed
            changed = _set_payload_reference_manual(
                trip,
                kind="object",
                code_key="from_object_code",
                selection_mode_key="from_object_selection_mode",
                suggestions_key="from_object_suggestions",
                code=row.get("from_object_code"),
                label=row.get("from_name"),
            ) or changed
            changed = _set_payload_reference_manual(
                trip,
                kind="object",
                code_key="to_object_code",
                selection_mode_key="to_object_selection_mode",
                suggestions_key="to_object_suggestions",
                code=row.get("to_object_code"),
                label=row.get("to_name"),
            ) or changed
            if changed and _overlay_row_snapshot(trip) != before:
                summary["transport_trips"]["updated"] += 1
    elif transport_trips or transport_rows:
        summary["warnings"].append(
            f"transport_count_mismatch: payload={len(transport_trips)} db={len(transport_rows)}"
        )

    work_rows = _payload_regular_work_rows(payload)
    db_work_rows = query(
        """
        SELECT
          dwi.work_name_raw,
          dwi.volume,
          dwi.unit,
          wt.code AS work_type_code,
          wt.name AS work_type_name,
          wt.default_unit,
          wt.analytics_tag,
          COALESCE(dwi.productivity_enabled, true) AS productivity_enabled,
          obj.object_code AS object_code,
          obj.name AS object_name,
          wieu.work_hours
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects obj ON obj.id = dwi.object_id
        LEFT JOIN LATERAL (
          SELECT work_hours
          FROM work_item_equipment_usage
          WHERE daily_work_item_id = dwi.id
          ORDER BY created_at NULLS LAST
          LIMIT 1
        ) wieu ON true
        WHERE dwi.daily_report_id = %s
          AND wt.code NOT IN ('PILE_MAIN', 'PILE_TRIAL', 'PILE_DYNTEST', 'PILE_HEADCAP_INSTALLATION')
        ORDER BY dwi.created_at, dwi.id
        """,
        [report_id],
    )
    summary["regular_works"]["payload"] = len(work_rows)
    summary["regular_works"]["db"] = len(db_work_rows)
    if work_rows and db_work_rows:
        work_pairs = _unique_overlay_pairs(
            work_rows,
            db_work_rows,
            _work_overlay_signature,
            lambda row: _work_overlay_signature(row, db_row=True),
        )
        if len(work_pairs) < min(len(work_rows), len(db_work_rows)):
            summary["warnings"].append(
                "regular_work_unmatched_or_ambiguous: "
                f"payload={len(work_rows)} db={len(db_work_rows)} matched={len(work_pairs)}"
        )
        for work, row in work_pairs:
            before = _overlay_row_snapshot(work)
            changed = False
            db_work_hours = float(row["work_hours"]) if row.get("work_hours") is not None else None
            changed = work.get("work_hours") != db_work_hours or changed
            work["work_hours"] = db_work_hours
            changed = _set_payload_reference_manual(
                work,
                kind="work_type",
                code_key="work_type_code",
                selection_mode_key="work_type_selection_mode",
                suggestions_key="work_type_suggestions",
                code=row.get("work_type_code"),
                label=row.get("work_type_name"),
                extra={
                    "default_unit": row.get("default_unit"),
                    "analytics_tag": row.get("analytics_tag"),
                    "productivity_enabled": row.get("productivity_enabled"),
                },
            ) or changed
            if row.get("object_code"):
                work["object_code"] = row.get("object_code")
                work["constructive_code"] = row.get("object_code")
            changed = _set_payload_reference_manual(
                work,
                kind="object",
                code_key="object_code",
                selection_mode_key="object_selection_mode",
                suggestions_key="object_suggestions",
                code=row.get("object_code"),
                label=row.get("object_name"),
            ) or changed
            unit_value = row.get("unit") or row.get("default_unit")
            if unit_value:
                work["unit"] = unit_value
            if row.get("analytics_tag") is not None:
                work["analytics_tag"] = row.get("analytics_tag")
            if row.get("productivity_enabled") is not None:
                work["productivity_enabled"] = bool(row.get("productivity_enabled"))
            if changed and _overlay_row_snapshot(work) != before:
                summary["regular_works"]["updated"] += 1
    elif work_rows or db_work_rows:
        summary["warnings"].append(
            f"regular_work_count_mismatch: payload={len(work_rows)} db={len(db_work_rows)}"
        )

    pile_rows = _payload_pile_rows(payload)
    db_pile_rows = query(
        """
        SELECT
          wt.code AS work_type_code,
          pf.id::text AS field_id,
          pf.field_code,
          pf.field_type,
          pf.pile_type,
          obj.id::text AS object_id,
          obj.object_code,
          obj.name AS object_name,
          ot.code AS object_type_code
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN daily_work_item_segments seg ON seg.daily_work_item_id = dwi.id
        LEFT JOIN pile_fields pf ON pf.id = seg.pile_field_id
        LEFT JOIN objects obj ON obj.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = obj.object_type_id
        WHERE dwi.daily_report_id = %s
          AND wt.code IN ('PILE_MAIN', 'PILE_TRIAL', 'PILE_DYNTEST', 'PILE_HEADCAP_INSTALLATION')
        ORDER BY dwi.created_at, dwi.id
        """,
        [report_id],
    )
    summary["piles"]["payload"] = len(pile_rows)
    summary["piles"]["db"] = len(db_pile_rows)
    if pile_rows and db_pile_rows:
        if len(pile_rows) == 1 and len(db_pile_rows) == 1:
            pile = pile_rows[0]
            row = db_pile_rows[0]
            before = _overlay_row_snapshot(pile)
            changed = False
            if row.get("work_type_code"):
                changed = pile.get("work_type_code") != row.get("work_type_code") or changed
                pile["work_type_code"] = row.get("work_type_code")
            if row.get("field_id"):
                changed = (
                    pile.get("field_id") != row.get("field_id")
                    or pile.get("field_code") != row.get("field_code")
                    or pile.get("target_type") != "pile_field"
                    or changed
                )
                pile["field_id"] = row.get("field_id")
                pile["field_code"] = row.get("field_code")
                pile["field_type"] = row.get("field_type")
                pile["pile_type"] = row.get("pile_type")
                pile["target_type"] = "pile_field"
                pile["field_selection_mode"] = "manual"
            elif row.get("object_id"):
                next_target_type = "pipe" if row.get("object_type_code") == "PIPE" else pile.get("target_type")
                changed = (
                    pile.get("object_id") != row.get("object_id")
                    or pile.get("object_code") != row.get("object_code")
                    or pile.get("target_type") != next_target_type
                    or changed
                )
                pile["target_type"] = next_target_type
                pile["object_id"] = row.get("object_id")
                pile["object_code"] = row.get("object_code")
                pile["object_name"] = row.get("object_name")
                pile["field_selection_mode"] = "manual"
            if changed and _overlay_row_snapshot(pile) != before:
                summary["piles"]["updated"] += 1
        else:
            summary["warnings"].append(
                "pile_overlay_skipped_no_stable_signature: "
                f"payload={len(pile_rows)} db={len(db_pile_rows)}"
            )
    elif pile_rows or db_pile_rows:
        summary["warnings"].append(
            f"pile_count_mismatch: payload={len(pile_rows)} db={len(db_pile_rows)}"
        )

    if (
        summary["transport_trips"]["updated"]
        or summary["regular_works"]["updated"]
        or summary["piles"]["updated"]
    ):
        review_actions = payload.get("review_actions") if isinstance(payload.get("review_actions"), dict) else {}
        review_actions["db_authoritative_overlay"] = summary
        payload["review_actions"] = review_actions
    return payload


def _payload_transport_trip_materials(payload: Any) -> list[dict[str, Any]]:
    payload = _coerce_payload_dict(payload)
    if not isinstance(payload, dict):
        return []
    rows: list[dict[str, Any]] = []
    for unit_index, unit in enumerate(payload.get("transport") or []):
        if not isinstance(unit, dict):
            continue
        for trip_index, trip in enumerate(unit.get("trips") or []):
            if not isinstance(trip, dict):
                continue
            source = trip.get("_source") if isinstance(trip.get("_source"), dict) else {}
            line_value = source.get("line") if isinstance(source, dict) else None
            try:
                source_line = int(line_value) if line_value not in (None, "") else None
            except (TypeError, ValueError):
                source_line = None
            rows.append({
                "unit_index": unit_index,
                "trip_index": trip_index,
                "source_line": source_line,
                "material": trip.get("material"),
                "material_code": trip.get("material_code"),
            })
    return rows


def _material_alias_candidates_from_report_payloads(
    final_payload: Any,
    initial_parse: Any = None,
    canonical_material_aliases: Optional[dict[str, str]] = None,
) -> list[dict[str, str]]:
    final_rows = _payload_transport_trip_materials(final_payload)
    initial_rows = _payload_transport_trip_materials(initial_parse)
    canonical_material_aliases = canonical_material_aliases or {}
    candidates: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(alias_text: Any, canonical_code: Any, source: str) -> None:
        alias = re.sub(r"\s+", " ", str(alias_text or "").replace("\xa0", " ")).strip().strip("/")
        canonical = str(canonical_code or "").strip()
        if not alias or not canonical or _normalize_ref(alias) == _normalize_ref(canonical):
            return
        if canonical_material_aliases.get(_normalize_ref(alias)):
            return
        key = (alias.casefold(), canonical)
        if key in seen:
            return
        seen.add(key)
        candidates.append({"kind": "material", "alias_text": alias, "canonical_code": canonical, "source": source})

    for row in final_rows:
        add(row.get("material"), row.get("material_code"), "final_payload")

    final_by_line = {row["source_line"]: row for row in final_rows if row.get("source_line") is not None and row.get("material_code")}
    final_by_index = {
        (row["unit_index"], row["trip_index"]): row
        for row in final_rows
        if row.get("material_code")
    }
    for initial in initial_rows:
        final = None
        if initial.get("source_line") is not None:
            final = final_by_line.get(initial.get("source_line"))
        if not final:
            final = final_by_index.get((initial["unit_index"], initial["trip_index"]))
        if final:
            add(initial.get("material"), final.get("material_code"), "initial_to_final_payload")

    return candidates


def _canonical_material_aliases_from_db() -> dict[str, str]:
    try:
        rows = query("SELECT code, name FROM materials")
    except Exception:
        return {}
    aliases: dict[str, str] = {}
    for row in rows:
        code = str(row.get("code") or "").strip()
        if not code:
            continue
        for value in (row.get("name"), row.get("code")):
            key = _normalize_ref(value)
            if key:
                aliases.setdefault(key, code)
    return aliases


def learn_report_aliases_for_date(target_date: Optional[date_cls] = None) -> dict[str, Any]:
    """Learn material aliases from already edited report payloads for one date."""
    date_value = target_date or (date_cls.today() - timedelta(days=1))
    _ensure_report_review_schema()
    canonical_material_aliases = _canonical_material_aliases_from_db()
    conn = get_conn()
    inserted_or_updated = 0
    skipped = 0
    conflict_skipped = 0
    conflict_examples: list[dict[str, Any]] = []
    scanned_reports = 0
    parsed_raw_reports = 0
    candidates_by_alias: dict[tuple[str, str], dict[str, Any]] = {}
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT review_payload, initial_parse_payload, raw_text
                    FROM daily_reports
                    WHERE report_date = %s
                      AND review_payload IS NOT NULL
                      AND COALESCE(status, 'pending_review') IN ('pending_review', 'review', 'confirmed', 'approved')
                    """,
                    (date_value,),
                )
                for final_payload, initial_parse, raw_text in cur.fetchall():
                    scanned_reports += 1
                    initial_payloads = [initial_parse]
                    if raw_text:
                        try:
                            raw_initial = parse_report_text(f"daily-report-{date_value.isoformat()}.txt", raw_text)
                            initial_payloads.append(raw_initial)
                            parsed_raw_reports += 1
                        except Exception as exc:
                            print(f"[report-aliases] raw parse failed for {date_value}: {exc}", flush=True)
                    for initial_payload in initial_payloads:
                        for candidate in _material_alias_candidates_from_report_payloads(
                            final_payload,
                            initial_payload,
                            canonical_material_aliases,
                        ):
                            alias_key = _normalize_ref(candidate["alias_text"])
                            if not alias_key:
                                skipped += 1
                                continue
                            bucket = candidates_by_alias.setdefault(
                                (candidate["kind"], alias_key),
                                {
                                    "kind": candidate["kind"],
                                    "alias_text": candidate["alias_text"],
                                    "codes": Counter(),
                                    "sources": Counter(),
                                },
                            )
                            bucket["codes"][candidate["canonical_code"]] += 1
                            bucket["sources"][candidate["source"]] += 1
                for bucket in candidates_by_alias.values():
                    if len(bucket["codes"]) != 1:
                        conflict_skipped += sum(bucket["codes"].values())
                        if len(conflict_examples) < 20:
                            conflict_examples.append({
                                "alias_text": bucket["alias_text"],
                                "codes": dict(bucket["codes"]),
                                "sources": dict(bucket["sources"]),
                            })
                        continue
                    canonical_code = next(iter(bucket["codes"]))
                    changed = _upsert_learned_reference_alias(
                        cur,
                        bucket["kind"],
                        bucket["alias_text"],
                        canonical_code,
                        "learned_from_previous_day_report_payload",
                    )
                    if changed:
                        inserted_or_updated += changed
                    else:
                        skipped += 1
        if inserted_or_updated:
            _reset_reference_caches()
            load_aliases(force=True)
        return {
            "date": date_value.isoformat(),
            "reports": scanned_reports,
            "raw_reports_parsed": parsed_raw_reports,
            "aliases_changed": inserted_or_updated,
            "aliases_skipped": skipped,
            "aliases_conflict_skipped": conflict_skipped,
            "alias_conflicts": conflict_examples,
        }
    finally:
        conn.close()


def _report_alias_learner_loop() -> None:
    global _REPORT_ALIAS_LEARNER_LAST_DATE
    if _REPORT_ALIAS_LEARNER_INITIAL_DELAY_SEC > 0:
        time.sleep(_REPORT_ALIAS_LEARNER_INITIAL_DELAY_SEC)
    while True:
        target_date = date_cls.today() - timedelta(days=1)
        try:
            with _REPORT_ALIAS_LEARNER_LOCK:
                if _REPORT_ALIAS_LEARNER_LAST_DATE != target_date:
                    result = learn_report_aliases_for_date(target_date)
                    _REPORT_ALIAS_LEARNER_LAST_DATE = target_date
                    print(f"[report-aliases] learned aliases: {result}", flush=True)
        except Exception as exc:
            print(f"[report-aliases] previous-day learning failed: {exc}", flush=True)
        time.sleep(max(_REPORT_ALIAS_LEARNER_INTERVAL_SEC, 300))


def start_report_alias_learner() -> None:
    global _REPORT_ALIAS_LEARNER_STARTED
    if os.getenv("VSM_REPORT_ALIAS_LEARNER_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        return
    with _REPORT_ALIAS_LEARNER_LOCK:
        if _REPORT_ALIAS_LEARNER_STARTED:
            return
        _REPORT_ALIAS_LEARNER_STARTED = True
        thread = threading.Thread(target=_report_alias_learner_loop, name="report-alias-learner", daemon=True)
        thread.start()


def _stored_report_payload(report_id: str, meta: dict[str, Any], raw_text: Optional[str]) -> dict[str, Any]:
    """Build report preview from saved DB rows so confirmed-report edits are reflected."""
    review_payload = meta.get("review_payload")
    if isinstance(review_payload, str):
        try:
            review_payload = json.loads(review_payload)
        except json.JSONDecodeError:
            review_payload = None
    is_fill_payload = isinstance(review_payload, dict) and (
        review_payload.get("report_mode") == "fill"
        or bool(review_payload.get("fill_statuses"))
        or bool(review_payload.get("mainline_fill_statuses"))
    )
    if isinstance(review_payload, dict) and (
        meta.get("status") in {"pending_review", "review"}
        or (meta.get("status") in {"confirmed", "approved"} and is_fill_payload)
    ):
        payload = deepcopy(review_payload) if is_fill_payload else _overlay_payload_with_report_db_facts(report_id, review_payload)
        if not payload.get("initial_parse") and meta.get("initial_parse_payload"):
            payload["initial_parse"] = meta.get("initial_parse_payload")
        header = dict(payload.get("header") or {})
        header.setdefault("report_date", meta.get("report_date"))
        header.setdefault("shift", meta.get("shift") or "unknown")
        header.setdefault("section_code", meta.get("section_code") or "")
        header.setdefault("section_name", meta.get("section_name") or "")
        payload["header"] = header
        payload["raw_text"] = sanitize_personal_report_text(raw_text or payload.get("raw_text") or "")
        payload = _mark_existing_payload_reference_codes_manual(payload)
        return _refresh_payload_reference_metadata(payload)

    transport_rows = query(
        """
        SELECT
          mm.id::text AS movement_id,
          m.code AS material_code,
          m.name AS material_name,
          fo.object_code AS from_object_code,
          fo.name AS from_name,
          tob.object_code AS to_object_code,
          tob.name AS to_name,
          mm.volume,
          mm.unit,
          mm.trip_count,
          mm.contractor_name,
          mm.haul_distance_km,
          mm.haul_distance_source,
          mmeu.work_hours,
          reu.equipment_type,
          reu.brand_model,
          reu.unit_number,
          reu.plate_number,
          reu.equipment_unit_id::text AS equipment_unit_id
        FROM material_movements mm
        LEFT JOIN materials m ON m.id = mm.material_id
        LEFT JOIN objects fo ON fo.id = mm.from_object_id
        LEFT JOIN objects tob ON tob.id = mm.to_object_id
        LEFT JOIN LATERAL (
          SELECT report_equipment_unit_id, work_hours
          FROM material_movement_equipment_usage
          WHERE material_movement_id = mm.id
          ORDER BY created_at NULLS LAST
          LIMIT 1
        ) mmeu ON true
        LEFT JOIN report_equipment_units reu ON reu.id = mmeu.report_equipment_unit_id
        WHERE mm.daily_report_id = %s
        ORDER BY mm.created_at, mm.id
        """,
        [report_id],
    )
    transport = []
    for row in transport_rows:
        transport.append({
            "vehicle": " ".join(x for x in [row.get("equipment_type"), row.get("brand_model")] if x),
            "equipment_type": row.get("equipment_type"),
            "brand_model": row.get("brand_model"),
            "equipment_unit_id": row.get("equipment_unit_id"),
            "unit_number": row.get("unit_number"),
            "plate_number": row.get("plate_number"),
            "plate": row.get("plate_number"),
            "owner": row.get("contractor_name"),
            "trips": [{
                "material": row.get("material_name") or row.get("material_code"),
                "material_code": row.get("material_code"),
                "from": row.get("from_name") or row.get("from_object_code"),
                "from_object_code": row.get("from_object_code"),
                "to": row.get("to_name") or row.get("to_object_code"),
                "to_object_code": row.get("to_object_code"),
                "volume": float(row["volume"]) if row.get("volume") is not None else None,
                "unit": row.get("unit") or "м3",
                "trips": row.get("trip_count"),
                "trip_count": row.get("trip_count"),
                "haul_distance_km": float(row["haul_distance_km"]) if row.get("haul_distance_km") is not None else None,
                "haul_distance_source": row.get("haul_distance_source"),
                "work_hours": float(row["work_hours"]) if row.get("work_hours") is not None else None,
            }],
        })

    work_rows = query(
        """
        SELECT
          dwi.id::text AS work_item_id,
          wt.code AS work_type_code,
          wt.name AS work_type_name,
          wt.default_unit AS work_type_default_unit,
          wt.analytics_tag AS work_type_analytics_tag,
          obj.object_code AS object_code,
          obj.name AS object_name,
          c.code AS constructive_type_code,
          c.name AS constructive_name,
          dwi.work_name_raw,
          dwi.volume,
          dwi.unit,
          dwi.contractor_name,
          COALESCE(dwi.productivity_enabled, true) AS productivity_enabled,
          seg.pk_start,
          seg.pk_end,
          seg.pk_raw_text,
          seg.comment AS segment_comment,
          reu.equipment_type,
          reu.brand_model,
          reu.unit_number,
          reu.plate_number,
          reu.equipment_unit_id::text AS equipment_unit_id,
          wieu.work_hours
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects obj ON obj.id = dwi.object_id
        LEFT JOIN constructives c ON c.id = dwi.constructive_id
        LEFT JOIN LATERAL (
          SELECT pk_start, pk_end, pk_raw_text, comment
          FROM daily_work_item_segments
          WHERE daily_work_item_id = dwi.id
          ORDER BY created_at NULLS LAST
          LIMIT 1
        ) seg ON true
        LEFT JOIN LATERAL (
          SELECT report_equipment_unit_id, work_hours
          FROM work_item_equipment_usage
          WHERE daily_work_item_id = dwi.id
          ORDER BY created_at NULLS LAST
          LIMIT 1
        ) wieu ON true
        LEFT JOIN report_equipment_units reu ON reu.id = wieu.report_equipment_unit_id
        WHERE dwi.daily_report_id = %s
          AND wt.code NOT IN ('PILE_MAIN', 'PILE_TRIAL', 'PILE_DYNTEST')
        ORDER BY dwi.created_at, dwi.id
        """,
        [report_id],
    )
    works = []
    for row in work_rows:
        works.append({
            "constructive": row.get("object_name") or row.get("constructive_name"),
            "constructive_code": row.get("object_code"),
            "object_code": row.get("object_code"),
            "work_name": row.get("work_name_raw") or row.get("work_type_name"),
            "work_type_code": row.get("work_type_code"),
            "work_type_suggestions": [{
                "code": row.get("work_type_code"),
                "label": row.get("work_type_name"),
                "score": 1.0,
                "source": "selected",
                "table": "work_types",
                "default_unit": row.get("work_type_default_unit"),
                "analytics_tag": row.get("work_type_analytics_tag"),
                "productivity_enabled": row.get("productivity_enabled"),
            }] if row.get("work_type_code") else [],
            "analytics_tag": row.get("work_type_analytics_tag"),
            "pk_rail_start": float(row["pk_start"]) if row.get("pk_start") is not None else None,
            "pk_rail_end": float(row["pk_end"]) if row.get("pk_end") is not None else None,
            "pk_rail_raw": row.get("pk_raw_text"),
            "pk_ad_raw": row.get("segment_comment"),
            "volume": float(row["volume"]) if row.get("volume") is not None else None,
            "unit": row.get("work_type_default_unit") or row.get("unit"),
            "vehicle": " ".join(x for x in [row.get("equipment_type"), row.get("brand_model")] if x),
            "equipment_unit_id": row.get("equipment_unit_id"),
            "unit_number": row.get("unit_number"),
            "plate_number": row.get("plate_number"),
            "plate": row.get("plate_number"),
            "owner": row.get("contractor_name"),
            "work_hours": float(row["work_hours"]) if row.get("work_hours") is not None else None,
            "productivity_enabled": bool(row.get("productivity_enabled", True)),
        })

    park_rows = query(
        """
        SELECT equipment_unit_id::text AS equipment_unit_id,
               equipment_type, brand_model, unit_number, plate_number,
               ownership_type, contractor_name, status, comment
        FROM report_equipment_units
        WHERE daily_report_id = %s
        ORDER BY equipment_type, unit_number NULLS LAST, plate_number NULLS LAST
        """,
        [report_id],
    )

    pile_rows = query(
        """
        SELECT wt.code AS wt_code, dwi.volume, pf.id::text AS field_id,
               pf.field_code, pf.field_type, pf.pile_type, pf.pk_start, pf.pk_end,
               pf.pk_raw_text, dwi.comment,
               ot.code AS object_type_code, o.id::text AS object_id, o.object_code, o.name AS object_name,
               pps.id::text AS pipe_pile_spec_id,
               ('L=' || trim(to_char(pps.pile_length_m, 'FM999999990.##')) || ' м') AS pipe_pile_type,
               seg.pk_start AS seg_pk_start, seg.pk_end AS seg_pk_end, seg.pk_raw_text AS seg_pk_raw_text
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN objects o ON o.id = dwi.object_id
        LEFT JOIN object_types ot ON ot.id = o.object_type_id
        LEFT JOIN daily_work_item_segments seg ON seg.daily_work_item_id = dwi.id
        LEFT JOIN pile_fields pf ON pf.id = seg.pile_field_id
        LEFT JOIN LATERAL (
          SELECT s.id, s.pile_length_m
          FROM pipe_pile_specs s
          WHERE s.object_id = dwi.object_id
            AND s.work_type_id = wt.id
            AND s.is_active IS TRUE
          ORDER BY s.pile_length_m, s.source_reference
          LIMIT 1
        ) pps ON ot.code = 'PIPE'
        WHERE dwi.daily_report_id = %s
          AND wt.code IN ('PILE_MAIN', 'PILE_TRIAL', 'PILE_DYNTEST', 'PILE_HEADCAP_INSTALLATION')
        ORDER BY dwi.created_at, dwi.id
        """,
        [report_id],
    )
    piles = []
    for row in pile_rows:
        wt_code = row.get("wt_code")
        is_pipe = row.get("object_type_code") == "PIPE" and not row.get("field_id")
        field_kind = "test" if row.get("field_type") == "test" else "main"
        pipe_kind = "test" if wt_code == "PILE_TRIAL" else "main"
        piles.append({
            "field_id": f"pipe:{row.get('pipe_pile_spec_id')}" if is_pipe and row.get("pipe_pile_spec_id") else row.get("field_id"),
            "field_code": (row.get("object_name") or row.get("object_code")) if is_pipe else row.get("field_code"),
            "field_type": pipe_kind if is_pipe else row.get("field_type"),
            "target_type": "pipe" if is_pipe else "pile_field",
            "object_id": row.get("object_id") if is_pipe else None,
            "object_code": row.get("object_code") if is_pipe else None,
            "object_name": row.get("object_name") if is_pipe else None,
            "pipe_pile_spec_id": row.get("pipe_pile_spec_id") if is_pipe else None,
            "pk_start": float(row["seg_pk_start"] if is_pipe else row["pk_start"]) if (row.get("seg_pk_start") if is_pipe else row.get("pk_start")) is not None else None,
            "pk_end": float(row["seg_pk_end"] if is_pipe else row["pk_end"]) if (row.get("seg_pk_end") if is_pipe else row.get("pk_end")) is not None else None,
            "pk_text": row.get("seg_pk_raw_text") if is_pipe else row.get("pk_raw_text"),
            "pile_kind": pipe_kind if is_pipe else ("test" if wt_code == "PILE_TRIAL" else field_kind),
            "pile_operation": "headcap" if wt_code == PILE_HEADCAP_WORK_TYPE_CODE else "driving",
            "work_type_code": wt_code,
            "count": float(row["volume"]) if row.get("volume") is not None else None,
            "pile_type": row.get("pipe_pile_type") if is_pipe else row.get("pile_type"),
            "pile_length_label": _pile_length_label(row.get("pipe_pile_type") if is_pipe else row.get("pile_type")),
            "comment": row.get("comment"),
        })

    staff_rows = query(
        """
        SELECT category, count
        FROM daily_report_staff_counts
        WHERE daily_report_id = %s
        ORDER BY
          CASE category
            WHEN 'ИТР' THEN 1
            WHEN 'ДР' THEN 2
            WHEN 'Механизаторы' THEN 3
            WHEN 'Водители' THEN 4
            ELSE 5
          END,
          category
        """,
        [report_id],
    )

    return {
        "source": {"filename": meta.get("source_reference") or "confirmed-report", "chars": len(raw_text or ""), "lines": len((raw_text or "").splitlines())},
        "header": {
            "report_date": meta.get("report_date"),
            "shift": meta.get("shift") or "unknown",
            "section_code": meta.get("section_code") or "",
            "section_name": meta.get("section_name") or "",
            "author": "",
        },
        "human_summary": {"constructives": meta.get("section_name") or "", "delivery_info": "", "global_comments": []},
        "transport": transport,
        "main_works": works,
        "aux_works": [],
        "staff_counts": staff_rows,
        "park": park_rows,
        "problems": "",
        "stockpiles": [],
        "piles": piles,
        "warnings": [],
        "review_actions": {"stockpiles_to_create": []},
        "raw_text": sanitize_personal_report_text(raw_text or "") if raw_text else "",
        "_stub": False,
    }


def _plain_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    return value


def _text_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _report_date_label(value: Any) -> str:
    iso = _iso_date(value)
    if not iso:
        return ""
    try:
        dt = date_cls.fromisoformat(iso[:10])
        return dt.strftime("%d.%m.%Y")
    except ValueError:
        return iso


def _shift_sheet_label(shift: Any) -> str:
    value = (str(shift or "").strip().lower())
    if value == "day":
        return "День"
    if value == "night":
        return "Ночь"
    return "Не задано"


def _shift_filename_part(shift: Any) -> str:
    value = (str(shift or "").strip().lower())
    if value == "day":
        return "день"
    if value == "night":
        return "ночь"
    return "смена"


def _section_filename_part(meta: dict[str, Any]) -> str:
    source = _text_cell(meta.get("section_code") or meta.get("section_name"))
    match = re.search(r"(\d+)", source)
    if match:
        return f"уч{int(match.group(1))}"
    return "участок"


def _daily_report_export_filename(meta: dict[str, Any]) -> str:
    date_label = _report_date_label(meta.get("report_date")) or "__.__.____"
    return f"Сменный отчет за {date_label} {_section_filename_part(meta)} {_shift_filename_part(meta.get('shift'))}.xlsx"


def _pk_range_label(start: Any, end: Any, raw: Any = None) -> str:
    raw_text = _text_cell(raw)
    if raw_text:
        return raw_text
    start_label = _format_pk_db(start)
    end_label = _format_pk_db(end)
    if start_label and end_label and start_label != end_label:
        return f"{start_label} - {end_label}"
    return start_label or end_label or ""


def _equipment_number(row: dict[str, Any]) -> str:
    return _text_cell(
        row.get("reported_number")
        or row.get("unit_number")
        or row.get("plate_number")
        or row.get("plate")
        or row.get("equipment_unit_id")
    )


def _equipment_status_label(value: Any) -> str:
    status = _text_cell(value).lower()
    return {
        "working": "В работе",
        "standby": "Простой",
        "idle": "Простой",
        "repair": "Ремонт",
        "out": "Выбыла",
        "unknown": "",
    }.get(status, _text_cell(value))


def _copy_row_format(ws, source_row: int, target_row: int, max_col: int) -> None:
    for col_idx in range(1, max_col + 1):
        src = ws.cell(source_row, col_idx)
        dst = ws.cell(target_row, col_idx)
        if src.has_style:
            dst._style = copy(src._style)
        if src.number_format:
            dst.number_format = src.number_format
        if src.alignment:
            dst.alignment = copy(src.alignment)
    ws.row_dimensions[target_row].height = ws.row_dimensions[source_row].height


def _marker_rows(ws) -> list[tuple[str, int]]:
    rows: list[tuple[str, int]] = []
    for row_idx in range(1, ws.max_row + 1):
        value = _text_cell(ws.cell(row_idx, 1).value)
        if value.startswith("##"):
            rows.append((value.lstrip("#").strip().upper(), row_idx))
    return rows


def _fill_xlsx_table(ws, marker_name: str, rows: list[dict[str, Any]]) -> None:
    markers = _marker_rows(ws)
    marker_key = marker_name.upper()
    marker_idx = next((idx for idx, (name, _row) in enumerate(markers) if name == marker_key), None)
    if marker_idx is None:
        return
    marker_row = markers[marker_idx][1]
    next_marker_row = markers[marker_idx + 1][1] if marker_idx + 1 < len(markers) else ws.max_row + 1
    header_row = marker_row + 1
    start_row = header_row + 1
    end_row = max(start_row - 1, next_marker_row - 1)
    headers = [_text_cell(cell.value) for cell in ws[header_row]]
    max_col = max((idx for idx, header in enumerate(headers, start=1) if header), default=1)
    capacity = max(0, end_row - start_row + 1)
    if len(rows) > capacity:
        extra = len(rows) - capacity
        insert_at = end_row + 1
        ws.insert_rows(insert_at, extra)
        source_row = end_row if capacity > 0 else header_row
        for row_idx in range(insert_at, insert_at + extra):
            _copy_row_format(ws, source_row, row_idx, max_col)
        end_row += extra
    for row_idx in range(start_row, end_row + 1):
        for col_idx in range(1, max_col + 1):
            ws.cell(row_idx, col_idx).value = None
    for offset, data in enumerate(rows):
        row_idx = start_row + offset
        for col_idx, header in enumerate(headers[:max_col], start=1):
            if not header:
                continue
            ws.cell(row_idx, col_idx).value = _plain_cell(data.get(header))


def _problem_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    problems = payload.get("problems")
    if isinstance(problems, list):
        values = [item.get("problem_text") if isinstance(item, dict) else item for item in problems]
    else:
        values = str(problems or "").splitlines()
    return [{"Проблема": _text_cell(value)} for value in values if _text_cell(value)]


def _daily_report_workbook_from_payload(meta: dict[str, Any], payload: dict[str, Any]):
    template_path = _daily_report_template_path()
    if not template_path.exists():
        raise HTTPException(404, f"Excel-шаблон сменного отчета не найден: {template_path}")
    try:
        wb = load_workbook(template_path)
    except Exception as exc:
        raise HTTPException(500, f"Не удалось прочитать Excel-шаблон: {exc}") from exc
    ws = wb["Отчет"] if "Отчет" in wb.sheetnames else wb.active
    ws.title = "Отчет"

    header = payload.get("header") or {}
    ws["B4"] = _report_date_label(header.get("report_date") or meta.get("report_date"))
    ws["B5"] = _shift_sheet_label(header.get("shift") or meta.get("shift"))
    ws["B6"] = header.get("section_name") or meta.get("section_name") or header.get("section_code") or meta.get("section_code") or "Участок"
    ws["B7"] = header.get("section_code") or meta.get("section_code") or ""
    ws["B8"] = (payload.get("human_summary") or {}).get("constructives") or header.get("constructives") or ""

    transport_rows: list[dict[str, Any]] = []
    delivery_rows: list[dict[str, Any]] = []
    for unit in payload.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        unit_number = _equipment_number(unit)
        owner = unit.get("owner") or unit.get("contractor_name")
        for trip in unit.get("trips") or []:
            if not isinstance(trip, dict):
                continue
            delivery_rows.append({
                "Источник": trip.get("from"),
                "Материал": trip.get("material"),
                "Объем": trip.get("volume"),
                "Ед.": trip.get("unit") or "м3",
            })
            transport_rows.append({
                "Откуда": trip.get("from"),
                "Куда": trip.get("to"),
                "Материал": trip.get("material"),
                "Номер техники": unit_number,
                "Объем": trip.get("volume"),
                "Ед.": trip.get("unit") or "м3",
                "Рейсов": trip.get("trips") or trip.get("trip_count"),
                "Организация": owner,
                "Плечо, км": trip.get("haul_distance_km"),
                "Время работы": trip.get("work_hours"),
            })

    work_rows: list[dict[str, Any]] = []
    for item in list(payload.get("main_works") or []) + list(payload.get("aux_works") or []):
        if not isinstance(item, dict):
            continue
        work_rows.append({
            "Объект/конструктив": item.get("constructive") or item.get("object_code") or item.get("constructive_code"),
            "Работа": item.get("work_name"),
            "ПК ВСЖМ": _pk_range_label(item.get("pk_rail_start") or item.get("pk_start"), item.get("pk_rail_end") or item.get("pk_end"), item.get("pk_rail_raw")),
            "ПК АД": item.get("pk_ad_raw"),
            "Номер техники": _equipment_number(item),
            "Объем": item.get("volume"),
            "Ед.": item.get("unit") or "м3",
            "Тип техники": item.get("equipment_type") or item.get("vehicle"),
            "Организация": item.get("owner") or item.get("contractor_name"),
            "Производительность": "Да" if item.get("productivity_enabled", True) else "Нет",
            "Комментарий": item.get("comment"),
            "Время работы": item.get("work_hours"),
        })

    park_rows = [
        {
            "Тип техники": row.get("equipment_type"),
            "Модель": row.get("brand_model"),
            "Номер техники": row.get("unit_number") or row.get("reported_number"),
            "Госномер": row.get("plate_number") or row.get("plate"),
            "Организация": row.get("contractor_name") or row.get("owner"),
            "Статус": _equipment_status_label(row.get("status")),
            "Комментарий": row.get("comment") or row.get("status_reason"),
        }
        for row in payload.get("park") or []
        if isinstance(row, dict)
    ]

    staff_rows = [
        {"Категория": row.get("category"), "Количество": row.get("count")}
        for row in payload.get("staff_counts") or []
        if isinstance(row, dict)
    ]
    fill_rows = [
        {
            "Автодорога": row.get("road_name") or row.get("road_code"),
            "Участок": row.get("section_code"),
            "Пионерка": row.get("pioneer_fill"),
            "не в отметку": row.get("subgrade_not_to_grade"),
            "ДСО": row.get("dso"),
            "готово под ЩПГС": row.get("ready_for_shpgs"),
            "под аб": row.get("shpgs_done"),
            "Примечание": row.get("comment") or row.get("note"),
        }
        for row in payload.get("fill_statuses") or []
        if isinstance(row, dict)
    ]
    mainline_status_columns = {
        "prep_works": "ПРС",
        "main_works": "Основные работы",
        "protective_layer_2": "ЗС №2",
        "protective_layer_1": "ЗС №1",
        "asphalt_layer": "Асфальтобетон",
    }
    mainline_fill_rows: list[dict[str, Any]] = []
    for row in payload.get("mainline_fill_statuses") or []:
        if not isinstance(row, dict):
            continue
        out = {
            "Участок": row.get("section_code") or header.get("section_code") or meta.get("section_code"),
            "ПРС": "",
            "Основные работы": "",
            "ЗС №2": "",
            "ЗС №1": "",
            "Асфальтобетон": "",
            "Примечание": row.get("comment") or row.get("note"),
        }
        column = mainline_status_columns.get(str(row.get("status_type") or ""))
        if column:
            out[column] = row.get("pk_ranges")
        mainline_fill_rows.append(out)
    stockpile_rows = [
        {
            "Накопитель": row.get("name") or row.get("existing_object_name"),
            "ПК": row.get("pk_raw_text") or _pk_range_label(row.get("pk_start"), row.get("pk_end")),
            "Объем": row.get("volume"),
            "Ед.": row.get("unit") or "м3",
            "Комментарий": row.get("comment"),
        }
        for row in payload.get("stockpiles") or []
        if isinstance(row, dict)
    ]
    pile_rows = [
        {
            "Свайное поле": row.get("field_code"),
            "ПК": row.get("pk_text") or _pk_range_label(row.get("pk_start"), row.get("pk_end")),
            "Операция": "Установка наголовников" if _is_pile_headcap_row(row) else "Забивка свай",
            "Тип свай": row.get("pile_length_label") or row.get("pile_type"),
            "Количество": row.get("count"),
            "Вид/тип свай": "Пробные" if str(row.get("pile_kind") or "").lower() in {"test", "trial"} else "Основные",
            "Комментарий": row.get("comment"),
        }
        for row in payload.get("piles") or []
        if isinstance(row, dict)
    ]

    _fill_xlsx_table(ws, "ЗАВОЗ", delivery_rows)
    _fill_xlsx_table(ws, "ПЕРЕВОЗКА", transport_rows)
    _fill_xlsx_table(ws, "РАБОТЫ", work_rows)
    _fill_xlsx_table(ws, "ПАРК ТЕХНИКИ", park_rows)
    _fill_xlsx_table(ws, "ПЕРСОНАЛ", staff_rows)
    _fill_xlsx_table(ws, "ДАННЫЕ ПО ОТСЫПКЕ", fill_rows)
    _fill_xlsx_table(ws, "ДАННЫЕ ПО ОТСЫПКЕ ОХ", mainline_fill_rows)
    _fill_xlsx_table(ws, "НАКОПИТЕЛИ", stockpile_rows)
    _fill_xlsx_table(ws, "ЗАБИВКА СВАЙ", pile_rows)
    _fill_xlsx_table(ws, "ПРОБЛЕМНЫЕ ВОПРОСЫ", _problem_rows(payload))
    return wb


@router.get("/{report_id}/xlsx")
def download_stored_report_xlsx(report_id: str, _user=Depends(current_user)):
    try:
        uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(400, "Невалидный id")
    _ensure_report_review_schema()
    rows = query(
        """
        SELECT
          dr.id::text AS id,
          dr.report_date,
          dr.shift,
          dr.source_type,
          dr.source_reference,
          dr.uploaded_by_username,
          dr.raw_text,
          dr.status,
          dr.review_tag,
          dr.review_payload,
          dr.initial_parse_payload,
          cs.code AS section_code,
          cs.name AS section_name
        FROM daily_reports dr
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE dr.id = %s
        LIMIT 1
        """,
        [report_id],
    )
    if not rows:
        raise HTTPException(404, "Отчёт не найден")
    row = rows[0]
    meta = {
        "id": row["id"],
        "report_date": _iso_date(row.get("report_date")),
        "shift": row.get("shift"),
        "section_code": row.get("section_code"),
        "section_name": row.get("section_name"),
        "source_type": row.get("source_type"),
        "source_reference": row.get("source_reference"),
        "uploaded_by_username": row.get("uploaded_by_username"),
        "status": row.get("status"),
        "review_tag": row.get("review_tag"),
        "review_payload": row.get("review_payload"),
        "initial_parse_payload": row.get("initial_parse_payload"),
    }
    payload = _stored_report_payload(report_id, meta, row.get("raw_text"))
    wb = _daily_report_workbook_from_payload(meta, payload)
    output = BytesIO()
    wb.save(output)
    output.seek(0)
    filename = _daily_report_export_filename(meta)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=_content_disposition(filename),
    )


# ── GET /api/wip/reports ────────────────────────────────────────────────

def _report_list_where(
    *,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    uploaded_by: Optional[str] = None,
) -> tuple[str, list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    if date_from:
        where.append("dr.report_date >= %s")
        params.append(date_from)
    if date_to:
        where.append("dr.report_date <= %s")
        params.append(date_to)
    if uploaded_by is not None and uploaded_by != "":
        where.append("COALESCE(dr.uploaded_by_username, '') = %s")
        params.append(uploaded_by)
    return ("WHERE " + " AND ".join(where)) if where else "", params


def _decorate_report_list_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    boundaries = _load_pk_validation_boundaries()
    for row in rows:
        row["user_flags"] = _normalize_report_user_flags(row.get("user_flags"))
        payload = row.pop("review_payload", None)
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = None
        flags: list[str] = []
        if isinstance(payload, dict):
            raw_flags = payload.get("review_flags") or []
            if isinstance(raw_flags, list):
                flags = [str(flag).strip() for flag in raw_flags if str(flag).strip()]
            elif isinstance(raw_flags, str) and raw_flags.strip():
                flags = [raw_flags.strip()]
        row["review_flags"] = flags
        fill_statuses_count = 0
        if isinstance(payload, dict):
            for key in ("fill_statuses", "mainline_fill_statuses"):
                items = payload.get(key)
                if isinstance(items, list):
                    fill_statuses_count += sum(1 for item in items if isinstance(item, dict) and any(str(value or "").strip() for value in item.values()))
        row["fill_statuses_count"] = fill_statuses_count
        if payload:
            issues = _collect_import_pk_validation_issues(payload, boundaries)
            row["pk_validation_level"] = (
                "error" if any(issue["level"] == "error" for issue in issues)
                else "warning" if any(issue["level"] == "warning" for issue in issues)
                else None
            )
            row["pk_validation_count"] = len(issues)
        else:
            row["pk_validation_level"] = None
            row["pk_validation_count"] = 0
    return rows


@router.get("")
def list_reports(
    limit: int = 100,
    offset: int = 0,
    paged: bool = False,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    uploaded_by: Optional[str] = None,
):
    """
    Список суточных отчётов с привязкой участка и счётчиками зависимых сущностей.

    Legacy mode returns a plain array for old clients. `paged=true` returns metadata,
    total count and server-side filters so historical months are reachable.
    """
    _ensure_report_review_schema()
    limit = max(1, min(500, int(limit or 100)))
    offset = max(0, int(offset or 0))
    where_sql, where_params = _report_list_where(date_from=date_from, date_to=date_to, uploaded_by=uploaded_by)
    rows = query(
        f"""
        WITH selected_reports AS (
          SELECT
            dr.id              AS id_uuid,
            dr.id::text        AS id,
            dr.report_date,
            dr.shift,
            dr.source_type,
            dr.status,
            dr.parse_status,
            dr.operator_status,
            dr.created_at,
            dr.uploaded_by_username,
            dr.user_flags,
            cs.code            AS section_code,
            cs.name            AS section_name,
            dr.review_payload
          FROM daily_reports dr
          LEFT JOIN construction_sections cs ON cs.id = dr.section_id
          {where_sql}
          ORDER BY dr.report_date DESC, dr.created_at DESC
          LIMIT %s OFFSET %s
        ),
        work_counts AS (
          SELECT dwi.daily_report_id, COUNT(1)::int AS work_items_count
          FROM daily_work_items dwi
          WHERE dwi.daily_report_id IN (SELECT id_uuid FROM selected_reports)
          GROUP BY dwi.daily_report_id
        ),
        movement_counts AS (
          SELECT mm.daily_report_id, COUNT(1)::int AS movements_count
          FROM material_movements mm
          WHERE mm.daily_report_id IN (SELECT id_uuid FROM selected_reports)
          GROUP BY mm.daily_report_id
        ),
        equipment_counts AS (
          SELECT reu.daily_report_id, COUNT(1)::int AS equipment_count
          FROM report_equipment_units reu
          WHERE reu.daily_report_id IN (SELECT id_uuid FROM selected_reports)
          GROUP BY reu.daily_report_id
        )
        SELECT
          sr.id,
          sr.report_date,
          sr.shift,
          sr.source_type,
          sr.status,
          sr.parse_status,
          sr.operator_status,
          sr.created_at,
          sr.uploaded_by_username,
          sr.user_flags,
          sr.section_code,
          sr.section_name,
          COALESCE(wc.work_items_count, 0) AS work_items_count,
          COALESCE(mc.movements_count, 0) AS movements_count,
          COALESCE(ec.equipment_count, 0) AS equipment_count,
          sr.review_payload
        FROM selected_reports sr
        LEFT JOIN work_counts wc ON wc.daily_report_id = sr.id_uuid
        LEFT JOIN movement_counts mc ON mc.daily_report_id = sr.id_uuid
        LEFT JOIN equipment_counts ec ON ec.daily_report_id = sr.id_uuid
        ORDER BY sr.report_date DESC, sr.created_at DESC
        """,
        [*where_params, limit, offset],
    )
    rows = _decorate_report_list_rows(rows)
    if not paged:
        return rows

    total_rows = query(
        f"""
        SELECT COUNT(*)::int AS total
        FROM daily_reports dr
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        {where_sql}
        """,
        where_params,
    )
    total = int((total_rows[0] or {}).get("total") or 0) if total_rows else 0
    uploaders_where_sql, uploaders_params = _report_list_where(date_from=date_from, date_to=date_to)
    uploader_rows = query(
        f"""
        SELECT COALESCE(dr.uploaded_by_username, '') AS value,
               COUNT(*)::int AS count
        FROM daily_reports dr
        {uploaders_where_sql}
        GROUP BY dr.uploaded_by_username
        ORDER BY COALESCE(dr.uploaded_by_username, '')
        """,
        uploaders_params,
    )
    uploaders = [
        {
            "value": row.get("value") or "",
            "label": row.get("value") or "— не указан —",
            "count": int(row.get("count") or 0),
        }
        for row in uploader_rows
    ]
    return {
        "rows": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        "filter_options": {"uploaders": uploaders},
    }


@router.patch("/{report_id}/user-flags")
def update_report_user_flags(report_id: str, body: ReportUserFlagsBody, _user=Depends(current_user)):
    """Update operator/user-visible flags attached to a stored report."""
    _ensure_report_review_schema()
    try:
        report_uuid = uuid.UUID(report_id)
    except ValueError as exc:
        raise HTTPException(400, "Некорректный id отчета") from exc

    flags = _normalize_report_user_flags(body.flags, getattr(_user, "username", None))
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE daily_reports
                    SET user_flags = %s::jsonb
                    WHERE id = %s
                    RETURNING id::text, user_flags
                    """,
                    (json.dumps(flags, ensure_ascii=False), str(report_uuid)),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(404, "Отчет не найден")
                return {"id": row[0], "user_flags": _normalize_report_user_flags(row[1])}
    finally:
        conn.close()


# ── POST /api/wip/reports/preview ───────────────────────────────────────

# Регексы для разбора ведомости
_SECTION_RE = re.compile(r"===\s*(.+?)\s*===", re.MULTILINE)
_VOLUME_TRIPS_RE = re.compile(
    r"([\d\s]*[\d,\.]+|Н/Д)\s*(м3|м²|м2|м|км|шт)?\s*/\s*(\d+)\s*рейс"
)
_VOLUME_ONLY_RE = re.compile(r"([\d\s]*[\d,\.]+)\s*(м3|м²|м2|м|км|шт)(?:\s*\(([^)]+)\))?")
_PK_RANGE_RE = re.compile(r"ПК\s*(\d+)\+(\d+(?:[.,]\d+)?)\s*[-–—]\s*ПК\s*(\d+)\+(\d+(?:[.,]\d+)?)")
_VEHICLE_RE = re.compile(r"^(.+?)\s*\(([^)]+)\);\s*(.+)$")
_DRIVER_RE = re.compile(r"^-\s*(.+?)\s*-\s*$")
_MAT_BLOCK_RE = re.compile(r"^/(.+?)/\s*$")
_CONSTR_RE = re.compile(r"^-\s*(АД\s*[\d\.]+(?:\s*№\s*\d+(?:\.\d+)?)?)\s*-\s*$", re.IGNORECASE)
_SHIFT_MAP = {"день": "day", "ночь": "night"}


def _to_float(s: str) -> Optional[float]:
    if not s or s.strip().upper() in ("Н/Д", "НД", "-", "—"):
        return None
    try:
        return float(s.replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def _parse_section(section_body: str, section_name: str) -> Any:
    """Парсит тело одной секции отчёта."""
    sn = section_name.upper()

    if sn == 'ШАПКА':
        result = {}
        for line in section_body.splitlines():
            if '-' in line:
                k, _, v = line.partition('-')
                result[k.strip().lower()] = v.strip()
        return result

    if sn == 'ПЕРЕВОЗКА':
        units = []
        current = None
        current_trip = None
        for line in section_body.splitlines():
            line = line.rstrip()
            if not line.strip():
                continue
            m = _DRIVER_RE.match(line)
            if m:
                if current:
                    units.append(current)
                current = {
                    'vehicle': None, 'plate': None, 'owner': None,
                    'comments': [], 'trips': [],
                }
                current_trip = None
                continue
            if current is None:
                continue
            if line.startswith('%%%'):
                current['comments'].append(line[3:].strip())
                continue
            vm = _VEHICLE_RE.match(line)
            if vm and current['vehicle'] is None:
                current['vehicle'] = vm.group(1).strip()
                current['plate'] = vm.group(2).strip()
                current['owner'] = vm.group(3).strip()
                continue
            mat_m = _MAT_BLOCK_RE.match(line)
            if mat_m:
                if current_trip:
                    current['trips'].append(current_trip)
                current_trip = {'material': mat_m.group(1).strip(), 'from': None, 'to': None,
                                'volume': None, 'trips': None}
                continue
            if '→' in line and current_trip:
                a, _, b = line.partition('→')
                current_trip['from'] = a.strip()
                current_trip['to'] = b.strip()
                continue
            vt_m = _VOLUME_TRIPS_RE.search(line)
            if vt_m and current_trip:
                current_trip['volume'] = _to_float(vt_m.group(1))
                current_trip['trips'] = int(vt_m.group(3))
                current['trips'].append(current_trip)
                current_trip = None
        if current:
            if current_trip:
                current['trips'].append(current_trip)
            units.append(current)
        return units

    if sn in ('ОСНОВНЫЕ РАБОТЫ', 'СОПУТСТВУЮЩИЕ РАБОТЫ'):
        works = []
        current_constr = None if sn == 'СОПУТСТВУЮЩИЕ РАБОТЫ' else None
        current = None
        lines = section_body.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].rstrip()
            if not line.strip():
                i += 1
                continue
            cm = _CONSTR_RE.match(line)
            if cm:
                current_constr = cm.group(1).strip()
                i += 1
                continue
            mat_m = _MAT_BLOCK_RE.match(line)
            if mat_m:
                if current:
                    works.append(current)
                current = {
                    'constructive': current_constr, 'work_name': mat_m.group(1).strip(),
                    'pk_rail_start': None, 'pk_rail_end': None,
                    'pk_ad_start': None, 'pk_ad_end': None,
                    'vehicle': None, 'plate': None, 'owner': None,
                    'volume': None, 'unit': None, 'volume_note': None,
                }
                i += 1
                continue
            if current is None:
                i += 1
                continue
            if line.startswith('ПК ВСЖМ:'):
                body = line[len('ПК ВСЖМ:'):].strip()
                values = _strict_pk_values(body)
                if values:
                    start, end = _normalize_pk_pair(values[0], values[1] if len(values) > 1 else values[0])
                    current['pk_rail_start'] = start
                    current['pk_rail_end'] = end
                i += 1; continue
            if line.startswith('ПК АД:'):
                body = line[len('ПК АД:'):].strip()
                values = _strict_pk_values(body)
                if values:
                    start, end = _normalize_pk_pair(values[0], values[1] if len(values) > 1 else values[0])
                    current['pk_ad_start'] = start
                    current['pk_ad_end'] = end
                i += 1; continue
            vm = _VEHICLE_RE.match(line)
            if vm and current['vehicle'] is None:
                current['vehicle'] = vm.group(1).strip()
                current['plate'] = vm.group(2).strip()
                current['owner'] = vm.group(3).strip()
                i += 1; continue
            # volume line
            vol_m = _VOLUME_ONLY_RE.search(line)
            if vol_m:
                current['volume'] = _to_float(vol_m.group(1))
                current['unit'] = vol_m.group(2)
                if vol_m.group(3):
                    current['volume_note'] = vol_m.group(3)
                i += 1; continue
            i += 1
        if current:
            works.append(current)
        return works

    if sn == 'ПАРК ТЕХНИКИ':
        park = []
        for line in section_body.splitlines():
            line = line.rstrip()
            if not line.strip() or line.startswith('%'):
                continue
            vm = _VEHICLE_RE.match(line)
            if not vm:
                continue
            left = vm.group(1).strip()
            plate = vm.group(2).strip()
            tail = vm.group(3).strip()
            tail_parts = [p.strip() for p in tail.split(';')]
            owner = tail_parts[0] if tail_parts else None
            status = tail_parts[1].lower() if len(tail_parts) > 1 else 'working'
            comment = '; '.join(tail_parts[2:]) if len(tail_parts) > 2 else None
            # Попытка выделить тип техники из начала строки
            tokens = left.split(None, 1)
            et = tokens[0]
            model_and_num = tokens[1] if len(tokens) > 1 else ''
            park.append({
                'equipment_type': et,
                'brand_model': model_and_num,
                'plate_number': plate,
                'owner': owner,
                'status': 'working' if status in ('в работе', 'working', 'в_работе') else 'idle',
                'status_reason': comment if status not in ('в работе', 'working') else None,
            })
        return park

    if sn == 'ПРОБЛЕМНЫЕ ВОПРОСЫ':
        return section_body.strip()

    if sn == 'ПЕРСОНАЛ':
        out = []
        for line in section_body.splitlines():
            if line.startswith('%'):
                continue
            m = re.match(r"([А-ЯA-Z][А-Яа-яA-Za-z]*)\s*:\s*(\d+)", line.strip())
            if m:
                out.append({'category': m.group(1), 'count': int(m.group(2))})
        return out

    return section_body.strip()


def _parse_report_text(filename: str, raw_text: str) -> dict[str, Any]:
    """Parser v2 + DB-backed alias/review enrichment."""
    parsed = parse_report_text(filename, raw_text)
    aliases = load_aliases()
    section_code = (parsed.get("header") or {}).get("section_code")
    total_items = 0
    resolved_items = 0
    unresolved_samples: dict[str, str] = {}  # kind:text (lower) -> original text
    alias_suggestions: list[dict[str, str]] = []

    def _check(kind: str, text: Optional[str], existing_code: Optional[str] = None) -> tuple[Optional[str], list[dict[str, Any]]]:
        nonlocal total_items, resolved_items
        if text is None or str(text).strip() == "":
            return existing_code, []
        total_items += 1
        alias_code = _resolve(aliases, kind, text)
        preferred_code = alias_code or existing_code
        candidates = _reference_candidates(kind, text, preferred_code, section_code=section_code)
        code = _select_reference_code(kind, preferred_code, candidates, section_code=section_code)
        if code:
            resolved_items += 1
            if existing_code and not alias_code:
                alias_suggestions.append({
                    "kind": kind,
                    "alias_text": str(text).strip(),
                    "canonical_code": code,
                    "reason": "parser_inferred_after_operator_confirmation",
                })
        else:
            key = f"{kind}:{str(text).strip().lower()}"
            unresolved_samples.setdefault(key, str(text).strip())
        return code, candidates

    transport = parsed.get("transport") or []
    if isinstance(transport, list):
        for d in transport:
            if not isinstance(d, dict):
                continue
            d["_equipment_context"] = "transport"
            _enrich_equipment_row(d)
            d.pop("_equipment_context", None)
            needs = False
            for t in d.get('trips') or []:
                if not isinstance(t, dict):
                    continue
                t['material_code'], t['material_suggestions'] = _check('material', t.get('material'), t.get('material_code'))
                t['from_object_code'], t['from_object_suggestions'] = _check('object', t.get('from'), t.get('from_object_code'))
                t['to_object_code'], t['to_object_suggestions'] = _check('object', t.get('to'), t.get('to_object_code'))
                t_needs = (
                    (t.get('material') and not t['material_code']) or
                    (t.get('from') and not t['from_object_code']) or
                    (t.get('to') and not t['to_object_code'])
                )
                t['needs_alias'] = bool(t_needs)
                if t_needs:
                    needs = True
            d['needs_alias'] = needs

    main_works = parsed.get("main_works") or []
    aux_works = parsed.get("aux_works") or []
    for coll in (main_works, aux_works):
        if not isinstance(coll, list):
            continue
        for w in coll:
            if not isinstance(w, dict):
                continue
            w["_equipment_context"] = "work"
            _enrich_equipment_row(w)
            w.pop("_equipment_context", None)
            for eq in w.get("equipment") or []:
                if isinstance(eq, dict):
                    eq["_equipment_context"] = "work"
                    _enrich_equipment_row(eq)
                    eq.pop("_equipment_context", None)
            w['work_type_code'], w['work_type_suggestions'] = _check('work_type', w.get('work_name'), w.get('work_type_code'))
            forbidden_work_type = _is_regular_work_block_forbidden_work_type(w.get('work_type_code'))
            if forbidden_work_type:
                w["work_block_forbidden"] = True
                w["work_block_forbidden_message"] = (
                    "Забивку основных/пробных свай и монтаж наголовников нужно вводить "
                    "в блоке «Свайные работы»."
                )
            object_code, object_suggestions = _check(
                'object',
                w.get('constructive'),
                w.get('object_code') or w.get('constructive_code'),
            )
            w['object_code'] = object_code
            w['object_suggestions'] = object_suggestions
            if object_code:
                # Backward compatibility: the existing import path reads constructive_code
                # before falling back to the raw constructive text.
                w['constructive_code'] = object_code
            if not w.get("analytics_tag"):
                w["analytics_tag"] = _work_analytics_tag_from_row(w)
            w_needs = (
                (w.get('work_name') and not w['work_type_code']) or
                (w.get('constructive') and not w.get('object_code')) or
                forbidden_work_type
            )
            w['needs_alias'] = bool(w_needs)

    park = parsed.get("park") or []
    if isinstance(park, list):
        for p in park:
            if isinstance(p, dict):
                _enrich_equipment_row(p)

    warnings = [
        warning for warning in list(parsed.get("warnings") or [])
        if not ("Накопитель '" in warning and "требует проверки по пикету" in warning)
    ]
    review_actions = parsed.setdefault("review_actions", {})
    review_actions["stockpiles_to_create"] = []
    stockpiles = parsed.get("stockpiles") or []
    if isinstance(stockpiles, list):
        for sp in stockpiles:
            if not isinstance(sp, dict):
                continue
            sp["material_code"], sp["material_suggestions"] = _check("material", sp.get("material"), sp.get("material_code"))
            rounded_pk = sp.get("rounded_pk")
            material_code = sp.get("material_code")
            if rounded_pk is None:
                sp["needs_create"] = None
                sp["requires_user_confirmation"] = True
                warnings.append(f"Накопитель '{sp.get('name')}' без распознанного пикета: нужна ручная проверка")
                continue
            try:
                rows = query(
                    """
                    SELECT
                      o.id::text AS object_id,
                      o.object_code,
                      o.name AS object_name,
                      s.id::text AS stockpile_id,
                      m.code AS material_code,
                      os.pk_start,
                      os.pk_raw_text
                    FROM objects o
                    JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'STOCKPILE'
                    LEFT JOIN object_segments os ON os.object_id = o.id
                    LEFT JOIN stockpiles s ON s.object_id = o.id
                    LEFT JOIN materials m ON m.id = s.material_id
                    WHERE ROUND((os.pk_start / 100.0)::numeric) = %s
                      AND (%s IS NULL OR m.code = %s OR s.material_id IS NULL)
                    ORDER BY CASE WHEN m.code = %s THEN 0 ELSE 1 END, o.created_at
                    LIMIT 1
                    """,
                    [rounded_pk, material_code, material_code, material_code],
                )
            except Exception:
                rows = []
            if rows:
                row = rows[0]
                sp.update({
                    "needs_create": False,
                    "requires_user_confirmation": False,
                    "existing_object_id": row.get("object_id"),
                    "existing_object_code": row.get("object_code"),
                    "existing_object_name": row.get("object_name"),
                    "existing_stockpile_id": row.get("stockpile_id"),
                    "action": "use_existing",
                })
            else:
                section_code = (parsed.get("header") or {}).get("section_code") or "UCH"
                proposed = f"STOCK_AUTO_{section_code}_{rounded_pk}_{material_code or 'MAT'}"
                pk_value = sp.get("pk_start") if sp.get("pk_start") is not None else float(rounded_pk) * 100
                proposed_name = _stockpile_canonical_name(material_code, pk_value, sp.get("material"))
                sp.update({
                    "needs_create": True,
                    "requires_user_confirmation": True,
                    "proposed_object_code": proposed[:100],
                    "proposed_object_name": proposed_name,
                    "name": proposed_name,
                    "action": "create_after_operator_confirmation",
                })
                review_actions["stockpiles_to_create"].append(sp)
                warnings.append(
                    f"Накопитель '{proposed_name}' на ПК {sp.get('pk_raw_text')} не найден в БД по округленному пикету {rounded_pk}; будет создан на этапе проверки"
                )

    piles = parsed.get("piles") or []
    if isinstance(piles, list):
        for p in piles:
            if not isinstance(p, dict):
                continue
            rows: list[dict[str, Any]] = []
            desired_field_type = _desired_pile_field_type(p)
            pk_hint = p.get("pk_start")
            try:
                if p.get("field_id"):
                    rows = query(
                        """SELECT id::text AS id, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text
                           FROM pile_fields WHERE id = %s LIMIT 1""",
                        [p.get("field_id")],
                    )
                elif p.get("field_code"):
                    rows = query(
                        """SELECT id::text AS id, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text
                           FROM pile_fields
                           WHERE COALESCE(is_demo, false) = false
                             AND field_code = %s
                           ORDER BY
                             CASE WHEN %s IS NOT NULL AND field_type = %s THEN 0 ELSE 1 END,
                             CASE WHEN %s IS NOT NULL AND %s BETWEEN LEAST(pk_start, pk_end) AND GREATEST(pk_start, pk_end) THEN 0 ELSE 1 END,
                             CASE WHEN %s IS NOT NULL THEN ABS(((pk_start + pk_end) / 2.0) - %s) ELSE 0 END,
                             CASE field_type WHEN 'main' THEN 0 ELSE 1 END,
                             pk_start NULLS LAST
                           LIMIT 1""",
                        [p.get("field_code"), desired_field_type, desired_field_type, pk_hint, pk_hint, pk_hint, pk_hint],
                    )
                elif pk_hint is not None:
                    rows = query(
                        """SELECT id::text AS id, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text
                           FROM pile_fields
                           WHERE COALESCE(is_demo, false) = false
                             AND %s BETWEEN LEAST(pk_start, pk_end) AND GREATEST(pk_start, pk_end)
                           ORDER BY
                             CASE WHEN %s IS NOT NULL AND field_type = %s THEN 0 ELSE 1 END,
                             ABS(((pk_start + pk_end) / 2.0) - %s),
                             CASE field_type WHEN 'main' THEN 0 ELSE 1 END
                           LIMIT 1""",
                        [pk_hint, desired_field_type, desired_field_type, pk_hint],
                    )
            except Exception:
                rows = []
            pipe_rows: list[dict[str, Any]] = []
            if not rows:
                try:
                    has_pipe_specs = bool(query("SELECT to_regclass('public.pipe_pile_specs') AS table_name")[0].get("table_name"))
                except Exception:
                    has_pipe_specs = False
                if has_pipe_specs:
                    field_id = str(p.get("field_id") or "").strip()
                    raw_pipe_id = field_id.split(":", 1)[1] if field_id.startswith("pipe:") else ""
                    label = str(p.get("object_code") or p.get("field_code") or p.get("pk_text") or "").strip()
                    desired_work_code = _pile_row_work_type_code(p)
                    try:
                        base_sql = """
                            SELECT
                              ('pipe:' || pps.id::text) AS id,
                              pps.id::text AS pipe_pile_spec_id,
                              o.id::text AS object_id,
                              o.object_code,
                              o.name AS object_name,
                              COALESCE(NULLIF(o.name, ''), o.object_code) AS field_code,
                              CASE WHEN wt.code = 'PILE_TRIAL' THEN 'test' ELSE 'main' END AS field_type,
                              ('L=' || trim(to_char(pps.pile_length_m, 'FM999999990.##')) || ' м') AS pile_type,
                              os.pk_start,
                              os.pk_end,
                              os.pk_raw_text,
                              wt.code AS work_type_code
                            FROM pipe_pile_specs pps
                            JOIN objects o ON o.id = pps.object_id
                            JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'PIPE'
                            JOIN work_types wt ON wt.id = pps.work_type_id
                            LEFT JOIN LATERAL (
                              SELECT pk_start, pk_end, pk_raw_text
                              FROM object_segments os
                              WHERE os.object_id = o.id
                              ORDER BY os.pk_start NULLS LAST
                              LIMIT 1
                            ) os ON true
                            WHERE pps.is_active IS TRUE
                              AND o.is_active IS NOT FALSE
                              AND wt.code IN ('PILE_MAIN', 'PILE_TRIAL')
                        """
                        if raw_pipe_id:
                            pipe_rows = query(base_sql + " AND pps.id = %s::uuid LIMIT 1", [raw_pipe_id])
                        elif label:
                            pipe_rows = query(
                                base_sql + """
                                  AND (
                                    o.object_code = %s
                                    OR o.name = %s
                                    OR o.name ILIKE %s
                                    OR o.object_code ILIKE %s
                                  )
                                ORDER BY
                                  CASE WHEN wt.code = %s THEN 0 ELSE 1 END,
                                  CASE WHEN %s IS NOT NULL AND os.pk_start IS NOT NULL AND %s BETWEEN LEAST(os.pk_start, os.pk_end) AND GREATEST(os.pk_start, os.pk_end) THEN 0 ELSE 1 END,
                                  CASE WHEN %s IS NOT NULL AND os.pk_start IS NOT NULL THEN ABS(((os.pk_start + COALESCE(os.pk_end, os.pk_start)) / 2.0) - %s) ELSE 0 END,
                                  o.object_code, wt.code
                                LIMIT 1
                                """,
                                [label, label, f"%{label}%", f"%{label}%", desired_work_code, pk_hint, pk_hint, pk_hint, pk_hint],
                            )
                        elif pk_hint is not None:
                            pipe_rows = query(
                                base_sql + """
                                  AND os.pk_start IS NOT NULL
                                  AND %s BETWEEN LEAST(os.pk_start, os.pk_end) AND GREATEST(os.pk_start, os.pk_end)
                                ORDER BY
                                  CASE WHEN wt.code = %s THEN 0 ELSE 1 END,
                                  ABS(((os.pk_start + COALESCE(os.pk_end, os.pk_start)) / 2.0) - %s),
                                  o.object_code, wt.code
                                LIMIT 1
                                """,
                                [pk_hint, desired_work_code, pk_hint],
                            )
                    except Exception:
                        pipe_rows = []
            if pipe_rows:
                pipe = pipe_rows[0]
                resolved_kind = "test" if pipe.get("field_type") == "test" else "main"
                p.update({
                    "field_id": pipe.get("id"),
                    "field_code": pipe.get("field_code"),
                    "field_type": pipe.get("field_type"),
                    "target_type": "pipe",
                    "object_id": pipe.get("object_id"),
                    "object_code": pipe.get("object_code"),
                    "object_name": pipe.get("object_name"),
                    "pipe_pile_spec_id": pipe.get("pipe_pile_spec_id"),
                    "work_type_code": pipe.get("work_type_code"),
                    "pile_kind": resolved_kind,
                    "pile_type": pipe.get("pile_type"),
                    "pile_length_label": _pile_length_label(pipe.get("pile_type")),
                    "pk_start": float(pipe["pk_start"]) if pipe.get("pk_start") is not None else None,
                    "pk_end": float(pipe["pk_end"]) if pipe.get("pk_end") is not None else None,
                    "pk_text": f"{_format_pk_db(pipe.get('pk_start'))} — {_format_pk_db(pipe.get('pk_end'))}",
                })
            elif rows:
                pf = rows[0]
                resolved_kind = "test" if pf.get("field_type") == "test" else "main"
                p.update({
                    "field_id": pf.get("id"),
                    "field_code": pf.get("field_code"),
                    "field_type": pf.get("field_type"),
                    "target_type": "pile_field",
                    "pile_kind": resolved_kind,
                    "pile_type": pf.get("pile_type"),
                    "pile_length_label": _pile_length_label(pf.get("pile_type")),
                    "pk_start": float(pf["pk_start"]) if pf.get("pk_start") is not None else None,
                    "pk_end": float(pf["pk_end"]) if pf.get("pk_end") is not None else None,
                    "pk_text": f"{_format_pk_db(pf.get('pk_start'))} — {_format_pk_db(pf.get('pk_end'))}",
                })
            else:
                warnings.append(f"Свайная строка '{p.get('field_code') or p.get('pk_text') or p.get('comment')}' требует выбора поля/ПЖБТ")
            if p.get("count") in (None, "", 0):
                warnings.append(f"Свайная строка '{p.get('field_code') or p.get('pk_text') or 'без поля'}' без количества")

    auto_pk_count = _enrich_payload_ad_rail_from_temp_roads(parsed)
    if auto_pk_count:
        warnings.append(f"Для {auto_pk_count} строк рассчитан ПК ВСЖМ по введенному ПК АД")

    aliases_summary = {
        "total_items": total_items,
        "resolved": resolved_items,
        "unresolved": total_items - resolved_items,
        "unresolved_samples": list(unresolved_samples.values())[:50],
        "suggestions": alias_suggestions[:100],
    }

    parsed["aliases"] = aliases_summary
    parsed["warnings"] = warnings
    _attach_parser_source_metadata(parsed, raw_text)
    parsed["initial_parse"] = _learning_payload_snapshot(parsed)
    return parsed


MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB


async def _read_upload_blob(file: UploadFile, *, max_size: int = MAX_UPLOAD_SIZE) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            raise HTTPException(413, f"Файл больше {max_size // (1024 * 1024)} МБ")
        chunks.append(chunk)
    blob = b"".join(chunks)
    if not blob:
        raise HTTPException(400, "Пустой файл")
    return blob


def _personnel_accommodation_clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def _personnel_accommodation_number(value: object, default: float = 0.0) -> float:
    if value in (None, ""):
        return default
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        text = _personnel_accommodation_clean(value).replace(",", ".")
        match = re.search(r"-?\d+(?:\.\d+)?", text)
        if not match:
            return default
        try:
            return float(match.group(0))
        except ValueError:
            return default


def _personnel_accommodation_parse_date(value: object) -> Optional[date_cls]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date_cls):
        return value
    text = _personnel_accommodation_clean(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        try:
            return date_cls.fromisoformat(text)
        except ValueError:
            return None
    match = re.search(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})", text)
    if not match:
        return None
    day, month, year = (int(part) for part in match.groups())
    if year < 100:
        year += 2000
    try:
        return date_cls(year, month, day)
    except ValueError:
        return None


def _personnel_accommodation_section_label(value: object) -> Optional[str]:
    text = _personnel_accommodation_clean(value)
    if not text:
        return None
    text = text.replace("_", ", ")
    match = re.search(r"с\s*(\d+)\s*по\s*(\d+)", text, flags=re.I)
    if match:
        start, end = int(match.group(1)), int(match.group(2))
        return ", ".join(str(num) for num in range(start, end + 1))
    nums = re.findall(r"\d+", text)
    return ", ".join(nums) if nums else text


def _personnel_accommodation_settlement(value: object) -> str:
    text = _personnel_accommodation_clean(value).lower().replace("ё", "е")
    known = [
        ("выползово", "Выползово"),
        ("угловка", "Угловка"),
        ("едрово", "Едрово"),
        ("гузятино", "Гузятино"),
        ("шуркино", "Шуркино"),
        ("корытница", "Корытница"),
        ("валдай", "Валдай"),
        ("окуловка", "Окуловка"),
        ("болог", "Бологое"),
    ]
    for needle, label in known:
        if needle in text:
            return label
    match = re.search(r"(?:г\.|город|п\.|пос\.|с\.|д\.|деревня|раб\.п\.)\s*([а-яa-z-]+)", text, flags=re.I)
    if match:
        return match.group(1).strip().capitalize()
    return "Не указан"


def _personnel_accommodation_camp_name(value: object) -> str:
    text = _personnel_accommodation_clean(value).lower().replace("ё", "е")
    if "угловк" in text:
        return "пос. Угловка"
    if "едров" in text:
        return "с. Едрово"
    if "выползов" in text:
        return "пос. Выползово"
    return _personnel_accommodation_clean(value) or "Не указан"


def _personnel_accommodation_free(value: object, places: float, residents: float) -> float:
    if value not in (None, ""):
        return _personnel_accommodation_number(value)
    return max(places - residents, 0.0)


def _ensure_personnel_accommodation_schema() -> None:
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS personnel_accommodation_snapshots (
                      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                      report_date date NOT NULL UNIQUE,
                      source_filename text,
                      source_reference text,
                      sheet_name text,
                      imported_by text,
                      imported_at timestamptz NOT NULL DEFAULT now(),
                      row_count integer NOT NULL DEFAULT 0,
                      raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS personnel_accommodation_rows (
                      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                      snapshot_id uuid NOT NULL REFERENCES personnel_accommodation_snapshots(id) ON DELETE CASCADE,
                      group_kind text NOT NULL CHECK (group_kind IN ('hotels_apartments', 'dorms_canteens')),
                      facility_type text NOT NULL CHECK (facility_type IN ('hotel', 'apartment', 'dorm', 'canteen')),
                      settlement text,
                      camp_name text,
                      section_label text,
                      facility_name text NOT NULL,
                      address text,
                      places_total numeric,
                      places_base numeric,
                      places_actual numeric,
                      residents numeric,
                      free_places numeric,
                      itr_places_total numeric,
                      itr_places_occupied numeric,
                      canteen_people numeric,
                      canteen_seats_plan numeric,
                      canteen_seats_fact numeric,
                      note text,
                      sort_order integer NOT NULL DEFAULT 0,
                      raw_row jsonb NOT NULL DEFAULT '{}'::jsonb,
                      created_at timestamptz NOT NULL DEFAULT now()
                    )
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_personnel_accommodation_rows_snapshot
                    ON personnel_accommodation_rows(snapshot_id, group_kind, sort_order)
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_personnel_accommodation_rows_groups
                    ON personnel_accommodation_rows(snapshot_id, settlement, camp_name, facility_type)
                """)
    finally:
        conn.close()


def _personnel_accommodation_source_sheet(workbook: Any):
    preferred_title = "Исходные данные"
    for sheet_name in workbook.sheetnames:
        if _personnel_accommodation_clean(sheet_name).casefold() == preferred_title.casefold():
            return workbook[sheet_name]
    if len(workbook.sheetnames) == 1:
        return workbook[workbook.sheetnames[0]]
    raise HTTPException(
        400,
        "В файле нет листа «Исходные данные». Если отчет содержит один лист, он может называться как угодно; "
        "для книги с несколькими листами нужен лист «Исходные данные».",
    )


def _parse_personnel_accommodation_workbook(filename: str, blob: bytes, report_date: Optional[date_cls] = None) -> dict[str, Any]:
    try:
        workbook = load_workbook(BytesIO(blob), data_only=True, read_only=True)
    except Exception as exc:
        raise HTTPException(400, f"Не удалось открыть XLSX отчета по гостиницам: {exc}") from exc
    try:
        sheet = _personnel_accommodation_source_sheet(workbook)
        resolved_date = report_date or _personnel_accommodation_parse_date(sheet.cell(1, 1).value)
        if not resolved_date:
            raise HTTPException(400, "Не удалось определить дату отчета по гостиницам из ячейки A1")

        rows: list[dict[str, Any]] = []
        for row_idx in range(5, sheet.max_row + 1):
            first = _personnel_accommodation_clean(sheet.cell(row_idx, 1).value)
            if first.lower().startswith("всего"):
                break
            name = _personnel_accommodation_clean(sheet.cell(row_idx, 2).value)
            address = _personnel_accommodation_clean(sheet.cell(row_idx, 3).value)
            if not name or (not address and _personnel_accommodation_number(sheet.cell(row_idx, 5).value) <= 0):
                continue
            places = _personnel_accommodation_number(sheet.cell(row_idx, 5).value)
            residents = _personnel_accommodation_number(sheet.cell(row_idx, 6).value)
            free_places = _personnel_accommodation_free(sheet.cell(row_idx, 9).value, places, residents)
            facility_type = "apartment" if name.lower().replace("ё", "е") == "квартиры" else "hotel"
            item = {
                "group_kind": "hotels_apartments",
                "facility_type": facility_type,
                "settlement": _personnel_accommodation_settlement(address),
                "camp_name": None,
                "section_label": _personnel_accommodation_section_label(first),
                "facility_name": name,
                "address": address,
                "places_total": places,
                "places_base": None,
                "places_actual": places,
                "residents": residents,
                "free_places": free_places,
                "itr_places_total": None,
                "itr_places_occupied": None,
                "canteen_people": None,
                "canteen_seats_plan": None,
                "canteen_seats_fact": None,
                "note": _personnel_accommodation_clean(sheet.cell(row_idx, 12).value) or None,
                "sort_order": row_idx,
            }
            item["raw_row"] = {key: value for key, value in item.items() if key != "raw_row"}
            rows.append(item)

        dorm_title_row = None
        canteen_title_row = None
        for row_idx in range(1, sheet.max_row + 1):
            marker = _personnel_accommodation_clean(sheet.cell(row_idx, 1).value).lower().replace("ё", "е")
            if dorm_title_row is None and "общежития модульного типа" in marker:
                dorm_title_row = row_idx
            if canteen_title_row is None and "столовая модульного типа" in marker:
                canteen_title_row = row_idx
        if dorm_title_row:
            stop_row = canteen_title_row or (sheet.max_row + 1)
            for row_idx in range(dorm_title_row + 3, stop_row):
                name = _personnel_accommodation_clean(sheet.cell(row_idx, 1).value)
                if not name:
                    continue
                places_base = _personnel_accommodation_number(sheet.cell(row_idx, 4).value)
                places_actual = _personnel_accommodation_number(sheet.cell(row_idx, 5).value)
                residents = _personnel_accommodation_number(sheet.cell(row_idx, 8).value)
                free_places = _personnel_accommodation_free(sheet.cell(row_idx, 9).value, places_actual, residents)
                camp_name = _personnel_accommodation_camp_name(name)
                item = {
                    "group_kind": "dorms_canteens",
                    "facility_type": "dorm",
                    "settlement": camp_name.replace("пос. ", "").replace("с. ", ""),
                    "camp_name": camp_name,
                    "section_label": None,
                    "facility_name": name,
                    "address": None,
                    "places_total": places_actual,
                    "places_base": places_base,
                    "places_actual": places_actual,
                    "residents": residents,
                    "free_places": free_places,
                    "itr_places_total": _personnel_accommodation_number(sheet.cell(row_idx, 6).value),
                    "itr_places_occupied": _personnel_accommodation_number(sheet.cell(row_idx, 7).value),
                    "canteen_people": None,
                    "canteen_seats_plan": None,
                    "canteen_seats_fact": None,
                    "note": _personnel_accommodation_clean(sheet.cell(row_idx, 10).value) or None,
                    "sort_order": row_idx,
                }
                item["raw_row"] = {key: value for key, value in item.items() if key != "raw_row"}
                rows.append(item)

        if canteen_title_row:
            for row_idx in range(canteen_title_row + 3, sheet.max_row + 1):
                name = _personnel_accommodation_clean(sheet.cell(row_idx, 1).value)
                if not name:
                    continue
                camp_name = _personnel_accommodation_camp_name(name)
                item = {
                    "group_kind": "dorms_canteens",
                    "facility_type": "canteen",
                    "settlement": camp_name.replace("пос. ", "").replace("с. ", ""),
                    "camp_name": camp_name,
                    "section_label": None,
                    "facility_name": name,
                    "address": None,
                    "places_total": None,
                    "places_base": None,
                    "places_actual": None,
                    "residents": None,
                    "free_places": None,
                    "itr_places_total": None,
                    "itr_places_occupied": None,
                    "canteen_people": _personnel_accommodation_number(sheet.cell(row_idx, 5).value),
                    "canteen_seats_plan": _personnel_accommodation_number(sheet.cell(row_idx, 8).value),
                    "canteen_seats_fact": _personnel_accommodation_number(sheet.cell(row_idx, 6).value),
                    "note": None,
                    "sort_order": row_idx,
                }
                item["raw_row"] = {key: value for key, value in item.items() if key != "raw_row"}
                rows.append(item)

        if not rows:
            raise HTTPException(400, "В отчете по гостиницам не найдено строк размещения")
        return {
            "source_filename": filename,
            "sheet_name": sheet.title,
            "report_date": resolved_date,
            "rows": rows,
            "row_count": len(rows),
        }
    finally:
        workbook.close()


def _personnel_accommodation_summary(rows: list[dict[str, Any]]) -> dict[str, float | int]:
    hotel_rows = [row for row in rows if row.get("group_kind") == "hotels_apartments"]
    dorm_rows = [row for row in rows if row.get("facility_type") == "dorm"]
    canteen_rows = [row for row in rows if row.get("facility_type") == "canteen"]
    hotel_places = sum(_personnel_accommodation_number(row.get("places_total")) for row in hotel_rows)
    hotel_residents = sum(_personnel_accommodation_number(row.get("residents")) for row in hotel_rows)
    dorm_places = sum(_personnel_accommodation_number(row.get("places_total")) for row in dorm_rows)
    dorm_residents = sum(_personnel_accommodation_number(row.get("residents")) for row in dorm_rows)
    return {
        "total_places": round(hotel_places + dorm_places, 1),
        "total_residents": round(hotel_residents + dorm_residents, 1),
        "total_free": round(sum(_personnel_accommodation_number(row.get("free_places")) for row in [*hotel_rows, *dorm_rows]), 1),
        "hotel_apartment_places": round(hotel_places, 1),
        "hotel_apartment_residents": round(hotel_residents, 1),
        "hotel_apartment_free": round(sum(_personnel_accommodation_number(row.get("free_places")) for row in hotel_rows), 1),
        "hotel_count": sum(1 for row in hotel_rows if row.get("facility_type") == "hotel"),
        "apartment_count": sum(1 for row in hotel_rows if row.get("facility_type") == "apartment"),
        "dorm_places": round(dorm_places, 1),
        "dorm_residents": round(dorm_residents, 1),
        "dorm_free": round(sum(_personnel_accommodation_number(row.get("free_places")) for row in dorm_rows), 1),
        "dorm_count": len(dorm_rows),
        "canteen_people": round(sum(_personnel_accommodation_number(row.get("canteen_people")) for row in canteen_rows), 1),
        "canteen_seats_fact": round(sum(_personnel_accommodation_number(row.get("canteen_seats_fact")) for row in canteen_rows), 1),
        "canteen_seats_plan": round(sum(_personnel_accommodation_number(row.get("canteen_seats_plan")) for row in canteen_rows), 1),
        "canteen_count": len(canteen_rows),
    }


def _import_personnel_accommodation_snapshot(parsed: dict[str, Any], *, source_reference: str, imported_by: Optional[str]) -> dict[str, Any]:
    _ensure_personnel_accommodation_schema()
    summary = _personnel_accommodation_summary(parsed["rows"])
    payload = {
        "summary": summary,
        "source_filename": parsed["source_filename"],
        "sheet_name": parsed["sheet_name"],
        "report_date": parsed["report_date"].isoformat(),
    }
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO personnel_accommodation_snapshots (
                      report_date, source_filename, source_reference, sheet_name,
                      imported_by, imported_at, row_count, raw_payload
                    )
                    VALUES (%s, %s, %s, %s, %s, now(), %s, %s::jsonb)
                    ON CONFLICT (report_date) DO UPDATE
                    SET source_filename = EXCLUDED.source_filename,
                        source_reference = EXCLUDED.source_reference,
                        sheet_name = EXCLUDED.sheet_name,
                        imported_by = EXCLUDED.imported_by,
                        imported_at = now(),
                        row_count = EXCLUDED.row_count,
                        raw_payload = EXCLUDED.raw_payload
                    RETURNING id::text
                    """,
                    (
                        parsed["report_date"],
                        parsed["source_filename"],
                        source_reference,
                        parsed["sheet_name"],
                        imported_by,
                        parsed["row_count"],
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
                snapshot_id = cur.fetchone()[0]
                cur.execute("DELETE FROM personnel_accommodation_rows WHERE snapshot_id = %s::uuid", (snapshot_id,))
                for row in parsed["rows"]:
                    cur.execute(
                        """
                        INSERT INTO personnel_accommodation_rows (
                          snapshot_id, group_kind, facility_type, settlement, camp_name,
                          section_label, facility_name, address, places_total, places_base,
                          places_actual, residents, free_places, itr_places_total,
                          itr_places_occupied, canteen_people, canteen_seats_plan,
                          canteen_seats_fact, note, sort_order, raw_row
                        )
                        VALUES (
                          %s::uuid, %s, %s, NULLIF(%s, ''), NULLIF(%s, ''),
                          NULLIF(%s, ''), %s, NULLIF(%s, ''), %s, %s,
                          %s, %s, %s, %s, %s, %s, %s, %s, NULLIF(%s, ''),
                          %s, %s::jsonb
                        )
                        """,
                        (
                            snapshot_id,
                            row.get("group_kind"),
                            row.get("facility_type"),
                            row.get("settlement"),
                            row.get("camp_name"),
                            row.get("section_label"),
                            row.get("facility_name"),
                            row.get("address"),
                            row.get("places_total"),
                            row.get("places_base"),
                            row.get("places_actual"),
                            row.get("residents"),
                            row.get("free_places"),
                            row.get("itr_places_total"),
                            row.get("itr_places_occupied"),
                            row.get("canteen_people"),
                            row.get("canteen_seats_plan"),
                            row.get("canteen_seats_fact"),
                            row.get("note"),
                            row.get("sort_order"),
                            json.dumps(row.get("raw_row") or {}, ensure_ascii=False),
                        ),
                    )
        _invalidate_dashboard_cache_after_report_write("personnel_accommodation_import")
        return {
            "ok": True,
            "snapshot_id": snapshot_id,
            "source_filename": parsed["source_filename"],
            "report_date": parsed["report_date"].isoformat(),
            "sheet_name": parsed["sheet_name"],
            "row_count": parsed["row_count"],
            "summary": summary,
        }
    finally:
        conn.close()


def _personnel_accommodation_db_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in (
        "places_total", "places_base", "places_actual", "residents", "free_places",
        "itr_places_total", "itr_places_occupied", "canteen_people",
        "canteen_seats_plan", "canteen_seats_fact",
    ):
        out[key] = round(_personnel_accommodation_number(out.get(key)), 1) if out.get(key) is not None else None
    for key in ("id", "snapshot_id"):
        if out.get(key) is not None:
            out[key] = str(out[key])
    return out


def _personnel_accommodation_group_totals(items: list[dict[str, Any]]) -> dict[str, float | int]:
    return {
        "places": round(sum(_personnel_accommodation_number(row.get("places_total")) for row in items), 1),
        "residents": round(sum(_personnel_accommodation_number(row.get("residents")) for row in items), 1),
        "free": round(sum(_personnel_accommodation_number(row.get("free_places")) for row in items), 1),
        "canteen_people": round(sum(_personnel_accommodation_number(row.get("canteen_people")) for row in items), 1),
        "canteen_seats_fact": round(sum(_personnel_accommodation_number(row.get("canteen_seats_fact")) for row in items), 1),
        "canteen_seats_plan": round(sum(_personnel_accommodation_number(row.get("canteen_seats_plan")) for row in items), 1),
        "items_count": len(items),
    }


def _build_personnel_accommodation_payload(snapshot: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    normalized_rows = [_personnel_accommodation_db_row(row) for row in rows]
    summary = _personnel_accommodation_summary(normalized_rows)

    settlements: list[dict[str, Any]] = []
    by_settlement: dict[str, list[dict[str, Any]]] = {}
    for row in normalized_rows:
        if row.get("group_kind") == "hotels_apartments":
            by_settlement.setdefault(row.get("settlement") or "Не указан", []).append(row)
    for settlement, items in by_settlement.items():
        items.sort(key=lambda row: (row.get("facility_type") != "hotel", row.get("facility_name") or "", row.get("address") or ""))
        totals = _personnel_accommodation_group_totals(items)
        settlements.append({
            "settlement": settlement,
            "totals": totals,
            "hotels_count": sum(1 for row in items if row.get("facility_type") == "hotel"),
            "apartments_count": sum(1 for row in items if row.get("facility_type") == "apartment"),
            "sections": sorted({str(row.get("section_label")) for row in items if row.get("section_label")}),
            "items": items,
        })
    settlements.sort(key=lambda item: (-float(item["totals"]["residents"]), item["settlement"]))

    camps: list[dict[str, Any]] = []
    camp_names = sorted({
        row.get("camp_name") or "Не указан"
        for row in normalized_rows
        if row.get("group_kind") == "dorms_canteens"
    })
    camp_order = {"пос. Угловка": 1, "с. Едрово": 2, "пос. Выползово": 3}
    for camp_name in sorted(camp_names, key=lambda value: (camp_order.get(value, 99), value)):
        dorms = [row for row in normalized_rows if row.get("camp_name") == camp_name and row.get("facility_type") == "dorm"]
        canteens = [row for row in normalized_rows if row.get("camp_name") == camp_name and row.get("facility_type") == "canteen"]
        dorms.sort(key=lambda row: int(row.get("sort_order") or 0))
        canteens.sort(key=lambda row: int(row.get("sort_order") or 0))
        camps.append({
            "camp_name": camp_name,
            "settlement": (dorms or canteens or [{}])[0].get("settlement") or camp_name,
            "totals": _personnel_accommodation_group_totals([*dorms, *canteens]),
            "dorms": dorms,
            "canteens": canteens,
        })

    return {
        "ok": True,
        "snapshot": {
            "id": str(snapshot.get("id")),
            "report_date": snapshot.get("report_date").isoformat() if hasattr(snapshot.get("report_date"), "isoformat") else str(snapshot.get("report_date") or ""),
            "source_filename": snapshot.get("source_filename"),
            "sheet_name": snapshot.get("sheet_name"),
            "imported_at": snapshot.get("imported_at").isoformat() if hasattr(snapshot.get("imported_at"), "isoformat") else str(snapshot.get("imported_at") or ""),
            "imported_by": snapshot.get("imported_by"),
            "row_count": int(snapshot.get("row_count") or len(normalized_rows)),
        },
        "summary": summary,
        "hotels_apartments": {
            "settlements": settlements,
            "items": [row for row in normalized_rows if row.get("group_kind") == "hotels_apartments"],
        },
        "dorms_canteens": {
            "camps": camps,
            "dorms": [row for row in normalized_rows if row.get("facility_type") == "dorm"],
            "canteens": [row for row in normalized_rows if row.get("facility_type") == "canteen"],
        },
    }


@router.get("/personnel-accommodation")
def personnel_accommodation(
    date: Optional[str] = Query(None),
    _user=Depends(current_user),
):
    _ensure_personnel_accommodation_schema()
    requested_date = _personnel_accommodation_parse_date(date) if date else None
    if date and not requested_date:
        raise HTTPException(400, "Неверная дата размещения персонала")
    if requested_date:
        snapshot = query_one(
            """
            SELECT id, report_date, source_filename, sheet_name, imported_at, imported_by, row_count
            FROM personnel_accommodation_snapshots
            WHERE report_date = %s
            LIMIT 1
            """,
            (requested_date,),
        )
    else:
        snapshot = query_one(
            """
            SELECT id, report_date, source_filename, sheet_name, imported_at, imported_by, row_count
            FROM personnel_accommodation_snapshots
            ORDER BY report_date DESC, imported_at DESC
            LIMIT 1
            """
        )
    if not snapshot:
        return {"ok": False, "detail": "Данные по размещению персонала еще не загружены"}
    rows = query(
        """
        SELECT id, snapshot_id, group_kind, facility_type, settlement, camp_name,
               section_label, facility_name, address, places_total, places_base,
               places_actual, residents, free_places, itr_places_total,
               itr_places_occupied, canteen_people, canteen_seats_plan,
               canteen_seats_fact, note, sort_order
        FROM personnel_accommodation_rows
        WHERE snapshot_id = %s
        ORDER BY group_kind, sort_order, facility_name
        """,
        (snapshot["id"],),
    )
    return _build_personnel_accommodation_payload(snapshot, rows)


@router.post("/personnel-accommodation/import")
async def import_personnel_accommodation(
    file: UploadFile = File(...),
    report_date: Optional[str] = Query(None),
    manager=Depends(require_settings_manager),
):
    filename = file.filename or "personnel_accommodation.xlsx"
    if not filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Загрузите XLSX-файл отчета по гостиницам")
    parsed_report_date = _personnel_accommodation_parse_date(report_date) if report_date else None
    if report_date and not parsed_report_date:
        raise HTTPException(400, "Неверная дата отчета по гостиницам")
    parsed = _parse_personnel_accommodation_workbook(filename, await _read_upload_blob(file), parsed_report_date)
    return _import_personnel_accommodation_snapshot(
        parsed,
        source_reference=filename,
        imported_by=getattr(manager, "username", None),
    )


def _report_upload_blob_to_text(filename: str, blob: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        raise HTTPException(400, "PDF не поддерживается для разбора. Загрузите .txt, .log, .xlsx или .xlsm")
    if not (name.endswith(".txt") or name.endswith(".log") or name.endswith(".xlsx") or name.endswith(".xlsm")):
        raise HTTPException(400, "Поддерживаются только .txt, .log, .xlsx и .xlsm")

    if name.endswith((".xlsx", ".xlsm")):
        try:
            return xlsx_bytes_to_report_text(blob)
        except Exception as exc:
            raise HTTPException(400, f"Не удалось разобрать Excel-шаблон: {exc}") from exc
    try:
        return blob.decode("utf-8")
    except UnicodeDecodeError:
        return blob.decode("cp1251", errors="replace")


def _parse_report_upload_payloads(filename: str, blob: bytes) -> list[dict[str, Any]]:
    raw_text = _report_upload_blob_to_text(filename, blob)
    report_chunks = split_report_texts(raw_text)
    source_name = filename or "report.txt"
    if len(report_chunks) > 1:
        return [
            _parse_report_text(f"{source_name} #{idx}", chunk)
            for idx, chunk in enumerate(report_chunks, start=1)
        ]
    return [_parse_report_text(source_name, report_chunks[0])]


@router.post("/preview")
async def preview_report(file: UploadFile = File(...)):
    """
    multipart/form-data: file=<.txt | .log | .xlsx | .xlsm>
    Возвращает распарсенную структуру (ни одной записи в БД не создаётся).
    """
    source_name = file.filename or "report.txt"
    raw_text = _report_upload_blob_to_text(source_name, await _read_upload_blob(file))

    report_chunks = split_report_texts(raw_text)
    if len(report_chunks) > 1:
        return {
            "batch": True,
            "source_filename": source_name,
            "count": len(report_chunks),
            "reports": [
                _parse_report_text(f"{source_name} #{idx}", chunk)
                for idx, chunk in enumerate(report_chunks, start=1)
            ],
        }

    parsed = _parse_report_text(source_name, report_chunks[0])
    return parsed


REPORT_M_DATE_RE = re.compile(r"(?P<day>\d{1,2})[._-]+(?P<month>\d{1,2})[._-]+(?P<year>\d{2,4})")
REPORT_DATE_SHORT_RE = re.compile(r"(?P<day>\d{1,2})[._-]+(?P<month>\d{1,2})(?:[._-]+(?P<year>\d{2,4}))?")
REPORT_M_SUMMARY_EQUIPMENT_TYPES = {
    "в работе",
    "водителей",
    "простой",
    "ремонт",
    "статус техники/ водителей",
    "техники",
}


def _report_m_clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def _report_m_normalize_identifier(value: Any) -> str:
    text = "" if value is None else str(value).strip().upper().replace("Ё", "Е")
    return re.sub(r"[^0-9A-ZА-Я]+", "", text)


_EQUIPMENT_EMPTY_IDENTIFIER_NORMS = {"", "БН", "НД", "НЕТ", "NONE", "NULL", "UNKNOWN", "БЕЗНОМЕРА"}


def _equipment_master_plate_should_be_ignored(row: dict[str, Any]) -> bool:
    plate = _report_m_clean_text(row.get("plate_number") or row.get("plate")) or ""
    plate_norm = (
        row.get("plate_number_norm")
        or _normalize_equipment_identifier(plate)
        or _report_m_normalize_identifier(plate)
    )
    if not plate_norm:
        return False
    if plate_norm in _EQUIPMENT_EMPTY_IDENTIFIER_NORMS:
        return True

    unit_norm = (
        row.get("unit_number_norm")
        or _normalize_equipment_identifier(row.get("unit_number") or row.get("reported_number"))
        or _report_m_normalize_identifier(row.get("unit_number") or row.get("reported_number"))
    )
    vin_norm = (
        row.get("vin_norm")
        or _normalize_equipment_identifier(row.get("vin"))
        or _report_m_normalize_identifier(row.get("vin"))
    )
    if vin_norm and plate_norm == vin_norm:
        return True
    if plate_norm.isdigit() and unit_norm and plate_norm == unit_norm:
        return True

    brand_model = (_report_m_clean_text(row.get("brand_model")) or "").lower()
    plate_raw_norm = _report_m_normalize_identifier(plate)
    unit_raw_norm = _report_m_normalize_identifier(row.get("unit_number"))
    vin_raw_norm = _report_m_normalize_identifier(row.get("vin"))
    if (
        plate_raw_norm == "6977ХА27"
        and (
            "tts xt360e" in brand_model
            or unit_raw_norm == "TTS360EZDPHH31565"
            or vin_raw_norm == "TTS360EZDPHH31565"
        )
    ):
        return True

    return False


def _equipment_master_clean_historical_plate(value: Any) -> Optional[str]:
    plate = _report_m_clean_text(value)
    if not plate:
        return None
    cleaned = re.sub(r"\s*БЫЛ.*$", "", plate, flags=re.IGNORECASE).strip()
    return cleaned or plate


def _sanitize_equipment_master_row(row: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(row)
    plate = _equipment_master_clean_historical_plate(row.get("plate_number") or row.get("plate"))
    if plate != _report_m_clean_text(row.get("plate_number") or row.get("plate")):
        sanitized["plate_number"] = plate
        sanitized["plate"] = plate
        sanitized["plate_number_norm"] = _normalize_equipment_identifier(plate)
    should_ignore_plate = _equipment_master_plate_should_be_ignored(sanitized)
    vin = _report_m_clean_text(row.get("vin"))
    detected_vin = None
    unit = _report_m_clean_text(row.get("unit_number"))
    if unit and _report_m_looks_like_vin(unit):
        detected_vin = unit
        sanitized["unit_number"] = None
        sanitized["unit_number_norm"] = ""
    if plate and _report_m_looks_like_vin(plate):
        detected_vin = detected_vin or plate
        should_ignore_plate = True
    should_ignore_vin = bool(vin and not _report_m_looks_like_vin(vin))
    current_vin_is_valid = bool(vin and _report_m_looks_like_vin(vin))
    if detected_vin and not current_vin_is_valid:
        sanitized["vin"] = detected_vin
        sanitized["vin_norm"] = _normalize_equipment_identifier(detected_vin)
        should_ignore_vin = False
    if not should_ignore_plate and not should_ignore_vin and sanitized == row:
        return row
    if should_ignore_plate:
        sanitized["plate_number"] = None
        sanitized["plate"] = None
        sanitized["plate_number_norm"] = ""
    if should_ignore_vin:
        sanitized["vin"] = None
        sanitized["vin_norm"] = ""
    return sanitized


def _report_m_parse_date(value: str) -> Optional[str]:
    match = REPORT_M_DATE_RE.search(value or "")
    if not match:
        return None
    try:
        year = int(match.group("year"))
        if year < 100:
            year += 2000
        return date_cls(year, int(match.group("month")), int(match.group("day"))).isoformat()
    except ValueError:
        return None


def _operation_report_parse_date(value: str, *, fallback_year: Optional[int] = None) -> Optional[str]:
    text_value = value or ""
    parsed = _report_m_parse_date(text_value)
    if parsed:
        return parsed
    match = REPORT_DATE_SHORT_RE.search(text_value)
    if not match:
        return None
    year_text = match.group("year")
    year = fallback_year or date_cls.today().year
    if year_text:
        year = int(year_text)
        if year < 100:
            year += 2000
    try:
        return date_cls(year, int(match.group("month")), int(match.group("day"))).isoformat()
    except ValueError:
        return None


def _operation_report_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    text_value = _report_m_clean_text(value)
    if not text_value:
        return None
    if text_value.strip().upper() in {"#N/A", "N/A", "NA", "-", "—", "Н/Д", "НД"}:
        return None
    normalized = text_value.replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    try:
        parsed = float(normalized)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _operation_report_hours(value: Any) -> Optional[float]:
    if value is None:
        return None
    if hasattr(value, "hour") and hasattr(value, "minute") and hasattr(value, "second"):
        return float(value.hour) + float(value.minute) / 60.0 + float(value.second) / 3600.0
    if isinstance(value, timedelta):
        return max(0.0, value.total_seconds() / 3600.0)
    numeric = _operation_report_number(value)
    if numeric is not None:
        text_value = _report_m_clean_text(value) or ""
        if ":" not in text_value:
            return numeric
    text_value = _report_m_clean_text(value)
    if not text_value:
        return None
    if text_value.strip().upper() in {"#N/A", "N/A", "NA", "-", "—", "Н/Д", "НД"}:
        return None
    match = re.match(r"^\s*(?P<h>\d+):(?P<m>\d{1,2})(?::(?P<s>\d{1,2}))?\s*$", text_value)
    if not match:
        return numeric
    return (
        float(match.group("h"))
        + float(match.group("m")) / 60.0
        + float(match.group("s") or 0) / 3600.0
    )


def _operation_report_cell(row: tuple[Any, ...], index: Optional[int]) -> Any:
    if index is None or index >= len(row):
        return None
    return row[index]


def _operation_report_find_sheet(workbook, preferred_name: str = "Сачков"):
    preferred = preferred_name.strip().lower().replace("ё", "е")
    for sheet in workbook.worksheets:
        if sheet.title.strip().lower().replace("ё", "е") == preferred:
            return sheet
    for sheet in workbook.worksheets:
        if preferred in sheet.title.strip().lower().replace("ё", "е"):
            return sheet
    return workbook.worksheets[0] if workbook.worksheets else None


def _operation_report_find_header_row(sheet) -> tuple[int, tuple[Any, ...], tuple[Any, ...]]:
    for row_number, row in enumerate(sheet.iter_rows(min_row=1, max_row=min(sheet.max_row, 12), values_only=True), start=1):
        normalized = [(_report_m_clean_text(cell) or "").lower().replace("ё", "е") for cell in row]
        joined = " | ".join(normalized)
        if "тип техники" in joined and "марка" in joined and ("г/н" in joined or "гос" in joined):
            group_row = tuple(
                sheet.cell(row_number - 2, column=index + 1).value if row_number > 2 else None
                for index in range(len(row))
            )
            return row_number, tuple(row), group_row
    raise HTTPException(400, "На листе Сачков не найдена шапка техники")


def _operation_report_metric_groups(headers: tuple[Any, ...], group_headers: tuple[Any, ...]) -> dict[str, dict[str, Optional[int]]]:
    groups: dict[str, dict[str, Optional[int]]] = {}
    current_group = ""
    for index, (header, group_header) in enumerate(zip(headers, group_headers)):
        group_text = _report_m_clean_text(group_header)
        if group_text:
            current_group = group_text
        header_text = (_report_m_clean_text(header) or "").lower().replace("ё", "е")
        if not current_group or not header_text:
            continue
        group = groups.setdefault(current_group, {"mileage": None, "engine_hours": None, "fuel": None})
        if "пробег" in header_text:
            group["mileage"] = index
        elif "моточ" in header_text:
            group["engine_hours"] = index
        elif "расход" in header_text and "л" in header_text:
            group["fuel"] = index
    return {
        name: indexes
        for name, indexes in groups.items()
        if any(value is not None for value in indexes.values())
    }


def _operation_report_pick_metrics(row: tuple[Any, ...], metric_groups: dict[str, dict[str, Optional[int]]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    group_values: list[dict[str, Any]] = []
    for group_name, indexes in metric_groups.items():
        mileage_raw = _operation_report_cell(row, indexes.get("mileage"))
        engine_raw = _operation_report_cell(row, indexes.get("engine_hours"))
        fuel_raw = _operation_report_cell(row, indexes.get("fuel"))
        values = {
            "source": group_name,
            "mileage_km": _operation_report_number(mileage_raw),
            "engine_hours": _operation_report_hours(engine_raw),
            "fuel_liters": _operation_report_number(fuel_raw),
            "mileage_raw": _report_m_clean_text(mileage_raw),
            "engine_hours_raw": _report_m_clean_text(engine_raw),
            "fuel_raw": _report_m_clean_text(fuel_raw),
        }
        group_values.append(values)

    total = next((item for item in group_values if "итог" in item["source"].lower()), None)
    if total and any(total.get(key) is not None for key in ("mileage_km", "engine_hours", "fuel_liters")):
        return total, group_values

    candidates = [
        item for item in group_values
        if any(item.get(key) is not None for key in ("mileage_km", "engine_hours", "fuel_liters"))
    ]
    if not candidates:
        return {
            "source": None,
            "mileage_km": None,
            "engine_hours": None,
            "fuel_liters": None,
            "mileage_raw": None,
            "engine_hours_raw": None,
            "fuel_raw": None,
        }, group_values

    def score(item: dict[str, Any]) -> tuple[int, float]:
        filled = sum(1 for key in ("mileage_km", "engine_hours", "fuel_liters") if item.get(key) is not None)
        magnitude = sum(abs(float(item.get(key) or 0)) for key in ("mileage_km", "engine_hours", "fuel_liters"))
        return filled, magnitude

    return max(candidates, key=score), group_values


def _parse_equipment_operation_workbook(filename: str, blob: bytes, report_date: Optional[str] = None) -> dict[str, Any]:
    try:
        workbook = load_workbook(BytesIO(blob), read_only=True, data_only=True)
    except Exception as exc:
        raise HTTPException(400, f"Не удалось открыть XLSX отчета эксплуатации техники: {exc}") from exc
    try:
        sheet = _operation_report_find_sheet(workbook, "Сачков")
        if sheet is None:
            raise HTTPException(400, "В книге нет листов")
        resolved_report_date = report_date or _operation_report_parse_date(sheet.title) or _operation_report_parse_date(filename)
        if not resolved_report_date:
            raise HTTPException(400, "Не удалось определить дату отчета эксплуатации из имени файла или листа")
        header_row_number, headers, group_headers = _operation_report_find_header_row(sheet)
        indexes = {
            "location": _report_m_header_index(list(headers), ["местонахождение"]),
            "equipment_type": _report_m_header_index(list(headers), ["тип", "техник"]),
            "brand_model": _report_m_header_index(list(headers), ["марка", "модель"]),
            "plate_number": _report_m_header_index(list(headers), ["г/н"]),
            "unit_number": _report_m_header_index(list(headers), ["борт"]),
            "status": _report_m_header_index(list(headers), ["статус"]),
            "drivers_count": _report_m_header_index(list(headers), ["водител"]),
            "repair_reason": _report_m_header_index(list(headers), ["причина"]),
            "stopped_at": _report_m_header_index(list(headers), ["дата", "останов"]),
            "planned_work_at": _report_m_header_index(list(headers), ["планируем", "дата"]),
            "comment": _report_m_header_index(list(headers), ["примечан"]),
            "vin": _report_m_header_index(list(headers), ["вин"]),
        }
        metric_groups = _operation_report_metric_groups(headers, group_headers)
        if not metric_groups:
            raise HTTPException(400, "На листе Сачков не найдены колонки пробега, моточасов и расхода")
        rows: list[dict[str, Any]] = []
        skipped_rows = 0
        for row_number, row in enumerate(sheet.iter_rows(min_row=header_row_number + 1, values_only=True), start=header_row_number + 1):
            equipment_type = _report_m_clean_text(_operation_report_cell(row, indexes["equipment_type"]))
            brand_model = _report_m_clean_text(_operation_report_cell(row, indexes["brand_model"]))
            plate_number = _report_m_clean_text(_operation_report_cell(row, indexes["plate_number"]))
            unit_number = _report_m_clean_text(_operation_report_cell(row, indexes["unit_number"]))
            vin = _report_m_clean_text(_operation_report_cell(row, indexes["vin"]))
            status_raw = _operation_report_cell(row, indexes["status"])
            repair_reason = _report_m_clean_text(_operation_report_cell(row, indexes["repair_reason"]))
            if not equipment_type and not brand_model and not plate_number and not unit_number and not vin:
                skipped_rows += 1
                continue
            if _report_m_is_summary_row(equipment_type, brand_model, plate_number, unit_number or vin, repair_reason):
                skipped_rows += 1
                continue
            metrics, raw_groups = _operation_report_pick_metrics(row, metric_groups)
            status, status_label = _report_m_status_from_raw(status_raw)
            normalized_plate = _normalize_equipment_identifier(plate_number)
            normalized_unit = _normalize_equipment_identifier(unit_number)
            normalized_vin = _normalize_equipment_identifier(vin)
            rows.append({
                "row_number": row_number,
                "report_date": resolved_report_date,
                "location": _report_m_clean_text(_operation_report_cell(row, indexes["location"])),
                "section_code": _report_m_section_code_from_location(_operation_report_cell(row, indexes["location"])),
                "equipment_type": equipment_type or "не указано",
                "brand_model": brand_model,
                "unit_number": unit_number,
                "plate_number": plate_number,
                "status": status,
                "status_label": status_label,
                "ownership_type": "unknown",
                "contractor_name": None,
                "drivers_count": _report_m_clean_text(_operation_report_cell(row, indexes["drivers_count"])),
                "repair_reason": repair_reason,
                "stopped_at": _report_m_parse_cell_date(_operation_report_cell(row, indexes["stopped_at"])),
                "planned_work_at": _report_m_parse_cell_date(_operation_report_cell(row, indexes["planned_work_at"])),
                "comment": _report_m_clean_text(_operation_report_cell(row, indexes["comment"])),
                "vin": vin,
                "metric_source": metrics.get("source"),
                "mileage_km": metrics.get("mileage_km"),
                "engine_hours": metrics.get("engine_hours"),
                "fuel_liters": metrics.get("fuel_liters"),
                "mileage_raw": metrics.get("mileage_raw"),
                "engine_hours_raw": metrics.get("engine_hours_raw"),
                "fuel_raw": metrics.get("fuel_raw"),
                "raw_metric_groups": raw_groups,
                "plate_number_norm": normalized_plate,
                "unit_number_norm": normalized_unit,
                "vin_norm": normalized_vin,
            })
        if not rows:
            raise HTTPException(400, "На листе Сачков не найдено строк техники")
        return {
            "report_date": resolved_report_date,
            "source_filename": filename,
            "source_reference": f"Сачков:{resolved_report_date}",
            "sheet": sheet.title,
            "header_row_number": header_row_number,
            "metric_groups": metric_groups,
            "rows": rows,
            "row_count": len(rows),
            "skipped_rows": skipped_rows,
        }
    finally:
        workbook.close()


def _report_m_parse_cell_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date_cls):
        return value.isoformat()
    text_value = _report_m_clean_text(value)
    if not text_value:
        return None
    parsed = _report_m_parse_date(text_value)
    if parsed:
        return parsed
    try:
        return date_cls.fromisoformat(text_value[:10]).isoformat()
    except ValueError:
        return None


def _report_m_status_from_raw(value: Any) -> tuple[str, str]:
    raw = _report_m_clean_text(value) or ""
    low = raw.lower().replace("ё", "е")
    if "рем" in low:
        return "repair", "ремонт"
    if "прост" in low or "ожидан" in low:
        return "standby", "простой"
    if "работ" in low:
        return "working", "в работе"
    if "выб" in low or "нет" in low:
        return "out", "не в работе"
    return "unknown", raw or "не указано"


def _report_m_header_index(headers: list[Any], needles: list[str]) -> Optional[int]:
    normalized = [(_report_m_clean_text(header) or "").lower().replace("ё", "е") for header in headers]
    for index, header in enumerate(normalized):
        if all(needle in header for needle in needles):
            return index
    return None


def _report_m_equipment_type_index(headers: list[Any]) -> Optional[int]:
    normalized = [(_report_m_clean_text(header) or "").lower().replace("ё", "е") for header in headers]
    for needles in (["кран"], ["тип", "техник"], ["вид", "техник"]):
        for index, header in enumerate(normalized):
            if all(needle in header for needle in needles):
                return index
    for index, header in enumerate(normalized):
        if header == "модель":
            return index
    brand_model_index = _report_m_header_index(headers, ["марка", "модель"])
    if brand_model_index is not None and brand_model_index > 0:
        candidate_index = brand_model_index - 1
        if normalized[candidate_index] in {"модель", "тип", "тип техники", "вид техники"}:
            return candidate_index
    return None


def _report_m_plate_number_index(headers: list[Any], indexes: dict[str, Optional[int]]) -> Optional[int]:
    explicit_index = _report_m_header_index(headers, ["г/н"])
    if explicit_index is not None:
        return explicit_index
    explicit_index = _report_m_header_index(headers, ["гос"])
    if explicit_index is not None:
        return explicit_index

    brand_model_index = indexes.get("brand_model")
    unit_number_index = indexes.get("unit_number")
    if brand_model_index is None or unit_number_index is None:
        return None
    if unit_number_index - brand_model_index != 2:
        return None
    candidate_index = brand_model_index + 1
    candidate_header = (_report_m_clean_text(headers[candidate_index]) or "").lower().replace("ё", "е")
    if any(marker in candidate_header for marker in ("борт", "статус", "водител", "причина", "дата", "примечан", "vin")):
        return None
    return candidate_index


def _report_m_cell(row: tuple[Any, ...], index: Optional[int]) -> Any:
    if index is None or index >= len(row):
        return None
    return row[index]


def _report_m_looks_like_vin(value: Any) -> bool:
    raw = _report_m_clean_text(value) or ""
    if not raw or re.search(r"\s", raw):
        return False
    text_value = _report_m_normalize_identifier(value)
    return (
        10 <= len(text_value) <= 25
        and not re.search(r"[А-Я]", text_value)
        and any(ch.isdigit() for ch in text_value)
        and any("A" <= ch <= "Z" for ch in text_value)
    )


def _report_m_is_summary_row(
    equipment_type: Optional[str],
    brand_model: Optional[str],
    plate_number: Optional[str],
    unit_number: Optional[str],
    repair_reason: Optional[str],
) -> bool:
    low_type = (equipment_type or "").strip().lower().replace("ё", "е")
    low_reason = (repair_reason or "").strip().lower().replace("ё", "е")
    if low_type in REPORT_M_SUMMARY_EQUIPMENT_TYPES or low_type.startswith("статус техник"):
        return True
    if "итого" in low_type or "итого" in low_reason:
        return True
    if not equipment_type and not brand_model and not plate_number:
        return True
    if not equipment_type and not brand_model and unit_number and str(unit_number).strip().isdigit():
        return True
    identifiers = [_report_m_normalize_identifier(unit_number), _report_m_normalize_identifier(plate_number)]
    if not any(any(ch.isdigit() for ch in identifier) for identifier in identifiers if identifier):
        return True
    return False


def _report_m_section_code_from_location(location: Any) -> Optional[str]:
    text_value = str(location or "").strip().lower().replace("ё", "е")
    match = re.search(r"(?:участ(?:ок|ка)|уч\.)\s*№?\s*(\d+)", text_value)
    if not match:
        match = re.search(r"\b(\d+)\s*[-–]?\s*(?:й|ый|ой)?\s*участ", text_value)
    if not match:
        match = re.search(r"\b(\d+)\s*уч", text_value)
    if not match:
        return None
    section_num = int(match.group(1))
    if section_num in (31, 32):
        section_num = 3
    return f"UCH_{section_num}"


def _parse_mechanization_report_m_workbook(filename: str, blob: bytes, report_date: Optional[str] = None) -> dict[str, Any]:
    try:
        workbook = load_workbook(BytesIO(blob), read_only=True, data_only=True)
    except Exception as exc:
        raise HTTPException(400, f"Не удалось открыть XLSX Отчета М: {exc}") from exc
    try:
        sheet = workbook.worksheets[0]
        try:
            headers = list(next(sheet.iter_rows(min_row=1, max_row=1, values_only=True)))
        except StopIteration as exc:
            raise HTTPException(400, "В Отчете М нет строк") from exc
        resolved_report_date = report_date or _report_m_parse_date(filename) or _report_m_parse_date(sheet.title)
        if not resolved_report_date:
            raise HTTPException(400, "Не удалось определить дату Отчета М из имени файла или листа")
        indexes: dict[str, Optional[int]] = {
            "location": _report_m_header_index(headers, ["местонахождение"]),
            "equipment_type": _report_m_equipment_type_index(headers),
            "brand_model": _report_m_header_index(headers, ["марка", "модель"]),
            "plate_number": None,
            "unit_number": _report_m_header_index(headers, ["борт"]),
            "status": _report_m_header_index(headers, ["статус"]),
            "drivers_count": _report_m_header_index(headers, ["водител"]),
            "repair_reason": _report_m_header_index(headers, ["причина"]),
            "stopped_at": _report_m_header_index(headers, ["дата", "останов"]),
            "planned_work_at": _report_m_header_index(headers, ["планируем", "дата"]),
            "comment": _report_m_header_index(headers, ["примечан"]),
        }
        indexes["plate_number"] = _report_m_plate_number_index(headers, indexes)
        required = ("equipment_type", "brand_model", "plate_number", "unit_number", "status")
        if all(indexes[key] is None for key in required):
            raise HTTPException(400, "В Отчете М не найдена ожидаемая шапка техники")
        rows: list[dict[str, Any]] = []
        skipped_rows = 0
        for row_number, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
            equipment_type = _report_m_clean_text(_report_m_cell(row, indexes["equipment_type"]))
            status_raw = _report_m_cell(row, indexes["status"])
            location = _report_m_clean_text(_report_m_cell(row, indexes["location"]))
            brand_model = _report_m_clean_text(_report_m_cell(row, indexes["brand_model"]))
            plate_number = _report_m_clean_text(_report_m_cell(row, indexes["plate_number"]))
            unit_number = _report_m_clean_text(_report_m_cell(row, indexes["unit_number"]))
            repair_reason = _report_m_clean_text(_report_m_cell(row, indexes["repair_reason"]))
            if not equipment_type and not status_raw and not brand_model and not plate_number and not unit_number:
                skipped_rows += 1
                continue
            if _report_m_is_summary_row(equipment_type, brand_model, plate_number, unit_number, repair_reason):
                skipped_rows += 1
                continue
            status, status_label = _report_m_status_from_raw(status_raw)
            vin = next((_report_m_clean_text(value) for value in row if _report_m_looks_like_vin(value)), None)
            rows.append(
                {
                    "row_number": row_number,
                    "report_date": resolved_report_date,
                    "location": location,
                    "section_code": _report_m_section_code_from_location(location),
                    "equipment_type": equipment_type or "не указано",
                    "brand_model": brand_model,
                    "unit_number": unit_number,
                    "plate_number": plate_number,
                    "status": status,
                    "status_label": status_label,
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "drivers_count": _report_m_clean_text(_report_m_cell(row, indexes["drivers_count"])),
                    "repair_reason": repair_reason,
                    "stopped_at": _report_m_parse_cell_date(_report_m_cell(row, indexes["stopped_at"])),
                    "planned_work_at": _report_m_parse_cell_date(_report_m_cell(row, indexes["planned_work_at"])),
                    "comment": _report_m_clean_text(_report_m_cell(row, indexes["comment"])),
                    "vin": vin,
                    "unit_number_norm": _report_m_normalize_identifier(unit_number),
                    "plate_number_norm": _report_m_normalize_identifier(plate_number),
                }
            )
        if not rows:
            raise HTTPException(400, "В Отчете М не найдено строк техники")
        return {
            "report_date": resolved_report_date,
            "source_filename": filename,
            "sheet": sheet.title,
            "header_indexes": indexes,
            "rows": rows,
            "row_count": len(rows),
            "skipped_rows": skipped_rows,
        }
    finally:
        workbook.close()


def _report_m_snapshot_report_groups(targets: list[tuple[dict[str, Any], str]]) -> dict[str, list[tuple[dict[str, Any], str]]]:
    """Отчет М is one daily equipment snapshot; row locations are not report sections."""
    return {"__REPORT_M__": targets}


def _report_m_match_equipment_unit(
    cur,
    plate_number_norm: str,
    unit_number_norm: str = "",
    vin_norm: str = "",
) -> Optional[str]:
    candidates: list[tuple[str, str]] = []
    if plate_number_norm:
        candidates.append(("plate", plate_number_norm))
        if vin_norm:
            candidates.append(("unit", vin_norm))
    else:
        if vin_norm:
            candidates.append(("unit", vin_norm))
        if unit_number_norm:
            candidates.append(("unit", unit_number_norm))
    for identifier_type, normalized_value in candidates:
        if not normalized_value:
            continue
        cur.execute(
            """
            SELECT eu.id::text, eu.unit_number, eu.plate_number, eu.vin
            FROM equipment_unit_identifiers eui
            JOIN equipment_units eu ON eu.id = eui.equipment_unit_id
            WHERE eui.identifier_type = %s
              AND eui.normalized_value = %s
              AND COALESCE(eu.is_active, true) = true
            ORDER BY CASE
                       WHEN LOWER(COALESCE(eu.source_name, '')) LIKE '%%отчет м%%' THEN 0
                       WHEN LOWER(COALESCE(eu.source_name, '')) LIKE '%%сачков%%' THEN 1
                       ELSE 2
                     END,
                     eu.source_date DESC NULLS LAST,
                     eu.updated_at DESC NULLS LAST,
                     eu.created_at DESC NULLS LAST,
                     eu.id DESC
            LIMIT 10
            """,
            (identifier_type, normalized_value),
        )
        for found in cur.fetchall() or []:
            if _equipment_master_identifier_match_is_current(found, identifier_type, normalized_value):
                return str(_equipment_candidate_value(found, "id", 0))
    return None


def _equipment_master_primary_identifiers_conflict(cur, equipment_unit_id: str, row: dict[str, Any]) -> bool:
    incoming_unit = _report_m_normalize_identifier(row.get("unit_number"))
    incoming_plate = _report_m_normalize_identifier(row.get("plate_number") or row.get("plate"))
    if not incoming_unit or not incoming_plate:
        return False
    cur.execute(
        """
        SELECT unit_number, plate_number
        FROM equipment_units
        WHERE id = %s::uuid
        LIMIT 1
        """,
        (equipment_unit_id,),
    )
    found = cur.fetchone()
    if not found:
        return False
    existing_unit_raw = found.get("unit_number") if isinstance(found, dict) else found[0]
    existing_plate_raw = found.get("plate_number") if isinstance(found, dict) else found[1]
    existing_unit = _report_m_normalize_identifier(existing_unit_raw)
    existing_plate = _report_m_normalize_identifier(existing_plate_raw)
    if not existing_unit or not existing_plate:
        return False
    return incoming_unit != existing_unit and incoming_plate != existing_plate


def _report_m_insert_identifier(cur, equipment_unit_id: str, identifier_type: str, raw_value: Optional[str], normalized_value: str) -> None:
    if not normalized_value:
        return
    cur.execute(
        """
        INSERT INTO equipment_unit_identifiers (equipment_unit_id, identifier_type, raw_value, normalized_value)
        VALUES (%s::uuid, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (equipment_unit_id, identifier_type, raw_value or normalized_value, normalized_value),
    )


def _equipment_identifier_norm_variants(value: Any) -> list[str]:
    variants: list[str] = []
    for normalizer in (_report_m_normalize_identifier, _normalize_equipment_identifier):
        normalized = normalizer(value)
        if normalized and normalized not in _EQUIPMENT_EMPTY_IDENTIFIER_NORMS and normalized not in variants:
            variants.append(normalized)
    return variants


def _equipment_master_allowed_identifier_norms(
    unit_number: Any,
    plate_number: Any,
    vin: Any = None,
) -> dict[str, set[str]]:
    allowed = {
        "unit": set(_equipment_identifier_norm_variants(unit_number)),
        "plate": set(_equipment_identifier_norm_variants(plate_number)),
    }
    if _report_m_looks_like_vin(vin):
        allowed["unit"].update(_equipment_identifier_norm_variants(vin))
    return allowed


def _equipment_candidate_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[index]
    except (IndexError, TypeError):
        return None


def _equipment_master_identifier_match_is_current(row: Any, identifier_type: str, normalized_value: str) -> bool:
    if not row:
        return False
    if _equipment_candidate_value(row, "unit_number", 1) is None and _equipment_candidate_value(row, "plate_number", 2) is None:
        return True
    allowed = _equipment_master_allowed_identifier_norms(
        _equipment_candidate_value(row, "unit_number", 1),
        _equipment_candidate_value(row, "plate_number", 2),
        _equipment_candidate_value(row, "vin", 3),
    )
    return normalized_value in allowed.get(identifier_type, set())


def _report_m_prune_equipment_unit_identifiers(cur, equipment_unit_id: str) -> int:
    cur.execute(
        """
        SELECT unit_number, plate_number, vin
        FROM equipment_units
        WHERE id = %s::uuid
        LIMIT 1
        """,
        (equipment_unit_id,),
    )
    row = cur.fetchone()
    if not row:
        return 0
    allowed = _equipment_master_allowed_identifier_norms(
        _equipment_candidate_value(row, "unit_number", 0),
        _equipment_candidate_value(row, "plate_number", 1),
        _equipment_candidate_value(row, "vin", 2),
    )
    cur.execute(
        """
        DELETE FROM equipment_unit_identifiers
        WHERE equipment_unit_id = %s::uuid
          AND identifier_type = 'plate'
          AND NOT (normalized_value = ANY(%s::text[]))
        """,
        (equipment_unit_id, sorted(allowed["plate"])),
    )
    removed = cur.rowcount
    cur.execute(
        """
        DELETE FROM equipment_unit_identifiers
        WHERE equipment_unit_id = %s::uuid
          AND identifier_type = 'unit'
          AND NOT (normalized_value = ANY(%s::text[]))
        """,
        (equipment_unit_id, sorted(allowed["unit"])),
    )
    return removed + cur.rowcount


def _ensure_equipment_operation_metrics_schema(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS equipment_operation_metrics (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          equipment_unit_id uuid REFERENCES equipment_units(id) ON DELETE SET NULL,
          metric_date date NOT NULL,
          source_reference text NOT NULL,
          source_sheet text NOT NULL DEFAULT 'Лист1',
          source_row_number integer NOT NULL,
          source_location text,
          source_equipment_type text,
          source_brand_model text,
          source_plate_number text,
          source_unit_number text,
          source_vin text,
          source_status text,
          match_method text,
          matched_identifier_norm text,
          mileage_km numeric,
          engine_hours numeric,
          fuel_liters numeric,
          mileage_raw text,
          engine_hours_raw text,
          fuel_raw text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (source_reference, source_sheet, source_row_number)
        )
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_equipment_operation_metrics_unit_date
        ON equipment_operation_metrics (equipment_unit_id, metric_date)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_equipment_operation_metrics_date
        ON equipment_operation_metrics (metric_date)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_equipment_operation_metrics_source_plate
        ON equipment_operation_metrics (source_plate_number)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_equipment_operation_metrics_source_unit
        ON equipment_operation_metrics (source_unit_number)
        """
    )
    cur.execute(
        """
        CREATE OR REPLACE VIEW equipment_operation_metrics_by_unit AS
        SELECT
          equipment_unit_id,
          MIN(metric_date) AS first_metric_date,
          MAX(metric_date) AS last_metric_date,
          COUNT(*)::integer AS source_rows,
          COUNT(*) FILTER (WHERE mileage_km IS NOT NULL)::integer AS mileage_rows,
          COUNT(*) FILTER (WHERE engine_hours IS NOT NULL)::integer AS engine_hours_rows,
          COUNT(*) FILTER (WHERE fuel_liters IS NOT NULL)::integer AS fuel_rows,
          SUM(COALESCE(mileage_km, 0))::numeric AS mileage_km_total,
          SUM(COALESCE(engine_hours, 0))::numeric AS engine_hours_total,
          SUM(COALESCE(fuel_liters, 0))::numeric AS fuel_liters_total
        FROM equipment_operation_metrics
        WHERE equipment_unit_id IS NOT NULL
        GROUP BY equipment_unit_id
        """
    )


def _operation_report_match_equipment_unit(cur, row: dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    plate_number_norm = row.get("plate_number_norm")
    vin_norm = row.get("vin_norm")
    unit_number_norm = row.get("unit_number_norm")
    candidates: list[tuple[str, Optional[str], str]] = []
    if plate_number_norm:
        candidates.append(("plate", plate_number_norm, "plate"))
        if vin_norm:
            candidates.append(("unit", vin_norm, "vin"))
    else:
        if vin_norm:
            candidates.append(("unit", vin_norm, "vin"))
        if unit_number_norm:
            candidates.append(("unit", unit_number_norm, "unit"))
    for identifier_type, normalized_value, method in candidates:
        if not normalized_value:
            continue
        cur.execute(
            """
            SELECT eu.id::text, eu.unit_number, eu.plate_number, eu.vin
            FROM equipment_unit_identifiers eui
            JOIN equipment_units eu ON eu.id = eui.equipment_unit_id
            WHERE eui.identifier_type = %s
              AND eui.normalized_value = %s
              AND COALESCE(eu.is_active, true) = true
            ORDER BY
              CASE
                WHEN LOWER(COALESCE(eu.source_name, '')) LIKE '%%отчет м%%' THEN 0
                WHEN LOWER(COALESCE(eu.source_name, '')) LIKE '%%сачков%%' THEN 1
                WHEN LOWER(COALESCE(eu.source_name, '')) LIKE '%%накоп%%' THEN 2
                ELSE 3
              END,
              eu.source_date DESC NULLS LAST,
              eu.updated_at DESC NULLS LAST,
              eu.created_at DESC NULLS LAST,
              eu.id DESC
            LIMIT 10
            """,
            (identifier_type, normalized_value),
        )
        for found in cur.fetchall() or []:
            if _equipment_master_identifier_match_is_current(found, identifier_type, normalized_value):
                return str(_equipment_candidate_value(found, "id", 0)), method, normalized_value
    return None, None, None


def _operation_report_upsert_master_unit(cur, row: dict[str, Any], report_date: str, source_filename: str) -> tuple[Optional[str], str, Optional[str], Optional[str]]:
    row = _sanitize_equipment_master_row(row)
    equipment_unit_id, match_method, matched_identifier_norm = _operation_report_match_equipment_unit(cur, row)
    if equipment_unit_id and _equipment_master_primary_identifiers_conflict(cur, equipment_unit_id, row):
        equipment_unit_id = None
    if equipment_unit_id:
        cur.execute(
            """
            UPDATE equipment_units
            SET equipment_type = COALESCE(NULLIF(equipment_units.equipment_type, ''), COALESCE(NULLIF(%s, ''), 'не указано')),
                brand_model = COALESCE(NULLIF(equipment_units.brand_model, ''), NULLIF(%s, '')),
                unit_number = COALESCE(NULLIF(equipment_units.unit_number, ''), NULLIF(%s, '')),
                plate_number = COALESCE(NULLIF(equipment_units.plate_number, ''), NULLIF(%s, '')),
                status = CASE
                  WHEN LOWER(COALESCE(equipment_units.source_name, '')) LIKE '%%отчет м%%'
                  THEN equipment_units.status
                  ELSE COALESCE(NULLIF(%s, ''), equipment_units.status, 'unknown')
                END,
                source_name = CASE
                  WHEN LOWER(COALESCE(equipment_units.source_name, '')) LIKE '%%отчет м%%'
                  THEN equipment_units.source_name
                  ELSE 'Сводная таблица Сачков'
                END,
                source_date = CASE
                  WHEN LOWER(COALESCE(equipment_units.source_name, '')) LIKE '%%отчет м%%'
                  THEN equipment_units.source_date
                  ELSE %s::date
                END,
                source_reference = CASE
                  WHEN LOWER(COALESCE(equipment_units.source_name, '')) LIKE '%%отчет м%%'
                  THEN equipment_units.source_reference
                  ELSE %s
                END,
                location = COALESCE(NULLIF(%s, ''), equipment_units.location),
                vin = COALESCE(NULLIF(equipment_units.vin, ''), NULLIF(%s, '')),
                drivers_count = COALESCE(NULLIF(%s, ''), equipment_units.drivers_count),
                repair_reason = COALESCE(NULLIF(%s, ''), equipment_units.repair_reason),
                stopped_at = COALESCE(%s::date, equipment_units.stopped_at),
                planned_work_at = COALESCE(%s::date, equipment_units.planned_work_at),
                comment = COALESCE(NULLIF(equipment_units.comment, ''), NULLIF(%s, '')),
                is_active = true,
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (
                row.get("equipment_type"),
                row.get("brand_model"),
                row.get("unit_number"),
                row.get("plate_number"),
                row.get("status") or "unknown",
                report_date,
                source_filename,
                row.get("location"),
                row.get("vin"),
                row.get("drivers_count"),
                row.get("repair_reason"),
                row.get("stopped_at"),
                row.get("planned_work_at"),
                row.get("comment"),
                equipment_unit_id,
            ),
        )
        action = "matched"
    elif row.get("plate_number_norm") or row.get("unit_number_norm") or row.get("vin_norm"):
        equipment_unit_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO equipment_units (
              id, equipment_type, brand_model, unit_number, plate_number,
              ownership_type, contractor_name, status, source_name, source_date,
              source_reference, location, vin, drivers_count, repair_reason,
              stopped_at, planned_work_at, comment, is_active, review_tag
            )
            VALUES (%s::uuid, COALESCE(NULLIF(%s, ''), 'не указано'), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                    'unknown', NULLIF(%s, ''), COALESCE(NULLIF(%s, ''), 'unknown'),
                    'Сводная таблица Сачков', %s::date, %s, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                    %s::date, %s::date, NULLIF(%s, ''), true, %s)
            """,
            (
                equipment_unit_id,
                row.get("equipment_type"),
                row.get("brand_model"),
                row.get("unit_number"),
                row.get("plate_number"),
                row.get("contractor_name"),
                row.get("status"),
                report_date,
                source_filename,
                row.get("location"),
                row.get("vin"),
                row.get("drivers_count"),
                row.get("repair_reason"),
                row.get("stopped_at"),
                row.get("planned_work_at"),
                row.get("comment"),
                f"sachkov_operation_import:{report_date}",
            ),
        )
        action = "created"
        match_method = "created"
        matched_identifier_norm = row.get("plate_number_norm") or row.get("vin_norm") or row.get("unit_number_norm")
    else:
        return None, "unmatched", None, None

    _report_m_insert_identifier(cur, equipment_unit_id, "plate", row.get("plate_number"), row.get("plate_number_norm") or "")
    _report_m_insert_identifier(cur, equipment_unit_id, "unit", row.get("unit_number"), row.get("unit_number_norm") or "")
    if row.get("vin_norm") and row.get("vin_norm") != row.get("unit_number_norm"):
        _report_m_insert_identifier(cur, equipment_unit_id, "unit", row.get("vin"), row.get("vin_norm") or "")
    _report_m_prune_equipment_unit_identifiers(cur, equipment_unit_id)
    return equipment_unit_id, action, match_method, matched_identifier_norm


def _import_equipment_operation_report(parsed: dict[str, Any]) -> dict[str, Any]:
    _ensure_report_review_schema()
    rows = parsed["rows"]
    report_date = parsed["report_date"]
    source_reference = parsed["source_reference"]
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '90s'")
                _ensure_equipment_operation_metrics_schema(cur)
                cur.execute(
                    "DELETE FROM equipment_operation_metrics WHERE source_reference = %s",
                    (source_reference,),
                )
                deleted_metrics = cur.rowcount
                matched_count = 0
                created_count = 0
                unmatched_count = 0
                metric_rows_inserted = 0
                for row in rows:
                    equipment_unit_id, action, match_method, matched_identifier_norm = _operation_report_upsert_master_unit(
                        cur,
                        row,
                        report_date,
                        parsed["source_filename"],
                    )
                    if action == "created":
                        created_count += 1
                    elif action == "matched":
                        matched_count += 1
                    else:
                        unmatched_count += 1
                    cur.execute(
                        """
                        INSERT INTO equipment_operation_metrics (
                          equipment_unit_id, metric_date, source_reference, source_sheet, source_row_number,
                          source_location, source_equipment_type, source_brand_model, source_plate_number,
                          source_unit_number, source_vin, source_status, match_method, matched_identifier_norm,
                          mileage_km, engine_hours, fuel_liters, mileage_raw, engine_hours_raw, fuel_raw
                        )
                        VALUES (%s::uuid, %s::date, %s, %s, %s,
                                NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                                NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                                %s, %s, %s, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''))
                        """,
                        (
                            equipment_unit_id,
                            report_date,
                            source_reference,
                            parsed["sheet"],
                            row.get("row_number"),
                            row.get("location"),
                            row.get("equipment_type"),
                            row.get("brand_model"),
                            row.get("plate_number"),
                            row.get("unit_number"),
                            row.get("vin"),
                            row.get("status_label") or row.get("status"),
                            match_method,
                            matched_identifier_norm,
                            row.get("mileage_km"),
                            row.get("engine_hours"),
                            row.get("fuel_liters"),
                            row.get("mileage_raw"),
                            row.get("engine_hours_raw"),
                            row.get("fuel_raw"),
                        ),
                    )
                    metric_rows_inserted += 1
        _invalidate_dashboard_cache_after_report_write("equipment_operation_import")
        return {
            "ok": True,
            "source_filename": parsed["source_filename"],
            "source_reference": source_reference,
            "report_date": report_date,
            "sheet": parsed["sheet"],
            "row_count": parsed["row_count"],
            "skipped_rows": parsed["skipped_rows"],
            "metric_rows_deleted": deleted_metrics,
            "metric_rows_inserted": metric_rows_inserted,
            "matched_equipment_units": matched_count,
            "created_equipment_units": created_count,
            "unmatched_rows": unmatched_count,
            "mileage_km_total": round(sum(float(row.get("mileage_km") or 0) for row in rows), 2),
            "engine_hours_total": round(sum(float(row.get("engine_hours") or 0) for row in rows), 2),
            "fuel_liters_total": round(sum(float(row.get("fuel_liters") or 0) for row in rows), 2),
            "metric_sources": sorted({str(row.get("metric_source")) for row in rows if row.get("metric_source")}),
        }
    finally:
        conn.close()


def _report_m_upsert_master_unit(cur, row: dict[str, Any], report_date: str, source_reference: str, review_tag: str) -> tuple[str, str]:
    row = _sanitize_equipment_master_row(row)
    equipment_unit_id = _report_m_match_equipment_unit(
        cur,
        row.get("plate_number_norm") or "",
        row.get("unit_number_norm") or "",
        row.get("vin_norm") or _report_m_normalize_identifier(row.get("vin")) or "",
    )
    if equipment_unit_id and _equipment_master_primary_identifiers_conflict(cur, equipment_unit_id, row):
        equipment_unit_id = None
    params = (
        row.get("equipment_type"),
        row.get("brand_model"),
        row.get("unit_number"),
        row.get("plate_number"),
        row.get("ownership_type") or "own",
        row.get("contractor_name") or "ЖДС",
        row.get("status") or "unknown",
        report_date,
        source_reference,
        row.get("location"),
        row.get("vin"),
        row.get("drivers_count"),
        row.get("repair_reason"),
        row.get("stopped_at"),
        row.get("planned_work_at"),
        row.get("comment"),
        review_tag,
    )
    if equipment_unit_id:
        cur.execute(
            """
            UPDATE equipment_units
            SET equipment_type = COALESCE(NULLIF(%s, ''), equipment_type),
                brand_model = COALESCE(NULLIF(%s, ''), brand_model),
                unit_number = COALESCE(NULLIF(%s, ''), unit_number),
                plate_number = COALESCE(NULLIF(%s, ''), plate_number),
                ownership_type = COALESCE(NULLIF(%s, ''), ownership_type),
                contractor_name = NULLIF(%s, ''),
                status = COALESCE(NULLIF(%s, ''), status),
                source_name = 'Отчет М',
                source_date = %s::date,
                source_reference = %s,
                location = NULLIF(%s, ''),
                vin = COALESCE(NULLIF(%s, ''), vin),
                drivers_count = NULLIF(%s, ''),
                repair_reason = NULLIF(%s, ''),
                stopped_at = %s::date,
                planned_work_at = %s::date,
                comment = NULLIF(%s, ''),
                is_active = true,
                review_tag = %s,
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (*params, equipment_unit_id),
        )
        action = "updated"
    else:
        equipment_unit_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO equipment_units (
              id, equipment_type, brand_model, unit_number, plate_number,
              ownership_type, contractor_name, status, source_name, source_date,
              source_reference, location, vin, drivers_count, repair_reason,
              stopped_at, planned_work_at, comment, is_active, review_tag
            )
            VALUES (%s::uuid, COALESCE(NULLIF(%s, ''), 'не указано'), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                    COALESCE(NULLIF(%s, ''), 'own'), NULLIF(%s, ''), COALESCE(NULLIF(%s, ''), 'unknown'),
                    'Отчет М', %s::date, %s, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                    %s::date, %s::date, NULLIF(%s, ''), true, %s)
            """,
            (equipment_unit_id, *params),
        )
        action = "inserted"
    _report_m_insert_identifier(cur, equipment_unit_id, "unit", row.get("unit_number"), row.get("unit_number_norm") or "")
    _report_m_insert_identifier(cur, equipment_unit_id, "plate", row.get("plate_number"), row.get("plate_number_norm") or "")
    if row.get("vin") and row.get("vin_norm"):
        _report_m_insert_identifier(cur, equipment_unit_id, "unit", row.get("vin"), row.get("vin_norm") or "")
    _report_m_prune_equipment_unit_identifiers(cur, equipment_unit_id)
    return equipment_unit_id, action


def _report_m_dedupe_master_units(cur) -> dict[str, int]:
    cur.execute(
        """
        CREATE TEMP TABLE report_m_dedupe_pairs ON COMMIT DROP AS
        WITH report_m_units AS (
          SELECT
            eu.*,
            REGEXP_REPLACE(UPPER(COALESCE(eu.unit_number, '')), '[^0-9A-ZА-Я]+', '', 'g') AS unit_norm,
            REGEXP_REPLACE(UPPER(COALESCE(eu.plate_number, '')), '[^0-9A-ZА-Я]+', '', 'g') AS plate_norm,
            REGEXP_REPLACE(UPPER(COALESCE(eu.vin, '')), '[^0-9A-ZА-Я]+', '', 'g') AS vin_norm
          FROM equipment_units eu
          WHERE LOWER(COALESCE(eu.source_name, '')) LIKE '%%отчет м%%'
        ), ranked AS (
          SELECT
            eu.id AS equipment_unit_id,
            eui.identifier_type,
            eui.normalized_value AS identifier_norm,
            FIRST_VALUE(eu.id) OVER (
              PARTITION BY eui.identifier_type, eui.normalized_value
              ORDER BY CASE WHEN COALESCE(eu.is_active, true) = true THEN 0 ELSE 1 END,
                       eu.source_date DESC NULLS LAST,
                       eu.updated_at DESC NULLS LAST,
                       eu.created_at DESC NULLS LAST,
                       eu.id DESC
            ) AS survivor_id,
            ROW_NUMBER() OVER (
              PARTITION BY eui.identifier_type, eui.normalized_value
              ORDER BY CASE WHEN COALESCE(eu.is_active, true) = true THEN 0 ELSE 1 END,
                       eu.source_date DESC NULLS LAST,
                       eu.updated_at DESC NULLS LAST,
                       eu.created_at DESC NULLS LAST,
                       eu.id DESC
            ) AS rn
          FROM report_m_units eu
          JOIN equipment_unit_identifiers eui
            ON eui.equipment_unit_id = eu.id
           AND eui.identifier_type IN ('plate', 'unit')
          WHERE NULLIF(eui.normalized_value, '') IS NOT NULL
              AND eui.normalized_value <> ALL(ARRAY['БН', 'НД', 'НЕТ', 'NONE', 'NULL', 'UNKNOWN', 'БЕЗНОМЕРА'])
        ), candidate_pairs AS (
          SELECT DISTINCT ON (equipment_unit_id)
            equipment_unit_id AS loser_id,
            survivor_id,
            identifier_type,
            identifier_norm
          FROM ranked
          WHERE rn > 1
          ORDER BY equipment_unit_id,
                   CASE identifier_type WHEN 'plate' THEN 0 ELSE 1 END,
                   identifier_norm
        )
        SELECT DISTINCT ON (cp.loser_id)
          cp.loser_id,
          cp.survivor_id,
          cp.identifier_type,
          cp.identifier_norm
        FROM candidate_pairs cp
        JOIN report_m_units loser ON loser.id = cp.loser_id
        JOIN report_m_units survivor ON survivor.id = cp.survivor_id
        WHERE NOT (
          NULLIF(loser.unit_norm, '') IS NOT NULL
          AND NULLIF(loser.plate_norm, '') IS NOT NULL
          AND NULLIF(survivor.unit_norm, '') IS NOT NULL
          AND NULLIF(survivor.plate_norm, '') IS NOT NULL
          AND loser.unit_norm <> survivor.unit_norm
          AND loser.plate_norm <> survivor.plate_norm
        )
        AND NOT (
          cp.identifier_type = 'unit'
          AND loser.unit_norm = survivor.unit_norm
          AND NULLIF(loser.plate_norm, '') IS NOT NULL
          AND NULLIF(survivor.plate_norm, '') IS NOT NULL
          AND loser.plate_norm <> survivor.plate_norm
          AND NULLIF(loser.vin_norm, '') IS NOT NULL
          AND NULLIF(survivor.vin_norm, '') IS NOT NULL
          AND loser.vin_norm <> survivor.vin_norm
        )
        ORDER BY cp.loser_id,
                 CASE cp.identifier_type WHEN 'plate' THEN 0 ELSE 1 END,
                 cp.identifier_norm
        """
    )
    cur.execute(
        """
        UPDATE report_equipment_units reu
        SET equipment_unit_id = dp.survivor_id
        FROM report_m_dedupe_pairs dp
        WHERE reu.equipment_unit_id = dp.loser_id
        """
    )
    moved_links = cur.rowcount
    cur.execute(
        """
        UPDATE equipment_operation_metrics eom
        SET equipment_unit_id = dp.survivor_id,
            updated_at = now()
        FROM report_m_dedupe_pairs dp
        WHERE eom.equipment_unit_id = dp.loser_id
        """
    )
    moved_metric_links = cur.rowcount
    cur.execute(
        """
        INSERT INTO equipment_unit_identifiers (equipment_unit_id, identifier_type, raw_value, normalized_value)
        SELECT DISTINCT dp.survivor_id, eui.identifier_type, eui.raw_value, eui.normalized_value
        FROM report_m_dedupe_pairs dp
        JOIN equipment_unit_identifiers eui ON eui.equipment_unit_id = dp.loser_id
        JOIN equipment_units loser ON loser.id = dp.loser_id
        WHERE NULLIF(eui.normalized_value, '') IS NOT NULL
          AND eui.normalized_value <> ALL(ARRAY['БН', 'НД', 'НЕТ', 'NONE', 'NULL', 'UNKNOWN', 'БЕЗНОМЕРА'])
          AND NOT (
            eui.identifier_type = 'plate'
            AND eui.normalized_value ~ '^[0-9]{1,4}$'
            AND eui.normalized_value = REGEXP_REPLACE(UPPER(COALESCE(loser.unit_number, '')), '[^0-9A-ZА-Я]+', '', 'g')
          )
        ON CONFLICT DO NOTHING
        """
    )
    cur.execute("SELECT DISTINCT survivor_id::text FROM report_m_dedupe_pairs")
    dedupe_survivor_ids = [
        str(row["survivor_id"] if isinstance(row, dict) else row[0])
        for row in cur.fetchall() or []
    ]
    cur.execute(
        """
        UPDATE equipment_units eu
        SET plate_number = NULL,
            updated_at = now()
        WHERE LOWER(COALESCE(eu.source_name, '')) LIKE '%%отчет м%%'
          AND NULLIF(BTRIM(COALESCE(eu.plate_number, '')), '') IS NOT NULL
          AND (
            REGEXP_REPLACE(UPPER(COALESCE(eu.plate_number, '')), '[^0-9A-ZА-Я]+', '', 'g')
              = ANY(ARRAY['БН', 'НД', 'НЕТ', 'NONE', 'NULL', 'UNKNOWN', 'БЕЗНОМЕРА'])
            OR (
              REGEXP_REPLACE(UPPER(COALESCE(eu.plate_number, '')), '[^0-9A-ZА-Я]+', '', 'g') ~ '^[0-9]{1,4}$'
              AND REGEXP_REPLACE(UPPER(COALESCE(eu.plate_number, '')), '[^0-9A-ZА-Я]+', '', 'g')
                = REGEXP_REPLACE(UPPER(COALESCE(eu.unit_number, '')), '[^0-9A-ZА-Я]+', '', 'g')
            )
          )
        """
    )
    fake_master_plates_cleared = cur.rowcount
    cur.execute(
        """
        DELETE FROM equipment_unit_identifiers eui
        USING equipment_units eu
        WHERE eui.equipment_unit_id = eu.id
          AND eui.identifier_type = 'plate'
          AND LOWER(COALESCE(eu.source_name, '')) LIKE '%%отчет м%%'
          AND (
            eui.normalized_value = ANY(ARRAY['БН', 'НД', 'НЕТ', 'NONE', 'NULL', 'UNKNOWN', 'БЕЗНОМЕРА'])
            OR (
              eui.normalized_value ~ '^[0-9]{1,4}$'
              AND eui.normalized_value = REGEXP_REPLACE(UPPER(COALESCE(eu.unit_number, '')), '[^0-9A-ZА-Я]+', '', 'g')
            )
          )
        """
    )
    fake_plate_identifiers_removed = cur.rowcount
    stale_identifiers_pruned = 0
    for survivor_id in dedupe_survivor_ids:
        stale_identifiers_pruned += _report_m_prune_equipment_unit_identifiers(cur, survivor_id)
    cur.execute(
        """
        DELETE FROM equipment_unit_identifiers eui
        USING report_m_dedupe_pairs dp
        WHERE eui.equipment_unit_id = dp.loser_id
        """
    )
    cur.execute(
        """
        DELETE FROM equipment_units eu
        USING report_m_dedupe_pairs dp
        WHERE eu.id = dp.loser_id
        """
    )
    deduped_units = cur.rowcount
    cur.execute("SELECT COUNT(DISTINCT identifier_type || ':' || identifier_norm)::int FROM report_m_dedupe_pairs")
    duplicate_groups = int((cur.fetchone() or [0])[0] or 0)
    return {
        "deduped_equipment_units": deduped_units,
        "report_equipment_links_moved": moved_links,
        "equipment_operation_metric_links_moved": moved_metric_links,
        "duplicate_plate_groups_touched": duplicate_groups,
        "duplicate_identifier_groups_touched": duplicate_groups,
        "fake_master_plates_cleared": fake_master_plates_cleared,
        "fake_plate_identifiers_removed": fake_plate_identifiers_removed,
        "stale_identifiers_pruned": stale_identifiers_pruned,
    }


def _import_mechanization_report_m_snapshot(parsed: dict[str, Any], *, source_reference: str) -> dict[str, Any]:
    _ensure_report_review_schema()
    rows = parsed["rows"]
    report_date = parsed["report_date"]
    master_review_tag = f"otchet_m_import:{report_date}"
    snapshot_review_tag = f"otchet_m_import_snapshot:{report_date}"
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '60s'")
                cur.execute(
                    """
                    DELETE FROM report_equipment_units reu
                    USING daily_reports dr
                    WHERE reu.daily_report_id = dr.id
                      AND dr.report_date = %s::date
                      AND dr.source_type = 'mechanization_report_m'
                      AND dr.review_tag = %s
                    """,
                    (report_date, snapshot_review_tag),
                )
                snapshot_equipment_deleted = cur.rowcount
                cur.execute(
                    """
                    DELETE FROM daily_reports
                    WHERE report_date = %s::date
                      AND source_type = 'mechanization_report_m'
                      AND review_tag = %s
                    """,
                    (report_date, snapshot_review_tag),
                )
                snapshot_reports_deleted = cur.rowcount

                targets: list[tuple[dict[str, Any], str]] = []
                updated_count = 0
                inserted_count = 0
                for row in rows:
                    row = _sanitize_equipment_master_row(row)
                    equipment_unit_id, action = _report_m_upsert_master_unit(cur, row, report_date, source_reference, master_review_tag)
                    targets.append((row, equipment_unit_id))
                    if action == "updated":
                        updated_count += 1
                    else:
                        inserted_count += 1

                groups = _report_m_snapshot_report_groups(targets)

                report_ids: dict[str, str] = {}
                for key in groups:
                    report_id = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO daily_reports (
                          id, report_date, shift, section_id, source_type, source_reference, raw_text,
                          parse_status, operator_status, status, is_demo, review_tag
                        )
                        VALUES (%s::uuid, %s::date, 'day', NULL, 'mechanization_report_m', %s,
                                'Отчет М equipment status snapshot', 'parsed', 'approved', 'confirmed', false, %s)
                        """,
                        (report_id, report_date, source_reference, snapshot_review_tag),
                    )
                    report_ids[key] = report_id

                snapshot_equipment_inserted = 0
                for key, group_rows in groups.items():
                    report_id = report_ids[key]
                    for row, equipment_unit_id in group_rows:
                        cur.execute(
                            """
                            INSERT INTO report_equipment_units (
                              id, daily_report_id, equipment_type, brand_model, unit_number, plate_number,
                              ownership_type, contractor_name, status, comment, is_demo, review_tag, equipment_unit_id
                            )
                            VALUES (%s::uuid, %s::uuid, %s, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''),
                                    COALESCE(NULLIF(%s, ''), 'own'), NULLIF(%s, ''), COALESCE(NULLIF(%s, ''), 'unknown'),
                                    NULLIF(%s, ''), false, %s, %s::uuid)
                            """,
                            (
                                str(uuid.uuid4()),
                                report_id,
                                row.get("equipment_type") or "не указано",
                                row.get("brand_model"),
                                row.get("unit_number"),
                                row.get("plate_number"),
                                row.get("ownership_type") or "own",
                                row.get("contractor_name") or "ЖДС",
                                row.get("status") or "unknown",
                                row.get("comment"),
                                snapshot_review_tag,
                                equipment_unit_id,
                            ),
                        )
                        snapshot_equipment_inserted += 1

                dedupe_result = _report_m_dedupe_master_units(cur)
        _invalidate_dashboard_cache_after_report_write("mechanization_report_m_import")
        return {
            "ok": True,
            "source_filename": parsed["source_filename"],
            "source_reference": source_reference,
            "report_date": report_date,
            "sheet": parsed["sheet"],
            "row_count": parsed["row_count"],
            "skipped_rows": parsed["skipped_rows"],
            "count": len(report_ids),
            "total_equipment_units": snapshot_equipment_inserted,
            "updated_count": updated_count,
            "inserted_count": inserted_count,
            "snapshot_reports_deleted": snapshot_reports_deleted,
            "snapshot_equipment_deleted": snapshot_equipment_deleted,
            "snapshot_reports_inserted": len(report_ids),
            "snapshot_equipment_inserted": snapshot_equipment_inserted,
            **dedupe_result,
        }
    finally:
        conn.close()


@router.post("/mechanization-report-m/import")
async def import_mechanization_report_m(
    file: UploadFile = File(...),
    report_date: Optional[str] = Query(None),
    _manager=Depends(require_settings_manager),
):
    """Import XLSX `СВОД ТЕХНИКИ` into dashboard equipment pulse snapshots."""
    filename = file.filename or "report_m.xlsx"
    if not filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Загрузите XLSX-файл Отчета М")
    parsed_report_date = _report_m_parse_date(report_date) if report_date else None
    if report_date and not parsed_report_date:
        raise HTTPException(400, "Неверная дата Отчета М, используйте ДД.ММ.ГГГГ")
    parsed = _parse_mechanization_report_m_workbook(filename, await _read_upload_blob(file), parsed_report_date)
    return _import_mechanization_report_m_snapshot(parsed, source_reference=filename)


@router.post("/equipment-operation/import")
async def import_equipment_operation_report(
    file: UploadFile = File(...),
    report_date: Optional[str] = Query(None),
    _manager=Depends(require_settings_manager),
):
    """Import XLSX `Сводная таблица` sheet `Сачков` into equipment operation metrics."""
    filename = file.filename or "equipment-operation.xlsx"
    if not filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Загрузите XLSX-файл сводной таблицы техники")
    parsed_report_date = _operation_report_parse_date(report_date) if report_date else None
    if report_date and not parsed_report_date:
        raise HTTPException(400, "Неверная дата отчета эксплуатации, используйте ДД.ММ.ГГГГ")
    parsed = _parse_equipment_operation_workbook(filename, await _read_upload_blob(file), parsed_report_date)
    return _import_equipment_operation_report(parsed)


@router.get("/parser-learning-cases")
def parser_learning_cases(
    status: str = Query("new"),
    limit: int = Query(100, ge=1, le=500),
    _admin=Depends(require_admin),
):
    """Diffs between initial parser output and operator-edited report payloads."""
    _ensure_report_review_schema()
    where = []
    params: list[Any] = []
    if status and status != "all":
        where.append("plc.status = %s")
        params.append(status)
    rows = query(
        f"""
        SELECT
          plc.id::text AS id,
          plc.daily_report_id::text AS daily_report_id,
          plc.report_date,
          plc.shift,
          plc.section_code,
          plc.source_reference,
          plc.case_type,
          plc.item_path,
          plc.raw_fragment,
          plc.initial_value,
          plc.final_value,
          plc.status,
          plc.created_at
        FROM parser_learning_cases plc
        {'WHERE ' + ' AND '.join(where) if where else ''}
        ORDER BY plc.created_at DESC
        LIMIT %s
        """,
        [*params, limit],
    )
    return {
        "count": len(rows),
        "cases": [
            {
                **row,
                "report_date": _iso_date(row.get("report_date")),
                "created_at": row.get("created_at").isoformat() if row.get("created_at") else None,
            }
            for row in rows
        ],
    }


@router.get("/parser-learning-summary")
def parser_learning_summary(_admin=Depends(require_admin)):
    _ensure_report_review_schema()
    rows = query(
        """
        SELECT status, case_type, COUNT(*)::int AS count
        FROM parser_learning_cases
        GROUP BY status, case_type
        ORDER BY status, count DESC, case_type
        """
    )
    return {"rows": rows}


@router.get("/quality-metrics")
def report_quality_metrics(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    scope: str = Query("all"),
    uploaded_by: Optional[str] = None,
    limit: int = Query(500, ge=1, le=5000),
    refresh_due: bool = Query(True),
    _user=Depends(current_user),
):
    """Percent of report content changed between upload snapshot and day-3 snapshot."""
    _require_report_quality_access(_user)
    _ensure_report_review_schema()
    if date_from:
        try:
            date_cls.fromisoformat(date_from)
        except ValueError:
            raise HTTPException(400, "date_from должен быть YYYY-MM-DD")
    if date_to:
        try:
            date_cls.fromisoformat(date_to)
        except ValueError:
            raise HTTPException(400, "date_to должен быть YYYY-MM-DD")

    scope_key = (scope or "all").strip().lower()
    pile_scope: Optional[bool]
    if scope_key in {"all", ""}:
        pile_scope = None
        scope_key = "all"
    elif scope_key in {"piles", "pile", "pile_shift", "svai", "сваи", "isso", "иссо"}:
        pile_scope = True
    elif scope_key in {"regular", "shift", "non_piles", "non-piles", "обычные"}:
        pile_scope = False
    else:
        raise HTTPException(400, "scope должен быть all|piles|regular")

    refresh_info = {"checked": 0, "captured": 0, "metrics": 0}
    if refresh_due:
        refresh_info = _report_quality_refresh_due_snapshots(
            min(REPORT_QUALITY_DUE_LIMIT, REPORT_QUALITY_ENDPOINT_REFRESH_LIMIT),
            captured_by="quality_endpoint",
        )

    where = ["m.metric_kind = %s"]
    params: list[Any] = [REPORT_QUALITY_METRIC_KIND]
    if date_from:
        where.append("m.report_date >= %s")
        params.append(date_from)
    if date_to:
        where.append("m.report_date <= %s")
        params.append(date_to)
    if uploaded_by is not None and uploaded_by != "":
        where.append("COALESCE(m.uploaded_by_username, '') = %s")
        params.append(uploaded_by)
    if pile_scope is not None:
        where.append("m.is_pile_shift_report = %s")
        params.append(pile_scope)
    where_sql = " AND ".join(where)

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '30s'")
                cur.execute(
                    f"""
                    SELECT
                      COUNT(*)::int AS reports,
                      COALESCE(AVG(m.changed_percent), 0)::float AS avg_changed_percent,
                      COALESCE(SUM(m.changed_units), 0)::int AS changed_units,
                      COALESCE(SUM(m.comparable_units), 0)::int AS comparable_units,
                      COALESCE(SUM(m.added_rows), 0)::int AS added_rows,
                      COALESCE(SUM(m.removed_rows), 0)::int AS removed_rows,
                      COALESCE(SUM(m.changed_rows), 0)::int AS changed_rows,
                      COALESCE(SUM(m.changed_fields), 0)::int AS changed_fields,
                      COUNT(*) FILTER (WHERE m.is_pile_shift_report)::int AS pile_shift_reports
                    FROM daily_report_quality_metrics m
                    WHERE {where_sql}
                    """,
                    params,
                )
                summary_row = cur.fetchone() or (0, 0, 0, 0, 0, 0, 0, 0, 0)
                comparable_units = int(summary_row[3] or 0)
                changed_units = int(summary_row[2] or 0)
                weighted_changed_percent = round((changed_units / comparable_units * 100.0), 2) if comparable_units else 0.0
                cur.execute(
                    f"""
                    SELECT
                      m.daily_report_id_text,
                      m.daily_report_id::text,
                      m.report_date,
                      m.shift,
                      m.source_type,
                      m.source_reference,
                      m.uploaded_by_username,
                      m.is_pile_shift_report,
                      m.comparable_units,
                      m.changed_units,
                      m.changed_percent::float,
                      m.added_rows,
                      m.removed_rows,
                      m.changed_rows,
                      m.changed_fields,
                      m.section_breakdown,
                      m.calculated_at,
                      up.snapshot_at AS uploaded_snapshot_at,
                      d3.snapshot_at AS day3_snapshot_at,
                      d3.captured_at AS day3_captured_at,
                      d3.capture_status AS day3_capture_status
                    FROM daily_report_quality_metrics m
                    LEFT JOIN daily_report_quality_snapshots up
                      ON up.id = m.uploaded_snapshot_id
                    LEFT JOIN daily_report_quality_snapshots d3
                      ON d3.id = m.day3_snapshot_id
                    WHERE {where_sql}
                    ORDER BY m.report_date DESC NULLS LAST, m.changed_percent DESC, m.calculated_at DESC
                    LIMIT %s
                    """,
                    [*params, limit],
                )
                metric_rows = cur.fetchall()
                if pile_scope is None:
                    due_where = [
                        "day3.id IS NULL",
                        "COALESCE(dr.is_demo, false) IS NOT TRUE",
                        "dr.review_payload IS NOT NULL",
                        "LOWER(COALESCE(dr.source_type, '')) = ANY(%s)",
                        "dr.created_at <= NOW() - (%s || ' days')::interval",
                    ]
                    due_params: list[Any] = [list(REPORT_QUALITY_MASTER_SOURCE_TYPES), str(REPORT_QUALITY_SNAPSHOT_DAYS)]
                    if date_from:
                        due_where.append("dr.report_date >= %s")
                        due_params.append(date_from)
                    if date_to:
                        due_where.append("dr.report_date <= %s")
                        due_params.append(date_to)
                    if uploaded_by is not None and uploaded_by != "":
                        due_where.append("COALESCE(dr.uploaded_by_username, '') = %s")
                        due_params.append(uploaded_by)
                    cur.execute(
                        f"""
                        SELECT COUNT(*)::int
                        FROM daily_reports dr
                        LEFT JOIN daily_report_quality_snapshots day3
                          ON day3.daily_report_id_text = dr.id::text
                         AND day3.snapshot_kind = 'day3'
                        WHERE {' AND '.join(due_where)}
                        """,
                        due_params,
                    )
                else:
                    due_where = [
                        "uploaded.snapshot_kind = 'uploaded'",
                        "uploaded.is_pile_shift_report = %s",
                        "day3.id IS NULL",
                        "uploaded.snapshot_at <= NOW() - (%s || ' days')::interval",
                    ]
                    due_params = [pile_scope, str(REPORT_QUALITY_SNAPSHOT_DAYS)]
                    if date_from:
                        due_where.append("uploaded.report_date >= %s")
                        due_params.append(date_from)
                    if date_to:
                        due_where.append("uploaded.report_date <= %s")
                        due_params.append(date_to)
                    if uploaded_by is not None and uploaded_by != "":
                        due_where.append("COALESCE(uploaded.uploaded_by_username, '') = %s")
                        due_params.append(uploaded_by)
                    cur.execute(
                        f"""
                        SELECT COUNT(*)::int
                        FROM daily_report_quality_snapshots uploaded
                        LEFT JOIN daily_report_quality_snapshots day3
                          ON day3.daily_report_id_text = uploaded.daily_report_id_text
                         AND day3.snapshot_kind = 'day3'
                        WHERE {' AND '.join(due_where)}
                        """,
                        due_params,
                    )
                due_missing = int((cur.fetchone() or [0])[0] or 0)
    finally:
        conn.close()

    rows = []
    for row in metric_rows:
        rows.append({
            "daily_report_id_text": row[0],
            "daily_report_id": row[1],
            "report_date": _iso_date(row[2]),
            "shift": row[3],
            "source_type": row[4],
            "source_reference": row[5],
            "uploaded_by_username": row[6],
            "is_pile_shift_report": bool(row[7]),
            "comparable_units": int(row[8] or 0),
            "changed_units": int(row[9] or 0),
            "changed_percent": float(row[10] or 0),
            "added_rows": int(row[11] or 0),
            "removed_rows": int(row[12] or 0),
            "changed_rows": int(row[13] or 0),
            "changed_fields": int(row[14] or 0),
            "section_breakdown": row[15] or {},
            "calculated_at": row[16].isoformat() if row[16] else None,
            "uploaded_snapshot_at": row[17].isoformat() if row[17] else None,
            "day3_snapshot_at": row[18].isoformat() if row[18] else None,
            "day3_captured_at": row[19].isoformat() if row[19] else None,
            "day3_capture_status": row[20],
        })
    return {
        "metric_kind": REPORT_QUALITY_METRIC_KIND,
        "snapshot_days": REPORT_QUALITY_SNAPSHOT_DAYS,
        "scope": scope_key,
        "filters": {
            "date_from": date_from,
            "date_to": date_to,
            "uploaded_by": uploaded_by,
        },
        "included_source_types": sorted(REPORT_QUALITY_MASTER_SOURCE_TYPES),
        "excluded_source_types": sorted(REPORT_QUALITY_EXCLUDED_SOURCE_TYPES),
        "summary": {
            "reports": int(summary_row[0] or 0),
            "avg_changed_percent": round(float(summary_row[1] or 0), 2),
            "weighted_changed_percent": weighted_changed_percent,
            "changed_units": changed_units,
            "comparable_units": comparable_units,
            "added_rows": int(summary_row[4] or 0),
            "removed_rows": int(summary_row[5] or 0),
            "changed_rows": int(summary_row[6] or 0),
            "changed_fields": int(summary_row[7] or 0),
            "pile_shift_reports": int(summary_row[8] or 0),
            "due_snapshots_missing": due_missing,
        },
        "refresh": refresh_info,
        "rows": rows,
    }


@router.get("/section-rating")
def section_rating(
    scope: str = Query("zp"),
    period: str = Query("day"),
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    refresh_due: bool = Query(False),
    _user=Depends(current_user),
):
    """Leaderboard for section report discipline: edits, upload time, MStroy convergence."""
    _ensure_report_review_schema()
    scope_key, pile_scope = _section_rating_normalize_scope(scope)
    period_key, d_from, d_to, anchor = _section_rating_period_bounds(period, date, date_from, date_to, pile_scope)
    refresh_info = {"checked": 0, "captured": 0, "metrics": 0}
    if refresh_due:
        refresh_info = _report_quality_refresh_due_snapshots(
            min(REPORT_QUALITY_DUE_LIMIT, REPORT_QUALITY_ENDPOINT_REFRESH_LIMIT),
            captured_by="section_rating_endpoint",
        )
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '30s'")
                calculated = _section_rating_calculate(cur, scope_key, pile_scope, d_from, d_to)
    finally:
        conn.close()
    return {
        "scope": scope_key,
        "scope_label": SECTION_RATING_SCOPE_LABELS[scope_key],
        "period": period_key,
        "date": _iso_date(anchor),
        "date_from": d_from.isoformat(),
        "date_to": d_to.isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "refresh": refresh_info,
        "calculation": {
            "edit_score": "100 - взвешенный процент изменений между снимком загрузки и снимком на третий день",
            "upload_score": "100 баллов до 09:00 МСК, далее линейное снижение до 0 баллов в 12:00 МСК; после дедлайна 0",
            "mstroy_score": "100 - вручную внесенный процент расхождения с МСтроем",
            "total_score": "среднее доступных баллов: правки, время загрузки, МСтрой",
            "upload_window_msk": {"start": "09:00", "deadline": "12:00"},
        },
        **calculated,
    }


@router.get("/section-rating/details")
def section_rating_details(
    scope: str = Query("zp"),
    section_code: str = Query(...),
    period: str = Query("day"),
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    _user=Depends(current_user),
):
    """Per-report drilldown for one section in the selected section-rating period."""
    _ensure_report_review_schema()
    scope_key, pile_scope = _section_rating_normalize_scope(scope)
    normalized_section_code = _section_rating_normalize_section_code(section_code)
    if normalized_section_code is None:
        raise HTTPException(400, "Неизвестный участок")
    period_key, d_from, d_to, anchor = _section_rating_period_bounds(period, date, date_from, date_to, pile_scope)
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '30s'")
                sections = _section_rating_sections(cur)
                section = next((item for item in sections if item["section_code"] == normalized_section_code), None)
                if section is None:
                    raise HTTPException(404, "Участок не найден")
                details_by_section = _section_rating_report_details_by_section(cur, pile_scope, d_from, d_to)
                rows = details_by_section.get(normalized_section_code, [])
    finally:
        conn.close()
    return {
        "scope": scope_key,
        "scope_label": SECTION_RATING_SCOPE_LABELS[scope_key],
        "period": period_key,
        "date": _iso_date(anchor),
        "date_from": d_from.isoformat(),
        "date_to": d_to.isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "section": section,
        "summary": _section_rating_report_details_summary(rows),
        "rows": [_section_rating_report_detail_payload(row) for row in rows],
    }


@router.get("/section-rating/mstroy")
def section_rating_mstroy_inputs(
    rating_date: Optional[str] = None,
    scope: str = Query("zp"),
    _admin=Depends(require_admin),
):
    """Manual MStroy convergence values by section for one date."""
    _ensure_report_review_schema()
    scope_key, pile_scope = _section_rating_normalize_scope(scope)
    selected_date = _section_rating_parse_iso_date(rating_date, "rating_date") or _section_rating_latest_metric_date(pile_scope)
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '15s'")
                sections = _section_rating_sections(cur)
                cur.execute(
                    """
                    SELECT
                      id::text,
                      rating_date,
                      scope,
                      section_code,
                      difference_percent::float,
                      score::float,
                      comment,
                      created_by,
                      created_at,
                      updated_by,
                      updated_at
                    FROM daily_section_rating_mstroy_convergence
                    WHERE rating_date = %s
                      AND scope = %s
                    ORDER BY section_code
                    """,
                    (selected_date, scope_key),
                )
                rows_by_section = {
                    _section_rating_normalize_section_code(row[3]): _section_rating_mstroy_row_payload(row)
                    for row in cur.fetchall()
                }
    finally:
        conn.close()
    return {
        "rating_date": selected_date.isoformat(),
        "scope": scope_key,
        "scope_label": SECTION_RATING_SCOPE_LABELS[scope_key],
        "sections": sections,
        "rows": [
            rows_by_section.get(section["section_code"]) or {
                "id": None,
                "rating_date": selected_date.isoformat(),
                "scope": scope_key,
                "section_code": section["section_code"],
                "difference_percent": None,
                "score": None,
                "comment": None,
                "created_by": None,
                "created_at": None,
                "updated_by": None,
                "updated_at": None,
            }
            for section in sections
        ],
    }


@router.post("/section-rating/mstroy")
def save_section_rating_mstroy_input(body: SectionRatingMstroyBody, _admin=Depends(require_admin)):
    """Upsert or remove one manual MStroy convergence value."""
    _ensure_report_review_schema()
    scope_key, _pile_scope = _section_rating_normalize_scope(body.scope)
    selected_date = _section_rating_parse_iso_date(body.rating_date, "rating_date")
    if selected_date is None:
        raise HTTPException(400, "rating_date обязателен")
    section_code = _section_rating_normalize_section_code(body.section_code)
    if section_code not in SECTION_RATING_SECTION_CODES:
        raise HTTPException(400, "section_code должен быть UCH_1..UCH_8")
    updated_by = getattr(_admin, "username", None) or "admin"
    if body.delete or body.difference_percent is None:
        conn = get_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        DELETE FROM daily_section_rating_mstroy_convergence
                        WHERE rating_date = %s
                          AND scope = %s
                          AND section_code = %s
                        RETURNING id::text
                        """,
                        (selected_date, scope_key, section_code),
                    )
                    deleted = cur.fetchone()
        finally:
            conn.close()
        return {
            "ok": True,
            "deleted": bool(deleted),
            "rating_date": selected_date.isoformat(),
            "scope": scope_key,
            "section_code": section_code,
        }
    difference_percent = _section_rating_float(body.difference_percent)
    if difference_percent is None or difference_percent < 0 or difference_percent > 1000:
        raise HTTPException(400, "difference_percent должен быть числом от 0 до 1000")
    score = _section_rating_mstroy_score(difference_percent)
    comment = str(body.comment or "").strip()[:1000] or None
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '15s'")
                cur.execute(
                    """
                    INSERT INTO daily_section_rating_mstroy_convergence (
                      rating_date,
                      scope,
                      section_code,
                      difference_percent,
                      score,
                      comment,
                      created_by,
                      updated_by
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (rating_date, scope, section_code) DO UPDATE
                    SET difference_percent = EXCLUDED.difference_percent,
                        score = EXCLUDED.score,
                        comment = EXCLUDED.comment,
                        updated_by = EXCLUDED.updated_by,
                        updated_at = NOW()
                    RETURNING
                      id::text,
                      rating_date,
                      scope,
                      section_code,
                      difference_percent::float,
                      score::float,
                      comment,
                      created_by,
                      created_at,
                      updated_by,
                      updated_at
                    """,
                    (selected_date, scope_key, section_code, difference_percent, score, comment, updated_by, updated_by),
                )
                row = cur.fetchone()
    finally:
        conn.close()
    return {"ok": True, "row": _section_rating_mstroy_row_payload(row)}


# ── GET /api/wip/reports/stockpiles ──────────────────────────────────────

@router.get("/stockpiles")
def report_stockpiles(section: Optional[str] = None):
    """Справочник накопителей для мастера отчета: выбор по пикетажу и материалу."""
    where = ["COALESCE(o.is_active, true) IS NOT FALSE", "COALESCE(sp.is_active, true) IS NOT FALSE"]
    params: list[Any] = []
    if section and section != "all":
        where.append(
            """
            EXISTS (
              SELECT 1
              FROM object_segments os_scope
              JOIN construction_section_versions csv
                ON csv.is_current = true
               AND csv.boundary_kind = 'main'
               AND ((os_scope.pk_start + COALESCE(os_scope.pk_end, os_scope.pk_start)) / 2.0) BETWEEN csv.pk_start AND csv.pk_end
              JOIN construction_sections cs ON cs.id = csv.section_id
              WHERE os_scope.object_id = o.id
                AND cs.code = %s
            )
            """
        )
        params.append(section)
    rows = query(
        f"""
        WITH stockpile_source AS (
          SELECT sp.id AS stockpile_id,
                 sp.name AS stockpile_name,
                 o.id AS object_id,
                 o.object_code,
                 o.name AS object_name,
                 sp.material_id,
                 CASE
                   WHEN lower(COALESCE(sp.name, o.name, '')) LIKE '%%щпгс%%' THEN 'SHPGS'
                   WHEN lower(COALESCE(sp.name, o.name, '')) LIKE '%%пес%%' THEN 'SAND'
                   WHEN lower(COALESCE(sp.name, o.name, '')) LIKE '%%торф%%' THEN 'PEAT'
                   WHEN lower(COALESCE(sp.name, o.name, '')) LIKE '%%грунт%%' THEN 'SOIL'
                   ELSE NULL
                 END AS inferred_material_code
          FROM objects o
          JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'STOCKPILE'
          LEFT JOIN stockpiles sp ON sp.object_id = o.id
          WHERE {' AND '.join(where)}
        )
        SELECT COALESCE(src.stockpile_id::text, src.object_id::text) AS id,
               src.stockpile_id::text AS stockpile_id,
               src.object_id::text AS object_id,
               COALESCE(src.stockpile_name, src.object_name) AS name,
               src.object_code,
               src.object_name,
               COALESCE(m.code, im.code) AS material_code,
               COALESCE(m.name, im.name) AS material,
               os.pk_start,
               os.pk_end,
               os.pk_raw_text,
               COALESCE(
                 (SELECT cs.code
                  FROM construction_section_versions csv
                  JOIN construction_sections cs ON cs.id = csv.section_id
                  WHERE csv.is_current = true
                    AND csv.boundary_kind = 'main'
                    AND os.pk_start IS NOT NULL
                    AND ((os.pk_start + COALESCE(os.pk_end, os.pk_start)) / 2.0) BETWEEN csv.pk_start AND csv.pk_end
                  ORDER BY cs.sort_order NULLS LAST, cs.code
                  LIMIT 1),
                 NULL
               ) AS section_code,
               (src.stockpile_id IS NOT NULL) AS has_stockpile_record
        FROM stockpile_source src
        LEFT JOIN materials m ON m.id = src.material_id
        LEFT JOIN materials im ON im.code = src.inferred_material_code
        LEFT JOIN LATERAL (
          SELECT pk_start, pk_end, pk_raw_text
          FROM object_segments os
          WHERE os.object_id = src.object_id
          ORDER BY os.pk_start NULLS LAST
          LIMIT 1
        ) os ON true
        ORDER BY section_code NULLS LAST, os.pk_start NULLS LAST, COALESCE(src.stockpile_name, src.object_name)
        """,
        params,
    )
    for row in rows:
        row["pk_start"] = float(row["pk_start"]) if row.get("pk_start") is not None else None
        row["pk_end"] = float(row["pk_end"]) if row.get("pk_end") is not None else None
        row["pk_label"] = (
            f"{_format_pk_db(row.get('pk_start'))} — {_format_pk_db(row.get('pk_end'))}"
            if row.get("pk_start") is not None and row.get("pk_end") is not None
            else row.get("pk_raw_text")
        )
    return {"rows": rows}


# ── GET /api/wip/reports/pile-fields ───────────────────────────────────

@router.get("/pile-fields")
def report_pile_fields(section: Optional[str] = None):
    """
    Справочник свайных целей для review-блока отчёта.
    Возвращает обычные свайные поля и, если есть спецификация, сваи ПЖБТ/PIPE.
    """
    where: list[str] = ["pf.is_demo = false"]
    params: list[Any] = []
    section_codes = _report_section_codes(section)
    if section_codes:
        where.append(
            """
            EXISTS (
              SELECT 1
              FROM construction_section_versions csv
              JOIN construction_sections cs ON cs.id = csv.section_id
              WHERE csv.is_current = true
                AND csv.boundary_kind = 'piles_pipes'
                AND cs.code = ANY(%s)
                AND pf.pk_start >= csv.pk_start
                AND pf.pk_end <= csv.pk_end
            )
            """
        )
        params.append(section_codes)
    rows = query(
        f"""
        SELECT
          pf.id::text AS id,
          pf.field_code,
          pf.field_type,
          pf.pile_type,
          pf.pk_start,
          pf.pk_end,
          pf.pk_raw_text,
          pf.pile_count,
          COALESCE((
            SELECT SUM(dwi.volume)::numeric
            FROM daily_work_item_segments seg
            JOIN daily_work_items dwi ON dwi.id = seg.daily_work_item_id
            JOIN work_types wt ON wt.id = dwi.work_type_id
            JOIN daily_reports dr ON dr.id = dwi.daily_report_id
            WHERE seg.pile_field_id = pf.id
              AND seg.is_demo IS NOT TRUE
              AND dwi.is_demo IS NOT TRUE
              AND wt.code IN ('PILE_MAIN', 'PILE_TRIAL')
              AND COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
              AND NOT (
                COALESCE(dr.source_type, '') = 'web_pile_control'
                OR COALESCE(dr.review_payload->'review_flags', '[]'::jsonb) ?| ARRAY['isso', 'контроль свай']
              )
          ), 0) AS completed_count,
          COALESCE(
            (SELECT cs.code
             FROM construction_section_versions csv
             JOIN construction_sections cs ON cs.id = csv.section_id
             WHERE csv.is_current = true
               AND csv.boundary_kind = 'piles_pipes'
               AND pf.pk_start >= csv.pk_start
               AND pf.pk_end <= csv.pk_end
             ORDER BY csv.pk_start
             LIMIT 1),
            NULL
          ) AS section_code
        FROM pile_fields pf
        WHERE {' AND '.join(where)}
        ORDER BY pf.pk_start, pf.field_code
        """,
        params,
    )
    for row in rows:
        row["target_type"] = "pile_field"
        row["work_type_code"] = "PILE_TRIAL" if row.get("field_type") == "test" else "PILE_MAIN"
    pipe_rows: list[dict[str, Any]] = []
    try:
        has_pipe_specs = bool(query("SELECT to_regclass('public.pipe_pile_specs') AS table_name")[0].get("table_name"))
    except Exception:
        has_pipe_specs = False
    if has_pipe_specs:
        pipe_where: list[str] = [
            "pps.is_active IS TRUE",
            "o.is_active IS NOT FALSE",
            "ot.is_active IS NOT FALSE",
            "wt.is_active IS NOT FALSE",
            "wt.code IN ('PILE_MAIN', 'PILE_TRIAL')",
        ]
        pipe_params: list[Any] = []
        if section_codes:
            pipe_where.append(
                """
                EXISTS (
                  SELECT 1
                  FROM object_segments os_filter
                  JOIN construction_section_versions csv ON csv.is_current = true
                   AND csv.boundary_kind = 'piles_pipes'
                   AND ((os_filter.pk_start + COALESCE(os_filter.pk_end, os_filter.pk_start)) / 2.0) BETWEEN csv.pk_start AND csv.pk_end
                  JOIN construction_sections cs ON cs.id = csv.section_id
                  WHERE os_filter.object_id = o.id
                    AND cs.code = ANY(%s)
                )
                """
            )
            pipe_params.append(section_codes)
        pipe_rows = query(
            f"""
            SELECT
              ('pipe:' || pps.id::text) AS id,
              pps.id::text AS pipe_pile_spec_id,
              o.id::text AS object_id,
              o.object_code,
              o.name AS object_name,
              COALESCE(NULLIF(o.name, ''), o.object_code) AS field_code,
              CASE WHEN wt.code = 'PILE_TRIAL' THEN 'test' ELSE 'main' END AS field_type,
              ('L=' || trim(to_char(pps.pile_length_m, 'FM999999990.##')) || ' м') AS pile_type,
              os.pk_start,
              os.pk_end,
              os.pk_raw_text,
              pps.quantity AS pile_count,
              wt.code AS work_type_code,
              COALESCE((
                SELECT SUM(dwi.volume)::numeric
                FROM daily_work_items dwi
                JOIN work_types dwt ON dwt.id = dwi.work_type_id
                JOIN daily_reports dr ON dr.id = dwi.daily_report_id
                WHERE dwi.object_id = o.id
                  AND dwi.is_demo IS NOT TRUE
                  AND dwt.code = wt.code
                  AND COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
                  AND NOT (
                    COALESCE(dr.source_type, '') = 'web_pile_control'
                    OR COALESCE(dr.review_payload->'review_flags', '[]'::jsonb) ?| ARRAY['isso', 'контроль свай']
                  )
              ), 0) AS completed_count,
              COALESCE(
                (SELECT cs.code
                 FROM object_segments os_sec
                 JOIN construction_section_versions csv ON csv.is_current = true
                  AND csv.boundary_kind = 'piles_pipes'
                  AND ((os_sec.pk_start + COALESCE(os_sec.pk_end, os_sec.pk_start)) / 2.0) BETWEEN csv.pk_start AND csv.pk_end
                 JOIN construction_sections cs ON cs.id = csv.section_id
                 WHERE os_sec.object_id = o.id
                 ORDER BY csv.pk_start
                 LIMIT 1),
                NULL
              ) AS section_code
            FROM pipe_pile_specs pps
            JOIN objects o ON o.id = pps.object_id
            JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'PIPE'
            JOIN work_types wt ON wt.id = pps.work_type_id
            LEFT JOIN LATERAL (
              SELECT pk_start, pk_end, pk_raw_text
              FROM object_segments os
              WHERE os.object_id = o.id
              ORDER BY os.pk_start NULLS LAST
              LIMIT 1
            ) os ON true
            WHERE {' AND '.join(pipe_where)}
            ORDER BY os.pk_start NULLS LAST, o.object_code, wt.code, pps.pile_length_m
            """,
            pipe_params,
        )
        for row in pipe_rows:
            row["target_type"] = "pipe"
            row["dynamic_test_count"] = None
    rows.extend(pipe_rows)
    for row in rows:
        row["pk_start"] = float(row["pk_start"]) if row.get("pk_start") is not None else None
        row["pk_end"] = float(row["pk_end"]) if row.get("pk_end") is not None else None
        row["pk_label"] = (
            f"{_format_pk_db(row.get('pk_start'))} — {_format_pk_db(row.get('pk_end'))}"
            if row.get("pk_start") is not None and row.get("pk_end") is not None
            else row.get("pk_raw_text")
        )
        row["pile_length_label"] = _pile_length_label(row.get("pile_type"))
        completed = float(row.get("completed_count") or 0)
        plan = float(row.get("pile_count") or 0) if row.get("pile_count") is not None else None
        row["completed_count"] = round(completed, 2)
        row["remaining_count"] = round(max(plan - completed, 0), 2) if plan is not None else None
    filtered = [row for row in rows if row.get("remaining_count") is None or float(row.get("remaining_count") or 0) > 0]
    filtered.sort(key=lambda row: (
        row.get("pk_start") is None,
        row.get("pk_start") or 0,
        1 if row.get("target_type") == "pipe" else 0,
        str(row.get("field_code") or ""),
        str(row.get("work_type_code") or ""),
    ))
    return {"rows": filtered}




def _report_section_codes(section: Optional[str]) -> list[str]:
    value = (section or "").strip()
    if not value or value == "all":
        return []
    if value == "UCH_3":
        return ["UCH_3", "UCH_31", "UCH_32"]
    return [value]


def _is_report_pile_equipment_text(equipment_type: object, brand_model: object = None) -> bool:
    text = f"{equipment_type or ''} {brand_model or ''}".strip().lower().replace("ё", "е")
    return (
        "сваеб" in text
        or "свай" in text
        or "сбу" in text
        or "коп" in text
        or "junttan" in text
        or ("бур" in text and "установ" in text)
    )


def _report_pile_equipment_has_identifier(row: dict[str, Any]) -> bool:
    return bool(_clean_identifier(row.get("unit_number")) or _clean_identifier(row.get("plate_number")))


def _report_pile_equipment_is_own(row: dict[str, Any]) -> bool:
    ownership = _clean_identifier(row.get("ownership_type")).lower()
    contractor = _clean_identifier(row.get("contractor")).lower().replace("ё", "е")
    return ownership == "own" or contractor in {"ждс", "ооо ждс", "желдорстрой"} or "желдорстрой" in contractor


def _report_pile_equipment_sort_key(row: dict[str, Any]) -> tuple:
    unit = _clean_identifier(row.get("unit_number"))
    plate = _clean_identifier(row.get("plate_number"))
    numeric_unit = bool(re.fullmatch(r"\d+", unit))
    unit_num = int(unit) if numeric_unit else 10**9
    has_unit = bool(unit)
    own_bucket = 0 if _report_pile_equipment_is_own(row) else 1
    contractor = _clean_identifier(row.get("contractor")).lower()
    model = _clean_identifier(row.get("brand_model")) or _clean_identifier(row.get("equipment_type"))
    if numeric_unit and own_bucket == 0:
        group = 0
    elif numeric_unit:
        group = 1
    elif has_unit and own_bucket == 0:
        group = 2
    elif has_unit:
        group = 3
    elif own_bucket == 0:
        group = 4
    else:
        group = 5
    return (
        group,
        unit_num,
        unit,
        contractor if own_bucket else "",
        model.lower(),
        plate,
    )


def _report_pile_equipment_label(row: dict[str, Any]) -> str:
    model = _clean_identifier(row.get("brand_model")) or _clean_identifier(row.get("equipment_type")) or "Сваебойка"
    parts = [
        model,
        f"б/н {_clean_identifier(row.get('unit_number'))}" if _clean_identifier(row.get("unit_number")) else "",
        f"г/н {_clean_identifier(row.get('plate_number'))}" if _clean_identifier(row.get("plate_number")) else "",
        _clean_identifier(row.get("contractor")),
    ]
    return " · ".join(part for part in parts if part)


@router.get("/pile-equipment")
def report_pile_equipment(
    date: Optional[str] = Query(None),
    section: Optional[str] = Query(None),
    _user=Depends(current_user),
):
    """Дедуплицированный список сваебоек/СБУ из М-отчетов и master-каталога."""
    _ = (date, section)  # параметры оставлены для совместимости старых клиентов
    rows = query(
        """
        WITH report_source AS (
          SELECT reu.id::text AS report_equipment_unit_id,
                 reu.equipment_unit_id::text AS equipment_unit_id,
                 dr.report_date,
                 LOWER(COALESCE(dr.shift, 'unknown')) AS shift,
                 cs.code AS section_code,
                 cs.name AS section_name,
                 COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, 'техника') AS equipment_type,
                 COALESCE(NULLIF(reu.brand_model, ''), eu.brand_model, '') AS brand_model,
                 COALESCE(NULLIF(reu.unit_number, ''), eu.unit_number, '') AS unit_number,
                 COALESCE(NULLIF(reu.plate_number, ''), eu.plate_number, '') AS plate_number,
                 COALESCE(NULLIF(reu.ownership_type, ''), eu.ownership_type, 'unknown') AS ownership_type,
                 COALESCE(NULLIF(reu.status, ''), eu.status, '') AS status,
                 COALESCE(NULLIF(reu.contractor_name, ''), c.short_name, c.name, eu.contractor_name, '') AS contractor,
                 LOWER(REGEXP_REPLACE(COALESCE(NULLIF(reu.unit_number, ''), eu.unit_number, ''), '\\s+', '', 'g')) AS unit_key,
                 LOWER(REGEXP_REPLACE(COALESCE(NULLIF(reu.plate_number, ''), eu.plate_number, ''), '\\s+', '', 'g')) AS plate_key,
                 'report' AS source_kind
          FROM report_equipment_units reu
          JOIN daily_reports dr ON dr.id = reu.daily_report_id
          LEFT JOIN construction_sections cs ON cs.id = dr.section_id
          LEFT JOIN equipment_units eu ON eu.id = reu.equipment_unit_id
          LEFT JOIN contractors c ON c.id = reu.contractor_id
          WHERE reu.is_demo IS NOT TRUE
            AND COALESCE(dr.status, 'confirmed') IN ('confirmed', 'approved', 'pending_review')
            AND LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) NOT LIKE '%%самосвал%%'
            AND (
              LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) LIKE '%%сваеб%%'
              OR LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) LIKE '%%свай%%'
              OR LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) LIKE '%%сбу%%'
              OR LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) LIKE '%%бур%%'
              OR LOWER(COALESCE(NULLIF(reu.equipment_type, ''), eu.equipment_type, '')) LIKE '%%pile%%'
            )
            AND (
              NULLIF(BTRIM(COALESCE(NULLIF(reu.unit_number, ''), eu.unit_number, '')), '') IS NOT NULL
              OR NULLIF(BTRIM(COALESCE(NULLIF(reu.plate_number, ''), eu.plate_number, '')), '') IS NOT NULL
            )
        ), master_source AS (
          SELECT NULL::text AS report_equipment_unit_id,
                 eu.id::text AS equipment_unit_id,
                 eu.source_date AS report_date,
                 'master' AS shift,
                 NULL::text AS section_code,
                 NULL::text AS section_name,
                 COALESCE(NULLIF(eu.equipment_type, ''), 'техника') AS equipment_type,
                 COALESCE(NULLIF(eu.brand_model, ''), '') AS brand_model,
                 COALESCE(NULLIF(eu.unit_number, ''), '') AS unit_number,
                 COALESCE(NULLIF(eu.plate_number, ''), '') AS plate_number,
                 COALESCE(NULLIF(eu.ownership_type, ''), 'unknown') AS ownership_type,
                 COALESCE(NULLIF(eu.status, ''), '') AS status,
                 COALESCE(NULLIF(eu.contractor_name, ''), '') AS contractor,
                 LOWER(REGEXP_REPLACE(COALESCE(NULLIF(eu.unit_number, ''), ''), '\\s+', '', 'g')) AS unit_key,
                 LOWER(REGEXP_REPLACE(COALESCE(NULLIF(eu.plate_number, ''), ''), '\\s+', '', 'g')) AS plate_key,
                 'master' AS source_kind
          FROM equipment_units eu
          WHERE eu.is_active IS NOT FALSE
            AND (
              NULLIF(BTRIM(COALESCE(eu.unit_number, '')), '') IS NOT NULL
              OR NULLIF(BTRIM(COALESCE(eu.plate_number, '')), '') IS NOT NULL
            )
            AND LOWER(COALESCE(eu.equipment_type, '')) NOT LIKE '%%самосвал%%'
            AND (
              LOWER(COALESCE(eu.equipment_type, '')) LIKE '%%сваеб%%'
              OR LOWER(COALESCE(eu.equipment_type, '')) LIKE '%%свай%%'
              OR LOWER(COALESCE(eu.equipment_type, '')) LIKE '%%сбу%%'
              OR LOWER(COALESCE(eu.equipment_type, '')) LIKE '%%бур%%'
              OR LOWER(COALESCE(eu.equipment_type, '')) LIKE '%%pile%%'
              OR LOWER(COALESCE(eu.brand_model, '')) LIKE '%%junttan%%'
            )
        ), source AS (
          SELECT * FROM report_source
          UNION ALL
          SELECT * FROM master_source
        ), keyed AS (
          SELECT *,
                 CASE
                   WHEN equipment_unit_id IS NOT NULL AND equipment_unit_id <> '' THEN 'master:' || equipment_unit_id
                   WHEN unit_key <> '' THEN 'unit:' || unit_key
                   WHEN plate_key <> '' THEN 'plate:' || plate_key
                   ELSE 'row:' || report_equipment_unit_id
                 END AS dedupe_key
          FROM source
        )
        SELECT DISTINCT ON (dedupe_key)
               report_equipment_unit_id,
               equipment_unit_id,
               report_date,
               shift,
               section_code,
               section_name,
               equipment_type,
               brand_model,
               unit_number,
               plate_number,
               ownership_type,
               status,
               contractor,
               dedupe_key,
               source_kind
        FROM keyed
        ORDER BY dedupe_key,
                 CASE source_kind WHEN 'report' THEN 0 ELSE 1 END,
                 report_date DESC NULLS LAST,
                 CASE shift WHEN 'night' THEN 2 WHEN 'day' THEN 1 ELSE 0 END DESC,
                 report_equipment_unit_id DESC NULLS LAST
        """,
        [],
    )

    out: list[dict[str, Any]] = []
    for row in rows:
        if not _report_pile_equipment_has_identifier(row):
            continue
        if not _is_report_pile_equipment_text(row.get("equipment_type"), row.get("brand_model")):
            continue
        rid = str(row.get("report_equipment_unit_id") or "")
        master_id = str(row.get("equipment_unit_id") or "")
        option_id = rid or (f"master:{master_id}" if master_id else "")
        if not option_id:
            continue
        shift_label = "день" if row.get("shift") == "day" else "ночь" if row.get("shift") == "night" else "смена"
        report_date = row.get("report_date")
        report_date_label = report_date.isoformat() if hasattr(report_date, "isoformat") else str(report_date or "")
        out.append({
            "report_equipment_unit_id": option_id,
            "equipment_unit_id": master_id or None,
            "label": _report_pile_equipment_label(row),
            "equipment_type": row.get("equipment_type"),
            "brand_model": row.get("brand_model"),
            "unit_number": row.get("unit_number"),
            "plate_number": row.get("plate_number"),
            "ownership_type": row.get("ownership_type"),
            "status": row.get("status"),
            "section_code": row.get("section_code"),
            "section_name": row.get("section_name"),
            "shift": row.get("shift"),
            "contractor": row.get("contractor"),
            "dedupe_key": row.get("dedupe_key"),
            "last_report_date": report_date_label,
            "source": "Отчет М" if row.get("source_kind") == "report" else "Справочник техники",
            "source_note": f"последний М {report_date_label} {shift_label}" if row.get("source_kind") == "report" and report_date_label else "master",
        })
    out.sort(key=_report_pile_equipment_sort_key)
    return {"rows": out}


# ── GET /api/wip/reports/{id}/preview ───────────────────────────────────

@router.get("/{report_id}/preview")
def preview_stored_report(report_id: str):
    """
    Возвращает распарсенную структуру для уже сохранённого отчёта.
    Если raw_text отсутствует — возвращает {"available": false, ...}.
    """
    try:
        uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(400, "Невалидный id")
    _ensure_report_review_schema()

    rows = query(
        """
        SELECT
          dr.id::text        AS id,
          dr.report_date,
          dr.shift,
          dr.source_type,
          dr.source_reference,
          dr.uploaded_by_username,
          dr.raw_text,
          dr.status,
          dr.review_tag,
          dr.review_payload,
          dr.initial_parse_payload,
          cs.code            AS section_code,
          cs.name            AS section_name
        FROM daily_reports dr
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE dr.id = %s
        LIMIT 1
        """,
        [report_id],
    )
    if not rows:
        raise HTTPException(404, "Отчёт не найден")
    row = rows[0]
    raw_text = row.get("raw_text")

    meta = {
        "id": row["id"],
        "report_date": _iso_date(row.get("report_date")),
        "shift": row.get("shift"),
        "section_code": row.get("section_code"),
        "section_name": row.get("section_name"),
        "source_type": row.get("source_type"),
        "source_reference": row.get("source_reference"),
        "uploaded_by_username": row.get("uploaded_by_username"),
        "status": row.get("status"),
        "review_tag": row.get("review_tag"),
        "review_payload": row.get("review_payload"),
        "initial_parse_payload": row.get("initial_parse_payload"),
    }

    parsed = _stored_report_payload(report_id, meta, raw_text)
    return {"available": True, "meta": meta, "parsed": parsed}


# ── POST /api/wip/reports/import ────────────────────────────────────────

class ImportHeader(BaseModel):
    report_date: str
    shift: str  # day | night | unknown
    section_code: Optional[str] = None
    author: Optional[str] = None


class ImportPayload(BaseModel):
    report_mode: Optional[str] = None
    header: ImportHeader
    transport: list[dict[str, Any]] = []
    main_works: list[dict[str, Any]] = []
    aux_works: list[dict[str, Any]] = []
    staff_counts: list[dict[str, Any]] = []
    park: list[dict[str, Any]] = []
    problems: Optional[str] = ""
    stockpiles: list[dict[str, Any]] = []
    piles: list[dict[str, Any]] = []
    pile_control: Optional[dict[str, Any]] = None
    fill_statuses: list[dict[str, Any]] = []
    mainline_fill_statuses: list[dict[str, Any]] = []
    raw_text: Optional[str] = None
    initial_parse: Optional[dict[str, Any]] = None
    source_type: Optional[str] = "web_upload"
    source_reference: Optional[str] = None
    # Sanitized operator/review tags. Messenger intake uses this for labels like
    # `дубль` while review_tag stays the internal pending-row cleanup key.
    review_flags: list[str] = Field(default_factory=list)


_IMPORT_NUMERIC_KEYS = {
    "volume",
    "count",
    "trips",
    "equipment_count",
    "hired_count",
    "count_units",
    "worked_volume",
    "worked_area",
    "balance_volume",
    "haul_distance_km",
    "distance_km",
    "work_hours",
}


def _work_usage_unit_key(value: Any) -> str:
    text = str(value or "").strip().lower().replace("³", "3").replace("²", "2")
    text = re.sub(r"\s+", "", text)
    if text in {"м3", "m3"}:
        return "м3"
    if text in {"м2", "m2"}:
        return "м2"
    return text


_WORK_EQUIPMENT_VISIBLE_FIELDS = (
    "equipment_unit_id",
    "equipment_type",
    "brand_model",
    "reported_number",
    "unit_number",
    "plate_number",
    "plate",
    "owner",
    "contractor_name",
    "ownership_type",
    "status",
    "equipment_match_status",
    "work_hours",
)
_WORK_EQUIPMENT_COUNT_FIELDS = ("equipment_count", "hired_count", "count_units")
_EQUIPMENT_VOLUME_RE = re.compile(r"(?<![0-9A-Za-zА-Яа-я])(\d+(?:[.,]\d+)?)\s*(м3|м³|m3|м2|м²|m2)\b", re.I)


def _payload_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        number = Decimal(str(value).replace(" ", "").replace(",", "."))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def _payload_number(value: Decimal) -> float | int:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _equipment_volume_sources(row: dict[str, Any]) -> list[str]:
    sources: list[str] = []
    source = row.get("_source")
    if isinstance(source, dict):
        sources.append(str(source.get("text") or ""))
    for field in ("reported_number", "unit_number", "plate_number", "plate", "vehicle", "equipment_type", "comment"):
        value = str(row.get(field) or "").strip()
        if value:
            sources.append(value)
    return sources


def _embedded_equipment_volume(row: dict[str, Any], preferred_unit: str) -> tuple[Optional[Decimal], Optional[str]]:
    fallback: tuple[Optional[Decimal], Optional[str]] = (None, None)
    for text in _equipment_volume_sources(row):
        for match in _EQUIPMENT_VOLUME_RE.finditer(text):
            number = _payload_decimal(match.group(1))
            unit_key = _work_usage_unit_key(match.group(2))
            if number is None or unit_key not in {"м2", "м3"}:
                continue
            if preferred_unit and unit_key == preferred_unit:
                return number, unit_key
            if fallback == (None, None):
                fallback = (number, unit_key)
    return fallback


def _split_decimal_evenly(total: Decimal, count: int) -> list[Decimal]:
    if count <= 1:
        return [total]
    quantum = Decimal("0.001")
    base = (total / Decimal(count)).quantize(quantum)
    values = [base for _ in range(count)]
    values[-1] = total - sum(values[:-1], Decimal("0"))
    return values


def _apply_equipment_to_work_row(
    work: dict[str, Any],
    equipment_row: dict[str, Any],
    *,
    row_key: str,
    volume: Any,
    unit: Any,
    keep_count: bool = False,
) -> dict[str, Any]:
    clone = deepcopy(work)
    equipment_clone = deepcopy(equipment_row)
    clone["_equipment_row_key"] = row_key
    equipment_clone["_equipment_row_key"] = row_key
    clone["volume"] = volume
    clone["unit"] = unit
    equipment_clone["volume"] = volume
    equipment_clone["unit"] = unit
    clone["equipment"] = [equipment_clone]
    for field in _WORK_EQUIPMENT_VISIBLE_FIELDS:
        value = equipment_clone.get(field)
        if value not in (None, ""):
            clone[field] = value
    if equipment_clone.get("plate") and not equipment_clone.get("plate_number"):
        equipment_clone["plate_number"] = equipment_clone.get("plate")
    if equipment_clone.get("plate_number") and not equipment_clone.get("plate"):
        equipment_clone["plate"] = equipment_clone.get("plate_number")
    if keep_count:
        for field in _WORK_EQUIPMENT_COUNT_FIELDS:
            clone[field] = 1
            equipment_clone[field] = 1
    else:
        for field in _WORK_EQUIPMENT_COUNT_FIELDS:
            clone.pop(field, None)
            equipment_clone.pop(field, None)
    return clone


def _normalize_regular_work_equipment_cardinality(payload_dict: dict[str, Any]) -> dict[str, Any]:
    """Regular work rows are one fact volume for one equipment unit."""
    review_rows: list[dict[str, Any]] = []
    for collection_key in ("main_works", "aux_works"):
        collection = payload_dict.get(collection_key)
        if not isinstance(collection, list):
            continue
        normalized: list[Any] = []
        for work_idx, work in enumerate(collection):
            if not isinstance(work, dict):
                normalized.append(work)
                continue
            raw_equipment = work.get("equipment") if isinstance(work.get("equipment"), list) else []
            equipment_rows = [row for row in raw_equipment if isinstance(row, dict)]
            generated_count = _row_equipment_count(work)
            if len(equipment_rows) <= 1 and generated_count <= 1:
                normalized.append(work)
                continue

            work_unit_raw = work.get("unit") or (equipment_rows[0].get("unit") if equipment_rows else None) or "м3"
            work_unit = _work_usage_unit_key(work_unit_raw)
            work_volume = _payload_decimal(work.get("volume"))
            base_key = _clean_identifier(work.get("_equipment_row_key")) or f"{collection_key}:{work_idx}"
            candidates: list[dict[str, Any]] = []
            if equipment_rows:
                for eq_idx, equipment_row in enumerate(equipment_rows):
                    eq = deepcopy(equipment_row)
                    eq_volume = _payload_decimal(eq.get("volume"))
                    eq_unit = _work_usage_unit_key(eq.get("unit") or work_unit_raw)
                    embedded_volume, embedded_unit = _embedded_equipment_volume(eq, work_unit)
                    if eq_volume is None and embedded_volume is not None:
                        eq_volume = embedded_volume
                        eq_unit = embedded_unit or eq_unit
                    compatible = work_unit not in {"м2", "м3"} or eq_unit in {"", work_unit}
                    candidates.append({
                        "index": eq_idx,
                        "equipment": eq,
                        "volume": eq_volume,
                        "unit": eq_unit or work_unit,
                        "compatible": compatible,
                        "row_key": _clean_identifier(eq.get("_equipment_row_key")) or f"{base_key}:eq:{eq_idx}",
                    })
            elif generated_count > 1 and work_volume is not None:
                volumes = _split_decimal_evenly(work_volume, generated_count)
                for eq_idx, volume in enumerate(volumes):
                    candidates.append({
                        "index": eq_idx,
                        "equipment": {
                            "equipment_count": 1,
                            "hired_count": 1,
                            "count_units": 1,
                            "owner": work.get("owner") or work.get("contractor_name"),
                            "contractor_name": work.get("contractor_name") or work.get("owner"),
                            "equipment_type": work.get("equipment_type"),
                            "ownership_type": work.get("ownership_type"),
                            "status": work.get("status") or "working",
                        },
                        "volume": volume,
                        "unit": work_unit,
                        "compatible": True,
                        "row_key": f"{base_key}:count:{eq_idx}",
                        "keep_count": True,
                    })

            compatible_with_volume = [
                candidate for candidate in candidates
                if candidate["compatible"] and candidate["volume"] is not None
            ]
            split_candidates: list[dict[str, Any]] = []
            mode = "kept_best_equipment"
            if generated_count > 1 and not equipment_rows and compatible_with_volume:
                split_candidates = compatible_with_volume
                mode = "split_hired_count_evenly"
            elif work_volume is not None and len(compatible_with_volume) > 1:
                volume_sum = sum((candidate["volume"] for candidate in compatible_with_volume), Decimal("0"))
                if abs(volume_sum - work_volume) <= Decimal("0.001"):
                    split_candidates = compatible_with_volume
                    mode = "split_by_equipment_volume"

            if split_candidates:
                for candidate in split_candidates:
                    normalized.append(_apply_equipment_to_work_row(
                        work,
                        candidate["equipment"],
                        row_key=candidate["row_key"],
                        volume=_payload_number(candidate["volume"]),
                        unit=work_unit_raw if _work_usage_unit_key(work_unit_raw) == candidate["unit"] else candidate["unit"],
                        keep_count=bool(candidate.get("keep_count")),
                    ))
                review_rows.append({
                    "collection": collection_key,
                    "index": work_idx + 1,
                    "mode": mode,
                    "work_name": work.get("work_name"),
                    "object": work.get("object_code") or work.get("object_name") or work.get("constructive"),
                    "original_equipment_count": len(equipment_rows) or generated_count,
                    "result_work_rows": len(split_candidates),
                })
                continue

            selectable = [
                candidate for candidate in candidates
                if candidate["compatible"] and (candidate["volume"] is not None or work_volume is not None)
            ] or [candidate for candidate in candidates if candidate["compatible"]] or candidates[:1]
            if selectable:
                selected = min(
                    selectable,
                    key=lambda candidate: (
                        0 if candidate["volume"] is not None else 1,
                        abs(candidate["volume"] - work_volume) if candidate["volume"] is not None and work_volume is not None else Decimal("999999999"),
                        candidate["index"],
                    ),
                )
                selected_volume = work_volume if work_volume is not None else selected["volume"]
                normalized.append(_apply_equipment_to_work_row(
                    work,
                    selected["equipment"],
                    row_key=selected["row_key"],
                    volume=_payload_number(selected_volume) if isinstance(selected_volume, Decimal) else selected_volume,
                    unit=work_unit_raw,
                    keep_count=bool(selected.get("keep_count")),
                ))
                review_rows.append({
                    "collection": collection_key,
                    "index": work_idx + 1,
                    "mode": "kept_best_equipment",
                    "work_name": work.get("work_name"),
                    "object": work.get("object_code") or work.get("object_name") or work.get("constructive"),
                    "original_equipment_count": len(equipment_rows) or generated_count,
                    "result_work_rows": 1,
                    "selected_equipment_index": selected["index"] + 1,
                    "dropped_equipment_count": max((len(equipment_rows) or generated_count) - 1, 0),
                })
            else:
                normalized.append(work)
        payload_dict[collection_key] = normalized
    if review_rows:
        review_actions = payload_dict.setdefault("review_actions", {})
        if isinstance(review_actions, dict):
            review_actions["multi_equipment_work_rows_normalized"] = review_rows
    return payload_dict


def _sync_single_work_equipment_usage_volumes(payload_dict: dict[str, Any]) -> dict[str, Any]:
    """Keep one-machine work rows aligned with the latest saved work fact."""
    for work in _payload_regular_work_rows(payload_dict):
        work_volume = work.get("volume")
        if work_volume in (None, ""):
            continue
        equipment_rows = work.get("equipment")
        if not isinstance(equipment_rows, list):
            continue
        equipment_dicts = [row for row in equipment_rows if isinstance(row, dict)]
        if len(equipment_dicts) != 1:
            continue
        equipment_row = equipment_dicts[0]
        unit_raw = work.get("unit") or equipment_row.get("unit")
        work_unit = _work_usage_unit_key(unit_raw)
        if work_unit not in {"м2", "м3"}:
            continue
        equipment_row["volume"] = work_volume
        equipment_row["unit"] = unit_raw or work_unit
    return payload_dict


WORK_SHIFT_HOURS = Decimal("11")


def _coerce_work_hours(value: Any, row_label: str) -> Decimal:
    if value in (None, "") or (isinstance(value, str) and not value.strip()):
        return WORK_SHIFT_HOURS
    number = _payload_decimal(value)
    if number is None or number <= 0 or number > WORK_SHIFT_HOURS:
        raise HTTPException(400, f"Время работы должно быть больше 0 и не больше 11 часов: {row_label}")
    return number


def _equipment_work_hours_identities(row: dict[str, Any]) -> list[str]:
    identities: list[str] = []
    master_id = _clean_identifier(row.get("equipment_unit_id"))
    if master_id:
        identities.append(f"master:{master_id.lower()}")
    plate = _normalize_equipment_identifier(row.get("plate_number") or row.get("plate"))
    if plate:
        identities.append(f"plate:{plate}")
    unit = _normalize_equipment_identifier(row.get("unit_number") or row.get("reported_number"))
    if unit:
        equipment_type = _normalize_ref(row.get("equipment_type") or row.get("vehicle"))
        identities.append(f"unit:{equipment_type}:{unit}")
    return identities


def _validate_payload_equipment_work_hours(payload_dict: dict[str, Any]) -> None:
    totals: dict[str, Decimal] = {}

    def add(row: dict[str, Any], value: Any, label: str) -> None:
        hours = _coerce_work_hours(value, label)
        identities = _equipment_work_hours_identities(row)
        if not identities:
            return
        total = max((totals.get(identity, Decimal("0")) for identity in identities), default=Decimal("0")) + hours
        if total > WORK_SHIFT_HOURS:
            raise HTTPException(
                400,
                f"Сумма часов больше продолжительности рабочей смены, проверьте {label}",
            )
        for identity in identities:
            totals[identity] = total

    for unit in payload_dict.get("transport") or []:
        if not isinstance(unit, dict):
            continue
        for trip in unit.get("trips") or []:
            if not isinstance(trip, dict):
                continue
            route = " -> ".join(
                value for value in (str(trip.get("from") or "").strip(), str(trip.get("to") or "").strip())
                if value
            )
            material = str(trip.get("material") or trip.get("material_code") or "").strip()
            detail = ": ".join(value for value in (material, route) if value) or "строку без названия"
            add(unit, trip.get("work_hours"), f"перевозку «{detail}»")

    for collection_key in ("main_works", "aux_works"):
        for work in payload_dict.get(collection_key) or []:
            if not isinstance(work, dict):
                continue
            nested = [row for row in (work.get("equipment") or []) if isinstance(row, dict)]
            equipment = {**work, **(nested[0] if nested else {})}
            value = equipment.get("work_hours")
            work_name = str(work.get("work_name") or "работу без названия").strip()
            object_name = str(work.get("constructive") or work.get("object_code") or "").strip()
            detail = " / ".join(value for value in (object_name, work_name) if value)
            add(equipment, value, f"работу «{detail}»")


def _ensure_review_flags(payload_dict: dict[str, Any], source_type: Optional[str]) -> dict[str, Any]:
    flags: list[str] = []
    raw_flags = payload_dict.get("review_flags") or []
    if isinstance(raw_flags, list):
        flags = [str(flag).strip() for flag in raw_flags if str(flag).strip()]
    elif isinstance(raw_flags, str) and raw_flags.strip():
        flags = [raw_flags.strip()]
    if (source_type or "").strip().lower() == "web_pile_control":
        for required in ("isso", "контроль свай"):
            if required not in flags:
                flags.append(required)
    payload_dict["review_flags"] = flags
    return payload_dict


def _coerce_haul_distance_km(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip().replace(" ", "").replace(",", ".")
        if not text:
            return None
        value = text
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number


def _normalize_import_payload_numbers(payload: ImportPayload) -> None:
    def normalize_value(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        text = value.strip().replace(" ", "")
        if not text:
            return None
        if re.fullmatch(r"-?\d+(?:[,.]\d+)?", text):
            return float(text.replace(",", "."))
        return value

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in list(node.items()):
                if isinstance(value, (dict, list)):
                    walk(value)
                elif key in _IMPORT_NUMERIC_KEYS:
                    node[key] = normalize_value(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    for section in (
        "transport",
        "main_works",
        "aux_works",
        "staff_counts",
        "park",
        "stockpiles",
        "piles",
        "fill_statuses",
        "mainline_fill_statuses",
    ):
        walk(getattr(payload, section, None))


@router.put("/{report_id}/review-payload")
def update_report_review_payload(report_id: str, payload: ImportPayload, _user=Depends(current_user)):
    """Save operator edits for a report that is still waiting for admin review."""
    try:
        uuid.UUID(report_id)
        report_date = date_cls.fromisoformat(payload.header.report_date)
    except ValueError:
        raise HTTPException(400, "Невалидный id или дата")
    shift = payload.header.shift or "unknown"
    if shift not in ("day", "night", "unknown"):
        raise HTTPException(400, "header.shift должен быть day|night|unknown")
    _normalize_import_payload_numbers(payload)
    _enrich_payload_ad_rail_from_temp_roads(payload)
    _assert_import_pk_validation(payload)
    _ensure_report_review_schema()
    sanitized_raw_text = sanitize_personal_report_text(payload.raw_text or "") if payload.raw_text else None
    payload_for_review = payload.dict() if hasattr(payload, "dict") else payload.model_dump()
    if sanitized_raw_text is not None:
        payload_for_review["raw_text"] = sanitized_raw_text
    _normalize_payload_equipment_identifiers(payload_for_review)
    payload_for_review = _normalize_regular_work_equipment_cardinality(payload_for_review)
    payload_for_review = _sync_single_work_equipment_usage_volumes(payload_for_review)
    _validate_payload_equipment_work_hours(payload_for_review)
    payload.main_works = payload_for_review.get("main_works") or []
    payload.aux_works = payload_for_review.get("aux_works") or []
    payload_for_review = _mark_existing_payload_reference_codes_manual(payload_for_review)
    payload_for_review = _refresh_payload_reference_metadata(payload_for_review)
    payload_for_review = _ensure_review_flags(payload_for_review, payload.source_type)
    pending_tag = "pending_admin_review"
    uploader_username = _web_uploaded_by_username(payload.source_type, getattr(_user, "username", None))
    current_username = getattr(_user, "username", None)
    is_admin = getattr(_user, "role", None) == "admin"
    user_permissions = set(getattr(_user, "permissions", []) or [])
    can_review_reports = is_admin or "reports:review" in user_permissions or "reports:edit" in user_permissions
    can_edit_reports = is_admin or "reports:edit" in user_permissions

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                section_id: Optional[str] = None
                if payload.header.section_code:
                    cur.execute(
                        "SELECT id FROM construction_sections WHERE code = %s LIMIT 1",
                        (payload.header.section_code,),
                    )
                    r = cur.fetchone()
                    if r:
                        section_id = r[0]
                cur.execute("SELECT status, initial_parse_payload, uploaded_by_username FROM daily_reports WHERE id = %s LIMIT 1", (report_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(404, "Отчёт не найден")
                current_status = row[0]
                uploaded_by_username = row[2]
                is_owner = bool(uploaded_by_username and current_username and uploaded_by_username == current_username)
                if uploaded_by_username:
                    uploader_username = uploaded_by_username
                is_review_edit = current_status in ("pending_review", "review") and (can_review_reports or is_owner)
                is_confirmed_admin_edit = current_status in ("confirmed", "approved") and can_edit_reports
                if not is_review_edit and not is_confirmed_admin_edit:
                    raise HTTPException(403, "Автор может редактировать свой отчёт только до подтверждения; чужие отчёты на проверке редактирует пользователь с правом проверки отчётов; подтверждённые отчёты редактирует пользователь с правом редактирования отчётов")
                initial_parse = payload.initial_parse or row[1]
                _report_quality_capture_day3_snapshot_for_report(
                    cur,
                    report_id,
                    captured_by="review_payload_update",
                    actor_username=current_username,
                )
                _snapshot_report_review_payload(
                    cur,
                    report_id,
                    "confirmed_review_payload_update" if is_confirmed_admin_edit else "review_payload_update",
                    current_username,
                )
                if is_confirmed_admin_edit:
                    cur.execute(
                        """
                        UPDATE daily_reports
                        SET report_date = %s,
                            shift = %s,
                            section_id = %s,
                            raw_text = COALESCE(%s, raw_text),
                            review_payload = %s::jsonb,
                            initial_parse_payload = COALESCE(%s::jsonb, initial_parse_payload),
                            uploaded_by_username = COALESCE(uploaded_by_username, %s),
                            status = 'confirmed',
                            parse_status = 'approved',
                            operator_status = 'approved',
                            review_tag = NULL
                        WHERE id = %s
                        """,
                        (
                            report_date,
                            shift,
                            section_id,
                            sanitized_raw_text,
                            json.dumps(payload_for_review, ensure_ascii=False),
                            json.dumps(initial_parse, ensure_ascii=False) if initial_parse else None,
                            uploader_username,
                            report_id,
                        ),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE daily_reports
                        SET report_date = %s,
                            shift = %s,
                            section_id = %s,
                            raw_text = COALESCE(%s, raw_text),
                            review_payload = %s::jsonb,
                            initial_parse_payload = COALESCE(%s::jsonb, initial_parse_payload),
                            uploaded_by_username = COALESCE(uploaded_by_username, %s),
                            operator_status = 'pending',
                            review_tag = %s
                        WHERE id = %s
                        """,
                        (
                            report_date,
                            shift,
                            section_id,
                            sanitized_raw_text,
                            json.dumps(payload_for_review, ensure_ascii=False),
                            json.dumps(initial_parse, ensure_ascii=False) if initial_parse else None,
                            uploader_username,
                            f"pending_admin_review:{report_id}",
                            report_id,
                        ),
                    )
                _store_parser_learning_cases(
                    cur,
                    report_id,
                    initial_parse=initial_parse,
                    final_payload=payload_for_review,
                    report_date=report_date,
                    shift=shift,
                    section_code=payload.header.section_code,
                    source_reference=payload.source_reference,
                )
                cur.execute(
                    """
                    UPDATE daily_work_items
                    SET report_date = %s,
                        shift = %s,
                        section_id = %s
                    WHERE daily_report_id = %s
                    """,
                    (report_date, shift, section_id, report_id),
                )
                cur.execute(
                    """
                    UPDATE material_movements
                    SET report_date = %s,
                        shift = %s,
                        section_id = %s
                    WHERE daily_report_id = %s
                    """,
                    (report_date, shift, section_id, report_id),
                )
                cur.execute("DELETE FROM daily_report_staff_counts WHERE daily_report_id = %s", (report_id,))
                for staff in payload.staff_counts or []:
                    category = (staff.get("category") or "").strip()
                    if not category:
                        continue
                    try:
                        count = int(float(staff.get("count") or 0))
                    except (TypeError, ValueError):
                        count = 0
                    cur.execute(
                        """INSERT INTO daily_report_staff_counts
                           (daily_report_id, category, count)
                           VALUES (%s, %s, %s)""",
                        (report_id, category, max(0, count)),
                    )
        materialized_from = _rematerialize_pending_report(
            report_id,
            payload_for_review,
            uploader_username,
            allow_confirmed_admin_edit=is_confirmed_admin_edit,
        )
        _invalidate_dashboard_cache_after_report_write("report_review_payload_update")
        return {"ok": True, "daily_report_id": report_id, "materialized_from_report_id": materialized_from}
    finally:
        conn.close()


def _table_exists_cur(cur, table_name: str) -> bool:
    cur.execute("SELECT to_regclass(%s)", (f"public.{table_name}",))
    row = cur.fetchone()
    return bool(row and row[0])


def _column_exists_cur(cur, table_name: str, column_name: str) -> bool:
    cur.execute(
        """
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = %s
            AND column_name = %s
        )
        """,
        (table_name, column_name),
    )
    row = cur.fetchone()
    return bool(row and row[0])


def _clear_report_review_tags(cur, report_id: str) -> None:
    tag = f"pending_admin_review:{report_id}"
    tables = [
        "daily_work_items",
        "material_movements",
        "report_equipment_units",
        "daily_work_item_segments",
        "material_movement_equipment_usage",
        "work_item_equipment_usage",
        "objects",
        "object_segments",
        "materials",
        "work_types",
        "object_types",
        "stockpiles",
        "stockpile_balance_snapshots",
        "temporary_road_status_segments",
    ]
    if _table_exists_cur(cur, "mainline_fill_status_segments"):
        tables.append("mainline_fill_status_segments")
    for table in tables:
        cur.execute(f"UPDATE {table} SET review_tag = NULL WHERE review_tag = %s", (tag,))


def _delete_pending_review_artifacts(cur, report_id: str) -> None:
    tag = f"pending_admin_review:{report_id}"

    # Pending reference rows are sometimes reused by several still-pending reports.
    # Delete only orphaned references here; otherwise deleting one report can break
    # another report that still points to the same temporary object/material/work type.
    cur.execute("DELETE FROM temporary_road_status_segments WHERE review_tag = %s", (tag,))
    if _table_exists_cur(cur, "mainline_fill_status_segments"):
        cur.execute("DELETE FROM mainline_fill_status_segments WHERE review_tag = %s", (tag,))
    cur.execute("DELETE FROM stockpile_balance_snapshots WHERE review_tag = %s", (tag,))
    cur.execute(
        """
        DELETE FROM stockpiles sp
        WHERE sp.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM stockpile_balance_snapshots s
            WHERE s.stockpile_id = sp.id
          )
        """,
        (tag,),
    )
    cur.execute(
        """
        DELETE FROM objects o
        WHERE o.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM daily_work_items dwi
            WHERE dwi.object_id = o.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM material_movements mm
            WHERE mm.from_object_id = o.id OR mm.to_object_id = o.id
          )
        """,
        (tag,),
    )
    cur.execute(
        """
        DELETE FROM object_segments os
        WHERE os.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM objects o
            WHERE o.id = os.object_id
          )
        """,
        (tag,),
    )
    cur.execute(
        """
        DELETE FROM materials m
        WHERE m.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM material_movements mm
            WHERE mm.material_id = m.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM stockpiles sp
            WHERE sp.material_id = m.id
          )
        """,
        (tag,),
    )
    cur.execute(
        """
        DELETE FROM work_types wt
        WHERE wt.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM daily_work_items dwi
            WHERE dwi.work_type_id = wt.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_work_items pwi
            WHERE pwi.work_type_id = wt.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM planned_work_items pwi
            WHERE pwi.work_type_id = wt.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM object_type_work_type_defaults otd
            WHERE otd.work_type_id = wt.id
          )
        """,
        (tag,),
    )
    cur.execute(
        """
        DELETE FROM object_types ot
        WHERE ot.review_tag = %s
          AND NOT EXISTS (
            SELECT 1 FROM objects o
            WHERE o.object_type_id = ot.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM constructives c
            WHERE c.object_type_id = ot.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM object_type_work_type_defaults otd
            WHERE otd.object_type_id = ot.id
          )
        """,
        (tag,),
    )


def _delete_report_child_rows(cur, report_id: str) -> None:
    """Delete report-owned fact rows in dependency order, keeping daily_reports."""
    cur.execute(
        """
        DELETE FROM material_movement_equipment_usage
        WHERE material_movement_id IN (
          SELECT id FROM material_movements WHERE daily_report_id = %s
        )
           OR report_equipment_unit_id IN (
          SELECT id FROM report_equipment_units WHERE daily_report_id = %s
        )
        """,
        (report_id, report_id),
    )
    cur.execute(
        """
        DELETE FROM work_item_equipment_usage
        WHERE daily_work_item_id IN (
          SELECT id FROM daily_work_items WHERE daily_report_id = %s
        )
           OR report_equipment_unit_id IN (
          SELECT id FROM report_equipment_units WHERE daily_report_id = %s
        )
        """,
        (report_id, report_id),
    )
    cur.execute(
        """
        DELETE FROM daily_work_item_segments
        WHERE daily_work_item_id IN (
          SELECT id FROM daily_work_items WHERE daily_report_id = %s
        )
        """,
        (report_id,),
    )
    if _column_exists_cur(cur, "temporary_road_status_segments", "daily_report_id"):
        cur.execute("DELETE FROM temporary_road_status_segments WHERE daily_report_id = %s", (report_id,))
    if _table_exists_cur(cur, "mainline_fill_status_segments"):
        cur.execute("DELETE FROM mainline_fill_status_segments WHERE daily_report_id = %s", (report_id,))
    cur.execute("DELETE FROM daily_report_staff_counts WHERE daily_report_id = %s", (report_id,))
    cur.execute("DELETE FROM daily_report_problems WHERE daily_report_id = %s", (report_id,))
    cur.execute("DELETE FROM material_movements WHERE daily_report_id = %s", (report_id,))
    cur.execute("DELETE FROM daily_work_items WHERE daily_report_id = %s", (report_id,))
    cur.execute("DELETE FROM report_equipment_units WHERE daily_report_id = %s", (report_id,))


def _retag_pending_review_artifacts(cur, source_report_id: str, target_report_id: str) -> None:
    source_tag = f"pending_admin_review:{source_report_id}"
    target_tag = f"pending_admin_review:{target_report_id}"
    for table in (
        "daily_work_items",
        "material_movements",
        "report_equipment_units",
        "daily_work_item_segments",
        "material_movement_equipment_usage",
        "work_item_equipment_usage",
        "objects",
        "object_segments",
        "materials",
        "work_types",
        "object_types",
        "stockpiles",
        "stockpile_balance_snapshots",
        "temporary_road_status_segments",
    ):
        cur.execute(f"UPDATE {table} SET review_tag = %s WHERE review_tag = %s", (target_tag, source_tag))
    if _table_exists_cur(cur, "mainline_fill_status_segments"):
        cur.execute("UPDATE mainline_fill_status_segments SET review_tag = %s WHERE review_tag = %s", (target_tag, source_tag))


def _move_report_child_rows(cur, source_report_id: str, target_report_id: str) -> None:
    for table in (
        "daily_report_staff_counts",
        "daily_report_problems",
        "report_equipment_units",
        "daily_work_items",
        "material_movements",
    ):
        cur.execute(f"UPDATE {table} SET daily_report_id = %s WHERE daily_report_id = %s", (target_report_id, source_report_id))
    if _column_exists_cur(cur, "temporary_road_status_segments", "daily_report_id"):
        cur.execute("UPDATE temporary_road_status_segments SET daily_report_id = %s WHERE daily_report_id = %s", (target_report_id, source_report_id))
    if _table_exists_cur(cur, "mainline_fill_status_segments"):
        cur.execute("UPDATE mainline_fill_status_segments SET daily_report_id = %s WHERE daily_report_id = %s", (target_report_id, source_report_id))


def _normalize_report_source_reference(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _normalize_report_source_type(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _report_import_payload_identity(payload_dict: dict[str, Any]) -> dict[str, Any]:
    identity = dict(payload_dict)
    identity.pop("import_summary", None)
    return identity


def _report_import_payload_identity_json(payload_identity: dict[str, Any]) -> str:
    return json.dumps(payload_identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _lock_report_import_business_key(
    cur,
    report_date: date_cls,
    shift: str,
    section_id: Optional[str],
    source_type: Optional[str],
    source_reference: Optional[str],
    payload_identity: dict[str, Any],
) -> str:
    normalized_source_reference = _normalize_report_source_reference(source_reference)
    normalized_source_type = _normalize_report_source_type(source_type)
    payload_hash = hashlib.sha256(_report_import_payload_identity_json(payload_identity).encode("utf-8")).hexdigest()
    key = "|".join(
        (
            report_date.isoformat(),
            shift,
            str(section_id or ""),
            normalized_source_type,
            normalized_source_reference.casefold(),
            payload_hash,
        )
    )
    cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (key,))
    return normalized_source_reference


def _find_existing_report_for_import(
    cur,
    report_date: date_cls,
    shift: str,
    section_id: Optional[str],
    normalized_source_type: str,
    normalized_source_reference: str,
    payload_identity: dict[str, Any],
    exclude_report_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    payload_identity_json = _report_import_payload_identity_json(payload_identity)
    cur.execute(
        """
        SELECT id::text, status, source_type, source_reference, created_at
        FROM daily_reports
        WHERE COALESCE(is_demo, false) = false
          AND report_date = %s
          AND shift = %s
          AND section_id IS NOT DISTINCT FROM %s::uuid
          AND regexp_replace(lower(btrim(COALESCE(source_type, ''))), '\\s+', ' ', 'g') = %s
          AND regexp_replace(lower(btrim(COALESCE(source_reference, ''))), '\\s+', ' ', 'g') = lower(%s)
          AND COALESCE(review_payload - 'import_summary', '{}'::jsonb) = %s::jsonb
          AND status IN ('pending_review', 'review', 'confirmed', 'approved')
          AND (%s::uuid IS NULL OR id <> %s::uuid)
        ORDER BY
          CASE WHEN status IN ('confirmed', 'approved') THEN 0 ELSE 1 END,
          created_at DESC,
          id
        LIMIT 1
        """,
        (
            report_date,
            shift,
            section_id,
            normalized_source_type,
            normalized_source_reference,
            payload_identity_json,
            exclude_report_id,
            exclude_report_id,
        ),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "status": row[1],
        "source_type": row[2],
        "source_reference": row[3],
        "created_at": row[4],
    }


def _rematerialize_pending_report(
    report_id: str,
    review_payload: dict[str, Any],
    uploader_username: Optional[str],
    *,
    allow_confirmed_admin_edit: bool = False,
) -> str:
    """Rebuild report-owned fact rows from review_payload while preserving report_id."""
    review_payload = _mark_existing_payload_reference_codes_manual(review_payload)
    uploader = type("ReportUploader", (), {"username": uploader_username})()
    created = _import_report_impl(ImportPayload(**review_payload), uploader, reuse_existing_pending=False)
    source_report_id = created["daily_report_id"]
    source_review_payload: Optional[Any] = None
    source_initial_parse_payload: Optional[Any] = None

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT review_payload, initial_parse_payload FROM daily_reports WHERE id = %s LIMIT 1",
                    (source_report_id,),
                )
                source_payload_row = cur.fetchone()
                if source_payload_row:
                    source_review_payload = source_payload_row[0]
                    source_initial_parse_payload = source_payload_row[1]
                    if isinstance(source_review_payload, str):
                        try:
                            source_review_payload = json.loads(source_review_payload)
                        except json.JSONDecodeError:
                            source_review_payload = None
                    if isinstance(source_review_payload, dict):
                        import_summary = source_review_payload.get("import_summary")
                        if isinstance(import_summary, dict):
                            import_summary["daily_report_id"] = report_id
                cur.execute("SELECT status FROM daily_reports WHERE id = %s LIMIT 1", (report_id,))
                row = cur.fetchone()
                if not row:
                    _delete_report_and_pending_review_artifacts(cur, source_report_id)
                    raise HTTPException(404, "Отчёт не найден")
                target_status = row[0]
                allowed_statuses = {"pending_review", "review"}
                if allow_confirmed_admin_edit:
                    allowed_statuses.update({"confirmed", "approved"})
                if target_status not in allowed_statuses:
                    _delete_report_and_pending_review_artifacts(cur, source_report_id)
                    raise HTTPException(400, "Редактировать подтвержденный отчёт может только администратор")
                _snapshot_report_review_payload(
                    cur,
                    report_id,
                    "rematerialize_target_before_replace",
                    uploader_username,
                )
                _delete_report_child_rows(cur, report_id)
                _delete_pending_review_artifacts(cur, report_id)
                _retag_pending_review_artifacts(cur, source_report_id, report_id)
                _move_report_child_rows(cur, source_report_id, report_id)
                if source_review_payload is not None:
                    cur.execute(
                        """
                        UPDATE daily_reports
                        SET review_payload = %s::jsonb,
                            initial_parse_payload = COALESCE(%s::jsonb, initial_parse_payload)
                        WHERE id = %s
                        """,
                        (
                            json.dumps(source_review_payload, ensure_ascii=False),
                            json.dumps(source_initial_parse_payload, ensure_ascii=False) if source_initial_parse_payload else None,
                            report_id,
                        ),
                    )
                cur.execute("DELETE FROM daily_reports WHERE id = %s", (source_report_id,))
                if target_status in ("confirmed", "approved"):
                    cur.execute(
                        """
                        UPDATE daily_reports
                        SET status = 'confirmed',
                            parse_status = 'approved',
                            operator_status = 'approved',
                            review_tag = NULL
                        WHERE id = %s
                        """,
                        (report_id,),
                    )
                    _clear_report_review_tags(cur, report_id)
        return source_report_id
    finally:
        conn.close()


def _delete_report_rows(cur, report_id: str) -> None:
    """Delete report-owned rows in dependency order."""
    _delete_report_child_rows(cur, report_id)
    cur.execute("DELETE FROM daily_reports WHERE id = %s", (report_id,))


def _delete_report_and_pending_review_artifacts(cur, report_id: str) -> None:
    # Pending reference rows can be FK targets for the report facts, so facts go first.
    _delete_report_rows(cur, report_id)
    _delete_pending_review_artifacts(cur, report_id)


@router.post("/{report_id}/confirm")
def confirm_report(report_id: str, _admin=Depends(require_admin)):
    """Admin confirmation: pending rows become visible to dashboards."""
    try:
        uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(400, "Невалидный id")
    _ensure_report_review_schema()
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT status, review_payload, initial_parse_payload, uploaded_by_username,
                           report_date, shift, section_id::text, source_type, source_reference
                    FROM daily_reports
                    WHERE id = %s
                    LIMIT 1
                    """,
                    (report_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(404, "Отчёт не найден")
                (
                    status,
                    review_payload,
                    initial_parse_payload,
                    uploaded_by_username,
                    stored_report_date,
                    stored_shift,
                    stored_section_id,
                    stored_source_type,
                    stored_source_reference,
                ) = row
                _report_quality_capture_day3_snapshot_for_report(
                    cur,
                    report_id,
                    captured_by="confirm_report",
                    actor_username=getattr(_admin, "username", None),
                )
                if status in ("pending_review", "review") and review_payload:
                    if isinstance(review_payload, str):
                        review_payload = json.loads(review_payload)
                    if not isinstance(review_payload, dict):
                        raise HTTPException(400, "У отчёта поврежден review_payload")
                    if initial_parse_payload and not review_payload.get("initial_parse"):
                        review_payload["initial_parse"] = initial_parse_payload
                    payload_header = review_payload.get("header") if isinstance(review_payload.get("header"), dict) else {}
                    try:
                        target_report_date = date_cls.fromisoformat(str(payload_header.get("report_date") or stored_report_date or ""))
                    except ValueError:
                        raise HTTPException(400, "У отчёта повреждена дата в review_payload")
                    target_shift = str(payload_header.get("shift") or stored_shift or "unknown")
                    if target_shift not in ("day", "night", "unknown"):
                        raise HTTPException(400, "У отчёта повреждена смена в review_payload")
                    target_section_id = stored_section_id
                    target_section_code = str(payload_header.get("section_code") or "").strip()
                    if target_section_code:
                        cur.execute(
                            "SELECT id::text FROM construction_sections WHERE code = %s LIMIT 1",
                            (target_section_code,),
                        )
                        section_row = cur.fetchone()
                        target_section_id = section_row[0] if section_row else None
                    target_source_type = review_payload.get("source_type") or stored_source_type or "web_upload"
                    target_source_reference = review_payload.get("source_reference") or stored_source_reference
                    payload_identity = _report_import_payload_identity(review_payload)
                    normalized_source_reference = _lock_report_import_business_key(
                        cur,
                        target_report_date,
                        target_shift,
                        target_section_id,
                        target_source_type,
                        target_source_reference,
                        payload_identity,
                    )
                    existing_report = _find_existing_report_for_import(
                        cur,
                        target_report_date,
                        target_shift,
                        target_section_id,
                        _normalize_report_source_type(target_source_type),
                        normalized_source_reference,
                        payload_identity,
                        exclude_report_id=report_id,
                    )
                    if existing_report:
                        raise HTTPException(
                            409,
                            "Нельзя подтвердить отчёт: уже есть другой активный отчёт с этой датой/сменой/участком, "
                            f"типом, источником и таким же содержанием (id={existing_report['id']}, status={existing_report['status']}). "
                            "Сначала объедините или удалите дубль, чтобы не размножить факты.",
                        )
                    review_payload = _overlay_payload_with_report_db_facts(report_id, review_payload)
                    review_payload = _mark_existing_payload_reference_codes_manual(review_payload)
                    # Materialize the confirmed report from the latest edited payload.
                    # The old pending report is then removed with its stale child rows.
                    uploader = type("ReportUploader", (), {"username": uploaded_by_username})()
                    created = _import_report_impl(ImportPayload(**review_payload), uploader, reuse_existing_pending=False)
                    new_report_id = created["daily_report_id"]
                    cur.execute(
                        """
                        UPDATE daily_reports
                        SET status = 'confirmed',
                            parse_status = 'approved',
                            operator_status = 'approved',
                            review_tag = NULL
                        WHERE id = %s
                        """,
                        (new_report_id,),
                    )
                    _clear_report_review_tags(cur, new_report_id)
                    _snapshot_report_review_payload(
                        cur,
                        report_id,
                        "confirm_before_materialize_delete",
                        getattr(_admin, "username", None),
                    )
                    _delete_report_and_pending_review_artifacts(cur, report_id)
                    _invalidate_dashboard_cache_after_report_write("report_confirm_materialized")
                    return {"ok": True, "daily_report_id": new_report_id, "status": "confirmed"}
                cur.execute(
                    """
                    UPDATE daily_reports
                    SET status = 'confirmed',
                        parse_status = 'approved',
                        operator_status = 'approved',
                        review_tag = NULL
                    WHERE id = %s
                    """,
                    (report_id,),
                )
                _clear_report_review_tags(cur, report_id)
        _invalidate_dashboard_cache_after_report_write("report_confirm")
        return {"ok": True, "daily_report_id": report_id, "status": "confirmed"}
    finally:
        conn.close()


@router.delete("/{report_id}")
def delete_pending_report(report_id: str, _user=Depends(current_user)):
    """Delete a report and dependent rows with admin/owner review-state permissions."""
    try:
        uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(400, "Невалидный id")
    _ensure_report_review_schema()
    current_username = getattr(_user, "username", None)
    is_admin = getattr(_user, "role", None) == "admin"
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, status, uploaded_by_username
                    FROM daily_reports
                    WHERE id = %s
                    LIMIT 1
                    """,
                    (report_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(404, "Отчёт не найден")
                status = row[1]
                uploaded_by_username = row[2]
                is_owner = bool(uploaded_by_username and current_username and uploaded_by_username == current_username)
                admin_allowed = is_admin and status in ("pending_review", "review", "confirmed", "approved")
                owner_allowed = is_owner and status in ("pending_review", "review")
                if not admin_allowed and not owner_allowed:
                    raise HTTPException(403, "Удалить отчёт может автор до подтверждения или администратор")
                _report_quality_capture_day3_snapshot_for_report(
                    cur,
                    report_id,
                    captured_by="report_delete",
                    actor_username=current_username,
                )
                _snapshot_report_review_payload(
                    cur,
                    report_id,
                    "report_delete",
                    current_username,
                )
                _delete_report_and_pending_review_artifacts(cur, report_id)
        _invalidate_dashboard_cache_after_report_write("report_delete")
        return {"ok": True, "daily_report_id": report_id, "status": status, "deleted": True}
    finally:
        conn.close()


@router.post("/import")
def import_report(payload: ImportPayload, _user=Depends(current_user)):
    return _import_report_impl(payload, _user, reuse_existing_pending=True)


def _import_report_impl(payload: ImportPayload, _user, *, reuse_existing_pending: bool) -> dict[str, Any]:
    """
    Сохраняет подтверждённый оператором отчёт в БД.

    Сохраняет подтвержденную оператором структуру в daily_reports и связанные
    таблицы: daily_work_items, material_movements, report_equipment_units и
    служебные строки проверки. Пустые блоки допустимы для ручного черновика.
    """
    try:
        report_date = date_cls.fromisoformat(payload.header.report_date)
    except ValueError:
        raise HTTPException(400, "header.report_date должен быть YYYY-MM-DD")

    shift = payload.header.shift or "unknown"
    if shift not in ("day", "night", "unknown"):
        raise HTTPException(400, "header.shift должен быть day|night|unknown")
    _normalize_import_payload_numbers(payload)
    _enrich_payload_ad_rail_from_temp_roads(payload)
    _assert_import_pk_validation(payload)
    _ensure_report_review_schema()
    sanitized_raw_text = sanitize_personal_report_text(payload.raw_text or "") if payload.raw_text else None
    payload_for_review = payload.dict() if hasattr(payload, "dict") else payload.model_dump()
    if sanitized_raw_text is not None:
        payload_for_review["raw_text"] = sanitized_raw_text
    _normalize_payload_equipment_identifiers(payload_for_review)
    payload_for_review = _normalize_regular_work_equipment_cardinality(payload_for_review)
    payload_for_review = _sync_single_work_equipment_usage_volumes(payload_for_review)
    _validate_payload_equipment_work_hours(payload_for_review)
    payload.main_works = payload_for_review.get("main_works") or []
    payload.aux_works = payload_for_review.get("aux_works") or []
    payload_for_review = _mark_existing_payload_reference_codes_manual(payload_for_review)
    payload_for_review = _refresh_payload_reference_metadata(payload_for_review)
    payload_for_review = _ensure_review_flags(payload_for_review, payload.source_type)
    initial_parse = payload.initial_parse
    source_type = payload.source_type or "web_upload"
    normalized_source_type = _normalize_report_source_type(source_type)
    payload_identity = _report_import_payload_identity(payload_for_review)
    uploader_username = _web_uploaded_by_username(source_type, getattr(_user, "username", None))

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                # Resolve section_id from code
                section_id: Optional[str] = None
                if payload.header.section_code:
                    cur.execute(
                        "SELECT id FROM construction_sections WHERE code = %s LIMIT 1",
                        (payload.header.section_code,),
                    )
                    row = cur.fetchone()
                    if row:
                        section_id = row[0]

                report_id = str(uuid.uuid4())
                reused_existing_report_id: Optional[str] = None
                pending_tag = f"pending_admin_review:{report_id}"
                normalized_source_reference = ""
                if reuse_existing_pending:
                    normalized_source_reference = _lock_report_import_business_key(
                        cur,
                        report_date,
                        shift,
                        section_id,
                        source_type,
                        payload.source_reference,
                        payload_identity,
                    )
                    existing_report = _find_existing_report_for_import(
                        cur,
                        report_date,
                        shift,
                        section_id,
                        normalized_source_type,
                        normalized_source_reference,
                        payload_identity,
                    )
                    if existing_report and existing_report["status"] in ("confirmed", "approved"):
                        raise HTTPException(
                            409,
                            "Отчёт за эту дату/смену/участок, тип, источник и содержимое уже подтверждён "
                            f"(id={existing_report['id']}). Новый импорт не создан, чтобы не продублировать факты; "
                            "откройте существующий отчёт и внесите правку через редактирование.",
                        )
                    if existing_report:
                        report_id = existing_report["id"]
                        reused_existing_report_id = report_id
                        pending_tag = f"pending_admin_review:{report_id}"
                        _report_quality_capture_day3_snapshot_for_report(
                            cur,
                            report_id,
                            captured_by="import_reuse_existing_pending",
                            actor_username=getattr(_user, "username", None),
                        )
                        _snapshot_report_review_payload(
                            cur,
                            report_id,
                            "import_reuse_existing_pending",
                            getattr(_user, "username", None),
                        )
                        _delete_report_child_rows(cur, report_id)
                        _delete_pending_review_artifacts(cur, report_id)
                        cur.execute(
                            """
                            UPDATE daily_reports
                            SET report_date = %s,
                                shift = %s,
                                section_id = %s,
                                source_type = %s,
                                source_reference = %s,
                                uploaded_by_username = COALESCE(uploaded_by_username, %s),
                                raw_text = COALESCE(%s, raw_text),
                                parse_status = 'parsed',
                                operator_status = 'pending',
                                status = 'pending_review',
                                review_tag = %s,
                                review_payload = %s::jsonb,
                                initial_parse_payload = %s::jsonb
                            WHERE id = %s
                            """,
                            (
                                report_date,
                                shift,
                                section_id,
                                source_type,
                                payload.source_reference,
                                uploader_username,
                                sanitized_raw_text,
                                pending_tag,
                                json.dumps(payload_for_review, ensure_ascii=False),
                                json.dumps(initial_parse, ensure_ascii=False) if initial_parse else None,
                                report_id,
                            ),
                        )
                    else:
                        cur.execute(
                            """
                            INSERT INTO daily_reports
                                (id, report_date, shift, section_id, source_type,
                                 source_reference, uploaded_by_username, raw_text, parse_status, operator_status, status,
                                 review_tag, review_payload, initial_parse_payload)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                            """,
                            (
                                report_id,
                                report_date,
                                shift,
                                section_id,
                                source_type,
                                payload.source_reference,
                                uploader_username,
                                sanitized_raw_text,
                                "parsed",
                                "pending",
                                "pending_review",
                                pending_tag,
                                json.dumps(payload_for_review, ensure_ascii=False),
                                json.dumps(initial_parse, ensure_ascii=False) if initial_parse else None,
                            ),
                        )
                else:
                    cur.execute(
                        """
                        INSERT INTO daily_reports
                            (id, report_date, shift, section_id, source_type,
                             source_reference, uploaded_by_username, raw_text, parse_status, operator_status, status,
                             review_tag, review_payload, initial_parse_payload)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                        """,
                        (
                            report_id,
                            report_date,
                            shift,
                            section_id,
                            source_type,
                            payload.source_reference,
                            uploader_username,
                            sanitized_raw_text,
                            "parsed",
                            "pending",
                            "pending_review",
                            pending_tag,
                            json.dumps(payload_for_review, ensure_ascii=False),
                            json.dumps(initial_parse, ensure_ascii=False) if initial_parse else None,
                            ),
                        )
                _report_quality_capture_uploaded_snapshot(
                    cur,
                    report_id,
                    uploaded_payload=initial_parse or payload_for_review,
                    captured_by="report_import",
                    actor_username=getattr(_user, "username", None),
                )
                _store_parser_learning_cases(
                    cur,
                    report_id,
                    initial_parse=initial_parse,
                    final_payload=payload_for_review,
                    report_date=report_date,
                    shift=shift,
                    section_code=payload.header.section_code,
                    source_reference=payload.source_reference,
                )

                n_staff_counts = 0
                for row in payload.staff_counts or []:
                    category = (row.get("category") or "").strip()
                    if not category:
                        continue
                    try:
                        count = int(float(row.get("count") or 0))
                    except (TypeError, ValueError):
                        count = 0
                    if count < 0:
                        count = 0
                    cur.execute(
                        """INSERT INTO daily_report_staff_counts
                           (daily_report_id, category, count)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (daily_report_id, category) DO UPDATE
                           SET count = EXCLUDED.count""",
                        (report_id, category, count),
                    )
                    n_staff_counts += 1

                # ── Lookup helpers ─────────────────────────────────────
                def _find_work_type_meta(code: Optional[str]) -> Optional[dict[str, Any]]:
                    if not code:
                        return None
                    cur.execute(
                        """
                        SELECT id, default_unit, analytics_tag
                        FROM work_types
                        WHERE code = %s
                        LIMIT 1
                        """,
                        (code,),
                    )
                    r = cur.fetchone()
                    if not r:
                        return None
                    return {"id": r[0], "default_unit": r[1], "analytics_tag": r[2]}

                def _find_work_type_id(code: Optional[str]) -> Optional[str]:
                    meta = _find_work_type_meta(code)
                    return meta["id"] if meta else None

                def _find_material_id(code: Optional[str]) -> Optional[str]:
                    if not code:
                        return None
                    cur.execute("SELECT id FROM materials WHERE code = %s LIMIT 1", (code,))
                    r = cur.fetchone()
                    return r[0] if r else None

                def _pending_material_code(raw_material: Any) -> str:
                    normalized = _normalize_ref(raw_material) or "unknown"
                    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12].upper()
                    return f"MAT_REVIEW_{digest}"[:50]

                def _ensure_pending_material(raw_material: Any, unit: Any = None) -> tuple[Optional[str], Optional[str]]:
                    name = re.sub(r"\s+", " ", str(raw_material or "").replace("\xa0", " ")).strip().strip("/")
                    if not name:
                        return None, None
                    cur.execute(
                        """
                        SELECT id, code
                        FROM materials
                        WHERE lower(name) = lower(%s)
                        ORDER BY CASE WHEN review_tag IS NULL THEN 0 ELSE 1 END, created_at
                        LIMIT 1
                        """,
                        (name,),
                    )
                    found = cur.fetchone()
                    if found:
                        return found[0], found[1]
                    code = _pending_material_code(name)
                    cur.execute(
                        """
                        INSERT INTO materials (id, code, name, default_unit, review_tag)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (code) DO UPDATE
                        SET name = EXCLUDED.name,
                            default_unit = EXCLUDED.default_unit,
                            review_tag = COALESCE(materials.review_tag, EXCLUDED.review_tag)
                        RETURNING id, code
                        """,
                        (
                            str(uuid.uuid4()),
                            code,
                            name[:255],
                            str(unit or "м3")[:50] or "м3",
                            pending_tag,
                        ),
                    )
                    row = cur.fetchone()
                    return (row[0], row[1]) if row else (None, None)

                def _find_object_id(name_or_code: Optional[str]) -> Optional[str]:
                    if not name_or_code:
                        return None
                    cur.execute("SELECT id FROM objects WHERE is_active IS TRUE AND name = %s LIMIT 1", (name_or_code,))
                    r = cur.fetchone()
                    if r:
                        return r[0]
                    cur.execute("SELECT id FROM objects WHERE is_active IS TRUE AND object_code = %s LIMIT 1", (name_or_code,))
                    r = cur.fetchone()
                    if r:
                        return r[0]
                    quarry_key = _quarry_ref_key(name_or_code)
                    if quarry_key:
                        cur.execute(
                            """
                            SELECT o.id, o.name, o.object_code
                            FROM objects o
                            JOIN object_types ot ON ot.id = o.object_type_id
                            WHERE o.is_active IS TRUE
                              AND ot.code = 'BORROW_PIT'
                            """
                        )
                        for object_id, object_name, object_code in cur.fetchall():
                            if quarry_key in {_quarry_ref_key(object_name), _quarry_ref_key(object_code)}:
                                return object_id
                    return None

                def _find_object_code(object_id: Optional[str]) -> Optional[str]:
                    if not object_id:
                        return None
                    cur.execute("SELECT object_code FROM objects WHERE id = %s LIMIT 1", (object_id,))
                    r = cur.fetchone()
                    return r[0] if r else None

                def _find_main_track_object_id(section_id_value: Optional[str], pk_start: Any = None, pk_end: Any = None) -> Optional[str]:
                    mid = _main_track_mid_pk(pk_start, pk_end)

                    if mid is not None:
                        cur.execute(
                            """
                            SELECT cs.code
                            FROM construction_section_versions csv
                            JOIN construction_sections cs ON cs.id = csv.section_id
                            WHERE csv.is_current
                              AND csv.boundary_kind = 'main'
                              AND %s >= LEAST(csv.pk_start, csv.pk_end)
                              AND %s < GREATEST(csv.pk_start, csv.pk_end)
                              AND cs.is_active IS NOT FALSE
                            ORDER BY csv.pk_start, csv.pk_end
                            LIMIT 1
                            """,
                            (mid, mid),
                        )
                        r = cur.fetchone()
                        target_code = _main_track_object_code_for_section(r[0] if r else None, mid)
                        if target_code:
                            object_id = _find_object_id(target_code)
                            if object_id:
                                return object_id

                    if not section_id_value:
                        return None
                    cur.execute("SELECT code FROM construction_sections WHERE id = %s LIMIT 1", (section_id_value,))
                    r = cur.fetchone()
                    if not r:
                        return None
                    target_code = _main_track_object_code_for_section(r[0], mid)
                    if not target_code:
                        return None
                    return _find_object_id(target_code)

                def _is_main_track_object_hint(value: Optional[str]) -> bool:
                    text = _normalize_ref(value)
                    compact = _compact_ref(value)
                    return bool(
                        compact in {"mainohstage3", "maintrack", "main"}
                        or text in {"ох", "основной ход"}
                        or "земляное полотно ох" in text
                        or "основной ход" in text
                    )

                def _object_type_code(object_id: Optional[str]) -> Optional[str]:
                    if not object_id:
                        return None
                    cur.execute(
                        """
                        SELECT ot.code
                        FROM objects o
                        JOIN object_types ot ON ot.id = o.object_type_id
                        WHERE o.id = %s
                        LIMIT 1
                        """,
                        (object_id,),
                    )
                    r = cur.fetchone()
                    return r[0] if r else None

                def _classify_movement(from_id: Optional[str], to_id: Optional[str]) -> str:
                    from_type = _object_type_code(from_id)
                    to_type = _object_type_code(to_id)
                    return classify_material_movement_type(from_type, to_type)

                def _default_haul_distance_km(from_id: Optional[str]) -> tuple[Optional[float], Optional[str]]:
                    if not from_id or not payload.header.section_code:
                        return None, None
                    cur.execute(
                        """
                        SELECT distance_km
                        FROM section_quarry_haul_distances
                        WHERE section_code = %s
                          AND quarry_object_id = %s
                        LIMIT 1
                        """,
                        (payload.header.section_code, from_id),
                    )
                    row = cur.fetchone()
                    if not row or row[0] is None:
                        return None, None
                    return float(row[0]), "section_quarry_default"

                def _find_constructive_id(code_or_name: Optional[str]) -> Optional[str]:
                    if not code_or_name:
                        return None
                    cur.execute("SELECT id FROM constructives WHERE code = %s LIMIT 1", (code_or_name,))
                    r = cur.fetchone()
                    if r:
                        return r[0]
                    cur.execute("SELECT id FROM constructives WHERE name = %s LIMIT 1", (code_or_name,))
                    r = cur.fetchone()
                    return r[0] if r else None

                def _learn_alias(kind: str, alias_text: Optional[str], canonical_code: Optional[str]) -> None:
                    alias = (alias_text or "").strip()
                    canonical = (canonical_code or "").strip()
                    if not alias or not canonical:
                        return
                    cur.execute(
                        """INSERT INTO work_type_aliases (canonical_code, alias_text, kind, notes)
                           VALUES (%s, %s, %s, 'learned_from_confirmed_report_import')
                           ON CONFLICT DO NOTHING""",
                        (canonical, alias, kind),
                    )

                def _get_object_type_id(code: str) -> Optional[str]:
                    cur.execute("SELECT id FROM object_types WHERE code = %s LIMIT 1", (code,))
                    r = cur.fetchone()
                    return r[0] if r else None

                def _find_stockpile_by_pk_material(pk_start: Any, material_code: Optional[str]) -> tuple[Optional[str], Optional[str]]:
                    if pk_start is None:
                        return None, None
                    try:
                        pk_value = float(pk_start)
                    except (TypeError, ValueError):
                        return None, None
                    cur.execute(
                        """
                        SELECT s.id, o.id
                        FROM objects o
                        JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'STOCKPILE'
                        LEFT JOIN object_segments os ON os.object_id = o.id
                        LEFT JOIN stockpiles s ON s.object_id = o.id
                        LEFT JOIN materials m ON m.id = s.material_id
                        WHERE os.pk_start IS NOT NULL
                          AND ABS(os.pk_start - %s::numeric) <= 0.01
                          AND (%s IS NULL OR m.code = %s OR s.material_id IS NULL)
                        ORDER BY
                          CASE
                            WHEN s.id IS NOT NULL AND m.code = %s THEN 0
                            WHEN s.id IS NOT NULL THEN 1
                            ELSE 2
                          END,
                          o.created_at
                        LIMIT 1
                        """,
                        (pk_value, material_code, material_code, material_code),
                    )
                    r = cur.fetchone()
                    return (r[0], r[1]) if r else (None, None)

                def _stockpile_spec_from_endpoint(label: Any, material_code: Optional[str]) -> Optional[dict[str, Any]]:
                    text = str(label or "").strip()
                    if not text or not material_code:
                        return None
                    normalized = text.lower().replace("ё", "е")
                    # Only stockpile-like labels may create stockpile objects. A road/object
                    # range such as `АД12 ПК3111+50-ПК3112+60` must stay a constructive
                    # endpoint for manual review, not become a stockpile by accident.
                    if "накопител" not in normalized:
                        return None
                    values = _strict_pk_values(text)
                    if len(values) != 1:
                        return None
                    pk_value = values[0]
                    rounded = int(round(float(pk_value) / 100.0))
                    name = _stockpile_canonical_name(material_code, pk_value, material_code)
                    return {
                        "name": name,
                        "material": _stockpile_material_label(material_code),
                        "material_code": material_code,
                        "pk_raw_text": _format_pk_db(pk_value),
                        "pk_start": pk_value,
                        "pk_end": pk_value,
                        "rounded_pk": rounded,
                        "proposed_object_code": f"STOCK_AUTO_{rounded}_{material_code}"[:100],
                        "proposed_object_name": name,
                    }

                def _ensure_stockpile(sp: dict[str, Any]) -> Optional[str]:
                    existing_stockpile_id = _clean_identifier(sp.get("existing_stockpile_id"))
                    if existing_stockpile_id:
                        try:
                            uuid.UUID(existing_stockpile_id)
                        except ValueError:
                            existing_stockpile_id = None
                    if existing_stockpile_id:
                        cur.execute("SELECT id FROM stockpiles WHERE id = %s LIMIT 1", (existing_stockpile_id,))
                        found_existing = cur.fetchone()
                        if found_existing:
                            return found_existing[0]
                    material_id = _find_material_id(sp.get("material_code"))
                    existing_object_id = _clean_identifier(sp.get("existing_object_id")) or existing_stockpile_id
                    if existing_object_id:
                        try:
                            uuid.UUID(existing_object_id)
                        except ValueError:
                            existing_object_id = None
                    if existing_object_id and material_id:
                        cur.execute(
                            """
                            SELECT o.id, o.name
                            FROM objects o
                            JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'STOCKPILE'
                            WHERE o.id = %s
                              AND COALESCE(o.is_active, true) IS NOT FALSE
                            LIMIT 1
                            """,
                            (existing_object_id,),
                        )
                        object_row = cur.fetchone()
                        if object_row:
                            stockpile_id = str(uuid.uuid4())
                            object_id = object_row[0]
                            object_name = (sp.get("name") or object_row[1] or "Накопитель")[:255]
                            cur.execute(
                                """INSERT INTO stockpiles (id, object_id, material_id, name, is_active, review_tag)
                                   VALUES (%s, %s, %s, %s, true, %s)
                                   ON CONFLICT (object_id) DO UPDATE
                                   SET material_id = EXCLUDED.material_id,
                                       name = EXCLUDED.name,
                                       is_active = true
                                   RETURNING id, object_id""",
                                (stockpile_id, object_id, material_id, object_name, pending_tag),
                            )
                            created_or_existing = cur.fetchone()
                            if created_or_existing:
                                sp["existing_stockpile_id"] = str(created_or_existing[0])
                                sp["existing_object_id"] = str(created_or_existing[1])
                                return created_or_existing[0]
                    rounded_pk = sp.get("rounded_pk")
                    pk_start = sp.get("pk_start")
                    if rounded_pk is None and pk_start is not None:
                        try:
                            rounded_pk = int(round(float(pk_start) / 100.0))
                            sp["rounded_pk"] = rounded_pk
                        except (TypeError, ValueError):
                            rounded_pk = None
                    if not material_id or rounded_pk is None or pk_start is None:
                        return None
                    found_stockpile_id, found_object_id = _find_stockpile_by_pk_material(pk_start, sp.get("material_code"))
                    if found_stockpile_id:
                        sp["existing_stockpile_id"] = str(found_stockpile_id)
                        if found_object_id:
                            sp["existing_object_id"] = str(found_object_id)
                        return found_stockpile_id

                    object_id = found_object_id or str(uuid.uuid4())
                    stockpile_id = str(uuid.uuid4())
                    object_code = (sp.get("proposed_object_code") or f"STOCK_AUTO_{rounded_pk}_{sp.get('material_code') or 'MAT'}")[:100]
                    object_name = _stockpile_canonical_name(sp.get("material_code"), pk_start, sp.get("material"))[:255]
                    if not found_object_id:
                        object_type_id = _get_object_type_id("STOCKPILE")
                        if not object_type_id:
                            return None
                        cur.execute(
                            """INSERT INTO objects
                               (id, object_code, name, object_type_id, constructive_id, is_active, comment, review_tag)
                               VALUES (%s, %s, %s, %s, NULL, true, %s, %s)
                               ON CONFLICT (object_code) DO NOTHING""",
                            (object_id, object_code, object_name, object_type_id, "auto-created from pending-review stockpile rule", pending_tag),
                        )
                        cur.execute("SELECT id FROM objects WHERE object_code = %s LIMIT 1", (object_code,))
                        r_obj = cur.fetchone()
                        object_id = r_obj[0] if r_obj else object_id
                    cur.execute("SELECT 1 FROM object_segments WHERE object_id = %s LIMIT 1", (object_id,))
                    if not cur.fetchone():
                        cur.execute(
                            """INSERT INTO object_segments
                               (id, object_id, pk_start, pk_end, pk_raw_text, comment, review_tag)
                               VALUES (%s, %s, %s, %s, %s, %s, %s)
                               ON CONFLICT DO NOTHING""",
                            (
                                str(uuid.uuid4()),
                                object_id,
                                pk_start,
                                sp.get("pk_end") or pk_start,
                                sp.get("pk_raw_text") or _format_pk_db(pk_start),
                                "auto-created from pending-review stockpile rule",
                                pending_tag,
                            ),
                        )
                    cur.execute(
                        """INSERT INTO stockpiles (id, object_id, material_id, name, is_active, review_tag)
                           VALUES (%s, %s, %s, %s, true, %s)
                           ON CONFLICT (object_id) DO UPDATE
                           SET material_id = EXCLUDED.material_id,
                               name = EXCLUDED.name
                           RETURNING id""",
                        (stockpile_id, object_id, material_id, object_name, pending_tag),
                    )
                    r_stock = cur.fetchone()
                    return r_stock[0] if r_stock else stockpile_id

                def _ensure_stockpile_object_from_endpoint(label: Any, material_code: Optional[str]) -> Optional[str]:
                    spec = _stockpile_spec_from_endpoint(label, material_code)
                    if not spec:
                        return None
                    stockpile_id = _ensure_stockpile(spec)
                    if not stockpile_id:
                        return None
                    cur.execute("SELECT object_id FROM stockpiles WHERE id = %s LIMIT 1", (stockpile_id,))
                    row = cur.fetchone()
                    return row[0] if row else None

                def _find_section_misc_object_id(section_code: Optional[str]) -> Optional[str]:
                    num = _section_number_from_code(section_code)
                    if num is not None:
                        cur.execute("SELECT id FROM objects WHERE object_code = %s LIMIT 1", (f"STUFF_{num}",))
                        r = cur.fetchone()
                        if r:
                            return r[0]
                    cur.execute(
                        """
                        SELECT o.id
                        FROM objects o
                        JOIN object_types ot ON ot.id = o.object_type_id
                        WHERE ot.code = 'OTHER'
                        ORDER BY o.created_at
                        LIMIT 1
                        """
                    )
                    r = cur.fetchone()
                    return r[0] if r else None

                def _pipe_target_from_row(found) -> dict[str, Any]:
                    return {
                        "target_type": "pipe",
                        "id": f"pipe:{found[0]}",
                        "pipe_pile_spec_id": found[0],
                        "field_code": found[3] or found[2],
                        "field_type": "test" if found[8] == "PILE_TRIAL" else "main",
                        "pile_type": found[4],
                        "pk_start": found[5],
                        "pk_end": found[6],
                        "pk_raw_text": found[7],
                        "object_id": found[1],
                        "object_code": found[2],
                        "object_name": found[3],
                        "work_type_code": found[8],
                        "pile_field_id": None,
                    }

                def _find_pipe_pile_target(row: dict[str, Any]) -> Optional[dict[str, Any]]:
                    if not _table_exists_cur(cur, "pipe_pile_specs"):
                        return None
                    field_id = str(row.get("field_id") or "").strip()
                    raw_pipe_id = ""
                    if field_id.startswith("pipe:"):
                        raw_pipe_id = field_id.split(":", 1)[1]
                    elif str(row.get("target_type") or "").strip().lower() == "pipe":
                        raw_pipe_id = str(row.get("pipe_pile_spec_id") or row.get("id") or "").replace("pipe:", "").strip()
                    desired_code = _pile_row_work_type_code(row)
                    pk_hint = row.get("pk_start")
                    label = str(row.get("object_code") or row.get("field_code") or row.get("pk_text") or "").strip()
                    base_select = """
                        SELECT pps.id::text,
                               o.id::text AS object_id,
                               o.object_code,
                               o.name AS object_name,
                               ('L=' || trim(to_char(pps.pile_length_m, 'FM999999990.##')) || ' м') AS pile_type,
                               os.pk_start,
                               os.pk_end,
                               os.pk_raw_text,
                               wt.code AS work_type_code
                        FROM pipe_pile_specs pps
                        JOIN objects o ON o.id = pps.object_id
                        JOIN object_types ot ON ot.id = o.object_type_id AND ot.code = 'PIPE'
                        JOIN work_types wt ON wt.id = pps.work_type_id
                        LEFT JOIN LATERAL (
                          SELECT pk_start, pk_end, pk_raw_text
                          FROM object_segments os
                          WHERE os.object_id = o.id
                          ORDER BY os.pk_start NULLS LAST
                          LIMIT 1
                        ) os ON true
                        WHERE pps.is_active IS TRUE
                          AND o.is_active IS NOT FALSE
                          AND wt.code IN ('PILE_MAIN', 'PILE_TRIAL')
                    """
                    if raw_pipe_id:
                        cur.execute(base_select + " AND pps.id = %s::uuid LIMIT 1", (raw_pipe_id,))
                    elif label:
                        cur.execute(
                            base_select + """
                              AND (
                                o.object_code = %s
                                OR o.name = %s
                                OR o.name ILIKE %s
                                OR o.object_code ILIKE %s
                              )
                            ORDER BY
                              CASE WHEN wt.code = %s THEN 0 ELSE 1 END,
                              CASE WHEN %s IS NOT NULL AND os.pk_start IS NOT NULL AND %s BETWEEN LEAST(os.pk_start, os.pk_end) AND GREATEST(os.pk_start, os.pk_end) THEN 0 ELSE 1 END,
                              CASE WHEN %s IS NOT NULL AND os.pk_start IS NOT NULL THEN ABS(((os.pk_start + COALESCE(os.pk_end, os.pk_start)) / 2.0) - %s) ELSE 0 END,
                              o.object_code, wt.code
                            LIMIT 1
                            """,
                            (label, label, f"%{label}%", f"%{label}%", desired_code, pk_hint, pk_hint, pk_hint, pk_hint),
                        )
                    elif pk_hint is not None:
                        cur.execute(
                            base_select + """
                              AND os.pk_start IS NOT NULL
                              AND %s BETWEEN LEAST(os.pk_start, os.pk_end) AND GREATEST(os.pk_start, os.pk_end)
                            ORDER BY
                              CASE WHEN wt.code = %s THEN 0 ELSE 1 END,
                              ABS(((os.pk_start + COALESCE(os.pk_end, os.pk_start)) / 2.0) - %s),
                              o.object_code, wt.code
                            LIMIT 1
                            """,
                            (pk_hint, desired_code, pk_hint),
                        )
                    else:
                        return None
                    found = cur.fetchone()
                    return _pipe_target_from_row(found) if found else None

                def _find_pile_field(row: dict[str, Any]) -> Optional[dict[str, Any]]:
                    desired_field_type = _desired_pile_field_type(row)
                    pk_hint = row.get("pk_start")
                    field_id = str(row.get("field_id") or "").strip()
                    if field_id.startswith("pipe:") or str(row.get("target_type") or "").strip().lower() == "pipe":
                        return _find_pipe_pile_target(row)
                    if row.get("field_id"):
                        cur.execute(
                            """SELECT id::text, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text, object_id::text
                               FROM pile_fields WHERE id = %s LIMIT 1""",
                            (row.get("field_id"),),
                        )
                    elif row.get("field_code"):
                        cur.execute(
                            """SELECT id::text, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text, object_id::text
                               FROM pile_fields
                               WHERE COALESCE(is_demo, false) = false
                                 AND field_code = %s
                               ORDER BY
                                 CASE WHEN %s IS NOT NULL AND field_type = %s THEN 0 ELSE 1 END,
                                 CASE WHEN %s IS NOT NULL AND %s BETWEEN LEAST(pk_start, pk_end) AND GREATEST(pk_start, pk_end) THEN 0 ELSE 1 END,
                                 CASE WHEN %s IS NOT NULL THEN ABS(((pk_start + pk_end) / 2.0) - %s) ELSE 0 END,
                                 CASE field_type WHEN 'main' THEN 0 ELSE 1 END,
                                 pk_start NULLS LAST
                               LIMIT 1""",
                            (row.get("field_code"), desired_field_type, desired_field_type, pk_hint, pk_hint, pk_hint, pk_hint),
                        )
                    elif pk_hint is not None:
                        cur.execute(
                            """SELECT id::text, field_code, field_type, pile_type, pk_start, pk_end, pk_raw_text, object_id::text
                               FROM pile_fields
                               WHERE COALESCE(is_demo, false) = false
                                 AND %s BETWEEN LEAST(pk_start, pk_end) AND GREATEST(pk_start, pk_end)
                               ORDER BY
                                 CASE WHEN %s IS NOT NULL AND field_type = %s THEN 0 ELSE 1 END,
                                 ABS(((pk_start + pk_end) / 2.0) - %s),
                                 CASE field_type WHEN 'main' THEN 0 ELSE 1 END
                               LIMIT 1""",
                            (pk_hint, desired_field_type, desired_field_type, pk_hint),
                        )
                    else:
                        return None
                    found = cur.fetchone()
                    if not found:
                        return _find_pipe_pile_target(row)
                    return {
                        "target_type": "pile_field",
                        "id": found[0],
                        "pile_field_id": found[0],
                        "field_code": found[1],
                        "field_type": found[2],
                        "pile_type": found[3],
                        "pk_start": found[4],
                        "pk_end": found[5],
                        "pk_raw_text": found[6],
                        "object_id": found[7],
                        "work_type_code": None,
                    }

                def _find_temp_road(row: dict[str, Any]) -> Optional[dict[str, Any]]:
                    road_id = _clean_identifier(row.get("road_id") or row.get("id"))
                    road_code = (row.get("road_code") or row.get("road") or "").strip()
                    road_name = (row.get("road_name") or "").strip()
                    if road_id:
                        cur.execute(
                            """SELECT id::text, road_code, road_name, object_id::text
                               FROM temporary_roads
                               WHERE id = %s
                               LIMIT 1""",
                            (road_id,),
                        )
                    elif road_code:
                        cur.execute(
                            """SELECT id::text, road_code, road_name, object_id::text
                               FROM temporary_roads
                               WHERE road_code = %s
                               LIMIT 1""",
                            (road_code,),
                        )
                    elif road_name:
                        cur.execute(
                            """SELECT id::text, road_code, road_name, object_id::text
                               FROM temporary_roads
                               WHERE road_name = %s
                               LIMIT 1""",
                            (road_name,),
                        )
                    else:
                        return None
                    found = cur.fetchone()
                    if not found:
                        return None
                    return {"id": found[0], "road_code": found[1], "road_name": found[2], "object_id": found[3]}

                # ── Парк техники → report_equipment_units ──
                eq_by_identifier: dict[str, list[str]] = {}
                park_by_identifier: dict[str, dict[str, Any]] = {}
                merged_park: list[dict[str, Any]] = []
                raw_equipment_rows: list[dict[str, Any]] = []

                def _row_has_equipment_reference(row: dict[str, Any]) -> bool:
                    return bool(
                        row.get("reported_number")
                        or row.get("unit_number")
                        or row.get("plate_number")
                        or row.get("plate")
                        or row.get("equipment_unit_id")
                        or _row_equipment_count(row) > 0
                    )

                def _work_visible_equipment_patch(work: dict[str, Any]) -> dict[str, Any]:
                    patch: dict[str, Any] = {}
                    for field in (
                        "equipment_unit_id",
                        "equipment_type",
                        "brand_model",
                        "reported_number",
                        "unit_number",
                        "plate_number",
                        "plate",
                        "owner",
                        "contractor_name",
                        "ownership_type",
                        "status",
                        "work_hours",
                    ):
                        value = work.get(field)
                        if value not in (None, ""):
                            patch[field] = value
                    count = _row_equipment_count(work)
                    if count > 0:
                        patch["equipment_count"] = count
                        patch["hired_count"] = work.get("hired_count") or count
                    if patch.get("owner") and not patch.get("contractor_name"):
                        patch["contractor_name"] = patch.get("owner")
                    if patch.get("contractor_name") and not patch.get("owner"):
                        patch["owner"] = patch.get("contractor_name")
                    if patch.get("plate") and not patch.get("plate_number"):
                        patch["plate_number"] = patch.get("plate")
                    if patch.get("plate_number") and not patch.get("plate"):
                        patch["plate"] = patch.get("plate_number")
                    return patch

                def _merge_work_visible_equipment_fields(equipment_row: dict[str, Any], work: dict[str, Any]) -> None:
                    for field, value in _work_visible_equipment_patch(work).items():
                        if value not in (None, ""):
                            equipment_row[field] = value
                    if equipment_row.get("owner") and not equipment_row.get("contractor_name"):
                        equipment_row["contractor_name"] = equipment_row.get("owner")
                    if equipment_row.get("contractor_name") and not equipment_row.get("owner"):
                        equipment_row["owner"] = equipment_row.get("contractor_name")
                    if equipment_row.get("plate") and not equipment_row.get("plate_number"):
                        equipment_row["plate_number"] = equipment_row.get("plate")
                    if equipment_row.get("plate_number") and not equipment_row.get("plate"):
                        equipment_row["plate"] = equipment_row.get("plate_number")

                def _work_equipment_rows_for_import(work: dict[str, Any], work_idx: int) -> list[dict[str, Any]]:
                    base_key = _clean_identifier(work.get("_equipment_row_key")) or f"work:{work_idx}"
                    work["_equipment_row_key"] = base_key
                    raw_nested = work.get("equipment") if isinstance(work.get("equipment"), list) else []
                    rows: list[dict[str, Any]] = []
                    for eq_idx, source_eq in enumerate(raw_nested):
                        if not isinstance(source_eq, dict):
                            continue
                        eq = dict(source_eq)
                        if eq_idx == 0:
                            _merge_work_visible_equipment_fields(eq, work)
                        row_key = _clean_identifier(eq.get("_equipment_row_key")) or (
                            base_key if len(raw_nested) == 1 else f"{base_key}:eq:{eq_idx}"
                        )
                        eq["_equipment_row_key"] = row_key
                        eq["owner"] = eq.get("owner") or work.get("owner")
                        eq["contractor_name"] = eq.get("contractor_name") or eq.get("owner") or work.get("contractor_name") or work.get("owner")
                        eq["status"] = eq.get("status") or work.get("status") or "working"
                        if not eq.get("equipment_type"):
                            eq["equipment_type"] = work.get("equipment_type")
                        if _row_has_equipment_reference(eq):
                            source_eq.update(eq)
                            rows.append(eq)
                    if rows:
                        return rows
                    if not _row_has_equipment_reference(work):
                        return []
                    row = {
                        "_equipment_row_key": base_key,
                        "equipment_unit_id": work.get("equipment_unit_id"),
                        "plate_number": work.get("plate") or work.get("plate_number"),
                        "unit_number": work.get("unit_number"),
                        "reported_number": work.get("reported_number"),
                        "equipment_type": work.get("equipment_type"),
                        "brand_model": work.get("brand_model"),
                        "owner": work.get("owner") or work.get("contractor_name"),
                        "contractor_name": work.get("contractor_name") or work.get("owner"),
                        "ownership_type": work.get("ownership_type"),
                        "status": work.get("status") or "working",
                        "equipment_count": work.get("equipment_count"),
                        "hired_count": work.get("hired_count"),
                        "count_units": work.get("count_units"),
                        "work_hours": work.get("work_hours"),
                        "comment": work.get("comment") or "auto-added from work row",
                    }
                    return [row]

                for park_idx, p in enumerate(payload.park or []):
                    row = dict(p)
                    row_key = _clean_identifier(row.get("_equipment_row_key")) or f"park:{park_idx}"
                    row["_equipment_row_key"] = row_key
                    if isinstance(p, dict):
                        p["_equipment_row_key"] = row_key
                    raw_equipment_rows.append(row)
                for unit_idx, d in enumerate(payload.transport or []):
                    if _row_has_equipment_reference(d):
                        row_key = _clean_identifier(d.get("_equipment_row_key")) or f"transport:{unit_idx}"
                        d["_equipment_row_key"] = row_key
                        review_transport = payload_for_review.get("transport") if isinstance(payload_for_review.get("transport"), list) else []
                        if unit_idx < len(review_transport) and isinstance(review_transport[unit_idx], dict):
                            review_transport[unit_idx]["_equipment_row_key"] = row_key
                        raw_equipment_rows.append({
                            **dict(d),
                            "_equipment_row_key": row_key,
                            "status": d.get("status") or "working",
                            "equipment_type": d.get("equipment_type") or "самосвал",
                            "comment": d.get("comment") or "auto-added from transport row",
                        })
                for work_idx, w in enumerate((payload.main_works or []) + (payload.aux_works or [])):
                    for eq in _work_equipment_rows_for_import(w, work_idx):
                        raw_equipment_rows.append({
                            **dict(eq),
                            "status": eq.get("status") or "working",
                            "comment": eq.get("comment") or "auto-added from work equipment row",
                        })
                for raw_p in raw_equipment_rows:
                    p = dict(raw_p)
                    _normalize_report_equipment_identifiers(p)
                    keys = _equipment_lookup_keys(p)
                    if not keys:
                        continue
                    existing = next((park_by_identifier[key] for key in keys if key in park_by_identifier), None)
                    if existing:
                        _merge_equipment_payload_row(existing, p)
                        _normalize_report_equipment_identifiers(existing)
                    else:
                        existing = p
                        merged_park.append(existing)
                    for key in _equipment_lookup_keys(existing):
                        park_by_identifier[key] = existing

                n_equipment = 0
                for p in merged_park:
                    _normalize_report_equipment_identifiers(p)
                    raw_master_equipment_id = _clean_identifier(p.get("equipment_unit_id"))
                    master_equipment_id = _resolve_report_equipment_master_id(cur, p)
                    if raw_master_equipment_id and raw_master_equipment_id != master_equipment_id:
                        stale_note = f"stale equipment_unit_id ignored: {raw_master_equipment_id}"
                        p["comment"] = "; ".join(x for x in [_clean_identifier(p.get("comment")), stale_note] if x)
                    reported_number = _clean_identifier(p.get('reported_number'))
                    plate = _clean_identifier(p.get('plate_number') or p.get('plate'))
                    unit_number = _clean_identifier(p.get('unit_number')) or (reported_number if not plate else "")
                    equipment_count = _row_equipment_count(p)
                    has_identifier = bool(plate or unit_number or master_equipment_id)
                    insert_count = _safe_equipment_insert_count(p, has_identifier)
                    if insert_count <= 0:
                        continue
                    if n_equipment + insert_count > MAX_REPORT_EQUIPMENT_UNITS:
                        raise HTTPException(
                            400,
                            "Импорт остановлен: в отчете слишком много строк техники "
                            f"({n_equipment + insert_count}). Проверьте блок техники и наемную технику.",
                        )
                    owner = (p.get('owner') or p.get('contractor_name') or '').strip()
                    raw_status = (p.get('status') or 'working').lower()
                    # Маппим в допустимые БД-значения: working | repair | out | standby | unknown
                    if raw_status in ('working', 'в работе', 'в_работе'):
                        status_db = 'working'
                    elif raw_status in ('idle', 'standby', 'простой', 'резерв'):
                        status_db = 'standby'
                    elif raw_status in ('repair', 'ремонт'):
                        status_db = 'repair'
                    elif raw_status in ('out', 'вне', 'списан'):
                        status_db = 'out'
                    else:
                        status_db = 'unknown'

                    inserted_ids: list[str] = []
                    for count_idx in range(insert_count):
                        eq_id = str(uuid.uuid4())
                        comment_parts = [p.get('status_reason') or p.get('comment')]
                        if insert_count > 1:
                            comment_parts.append(f"hired equipment {count_idx + 1}/{insert_count}")
                        cur.execute(
                            """INSERT INTO report_equipment_units
                               (id, daily_report_id, equipment_unit_id, equipment_type, brand_model, unit_number,
                                plate_number, ownership_type, contractor_name,
                                status, comment, review_tag)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (eq_id, report_id,
                             master_equipment_id if has_identifier else None,
                             (p.get('equipment_type') or 'unknown').lower(),
                             p.get('brand_model'), unit_number or None, plate or None,
                             p.get('ownership_type') or _ownership_from_owner(owner),
                             p.get('contractor_name') or owner,
                             status_db,
                             "; ".join(str(part).strip() for part in comment_parts if str(part or '').strip()) or None,
                             pending_tag))
                        inserted_ids.append(eq_id)
                        n_equipment += 1
                    lookup_keys = _equipment_lookup_keys(p)
                    if raw_master_equipment_id:
                        lookup_keys.append(f"master:{raw_master_equipment_id}")
                    if master_equipment_id and master_equipment_id != raw_master_equipment_id:
                        lookup_keys.append(f"master:{master_equipment_id}")
                    _register_equipment_ids(eq_by_identifier, lookup_keys, inserted_ids)

                # ── Работы → daily_work_items (+ work_item_equipment_usage) ──
                n_work_items = 0
                n_skipped = 0
                skipped_details: list[str] = []
                work_pending_review: list[dict[str, Any]] = []
                # Default object для сопутствующих работ — любая TEMP_ROAD в этом участке.
                default_obj_id = None
                if section_id:
                    cur.execute(
                        """SELECT o.id FROM objects o
                           JOIN object_types ot ON ot.id = o.object_type_id
                           WHERE ot.code = 'TEMP_ROAD'
                             AND EXISTS (SELECT 1 FROM object_segments os WHERE os.object_id = o.id)
                           LIMIT 1""")
                    r = cur.fetchone()
                    if r:
                        default_obj_id = r[0]
                for work_idx, w in enumerate((payload.main_works or []) + (payload.aux_works or []), start=1):
                    if _is_regular_work_block_forbidden_work_type(w.get('work_type_code')):
                        n_skipped += 1
                        skipped_text = _regular_work_block_forbidden_work_message(work_idx, w)
                        skipped_details.append(skipped_text)
                        work_pending_review.append({
                            "index": work_idx,
                            "reason": "pile_work_in_regular_work_block",
                            "message": skipped_text,
                            "work_row": dict(w),
                        })
                        continue
                    wt_meta = _find_work_type_meta(w.get('work_type_code'))
                    wt_id = wt_meta["id"] if wt_meta else None
                    pk_rail_start = _parse_pk_input(w.get("pk_rail_start") or w.get("pk_start") or w.get("pk_rail_raw"))
                    pk_rail_end = _parse_pk_input(w.get("pk_rail_end") or w.get("pk_end")) if w.get("pk_rail_end") not in (None, "") else pk_rail_start
                    pk_rail_start, pk_rail_end = _normalize_pk_pair(pk_rail_start, pk_rail_end)
                    raw_object_hint = w.get('constructive')
                    object_hint = w.get('object_code') or w.get('constructive_code') or raw_object_hint
                    obj_id = None
                    if _is_main_track_object_hint(raw_object_hint) or _is_main_track_object_hint(object_hint):
                        obj_id = _find_main_track_object_id(section_id, pk_rail_start, pk_rail_end)
                    if not obj_id:
                        obj_id = _find_object_id(object_hint)
                    if not obj_id and not object_hint:
                        obj_id = default_obj_id
                    resolved_object_code = _find_object_code(obj_id)
                    constr_id = _find_constructive_id(w.get('constructive_type_code') or w.get('constructive'))
                    vol = w.get('volume')
                    unit = ((wt_meta or {}).get('default_unit') or w.get('unit') or 'м3').replace('м²', 'м2')
                    row_analytics_tag = _work_analytics_tag_from_row(w)
                    analytics_tag = row_analytics_tag or _normalize_work_analytics_tag((wt_meta or {}).get('analytics_tag'))
                    if row_analytics_tag and wt_meta:
                        cur.execute(
                            """
                            UPDATE work_types
                            SET analytics_tag = %s
                            WHERE id = %s
                              AND NULLIF(BTRIM(COALESCE(analytics_tag, '')), '') IS NULL
                            """,
                            (row_analytics_tag, wt_meta["id"]),
                        )
                    if vol is None or obj_id is None or wt_id is None:
                        n_skipped += 1
                        missing = []
                        if vol is None:
                            missing.append("объем")
                        if obj_id is None:
                            missing.append("объект БД")
                        if wt_id is None:
                            missing.append("тип работы БД")
                        skipped_text = (
                            f"работа №{work_idx}: {w.get('constructive') or 'без конструктива'} / "
                            f"{w.get('work_name') or 'без названия'} (нет: {', '.join(missing)})"
                        )
                        skipped_details.append(skipped_text)
                        work_pending_review.append({
                            "index": work_idx,
                            "reason": "missing_required_fields_for_work_item",
                            "missing": missing,
                            "message": skipped_text,
                            "work_row": dict(w),
                        })
                        continue
                    if analytics_tag:
                        _upsert_work_analytics_tag(cur, analytics_tag)
                    dwi_id = str(uuid.uuid4())
                    cur.execute(
                        """INSERT INTO daily_work_items
                           (id, daily_report_id, report_date, shift, section_id, object_id,
                            constructive_id, work_type_id, work_name_raw, unit, volume,
                            labor_source_type, contractor_name, comment, productivity_enabled, review_tag, analytics_tag)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (dwi_id, report_id, report_date, shift, section_id,
                         obj_id, constr_id, wt_id, w.get('work_name') or '',
                         unit, vol,
                         _ownership_from_owner(w.get('owner')),
                         w.get('owner'),
                         w.get('comment'),
                         bool(w.get('productivity_enabled', True)),
                         pending_tag,
                         analytics_tag))
                    n_work_items += 1
                    _learn_alias("work_type", w.get("work_name"), w.get("work_type_code"))
                    _learn_alias("object", w.get("constructive"), resolved_object_code or w.get("object_code") or w.get("constructive_code"))
                    pk_raw = (w.get("pk_rail_raw") or "").strip() if isinstance(w.get("pk_rail_raw"), str) else None
                    if not pk_raw and pk_rail_start is not None:
                        start_label = _format_pk_db(pk_rail_start)
                        end_label = _format_pk_db(pk_rail_end)
                        pk_raw = f"{start_label} - {end_label}" if start_label and end_label and start_label != end_label else start_label
                    if pk_rail_start is not None and pk_rail_end is not None:
                        cur.execute(
                            """INSERT INTO daily_work_item_segments
                               (id, daily_work_item_id, pk_start, pk_end, pk_raw_text, comment, volume_segment, review_tag, analytics_tag)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (
                                str(uuid.uuid4()),
                                dwi_id,
                                pk_rail_start,
                                pk_rail_end,
                                pk_raw,
                                f"ПК АД: {w.get('pk_ad_raw')}" if w.get("pk_ad_raw") else None,
                                vol,
                                pending_tag,
                                analytics_tag,
                            ),
                        )
                    equipment_rows = _work_equipment_rows_for_import(w, work_idx - 1)
                    for equipment_row in equipment_rows:
                        equipment_row.setdefault("volume", vol)
                        equipment_row.setdefault("unit", unit)
                    for eq in equipment_rows:
                        eq_ids = _lookup_equipment_ids(eq, eq_by_identifier)
                        if eq_ids:
                            eq_vol = eq.get("volume")
                            eq_unit = str(eq.get("unit") or unit or "").strip().lower().replace("м²", "м2").replace("м³", "м3")
                            usage_comment = 'import'
                            if eq_vol is None and len(equipment_rows) == 1 and eq_unit in ('м2', 'м3'):
                                eq_vol = vol
                                usage_comment = 'import; inferred work volume from row'
                            for eq_id in eq_ids:
                                eq_vol_for_unit = eq_vol
                                if eq_vol is not None and len(eq_ids) > 1:
                                    try:
                                        eq_vol_for_unit = float(eq_vol) / len(eq_ids)
                                        usage_comment = 'import; inferred work volume split across hired equipment count'
                                    except (TypeError, ValueError):
                                        eq_vol_for_unit = eq_vol
                                cur.execute(
                                    """INSERT INTO work_item_equipment_usage
                                       (id, daily_work_item_id, report_equipment_unit_id,
                                       worked_volume, worked_area, work_hours, comment, review_tag)
                                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                                    (str(uuid.uuid4()), dwi_id, eq_id,
                                     eq_vol_for_unit if eq_unit == 'м3' else None,
                                     eq_vol_for_unit if eq_unit == 'м2' else None,
                                     float(_payload_decimal(eq.get("work_hours"))) if _payload_decimal(eq.get("work_hours")) is not None else None,
                                     usage_comment,
                                     pending_tag))
                if work_pending_review:
                    review_actions = payload_for_review.setdefault("review_actions", {})
                    review_actions["work_items_pending_required_fields_review"] = work_pending_review
                # ── Забивка свай → daily_work_items (+ ordinary object link and segment) ──
                _ensure_pile_field_object_links(cur)
                n_piles = 0
                pile_skipped: list[str] = []
                pile_master_equipment_report_ids: dict[str, str] = {}

                def _pile_report_equipment_id(pile_row: dict[str, Any]) -> Optional[str]:
                    selected_equipment_id = _clean_identifier(pile_row.get("report_equipment_unit_id"))
                    if selected_equipment_id and not selected_equipment_id.startswith("master:"):
                        try:
                            uuid.UUID(selected_equipment_id)
                        except ValueError:
                            return None
                        cur.execute("SELECT id::text FROM report_equipment_units WHERE id = %s::uuid LIMIT 1", (selected_equipment_id,))
                        found = cur.fetchone()
                        return str(found[0]) if found else None

                    master_equipment_id = ""
                    if selected_equipment_id.startswith("master:"):
                        master_equipment_id = selected_equipment_id.split(":", 1)[1].strip()
                    if not master_equipment_id:
                        master_equipment_id = _clean_identifier(pile_row.get("equipment_unit_id"))
                    if not master_equipment_id:
                        return None
                    try:
                        uuid.UUID(master_equipment_id)
                    except ValueError:
                        return None
                    if master_equipment_id in pile_master_equipment_report_ids:
                        return pile_master_equipment_report_ids[master_equipment_id]

                    cur.execute(
                        """
                        SELECT id::text,
                               equipment_type,
                               brand_model,
                               unit_number,
                               plate_number,
                               ownership_type,
                               contractor_name,
                               status
                        FROM equipment_units
                        WHERE id = %s::uuid
                          AND is_active IS NOT FALSE
                        LIMIT 1
                        """,
                        (master_equipment_id,),
                    )
                    master_row = cur.fetchone()
                    if not master_row:
                        return None
                    status_db = _clean_identifier(pile_row.get("status") or master_row[7]).lower()
                    if status_db not in {"working", "repair", "out", "standby", "unknown"}:
                        status_db = "unknown"
                    eq_id = str(uuid.uuid4())
                    cur.execute(
                        """INSERT INTO report_equipment_units
                           (id, daily_report_id, equipment_unit_id, equipment_type, brand_model, unit_number,
                            plate_number, ownership_type, contractor_name,
                            status, comment, review_tag)
                           VALUES (%s, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (
                            eq_id,
                            report_id,
                            master_equipment_id,
                            _clean_identifier(pile_row.get("equipment_type")) or master_row[1] or "Сваебойная установка",
                            _clean_identifier(pile_row.get("brand_model")) or master_row[2],
                            _clean_identifier(pile_row.get("unit_number")) or master_row[3],
                            _clean_identifier(pile_row.get("plate_number")) or master_row[4],
                            _clean_identifier(pile_row.get("ownership_type")) or master_row[5] or "unknown",
                            _clean_identifier(pile_row.get("contractor")) or master_row[6],
                            status_db,
                            "pile-control master candidate",
                            pending_tag,
                        ),
                    )
                    pile_master_equipment_report_ids[master_equipment_id] = eq_id
                    return eq_id

                for p in (payload.piles or []):
                    count = p.get("count")
                    try:
                        count_num = float(count)
                    except (TypeError, ValueError):
                        count_num = 0
                    if count_num <= 0:
                        continue
                    field = _find_pile_field(p)
                    wt_code = _pile_row_work_type_code(p, field)
                    wt_meta = _find_work_type_meta(wt_code)
                    wt_id = wt_meta["id"] if wt_meta else None
                    analytics_tag = _normalize_work_analytics_tag((wt_meta or {}).get("analytics_tag")) or _infer_work_analytics_tag(wt_code)
                    if analytics_tag and wt_meta and not _normalize_work_analytics_tag(wt_meta.get("analytics_tag")):
                        cur.execute(
                            """
                            UPDATE work_types
                            SET analytics_tag = %s
                            WHERE id = %s
                              AND NULLIF(BTRIM(COALESCE(analytics_tag, '')), '') IS NULL
                            """,
                            (analytics_tag, wt_meta["id"]),
                        )
                    if not wt_id or not field or not field.get("object_id"):
                        pile_skipped.append(str(p.get("field_code") or p.get("pk_text") or "свайная цель н/д"))
                        continue
                    if analytics_tag:
                        _upsert_work_analytics_tag(cur, analytics_tag)
                    dwi_id = str(uuid.uuid4())
                    if field.get("target_type") == "pipe":
                        comment_parts = [
                            f"pipe={field.get('object_code') or field.get('field_code')}",
                            f"pipe_pile_spec={field.get('pipe_pile_spec_id')}",
                            f"pile_type={field.get('pile_type')}",
                            f"length={_pile_length_label(field.get('pile_type'))}",
                        ]
                    else:
                        comment_parts = [
                            f"field={field.get('field_code')}",
                            f"pile_type={field.get('pile_type')}",
                            f"length={_pile_length_label(field.get('pile_type'))}",
                        ]
                    equipment_label = str(p.get("equipment_label") or p.get("equipment_type") or "").strip()
                    if equipment_label:
                        comment_parts.append(f"equipment={equipment_label}")
                    pile_comment = _strip_composite_ready_marker(p.get("comment"))
                    if pile_comment:
                        comment_parts.append(pile_comment)
                    cur.execute(
                        """INSERT INTO daily_work_items
                           (id, daily_report_id, report_date, shift, section_id, object_id,
                            constructive_id, work_type_id, work_name_raw, unit, volume,
                            labor_source_type, contractor_name, comment, review_tag, analytics_tag)
                           VALUES (%s, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (
                            dwi_id,
                            report_id,
                            report_date,
                            shift,
                            section_id,
                            field.get("object_id"),
                            wt_id,
                            _pile_work_name_for_code(wt_code),
                            "шт",
                            count_num,
                            "unknown",
                            None,
                            "; ".join(comment_parts),
                            pending_tag,
                            analytics_tag,
                        ),
                    )
                    report_equipment_unit_id = _pile_report_equipment_id(p)
                    if report_equipment_unit_id:
                        cur.execute(
                            """INSERT INTO work_item_equipment_usage
                               (id, daily_work_item_id, report_equipment_unit_id,
                                worked_volume, comment, review_tag)
                               VALUES (%s, %s, %s, %s, %s, %s)""",
                            (str(uuid.uuid4()), dwi_id, report_equipment_unit_id, count_num, "pile-control", pending_tag),
                        )
                    cur.execute(
                        """INSERT INTO daily_work_item_segments
                           (id, daily_work_item_id, pile_field_id, pk_start, pk_end, pk_raw_text, comment, volume_segment, review_tag, analytics_tag)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (
                            str(uuid.uuid4()),
                            dwi_id,
                            field.get("pile_field_id"),
                            field.get("pk_start"),
                            field.get("pk_end"),
                            field.get("pk_raw_text"),
                            f"ПЖБТ {field.get('field_code')}" if field.get("target_type") == "pipe" else f"Свайное поле {field.get('field_code')}",
                            count_num,
                            pending_tag,
                            analytics_tag,
                        ),
                    )
                    n_work_items += 1
                    n_piles += 1
                if pile_skipped:
                    raise HTTPException(
                        400,
                        "Импорт остановлен: есть свайные строки без поля/ПЖБТ или типа работ: " + "; ".join(pile_skipped[:10]),
                    )

                # ── Перевозка → material_movements (+ usage) ──
                n_movements = 0
                movement_skipped: list[str] = []
                movement_pending_review: list[dict[str, Any]] = []
                movement_reference_review: list[dict[str, Any]] = []
                movement_idx = 0
                for d in (payload_for_review.get("transport") or []):
                    eq_id = _lookup_equipment_id(d, eq_by_identifier)
                    owner = d.get('owner') or 'ЖДС'
                    for trip in (d.get('trips') or []):
                        movement_idx += 1
                        mat_id = _find_material_id(trip.get('material_code'))
                        if mat_id is None and trip.get("material"):
                            mat_id, material_code = _ensure_pending_material(trip.get("material"), trip.get("unit") or "м3")
                            if mat_id and material_code:
                                trip["material_code"] = material_code
                                movement_reference_review.append({
                                    "index": movement_idx,
                                    "reason": "pending_material_reference_created",
                                    "message": (
                                        f"перевозка №{movement_idx}: материал "
                                        f"«{trip.get('material')}» создан как временный справочник и требует привязки"
                                    ),
                                    "material": trip.get("material"),
                                    "material_code": material_code,
                                })
                        from_id = _find_object_id(trip.get('from_object_code') or trip.get('from'))
                        to_id = _find_object_id(trip.get('to_object_code') or trip.get('to'))
                        # Owner-approved narrow auto-create gate: only stockpile-like
                        # endpoints with material+single PK may create stockpile objects.
                        # Any other missing endpoint remains staged in review_payload.
                        if not from_id:
                            from_id = _ensure_stockpile_object_from_endpoint(trip.get('from'), trip.get('material_code'))
                        if not to_id:
                            to_id = _ensure_stockpile_object_from_endpoint(trip.get('to'), trip.get('material_code'))
                        mtype = _classify_movement(from_id, to_id)
                        haul_distance_km = _coerce_haul_distance_km(
                            trip.get('haul_distance_km') or trip.get('distance_km') or trip.get('haul_distance')
                        )
                        haul_distance_source = 'manual' if haul_distance_km is not None else None
                        if haul_distance_km is None:
                            haul_distance_km, haul_distance_source = _default_haul_distance_km(from_id)
                        vol = trip.get('volume')
                        trips_cnt = trip.get('trips') or 0
                        try:
                            equipment_count = max(int(trip.get("equipment_count") or d.get("equipment_count") or 1), 1)
                        except (TypeError, ValueError):
                            equipment_count = 1
                        if vol is None or mat_id is None or from_id is None or to_id is None:
                            missing = []
                            if vol is None:
                                missing.append("объем")
                            if mat_id is None:
                                missing.append("материал БД")
                            if from_id is None:
                                missing.append("откуда БД")
                            if to_id is None:
                                missing.append("куда БД")
                            skipped_text = (
                                f"перевозка №{movement_idx}: {trip.get('material') or 'материал н/д'}: "
                                f"{trip.get('from') or 'откуда н/д'} → {trip.get('to') or 'куда н/д'} "
                                f"(нет: {', '.join(missing)})"
                            )
                            movement_skipped.append(skipped_text)
                            movement_pending_review.append({
                                "index": movement_idx,
                                "reason": "missing_required_fields_for_material_movements",
                                "missing": missing,
                                "message": skipped_text,
                                "transport_row": {
                                    "reported_number": d.get("reported_number"),
                                    "unit_number": d.get("unit_number"),
                                    "plate_number": d.get("plate_number") or d.get("plate"),
                                    "owner": owner,
                                },
                                "trip": dict(trip),
                            })
                            continue
                        _learn_alias("material", trip.get("material"), trip.get("material_code"))
                        _learn_alias("object", trip.get("from"), trip.get("from_object_code"))
                        _learn_alias("object", trip.get("to"), trip.get("to_object_code"))
                        mm_id = str(uuid.uuid4())
                        cur.execute(
                            """INSERT INTO material_movements
                               (id, daily_report_id, report_date, shift, section_id, material_id,
                                from_object_id, to_object_id, volume, unit, trip_count, movement_type,
                                haul_distance_km, haul_distance_source,
                                labor_source_type, contractor_name, equipment_type, equipment_count, review_tag)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (mm_id, report_id, report_date, shift, section_id, mat_id,
                             from_id, to_id, vol, trip.get('unit') or 'м3', trips_cnt, mtype,
                             haul_distance_km, haul_distance_source,
                             _ownership_from_owner(owner),
                             owner, 'самосвал', equipment_count, pending_tag))
                        n_movements += 1
                        if eq_id:
                            cur.execute(
                                """INSERT INTO material_movement_equipment_usage
                                   (id, material_movement_id, report_equipment_unit_id,
                                    trips_count, worked_volume, work_hours, comment, review_tag)
                                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                                (str(uuid.uuid4()), mm_id, eq_id,
                                 trips_cnt, vol,
                                 float(_payload_decimal(trip.get("work_hours"))) if _payload_decimal(trip.get("work_hours")) is not None else None,
                                 'import', pending_tag))
                if movement_pending_review:
                    review_actions = payload_for_review.setdefault("review_actions", {})
                    review_actions["material_movements_pending_endpoint_review"] = movement_pending_review
                if movement_reference_review:
                    review_actions = payload_for_review.setdefault("review_actions", {})
                    review_actions["material_movements_pending_reference_review"] = movement_reference_review

                # ── Проблемные вопросы ──
                problems_text = (payload.problems or '').strip()
                n_problems = 0
                if problems_text:
                    cur.execute(
                        """INSERT INTO daily_report_problems
                           (id, daily_report_id, problem_text, sort_order)
                           VALUES (%s, %s, %s, %s)""",
                        (str(uuid.uuid4()), report_id, problems_text, 0))
                    n_problems = 1

                # ── Накопители → stockpiles + stockpile_balance_snapshots ──
                n_stockpiles = 0
                n_stockpiles_created_or_used = 0
                stockpile_skipped: list[str] = []
                for sp in (payload_for_review.get("stockpiles") or []):
                    if sp.get("volume") is None:
                        stockpile_skipped.append(f"{sp.get('name') or 'накопитель н/д'} без объема")
                        continue
                    stockpile_id = _ensure_stockpile(sp)
                    if not stockpile_id:
                        stockpile_skipped.append(f"{sp.get('name') or 'накопитель н/д'} без материала/пикета/типа объекта")
                        continue
                    cur.execute(
                        """INSERT INTO stockpile_balance_snapshots
                           (id, stockpile_id, snapshot_date, balance_volume, unit, comment, review_tag)
                           VALUES (%s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT (stockpile_id, snapshot_date) DO UPDATE
                           SET balance_volume = EXCLUDED.balance_volume,
                               unit = EXCLUDED.unit,
                               comment = EXCLUDED.comment,
                               review_tag = EXCLUDED.review_tag""",
                        (
                            str(uuid.uuid4()),
                            stockpile_id,
                            report_date,
                            sp.get("volume"),
                            sp.get("unit") or "м3",
                            "confirmed report import; stockpile block",
                            pending_tag,
                        ),
                    )
                    n_stockpiles += 1
                    n_stockpiles_created_or_used += 1
                if stockpile_skipped:
                    raise HTTPException(
                        400,
                        "Импорт остановлен: есть накопители без обязательных данных: " + "; ".join(stockpile_skipped[:10]),
                    )

                # ── Отсыпка ВАД → temporary_road_status_segments ──
                n_fill_status_segments = 0
                fill_status_skipped: list[str] = []
                for row_idx, fill_row in enumerate(payload.fill_statuses or [], start=1):
                    road = _find_temp_road(fill_row)
                    status_inputs = _iter_temp_road_fill_status_inputs(fill_row)
                    if not status_inputs:
                        continue
                    if not road:
                        fill_status_skipped.append(f"строка отсыпки №{row_idx}: автодорога не выбрана")
                        continue
                    comment = (fill_row.get("comment") or fill_row.get("note") or "").strip() or None
                    section_note = (fill_row.get("section_code") or "").strip()
                    if section_note:
                        comment = f"{comment}; участок={section_note}" if comment else f"участок={section_note}"
                    for status_type, pk_text, pk_system in status_inputs:
                        for pk_range in _parse_pk_ranges_text(pk_text):
                            start = pk_range.get("start")
                            end = pk_range.get("end")
                            if start is None or end is None:
                                continue
                            pk_raw = pk_range.get("raw") or f"{_format_pk_db(start)} - {_format_pk_db(end)}"
                            road_pk_start = start if pk_system == "road" else None
                            road_pk_end = end if pk_system == "road" else None
                            rail_pk_start = start if pk_system == "rail" else None
                            rail_pk_end = end if pk_system == "rail" else None
                            if _store_temp_road_status_segment(
                                cur,
                                report_id=report_id,
                                road=road,
                                report_date=report_date,
                                status_type=status_type,
                                pk_system=pk_system,
                                road_pk_start=road_pk_start,
                                road_pk_end=road_pk_end,
                                rail_pk_start=rail_pk_start,
                                rail_pk_end=rail_pk_end,
                                source_reference=payload.source_reference or pk_raw,
                                comment=comment,
                                review_tag=pending_tag,
                            ):
                                n_fill_status_segments += 1
                if fill_status_skipped:
                    raise HTTPException(
                        400,
                        "Импорт остановлен: есть строки отсыпки без автодороги: " + "; ".join(fill_status_skipped[:10]),
                    )


                # ── Отсыпка ОХ → mainline_fill_status_segments ──
                n_mainline_fill_status_segments = 0
                mainline_fill_skipped: list[str] = []
                if payload.mainline_fill_statuses:
                    if not _table_exists_cur(cur, "mainline_fill_status_segments"):
                        raise HTTPException(
                            400,
                            "Импорт отсыпки ОХ недоступен: не применена миграция mainline_fill_status_segments",
                        )
                    section_id_cache: dict[str, Optional[str]] = {payload.header.section_code or "": section_id}
                    for row_idx, fill_row in enumerate(payload.mainline_fill_statuses or [], start=1):
                        status_type = str(fill_row.get("status_type") or "prep_works").strip()
                        if status_type not in MAINLINE_FILL_STATUS_TYPES or status_type == "no_work":
                            mainline_fill_skipped.append(f"строка отсыпки ОХ №{row_idx}: некорректный статус")
                            continue
                        pk_ranges = _parse_pk_ranges_text(fill_row.get("pk_ranges"))
                        if not pk_ranges:
                            continue
                        row_section_code = str(fill_row.get("section_code") or payload.header.section_code or "").strip()
                        row_section_id = section_id_cache.get(row_section_code)
                        if row_section_code not in section_id_cache:
                            row_section = query_one("SELECT id::text AS id FROM construction_sections WHERE code = %s LIMIT 1", [row_section_code])
                            row_section_id = row_section.get("id") if row_section else None
                            section_id_cache[row_section_code] = row_section_id
                        if not row_section_id:
                            mainline_fill_skipped.append(f"строка отсыпки ОХ №{row_idx}: участок не выбран")
                            continue
                        comment = (fill_row.get("comment") or fill_row.get("note") or "").strip() or None
                        for pk_range in pk_ranges:
                            start = pk_range.get("start")
                            end = pk_range.get("end")
                            if start is None or end is None:
                                continue
                            pk_raw = pk_range.get("raw") or f"{_format_pk_db(start)} - {_format_pk_db(end)}"
                            cur.execute(
                                """INSERT INTO mainline_fill_status_segments
                                   (id, daily_report_id, section_id, status_date, status_type,
                                    pk_start, pk_end, source_reference, comment, is_demo, review_tag)
                                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, false, %s)
                                   ON CONFLICT DO NOTHING
                                   RETURNING id""",
                                (
                                    str(uuid.uuid4()),
                                    report_id,
                                    row_section_id,
                                    report_date,
                                    status_type,
                                    start,
                                    end,
                                    payload.source_reference or pk_raw,
                                    comment,
                                    pending_tag,
                                ),
                            )
                            if cur.fetchone():
                                n_mainline_fill_status_segments += 1
                if mainline_fill_skipped:
                    raise HTTPException(
                        400,
                        "Импорт остановлен: есть ошибки в отсыпке ОХ: " + "; ".join(mainline_fill_skipped[:10]),
                    )

                inserted = {
                    "daily_report_id": report_id,
                    "work_items": n_work_items,
                    "work_items_skipped_no_object": n_skipped,
                    "movements": n_movements,
                    "movements_pending_review": len(movement_pending_review),
                    "movements_pending_reference_review": len(movement_reference_review),
                    "equipment_units": n_equipment,
                    "staff_counts": n_staff_counts,
                    "problems": n_problems,
                    "stockpile_snapshots": n_stockpiles,
                    "stockpiles_created_or_used": n_stockpiles_created_or_used,
                    "pile_items": n_piles,
                    "fill_status_segments": n_fill_status_segments,
                    "mainline_fill_status_segments": n_mainline_fill_status_segments,
                    "reused_existing_report": bool(reused_existing_report_id),
                }
                payload_for_review["import_summary"] = inserted
                cur.execute(
                    """UPDATE daily_reports
                       SET review_payload = %s::jsonb
                       WHERE id = %s""",
                    (json.dumps(payload_for_review, ensure_ascii=False), report_id),
                )

                _invalidate_dashboard_cache_after_report_write("report_import")
                return {"ok": True, **inserted}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Ошибка импорта: {e}")
    finally:
        conn.close()
