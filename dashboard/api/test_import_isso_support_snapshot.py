import importlib.util
import json
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMPORT_PATH = ROOT / "tools" / "import_isso_support_snapshot.py"
SPEC = importlib.util.spec_from_file_location("import_isso_support_snapshot", IMPORT_PATH)
assert SPEC and SPEC.loader
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


def test_no_rd_requires_exact_phrase_in_remark():
    assert IMPORTER._rd_status("В срок до 01.10.2026", "Нет РД. Срок уточняется") == ("missing", "нет")
    assert IMPORTER._rd_status("Нет РД", "") != ("missing", "нет")
    assert IMPORTER._rd_status("", "РД нет") == ("missing", "нет")
    assert IMPORTER._rd_status("", "Корректировка РД") != ("missing", "нет")
    assert IMPORTER._rd_status("", "Документов нет, рабочая документация корректируется") != ("missing", "нет")


def test_snapshot_corrections_are_exact_and_material_stages_are_separate():
    corrections_path = ROOT / "tools" / "generation_assets" / "config" / "isso_support_corrections_2026-09-07.json"
    corrections = json.loads(corrections_path.read_text(encoding="utf-8"))

    def source_row(pk: int, support_label: str, sites_total: int, **facts: int):
        return {
            "object_name": f"ИССО на ПК{pk}",
            "support_label": support_label,
            "supports_total": 0,
            "sites_total": sites_total,
            "sites_done": 0,
            "rd_status": "unknown",
            **facts,
        }

    lines = [
        source_row(2734, "Опоры 1-14", 8, fact_august_sites=5),
        source_row(3001, "Опоры 41-56", 9, fact_august_sites=4),
        source_row(3191, "Опоры 36-50", 8, fact_august_sites=2),
        source_row(3284, "Опоры 17-22", 2, fact_july_sites=3),
        source_row(3284, "Опоры 23-40", 11, fact_july_sites=6),
    ]
    applied = IMPORTER.apply_corrections(lines, date(2026, 9, 7), corrections)

    assert len(applied) == 5

    def row(pk: int, support_label: str):
        matches = [
            item for item in lines
            if IMPORTER._pk_from_name(item["object_name"]) == float(pk * 100)
            and item["support_label"] == support_label
        ]
        assert len(matches) == 1
        return matches[0]

    pk2734 = row(2734, "Опоры 1-14")
    assert pk2734["sites_sand_done"] == 6
    assert pk2734["sites_shpgs_done"] == 0
    assert pk2734["fact_august_sites"] == 0
    assert "2026-08-01" not in pk2734["fact_months"]

    pk3001 = row(3001, "Опоры 41-56")
    assert (pk3001["sites_sand_done"], pk3001["sites_shpgs_done"], pk3001["sites_total"]) == (4, 4, 9)

    pk3191 = row(3191, "Опоры 36-50")
    assert (pk3191["sites_sand_done"], pk3191["sites_shpgs_done"]) == (4, 2)

    pk3284_project = row(3284, "Опоры 17-22")
    assert (pk3284_project["supports_total"], pk3284_project["sites_total"], pk3284_project["sites_shpgs_done"]) == (6, 3, 3)

    pk3284_sand = row(3284, "Опоры 23-40")
    assert (pk3284_sand["sites_sand_done"], pk3284_sand["sites_shpgs_done"]) == (9, 6)


def test_selective_update_preserves_history_and_operational_statuses():
    def previous_row(object_no: int, pk: int, support_label: str, **updates):
        raw = {
            "object_no": object_no,
            "object_name": f"ИССО на ПК{pk}",
            "object_type": "ИССО",
            "support_label": support_label,
            "row_num": object_no,
            "sites_total": 8,
            "supports_total": 14,
            "sites_done": 0,
            "fact_august_sites": 0,
            "fact_september_sites": 0,
            "month_plan": {"авг.": 3, "сен.": 2},
            "deadline": "старый срок",
            "remark": "старое примечание",
            "rd_status": "missing",
            "rd_available_text": "нет",
            "ms11_started": False,
            "ms11_scope": True,
            "ms11_bridge_work": False,
        }
        raw.update(updates)
        return {
            "raw_payload": raw,
            "source_no": str(object_no),
            "line_rd_status": raw["rd_status"],
            "line_rd_available_text": raw["rd_available_text"],
            "line_remark": raw["remark"],
        }

    def source_row(object_no: int, pk: int, support_label: str, **updates):
        row = {
            "kind": "isso_xlsx_template_row",
            "row_num": object_no + 10,
            "snapshot_date": "2026-09-09",
            "object_no": object_no,
            "object_no_text": str(object_no),
            "object_name": f"ИССО на ПК{pk}",
            "object_type": "ИССО",
            "support_label": support_label,
            "sites_total": 8,
            "supports_total": 14,
            "sites_done": 0,
            "fact_august_sites": 7,
            "fact_september_sites": 5,
            "month_plan": {"авг.": 9, "сен.": 5},
            "deadline": "новый срок",
            "remark": "новое примечание",
            "rd_status": "available",
            "rd_available_text": "есть",
            "ms11_started": True,
            "ms11_scope": False,
            "ms11_bridge_work": True,
        }
        row.update(updates)
        return row

    previous_rows = [
        previous_row(7, 2734, "Опоры 1-14"),
        previous_row(31, 3284, "Опоры 17-22", sites_total=3, supports_total=6, fact_july_sites=3, ms11_scope=False),
        previous_row(31, 3284, "Опоры 23-40", sites_total=11, supports_total=20, fact_july_sites=6, ms11_scope=False),
    ]
    lines = [
        source_row(7, 2734, "Опоры 1-14"),
        source_row(
            31,
            3284,
            "Опоры 17-20",
            sites_total=2,
            supports_total=4,
            sites_done=2,
            fact_august_sites=1,
            fact_september_sites=0,
        ),
        source_row(
            31,
            3284,
            "Опоры 21-38",
            sites_total=10,
            supports_total=20,
            fact_august_sites=0,
            fact_july_sites=6,
            fact_september_sites=10,
        ),
    ]
    policy = {
        "update_remarks": True,
        "update_fact_fields": ["fact_september_sites"],
        "update_plan_months": ["2026-09-01"],
        "fact_material_by_month": {"2026-09-01": "sand"},
        "cumulative_shpgs_source_field": "sites_done",
        "structure_pks": [3284],
        "preserve_operational_statuses": True,
    }

    audit = IMPORTER.apply_selective_update_policy(
        lines,
        date(2026, 9, 9),
        {"id": "previous-snapshot"},
        previous_rows,
        policy,
    )
    IMPORTER.apply_corrections(lines, date(2026, 9, 9), None)

    pk2734 = lines[0]
    assert pk2734["fact_august_sites"] == 0
    assert pk2734["fact_september_sites"] == 5
    assert (pk2734["sites_sand_done"], pk2734["sites_shpgs_done"]) == (5, 0)
    assert pk2734["deadline"] == "старый срок"
    assert pk2734["month_plan"] == {"авг.": 3, "сен.": 5}
    assert pk2734["remark"] == "новое примечание"
    assert (pk2734["rd_status"], pk2734["ms11_scope"]) == ("missing", True)

    pk3284 = lines[2]
    assert (pk3284["supports_total"], pk3284["sites_total"]) == (20, 10)
    assert (pk3284["fact_july_sites"], pk3284["fact_september_sites"]) == (7, 10)
    assert (pk3284["sites_sand_done"], pk3284["sites_shpgs_done"]) == (10, 0)
    assert lines[1]["sites_shpgs_done"] == 2
    assert audit[2]["match_method"] == "object_no_and_support_overlap"
    assert audit[0]["updated_plan_months"] == {"сен.": {"before": 2, "after": 5}}
    assert all(item["operational_status_before"] == item["operational_status_after"] for item in audit)
