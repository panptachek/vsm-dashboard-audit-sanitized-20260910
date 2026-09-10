#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock
from zipfile import ZipFile

try:
    import fastapi  # noqa: F401
except ModuleNotFoundError:
    # The host maintenance Python may not have dashboard API deps installed; the
    # production Docker image does.  Stub only the imports needed for these pure
    # cache-helper unit tests.
    import sys
    import types

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda fn: fn

        post = put = patch = delete = get

    def passthrough(*args, **kwargs):
        return None

    fastapi_stub = types.ModuleType("fastapi")
    fastapi_stub.APIRouter = APIRouter
    fastapi_stub.Depends = passthrough
    fastapi_stub.File = passthrough
    fastapi_stub.Header = passthrough
    fastapi_stub.Query = passthrough
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.UploadFile = object
    sys.modules["fastapi"] = fastapi_stub

    responses_stub = types.ModuleType("fastapi.responses")
    responses_stub.FileResponse = object
    responses_stub.Response = object
    responses_stub.StreamingResponse = object
    sys.modules["fastapi.responses"] = responses_stub

    pydantic_stub = types.ModuleType("pydantic")
    pydantic_stub.BaseModel = object
    pydantic_stub.Field = lambda default=None, **kwargs: default
    sys.modules.setdefault("pydantic", pydantic_stub)

    main_stub = types.ModuleType("main")
    main_stub.query = lambda *args, **kwargs: []
    main_stub.query_one = lambda *args, **kwargs: None
    main_stub.get_conn = lambda: None
    sys.modules["main"] = main_stub

    auth_stub = types.ModuleType("auth")
    auth_stub.current_user = lambda: None
    auth_stub.require_admin = lambda: None
    auth_stub.require_settings_manager = lambda: None
    auth_stub.require_statements_project_writer = lambda: None
    sys.modules["auth"] = auth_stub

import wip_routes


class XlsxReportCacheTests(unittest.TestCase):
    def _write_minimal_xlsx(self, path: Path, value: str = "cached") -> None:
        with ZipFile(path, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", f"<workbook>{value}</workbook>")

    def _write_minimal_pdf(self, path: Path, value: str = "cached") -> None:
        path.write_bytes(f"%PDF-1.4\n% {value}\n1 0 obj\n<<>>\nendobj\n%%EOF\n".encode("utf-8"))

    def test_report_pipeline_cgroup_action_pauses_resumes_and_kills(self):
        patches = [
            mock.patch.object(wip_routes, "REPORT_PIPELINE_CGROUP_BACKPRESSURE_ENABLED", True),
            mock.patch.object(wip_routes, "REPORT_PIPELINE_CGROUP_PAUSE_RATIO", 0.92),
            mock.patch.object(wip_routes, "REPORT_PIPELINE_CGROUP_RESUME_RATIO", 0.86),
            mock.patch.object(wip_routes, "REPORT_PIPELINE_CGROUP_KILL_RATIO", 0.97),
            mock.patch.object(wip_routes, "REPORT_PIPELINE_CGROUP_MAX_PAUSE_SECONDS", 180.0),
        ]
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            self.assertEqual(wip_routes._report_pipeline_cgroup_action(50, 100, paused=False, paused_seconds=0), "none")
            self.assertEqual(wip_routes._report_pipeline_cgroup_action(93, 100, paused=False, paused_seconds=0), "pause")
            self.assertEqual(wip_routes._report_pipeline_cgroup_action(85, 100, paused=True, paused_seconds=10), "resume")
            self.assertEqual(wip_routes._report_pipeline_cgroup_action(90, 100, paused=True, paused_seconds=181), "kill")
            self.assertEqual(wip_routes._report_pipeline_cgroup_action(98, 100, paused=False, paused_seconds=0), "kill")

    def test_report_pipeline_env_enables_dim_memory_guard_defaults(self):
        with mock.patch.dict(wip_routes.os.environ, {"DB_NAME": "works_db_v2"}, clear=True):
            env = wip_routes._report_pipeline_env()

        self.assertEqual(env["DIM_REPORT_MEMORY_GUARD"], "1")
        self.assertEqual(env["DIM_REPORT_MEMORY_GUARD_HARD_RATIO"], "0.84")
        self.assertIn("TEMP_ROADS_DB_DSN", env)

    def test_mechanization_display_pair_moves_full_plate_from_unit_number(self):
        plate, unit_number = wip_routes._equipment_display_identifier_pair({
            "plate_number": "",
            "unit_number": "С870 ХВ 27",
        })

        self.assertEqual(plate, "С870ХВ27")
        self.assertEqual(unit_number, "")

    def test_mechanization_display_pair_keeps_plain_unit_number(self):
        plate, unit_number = wip_routes._equipment_display_identifier_pair({
            "plate_number": "",
            "unit_number": "870",
        })

        self.assertEqual(plate, "")
        self.assertEqual(unit_number, "870")

    def test_mechanization_caps_overlarge_work_usage_fact_to_source_volume(self):
        rows = [
            {
                "work_item_id": "work-1",
                "unit": "м³",
                "source_unit": "м3",
                "source_volume": 416.0,
                "fact": 1200.0,
            },
            {
                "work_item_id": "work-2",
                "unit": "м³",
                "source_unit": "м3",
                "source_volume": 784.0,
                "fact": 784.0,
            },
        ]

        wip_routes._mechanization_cap_work_usage_facts(rows)

        self.assertAlmostEqual(rows[0]["fact"], 416.0)
        self.assertEqual(rows[0]["raw_fact"], 1200.0)
        self.assertIn("ограничен фактом строки отчета", rows[0]["fact_adjustment_reason"])
        self.assertEqual(rows[1]["fact"], 784.0)
        self.assertNotIn("raw_fact", rows[1])

    def test_statements_general_workbook_uses_persistent_cache_before_build(self):
        cached_payload = {
            "month": "2026-08",
            "month_start": "2026-08-01",
            "month_end": "2026-08-31",
            "days": [],
            "rows": [{"id": "cached"}],
            "totals": {},
            "row_count": 1,
            "updated_at": "2026-08-13T10:00:00+00:00",
        }

        with mock.patch.object(wip_routes, "_statement_general_workbook_fingerprint", return_value="fp-current"), \
             mock.patch.object(wip_routes, "_dashboard_short_cache_get", return_value=None), \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_get", return_value=cached_payload), \
             mock.patch.object(wip_routes, "_dashboard_short_cache_set", side_effect=lambda _cache, _key, payload: payload), \
             mock.patch.object(wip_routes, "_statements_general_workbook_payload") as build_payload:
            result = wip_routes.statements_general_workbook(
                month="2026-08",
                include_metadata=False,
                use_file_response=False,
                _user=None,
            )

        build_payload.assert_not_called()
        self.assertEqual(result["rows"], [{"id": "cached"}])
        self.assertEqual(result["cache"]["status"], "fresh")
        self.assertEqual(result["cache"]["fingerprint"], "fp-current")

    def test_statements_general_workbook_returns_stale_cache_and_refreshes(self):
        stale_payload = {
            "month": "2026-08",
            "month_start": "2026-08-01",
            "month_end": "2026-08-31",
            "days": [],
            "rows": [{"id": "stale"}],
            "totals": {},
            "row_count": 1,
            "updated_at": "2026-08-13T09:00:00+00:00",
        }

        with mock.patch.object(wip_routes, "_statement_general_workbook_fingerprint", return_value="fp-new"), \
             mock.patch.object(wip_routes, "_dashboard_short_cache_get", return_value=None), \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_get", return_value=None), \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_get_latest", return_value={
                 "payload": stale_payload,
                 "fingerprint": "fp-old",
                 "created_at": "2026-08-13T09:00:00+00:00",
             }), \
             mock.patch.object(wip_routes, "_statement_general_workbook_refresh_async", return_value=True) as refresh_async, \
             mock.patch.object(wip_routes, "_statements_general_workbook_payload") as build_payload:
            result = wip_routes.statements_general_workbook(
                month="2026-08",
                include_metadata=False,
                use_file_response=False,
                _user=None,
            )

        build_payload.assert_not_called()
        refresh_async.assert_called_once()
        self.assertEqual(result["rows"], [{"id": "stale"}])
        self.assertEqual(result["cache"]["status"], "stale")
        self.assertTrue(result["cache"]["refreshing"])

    def test_statements_general_workbook_can_disable_stale_cache(self):
        fresh_payload = {
            "month": "2026-08",
            "month_start": "2026-08-01",
            "month_end": "2026-08-31",
            "days": [],
            "rows": [{"id": "fresh"}],
            "totals": {},
            "row_count": 1,
        }

        with mock.patch.object(wip_routes, "_statement_general_workbook_fingerprint", return_value="fp-new"), \
             mock.patch.object(wip_routes, "_dashboard_short_cache_get", return_value=None), \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_get", return_value=None), \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_get_latest") as latest_cache, \
             mock.patch.object(wip_routes, "_statement_general_workbook_cache_set", side_effect=lambda _key, _fingerprint, payload: payload), \
             mock.patch.object(wip_routes, "_dashboard_short_cache_set", side_effect=lambda _cache, _key, payload: payload), \
             mock.patch.object(wip_routes, "_statement_general_workbook_try_build_lock", return_value=object()), \
             mock.patch.object(wip_routes, "_statement_general_workbook_release_build_lock"), \
             mock.patch.object(wip_routes, "_statements_general_workbook_payload", return_value=fresh_payload) as build_payload:
            result = wip_routes.statements_general_workbook(
                month="2026-08",
                include_metadata=False,
                allow_stale=False,
                use_file_response=False,
                _user=None,
            )

        latest_cache.assert_not_called()
        build_payload.assert_called_once()
        self.assertEqual(result["rows"], [{"id": "fresh"}])
        self.assertEqual(result["cache"]["status"], "fresh")

    def test_statements_general_workbook_file_cache_roundtrip(self):
        payload = {
            "month": "2026-08",
            "rows": [{"id": "file-cache"}],
            "row_count": 1,
        }

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            with mock.patch.object(wip_routes, "STATEMENTS_GENERAL_WORKBOOK_JSON_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "DASHBOARD_RESPONSE_CACHE_TTL_SECONDS", 3600):
                wip_routes._statement_general_workbook_cache_set("cache-key", "fingerprint-a", payload)
                exact = wip_routes._statement_general_workbook_cache_get("cache-key", "fingerprint-a")
                latest = wip_routes._statement_general_workbook_cache_get_latest("cache-key", 3600)

        self.assertEqual(exact["rows"], payload["rows"])
        self.assertEqual(exact["cache"]["status"], "fresh")
        self.assertEqual(latest["payload"]["rows"], payload["rows"])
        self.assertEqual(latest["fingerprint"], "fingerprint-a")

    def test_cached_report_reuses_artifact_for_same_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_dim_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            cache_dir = tmp_path / "cache"
            generated = {"count": 0}

            def fake_run(_script, _template, output, _d_from, _d_to, *, filter_env=None, cumulative_end_date=None):
                generated["count"] += 1
                output.write_bytes(f"xlsx-{generated['count']}".encode("utf-8"))
                return f"generated {generated['count']}"

            with mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"daily_work_items": {"rows": "1", "max_xmin": "10"}}), \
                 mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_run_xlsx_generator", side_effect=fake_run):
                first = wip_routes._generate_cached_xlsx_report(
                    report_key="dim",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="dim.xlsx",
                )
                second = wip_routes._generate_cached_xlsx_report(
                    report_key="dim",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="dim.xlsx",
                )

            self.assertEqual(first, b"xlsx-1")
            self.assertEqual(second, b"xlsx-1")
            self.assertEqual(generated["count"], 1)
            self.assertEqual(len(list((cache_dir / "dim").glob("*.metadata.json"))), 1)

    def test_cache_key_changes_when_report_filters_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_dim_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            cache_dir = tmp_path / "cache"
            generated = {"count": 0}

            def fake_run(_script, _template, output, _d_from, _d_to, *, filter_env=None, cumulative_end_date=None):
                generated["count"] += 1
                marker = (filter_env or {}).get("DIM_REPORT_FILTER_WORK_TAGS", "all")
                output.write_bytes(f"xlsx-{generated['count']}-{marker}".encode("utf-8"))
                return f"generated {generated['count']}"

            with mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"daily_work_items": {"rows": "1", "max_xmin": "10"}}), \
                 mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_run_xlsx_generator", side_effect=fake_run):
                first = wip_routes._generate_cached_xlsx_report(
                    report_key="dim",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="dim.xlsx",
                    filter_env={"DIM_REPORT_FILTER_WORK_TAGS": '["tag-a"]'},
                )
                second = wip_routes._generate_cached_xlsx_report(
                    report_key="dim",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="dim.xlsx",
                    filter_env={"DIM_REPORT_FILTER_WORK_TAGS": '["tag-b"]'},
                )

            self.assertNotEqual(first, second)
            self.assertEqual(generated["count"], 2)
            self.assertEqual(len(list((cache_dir / "dim").glob("*.metadata.json"))), 2)

    def test_cache_key_changes_when_db_fingerprint_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_general_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            cache_dir = tmp_path / "cache"
            generated = {"count": 0}
            db_states = [
                {"daily_work_items": {"rows": "1", "max_xmin": "10"}},
                {"daily_work_items": {"rows": "2", "max_xmin": "11"}},
            ]

            def fake_run(_script, _template, output, _d_from, _d_to, *, filter_env=None, cumulative_end_date=None):
                generated["count"] += 1
                output.write_bytes(f"xlsx-{generated['count']}".encode("utf-8"))
                return f"generated {generated['count']}"

            with mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", side_effect=db_states), \
                 mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_run_xlsx_generator", side_effect=fake_run):
                first = wip_routes._generate_cached_xlsx_report(
                    report_key="general",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="general.xlsx",
                )
                second = wip_routes._generate_cached_xlsx_report(
                    report_key="general",
                    d_from=date(2026, 5, 1),
                    d_to=date(2026, 5, 2),
                    script=script,
                    template=template,
                    output_name="general.xlsx",
                )

            self.assertEqual(first, b"xlsx-1")
            self.assertEqual(second, b"xlsx-2")
            self.assertEqual(generated["count"], 2)
            self.assertEqual(len(list((cache_dir / "general").glob("*.metadata.json"))), 2)

    def test_large_report_cache_fingerprint_passes_date_scope_to_db_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_general_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            filter_env = {"DIM_REPORT_FILTER_WORK_TAGS": '["tag-a"]'}

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"scope": "ok"}) as db_fingerprint:
                wip_routes._xlsx_report_cache_fingerprint(
                    "general",
                    date(2026, 8, 1),
                    date(2026, 8, 9),
                    script,
                    template,
                    filter_env=filter_env,
                )

            db_fingerprint.assert_called_once_with(
                "general",
                date(2026, 8, 1),
                date(2026, 8, 9),
                filter_env=filter_env,
            )

    def test_dim_cache_fingerprint_includes_shared_mstroy_summary_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            templates_dir = tmp_path / "templates"
            templates_dir.mkdir()
            script = tmp_path / "generate_dim_report.py"
            shared_script = tmp_path / "generate_mstroi_graph_report.py"
            template = templates_dir / "DiM report.xlsx"
            shared_template = templates_dir / "MStroy graph report.xlsx"
            script.write_text("print('dim')\n", encoding="utf-8")
            shared_script.write_text("print('summary-v1')\n", encoding="utf-8")
            template.write_bytes(b"dim-template")
            shared_template.write_bytes(b"summary-template-v1")

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "MSTROY_GRAPH_TEMPLATE", shared_template), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"scope": "ok"}):
                first = wip_routes._xlsx_report_cache_fingerprint(
                    "dim",
                    date(2026, 8, 1),
                    date(2026, 8, 9),
                    script,
                    template,
                )
                shared_script.write_text("print('summary-v2')\n", encoding="utf-8")
                after_script_change = wip_routes._xlsx_report_cache_fingerprint(
                    "dim",
                    date(2026, 8, 1),
                    date(2026, 8, 9),
                    script,
                    template,
                )
                shared_template.write_bytes(b"summary-template-v2")
                after_template_change = wip_routes._xlsx_report_cache_fingerprint(
                    "dim",
                    date(2026, 8, 1),
                    date(2026, 8, 9),
                    script,
                    template,
                )

            self.assertNotEqual(first, after_script_change)
            self.assertNotEqual(after_script_change, after_template_change)

    def test_large_report_db_fingerprint_scopes_daily_tables_through_report_date(self):
        class FakeCursor:
            def __init__(self):
                self.executed = []
                self.next_row = None

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, sql, params=None):
                params = tuple(params or ())
                self.executed.append((sql, params))
                if "to_regclass" in sql:
                    self.next_row = (params[0],)
                else:
                    self.next_row = ("1", "10")

            def fetchone(self):
                return self.next_row

        class FakeConn:
            def __init__(self):
                self.cursor_obj = FakeCursor()

            def cursor(self):
                return self.cursor_obj

            def close(self):
                pass

        conn = FakeConn()
        with mock.patch.object(wip_routes, "get_conn", return_value=conn):
            payload = wip_routes._xlsx_report_db_fingerprint(
                "dim",
                date(2026, 8, 1),
                date(2026, 8, 9),
                filter_env={"DIM_REPORT_CUMULATIVE_AS_OF_END_DATE": "1"},
            )

        self.assertEqual(payload["scope"]["mode"], "facts_through_report_date")
        self.assertEqual(payload["scope"]["date_to"], "2026-08-09")
        self.assertIn("global", payload)
        self.assertIn("daily", payload)

        count_queries = [
            (sql, params)
            for sql, params in conn.cursor_obj.executed
            if "SELECT COUNT(*)::text" in sql
        ]
        daily_queries = [
            (sql, params)
            for sql, params in count_queries
            if "daily_work_items dwi" in sql or "material_movements mm" in sql
        ]
        self.assertTrue(daily_queries)
        self.assertTrue(all(params for _sql, params in daily_queries))
        self.assertTrue(
            all(
                all(param == date(2026, 8, 9) for param in params)
                for _sql, params in daily_queries
            )
        )
        self.assertFalse(
            any(
                "FROM daily_work_items" in sql and not params
                for sql, params in count_queries
            )
        )

    def test_global_db_fingerprint_keeps_daily_tables_for_unscoped_reports(self):
        class FakeCursor:
            def __init__(self):
                self.next_row = None

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, sql, params=None):
                if "to_regclass" in sql:
                    self.next_row = ((params or ("",))[0],)
                else:
                    self.next_row = ("1", "10")

            def fetchone(self):
                return self.next_row

        class FakeConn:
            def cursor(self):
                return FakeCursor()

            def close(self):
                pass

        with mock.patch.object(wip_routes, "get_conn", return_value=FakeConn()):
            payload = wip_routes._xlsx_report_db_fingerprint()

        self.assertNotIn("scope", payload)
        self.assertIn("daily_reports", payload)
        self.assertIn("daily_work_items", payload)
        self.assertIn("daily_work_item_segments", payload)

    def test_daily_email_reuses_background_xlsx_cache_for_same_attachment(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_dim_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            cache_dir = tmp_path / "cache"
            generated = {"count": 0}
            spec = {
                **wip_routes.XLSX_PIPELINE_REPORT_SPECS["dim"],
                "template": template,
            }

            def fake_run(_script, _template, output, _d_from, _d_to, *, filter_env=None, cumulative_end_date=None):
                generated["count"] += 1
                output.write_bytes(f"xlsx-{generated['count']}".encode("utf-8"))
                return f"generated {generated['count']}"

            report_config = {
                "date_mode": "custom",
                "date": "2026-08-09",
                "date_from": "2026-08-03",
                "cumulative_as_of_end_date": True,
            }

            with mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "XLSX_PIPELINE_REPORT_SPECS", {"dim": spec}), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"daily_work_items": {"rows": "1", "max_xmin": "10"}}), \
                 mock.patch.object(wip_routes, "_report_parameters_env", return_value={}), \
                 mock.patch.object(wip_routes, "_run_xlsx_generator", side_effect=fake_run):
                first = wip_routes._daily_report_email_generator_attachment("dim", report_config, date(2026, 8, 11))
                second = wip_routes._daily_report_email_generator_attachment("dim", report_config, date(2026, 8, 11))
                estimate = wip_routes._daily_report_email_attachment_estimate_seconds("dim", report_config, date(2026, 8, 11))

            self.assertEqual(first["content"], b"xlsx-1")
            self.assertEqual(second["content"], b"xlsx-1")
            self.assertFalse(first["from_cache"])
            self.assertTrue(second["from_cache"])
            self.assertEqual(estimate, 2)
            self.assertEqual(generated["count"], 1)

    def test_daily_email_can_reuse_latest_background_xlsx_cache_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_dim_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template-v1")
            cache_dir = tmp_path / "cache"
            cache_report_dir = cache_dir / "dim"
            cache_report_dir.mkdir(parents=True)
            cached_artifact = cache_report_dir / "dim_2026-08-03_2026-08-09_oldfingerprint.xlsx"
            cached_meta = cache_report_dir / "dim_2026-08-03_2026-08-09_oldfingerprint.metadata.json"
            self._write_minimal_xlsx(cached_artifact, "old-cache")
            cached_meta.write_text(
                json.dumps(
                    {
                        "report_key": "dim",
                        "date_from": "2026-08-03",
                        "date_to": "2026-08-09",
                        "fingerprint": "oldfingerprint",
                        "artifact": str(cached_artifact),
                        "size_bytes": cached_artifact.stat().st_size,
                        "created_at": "2026-08-09T10:00:00+00:00",
                    }
                ),
                encoding="utf-8",
            )
            spec = {
                **wip_routes.XLSX_PIPELINE_REPORT_SPECS["dim"],
                "template": template,
            }
            report_config = {
                "date_mode": "custom",
                "date": "2026-08-09",
                "date_from": "2026-08-03",
                "cumulative_as_of_end_date": False,
                "use_cache": True,
            }

            with mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_XLSX_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "XLSX_PIPELINE_REPORT_SPECS", {"dim": spec}), \
                 mock.patch.object(wip_routes, "_xlsx_report_db_fingerprint", return_value={"daily_work_items": {"rows": "2", "max_xmin": "20"}}), \
                 mock.patch.object(wip_routes, "_report_parameters_env", return_value={}), \
                 mock.patch.object(wip_routes, "_run_xlsx_generator") as run_mock:
                attachment = wip_routes._daily_report_email_generator_attachment("dim", report_config, date(2026, 8, 11))
                estimate = wip_routes._daily_report_email_attachment_estimate_seconds("dim", report_config, date(2026, 8, 11))

            self.assertEqual(attachment["content"], cached_artifact.read_bytes())
            self.assertTrue(attachment["from_cache"])
            self.assertEqual(attachment["cache_mode"], "latest_metadata")
            self.assertEqual(attachment["cache_created_at"], "2026-08-09T10:00:00+00:00")
            self.assertEqual(estimate, 2)
            run_mock.assert_not_called()

    def test_daily_email_does_not_reuse_latest_pdf_cache_without_checkbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "mainline_structural_scheme.py"
            script.write_text("print('generator')\n", encoding="utf-8")
            cache_dir = tmp_path / "cache"
            cache_report_dir = cache_dir / "mainline_structural_scheme"
            cache_report_dir.mkdir(parents=True)
            cached_artifact = cache_report_dir / "mainline_structural_scheme_2026-08-31_2026-08-31_all_oldfingerprint.pdf"
            cached_meta = cache_report_dir / "mainline_structural_scheme_2026-08-31_2026-08-31_all_oldfingerprint.metadata.json"
            self._write_minimal_pdf(cached_artifact, "old-cache")
            cached_meta.write_text(
                json.dumps(
                    {
                        "report_key": "mainline_structural_scheme",
                        "date_from": "2026-08-31",
                        "date_to": "2026-08-31",
                        "section_codes": [],
                        "fingerprint": "oldfingerprint",
                        "artifact": str(cached_artifact),
                        "size_bytes": cached_artifact.stat().st_size,
                        "created_at": "2026-08-31T10:00:00+00:00",
                    }
                ),
                encoding="utf-8",
            )
            report_config = {
                "date_mode": "custom",
                "date": "2026-08-31",
                "use_cache": False,
            }

            def fake_run(_d_to, _section_codes, output, _mpl_config_dir):
                self._write_minimal_pdf(output, "generated")
                return "generated"

            with mock.patch.object(wip_routes, "REPORT_PDF_CACHE_DIR", cache_dir), \
                 mock.patch.object(wip_routes, "REPORT_PDF_CACHE_ENABLED", True), \
                 mock.patch.object(wip_routes, "MAINLINE_STRUCTURAL_SCHEME_SCRIPT", script), \
                 mock.patch.object(wip_routes, "_dashboard_source_fingerprint", return_value="newfingerprint"), \
                 mock.patch.object(wip_routes, "_run_mainline_structural_scheme_pipeline", side_effect=fake_run) as run_mock:
                estimate = wip_routes._daily_report_email_attachment_estimate_seconds(
                    "mainline_structural_scheme",
                    report_config,
                    date(2026, 9, 1),
                )
                attachment = wip_routes._daily_report_email_generator_attachment(
                    "mainline_structural_scheme",
                    report_config,
                    date(2026, 9, 1),
                )

            self.assertIn(b"generated", attachment["content"])
            self.assertFalse(attachment["from_cache"])
            self.assertIsNone(attachment["cache_mode"])
            self.assertIsNone(attachment["cache_created_at"])
            self.assertNotEqual(attachment["content"], cached_artifact.read_bytes())
            self.assertGreaterEqual(estimate, 60)
            run_mock.assert_called_once()

    def test_dim_like_cumulative_as_of_uses_last_day_period_and_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_mstroi_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template")
            calls: list[dict] = []

            def fake_cached(**kwargs):
                calls.append(kwargs)
                return b"xlsx"

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_generate_cached_xlsx_report", side_effect=fake_cached):
                content, filename_ascii, filename_utf8 = wip_routes._generate_dim_like_pipeline_xlsx(
                    report_key="mstroy",
                    script_name="generate_mstroi_report.py",
                    template=template,
                    output_name="mstroy.xlsx",
                    filename_prefix="VSM_MStroy",
                    filename_label="Отчет МСтрой",
                    d_from=date(2025, 9, 30),
                    d_to=date(2026, 7, 25),
                    filter_env={"DIM_REPORT_FILTER_WORK_TAGS": '["Выемка"]'},
                    cumulative_as_of_end_date=True,
                )

            self.assertEqual(content, b"xlsx")
            self.assertEqual(filename_ascii, "VSM_MStroy_Cumulative_As_Of_2026-07-25.xlsx")
            self.assertEqual(filename_utf8, "Отчет МСтрой накопительно на 2026-07-25.xlsx")
            self.assertEqual(calls[0]["d_from"], date(2026, 7, 25))
            self.assertEqual(calls[0]["d_to"], date(2026, 7, 25))
            self.assertEqual(calls[0]["cumulative_end_date"], date(2026, 7, 25))
            self.assertEqual(calls[0]["filter_env"]["DIM_REPORT_CUMULATIVE_AS_OF_END_DATE"], "1")
            self.assertEqual(calls[0]["filter_env"]["DIM_REPORT_SHOW_DAILY_PK_DETAILS"], "0")

    def test_run_xlsx_generator_passes_cumulative_end_date_when_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_general_report.py"
            template = tmp_path / "template.xlsx"
            output = tmp_path / "out.xlsx"
            captured: dict[str, object] = {}

            def fake_pipeline(cmd, cwd, **kwargs):
                captured["cmd"] = cmd
                captured["cwd"] = cwd
                captured["kwargs"] = kwargs
                return "ok"

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_run_report_pipeline", side_effect=fake_pipeline):
                result = wip_routes._run_xlsx_generator(
                    script,
                    template,
                    output,
                    date(2026, 7, 25),
                    date(2026, 7, 25),
                    cumulative_end_date=date(2026, 7, 25),
                )

            cmd = captured["cmd"]
            self.assertEqual(result, "ok")
            self.assertIn("--cumulative-end-date", cmd)
            self.assertEqual(cmd[cmd.index("--cumulative-end-date") + 1], "2026-07-25")

    def test_run_xlsx_generator_skips_cumulative_end_date_for_graph_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_mstroi_graph_report.py"
            template = tmp_path / "template.xlsx"
            output = tmp_path / "out.xlsx"
            captured: dict[str, object] = {}

            def fake_pipeline(cmd, cwd, **kwargs):
                captured["cmd"] = cmd
                return "ok"

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "_run_report_pipeline", side_effect=fake_pipeline):
                wip_routes._run_xlsx_generator(
                    script,
                    template,
                    output,
                    date(2026, 7, 25),
                    date(2026, 7, 25),
                    cumulative_end_date=date(2026, 7, 25),
                )

            self.assertNotIn("--cumulative-end-date", captured["cmd"])

    def test_xlsx_pipeline_job_info_uses_cumulative_as_of_dates_and_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            script = tmp_path / "generate_dim_report.py"
            template = tmp_path / "template.xlsx"
            script.write_text("print('generator')\n", encoding="utf-8")
            template.write_bytes(b"template")
            spec = {
                **wip_routes.XLSX_PIPELINE_REPORT_SPECS["dim"],
                "template": template,
            }

            with mock.patch.object(wip_routes, "DIM_PIPELINE_DIR", tmp_path), \
                 mock.patch.object(wip_routes, "XLSX_PIPELINE_REPORT_SPECS", {"dim": spec}), \
                 mock.patch.object(wip_routes, "_xlsx_report_cache_fingerprint", return_value="f" * 64):
                info = wip_routes._xlsx_pipeline_job_info(
                    "dim",
                    date(2025, 9, 30),
                    date(2026, 7, 25),
                    filter_env={},
                    cumulative_as_of_end_date=True,
                )

            self.assertEqual(info["date_from"], "2026-07-25")
            self.assertEqual(info["date_to"], "2026-07-25")
            self.assertEqual(info["request_date_from"], "2025-09-30")
            self.assertEqual(info["request_date_to"], "2026-07-25")
            self.assertEqual(info["filename_ascii"], "VSM_DiM_Cumulative_As_Of_2026-07-25.xlsx")
            self.assertEqual(info["filename_utf8"], "Отчет ДиМ накопительно на 2026-07-25.xlsx")
            self.assertEqual(info["cumulative_end_date"], "2026-07-25")


class EquipmentReportRowsTests(unittest.TestCase):
    def test_equipment_report_drops_mechanization_duplicate_when_shift_report_has_details(self):
        report_date = date(2026, 8, 11)
        base_rows = [
            {
                "report_equipment_unit_id": "m-132",
                "equipment_unit_id": "eu-132",
                "report_date": report_date,
                "shift": "day",
                "source_type": "mechanization_report_m",
                "section_code": "UCH_1",
                "equipment_type": "Бульдозер",
                "brand_model": "",
                "unit_number": "132",
                "plate_number": "3447ХА27",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "comment": "",
            },
            {
                "report_equipment_unit_id": "web-132",
                "equipment_unit_id": "eu-132",
                "report_date": report_date,
                "shift": "day",
                "source_type": "web_upload",
                "section_code": "UCH_1",
                "equipment_type": "бульдозер",
                "brand_model": "",
                "unit_number": "132",
                "plate_number": "3447ХА27",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "comment": "auto-added from work equipment row",
            },
            {
                "report_equipment_unit_id": "m-131",
                "equipment_unit_id": "eu-131",
                "report_date": report_date,
                "shift": "day",
                "source_type": "mechanization_report_m",
                "section_code": "UCH_1",
                "equipment_type": "Бульдозер",
                "brand_model": "",
                "unit_number": "131",
                "plate_number": "0332АА28",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "comment": "",
            },
        ]
        work_rows = [
            {
                "eq_id": "web-132",
                "work_objects": "Притрассовая дорога №13",
                "work_names": "Планировка площадей",
                "work_volume": 2550,
                "work_trips": 0,
            }
        ]

        def fake_query(sql, params=None):
            if "FROM report_equipment_units reu" in sql:
                return base_rows
            if "FROM work_item_equipment_usage wieu" in sql:
                return work_rows
            if "FROM material_movement_equipment_usage mmeu" in sql:
                return []
            return []

        with mock.patch.object(wip_routes, "query", side_effect=fake_query), \
             mock.patch.object(wip_routes, "_enrich_equipment_report_master_fields", lambda _rows: None):
            rows = wip_routes._query_equipment_report_rows(report_date, report_date, ["UCH_1"])

        rows_by_id = {row["report_equipment_unit_id"]: row for row in rows}
        self.assertNotIn("m-132", rows_by_id)
        self.assertEqual(rows_by_id["web-132"]["objects"], "Притрассовая дорога №13")
        self.assertEqual(rows_by_id["web-132"]["work_names"], "Планировка площадей")
        self.assertEqual(rows_by_id["m-131"]["objects"], wip_routes.EQUIPMENT_REPORT_MECHANIZATION_ONLY_OBJECTS)


if __name__ == "__main__":
    unittest.main()
