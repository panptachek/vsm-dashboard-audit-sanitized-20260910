#!/usr/bin/env python3
from __future__ import annotations

import sys
import inspect
import types
from datetime import datetime, timezone


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


class DummyBaseModel:
    pass


fastapi_stub = types.ModuleType("fastapi")
fastapi_stub.APIRouter = DummyRouter
fastapi_stub.Depends = lambda *args, **kwargs: None
fastapi_stub.File = lambda *args, **kwargs: None
fastapi_stub.HTTPException = DummyHTTPException
fastapi_stub.Query = lambda default=None, **kwargs: default
fastapi_stub.UploadFile = object
sys.modules.setdefault("fastapi", fastapi_stub)

fastapi_responses_stub = types.ModuleType("fastapi.responses")
fastapi_responses_stub.StreamingResponse = object
sys.modules.setdefault("fastapi.responses", fastapi_responses_stub)

pydantic_stub = types.ModuleType("pydantic")
pydantic_stub.BaseModel = DummyBaseModel
pydantic_stub.Field = lambda default=None, default_factory=None, **kwargs: default_factory() if default_factory else default
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
sys.modules.setdefault("auth", auth_stub)

parser_stub = types.ModuleType("report_text_parser")
parser_stub.parse_report_text = lambda filename, text: {}
parser_stub.sanitize_personal_report_text = lambda text: text
parser_stub.split_report_texts = lambda text: [text]
sys.modules.setdefault("report_text_parser", parser_stub)

xlsx_stub = types.ModuleType("xlsx_report_adapter")
xlsx_stub.xlsx_bytes_to_report_text = lambda blob: ""
sys.modules.setdefault("xlsx_report_adapter", xlsx_stub)

import reports_routes


def test_report_quality_source_filter_excludes_non_master_report_sources() -> None:
    assert not reports_routes._report_quality_source_allowed("mechanization_report_m")
    assert not reports_routes._report_quality_source_allowed("web_fill_report")
    assert not reports_routes._report_quality_source_allowed("web_pile_control")
    assert not reports_routes._report_quality_source_allowed("manual_correction")
    assert reports_routes._report_quality_source_allowed("web_upload")
    assert reports_routes._report_quality_source_allowed("web_manual")
    assert reports_routes._report_quality_source_allowed("hermes")


def test_report_quality_pile_shift_detection_uses_payload_first_and_account_fallback() -> None:
    assert reports_routes._report_quality_payload_marks_pile_shift({"review_flags": ["сваи"]})
    assert reports_routes._report_quality_payload_marks_pile_shift({"header": {"author": "бригада ИССО"}})
    assert reports_routes._report_quality_payload_marks_pile_shift({"piles": [{"field_code": "SF-1", "count": 4}]})
    assert reports_routes._report_quality_account_marks_pile_shift("isso_uch6")
    assert not reports_routes._report_quality_account_marks_pile_shift("admin_oks")


def test_report_quality_diff_counts_rows_fields_and_ignores_fill_statuses() -> None:
    uploaded = {
        "header": {"report_date": "2026-08-01", "shift": "day", "section_code": "1"},
        "main_works": [
            {"work_name": "Устройство насыпи", "constructive": "ОХ", "pk_start": 2640, "volume": 10},
        ],
        "fill_statuses": [{"road_code": "АД1", "status_type": "ready"}],
    }
    day3 = {
        "header": {"report_date": "2026-08-01", "shift": "night", "section_code": "1"},
        "main_works": [
            {"work_name": "Устройство насыпи", "constructive": "ОХ", "pk_start": 2640, "volume": 10},
            {"work_name": "Планировка", "constructive": "ОХ", "pk_start": 2641, "volume": 5},
        ],
        "fill_statuses": [{"road_code": "АД1", "status_type": "no_work"}],
    }

    diff = reports_routes._report_quality_diff(uploaded, day3)

    assert diff["comparable_units"] == 13
    assert diff["changed_units"] == 6
    assert diff["changed_percent"] == 46.15
    assert diff["added_rows"] == 1
    assert diff["removed_rows"] == 0
    assert diff["changed_rows"] == 0
    assert diff["changed_fields"] == 5


def test_ensure_review_flags_preserves_master_report_flags() -> None:
    master = reports_routes._ensure_review_flags({"review_flags": ["сваи"]}, "web_upload")
    pile_control = reports_routes._ensure_review_flags({"review_flags": ["сваи"]}, "web_pile_control")

    assert master["review_flags"] == ["сваи"]
    assert pile_control["review_flags"] == ["сваи", "isso", "контроль свай"]


def test_section_rating_upload_score_uses_moscow_deadline_window() -> None:
    assert reports_routes._section_rating_upload_score(datetime(2026, 8, 25, 5, 59, tzinfo=timezone.utc)) == 100.0
    assert reports_routes._section_rating_upload_score(datetime(2026, 8, 25, 6, 0, tzinfo=timezone.utc)) == 100.0
    assert reports_routes._section_rating_upload_score(datetime(2026, 8, 25, 7, 30, tzinfo=timezone.utc)) == 50.0
    assert reports_routes._section_rating_upload_score(datetime(2026, 8, 25, 9, 0, tzinfo=timezone.utc)) == 0.0
    assert reports_routes._section_rating_upload_score(datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)) == 0.0


def test_equipment_work_hours_sum_is_limited_to_shift() -> None:
    valid = {
        "transport": [{
            "equipment_type": "самосвал",
            "unit_number": "913",
            "trips": [{"material": "песок", "from": "карьер", "to": "АД5", "work_hours": 4}],
        }],
        "main_works": [{
            "equipment_type": "самосвал",
            "unit_number": "913",
            "work_name": "Планировка",
            "work_hours": 7,
        }],
    }
    reports_routes._validate_payload_equipment_work_hours(valid)

    invalid = {
        **valid,
        "main_works": [{**valid["main_works"][0], "work_hours": 7.25}],
    }
    try:
        reports_routes._validate_payload_equipment_work_hours(invalid)
    except reports_routes.HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Сумма часов больше продолжительности рабочей смены, проверьте работу «Планировка»"
    else:
        raise AssertionError("expected work-hours validation error")


def test_section_rating_mstroy_score_is_inverse_difference_percent() -> None:
    assert reports_routes._section_rating_mstroy_score(0) == 100.0
    assert reports_routes._section_rating_mstroy_score(12.5) == 87.5
    assert reports_routes._section_rating_mstroy_score(125) == 0.0


def test_section_rating_details_require_existing_daily_report_rows() -> None:
    source = inspect.getsource(reports_routes._section_rating_report_details_by_section)

    assert "JOIN daily_reports dr ON dr.id = up.daily_report_id" in source
    assert "JOIN daily_reports dr ON dr.id = m.daily_report_id" in source
    assert "LEFT JOIN daily_reports dr ON dr.id = up.daily_report_id" not in source
    assert "LEFT JOIN daily_reports dr ON dr.id = m.daily_report_id" not in source
