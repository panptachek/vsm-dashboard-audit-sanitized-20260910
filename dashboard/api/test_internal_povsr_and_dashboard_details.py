from __future__ import annotations

from datetime import date
from pathlib import Path
import unittest
from unittest.mock import patch

import db_admin_routes
import wip_analytics_routes
import wip_routes


class InternalPovsrAndDashboardDetailsTests(unittest.TestCase):
    def test_dashboard_kpi_payload_keeps_fact_and_plan_source_rows(self):
        payload = wip_analytics_routes._dashboard_kpi_detail_payload(
            metric="sand_oh",
            label="Песок ОХ",
            unit="м³",
            d_from=date(2026, 9, 1),
            d_to=date(2026, 9, 30),
            source_rows=[
                {
                    "section_code": "UCH_2",
                    "section_name": "Участок 2",
                    "object_type_code": "MAIN_ROAD",
                    "object_type_name": "Основной ход",
                    "object_id": "object-1",
                    "object_code": "MAIN_002",
                    "object_name": "Основной ход, участок 2",
                    "detail_kind": "fact",
                    "report_id": "report-1",
                    "report_date": date(2026, 9, 7),
                    "shift": "night",
                    "work_type_name": "Устройство насыпи",
                    "fact_count": 1,
                    "volume": 12,
                    "plan_volume": 0,
                },
                {
                    "section_code": "UCH_2",
                    "section_name": "Участок 2",
                    "object_type_code": "MAIN_ROAD",
                    "object_type_name": "Основной ход",
                    "object_id": "object-1",
                    "object_code": "MAIN_002",
                    "object_name": "Основной ход, участок 2",
                    "detail_kind": "plan",
                    "plan_item_id": "plan-1",
                    "work_type_name": "Устройство насыпи",
                    "plan_period_start": date(2026, 9, 1),
                    "plan_period_end": date(2026, 9, 30),
                    "fact_count": 0,
                    "volume": 0,
                    "plan_volume": 20,
                },
            ],
        )

        self.assertEqual(len(payload["rows"]), 1)
        row = payload["rows"][0]
        self.assertEqual(row["volume"], 12)
        self.assertEqual(row["plan_volume"], 20)
        self.assertEqual(row["details"], [
            {
                "kind": "fact",
                "object_name": "Основной ход, участок 2",
                "work_type_name": "Устройство насыпи",
                "volume": 12.0,
                "report_date": "2026-09-07",
                "shift": "night",
                "report_id": "report-1",
                "plan_item_id": None,
                "period_start": None,
                "period_end": None,
            },
            {
                "kind": "plan",
                "object_name": "Основной ход, участок 2",
                "work_type_name": "Устройство насыпи",
                "volume": 20.0,
                "report_date": None,
                "shift": None,
                "report_id": None,
                "plan_item_id": "plan-1",
                "period_start": "2026-09-01",
                "period_end": "2026-09-30",
            },
        ])
        self.assertEqual(payload["sections"][0]["object_types"][0]["objects"][0]["details"], row["details"])
    def test_statements_current_month_warmer_populates_both_binding_modes(self):
        calls: list[bool] = []

        def fake_warm(*, month_key: str, fingerprint: str, actual_section_binding: bool):
            self.assertEqual(month_key, "2026-09")
            self.assertEqual(fingerprint, "fingerprint")
            calls.append(actual_section_binding)
            return {"status": "warmed"}

        with (
            patch.object(wip_routes, "_statement_general_month_bounds", return_value=("2026-09", date(2026, 9, 1), date(2026, 9, 30))),
            patch.object(wip_routes, "_statement_general_workbook_fingerprint", return_value="fingerprint"),
            patch.object(wip_routes, "_warm_statements_general_workbook_mode", side_effect=fake_warm),
        ):
            result = wip_routes._warm_statements_general_workbook_current_month()

        self.assertEqual(calls, [False, True])
        self.assertEqual(result["modes"], {
            "nominal": {"status": "warmed"},
            "actual": {"status": "warmed"},
        })

    def test_statements_warmer_uses_file_cache_without_loading_large_json(self):
        with (
            patch.object(wip_routes, "_statement_general_workbook_cache_params", return_value={"actual_section_binding": True}),
            patch.object(wip_routes, "_statement_general_workbook_persistent_key", return_value="actual-cache"),
            patch.object(wip_routes, "_statement_general_workbook_cache_file_is_fresh", return_value=True),
            patch.object(wip_routes, "_statement_general_workbook_cache_get", side_effect=AssertionError("JSON cache must not be loaded")),
        ):
            result = wip_routes._warm_statements_general_workbook_mode(
                month_key="2026-09",
                fingerprint="fingerprint",
                actual_section_binding=True,
            )

        self.assertEqual(result, {"status": "hit"})

    def test_povsr_work_types_are_filtered_from_database_and_reference_search(self):
        _, work_where = db_admin_routes._database_table_filter_parts("work_types", set())
        _, alias_where = db_admin_routes._database_table_filter_parts("work_type_aliases", set())
        self.assertIn("POVSR", repr(work_where))
        self.assertIn("POVSR", repr(alias_where))

        captured: list[str] = []

        def fake_query(statement: str, _params=None):
            captured.append(statement)
            return []

        with patch.object(wip_routes, "query", side_effect=fake_query):
            self.assertEqual(wip_routes._dedup_reference_search("work_type", "ПОВСР", 10), [])
        self.assertIn("code NOT LIKE 'POVSR", captured[0])
    def test_povsr_importer_keeps_internal_work_types_inactive_and_without_tag(self):
        workspace_importer = Path("/opt/vsm/ops/report_pipeline/simple_section_xlsx/import_povsr_customer_closed.py")
        if workspace_importer.exists():
            importer = workspace_importer
        else:
            importer = Path(__file__).resolve().parent.parent.parent / "ops" / "report_pipeline" / "simple_section_xlsx" / "import_povsr_customer_closed.py"
        source = importer.read_text(encoding="utf-8")
        self.assertIn("VALUES (%s, %s, %s, 'povsr', false, false, false, NULL, NULL)", source)
        self.assertIn("is_active = false", source)
        self.assertIn("review_tag = NULL", source)
        self.assertIn("analytics_tag = NULL", source)
        self.assertIn("OR code LIKE 'POVSR\\\\_%%' ESCAPE '\\\\'", source)


if __name__ == "__main__":
    unittest.main()
