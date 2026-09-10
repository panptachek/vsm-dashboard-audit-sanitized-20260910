"""Deterministic parser for VSM daily text reports.

The parser is deliberately format-first. It does not write to DB and does not
resolve DB ids. reports_routes.py enriches aliases and performs import.
"""
from __future__ import annotations

from datetime import date as date_cls
import re
from typing import Any, Optional


SECTION_RE = re.compile(
    r"^\s*(?:"
    r"={2,}\s*(?P<boxed>.+?)\s*={2,}"
    r"|#{1,6}\s*(?P<hash>.+?)\s*"
    r"|(?P<bare>Шапка|Перевозка|Перевозки|Возка|Транспорт|Транспортировка|Основные работы|Основные|Выполненные работы|Работы за смену|Работы|Сопутствующие работы|Парк техники|Техника|Персонал|Люди|Накопители|Забивка свай|Свайные работы|Сваи|Данные по отсыпке ОХ|Отсыпка ОХ|Статусы отсыпки ОХ|Данные по отсыпке|Отсыпка|Статусы отсыпки|Проблемные вопросы)\s*[:：]?"
    r")\s*$",
    re.MULTILINE | re.I,
)
MAT_OR_WORK_RE = re.compile(r"^/(.+?)/\s*$")
CONSTRUCTIVE_RE = re.compile(r"^-\s*(.+?)\s*-\s*$")
FIELD_RE = re.compile(r"^([^:：]+)\s*[:：]\s*(.*)$")
HEADER_RE = re.compile(r"^([^-\n–—]+?)\s*[-–—]\s*(.+)$")
VEHICLE_RE = re.compile(r"^(.+?)\s*\(([^)]*)\)\s*;\s*(.+?)\s*[;,]?\s*$")
ROUTE_RE = re.compile(r"^\s*(?:=\s*(.+?)\s*=|-\s*(.+?)\s*-)\s*$")
ROUTE_MATERIAL_RE = re.compile(r"^\s*(.+?)\s*(?:→|->)\s*(.+?)\s*=\s*(.+?)\s*$", re.I)
ROUTE_LABEL_RE = re.compile(r"^\s*(?:маршрут|направлен(?:ие|ия)(?:\s+перевозк\w*)?|куда|рейс\w*)\s*[:：-]\s*(.+?)\s*$", re.I)
MATERIAL_LABEL_RE = re.compile(r"^\s*(?:материал|груз)\s*[:：-]\s*(.+?)\s*$", re.I)
HAUL_DISTANCE_RE = re.compile(r"(?:^|[/;,\s])(?:плечо|плеч\.?|расстояние|дистанция|l)\s*(?:возки|перевозки)?\s*[:=\-]?\s*(\d[\d\s]*(?:[,.]\d+)?)\s*км\b", re.I)
WORK_HOURS_RE = re.compile(
    r"(?:\s*/\s*|\s+)(?:время\s+работы|время)\s*[:=\-]?\s*(\d{1,2}(?:[,.]\d+)?)\s*ч(?:ас(?:а|ов)?)?\s*$",
    re.I,
)
COMPACT_NUMBER_ROW_RE = re.compile(r"^Номер\s+(.+?)\s*/(?=\s|\d)\s*(.+?)\s+/\s*(.+?)\s+/\s*(.+?)\s*$", re.I)
COMPACT_TRANSPORT_SLASH_ROW_RE = re.compile(
    r"^(?P<left>.+?)\s*/\s*(?P<qty>\d[\d\s]*(?:[,.]\d+)?\s*(?:м3|м³|м²|м2|м|км|шт\.?|ед\.?|т)?)\s*/\s*(?P<trips>\d+\s*рейс\w*)\s*/\s*(?P<owner>.+?)\s*$",
    re.I,
)
COMPACT_FLEET_ROW_RE = re.compile(
    r"^(?P<count>\d+)\s*а\s*/\s*с\s*/\s*(?P<qty>.+?)\s*/\s*(?P<trips>.+?)\s*/\s*(?P<owner>.+?)\s*$",
    re.I,
)
COMPACT_WORK_FLEET_ROW_RE = re.compile(
    r"^(?P<count>\d+)\s*(?:ед\.?|шт\.?|машин\w*|техник\w*|а\s*/\s*с)\s*/\s*(?P<qty>.+?)\s*/\s*(?P<equipment>.+?)\s*/\s*(?P<owner>.+?)\s*$",
    re.I,
)
UNIT_RE_PART = r"м3|м³|м²|м2|м|км|шт\.?|ед\.?|т"
VOLUME_TRIPS_RE = re.compile(rf"(\d[\d\s]*(?:[,.]\d+)?|Н/Д|н/д)\s*({UNIT_RE_PART})?\s*/\s*(\d+)\s*рейс", re.I)
VOLUME_RE = re.compile(rf"(?:[A-ZА-Я]\s*=\s*)?(\d[\d\s]*(?:[,.]\d+)?)\s*({UNIT_RE_PART})(?:\s*[;(]\s*([^)]+?)\s*\)?)?", re.I)
SHORTHAND_EQUIPMENT_VOLUME_RE = re.compile(
    r"^\s*(?P<equipment>.+?\([^)]*\))\s*[-–—]\s*"
    r"(?:(?P<trips>\d+)\s*р(?:ейс\w*)?\s*[-–—]\s*)?"
    rf"(?P<volume>\d[\d\s]*(?:[,.]\d+)?)\s*(?P<unit>{UNIT_RE_PART})\b",
    re.I,
)
NUMBERED_WORK_RE = re.compile(r"^\s*\d+\)\s*(.+?)\s*$")
PK_TOKEN_RE = re.compile(
    r"(?<![\d+])"
    r"(?P<prefix>п\s*\.?\s*к\s*\.?\s*(?:[А-ЯA-Z]{1,8}\s*)?(?:[:：]\s*)?)?"
    r"(?P<picket>\d{1,7})"
    r"(?:\s*(?:\+|[,.])\s*(?P<plus>\d{1,2}(?:[,.]\d+)?))?"
    r"(?!\d)",
    re.I,
)
PK_PLUS_CONTINUATION_RE = re.compile(r"[-]\s*(?:\+|[,.])\s*(?P<plus>\d{1,2}(?:[,.]\d+)?)", re.I)
PK_LINE_RE = re.compile(r"^(п\s*\.?\s*к\s*\.?\s*(?:ВСЖМ|АД))\s*[:：]\s*(.*)$", re.I)
OPERATOR_RE = re.compile(r"^ф\s*\.?\s*и\s*\.?\s*о\s*\.?\s*:?\s*(.*)$", re.I)
ROLE_MARKER_RE = re.compile(r"^(?:исполнитель|водитель|машинист|единица\s+техники|техника)\s*\d*\s*:?\s*$", re.I)
EQUIPMENT_WORD_RE = re.compile(
    r"\b(экскаватор-погрузчик|фронтальный\s+погрузчик|экскаватор|самосвал|шахман|shacman|бульдозер|автогрейдер|виброкаток|каток|коток|камаз|кдм|топливозаправщик|вахтовка|уаз|кму|прм)\b",
    re.I,
)
PLAIN_OPERATOR_RE = re.compile(r"^[А-ЯЁ][а-яё]+(?:\s*[А-ЯЁ]\.?){1,2}$")
PLATE_LIKE_RE = re.compile(r"^(?=.*\d)(?=.*[A-ZА-ЯЁ])[A-ZА-ЯЁ0-9]+$", re.I)
PLATE_TRANSLIT = str.maketrans({
    "A": "А",
    "B": "В",
    "C": "С",
    "E": "Е",
    "H": "Н",
    "K": "К",
    "M": "М",
    "O": "О",
    "P": "Р",
    "T": "Т",
    "X": "Х",
    "Y": "У",
})
FULL_PLATE_RE = re.compile(
    r"^(?:"
    r"[АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}|"
    r"[АВЕКМНОРСТУХ]?[0-9]{4}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}"
    r")$",
    re.I,
)
UNIT_NUMBER_LABEL = r"(?:б\s*/\s*н|борт(?:\.|овой)?(?:\s*(?:№|номер))?|инв(?:\.|ентарн(?:ый|ого)?)?(?:\s*(?:№|номер))?)"
PLATE_NUMBER_LABEL = r"(?:г\s*/\s*н|гос\.?\s*(?:номер|н)|госномер|государственн(?:ый|ого)?\s*номер|рег(?:\.|истрационн(?:ый|ого)?)?\s*(?:номер)?)"
UNIT_NUMBER_LABEL_RE = re.compile(UNIT_NUMBER_LABEL, re.I)
PLATE_NUMBER_LABEL_RE = re.compile(PLATE_NUMBER_LABEL, re.I)
NUMBER_MARKER_RE = re.compile(rf"(?:{UNIT_NUMBER_LABEL}|{PLATE_NUMBER_LABEL})", re.I)
NUMBER_STOP_RE = re.compile(rf"\s*(?:[;,]|\b(?:{UNIT_NUMBER_LABEL}|{PLATE_NUMBER_LABEL})\b)", re.I)
NUMBER_TOKEN_RE = re.compile(
    rf"\s*(?:{UNIT_NUMBER_LABEL}|{PLATE_NUMBER_LABEL})\s*[:№#-]?\s*.*?(?=\s*(?:[;,]|\b(?:{UNIT_NUMBER_LABEL}|{PLATE_NUMBER_LABEL})\b|$))",
    re.I,
)
STATUS_MAP = {
    "в работе": "working",
    "работа": "working",
    "working": "working",
    "ремонт": "repair",
    "в ремонт": "repair",
    "в ремонте": "repair",
    "repair": "repair",
    "простой": "standby",
    "в простое": "standby",
    "standby": "standby",
    "резерв": "standby",
    "вне": "out",
    "out": "out",
    "н/д": "unknown",
    "нд": "unknown",
    "unknown": "unknown",
}


def looks_like_full_plate(value: Any) -> bool:
    raw = clean_value(value).upper().replace("Ё", "Е").translate(PLATE_TRANSLIT)
    normalized = re.sub(r"[^0-9A-ZА-Я]", "", raw)
    return bool(FULL_PLATE_RE.fullmatch(normalized))
PARK_IMPORT_STATUSES = {"repair", "standby"}
WORKING_STATUS_RE = re.compile(r"\b(в\s+работе|работа(?:ет|ла|ли)?|working)\b", re.I)
REPAIR_STATUS_RE = re.compile(r"\b(?:в\s+)?ремонт\w*|\brepair\b", re.I)
STANDBY_STATUS_RE = re.compile(r"\bпрост\w*|\bstandby\b|\bрезерв\b", re.I)
STAFF_CATEGORY_RE = re.compile(
    r"^(?P<category>ИТР|ДР|дорожн(?:ые|ых)\s+рабоч(?:ие|их)|механизатор(?:ы|ов)|водител(?:и|ей)|машинист(?:ы|ов)|рабоч(?:ие|их))\s*[:：\-–—]?\s*(?P<count>\d+)\b",
    re.I,
)
MATERIAL_CODES = [
    ("SHPGS", re.compile(r"\b(щпгс|щпс)\b", re.I)),
    ("COARSE_SAND", re.compile(r"\b(?:крупн(?:ый|ого)\s+пес(?:ок|ка)|пес(?:ок|ка)\s+крупн(?:ый|ого)|крупнозернист(?:ый|ого)\s+пес(?:ок|ка))\b", re.I)),
    ("SAND", re.compile(r"\bпес", re.I)),
    ("PEAT", re.compile(r"\b(торф|непригод)", re.I)),
    ("SOIL", re.compile(r"\b(грунт|глин)", re.I)),
    ("CRUSHED_STONE", re.compile(r"\bщеб", re.I)),
]
WORK_TYPE_CODES = [
    ("CONSOLIDATION", re.compile(r"\bуплотнен", re.I)),
    ("DITCH_CONSTRUCTION", re.compile(r"\b(канава|кювет|водоотвод)", re.I)),
    ("EARTH_EXCAVATION", re.compile(r"\b(разработка\s+(?:выемки|грунта)|выемк)", re.I)),
    ("AREA_GRADING", re.compile(r"\b(планировк|профилирован)", re.I)),
    ("EMBANKMENT_CONSTRUCTION", re.compile(r"\bустройство\s+насып", re.I)),
    ("FLEXIBLE_GRILLAGE_GEOTEXTILE", re.compile(r"\b(гибк\w*\s+ростверк\w*.*гео\s*текст|гео\s*текст.*сва)", re.I)),
    ("GEOTEXTILE_LAYER_DO", re.compile(r"\b(гео\s*текст.*(?:5\s*кн|дсо)|(?:5\s*кн|дсо).*гео\s*текст)", re.I)),
    ("GEOTEXTILE_LAYER", re.compile(r"\b(геотекст|гео\s*текст)", re.I)),
    ("PAVEMENT_SANDING", re.compile(r"\b(дорожн(?:ой|ая)\s+одежд|дсо|дополнительн.*сло)", re.I)),
    ("TOPSOIL_STRIPPING", re.compile(r"\b(прс|растительн)", re.I)),
    ("SOIL_WORK", re.compile(r"\b(погруз|при[её]м|иссо|конус|накопител)", re.I)),
]
FILL_STATUS_FIELDS = (
    "pioneer_fill",
    "subgrade_not_to_grade",
    "dso",
    "ready_for_shpgs",
    "shpgs_done",
)
FILL_STATUS_LABELS = {
    "pioneer_fill": "пионерка",
    "subgrade_not_to_grade": "не в отметку",
    "dso": "ДСО",
    "ready_for_shpgs": "готово под ЩПГС",
    "shpgs_done": "под АБ",
}
FILL_STATUS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("shpgs_done", re.compile(r"\b(под\s*а\s*б|под\s+асфальт|щпгс\s+(?:отсыпан|уложен|готов))\b", re.I)),
    ("ready_for_shpgs", re.compile(r"\b(готов[оа]?\s+под\s+щпгс|под\s+щпгс|ожидается\s+щпгс|геотекстиль\s+уложен|работы\s+по\s+зп\s+завершены)\b", re.I)),
    ("dso", re.compile(r"\b(дсо|сдо|дополнительн\w*\s+сло\w*\s+основан)\b", re.I)),
    ("pioneer_fill", re.compile(r"\b(пионер\w*|выторф\w*|зп\s+в\s+работе\s+не\s+на\s+всю\s+ширину|не\s+на\s+всю\s+ширину)\b", re.I)),
    ("subgrade_not_to_grade", re.compile(r"\b(не\s+в\s+отметк\w*|устройств\w*\s+зп|зп\s+в\s+работе|землян\w*\s+полотн)\b", re.I)),
]
MAINLINE_FILL_STATUS_FIELDS = (
    "prep_works",
    "main_works",
    "protective_layer_2",
    "protective_layer_1",
    "asphalt_layer",
)
MAINLINE_FILL_STATUS_LABELS = {
    "prep_works": "ПРС",
    "main_works": "Основные работы",
    "protective_layer_2": "ЗС №2",
    "protective_layer_1": "ЗС №1",
    "asphalt_layer": "Асфальтобетон",
}
MAINLINE_FILL_STATUS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("asphalt_layer", re.compile(r"\b(асфальт|асфальтобетон|под\s*а\s*б|под\s+асфальт)\b", re.I)),
    ("protective_layer_1", re.compile(r"\b(зс\s*(?:№\s*)?1|защитн\w*\s+сло\w*\s*(?:№\s*)?1|щпгс|щпс|готов\w*\s+под\s+щпгс|под\s+щпгс)\b", re.I)),
    ("protective_layer_2", re.compile(r"\b(зс\s*(?:№\s*)?2|защитн\w*\s+сло\w*\s*(?:№\s*)?2|пгс|дсо|сдо|дополнительн\w*\s+сло)\b", re.I)),
    ("prep_works", re.compile(r"\b(прс|подготов\w*|срезк\w*\s+прс|растительн\w*|выторф\w*|замен\w*\s+грунт)\b", re.I)),
    ("main_works", re.compile(r"\b(основн\w*\s+работ|зп|землян\w*\s+полотн|выемк\w*|разработк\w*|насып\w*)\b", re.I)),
]
PERSON_MARKER = "__PERSON_MARKER__"
REPORT_START_RE = re.compile(r"(?im)^\s*Дата\s*[-–—]")


def split_report_texts(raw_text: str) -> list[str]:
    """Split a pasted/uploaded text bundle into individual daily reports."""
    text = (raw_text or "").replace("\r\n", "\n").replace("\r", "\n")
    starts = [match.start() for match in REPORT_START_RE.finditer(text)]
    if len(starts) <= 1:
        return [text]
    reports: list[str] = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(text)
        chunk = text[start:end].strip()
        if chunk:
            reports.append(chunk)
    return reports or [text]


def sanitize_personal_report_text(raw_text: str) -> str:
    """Remove personal names from report text before UI display or DB storage.

    The personnel section may contain useful headcount totals. Keep only
    category/count rows there and drop any name-like lines.
    """
    out: list[str] = []
    skip_personnel_section = False
    for raw_line in (raw_text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
        line = raw_line.strip()
        if not line:
            if not skip_personnel_section:
                out.append(raw_line)
            continue
        section_match = re.match(r"^===\s*(.+?)\s*===$", line)
        if section_match:
            title = section_match.group(1).strip().upper().replace("Ё", "Е")
            skip_personnel_section = title == "ПЕРСОНАЛ"
            out.append(raw_line)
            continue
        if skip_personnel_section:
            count_row = parse_staff_count_line(line)
            if count_row:
                out.append(f"{count_row['category']}: {count_row['count']}")
            continue
        if OPERATOR_RE.match(line):
            out.append("Исполнитель:")
            continue
        dash = CONSTRUCTIVE_RE.match(line)
        if dash and parse_plain_operator_line(clean_value(dash.group(1))):
            out.append("Исполнитель:")
            continue
        if parse_plain_operator_line(line):
            out.append("Исполнитель:")
            continue
        if line.startswith("%%") and re.search(r"ф\s*\.?\s*и\s*\.?\s*о|фио", line, re.I):
            continue
        if ";" in line and parse_equipment_line(line):
            parts = [clean_value(part) for part in line.split(";")]
            head = parts[0]
            kept_tail: list[str] = []
            for part in parts[1:]:
                if not part:
                    continue
                if looks_company(part) or parse_status(part) != "unknown":
                    kept_tail.append(part)
            out.append("; ".join([head, *kept_tail]) + (";" if kept_tail else ""))
            continue
        out.append(raw_line)
    return "\n".join(out)


def normalize_text(raw_text: str) -> tuple[str, list[str]]:
    comments: list[str] = []
    lines: list[str] = []
    for raw_line in (raw_text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
        line = raw_line.replace("\t", " ")
        line = re.sub(r"[ \u00a0]+", " ", line).strip()
        if not line:
            lines.append("")
            continue
        if line.startswith("%%"):
            comments.append(line.lstrip("%").strip())
            continue
        if line == "|":
            lines.append("")
            continue
        line = line.strip("|").strip()
        if not line:
            lines.append("")
            continue
        lines.append(line)
    return "\n".join(lines), comments


def to_float(value: str | None) -> Optional[float]:
    if not value:
        return None
    v = value.strip()
    if v.lower() in {"н/д", "нд", "-", "—"}:
        return None
    try:
        return float(v.replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def clean_value(value: str | None) -> str:
    return (value or "").strip().strip(";,. ")


def extract_haul_distance(value: str | None) -> tuple[str, Optional[float]]:
    text = value or ""
    match = HAUL_DISTANCE_RE.search(text)
    if not match:
        return text, None
    distance = to_float(match.group(1))
    cleaned = (text[:match.start()] + " " + text[match.end():]).replace("  ", " ")
    cleaned = re.sub(r"[/;,\s]+$", "", cleaned)
    cleaned = re.sub(r"^[ /;,]+", "", cleaned)
    return clean_value(cleaned), distance


def extract_work_hours(value: str | None) -> tuple[str, Optional[float]]:
    text = value or ""
    match = WORK_HOURS_RE.search(text)
    if not match:
        return text, None
    hours = to_float(match.group(1))
    cleaned = (text[:match.start()] + " " + text[match.end():]).replace("  ", " ")
    cleaned = re.sub(r"[/;,\s]+$", "", cleaned)
    return clean_value(cleaned), hours


def normalize_owner_label(value: str | None) -> str:
    """Canonicalize owner labels that are safe to resolve format-first.

    Field reports use several spellings for the same in-house owner, including
    legal-name wrappers such as `ООО «ЖДС»` and `«ООО ЖДС»`. Keep third-party
    company labels unchanged, but collapse these ЖДС variants to the canonical
    `ЖДС` so downstream enrichment does not treat them as hired equipment.
    """
    owner = clean_value(value)
    if not owner:
        return ""
    spaced = re.sub(r"[\"'«»“”„]+", " ", owner.lower().replace("ё", "е"))
    spaced = re.sub(r"\s+", " ", spaced).strip()
    compact = re.sub(r"[^0-9a-zа-я]+", "", spaced)
    if compact in {"ждс", "ооождс"} or re.search(r"(?:^|\b)(?:ооо\s+)?ждс(?:\b|$)", spaced):
        return "ЖДС"
    if (
        compact in {"желдорстрой", "ооожелдорстрой"}
        or re.search(r"(?:^|\b)(?:ооо\s+)?желдорстрой(?:\b|$)", spaced)
        or "жел дор строй" in spaced
        or "железнодорожное строительство" in spaced
    ):
        return "ЖЕЛДОРСТРОЙ"
    return owner


def normalize_unit(value: str | None, default: str = "м3") -> str:
    unit = clean_value(value) or default
    unit = unit.replace("м³", "м3").replace("м²", "м2")
    low = unit.lower().rstrip(".")
    if low == "ед":
        return "шт"
    if low == "шт":
        return "шт"
    return unit


def equipment_identifier_keys(row: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    for prefix, fields in (("plate", ("plate_number", "plate")), ("unit", ("unit_number",))):
        for field in fields:
            value = clean_value(row.get(field))
            if value and value.lower() not in {"н/д", "нд", "-", "—"}:
                key = f"{prefix}:{value.lower()}"
                if key not in keys:
                    keys.append(key)
                break
    return keys


def merge_equipment_row(target: dict[str, Any], source: dict[str, Any], *, infer_working: bool = False) -> None:
    if target.get("plate_number") and not target.get("plate"):
        target["plate"] = target.get("plate_number")
    if target.get("plate") and not target.get("plate_number"):
        target["plate_number"] = target.get("plate")

    source_status = clean_value(source.get("status")).lower()
    target_status = clean_value(target.get("status")).lower()
    if source_status and source_status != "unknown" and target_status in {"", "unknown"}:
        target["status"] = source.get("status")
    if infer_working and target_status in {"", "unknown"}:
        target["status"] = "working"

    for field in (
        "equipment_type",
        "brand_model",
        "reported_number",
        "unit_number",
        "plate_number",
        "plate",
        "owner",
        "contractor_name",
    ):
        if not target.get(field) and source.get(field):
            target[field] = source.get(field)

    source_comment = clean_value(source.get("comment"))
    target_comment = clean_value(target.get("comment"))
    if source_comment and source_comment != target_comment:
        target["comment"] = "; ".join(x for x in [target_comment, source_comment] if x)


def parse_date(value: str) -> str:
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", value or "")
    if not m:
        return date_cls.today().isoformat()
    return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"


def parse_shift(value: str) -> str:
    v = (value or "").lower()
    if "день" in v:
        return "day"
    if "ноч" in v:
        return "night"
    return "unknown"


def parse_section_code(value: str) -> str:
    m = re.search(r"№\s*(\d+)|участок\s*(\d+)", value or "", re.I)
    if not m:
        return ""
    num = m.group(1) or m.group(2)
    return f"UCH_{num}"


def normalize_pk_text(text: str | None) -> str:
    raw = clean_value(text)
    raw = raw.replace("\u00a0", " ")
    raw = raw.replace("–", "-").replace("—", "-").replace("−", "-")
    return re.sub(r"\s+", " ", raw).strip()


def _pk_parts(picket: str, plus: str | None = None) -> tuple[float, int, bool]:
    digits = re.sub(r"\D+", "", picket or "")
    if not digits:
        raise ValueError("empty picket")
    implicit_plus = plus is None and len(digits) >= 6
    if implicit_plus:
        picket_num = int(digits[:-2])
        plus_num = float(digits[-2:])
    else:
        picket_num = int(digits)
        plus_num = float((plus or "0").replace(",", "."))
    if plus_num < 0 or plus_num >= 100:
        raise ValueError("plus out of range")
    return picket_num * 100 + plus_num, picket_num, plus is not None or implicit_plus


def _pk_value(picket: str, plus: str | None = None) -> float:
    return _pk_parts(picket, plus)[0]


def _iter_pk_values(text: str, *, allow_bare: bool = False) -> list[tuple[int, float]]:
    raw = normalize_pk_text(text)
    values: list[tuple[int, float, int, bool, int]] = []
    for m in PK_TOKEN_RE.finditer(raw):
        prefix = m.group("prefix") or ""
        has_pk_prefix = bool(re.search(r"п\s*\.?\s*к", prefix, re.I))
        if not has_pk_prefix and not allow_bare:
            continue
        picket_text = m.group("picket")
        plus_text = m.group("plus")
        previous = values[-1] if values else None
        has_dash_before = bool(previous and "-" in raw[previous[4]: m.start()])
        if not has_pk_prefix and not plus_text and len(picket_text) <= 2:
            if previous and has_dash_before and previous[3]:
                plus = float(picket_text.replace(",", "."))
                values.append((m.start(), previous[2] * 100 + plus, previous[2], True, m.end()))
            continue
        try:
            value, picket_num, has_plus = _pk_parts(picket_text, plus_text)
        except ValueError:
            continue
        values.append((m.start(), value, picket_num, has_plus, m.end()))

    for m in PK_PLUS_CONTINUATION_RE.finditer(raw):
        previous = next((item for item in reversed(values) if item[4] <= m.start()), None)
        if not previous or "-" not in raw[previous[4]: m.start() + 1]:
            continue
        plus = float(m.group("plus").replace(",", "."))
        values.append((m.start(), previous[2] * 100 + plus, previous[2], True, m.end()))
    return [(start, value) for start, value, *_ in sorted(values, key=lambda x: x[0])]


def parse_pk_value(text: str) -> Optional[float]:
    raw = normalize_pk_text(text)
    allow_bare = bool(
        re.search(r"п\s*\.?\s*к", raw, re.I)
        or re.fullmatch(r"\d{1,7}(?:\s*(?:\+|[,.])\s*\d{1,2}(?:[,.]\d+)?)?", raw)
        or re.search(r"\d{1,7}\s*(?:\+|[,.])\s*\d{1,2}", raw)
        or re.search(r"\d{3,7}\s*[-]\s*\d{1,7}", raw)
    )
    values = _iter_pk_values(raw, allow_bare=allow_bare)
    return values[0][1] if values else None


def _strip_unlabeled_parenthetical_pk_ranges(raw: str) -> str:
    if not re.search(r"п\s*\.?\s*к", raw, re.I):
        return raw
    pk_prefix = r"(?:п\s*\.?\s*к\s*\.?\s*(?:[А-ЯA-Z]{1,8}\s*)?(?:[:：]\s*)?)?"
    pk_number = r"\d{1,7}(?:\s*(?:\+|[,.])\s*\d{1,2}(?:[,.]\d+)?)?"
    parenthetical_range_re = re.compile(rf"{pk_prefix}{pk_number}\s*-\s*{pk_prefix}{pk_number}", re.I)

    def repl(match: re.Match[str]) -> str:
        if not re.search(r"п\s*\.?\s*к", raw[: match.start()], re.I):
            return match.group(0)
        inner = match.group(1)
        if parenthetical_range_re.search(inner):
            return " "
        return match.group(0)

    return re.sub(r"\(([^()]*)\)", repl, raw)


def parse_pk_range(text: str) -> dict[str, Any]:
    raw = normalize_pk_text(text)
    parse_raw = _strip_unlabeled_parenthetical_pk_ranges(raw)
    values = _iter_pk_values(parse_raw, allow_bare=True)
    if not values:
        return {"start": None, "end": None, "raw": raw}
    first = values[0][1]
    last = values[-1][1]
    if len(values) > 1 and last < first:
        first, last = last, first
    return {"start": first, "end": last if len(values) > 1 else first, "raw": raw}


def rounded_pk(pk: Optional[float]) -> Optional[int]:
    if pk is None:
        return None
    return int(round(pk / 100))


def _format_pk_warning_value(value: Any) -> str:
    if value in (None, ""):
        return "—"
    pk = int(float(value) // 100)
    plus = float(value) - pk * 100
    plus_text = f"{int(plus):02d}" if plus.is_integer() else f"{plus:.2f}".replace(".", ",")
    return f"ПК{pk}+{plus_text}"


def append_pk_soft_warnings(warnings: list[str], rows: list[dict[str, Any]], *, label: str) -> None:
    """Add non-blocking hints for parsed report PK fields.

    The parser/import path must stay tolerant: bad PK text should surface for
    operator review instead of failing preview/import silently.
    """
    for row in rows:
        name = row.get("work_name") or row.get("name") or row.get("field_code") or row.get("comment") or label
        raw_fields = [
            ("ПК ВСЖМ", row.get("pk_rail_raw"), row.get("pk_rail_start"), row.get("pk_rail_end")),
            ("ПК АД", row.get("pk_ad_raw"), row.get("pk_ad_start"), row.get("pk_ad_end")),
            ("ПК", row.get("pk_raw_text") or row.get("pk_text"), row.get("pk_start"), row.get("pk_end")),
        ]
        for field_label, raw, start, end in raw_fields:
            if raw and start is None:
                warnings.append(
                    f"{label} '{name}': {field_label} '{raw}' не распознан; проверь формат или оставь через override"
                )


def infer_material_code(value: str | None) -> Optional[str]:
    for code, pattern in MATERIAL_CODES:
        if pattern.search(value or ""):
            return code
    return None


def looks_like_unknown_transport_material(value: str | None) -> bool:
    """Keep compact transport rows even when the material is not in our dictionary."""
    text = clean_value(value)
    if not text:
        return False
    if VOLUME_RE.search(text) or looks_like_transport_route_line(text) or parse_equipment_line(text):
        return False
    stripped = text.strip(" /\\")
    low = stripped.lower().replace("ё", "е")
    if not low:
        return False
    if low in {"прс", "плодородный слой", "растительный грунт"}:
        return True
    material_markers = (
        "материал",
        "грунт",
        "песок",
        "щпгс",
        "щпс",
        "щгпс",
        "пгс",
        "суглин",
        "супес",
        "скальн",
        "выемк",
        "отвал",
    )
    if not any(marker in low for marker in material_markers):
        return False
    work_verbs = (
        "устрой",
        "разработ",
        "уплотн",
        "планиров",
        "отсып",
        "срезк",
        "снят",
        "забив",
        "монтаж",
        "уклад",
        "погруж",
    )
    return not any(marker in low for marker in work_verbs)


def infer_work_type_code(value: str | None) -> Optional[str]:
    for code, pattern in WORK_TYPE_CODES:
        if pattern.search(value or ""):
            return code
    return None


def canonical_section_title(title: str | None) -> str:
    """Map human MAX headings to the deterministic parser's canonical buckets.

    Field teams do not consistently use the wizard's exact headers: `Возка`,
    `Транспорт`, `Выполненные работы` and similar variants are common. The
    parser stores sections in a dict and later reads fixed keys, so without this
    normalization an entire valid block can be silently ignored.
    """
    raw = clean_value(title)
    normalized = re.sub(r"^[#=\-–—\s]+|[#=\-–—\s:：]+$", "", raw).strip()
    low = normalized.lower().replace("ё", "е")
    compact = re.sub(r"[\s_\-–—:：]+", "", low)
    if not compact:
        return ""
    if "шапк" in compact:
        return "ШАПКА"
    if any(marker in compact for marker in ("перевоз", "возка", "транспорт", "завоз")):
        return "ПЕРЕВОЗКА"
    if "сопутств" in compact:
        return "СОПУТСТВУЮЩИЕ РАБОТЫ"
    if ("основ" in compact and "работ" in compact) or compact == "основные":
        return "ОСНОВНЫЕ РАБОТЫ"
    if compact in {"работы", "выполненныеработы", "работызасмену"} or ("работ" in compact and "парк" not in compact):
        return "РАБОТЫ"
    if "парк" in compact or compact == "техника":
        return "ПАРК ТЕХНИКИ"
    if "персонал" in compact or compact in {"люди", "сотрудники"}:
        return "ПЕРСОНАЛ"
    if "накоп" in compact:
        return "НАКОПИТЕЛИ"
    if "сва" in compact:
        return "ЗАБИВКА СВАЙ"
    if "проблем" in compact or "вопрос" in compact:
        return "ПРОБЛЕМНЫЕ ВОПРОСЫ"
    if ("отсып" in compact or "статус" in compact) and (
        "ох" in compact or "основнойход" in compact or "основногоход" in compact
    ):
        return "ДАННЫЕ ПО ОТСЫПКЕ ОХ"
    if "отсып" in compact or "статус" in compact:
        return "ДАННЫЕ ПО ОТСЫПКЕ"
    return normalized.upper().replace("Ё", "Е")


def split_sections(text: str) -> tuple[str, dict[str, str]]:
    matches = list(SECTION_RE.finditer(text or ""))
    if not matches:
        return text or "", {}
    header = text[: matches[0].start()]
    sections: dict[str, str] = {}
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        title = canonical_section_title(
            match.groupdict().get("boxed")
            or match.groupdict().get("hash")
            or match.groupdict().get("bare")
            or ""
        )
        body = text[start:end].strip()
        if title in sections and body:
            sections[title] = "\n".join(part for part in (sections[title], body) if part.strip())
        else:
            sections[title] = body
    return header, sections


def parse_header(header_text: str) -> dict[str, Any]:
    raw: dict[str, str] = {}
    delivery_info = ""
    for line in header_text.splitlines():
        if not line.strip():
            continue
        if line.lower().startswith("информация по завозу"):
            _, _, delivery_info = line.partition(":")
            delivery_info = delivery_info.strip()
            continue
        m = HEADER_RE.match(line)
        if m:
            raw[m.group(1).strip().lower()] = m.group(2).strip()
    report_date = parse_date(raw.get("дата", ""))
    shift = parse_shift(raw.get("смена", ""))
    section_name = raw.get("участок", "")
    return {
        "report_date": report_date,
        "shift": shift,
        "section_code": parse_section_code(section_name),
        "section_name": section_name,
        "direction": raw.get("направление", ""),
        "constructives": raw.get("конструктивы", ""),
        "delivery_info": delivery_info,
        "author": "",
    }


def normalize_staff_category(value: str) -> str:
    v = clean_value(value).lower().replace("ё", "е")
    if v == "итр":
        return "ИТР"
    if v == "др" or "дорож" in v:
        return "ДР"
    if "механизатор" in v or "машинист" in v:
        return "Механизаторы"
    if "водител" in v:
        return "Водители"
    if "рабоч" in v:
        return "Рабочие"
    return clean_value(value)


def parse_staff_count_line(line: str) -> Optional[dict[str, Any]]:
    m = STAFF_CATEGORY_RE.match(clean_value(line))
    if not m:
        return None
    return {
        "category": normalize_staff_category(m.group("category")),
        "count": int(m.group("count")),
    }


def parse_staff_counts(body: str) -> list[dict[str, Any]]:
    by_category: dict[str, int] = {}
    for line in (body or "").splitlines():
        parsed = parse_staff_count_line(line)
        if not parsed:
            continue
        category = parsed["category"]
        by_category[category] = by_category.get(category, 0) + int(parsed["count"] or 0)
    order = ["ИТР", "ДР", "Механизаторы", "Водители", "Рабочие"]
    return [
        {"category": category, "count": by_category[category]}
        for category in order
        if category in by_category
    ] + [
        {"category": category, "count": count}
        for category, count in by_category.items()
        if category not in order
    ]


def parse_operator_line(line: str) -> Optional[str]:
    if ROLE_MARKER_RE.match(line.strip()):
        return PERSON_MARKER
    m = OPERATOR_RE.match(line.strip())
    if not m:
        return None
    return PERSON_MARKER


def parse_dash_person_line(line: str) -> Optional[str]:
    m = CONSTRUCTIVE_RE.match(line)
    if not m:
        return None
    value = clean_value(m.group(1))
    if ROLE_MARKER_RE.match(value):
        return PERSON_MARKER
    return PERSON_MARKER if parse_plain_operator_line(value) else None


def parse_plain_operator_line(line: str) -> Optional[str]:
    value = (line or "").strip().strip("; ")
    if PLAIN_OPERATOR_RE.match(value):
        return value
    return None


def split_inline_operator_equipment(value: str) -> tuple[str, Optional[str]]:
    m = EQUIPMENT_WORD_RE.search(value or "")
    if not m or m.start() == 0:
        return clean_value(value), None
    return clean_value(value[: m.start()]), clean_value(value[m.start():])


def parse_numbers(numbers: str) -> dict[str, Optional[str]]:
    def clean_identifier(value: str | None) -> Optional[str]:
        v = clean_value(value)
        v = re.sub(r"^(?:№|#|n|no|номер)\s*", "", v, flags=re.I)
        v = clean_value(v)
        if not v or v.lower() in {"н/д", "нд", "-", "—"}:
            return None
        return re.sub(r"\s+", "", v)

    def extract_labeled(pattern: re.Pattern[str], text: str) -> Optional[str]:
        for match in pattern.finditer(text):
            tail = text[match.end():]
            stop = NUMBER_STOP_RE.search(tail)
            value = tail[: stop.start()] if stop else tail
            cleaned = clean_identifier(value)
            if cleaned:
                return cleaned
        return None

    unit_number = extract_labeled(UNIT_NUMBER_LABEL_RE, numbers)
    plate_number = extract_labeled(PLATE_NUMBER_LABEL_RE, numbers)
    if unit_number or plate_number:
        return {"unit_number": unit_number or None, "plate_number": plate_number or None}

    parts = [clean_identifier(part) for part in re.split(r"[;,]", numbers)]
    parts = [part for part in parts if part]
    if len(parts) >= 2:
        unit_number = parts[0]
        plate_number = parts[1]
    elif len(parts) == 1:
        unit_number = parts[0]
    return {"unit_number": unit_number or None, "plate_number": plate_number or None}


def strip_number_markers(value: str) -> str:
    stripped = NUMBER_TOKEN_RE.sub(" ", value)
    stripped = re.sub(r"\s*[;,]\s*", " ", stripped)
    return clean_value(re.sub(r"\s+", " ", stripped))


def normalize_equipment_left(value: str) -> str:
    fixed = clean_value(value)
    for word in ("Самосвал", "Шахман", "SHACMAN", "Бульдозер", "Экскаватор", "Автогрейдер", "Виброкаток", "Каток", "Коток"):
        fixed = re.sub(rf"^({word})(?=[A-ZА-ЯЁ])", r"\1 ", fixed, flags=re.I)
    return re.sub(r"\s+", " ", fixed).strip()


def split_equipment_name(left: str) -> tuple[str, Optional[str]]:
    parts = normalize_equipment_left(left).split(None, 1)
    if not parts:
        return "unknown", None
    first = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else None
    if first == "коток":
        first = "каток"
    if first == "фронтальный" and rest and rest.lower().startswith("погрузчик"):
        tail = rest.split(None, 1)
        return "фронтальный погрузчик", tail[1] if len(tail) > 1 else None
    return first, rest


def split_trailing_unit_from_model(equipment_type: str, brand_model: str | None) -> tuple[str | None, Optional[str]]:
    if not brand_model:
        return brand_model, None
    m = re.match(r"^(.+\S)\s+([A-ZА-ЯЁ]?\d{2,4}[A-ZА-ЯЁ]?)$", brand_model, re.I)
    if not m:
        return brand_model, None
    prefix = m.group(1)
    unit = m.group(2)
    if equipment_type == "самосвал" or re.search(r"\d", prefix):
        return prefix, unit
    return brand_model, None


def split_equipment_line(line: str) -> Optional[tuple[str, str, str]]:
    raw = line.strip()
    m = VEHICLE_RE.match(raw)
    if m:
        return clean_value(m.group(1)), m.group(2), clean_value(m.group(3))

    paren = re.match(r"^(.+?)\s*\(([^)]*)\)\s*(?:[;,]?\s*(.+?))?\s*$", raw)
    if paren and EQUIPMENT_WORD_RE.search(paren.group(1)) and (NUMBER_MARKER_RE.search(paren.group(2)) or any(parse_numbers(paren.group(2)).values())):
        return clean_value(paren.group(1)), paren.group(2), clean_value(paren.group(3))

    if ";" in raw:
        left_with_numbers, tail = raw.rsplit(";", 1)
        if NUMBER_MARKER_RE.search(left_with_numbers):
            left = strip_number_markers(left_with_numbers)
            if left:
                return left, left_with_numbers, clean_value(tail)
        if EQUIPMENT_WORD_RE.search(left_with_numbers):
            return clean_value(left_with_numbers), "", clean_value(tail)

    if NUMBER_MARKER_RE.search(raw):
        left = strip_number_markers(raw)
        if left and left != raw:
            return left, raw, ""
    return None


def parse_equipment_line(line: str, _person_marker: str | None = None) -> Optional[dict[str, Any]]:
    parsed = split_equipment_line(line)
    if not parsed:
        return None
    left, numbers, owner = parsed
    owner = normalize_owner_label(owner)
    nums = parse_numbers(numbers)
    equipment_type, brand_model = split_equipment_name(left)
    if nums["unit_number"] and not nums["plate_number"] and PLATE_LIKE_RE.match(nums["unit_number"]):
        brand_model, inferred_unit = split_trailing_unit_from_model(equipment_type, brand_model)
        if inferred_unit:
            nums["plate_number"] = nums["unit_number"]
            nums["unit_number"] = inferred_unit
    if nums["unit_number"] and not nums["plate_number"] and looks_like_full_plate(nums["unit_number"]):
        nums["plate_number"] = nums["unit_number"]
        nums["unit_number"] = None
    reported_number = None
    if nums["unit_number"] and not nums["plate_number"] and not NUMBER_MARKER_RE.search(numbers):
        reported_number = nums["unit_number"]
    return {
        "equipment_type": equipment_type,
        "brand_model": brand_model,
        "reported_number": reported_number,
        "unit_number": nums["unit_number"],
        "plate_number": nums["plate_number"],
        "plate": nums["plate_number"],
        "owner": owner,
        "contractor_name": owner,
        "status": "unknown",
        "comment": None,
    }


def parse_quantity(value: str | None, default_unit: str = "м3") -> dict[str, Any]:
    text = clean_value(value)
    explicit_unit = re.search(rf"(?<!\w)({UNIT_RE_PART})(?!\w)", text, re.I)
    unit = normalize_unit(explicit_unit.group(1) if explicit_unit else default_unit, default_unit)
    if "№" in text:
        return {"volume": None, "unit": unit}
    m = re.search(r"(\d[\d\s]*(?:[,.]\d+)?)", text)
    return {
        "volume": to_float(m.group(1)) if m else None,
        "unit": unit,
    }


def _looks_like_truck_brand(value: str | None) -> bool:
    low = clean_value(value).lower().replace("ё", "е")
    return low in {"faw", "фав", "shacman", "шахман", "камаз", "маз"}


def split_transport_equipment_left(left: str) -> tuple[str, str]:
    """Split compact transport prefix into `(number, equipment_text)`.

    Transport rows are often written by indirect cues, e.g. `FAW б/н 718 / ...`
    or `807(с527хв27) / ...`: no leading `Номер`, but volume + trips + owner
    make it a transport unit. Keep the default conservative: a row in the
    transport block is a dump truck unless an explicit equipment word says else.
    """
    value = clean_value(re.sub(r"^номер\s+", "", left or "", flags=re.I))
    if not value:
        return "", "самосвал"
    marker = NUMBER_MARKER_RE.search(value)
    if marker:
        prefix = clean_value(value[: marker.start()])
        number = clean_value(value[marker.start():])
        equipment_text = prefix or "самосвал"
        if _looks_like_truck_brand(equipment_text):
            equipment_text = f"самосвал {equipment_text.upper() if equipment_text.isascii() else equipment_text}"
        return number, equipment_text
    composite = re.fullmatch(r"(?P<unit>\d{2,4})\s*\((?P<plate>[^)]+)\)", value, re.I)
    if composite:
        return value, "самосвал"
    m = re.match(r"^(?P<prefix>.+?)\s+(?P<number>[A-ZА-ЯЁ]?\d[0-9A-ZА-ЯЁ()\-]+)$", value, re.I)
    if m and (EQUIPMENT_WORD_RE.search(m.group("prefix")) or _looks_like_truck_brand(m.group("prefix"))):
        equipment_text = clean_value(m.group("prefix"))
        if _looks_like_truck_brand(equipment_text):
            equipment_text = f"самосвал {equipment_text.upper() if equipment_text.isascii() else equipment_text}"
        return clean_value(m.group("number")), equipment_text
    return value, "самосвал"


def compact_equipment_row(
    number: str,
    equipment_text: str,
    owner: str,
    *,
    volume: Optional[float] = None,
    unit: Optional[str] = None,
) -> dict[str, Any]:
    equipment_type, brand_model = split_equipment_name(equipment_text or "техника")
    reported_number = clean_value(number)
    owner_label = normalize_owner_label(owner)
    composite = re.fullmatch(r"(?P<unit>\d{2,4})\s*\((?P<plate>[^)]+)\)", reported_number, re.I)
    if composite:
        nums = {"unit_number": clean_value(composite.group("unit")), "plate_number": clean_value(composite.group("plate"))}
    elif NUMBER_MARKER_RE.search(reported_number):
        nums = parse_numbers(reported_number)
    elif reported_number and PLATE_LIKE_RE.match(reported_number):
        nums = {"unit_number": None, "plate_number": reported_number}
    else:
        nums = {"unit_number": reported_number or None, "plate_number": None}
    vehicle = " ".join(x for x in [equipment_type, brand_model] if x)
    row = {
        "equipment_type": equipment_type,
        "brand_model": brand_model,
        "reported_number": reported_number or None,
        "unit_number": nums["unit_number"],
        "plate_number": nums["plate_number"],
        "plate": nums["plate_number"],
        "owner": owner_label,
        "contractor_name": owner_label,
        "status": "working",
        "comment": None,
        "vehicle": vehicle,
    }
    if volume is not None:
        row["volume"] = volume
    if unit:
        row["unit"] = unit
    return row


def parse_compact_transport_row(line: str, route: tuple[str, str] | None, material: str | None, route_distance_km: Optional[float] = None) -> Optional[dict[str, Any]]:
    if not route or not material:
        return None
    line, work_hours = extract_work_hours(line)
    line, row_distance_km = extract_haul_distance(line)
    haul_distance_km = row_distance_km if row_distance_km is not None else route_distance_km
    m = COMPACT_NUMBER_ROW_RE.match(line)
    fleet = None if m else COMPACT_FLEET_ROW_RE.match(line)
    slash = None if (m or fleet) else COMPACT_TRANSPORT_SLASH_ROW_RE.match(line)
    if not m and not slash and not fleet:
        return None
    if m or slash:
        if m:
            raw_left = m.group(1)
            qty_text = m.group(2)
            trips_text = m.group(3)
            owner = clean_value(m.group(4))
        else:
            raw_left = slash.group("left")
            qty_text = slash.group("qty")
            trips_text = slash.group("trips")
            owner = clean_value(slash.group("owner"))
        number, equipment_text = split_transport_equipment_left(raw_left)
        qty = parse_quantity(qty_text, "м3")
        eq = compact_equipment_row(number, equipment_text, owner)
        equipment_count = 1
    else:
        qty = parse_quantity(fleet.group("qty"), "м3")
        trips_text = fleet.group("trips")
        owner = normalize_owner_label(fleet.group("owner"))
        equipment_count = int(fleet.group("count"))
        eq = {
            "equipment_type": "самосвал",
            "brand_model": None,
            "reported_number": None,
            "unit_number": None,
            "plate_number": None,
            "plate": None,
            "owner": owner,
            "contractor_name": owner,
            "status": "working",
            "comment": f"агрегированная строка: {equipment_count} а/с",
            "vehicle": "самосвал",
            "equipment_count": equipment_count,
        }
    trips_match = re.search(r"(\d+)", trips_text)
    return {
        **eq,
        "trips": [{
            "material": material,
            "material_code": infer_material_code(material),
            "from": route[0],
            "to": route[1],
            "from_location": route[0],
            "to_location": route[1],
            "volume": qty["volume"],
            "unit": qty["unit"],
            "trips": int(trips_match.group(1)) if trips_match else 0,
            "trip_count": int(trips_match.group(1)) if trips_match else 0,
            "equipment_count": equipment_count,
            "haul_distance_km": haul_distance_km,
            "work_hours": work_hours,
        }],
        "comments": [],
    }


def parse_compact_work_equipment_row(line: str) -> Optional[dict[str, Any]]:
    line, work_hours = extract_work_hours(line)
    fleet = COMPACT_WORK_FLEET_ROW_RE.match(line)
    if fleet:
        qty = parse_quantity(fleet.group("qty"), "м3")
        count = int(fleet.group("count"))
        equipment_type, brand_model = split_equipment_name(fleet.group("equipment") or "техника")
        owner = normalize_owner_label(fleet.group("owner"))
        row = {
            "equipment_type": equipment_type,
            "brand_model": brand_model,
            "reported_number": None,
            "unit_number": None,
            "plate_number": None,
            "plate": None,
            "owner": owner,
            "contractor_name": owner,
            "status": "working",
            "comment": f"агрегированная строка: {count} ед. техники",
            "vehicle": " ".join(x for x in [equipment_type, brand_model] if x),
            "equipment_count": count,
            "hired_count": count,
            "volume": qty["volume"],
            "unit": qty["unit"],
        }
        if work_hours is not None:
            row["work_hours"] = work_hours
        return row
    m = COMPACT_NUMBER_ROW_RE.match(line)
    if not m:
        return None
    qty = parse_quantity(m.group(2), "м3")
    row = compact_equipment_row(
        m.group(1),
        m.group(3),
        m.group(4),
        volume=qty["volume"],
        unit=qty["unit"],
    )
    if work_hours is not None:
        row["work_hours"] = work_hours
    return row


def parse_shorthand_equipment_volume_row(line: str) -> Optional[dict[str, Any]]:
    """Parse free-form rows like `Самосвал FAW (188) - 6р - 102,7 м3`.

    Section-1 MAX reports often use this compact human format instead of the
    wizard format with explicit FIO/equipment/volume lines. Keep it deterministic:
    parse only if an equipment-looking prefix and a trailing quantity are both
    present.
    """
    m = SHORTHAND_EQUIPMENT_VOLUME_RE.match(line)
    if not m:
        return None
    eq = parse_equipment_line(m.group("equipment"))
    if not eq:
        return None
    eq["owner"] = None
    eq["contractor_name"] = None
    eq["status"] = "working"
    eq["volume"] = to_float(m.group("volume"))
    eq["unit"] = normalize_unit(m.group("unit"), "м3")
    if m.group("trips"):
        eq["trips"] = int(m.group("trips"))
        eq["trip_count"] = int(m.group("trips"))
    eq["vehicle"] = " ".join(x for x in [eq.get("equipment_type"), eq.get("brand_model")] if x)
    return eq


def parse_status(value: str | None) -> str:
    v = clean_value(value).lower().replace("ё", "е")
    if v in STATUS_MAP:
        return STATUS_MAP[v]
    if STANDBY_STATUS_RE.search(v):
        return "standby"
    if REPAIR_STATUS_RE.search(v):
        return "repair"
    if WORKING_STATUS_RE.search(v):
        return "working"
    return "unknown"


def split_compact_route_text(value: str) -> Optional[tuple[str, str]]:
    text = clean_value(value)
    text = re.sub(r"^[-–—=\s]+|[-–—=\s]+$", "", text).strip()
    for arrow in ("→", "->"):
        if arrow in text:
            src, _, dst = text.partition(arrow)
            return clean_value(src), clean_value(dst)
    dash = re.search(r"\s+[-–—]\s+", text)
    if dash:
        return clean_value(text[: dash.start()]), clean_value(text[dash.end():])
    compact_dash = re.search(r"(?i)(?P<src>.+?)\s*[-–—]\s*(?P<dst>(?:АД\s*\d|Мост|ПК\s*\d|свайн|пионерк|тех\.?\s*проезд).+)", text)
    if compact_dash and re.search(r"(?i)(карьер|накопител|резерв|боковой\s+резерв|песка|щпгс|грунта)", compact_dash.group("src")):
        return clean_value(compact_dash.group("src")), clean_value(compact_dash.group("dst"))
    return None


def looks_like_transport_route_heading(value: str) -> bool:
    """Return True for MAX transport direction rows with only an opening sign.

    Field messages often write `-карьер Васильки - АД14 ПК...` or
    `- Накопитель ПК3089 - АД12 ...` without the closing dash that the compact
    template used. Treat such opening-sign rows as route headings only when both
    sides look like route endpoints; do not steal work constructives such as
    `-АД14-` or arbitrary prose.
    """
    text = clean_value(value)
    if not re.match(r"^\s*[-–—=]", text):
        return False
    inner = re.sub(r"^\s*[-–—=]+\s*|\s*[-–—=]+\s*$", "", text).strip()
    if not inner or len(inner) < 6:
        return False
    if MAT_OR_WORK_RE.match(inner) or SECTION_RE.match(inner):
        return False
    if infer_work_type_code(inner) and not looks_like_transport_route_line(inner):
        return False
    route = split_compact_route_text(inner)
    if not route:
        return False
    src, dst = route
    if endpoint_is_section_marker(src) or endpoint_is_section_marker(dst):
        return False
    route_words = re.compile(r"(карьер|накопител|ад\s*\d|мост|свайн|пионерк|пк\s*\d|тех\.?\s*проезд|резерв)", re.I)
    return bool(route_words.search(src) and route_words.search(dst))


def is_section_marker_line(line: str) -> bool:
    return bool(SECTION_RE.match(clean_value(line)))


def endpoint_is_section_marker(value: str | None) -> bool:
    text = clean_value(value)
    if not text:
        return False
    # Only reject a bare block heading that leaked into a route. Do not classify
    # legitimate endpoints such as `свайная площадка ПК ...` as the piles block.
    bare = re.sub(r"^=+|=+$", "", text).strip().lower().replace("ё", "е")
    bare = re.sub(r"\s+", " ", bare)
    return bare in {
        "перевозка",
        "работы",
        "основные работы",
        "сопутствующие работы",
        "парк техники",
        "персонал",
        "накопители",
        "забивка свай",
        "проблемные вопросы",
        "данные по отсыпке",
    }


def park_status_comment(value: str | None, status: str) -> Optional[str]:
    text = clean_value(value)
    if not text:
        return None
    lowered = text.lower().replace("ё", "е")
    if lowered in STATUS_MAP:
        return None
    if status == "repair":
        stripped = re.sub(r"^\s*(?:в\s+)?ремонт\w*\s*[-:,.]?\s*", "", text, flags=re.I)
    elif status == "standby":
        stripped = re.sub(r"^\s*(?:в\s+)?прост\w*(?:\s+по\s+причине)?\s*[-:,.]?\s*", "", text, flags=re.I)
    else:
        stripped = text
    stripped = clean_value(stripped)
    return stripped or None


def looks_company(value: str) -> bool:
    v = value.lower()
    return any(marker in v for marker in ("ооо", "ждс", "алмаз", "рейл", "логистик", "ао", "зао"))


def parse_transport(body: str) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_material: str | None = None
    pending_route: tuple[str, str] | None = None
    compact_route: tuple[str, str] | None = None
    compact_material: str | None = None
    compact_distance_km: Optional[float] = None
    pending_distance_km: Optional[float] = None
    for line in body.splitlines():
        if not line.strip():
            continue
        if is_section_marker_line(line):
            if current:
                units.append(current)
                current = None
            current_material = None
            pending_route = None
            compact_route = None
            compact_material = None
            compact_distance_km = None
            pending_distance_km = None
            continue
        route_material = ROUTE_MATERIAL_RE.match(line)
        if route_material:
            if current:
                units.append(current)
                current = None
            from_text, from_distance = extract_haul_distance(route_material.group(1))
            to_text, to_distance = extract_haul_distance(route_material.group(2))
            material_text, material_distance = extract_haul_distance(route_material.group(3))
            compact_route = (clean_value(from_text), clean_value(to_text))
            compact_material = clean_value(material_text)
            compact_distance_km = material_distance if material_distance is not None else (to_distance if to_distance is not None else from_distance)
            current_material = None
            pending_route = None
            pending_distance_km = None
            continue
        route_match = ROUTE_RE.match(line)
        route_label = ROUTE_LABEL_RE.match(line)
        loose_route_candidate = None
        if not route_match and not route_label and (("→" in line or "->" in line) or looks_like_transport_route_heading(line)):
            loose_route_candidate = split_compact_route_text(line)
        if route_match or route_label or loose_route_candidate:
            route_text = clean_value(
                route_label.group(1)
                if route_label
                else (route_match.group(1) or route_match.group(2) if route_match else line)
            )
            route_text, route_distance_km = extract_haul_distance(route_text)
            labeled_material = None
            material_in_route = MATERIAL_LABEL_RE.search(route_text)
            if material_in_route:
                labeled_material = clean_value(material_in_route.group(1))
                route_text = clean_value(route_text[: material_in_route.start()])
            compact_route_candidate = loose_route_candidate or split_compact_route_text(route_text) or parse_route_from_work_title(route_text)
            if current is not None and compact_route_candidate:
                if not (endpoint_is_section_marker(compact_route_candidate[0]) or endpoint_is_section_marker(compact_route_candidate[1])):
                    pending_route = compact_route_candidate
                    pending_distance_km = route_distance_km
                    if labeled_material:
                        current_material = labeled_material
                continue
            if route_label or (route_match and route_match.group(1) is not None) or compact_route_candidate:
                if current:
                    units.append(current)
                    current = None
                if compact_route_candidate:
                    if endpoint_is_section_marker(compact_route_candidate[0]) or endpoint_is_section_marker(compact_route_candidate[1]):
                        compact_route = None
                    else:
                        compact_route = compact_route_candidate
                else:
                    compact_route = (route_text, "")
                compact_material = labeled_material
                compact_distance_km = route_distance_km
                current_material = None
                pending_route = None
                pending_distance_km = None
                continue
        material_label = MATERIAL_LABEL_RE.match(line)
        if material_label:
            material_text = clean_value(material_label.group(1))
            if compact_route:
                compact_material = material_text
            elif current is not None:
                current_material = material_text
            continue
        if compact_route and (
            parse_plain_constructive_heading(line)
            or PK_LINE_RE.match(line)
            or (
                infer_work_type_code(line)
                and not looks_like_unknown_transport_material(line)
                and not looks_like_transport_quantity_line(line)
                and not looks_like_transport_route_line(line)
            )
        ):
            compact_route = None
            compact_material = None
            compact_distance_km = None
            current_material = None
            pending_route = None
            pending_distance_km = None
            continue
        if compact_route and (
            infer_material_code(line) or looks_like_unknown_transport_material(line)
        ) and not VOLUME_RE.search(line) and not parse_equipment_line(line):
            compact_material = clean_value(line)
            continue
        compact_row = parse_compact_transport_row(line, compact_route, compact_material, compact_distance_km)
        if compact_row:
            units.append(compact_row)
            continue
        operator = parse_operator_line(line) or parse_dash_person_line(line)
        if operator is not None:
            if current:
                units.append(current)
            current = {"trips": [], "comments": []}
            current_material = None
            pending_route = None
            pending_distance_km = None
            compact_route = None
            compact_material = None
            compact_distance_km = None
            continue
        if line.startswith("%%"):
            if current is not None:
                current["comments"].append(line.lstrip("%").strip())
            continue
        mat = MAT_OR_WORK_RE.match(line)
        if mat and compact_route:
            compact_material = clean_value(mat.group(1))
            continue
        if current is None:
            continue
        eq = parse_equipment_line(line)
        if eq and not current.get("vehicle"):
            current.update(eq)
            current["vehicle"] = " ".join(x for x in [eq.get("equipment_type"), eq.get("brand_model")] if x)
            continue
        if mat:
            current_material = clean_value(mat.group(1))
            pending_route = None
            pending_distance_km = None
            continue
        if current_material and (("→" in line or "->" in line) or looks_like_transport_route_heading(line)):
            route_line, route_distance_km = extract_haul_distance(line)
            compact_route_candidate = split_compact_route_text(route_line)
            if compact_route_candidate:
                pending_route = compact_route_candidate
                pending_distance_km = route_distance_km
            continue
        vol = VOLUME_TRIPS_RE.search(line)
        if vol and current_material and pending_route:
            unit = normalize_unit(vol.group(2), "м3")
            current["trips"].append({
                "material": current_material,
                "material_code": infer_material_code(current_material),
                "from": pending_route[0],
                "to": pending_route[1],
                "from_location": pending_route[0],
                "to_location": pending_route[1],
                "volume": to_float(vol.group(1)),
                "unit": unit,
                "trips": int(vol.group(3)),
                "trip_count": int(vol.group(3)),
                "haul_distance_km": pending_distance_km,
            })
            pending_route = None
            pending_distance_km = None
    if current:
        units.append(current)
    return units


def make_work_row(name: str, constructive: str | None) -> dict[str, Any]:
    return {
        "constructive": constructive,
        "constructive_code": None,
        "work_name": clean_value(name),
        "work_type_code": infer_work_type_code(name),
        "pk_rail_start": None,
        "pk_rail_end": None,
        "pk_rail_raw": None,
        "pk_ad_start": None,
        "pk_ad_end": None,
        "pk_ad_raw": None,
        "pk_start": None,
        "pk_end": None,
        "volume": None,
        "unit": None,
        "volume_note": None,
        "equipment": [],
        "performers": [],
        "_pending_volume": None,
        "comments": [],
    }


def parse_plain_constructive_heading(line: str) -> Optional[str]:
    value = clean_value(line)
    if not value.endswith(":"):
        return None
    title = clean_value(value[:-1])
    if not title:
        return None
    low = title.lower().replace("ё", "е")
    if low.startswith(("пк", "номер", "направлен", "информация")):
        return None
    if SECTION_RE.match(title):
        return None
    if VOLUME_RE.search(title) or COMPACT_NUMBER_ROW_RE.match(title):
        return None
    return title


def is_plain_work_heading(line: str, current_constructive: str | None = None) -> bool:
    value = clean_value(line)
    if not value or len(value) < 4:
        return False
    low = value.lower().replace("ё", "е")
    if low.startswith(("пк", "номер", "итого", "всего", "направления перевозки")):
        return False
    if value.startswith(("-", "=", "%")):
        return False
    if COMPACT_NUMBER_ROW_RE.match(value) or VOLUME_RE.search(value) or parse_equipment_line(value):
        return False
    if parse_plain_operator_line(value) or parse_operator_line(value) is not None:
        return False
    return bool(re.search(r"[А-Яа-яЁё]", value)) and (current_constructive is not None or bool(NUMBERED_WORK_RE.match(value)))


def apply_pk_from_text(row: dict[str, Any], text: str) -> None:
    parsed = parse_pk_range(text)
    if parsed.get("start") is None:
        return
    row["pk_rail_start"] = parsed["start"]
    row["pk_rail_end"] = parsed["end"]
    row["pk_rail_raw"] = parsed["raw"]
    row["pk_start"] = parsed["start"]
    row["pk_end"] = parsed["end"]


def parse_inline_no_equipment_work(line: str, constructive: str | None = None) -> Optional[dict[str, Any]]:
    value = clean_value(line)
    if not value:
        return None
    low = value.lower().replace("ё", "е")
    if not re.search(r"гео\s*текст|геотекст", low, re.I):
        return None
    volume_match = VOLUME_RE.search(value)
    if not volume_match:
        return None
    before = clean_value(value[:volume_match.start()])
    after = clean_value(value[volume_match.end():])
    name = before or re.sub(r"\s+", " ", VOLUME_RE.sub(" ", value)).strip()
    if not name or not re.search(r"гео\s*текст|геотекст", name.lower().replace("ё", "е"), re.I):
        return None
    row = make_work_row(name, constructive)
    row["volume"] = to_float(volume_match.group(1))
    row["unit"] = normalize_unit(volume_match.group(2), "м2")
    note = clean_value(volume_match.group(3))
    if note:
        row["volume_note"] = note
    apply_pk_from_text(row, value)
    if after and not row.get("volume_note"):
        row["volume_note"] = after
    return row


def finalize_work(current: dict[str, Any] | None, out: list[dict[str, Any]]) -> None:
    if not current:
        return
    equipment = current.get("equipment") or []
    with_individual = [eq for eq in equipment if eq.get("volume") is not None]
    performers = current.get("performers") or []
    common_equipment_volume = (
        len(with_individual) == 1
        and len(equipment) > 1
        and current.get("volume") == with_individual[0].get("volume")
    )

    def drop_internal(item: dict[str, Any]) -> None:
        item.pop("_last_equipment_index", None)
        item.pop("performers", None)
        item.pop("_pending_volume", None)

    if (with_individual and not common_equipment_volume) or performers:
        for eq in with_individual:
            item = dict(current)
            item["equipment"] = [eq]
            item["plate"] = eq.get("plate_number")
            item["plate_number"] = eq.get("plate_number")
            item["unit_number"] = eq.get("unit_number")
            item["vehicle"] = " ".join(x for x in [eq.get("equipment_type"), eq.get("brand_model")] if x)
            item["owner"] = eq.get("owner")
            item["volume"] = eq.get("volume")
            item["unit"] = eq.get("unit") or current.get("unit")
            drop_internal(item)
            out.append(item)
        for eq in equipment:
            if eq.get("volume") is not None:
                continue
            item = dict(current)
            item["equipment"] = [eq]
            item["plate"] = eq.get("plate_number")
            item["plate_number"] = eq.get("plate_number")
            item["unit_number"] = eq.get("unit_number")
            item["vehicle"] = " ".join(x for x in [eq.get("equipment_type"), eq.get("brand_model")] if x)
            item["owner"] = eq.get("owner")
            item["volume"] = None
            item["unit"] = current.get("unit")
            drop_internal(item)
            out.append(item)
        for performer in performers:
            item = dict(current)
            if len(equipment) == 1:
                item["equipment"] = [equipment[0]]
            else:
                item["equipment"] = []
            item["volume"] = performer.get("volume")
            item["unit"] = performer.get("unit") or current.get("unit")
            if equipment:
                first = equipment[0]
                item["plate"] = first.get("plate_number")
                item["plate_number"] = first.get("plate_number")
                item["unit_number"] = first.get("unit_number")
                item["vehicle"] = " ".join(x for x in [first.get("equipment_type"), first.get("brand_model")] if x)
                item["owner"] = first.get("owner")
            drop_internal(item)
            out.append(item)
    else:
        item = dict(current)
        item["equipment"] = []
        for eq in equipment:
            eq_item = dict(eq)
            if common_equipment_volume and eq_item.get("volume") == current.get("volume"):
                eq_item.pop("volume", None)
                eq_item.pop("unit", None)
            item["equipment"].append(eq_item)
        if equipment:
            first = equipment[0]
            item["plate"] = first.get("plate_number")
            item["plate_number"] = first.get("plate_number")
            item["unit_number"] = first.get("unit_number")
            item["vehicle"] = " ".join(x for x in [first.get("equipment_type"), first.get("brand_model")] if x)
            item["owner"] = first.get("owner")
        drop_internal(item)
        out.append(item)


def parse_operator_volume_entries(value: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for part in re.split(r"\s*;\s*", value or ""):
        vol = VOLUME_RE.search(part)
        if not vol:
            continue
        unit = normalize_unit(vol.group(2), "")
        entries.append({
            "volume": to_float(vol.group(1)),
            "unit": unit,
        })
    return entries


def parse_works(body: str) -> list[dict[str, Any]]:
    works: list[dict[str, Any]] = []
    current_constructive: str | None = None
    current: dict[str, Any] | None = None
    pending_operator: str | None = None
    for line in body.splitlines():
        if not line.strip():
            continue
        constr = CONSTRUCTIVE_RE.match(line)
        if constr and not MAT_OR_WORK_RE.match(line):
            finalize_work(current, works)
            current = None
            current_constructive = clean_value(constr.group(1))
            continue
        plain_constructive = parse_plain_constructive_heading(line)
        if plain_constructive:
            finalize_work(current, works)
            current = None
            current_constructive = plain_constructive
            continue
        work = MAT_OR_WORK_RE.match(line)
        if work:
            finalize_work(current, works)
            name = clean_value(work.group(1))
            current = make_work_row(name, current_constructive)
            pending_operator = None
            continue
        inline_no_equipment_work = parse_inline_no_equipment_work(line, current_constructive)
        if current is None and inline_no_equipment_work:
            current = inline_no_equipment_work
            pending_operator = None
            continue
        if current is None and is_plain_work_heading(line, current_constructive):
            current = make_work_row(line, current_constructive)
            apply_pk_from_text(current, line)
            pending_operator = None
            continue
        if current is None:
            continue
        if inline_no_equipment_work:
            finalize_work(current, works)
            current = inline_no_equipment_work
            pending_operator = None
            continue
        if is_plain_work_heading(line, current_constructive):
            finalize_work(current, works)
            current = make_work_row(line, current_constructive)
            apply_pk_from_text(current, line)
            pending_operator = None
            continue
        if line.startswith("%%"):
            current["comments"].append(line.lstrip("%").strip())
            continue
        pk_line = PK_LINE_RE.match(line)
        if pk_line:
            body = pk_line.group(2)
            inline_ad = re.search(r"\(?\s*ПК\s+АД\s*:\s*([^)]+)\)?", body, re.I)
            rail_body = body[: inline_ad.start()] if inline_ad else body
            parsed = parse_pk_range(rail_body)
            if "ВСЖМ" in pk_line.group(1).upper():
                current["pk_rail_start"] = parsed["start"]
                current["pk_rail_end"] = parsed["end"]
                current["pk_rail_raw"] = parsed["raw"]
                current["pk_start"] = parsed["start"]
                current["pk_end"] = parsed["end"]
                if inline_ad:
                    ad_parsed = parse_pk_range(inline_ad.group(1))
                    current["pk_ad_start"] = ad_parsed["start"]
                    current["pk_ad_end"] = ad_parsed["end"]
                    current["pk_ad_raw"] = ad_parsed["raw"]
            else:
                current["pk_ad_start"] = parsed["start"]
                current["pk_ad_end"] = parsed["end"]
                current["pk_ad_raw"] = parsed["raw"]
            continue
        operator_line = parse_operator_line(line)
        if operator_line is not None:
            raw_operator = OPERATOR_RE.match(line.strip())
            operator_text = clean_value(raw_operator.group(1)) if raw_operator else (
                "" if operator_line == PERSON_MARKER else operator_line
            )
            operator_text, inline_equipment = split_inline_operator_equipment(operator_text)
            performer_volumes = parse_operator_volume_entries(operator_text)
            if performer_volumes:
                current["performers"].extend(performer_volumes)
                pending_operator = None
            else:
                pending_operator = PERSON_MARKER
            if inline_equipment:
                eq = parse_equipment_line(inline_equipment, pending_operator)
                if eq:
                    pending_volume = current.get("_pending_volume")
                    if pending_volume and eq.get("volume") is None:
                        eq["volume"] = pending_volume.get("volume")
                        eq["unit"] = pending_volume.get("unit")
                        current["_pending_volume"] = None
                    current["equipment"].append(eq)
                    current["_last_equipment_index"] = len(current["equipment"]) - 1
                    pending_operator = None
            continue
        plain_operator = parse_plain_operator_line(line)
        if plain_operator is not None:
            pending_operator = PERSON_MARKER
            continue
        compact_eq = parse_compact_work_equipment_row(line)
        if compact_eq:
            if compact_eq.get("volume") is not None and current.get("volume") is None:
                current["volume"] = compact_eq.get("volume")
                current["unit"] = compact_eq.get("unit")
            current["equipment"].append(compact_eq)
            current["_last_equipment_index"] = len(current["equipment"]) - 1
            pending_operator = None
            continue
        shorthand_eq = parse_shorthand_equipment_volume_row(line)
        if shorthand_eq:
            if shorthand_eq.get("volume") is not None and current.get("volume") is None:
                current["volume"] = shorthand_eq.get("volume")
                current["unit"] = shorthand_eq.get("unit")
            current["equipment"].append(shorthand_eq)
            current["_last_equipment_index"] = len(current["equipment"]) - 1
            pending_operator = None
            continue
        eq = parse_equipment_line(line, pending_operator)
        if eq:
            pending_volume = current.get("_pending_volume")
            if pending_volume and eq.get("volume") is None:
                eq["volume"] = pending_volume.get("volume")
                eq["unit"] = pending_volume.get("unit")
                current["_pending_volume"] = None
            current["equipment"].append(eq)
            current["_last_equipment_index"] = len(current["equipment"]) - 1
            pending_operator = None
            continue
        volume_matches = list(VOLUME_RE.finditer(line))
        if volume_matches:
            vol = volume_matches[0]
            value = to_float(vol.group(1))
            unit = normalize_unit(vol.group(2), "")
            note = clean_value(vol.group(3))
            extra_notes = [clean_value(m.group(0)) for m in volume_matches[1:] if clean_value(m.group(0))]
            if extra_notes:
                note = "; ".join(x for x in [note, *extra_notes] if x)
            if pending_operator:
                current["performers"].append({
                    "volume": value,
                    "unit": unit,
                })
                pending_operator = None
                if note:
                    current["volume_note"] = note
                continue
            last_idx = current.get("_last_equipment_index")
            if isinstance(last_idx, int) and last_idx < len(current["equipment"]):
                eq = current["equipment"][last_idx]
                if eq.get("volume") is None:
                    eq["volume"] = value
                    eq["unit"] = unit
                    if current.get("volume") is None:
                        current["volume"] = value
                        current["unit"] = unit
                else:
                    if current.get("volume") is None:
                        current["volume"] = value
                        current["unit"] = unit
                    current["_pending_volume"] = {"volume": value, "unit": unit}
            else:
                if current.get("volume") is None:
                    current["volume"] = value
                    current["unit"] = unit
                current["_pending_volume"] = {"volume": value, "unit": unit}
            if note:
                current["volume_note"] = note
            continue
    finalize_work(current, works)
    return works


def strip_header_lines_for_freeform(header_text: str) -> str:
    out: list[str] = []
    for line in (header_text or "").splitlines():
        value = clean_value(line)
        if not value:
            out.append("")
            continue
        header_match = HEADER_RE.match(value)
        if header_match and header_match.group(1).strip().lower() in {"дата", "смена", "участок", "направление", "конструктивы"}:
            continue
        if value.lower().startswith("информация по завозу"):
            continue
        if value.startswith("==="):
            continue
        out.append(line)
    return "\n".join(out)


def looks_like_transport_route_line(line: str) -> bool:
    value = clean_value(line)
    if not value:
        return False
    if ROUTE_MATERIAL_RE.match(value) or ROUTE_LABEL_RE.match(value):
        return True
    route_match = ROUTE_RE.match(value)
    route_text = clean_value(route_match.group(1) or route_match.group(2)) if route_match else value
    if split_compact_route_text(route_text) or parse_route_from_work_title(route_text):
        low = route_text.lower().replace("ё", "е")
        return any(marker in low for marker in ("карьер", "накоп", "пк", "ад", "площадк", "иссо"))
    return False


def looks_like_transport_quantity_line(line: str) -> bool:
    value = clean_value(line)
    if not value:
        return False
    if COMPACT_NUMBER_ROW_RE.match(value) or COMPACT_FLEET_ROW_RE.match(value):
        return True
    return bool(VOLUME_TRIPS_RE.search(value) and re.search(r"\bрейс", value, re.I))


def strip_transport_like_lines_for_work(body: str) -> str:
    """Remove route/material/trip rows before trying to infer a missing work block.

    Owner rule for Юрий/MAX: reports are expected to contain both core blocks —
    work facts and material transport. Field messages may omit exact headings, so
    when the work block is missing we retry against the whole report, but first
    strip route-shaped rows to avoid turning `/песок/` under `карьер -> ПК...`
    into a bogus work item.
    """
    out: list[str] = []
    in_transport_run = False
    for raw_line in (body or "").splitlines():
        line = clean_value(raw_line)
        if not line:
            in_transport_run = False
            out.append(raw_line)
            continue

        section_match = SECTION_RE.match(line)
        if section_match:
            title = canonical_section_title(
                section_match.groupdict().get("boxed")
                or section_match.groupdict().get("hash")
                or section_match.groupdict().get("bare")
                or ""
            )
            in_transport_run = title == "ПЕРЕВОЗКА"
            if in_transport_run:
                continue
            out.append(raw_line)
            continue

        if looks_like_transport_route_line(line):
            in_transport_run = True
            continue
        if in_transport_run:
            mat = MAT_OR_WORK_RE.match(line)
            if (mat and infer_material_code(mat.group(1))) or MATERIAL_LABEL_RE.match(line):
                continue
            if looks_like_transport_quantity_line(line):
                continue
            # First non-transport-shaped row ends the run; process it as normal.
            in_transport_run = False
        out.append(raw_line)
    return "\n".join(out)


def infer_core_blocks_from_cues(
    text: str,
    *,
    transport: list[dict[str, Any]],
    main_works: list[dict[str, Any]],
    aux_works: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Second-pass recovery for reports whose core headings are absent/odd.

    A daily report without explicit `===Перевозка===` or `===Работы===` headings
    is still expected to contain those blocks. Do not conclude that the block is
    absent just because the exact heading is missing; retry by route/trip/work
    cues and keep a warning so the review UI shows what was inferred.
    """
    warnings: list[str] = []
    inferred_transport = transport
    inferred_main_works = main_works

    if not inferred_transport:
        guessed_transport = [row for row in parse_transport(text) if row.get("trips")]
        if guessed_transport:
            inferred_transport = guessed_transport
            warnings.append("Перевозка распознана без явного заголовка блока — по маршрутам/рейсам/материалам")

    if not inferred_main_works and not aux_works:
        work_probe = strip_transport_like_lines_for_work(strip_header_lines_for_freeform(text))
        guessed_works = parse_works(work_probe)
        if not guessed_works:
            guessed_works, _ = parse_freeform_numbered_report(work_probe)
        if guessed_works:
            inferred_main_works = guessed_works
            warnings.append("Работы распознаны без явного заголовка блока — по конструктивам/видам работ/ПК/объемам")

    return inferred_transport, inferred_main_works, warnings


def parse_route_from_work_title(title: str) -> tuple[str, str] | None:
    text = clean_value(title)
    m = re.search(r"\b(?:с|из)\s+(.+?)\s+\b(?:на|в)\s+(.+)$", text, re.I)
    if not m:
        return None
    src = clean_value(m.group(1))
    dst = clean_value(m.group(2))
    if not src or not dst:
        return None
    return src, dst


def freeform_work_to_transport(work: dict[str, Any]) -> list[dict[str, Any]]:
    title = clean_value(work.get("work_name"))
    low = title.lower().replace("ё", "е")
    if not any(marker in low for marker in ("поставка", "погрузка", "перемещен", "перевоз")):
        return []
    route = parse_route_from_work_title(title)
    if not route:
        return []
    material = "песок" if "пес" in low else "ЩПГС" if "щпгс" in low or "щпс" in low else "непригодный грунт" if "непригод" in low else title
    rows: list[dict[str, Any]] = []
    for eq in work.get("equipment") or []:
        if eq.get("volume") is None:
            continue
        trips = int(eq.get("trip_count") or eq.get("trips") or 0)
        rows.append({
            **{k: v for k, v in eq.items() if k not in {"volume", "unit", "trips", "trip_count"}},
            "trips": [{
                "material": material,
                "material_code": infer_material_code(material),
                "from": route[0],
                "to": route[1],
                "from_location": route[0],
                "to_location": route[1],
                "volume": eq.get("volume"),
                "unit": eq.get("unit") or "м3",
                "trips": trips,
                "trip_count": trips,
            }],
            "comments": ["freeform_section1_route_inferred"],
        })
    return rows


def parse_freeform_numbered_report(body: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    works: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw_line in (body or "").splitlines():
        line = clean_value(raw_line)
        if not line:
            continue
        numbered = NUMBERED_WORK_RE.match(line)
        if numbered:
            finalize_work(current, works)
            title = clean_value(numbered.group(1))
            current = make_work_row(title, None)
            apply_pk_from_text(current, title)
            continue
        if current is None:
            if is_plain_work_heading(line, None):
                current = make_work_row(line, None)
                apply_pk_from_text(current, line)
            continue
        if line.startswith("-") and line.endswith("-"):
            current.setdefault("comments", []).append(f"contractor={clean_value(line.strip('-'))}")
            continue
        if is_plain_work_heading(line, "freeform"):
            finalize_work(current, works)
            current = make_work_row(line, None)
            apply_pk_from_text(current, line)
            continue
        shorthand_eq = parse_shorthand_equipment_volume_row(line)
        if shorthand_eq:
            if shorthand_eq.get("volume") is not None and current.get("volume") is None:
                current["volume"] = shorthand_eq.get("volume")
                current["unit"] = shorthand_eq.get("unit")
            current["equipment"].append(shorthand_eq)
            current["_last_equipment_index"] = len(current["equipment"]) - 1
            continue
        volume_matches = list(VOLUME_RE.finditer(line))
        if volume_matches:
            vol = volume_matches[0]
            # Lines starting with Итог/Всего usually contain the already summed
            # value; prefer an earlier explicit V/S value if one exists.
            if current.get("volume") is None or not re.search(r"^(итого|всего)\b", line, re.I):
                current["volume"] = to_float(vol.group(1))
                current["unit"] = normalize_unit(vol.group(2), "")
            continue
        if "пк" in line.lower() and current.get("pk_start") is None:
            apply_pk_from_text(current, line)
            continue
    finalize_work(current, works)
    transport: list[dict[str, Any]] = []
    for work in works:
        transport.extend(freeform_work_to_transport(work))
    return works, transport


def parse_park(body: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in body.splitlines():
        if not line.strip():
            continue
        parsed = split_equipment_line(line)
        if not parsed:
            continue
        eq = parse_equipment_line(line)
        if not eq:
            continue
        tail = parsed[2]
        parts = [clean_value(p) for p in tail.split(";") if clean_value(p)]
        owner = None
        status = "unknown"
        comment = None
        for part in parts:
            parsed_status = parse_status(part)
            if parsed_status != "unknown":
                status = parsed_status
                status_note = park_status_comment(part, parsed_status)
                if status_note:
                    comment = "; ".join(x for x in [comment, status_note] if x)
            elif looks_company(part):
                owner = normalize_owner_label(part)
            else:
                comment = "; ".join(x for x in [comment, part] if x)
        if status not in PARK_IMPORT_STATUSES:
            continue
        eq["owner"] = owner
        eq["contractor_name"] = owner
        eq["status"] = status
        eq["comment"] = comment
        rows.append(eq)
    return rows


def parse_stockpiles(body: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    stockpile_pk_re = re.compile(r"(?i)(?:п\s*\.?\s*к\s*\.?\s*)?\d{3,5}(?:\s*(?:\+|[,.])\s*\d{1,2}(?:[,.]\d+)?)?")
    for line in body.splitlines():
        if not line.strip():
            continue
        parts = [clean_value(p) for p in re.split(r"\s*[-–—]\s*", line, maxsplit=2)]
        vol = None
        name = ""
        pk_raw = ""
        rest = ""
        if len(parts) >= 3:
            name, pk_raw, rest = parts
            vol = VOLUME_RE.search(rest)
        else:
            raw = clean_value(line)
            vol = VOLUME_RE.search(raw)
            before_volume = raw[: vol.start()].strip(" -–—") if vol else raw
            pk_match = None
            for match in stockpile_pk_re.finditer(before_volume):
                token = match.group(0)
                if re.search(r"(?i)п\s*\.?\s*к", token) or "накоп" in before_volume[: match.start()].lower().replace("ё", "е"):
                    pk_match = match
                    break
            if not pk_match:
                continue
            pk_raw = clean_value(pk_match.group(0))
            name = clean_value((before_volume[: pk_match.start()] + " " + before_volume[pk_match.end():]).strip(" -–—"))
            if not name:
                name = "Накопитель"
            rest = raw[vol.start():] if vol else ""
        material = re.sub(r"(?i)\bнакопител\w*\b", "", name)
        material = stockpile_pk_re.sub("", material)
        material = clean_value(re.sub(r"\s+", " ", material)) or name
        pk = parse_pk_value(pk_raw)
        rows.append({
            "name": name,
            "material": material,
            "material_code": infer_material_code(material),
            "pk_raw_text": pk_raw,
            "pk_start": pk,
            "pk_end": pk,
            "rounded_pk": rounded_pk(pk),
            "volume": to_float(vol.group(1)) if vol else None,
            "unit": normalize_unit(vol.group(2) if vol else None, "м3"),
            "needs_create": None,
            "requires_user_confirmation": False,
        })
    return rows


PILE_HEADCAP_OPERATION_RE = re.compile(r"(?:наголов|оголов|head\s*cap|headcap)", re.I)


def parse_pile_driving(body: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in body.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("%"):
            continue
        parts = [clean_value(p) for p in re.split(r"\s*-\s*", raw) if clean_value(p)]
        if not parts:
            continue
        joined = " ".join(parts)
        count_m = re.search(r"(\d+)\s*(?:шт|сва)", joined, re.I)
        field_code = parts[0] if parts else ""
        pk = next((parse_pk_value(p) for p in parts if parse_pk_value(p) is not None), None)
        kind_text = joined.lower()
        pile_kind = "test" if "проб" in kind_text else "main"
        pile_operation = "headcap" if PILE_HEADCAP_OPERATION_RE.search(kind_text.replace("ё", "е")) else "driving"
        comment = re.sub(r"\bсоставн\w*\s+(?:свая\s+)?готов\w*\b", "", raw, flags=re.I)
        comment = re.sub(r"\s*-\s*$", "", comment).strip()
        row = {
            "field_code": field_code,
            "field_id": None,
            "pk_start": pk,
            "pk_end": pk,
            "pk_text": next((p for p in parts if "пк" in p.lower()), ""),
            "pile_kind": pile_kind,
            "pile_operation": pile_operation,
            "count": int(count_m.group(1)) if count_m else None,
            "pile_type": "",
            "pile_length_label": "",
            "comment": comment,
        }
        if pile_operation == "headcap":
            row["work_type_code"] = "PILE_HEADCAP_INSTALLATION"
        rows.append(row)
    return rows


def normalize_fill_status(value: str | None) -> Optional[str]:
    text = clean_value(value).lower().replace("ё", "е")
    if not text:
        return None
    normalized = re.sub(r"\s+", " ", text)
    for key, pattern in FILL_STATUS_PATTERNS:
        if pattern.search(normalized):
            return key
    compact = normalized.replace("_", " ").replace("-", " ")
    for key, label in FILL_STATUS_LABELS.items():
        if compact == label.lower().replace("ё", "е"):
            return key
    return None


def normalize_fill_road(value: str | None) -> str:
    text = clean_value(value)
    text = re.sub(r"^(?:автодорога|авто\s*дорога)\s+", "", text, flags=re.I)
    text = re.sub(r"\bАД\s+(\d)", r"АД\1", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def parse_fill_statuses(body: str) -> tuple[list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for line_no, raw_line in enumerate((body or "").splitlines(), start=1):
        line = clean_value(raw_line)
        if not line:
            continue
        parts = [clean_value(part) for part in re.split(r"\s*;\s*", line) if clean_value(part)]
        if len(parts) < 3:
            tab_parts = [clean_value(part) for part in re.split(r"\t+", line) if clean_value(part)]
            if len(tab_parts) >= 3:
                parts = tab_parts
        if len(parts) < 3:
            warnings.append(f"Отсыпка строка {line_no}: не разобрана; используйте формат 'АД5; ПК АД 0+00-2+15; статус'")
            continue

        road = normalize_fill_road(parts[0])
        pk_text = clean_value(parts[1])
        status_text = clean_value(parts[2])
        status_key = normalize_fill_status(status_text)
        if not road:
            warnings.append(f"Отсыпка строка {line_no}: не указана автодорога")
            continue
        if not status_key:
            warnings.append(f"Отсыпка {road}: статус '{status_text}' не распознан")
            continue

        row: dict[str, Any] = {
            "road_id": None,
            "road_code": road,
            "road_name": road,
            "section_code": "",
            "comment": "; ".join(parts[3:]),
            "pk_validation_override": False,
        }
        for field in FILL_STATUS_FIELDS:
            row[field] = pk_text if field == status_key else ""
        rows.append(row)
    return rows, warnings


def normalize_mainline_fill_status(value: str | None) -> Optional[str]:
    text = clean_value(value).lower().replace("ё", "е")
    if not text:
        return None
    normalized = re.sub(r"\s+", " ", text)
    for key, pattern in MAINLINE_FILL_STATUS_PATTERNS:
        if pattern.search(normalized):
            return key
    compact = normalized.replace("_", " ").replace("-", " ")
    for key, label in MAINLINE_FILL_STATUS_LABELS.items():
        if compact == label.lower().replace("ё", "е"):
            return key
    return None


def normalize_mainline_section_code(value: str | None) -> str:
    raw = clean_value(value)
    if not raw:
        return ""
    parsed = parse_section_code(raw)
    if parsed:
        return parsed
    if re.fullmatch(r"UCH_\d+", raw, re.I):
        return raw.upper()
    return raw


def parse_mainline_fill_statuses(body: str) -> tuple[list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for line_no, raw_line in enumerate((body or "").splitlines(), start=1):
        line = clean_value(raw_line)
        if not line:
            continue
        parts = [clean_value(part) for part in re.split(r"\s*;\s*", line) if clean_value(part)]
        if len(parts) < 3:
            tab_parts = [clean_value(part) for part in re.split(r"\t+", line) if clean_value(part)]
            if len(tab_parts) >= 3:
                parts = tab_parts
        if len(parts) < 3:
            warnings.append(
                f"Отсыпка ОХ строка {line_no}: не разобрана; используйте формат 'участок №1; ПК2654+50-ПК2655+20; статус'"
            )
            continue

        section_code = normalize_mainline_section_code(parts[0])
        pk_text = clean_value(parts[1])
        status_text = clean_value(parts[2])
        status_key = normalize_mainline_fill_status(status_text)
        if not section_code:
            warnings.append(f"Отсыпка ОХ строка {line_no}: не указан участок")
            continue
        if not status_key:
            warnings.append(f"Отсыпка ОХ {section_code}: статус '{status_text}' не распознан")
            continue
        rows.append({
            "section_code": section_code,
            "status_type": status_key,
            "pk_ranges": pk_text,
            "pk_validation_override": False,
            "comment": "; ".join(parts[3:]),
        })
    return rows, warnings


def append_fill_status_warnings(warnings: list[str], rows: list[dict[str, Any]]) -> None:
    for idx, row in enumerate(rows, start=1):
        road = row.get("road_code") or row.get("road_name") or f"строка {idx}"
        for field in FILL_STATUS_FIELDS:
            raw = row.get(field)
            if not raw:
                continue
            parsed = parse_pk_range(str(raw))
            if parsed.get("start") is None:
                warnings.append(f"Отсыпка '{road}' ({FILL_STATUS_LABELS[field]}): пикетаж '{raw}' не распознан")
            elif parsed.get("end") is not None and parsed["end"] < parsed["start"]:
                warnings.append(f"Отсыпка '{road}' ({FILL_STATUS_LABELS[field]}): конец пикетажа меньше начала")


def append_mainline_fill_status_warnings(warnings: list[str], rows: list[dict[str, Any]]) -> None:
    for idx, row in enumerate(rows, start=1):
        raw = row.get("pk_ranges")
        if not raw:
            continue
        parsed = parse_pk_range(str(raw))
        label = MAINLINE_FILL_STATUS_LABELS.get(str(row.get("status_type") or ""), "статус")
        section = row.get("section_code") or f"строка {idx}"
        if parsed.get("start") is None:
            warnings.append(f"Отсыпка ОХ '{section}' ({label}): пикетаж '{raw}' не распознан")
        elif parsed.get("end") is not None and parsed["end"] < parsed["start"]:
            warnings.append(f"Отсыпка ОХ '{section}' ({label}): конец пикетажа меньше начала")


def enrich_park_from_usage(
    park: list[dict[str, Any]],
    transport: list[dict[str, Any]],
    works: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Deduplicate manually reported park exceptions.

    Transport and work rows are imported into report_equipment_units separately.
    The park block is intentionally reserved for report-M status exceptions:
    equipment in repair or standby.
    """
    by_key: dict[str, dict[str, Any]] = {}
    deduped: list[dict[str, Any]] = []
    for item in park:
        keys = equipment_identifier_keys(item)
        if not keys:
            deduped.append(item)
            continue
        existing = next((by_key[key] for key in keys if key in by_key), None)
        if existing:
            merge_equipment_row(existing, item)
        else:
            existing = item
            deduped.append(existing)
        for key in equipment_identifier_keys(existing):
            by_key[key] = existing
    return deduped


def apply_special_work_defaults(works: list[dict[str, Any]]) -> None:
    note = "условная учетная единица: техника передана на направление ИССО, производительность не рассчитывается"
    geotextile_codes = {"GEOTEXTILE_LAYER", "GEOTEXTILE_LAYER_DO", "FLEXIBLE_GRILLAGE_GEOTEXTILE"}
    for work in works:
        text = f"{work.get('constructive') or ''} {work.get('work_name') or ''}".lower().replace("ё", "е")
        if "геотекст" in text or str(work.get("work_type_code") or "").upper() in geotextile_codes:
            work["productivity_enabled"] = False
        if "иссо" not in text or work.get("volume") is not None:
            continue
        work["volume"] = 1.0
        work["unit"] = "шт"
        work["volume_note"] = note
        work["work_type_code"] = work.get("work_type_code") or "SOIL_WORK"
        comments = work.setdefault("comments", [])
        if note not in comments:
            comments.append(note)


def parse_delivery_info(value: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for part in (value or "").split(";"):
        bits = [clean_value(x) for x in re.split(r"\s*[-–—]\s*", part)]
        if len(bits) < 3:
            continue
        vol = VOLUME_RE.search(bits[-1])
        material = bits[-2]
        rows.append({
            "source": bits[0],
            "material": material,
            "material_code": infer_material_code(material),
            "volume": to_float(vol.group(1)) if vol else None,
            "unit": normalize_unit(vol.group(2) if vol else None, "м3"),
            "human_only": True,
        })
    return rows


def normalize_problems_text(value: str | None) -> str:
    """Keep real field problems, ignore empty/default filler lines.

    MAX reports often leave the `Проблемные вопросы` block with only spaces,
    dashes, dots or phrases like `нет`. Such placeholders must not create a
    blocker/problem row in DB.
    """
    lines: list[str] = []
    for raw in (value or "").splitlines():
        text = clean_value(raw)
        text = re.sub(r"^[*•\-–—\s]+", "", text).strip()
        if not text or re.fullmatch(r"[-–—_.;:,/\\\s]+", text):
            continue
        low = text.lower().replace("ё", "е")
        compact = re.sub(r"[\s.,;:!\-–—]+", "", low)
        if compact in {"нет", "нету", "н/д", "нд", "отсутствуют", "безпроблем", "проблемнет", "невыявлено", "невиявлено"}:
            continue
        if re.fullmatch(r"(?:проблем\w*\s*)?(?:нет|отсутствуют)", low):
            continue
        lines.append(text)
    return "\n".join(lines).strip()


def parse_report_text(filename: str, raw_text: str) -> dict[str, Any]:
    text, comments = normalize_text(raw_text)
    comments = [c for c in comments if not re.search(r"ф\s*\.?\s*и\s*\.?\s*о|фио", c, re.I)]
    report_header_count = len(REPORT_START_RE.findall(raw_text or ""))
    header_text, sections = split_sections(text)
    header_source = "\n".join(part for part in [header_text, sections.get("ШАПКА", "")] if part.strip())
    header = parse_header(header_source)
    delivery = parse_delivery_info(header.get("delivery_info", ""))
    transport = parse_transport(sections.get("ПЕРЕВОЗКА", ""))
    main_work_body = "\n".join(
        part
        for part in (sections.get("ОСНОВНЫЕ РАБОТЫ", ""), sections.get("РАБОТЫ", ""))
        if part.strip()
    )
    main_works = parse_works(main_work_body)
    aux_works = parse_works(sections.get("СОПУТСТВУЮЩИЕ РАБОТЫ", ""))
    inference_warnings: list[str] = []
    if not sections or (not main_works and not aux_works and not transport):
        free_body = strip_header_lines_for_freeform(header_text)
        free_works, free_transport = parse_freeform_numbered_report(free_body)
        if free_works:
            main_works = free_works
        if free_transport and not transport:
            transport = free_transport
    transport, main_works, cue_warnings = infer_core_blocks_from_cues(
        text,
        transport=transport,
        main_works=main_works,
        aux_works=aux_works,
    )
    inference_warnings.extend(cue_warnings)
    # Deprecated sections from old Excel/text templates are tolerated but ignored.
    # Equipment facts now come from transport/works, and personnel is not imported.
    staff_counts: list[dict[str, Any]] = []
    for work in main_works:
        work["productivity_enabled"] = True
    for work in aux_works:
        work["productivity_enabled"] = False
    apply_special_work_defaults(main_works)
    apply_special_work_defaults(aux_works)
    park: list[dict[str, Any]] = []
    stockpiles = parse_stockpiles(sections.get("НАКОПИТЕЛИ", ""))
    piles = parse_pile_driving(
        sections.get("ЗАБИВКА СВАЙ", "")
        or sections.get("СВАЙНЫЕ РАБОТЫ", "")
        or sections.get("СВАИ", "")
    )
    fill_statuses, fill_status_warnings = parse_fill_statuses(
        sections.get("ДАННЫЕ ПО ОТСЫПКЕ", "")
        or sections.get("ОТСЫПКА", "")
        or sections.get("СТАТУСЫ ОТСЫПКИ", "")
    )
    mainline_fill_statuses, mainline_fill_warnings = parse_mainline_fill_statuses(
        sections.get("ДАННЫЕ ПО ОТСЫПКЕ ОХ", "")
        or sections.get("ОТСЫПКА ОХ", "")
        or sections.get("СТАТУСЫ ОТСЫПКИ ОХ", "")
    )
    warnings: list[str] = []
    warnings.extend(inference_warnings)
    warnings.extend(fill_status_warnings)
    warnings.extend(mainline_fill_warnings)
    if report_header_count > 1:
        warnings.append(
            f"В файле найдено несколько отчетов ({report_header_count} строк 'Дата'); загрузите день и ночь отдельными файлами"
        )
    for row in stockpiles:
        if row.get("needs_create") is None:
            warnings.append(f"Накопитель '{row.get('name')}' требует проверки по пикету перед импортом")
    append_pk_soft_warnings(warnings, main_works + aux_works, label="Работа")
    append_pk_soft_warnings(warnings, stockpiles, label="Накопитель")
    append_pk_soft_warnings(warnings, piles, label="Свайная строка")
    append_fill_status_warnings(warnings, fill_statuses)
    append_mainline_fill_status_warnings(warnings, mainline_fill_statuses)
    for work in main_works + aux_works:
        if work.get("volume") is None:
            warnings.append(f"Работа '{work.get('work_name')}' ({work.get('constructive') or 'без конструктива'}) без объема: перед импортом нужно заполнить или удалить строку")
    return {
        "source": {"filename": filename, "chars": len(raw_text or ""), "lines": len((raw_text or "").splitlines())},
        "header": header,
        "human_summary": {
            "constructives": header.get("constructives", ""),
            "delivery_info": header.get("delivery_info", ""),
            "delivery_rows": delivery,
            "global_comments": comments,
        },
        "transport": transport,
        "main_works": main_works,
        "aux_works": aux_works,
        "staff_counts": staff_counts,
        "park": park,
        "problems": normalize_problems_text(sections.get("ПРОБЛЕМНЫЕ ВОПРОСЫ", "")),
        "stockpiles": stockpiles,
        "piles": piles,
        "fill_statuses": fill_statuses,
        "mainline_fill_statuses": mainline_fill_statuses,
        "warnings": warnings,
        "review_actions": {"stockpiles_to_create": []},
        "raw_text": sanitize_personal_report_text(raw_text),
        "_stub": False,
    }
