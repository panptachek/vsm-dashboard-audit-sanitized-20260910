#!/usr/bin/env python3
from __future__ import annotations

from datetime import date

import wip_routes


def test_pile_deliveries_summary_returns_unavailable_when_table_missing(monkeypatch):
    monkeypatch.setattr(wip_routes, "_wip_table_exists", lambda table_name: False)

    result = wip_routes.pile_deliveries_summary(date="2026-06-24")

    assert result["available"] is False
    assert result["month"] == "2026-06"
    assert result["rows"] == []
    assert result["totals"]["month_plan"] == 0
    assert result["legend"] == ["НС — низовые сваи", "ВС — верховые сваи"]


def test_pile_deliveries_summary_aggregates_plan_and_fact(monkeypatch):
    def fake_table_exists(table_name: str) -> bool:
        return table_name in {"pile_delivery_calendar", "pile_delivery_specs"}

    def fake_query(sql: str, params=None):
        assert "FROM pile_delivery_calendar pdc" in sql
        return [
            {
                "d": date(2026, 6, 24),
                "supplier_name": "МС-11",
                "spec_display": "12 м НС",
                "raw_spec_text": "12 м НС",
                "spec_code": "PILE_12M_NS",
                "length_m": 12,
                "placement_side": "ns",
                "exclude_from_totals": True,
                "planned_qty": 72,
                "actual_qty": 80,
            },
            {
                "d": date(2026, 6, 25),
                "supplier_name": "МС-11",
                "spec_display": "12 м НС",
                "raw_spec_text": "12 м НС",
                "spec_code": "PILE_12M_NS",
                "length_m": 12,
                "placement_side": "ns",
                "exclude_from_totals": True,
                "planned_qty": 80,
                "actual_qty": 0,
            },
            {
                "d": date(2026, 6, 24),
                "supplier_name": "ПСК",
                "spec_display": "21 м",
                "raw_spec_text": "21 м",
                "spec_code": "PILE_21M",
                "length_m": 21,
                "placement_side": None,
                "exclude_from_totals": False,
                "planned_qty": 8,
                "actual_qty": 10,
            },
        ]

    monkeypatch.setattr(wip_routes, "_wip_table_exists", fake_table_exists)
    monkeypatch.setattr(wip_routes, "query", fake_query)

    result = wip_routes.pile_deliveries_summary(date="2026-06-24")

    assert result["available"] is True
    assert result["totals"]["day_plan"] == 8
    assert result["totals"]["day_fact"] == 10
    assert result["totals"]["month_plan"] == 8
    assert result["totals"]["month_fact"] == 10
    assert result["totals"]["delta_month"] == 2

    first_row = result["rows"][0]
    assert first_row["supplier"] == "МС-11"
    assert first_row["spec_display"] == "12 м НС"
    assert first_row["days"]["2026-06-24"] == {"plan": 72.0, "fact": 80.0}
    assert first_row["days"]["2026-06-25"] == {"plan": 80.0, "fact": 0.0}

    total_day = result["totals_by_day"]["2026-06-24"]
    assert total_day == {"plan": 8.0, "fact": 10.0}
    assert first_row["exclude_from_totals"] is True
