#!/usr/bin/env python3
from __future__ import annotations

from io import BytesIO

from openpyxl import Workbook

from report_text_parser import parse_report_text, split_report_texts
from xlsx_report_adapter import ONE_SHEET_TEMPLATE_MARKER, workbook_to_report_text, xlsx_bytes_to_report_text


def build_workbook() -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Шаблон"
    ref = wb.create_sheet("Справочники")
    example = wb.create_sheet("Пример уч.7 день")

    for sheet in (ws, example):
        sheet["A1"] = "ДЕЖУРНЫЙ ОТЧЁТ ПО УЧАСТКУ"
    ref["A1"] = "Справочник"

    # A populated Шаблон must be selected before the demo sheet.
    ws["A5"] = "06.05.2026"
    ws["B5"] = "день"
    ws["C5"] = "участок №1"
    ws["D5"] = "ЗП"
    ws["E5"] = "АД 2.2"
    ws["B6"] = "Карьер Васильки - песок - 666 м3"

    ws["A32"] = "Тестов"
    ws["B32"] = "Самосвал"
    ws["C32"] = "FAW"
    ws["D32"] = "999"
    ws["E32"] = "ЖДС"
    ws["G32"] = "песок"
    ws["H32"] = "карьер Великий"
    ws["I32"] = "АД 2.2"
    ws["J32"] = 10
    ws["K32"] = 1
    ws["L32"] = "м3"

    ws["A80"] = "АД 2.2"
    ws["B80"] = "Устройство насыпи"
    ws["C80"] = "ПК100+00"
    ws["D80"] = "ПК101+00"
    ws["G80"] = "Машинист"
    ws["H80"] = "Бульдозер"
    ws["I80"] = "SEM"
    ws["J80"] = "123"
    ws["K80"] = "ЖДС"
    ws["L80"] = 20
    ws["M80"] = "м3"

    ws["A191"] = 3
    ws["B191"] = 4
    ws["C191"] = 5
    ws["D191"] = 6

    ws["A195"] = "Накопитель песка АД13"
    ws["B195"] = "ПК2715+00"
    ws["C195"] = 1000
    ws["D195"] = "м3"

    ws["A208"] = "5_1 Н"
    ws["B208"] = "ПК2655+73.50"
    ws["C208"] = "основные"
    ws["D208"] = 4
    ws["F208"] = "да"

    example["A5"] = "16.04.2026"
    return wb


def build_one_sheet_workbook() -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Отчет"
    ws["A1"] = ONE_SHEET_TEMPLATE_MARKER
    ws["B4"] = "08.05.2026"
    ws["B5"] = "день"
    ws["B6"] = "участок №1"
    ws["B7"] = "ЗП"
    ws["B8"] = "АД5, основной ход"

    ws["A11"] = "## ЗАВОЗ"
    ws.append(["Источник", "Материал", "Объем", "Ед."])
    ws.append(["Карьер Васильки", "песок", 100, "м3"])

    ws["A15"] = "## ПЕРЕВОЗКА"
    ws.append(["Откуда", "Куда", "Материал", "Номер техники", "Объем", "Ед.", "Рейсов", "Организация", "Плечо, км", "Время работы"])
    ws.append(["Карьер Васильки", "АД5", "крупный песок", "913", 111.1, "м3", 6, "ЖДС", 16, 7.5])

    ws["A19"] = "## РАБОТЫ"
    ws.append([
        "Объект/конструктив",
        "Работа",
        "ПК ВСЖМ",
        "ПК АД",
        "Номер техники",
        "Объем",
        "Ед.",
        "Тип техники",
        "Организация",
        "Производительность",
        "Комментарий",
        "Время работы",
    ])
    ws.append(["АД5", "Устройство насыпи", "ПК2694+00", "ПК51+20-ПК53+20", "6947", 940, "м3", "бульдозер", "ЖДС", "да", "", 6])

    ws["A23"] = "## ПАРК ТЕХНИКИ"
    ws.append(["Тип техники", "Модель", "Номер техники", "Госномер", "Организация", "Статус", "Комментарий"])
    ws.append(["Самосвал", "FAW", "913", "", "ЖДС", "ремонт", "Боровичи"])
    ws.append(["Самосвал", "FAW", "256", "", "ЖДС", "в работе", ""])

    ws["A28"] = "## ПЕРСОНАЛ"
    ws.append(["Категория", "Количество"])
    ws.append(["ИТР", 4])

    ws["A32"] = "## ДАННЫЕ ПО ОТСЫПКЕ"
    ws.append(["Автодорога", "Участок", "Пионерка", "не в отметку", "ДСО", "готово под ЩПГС", "под аб", "Примечание"])
    ws.append(["АД5", "участок №1", "", "ПК АД 0+00-2+15", "", "", "", ""])

    ws["A36"] = "## ДАННЫЕ ПО ОТСЫПКЕ ОХ"
    ws.append(["Участок", "ПРС", "Основные работы", "ЗС №2", "ЗС №1", "Асфальтобетон", "Примечание"])
    ws.append(["участок №1", "", "ПК2654+50-ПК2655+20", "", "", "", "ОХ в работе"])

    ws["A40"] = "## НАКОПИТЕЛИ"
    ws.append(["Накопитель", "ПК", "Объем", "Ед.", "Комментарий"])
    ws.append(["Накопитель песка АД13", "ПК2715+00", 1000, "м3", ""])

    ws["A44"] = "## ЗАБИВКА СВАЙ"
    ws.append(["Свайное поле", "ПК", "Операция", "Тип свай", "Количество", "Вид/тип свай", "Комментарий"])
    ws.append(["5_1 Н", "ПК2655+73.50", "Установка наголовников", "основные", 4, "", ""])

    ws["A48"] = "## ПРОБЛЕМНЫЕ ВОПРОСЫ"
    ws.append(["Проблема"])
    ws.append(["Нет доступа"])
    return wb


def build_two_shift_one_sheet_workbook() -> Workbook:
    wb = build_one_sheet_workbook()
    day_ws = wb["Отчет"]
    day_ws.title = "День"
    night_ws = wb.copy_worksheet(day_ws)
    night_ws.title = "Ночь"
    night_ws["B4"] = "09.05.2026"
    night_ws["B5"] = "ночь"
    night_ws["B6"] = "участок №2"
    night_ws["A17"] = "Карьер Миголощи"
    night_ws["B17"] = "АД6"
    night_ws["E17"] = 222
    night_ws["G17"] = 11

    example_ws = wb.copy_worksheet(day_ws)
    example_ws.title = "Пример"
    example_ws["B4"] = "01.01.2099"
    example_ws["B5"] = "день"
    return wb


def build_max_row4_workbook() -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Шаблон"
    ws["A1"] = "ДЕЖУРНЫЙ ОТЧЕТ ПО УЧАСТКУ"
    ws["A4"] = "Дата - 16.05.2026"
    ws["B4"] = "Смена - 1"
    ws["C4"] = "Участок - 7"
    ws["D4"] = "Направление - ЗП"
    ws["E4"] = "Конструктивы - АД 4.8"

    ws["B33"] = "Самосвал"
    ws["C33"] = "FAW"
    ws["D33"] = "913"
    ws["E33"] = "ЖДС"
    ws["G33"] = "песок"
    ws["H33"] = "Карьер Васильки"
    ws["I33"] = "АД4 №8"
    ws["K33"] = 6
    ws["L33"] = 111.1
    ws["M33"] = "м3"

    ws["A90"] = "АД4 №8"
    ws["B90"] = "Устройство насыпи"
    ws["C90"] = "ПК3120+00"
    ws["D90"] = "ПК3121+00"
    ws["H90"] = "Бульдозер"
    ws["J90"] = "6947"
    ws["K90"] = "ЖДС"
    ws["M90"] = 940
    ws["N90"] = "м3"

    ws["A137"] = "Самосвал"
    ws["B137"] = "FAW"
    ws["C137"] = "913"
    ws["D137"] = "ЖДС"
    ws["E137"] = "в работе"
    ws["A203"] = 2
    ws["B203"] = 3
    ws["C203"] = 4
    ws["D203"] = 5
    ws["A207"] = "Накопитель песка АД13"
    ws["B207"] = "ПК2715+00"
    ws["C207"] = 1000
    ws["D207"] = "м3"
    ws["A220"] = "7_1 Т"
    ws["B220"] = "ПК3120+10"
    ws["C220"] = "основные"
    ws["D220"] = 4
    return wb


def main() -> int:
    text = workbook_to_report_text(build_workbook())
    assert "%% XLSX source sheet: Шаблон" in text
    parsed = parse_report_text("xlsx-test.xlsx", text)
    assert parsed["header"]["report_date"] == "2026-05-06"
    assert parsed["header"]["shift"] == "day"
    assert parsed["header"]["section_code"] == "UCH_1"
    assert "Карьер Васильки" in parsed["human_summary"]["delivery_info"]
    assert len(parsed["transport"]) == 1
    assert parsed["transport"][0]["trips"][0]["material_code"] == "SAND"
    assert len(parsed["main_works"]) == 1
    assert parsed["main_works"][0]["work_type_code"] == "EMBANKMENT_CONSTRUCTION"
    assert parsed["staff_counts"] == []
    assert len(parsed["stockpiles"]) == 1
    assert parsed["stockpiles"][0]["rounded_pk"] == 2715
    assert len(parsed["piles"]) == 1
    assert parsed["piles"][0]["field_code"] == "5_1 Н"
    assert "is_composite_complete" not in parsed["piles"][0]

    buf = BytesIO()
    build_one_sheet_workbook().save(buf)
    one_sheet_text = xlsx_bytes_to_report_text(buf.getvalue())
    parsed_one_sheet = parse_report_text("one-sheet.xlsx", one_sheet_text)
    assert parsed_one_sheet["header"]["report_date"] == "2026-05-08"
    assert len(parsed_one_sheet["transport"]) == 1
    assert parsed_one_sheet["transport"][0]["trips"][0]["haul_distance_km"] == 16
    assert parsed_one_sheet["transport"][0]["trips"][0]["material_code"] == "COARSE_SAND"
    assert parsed_one_sheet["transport"][0]["trips"][0]["work_hours"] == 7.5
    assert len(parsed_one_sheet["main_works"]) == 1
    assert parsed_one_sheet["main_works"][0]["pk_ad_raw"] == "ПК51+20-ПК53+20"
    assert parsed_one_sheet["main_works"][0]["equipment"][0]["work_hours"] == 6
    assert parsed_one_sheet["park"] == []
    assert parsed_one_sheet["staff_counts"] == []
    assert "===Парк техники===" not in one_sheet_text
    assert "===Персонал===" not in one_sheet_text
    assert len(parsed_one_sheet["fill_statuses"]) == 1
    assert parsed_one_sheet["mainline_fill_statuses"] == [
        {
            "section_code": "UCH_1",
            "status_type": "main_works",
            "pk_ranges": "ПК2654+50-ПК2655+20",
            "pk_validation_override": False,
            "comment": "ОХ в работе",
        }
    ]
    assert len(parsed_one_sheet["stockpiles"]) == 1
    assert len(parsed_one_sheet["piles"]) == 1
    assert parsed_one_sheet["piles"][0]["pile_operation"] == "headcap"
    assert parsed_one_sheet["piles"][0]["work_type_code"] == "PILE_HEADCAP_INSTALLATION"
    assert parsed_one_sheet["problems"] == "Нет доступа"

    example_wb = build_one_sheet_workbook()
    report_ws = example_wb["Отчет"]
    example_ws = example_wb.copy_worksheet(report_ws)
    example_ws.title = "Пример заполнения"
    example_ws["B4"] = "09.05.2026"
    example_ws["B5"] = "ночь"
    report_ws["B4"] = "10.05.2026"
    report_ws["B5"] = "день"
    buf = BytesIO()
    example_wb.save(buf)
    with_example_text = xlsx_bytes_to_report_text(buf.getvalue())
    assert "%% XLSX source sheet: Отчет" in with_example_text
    parsed_with_example = parse_report_text("one-sheet-with-example.xlsx", with_example_text)
    assert parsed_with_example["header"]["report_date"] == "2026-05-10"
    assert parsed_with_example["header"]["shift"] == "day"

    buf = BytesIO()
    build_two_shift_one_sheet_workbook().save(buf)
    two_shift_text = xlsx_bytes_to_report_text(buf.getvalue())
    assert "%% XLSX source sheet: День" in two_shift_text
    assert "%% XLSX source sheet: Ночь" in two_shift_text
    assert "01.01.2099" not in two_shift_text
    reports = split_report_texts(two_shift_text)
    assert len(reports) == 2
    parsed_day = parse_report_text("two-shift.xlsx #1", reports[0])
    parsed_night = parse_report_text("two-shift.xlsx #2", reports[1])
    assert parsed_day["header"]["report_date"] == "2026-05-08"
    assert parsed_day["header"]["shift"] == "day"
    assert parsed_night["header"]["report_date"] == "2026-05-09"
    assert parsed_night["header"]["shift"] == "night"
    assert parsed_night["header"]["section_code"] == "UCH_2"

    buf = BytesIO()
    build_max_row4_workbook().save(buf)
    max_text = xlsx_bytes_to_report_text(buf.getvalue())
    assert "MAX variant row4 header" in max_text
    parsed_max = parse_report_text("max-row4.xlsx", max_text)
    assert parsed_max["header"]["report_date"] == "2026-05-16"
    assert parsed_max["header"]["shift"] == "day"
    assert parsed_max["header"]["section_code"] == "UCH_7"
    assert len(parsed_max["transport"]) == 1
    assert len(parsed_max["main_works"]) == 1
    assert parsed_max["staff_counts"] == []
    assert len(parsed_max["stockpiles"]) == 1
    assert len(parsed_max["piles"]) == 1
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
