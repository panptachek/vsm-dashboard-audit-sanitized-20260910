#!/usr/bin/env python3
from __future__ import annotations

from io import BytesIO
import sys
import types

from openpyxl import Workbook


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
fastapi_stub.Header = lambda *args, **kwargs: None
fastapi_stub.HTTPException = DummyHTTPException
fastapi_stub.Query = lambda *args, **kwargs: None
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
main_stub.query_one = lambda sql, params=None: {}
sys.modules.setdefault("main", main_stub)

auth_stub = types.ModuleType("auth")
auth_stub.current_user = lambda *args, **kwargs: None
auth_stub.require_admin = lambda *args, **kwargs: None
auth_stub.require_settings_manager = lambda *args, **kwargs: None
auth_stub.require_statements_project_writer = lambda *args, **kwargs: None
sys.modules.setdefault("auth", auth_stub)

xlsx_stub = types.ModuleType("xlsx_report_adapter")
xlsx_stub.xlsx_bytes_to_report_text = lambda blob: ""
sys.modules.setdefault("xlsx_report_adapter", xlsx_stub)

import reports_routes


def test_alias_lookup_normalizes_case_and_punctuation():
    aliases = {"material": {"крупный песок": "COARSE_SAND"}}
    assert reports_routes._resolve(aliases, "material", "  Крупный-песок! ") == "COARSE_SAND"


def test_load_aliases_omits_ambiguous_normalized_aliases():
    original_query = reports_routes.query
    original_cache = reports_routes._ALIAS_CACHE
    reports_routes.query = lambda sql, params=None: [
        {"kind": "material", "alias_text": "Песок крупный", "canonical_code": "COARSE_SAND"},
        {"kind": "material", "alias_text": "песок-крупный", "canonical_code": "SAND"},
        {"kind": "material", "alias_text": "обычный песок", "canonical_code": "SAND"},
    ]
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        aliases = reports_routes.load_aliases(force=True)
        assert "песок крупный" not in aliases["material"]
        assert aliases["material"]["обычный песок"] == "SAND"
    finally:
        reports_routes.query = original_query
        reports_routes._ALIAS_CACHE = original_cache


def test_classify_material_movement_type_uses_endpoint_semantics():
    cases = [
        (("BORROW_PIT", "TEMP_ROAD"), "pit_to_constructive"),
        (("BORROW_PIT", "STOCKPILE"), "pit_to_stockpile"),
        (("STOCKPILE", "TECH_ROAD"), "stockpile_to_constructive"),
        (("STOCKPILE", "STOCKPILE"), "stockpile_to_stockpile"),
        (("TEMP_ROAD", "STOCKPILE"), "constructive_to_stockpile"),
        (("TEMP_ROAD", "TECH_ROAD"), "constructive_to_constructive"),
        (("MAIN_TRACK", "TEMP_ROAD"), "constructive_to_constructive"),
    ]

    for endpoint_types, expected in cases:
        assert reports_routes.classify_material_movement_type(*endpoint_types) == expected


SAMPLE = """
Дата - 04.05.2026
Смена - день
Участок - участок №1
|
===Основные работы===
-ОХ-
/Разработка выемки/
ПК ВСЖМ: ПК2654+50-ПК2655+20
V = 620 м3
|
-АД5-
/Устройство насыпи из песка/
ПК ВСЖМ: ПК2694+00
ПК АД: ПК51+20-ПК53+20
V = 1804,7 м3
===Сопутствующие работы===
-Работа на ИССО-
/Работа на ИССО/
ПК ВСЖМ: ПК2658
V = 1 шт
"""


def fake_query(sql: str, params=None) -> list[dict]:
    if "FROM work_type_aliases" in sql:
        return []
    if "FROM work_types" in sql:
        return [
            {"code": "EARTH_EXCAVATION", "name": "Разработка выемки", "default_unit": "м3", "work_group": "earthwork"},
            {"code": "EMBANKMENT_CONSTRUCTION", "name": "Устройство насыпи", "default_unit": "м3", "work_group": "earthwork"},
            {"code": "SOIL_WORK", "name": "Грунтовые работы", "default_unit": "м3", "work_group": "earthwork"},
        ]
    if "FROM materials" in sql:
        return [
            {"code": "SAND", "name": "Песок", "default_unit": "м3"},
            {"code": "SOIL", "name": "Грунт", "default_unit": "м3"},
            {"code": "SHPGS", "name": "ЩПГС", "default_unit": "м3"},
        ]
    if "FROM objects o" in sql:
        return [
            {
                "code": "MAIN_001",
                "label": "Основной ход, участок 1",
                "object_type_code": "MAIN",
                "constructive_code": "MAIN",
                "constructive_name": "Основной ход",
            },
            {
                "code": "MAIN_005",
                "label": "Основной ход, участок 5",
                "object_type_code": "MAIN",
                "constructive_code": "MAIN",
                "constructive_name": "Основной ход",
            },
            {
                "code": "VPD_005",
                "label": "Притрассовая дорога №5",
                "object_type_code": "TEMP_ROAD",
                "constructive_code": "VPD",
                "constructive_name": "Временные притрассовые дороги",
            },
            {
                "code": "STUFF_1",
                "label": "Сопутствующее участок №1",
                "object_type_code": "OTHER",
                "constructive_code": "STU",
                "constructive_name": "Сопутствующее",
            },
            {
                "code": "PLATFORM_PK2702",
                "label": "Устройство площадки и проезда к ИССО ПК2702",
                "object_type_code": "ISSO_ACCESS",
                "constructive_code": "STU",
                "constructive_name": "Сопутствующее",
            },
        ]
    if "FROM constructives" in sql:
        return [
            {"code": "MAIN", "name": "Основной ход"},
            {"code": "VPD", "name": "Временные притрассовые дороги"},
            {"code": "STU", "name": "Сопутствующее"},
        ]
    if "FROM equipment_unit_identifiers" in sql:
        normalized_values = set((params or [[]])[0] or [])
        partial_patterns = list((params or [[], []])[1] or [])
        wants_plate_fragment = "7439АР" in normalized_values or any("7439АР" in pattern for pattern in partial_patterns)
        wants_stale_5749_alias = "5749ХА" in normalized_values or any("5749ХА" in pattern for pattern in partial_patterns)
        wants_t930ea = "Т930ЕА" in normalized_values or any("Т930ЕА" in pattern for pattern in partial_patterns)
        wants_roller_160 = "160" in normalized_values
        wants_roller_161 = "161" in normalized_values
        wants_excavator_546 = "546" in normalized_values
        wants_excavator_347 = "347" in normalized_values or any("347" in pattern for pattern in partial_patterns)
        if wants_stale_5749_alias:
            return [
                {
                    "id": "mixed-excavator-5148",
                    "equipment_type": "Экскаватор",
                    "brand_model": "HITACHI 33",
                    "unit_number": "846",
                    "plate_number": "5148ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-20",
                    "location": "7-й участок",
                    "updated_at": "2026-08-20T00:00:00",
                    "matched_identifiers": ["plate:5749ХА27"],
                },
                {
                    "id": "current-excavator-5749",
                    "equipment_type": "Экскаватор",
                    "brand_model": "SANY 215 колесный",
                    "unit_number": "545",
                    "plate_number": "5749ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-20",
                    "location": "5-й участок",
                    "updated_at": "2026-08-20T00:00:00",
                    "matched_identifiers": ["plate:5749ХА27"],
                },
            ]
        if wants_t930ea:
            return [
                {
                    "id": "dump-truck-723",
                    "equipment_type": "Самосвал",
                    "brand_model": "FAW J6 6*6",
                    "unit_number": "723",
                    "plate_number": "Т930ЕА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-24",
                    "location": "7-й участок",
                    "updated_at": "2026-08-24T00:00:00",
                    "matched_identifiers": ["plate:Т930ЕА27"],
                }
            ]
        if wants_roller_160:
            return [
                {
                    "id": "roller-160",
                    "equipment_type": "Каток",
                    "brand_model": "SANY 180",
                    "unit_number": "160",
                    "plate_number": "3581ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-24",
                    "location": "1-й участок",
                    "updated_at": "2026-08-24T00:00:00",
                    "matched_identifiers": ["unit:160"],
                },
                {
                    "id": "tractor-160",
                    "equipment_type": "Седельный тягач",
                    "brand_model": "SHACMAN SX42586W385C",
                    "unit_number": "160",
                    "plate_number": "С430ХУ27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Сводная таблица Сачков",
                    "source_date": "2026-08-23",
                    "location": "2-й участок",
                    "updated_at": "2026-08-23T00:00:00",
                    "matched_identifiers": ["unit:160"],
                },
            ]
        if wants_roller_161:
            return [
                {
                    "id": "roller-161",
                    "equipment_type": "Каток",
                    "brand_model": "XCMG 183",
                    "unit_number": "161",
                    "plate_number": "5885ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-24",
                    "location": "Участок 4",
                    "updated_at": "2026-08-24T00:00:00",
                    "matched_identifiers": ["unit:161"],
                },
                {
                    "id": "tractor-161",
                    "equipment_type": "Седельный тягач",
                    "brand_model": "SHAHMAN SX 42586W385",
                    "unit_number": "161",
                    "plate_number": "С621ХВ27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-23",
                    "location": "Участок 4",
                    "updated_at": "2026-08-23T00:00:00",
                    "matched_identifiers": ["unit:161"],
                },
            ]
        if wants_excavator_347:
            return [
                {
                    "id": "mixer-347-plate-fragment",
                    "equipment_type": "Автобетоносмеситель",
                    "brand_model": "УРАЛ 5670А4 (6м3)",
                    "unit_number": "0-181",
                    "plate_number": "О347СМ196",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "standby",
                    "source_name": "Отчет М",
                    "source_date": "2026-08-24",
                    "location": "РММ",
                    "updated_at": "2026-08-24T00:00:00",
                    "matched_identifiers": ["plate:О347СМ196"],
                }
            ]
        if wants_excavator_546:
            return [
                {
                    "id": "hitachi-546",
                    "equipment_type": "Экскаватор",
                    "brand_model": "HITACHI 330",
                    "unit_number": "546",
                    "plate_number": "5745ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Сводная таблица Сачков",
                    "source_date": "2026-08-26",
                    "location": "Участок 5",
                    "updated_at": "2026-08-26T00:00:00",
                    "matched_identifiers": ["unit:546"],
                },
                {
                    "id": "lonking-546",
                    "equipment_type": "Экскаватор",
                    "brand_model": "LONKING",
                    "unit_number": "546",
                    "plate_number": "6965ХА27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Сводная таблица Сачков",
                    "source_date": "2026-08-26",
                    "location": "Участок 5",
                    "updated_at": "2026-08-26T00:00:00",
                    "matched_identifiers": ["unit:546"],
                },
            ]
        if "709" in normalized_values:
            return [
                {
                    "id": "alias-shift-513",
                    "equipment_type": "самосвал",
                    "brand_model": "FAW J6 6*4",
                    "unit_number": "513",
                    "plate_number": "С393ХЕ27",
                    "ownership_type": "own",
                    "contractor_name": "ЖДС",
                    "status": "working",
                    "source_name": "Отчет М",
                    "source_date": "2026-07-10",
                    "location": "Участок 5",
                    "updated_at": "2026-07-10T00:00:00",
                    "matched_identifiers": ["unit:709"],
                }
            ]
        rows = [
            {
                "id": "master-older",
                "equipment_type": "самосвал",
                "brand_model": "FAW",
                "unit_number": "208",
                "plate_number": "А208АА27",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "source_name": "Отчет М",
                "source_date": "2026-05-12",
                "location": "Участок 1",
                "updated_at": "2026-05-12T00:00:00",
                "matched_identifiers": ["unit:208"],
            },
            {
                "id": "master-newer",
                "equipment_type": "самосвал",
                "brand_model": "FAW",
                "unit_number": "208",
                "plate_number": "А208АА27",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "source_name": "Отчет М",
                "source_date": "2026-05-13",
                "location": "Участок 1",
                "updated_at": "2026-05-13T00:00:00",
                "matched_identifiers": ["unit:208", "plate:А208АА27"],
            },
            {
                "id": "partial-only",
                "equipment_type": "самосвал",
                "brand_model": "FAW",
                "unit_number": "714",
                "plate_number": "А208ВВ27",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "source_name": "Отчет М",
                "source_date": "2026-05-13",
                "location": "Участок 1",
                "updated_at": "2026-05-13T00:00:00",
                "matched_identifiers": ["plate:А208ВВ27"],
            },
            {
                "id": "plate-fragment",
                "equipment_type": "самосвал",
                "brand_model": "SHACMAN",
                "unit_number": "743",
                "plate_number": "А7439АР53",
                "ownership_type": "own",
                "contractor_name": "ЖДС",
                "status": "working",
                "source_name": "Отчет М",
                "source_date": "2026-05-13",
                "location": "Участок 1",
                "updated_at": "2026-05-13T00:00:00",
                "matched_identifiers": ["plate:А7439АР53"],
            },
        ]
        return [row for row in rows if row["id"] == "plate-fragment"] if wants_plate_fragment else rows[:3]
    return []


def assert_parser_prefill_can_be_corrected_by_same_section_candidate() -> None:
    vpd_candidates = [
        {"code": "VPD_014", "label": "Притрассовая дорога №14", "score": 1.1, "section_code": "UCH_2"},
        {"code": "VPD_001", "label": "Притрассовая дорога №1", "score": 0.92, "section_code": "UCH_3"},
    ]
    assert reports_routes._select_reference_code(
        "object",
        "VPD_001",
        vpd_candidates,
        section_code="UCH_2",
    ) == "VPD_014"

    stockpile_candidates = [
        {"code": "STOCKPILE_3284", "label": "Накопитель песка ПК3284", "score": 0.897, "section_code": "UCH_8"},
        {"code": "STOCKPILE_2700", "label": "Накопитель песка АД5 ПК2700", "score": 0.92, "section_code": "UCH_1"},
    ]
    assert reports_routes._select_reference_code(
        "object",
        "STOCKPILE_2700",
        stockpile_candidates,
        section_code="UCH_8",
    ) == "STOCKPILE_3284"

    assert reports_routes._select_reference_code(
        "object",
        "STOCKPILE_2700",
        stockpile_candidates,
        section_code="UCH_1",
    ) == "STOCKPILE_2700"


def assert_temp_road_exact_number_beats_prefix_prefill() -> None:
    original_loader = reports_routes.load_reference_catalog
    try:
        catalog = []
        for code, label in [
            ("VPD_001", "Притрассовая дорога №1"),
            ("VPD_014", "Притрассовая дорога №14"),
        ]:
            catalog.append(reports_routes._prepare_reference_entry({
                "code": code,
                "label": label,
                "object_type_code": "TEMP_ROAD",
                "aliases": reports_routes._object_aliases(code, label, "TEMP_ROAD"),
            }))
        reports_routes.load_reference_catalog = lambda force=False: {"object": catalog}
        candidates = reports_routes._reference_candidates(
            "object",
            "АД14 ПК 2796+75-2797+40",
            existing_code="VPD_001",
            limit=4,
        )
        assert candidates[0]["code"] == "VPD_014"
        assert reports_routes._select_reference_code("object", "VPD_001", candidates) == "VPD_014"
    finally:
        reports_routes.load_reference_catalog = original_loader


def test_exact_quarry_alias_beats_same_section_road_name() -> None:
    quarry_code = "QUARRY_08"
    road_code = "ROAD_MAINT_STAGE3_063"
    quarry = reports_routes._prepare_reference_entry({
        "code": quarry_code,
        "label": "Карьер Великий",
        "object_type_code": "BORROW_PIT",
        "section_code": None,
        "aliases": reports_routes._object_aliases(quarry_code, "Карьер Великий", "BORROW_PIT"),
    })
    road_label = "Карьер «Великий 1» - выезд на дорогу Гузятино-Токарево"
    road = reports_routes._prepare_reference_entry({
        "code": road_code,
        "label": road_label,
        "object_type_code": "SERVICE_ROAD",
        "section_code": "UCH_6",
        "aliases": reports_routes._object_aliases(road_code, road_label, "SERVICE_ROAD"),
    })
    catalog = {"object": [road, quarry], "material": [], "work_type": []}
    original_aliases = reports_routes.load_aliases
    original_catalog = reports_routes.load_reference_catalog
    reports_routes.load_aliases = lambda force=False: {"object": {"карьер великий": road_code}}
    reports_routes.load_reference_catalog = lambda force=False: catalog
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        candidates = reports_routes._reference_candidates(
            "object",
            "Карьер Великий",
            existing_code=road_code,
            section_code="UCH_6",
            limit=4,
        )
        assert candidates[0]["code"] == quarry_code
        assert candidates[0]["source"] == "exact"
        assert reports_routes._select_reference_code(
            "object",
            road_code,
            candidates,
            section_code="UCH_6",
        ) == quarry_code

        road_candidates = reports_routes._reference_candidates(
            "object",
            road_label,
            section_code="UCH_6",
            limit=4,
        )
        assert road_candidates[0]["code"] == road_code

        auto_payload = {
            "header": {"section_code": "UCH_6"},
            "transport": [{
                "trips": [{
                    "from": "Карьер Великий",
                    "from_object_code": road_code,
                    "to": "Карьер Великий",
                    "to_object_code": road_code,
                }],
            }],
            "main_works": [{
                "constructive": "Карьер Великий",
                "object_code": road_code,
                "constructive_code": road_code,
            }],
        }
        refreshed = reports_routes._refresh_payload_reference_metadata(auto_payload)

        manual_payload = {
            "header": {"section_code": "UCH_6"},
            "main_works": [{
                "constructive": "Карьер Великий",
                "object_code": road_code,
                "constructive_code": road_code,
                "object_selection_mode": "manual",
            }],
        }
        manual_refreshed = reports_routes._refresh_payload_reference_metadata(manual_payload)
    finally:
        reports_routes.load_aliases = original_aliases
        reports_routes.load_reference_catalog = original_catalog
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
        reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}

    trip = refreshed["transport"][0]["trips"][0]
    assert trip["from_object_code"] == quarry_code
    assert trip["to_object_code"] == quarry_code
    work = refreshed["main_works"][0]
    assert work["object_code"] == quarry_code
    assert work["constructive_code"] == quarry_code
    assert manual_refreshed["main_works"][0]["object_code"] == road_code


def assert_ad_pk_autofills_rail_pk_from_temp_road_mapping() -> None:
    original_query = reports_routes.query

    def mapping_query(sql: str, params=None) -> list[dict]:
        if "FROM temporary_roads tr" in sql and "temporary_road_pk_mappings" in sql:
            return [{
                "road_code": "АД5",
                "mapping_type": "full_axis_range",
                "ad_pk_start": 0,
                "ad_pk_end": 10000,
                "rail_pk_start": 260000,
                "rail_pk_end": 270000,
            }]
        return []

    payload = types.SimpleNamespace(
        main_works=[{
            "constructive": "АД5",
            "work_name": "Устройство насыпи из песка",
            "pk_ad_raw": "ПК51+20-ПК53+20",
        }],
        aux_works=[],
    )
    reports_routes.query = mapping_query
    try:
        updated = reports_routes._enrich_payload_ad_rail_from_temp_roads(payload)
    finally:
        reports_routes.query = original_query

    row = payload.main_works[0]
    assert updated == 1
    assert row["pk_rail_start"] == 265120
    assert row["pk_rail_end"] == 265320
    assert row["pk_start"] == 265120
    assert row["pk_end"] == 265320
    assert row["pk_rail_raw"] == "ПК2651+20 - ПК2653+20"
    assert row["pk_rail_source"] == "auto_from_ad"


def assert_pile_field_type_defaults_to_main_unless_explicit() -> None:
    assert reports_routes._desired_pile_field_type({"field_code": "13_1 Т", "pk_start": 311870}) == "main"
    assert reports_routes._desired_pile_field_type({"pile_kind": "пробные"}) == "test"
    assert reports_routes._desired_pile_field_type({"field_type": "trial"}) == "test"
    assert reports_routes._desired_pile_field_type({"pile_kind": "основные", "field_type": "test"}) == "main"
    assert reports_routes._desired_pile_field_type({}, default=None) is None
    assert reports_routes._pile_row_work_type_code({"pile_operation": "headcap"}) == "PILE_HEADCAP_INSTALLATION"
    assert reports_routes._pile_row_work_type_code({"work_type_code": "PILE_HEADCAP_INSTALLATION"}) == "PILE_HEADCAP_INSTALLATION"
    assert reports_routes._pile_row_work_type_code({"pile_kind": "пробные"}) == "PILE_TRIAL"
    assert reports_routes._pile_row_work_type_code({"pile_kind": "основные"}) == "PILE_MAIN"


def test_main_track_object_code_resolves_by_boundary_section_not_report_section():
    assert reports_routes._main_track_mid_pk(305800, 305900) == 305850
    assert reports_routes._main_track_object_code_for_section("UCH_6", 305850) == "MAIN_006"
    assert reports_routes._main_track_object_code_for_section("UCH_3", 292000) == "MAIN_031"
    assert reports_routes._main_track_object_code_for_section("UCH_3", 293000) == "MAIN_032"


def test_equipment_master_sanitizer_drops_numeric_plate_copied_from_unit():
    row = {
        "brand_model": "КБУРГ 14-02, SANY SY375H",
        "unit_number": "913",
        "plate_number": "913",
        "unit_number_norm": "913",
        "plate_number_norm": "913",
    }

    sanitized = reports_routes._sanitize_equipment_master_row(row)

    assert sanitized is not row
    assert sanitized["unit_number"] == "913"
    assert sanitized["plate_number"] is None
    assert sanitized["plate_number_norm"] == ""
    assert row["plate_number"] == "913"


def test_equipment_master_sanitizer_drops_bortless_plate_placeholder():
    row = {
        "brand_model": "КБУРГ 16-02 SANY SY415H",
        "unit_number": "911",
        "plate_number": "б/н",
        "unit_number_norm": "911",
        "plate_number_norm": "БН",
    }

    sanitized = reports_routes._sanitize_equipment_master_row(row)

    assert sanitized is not row
    assert sanitized["unit_number"] == "911"
    assert sanitized["plate_number"] is None
    assert sanitized["plate_number_norm"] == ""


def test_equipment_master_sanitizer_drops_tts_6977_vin_from_plate():
    row = {
        "brand_model": "TTS XT360E",
        "unit_number": "TTS360EZDPHH31565",
        "plate_number": "6977ХА27",
        "vin": "TTS360EZDPHH31565",
        "unit_number_norm": reports_routes._normalize_equipment_identifier("TTS360EZDPHH31565"),
        "plate_number_norm": reports_routes._normalize_equipment_identifier("6977ХА27"),
        "vin_norm": reports_routes._normalize_equipment_identifier("TTS360EZDPHH31565"),
    }

    sanitized = reports_routes._sanitize_equipment_master_row(row)

    assert sanitized["plate_number"] is None
    assert sanitized["plate_number_norm"] == ""


def test_equipment_master_sanitizer_keeps_real_plate():
    row = {
        "brand_model": "КБУРГ 14-02, SANY SY375H",
        "unit_number": "914",
        "plate_number": "7163НВ53",
        "unit_number_norm": "914",
        "plate_number_norm": "7163НВ53",
    }

    assert reports_routes._sanitize_equipment_master_row(row) is row


def test_equipment_master_sanitizer_moves_vin_from_unit_number():
    row = {
        "brand_model": "DAEWOO BS106",
        "unit_number": "KL5UM52PECU006439",
        "plate_number": "О706РА196",
        "unit_number_norm": reports_routes._normalize_equipment_identifier("KL5UM52PECU006439"),
        "plate_number_norm": reports_routes._normalize_equipment_identifier("О706РА196"),
        "vin": None,
        "vin_norm": "",
    }

    sanitized = reports_routes._sanitize_equipment_master_row(row)

    assert sanitized["unit_number"] is None
    assert sanitized["unit_number_norm"] == ""
    assert sanitized["plate_number"] == "О706РА196"
    assert sanitized["vin"] == "KL5UM52PECU006439"


def test_equipment_master_sanitizer_trims_historical_plate_suffix():
    row = {
        "brand_model": "TOYOTA LAND CRUISER 300",
        "unit_number": "JTMAB7BJ304079038",
        "plate_number": "У358ЕА27БЫЛТ023ОР797",
        "unit_number_norm": reports_routes._normalize_equipment_identifier("JTMAB7BJ304079038"),
        "plate_number_norm": reports_routes._normalize_equipment_identifier("У358ЕА27БЫЛТ023ОР797"),
        "vin": "JTMAB7BJ304079038",
        "vin_norm": reports_routes._normalize_equipment_identifier("JTMAB7BJ304079038"),
    }

    sanitized = reports_routes._sanitize_equipment_master_row(row)

    assert sanitized["unit_number"] is None
    assert sanitized["plate_number"] == "У358ЕА27"
    assert sanitized["plate_number_norm"] == "У358ЕА27"
    assert sanitized["vin"] == "JTMAB7BJ304079038"


def test_report_m_vin_detector_ignores_brand_model_text():
    assert not reports_routes._report_m_looks_like_vin("SANY SY375H")
    assert not reports_routes._report_m_looks_like_vin("SHACMAN SX42586W385C")
    assert reports_routes._report_m_looks_like_vin("LZGJL4W50PX037890")


def test_report_m_parser_reads_numeric_plate_header_and_filename_date():
    wb = Workbook()
    ws = wb.active
    ws.title = "29.08.2026"
    ws.append([
        "№ п/п",
        "Фактическое местонахождение ",
        "Модель",
        "Марка и модель",
        859,
        "Бортовой №",
        "Статус\nтехники",
        "Водителей в работе",
        "Причина неисправности",
        "Дата остановки техники",
        "Планируемая дата выхода в работу",
        "Перенос даты выхода с ремонта",
        "Примечание",
    ])
    ws.append([
        1,
        "1-й участок",
        "Самосвал",
        "FAW J6 6*6",
        "Т932ВК27",
        "117",
        "В работе",
        2,
        None,
        None,
        None,
        None,
        "сменный отчет",
    ])
    blob = BytesIO()
    wb.save(blob)

    parsed = reports_routes._parse_mechanization_report_m_workbook(
        "30..08.26___СВОД ПО ТЕХНИКЕ.xlsx",
        blob.getvalue(),
    )

    assert parsed["report_date"] == "2026-08-30"
    assert parsed["header_indexes"]["plate_number"] == 4
    assert parsed["row_count"] == 1
    assert parsed["rows"][0]["plate_number"] == "Т932ВК27"
    assert parsed["rows"][0]["unit_number"] == "117"
    assert parsed["rows"][0]["section_code"] == "UCH_1"


def test_report_m_snapshot_groups_ignore_row_sections():
    targets = [
        ({"section_code": "UCH_1", "unit_number": "117"}, "equipment-1"),
        ({"section_code": "UCH_7", "unit_number": "732"}, "equipment-2"),
        ({"section_code": None, "unit_number": "999"}, "equipment-3"),
    ]

    groups = reports_routes._report_m_snapshot_report_groups(targets)

    assert list(groups) == ["__REPORT_M__"]
    assert groups["__REPORT_M__"] == targets


def test_equipment_master_allowed_identifier_norms_only_current_identifiers():
    allowed = reports_routes._equipment_master_allowed_identifier_norms(
        unit_number="160",
        plate_number="С430ХУ27",
        vin="LZGJL4W50PX037890",
    )

    assert "160" in allowed["unit"]
    assert "С430ХУ27" in allowed["plate"]
    assert "LZGJL4W50PX037890" in allowed["unit"]
    assert "1472УА27" not in allowed["plate"]
    assert "161" not in allowed["unit"]


class FakeEquipmentMatchCursor:
    def __init__(self, matches):
        self.matches = matches
        self.calls = []
        self._row = None

    def execute(self, sql, params=None):
        key = tuple(params or ())
        self.calls.append(key)
        found = self.matches.get(key)
        self._row = (found,) if found else None

    def fetchone(self):
        return self._row

    def fetchall(self):
        return [self._row] if self._row else []


def test_report_m_match_does_not_fallback_to_unit_when_plate_is_present():
    cur = FakeEquipmentMatchCursor({("unit", "846"): "excavator-master"})

    match = reports_routes._report_m_match_equipment_unit(cur, "6939ХА27", "846")

    assert match is None
    assert cur.calls == [("plate", "6939ХА27")]


def test_report_m_match_uses_unit_when_plate_is_missing():
    cur = FakeEquipmentMatchCursor({("unit", "846"): "excavator-master"})

    match = reports_routes._report_m_match_equipment_unit(cur, "", "846")

    assert match == "excavator-master"
    assert cur.calls == [("unit", "846")]


class CapturingCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))


def test_report_m_upsert_preserves_master_identifiers_when_source_has_blanks():
    original_match = reports_routes._report_m_match_equipment_unit
    original_conflict = reports_routes._equipment_master_primary_identifiers_conflict
    original_insert_identifier = reports_routes._report_m_insert_identifier
    original_prune = reports_routes._report_m_prune_equipment_unit_identifiers
    reports_routes._report_m_match_equipment_unit = lambda *args, **kwargs: "00000000-0000-0000-0000-000000000001"
    reports_routes._equipment_master_primary_identifiers_conflict = lambda *args, **kwargs: False
    reports_routes._report_m_insert_identifier = lambda *args, **kwargs: None
    reports_routes._report_m_prune_equipment_unit_identifiers = lambda *args, **kwargs: 0
    cur = CapturingCursor()
    try:
        _, action = reports_routes._report_m_upsert_master_unit(
            cur,
            {
                "equipment_type": "Самосвал",
                "brand_model": "",
                "unit_number": "103",
                "unit_number_norm": "103",
                "plate_number": "",
                "plate_number_norm": "",
                "vin": "",
                "vin_norm": "",
            },
            "2026-08-27",
            "27.08.26___СВОД ПО ТЕХНИКЕ.xlsx",
            "report_m:2026-08-27",
        )
    finally:
        reports_routes._report_m_match_equipment_unit = original_match
        reports_routes._equipment_master_primary_identifiers_conflict = original_conflict
        reports_routes._report_m_insert_identifier = original_insert_identifier
        reports_routes._report_m_prune_equipment_unit_identifiers = original_prune

    assert action == "updated"
    update_sql = cur.executed[0][0]
    assert "brand_model = COALESCE(NULLIF(%s, ''), brand_model)" in update_sql
    assert "unit_number = COALESCE(NULLIF(%s, ''), unit_number)" in update_sql
    assert "plate_number = COALESCE(NULLIF(%s, ''), plate_number)" in update_sql
    assert "vin = COALESCE(NULLIF(%s, ''), vin)" in update_sql


class FakeMasterPrimaryIdentifierCursor:
    def __init__(self, unit_number, plate_number):
        self.row = (unit_number, plate_number)
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.row


def test_equipment_master_primary_conflict_requires_unit_and_plate_mismatch():
    cur = FakeMasterPrimaryIdentifierCursor("723", "Т930ЕА27")

    assert reports_routes._equipment_master_primary_identifiers_conflict(
        cur,
        "56b09c7b-2220-4c55-951c-93e259a5fc64",
        {"unit_number": "506", "plate_number": "Т989ВЕ27"},
    )

    assert not reports_routes._equipment_master_primary_identifiers_conflict(
        cur,
        "56b09c7b-2220-4c55-951c-93e259a5fc64",
        {"unit_number": "506", "plate_number": "Т930ЕА27"},
    )
    assert not reports_routes._equipment_master_primary_identifiers_conflict(
        cur,
        "56b09c7b-2220-4c55-951c-93e259a5fc64",
        {"unit_number": "723", "plate_number": "Т989ВЕ27"},
    )


def test_equipment_search_drops_stale_plate_alias_for_current_lookup():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    try:
        suggestions = reports_routes._equipment_suggestions({"reported_number": "5749ХА"}, limit=10)
    finally:
        reports_routes.query = original_query

    assert [s["plate_number"] for s in suggestions] == ["5749ХА27"]
    assert [s["unit_number"] for s in suggestions] == ["545"]
    assert all("5148ХА27" not in s["label"] for s in suggestions)


def test_equipment_lookup_strips_common_number_prefixes():
    values = reports_routes._equipment_lookup_values({
        "reported_number": "б/н 208",
        "unit_number": "борт 208",
        "plate_number": "г/н А208АА27",
    })

    assert ("reported", "208") in values
    assert ("unit", "208") in values
    assert ("plate", "А208АА27") in values
    assert ("reported", "БН208") in values


def test_equipment_lookup_extracts_number_from_typed_identifier():
    values = reports_routes._equipment_lookup_values({
        "reported_number": "каток 161",
        "unit_number": "экскаватор -347",
        "plate_number": "с номером T930PA",
    })

    assert ("reported", "161") in values
    assert ("unit", "347") in values
    assert ("plate", "Т930РА") in values


def test_equipment_identifier_normalizer_moves_full_plate_from_unit_number():
    row = {"unit_number": "С870 ХВ 27", "plate_number": "", "reported_number": ""}

    reports_routes._normalize_report_equipment_identifiers(row)

    assert row["unit_number"] is None
    assert row["plate_number"] == "С870 ХВ 27"
    assert row["plate"] == "С870 ХВ 27"
    assert row["reported_number"] == "С870 ХВ 27"


def test_equipment_identifier_normalizer_keeps_plain_unit_number():
    row = {"unit_number": "870", "plate_number": "", "reported_number": ""}

    reports_routes._normalize_report_equipment_identifiers(row)

    assert row["unit_number"] == "870"
    assert row.get("plate_number") == ""
    assert not row.get("plate")


def test_payload_equipment_identifier_normalizer_covers_nested_rows():
    payload = {
        "transport": [{"unit_number": "С887 ХВ 27", "plate_number": ""}],
        "main_works": [{"equipment": [{"unit_number": "О461 ТН 196", "plate_number": ""}]}],
    }

    reports_routes._normalize_payload_equipment_identifiers(payload)

    assert payload["transport"][0]["unit_number"] is None
    assert payload["transport"][0]["plate_number"] == "С887 ХВ 27"
    assert payload["main_works"][0]["equipment"][0]["unit_number"] is None
    assert payload["main_works"][0]["equipment"][0]["plate_number"] == "О461 ТН 196"


def test_single_work_equipment_usage_volume_tracks_latest_work_volume():
    payload = {
        "main_works": [
            {
                "volume": 7000,
                "unit": "м2",
                "equipment": [{"volume": 5300, "unit": "м2", "unit_number": "770"}],
            },
            {
                "volume": 1200,
                "unit": "м3",
                "equipment": [
                    {"volume": 500, "unit": "м3", "unit_number": "731"},
                    {"volume": 700, "unit": "м3", "unit_number": "744"},
                ],
            },
        ],
        "aux_works": [
            {
                "volume": 42,
                "unit": "шт",
                "equipment": [{"volume": 7, "unit": "шт", "unit_number": "1"}],
            },
        ],
    }

    reports_routes._sync_single_work_equipment_usage_volumes(payload)

    assert payload["main_works"][0]["equipment"][0]["volume"] == 7000
    assert [row["volume"] for row in payload["main_works"][1]["equipment"]] == [500, 700]
    assert payload["aux_works"][0]["equipment"][0]["volume"] == 7


def test_single_work_equipment_usage_unit_tracks_work_unit():
    payload = {
        "main_works": [
            {
                "volume": 624,
                "unit": "м3",
                "equipment": [{"volume": 2450, "unit": "м2", "unit_number": "732"}],
            }
        ]
    }

    reports_routes._sync_single_work_equipment_usage_volumes(payload)

    assert payload["main_works"][0]["equipment"][0]["volume"] == 624
    assert payload["main_works"][0]["equipment"][0]["unit"] == "м3"


def test_multi_equipment_work_rows_split_when_equipment_volumes_match_work_volume():
    payload = {
        "main_works": [
            {
                "work_name": "Устройство насыпи",
                "object_code": "MAIN_1",
                "volume": 100,
                "unit": "м3",
                "equipment": [
                    {"volume": 40, "unit": "м3", "unit_number": "731"},
                    {"volume": 60, "unit": "м3", "unit_number": "732"},
                ],
            }
        ]
    }

    reports_routes._normalize_regular_work_equipment_cardinality(payload)

    assert [row["volume"] for row in payload["main_works"]] == [40, 60]
    assert [row["unit_number"] for row in payload["main_works"]] == ["731", "732"]
    assert all(len(row["equipment"]) == 1 for row in payload["main_works"])
    assert payload["review_actions"]["multi_equipment_work_rows_normalized"][0]["mode"] == "split_by_equipment_volume"


def test_ambiguous_multi_equipment_work_row_keeps_one_equipment_and_flags_review():
    payload = {
        "main_works": [
            {
                "work_name": "Планировка до проектных отметок",
                "object_code": "VPD_048",
                "volume": 5000,
                "unit": "м2",
                "equipment": [
                    {"unit_number": "8409/5000м2/автогрейдер/ЖДС", "equipment_type": "номер"},
                    {"unit_number": "7135/5000м2/автогрейдер/найм", "equipment_type": "номер"},
                ],
            }
        ]
    }

    reports_routes._normalize_regular_work_equipment_cardinality(payload)

    assert len(payload["main_works"]) == 1
    assert payload["main_works"][0]["volume"] == 5000
    assert len(payload["main_works"][0]["equipment"]) == 1
    action = payload["review_actions"]["multi_equipment_work_rows_normalized"][0]
    assert action["mode"] == "kept_best_equipment"
    assert action["dropped_equipment_count"] == 1


def test_hired_equipment_count_work_row_expands_to_one_equipment_rows():
    payload = {
        "aux_works": [
            {
                "work_name": "Разработка выемки",
                "object_code": "MAIN_1",
                "volume": 100,
                "unit": "м3",
                "equipment_count": 2,
                "hired_count": 2,
                "owner": "Наемник",
                "equipment_type": "экскаватор",
            }
        ]
    }

    reports_routes._normalize_regular_work_equipment_cardinality(payload)

    assert [row["volume"] for row in payload["aux_works"]] == [50, 50]
    assert all(len(row["equipment"]) == 1 for row in payload["aux_works"])
    assert all(row["equipment"][0]["equipment_count"] == 1 for row in payload["aux_works"])
    assert payload["review_actions"]["multi_equipment_work_rows_normalized"][0]["mode"] == "split_hired_count_evenly"


def test_equipment_enrich_resolves_unique_primary_match_by_type():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    row = {"unit_number": "161", "equipment_type": "каток", "_equipment_context": "work"}
    try:
        reports_routes._enrich_equipment_row(row)
    finally:
        reports_routes.query = original_query

    assert row["equipment_match_status"] == "resolved"
    assert row["equipment_unit_id"] == "roller-161"
    assert row["brand_model"] == "XCMG 183"
    assert row["plate_number"] == "5885ХА27"


def test_equipment_search_filters_exact_number_by_requested_type():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    try:
        suggestions = reports_routes.equipment_search(q="161", equipment_type="каток", context="work", limit=10)
    finally:
        reports_routes.query = original_query

    assert [s["equipment_unit_id"] for s in suggestions] == ["roller-161"]
    assert suggestions[0]["equipment_type"] == "Каток"


def test_equipment_search_infers_requested_type_from_typed_query():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    try:
        suggestions = reports_routes.equipment_search(q="каток 160", limit=10)
    finally:
        reports_routes.query = original_query

    assert [s["equipment_unit_id"] for s in suggestions] == ["roller-160"]
    assert suggestions[0]["equipment_type"] == "Каток"


def test_equipment_enrich_resolves_unique_plate_fragment_by_type():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    row = {"reported_number": "Т930ЕА", "equipment_type": "самосвал", "_equipment_context": "transport"}
    try:
        reports_routes._enrich_equipment_row(row)
    finally:
        reports_routes.query = original_query

    assert row["equipment_match_status"] == "resolved"
    assert row["equipment_unit_id"] == "dump-truck-723"
    assert row["unit_number"] == "723"
    assert row["plate_number"] == "Т930ЕА27"


def test_equipment_suggestions_drop_partial_cross_type_match():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    try:
        suggestions = reports_routes._equipment_suggestions(
            {"reported_number": "экскаватор 347", "equipment_type": "экскаватор", "_equipment_context": "work"},
            limit=10,
        )
    finally:
        reports_routes.query = original_query

    assert suggestions == []


def test_equipment_enrich_resolves_same_unit_by_requested_model():
    original_query = reports_routes.query
    reports_routes.query = fake_query
    try:
        hitachi = {"unit_number": "546", "equipment_type": "Экскаватор", "brand_model": "HITACHI 330"}
        lonking = {"unit_number": "546", "equipment_type": "Экскаватор", "brand_model": "LONKING"}
        reports_routes._enrich_equipment_row(hitachi)
        reports_routes._enrich_equipment_row(lonking)
    finally:
        reports_routes.query = original_query

    assert hitachi["equipment_match_status"] == "resolved"
    assert hitachi["equipment_unit_id"] == "hitachi-546"
    assert hitachi["plate_number"] == "5745ХА27"
    assert lonking["equipment_match_status"] == "resolved"
    assert lonking["equipment_unit_id"] == "lonking-546"
    assert lonking["plate_number"] == "6965ХА27"


def test_operation_report_match_does_not_fallback_to_unit_when_plate_is_present():
    cur = FakeEquipmentMatchCursor({("unit", "846"): "excavator-master"})

    match, method, matched_norm = reports_routes._operation_report_match_equipment_unit(
        cur,
        {
            "plate_number_norm": "6939ХА27",
            "unit_number_norm": "846",
            "vin_norm": "",
        },
    )

    assert match is None
    assert method is None
    assert matched_norm is None
    assert cur.calls == [("plate", "6939ХА27")]


def assert_report_material_alias_refresh_and_previous_day_candidates() -> None:
    catalog = {
        "material": [
            {
                "code": "SAND",
                "label": "Песок",
                "table": "materials",
                "default_unit": "м3",
                "aliases": ["Песок", "SAND"],
            },
            {
                "code": "SOIL",
                "label": "Грунт",
                "table": "materials",
                "default_unit": "м3",
                "aliases": ["Грунт", "SOIL", "песок с выемки"],
            },
            {
                "code": "PEAT",
                "label": "Торф",
                "table": "materials",
                "default_unit": "м3",
                "aliases": ["Торф", "PEAT"],
            },
        ],
        "object": [],
        "work_type": [],
    }
    for entries in catalog.values():
        for entry in entries:
            reports_routes._prepare_reference_entry(entry)
    original_aliases = reports_routes.load_aliases
    original_catalog = reports_routes.load_reference_catalog
    reports_routes.load_aliases = lambda force=False: {
        "material": {
            "песок с выемки": "SOIL",
            "/песок с выемки/": "SAND",
            "грунт": "PEAT",
        }
    }
    reports_routes.load_reference_catalog = lambda force=False: catalog
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        payload = {
            "header": {"section_code": "UCH_3"},
            "transport": [
                {
                    "trips": [
                        {
                            "material": "/песок с выемки/",
                            "material_code": "SAND",
                            "from": "Карьер",
                            "to": "АД13",
                        },
                        {
                            "material": "Грунт",
                            "material_code": "SOIL",
                            "from": "Выемка",
                            "to": "АД13",
                        },
                    ]
                }
            ],
        }
        refreshed = reports_routes._refresh_payload_reference_metadata(payload)
    finally:
        reports_routes.load_aliases = original_aliases
        reports_routes.load_reference_catalog = original_catalog
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
        reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}

    first_trip = refreshed["transport"][0]["trips"][0]
    assert first_trip["material_code"] == "SOIL"
    assert first_trip["material_suggestions"][0]["code"] == "SOIL"
    second_trip = refreshed["transport"][0]["trips"][1]
    assert second_trip["material_code"] == "SOIL"

    candidates = reports_routes._material_alias_candidates_from_report_payloads(
        {
            "transport": [
                {
                    "trips": [
                        {
                            "material": "Грунт",
                            "material_code": "SOIL",
                            "_source": {"line": 17},
                        }
                    ]
                }
            ]
        },
        {
            "transport": [
                {
                    "trips": [
                        {
                            "material": "/песок с выемки/",
                            "material_code": "SAND",
                            "_source": {"line": 17},
                        }
                    ]
                }
            ]
        },
    )
    assert {
        "kind": "material",
        "alias_text": "песок с выемки",
        "canonical_code": "SOIL",
        "source": "initial_to_final_payload",
    } in candidates
    assert reports_routes._material_alias_candidates_from_report_payloads(
        {"transport": [{"trips": [{"material": "Грунт", "material_code": "SAND"}]}]},
        None,
        {"грунт": "SOIL", "soil": "SOIL"},
    ) == []


def test_manual_object_selection_survives_reference_refresh() -> None:
    catalog = {
        "object": [
            {
                "code": "OLD_OBJECT",
                "label": "ПК 3305+50",
                "aliases": ["ПК 3305+50"],
                "section_code": "UCH_8",
            },
            {
                "code": "MANUAL_OBJECT",
                "label": "ПК 3306",
                "aliases": ["ПК 3306"],
                "section_code": "UCH_7",
            },
        ],
        "material": [
            {
                "code": "SOIL",
                "label": "Грунт",
                "aliases": ["Грунт"],
            },
            {
                "code": "SAND",
                "label": "Песок",
                "aliases": ["Песок"],
            },
        ],
        "work_type": [
            {
                "code": "OLD_WORK",
                "label": "Работа из источника",
                "aliases": ["Работа из источника"],
                "default_unit": "м3",
            },
            {
                "code": "MANUAL_WORK",
                "label": "Ручная работа",
                "aliases": ["Ручная работа"],
                "default_unit": "шт",
            },
        ],
    }
    for entries in catalog.values():
        for entry in entries:
            reports_routes._prepare_reference_entry(entry)
    original_aliases = reports_routes.load_aliases
    original_catalog = reports_routes.load_reference_catalog
    reports_routes.load_aliases = lambda force=False: {}
    reports_routes.load_reference_catalog = lambda force=False: catalog
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        auto_payload = {
            "header": {"section_code": "UCH_8"},
            "main_works": [
                {
                    "work_name": "Работа",
                    "constructive": "ПК 3305+50",
                    "object_code": "MANUAL_OBJECT",
                    "constructive_code": "MANUAL_OBJECT",
                }
            ],
        }
        auto_refreshed = reports_routes._refresh_payload_reference_metadata(auto_payload)
        assert auto_refreshed["main_works"][0]["object_code"] == "OLD_OBJECT"

        manual_payload = {
            "header": {"section_code": "UCH_8"},
            "transport": [
                {
                    "trips": [
                        {
                            "material": "Грунт",
                            "material_code": "CUSTOM_MATERIAL",
                            "material_selection_mode": "manual",
                        }
                    ]
                }
            ],
            "main_works": [
                {
                    "work_name": "Работа из источника",
                    "work_type_code": "MANUAL_WORK",
                    "work_type_selection_mode": "manual",
                    "constructive": "ПК 3305+50",
                    "object_code": "MANUAL_OBJECT",
                    "constructive_code": "MANUAL_OBJECT",
                    "object_selection_mode": "manual",
                }
            ],
            "stockpiles": [
                {
                    "material": "Грунт",
                    "material_code": "CUSTOM_STOCKPILE_MATERIAL",
                    "material_selection_mode": "manual",
                }
            ],
        }
        manual_refreshed = reports_routes._refresh_payload_reference_metadata(manual_payload)
    finally:
        reports_routes.load_aliases = original_aliases
        reports_routes.load_reference_catalog = original_catalog
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
        reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}

    work = manual_refreshed["main_works"][0]
    assert work["object_code"] == "MANUAL_OBJECT"
    assert work["constructive_code"] == "MANUAL_OBJECT"
    assert work["work_type_code"] == "MANUAL_WORK"
    assert work["unit"] == "шт"
    assert any(suggestion["code"] == "OLD_OBJECT" for suggestion in work["object_suggestions"])
    trip = manual_refreshed["transport"][0]["trips"][0]
    assert trip["material_code"] == "CUSTOM_MATERIAL"
    assert trip["material_suggestions"][0]["code"] == "CUSTOM_MATERIAL"
    stockpile = manual_refreshed["stockpiles"][0]
    assert stockpile["material_code"] == "CUSTOM_STOCKPILE_MATERIAL"
    assert stockpile["material_suggestions"][0]["code"] == "CUSTOM_STOCKPILE_MATERIAL"


def test_compact_object_code_collision_does_not_replace_manual_selection() -> None:
    catalog = {
        "object": [
            {
                "code": "PFP_52N",
                "label": "Стартовая площадка для погружения свай 52Н",
                "aliases": ["Стартовая площадка для погружения свай 52Н", "PFP_52N"],
                "section_code": "UCH_1",
            },
            {
                "code": "PFP_5_2N",
                "label": "Стартовая площадка для погружения свай 5_2Н",
                "aliases": ["Стартовая площадка для погружения свай 5_2Н", "PFP_5_2N"],
                "section_code": "UCH_1",
            },
        ],
        "material": [
            {"code": "SAND", "label": "Песок", "aliases": ["Песок"]},
        ],
        "work_type": [
            {
                "code": "PILE_PAD_START",
                "label": "Устройство стартовой площадки",
                "aliases": ["Устройство стартовой площадки"],
                "default_unit": "м3",
            },
        ],
    }
    for entries in catalog.values():
        for entry in entries:
            reports_routes._prepare_reference_entry(entry)
    original_aliases = reports_routes.load_aliases
    original_catalog = reports_routes.load_reference_catalog
    reports_routes.load_aliases = lambda force=False: {}
    reports_routes.load_reference_catalog = lambda force=False: catalog
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        selected = reports_routes._reference_candidate_for_code("object", "PFP_5_2N")
        payload = {
            "header": {"section_code": "UCH_1"},
            "transport": [
                {
                    "trips": [
                        {
                            "material": "Песок",
                            "material_code": "SAND",
                            "from": "Стартовая площадка для погружения свай 5_2Н",
                            "from_object_code": "PFP_5_2N",
                            "from_object_selection_mode": "manual",
                            "to": "Стартовая площадка для погружения свай 5_2Н",
                            "to_object_code": "PFP_5_2N",
                            "to_object_selection_mode": "manual",
                        }
                    ]
                }
            ],
            "main_works": [
                {
                    "work_name": "Устройство стартовой площадки",
                    "work_type_code": "PILE_PAD_START",
                    "constructive": "Стартовая площадка для погружения свай 5_2Н",
                    "object_code": "PFP_5_2N",
                    "constructive_code": "PFP_5_2N",
                    "object_selection_mode": "manual",
                }
            ],
        }
        refreshed = reports_routes._refresh_payload_reference_metadata(payload)
    finally:
        reports_routes.load_aliases = original_aliases
        reports_routes.load_reference_catalog = original_catalog
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
        reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}

    assert selected
    assert selected["code"] == "PFP_5_2N"
    work = refreshed["main_works"][0]
    assert work["object_code"] == "PFP_5_2N"
    assert work["constructive_code"] == "PFP_5_2N"
    assert work["object_suggestions"][0]["code"] == "PFP_5_2N"
    trip = refreshed["transport"][0]["trips"][0]
    assert trip["from_object_code"] == "PFP_5_2N"
    assert trip["to_object_code"] == "PFP_5_2N"
    assert trip["from_object_suggestions"][0]["code"] == "PFP_5_2N"
    assert trip["to_object_suggestions"][0]["code"] == "PFP_5_2N"


def test_db_fact_overlay_matches_unique_signatures_not_query_order() -> None:
    catalog = {
        "object": [
            {"code": "OBJ_A", "label": "Объект А", "aliases": ["Объект А"]},
            {"code": "OBJ_B", "label": "Объект Б", "aliases": ["Объект Б"]},
            {"code": "OBJ_C", "label": "Объект В", "aliases": ["Объект В"]},
        ],
        "material": [
            {"code": "SOIL", "label": "Грунт", "aliases": ["Грунт"]},
            {"code": "SAND", "label": "Песок", "aliases": ["Песок"]},
        ],
        "work_type": [
            {
                "code": "EARTH_EXCAVATION",
                "label": "Разработка выемки",
                "aliases": ["Разработка выемки"],
                "default_unit": "м3",
            },
            {
                "code": "EMBANKMENT_CONSTRUCTION",
                "label": "Устройство насыпи",
                "aliases": ["Устройство насыпи"],
                "default_unit": "м3",
            },
        ],
    }
    for entries in catalog.values():
        for entry in entries:
            reports_routes._prepare_reference_entry(entry)

    payload = {
        "transport": [
            {
                "trips": [
                    {
                        "material": "Грунт",
                        "volume": "10,00",
                        "unit": "м3",
                        "trip_count": 2,
                        "material_code": "WRONG_A",
                        "from_object_code": "WRONG_FROM_A",
                        "to_object_code": "WRONG_TO_A",
                    },
                    {
                        "material": "Песок",
                        "volume": 20,
                        "unit": "м3",
                        "trip_count": "3",
                        "material_code": "WRONG_B",
                        "from_object_code": "WRONG_FROM_B",
                        "to_object_code": "WRONG_TO_B",
                    },
                ]
            }
        ],
        "main_works": [
            {
                "work_name": "Разработка выемки",
                "volume": "100.0",
                "unit": "м3",
                "work_type_code": "WRONG_WORK_A",
                "object_code": "WRONG_OBJECT_A",
            },
            {
                "work_name": "Устройство насыпи",
                "volume": 200,
                "unit": "м3",
                "work_type_code": "WRONG_WORK_B",
                "object_code": "WRONG_OBJECT_B",
            },
        ],
    }

    def overlay_query(sql: str, params=None) -> list[dict]:
        if "FROM material_movements mm" in sql:
            return [
                {
                    "volume": 20,
                    "unit": "м3",
                    "trip_count": 3,
                    "material_code": "SAND",
                    "material_name": "Песок",
                    "from_object_code": "OBJ_B",
                    "from_name": "Объект Б",
                    "to_object_code": "OBJ_C",
                    "to_name": "Объект В",
                },
                {
                    "volume": 10,
                    "unit": "м3",
                    "trip_count": 2,
                    "material_code": "SOIL",
                    "material_name": "Грунт",
                    "from_object_code": "OBJ_A",
                    "from_name": "Объект А",
                    "to_object_code": "OBJ_B",
                    "to_name": "Объект Б",
                },
            ]
        if "FROM daily_work_items dwi" in sql and "wt.code NOT IN" in sql:
            return [
                {
                    "work_name_raw": "Устройство насыпи",
                    "volume": 200,
                    "unit": "м3",
                    "work_type_code": "EMBANKMENT_CONSTRUCTION",
                    "work_type_name": "Устройство насыпи",
                    "default_unit": "м3",
                    "analytics_tag": "Песок (Насыпь)",
                    "productivity_enabled": True,
                    "object_code": "OBJ_C",
                    "object_name": "Объект В",
                },
                {
                    "work_name_raw": "Разработка выемки",
                    "volume": 100,
                    "unit": "м3",
                    "work_type_code": "EARTH_EXCAVATION",
                    "work_type_name": "Разработка выемки",
                    "default_unit": "м3",
                    "analytics_tag": "Грунт (Выемка)",
                    "productivity_enabled": False,
                    "object_code": "OBJ_A",
                    "object_name": "Объект А",
                },
            ]
        if "FROM daily_work_items dwi" in sql and "wt.code IN" in sql:
            return []
        return []

    original_query = reports_routes.query
    original_catalog = reports_routes.load_reference_catalog
    reports_routes.query = overlay_query
    reports_routes.load_reference_catalog = lambda force=False: catalog
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    try:
        updated = reports_routes._overlay_payload_with_report_db_facts("report-1", payload)
    finally:
        reports_routes.query = original_query
        reports_routes.load_reference_catalog = original_catalog
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}

    first_trip = updated["transport"][0]["trips"][0]
    second_trip = updated["transport"][0]["trips"][1]
    assert first_trip["material_code"] == "SOIL"
    assert first_trip["from_object_code"] == "OBJ_A"
    assert first_trip["to_object_code"] == "OBJ_B"
    assert second_trip["material_code"] == "SAND"
    assert second_trip["from_object_code"] == "OBJ_B"
    assert second_trip["to_object_code"] == "OBJ_C"

    first_work = updated["main_works"][0]
    second_work = updated["main_works"][1]
    assert first_work["work_type_code"] == "EARTH_EXCAVATION"
    assert first_work["object_code"] == "OBJ_A"
    assert first_work["productivity_enabled"] is False
    assert second_work["work_type_code"] == "EMBANKMENT_CONSTRUCTION"
    assert second_work["object_code"] == "OBJ_C"
    summary = updated["review_actions"]["db_authoritative_overlay"]
    assert summary["transport_trips"]["updated"] == 2
    assert summary["regular_works"]["updated"] == 2


def test_db_fact_overlay_skips_ambiguous_transport_signature() -> None:
    payload = {
        "transport": [
            {
                "trips": [
                    {"volume": 10, "unit": "м3", "trip_count": 2, "material_code": "LEFT"},
                    {"volume": "10.0", "unit": "м3", "trip_count": "2", "material_code": "RIGHT"},
                ]
            }
        ]
    }

    def overlay_query(sql: str, params=None) -> list[dict]:
        if "FROM material_movements mm" in sql:
            return [
                {"volume": 10, "unit": "м3", "trip_count": 2, "material_code": "SOIL"},
                {"volume": "10.00", "unit": "м3", "trip_count": 2, "material_code": "SAND"},
            ]
        return []

    original_query = reports_routes.query
    reports_routes.query = overlay_query
    try:
        updated = reports_routes._overlay_payload_with_report_db_facts("report-1", payload)
    finally:
        reports_routes.query = original_query

    assert updated["transport"][0]["trips"][0]["material_code"] == "LEFT"
    assert updated["transport"][0]["trips"][1]["material_code"] == "RIGHT"
    assert "review_actions" not in updated


def assert_import_pk_validation_marks_issues_without_blocking() -> None:
    empty_boundaries = {"sections": {}, "objects": {}, "roads": {}}
    assert reports_routes._parse_pk_input("ПК2702") == 270200
    assert reports_routes._parse_pk_input("ПК2702+00") == 270200
    assert reports_routes._parse_pk_input("2702") == 270200
    assert reports_routes._parse_pk_input("270200") == 270200
    assert reports_routes._parse_pk_input("ПК270200") == 270200
    assert reports_routes._parse_pk_input("ПК 2702 + 00") == 270200
    assert reports_routes._parse_pk_input("ПК2702.25") == 270225
    assert reports_routes._parse_pk_input("2702,25") == 270225
    assert reports_routes._parse_pk_input("267668.76") == 267668.76
    assert reports_routes._format_pk_db(267668.76) == "ПК2676+68,76"
    assert reports_routes._parse_pk_input("128") is None
    assert reports_routes._parse_pk_input("выторф") is None
    ranges = reports_routes._parse_pk_ranges_text("264022-264050")
    assert ranges == [{"start": 264022, "end": 264050, "raw": "264022-264050"}]
    inverted = reports_routes._parse_pk_ranges_text("ПК2640,50-ПК2640.22")
    assert inverted == [{"start": 264022, "end": 264050, "raw": "ПК2640,50-ПК2640.22"}]
    assert reports_routes._work_analytics_tag_from_row({"work_name": "отсыпка щебнем"}) is None
    assert reports_routes._work_analytics_tag_from_row({
        "work_type_code": "EMBANKMENT_CONSTRUCTION",
        "work_name": "разработка выемки",
    }) == "Песок (Насыпь)"
    assert reports_routes._ownership_from_owner('ООО «ЖДС»') == "own"
    assert reports_routes._ownership_from_owner('ООО«ЖДС»') == "own"
    assert reports_routes._ownership_from_owner('«ООО ЖДС»') == "own"
    assert not reports_routes._is_external_equipment_owner({"owner": 'ООО "ЖДС"'})
    assert not reports_routes._is_external_equipment_owner({"owner": '«ООО ЖДС»', "ownership_type": "hired"})
    assert "%самосвал%" in reports_routes._equipment_preferred_type_patterns({"reported_number": "506", "_equipment_context": "transport"})
    bad_work = types.SimpleNamespace(
        main_works=[{
            "work_name": "Устройство насыпи",
            "work_type_code": "EMBANKMENT_CONSTRUCTION",
            "object_code": "MAIN_001",
            "volume": 1,
            "analytics_tag": "Песок (Насыпь)",
            "pk_rail_start": "АД13",
        }],
        aux_works=[],
        stockpiles=[],
        fill_statuses=[],
    )
    issues = reports_routes._collect_import_pk_validation_issues(bad_work, empty_boundaries)
    assert issues
    assert issues[0]["level"] == "error"
    assert "работа №1" in issues[0]["message"]
    reports_routes._assert_import_pk_validation(bad_work)

    bad_fill = types.SimpleNamespace(
        main_works=[],
        aux_works=[],
        stockpiles=[],
        fill_statuses=[{"road_code": "АД5", "pioneer_fill": "непонятный пикет"}],
    )
    fill_issues = reports_routes._collect_import_pk_validation_issues(bad_fill, empty_boundaries)
    assert fill_issues
    assert "отсыпка ВАД №1" in fill_issues[0]["message"]
    reports_routes._assert_import_pk_validation(bad_fill)


def main() -> int:
    test_alias_lookup_normalizes_case_and_punctuation()
    test_load_aliases_omits_ambiguous_normalized_aliases()
    assert_parser_prefill_can_be_corrected_by_same_section_candidate()
    assert_temp_road_exact_number_beats_prefix_prefill()
    test_exact_quarry_alias_beats_same_section_road_name()
    assert_ad_pk_autofills_rail_pk_from_temp_road_mapping()
    assert_import_pk_validation_marks_issues_without_blocking()
    test_manual_object_selection_survives_reference_refresh()
    test_compact_object_code_collision_does_not_replace_manual_selection()
    test_db_fact_overlay_matches_unique_signatures_not_query_order()
    test_db_fact_overlay_skips_ambiguous_transport_signature()
    assert_pile_field_type_defaults_to_main_unless_explicit()
    test_equipment_search_drops_stale_plate_alias_for_current_lookup()
    test_equipment_lookup_strips_common_number_prefixes()
    test_equipment_lookup_extracts_number_from_typed_identifier()
    test_equipment_enrich_resolves_unique_primary_match_by_type()
    test_equipment_search_filters_exact_number_by_requested_type()
    test_equipment_search_infers_requested_type_from_typed_query()
    test_equipment_enrich_resolves_unique_plate_fragment_by_type()
    test_equipment_suggestions_drop_partial_cross_type_match()
    test_single_work_equipment_usage_volume_tracks_latest_work_volume()
    test_single_work_equipment_usage_unit_tracks_work_unit()
    test_multi_equipment_work_rows_split_when_equipment_volumes_match_work_volume()
    test_ambiguous_multi_equipment_work_row_keeps_one_equipment_and_flags_review()
    test_hired_equipment_count_work_row_expands_to_one_equipment_rows()
    test_equipment_enrich_resolves_same_unit_by_requested_model()
    test_report_m_parser_reads_numeric_plate_header_and_filename_date()
    test_report_m_snapshot_groups_ignore_row_sections()
    assert_report_material_alias_refresh_and_previous_day_candidates()
    original_query = reports_routes.query
    reports_routes.query = fake_query
    reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}
    reports_routes._REVIEW_SCHEMA_READY = True
    try:
        parsed = reports_routes._parse_report_text("sample.txt", SAMPLE)
        manual_search = reports_routes.reference_search(
            "object",
            "площадка №1 ПК2702",
            section="UCH_1",
            limit=5,
        )
        equipment_suggestions = reports_routes._equipment_suggestions({"reported_number": "208"}, limit=10)
        plate_fragment_suggestions = reports_routes._equipment_suggestions({"reported_number": "7439АР"}, limit=10)
        selected_equipment_row = {"reported_number": "208", "equipment_unit_id": "partial-only"}
        reports_routes._enrich_equipment_row(selected_equipment_row)
        alias_only_equipment_row = {"reported_number": "709", "unit_number": "709", "_equipment_context": "transport"}
        reports_routes._enrich_equipment_row(alias_only_equipment_row)
    finally:
        reports_routes.query = original_query
        reports_routes._ALIAS_CACHE = {"ts": 0.0, "by_kind": {}}
        reports_routes._REF_CACHE = {"ts": 0.0, "by_kind": {}}

    first = parsed["main_works"][0]
    assert first["work_type_code"] == "EARTH_EXCAVATION"
    assert first["object_code"] == "MAIN_001"
    assert first["work_type_suggestions"][0]["code"] == "EARTH_EXCAVATION"
    assert first["object_suggestions"][0]["code"] == "MAIN_001"

    second = parsed["main_works"][1]
    assert second["work_type_code"] == "EMBANKMENT_CONSTRUCTION"
    assert second["object_code"] == "VPD_005"

    aux = parsed["aux_works"][0]
    assert aux["work_type_code"] == "SOIL_WORK"
    assert aux["object_code"] == "STUFF_1"
    assert manual_search[0]["code"] == "PLATFORM_PK2702"
    assert [s["unit_number"] for s in equipment_suggestions] == ["208", "714"]
    assert [s["plate_number"] for s in plate_fragment_suggestions] == ["А7439АР53"]
    assert selected_equipment_row["equipment_match_status"] == "resolved"
    assert selected_equipment_row["equipment_unit_id"] == "partial-only"
    assert selected_equipment_row["unit_number"] == "714"
    assert alias_only_equipment_row["equipment_match_status"] == "unmatched"
    assert alias_only_equipment_row.get("equipment_unit_id") is None
    assert alias_only_equipment_row["unit_number"] == "709"
    assert alias_only_equipment_row["equipment_suggestions"] == []
    assert parsed["aliases"]["unresolved"] == 0
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
