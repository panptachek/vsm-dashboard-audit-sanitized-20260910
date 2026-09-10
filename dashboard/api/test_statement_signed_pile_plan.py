import unittest
from datetime import date
from unittest import mock

from fastapi import HTTPException

import wip_routes


class DashboardAnnouncementsTests(unittest.TestCase):
    def test_legacy_announcement_becomes_global_item(self):
        payload = wip_routes._normalize_dashboard_announcements({
            "enabled": True,
            "title": "Информация",
            "message": "Текст",
            "tone": "info",
        })

        self.assertEqual(len(payload["items"]), 1)
        self.assertEqual(payload["items"][0]["target_paths"], [])
        self.assertEqual(len(wip_routes._active_dashboard_announcements(payload, "/statements")), 1)
        self.assertEqual(len(wip_routes._active_dashboard_announcements(payload, None)), 1)

    def test_page_announcement_does_not_leak_to_other_pages(self):
        payload = wip_routes._normalize_dashboard_announcements({
            "items": [
                {"id": "global", "enabled": True, "message": "Всем", "target_paths": []},
                {"id": "statements", "enabled": True, "message": "Ведомости", "target_paths": ["/statements"]},
            ]
        })

        self.assertEqual(
            [item["id"] for item in wip_routes._active_dashboard_announcements(payload, "/statements")],
            ["global", "statements"],
        )
        self.assertEqual(
            [item["id"] for item in wip_routes._active_dashboard_announcements(payload, "/reports")],
            ["global"],
        )
        self.assertEqual(
            [item["id"] for item in wip_routes._active_dashboard_announcements(payload, None)],
            ["global"],
        )


class StatementSignedPilePlanTests(unittest.TestCase):
    def test_effective_plan_source_replaces_only_overlapping_pile_rows(self):
        with mock.patch.object(wip_routes, "_statement_table_exists", return_value=True):
            sql = wip_routes._statement_general_plan_source_sql()

        self.assertIn("statement_signed_pile_plan_batches", sql)
        self.assertIn("statement_signed_pile_plan_items", sql)
        self.assertIn("source_plan.period_start IS NOT NULL", sql)
        self.assertIn("signed_batch.period_start <= source_plan.period_end", sql)
        self.assertIn("'PILE_MAIN'", sql)
        self.assertIn("'PILE_TRIAL'", sql)
        self.assertIn("'PILE_HEADCAP_INSTALLATION'", sql)

    def test_effective_plan_source_falls_back_before_migration(self):
        with mock.patch.object(wip_routes, "_statement_table_exists", return_value=False):
            self.assertEqual(wip_routes._statement_general_plan_source_sql(), "planned_work_items pwi")

    def test_manual_month_plan_is_rejected_for_signed_pile_period(self):
        body = wip_routes.StatementGeneralWorkbookMonthPlanBody(
            object_id="11111111-1111-1111-1111-111111111111",
            work_type_id="22222222-2222-2222-2222-222222222222",
            planned_volume=10,
            month="2026-09",
        )
        with mock.patch.object(wip_routes, "_statement_table_exists", return_value=True), mock.patch.object(
            wip_routes,
            "_statement_signed_pile_plan_for_period",
            return_value={"id": "batch"},
        ), mock.patch.object(wip_routes, "query_one", return_value={"code": "PILE_MAIN"}):
            with self.assertRaises(HTTPException) as raised:
                wip_routes.statements_general_workbook_month_plan(body, _user=None)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("подписанной производственной программой", raised.exception.detail)

    def test_signed_plan_row_is_marked_read_only(self):
        days = [{"date": date(2026, 9, day).isoformat()} for day in range(1, 31)]
        source_row = {
            "object_id": "obj-1",
            "object_code": "PF_24Н",
            "object_name": "Свайное поле 24 Н",
            "object_type_code": "PILE_FIELD",
            "object_type_name": "Свайное поле",
            "section_code": "UCH_2",
            "section_name": "Участок 2",
            "section_sort_order": 2,
            "work_type_id": "wt-main",
            "work_type_code": "PILE_MAIN",
            "work_type_name": "Забивка основных свай",
            "pile_type": "С130.35-10",
            "pipe_pile_length_m": None,
            "analytics_tag": "Забивка основных свай",
            "unit": "шт",
            "section_pk_start": 275200.3,
            "section_pk_end": 275425.0,
            "object_pk_start": 275200.3,
            "object_pk_end": 275425.0,
            "plan_pk_start": 275200.3,
            "plan_pk_end": 275425.0,
            "pk_start": 275200.3,
            "pk_end": 275425.0,
            "pk_raw_text": "ПК2752+00.3 - ПК2754+25",
            "period_start": date(2026, 9, 1),
            "period_end": date(2026, 9, 30),
            "plan_type": "signed_month",
            "source_reference": "signed_production_program:abc",
            "planned_volume": 600,
        }
        rows_by_key = {}
        with mock.patch.object(wip_routes, "_statement_table_exists", return_value=True), mock.patch.object(
            wip_routes, "_statement_general_plan_scope_filters", return_value=([], [])
        ), mock.patch.object(wip_routes, "_statement_scope_cte", return_value=""), mock.patch.object(
            wip_routes, "query", return_value=[source_row]
        ), mock.patch.object(
            wip_routes, "_general_plan_work_category", return_value="work:PILE_MAIN"
        ), mock.patch.object(
            wip_routes,
            "_statement_clip_volume_to_section",
            side_effect=lambda item, volume, *_args: (item["pk_start"], item["pk_end"], volume, True),
        ):
            wip_routes._statement_general_add_plan_rows(
                rows_by_key,
                days=days,
                period_start=date(2026, 9, 1),
                period_end=date(2026, 9, 30),
                section_codes=None,
                object_type=None,
                object_id=None,
                q=None,
            )

        row = next(iter(rows_by_key.values()))
        self.assertEqual(row["month_plan"], 600)
        self.assertTrue(row["month_plan_locked"])
        self.assertEqual(row["month_plan_source"], "Подписанная производственная программа")


if __name__ == "__main__":
    unittest.main()
