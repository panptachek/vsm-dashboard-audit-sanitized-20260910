#!/usr/bin/env python3
"""Memory-bounded A3 PDF renderer for mainline earthwork structural schemes.

The renderer is intentionally vector-first and page-by-page.  It consumes the
same mainline-fill payload that powers the dashboard card view, then writes a
single A3 landscape overview page for the three stage-3 segments.  No browser
capture or large raster canvas is used.
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import re
import sys
import tempfile
import textwrap
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable

if not os.environ.get("MPLCONFIGDIR"):
    mpl_config_dir = Path(tempfile.gettempdir()) / "vsm-mainline-scheme-mpl"
    mpl_config_dir.mkdir(parents=True, exist_ok=True)
    os.environ["MPLCONFIGDIR"] = str(mpl_config_dir)

API_DIR = Path(__file__).resolve().parent.parent
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

A3_LANDSCAPE = (420 / 25.4, 297 / 25.4)
FONT = "DejaVu Sans"
MONO_FONT = "DejaVu Sans Mono"

STATUS_META = [
    ("prep_works", "Подготовка", "#E8DDF5", "#7c3aed"),
    ("main_works", "Основные", "#FCE5CD", "#d97706"),
    ("protective_layer_2", "ЗС №2", "#FFF2CC", "#ca8a04"),
    ("protective_layer_1", "ЗС №1", "#D9EAF7", "#2563eb"),
    ("asphalt_layer", "Асфальтобетон", "#D9EAD3", "#16a34a"),
    ("no_work", "Не в работе", "#f8fafc", "#6b7280"),
]
STATUS_BY_KEY = {key: (label, fill, stroke) for key, label, fill, stroke in STATUS_META}

OBJECT_LANES = [
    ("pile_field", "Свайные поля"),
    ("isso", "ЖДМ / эстакады"),
    ("pipe", "Водопропускные трубы"),
    ("crossing", "Пересечения"),
]
OBJECT_GROUP_ORDER = {key: idx for idx, (key, _label) in enumerate(OBJECT_LANES)}
OBJECT_TYPE_META = {
    "PILE_FIELD": {"symbol": "pile_field", "label": "Свайное поле", "color": "#007fff", "fill": "#e0f2fe"},
    "BRIDGE": {"symbol": "bridge", "label": "ЖДМ / эстакада", "color": "#111827", "fill": "#f8fafc"},
    "OVERPASS": {"symbol": "overpass", "label": "Путепровод", "color": "#111827", "fill": "#f8fafc"},
    "PIPE": {"symbol": "pipe", "label": "Водопропускная труба", "color": "#06b6d4", "fill": "#ecfeff"},
    "INTERSECTION_FIN": {"symbol": "intersection_fin", "label": "Пересечение", "color": "#7c3aed", "fill": "#f5f3ff"},
    "INTERSECTION_PROP": {"symbol": "intersection_prop", "label": "Пересечение", "color": "#7c3aed", "fill": "#f5f3ff"},
    "RECONS_ROAD": {"symbol": "intersection_prop", "label": "Пересечение", "color": "#7c3aed", "fill": "#f5f3ff"},
}
OBJECT_LEGEND_ORDER = ("BRIDGE", "OVERPASS", "PILE_FIELD", "INTERSECTION_FIN", "PIPE")
RD_COLOR = {"issued": "#15803d", "ready_work": "#ca8a04", "ready_idle": "#b91c1c"}
RD_LABEL = {"issued": "РД выдана", "ready_work": "РД + сваи готовы + работы идут", "ready_idle": "РД + сваи готовы + работ нет"}

PDF_FRAME_LEFT = 20 / 420
PDF_FRAME_RIGHT = 1 - 5 / 420
PDF_FRAME_BOTTOM = 5 / 297
PDF_FRAME_TOP = 1 - 5 / 297
PDF_X_LEFT = 0.092
PDF_X_RIGHT = 0.982
PDF_RD_Y = 0.805
PDF_ROW_H = 0.032
PDF_STATUS_FIRST_Y = 0.720
PDF_STATUS_TRACK_H = 0.042
PDF_STATUS_GAP = 0.008
PDF_STATUS_BLOCK_TOP = PDF_STATUS_FIRST_Y + PDF_STATUS_TRACK_H
PDF_STATUS_BLOCK_BOTTOM = PDF_STATUS_FIRST_Y - (len(STATUS_META) - 1) * (PDF_STATUS_TRACK_H + PDF_STATUS_GAP)
PDF_PK_ROW_Y = 0.412
PDF_DATE_ROW_Y = 0.372
PDF_AXIS_Y = 0.326
PDF_GRID_TOP = PDF_RD_Y + PDF_ROW_H + 0.012

PDF_PANEL_TOPS = (0.890, 0.615, 0.340)
PDF_PANEL_ROW_H = 0.014
PDF_PANEL_SITUATION_H = 0.052
PDF_PANEL_TRACK_H = 0.012
PDF_PANEL_GAP = 0.002
PDF_PANEL_SITUATION_OFFSET = 0.095
PDF_PANEL_STATUS_OFFSET = 0.022
PDF_PANEL_ROW_STEP = 0.017
PDF_PANEL_AXIS_OFFSET = 0.020
PDF_PANEL_CALLOUT_LANES = 2
PDF_PANEL_CALLOUT_STEP = 0.014
PDF_PANEL_CALLOUT_H = 0.0075


def _norm_section(code: Any) -> str:
    text = str(code or "").strip().upper()
    match = re.fullmatch(r"(?:УЧ(?:АСТОК)?[_\s-]*)?(\d+)", text)
    if match:
        return f"UCH_{match.group(1)}"
    return text


def _section_num(code: Any) -> int:
    match = re.search(r"(\d+)", str(code or ""))
    return int(match.group(1)) if match else 99


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _date_label(value: Any) -> str:
    if not value:
        return "-"
    if isinstance(value, datetime):
        return value.strftime("%d.%m.%Y")
    if isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    text = str(value)
    try:
        return date.fromisoformat(text[:10]).strftime("%d.%m.%Y")
    except ValueError:
        return text


def _format_pk(value: Any) -> str:
    m = _as_float(value)
    sign = "-" if m < 0 else ""
    m_abs = abs(m)
    pk = int(m_abs // 100)
    plus = m_abs - pk * 100
    if abs(plus - round(plus)) < 0.005:
        return f"{sign}ПК{pk}+{int(round(plus)):02d}"
    return f"{sign}ПК{pk}+{plus:05.2f}"


def _format_pk_range(start: Any, end: Any) -> str:
    if start is None or end is None:
        return "ПК н/д"
    return f"{_format_pk(start)} - {_format_pk(end)}"


def _fnum(value: Any, digits: int = 0) -> str:
    number = _as_float(value)
    if digits <= 0:
        return f"{int(round(number)):,}".replace(",", " ")
    return f"{number:,.{digits}f}".replace(",", " ")


def _short(value: Any, width: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ").strip())
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)].rstrip() + "..."


def _merge_ranges(ranges: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    clean = sorted((min(a, b), max(a, b)) for a, b in ranges if a is not None and b is not None)
    if not clean:
        return []
    out: list[list[float]] = [[clean[0][0], clean[0][1]]]
    for start, end in clean[1:]:
        if start <= out[-1][1] + 0.01:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(a, b) for a, b in out]


def _clip_to_ranges(start: Any, end: Any, allowed: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if start is None or end is None:
        return []
    raw_start, raw_end = min(_as_float(start), _as_float(end)), max(_as_float(start), _as_float(end))
    is_point = raw_end - raw_start < 0.01
    out: list[tuple[float, float]] = []
    for allowed_start, allowed_end in allowed:
        lo, hi = min(allowed_start, allowed_end), max(allowed_start, allowed_end)
        if is_point:
            if lo <= raw_start <= hi:
                out.append((raw_start, raw_start))
            continue
        clipped_start = max(raw_start, lo)
        clipped_end = min(raw_end, hi)
        if clipped_end - clipped_start >= 0.01:
            out.append((clipped_start, clipped_end))
    return out if is_point else _merge_ranges(out)


def _subtract_ranges(universes: list[tuple[float, float]], holes: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = _merge_ranges(universes)
    for h_start, h_end in _merge_ranges(holes):
        next_ranges: list[tuple[float, float]] = []
        for start, end in out:
            if h_end <= start or h_start >= end:
                next_ranges.append((start, end))
                continue
            if start < h_start:
                next_ranges.append((start, h_start))
            if h_end < end:
                next_ranges.append((h_end, end))
        out = _merge_ranges(next_ranges)
    return out


def _ranges_overlap(a_start: Any, a_end: Any, b_start: Any, b_end: Any) -> bool:
    a, b = min(_as_float(a_start), _as_float(a_end)), max(_as_float(a_start), _as_float(a_end))
    c, d = min(_as_float(b_start), _as_float(b_end)), max(_as_float(b_start), _as_float(b_end))
    if abs(b - a) < 0.01:
        return c <= a <= d
    if abs(d - c) < 0.01:
        return a <= c <= b
    return min(b, d) - max(a, c) > 0.01


def _range_intersects_ranges(start: Any, end: Any, ranges: list[tuple[float, float]]) -> bool:
    return any(_ranges_overlap(start, end, a, b) for a, b in ranges)


def _section_ranges(section: dict[str, Any]) -> list[tuple[float, float]]:
    ranges = [
        (min(_as_float(item.get("pk_start")), _as_float(item.get("pk_end"))),
         max(_as_float(item.get("pk_start")), _as_float(item.get("pk_end"))))
        for item in section.get("ranges") or []
        if item.get("pk_start") is not None and item.get("pk_end") is not None
    ]
    if not ranges and section.get("pk_start") is not None and section.get("pk_end") is not None:
        ranges = [(min(_as_float(section.get("pk_start")), _as_float(section.get("pk_end"))),
                   max(_as_float(section.get("pk_start")), _as_float(section.get("pk_end"))))]
    return _merge_ranges(ranges)


def _is_isso_gap(row: dict[str, Any]) -> bool:
    return str(row.get("object_type_code") or "").strip().upper() in {"BRIDGE", "OVERPASS"}


def _earthwork_ranges(section: dict[str, Any], allowed: list[tuple[float, float]]) -> list[tuple[float, float]]:
    holes: list[tuple[float, float]] = []
    for row in section.get("related_objects") or []:
        if not _is_isso_gap(row):
            continue
        holes.extend(_clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed))
    return _subtract_ranges(allowed, holes)


def _pile_summary_ready(row: dict[str, Any]) -> bool:
    summary = row.get("pile_summary") or {}
    planned = _as_float(summary.get("planned_main")) + _as_float(summary.get("planned_trial"))
    if planned <= 0:
        return False
    driven = _as_float(summary.get("driven_main")) + _as_float(summary.get("driven_trial"))
    return driven >= planned - 0.01


def _readiness_rows(section: dict[str, Any], earthwork_allowed: list[tuple[float, float]]) -> list[dict[str, Any]]:
    work_ranges: list[tuple[float, float]] = []
    for segment in section.get("segments") or []:
        if str(segment.get("status_type") or "") == "no_work":
            continue
        work_ranges.extend(_clip_to_ranges(segment.get("pk_start"), segment.get("pk_end"), earthwork_allowed))
    work_ranges = _merge_ranges(work_ranges)
    pile_objects = [
        row for row in section.get("related_objects") or []
        if str(row.get("object_group") or "") == "pile_field"
    ]
    out: list[dict[str, Any]] = []
    for doc in section.get("rd_documents") or []:
        for start, end in _clip_to_ranges(doc.get("pk_start"), doc.get("pk_end"), earthwork_allowed):
            fields = [row for row in pile_objects if _ranges_overlap(start, end, row.get("pk_start"), row.get("pk_end"))]
            if fields and not all(_pile_summary_ready(row) for row in fields):
                continue
            has_work = _range_intersects_ranges(start, end, work_ranges)
            out.append({
                "pk_start": start,
                "pk_end": end,
                "label": "РД + сваи готовы + работы идут" if has_work else "РД + сваи готовы + работ нет",
                "fill": "#facc15" if has_work else "#ef4444",
                "stroke": "#ca8a04" if has_work else "#b91c1c",
            })
    return out


def _pk_ticks(start: float, end: float) -> list[tuple[float, bool]]:
    pk_start = int(start // 100)
    pk_end = int(end // 100)
    count = max(0, pk_end - pk_start + 1)
    if count <= 0:
        return []
    step = 1
    for candidate in (1, 2, 5, 10, 20, 50):
        if (count + candidate - 1) // candidate <= 15:
            step = candidate
            break
    return [(pk * 100.0, pk % step == 0) for pk in range(pk_start, pk_end + 1)]


def _text(
    ax: Any,
    x: float,
    y: float,
    text: Any,
    size: float = 8,
    *,
    color: str = "#111827",
    weight: str = "normal",
    ha: str = "left",
    va: str = "center",
    mono: bool = False,
    wrap: int | None = None,
    **kwargs: Any,
) -> Any:
    content = str(text if text is not None else "")
    if wrap:
        content = "\n".join(textwrap.wrap(content, width=wrap, break_long_words=False))
    return ax.text(
        x,
        y,
        content,
        fontsize=size,
        color=color,
        fontweight=weight,
        ha=ha,
        va=va,
        fontfamily=MONO_FONT if mono else FONT,
        transform=ax.transAxes,
        **kwargs,
    )


def _rect(
    ax: Any,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill: str,
    edge: str = "#d1d5db",
    lw: float = 0.6,
    alpha: float = 1.0,
    hatch: str | None = None,
    ls: str = "solid",
) -> None:
    ax.add_patch(
        Rectangle(
            (x, y),
            max(w, 0.0001),
            max(h, 0.0001),
            transform=ax.transAxes,
            facecolor=fill,
            edgecolor=edge,
            linewidth=lw,
            alpha=alpha,
            hatch=hatch,
            linestyle=ls,
        )
    )


def _line(
    ax: Any,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    color: str = "#6b7280",
    lw: float = 0.8,
    ls: str = "solid",
    alpha: float = 1.0,
) -> None:
    ax.add_line(
        Line2D(
            [x1, x2],
            [y1, y2],
            transform=ax.transAxes,
            color=color,
            linewidth=lw,
            linestyle=ls,
            alpha=alpha,
            solid_capstyle="butt",
        )
    )


def _draw_page_frame(ax: Any) -> None:
    _rect(
        ax,
        PDF_FRAME_LEFT,
        PDF_FRAME_BOTTOM,
        PDF_FRAME_RIGHT - PDF_FRAME_LEFT,
        PDF_FRAME_TOP - PDF_FRAME_BOTTOM,
        fill="none",
        edge="#111827",
        lw=0.65,
    )


def _new_a3_figure() -> tuple[Any, Any]:
    """Create page coordinates that cover the physical sheet, without subplot margins."""
    fig = plt.figure(figsize=A3_LANDSCAPE)
    ax = fig.add_axes((0.0, 0.0, 1.0, 1.0))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    return fig, ax


def _object_meta(row: dict[str, Any]) -> dict[str, str]:
    return OBJECT_TYPE_META.get(str(row.get("object_type_code") or "").strip().upper(), {
        "symbol": "other",
        "label": str(row.get("object_type_name") or "Объект"),
        "color": "#6b7280",
        "fill": "#f3f4f6",
    })


def _object_render_priority(row: dict[str, Any]) -> int:
    code = str(row.get("object_type_code") or "").strip().upper()
    if code == "PILE_FIELD":
        return 0
    if code == "BRIDGE":
        return 1
    if code == "OVERPASS":
        return 2
    if code == "PIPE":
        return 3
    if code in {"INTERSECTION_FIN", "INTERSECTION_PROP", "RECONS_ROAD"}:
        return 4
    return 5


def _object_label(row: dict[str, Any], width: int = 18) -> str:
    meta = _object_meta(row)
    return _short(row.get("object_name") or row.get("object_type_name") or meta["label"], width)


def _object_callout_label(row: dict[str, Any], width: int = 42) -> str:
    text = re.sub(r"\s+", " ", str(row.get("object_name") or row.get("object_type_name") or _object_meta(row)["label"]).strip())
    code = str(row.get("object_type_code") or "").strip().upper()
    if code == "PILE_FIELD":
        match = re.search(r"(?:свайное\s+поле|^сп)\s*([0-9]+(?:[_-][0-9]+)?\s*[нНnN]?)", text, flags=re.I)
        number = (match.group(1) if match else re.sub(r"^свайное\s+поле\s*", "", text, flags=re.I)).replace(" ", "").replace("-", "_")
        text = f"СП {re.sub(r'[нn]$', 'Н', number, flags=re.I)}"
    elif code in {"PIPE", "BRIDGE", "OVERPASS"}:
        text = re.sub(r"\s*ПК\s*\d+.*$", "", text, flags=re.I).strip() or text
    if code != "PILE_FIELD" and not re.search(r"ПК\s*\d+", text, flags=re.I) and row.get("pk_start") is not None:
        text = f"{text} {_format_pk(round(_as_float(row.get('pk_start'))))}"
    return _short(text, width)


def _wrap_pdf_callout_label(value: Any, width: int = 20, max_lines: int = 2) -> list[str]:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if not text:
        return [""]
    lines = textwrap.wrap(text, width=width, break_long_words=True, break_on_hyphens=False) or [text]
    if len(lines) <= max_lines:
        return lines
    tail = " ".join(lines[max_lines - 1 :])
    return [*lines[: max_lines - 1], _short(tail, width)]


def _estimate_pdf_label_width(text: str, size: float, min_w: float = 0.026, max_w: float = 0.100) -> float:
    return min(max_w, max(min_w, len(str(text)) * size * 0.00115 + 0.014))


def _layout_pdf_callouts(
    items: list[dict[str, Any]],
    *,
    x_left: float,
    x_right: float,
    y_start: float,
    lane_step: float,
    lanes: int,
    size: float,
    max_w: float = 0.100,
) -> list[dict[str, Any]]:
    if not items or lanes <= 0:
        return []
    lane_rights = [x_left - 0.006 for _ in range(lanes)]
    out: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda row: _as_float(row.get("anchor_x"))):
        label = str(item.get("label") or "")
        lines = [str(line) for line in (item.get("lines") or [label])]
        width = _estimate_pdf_label_width(max(lines, key=len, default=label), size, max_w=max_w)
        anchor_x = max(x_left, min(_as_float(item.get("anchor_x")), x_right))
        candidate_x = max(x_left, min(anchor_x - width / 2, x_right - width))
        placed_x: float | None = None
        placed_lane: int | None = None
        for lane in range(lanes):
            shifted_x = max(candidate_x, lane_rights[lane] + 0.004)
            if shifted_x <= x_right - width:
                placed_x = shifted_x
                placed_lane = lane
                break
        if placed_x is None or placed_lane is None:
            continue
        x = max(x_left, min(placed_x, x_right - width))
        lane_rights[placed_lane] = x + width
        out.append({
            **item,
            "x": x,
            "y": y_start - placed_lane * lane_step,
            "w": width,
            "label": label,
            "lines": lines,
            "anchor_x": anchor_x,
        })
    return out


def _draw_pdf_callouts(
    ax: Any,
    callouts: list[dict[str, Any]],
    *,
    target_y: float,
    size: float,
    box_h: float,
) -> None:
    for callout in callouts:
        color = str(callout.get("color") or "#64748b")
        text_color = str(callout.get("text_color") or color)
        x = _as_float(callout.get("x"))
        y = _as_float(callout.get("y"))
        w = _as_float(callout.get("w"))
        anchor_x = _as_float(callout.get("anchor_x"))
        lines = [str(line) for line in (callout.get("lines") or [callout.get("label") or ""])]
        local_box_h = _as_float(callout.get("box_h"), box_h * (1.65 if len(lines) > 1 else 1.0))
        local_target_y = _as_float(callout.get("target_y"), target_y)
        elbow_y = y - local_box_h / 2
        _line(ax, anchor_x, local_target_y, anchor_x, elbow_y, color=color, lw=0.35, alpha=0.72)
        _line(ax, anchor_x, elbow_y, x + w / 2, elbow_y, color=color, lw=0.35, alpha=0.72)
        _rect(ax, x, y - local_box_h / 2, w, local_box_h, fill="#ffffff", edge=color, lw=0.35)
        line_step = 0.0052
        text_y = y + (len(lines) - 1) * line_step / 2
        for line_index, line in enumerate(lines):
            _text(ax, x + w / 2, text_y - line_index * line_step, line, size, color=text_color, ha="center")


def _draw_object_symbol(
    ax: Any,
    row: dict[str, Any],
    x: float,
    y: float,
    w: float,
    h: float,
) -> None:
    meta = _object_meta(row)
    symbol = meta["symbol"]
    color = meta["color"]
    fill = meta["fill"]
    cx = x + w / 2
    top = y + h * 0.80
    mid = y + h / 2
    bottom = y + h * 0.20
    min_w = min(max(w, 0.00001), 0.022)
    px = cx - min_w / 2

    if symbol == "pile_field":
        _line(ax, x, y + h * 0.28, x, y + h * 0.72, color=color, lw=0.75)
        _line(ax, x + w, y + h * 0.28, x + w, y + h * 0.72, color=color, lw=0.75)
        for line_y in (y + h * 0.28, y + h * 0.72):
            _line(ax, x, line_y, x + w * 0.28, line_y, color=color, lw=0.70)
            _line(ax, x + w * 0.38, line_y, x + w * 0.62, line_y, color=color, lw=0.70)
            _line(ax, x + w * 0.72, line_y, x + w, line_y, color=color, lw=0.70)
        _line(ax, x, y + h * 0.50, x + w, y + h * 0.50, color=color, lw=0.80)
    elif symbol == "bridge":
        _line(ax, x, top, x + w, top, color=color, lw=1.4)
        _line(ax, x, bottom, x + w, bottom, color=color, lw=1.4)
        whisker = min(w * 0.10, 0.010)
        _line(ax, x, top, x + whisker, y + h * 0.92, color=color, lw=1.0)
        _line(ax, x, bottom, x + whisker, y + h * 0.08, color=color, lw=1.0)
        _line(ax, x + w, top, x + w - whisker, y + h * 0.92, color=color, lw=1.0)
        _line(ax, x + w, bottom, x + w - whisker, y + h * 0.08, color=color, lw=1.0)
    elif symbol == "overpass":
        min_w *= 0.50
        px = cx - min_w / 2
        _line(ax, cx, y + h * 0.04, cx, y + h * 0.96, color=color, lw=1.2)
        _line(ax, px, y + h * 0.18, cx, y + h * 0.04, color=color, lw=1.0)
        _line(ax, px + min_w, y + h * 0.18, cx, y + h * 0.04, color=color, lw=1.0)
        _line(ax, px, y + h * 0.82, cx, y + h * 0.96, color=color, lw=1.0)
        _line(ax, px + min_w, y + h * 0.82, cx, y + h * 0.96, color=color, lw=1.0)
    elif symbol == "pipe":
        min_w *= 0.50
        px = cx - min_w / 2
        _line(ax, cx, y + h * 0.04, cx, y + h * 0.96, color=color, lw=1.2)
        _line(ax, cx, y + h * 0.04, px, y + h * 0.20, color=color, lw=1.0)
        _line(ax, cx, y + h * 0.04, px + min_w, y + h * 0.20, color=color, lw=1.0)
        _line(ax, cx, y + h * 0.96, px, y + h * 0.80, color=color, lw=1.0)
        _line(ax, cx, y + h * 0.96, px + min_w, y + h * 0.80, color=color, lw=1.0)
    elif symbol in {"intersection_fin", "intersection_prop"}:
        dash = (0, (4, 3)) if symbol == "intersection_prop" else "solid"
        _line(ax, cx, y + h * 0.04, cx, y + h * 0.38, color=color, lw=1.25, ls=dash)
        _line(ax, cx, y + h * 0.62, cx, y + h * 0.96, color=color, lw=1.25, ls=dash)
        _text(ax, cx, mid, "N", 7.2, color=color, ha="center", mono=True, weight="bold")
    else:
        _rect(ax, x, y + h * 0.20, w, h * 0.60, fill=fill, edge=color, lw=0.8)


def _collect_object_counts(section: dict[str, Any]) -> dict[str, int]:
    counts = {key: 0 for key, _ in OBJECT_LANES}
    for row in section.get("related_objects") or []:
        group = str(row.get("object_group") or "other")
        if group in counts:
            counts[group] += 1
    return counts


def _section_summary(payload: dict[str, Any]) -> dict[str, Any]:
    sections = payload.get("sections") or []
    objects = sum(len(section.get("related_objects") or []) for section in sections)
    docs = sum(len(section.get("rd_documents") or []) for section in sections)
    schedules = sum(len(section.get("schedule_rows") or []) for section in sections)
    return {
        "sections": len(sections),
        "objects": objects,
        "rd_documents": docs,
        "schedule_rows": schedules,
    }


def _status_totals(section: dict[str, Any], allowed: list[tuple[float, float]]) -> dict[str, float]:
    totals = {key: 0.0 for key, *_ in STATUS_META}
    covered: list[tuple[float, float]] = []
    for segment in section.get("segments") or []:
        status = str(segment.get("status_type") or "")
        ranges = _clip_to_ranges(segment.get("pk_start"), segment.get("pk_end"), allowed)
        if status in totals:
            totals[status] += sum(max(0.0, b - a) for a, b in ranges)
        covered.extend(ranges)
    totals["no_work"] = sum(max(0.0, b - a) for a, b in _subtract_ranges(allowed, covered))
    return totals


def _draw_header(
    ax: Any,
    section: dict[str, Any],
    report_date: date,
    page_no: int,
    page_count: int,
    axis_start: float,
    axis_end: float,
) -> None:
    section_code = str(section.get("section_code") or "")
    section_name = str(section.get("section_name") or section_code)
    title = str(section.get("page_title") or f"Структурная схема ОХ. 3 этап. Участок {_section_num(section_code)}")
    range_label = str(section.get("segment_label") or _format_pk_range(axis_start, axis_end))
    _text(ax, 0.035, 0.965, title, 15, weight="bold")
    _text(ax, 0.035, 0.939, _short(section_name, 120), 8.5, color="#4b5563")
    _text(ax, 0.035, 0.917, f"Срез на {_date_label(report_date)} · {range_label}", 8, color="#4b5563", mono=True)
    _text(ax, 0.966, 0.965, f"{page_no}/{page_count}", 8, color="#6b7280", ha="right", mono=True)

    x = 0.385
    y = 0.936
    for code in OBJECT_LEGEND_ORDER:
        meta = OBJECT_TYPE_META[code]
        _draw_object_symbol(ax, {"object_type_code": code}, x, y - 0.010, 0.024, 0.021)
        _text(ax, x + 0.030, y, meta["label"], 6.4, color="#374151")
        x += 0.118 if code not in {"INTERSECTION_FIN", "PIPE"} else 0.135

    rd_x = 0.385
    rd_y = 0.908
    for status in ("issued", "ready_work", "ready_idle"):
        _rect(ax, rd_x, rd_y - 0.006, 0.018, 0.012, fill=RD_COLOR[status], edge=RD_COLOR[status], lw=0.5)
        _text(ax, rd_x + 0.025, rd_y, RD_LABEL[status], 6.4, color="#4b5563")
        rd_x += 0.165 if status == "issued" else 0.230


def _draw_axis_grid(
    ax: Any,
    x_left: float,
    x_right: float,
    axis_start: float,
    axis_end: float,
    rows: list[tuple[float, float]],
) -> Any:
    span = max(1.0, axis_end - axis_start)

    def x_of(value: Any) -> float:
        return x_left + ((_as_float(value) - axis_start) / span) * (x_right - x_left)

    for pk, labelled in _pk_ticks(axis_start, axis_end):
        x = x_of(pk)
        _line(ax, x, PDF_AXIS_Y, x, PDF_GRID_TOP, color="#e5e7eb", lw=0.35, ls=(0, (2, 3)) if labelled else "solid", alpha=0.95)
        if labelled:
            _text(ax, x, PDF_AXIS_Y - 0.018, f"ПК{int(pk // 100)}", 6.5, color="#6b7280", ha="center", mono=True)
    for start, end in rows:
        _rect(ax, x_of(start), PDF_AXIS_Y + 0.006, max(0.001, x_of(end) - x_of(start)), PDF_GRID_TOP - PDF_AXIS_Y - 0.012, fill="#f8fafc", edge="#e5e7eb", lw=0.2, alpha=0.35)
    _line(ax, x_left, PDF_AXIS_Y, x_right, PDF_AXIS_Y, color="#9ca3af", lw=0.65)
    _text(ax, x_left, PDF_AXIS_Y - 0.040, _format_pk(axis_start), 7, color="#374151", ha="left", mono=True)
    _text(ax, x_right, PDF_AXIS_Y - 0.040, _format_pk(axis_end), 7, color="#374151", ha="right", mono=True)
    return x_of


def _draw_object_overlays(
    ax: Any,
    section: dict[str, Any],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
) -> None:
    y = PDF_STATUS_BLOCK_BOTTOM
    h = PDF_STATUS_BLOCK_TOP - PDF_STATUS_BLOCK_BOTTOM
    objects = sorted(
        section.get("related_objects") or [],
        key=lambda row: (
            OBJECT_GROUP_ORDER.get(str(row.get("object_group") or ""), 99),
            _as_float(row.get("pk_start")),
            _object_label(row, 80),
        ),
    )
    for index, row in enumerate(objects):
        meta = _object_meta(row)
        symbol = meta["symbol"]
        color = meta["color"]
        fill = meta["fill"]
        ranges = _clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed)
        if not ranges:
            continue
        for start, end in ranges:
            point = abs(end - start) < 0.01
            x1 = x_of(start)
            x2 = x_of(end if not point else start)
            width = max(0.006 if point else 0.004, x2 - x1)
            if point:
                x1 -= width / 2
            x1 = max(x_left, min(x1, x_right - width))
            cx = x1 + width / 2
            label_text = _object_label(row, 18)

            if symbol == "pile_field":
                _rect(ax, x1, y, width, h, fill=fill, edge=color, lw=1.0, alpha=0.28)
                _line(ax, x1, y + 0.018, x1 + width, y + 0.018, color=color, lw=0.9, alpha=0.85)
                _line(ax, x1, y + h - 0.018, x1 + width, y + h - 0.018, color=color, lw=0.9, alpha=0.85)
                if width > 0.050:
                    _text(ax, x1 + width / 2, y + h / 2, label_text, 5.6, color=color, ha="center", mono=True)
            elif symbol in {"bridge", "overpass"}:
                _rect(ax, x1, y - 0.002, width, h + 0.004, fill="#ffffff", edge=color, lw=1.25, alpha=0.96)
                _line(ax, x1 + 0.004, y + 0.024, x1 + width - 0.004, y + 0.024, color=color, lw=1.0)
                _line(ax, x1 + 0.004, y + h - 0.024, x1 + width - 0.004, y + h - 0.024, color=color, lw=1.0)
                if symbol == "overpass":
                    _line(ax, cx, y + 0.010, cx, y + h - 0.010, color=color, lw=0.8, ls=(0, (4, 3)))
                if width > 0.048:
                    _text(ax, x1 + width / 2, y + h / 2, label_text, 5.4, color=color, ha="center", mono=True)
            elif symbol == "pipe":
                marker_w = 0.008
                lx = max(x_left, min(cx - marker_w / 2, x_right - marker_w))
                _rect(ax, lx, y - 0.002, marker_w, h + 0.004, fill=fill, edge=color, lw=1.0, alpha=0.88)
                _line(ax, cx, y + 0.010, cx, y + h - 0.010, color=color, lw=0.85)
            elif symbol in {"intersection_fin", "intersection_prop"}:
                dash = (0, (4, 3)) if symbol == "intersection_prop" else "solid"
                _line(ax, cx, y - 0.003, cx, y + h + 0.003, color=color, lw=1.4, ls=dash)
                _line(ax, cx - 0.010, y + h * 0.30, cx + 0.010, y + h * 0.30, color=color, lw=0.9, ls=dash)
                _line(ax, cx - 0.010, y + h * 0.70, cx + 0.010, y + h * 0.70, color=color, lw=0.9, ls=dash)
            else:
                _rect(ax, x1, y, width, h, fill=fill, edge=color, lw=0.8, alpha=0.24)

            if symbol in {"pipe", "intersection_fin", "intersection_prop"} and index < 18:
                label_y = y + h + 0.010 + (index % 2) * 0.010
                if label_y < PDF_RD_Y - 0.010:
                    _text(ax, cx, label_y, label_text, 4.7, color=color, ha="center", mono=True)


def _draw_bar_lane(
    ax: Any,
    *,
    label: str,
    y: float,
    h: float,
    rows: list[dict[str, Any]],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
    fill: str,
    stroke: str,
    empty_text: str,
    label_getter: Any,
) -> None:
    _text(ax, x_left - 0.006, y + h / 2, label, 7, color="#374151", ha="right")
    for start, end in allowed:
        _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), h, fill="#ffffff", edge="#d1d5db", lw=0.45)
    visible = 0
    for row in rows[:80]:
        for start, end in _clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed):
            visible += 1
            point = abs(end - start) < 0.01
            x1 = x_of(start)
            x2 = x_of(end if not point else start)
            w = max(0.006 if point else 0.004, x2 - x1)
            if point:
                x1 -= w / 2
            x1 = max(x_left, min(x1, x_right - w))
            row_fill = str(row.get("fill") or fill)
            row_stroke = str(row.get("stroke") or stroke)
            _rect(ax, x1, y + 0.004, w, h - 0.008, fill=row_fill, edge=row_stroke, lw=0.75)
            if w > 0.030:
                _text(ax, x1 + w / 2, y + h / 2, label_getter(row), 5.5, color=row_stroke, ha="center")
    if not visible:
        _text(ax, x_left + 0.006, y + h / 2, empty_text, 6.7, color="#9ca3af")


def _compact_fact_rows(section: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    seen: set[tuple[str, str, str, str]] = set()
    for row in sorted(section.get("segment_days") or [], key=lambda item: str(item.get("date") or ""), reverse=True):
        key = (
            str(row.get("date") or ""),
            str(row.get("status_type") or ""),
            f"{_as_float(row.get('pk_start')):.2f}",
            f"{_as_float(row.get('pk_end')):.2f}",
        )
        if key in seen:
            continue
        seen.add(key)
        rows.append(row)
    return rows[:48]


def _draw_status_tracks(
    ax: Any,
    section: dict[str, Any],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
) -> None:
    y_top = PDF_STATUS_FIRST_Y
    track_h = PDF_STATUS_TRACK_H
    gap = PDF_STATUS_GAP
    covered: list[tuple[float, float]] = []
    segments_by_status: dict[str, list[tuple[float, float]]] = {key: [] for key, *_ in STATUS_META}
    for segment in section.get("segments") or []:
        status = str(segment.get("status_type") or "")
        ranges = _clip_to_ranges(segment.get("pk_start"), segment.get("pk_end"), allowed)
        covered.extend(ranges)
        if status in segments_by_status:
            segments_by_status[status].extend(ranges)
    segments_by_status["no_work"] = _subtract_ranges(allowed, covered)

    for idx, (status, label, fill, stroke) in enumerate(STATUS_META):
        y = y_top - idx * (track_h + gap)
        _text(ax, x_left - 0.006, y + track_h / 2, label, 7, color="#374151", ha="right")
        for start, end in allowed:
            _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), track_h, fill="#ffffff", edge="#d1d5db", lw=0.45)
        for start, end in _merge_ranges(segments_by_status.get(status) or []):
            x1, x2 = x_of(start), x_of(end)
            _rect(
                ax,
                x1,
                y + 0.004,
                max(0.001, x2 - x1),
                track_h - 0.008,
                fill=fill,
                edge=stroke,
                lw=0.65,
                hatch="////" if status == "no_work" else None,
                alpha=0.95,
            )


def _draw_bottom_tables(
    ax: Any,
    section: dict[str, Any],
    allowed: list[tuple[float, float]],
    totals: dict[str, float],
) -> None:
    y = 0.174
    _rect(ax, 0.035, 0.036, 0.930, 0.145, fill="#ffffff", edge="#d1d5db", lw=0.55)
    _text(ax, 0.047, y, "Итог по участку", 8.2, weight="bold")
    length = sum(max(0.0, end - start) for start, end in allowed)
    _text(ax, 0.047, y - 0.022, f"Длина: {_fnum(length)} м", 7, color="#374151")

    x = 0.047
    y2 = 0.117
    for status, label, fill, stroke in STATUS_META:
        value = totals.get(status, 0.0)
        _rect(ax, x, y2 - 0.008, 0.012, 0.012, fill=fill, edge=stroke, lw=0.45, hatch="////" if status == "no_work" else None)
        _text(ax, x + 0.016, y2, f"{label}: {_fnum(value)} м", 6.3, color="#374151")
        x += 0.130
        if x > 0.820:
            x = 0.047
            y2 -= 0.021

    work_totals = [row for row in section.get("work_totals") or [] if _as_float(row.get("volume_m3"))]
    x = 0.047
    y3 = 0.064
    if work_totals:
        for row in work_totals[:5]:
            _text(ax, x, y3, f"{row.get('label')}: {_fnum(row.get('volume_m3'))} м³", 6.4, color="#374151")
            x += 0.130
    else:
        _text(ax, x, y3, "Объемы работ по ОХ не найдены", 6.4, color="#9ca3af")

    counts = _collect_object_counts(section)
    rd = section.get("rd_summary") or {}
    _text(ax, 0.650, y, "Объекты / РД / даты", 8.2, weight="bold")
    object_text = " · ".join(f"{label}: {counts.get(group, 0)}" for group, label in OBJECT_LANES)
    _text(ax, 0.650, y - 0.022, object_text, 6.3, color="#374151", wrap=62)
    _text(
        ax,
        0.650,
        0.092,
        f"РД: есть {int(rd.get('issued') or 0)}, частично {int(rd.get('partial') or 0)}, нет {int(rd.get('missing') or 0)}",
        6.4,
        color="#374151",
    )
    schedule_rows = section.get("schedule_rows") or []
    if schedule_rows:
        row = schedule_rows[0]
        _text(
            ax,
            0.650,
            0.065,
            f"Ближайшее окно: {_format_pk_range(row.get('pk_start'), row.get('pk_end'))}, {_date_label(row.get('required_start_date'))}-{_date_label(row.get('required_finish_date'))}",
            6.2,
            color="#374151",
            wrap=70,
        )
    else:
        _text(ax, 0.650, 0.065, "Плановые даты: нет загруженных диапазонов", 6.2, color="#9ca3af")


def _draw_panel_axis_grid(
    ax: Any,
    x_left: float,
    x_right: float,
    axis_start: float,
    axis_end: float,
    grid_top: float,
    axis_y: float,
    rows: list[tuple[float, float]],
    *,
    draw_grid: bool = True,
) -> Any:
    span = max(1.0, axis_end - axis_start)

    def x_of(value: Any) -> float:
        return x_left + ((_as_float(value) - axis_start) / span) * (x_right - x_left)

    if draw_grid:
        for start, end in rows:
            _rect(
                ax,
                x_of(start),
                axis_y + 0.004,
                max(0.001, x_of(end) - x_of(start)),
                grid_top - axis_y - 0.008,
                fill="#f8fafc",
                edge="#e5e7eb",
                lw=0.2,
                alpha=0.34,
            )
    for pk, labelled in _pk_ticks(axis_start, axis_end):
        x = x_of(pk)
        if draw_grid:
            _line(ax, x, axis_y, x, grid_top, color="#e5e7eb", lw=0.28, ls=(0, (2, 3)) if labelled else "solid", alpha=0.95)
        elif labelled:
            _line(ax, x, axis_y, x, axis_y + 0.006, color="#9ca3af", lw=0.35)
        if labelled:
            _text(ax, x, axis_y - 0.012, f"ПК{int(pk // 100)}", 5.2, color="#6b7280", ha="center", mono=True)
    _line(ax, x_left, axis_y, x_right, axis_y, color="#9ca3af", lw=0.55)
    _text(ax, x_left, axis_y - 0.030, _format_pk(axis_start), 5.7, color="#374151", ha="left", mono=True)
    _text(ax, x_right, axis_y - 0.030, _format_pk(axis_end), 5.7, color="#374151", ha="right", mono=True)
    return x_of


def _draw_panel_status_tracks(
    ax: Any,
    section: dict[str, Any],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
    y_top: float,
    track_h: float,
    gap: float,
) -> None:
    covered: list[tuple[float, float]] = []
    segments_by_status: dict[str, list[tuple[float, float]]] = {key: [] for key, *_ in STATUS_META}
    for segment in section.get("segments") or []:
        status = str(segment.get("status_type") or "")
        ranges = _clip_to_ranges(segment.get("pk_start"), segment.get("pk_end"), allowed)
        covered.extend(ranges)
        if status in segments_by_status:
            segments_by_status[status].extend(ranges)
    segments_by_status["no_work"] = _subtract_ranges(allowed, covered)

    for idx, (status, label, fill, stroke) in enumerate(STATUS_META):
        y = y_top - idx * (track_h + gap)
        _text(ax, x_left - 0.006, y + track_h / 2, label, 5.5, color="#374151", ha="right")
        for start, end in allowed:
            _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), track_h, fill="#ffffff", edge="#d1d5db", lw=0.35)
        for start, end in _merge_ranges(segments_by_status.get(status) or []):
            _rect(
                ax,
                x_of(start),
                y + 0.002,
                max(0.001, x_of(end) - x_of(start)),
                track_h - 0.004,
                fill=fill,
                edge=stroke,
                lw=0.45,
                hatch="////" if status == "no_work" else None,
                alpha=0.95,
            )


def _draw_panel_bar_lane(
    ax: Any,
    *,
    label: str,
    y: float,
    h: float,
    rows: list[dict[str, Any]],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
    fill: str,
    stroke: str,
    empty_text: str,
    label_getter: Any,
    callout_y_start: float | None = None,
    callout_lanes: int = 0,
) -> None:
    _text(ax, x_left - 0.006, y + h / 2, label, 5.5, color="#374151", ha="right")
    for start, end in allowed:
        _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), h, fill="#ffffff", edge="#d1d5db", lw=0.35)
    visible = 0
    callout_items: list[dict[str, Any]] = []
    for row in rows[:90]:
        for start, end in _clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed):
            visible += 1
            point = abs(end - start) < 0.01
            x1 = x_of(start)
            x2 = x_of(end if not point else start)
            w = max(0.005 if point else 0.003, x2 - x1)
            if point:
                x1 -= w / 2
            x1 = max(x_left, min(x1, x_right - w))
            row_fill = str(row.get("fill") or fill)
            row_stroke = str(row.get("stroke") or stroke)
            _rect(ax, x1, y + 0.002, w, h - 0.004, fill=row_fill, edge=row_stroke, lw=0.45)
            if w > 0.042:
                _text(ax, x1 + w / 2, y + h / 2, label_getter(row), 4.8, color=row_stroke, ha="center")
            elif callout_y_start is not None and callout_lanes > 0:
                callout_items.append({
                    "label": label_getter(row),
                    "anchor_x": x1 + w / 2,
                    "color": row_stroke,
                    "text_color": row_stroke,
                })
    if not visible:
        _text(ax, x_left + 0.004, y + h / 2, empty_text, 5.3, color="#9ca3af")
    if callout_items:
        _draw_pdf_callouts(
            ax,
            _layout_pdf_callouts(
                callout_items,
                x_left=x_left,
                x_right=x_right,
                y_start=callout_y_start,
                lane_step=0.009,
                lanes=callout_lanes,
                size=4.1,
                max_w=0.086,
            ),
            target_y=y + h,
            size=4.1,
            box_h=0.0075,
        )


def _schedule_direction_forward(row: dict[str, Any]) -> bool:
    direction = str(row.get("work_direction") or "").lower()
    if "от большего" in direction:
        return False
    if "от меньшего" in direction:
        return True
    start = str(row.get("required_start_date") or "")
    finish = str(row.get("required_finish_date") or "")
    if start and finish:
        return start <= finish
    return True


def _draw_panel_direction_lane(
    ax: Any,
    *,
    y: float,
    h: float,
    rows: list[dict[str, Any]],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
) -> None:
    _text(ax, x_left - 0.006, y + h / 2, "Направление\nработ", 4.4, color="#374151", ha="right")
    for start, end in allowed:
        _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), h, fill="#ffffff", edge="#d1d5db", lw=0.35)
    visible = 0
    for row in rows[:90]:
        for start, end in _clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed):
            visible += 1
            x1 = max(x_left, min(x_of(start), x_right))
            x2 = max(x_left, min(x_of(end), x_right))
            if x2 < x1:
                x1, x2 = x2, x1
            width = x2 - x1
            if width <= 0.004:
                continue
            _rect(ax, x1, y + 0.002, max(0.001, width), h - 0.004, fill="#ffffff", edge="#64748b", lw=0.30)
            pad = min(max(width * 0.10, 0.004), 0.018)
            start_x = x1 + pad
            end_x = x2 - pad
            if end_x <= start_x:
                continue
            if not _schedule_direction_forward(row):
                start_x, end_x = end_x, start_x
            ax.annotate(
                "",
                xy=(end_x, y + h / 2),
                xytext=(start_x, y + h / 2),
                xycoords=ax.transAxes,
                textcoords=ax.transAxes,
                arrowprops={"arrowstyle": "->", "linewidth": 0.55, "color": "#111827", "shrinkA": 0, "shrinkB": 0},
            )
    if not visible:
        _text(ax, x_left + 0.004, y + h / 2, "Направление работ не загружено", 5.3, color="#9ca3af")


def _draw_panel_situation_row(
    ax: Any,
    section: dict[str, Any],
    allowed: list[tuple[float, float]],
    x_of: Any,
    x_left: float,
    x_right: float,
    y: float,
    h: float,
    callout_y_start: float,
) -> None:
    for start, end in allowed:
        _rect(ax, x_of(start), y, max(0.001, x_of(end) - x_of(start)), h, fill="#ffffff", edge="#d1d5db", lw=0.35)
    objects = sorted(
        section.get("related_objects") or [],
        key=lambda row: (_as_float(row.get("pk_start")), _as_float(row.get("pk_end")), _object_label(row, 80)),
    )[:160]
    markers: list[dict[str, Any]] = []
    for row in objects:
        for start, end in _clip_to_ranges(row.get("pk_start"), row.get("pk_end"), allowed):
            point = abs(end - start) < 0.01
            raw_x1 = x_of(start)
            raw_x2 = x_of(end if not point else start)
            markers.append({
                "row": row,
                "start": start,
                "end": end,
                "point": point,
                "x_start": raw_x1,
                "x_end": raw_x2,
                "anchor_x": (raw_x1 + raw_x2) / 2,
            })
    if not markers:
        _text(ax, x_left + 0.004, y + h / 2, "Объекты в границах сегмента не найдены", 5.3, color="#9ca3af")
        return

    for marker in markers:
        if marker["point"]:
            anchor_x = marker["anchor_x"]
            nearest_gap = min(anchor_x - x_left, x_right - anchor_x)
            for other in markers:
                if other is marker or _ranges_overlap(marker["start"], marker["end"], other["start"], other["end"]):
                    continue
                if other["end"] < marker["start"]:
                    nearest_gap = min(nearest_gap, max(0.0, anchor_x - other["x_end"]))
                elif other["start"] > marker["end"]:
                    nearest_gap = min(nearest_gap, max(0.0, other["x_start"] - anchor_x))
            marker["w"] = max(0.00001, min(0.0038, nearest_gap * 0.72))
            marker["x"] = anchor_x - marker["w"] / 2
        else:
            marker["x"] = marker["x_start"]
            marker["w"] = max(0.00001, marker["x_end"] - marker["x_start"])

    markers.sort(key=lambda marker: (
        bool(marker["point"]),
        _object_render_priority(marker["row"]),
        marker["anchor_x"],
    ))
    marker_y = y + 0.002
    marker_h = h - 0.004
    callout_items: list[dict[str, Any]] = []
    for marker in markers:
        row = marker["row"]
        x1 = marker["x"]
        w = marker["w"]
        meta = _object_meta(row)
        symbol = meta["symbol"]
        if symbol in {"bridge", "overpass"}:
            _rect(ax, x1, marker_y, w, marker_h, fill="#ffffff", edge=meta["color"], lw=0.25, alpha=0.38)
        elif symbol == "pipe":
            _rect(ax, x1, marker_y, w, marker_h, fill=meta["fill"], edge=meta["fill"], lw=0.0, alpha=0.54)
        _draw_object_symbol(ax, row, x1, marker_y, w, marker_h)
        if str(row.get("object_type_code") or "").strip().upper() in {"BRIDGE", "OVERPASS", "PIPE"}:
            label = _object_callout_label(row, 42)
            callout_items.append({
                "label": label,
                "lines": _wrap_pdf_callout_label(label, width=19, max_lines=2),
                "anchor_x": marker["anchor_x"],
                "target_y": marker_y + marker_h,
                "color": meta["color"],
                "text_color": meta.get("color", "#374151"),
            })
    if callout_items:
        _draw_pdf_callouts(
            ax,
            _layout_pdf_callouts(
                callout_items[:90],
                x_left=x_left,
                x_right=x_right,
                y_start=callout_y_start,
                lane_step=-PDF_PANEL_CALLOUT_STEP,
                lanes=PDF_PANEL_CALLOUT_LANES,
                size=3.5,
                max_w=0.074,
            ),
            target_y=y + h,
            size=3.5,
            box_h=PDF_PANEL_CALLOUT_H,
        )


def _draw_panel_section_boundaries(
    ax: Any,
    section: dict[str, Any],
    x_of: Any,
    x_left: float,
    x_right: float,
    y_top: float,
    y_bottom: float,
    label_y: float,
) -> None:
    rows = sorted(
        section.get("section_boundaries") or [],
        key=lambda row: (_as_float(row.get("pk_start")), _section_num(row.get("section_code"))),
    )
    if not rows:
        return
    edge_positions: dict[str, float] = {}
    for row in rows:
        start = _as_float(row.get("pk_start"))
        end = _as_float(row.get("pk_end"))
        if end < start:
            start, end = end, start
        x1 = max(x_left, min(x_of(start), x_right))
        x2 = max(x_left, min(x_of(end), x_right))
        edge_positions[f"{start:.2f}"] = x1
        edge_positions[f"{end:.2f}"] = x2
        _line(ax, x1, y_top, x2, y_top, color="#111827", lw=0.55, alpha=0.90)
        _line(ax, x1, y_top - 0.004, x1, y_top + 0.004, color="#111827", lw=0.55, alpha=0.90)
        _line(ax, x2, y_top - 0.004, x2, y_top + 0.004, color="#111827", lw=0.55, alpha=0.90)
        section_number = _section_num(row.get("section_code"))
        width = x2 - x1
        if width >= 0.075:
            label = f"Участок №{section_number} · {_format_pk(start)}-{_format_pk(end)}"
            size = 3.8
        elif width >= 0.035:
            label = f"Участок №{section_number}"
            size = 4.0
        else:
            label = f"У{section_number}"
            size = 4.0
        _text(
            ax,
            (x1 + x2) / 2,
            label_y,
            label,
            size,
            color="#111827",
            ha="center",
            mono=True,
            bbox={"facecolor": "white", "edgecolor": "none", "pad": 0.8},
        )
    for x in edge_positions.values():
        _line(ax, x, y_bottom, x, y_top + 0.004, color="#111827", lw=0.52, ls=(0, (4, 2)), alpha=0.88)


def _panel_object_count_text(section: dict[str, Any]) -> str:
    counts = _collect_object_counts(section)
    pairs = [f"{label}: {counts.get(group, 0)}" for group, label in OBJECT_LANES if counts.get(group, 0)]
    return "; ".join(pairs) if pairs else "объектов нет"


def _panel_work_text(section: dict[str, Any]) -> str:
    work_totals = [row for row in section.get("work_totals") or [] if _as_float(row.get("volume_m3"))]
    if not work_totals:
        return "объемы работ не найдены"
    return "; ".join(f"{row.get('label')}: {_fnum(row.get('volume_m3'))} м³" for row in work_totals[:3])


def _draw_segment_panel(
    ax: Any,
    section: dict[str, Any],
    report_date: date,
    index: int,
    count: int,
    top_y: float,
) -> None:
    allowed = _section_ranges(section)
    if not allowed:
        return
    earthwork_allowed = _earthwork_ranges(section, allowed)
    axis_start = min(start for start, _ in allowed)
    axis_end = max(end for _, end in allowed)
    x_left = PDF_X_LEFT
    x_right = PDF_X_RIGHT
    row_h = PDF_PANEL_ROW_H
    situation_h = PDF_PANEL_SITUATION_H
    track_h = PDF_PANEL_TRACK_H
    gap = PDF_PANEL_GAP
    situation_y = top_y - PDF_PANEL_SITUATION_OFFSET
    status_first_y = situation_y - PDF_PANEL_STATUS_OFFSET
    last_status_y = status_first_y - (len(STATUS_META) - 1) * (track_h + gap)
    rd_y = last_status_y - PDF_PANEL_ROW_STEP
    pk_y = rd_y - PDF_PANEL_ROW_STEP
    direction_y = pk_y - 0.030
    date_y = direction_y - PDF_PANEL_ROW_STEP
    axis_y = date_y - PDF_PANEL_AXIS_OFFSET
    grid_top = situation_y + situation_h + 0.006

    x_of = _draw_panel_axis_grid(ax, x_left, x_right, axis_start, axis_end, grid_top, axis_y, allowed, draw_grid=False)
    _draw_panel_section_boundaries(ax, section, x_of, x_left, x_right, grid_top, axis_y, top_y - 0.004)
    _draw_panel_situation_row(
        ax,
        section,
        allowed,
        x_of,
        x_left,
        x_right,
        situation_y,
        situation_h,
        situation_y + situation_h + 0.008,
    )
    _draw_panel_status_tracks(ax, section, earthwork_allowed, x_of, x_left, x_right, status_first_y, track_h, gap)
    _draw_panel_bar_lane(
        ax,
        label="Наличие\nРД",
        y=rd_y,
        h=row_h,
        rows=[*(section.get("rd_documents") or []), *_readiness_rows(section, earthwork_allowed)],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#dcfce7",
        stroke="#15803d",
        empty_text="РД по ЗП не загружена",
        label_getter=lambda row: _short(row.get("label") or row.get("rd_title") or "РД выдана", 26),
    )
    _draw_panel_bar_lane(
        ax,
        label="ПК",
        y=pk_y,
        h=row_h,
        rows=section.get("schedule_rows") or [{"pk_start": start, "pk_end": end} for start, end in earthwork_allowed],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#f8fafc",
        stroke="#64748b",
        empty_text="Промежутки ЗП не найдены",
        label_getter=lambda row: _format_pk_range(row.get("pk_start"), row.get("pk_end")),
        callout_y_start=pk_y - 0.009,
        callout_lanes=1,
    )
    _draw_panel_direction_lane(
        ax,
        y=direction_y,
        h=row_h,
        rows=section.get("schedule_rows") or [],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
    )
    _draw_panel_bar_lane(
        ax,
        label="Даты",
        y=date_y,
        h=row_h,
        rows=section.get("schedule_rows") or [],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#ede9fe",
        stroke="#7c3aed",
        empty_text="Сроки работ не загружены",
        label_getter=lambda row: f"{_date_label(row.get('required_start_date'))}-{_date_label(row.get('required_finish_date'))}",
    )


def _draw_overview_header(ax: Any, report_date: date, pages: list[dict[str, Any]]) -> None:
    ranges = _merge_ranges(
        range_item
        for page in pages
        for range_item in _section_ranges(page)
    )
    range_label = _format_pk_range(min(start for start, _ in ranges), max(end for _, end in ranges)) if ranges else "ПК н/д"
    center_x = (PDF_FRAME_LEFT + PDF_FRAME_RIGHT) / 2
    _text(ax, center_x, 0.966, "Структурная схема устройства земляного полотна ОХ 3 этапа", 12.5, weight="bold", ha="center")
    _text(ax, center_x, 0.946, f"по состоянию на {_date_label(report_date)} · {range_label}", 7.2, color="#4b5563", ha="center")
    _text(ax, PDF_FRAME_RIGHT - 0.006, 0.966, "Лист 1/1", 6.5, color="#6b7280", ha="right", mono=True)

    x = PDF_X_LEFT
    y = 0.922
    for code in OBJECT_LEGEND_ORDER:
        meta = OBJECT_TYPE_META[code]
        _draw_object_symbol(ax, {"object_type_code": code}, x, y - 0.008, 0.018, 0.016)
        _text(ax, x + 0.022, y, meta["label"], 5.5, color="#374151")
        x += 0.112 if code not in {"INTERSECTION_FIN", "PIPE"} else 0.132

    rd_x = PDF_X_LEFT
    rd_y = 0.902
    for status in ("issued", "ready_work", "ready_idle"):
        _rect(ax, rd_x, rd_y - 0.004, 0.014, 0.008, fill=RD_COLOR[status], edge=RD_COLOR[status], lw=0.40)
        _text(ax, rd_x + 0.019, rd_y, RD_LABEL[status], 5.2, color="#4b5563")
        rd_x += 0.142 if status == "issued" else 0.205


def _render_stage_overview_page(pdf: PdfPages, pages: list[dict[str, Any]], report_date: date) -> None:
    fig, ax = _new_a3_figure()

    _draw_page_frame(ax)
    _draw_overview_header(ax, report_date, pages)
    for index, (section, top_y) in enumerate(zip(pages, PDF_PANEL_TOPS), start=1):
        _draw_segment_panel(ax, section, report_date, index, len(pages), top_y)

    pdf.savefig(fig)
    plt.close(fig)
    gc.collect()


def _range_length(ranges: list[tuple[float, float]]) -> float:
    return sum(max(0.0, end - start) for start, end in ranges)


def _intersect_range_sets(source: list[tuple[float, float]], allowed: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for start, end in source:
        out.extend(_clip_to_ranges(start, end, allowed))
    return _merge_ranges(out)


def _split_ranges_equal(ranges: list[tuple[float, float]], parts: int = 3) -> list[list[tuple[float, float]]]:
    merged = _merge_ranges(ranges)
    total = _range_length(merged)
    if total <= 0:
        return [merged] if merged else []
    result: list[list[tuple[float, float]]] = []
    for idx in range(parts):
        offset_start = total * idx / parts
        offset_end = total * (idx + 1) / parts
        cursor = 0.0
        segment_ranges: list[tuple[float, float]] = []
        for start, end in merged:
            length = max(0.0, end - start)
            cursor_end = cursor + length
            overlap_start = max(offset_start, cursor)
            overlap_end = min(offset_end, cursor_end)
            if overlap_end - overlap_start > 0.01:
                segment_ranges.append((start + (overlap_start - cursor), start + (overlap_end - cursor)))
            cursor = cursor_end
        if segment_ranges:
            result.append(_merge_ranges(segment_ranges))
    return result


def _clip_rows_to_ranges(rows: Iterable[dict[str, Any]], allowed: list[tuple[float, float]]) -> list[dict[str, Any]]:
    clipped_rows: list[dict[str, Any]] = []
    for row in rows:
        row_start = row.get("pk_start")
        row_end = row.get("pk_end")
        if row_start is None or row_end is None:
            continue
        for index, (start, end) in enumerate(_clip_to_ranges(row_start, row_end, allowed)):
            item = dict(row)
            item["pk_start"] = start
            item["pk_end"] = end
            if "object_pk_start" not in item:
                item["object_pk_start"] = row_start
            if "object_pk_end" not in item:
                item["object_pk_end"] = row_end
            item["clipped"] = bool(item.get("clipped")) or index > 0 or abs(_as_float(row_start) - start) > 0.01 or abs(_as_float(row_end) - end) > 0.01
            clipped_rows.append(item)
    return clipped_rows


def _dedupe_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for row in rows:
        key = (
            str(row.get("id") or row.get("object_id") or row.get("object_code") or row.get("label") or ""),
            f"{_as_float(row.get('pk_start')):.2f}",
            f"{_as_float(row.get('pk_end')):.2f}",
            str(row.get("status_type") or row.get("rd_code") or row.get("schedule_label") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _segment_work_totals(source_sections: list[dict[str, Any]], segment_ranges: list[tuple[float, float]]) -> list[dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for section in source_sections:
        section_ranges = _section_ranges(section)
        if not section_ranges:
            continue
        full_earthwork = _earthwork_ranges(section, section_ranges)
        visible_earthwork = _intersect_range_sets(full_earthwork, segment_ranges)
        full_length = _range_length(full_earthwork)
        if full_length <= 0:
            continue
        ratio = _range_length(visible_earthwork) / full_length
        if ratio <= 0:
            continue
        for row in section.get("work_totals") or []:
            key = str(row.get("key") or row.get("label") or "")
            if not key:
                continue
            target = totals.setdefault(key, {"key": key, "label": row.get("label") or key, "volume_m3": 0.0})
            target["volume_m3"] += _as_float(row.get("volume_m3")) * ratio
    return [
        {"key": row["key"], "label": row["label"], "volume_m3": row["volume_m3"]}
        for row in totals.values()
    ]


def _segment_page_from_sections(
    source_sections: list[dict[str, Any]],
    segment_ranges: list[tuple[float, float]],
    segment_index: int,
    segment_count: int,
) -> dict[str, Any]:
    source_codes = [str(section.get("section_code") or "") for section in source_sections if section.get("section_code")]
    section_numbers = sorted({_section_num(code) for code in source_codes if code})
    section_label = ", ".join(str(num) for num in section_numbers if num != 99) or ", ".join(source_codes)
    axis_start = min(start for start, _ in segment_ranges)
    axis_end = max(end for _, end in segment_ranges)
    page = {
        "section_code": f"STAGE_3_SEG_{segment_index}",
        "section_name": f"Участки {section_label}" if section_label else "3 этап",
        "page_title": f"Структурная схема ОХ. 3 этап. Сегмент {segment_index}/{segment_count}",
        "segment_label": _format_pk_range(axis_start, axis_end),
        "ranges": [{"pk_start": start, "pk_end": end} for start, end in segment_ranges],
        "segments": [],
        "related_objects": [],
        "rd_documents": [],
        "schedule_rows": [],
        "segment_days": [],
        "section_boundaries": [],
        "work_totals": _segment_work_totals(source_sections, segment_ranges),
        "rd_summary": {"issued": 0, "partial": 0, "missing": 0},
    }
    for section in source_sections:
        for start, end in _section_ranges(section):
            for clipped_start, clipped_end in _clip_to_ranges(start, end, segment_ranges):
                page["section_boundaries"].append({
                    "section_code": section.get("section_code"),
                    "section_name": section.get("section_name"),
                    "pk_start": clipped_start,
                    "pk_end": clipped_end,
                })
        page["segments"].extend(_clip_rows_to_ranges(section.get("segments") or [], segment_ranges))
        page["related_objects"].extend(_clip_rows_to_ranges(section.get("related_objects") or [], segment_ranges))
        page["rd_documents"].extend(_clip_rows_to_ranges(section.get("rd_documents") or [], segment_ranges))
        page["schedule_rows"].extend(_clip_rows_to_ranges(section.get("schedule_rows") or [], segment_ranges))
        page["segment_days"].extend(_clip_rows_to_ranges(section.get("segment_days") or [], segment_ranges))
    page["segments"] = sorted(_dedupe_rows(page["segments"]), key=lambda row: (row.get("pk_start") or 0, row.get("status_type") or ""))
    page["related_objects"] = sorted(
        _dedupe_rows(page["related_objects"]),
        key=lambda row: (
            OBJECT_GROUP_ORDER.get(str(row.get("object_group") or ""), 99),
            row.get("pk_start") or 0,
            _object_label(row, 80),
        ),
    )
    page["rd_documents"] = sorted(_dedupe_rows(page["rd_documents"]), key=lambda row: (row.get("pk_start") or 0, row.get("rd_title") or ""))
    page["schedule_rows"] = sorted(_dedupe_rows(page["schedule_rows"]), key=lambda row: (row.get("pk_start") or 0, str(row.get("required_start_date") or "")))
    page["segment_days"] = sorted(_dedupe_rows(page["segment_days"]), key=lambda row: (str(row.get("date") or ""), row.get("pk_start") or 0), reverse=True)
    boundary_seen: set[tuple[str, str, str]] = set()
    section_boundaries: list[dict[str, Any]] = []
    for row in sorted(page["section_boundaries"], key=lambda item: (_as_float(item.get("pk_start")), _section_num(item.get("section_code")))):
        key = (
            str(row.get("section_code") or ""),
            f"{_as_float(row.get('pk_start')):.2f}",
            f"{_as_float(row.get('pk_end')):.2f}",
        )
        if key in boundary_seen:
            continue
        boundary_seen.add(key)
        section_boundaries.append(row)
    page["section_boundaries"] = section_boundaries
    for obj in page["related_objects"]:
        status = obj.get("rd_status") or "missing"
        if status in page["rd_summary"]:
            page["rd_summary"][status] += 1
    return page


def _stage_segment_pages(sections: list[dict[str, Any]], parts: int = 3) -> list[dict[str, Any]]:
    active_sections = [section for section in sections if _section_ranges(section)]
    all_ranges = _merge_ranges(
        range_item
        for section in active_sections
        for range_item in _section_ranges(section)
    )
    split_ranges = _split_ranges_equal(all_ranges, parts=parts)
    pages: list[dict[str, Any]] = []
    for index, segment_ranges in enumerate(split_ranges, start=1):
        source_sections = [
            section for section in active_sections
            if _range_intersects_ranges(
                min(start for start, _ in segment_ranges),
                max(end for _, end in segment_ranges),
                _section_ranges(section),
            )
        ]
        pages.append(_segment_page_from_sections(source_sections, segment_ranges, index, len(split_ranges)))
    return pages


def _render_section_page(
    pdf: PdfPages,
    section: dict[str, Any],
    report_date: date,
    page_no: int,
    page_count: int,
) -> None:
    allowed = _section_ranges(section)
    if not allowed:
        return
    earthwork_allowed = _earthwork_ranges(section, allowed)
    axis_start = min(start for start, _ in allowed)
    axis_end = max(end for _, end in allowed)
    fig, ax = _new_a3_figure()

    x_left = PDF_X_LEFT
    x_right = PDF_X_RIGHT
    _draw_header(ax, section, report_date, page_no, page_count, axis_start, axis_end)
    x_of = _draw_axis_grid(ax, x_left, x_right, axis_start, axis_end, allowed)

    _draw_bar_lane(
        ax,
        label="РД",
        y=PDF_RD_Y,
        h=PDF_ROW_H,
        rows=[*(section.get("rd_documents") or []), *_readiness_rows(section, earthwork_allowed)],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#dcfce7",
        stroke="#15803d",
        empty_text="РД: нет загруженных диапазонов",
        label_getter=lambda row: _short(row.get("label") or row.get("rd_title") or "РД выдана", 22),
    )
    _draw_status_tracks(ax, section, earthwork_allowed, x_of, x_left, x_right)
    _draw_object_overlays(ax, section, allowed, x_of, x_left, x_right)
    _draw_bar_lane(
        ax,
        label="ПК промежутка",
        y=PDF_PK_ROW_Y,
        h=PDF_ROW_H,
        rows=section.get("schedule_rows") or [{"pk_start": start, "pk_end": end} for start, end in earthwork_allowed],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#f8fafc",
        stroke="#64748b",
        empty_text="Промежутки: нет активных диапазонов",
        label_getter=lambda row: _format_pk_range(row.get("pk_start"), row.get("pk_end")),
    )
    _draw_bar_lane(
        ax,
        label="Даты работ",
        y=PDF_DATE_ROW_Y,
        h=PDF_ROW_H,
        rows=section.get("schedule_rows") or [],
        allowed=earthwork_allowed,
        x_of=x_of,
        x_left=x_left,
        x_right=x_right,
        fill="#ede9fe",
        stroke="#7c3aed",
        empty_text="Даты: нет загруженных диапазонов",
        label_getter=lambda row: f"{_date_label(row.get('required_start_date'))}-{_date_label(row.get('required_finish_date'))}",
    )
    _draw_bottom_tables(ax, section, earthwork_allowed, _status_totals(section, earthwork_allowed))

    pdf.savefig(fig)
    plt.close(fig)
    gc.collect()


def generate_mainline_structural_scheme_pdf(payload: dict[str, Any], report_date: date) -> bytes:
    buffer = BytesIO()
    sections = sorted(payload.get("sections") or [], key=lambda row: (_section_num(row.get("section_code")), str(row.get("section_code") or "")))
    pages = _stage_segment_pages(sections, parts=3)
    with PdfPages(buffer) as pdf:
        if pages:
            _render_stage_overview_page(pdf, pages, report_date)
        else:
            fig, ax = _new_a3_figure()
            _draw_page_frame(ax)
            _text(ax, 0.5, 0.52, "Нет данных для схем ОХ", 16, ha="center", weight="bold")
            _text(ax, 0.5, 0.48, f"Срез на {_date_label(report_date)}", 9, ha="center", color="#6b7280")
            pdf.savefig(fig)
            plt.close(fig)
    return buffer.getvalue()


def write_mainline_structural_scheme_pdf(payload: dict[str, Any], report_date: date, output: Path) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(generate_mainline_structural_scheme_pdf(payload, report_date))
    meta = _section_summary(payload)
    meta.update({"output": str(output), "size_bytes": output.stat().st_size, "as_of": report_date.isoformat()})
    return meta


def load_payload_from_wip_routes(report_date: date, section_codes: list[str] | None = None) -> dict[str, Any]:
    import wip_routes  # Imported only in CLI/subprocess mode to avoid a renderer dependency cycle.

    payload = wip_routes.mainline_fill_status(report_date.isoformat())
    requested = {_norm_section(code) for code in (section_codes or []) if _norm_section(code)}
    filtered_sections = []
    for section in payload.get("sections") or []:
        code = _norm_section(section.get("section_code"))
        if requested and code not in requested:
            continue
        section["segment_days"] = []
        filtered_sections.append(section)
    payload["sections"] = filtered_sections
    return payload


def _parse_section_codes(value: str | None) -> list[str] | None:
    if not value:
        return None
    parts = [_norm_section(part) for part in re.split(r"[,;\s]+", value) if _norm_section(part)]
    return list(dict.fromkeys(parts)) or None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate mainline structural scheme PDF")
    parser.add_argument("--to", required=True, help="Report date, YYYY-MM-DD")
    parser.add_argument("--output", required=True, help="Output PDF path")
    parser.add_argument("--sections", default="", help="Comma-separated section codes, optional")
    parser.add_argument("--json-output", default="", help="Optional JSON metadata output path")
    args = parser.parse_args(argv)

    report_date = date.fromisoformat(args.to)
    section_codes = _parse_section_codes(args.sections)
    payload = load_payload_from_wip_routes(report_date, section_codes)
    meta = write_mainline_structural_scheme_pdf(payload, report_date, Path(args.output))
    if args.json_output:
        Path(args.json_output).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
