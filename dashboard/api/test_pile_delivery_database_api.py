#!/usr/bin/env python3
from __future__ import annotations

from datetime import date

import pytest

import wip_routes


class _FakeCursor:
    def __init__(self, executed: list[tuple[str, tuple | None]]):
        self.executed = executed

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql: str, params=None):
        self.executed.append((sql, tuple(params) if params is not None else None))


class _FakeConn:
    def __init__(self, executed: list[tuple[str, tuple | None]]):
        self.executed = executed
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return _FakeCursor(self.executed)

    def commit(self):
        self.committed = True


def test_database_pile_deliveries_returns_rows_specs_and_summary(monkeypatch):
    def fake_table_exists(table_name: str) -> bool:
        return table_name in {"pile_delivery_calendar", "pile_delivery_specs"}

    def fake_query(sql: str, params=None):
        if "FROM pile_delivery_calendar pdc" in sql and "WHERE pdc.delivery_date = %s" in sql:
            assert params == [date(2026, 6, 24)]
            return [
                {
                    "id": "row-1",
                    "delivery_date": date(2026, 6, 24),
                    "supplier_name": "МС-11",
                    "supplier_code": None,
                    "raw_spec_text": "12 м НС",
                    "spec_code": "PILE_12M_NS",
                    "spec_display": "12 м НС",
                    "length_m": 12,
                    "placement_side": "ns",
                    "exclude_from_totals": True,
                    "planned_qty": 72,
                    "actual_qty": 80,
                    "source_reference": "telegram",
                    "comment": "пример",
                    "updated_at": None,
                },
            ]
        if "FROM pile_delivery_specs" in sql:
            return [
                {
                    "spec_code": "PILE_12M_NS",
                    "display_name": "12 м НС",
                    "length_m": 12,
                    "placement_side": "ns",
                },
                {
                    "spec_code": "PILE_21M",
                    "display_name": "21 м",
                    "length_m": 21,
                    "placement_side": None,
                },
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "_wip_table_exists", fake_table_exists)
    monkeypatch.setattr(wip_routes, "query", fake_query)
    monkeypatch.setattr(
        wip_routes,
        "pile_deliveries_summary",
        lambda date=None: {
            "available": True,
            "date": date,
            "month": "2026-06",
            "days": ["2026-06-24"],
            "rows": [],
            "totals_by_day": {"2026-06-24": {"plan": 0.0, "fact": 0.0}},
            "totals": {"day_plan": 0.0, "day_fact": 0.0, "month_plan": 0.0, "month_fact": 0.0, "delta_day": 0.0, "delta_month": 0.0},
            "legend": [],
        },
    )

    result = wip_routes.database_pile_deliveries(date="2026-06-24", _user=object())

    assert result["available"] is True
    assert result["date"] == "2026-06-24"
    assert result["totals"] == {"day_plan": 0.0, "day_fact": 0.0, "row_count": 1}
    assert result["rows"][0]["supplier_name"] == "МС-11"
    assert result["rows"][0]["spec_display"] == "12 м НС"
    assert result["rows"][0]["planned_qty"] == 72.0
    assert result["rows"][0]["exclude_from_totals"] is True
    assert result["specs"][0]["spec_code"] == "PILE_12M_NS"
    assert result["summary"]["totals"]["day_fact"] == 0.0


def test_database_replace_pile_deliveries_replaces_day_snapshot_and_resolves_spec_codes(monkeypatch):
    executed: list[tuple[str, tuple | None]] = []
    conn = _FakeConn(executed)

    def fake_table_exists(table_name: str) -> bool:
        return table_name in {"pile_delivery_calendar", "pile_delivery_specs"}

    def fake_query(sql: str, params=None):
        if "FROM pile_delivery_specs" in sql:
            return [
                {
                    "spec_code": "PILE_12M_NS",
                    "display_name": "12 м НС",
                    "length_m": 12,
                    "placement_side": "ns",
                },
            ]
        raise AssertionError(f"unexpected query: {sql}")

    monkeypatch.setattr(wip_routes, "_wip_table_exists", fake_table_exists)
    monkeypatch.setattr(wip_routes, "query", fake_query)
    monkeypatch.setattr(wip_routes, "get_conn", lambda: conn)

    body = wip_routes.PileDeliveryDatabaseReplaceBody(
        delivery_date="2026-06-24",
        rows=[
            wip_routes.PileDeliveryDatabaseRowBody(
                supplier_name="МС-11",
                raw_spec_text="12Н",
                planned_qty=72,
                actual_qty=80,
                exclude_from_totals=True,
            ),
            wip_routes.PileDeliveryDatabaseRowBody(
                supplier_name="ПСК",
                raw_spec_text="21 м",
                planned_qty=8,
                actual_qty=10,
                source_reference="telegram",
            ),
        ],
    )

    result = wip_routes.database_replace_pile_deliveries(body, _admin=type("Admin", (), {"username": "boss"})())

    assert result == {"ok": True, "date": "2026-06-24", "saved": 2}
    assert conn.committed is True
    assert "DELETE FROM pile_delivery_calendar WHERE delivery_date = %s" in executed[0][0]
    assert executed[0][1] == (date(2026, 6, 24),)

    insert_calls = [item for item in executed if "INSERT INTO pile_delivery_calendar" in item[0]]
    assert len(insert_calls) == 2

    first_params = insert_calls[0][1]
    assert first_params is not None
    assert first_params[0] == date(2026, 6, 24)
    assert first_params[1] == "МС-11"
    assert first_params[3] == "12 м НС"
    assert first_params[4] == "PILE_12M_NS"
    assert first_params[5] == 72.0
    assert first_params[6] == 80.0
    assert first_params[7] is True
    assert first_params[8] == "dashboard"
    assert first_params[9] is None

    second_params = insert_calls[1][1]
    assert second_params is not None
    assert second_params[1] == "ПСК"
    assert second_params[4] is None
    assert second_params[7] is False
    assert second_params[8] == "telegram"


def test_database_replace_pile_deliveries_rejects_duplicate_supplier_spec_rows(monkeypatch):
    monkeypatch.setattr(wip_routes, "_wip_table_exists", lambda table_name: table_name == "pile_delivery_calendar")

    body = wip_routes.PileDeliveryDatabaseReplaceBody(
        delivery_date="2026-06-24",
        rows=[
            wip_routes.PileDeliveryDatabaseRowBody(supplier_name="МС-11", raw_spec_text="12 м НС", planned_qty=72, actual_qty=80),
            wip_routes.PileDeliveryDatabaseRowBody(supplier_name=" мс-11 ", raw_spec_text="12  м   нс", planned_qty=10, actual_qty=0),
        ],
    )

    with pytest.raises(wip_routes.HTTPException) as exc:
        wip_routes.database_replace_pile_deliveries(body, _admin=object())

    assert exc.value.status_code == 400
    assert "повторяется" in exc.value.detail.lower()


def test_pile_delivery_compact_and_numeric_spec_canonicalization():
    specs = [
        {"spec_code": "PILE_9M_VS", "display_name": "9 м ВС", "length_m": 9, "placement_side": "vs"},
        {"spec_code": "PILE_12M_NS", "display_name": "12 м НС", "length_m": 12, "placement_side": "ns"},
        {"spec_code": "PILE_21M", "display_name": "21 м", "length_m": 21, "placement_side": None},
    ]

    assert wip_routes._pile_delivery_canonical_spec_text("12Н") == "12 м НС"
    assert wip_routes._pile_delivery_canonical_spec_text("9В") == "9 м ВС"
    assert wip_routes._pile_delivery_canonical_spec_text("21") == "21 м"
    assert wip_routes._pile_delivery_resolve_spec_code("12Н", specs) == "PILE_12M_NS"
    assert wip_routes._pile_delivery_resolve_spec_code("9В", specs) == "PILE_9M_VS"
    assert wip_routes._pile_delivery_resolve_spec_code("21", specs) == "PILE_21M"
