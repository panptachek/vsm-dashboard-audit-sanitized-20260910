from datetime import date

import wip_analytics_routes


def test_stockpile_balances_sql_uses_latest_section_slice(monkeypatch):
    calls = {"query_one": 0}

    def fake_query_one(sql: str, params=None):
        calls["query_one"] += 1
        if calls["query_one"] == 1:
            return {"max_date": date(2026, 8, 23)}
        return {"effective_date": date(2026, 8, 23)}

    def fake_query(sql: str, params=None):
        assert "section_latest AS" in sql
        assert "GROUP BY sec_num" in sql
        assert "IS NOT DISTINCT FROM" in sql
        assert "s.balance_volume::numeric <> 0" in sql
        assert params == (date(2026, 8, 23),)
        return [
            {
                "stockpile_id": "sp-current",
                "stockpile_name": "Накопитель песка ПК3219",
                "sec_num": 7,
                "material_code": "SAND",
                "material_name": "Песок",
                "snapshot_date": date(2026, 8, 23),
                "unit": "м3",
                "balance": 1200,
                "is_pending_review": False,
                "report_id": None,
                "pk_start": 3219,
                "pk_end": 3219,
                "pk_raw_text": None,
            }
        ]

    monkeypatch.setattr(wip_analytics_routes, "query_one", fake_query_one)
    monkeypatch.setattr(wip_analytics_routes, "query", fake_query)

    payload = wip_analytics_routes.analytics_stockpile_balances(as_of="2026-08-24")

    assert payload["effective_date"] == "2026-08-23"
    assert payload["max_date"] == "2026-08-23"
    assert len(payload["rows"]) == 1
    assert payload["rows"][0]["stockpile_id"] == "sp-current"
    assert payload["rows"][0]["balance"] == 1200.0
