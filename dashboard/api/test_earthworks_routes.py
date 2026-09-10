from __future__ import annotations

import importlib
import sys
import types
from datetime import date, datetime, timezone
from unittest import mock


_MODULES_TO_STUB = ["fastapi", "main", "wip_routes", "wip_analytics_routes", "earthworks_routes"]


def _merge_section(code):
    if code in {"UCH_31", "UCH_32"}:
        return "UCH_3"
    return code


def _expand_sections(value):
    if not value:
        return []
    raw = value if isinstance(value, list) else [item.strip() for item in str(value).split(",") if item.strip()]
    out = []
    for item in raw:
        if item == "UCH_3":
            out.extend(["UCH_3", "UCH_31", "UCH_32"])
        else:
            out.append(item)
    return out


def _parse_range(date_from=None, date_to=None):
    return date.fromisoformat(date_from or "2026-07-01"), date.fromisoformat(date_to or "2026-07-02")


def _install_stubs():
    saved = {name: sys.modules.get(name) for name in _MODULES_TO_STUB}
    for name in _MODULES_TO_STUB:
        sys.modules.pop(name, None)

    fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def __init__(self, *args, **kwargs):
            self.prefix = kwargs.get("prefix", "")
            self.tags = kwargs.get("tags", [])
            self.routes = []

        def get(self, path, *args, **kwargs):
            def decorator(fn):
                self.routes.append(types.SimpleNamespace(path=f"{self.prefix}{path}", endpoint=fn))
                return fn
            return decorator

    def Query(default=None, *args, **kwargs):
        return default

    fastapi.APIRouter = APIRouter
    fastapi.HTTPException = HTTPException
    fastapi.Query = Query
    sys.modules["fastapi"] = fastapi

    main = types.ModuleType("main")
    main.query = lambda *args, **kwargs: []
    main.query_one = lambda *args, **kwargs: {}
    sys.modules["main"] = main

    wip_routes = types.ModuleType("wip_routes")
    wip_routes._approved_report_exists = lambda alias: "TRUE"
    wip_routes._expand_sections = _expand_sections
    wip_routes._merge_section = _merge_section
    wip_routes._parse_range = _parse_range
    sys.modules["wip_routes"] = wip_routes

    analytics = types.ModuleType("wip_analytics_routes")
    analytics.WORK_TAG_EXPR = "COALESCE(NULLIF(BTRIM(dwi.analytics_tag), ''), NULLIF(BTRIM(wt.analytics_tag), ''))"
    analytics._analytics_segment_volume_expr = lambda alias: "COALESCE(seg.volume_segment, dwi.volume)"
    analytics._effective_section_join = lambda alias: "LEFT JOIN daily_work_item_segments seg ON seg.daily_work_item_id = dwi.id LEFT JOIN construction_sections cs_eff ON cs_eff.id = dwi.section_id"
    sys.modules["wip_analytics_routes"] = analytics

    module = importlib.import_module("earthworks_routes")
    return module, saved


def _restore_stubs(saved):
    sys.modules.pop("earthworks_routes", None)
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


def _load_module():
    module, saved = _install_stubs()
    return module, saved


def test_metric_id_round_trips_russian_metric_and_unit():
    module, saved = _load_module()
    try:
        metric_id = module._metric_id("Песок (Насыпь)", "м3")
        assert metric_id.startswith("metric:")
        assert module._decode_metric_id(metric_id) == ("Песок (Насыпь)", "м3")
    finally:
        _restore_stubs(saved)


def test_metric_values_do_not_emit_infinity_for_zero_plan():
    module, saved = _load_module()
    try:
        values = module._metric_values(plan_period=0, fact_before=5, fact_period=12, plan_total=40)
        assert values["fact_total"] == 17
        assert values["deviation"] == 12
        assert values["remaining"] == 23
        assert values["completion_pct"] is None
    finally:
        _restore_stubs(saved)


def test_filter_bundle_expands_section_3_and_decodes_metric():
    module, saved = _load_module()
    try:
        metric_id = module._metric_id("ПРС", "м3")
        with mock.patch.object(module, "_mstroy_pair_scopes", return_value=[(["TOPSOIL_STRIPPING"], ["TEMP_ROAD"])]):
            filters = module._filter_bundle(section_ids="UCH_3,UCH_5", metric_id=metric_id)
        assert filters["section_codes"] == ["UCH_3", "UCH_31", "UCH_32", "UCH_5"]
        assert filters["metric_tag"] == "ПРС"
        assert filters["metric_unit"] == "м3"
        assert filters["object_type_codes"] == module._mstroy_all_object_types()
        assert filters["mstroy_pair_scopes"] == [(["TOPSOIL_STRIPPING"], ["TEMP_ROAD"])]
    finally:
        _restore_stubs(saved)


def test_filter_bundle_decodes_mstroy_summary_work_and_object_type_tokens():
    module, saved = _load_module()
    try:
        with mock.patch.object(module, "_mstroy_pair_scopes", return_value=[(["EMBANKMENT_CONSTRUCTION"], ["MAIN_TRACK"])]):
            filters = module._filter_bundle(work_type_ids="summary-work:46", object_ids="type:MAIN_TRACK,type:PILE_FIELD")
        assert filters["summary_work_tokens"] == ["summary-work:46"]
        assert filters["work_type_ids"] == []
        assert filters["object_ids"] == []
        assert filters["object_type_codes"] == ["MAIN_TRACK", "PILE_FIELD"]
        assert filters["mstroy_pair_scopes"] == [(["EMBANKMENT_CONSTRUCTION"], ["MAIN_TRACK"])]
    finally:
        _restore_stubs(saved)


def test_filter_bundle_keeps_legacy_concrete_object_and_work_ids():
    module, saved = _load_module()
    try:
        filters = module._filter_bundle(work_type_ids="work-uuid", object_ids="type:TEMP_ROAD,obj-uuid")
        assert filters["work_type_ids"] == ["work-uuid"]
        assert filters["summary_work_tokens"] == []
        assert filters["object_ids"] == ["obj-uuid"]
        assert filters["object_type_codes"] == ["TEMP_ROAD"]
        assert filters["mstroy_pair_scopes"] == []
    finally:
        _restore_stubs(saved)


def test_mstroy_pair_scope_clause_limits_work_codes_by_object_types():
    module, saved = _load_module()
    try:
        params = []
        clause = module._mstroy_pair_scope_clause({"mstroy_pair_scopes": [(["ZS2"], ["MAIN_TRACK", "STATION_TRACK"]), (["PAVEMENT_SANDING"], ["TEMP_ROAD"])]}, params)
        assert "wt.code = ANY(%s)" in clause
        assert "ot.code = ANY(%s)" in clause
        assert params == [["ZS2"], ["MAIN_TRACK", "STATION_TRACK"], ["PAVEMENT_SANDING"], ["TEMP_ROAD"]]
    finally:
        _restore_stubs(saved)


def test_mstroy_meta_options_use_summary_sheet_fallback_order():
    module, saved = _load_module()
    try:
        with mock.patch.object(module, "_load_mstroy_graph_module", return_value=None), mock.patch.object(module, "_mstroy_summary_template_rows", return_value={}):
            module._mstroy_summary_scope_static.cache_clear()
            objects = module._mstroy_object_options()
            works = module._mstroy_work_options()
        assert objects[0]["id"] == "type:TEMP_ROAD"
        assert objects[0]["label"] == "Притрассовая дорога"
        assert works[0]["id"] == "summary-work:4"
        assert works[0]["label"] == "Снятие ПРС"
        assert "type:PIPE" in {item["id"] for item in objects}
    finally:
        module._mstroy_summary_scope_static.cache_clear()
        _restore_stubs(saved)


def test_overview_merges_uch31_and_uch32_into_single_section_3_row_without_double_count():
    module, saved = _load_module()
    try:
        detail_maps = {
            "keys": {
                ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"),
                ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"),
            },
            "plan_period": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"): 25, ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"): 7},
            "fact_before": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"): 5, ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"): 1},
            "fact_period": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"): 10, ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"): 1},
            "plan_total": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"): 100, ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"): 20},
            "object_labels": {("TEMP_ROAD", "road-1"): "АД 1", ("TEMP_ROAD", "road-2"): "АД 2"},
            "object_codes": {("TEMP_ROAD", "road-1"): "ROAD_1", ("TEMP_ROAD", "road-2"): "ROAD_2"},
            "section_codes": {"UCH_3": "UCH_3", "UCH_4": "UCH_4"},
            "metric_keys": {
                ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_3"): ("ПРС", "м3"),
                ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-2", "UCH_4"): ("ПРС", "м3"),
            },
            "last_fact_date": {("ПРС", "м3"): "2026-07-02"},
        }

        with (
            mock.patch.object(module, "query_one", return_value={"updated_at": datetime(2026, 7, 3, tzinfo=timezone.utc)}),
            mock.patch.object(module, "_build_detail_maps_cached", return_value=detail_maps),
        ):
            payload = module.earthworks_overview(date_from="2026-07-01", date_to="2026-07-02", grouping="sections")

        section_rows = [row for row in payload["periodRows"] if row["label"] == "Участок №3"]
        assert len(section_rows) == 1
        section_3 = section_rows[0]
        assert section_3["sourceIds"] == ["UCH_3", "UCH_31", "UCH_32"]
        assert section_3["values"]["plan_period"] == 25
        assert section_3["values"]["fact_before"] == 5
        assert section_3["values"]["fact_period"] == 10
        assert section_3["values"]["fact_total"] == 15
        assert payload["overallRows"][0]["values"]["plan_period"] == 32
        assert payload["selectedMetricTotals"]["lastFactDate"] == "2026-07-02"
        assert all("UCH_31" not in row["label"] and "UCH_32" not in row["label"] for row in payload["periodRows"])
    finally:
        _restore_stubs(saved)



def test_mstroy_tree_rows_group_by_work_then_object_category_then_object():
    module, saved = _load_module()
    try:
        detail_maps = {
            "keys": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1")},
            "plan_period": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1"): 25},
            "fact_before": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1"): 5},
            "fact_period": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1"): 10},
            "plan_total": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1"): 100},
            "object_labels": {("TEMP_ROAD", "road-1"): "Притрассовая дорога №1"},
            "object_codes": {("TEMP_ROAD", "road-1"): "ROAD_1"},
            "section_codes": {"UCH_1": "UCH_1"},
            "metric_keys": {("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1"): ("ПРС", "м3")},
            "last_fact_date": {},
        }
        with mock.patch.object(module, "_load_mstroy_graph_module", return_value=None):
            module._mstroy_summary_scope_static.cache_clear()
            rows = module._build_mstroy_tree_rows(detail_maps, grouping="objects", prefix="summary", filters={"summary_work_tokens": []})
        work = next(row for row in rows if row["id"] == "summary:summary-work:4")
        category = next(row for row in rows if row["parentId"] == work["id"] and row["label"] == "Объекты")
        leaf = next(row for row in rows if row["parentId"] == category["id"] and row["label"] == "Притрассовая дорога")
        obj = next(row for row in rows if row["parentId"] == leaf["id"])
        assert work["level"] == 0
        assert category["level"] == 1
        assert leaf["level"] == 2
        assert obj["level"] == 3
        assert work["values"]["fact_total"] == 15
        assert work["values"]["completion_total_pct"] == 15
        assert obj["label"] == "Притрассовая дорога №1"
    finally:
        module._mstroy_summary_scope_static.cache_clear()
        _restore_stubs(saved)


def test_detail_maps_move_project_only_unknown_section_to_single_fact_section():
    module, saved = _load_module()
    try:
        fact_row = {
            "work_code": "TOPSOIL_STRIPPING",
            "tag": "ПРС",
            "unit": "м3",
            "object_type_code": "TEMP_ROAD",
            "object_id": "road-1",
            "object_code": "ROAD_1",
            "object_label": "Притрассовая дорога №1",
            "raw_section_code": "UCH_1",
            "volume": 10,
            "last_fact_date": "2026-07-02",
        }
        project_row = dict(fact_row, raw_section_code=None, volume=100, last_fact_date=None)

        def fake_fact_rows(*args, before=False, **kwargs):
            return [] if before else [fact_row]

        with (
            mock.patch.object(module, "_plan_detail_rows", return_value=[]),
            mock.patch.object(module, "_fact_detail_rows", side_effect=fake_fact_rows),
            mock.patch.object(module, "_project_detail_rows", return_value=[project_row]),
        ):
            maps = module._build_detail_maps(date(2026, 7, 1), date(2026, 7, 2), {})

        concrete = ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "UCH_1")
        unknown = ("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1", "—")
        assert maps["plan_total"][concrete] == 100
        assert unknown not in maps["plan_total"]
        assert unknown not in maps["keys"]
        assert maps["section_overrides"][("TOPSOIL_STRIPPING", "TEMP_ROAD", "road-1")] == "UCH_1"
    finally:
        _restore_stubs(saved)


def test_mstroy_timeseries_aggregates_sections_until_specific_section_selected():
    module, saved = _load_module()
    try:
        fact_rows = [
            {"bucket": date(2026, 7, 1), "work_code": "TOPSOIL_STRIPPING", "object_type_code": "TEMP_ROAD", "raw_section_code": "UCH_1", "volume": 4},
            {"bucket": date(2026, 7, 2), "work_code": "TOPSOIL_STRIPPING", "object_type_code": "TEMP_ROAD", "raw_section_code": "UCH_1", "volume": 6},
        ]
        with (
            mock.patch.object(module, "_load_mstroy_graph_module", return_value=None),
            mock.patch.object(module, "_fact_bucket_detail_rows", return_value=fact_rows),
        ):
            module._mstroy_summary_scope_static.cache_clear()
            aggregate_payload = module._mstroy_timeseries_payload(
                date(2026, 7, 1),
                date(2026, 7, 2),
                {"summary_work_tokens": [], "section_codes": []},
                granularity="day",
                mode="cumulative",
                grouping="sections",
            )
            section_payload = module._mstroy_timeseries_payload(
                date(2026, 7, 1),
                date(2026, 7, 2),
                {"summary_work_tokens": [], "section_codes": ["UCH_1"]},
                granularity="day",
                mode="cumulative",
                grouping="sections",
            )
        assert aggregate_payload["series"][0]["id"] == "work:summary-work:4"
        assert aggregate_payload["series"][0]["label"].startswith("Снятие ПРС")
        aggregate_series_id = aggregate_payload["series"][0]["id"]
        assert aggregate_payload["points"][0]["values"][aggregate_series_id] == 4
        assert aggregate_payload["points"][1]["values"][aggregate_series_id] == 10

        assert section_payload["series"][0]["label"].startswith("Участок №1 / Снятие ПРС")
        assert section_payload["series"][0]["groupId"] == "summary-work:4"
        section_series_id = section_payload["series"][0]["id"]
        assert section_payload["points"][0]["values"][section_series_id] == 4
        assert section_payload["points"][1]["values"][section_series_id] == 10
    finally:
        module._mstroy_summary_scope_static.cache_clear()
        _restore_stubs(saved)
