from __future__ import annotations

import logging
import re
import uuid
from decimal import Decimal
from typing import Any

import psycopg2.extras

from main import get_conn


LOG = logging.getLogger("vsm.temp_roads_catalog")

_AD_WITH_SUFFIX_RE = re.compile(
    r"(?:^|[^А-ЯA-Z0-9])(?:АД|AD)\s*([0-9]+)\s*№\s*([0-9]+(?:[.,][0-9]+)*)",
    re.IGNORECASE,
)
_AD_DOTTED_RE = re.compile(
    r"(?:^|[^А-ЯA-Z0-9])(?:АД|AD)\s*[-№#]?\s*([0-9]+(?:[.,][0-9]+)*)",
    re.IGNORECASE,
)
_ROAD_NUMBER_RE = re.compile(
    r"дорог[аиеуы]?\s*№?\s*([0-9]+(?:[.,][0-9]+)*)",
    re.IGNORECASE,
)


def _normalize_temp_road_number_part(value: str) -> str:
    value = str(value or "").strip()
    if value.isdigit():
        return str(int(value))
    return value


def _format_temp_road_code(number: str, suffix: str | None = None) -> str:
    raw_parts = [part for part in re.split(r"[.,]", str(number or "").strip()) if part]
    parts = [_normalize_temp_road_number_part(part) for part in raw_parts]
    if not parts:
        return ""
    if suffix:
        suffix_parts = [
            _normalize_temp_road_number_part(part)
            for part in re.split(r"[.,]", str(suffix or "").strip())
            if part
        ]
        if suffix_parts:
            return f"АД{parts[0]} №{'.'.join(suffix_parts)}"
    if len(parts) == 1:
        return f"АД{parts[0]}"
    return f"АД{parts[0]} №{'.'.join(parts[1:])}"


def derive_temp_road_code(object_code: Any, name: Any) -> str:
    """Convert TEMP_ROAD object labels like "Притрассовая дорога №4.8.1" to catalog road codes."""
    text = " ".join(str(value or "").strip() for value in (object_code, name) if str(value or "").strip())
    if not text:
        return ""
    explicit_with_suffix = _AD_WITH_SUFFIX_RE.search(f" {text}")
    if explicit_with_suffix:
        return _format_temp_road_code(explicit_with_suffix.group(1), explicit_with_suffix.group(2))
    explicit_dotted = _AD_DOTTED_RE.search(f" {text}")
    if explicit_dotted:
        return _format_temp_road_code(explicit_dotted.group(1))
    road_number = _ROAD_NUMBER_RE.search(text)
    if road_number:
        return _format_temp_road_code(road_number.group(1))
    fallback = str(object_code or name or "").strip()
    return fallback


def _as_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _bump_dashboard_cache_generation() -> None:
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_response_cache_state (
                      cache_scope text PRIMARY KEY,
                      generation bigint NOT NULL DEFAULT 1,
                      updated_at timestamptz NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    INSERT INTO dashboard_response_cache_state(cache_scope, generation, updated_at)
                    VALUES ('global', 2, now())
                    ON CONFLICT (cache_scope) DO UPDATE
                    SET generation = dashboard_response_cache_state.generation + 1,
                        updated_at = now()
                    """
                )
    finally:
        conn.close()


def ensure_temp_road_catalog_rows() -> int:
    """
    Promote active TEMP_ROAD objects to temporary_roads when report intake created only
    the generic object row. Existing manually configured roads are left untouched.
    """
    inserted = 0
    conn = None
    try:
        conn = get_conn()
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT o.id::text AS object_id,
                           o.object_code,
                           o.name,
                           MIN(LEAST(os.pk_start, os.pk_end)) AS rail_pk_start,
                           MAX(GREATEST(os.pk_start, os.pk_end)) AS rail_pk_end
                    FROM objects o
                    JOIN object_types ot ON ot.id = o.object_type_id
                    JOIN object_segments os ON os.object_id = o.id
                    WHERE ot.code = 'TEMP_ROAD'
                      AND COALESCE(o.is_active, true) IS TRUE
                      AND os.pk_start IS NOT NULL
                      AND os.pk_end IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1
                        FROM temporary_roads tr
                        WHERE tr.object_id = o.id
                      )
                    GROUP BY o.id, o.object_code, o.name
                    ORDER BY MIN(LEAST(os.pk_start, os.pk_end)), o.name
                    """
                )
                candidates = [dict(row) for row in cur.fetchall()]
                for row in candidates:
                    road_code = derive_temp_road_code(row.get("object_code"), row.get("name"))
                    if not road_code:
                        continue
                    rail_start = _as_decimal(row.get("rail_pk_start"))
                    rail_end = _as_decimal(row.get("rail_pk_end"))
                    if rail_start is None or rail_end is None:
                        continue
                    rail_lo = min(rail_start, rail_end)
                    rail_hi = max(rail_start, rail_end)
                    length_m = rail_hi - rail_lo
                    if length_m <= 0:
                        continue
                    road_id = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO temporary_roads (
                          id, road_code, road_name, road_type,
                          ad_start_pk, ad_end_pk, rail_start_pk, rail_end_pk,
                          can_translate_to_rail, object_id, display_in_dashboard, comment
                        )
                        VALUES (%s, %s, %s, 'temporary_access',
                                %s, %s, %s, %s,
                                true, %s, true, %s)
                        ON CONFLICT (road_code) DO UPDATE
                        SET object_id = COALESCE(temporary_roads.object_id, EXCLUDED.object_id),
                            ad_start_pk = COALESCE(temporary_roads.ad_start_pk, EXCLUDED.ad_start_pk),
                            ad_end_pk = COALESCE(temporary_roads.ad_end_pk, EXCLUDED.ad_end_pk),
                            rail_start_pk = COALESCE(temporary_roads.rail_start_pk, EXCLUDED.rail_start_pk),
                            rail_end_pk = COALESCE(temporary_roads.rail_end_pk, EXCLUDED.rail_end_pk),
                            can_translate_to_rail = temporary_roads.can_translate_to_rail OR EXCLUDED.can_translate_to_rail,
                            updated_at = now()
                        WHERE temporary_roads.object_id IS NULL
                        RETURNING id::text
                        """,
                        (
                            road_id,
                            road_code,
                            road_code,
                            Decimal("0"),
                            length_m,
                            rail_lo,
                            rail_hi,
                            row.get("object_id"),
                            f"auto-created from TEMP_ROAD object: {row.get('name') or row.get('object_code') or road_code}",
                        ),
                    )
                    saved = cur.fetchone()
                    if not saved:
                        continue
                    saved_road_id = saved["id"]
                    cur.execute(
                        """
                        INSERT INTO temporary_road_pk_mappings (
                          id, road_id, mapping_type,
                          ad_pk_start, ad_pk_end, rail_pk_start, rail_pk_end,
                          source_reference, comment
                        )
                        SELECT %s, %s, 'full_axis_range',
                               %s, %s, %s, %s,
                               %s, %s
                        WHERE NOT EXISTS (
                          SELECT 1
                          FROM temporary_road_pk_mappings
                          WHERE road_id = %s AND mapping_type = 'full_axis_range'
                        )
                        """,
                        (
                            str(uuid.uuid4()),
                            saved_road_id,
                            Decimal("0"),
                            length_m,
                            rail_lo,
                            rail_hi,
                            "object_segments",
                            "auto-created from TEMP_ROAD object bounds",
                            saved_road_id,
                        ),
                    )
                    inserted += 1
    except Exception as exc:
        LOG.warning("temporary road catalog autosync failed: %s", exc)
        return 0
    finally:
        if conn is not None:
            conn.close()

    if inserted:
        try:
            _bump_dashboard_cache_generation()
        except Exception as exc:
            LOG.warning("dashboard cache generation bump after temp-road autosync failed: %s", exc)
    return inserted
