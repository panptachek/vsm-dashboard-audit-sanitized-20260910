"""Reinforcement sections PDF generator — A4 landscape report."""
from __future__ import annotations

import html
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

SECTION_COLORS = ['#dc2626', '#f59e0b', '#eab308', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777']
WEEKDAY_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']


def _ensure_api_path() -> None:
    api_dir = Path(__file__).resolve().parents[1]
    api_dir_str = str(api_dir)
    if api_dir_str not in sys.path:
        sys.path.insert(0, api_dir_str)


def _load_summary(report_date: date, mode: str) -> dict[str, Any]:
    _ensure_api_path()
    from wip_routes import reinforcement_sections_summary

    return reinforcement_sections_summary(date=report_date.isoformat(), mode=mode)


def _load_pile_delivery_summary(report_date: date) -> dict[str, Any]:
    _ensure_api_path()
    from wip_routes import pile_deliveries_summary

    return pile_deliveries_summary(date=report_date.isoformat())


def _fnum(value: Any, decimals: int = 0) -> str:
    try:
        n = float(value or 0)
    except (TypeError, ValueError):
        n = 0.0
    if decimals <= 0:
        return f'{round(n):,}'.replace(',', ' ')
    return f'{n:,.{decimals}f}'.replace(',', ' ')


def _pct(fact: float, plan: float) -> int:
    if plan <= 0:
        return 0
    return max(0, round(fact / plan * 100))


def _section_number(code: str) -> int:
    digits = ''.join(ch for ch in code if ch.isdigit())
    return int(digits) if digits else 1


def _section_color(code: str) -> str:
    return SECTION_COLORS[(_section_number(code) - 1) % len(SECTION_COLORS)]


def _day_label(value: str) -> str:
    _, month, day = value.split('-')
    return f'{day}.{month}'


def _full_date_label(value: date) -> str:
    return value.strftime('%d.%m.%Y')


def _month_label(value: str) -> str:
    year, month = value.split('-')
    names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
    idx = int(month) - 1
    return f'{names[idx]} {year}' if 0 <= idx < len(names) else value


def _fact_value(day_facts: dict[str, Any] | None) -> float:
    if not day_facts:
        return 0.0
    return float(day_facts.get('main') or 0) + float(day_facts.get('test') or 0)


def _plan_value(day_facts: dict[str, Any] | None) -> float:
    if not day_facts:
        return 0.0
    return float(day_facts.get('plan_main') or 0) + float(day_facts.get('plan_test') or 0)


def _headcap_fact_value(day_facts: dict[str, Any] | None) -> float:
    if not day_facts:
        return 0.0
    return float(day_facts.get('headcaps') or 0)


def _headcap_plan_value(day_facts: dict[str, Any] | None) -> float:
    if not day_facts:
        return 0.0
    return float(day_facts.get('plan_headcaps') or 0)


def _section_fact(section: dict[str, Any]) -> float:
    return float(section.get('main') or 0) + float(section.get('test') or 0)


def _section_plan(section: dict[str, Any]) -> float:
    return float(section.get('plan_main') or 0) + float(section.get('plan_test') or 0)


def _sum_until(row: dict[str, Any], days: list[str], selected_date: str, getter) -> float:
    day_map = row.get('days') or {}
    return sum(getter(day_map.get(day)) for day in days if day <= selected_date)


def _row_total(row: dict[str, Any], days: list[str], getter) -> float:
    day_map = row.get('days') or {}
    return sum(getter(day_map.get(day)) for day in days)


def _fact_lengths(day_facts: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not day_facts:
        return []
    lengths = day_facts.get('fact_lengths') or []
    return [item for item in lengths if float(item.get('count') or 0) > 0]


def _fact_lengths_text(day_facts: dict[str, Any] | None) -> str:
    parts = []
    for item in _fact_lengths(day_facts):
        length_m = item.get('length_m')
        length_label = f"{_fnum(length_m)}м" if length_m is not None else 'н/д'
        parts.append(f"{length_label}×{_fnum(item.get('count') or 0)}")
    return ' · '.join(parts)


def _daily_plan_by_section(daily: dict[str, Any]) -> dict[str, float]:
    return {
        section['code']: _section_plan(section)
        for section in daily.get('sections', [])
    }


def _monthly_plan_by_section(daily: dict[str, Any]) -> dict[str, float]:
    days = daily['calendar']['days']
    result: dict[str, float] = {}
    for row in daily['calendar']['rows']:
        result[row['code']] = _row_total(row, days, _plan_value)
    return result


def _active_month_sections(daily: dict[str, Any], monthly_plan: dict[str, float], selected_date: str) -> list[dict[str, Any]]:
    """Return sections active in the selected month scope.

    The dashboard monthly view keeps a section visible when it has either a
    month plan or month-to-date fact. Do not use only selected-day fact here:
    a section with earlier month fact but zero fact/plan on the selected day
    must still contribute to month totals and the PDF calendar.
    """
    days = daily['calendar']['days']
    rows_by_code = _calendar_rows_by_code(daily)
    sections = [
        section
        for section in daily.get('sections', [])
        if monthly_plan.get(section['code'], 0) > 0
        or _sum_until(rows_by_code.get(section['code'], {'days': {}}), days, selected_date, _fact_value) > 0
    ]
    return sorted(sections or daily.get('sections', []), key=lambda item: _section_number(item['code']))


def _all_fact_sections(cumulative: dict[str, Any]) -> list[dict[str, Any]]:
    sections = [
        section
        for section in cumulative.get('sections', [])
        if _section_fact(section) > 0
    ]
    return sorted(sections or cumulative.get('sections', []), key=lambda item: _section_number(item['code']))


def _all_time_sections(cumulative: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the all-time scope as all dashboard sections, including zero fact.

    The owner wants this PDF block to always show all eight reinforcement
    sections on one sheet.  `_all_fact_sections()` intentionally hides zero-fact
    sections for the chart; this helper is for the explicit all-time card grid.
    """
    return sorted(cumulative.get('sections', []), key=lambda item: _section_number(item['code']))


def _calendar_rows_by_code(daily: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row['code']: row for row in daily['calendar']['rows']}


def _dynamic_from_calendar(daily: dict[str, Any], report_date: date, active_codes: set[str]) -> list[dict[str, Any]]:
    rows_by_code = _calendar_rows_by_code(daily)
    out: list[dict[str, Any]] = []
    for delta in (-2, -1, 0, 1):
        d = (report_date + timedelta(days=delta)).isoformat()
        by_section: dict[str, float] = {}
        plan = 0.0
        for code in active_codes:
            row = rows_by_code.get(code)
            facts = (row.get('days') or {}).get(d) if row else None
            value = _fact_value(facts)
            if value > 0:
                by_section[code] = value
            plan += _plan_value(facts)
        out.append({
            'date': d,
            'plan': plan,
            'by_section': by_section,
            'total': sum(by_section.values()),
        })
    return out


def build_reinforcement_context(report_date: date | None = None) -> dict[str, Any]:
    if report_date is None:
        report_date = date.today() - timedelta(days=1)

    daily = _load_summary(report_date, 'date')
    cumulative = _load_summary(report_date, 'cumulative')
    pile_delivery = _load_pile_delivery_summary(report_date)
    days = daily['calendar']['days']
    selected = report_date.isoformat()
    daily_plan = _daily_plan_by_section(daily)
    monthly_plan = _monthly_plan_by_section(daily)
    active_sections = _active_month_sections(daily, monthly_plan, selected)
    active_codes = {section['code'] for section in active_sections}
    cumulative_sections = _all_fact_sections(cumulative)
    cumulative_codes = {section['code'] for section in cumulative_sections}
    all_time_sections = _all_time_sections(cumulative)
    rows_by_code = _calendar_rows_by_code(daily)

    day_fact = sum(_section_fact(section) for section in active_sections)
    day_plan = sum(daily_plan.get(section['code'], 0) for section in active_sections)
    day_main = sum(float(section.get('main') or 0) for section in active_sections)
    day_test = sum(float(section.get('test') or 0) for section in active_sections)
    day_plan_main = sum(float(section.get('plan_main') or 0) for section in active_sections)
    day_plan_test = sum(float(section.get('plan_test') or 0) for section in active_sections)

    month_fact = 0.0
    month_plan = 0.0
    section_scope_rows = []
    for section in active_sections:
        code = section['code']
        row = rows_by_code.get(code, {'days': {}})
        sec_month_fact = _sum_until(row, days, selected, _fact_value)
        sec_month_plan = _sum_until(row, days, selected, _plan_value)
        month_fact += sec_month_fact
        month_plan += sec_month_plan
        section_scope_rows.append({
            'code': code,
            'label': section['label'],
            'day_main': float(section.get('main') or 0),
            'day_test': float(section.get('test') or 0),
            'day_fact': _section_fact(section),
            'day_plan_main': float(section.get('plan_main') or 0),
            'day_plan_test': float(section.get('plan_test') or 0),
            'day_plan': daily_plan.get(code, 0),
            'month_fact': sec_month_fact,
            'month_plan': sec_month_plan,
            'month_total_plan': monthly_plan.get(code, 0),
            'all_fact': _section_fact(next((item for item in cumulative_sections if item['code'] == code), {})),
        })

    all_time_rows = [
        {
            'code': section['code'],
            'label': section['label'],
            'all_fact': _section_fact(section),
        }
        for section in all_time_sections
    ]
    all_fact = sum(row['all_fact'] for row in all_time_rows)

    return {
        'report_date': report_date,
        'generated_at': datetime.now(),
        'daily': daily,
        'cumulative': cumulative,
        'days': days,
        'active_sections': active_sections,
        'active_codes': active_codes,
        'cumulative_sections': cumulative_sections,
        'cumulative_codes': cumulative_codes,
        'all_time_sections': all_time_sections,
        'all_time_rows': all_time_rows,
        'daily_plan': daily_plan,
        'monthly_plan': monthly_plan,
        'section_scope_rows': section_scope_rows,
        'totals': {
            'day_fact': day_fact,
            'day_plan': day_plan,
            'day_main': day_main,
            'day_test': day_test,
            'day_plan_main': day_plan_main,
            'day_plan_test': day_plan_test,
            'month_fact': month_fact,
            'month_plan': month_plan,
            'all_fact': all_fact,
        },
        'dynamic': _dynamic_from_calendar(daily, report_date, active_codes),
        'pile_delivery': pile_delivery,
    }


def _kpi_card(title: str, value: float, sub: str, tone: str = 'base', suffix: str = '') -> str:
    return f"""
      <div class="kpi kpi-{tone}">
        <div class="kpi-title">{html.escape(title)}</div>
        <div class="kpi-value">{_fnum(value)}{html.escape(suffix)}</div>
        <div class="kpi-sub">{html.escape(sub)}</div>
      </div>
    """


def _section_card(row: dict[str, Any]) -> str:
    pct = _pct(row['day_fact'], row['day_plan'])
    bar_pct = min(100, pct)
    color = _section_color(row['code'])
    delta = row['day_fact'] - row['day_plan']
    delta_cls = 'ok' if delta >= 0 else 'risk'
    return f"""
      <div class="section-card">
        <div class="section-head">
          <span class="swatch" style="background:{color}"></span>
          <span>{html.escape(row['label'])}</span>
          <b>{pct}%</b>
        </div>
        <div class="section-metrics">
          <div><span>План день</span><b>{_fnum(row['day_plan'])}</b></div>
          <div><span>Факт</span><b>{_fnum(row['day_fact'])}</b></div>
        </div>
        <div class="small-line">
          <span>осн. {_fnum(row['day_main'])} / {_fnum(row['day_plan_main'])}</span>
          <span>проб. {_fnum(row['day_test'])} / {_fnum(row['day_plan_test'])}</span>
        </div>
        <div class="progress"><span style="width:{bar_pct}%; background:{color}"></span></div>
        <div class="delta {delta_cls}">{'+' if delta > 0 else ''}{_fnum(delta)} шт к плану дня</div>
      </div>
    """


def _total_section_card(row: dict[str, Any]) -> str:
    pct = _pct(row['month_fact'], row['month_plan'])
    color = _section_color(row['code'])
    delta = row['month_fact'] - row['month_plan']
    delta_cls = 'ok' if delta >= 0 else 'risk'
    return f"""
      <div class="mini-card">
        <div class="mini-title"><span class="swatch" style="background:{color}"></span>{html.escape(row['label'])}</div>
        <div class="mini-sub">План к дате: {_fnum(row['month_plan'])}</div>
        <div class="mini-value">{_fnum(row['month_fact'])}</div>
        <div class="delta {delta_cls}">{'+' if delta > 0 else ''}{_fnum(delta)} шт · {pct}%</div>
      </div>
    """


def _all_time_section_card(row: dict[str, Any]) -> str:
    color = _section_color(row['code'])
    return f"""
      <div class="mini-card mini-card-all-time">
        <div class="mini-title"><span class="swatch" style="background:{color}"></span>{html.escape(row['label'])}</div>
        <div class="mini-sub">Факт за все время</div>
        <div class="mini-value">{_fnum(row['all_fact'])}</div>
      </div>
    """


def _calendar_table(ctx: dict[str, Any]) -> str:
    daily = ctx['daily']
    rows = [row for row in daily['calendar']['rows'] if row['code'] in ctx['active_codes']]
    days = ctx['days']
    selected = ctx['report_date'].isoformat()
    head = []
    for day in days:
        d = date.fromisoformat(day)
        cls = 'selected' if day == selected else 'weekend' if d.weekday() >= 5 else ''
        head.append(f'<th class="{cls}"><b>{day[-2:]}</b><span>{WEEKDAY_SHORT[(d.weekday() + 1) % 7]}</span></th>')

    body = []
    fact_totals = []
    plan_totals = []
    for row in rows:
        color = _section_color(row['code'])
        plan_cells = []
        fact_cells = []
        for day in days:
            facts = row['days'].get(day) or {}
            value = _fact_value(facts)
            plan = _plan_value(facts)
            plan_text = _fnum(plan) if plan > 0 else '·'
            plan_cells.append(f'<td class="plan-cell">{plan_text}</td>')
            length_text = _fact_lengths_text(facts)
            if day > selected:
                cls = 'future'
                text = ''
            elif value >= plan and plan > 0:
                cls = 'ok'
                text = _fnum(value)
            elif value > 0:
                cls = 'warn'
                text = _fnum(value)
            elif plan > 0:
                cls = 'risk'
                text = '0'
            else:
                cls = 'empty'
                text = '·'
            inner = f'<span class="fact-number">{text}</span>'
            if length_text and day <= selected:
                inner += f'<span class="fact-lengths">{html.escape(length_text)}</span>'
            fact_cells.append(f'<td class="{cls}">{inner}</td>')
        row_plan_total = _row_total(row, days, _plan_value)
        row_fact_total = _row_total(row, days, _fact_value)
        body.append(f"""
          <tr class="calendar-plan-row">
            <td class="calendar-label" rowspan="2"><span class="swatch" style="background:{color}"></span>{html.escape(row['label'])}</td>
            <td class="calendar-kind">План</td>
            {''.join(plan_cells)}
            <td class="calendar-total plan-cell">{_fnum(row_plan_total)}</td>
          </tr>
          <tr class="calendar-fact-row">
            <td class="calendar-kind">Факт</td>
            {''.join(fact_cells)}
            <td class="calendar-total">{_fnum(row_fact_total)}</td>
          </tr>
        """)

    totals_by_day = daily['calendar'].get('totals_by_day') or {}
    for day in days:
        day_totals = totals_by_day.get(day) or {}
        fact_total = _fact_value(day_totals)
        plan_total = _plan_value(day_totals)
        plan_totals.append(f'<td class="plan-cell">{_fnum(plan_total) if plan_total > 0 else "·"}</td>')
        length_text = _fact_lengths_text(day_totals)
        if day > selected:
            cls = 'future'
            text = ''
        elif fact_total >= plan_total and plan_total > 0:
            cls = 'ok'
            text = _fnum(fact_total)
        elif fact_total > 0:
            cls = 'warn'
            text = _fnum(fact_total)
        elif plan_total > 0:
            cls = 'risk'
            text = '0'
        else:
            cls = 'empty'
            text = '·'
        inner = f'<span class="fact-number">{text}</span>'
        if length_text and day <= selected:
            inner += f'<span class="fact-lengths">{html.escape(length_text)}</span>'
        fact_totals.append(f'<td class="{cls}">{inner}</td>')

    plan_all = sum(
        _plan_value(row['days'].get(day) or {})
        for row in rows
        for day in days
    )
    fact_all = sum(
        _fact_value(row['days'].get(day) or {})
        for row in rows
        for day in days
    )

    return f"""
      <table class="calendar-table">
        <thead>
          <tr>
            <th class="calendar-label">Участок</th>
            <th class="calendar-kind">Тип</th>
            {''.join(head)}
            <th>Итого</th>
          </tr>
        </thead>
        <tbody>
          {''.join(body)}
          <tr class="calendar-grand calendar-plan-row">
            <td class="calendar-label" rowspan="2">Итого</td>
            <td class="calendar-kind">План</td>
            {''.join(plan_totals)}
            <td class="calendar-total plan-cell">{_fnum(plan_all)}</td>
          </tr>
          <tr class="calendar-grand calendar-fact-row">
            <td class="calendar-kind">Факт</td>
            {''.join(fact_totals)}
            <td class="calendar-total">{_fnum(fact_all)}</td>
          </tr>
        </tbody>
      </table>
    """


def _has_headcap_calendar_activity(row: dict[str, Any], days: list[str]) -> bool:
    day_map = row.get('days') or {}
    return any(
        _headcap_fact_value(day_map.get(day)) > 0 or _headcap_plan_value(day_map.get(day)) > 0
        for day in days
    )


def _headcap_calendar_table(ctx: dict[str, Any]) -> str:
    daily = ctx['daily']
    days = ctx['days']
    selected = ctx['report_date'].isoformat()
    rows = [
        row
        for row in daily['calendar']['rows']
        if _has_headcap_calendar_activity(row, days)
    ]
    if not rows:
        return f"""
          <div class="calendar-empty">
            Данных и плана по монтажу наголовников за {_month_label(daily['calendar']['month'])} пока нет.
          </div>
        """

    head = []
    for day in days:
        d = date.fromisoformat(day)
        cls = 'selected' if day == selected else 'weekend' if d.weekday() >= 5 else ''
        head.append(f'<th class="{cls}"><b>{day[-2:]}</b><span>{WEEKDAY_SHORT[(d.weekday() + 1) % 7]}</span></th>')

    body = []
    fact_totals = []
    plan_totals = []
    for row in rows:
        color = _section_color(row['code'])
        plan_cells = []
        fact_cells = []
        day_map = row.get('days') or {}
        for day in days:
            facts = day_map.get(day) or {}
            value = _headcap_fact_value(facts)
            plan = _headcap_plan_value(facts)
            plan_text = _fnum(plan) if plan > 0 else '·'
            plan_cells.append(f'<td class="plan-cell">{plan_text}</td>')
            if day > selected:
                cls = 'future'
                text = ''
            elif value >= plan and plan > 0:
                cls = 'ok'
                text = _fnum(value)
            elif value > 0:
                cls = 'warn'
                text = _fnum(value)
            elif plan > 0:
                cls = 'risk'
                text = '0'
            else:
                cls = 'empty'
                text = '·'
            fact_cells.append(f'<td class="{cls}"><span class="fact-number">{text}</span></td>')
        row_plan_total = _row_total(row, days, _headcap_plan_value)
        row_fact_total = _row_total(row, days, _headcap_fact_value)
        body.append(f"""
          <tr class="calendar-plan-row">
            <td class="calendar-label" rowspan="2"><span class="swatch" style="background:{color}"></span>{html.escape(row['label'])}</td>
            <td class="calendar-kind">План</td>
            {''.join(plan_cells)}
            <td class="calendar-total plan-cell">{_fnum(row_plan_total)}</td>
          </tr>
          <tr class="calendar-fact-row">
            <td class="calendar-kind">Факт</td>
            {''.join(fact_cells)}
            <td class="calendar-total">{_fnum(row_fact_total)}</td>
          </tr>
        """)

    totals_by_day = daily['calendar'].get('totals_by_day') or {}
    for day in days:
        day_totals = totals_by_day.get(day) or {}
        fact_total = _headcap_fact_value(day_totals)
        plan_total = _headcap_plan_value(day_totals)
        plan_totals.append(f'<td class="plan-cell">{_fnum(plan_total) if plan_total > 0 else "·"}</td>')
        if day > selected:
            cls = 'future'
            text = ''
        elif fact_total >= plan_total and plan_total > 0:
            cls = 'ok'
            text = _fnum(fact_total)
        elif fact_total > 0:
            cls = 'warn'
            text = _fnum(fact_total)
        elif plan_total > 0:
            cls = 'risk'
            text = '0'
        else:
            cls = 'empty'
            text = '·'
        fact_totals.append(f'<td class="{cls}"><span class="fact-number">{text}</span></td>')

    plan_all = sum(
        _headcap_plan_value(row.get('days', {}).get(day) or {})
        for row in rows
        for day in days
    )
    fact_all = sum(
        _headcap_fact_value(row.get('days', {}).get(day) or {})
        for row in rows
        for day in days
    )

    return f"""
      <table class="calendar-table calendar-table-headcaps">
        <thead>
          <tr>
            <th class="calendar-label">Участок</th>
            <th class="calendar-kind">Тип</th>
            {''.join(head)}
            <th>Итого</th>
          </tr>
        </thead>
        <tbody>
          {''.join(body)}
          <tr class="calendar-grand calendar-plan-row">
            <td class="calendar-label" rowspan="2">Итого</td>
            <td class="calendar-kind">План</td>
            {''.join(plan_totals)}
            <td class="calendar-total plan-cell">{_fnum(plan_all)}</td>
          </tr>
          <tr class="calendar-grand calendar-fact-row">
            <td class="calendar-kind">Факт</td>
            {''.join(fact_totals)}
            <td class="calendar-total">{_fnum(fact_all)}</td>
          </tr>
        </tbody>
      </table>
    """


def _bar_row(label: str, value: float, max_value: float, color: str, suffix: str = 'шт') -> str:
    width = 0 if max_value <= 0 else max(2, min(100, value / max_value * 100))
    return f"""
      <div class="bar-row">
        <div class="bar-label">{html.escape(label)}</div>
        <div class="bar-track"><span style="width:{width:.2f}%; background:{color}"></span></div>
        <div class="bar-value">{_fnum(value)} {suffix}</div>
      </div>
    """


def _chart_card(title: str, subtitle: str, rows: list[tuple[str, float, str]], suffix: str = 'шт') -> str:
    max_value = max([value for _, value, _ in rows] + [1])
    rendered = ''.join(_bar_row(label, value, max_value, color, suffix) for label, value, color in rows)
    return f"""
      <div class="chart-card">
        <div class="chart-title">{html.escape(title)}</div>
        <div class="chart-subtitle">{html.escape(subtitle)}</div>
        <div class="bar-list">{rendered}</div>
      </div>
    """


def _dynamic_chart(ctx: dict[str, Any]) -> str:
    max_value = max([max(day['total'], day['plan']) for day in ctx['dynamic']] + [1])
    day_blocks = []
    for day in ctx['dynamic']:
        width = 0 if max_value <= 0 else max(2, min(100, day['total'] / max_value * 100))
        stacked = []
        breakdown = []
        total = day['total'] or 0
        for code, value in sorted(day['by_section'].items(), key=lambda item: _section_number(item[0])):
            if total <= 0:
                continue
            color = _section_color(code)
            stacked.append(f'<span style="width:{value / total * 100:.2f}%; background:{color}"></span>')
            breakdown.append(
                f'<span><i style="background:{color}"></i>Уч. {_section_number(code)}: {_fnum(value)}</span>'
            )
        plan_width = 0 if max_value <= 0 else max(2, min(100, day['plan'] / max_value * 100))
        day_blocks.append(f"""
          <div class="dynamic-day">
            <div class="dynamic-head"><b>{_day_label(day['date'])}</b><span>План {_fnum(day['plan'])} · Факт {_fnum(day['total'])}</span></div>
            <div class="dynamic-metric">
              <span class="dynamic-label">План</span>
              <div class="dynamic-plan"><span style="width:{plan_width:.2f}%"></span></div>
              <b>{_fnum(day['plan'])}</b>
            </div>
            <div class="dynamic-metric">
              <span class="dynamic-label">Факт</span>
              <div class="dynamic-stack"><div class="dynamic-stack-fill" style="width:{width:.2f}%">{''.join(stacked) or '<span class="empty-stack"></span>'}</div></div>
              <b>{_fnum(day['total'])}</b>
            </div>
            <div class="dynamic-breakdown">{''.join(breakdown) or '<span>Факта нет</span>'}</div>
          </div>
        """)
    return f"""
      <div class="chart-card">
        <div class="chart-title">Динамика</div>
        <div class="chart-subtitle">последние 3 дня и следующий день, план/факт</div>
        <div class="dynamic-list">{''.join(day_blocks)}</div>
      </div>
    """


def _cumulative_chart(ctx: dict[str, Any]) -> str:
    cumulative_rows = [
        (section['label'], _section_fact(section), _section_color(section['code']))
        for section in ctx['cumulative_sections']
    ]
    total = sum(value for _, value, _ in cumulative_rows)
    total_html = f'<div class="chart-total">Итого по всем участкам: <b>{_fnum(total)} шт</b></div>'
    max_value = max([value for _, value, _ in cumulative_rows] + [1])
    rendered = ''.join(_bar_row(label, value, max_value, color) for label, value, color in cumulative_rows)
    return f"""
      <div class="chart-card">
        <div class="chart-title">Нарастающий факт</div>
        <div class="chart-subtitle">по всем участкам, где была забивка</div>
        {total_html}
        <div class="bar-list">{rendered}</div>
      </div>
    """


def _charts(ctx: dict[str, Any]) -> str:
    return f"""
      <div class="chart-grid chart-grid-final">
        {_dynamic_chart(ctx)}
        {_cumulative_chart(ctx)}
      </div>
    """


def _section_legend(ctx: dict[str, Any]) -> str:
    sections = sorted(ctx['daily'].get('sections', []), key=lambda item: _section_number(item['code']))
    items = [
        f'<span><span class="swatch" style="background:{_section_color(section["code"])}"></span>{html.escape(section["label"])}</span>'
        for section in sections
    ]
    items.append('<span><span class="swatch" style="background:#f59e0b"></span>План</span>')
    return f'<div class="chart-legend">{"".join(items)}</div>'


def _pile_delivery_has_rows(ctx: dict[str, Any]) -> bool:
    summary = ctx.get('pile_delivery') or {}
    return bool(summary.get('available') and summary.get('rows'))


def _pile_delivery_spec_meta(row: dict[str, Any]) -> str:
    # В пользовательском столбце «Тип сваи» оставляем только наименование.
    # Коды заверенных свай и дублирующие подсказки по стороне не показываем.
    return ''


def _clean_pile_spec_label(value: Any) -> str:
    cleaned = re.sub(r'\bPILE[_\s-]*', '', str(value or ''), flags=re.I)
    cleaned = re.sub(r'[_\s-]+$', '', cleaned).strip()
    return cleaned or 'Свая н/д'


def _pile_delivery_plan_cell(day: str, selected_date: str, payload: dict[str, Any]) -> str:
    plan = float(payload.get('plan') or 0)
    selected_cls = ' selected' if day == selected_date else ''
    text = _fnum(plan) if plan > 0 else '·'
    return f'<td class="plan-cell{selected_cls}">{text}</td>'


def _pile_delivery_fact_cell(day: str, selected_date: str, payload: dict[str, Any]) -> str:
    plan = float(payload.get('plan') or 0)
    fact = float(payload.get('fact') or 0)
    if day > selected_date:
        cls = 'future'
        value = ''
    elif fact >= plan and (plan > 0 or fact > 0):
        cls = 'ok'
        value = _fnum(fact)
    elif fact > 0:
        cls = 'warn'
        value = _fnum(fact)
    elif plan > 0:
        cls = 'risk'
        value = '0'
    else:
        cls = 'empty'
        value = '·'
    selected_cls = ' selected' if day == selected_date else ''
    return f'<td class="delivery-cell {cls}{selected_cls}">{value}</td>'


def _pile_delivery_table(summary: dict[str, Any], selected_date: str) -> str:
    days = summary.get('days') or []
    rows = summary.get('rows') or []
    day_headers = ''.join(
        f'<th>{day.split("-")[2]}<span>{WEEKDAY_SHORT[date.fromisoformat(day).weekday() + 1 if date.fromisoformat(day).weekday() < 6 else 0]}</span></th>'
        for day in days
    )
    body_rows = []
    for row in rows:
        plan_cells = ''.join(_pile_delivery_plan_cell(day, selected_date, (row.get('days') or {}).get(day) or {}) for day in days)
        fact_cells = ''.join(_pile_delivery_fact_cell(day, selected_date, (row.get('days') or {}).get(day) or {}) for day in days)
        spec_label = _clean_pile_spec_label(row.get('spec_display') or 'Свая н/д')
        spec_meta = _pile_delivery_spec_meta(row)
        spec_secondary = f'<span>{html.escape(spec_meta)}</span>' if spec_meta and spec_meta != spec_label else ''
        body_rows.append(f"""
          <tr class="delivery-plan-row">
            <td class="delivery-supplier" rowspan="2">{html.escape(str(row.get('supplier') or '—'))}</td>
            <td class="delivery-spec" rowspan="2">{html.escape(spec_label)}{spec_secondary}</td>
            <td class="delivery-kind">План</td>
            {plan_cells}
            <td class="delivery-total plan-cell">{_fnum(row.get('month_plan') or 0) if float(row.get('month_plan') or 0) > 0 else '·'}</td>
          </tr>
          <tr class="delivery-fact-row">
            <td class="delivery-kind">Факт</td>
            {fact_cells}
            <td class="delivery-total">{_fnum(row.get('month_fact') or 0) if float(row.get('month_fact') or 0) > 0 else '·'}</td>
          </tr>
        """)
    totals_by_day = summary.get('totals_by_day') or {}
    plan_totals_cells = ''.join(
        _pile_delivery_plan_cell(day, selected_date, totals_by_day.get(day) or {})
        for day in days
    )
    fact_totals_cells = ''.join(
        _pile_delivery_fact_cell(day, selected_date, totals_by_day.get(day) or {})
        for day in days
    )
    totals = summary.get('totals') or {}
    return f"""
      <table class="delivery-table">
        <thead>
          <tr>
            <th class="delivery-supplier-head">Поставщик</th>
            <th class="delivery-spec-head">Тип сваи</th>
            <th class="delivery-kind-head">Строка</th>
            {day_headers}
            <th class="delivery-total-head">Итого</th>
          </tr>
        </thead>
        <tbody>
          {''.join(body_rows)}
          <tr class="delivery-grand delivery-plan-row">
            <td class="delivery-supplier" rowspan="2">Итого</td>
            <td class="delivery-spec" rowspan="2">Все поставщики</td>
            <td class="delivery-kind">План</td>
            {plan_totals_cells}
            <td class="delivery-total plan-cell">{_fnum(totals.get('month_plan') or 0) if float(totals.get('month_plan') or 0) > 0 else '·'}</td>
          </tr>
          <tr class="delivery-grand delivery-fact-row">
            <td class="delivery-kind">Факт</td>
            {fact_totals_cells}
            <td class="delivery-total">{_fnum(totals.get('month_fact') or 0) if float(totals.get('month_fact') or 0) > 0 else '·'}</td>
          </tr>
        </tbody>
      </table>
    """


def _pile_delivery_page(ctx: dict[str, Any]) -> str:
    if not _pile_delivery_has_rows(ctx):
        return ''
    summary = ctx['pile_delivery']
    totals = summary.get('totals') or {}
    legend_items = ''.join(f'<span>{html.escape(item)}</span>' for item in summary.get('legend') or [])
    return f"""
    <div class="section-title">Поставка свай</div>
    <div class="kpi-grid delivery-kpi-grid">
      {_kpi_card('План день', float(totals.get('day_plan') or 0), 'поставка по календарю', 'plan')}
      {_kpi_card('Факт день', float(totals.get('day_fact') or 0), 'отгружено/принято', 'fact')}
      {_kpi_card('План месяц', float(totals.get('month_plan') or 0), 'всего по текущему месяцу', 'plan')}
      {_kpi_card('Факт месяц', float(totals.get('month_fact') or 0), f'отклонение {"+" if float(totals.get("delta_month") or 0) > 0 else ""}{_fnum(totals.get("delta_month") or 0)} шт', 'ok' if float(totals.get('delta_month') or 0) >= 0 else 'fact')}
    </div>
    <div class="delivery-note">
      <div><b>Строки:</b> план и факт вынесены отдельно по дням</div>
      <div class="delivery-legend">{legend_items}</div>
    </div>
    {_pile_delivery_table(summary, ctx['report_date'].isoformat())}
    <div class="footer">Источник данных: /api/wip/pile-deliveries/summary и таблица pile_delivery_calendar.</div>
    """


def _pile_delivery_report_page(ctx: dict[str, Any], date_str: str) -> str:
    content = _pile_delivery_page(ctx)
    if not content:
        return ''
    return f"""
  <div class="page delivery-page">
    <header class="report-header">
      <div>
        <div class="eyebrow">Поставка свай</div>
        <h1>Поставка свай</h1>
      </div>
      <div class="meta">
        <div>Период: <b>{_month_label(ctx['daily']['calendar']['month'])}</b></div>
        <div>Дата отчета: {date_str}</div>
      </div>
    </header>
    {content}
  </div>
"""


def render_reinforcement_html(ctx: dict[str, Any]) -> str:
    report_date = ctx['report_date']
    totals = ctx['totals']
    date_str = _full_date_label(report_date)
    generated_str = ctx['generated_at'].strftime('%d.%m.%Y %H:%M')
    rows = ctx['section_scope_rows']
    all_time_rows = ctx['all_time_rows']

    css = """
@page {
  size: A4 landscape;
  margin: 7mm 7mm;
}
@page calendar-page {
  size: A4 landscape;
  margin: 4mm 4mm;
}
@page delivery-page {
  size: A4 landscape;
  margin: 5mm 5mm;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: Arial, sans-serif;
  color: #1f2937;
  background: #fff;
  font-size: 7.8pt;
}
.page {
  page-break-after: always;
}
.page:last-child {
  page-break-after: auto;
}
.calendar-page {
  page: calendar-page;
}
.delivery-page {
  page: delivery-page;
}
.report-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8mm;
  padding-bottom: 2mm;
  border-bottom: 2px solid #b91c1c;
  margin-bottom: 2.4mm;
}
.eyebrow {
  font-size: 7pt;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #6b7280;
  font-weight: 700;
}
h1 {
  margin: 1mm 0 0;
  font-size: 14pt;
  line-height: 1.05;
  color: #111827;
}
.meta {
  text-align: right;
  color: #4b5563;
  line-height: 1.45;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 3mm;
  margin: 2.2mm 0 1.1mm;
  font-size: 7.5pt;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #6b7280;
  font-weight: 700;
}
.section-title:after {
  content: "";
  height: 1px;
  background: #d1d5db;
  flex: 1;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2mm;
}
.kpi {
  border: 1px solid #e5e7eb;
  border-radius: 5px;
  padding: 2mm;
  background: #f9fafb;
}
.kpi-plan {
  background: #fffbeb;
  border-color: #fcd34d;
}
.kpi-fact {
  background: #fff1f2;
  border-color: #fecdd3;
}
.kpi-ok {
  background: #ecfdf5;
  border-color: #a7f3d0;
}
.kpi-title {
  color: #6b7280;
  font-size: 7pt;
  font-weight: 700;
  text-transform: uppercase;
}
.kpi-value {
  margin-top: 0.8mm;
  font-size: 15pt;
  font-weight: 800;
  line-height: 1;
  color: #111827;
}
.kpi-sub {
  margin-top: 1mm;
  color: #6b7280;
  font-size: 7.5pt;
}
.daily-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2mm;
}
.section-card,
.mini-card,
.chart-card {
  border: 1px solid #e5e7eb;
  border-radius: 5px;
  background: #fff;
  padding: 2mm;
}
.section-card {
  min-height: 25mm;
}
.section-head,
.mini-title {
  display: flex;
  align-items: center;
  gap: 1.6mm;
  color: #374151;
  font-size: 7.2pt;
  font-weight: 700;
  text-transform: uppercase;
}
.section-head b {
  margin-left: auto;
  color: #111827;
}
.swatch {
  display: inline-block;
  width: 2.7mm;
  height: 2.7mm;
  border-radius: 2px;
  vertical-align: -0.4mm;
  margin-right: 1.4mm;
}
.section-metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.4mm;
  margin-top: 1.4mm;
}
.section-metrics div {
  background: #f3f4f6;
  border-radius: 4px;
  padding: 1.4mm;
  text-align: center;
}
.section-metrics span,
.mini-sub {
  display: block;
  color: #6b7280;
  font-size: 6.8pt;
}
.section-metrics b {
  display: block;
  margin-top: 0.6mm;
  color: #111827;
  font-size: 12pt;
  line-height: 1;
}
.small-line {
  display: flex;
  justify-content: space-between;
  gap: 2mm;
  margin-top: 1.2mm;
  color: #6b7280;
  font-size: 6.5pt;
}
.progress {
  height: 2mm;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  overflow: hidden;
  margin-top: 1.2mm;
}
.progress span {
  display: block;
  height: 100%;
}
.delta {
  margin-top: 1mm;
  font-size: 6.6pt;
  font-weight: 700;
}
.delta.ok {
  color: #047857;
}
.delta.risk {
  color: #b91c1c;
}
.total-layout {
  display: grid;
  grid-template-columns: 1fr 58mm;
  gap: 2mm;
}
.mini-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2mm;
}
.mini-value {
  margin-top: 0.6mm;
  font-size: 12pt;
  line-height: 1;
  font-weight: 800;
}
.total-box {
  border: 1px solid #fecaca;
  border-radius: 5px;
  padding: 2.5mm;
  background: #fff7f7;
}
.total-box-title {
  font-size: 7pt;
  color: #7f1d1d;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.total-pair {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 3mm;
  margin-top: 2.6mm;
  text-align: center;
}
.total-pair-single {
  grid-template-columns: 1fr;
}
.total-box-all-time {
  background: #f8fafc;
  border-color: #cbd5e1;
}
.total-pair span {
  display: block;
  color: #6b7280;
  font-size: 7pt;
  font-weight: 700;
  text-transform: uppercase;
}
.total-pair b {
  display: block;
  margin-top: 1mm;
  font-size: 17pt;
  line-height: 1;
}
.calendar-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.calendar-table th,
.calendar-table td {
  border: 1px solid #d1d5db;
  padding: 1mm 0.8mm;
  text-align: center;
}
.calendar-table th {
  background: #f3f4f6;
  color: #374151;
  font-size: 6pt;
  font-weight: 700;
}
.calendar-table {
  font-size: 4.9pt;
}
.calendar-table th,
.calendar-table td {
  padding: 0.45mm 0.25mm;
}
.calendar-table th span {
  display: block;
  color: #6b7280;
  font-size: 4.3pt;
}
.calendar-table .calendar-label {
  width: 24mm;
  text-align: left;
  font-weight: 700;
  background: #fff;
}
.calendar-table .calendar-kind {
  width: 9mm;
  color: #6b7280;
  font-size: 4.5pt;
  font-weight: 700;
  text-transform: uppercase;
  background: #f9fafb;
}
.calendar-table .calendar-total {
  width: 10mm;
  font-weight: 800;
  background: #f9fafb;
}
.calendar-table .plan-cell {
  background: #fffbeb;
  color: #92400e;
  font-weight: 700;
}
.calendar-plan-row td {
  border-bottom-color: #f3e8c2;
}
.calendar-fact-row td {
  border-top-color: #f3e8c2;
}
.calendar-table .selected {
  background: #fee2e2;
  color: #991b1b;
}
.calendar-table .weekend {
  background: #fffbeb;
}
.calendar-table .ok {
  background: #ecfdf5;
  color: #047857;
  font-weight: 700;
}
.calendar-table .warn {
  background: #fffbeb;
  color: #b45309;
  font-weight: 700;
}
.calendar-table .risk {
  background: #fef2f2;
  color: #b91c1c;
  font-weight: 700;
}
.calendar-table .empty {
  background: #f9fafb;
  color: #9ca3af;
}
.calendar-table .future {
  background: #fff;
  color: #d1d5db;
}
.calendar-table .fact-number {
  display: block;
  font-weight: 700;
  line-height: 1.05;
}
.calendar-table .fact-lengths {
  display: block;
  margin-top: 0.35mm;
  font-size: 3.7pt;
  line-height: 1.08;
  white-space: normal;
}
.calendar-grand td {
  background: #fff1f2;
  color: #7f1d1d;
  font-weight: 800;
}
.calendar-page .report-header {
  margin-bottom: 1.4mm;
  padding-bottom: 1.5mm;
}
.calendar-page h1 {
  font-size: 13pt;
}
.calendar-page .section-title {
  margin: 1.6mm 0 0.8mm;
  font-size: 8pt;
}
.calendar-page .calendar-table {
  font-size: 5.5pt;
}
.calendar-page .calendar-table th,
.calendar-page .calendar-table td {
  padding: 0.66mm 0.38mm;
}
.calendar-page .calendar-table th {
  font-size: 6.2pt;
}
.calendar-page .calendar-table th span {
  font-size: 4.8pt;
}
.calendar-page .calendar-table .calendar-label {
  width: 25mm;
}
.calendar-page .calendar-table .calendar-kind {
  width: 9.5mm;
  font-size: 5pt;
}
.calendar-page .calendar-table .calendar-total {
  width: 11mm;
}
.calendar-page .calendar-table .fact-lengths {
  font-size: 4.1pt;
  line-height: 1.05;
}
.calendar-table-headcaps {
  margin-top: 1mm;
}
.calendar-empty {
  border: 1px dashed #d1d5db;
  border-radius: 5px;
  padding: 2.2mm 2.5mm;
  background: #f9fafb;
  color: #6b7280;
  font-size: 7pt;
}
.delivery-kpi-grid {
  margin-bottom: 2mm;
}
.delivery-note {
  display: flex;
  justify-content: space-between;
  gap: 4mm;
  margin: 1.8mm 0 2mm;
  color: #6b7280;
  font-size: 6.8pt;
}
.delivery-legend {
  display: flex;
  gap: 2mm 4mm;
  flex-wrap: wrap;
}
.delivery-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 4.8pt;
}
.delivery-table th,
.delivery-table td {
  border: 1px solid #d1d5db;
  padding: 0.45mm 0.3mm;
  text-align: center;
}
.delivery-table th {
  background: #f3f4f6;
  color: #374151;
  font-size: 5.6pt;
  font-weight: 700;
}
.delivery-table th span,
.delivery-spec span {
  display: block;
  color: #6b7280;
  font-size: 4.3pt;
}
.delivery-supplier-head,
.delivery-supplier {
  width: 18mm;
}
.delivery-spec-head,
.delivery-spec {
  width: 16mm;
}
.delivery-kind-head,
.delivery-kind {
  width: 7mm;
}
.delivery-supplier,
.delivery-spec {
  text-align: left;
  font-weight: 700;
  background: #fff;
  vertical-align: middle;
}
.delivery-kind {
  background: #f9fafb;
  color: #6b7280;
  font-weight: 700;
}
.delivery-total-head,
.delivery-total {
  width: 8.5mm;
  font-weight: 800;
  background: #f9fafb;
}
.delivery-plan-row .delivery-kind {
  background: #fffbeb;
  color: #92400e;
}
.delivery-cell.ok,
.delivery-table .ok {
  background: #ecfdf5;
  color: #047857;
  font-weight: 700;
}
.delivery-cell.warn,
.delivery-table .warn {
  background: #fffbeb;
  color: #b45309;
  font-weight: 700;
}
.delivery-cell.risk,
.delivery-table .risk {
  background: #fef2f2;
  color: #b91c1c;
  font-weight: 700;
}
.delivery-cell.empty,
.delivery-table .empty {
  background: #f9fafb;
  color: #9ca3af;
}
.delivery-cell.future,
.delivery-table .future {
  background: #fff;
  color: #d1d5db;
}
.delivery-table .selected {
  box-shadow: inset 0 0 0 99px rgba(254, 226, 226, 0.6);
  color: #991b1b;
}
.delivery-table .plan-cell {
  background: #fffbeb;
  color: #92400e;
}
.delivery-grand td {
  background: #fff1f2;
  color: #7f1d1d;
  font-weight: 800;
}
.delivery-grand .delivery-kind {
  background: #fff1f2;
  color: #7f1d1d;
}
.delivery-page .report-header {
  margin-bottom: 1.7mm;
  padding-bottom: 1.7mm;
}
.delivery-page .section-title {
  margin: 1.6mm 0 1mm;
}
.delivery-page .delivery-kpi-grid {
  margin-bottom: 1.4mm;
}
.delivery-page .kpi {
  padding: 1.5mm 1.8mm;
}
.delivery-page .kpi-value {
  font-size: 13pt;
}
.delivery-page .kpi-sub {
  font-size: 6.7pt;
}
.delivery-page .delivery-note {
  margin: 1mm 0 1.2mm;
  font-size: 6.2pt;
}
.delivery-page .delivery-table {
  font-size: 4.35pt;
}
.delivery-page .delivery-table th,
.delivery-page .delivery-table td {
  padding: 0.32mm 0.22mm;
}
.delivery-page .delivery-table th {
  font-size: 5pt;
}
.delivery-page .delivery-table th span,
.delivery-page .delivery-spec span {
  font-size: 3.9pt;
}
.delivery-page .delivery-supplier-head,
.delivery-page .delivery-supplier {
  width: 17mm;
}
.delivery-page .delivery-spec-head,
.delivery-page .delivery-spec {
  width: 15mm;
}
.delivery-page .delivery-kind-head,
.delivery-page .delivery-kind {
  width: 6.5mm;
}
.delivery-page .delivery-total-head,
.delivery-page .delivery-total {
  width: 8mm;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4mm;
}
.chart-grid-final {
  margin-top: 4mm;
}
.chart-card {
  min-height: 122mm;
  break-inside: avoid;
}
.chart-title {
  font-size: 10pt;
  color: #111827;
  font-weight: 800;
}
.chart-subtitle {
  margin-top: 1mm;
  color: #6b7280;
  font-size: 7pt;
}
.bar-list {
  margin-top: 3mm;
}
.chart-total {
  display: inline-block;
  margin-top: 3mm;
  padding: 2mm 3mm;
  border-radius: 4px;
  background: #fff1f2;
  color: #7f1d1d;
  font-size: 8pt;
  font-weight: 700;
}
.chart-total b {
  color: #111827;
}
.bar-row {
  display: grid;
  grid-template-columns: 25mm 1fr 17mm;
  align-items: center;
  gap: 2mm;
  margin-bottom: 1.7mm;
}
.bar-label {
  font-size: 7pt;
  font-weight: 700;
  color: #374151;
}
.bar-track {
  height: 5.2mm;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
}
.bar-track span {
  display: block;
  height: 100%;
}
.bar-value {
  text-align: right;
  font-size: 7pt;
  font-weight: 700;
  color: #111827;
}
.dynamic-list {
  margin-top: 3mm;
}
.dynamic-day {
  margin-bottom: 4mm;
}
.dynamic-head {
  display: flex;
  justify-content: space-between;
  color: #374151;
  font-size: 7pt;
  font-weight: 700;
}
.dynamic-metric {
  display: grid;
  grid-template-columns: 11mm 1fr 13mm;
  align-items: center;
  gap: 2mm;
  margin-top: 1mm;
}
.dynamic-label {
  color: #6b7280;
  font-size: 6.6pt;
  font-weight: 700;
  text-transform: uppercase;
}
.dynamic-plan,
.dynamic-stack {
  height: 4.8mm;
  width: 100%;
  border-radius: 4px;
  overflow: hidden;
}
.dynamic-plan {
  background: #fffbeb;
  border: 1px solid #fcd34d;
}
.dynamic-plan span {
  display: block;
  height: 100%;
  background: #f59e0b;
}
.dynamic-stack {
  display: flex;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
}
.dynamic-stack span {
  display: block;
  height: 100%;
}
.dynamic-stack-fill {
  display: flex;
  height: 100%;
}
.dynamic-metric b {
  text-align: right;
  color: #111827;
  font-size: 7pt;
}
.dynamic-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 1mm 2mm;
  margin-top: 1.2mm;
  color: #6b7280;
  font-size: 6.5pt;
}
.dynamic-breakdown span {
  display: inline-flex;
  align-items: center;
  gap: 0.8mm;
}
.dynamic-breakdown i {
  display: inline-block;
  width: 2mm;
  height: 2mm;
  border-radius: 2px;
}
.empty-stack {
  width: 100%;
  background: #f3f4f6;
}
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2mm 4mm;
  margin-top: 3mm;
  padding: 2mm 2.5mm;
  border: 1px solid #e5e7eb;
  border-radius: 5px;
  background: #f9fafb;
  color: #6b7280;
  font-size: 7pt;
}
.footer {
  margin-top: 3mm;
  text-align: right;
  color: #6b7280;
  font-size: 6.8pt;
}
"""

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>{css}</style>
</head>
<body>
  <div class="page calendar-page">
    <header class="report-header">
      <div>
        <div class="eyebrow">ВСМ-1 · Участки усиления</div>
        <h1>Отчет по забивке свай за {date_str}</h1>
      </div>
      <div class="meta">
        <div>Дата отчета: <b>{date_str}</b></div>
        <div>Сформировано: {generated_str}</div>
        <div>Единица измерения: шт.</div>
      </div>
    </header>

    <div class="section-title">Суточный отчет</div>
    <div class="kpi-grid">
      {_kpi_card('План день', totals['day_plan'], f"осн. {_fnum(totals['day_plan_main'])} · проб. {_fnum(totals['day_plan_test'])}", 'plan')}
      {_kpi_card('Факт день', totals['day_fact'], f"осн. {_fnum(totals['day_main'])} · проб. {_fnum(totals['day_test'])}", 'fact')}
      {_kpi_card('Выполнение', _pct(totals['day_fact'], totals['day_plan']), 'процент к плану дня', 'ok', '%')}
      {_kpi_card('Отклонение', totals['day_fact'] - totals['day_plan'], 'факт минус план дня')}
    </div>

    <div class="section-title">Активные участки за месяц</div>
    <div class="daily-grid">
      {''.join(_section_card(row) for row in rows)}
    </div>

    <div class="section-title">Нарастающий итог текущего месяца</div>
    <div class="total-layout">
      <div class="mini-grid">
        {''.join(_total_section_card(row) for row in rows)}
      </div>
      <div class="total-box">
        <div class="total-box-title">Итого · текущий месяц к дате</div>
        <div class="total-pair">
          <div><span>План</span><b>{_fnum(totals['month_plan'])}</b></div>
          <div><span>Факт</span><b>{_fnum(totals['month_fact'])}</b></div>
        </div>
        <div class="delta {'ok' if totals['month_fact'] >= totals['month_plan'] else 'risk'}">
          {'+' if totals['month_fact'] - totals['month_plan'] > 0 else ''}{_fnum(totals['month_fact'] - totals['month_plan'])} шт отклонение
        </div>
      </div>
    </div>

    <div class="section-title">Нарастающий итог за все время</div>
    <div class="total-layout total-layout-all-time">
      <div class="mini-grid">
        {''.join(_all_time_section_card(row) for row in all_time_rows)}
      </div>
      <div class="total-box total-box-all-time">
        <div class="total-box-title">Итого · за все время</div>
        <div class="total-pair total-pair-single">
          <div><span>Факт</span><b>{_fnum(totals['all_fact'])}</b></div>
        </div>
      </div>
    </div>
  </div>

  <div class="page">
    <header class="report-header">
      <div>
        <div class="eyebrow">Календарь</div>
        <h1>Производственный календарь</h1>
      </div>
      <div class="meta">
        <div>Период: <b>{_month_label(ctx['daily']['calendar']['month'])}</b></div>
        <div>Дата отчета: {date_str}</div>
      </div>
    </header>
    <div class="section-title">Производственный календарь</div>
    {_calendar_table(ctx)}
    <div class="section-title">Производственный календарь по монтажу наголовников</div>
    {_headcap_calendar_table(ctx)}
  </div>

  {_pile_delivery_report_page(ctx, date_str)}

  <div class="page">
    <header class="report-header">
      <div>
        <div class="eyebrow">Графики</div>
        <h1>Визуальная сводка по участкам усиления</h1>
      </div>
      <div class="meta">Период календаря: {_month_label(ctx['daily']['calendar']['month'])}</div>
    </header>
    {_section_legend(ctx)}
    {_charts(ctx)}
    <div class="footer">Левый сайдбар дашборда в PDF не включается. Источник данных: /api/wip/reinforcement-sections/summary.</div>
  </div>
</body>
</html>"""


def generate_reinforcement_pdf(report_date: date | None = None, ctx: dict[str, Any] | None = None) -> bytes:
    if ctx is None:
        ctx = build_reinforcement_context(report_date)
    from weasyprint import HTML

    html_str = render_reinforcement_html(ctx)
    return HTML(string=html_str, base_url='/').write_pdf()


if __name__ == '__main__':
    d = date.today() - timedelta(days=1)
    if len(sys.argv) > 1:
        d = date.fromisoformat(sys.argv[1])
    pdf_bytes = generate_reinforcement_pdf(d)
    out = Path('/tmp/vsm-pdf-samples/reinforcement-sections-sample.pdf')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf_bytes)
    print(f'Written {out} ({len(pdf_bytes)} bytes)')
