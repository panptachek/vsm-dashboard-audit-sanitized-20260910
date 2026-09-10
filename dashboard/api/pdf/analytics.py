"""Analytics PDF generator — 3-page A4 landscape report.

Page 1: Summary table Plan/Fact x 8 sections + equipment norms + text summary
Page 2: 19 temp roads stacked bar charts by status
Page 3: Pile fields by section + quarry transport table
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
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

# UI section numbers: 1..8; DB codes map to UI numbers
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
ALL_DB_CODES = [c for codes in SECTION_DB_CODES.values() for c in codes]

# Work type code -> analytics category
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

# Equipment type normalization
EQUIP_NORMALIZE = {
    'самосвал': 'dump_truck',
    'экскаватор': 'excavator',
    'бульдозер': 'bulldozer',
    'каток': 'roller',
    'погрузчик': 'loader',
    'фр.погрузчик': 'loader',
    'грейдер': 'grader',
    'автогрейдер': 'grader',
}

EQUIP_LABELS = {
    'dump_truck': 'Самосвал',
    'excavator': 'Экскаватор',
    'bulldozer': 'Бульдозер',
}

# Quarries by section (from constants)
QUARRIES_BY_SECTION = {
    1: [{'name': 'Боровенка-3', 'armKm': 42}, {'name': 'Зорька-2', 'armKm': 26}, {'name': 'Васильки', 'armKm': 10}],
    2: [{'name': 'Боровенка-3', 'armKm': 55}, {'name': 'Зорька-2', 'armKm': 45}, {'name': 'Васильки', 'armKm': 22.7}],
    3: [{'name': 'УССК', 'armKm': 7.5}, {'name': 'Пирус', 'armKm': 32}, {'name': 'Васильки АЛМАЗ', 'armKm': 38}],
    4: [{'name': 'Пирус', 'armKm': 44}, {'name': 'Васильки АЛМАЗ', 'armKm': 44}],
    5: [{'name': 'Пирус', 'armKm': 16}, {'name': 'Васильки АЛМАЗ', 'armKm': 16}],
    6: [{'name': 'Южные Маяки', 'armKm': 24}, {'name': 'Добывалово', 'armKm': 28}],
    7: [{'name': 'Выползово', 'armKm': 12}, {'name': '"Великий" АЛМАЗ', 'armKm': 25}],
    8: [{'name': 'Выползово', 'armKm': 8.2}, {'name': '"Великий" АЛМАЗ', 'armKm': 3}],
}

# Temp road status colors
STATUS_COLORS = {
    'pioneer_fill': '#7c3aed',
    'subgrade_not_to_grade': '#d97706',
    'ready_for_shpgs': '#2563eb',
    'shpgs_done': '#16a34a',
    'no_work': '#9ca3af',
}
STATUS_FILLS = {
    'pioneer_fill': '#E8DDF5',
    'subgrade_not_to_grade': '#FCE5CD',
    'ready_for_shpgs': '#D9EAF7',
    'shpgs_done': '#D9EAD3',
    'no_work': '#E5E7EB',
}
STATUS_LABELS = {
    'pioneer_fill': 'Пионерка',
    'subgrade_not_to_grade': 'ЗП в работе',
    'ready_for_shpgs': 'Под ЩПГС',
    'shpgs_done': 'ЗП готово',
    'no_work': 'Не в работе',
}
ORDERED_STATUSES = ['pioneer_fill', 'subgrade_not_to_grade', 'ready_for_shpgs', 'shpgs_done']

# Custom section rules for temp roads
CUSTOM_SECTION_RULES = {
    "АД9": [("1", None, None)],
    "АД6": [("1", None, None)],
    "АД5": [("1", None, None)],
    "АД13": [("1", None, None)],
    "АД14": [("2", None, None)],
    "АД7": [("3", None, None)],
    "АД15": [("3", None, None)],
    "АД1": [("3", None, None)],
    "АД8 №1": [("4", None, 292520.0), ("3", 292520.0, None)],
    "АД3": [("4", None, None)],
    "АД8 №2": [("5", None, None)],
    "АД11": [("5", None, None)],
    "АД12": [("6", None, None)],
    "АД2 №6": [("6", None, None)],
    "АД2 №7": [("7", None, None)],
    "АД4 №7": [("7", None, None)],
    "АД4 №8": [("7", None, 328700.0), ("8", 328700.0, None)],
    "АД4 №8.1": [("8", None, None)],
    "АД4 №9": [("8", None, None)],
}


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
    """Format number with space thousands separator."""
    if v is None or v == 0:
        return '0'
    v = float(v)
    if decimals == 0:
        s = f'{v:,.0f}'
    else:
        s = f'{v:,.{decimals}f}'
    return s.replace(',', ' ')


def _db_code_to_sec_num(code):
    for num, codes in SECTION_DB_CODES.items():
        if code in codes:
            return num
    return None


# ─── Data loaders ────────────────────────────────────────────────────


def _load_work_volumes(report_date):
    """Load daily work item volumes grouped by section, work_type, shift, labor_source."""
    d = report_date
    week_start = d - timedelta(days=6)
    month_start = d.replace(day=1)

    result = {'day': [], 'week': [], 'month': []}
    for period_key, d_from in [('day', d), ('week', week_start), ('month', month_start)]:
        rows = _query("""
            SELECT cs.code AS sec_code, wt.code AS wt_code,
                   dwi.shift, dwi.labor_source_type,
                   COALESCE(SUM(dwi.volume), 0) AS vol
            FROM daily_work_items dwi
            JOIN work_types wt ON wt.id = dwi.work_type_id
            LEFT JOIN construction_sections cs ON cs.id = dwi.section_id
            WHERE dwi.report_date >= %s AND dwi.report_date <= %s
            GROUP BY cs.code, wt.code, dwi.shift, dwi.labor_source_type
        """, (d_from, d))
        result[period_key] = rows
    return result


def _load_transport_volumes(report_date):
    """Load material movement volumes grouped by section, shift, labor_source."""
    d = report_date
    week_start = d - timedelta(days=6)
    month_start = d.replace(day=1)

    result = {}
    for period_key, d_from in [('day', d), ('week', week_start), ('month', month_start)]:
        rows = _query("""
            SELECT cs.code AS sec_code, mm.shift,
                   mm.labor_source_type,
                   m.code AS mat_code,
                   COALESCE(SUM(mm.volume), 0) AS vol
            FROM material_movements mm
            LEFT JOIN construction_sections cs ON cs.id = mm.section_id
            LEFT JOIN materials m ON m.id = mm.material_id
            WHERE mm.report_date >= %s AND mm.report_date <= %s
            GROUP BY cs.code, mm.shift, mm.labor_source_type, m.code
        """, (d_from, d))
        result[period_key] = rows
    return result


def _load_equipment_data(report_date):
    """Load equipment counts by type, section, shift, status."""
    return _query("""
        SELECT reu.equipment_type, reu.status,
               dr.shift, cs.code AS sec_code,
               COUNT(*) AS cnt
        FROM report_equipment_units reu
        JOIN daily_reports dr ON dr.id = reu.daily_report_id
        LEFT JOIN construction_sections cs ON cs.id = dr.section_id
        WHERE dr.report_date = %s
        GROUP BY reu.equipment_type, reu.status, dr.shift, cs.code
    """, (report_date,))


def _load_temp_roads():
    return _query("""
        SELECT tr.road_code, tr.ad_start_pk, tr.ad_end_pk,
               tr.rail_start_pk, tr.rail_end_pk,
               m.ad_pk_start AS m_ad_start, m.ad_pk_end AS m_ad_end,
               m.rail_pk_start AS m_rail_start, m.rail_pk_end AS m_rail_end
        FROM temporary_roads tr
        LEFT JOIN temporary_road_pk_mappings m
          ON m.road_id = tr.id AND m.mapping_type = 'full_axis_range'
        ORDER BY tr.rail_start_pk NULLS LAST, tr.road_code
    """)


def _load_temp_road_statuses(report_date):
    return _query("""
        SELECT tr.road_code, s.status_type,
               s.road_pk_start, s.road_pk_end,
               s.rail_pk_start, s.rail_pk_end
        FROM temporary_road_status_segments s
        JOIN temporary_roads tr ON tr.id = s.road_id
        WHERE s.status_date <= %s
        ORDER BY tr.road_code, s.status_type
    """, (report_date,))


def _load_pile_fields():
    fields = _query("""
        SELECT pf.field_code, pf.field_type, pf.pile_type,
               pf.pile_count, pf.dynamic_test_count,
               pf.pk_start, pf.pk_end
        FROM pile_fields pf
        ORDER BY pf.pk_start NULLS LAST
    """)
    sections = _query("""
        SELECT cs.code, csv.pk_start, csv.pk_end
        FROM construction_sections cs
        JOIN construction_section_versions csv ON csv.section_id = cs.id AND csv.is_current
        ORDER BY cs.sort_order NULLS LAST
    """)
    for f in fields:
        f['section_num'] = None
        if f['pk_start'] is None:
            continue
        pk_mid = float(f['pk_start'])
        for s in sections:
            if s['pk_start'] is not None and s['pk_end'] is not None:
                if float(s['pk_start']) <= pk_mid <= float(s['pk_end']):
                    f['section_num'] = _db_code_to_sec_num(s['code'])
                    break
    return fields


# ─── Helpers ─────────────────────────────────────────────────────────


def _merge_ranges(ranges):
    clean = sorted((min(float(a), float(b)), max(float(a), float(b)))
                    for a, b in ranges if a is not None and b is not None)
    if not clean:
        return []
    merged = [clean[0]]
    for s, e in clean[1:]:
        ls, le = merged[-1]
        if s <= le:
            merged[-1] = (ls, max(le, e))
        else:
            merged.append((s, e))
    return merged


def _subtract_ranges(base, exclude):
    if not base or not exclude:
        return list(base)
    mexcl = _merge_ranges(exclude)
    result = []
    for bs, be in base:
        cursor = bs
        for es, ee in mexcl:
            if ee <= cursor:
                continue
            if es >= be:
                break
            if es > cursor:
                result.append((cursor, es))
            cursor = max(cursor, ee)
        if cursor < be:
            result.append((cursor, be))
    return _merge_ranges(result)


def _make_exclusive(merged_per_status):
    priority = ['shpgs_done', 'ready_for_shpgs', 'subgrade_not_to_grade', 'pioneer_fill']
    result = {}
    claimed = []
    for st in priority:
        raw = merged_per_status.get(st, [])
        eff = _subtract_ranges(raw, claimed)
        result[st] = eff
        claimed.extend(eff)
        claimed = _merge_ranges(claimed)
    return result


def _zero_sec_dict():
    return {sn: {'day': 0.0, 'week': 0.0, 'month': 0.0} for sn in SECTION_NUMS}


# ─── Build context ───────────────────────────────────────────────────


def build_analytics_context(report_date: date) -> dict:
    """Build all data needed for the analytics PDF."""
    work_data = _load_work_volumes(report_date)
    transport_data = _load_transport_volumes(report_date)
    equipment_data = _load_equipment_data(report_date)
    roads_raw = _load_temp_roads()
    statuses_raw = _load_temp_road_statuses(report_date)
    pile_fields = _load_pile_fields()

    # ── Categories (non-sand from daily_work_items) ──
    categories = ['prs', 'sand', 'excavation', 'excavation_oh', 'shps', 'transport']
    cat_labels = {
        'prs': 'ПРС', 'sand': 'Песок', 'excavation': 'Выемка',
        'excavation_oh': 'Выемка ОХ', 'shps': 'ЩПС', 'transport': 'Перевозка',
    }

    vol_table = {cat: _zero_sec_dict() for cat in categories}

    # Non-sand work categories from daily_work_items
    for period_key, rows in work_data.items():
        for r in rows:
            cat = WORK_TYPE_CATEGORY.get(r['wt_code'])
            if not cat or cat not in vol_table or cat == 'sand':
                continue
            sn = _db_code_to_sec_num(r['sec_code'])
            if sn is None:
                continue
            vol_table[cat][sn][period_key] += float(r['vol'])

    # Transport from material_movements (total across all materials)
    for period_key, rows in transport_data.items():
        for r in rows:
            sn = _db_code_to_sec_num(r['sec_code'])
            if sn is None:
                continue
            vol_table['transport'][sn][period_key] += float(r['vol'])

    # Sand sub-rows AND total from material_movements (SAND only)
    # This ensures sub-rows sum to total
    sand_sub = {label: _zero_sec_dict() for label in ['own', 'almaz', 'hired']}

    for period_key, rows in transport_data.items():
        for r in rows:
            if r['mat_code'] != 'SAND':
                continue
            sn = _db_code_to_sec_num(r['sec_code'])
            if sn is None:
                continue
            vol = float(r['vol'])
            ls = (r['labor_source_type'] or 'own').lower()
            if 'almaz' in ls or 'алмаз' in ls:
                sand_sub['almaz'][sn][period_key] += vol
            elif ls in ('hired', 'наёмники', 'наемники'):
                sand_sub['hired'][sn][period_key] += vol
            else:
                sand_sub['own'][sn][period_key] += vol

    # Sand total = sum of sub-rows
    for sn in SECTION_NUMS:
        for p in ['day', 'week', 'month']:
            vol_table['sand'][sn][p] = (
                sand_sub['own'][sn][p] +
                sand_sub['almaz'][sn][p] +
                sand_sub['hired'][sn][p]
            )

    # ── Equipment norms ──
    equip_by_sec = {}
    for et in ['dump_truck', 'excavator', 'bulldozer']:
        equip_by_sec[et] = {sn: {'working': 0, 'total': 0} for sn in SECTION_NUMS}

    for r in equipment_data:
        raw_type = r['equipment_type'] or ''
        et = EQUIP_NORMALIZE.get(raw_type.lower().strip())
        if et not in equip_by_sec:
            continue
        sn = _db_code_to_sec_num(r['sec_code'])
        if sn is None:
            continue
        cnt = int(r['cnt'])
        equip_by_sec[et][sn]['total'] += cnt
        if r['status'] == 'working':
            equip_by_sec[et][sn]['working'] += cnt

    # ── Text summary totals ──
    day_totals = {cat: sum(vol_table[cat][sn]['day'] for sn in SECTION_NUMS) for cat in categories}
    sand_own_total = sum(sand_sub['own'][sn]['day'] for sn in SECTION_NUMS)
    sand_almaz_total = sum(sand_sub['almaz'][sn]['day'] for sn in SECTION_NUMS)
    sand_hired_total = sum(sand_sub['hired'][sn]['day'] for sn in SECTION_NUMS)

    # ── Page 2: Temp roads ──
    road_bars = _build_temp_road_bars(roads_raw, statuses_raw)

    # ── Page 3: Pile fields + quarry transport ──
    pile_summary = _build_pile_summary(pile_fields)
    quarry_table = _build_quarry_table(transport_data, report_date)

    return {
        'report_date': report_date,
        'categories': categories,
        'cat_labels': cat_labels,
        'vol_table': vol_table,
        'sand_sub': sand_sub,
        'equip_by_sec': equip_by_sec,
        'day_totals': day_totals,
        'sand_own_total': sand_own_total,
        'sand_almaz_total': sand_almaz_total,
        'sand_hired_total': sand_hired_total,
        'road_bars': road_bars,
        'pile_summary': pile_summary,
        'quarry_table': quarry_table,
    }


def _build_temp_road_bars(roads_raw, statuses_raw):
    road_info = {}
    for r in roads_raw:
        code = r['road_code']
        ad_start = float(r['ad_start_pk']) if r['ad_start_pk'] is not None else 0
        ad_end = float(r['ad_end_pk']) if r['ad_end_pk'] is not None else 0
        rail_start = float(r['rail_start_pk']) if r['rail_start_pk'] is not None else None
        total_len = abs(ad_end - ad_start)
        rules = CUSTOM_SECTION_RULES.get(code, [])
        section_labels = [rule[0] for rule in rules] if rules else ['?']
        road_info[code] = {
            'total_len': total_len, 'ad_start': ad_start, 'ad_end': ad_end,
            'rail_start': rail_start, 'sections': section_labels,
        }

    raw_ad_ranges = defaultdict(lambda: defaultdict(list))
    for r in statuses_raw:
        code = r['road_code']
        st = r['status_type']
        ad_s = float(r['road_pk_start']) if r['road_pk_start'] is not None else None
        ad_e = float(r['road_pk_end']) if r['road_pk_end'] is not None else None
        if ad_s is not None and ad_e is not None:
            raw_ad_ranges[code][st].append((ad_s, ad_e))

    bars = []
    for code in sorted(road_info.keys(), key=lambda c: road_info[c].get('rail_start') or 999999):
        info = road_info[code]
        total = info['total_len']
        if total <= 0:
            continue
        merged = {st: _merge_ranges(raw_ad_ranges[code].get(st, [])) for st in ORDERED_STATUSES}
        exclusive = _make_exclusive(merged)
        lengths = {st: sum(abs(e - s) for s, e in exclusive[st]) for st in ORDERED_STATUSES}
        worked = sum(lengths.values())
        lengths['no_work'] = max(total - worked, 0)
        bars.append({'code': code, 'sections': info['sections'], 'total_len': total, 'lengths': lengths})
    return bars


def _build_pile_summary(pile_fields):
    summary = {sn: {'main_fields': 0, 'main_piles': 0, 'test_fields': 0,
                     'test_piles': 0, 'tests': 0, 'types': set()} for sn in SECTION_NUMS}
    for f in pile_fields:
        sn = f.get('section_num')
        if sn is None:
            continue
        if f['field_type'] == 'main':
            summary[sn]['main_fields'] += 1
            summary[sn]['main_piles'] += (f['pile_count'] or 0)
        elif f['field_type'] == 'test':
            summary[sn]['test_fields'] += 1
            summary[sn]['test_piles'] += (f['pile_count'] or 0)
            summary[sn]['tests'] += (f['dynamic_test_count'] or 0)
        if f['pile_type']:
            summary[sn]['types'].add(f['pile_type'])
    for sn in SECTION_NUMS:
        summary[sn]['types'] = sorted(summary[sn]['types'])[:3]
    return summary


def _build_quarry_table(transport_data, report_date):
    day_rows = transport_data.get('day', [])
    by_sec_mat = defaultdict(lambda: defaultdict(float))
    for r in day_rows:
        sn = _db_code_to_sec_num(r['sec_code'])
        if sn is None:
            continue
        mat = r['mat_code'] or 'SAND'
        by_sec_mat[sn][mat] += float(r['vol'])
    return {'by_sec_mat': dict(by_sec_mat)}


# ─── HTML rendering ─────────────────────────────────────────────────


def _render_page1(ctx):
    d = ctx['report_date']
    date_str = d.strftime('%d.%m.%Y')
    vol = ctx['vol_table']
    cats = ctx['categories']
    cat_labels = ctx['cat_labels']

    def _row(label, cat, period='day', cls=''):
        cells = []
        total = 0.0
        for sn in SECTION_NUMS:
            v = vol[cat][sn][period]
            total += v
            cells.append(f'<td class="{cls}">{_fnum(v, 0)}</td>')
        cells.append(f'<td class="{cls} tot">{_fnum(total, 0)}</td>')
        return f'<tr><td class="rl {cls}">{label}</td>{"".join(cells)}</tr>'

    def _sub_row(label, data, period='day'):
        cells = []
        total = 0.0
        for sn in SECTION_NUMS:
            v = data[sn][period]
            total += v
            cells.append(f'<td class="sub">{_fnum(v, 0)}</td>')
        cells.append(f'<td class="sub">{_fnum(total, 0)}</td>')
        return f'<tr><td class="rl sub">&nbsp;&nbsp;{label}</td>{"".join(cells)}</tr>'

    headers = ''.join(f'<th>{sn}</th>' for sn in SECTION_NUMS)

    work_rows = []
    for period, plabel in [('day', 'за сутки'), ('week', 'за неделю'), ('month', 'за месяц')]:
        work_rows.append(f'<tr class="ph"><td colspan="10">Факт {plabel}</td></tr>')
        for cat in cats:
            work_rows.append(_row(cat_labels[cat], cat, period))
            if cat == 'sand':
                work_rows.append(_sub_row('Свои', ctx['sand_sub']['own'], period))
                work_rows.append(_sub_row('Алмаз', ctx['sand_sub']['almaz'], period))
                work_rows.append(_sub_row('Наёмники', ctx['sand_sub']['hired'], period))

    # ── Equipment norms ──
    equip = ctx['equip_by_sec']
    equip_rows = []
    for et in ['dump_truck', 'excavator', 'bulldozer']:
        cells = []
        tw, ta = 0, 0
        for sn in SECTION_NUMS:
            w = equip[et][sn]['working']
            t = equip[et][sn]['total']
            tw += w; ta += t
            pct = round(w / t * 100) if t > 0 else 0
            cells.append(f'<td>{w}/{t} ({pct}%)</td>')
        tpct = round(tw / ta * 100) if ta > 0 else 0
        cells.append(f'<td class="tot">{tw}/{ta} ({tpct}%)</td>')
        equip_rows.append(f'<tr><td class="rl">{EQUIP_LABELS[et]}</td>{"".join(cells)}</tr>')

    # ── Text summary (compact, inline) ──
    dt = ctx['day_totals']
    summary_text = (
        f'<b>Выполнение за {date_str}:</b> '
        f'ПРС: {_fnum(dt["prs"], 0)} м\u00b3; '
        f'песок: {_fnum(dt["sand"], 0)} м\u00b3 '
        f'(свои {_fnum(ctx["sand_own_total"], 0)}, '
        f'Алмаз {_fnum(ctx["sand_almaz_total"], 0)}, '
        f'наёмн. {_fnum(ctx["sand_hired_total"], 0)}); '
        f'выемка: {_fnum(dt["excavation"], 0)} м\u00b3; '
        f'ЩПГС: {_fnum(dt["shps"], 0)} м\u00b3; '
        f'перевозка: {_fnum(dt["transport"], 0)} м\u00b3.'
    )

    return f"""
    <div class="page page1">
      <h2>Сводка по работам &mdash; {date_str}</h2>
      <table class="dt">
        <thead><tr><th class="rl">Показатель</th>{headers}<th>Всего</th></tr></thead>
        <tbody>{''.join(work_rows)}</tbody>
      </table>
      <h3>Техника (факт/всего, % загрузки)</h3>
      <table class="dt eq">
        <thead><tr><th class="rl">Техника</th>{headers}<th>Всего</th></tr></thead>
        <tbody>{''.join(equip_rows)}</tbody>
      </table>
      <p class="summary">{summary_text}</p>
    </div>
    """


def _render_page2(ctx):
    bars = ctx['road_bars']
    all_statuses = ORDERED_STATUSES + ['no_work']

    section_groups = defaultdict(list)
    for bar in bars:
        for sec in bar['sections']:
            section_groups[sec].append(bar)

    chart_parts = []
    bar_h = 18
    gap = 4
    chart_w = 700
    label_w = 90
    legend_h = 30

    for sec_num in [str(i) for i in range(1, 9)]:
        sec_bars = section_groups.get(sec_num, [])
        if not sec_bars:
            continue

        n = len(sec_bars)
        svg_h = n * (bar_h + gap) + legend_h + 30
        parts = [f'<div class="chart-block"><h4>Участок {sec_num}</h4>']
        parts.append(f'<svg width="{chart_w + label_w + 60}" height="{svg_h}" '
                     f'style="font-family:Arial,sans-serif;font-size:7px;">')

        for i, bar in enumerate(sec_bars):
            y = i * (bar_h + gap) + 5
            total = bar['total_len']
            if total <= 0:
                continue
            parts.append(f'<text x="{label_w - 4}" y="{y + bar_h - 4}" '
                         f'text-anchor="end" font-size="7">{bar["code"]}</text>')
            x_cursor = label_w
            for st in all_statuses:
                seg_len = bar['lengths'].get(st, 0)
                if seg_len <= 0:
                    continue
                w = seg_len / total * chart_w
                parts.append(f'<rect x="{x_cursor:.1f}" y="{y}" width="{w:.1f}" '
                             f'height="{bar_h}" fill="{STATUS_FILLS[st]}" '
                             f'stroke="{STATUS_COLORS[st]}" stroke-width="0.5"/>')
                if w > 30:
                    parts.append(f'<text x="{x_cursor + w / 2:.1f}" y="{y + bar_h - 5}" '
                                 f'text-anchor="middle" font-size="6" fill="#333">'
                                 f'{seg_len / 1000:.1f} км</text>')
                x_cursor += w
            parts.append(f'<text x="{label_w + chart_w + 4}" y="{y + bar_h - 4}" '
                         f'font-size="7" fill="#333">{total / 1000:.2f} км</text>')

        ly = n * (bar_h + gap) + 15
        lx = label_w
        for st in all_statuses:
            parts.append(f'<rect x="{lx}" y="{ly}" width="12" height="10" '
                         f'fill="{STATUS_FILLS[st]}" stroke="{STATUS_COLORS[st]}" stroke-width="0.5"/>')
            lx += 14
            parts.append(f'<text x="{lx}" y="{ly + 8}" font-size="7">{STATUS_LABELS[st]}</text>')
            lx += len(STATUS_LABELS[st]) * 4.5 + 8
        parts.append('</svg></div>')
        chart_parts.append('\n'.join(parts))

    return f"""
    <div class="page page2">
      <h2>Временные автодороги &mdash; статус по участкам</h2>
      <div class="charts-container">{''.join(chart_parts)}</div>
    </div>
    """


def _render_page3(ctx):
    pile = ctx['pile_summary']
    headers = ''.join(f'<th>{sn}</th>' for sn in SECTION_NUMS)

    def _pile_row(label, key, fmt=True):
        cells = ''.join(f'<td>{_fnum(pile[sn][key], 0) if fmt else pile[sn][key]}</td>' for sn in SECTION_NUMS)
        total = sum(pile[sn][key] for sn in SECTION_NUMS)
        return f'<tr><td class="rl">{label}</td>{cells}<td class="tot">{_fnum(total, 0) if fmt else total}</td></tr>'

    types_cells = ''.join(f'<td style="font-size:6pt">{", ".join(pile[sn]["types"]) or "&mdash;"}</td>' for sn in SECTION_NUMS)

    quarry_rows = []
    for sn in SECTION_NUMS:
        quarries = QUARRIES_BY_SECTION.get(sn, [])
        if not quarries:
            quarry_rows.append(f'<tr><td>{sn}</td><td colspan="3">&mdash;</td></tr>')
            continue
        for i, q in enumerate(quarries):
            sec_cell = f'<td rowspan="{len(quarries)}">{sn}</td>' if i == 0 else ''
            quarry_rows.append(f'<tr>{sec_cell}<td>{q["name"]}</td><td>{q["armKm"]} км</td><td>&mdash;</td></tr>')

    return f"""
    <div class="page page3">
      <h2>Свайные поля по участкам</h2>
      <table class="dt">
        <thead><tr><th class="rl">Показатель</th>{headers}<th>Всего</th></tr></thead>
        <tbody>
          {_pile_row('Осн. поля (кол-во)', 'main_fields')}
          {_pile_row('Осн. сваи (шт)', 'main_piles')}
          {_pile_row('Пробные поля (кол-во)', 'test_fields')}
          {_pile_row('Пробные сваи (шт)', 'test_piles')}
          {_pile_row('Дин. испытания (шт)', 'tests')}
          <tr><td class="rl">Типы свай</td>{types_cells}<td>&mdash;</td></tr>
        </tbody>
      </table>
      <h2 style="margin-top:8mm">Возка с карьеров</h2>
      <table class="dt qt">
        <thead><tr><th>Участок</th><th>Карьер</th><th>Плечо возки</th><th>Канал (Свои/Алмаз/Наём)</th></tr></thead>
        <tbody>{''.join(quarry_rows)}</tbody>
      </table>
    </div>
    """


def render_analytics_html(ctx: dict) -> str:
    d = ctx['report_date']
    page1 = _render_page1(ctx)
    page2 = _render_page2(ctx)
    page3 = _render_page3(ctx)

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
@page {{ size: A4 landscape; margin: 10mm 8mm; }}
body {{ font-family: Arial, sans-serif; font-size: 8pt; color: #202020; margin: 0; padding: 0; }}
h2 {{ font-size: 10pt; color: #17365d; margin: 1mm 0 2mm 0; border-bottom: 1px solid #17365d; padding-bottom: 1mm; }}
h3 {{ font-size: 9pt; color: #17365d; margin: 2mm 0 1mm 0; }}
h4 {{ font-size: 8pt; color: #333; margin: 1mm 0; }}
.page {{ page-break-after: always; }}
.page:last-child {{ page-break-after: avoid; }}
.dt {{ width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 2mm; }}
.dt th, .dt td {{ border: 1px solid #8f99a8; padding: 1px 2px; text-align: center; font-size: 7pt; word-wrap: break-word; }}
.dt th {{ background: #d9e2f3; font-weight: bold; }}
.rl {{ text-align: left !important; white-space: nowrap; font-weight: bold; }}
.sub {{ font-size: 6.5pt; color: #555; }}
.sub.rl {{ font-weight: normal; }}
.tot {{ font-weight: bold; }}
.eq td {{ font-size: 6.5pt; }}
.ph td {{ background: #e8e8e8; font-weight: bold; text-align: left; padding: 1px 4px; font-size: 7pt; }}
.summary {{ font-size: 7.5pt; margin-top: 1mm; line-height: 1.3; }}
.charts-container {{ columns: 2; column-gap: 5mm; }}
.chart-block {{ break-inside: avoid; margin-bottom: 2mm; }}
.qt td, .qt th {{ font-size: 7.5pt; }}
</style>
</head>
<body>
{page1}
{page2}
{page3}
</body>
</html>"""


def generate_analytics_pdf(report_date: date | None = None) -> bytes:
    if report_date is None:
        report_date = date.today() - timedelta(days=1)
    ctx = build_analytics_context(report_date)
    html_str = render_analytics_html(ctx)
    return HTML(string=html_str, base_url='/').write_pdf()


if __name__ == '__main__':
    import sys
    d = date.today() - timedelta(days=1)
    if len(sys.argv) > 1:
        d = date.fromisoformat(sys.argv[1])
    pdf_bytes = generate_analytics_pdf(d)
    out = Path('/tmp/vsm-pdf-samples/analytics-sample.pdf')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf_bytes)
    print(f'Written {out} ({len(pdf_bytes)} bytes)')
