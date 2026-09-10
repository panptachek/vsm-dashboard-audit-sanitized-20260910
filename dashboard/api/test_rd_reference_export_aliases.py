from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from db_admin_routes import _append_rd_intake_system_aliases


def test_reference_export_appends_system_aliases_for_existing_codes() -> None:
    aliases = [{"kind": "material", "alias_text": "ЩПС", "canonical_code": "SHPGS"}]
    work_types = [
        {"code": "ZS1"},
        {"code": "ZS2"},
        {"code": "WT_D746ECC7"},
        {"code": "PAVEMENT_SANDING"},
        {"code": "GEOMAT_PLACEMENT"},
        {"code": "GEOMAT_ANCHOR_TRENCH"},
        {"code": "DITCH_CONCRETE_M150"},
    ]
    materials = [
        {"code": "SHPGS"},
        {"code": "PGS"},
        {"code": "ASPHALT_MIX"},
        {"code": "CEMENT"},
        {"code": "CRUSHED_STONE"},
        {"code": "GEOMAT"},
        {"code": "CONCRETE_M150"},
    ]

    _append_rd_intake_system_aliases(aliases, work_types=work_types, materials=materials)

    exported = {(row["kind"], row["alias_text"], row["canonical_code"]) for row in aliases}
    assert ("work_type", "Устройство первого защитного слоя", "ZS1") in exported
    assert ("work_type", "Устройство второго защитного слоя", "ZS2") in exported
    assert ("work_type", "Погрузка готовой смеси", "WT_D746ECC7") in exported
    assert ("work_type", "Досыпка песчаного дренирующего грунта", "PAVEMENT_SANDING") in exported
    assert ("work_type", "Укладка противоэрозионного геомата", "GEOMAT_PLACEMENT") in exported
    assert ("work_type", "Анкерная траншея для геоматов", "GEOMAT_ANCHOR_TRENCH") in exported
    assert ("work_type", "Бетонирование откосов и дна канав, М150", "DITCH_CONCRETE_M150") in exported
    assert ("material", "Смесь щебеночно-песчаная", "SHPGS") in exported
    assert ("material", "Песчано-гравийная смесь", "PGS") in exported
    assert ("material", "Асфальтобетонная смесь", "ASPHALT_MIX") in exported
    assert ("material", "Цемент ПЦ 500", "CEMENT") in exported
    assert ("material", "Щебень фр", "CRUSHED_STONE") in exported
    assert ("material", "Противоэрозионного геомата", "GEOMAT") in exported
    assert ("material", "Бетона М150", "CONCRETE_M150") in exported
    assert sum(1 for row in aliases if row["alias_text"] == "ЩПС") == 1


def test_reference_export_skips_system_aliases_for_missing_codes() -> None:
    aliases: list[dict[str, str]] = []

    _append_rd_intake_system_aliases(aliases, work_types=[{"code": "ZS1"}], materials=[])

    assert all(row["canonical_code"] == "ZS1" for row in aliases)
    assert all(row["kind"] == "work_type" for row in aliases)
