"""Quarry (daily) report PDF generator — A4 landscape, 1-2 pages.

Layout matches the daily quarry report tables: 8 sections x categories x subtotals.
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import psycopg2
import psycopg2.extras
from weasyprint import HTML

DB = dict(
    dbname=os.getenv('DB_NAME', 'works_db_v2'),
    user=os.getenv('DB_USER', 'works_user'),
    password=os.getenv('DB_PASSWORD', 'changeme'),
    host=os.getenv('DB_HOST', '127.0.0.1'),
    port=int(os.getenv('DB_PORT', '5433')),
)

SECTION_NUMS = [1, 2, 3, 4, 5, 6, 7, 8]
SECTION_DB_CODES = {
    1: ['UCH_1'],
    2: ['UCH_2'],
    3: ['UCH_31', 'UCH_32'],
    4: ['UCH_4'],
    5: ['UCH_5'],
    6: ['UCH_6'],
    7: ['UCH_7'],
    8: ['UCH_8'],
}

WORK_TYPE_CATEGORY = {
    'FIRST_PROTECTIVE_LAYER': 'prs',
    'SECOND_PROTECTIVE_LAYER': 'prs',
    'GEOTEXTILE_LAYER': 'prs',
    'GEOTEXTILE_LAYER_DO': 'prs',
    'SHOULDER_BACKFILL': 'prs',
    'SLOPE_FORMATION': 'prs',
    'AREA_GRADING': 'prs',
    'DITCH_CONSTRUCTION': 'prs',
    'PRS': 'prs',
    'EMBANKMENT_CONSTRUCTION': 'sand',
    'PAVEMENT_SANDING': 'sand',
    'WEAK_SOIL_REPLACEMENT': 'sand',
    'SAND_DELIVERY': 'sand',
    'EARTH_EXCAVATION': 'excavation',
    'PEAT_REMOVAL': 'excavation',
    'TOPSOIL_STRIPPING': 'excavation',
    'EXCAVATION_MAIN': 'excavation_oh',
    'CRUSHED_STONE_PLACEMENT': 'shps',
    'SHPGS_DELIVERY': 'shps',
    'TRANSPORT': 'transport',
}

CATEGORIES = [
    ('prs', 'ПРС'),
    ('sand', 'Песок'),
    ('excavation', 'Выемка'),
    ('excavation_oh', 'Выемка ОХ'),
    ('shps', 'ЩПС/ЩПГС'),
    ('transport', 'Перевозка'),
]


def _conn():
    return psycopg2.connect(**DB)


def _query(sql, params=None):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _fnum(v, decimals=1):
    if v is None or v == 0:
        return '0'
    v = float(v)
    s = f'{v:,.{decimals}f}' if decimals > 0 else f'{v:,.0f}'
    return s.replace(',', ' ')


def _db_code_to_sec_num(code):
    for num, codes in SECTION_DB_CODES.items():
        if code in codes:
            return num
    return None


def build_quarry_context(report_date: date) -> dict:
    """Build context for the quarry daily report PDF."""

    # ── Work items for the day ──
    day_work = _query("""
        SELECT cs.code AS sec_code, wt.code AS wt_code,
               dwi.shift,
               COALESCE(SUM(dwi.volume), 0) AS vol
        FROM daily_work_items dwi
        JOIN work_types wt ON wt.id = dwi.work_type_id
        LEFT JOIN construction_sections cs ON cs.id = dwi.section_id
        WHERE dwi.report_date = %s
        GROUP BY cs.code, wt.code, dwi.shift
    """, (report_date,))

    # ── Material movements for the day ──
    day_mm = _query("""
        SELECT cs.code AS sec_code, mm.shift,
               m.code AS mat_code,
               mm.labor_source_type,
               COALESCE(SUM(mm.volume), 0) AS vol
        FROM material_movements mm
        LEFT JOIN construction_sections cs ON cs.id = mm.section_id
        LEFT JOIN materials m ON m.id = mm.material_id
        WHERE mm.report_date = %s
        GROUP BY cs.code, mm.shift, m.code, mm.labor_source_type
    """, (report_date,))

    # ── Equipment for the day ──
    day_equip = _query("""
        SELECT reu.equipment_type, reu.status,
               dr.shift, cs.code AS sec_code,
               COUNT(*) AS cnt
        FROM report_equipment_units reu
        JOIN daily_reports dr ON dr.id = reu.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE dr.report_date = %s
        GROUP BY reu.equipment_type, reu.status, dr.shift, cs.code
    """, (report_date,))

    # Build volume matrix: cat -> sec_num -> {day_vol, night_vol, total}
    vol = {}
    for cat_code, _ in CATEGORIES:
        vol[cat_code] = {}
        for sn in SECTION_NUMS:
            vol[cat_code][sn] = {'day': 0.0, 'night': 0.0}

    for r in day_work:
        cat = WORK_TYPE_CATEGORY.get(r['wt_code'])
        if cat is None or cat not in vol:
            continue
        sn = _db_code_to_sec_num(r['sec_code'])
        if sn is None:
            continue
        shift = r['shift'] or 'day'
        if shift == 'day':
            vol[cat][sn]['day'] += float(r['vol'])
        else:
            vol[cat][sn]['night'] += float(r['vol'])

    # Transport from material_movements
    for r in day_mm:
        sn = _db_code_to_sec_num(r['sec_code'])
        if sn is None:
            continue
        shift = r['shift'] or 'day'
        if shift == 'day':
            vol['transport'][sn]['day'] += float(r['vol'])
        else:
            vol['transport'][sn]['night'] += float(r['vol'])

    # Equipment counts by section
    equip = {}
    for sn in SECTION_NUMS:
        equip[sn] = {'working': 0, 'total': 0, 'by_type': defaultdict(lambda: {'working': 0, 'total': 0})}

    for r in day_equip:
        sn = _db_code_to_sec_num(r['sec_code'])
        if sn is None:
            continue
        cnt = int(r['cnt'])
        et = r['equipment_type'] or 'unknown'
        equip[sn]['total'] += cnt
        equip[sn]['by_type'][et]['total'] += cnt
        if r['status'] == 'working':
            equip[sn]['working'] += cnt
            equip[sn]['by_type'][et]['working'] += cnt

    return {
        'report_date': report_date,
        'vol': vol,
        'equip': equip,
    }


def render_quarry_html(ctx: dict) -> str:
    """Render quarry report HTML."""
    d = ctx['report_date']
    date_str = d.strftime('%d.%m.%Y')
    vol = ctx['vol']
    equip = ctx['equip']

    # ── Main work volumes table ──
    sec_headers = ''.join(f'<th colspan="3">Участок {sn}</th>' for sn in SECTION_NUMS)
    sub_headers = ''.join('<th>День</th><th>Ночь</th><th>Итого</th>' for _ in SECTION_NUMS)

    body_rows = []
    grand_day = 0.0
    grand_night = 0.0

    for cat_code, cat_label in CATEGORIES:
        cells = []
        cat_day_total = 0.0
        cat_night_total = 0.0
        for sn in SECTION_NUMS:
            dv = vol[cat_code][sn]['day']
            nv = vol[cat_code][sn]['night']
            tv = dv + nv
            cat_day_total += dv
            cat_night_total += nv
            cells.append(f'<td>{_fnum(dv, 0)}</td><td>{_fnum(nv, 0)}</td><td class="subtotal">{_fnum(tv, 0)}</td>')
        grand_day += cat_day_total
        grand_night += cat_night_total
        cat_total = cat_day_total + cat_night_total
        cells.append(f'<td>{_fnum(cat_day_total, 0)}</td><td>{_fnum(cat_night_total, 0)}</td><td class="subtotal">{_fnum(cat_total, 0)}</td>')
        body_rows.append(f'<tr><td class="cat-label">{cat_label}</td>{"".join(cells)}</tr>')

    # Grand total row
    grand_total = grand_day + grand_night
    gt_cells = []
    for sn in SECTION_NUMS:
        sec_day = sum(vol[c][sn]['day'] for c, _ in CATEGORIES)
        sec_night = sum(vol[c][sn]['night'] for c, _ in CATEGORIES)
        sec_total = sec_day + sec_night
        gt_cells.append(f'<td class="subtotal">{_fnum(sec_day, 0)}</td><td class="subtotal">{_fnum(sec_night, 0)}</td><td class="grand">{_fnum(sec_total, 0)}</td>')
    gt_cells.append(f'<td class="subtotal">{_fnum(grand_day, 0)}</td><td class="subtotal">{_fnum(grand_night, 0)}</td><td class="grand">{_fnum(grand_total, 0)}</td>')
    body_rows.append(f'<tr class="total-row"><td class="cat-label">ИТОГО</td>{"".join(gt_cells)}</tr>')

    # ── Equipment summary row ──
    equip_cells = []
    total_working = 0
    total_all = 0
    for sn in SECTION_NUMS:
        w = equip[sn]['working']
        t = equip[sn]['total']
        total_working += w
        total_all += t
        equip_cells.append(f'<td colspan="3" class="equip-cell">{w} / {t}</td>')
    equip_cells.append(f'<td colspan="3" class="equip-cell grand">{total_working} / {total_all}</td>')
    body_rows.append(f'<tr class="equip-row"><td class="cat-label">Техника (раб./всего)</td>{"".join(equip_cells)}</tr>')

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
@page {{
  size: A4 landscape;
  margin: 12mm 10mm;
}}
body {{
  font-family: Arial, sans-serif;
  font-size: 9pt;
  color: #202020;
  margin: 0;
  padding: 0;
}}
h1 {{
  font-size: 12pt;
  color: #17365d;
  text-align: center;
  margin: 0 0 4mm 0;
  border-bottom: 2px solid #17365d;
  padding-bottom: 2mm;
}}
h2 {{
  font-size: 10pt;
  color: #17365d;
  margin: 2mm 0;
}}
table {{
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}}
th, td {{
  border: 1px solid #8f99a8;
  padding: 2px 2px;
  text-align: center;
  font-size: 7pt;
  word-wrap: break-word;
}}
th {{
  background: #d9e2f3;
  font-weight: bold;
  font-size: 7pt;
}}
.cat-label {{
  text-align: left;
  font-weight: bold;
  white-space: nowrap;
  font-size: 8pt;
  padding-left: 4px;
}}
.subtotal {{
  font-weight: bold;
  background: #f0f4fa;
}}
.grand {{
  font-weight: bold;
  background: #dde6f3;
}}
.total-row td {{
  font-weight: bold;
  background: #e8eef7;
}}
.equip-row td {{
  background: #f9f9f9;
  font-size: 8pt;
}}
.equip-cell {{
  font-weight: bold;
}}
.footer {{
  margin-top: 4mm;
  font-size: 8pt;
  color: #666;
  text-align: right;
}}
</style>
</head>
<body>
  <h1>Суточный отчет ЖЕЛДОРСТРОЙ &mdash; {date_str}</h1>
  <table>
    <thead>
      <tr>
        <th rowspan="2" style="width:70px">Категория</th>
        {sec_headers}
        <th colspan="3">ВСЕГО</th>
      </tr>
      <tr>
        {sub_headers}
        <th>День</th><th>Ночь</th><th>Итого</th>
      </tr>
    </thead>
    <tbody>
      {''.join(body_rows)}
    </tbody>
  </table>
  <div class="footer">
    Сформировано: {d.strftime('%d.%m.%Y')} | ВСМ-1, 3 этап
  </div>
</body>
</html>"""


def generate_quarry_pdf(report_date: date | None = None) -> bytes:
    """Generate quarry report PDF, return bytes."""
    if report_date is None:
        report_date = date.today() - timedelta(days=1)
    ctx = build_quarry_context(report_date)
    html_str = render_quarry_html(ctx)
    return HTML(string=html_str, base_url='/').write_pdf()


if __name__ == '__main__':
    import sys
    d = date.today() - timedelta(days=1)
    if len(sys.argv) > 1:
        d = date.fromisoformat(sys.argv[1])
    pdf_bytes = generate_quarry_pdf(d)
    out = Path('/tmp/vsm-pdf-samples/quarry-sample.pdf')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf_bytes)
    print(f'Written {out} ({len(pdf_bytes)} bytes)')
