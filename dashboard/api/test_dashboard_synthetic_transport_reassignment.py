from __future__ import annotations

from datetime import date
from collections import defaultdict

import pytest

import wip_routes


def test_productivity_norm_is_prorated_by_work_hours():
    assert wip_routes._adjust_productivity_norm(110.0, 5.5) == (55.0, 5.5)
    assert wip_routes._adjust_productivity_norm(110.0, None) == (110.0, 11.0)


def _fake_sand_work_by_section(d_from: date, d_to: date) -> dict[str, float]:
    return {
        "UCH_1": 100.0,
        "UCH_2": 100.0,
        "UCH_6": 100.0,
    }


def test_quarry_display_name_merges_migoloshi_spelling_variants_with_material_suffix():
    assert wip_routes._quarry_display_name("карьер Миголоши (ЩПГС)") == "Миголощи"
    assert wip_routes._quarry_display_name("Карьер Миголощи") == "Миголощи"
    assert wip_routes._quarry_display_name("карьер Милогоши") == "Миголощи"
    assert wip_routes._quarry_source_group_key("Миголоши (ЩПГС)") == wip_routes._quarry_source_group_key("Миголощи")


def test_dashboard_synthetic_sand_reassigns_known_hired_quarry_volumes(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(wip_routes, "_dashboard_sand_work_by_section", _fake_sand_work_by_section)

    rows, share = wip_routes._dashboard_synthetic_sand_rows(
        wip_routes.DASHBOARD_HISTORICAL_SAND_START,
        wip_routes.DASHBOARD_HISTORICAL_SAND_END,
    )

    assert share == 1.0
    sand_rows = [row for row in rows if row["material"] == "SAND"]
    historical_total, _, _ = wip_routes._load_dashboard_synthetic_transport_material("SAND")
    assert round(sum(float(row["volume"]) for row in sand_rows), 2) == round(historical_total, 2)

    hired = defaultdict(float)
    zhds_by_quarry = defaultdict(float)
    for row in sand_rows:
        key = (row["quarry_name"], row["section_code"])
        if row["contractor_bucket"] == "hire":
            hired[key] += float(row["volume"])
            assert row["contractor_short"] == "Наёмники"
            assert row["contractor_kind"] == "subcontractor"
        if row["contractor_bucket"] == "zhds":
            zhds_by_quarry[row["quarry_name"]] += float(row["volume"])

    assert {
        ("Южные Маяки", "UCH_6"),
        ("Боровенка", "UCH_1"),
        ("Зорька 2", "UCH_1"),
        ("Боровенка", "UCH_2"),
        ("Зорька 2", "UCH_2"),
    }.issubset(set(hired))
    assert all(volume > 0 for volume in hired.values())
    assert round(zhds_by_quarry["Южные Маяки"], 2) == 0.0
    assert round(zhds_by_quarry["Боровенка"], 2) > 0.0
    assert round(zhds_by_quarry["Зорька 2"], 2) > 0.0


def test_dashboard_synthetic_transport_material_can_be_loaded_from_db_payload(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "materials": {
            "SAND": {
                "historical_total_m3": 321.5,
                "quarry_rows": [],
                "fixed_section_rows": [
                    {
                        "section_code": "uch_5",
                        "quarry_name": "карьер Боровенка-3",
                        "volume_m3": 123.4,
                        "bucket": "hire",
                        "contractor_name": "Наемники",
                    },
                    {
                        "section_code": "UCH_6",
                        "quarry_name": "карьер «Великий» АЛМАЗ",
                        "volume_m3": 198.1,
                        "bucket": "almaz",
                    },
                ],
            }
        }
    }
    monkeypatch.setattr(wip_routes, "query_one", lambda *args, **kwargs: {"payload": payload})

    historical_total, quarry_rows, fixed_rows = wip_routes._load_dashboard_synthetic_transport_material("SAND")

    assert historical_total == 321.5
    assert quarry_rows == []
    assert fixed_rows == [
        ("Боровенка", 123.4, "hire", "Наёмники", "UCH_5", None, None),
        ("Великий", 198.1, "almaz", "ООО «АЛМАЗ»", "UCH_6", None, None),
    ]

def test_dashboard_synthetic_transport_row_reference_from_is_honored(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "materials": {
            "SAND": {
                "historical_total_m3": 100.0,
                "quarry_rows": [],
                "fixed_section_rows": [
                    {
                        "section_code": "UCH_1",
                        "quarry_name": "карьер Заозерье-АЛМАЗ",
                        "volume_m3": 100.0,
                        "bucket": "almaz",
                        "reference_from": "2026-05-10",
                        "reference_to": "2026-06-02",
                    }
                ],
            }
        }
    }

    def fake_query_one(*args, **kwargs):
        return {"payload": payload}

    def fake_sand_work_by_section(d_from: date, d_to: date) -> dict[str, float]:
        if d_to < date(2026, 5, 10) or d_from > date(2026, 6, 2):
            return {}
        return {"UCH_1": 100.0}

    monkeypatch.setattr(wip_routes, "query_one", fake_query_one)
    monkeypatch.setattr(wip_routes, "_dashboard_sand_work_by_section", fake_sand_work_by_section)

    rows, share = wip_routes._dashboard_synthetic_sand_rows(date(2025, 9, 1), date(2026, 6, 2))
    zao_rows = [row for row in rows if row["quarry_name"] == "Заозерье"]

    assert share == 1.0
    assert len(zao_rows) == 1
    assert zao_rows[0]["report_date_from"] == "2026-05-10"
    assert zao_rows[0]["report_date_to"] == "2026-06-02"
    assert zao_rows[0]["volume"] == 100.0

    before_rows, _ = wip_routes._dashboard_synthetic_sand_rows(date(2025, 9, 1), date(2026, 5, 9))
    assert [row for row in before_rows if row["quarry_name"] == "Заозерье"] == []


def test_dashboard_sand_supply_split_uses_non_almaz_synthetic_sources(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "materials": {
            "SAND": {
                "historical_total_m3": 321.5,
                "quarry_rows": [],
                "fixed_section_rows": [
                    {
                        "section_code": "UCH_5",
                        "quarry_name": "карьер Боровенка-3",
                        "volume_m3": 123.4,
                        "bucket": "hire",
                    },
                    {
                        "section_code": "UCH_6",
                        "quarry_name": "карьер Великий",
                        "volume_m3": 198.1,
                        "bucket": "almaz",
                    },
                ],
            }
        }
    }
    monkeypatch.setattr(wip_routes, "query_one", lambda *args, **kwargs: {"payload": payload})

    split = wip_routes._dashboard_sand_supply_split([
        {
            "material": "SAND",
            "movement_type": "pit_to_constructive",
            "source_group_key": wip_routes._quarry_source_group_key("Боровенка"),
            "volume": 123.4,
        },
        {
            "material": "SAND",
            "movement_type": "pit_to_stockpile",
            "source_group_key": wip_routes._quarry_source_group_key("Боровенка"),
            "volume": 10.0,
        },
        {
            "material": "SAND",
            "movement_type": "pit_to_constructive",
            "source_group_key": wip_routes._quarry_source_group_key("Великий"),
            "volume": 198.1,
        },
        {
            "material": "SHPGS",
            "movement_type": "pit_to_constructive",
            "source_group_key": wip_routes._quarry_source_group_key("Боровенка"),
            "volume": 50.0,
        },
    ])

    assert split == {
        "total_m3": 331.5,
        "self_purchase_m3": 133.4,
        "customer_supplied_m3": 198.1,
    }
