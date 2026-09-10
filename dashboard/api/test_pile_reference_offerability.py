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
fastapi_responses_stub.FileResponse = object
fastapi_responses_stub.Response = object
fastapi_responses_stub.StreamingResponse = object
sys.modules.setdefault("fastapi.responses", fastapi_responses_stub)

pydantic_stub = types.ModuleType("pydantic")
pydantic_stub.BaseModel = DummyBaseModel
pydantic_stub.Field = lambda default=None, **kwargs: default
sys.modules.setdefault("pydantic", pydantic_stub)

main_stub = types.ModuleType("main")
main_stub.get_conn = lambda: None
main_stub.query = lambda sql, params=None: []
main_stub.query_one = lambda sql, params=None: None
sys.modules.setdefault("main", main_stub)

auth_stub = types.ModuleType("auth")
auth_stub.current_user = lambda *args, **kwargs: None
auth_stub.require_admin = lambda *args, **kwargs: None
auth_stub.require_settings_manager = lambda *args, **kwargs: None
auth_stub.require_statements_project_writer = lambda *args, **kwargs: None
sys.modules.setdefault("auth", auth_stub)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wip_routes  # noqa: E402


def test_pile_offer_hides_excluded_trial_even_when_remaining_exists():
    row = {
        "field_type": "test",
        "pile_count": 9,
        "fact_count": 6,
        "comment": "source=xlsx; status=исключен; driven_trial=6",
    }

    assert wip_routes._reference_pile_catalog_status(row) == "excluded"
    assert wip_routes._reference_pile_is_offerable(row) is False


def test_pile_offer_hides_completed_trial_from_db_fact():
    row = {
        "field_type": "test",
        "pile_count": 9,
        "fact_count": 9,
        "comment": "source=xlsx; status=выдана; driven_trial=0",
    }

    assert wip_routes._reference_pile_remaining_count(row) == 0
    assert wip_routes._reference_pile_is_offerable(row) is False


def test_pile_offer_hides_completed_trial_from_catalog_driven_count():
    row = {
        "field_type": "test",
        "pile_count": 9,
        "fact_count": 0,
        "comment": "source=xlsx; status=выдана; driven_trial=9",
    }

    assert wip_routes._reference_pile_driven_count(row) == 9
    assert wip_routes._reference_pile_is_offerable(row) is False


def test_pile_offer_keeps_incomplete_main_field():
    row = {
        "field_type": "main",
        "pile_count": 3024,
        "fact_count": 1599,
        "comment": "source=xlsx",
    }

    assert wip_routes._reference_pile_remaining_count(row) == 1425
    assert wip_routes._reference_pile_is_offerable(row) is True


def test_pile_offer_prefers_structured_catalog_columns():
    row = {
        "field_type": "test",
        "pile_count": 9,
        "fact_count": 0,
        "catalog_status": "excluded",
        "driven_pile_count": 6,
        "comment": "source=xlsx; status=выдана; driven_trial=0",
    }

    assert wip_routes._reference_pile_catalog_status(row) == "excluded"
    assert wip_routes._reference_pile_driven_count(row) == 6
    assert wip_routes._reference_pile_is_offerable(row) is False
