#!/usr/bin/env python3
from __future__ import annotations

from datetime import date

from pdf import reinforcement_sections as rs


def _section(code: str, idx: int, fact: float = 0, plan: float = 0) -> dict:
    return {
        "code": code,
        "label": f"Уч. {idx}",
        "main": fact,
        "test": 0,
        "dyn": 0,
        "headcaps": 0,
        "plan_main": plan,
        "plan_test": 0,
        "plan_dyn": 0,
        "plan_headcaps": 0,
    }


def _summary_payload(mode: str) -> dict:
    days = [f"2026-06-{day:02d}" for day in range(1, 31)]
    sections = [_section(f"UCH_{idx}", idx, fact=(idx if mode == "cumulative" else (1 if idx <= 2 else 0)), plan=(1 if idx <= 2 else 0)) for idx in range(1, 9)]
    rows = []
    totals_by_day = {
        day: {
            "main": 0.0,
            "test": 0.0,
            "dyn": 0.0,
            "headcaps": 0.0,
            "total": 0.0,
            "plan_main": 0.0,
            "plan_test": 0.0,
            "plan_dyn": 0.0,
            "plan_headcaps": 0.0,
            "plan_total": 0.0,
            "fact_lengths": [],
        }
        for day in days
    }
    for idx in range(1, 9):
        code = f"UCH_{idx}"
        day_payload = {}
        for day in days:
            is_fact_day = idx <= 2 and day <= "2026-06-02"
            is_headcap_day = idx == 3 and day == "2026-06-02"
            fact_lengths = [{"length_m": 12, "count": 1.0}] if (idx == 1 and day == "2026-06-02") else []
            payload = {
                "main": 1 if is_fact_day else 0,
                "test": 0,
                "dyn": 0,
                "headcaps": 2 if is_headcap_day else 0,
                "total": 1 if is_fact_day else 0,
                "plan_main": 1 if idx <= 2 else 0,
                "plan_test": 0,
                "plan_dyn": 0,
                "plan_headcaps": 1 if is_headcap_day else 0,
                "plan_total": 1 if idx <= 2 else 0,
                "fact_lengths": fact_lengths,
            }
            day_payload[day] = payload
            for key in ("main", "test", "dyn", "headcaps", "total", "plan_main", "plan_test", "plan_dyn", "plan_headcaps", "plan_total"):
                totals_by_day[day][key] += float(payload[key])
            if fact_lengths:
                totals_by_day[day]["fact_lengths"] = fact_lengths
        rows.append({
            "code": code,
            "label": f"Уч. {idx}",
            "days": day_payload,
        })
    return {
        "sections": sections,
        "totals": {},
        "calendar": {"month": "2026-06", "days": days, "rows": rows, "totals_by_day": totals_by_day},
    }


def _pile_delivery_payload(*, available: bool = False) -> dict:
    days = [f"2026-06-{day:02d}" for day in range(1, 31)]
    totals_by_day = {day: {"plan": 0.0, "fact": 0.0} for day in days}
    rows = []
    if available:
        rows = [
            {
                "supplier": "МС-11",
                "spec_display": "12 м НС",
                "spec_code": "PILE_12M_NS",
                "spec_code_display": "12M_NS",
                "placement_side": "ns",
                "days": {
                    day: {"plan": 72.0 if day == "2026-06-24" else 0.0, "fact": 80.0 if day == "2026-06-24" else 0.0}
                    for day in days
                },
                "month_plan": 72.0,
                "month_fact": 80.0,
            },
        ]
        totals_by_day["2026-06-24"] = {"plan": 72.0, "fact": 80.0}
    return {
        "available": available,
        "date": "2026-06-24",
        "month": "2026-06",
        "days": days,
        "rows": rows,
        "totals_by_day": totals_by_day,
        "totals": {
            "day_plan": 72.0 if available else 0.0,
            "day_fact": 80.0 if available else 0.0,
            "month_plan": 72.0 if available else 0.0,
            "month_fact": 80.0 if available else 0.0,
            "delta_day": 8.0 if available else 0.0,
            "delta_month": 8.0 if available else 0.0,
        },
        "legend": ["НС — низовые сваи", "ВС — верховые сваи"],
    }


def test_reinforcement_context_keeps_all_eight_all_time_sections(monkeypatch):
    def fake_load_summary(_report_date: date, mode: str) -> dict:
        return _summary_payload(mode)

    monkeypatch.setattr(rs, "_load_summary", fake_load_summary)
    monkeypatch.setattr(rs, "_load_pile_delivery_summary", lambda _report_date: _pile_delivery_payload())

    ctx = rs.build_reinforcement_context(date(2026, 6, 2))

    assert [row["code"] for row in ctx["all_time_rows"]] == [f"UCH_{idx}" for idx in range(1, 9)]
    assert ctx["totals"]["all_fact"] == sum(range(1, 9))
    assert [row["code"] for row in ctx["section_scope_rows"]] == ["UCH_1", "UCH_2"]


def test_reinforcement_pdf_html_has_three_pages_and_requested_order(monkeypatch):
    def fake_load_summary(_report_date: date, mode: str) -> dict:
        return _summary_payload(mode)

    monkeypatch.setattr(rs, "_load_summary", fake_load_summary)
    monkeypatch.setattr(rs, "_load_pile_delivery_summary", lambda _report_date: _pile_delivery_payload())

    html = rs.render_reinforcement_html(rs.build_reinforcement_context(date(2026, 6, 2)))

    assert html.count('<div class="page') == 3
    month_idx = html.index("Нарастающий итог текущего месяца")
    all_time_idx = html.index("Нарастающий итог за все время")
    calendar_idx = html.index("Производственный календарь")
    pile_calendar_idx = html.index('<div class="section-title">Производственный календарь</div>')
    headcap_calendar_idx = html.index("Производственный календарь по монтажу наголовников")
    visual_idx = html.index("Визуальная сводка по участкам усиления")
    assert month_idx < all_time_idx < calendar_idx < visual_idx
    assert calendar_idx < pile_calendar_idx < headcap_calendar_idx < visual_idx
    assert "Итого · за все время" in html


def test_reinforcement_pdf_html_uses_headcap_calendar_from_summary(monkeypatch):
    def fake_load_summary(_report_date: date, mode: str) -> dict:
        return _summary_payload(mode)

    monkeypatch.setattr(rs, "_load_summary", fake_load_summary)
    monkeypatch.setattr(rs, "_load_pile_delivery_summary", lambda _report_date: _pile_delivery_payload())

    html = rs.render_reinforcement_html(rs.build_reinforcement_context(date(2026, 6, 2)))

    headcap_idx = html.index("Производственный календарь по монтажу наголовников")
    visual_idx = html.index("Визуальная сводка по участкам усиления")
    headcap_block = html[headcap_idx:visual_idx]
    assert "Уч. 3" in headcap_block
    assert '<td class="calendar-total plan-cell">1</td>' in headcap_block
    assert '<td class="calendar-total">2</td>' in headcap_block
    assert "12м×1" not in headcap_block


def test_reinforcement_pdf_html_moves_delivery_to_separate_third_page(monkeypatch):
    def fake_load_summary(_report_date: date, mode: str) -> dict:
        return _summary_payload(mode)

    monkeypatch.setattr(rs, "_load_summary", fake_load_summary)
    monkeypatch.setattr(rs, "_load_pile_delivery_summary", lambda _report_date: _pile_delivery_payload(available=True))

    html = rs.render_reinforcement_html(rs.build_reinforcement_context(date(2026, 6, 24)))

    assert html.count('<div class="page') == 4
    calendar_page_idx = html.index('<div class="page calendar-page">')
    delivery_page_idx = html.index('<div class="page delivery-page">')
    calendar_idx = html.index("Производственный календарь")
    delivery_idx = html.index("Поставка свай")
    visual_idx = html.index("Визуальная сводка по участкам усиления")
    calendar_block = html[calendar_page_idx:delivery_page_idx]
    assert calendar_idx < delivery_idx < visual_idx
    assert calendar_page_idx < delivery_page_idx < visual_idx
    assert "Поставка свай" not in calendar_block
    assert "МС-11" in html
    assert "12 м НС" in html
    assert "12M_NS" not in html
    assert "PILE_12M_NS" not in html
    assert html.count('<td class="delivery-kind">План</td>') >= 2
    assert html.count('<td class="delivery-kind">Факт</td>') >= 2
    assert "12м×1" in html


def test_reinforcement_completion_percent_can_exceed_100():
    assert rs._pct(125, 100) == 125
    html = rs._section_card({
        "code": "UCH_1",
        "label": "Уч. 1",
        "day_fact": 125,
        "day_plan": 100,
        "day_main": 125,
        "day_test": 0,
        "day_plan_main": 100,
        "day_plan_test": 0,
    })
    assert ">125%<" in html
    assert "width:100%" in html


def test_clean_pile_spec_label_strips_pile_prefix():
    assert rs._clean_pile_spec_label("PILE_12M_NS") == "12M_NS"
