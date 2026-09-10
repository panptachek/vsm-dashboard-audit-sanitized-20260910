#!/usr/bin/env python3
from __future__ import annotations

import sys
import types
from pathlib import Path


class DummyRouter:
    def __init__(self, *args, **kwargs):
        pass

    def get(self, *args, **kwargs):
        return lambda fn: fn

    post = get
    put = get
    patch = get
    delete = get


class DummyHTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class DummyUploadFile:
    pass


fastapi_stub = types.ModuleType("fastapi")
fastapi_stub.APIRouter = DummyRouter
fastapi_stub.Depends = lambda *args, **kwargs: None
fastapi_stub.File = lambda *args, **kwargs: None
fastapi_stub.HTTPException = DummyHTTPException
fastapi_stub.Query = lambda default=None, **kwargs: default
fastapi_stub.UploadFile = DummyUploadFile
sys.modules.setdefault("fastapi", fastapi_stub)

fastapi_responses_stub = types.ModuleType("fastapi.responses")
fastapi_responses_stub.StreamingResponse = object
sys.modules.setdefault("fastapi.responses", fastapi_responses_stub)

pydantic_stub = types.ModuleType("pydantic")
pydantic_stub.BaseModel = object
pydantic_stub.Field = lambda default=None, **kwargs: default
sys.modules.setdefault("pydantic", pydantic_stub)

main_stub = types.ModuleType("main")
main_stub.get_conn = lambda: None
main_stub.query = lambda sql, params=None: []
main_stub.query_one = lambda sql, params=None: {}
sys.modules.setdefault("main", main_stub)

auth_stub = types.ModuleType("auth")
auth_stub.current_user = lambda *args, **kwargs: None
auth_stub.require_admin = lambda *args, **kwargs: None
auth_stub.require_settings_manager = lambda *args, **kwargs: None
auth_stub.require_statements_project_writer = lambda *args, **kwargs: None
sys.modules.setdefault("auth", auth_stub)

parser_stub = types.ModuleType("report_text_parser")
parser_stub.parse_report_text = lambda *args, **kwargs: {}
parser_stub.sanitize_personal_report_text = lambda text: text
parser_stub.split_report_texts = lambda text: [text]
sys.modules.setdefault("report_text_parser", parser_stub)

xlsx_stub = types.ModuleType("xlsx_report_adapter")
xlsx_stub.xlsx_bytes_to_report_text = lambda *args, **kwargs: ""
sys.modules.setdefault("xlsx_report_adapter", xlsx_stub)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reports_routes  # noqa: E402


def _sample_report_row(**overrides):
    row = {
        "id": "r1",
        "report_date": "2026-05-05",
        "shift": "day",
        "source_type": "web_manual",
        "status": "pending_review",
        "parse_status": "parsed",
        "operator_status": "pending",
        "created_at": "2026-06-05T00:00:00+00:00",
        "uploaded_by_username": "isso_uch2",
        "user_flags": None,
        "section_code": "UCH_2",
        "section_name": "Участок 2",
        "work_items_count": 1,
        "movements_count": 0,
        "equipment_count": 0,
        "review_payload": None,
    }
    row.update(overrides)
    return row


def test_list_reports_legacy_returns_array_and_keeps_default_limit(monkeypatch):
    calls = []

    def fake_query(sql, params=None):
        calls.append((sql, list(params or [])))
        return [_sample_report_row()]

    monkeypatch.setattr(reports_routes, "query", fake_query)
    monkeypatch.setattr(reports_routes, "_ensure_report_review_schema", lambda: None)
    monkeypatch.setattr(reports_routes, "_load_pk_validation_boundaries", lambda: [])

    result = reports_routes.list_reports()

    assert isinstance(result, list)
    assert result[0]["id"] == "r1"
    assert "LIMIT %s" in calls[0][0]
    assert "web_pile_control" not in calls[0][0]
    assert calls[0][1] == [100, 0]


def test_list_reports_paged_filters_by_date_and_uploader_and_returns_total(monkeypatch):
    calls = []

    def fake_query(sql, params=None):
        calls.append((sql, list(params or [])))
        if "GROUP BY dr.uploaded_by_username" in sql:
            return [{"value": "isso_uch2", "count": 1}]
        if "COUNT(*)" in sql:
            return [{"total": 1}]
        return [_sample_report_row()]

    monkeypatch.setattr(reports_routes, "query", fake_query)
    monkeypatch.setattr(reports_routes, "_ensure_report_review_schema", lambda: None)
    monkeypatch.setattr(reports_routes, "_load_pk_validation_boundaries", lambda: [])

    result = reports_routes.list_reports(
        limit=25,
        offset=50,
        paged=True,
        date_from="2026-05-01",
        date_to="2026-05-31",
        uploaded_by="isso_uch2",
    )

    assert result["total"] == 1
    assert result["limit"] == 25
    assert result["offset"] == 50
    assert result["rows"][0]["uploaded_by_username"] == "isso_uch2"
    assert result["filter_options"]["uploaders"] == [{"value": "isso_uch2", "label": "isso_uch2", "count": 1}]

    list_sql, list_params = calls[0]
    assert "dr.report_date >= %s" in list_sql
    assert "dr.report_date <= %s" in list_sql
    assert "COALESCE(dr.uploaded_by_username, '') = %s" in list_sql
    assert "web_pile_control" not in list_sql
    assert list_params[-2:] == [25, 50]
    assert "2026-05-01" in list_params
    assert "2026-05-31" in list_params
    assert "isso_uch2" in list_params


def test_stored_report_payload_keeps_confirmed_fill_review_payload(monkeypatch):
    def fail_query(_sql, _params=None):
        raise AssertionError("confirmed fill preview should use review_payload before DB row rebuild")

    monkeypatch.setattr(reports_routes, "query", fail_query)
    monkeypatch.setattr(reports_routes, "_refresh_payload_reference_metadata", lambda payload: payload)
    payload = {
        "report_mode": "fill",
        "header": {"report_date": "2026-07-07"},
        "fill_statuses": [{"road_code": "АД1", "pioneer_fill": "ПК1+00-ПК2+00"}],
        "mainline_fill_statuses": [],
        "raw_text": "saved payload text",
    }
    meta = {
        "status": "confirmed",
        "report_date": "2026-07-07",
        "shift": "unknown",
        "section_code": None,
        "section_name": None,
        "review_payload": payload,
        "initial_parse_payload": {"source": "initial"},
    }

    result = reports_routes._stored_report_payload("report-1", meta, "db raw text")

    assert result["report_mode"] == "fill"
    assert result["fill_statuses"] == payload["fill_statuses"]
    assert result["initial_parse"] == {"source": "initial"}
    assert result["raw_text"] == "db raw text"
    assert result["header"]["shift"] == "unknown"


def test_move_report_child_rows_moves_mainline_fill_segments_when_table_exists(monkeypatch):
    calls = []

    class Cursor:
        def execute(self, sql, params=None):
            calls.append((sql, params))

    monkeypatch.setattr(reports_routes, "_table_exists_cur", lambda _cur, table_name: table_name == "mainline_fill_status_segments")
    monkeypatch.setattr(reports_routes, "_column_exists_cur", lambda _cur, table_name, column_name: table_name == "temporary_road_status_segments" and column_name == "daily_report_id")

    reports_routes._move_report_child_rows(Cursor(), "source-id", "target-id")

    assert any("UPDATE mainline_fill_status_segments SET daily_report_id" in sql for sql, _params in calls)




def test_report_review_schema_prepared_requires_temp_road_report_scoped_indexes(monkeypatch):
    columns = [
        {"table_name": table_name, "column_name": column_name}
        for table_name, column_names in reports_routes.REPORT_REVIEW_REQUIRED_COLUMNS.items()
        for column_name in column_names
    ]
    tables = [{"table_name": table_name} for table_name in reports_routes.REPORT_REVIEW_REQUIRED_TABLES]

    def fake_query_with_old_index(sql, params=None):
        if "information_schema.columns" in sql:
            return columns
        if "information_schema.tables" in sql:
            return tables
        if "pg_indexes" in sql:
            return [{"indexname": "temporary_road_status_segments_unique_idx"}]
        raise AssertionError(sql)

    monkeypatch.setattr(reports_routes, "query", fake_query_with_old_index)
    assert reports_routes._report_review_schema_prepared() is False

    def fake_query_with_new_indexes(sql, params=None):
        if "information_schema.columns" in sql:
            return columns
        if "information_schema.tables" in sql:
            return tables
        if "pg_indexes" in sql:
            return [{"indexname": index_name} for index_name in reports_routes.REPORT_REVIEW_REQUIRED_INDEXES]
        raise AssertionError(sql)

    monkeypatch.setattr(reports_routes, "query", fake_query_with_new_indexes)
    assert reports_routes._report_review_schema_prepared() is True


def test_ensure_report_review_schema_replaces_global_temp_road_unique_index(monkeypatch):
    calls = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params=None):
            calls.append((sql, params))

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def cursor(self):
            return Cursor()

        def close(self):
            pass

    monkeypatch.setattr(reports_routes, "_REVIEW_SCHEMA_READY", False)
    monkeypatch.setattr(reports_routes, "_report_review_schema_prepared", lambda: False)
    monkeypatch.setattr(reports_routes, "get_conn", lambda: Conn())
    monkeypatch.setattr(reports_routes, "_ensure_pile_field_object_links", lambda _cur: None)

    reports_routes._ensure_report_review_schema()

    sql_text = "\n".join(sql for sql, _params in calls)
    assert "DROP INDEX IF EXISTS temporary_road_status_segments_unique_idx" in sql_text
    assert "temporary_road_status_segments_report_unique_idx" in sql_text
    assert "WHERE daily_report_id IS NOT NULL" in sql_text
    assert "temporary_road_status_segments_unowned_unique_idx" in sql_text
    assert "WHERE daily_report_id IS NULL" in sql_text


def test_store_temp_road_status_segment_claims_matching_pending_legacy_row_before_insert():
    calls = []

    class Cursor:
        def __init__(self):
            self.fetches = [{"id": "legacy-segment"}]

        def execute(self, sql, params=None):
            calls.append((sql, params))

        def fetchone(self):
            return self.fetches.pop(0)

    stored = reports_routes._store_temp_road_status_segment(
        Cursor(),
        report_id="report-1",
        road={"id": "road-1", "object_id": "object-1"},
        report_date="2026-07-09",
        status_type="shpgs_done",
        pk_system="rail",
        road_pk_start=None,
        road_pk_end=None,
        rail_pk_start=294500,
        rail_pk_end=294700,
        source_reference="fill-report-manual",
        comment="участок=UCH_3",
        review_tag="pending_admin_review:report-1",
    )

    assert stored is True
    assert len(calls) == 1
    update_sql, params = calls[0]
    assert "UPDATE temporary_road_status_segments" in update_sql
    assert "daily_report_id IS NULL" in update_sql
    assert "review_tag = %s" in update_sql
    assert params[0] == "report-1"
    assert params[4] == "pending_admin_review:report-1"
    assert params[5] == "pending_admin_review:report-1"


def test_store_temp_road_status_segment_inserts_report_owned_row_when_no_legacy_match():
    calls = []

    class Cursor:
        def __init__(self):
            self.fetches = [None, {"id": "new-segment"}]

        def execute(self, sql, params=None):
            calls.append((sql, params))

        def fetchone(self):
            return self.fetches.pop(0)

    stored = reports_routes._store_temp_road_status_segment(
        Cursor(),
        report_id="report-2",
        road={"id": "road-1", "object_id": "object-1"},
        report_date="2026-07-09",
        status_type="dso",
        pk_system="road",
        road_pk_start=10,
        road_pk_end=20,
        rail_pk_start=None,
        rail_pk_end=None,
        source_reference="report.xlsx",
        comment=None,
        review_tag="pending_admin_review:report-2",
    )

    assert stored is True
    assert len(calls) == 2
    insert_sql, params = calls[1]
    assert "INSERT INTO temporary_road_status_segments" in insert_sql
    assert "daily_report_id" in insert_sql
    assert params[1] == "report-2"
    assert params[13] == "pending_admin_review:report-2"
