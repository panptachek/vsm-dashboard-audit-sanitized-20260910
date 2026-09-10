from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path("/opt/vsm/ops/report_pipeline/export_pile_daily_breakdown.py")
SPEC = importlib.util.spec_from_file_location("pile_daily_breakdown_script", SCRIPT_PATH)
assert SPEC and SPEC.loader
pile_breakdown = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pile_breakdown)


def test_non_pile_control_report_condition_matches_dashboard_flags() -> None:
    condition = pile_breakdown.non_pile_control_report_condition("dr")

    assert "web_pile_control" in condition
    assert "review_flags" in condition
    assert "контроль свай" in condition
    assert "isso" in condition


def test_load_data_excludes_pile_control_reports_from_fact_queries() -> None:
    captured_sql: list[str] = []

    def fake_fetch_all(_conn, sql: str, params=()):
        captured_sql.append(sql)
        return []

    with mock.patch.object(pile_breakdown, "fetch_all", side_effect=fake_fetch_all):
        pile_breakdown.load_data(conn=None, start=None, end=None, approved_only=False)

    fact_queries = [
        sql
        for sql in captured_sql
        if "daily_work_items" in sql and ("wt.code = ANY" in sql or "wt.code IN ('PILE_MAIN','PILE_TRIAL')" in sql)
    ]
    assert len(fact_queries) >= 5
    assert all("web_pile_control" in sql for sql in fact_queries)
    assert all("review_flags" in sql for sql in fact_queries)


def test_source_driven_excluded_pile_rows_remain_visible() -> None:
    row = {
        "catalog_status": "excluded",
        "driven_pile_count": 9,
        "is_demo": False,
    }

    assert pile_breakdown.should_show_pile_row(row, fact_total=0) is True
    assert pile_breakdown.active_label(row) == "Исключен"
    assert str(pile_breakdown.pile_row_fill(row, "PILE_TRIAL").fgColor.rgb).endswith("FEE2E2")


def test_empty_excluded_pile_rows_stay_hidden() -> None:
    row = {
        "catalog_status": "excluded",
        "driven_pile_count": 0,
        "is_demo": False,
    }

    assert pile_breakdown.should_show_pile_row(row, fact_total=0) is False
