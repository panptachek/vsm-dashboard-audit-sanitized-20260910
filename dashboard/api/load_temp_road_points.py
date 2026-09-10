"""Загружает координаты точек временных притрассовых дорог из
«пересчет координат дорог МСК (1).xlsx» в `temp_road_points`.

Структура xlsx: строки чередуются — заголовок дороги (АДx) и под ним её точки
в формате: x_MSK | y_MSK | ПК-метка | latitude | longitude.
Колонка долготы иногда разбита — 2 разных ячейки; нормализуем.
"""
from __future__ import annotations
import os
import re
import sys
from uuid import uuid4

import openpyxl
import psycopg2
from psycopg2.extras import execute_values

XLSX = "/opt/vsm/.claude/channels/telegram/inbox/1777021607006-AgADmZ8AAoGWWUs.xlsx"
DB_DSN = os.environ.get(
    "DB_DSN",
    "postgresql://demo_user:REPLACE_WITH_RANDOM_VALUE@127.0.0.1:5433/vsm_synthetic",
)

# xlsx-код → DB road_code (пробелы / точки → «№» и пробел)
ROAD_ALIASES = {
    'АД5': 'АД5', 'АД9': 'АД9', 'АД6': 'АД6',
    'АД13': 'АД13', 'АД14': 'АД14', 'АД3': 'АД3',
    'АД8№1': 'АД8 №1', 'АД8№2': 'АД8 №2',
    'АД1': 'АД1', 'АД11': 'АД11',
    'АД10': None,                       # нет в DB — пропустим
    'АД12': 'АД12',
    'АД2.6 и АД2.7': 'АД2 №6',          # в xlsx на один блок — кладём в АД2 №6
    'АД7': 'АД7',
    'АД4.8': 'АД4 №8', 'АД4.8.1': 'АД4 №8.1', 'АД4.9': 'АД4 №9',
}


def parse_float(x):
    if x is None: return None
    if isinstance(x, (int, float)): return float(x)
    s = str(x).replace(',', '.').strip()
    try: return float(s)
    except ValueError: return None


def parse_latlng(cells):
    """Разные форматы широты/долготы в xlsx: либо в одной ячейке («58.35, 33.29»),
    либо в двух соседних. Возвращаем (lat, lng) или None."""
    # cells = последние не-пустые ячейки строки
    # Собираем числа из строкового представления.
    nums = []
    for c in cells:
        if c is None: continue
        s = str(c).replace(',', '.').strip()
        for tok in re.findall(r"-?\d+\.\d+", s):
            nums.append(float(tok))
    # Ожидаем [lat, lng]
    if len(nums) >= 2:
        return nums[0], nums[1]
    return None


def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb['Лист1']

    current_road = None
    records = []  # (road_code, seq_no, pk_label, x_msk, y_msk, lat, lng, comment)
    seq_by_road: dict[str, int] = {}

    for row in ws.iter_rows(values_only=True):
        if not row or all(c is None for c in row):
            continue

        # Заголовок дороги — в первой ячейке строка, начинающаяся с АД
        first = row[0]
        if isinstance(first, str) and re.match(r'^АД\d', first.strip()):
            raw = first.strip()
            current_road = ROAD_ALIASES.get(raw, raw)
            continue

        if current_road is None:
            continue

        # Парсим точку: x, y, ПК, lat, lng (+ может быть разрыв между lat/lng)
        x = parse_float(row[0])
        y = parse_float(row[1])
        pk_label = None
        if len(row) >= 3 and row[2] is not None:
            pk_label = str(row[2]).strip()
        # lat/lng — оставшиеся непустые ячейки
        rest = [c for c in row[3:] if c is not None and str(c).strip() != ""]
        ll = parse_latlng(rest)
        if ll is None:
            continue
        lat, lng = ll
        seq_by_road[current_road] = seq_by_road.get(current_road, 0) + 1
        records.append((current_road, seq_by_road[current_road], pk_label, x, y, lat, lng, None))

    print(f"Parsed {len(records)} points across {len(seq_by_road)} roads")
    for r, n in sorted(seq_by_road.items()):
        print(f'  {r}: {n} points')

    conn = psycopg2.connect(DB_DSN)
    cur = conn.cursor()
    try:
        # Сносим предыдущие импорты
        cur.execute("DELETE FROM temp_road_points")
        # Привязываем road_id через road_code
        cur.execute("SELECT id, road_code FROM temporary_roads")
        road_id_by_code = {c: rid for rid, c in cur.fetchall()}

        values = []
        skipped = 0
        for rc, seq, lbl, x, y, lat, lng, comment in records:
            rid = road_id_by_code.get(rc)
            if not rid:
                skipped += 1
                continue
            values.append((str(uuid4()), rid, rc, seq, lbl, x, y, lat, lng, comment))
        if skipped:
            print(f'  skipped {skipped} points: road_code not in DB')

        execute_values(cur,
            """INSERT INTO temp_road_points
               (id, road_id, road_code, seq_no, pk_label, x_msk, y_msk, latitude, longitude, comment)
               VALUES %s""", values)
        conn.commit()
        print(f'Inserted {len(values)} points')
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
