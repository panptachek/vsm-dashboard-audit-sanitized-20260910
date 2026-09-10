#!/usr/bin/env python3
from __future__ import annotations

from datetime import date

import pytest
import wip_routes
import wip_analytics_routes


@pytest.fixture(autouse=True)
def disable_dashboard_response_cache(monkeypatch):
    monkeypatch.setattr(wip_routes, "_dashboard_response_cache_get", lambda *args, **kwargs: None)
    monkeypatch.setattr(wip_routes, "_dashboard_response_cache_stale_payload", lambda *args, **kwargs: None)
    monkeypatch.setattr(wip_routes, "_dashboard_response_cache_mark", lambda payload, *args, **kwargs: payload)
    monkeypatch.setattr(wip_routes, "_dashboard_response_cache_build_or_wait", lambda endpoint, cache_key, fingerprint, builder, **kwargs: builder())


def test_temp_roads_status_applies_state_corrections(monkeypatch):
    """Dashboard WIP temp-road state must include approved state corrections."""

    def fake_query(sql: str, params=None):
        if "FROM temporary_roads tr" in sql and "LEFT JOIN temporary_road_pk_mappings" in sql:
            return [
                {
                    "id": "road-1",
                    "code": "АДТЕСТ",
                    "name": "Тестовая дорога",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 1000,
                    "rail_pk_end": 1100,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 1000,
                    "m_rail_end": 1100,
                }
            ]
        if "FROM construction_section_versions csv" in sql:
            return []
        if "FROM temporary_road_status_segments" in sql:
            assert params == ("road-1", date(2026, 5, 26))
            return [
                {
                    "road_pk_start": 0,
                    "road_pk_end": 100,
                    "rail_pk_start": 1000,
                    "rail_pk_end": 1100,
                    "status_type": "subgrade_not_to_grade",
                    "is_demo": False,
                    "last_date": date(2026, 5, 25),
                }
            ]
        if "FROM temporary_road_state_corrections" in sql:
            assert params == ("road-1", date(2026, 5, 26))
            return [
                {
                    "road_pk_start": 20,
                    "road_pk_end": 40,
                    "rail_pk_start": None,
                    "rail_pk_end": None,
                    "action": "set_status",
                    "status_type": "shpgs_done",
                    "effective_date": date(2026, 5, 26),
                    "last_correction_date": date(2026, 5, 26),
                }
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.temp_roads_status(to="2026-05-26")
    road = result["roads"][0]

    shpgs_ranges = [
        (seg["ad_pk_start"], seg["ad_pk_end"])
        for seg in road["segments"]
        if seg["status_type"] == "shpgs_done"
    ]
    subgrade_ranges = [
        (seg["ad_pk_start"], seg["ad_pk_end"])
        for seg in road["segments"]
        if seg["status_type"] == "subgrade_not_to_grade"
    ]

    assert shpgs_ranges == [(20, 40)]
    assert subgrade_ranges == [(0, 20), (40, 100)]
    assert road["effective_date"] == "2026-05-26"


def test_temp_roads_newer_report_status_overrides_older_correction(monkeypatch):
    """A manual correction fixes state only up to its date; newer report facts can advance it."""

    def fake_query(sql: str, params=None):
        if "FROM temporary_roads tr" in sql and "LEFT JOIN temporary_road_pk_mappings" in sql:
            return [
                {
                    "id": "road-1",
                    "code": "АДТЕСТ",
                    "name": "Тестовая дорога",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 1000,
                    "rail_pk_end": 1100,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 1000,
                    "m_rail_end": 1100,
                }
            ]
        if "FROM construction_section_versions csv" in sql:
            return []
        if "FROM temporary_road_status_segments" in sql:
            assert params == ("road-1", date(2026, 5, 26))
            return [
                {
                    "road_pk_start": 40,
                    "road_pk_end": 60,
                    "rail_pk_start": None,
                    "rail_pk_end": None,
                    "status_date": date(2026, 5, 24),
                    "status_type": "pioneer_fill",
                    "is_demo": False,
                    "created_at": None,
                    "last_date": date(2026, 5, 26),
                },
                {
                    "road_pk_start": 50,
                    "road_pk_end": 70,
                    "rail_pk_start": None,
                    "rail_pk_end": None,
                    "status_date": date(2026, 5, 26),
                    "status_type": "subgrade_not_to_grade",
                    "is_demo": False,
                    "created_at": None,
                    "last_date": date(2026, 5, 26),
                },
            ]
        if "FROM temporary_road_state_corrections" in sql:
            assert params == ("road-1", date(2026, 5, 26))
            return [
                {
                    "road_pk_start": 50,
                    "road_pk_end": 60,
                    "rail_pk_start": None,
                    "rail_pk_end": None,
                    "action": "set_status",
                    "status_type": "pioneer_fill",
                    "effective_date": date(2026, 5, 25),
                    "created_at": None,
                    "last_correction_date": date(2026, 5, 25),
                }
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    road = wip_routes.temp_roads_status(to="2026-05-26")["roads"][0]
    pioneer_ranges = [
        (seg["ad_pk_start"], seg["ad_pk_end"])
        for seg in road["segments"]
        if seg["status_type"] == "pioneer_fill"
    ]
    subgrade_ranges = [
        (seg["ad_pk_start"], seg["ad_pk_end"])
        for seg in road["segments"]
        if seg["status_type"] == "subgrade_not_to_grade"
    ]

    assert pioneer_ranges == [(40, 50)]
    assert subgrade_ranges == [(50, 70)]


def test_temp_roads_status_includes_all_display_enabled_roads(monkeypatch):
    """All catalog roads are eligible for dashboard display when display_in_dashboard allows them."""

    queried_road_ids: list[str] = []

    def fake_query(sql: str, params=None):
        if "FROM temporary_roads tr" in sql and "LEFT JOIN temporary_road_pk_mappings" in sql:
            return [
                {
                    "id": "road-hidden",
                    "code": "АД16",
                    "name": "Скрытая дорога",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 1000,
                    "rail_pk_end": 1100,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 1000,
                    "m_rail_end": 1100,
                },
                {
                    "id": "road-ad15",
                    "code": "АД15",
                    "name": "АД15",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 1400,
                    "rail_pk_end": 1500,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 1400,
                    "m_rail_end": 1500,
                },
                {
                    "id": "road-hidden-tech",
                    "code": "ТЕХПРОЕЗД К АД13",
                    "name": "Техпроезд к АД13",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 1200,
                    "rail_pk_end": 1300,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 1200,
                    "m_rail_end": 1300,
                },
                {
                    "id": "road-visible",
                    "code": "АД9",
                    "name": "Видимая дорога",
                    "ad_pk_start": 0,
                    "ad_pk_end": 100,
                    "rail_pk_start": 2000,
                    "rail_pk_end": 2100,
                    "length_m": 100,
                    "m_ad_start": 0,
                    "m_ad_end": 100,
                    "m_rail_start": 2000,
                    "m_rail_end": 2100,
                },
            ]
        if "FROM construction_section_versions csv" in sql:
            return []
        if "FROM temporary_road_status_segments" in sql:
            queried_road_ids.append(params[0])
            return []
        if "FROM temporary_road_state_corrections" in sql:
            queried_road_ids.append(params[0])
            return []
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.temp_roads_status(to="2026-05-26")

    assert [road["code"] for road in result["roads"]] == ["АД16", "АД15", "ТЕХПРОЕЗД К АД13", "АД9"]
    assert queried_road_ids == [
        "road-hidden", "road-hidden",
        "road-ad15", "road-ad15",
        "road-hidden-tech", "road-hidden-tech",
        "road-visible", "road-visible",
    ]


def test_temp_roads_status_payload_can_include_display_excluded_for_database(monkeypatch):
    """Database admin payload must include display-excluded roads while public dashboard still hides them."""

    queried_road_ids: list[str] = []

    def fake_query(sql: str, params=None):
        if "FROM temporary_roads tr" in sql and "LEFT JOIN temporary_road_pk_mappings" in sql:
            return [
                {
                    "id": "road-hidden",
                    "code": "АД16",
                    "name": "АД16",
                    "ad_pk_start": 1500,
                    "ad_pk_end": 1600,
                    "rail_pk_start": 2500,
                    "rail_pk_end": 2600,
                    "length_m": 100,
                    "m_ad_start": 1500,
                    "m_ad_end": 1600,
                    "m_rail_start": 2500,
                    "m_rail_end": 2600,
                },
                {
                    "id": "road-visible",
                    "code": "АД9",
                    "name": "АД9",
                    "ad_pk_start": 900,
                    "ad_pk_end": 1000,
                    "rail_pk_start": 1900,
                    "rail_pk_end": 2000,
                    "length_m": 100,
                    "m_ad_start": 900,
                    "m_ad_end": 1000,
                    "m_rail_start": 1900,
                    "m_rail_end": 2000,
                },
            ]
        if "FROM construction_section_versions csv" in sql:
            return []
        if "FROM temporary_road_status_segments" in sql:
            queried_road_ids.append(params[0])
            return []
        if "FROM temporary_road_state_corrections" in sql:
            queried_road_ids.append(params[0])
            return []
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes._temp_roads_status_payload(to="2026-05-26", include_display_excluded=True)

    assert [road["code"] for road in result["roads"]] == ["АД16", "АД9"]
    assert result["roads"][0]["display_locked"] is False
    assert result["roads"][1]["display_locked"] is False
    assert queried_road_ids == ["road-hidden", "road-hidden", "road-visible", "road-visible"]


def test_mainline_scheme_context_clips_objects_and_marks_rd(monkeypatch):
    sections = {
        "section-1": {
            "section_id": "section-1",
            "section_code": "UCH_1",
            "ranges": [{"pk_start": 0, "pk_end": 100}],
        }
    }
    monkeypatch.setattr(wip_routes, "_wip_table_exists", lambda table: table in {"mainline_rd_coverage", "mainline_work_schedule_ranges"})
    monkeypatch.setattr(wip_routes, "_query_mainline_scheme_related_object_rows", lambda: [
        {
            "object_id": "obj-1",
            "object_code": "PF_TEST",
            "object_name": "Свайное поле тест",
            "object_type_code": "PILE_FIELD",
            "object_type_name": "Свайное поле",
            "object_group": "pile_field",
            "object_group_label": "Свайное поле",
            "pk_start": 20,
            "pk_end": 80,
        },
        {
            "object_id": "obj-2",
            "object_code": "PIPE_TEST",
            "object_name": "Труба тест",
            "object_type_code": "PIPE",
            "object_type_name": "Труба",
            "object_group": "pipe",
            "object_group_label": "Труба",
            "pk_start": 100,
            "pk_end": 100,
        },
    ])
    monkeypatch.setattr(wip_routes, "_query_mainline_scheme_rd_rows", lambda: [
        {
            "id": "rd-1",
            "section_id": None,
            "section_code": None,
            "object_id": "obj-1",
            "object_type_code": None,
            "pk_start": 20,
            "pk_end": 50,
            "rd_code": "RD-1",
            "rd_title": "РД 1",
            "issued_at": date(2026, 8, 1),
            "comment": None,
        }
    ])
    monkeypatch.setattr(wip_routes, "_query_mainline_scheme_schedule_rows", lambda: [
        {
            "id": "sw-1",
            "section_id": "section-1",
            "section_code": "UCH_1",
            "object_id": "obj-1",
            "object_type_code": None,
            "pk_start": 20,
            "pk_end": 80,
            "required_start_date": date(2026, 9, 1),
            "required_finish_date": date(2026, 9, 3),
            "schedule_label": "Окно",
            "comment": "test",
        }
    ])

    flags = wip_routes._attach_mainline_scheme_context_to_sections(sections)
    rows = sections["section-1"]["related_objects"]

    assert flags == {"rd_schema_ready": True, "schedule_schema_ready": True}
    assert [row["object_code"] for row in rows] == ["PF_TEST", "PIPE_TEST"]
    assert rows[0]["rd_status"] == "partial"
    assert rows[0]["rd_documents"][0]["rd_code"] == "RD-1"
    assert rows[0]["required_start_date"] == "2026-09-01"
    assert rows[0]["required_finish_date"] == "2026-09-03"
    assert rows[1]["rd_status"] == "missing"


def test_mainline_pipe_pk_from_text_supports_names_and_codes():
    assert wip_routes._mainline_pipe_pk_from_text("ПБЖТ 1,5х2,0 ПК3286+87.91") == pytest.approx(328687.91)
    assert wip_routes._mainline_pipe_pk_from_text("PIPE_265634") == pytest.approx(265634.0)
    assert wip_routes._mainline_pipe_pk_from_text("PIPE_ARRANGEMENT_287506_50") == pytest.approx(287506.50)
    assert wip_routes._mainline_pipe_pk_from_text("без пикета") is None


def test_query_mainline_scheme_related_object_rows_keeps_segmentless_pipes(monkeypatch):
    def fake_query(sql: str, params=None):
        assert "OR ot.code = 'PIPE'" in sql
        return [
            {
                "object_id": "pipe-1",
                "object_code": "PIPE_265634",
                "object_name": "ПБЖТ 1,5х2,0 ПК2656+34",
                "object_comment": None,
                "object_type_code": "PIPE",
                "object_type_name": "Водопропускная труба",
                "pk_start": None,
                "pk_end": None,
            },
            {
                "object_id": "bridge-1",
                "object_code": "BRIDGE_WITHOUT_PK",
                "object_name": "Мост без пикета",
                "object_comment": None,
                "object_type_code": "BRIDGE",
                "object_type_name": "Мост",
                "pk_start": None,
                "pk_end": None,
            },
        ]

    monkeypatch.setattr(wip_routes, "query", fake_query)

    rows = wip_routes._query_mainline_scheme_related_object_rows()

    assert len(rows) == 1
    assert rows[0]["object_name"] == "ПБЖТ 1,5х2,0 ПК2656+34"
    assert rows[0]["object_group"] == "pipe"
    assert rows[0]["pk_start"] == pytest.approx(265634.0)
    assert rows[0]["pk_end"] == pytest.approx(265634.0)


def test_database_temp_road_fill_corrections_includes_display_excluded_roads(monkeypatch):
    def fake_status_payload(to=None, *, include_display_excluded=False):
        assert include_display_excluded is True
        return {"as_of": to, "roads": [{"id": "road-hidden", "code": "АД15", "segments": []}]}

    def fake_query(sql: str, params=None):
        if "FROM temporary_road_state_corrections c" in sql:
            return [
                {
                    "id": "corr-1",
                    "road_id": "road-hidden",
                    "road_code": "АД15",
                    "road_name": "АД15",
                    "effective_date": date(2026, 5, 26),
                    "action": "set_status",
                    "status_type": "ready_for_shpgs",
                    "input_pk_system": "both",
                    "road_pk_start": 1500,
                    "road_pk_end": 1600,
                    "rail_pk_start": 2500,
                    "rail_pk_end": 2600,
                    "comment": "test",
                    "created_at": None,
                }
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "_temp_roads_status_payload", fake_status_payload)
    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.database_temp_road_fill_corrections(to="2026-05-26", _user=object())

    assert [road["code"] for road in result["roads"]] == ["АД15"]
    assert [row["road_code"] for row in result["corrections"]] == ["АД15"]


def test_daily_summary_work_object_totals_split_sand_and_excavation(monkeypatch):
    def fake_query(sql: str, params=None):
        assert "FROM daily_work_items dwi" in sql
        assert "LEFT JOIN object_types ot" in sql
        return [
            {"wt_code": "EMBANKMENT_CONSTRUCTION", "analytics_tag": "Песок (Насыпь)", "object_type_code": "MAIN_TRACK", "volume": 10},
            {"wt_code": "WEAK_SOIL_REPLACEMENT", "analytics_tag": "Песок (Замена)", "object_type_code": "TEMP_ROAD", "volume": 20},
            {"wt_code": "EARTH_EXCAVATION", "analytics_tag": "Выемка", "object_type_code": "MAIN_TRACK", "volume": 30},
            {"wt_code": "PEAT_REMOVAL", "analytics_tag": "Выторфовка", "object_type_code": "TEMP_ROAD", "volume": 40},
            {"wt_code": "EXCAVATION_MAIN", "analytics_tag": "Выемка", "object_type_code": "PIPE", "volume": 5},
            {"wt_code": "OTHER", "analytics_tag": "Выторфовка", "object_type_code": "SERVICE_ROAD", "volume": 7},
        ]

    monkeypatch.setattr(wip_analytics_routes, "query", fake_query)

    totals = wip_analytics_routes._daily_summary_work_object_totals(date(2026, 5, 1), date(2026, 5, 26))

    assert totals == {
        "sand_oh_m3": 10.0,
        "sand_vad_m3": 20.0,
        "sand_other_m3": 0.0,
        "excavation_oh_m3": 30.0,
        "excavation_vad_m3": 47.0,
        "excavation_other_m3": 5.0,
        "excavation_total_m3": 82.0,
    }


def test_analytics_segment_volume_expr_scales_segments_to_parent_fact():
    join_sql = wip_analytics_routes._effective_section_join("seg")
    volume_sql = wip_analytics_routes._analytics_segment_volume_expr("seg")

    assert "volume_segment_sum" in join_sql
    assert "missing_volume_cnt" in join_sql
    assert "LEFT JOIN daily_reports dr_eff_section" in join_sql
    assert "cs_report.id = COALESCE(dwi.section_id, dr_eff_section.section_id)" in join_sql
    assert "cs_report.id,\n            cs_override.id,\n            effective_section.section_id" in join_sql
    assert "WHEN ot.code = 'SERVICE_ROAD' THEN cs_report.id" not in join_sql
    assert "COALESCE(dwi.volume, 0) *" in volume_sql
    assert "seg.volume_segment" in volume_sql
    assert "NULLIF(seg_count.cnt, 0)" in volume_sql


def test_daily_summary_stage3_is_derived_from_temp_roads_status_payload(monkeypatch):
    def fake_status_payload(to, *, include_display_excluded=False):
        assert to == "2026-05-26"
        assert include_display_excluded is True
        return {
            "as_of": to,
            "roads": [
                {
                    "id": "road-1",
                    "code": "АДТЕСТ",
                    "name": "Проектная дорога",
                    "display_in_dashboard": True,
                    "ad_pk_start": 0,
                    "ad_pk_end": 1000,
                    "length_m": 1000,
                    "sections": [
                        {"section_num": 1, "ad_pk_start": 0, "ad_pk_end": 600},
                        {"section_num": 2, "ad_pk_start": 600, "ad_pk_end": 1000},
                    ],
                    "segments": [
                        {"ad_pk_start": 0, "ad_pk_end": 300, "status_type": "shpgs_done"},
                        {"ad_pk_start": 300, "ad_pk_end": 500, "status_type": "ready_for_shpgs"},
                        {"ad_pk_start": 800, "ad_pk_end": 1000, "status_type": "pioneer_fill"},
                    ],
                },
                {
                    "id": "road-driveway",
                    "code": "АД15",
                    "name": "Проезд АД15",
                    "display_in_dashboard": False,
                    "ad_pk_start": 0,
                    "ad_pk_end": 200,
                    "length_m": 200,
                    "sections": [
                        {"section_num": 1, "ad_pk_start": 0, "ad_pk_end": 200},
                    ],
                    "segments": [
                        {"ad_pk_start": 0, "ad_pk_end": 100, "status_type": "ready_for_shpgs"},
                    ],
                },
            ],
        }

    wip_analytics_routes._TEMP_ROADS_STAGE3_CACHE.clear()
    monkeypatch.setattr(wip_analytics_routes, "_temp_roads_status_payload", fake_status_payload)

    stage3 = wip_analytics_routes._temp_roads_stage3_from_status_payload(date(2026, 5, 26))

    assert stage3["total_length_m"] == 1000
    assert stage3["passable_m"] == 700
    assert stage3["completed_m"] == 300
    assert stage3["ready_m"] == 200
    assert stage3["ready_plus_done_m"] == 500
    assert stage3["project"]["total_length_m"] == 1000
    assert stage3["driveways"]["total_length_m"] == 200
    assert stage3["driveways"]["passable_m"] == 100
    assert stage3["driveways"]["ready_plus_done_m"] == 100
    assert stage3["combined"]["total_length_m"] == 1200
    assert stage3["combined"]["passable_m"] == 800
    assert stage3["combined"]["ready_plus_done_m"] == 600

    project_section_1 = stage3["project"]["sections"][0]
    assert project_section_1["length_m"] == 600
    assert project_section_1["passable_m"] == 500
    assert project_section_1["completed_m"] == 300
    assert project_section_1["ready_m"] == 200
    assert project_section_1["ready_plus_done_m"] == 500
    assert project_section_1["pct_ready_plus_done"] == 83.3
    assert project_section_1["details"][0]["road_code"] == "АДТЕСТ"
    assert project_section_1["details"][0]["group"] == "project"

    driveway_section_1 = stage3["driveways"]["sections"][0]
    assert driveway_section_1["length_m"] == 200
    assert driveway_section_1["passable_m"] == 100
    assert driveway_section_1["ready_plus_done_m"] == 100
    assert driveway_section_1["details"][0]["road_code"] == "АД15"
    assert driveway_section_1["details"][0]["group"] == "driveways"

    combined_section_1 = stage3["combined"]["sections"][0]
    assert combined_section_1["length_m"] == 800
    assert combined_section_1["passable_m"] == 600
    assert combined_section_1["ready_plus_done_m"] == 600
    assert [detail["road_code"] for detail in combined_section_1["details"]] == ["АДТЕСТ", "АД15"]

    project_section_2 = stage3["project"]["sections"][1]
    assert project_section_2["length_m"] == 400
    assert project_section_2["passable_m"] == 200
    assert project_section_2["pct_ready_plus_done"] == 0.0
