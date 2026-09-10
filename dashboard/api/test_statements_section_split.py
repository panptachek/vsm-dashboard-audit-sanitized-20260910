from __future__ import annotations

import inspect

import pytest

import wip_routes


def test_statement_clip_explicit_range_to_matching_section():
    row = {
        "section_pk_start": 289800,
        "section_pk_end": 292500,
        "object_pk_start": 289800,
        "object_pk_end": 296700,
        "plan_pk_start": 289800,
        "plan_pk_end": 292500,
    }

    assert wip_routes._statement_clip_volume_to_section(row, 120.0, "plan_pk_start", "plan_pk_end") == (289800.0, 292500.0, 120.0, True)

    other_section = {**row, "section_pk_start": 292500, "section_pk_end": 296700}
    assert wip_routes._statement_clip_volume_to_section(other_section, 120.0, "plan_pk_start", "plan_pk_end") is None


def test_statement_clip_object_level_volume_by_section_length():
    row = {
        "section_pk_start": 292500,
        "section_pk_end": 296700,
        "object_pk_start": 289800,
        "object_pk_end": 296700,
        "plan_pk_start": None,
        "plan_pk_end": None,
    }

    pk_start, pk_end, volume, keep_raw = wip_routes._statement_clip_volume_to_section(row, 690.0, "plan_pk_start", "plan_pk_end")

    assert (pk_start, pk_end) == (292500, 296700)
    assert volume == pytest.approx(420.0)
    assert keep_raw is False


def test_statement_scope_cte_splits_objects_by_section_intersections():
    cte = wip_routes._statement_scope_cte()

    assert "section_clip.pk_start" in cte
    assert "section_clip.pk_end" in cte
    assert "ob.object_pk_start" in cte
    assert "boundary_kind = CASE" in cte

def test_statement_clip_manual_plan_range_to_selected_section():
    pk_start, pk_end, changed = wip_routes._statement_clip_manual_plan_range_to_section(
        324677.03,
        330729.24,
        324677.03,
        327800.0,
    )

    assert (pk_start, pk_end) == (324677.03, 327800.0)
    assert changed is True


def test_statement_clip_manual_plan_without_pk_uses_selected_section():
    pk_start, pk_end, changed = wip_routes._statement_clip_manual_plan_range_to_section(
        None,
        None,
        327800.0,
        330729.24,
    )

    assert (pk_start, pk_end) == (327800.0, 330729.24)
    assert changed is True

def test_statement_temp_road_fact_fallback_uses_section_clip():
    source = inspect.getsource(wip_routes._statement_general_add_fact_rows)

    assert ") cs_clip ON true" in source
    assert ") road_section_clip ON true" in source
    assert "COALESCE(seg.pk_start, pf.pk_start, ob.pk_start) AS raw_pk_start" in source
    assert "COALESCE(seg.pk_end, pf.pk_end, ob.pk_end) AS raw_pk_end" in source
    assert "THEN COALESCE(road_section_clip.pk_start, cs_clip.pk_start, fact_range.pk_start)" in source
    assert "THEN COALESCE(road_section_clip.pk_end, cs_clip.pk_end, fact_range.pk_end)" in source


def test_statement_row_scope_accepts_source_pile_field_fallback():
    source = inspect.getsource(wip_routes._statement_rows_payload)

    assert "LEFT JOIN pile_fields pf ON pf.id = pwi.source_pile_field_id" in source
    assert "LEFT JOIN pile_fields pf ON pf.id = ds.pile_field_id" in source
    assert "COALESCE(pwi.pk_start, pf.pk_start, so.pk_start)" in source
    assert "COALESCE(ps.pk_start, pf.pk_start, so.pk_start)" in source
    assert "_statement_plan_row_scope_lateral_sql('pwi', 'so', 'pf')" in source


def test_statement_general_fact_attaches_to_existing_project_row_inside_pk():
    row = {
        "category": "VYEMKA_OH",
        "section_code": "UCH_6",
        "object_id": "main-6",
        "work_type_id": "project-work",
        "unit": "m3",
        "pk_start": 311550.0,
        "pk_end": 311600.0,
        "project_volume": 100.0,
        "month_plan": 0.0,
        "cumulative_plan": 0.0,
        "material_project_volume": 0.0,
        "material_month_plan": 0.0,
        "material_cumulative_plan": 0.0,
    }
    rows = {"existing": row}

    found = wip_routes._statement_general_find_existing_row_for_fact(
        rows,
        category="VYEMKA_OH",
        section_code="UCH_6",
        object_id="main-6",
        work_type_id="fact-work",
        unit="m3",
        pk_start=311580.0,
        pk_end=311580.0,
    )

    assert found is row
    assert wip_routes._statement_general_find_existing_row_for_fact(
        rows,
        category="VYEMKA_OH",
        section_code="UCH_6",
        object_id="main-6",
        work_type_id="fact-work",
        unit="m3",
        pk_start=311650.0,
        pk_end=311650.0,
    ) is None
