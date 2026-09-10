#!/usr/bin/env python3
from __future__ import annotations

from datetime import date

import wip_routes


def test_reinforcement_summary_pile_totals_exclude_dynamic_tests(monkeypatch):
    """Dashboard pile plan/fact totals must match the XLSX report: main + trial only.

    Dynamic tests remain available in dyn/plan_dyn, but they are not driven piles and
    must not inflate day/month plan_total or chart totals.
    """

    def fake_query(sql: str, params=None):
        if "GROUP BY cs_eff_kpi.code, wt.code" in sql:
            return [
                {"section_code": "UCH_1", "wt_code": "PILE_MAIN", "cnt": 2},
                {"section_code": "UCH_1", "wt_code": "PILE_DYNTEST", "cnt": 5},
                {"section_code": "UCH_1", "wt_code": "PILE_HEADCAP_INSTALLATION", "cnt": 7},
            ]
        if "FROM pile_plan_periods ppp" in sql and "gs.day::date" not in sql:
            return [
                {
                    "section_code": "UCH_1",
                    "main_cnt": 10,
                    "test_cnt": 3,
                    "dyn_cnt": 4,
                    "headcap_cnt": 9,
                }
            ]
        if "GROUP BY cs_eff_calendar.code, dwi.report_date, wt.code" in sql:
            return [
                {"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_MAIN", "cnt": 2},
                {"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_DYNTEST", "cnt": 5},
                {"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_HEADCAP_INSTALLATION", "cnt": 7},
            ]
        if "GROUP BY cs_eff_day_detail.code" in sql:
            return []
        if "GROUP BY cs_eff_length_calendar.code, dwi.report_date, wt.code, pf.pile_type" in sql:
            return []
        if "GROUP BY cs.code, dwi.report_date, wt.code, specs.pile_length_m" in sql:
            return []
        if "FROM pile_plan_periods ppp" in sql and "cs.code AS section_code" in sql and "gs.day::date" in sql:
            return [
                {
                    "section_code": "UCH_1",
                    "d": date(2026, 6, 5),
                    "main_cnt": 10,
                    "test_cnt": 3,
                    "dyn_cnt": 4,
                    "headcap_cnt": 9,
                }
            ]
        if "cs_plan_detail.code AS section_code" in sql:
            return []
        if "GROUP BY cs_eff_dyn.code, dwi.report_date" in sql:
            assert "'PILE_DYNTEST'" not in sql
            assert "'PILE_HEADCAP_INSTALLATION'" not in sql
            return [{"section_code": "UCH_1", "d": date(2026, 6, 5), "cnt": 2}]
        if "SELECT gs.day::date AS d" in sql:
            assert "planned_dynamic_tests" not in sql
            return [{"d": date(2026, 6, 5), "cnt": 13}]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.reinforcement_sections_summary(date="2026-06-05", mode="date")
    section = result["sections"][0]
    day = result["calendar"]["rows"][0]["days"]["2026-06-05"]
    day_total = result["calendar"]["totals_by_day"]["2026-06-05"]
    dynamic_today = next(item for item in result["dynamic"] if item["date"] == "2026-06-05")

    assert section["dyn"] == 5
    assert section["headcaps"] == 7
    assert section["plan_dyn"] == 4
    assert section["plan_headcaps"] == 9
    assert section["total"] == 2
    assert section["plan_total"] == 13

    assert day["dyn"] == 5
    assert day["headcaps"] == 7
    assert day["plan_dyn"] == 4
    assert day["plan_headcaps"] == 9
    assert day["total"] == 2
    assert day["plan_total"] == 13
    assert day_total["total"] == 2
    assert day_total["plan_total"] == 13
    assert dynamic_today["total"] == 2
    assert dynamic_today["plan"] == 13


def test_reinforcement_summary_exposes_daily_pile_lengths(monkeypatch):
    def fake_query(sql: str, params=None):
        if "GROUP BY cs_eff_kpi.code, wt.code" in sql:
            return [{"section_code": "UCH_1", "wt_code": "PILE_MAIN", "cnt": 3}]
        if "FROM pile_plan_periods ppp" in sql and "gs.day::date" not in sql:
            return []
        if "GROUP BY cs_eff_calendar.code, dwi.report_date, wt.code" in sql:
            return [{"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_MAIN", "cnt": 3}]
        if "GROUP BY cs_eff_day_detail.code" in sql:
            return [
                {
                    "section_code": "UCH_1",
                    "d": date(2026, 6, 5),
                    "field_name": "13_1Т",
                    "pk_start": 311800,
                    "pk_end": 311900,
                    "pk_raw_text": "ПК3118+00 - ПК3119+00",
                    "main_cnt": 2,
                    "test_cnt": 1,
                    "dyn_cnt": 0,
                    "headcap_cnt": 0,
                    "report_count": 1,
                }
            ]
        if "GROUP BY cs_eff_length_calendar.code, dwi.report_date, wt.code, pf.pile_type" in sql:
            return [
                {"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_MAIN", "pile_type": "С120-35", "cnt": 2},
                {"section_code": "UCH_1", "d": date(2026, 6, 5), "wt_code": "PILE_TRIAL", "pile_type": "С180-35", "cnt": 1},
            ]
        if "GROUP BY cs.code, dwi.report_date, wt.code, specs.pile_length_m" in sql:
            return []
        if "FROM pile_plan_periods ppp" in sql and "cs.code AS section_code" in sql and "gs.day::date" in sql:
            return []
        if "cs_plan_detail.code AS section_code" in sql:
            return [
                {
                    "section_code": "UCH_1",
                    "d": date(2026, 6, 5),
                    "field_name": "13_1Т",
                    "pk_start": 311800,
                    "pk_end": 311900,
                    "pk_raw_text": "ПК3118+00 - ПК3119+00",
                    "main_cnt": 2,
                    "test_cnt": 1,
                    "dyn_cnt": 0,
                    "headcap_cnt": 0,
                    "report_count": 1,
                }
            ]
        if "GROUP BY cs_eff_dyn.code, dwi.report_date" in sql:
            return []
        if "SELECT gs.day::date AS d" in sql:
            return []
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.reinforcement_sections_summary(date="2026-06-05", mode="date")
    day = result["calendar"]["rows"][0]["days"]["2026-06-05"]
    day_total = result["calendar"]["totals_by_day"]["2026-06-05"]

    assert day["fact_lengths"] == [
        {"length_m": 12, "count": 2.0},
        {"length_m": 18, "count": 1.0},
    ]
    assert day_total["fact_lengths"] == [
        {"length_m": 12, "count": 2.0},
        {"length_m": 18, "count": 1.0},
    ]
    assert day["fact_details"][0]["field_name"] == "13_1Т"
    assert day["fact_details"][0]["pk_range"] == "ПК3118+00 - ПК3119+00"
    assert day["plan_details"][0]["field_name"] == "13_1Т"
    assert day_total["fact_details"][0]["field_name"] == "13_1Т"
    assert day_total["plan_details"][0]["field_name"] == "13_1Т"


def test_pile_delivery_summary_exposes_display_code_without_pile_prefix(monkeypatch):
    def fake_exists(table_name: str) -> bool:
        return table_name in {"pile_delivery_calendar", "pile_delivery_specs"}

    def fake_query(sql: str, params=None):
        if "FROM pile_delivery_calendar pdc" in sql:
            return [
                {
                    "d": date(2026, 6, 24),
                    "supplier_name": "МС-11",
                    "spec_display": "12 м НС",
                    "raw_spec_text": "PILE_12M_NS",
                    "spec_code": "PILE_12M_NS",
                    "length_m": 12,
                    "placement_side": "ns",
                    "planned_qty": 72,
                    "actual_qty": 80,
                },
                {
                    "d": date(2026, 6, 25),
                    "supplier_name": "МС-11",
                    "spec_display": "12 м НС",
                    "raw_spec_text": "PILE_12M_NS",
                    "spec_code": "PILE_12M_NS",
                    "length_m": 12,
                    "placement_side": "ns",
                    "planned_qty": 10,
                    "actual_qty": 0,
                },
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "_wip_table_exists", fake_exists)
    monkeypatch.setattr(wip_routes, "query", fake_query)

    summary = wip_routes.pile_deliveries_summary(date="2026-06-24")

    row = summary["rows"][0]
    assert row["spec_code"] == "PILE_12M_NS"
    assert row["spec_code_display"] == "12M_NS"
    assert row["days"]["2026-06-24"] == {"plan": 72.0, "fact": 80.0}
    assert row["days"]["2026-06-25"] == {"plan": 10.0, "fact": 0.0}
    assert summary["totals_by_day"]["2026-06-24"] == {"plan": 72.0, "fact": 80.0}
    assert summary["totals"]["day_plan"] == 72.0
    assert summary["totals"]["day_fact"] == 80.0
    assert summary["totals"]["month_plan"] == 82.0
    assert summary["totals"]["month_fact"] == 80.0
