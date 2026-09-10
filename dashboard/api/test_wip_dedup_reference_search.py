from __future__ import annotations

import re

import pytest

import wip_routes


def test_dedup_object_search_prioritizes_all_pk3153_stockpile_material_versions(monkeypatch: pytest.MonkeyPatch):
    rows = [
        ("id-3283", "STOCKPILE_3283", "Временный накопитель торфа ПК3283"),
        ("id-3133", "STOCKPILE_3133", "Накопитель грунта (выемка) ПК3133"),
        ("id-2663", "STOCK_AUTO_2663_SOIL", "Накопитель грунта ПК2663"),
        ("id-3153-soil", "STOCKPILE_3153_3", "Накопитель грунта ПК3153"),
        ("id-3153-sand", "STOCKPILE_3153", "Накопитель песка ПК3153"),
        ("id-3153-peat", "STOCKPILE_3153_4", "Накопитель торф ПК3153"),
        ("id-3153-shpgs", "STOCKPILE_3153_2", "Накопитель ЩПГС ПК3153"),
    ]

    def normalize(value: str) -> str:
        text = value.strip().lower().replace("ё", "е")
        text = re.sub(r"[\"'«»“”„.,;:/\\()\[\]{}]+", " ", text)
        return re.sub(r"\s+", " ", text).strip()

    def compact(value: str) -> str:
        return re.sub(r"[^0-9a-zа-я]+", "", normalize(value))

    def fake_query(sql: str, params=None) -> list[dict]:
        query_text = "накопитель пк3153"
        tokens = query_text.split()
        query_compact = compact(query_text)
        matched = []
        for row_id, code, label in rows:
            haystack = normalize(f"{code} {label}")
            haystack_compact = compact(f"{code}{label}")
            if not any(token in haystack for token in tokens) and query_compact not in haystack_compact:
                continue
            score = sum(1 for token in tokens if token in haystack)
            score += 2 if query_compact in haystack_compact else 0
            score += 100 if haystack == query_text else 0
            matched.append({
                "id": row_id,
                "code": code,
                "label": label,
                "score": score,
                "is_active": True,
                "review_tag": None,
            })
        return sorted(matched, key=lambda item: (-item["score"], item["label"].lower(), item["code"]))[: int((params or [8])[-1])]

    monkeypatch.setattr(wip_routes, "query", fake_query)
    monkeypatch.setattr(wip_routes, "_dedup_reference_counts", lambda kind, ref_id: {})

    result = wip_routes._dedup_reference_search("object", "накопитель ПК3153", 8)

    assert [row["code"] for row in result[:4]] == [
        "STOCKPILE_3153_3",
        "STOCKPILE_3153",
        "STOCKPILE_3153_4",
        "STOCKPILE_3153_2",
    ]
    assert all(row["score"] >= 2 for row in result[:4])
