from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT_PATH = Path("/opt/vsm/ops/report_pipeline/simple_section_xlsx/generate_simple_section_report.py")
SPEC = importlib.util.spec_from_file_location("transport_section_report_script", SCRIPT_PATH)
assert SPEC and SPEC.loader
transport_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transport_report)


def _row(*, section: str = "3", material: str, performer: str, volume: float, trips: int = 1) -> dict:
    return {
        "section": section,
        "performer": performer,
        "from": "Карьер А",
        "to": "Конструктив",
        "material": material,
        "volume": volume,
        "trips": trips,
        "equipment_count": 1,
        "haul_distance_km": 10.0,
        "_equipment_ids": [f"{material}-{performer}"],
        "_haul_distance_weighted_sum": volume * 10.0,
        "_haul_distance_weight_volume": volume,
        "source_kind": "quarry",
        "destination_kind": "object",
        "week_volume": volume,
        "month_volume": volume,
    }


def test_transport_breakdown_groups_material_then_performer_then_total() -> None:
    period_rows = [
        _row(material="Песок", performer="ЖДС", volume=10.0, trips=2),
        _row(material="Песок", performer="Наёмные", volume=5.0, trips=1),
        _row(material="ЩПГС", performer="АЛМАЗ", volume=7.0, trips=3),
    ]
    week_rows = [
        _row(material="Песок", performer="ЖДС", volume=12.0, trips=2),
        _row(material="Песок", performer="Наёмные", volume=5.0, trips=1),
        _row(material="ЩПГС", performer="АЛМАЗ", volume=9.0, trips=4),
    ]
    month_rows = [
        _row(material="Песок", performer="ЖДС", volume=20.0, trips=4),
        _row(material="Песок", performer="Наёмные", volume=8.0, trips=2),
        _row(material="ЩПГС", performer="АЛМАЗ", volume=11.0, trips=5),
    ]

    rows = transport_report._transport_breakdown_rows("3", period_rows, week_rows, month_rows)

    assert [row["label"] for row in rows] == [
        "Песок",
        "ЖДС",
        "Наёмные",
        "ЩПГС",
        "АЛМАЗ",
        "Итого",
    ]
    assert [row["row_kind"] for row in rows] == [
        "material_total",
        "performer",
        "performer",
        "material_total",
        "performer",
        "grand_total",
    ]
    assert [row["indent_level"] for row in rows] == [0, 1, 1, 0, 1, 0]

    assert rows[0]["volume"] == 15.0
    assert rows[0]["week_volume"] == 17.0
    assert rows[0]["month_volume"] == 28.0
    assert rows[1]["volume"] == 10.0
    assert rows[2]["volume"] == 5.0
    assert rows[3]["volume"] == 7.0
    assert rows[4]["volume"] == 7.0
    assert all(row["volume"] > 0 for row in rows)
    assert rows[-1]["volume"] == 22.0
    assert rows[-1]["week_volume"] == 26.0
    assert rows[-1]["month_volume"] == 39.0


def test_transport_workbook_uses_new_totals_layout_in_summary_and_section_blocks() -> None:
    period_rows = [
        _row(material="Песок", performer="ЖДС", volume=10.0),
        _row(material="Песок", performer="Наёмные", volume=5.0),
    ]
    totals = transport_report._transport_breakdown_rows("3", period_rows, period_rows, period_rows)
    workbook = transport_report.create_transport_report_workbook(
        {
            "detail_rows": [
                {
                    "section": "3",
                    "performer": "ЖДС",
                    "from": "Карьер А",
                    "to": "Конструктив",
                    "material": "Песок",
                    "volume": 10.0,
                    "trips": 2,
                    "equipment_count": 1,
                    "haul_distance_km": 10.0,
                    "week_volume": 10.0,
                    "month_volume": 10.0,
                }
            ],
            "ordered_sections": ["3"],
            "section_totals": {"3": totals},
            "summary_rows": totals,
            "section_titles": {"3": "Участок 3"},
            "week_from": "2026-06-15",
            "week_to": "2026-06-16",
            "month_from": "2026-06-01",
            "month_to": "2026-06-16",
        },
        "2026-06-01",
        "2026-06-16",
    )
    ws = workbook.active

    expected_labels = ["Песок", "ЖДС", "Наёмные", "Итого"]
    assert [ws.cell(row=row_idx, column=2).value for row_idx in range(6, 6 + len(expected_labels))] == expected_labels
    assert ws.cell(row=1, column=1).value == "Период отчета"
    assert ws.cell(row=1, column=2).value == "01.06.2026–16.06.2026"
    assert ws.cell(row=5, column=9).value == "Среднее плечо возки, км"
    assert ws.cell(row=5, column=10).value == "Объем за неделю (15.06.2026–16.06.2026), м³"
    assert ws.cell(row=5, column=11).value == "Объем за месяц (01.06.2026–16.06.2026), м³"
    assert ws.cell(row=7, column=2).alignment.indent == 1
    assert ws.cell(row=6 + len(expected_labels) - 1, column=2).value == "Итого"

    section_title_row = next(
        row_idx
        for row_idx in range(1, ws.max_row + 1)
        if ws.cell(row=row_idx, column=1).value == "Участок 3"
    )
    totals_caption_row = next(
        row_idx
        for row_idx in range(section_title_row, ws.max_row + 1)
        if ws.cell(row=row_idx, column=2).value == "Итоги по участку 3: материал → силы → итого"
    )
    totals_start_row = totals_caption_row + 1
    assert [ws.cell(row=totals_start_row + offset, column=2).value for offset in range(len(expected_labels))] == expected_labels
    assert all(
        not str(ws.cell(row=totals_start_row + offset, column=2).value).startswith("ИТОГО ")
        for offset in range(len(expected_labels))
    )
    assert ws.cell(row=totals_start_row + 1, column=2).alignment.indent == 1


def test_transport_totals_use_volume_weighted_haul_distance() -> None:
    rows = [
        {
            **_row(material="Песок", performer="ЖДС", volume=10.0),
            "haul_distance_km": 10.0,
            "_haul_distance_weighted_sum": 100.0,
            "_haul_distance_weight_volume": 10.0,
        },
        {
            **_row(material="Песок", performer="Наёмные", volume=30.0),
            "haul_distance_km": 20.0,
            "_haul_distance_weighted_sum": 600.0,
            "_haul_distance_weight_volume": 30.0,
        },
    ]

    totals = transport_report._transport_breakdown_rows("3", rows, rows, rows)

    assert totals[0]["label"] == "Песок"
    assert totals[0]["haul_distance_km"] == 17.5
    assert totals[-1]["label"] == "Итого"
    assert totals[-1]["haul_distance_km"] == 17.5


def test_transport_totals_hide_zero_volume_rows() -> None:
    rows = [_row(material="Песок", performer="ЖДС", volume=10.0)]

    totals = transport_report._transport_breakdown_rows("3", rows, rows, rows)

    assert [row["label"] for row in totals] == ["Песок", "ЖДС", "Итого"]
    assert all(row["volume"] > 0 for row in totals)
