from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIP_ANALYTICS = (ROOT / "api" / "wip_analytics_routes.py").read_text(encoding="utf-8")
DAILY_SUMMARY = (ROOT / "frontend" / "src" / "pages-wip-v2" / "blocks" / "DailySummaryBlock.tsx").read_text(encoding="utf-8")


def test_dashboard_isso_support_endpoint_uses_extended_report_tables_and_fields():
    assert '@router.get("/dashboard/isso-support")' in WIP_ANALYTICS
    assert "isso_front_transfer_lines" in WIP_ANALYTICS
    assert "isso_front_transfer_monthly_plan" in WIP_ANALYTICS
    assert "supports_total" in WIP_ANALYTICS
    assert "supports_done" in WIP_ANALYTICS
    assert "sites_total" in WIP_ANALYTICS
    assert "sites_done" in WIP_ANALYTICS
    assert "current_month_plan" in WIP_ANALYTICS
    assert "current_month_done" in WIP_ANALYTICS
    assert "fact_june_sites" in WIP_ANALYTICS
    assert "fact_july_sites" in WIP_ANALYTICS
    assert "pk_start_m" in WIP_ANALYTICS
    assert "pk_end_m" in WIP_ANALYTICS
    assert "pk_label" in WIP_ANALYTICS
    assert "month: Optional[str] = Query(None)" in WIP_ANALYTICS
    assert "ms11_started" in WIP_ANALYTICS
    assert "ms11_scope" in WIP_ANALYTICS
    assert "fact_months" in WIP_ANALYTICS
    assert "fill_material_kind" in WIP_ANALYTICS
    assert "fill_material_label" in WIP_ANALYTICS
    assert "отсыпано в песке" in WIP_ANALYTICS
    assert "отсыпано в ЩПГС" in WIP_ANALYTICS
    assert "sites_sand_done" in WIP_ANALYTICS
    assert "sites_shpgs_done" in WIP_ANALYTICS
    material_counts = WIP_ANALYTICS[
        WIP_ANALYTICS.index("def _dashboard_isso_material_counts("):
        WIP_ANALYTICS.index("def _dashboard_isso_fill_materials(")
    ]
    assert material_counts.index('raw.get("sites_done")') < material_counts.index('raw.get("sites_shpgs_done")')
    assert "fill_materials" in WIP_ANALYTICS
    assert "_dashboard_isso_fact_month_map" in WIP_ANALYTICS
    assert "_dashboard_isso_fact_material_map" in WIP_ANALYTICS
    assert "fact_material_by_month" in WIP_ANALYTICS
    assert "current_month_sand_done" in WIP_ANALYTICS
    assert "current_month_shpgs_done" in WIP_ANALYTICS
    assert "target_month_material_kind" in WIP_ANALYTICS
    assert "raw.get(\"fact_months\")" in WIP_ANALYTICS
    assert "month_filter_active" in WIP_ANALYTICS
    assert "deadline" in WIP_ANALYTICS
    assert "access_base AS MATERIALIZED" in WIP_ANALYTICS
    assert "work_activity AS MATERIALIZED" in WIP_ANALYTICS
    assert "work_activity_count" in WIP_ANALYTICS
    assert "last_work_date" in WIP_ANALYTICS
    assert "work_object_code" in WIP_ANALYTICS
    assert "idle_with_rd" in WIP_ANALYTICS
    assert 'return "ready"' in WIP_ANALYTICS
    assert "sites_sand_done," in WIP_ANALYTICS
    assert '"корректиров" in remark_norm' not in WIP_ANALYTICS


def test_dashboard_left_donut_is_isso_support_instead_of_money():
    assert "/api/wip/dashboard/isso-support" in DAILY_SUMMARY
    assert "Отсыпка площадок для ИССО" in DAILY_SUMMARY
    assert "donutSlices.isso_support" in DAILY_SUMMARY
    assert "IssoSupportDetails" in DAILY_SUMMARY
    assert "IssoObjectCard" in DAILY_SUMMARY
    assert "shouldShowIssoMonthProgress" in DAILY_SUMMARY
    assert "Все участки" in DAILY_SUMMARY
    assert "Отображаемый месяц" in DAILY_SUMMARY
    assert "Срок выполнения" in DAILY_SUMMARY
    assert "Силами МС-11" in DAILY_SUMMARY
    assert "отсыпано в песке" in DAILY_SUMMARY
    assert "отсыпано в ЩПГС" in DAILY_SUMMARY
    assert "Отсыпано в песке" in DAILY_SUMMARY
    assert "Отсыпано в ЩПГС" in DAILY_SUMMARY
    assert "issoFillMaterialBadgeClasses" in DAILY_SUMMARY
    assert "Фактическая отсыпка:" in DAILY_SUMMARY
    assert "issoMonthFactLabel" in DAILY_SUMMARY
    assert "target_month_material_kind" in DAILY_SUMMARY
    assert "current_month_sand_done" in DAILY_SUMMARY
    assert "Сбросить" in DAILY_SUMMARY
    assert "площ. ${month.label}" in DAILY_SUMMARY
    assert "оп. ${month.label}" not in DAILY_SUMMARY
    assert "issoSupportTitle" in DAILY_SUMMARY
    assert "pk_label" in DAILY_SUMMARY
    assert "max-w-[calc(100vw-16px)]" in DAILY_SUMMARY
    assert "h-[calc(100vh-16px)]" in DAILY_SUMMARY
    assert "дорога песок" not in DAILY_SUMMARY
    assert "площадка ЩПС" not in DAILY_SUMMARY
    assert "РД н/д" not in DAILY_SUMMARY
    assert "Факт опор" not in DAILY_SUMMARY
    assert "Строка отчета" not in DAILY_SUMMARY
    assert "МС-11 начал работы" not in DAILY_SUMMARY
    assert "Месяц графика" not in DAILY_SUMMARY
    assert "Факт производства" not in DAILY_SUMMARY
    assert "План и факт по деньгам" not in DAILY_SUMMARY
    assert "footer={`Площадки:" not in DAILY_SUMMARY
    assert "IssoStatusLegend" in DAILY_SUMMARY
    assert "площадки готовы" in DAILY_SUMMARY
    assert "isIssoSitesStarted" not in DAILY_SUMMARY
    assert "РД есть, работы не производятся" in DAILY_SUMMARY
    assert "есть работы в сменных отчетах" not in DAILY_SUMMARY
    assert "в сменных отчетах:" not in DAILY_SUMMARY
    assert "shpgs_partial" in DAILY_SUMMARY
    assert "useCloseOnEscape" in DAILY_SUMMARY
    assert "работы не производятся" in DAILY_SUMMARY
    assert "issoWorkActivityLabel" not in DAILY_SUMMARY
    assert "border-black bg-rose-100/90" in DAILY_SUMMARY
    assert "remark.includes('корректиров')" not in DAILY_SUMMARY


def test_isso_sand_fact_has_first_color_priority():
    api_status = WIP_ANALYTICS[
        WIP_ANALYTICS.index("def _dashboard_isso_work_status("):
        WIP_ANALYTICS.index("def _dashboard_isso_json_obj(")
    ]
    line_status = DAILY_SUMMARY[
        DAILY_SUMMARY.index("function issoLineStatus("):
        DAILY_SUMMARY.index("function issoCardStatus(")
    ]
    card_status = DAILY_SUMMARY[
        DAILY_SUMMARY.index("function issoCardStatus("):
        DAILY_SUMMARY.index("function issoStatusClasses(")
    ]

    assert api_status.index("sites_sand_done > 0") < api_status.index("_dashboard_isso_rd_missing")
    assert line_status.index("issoSandDone(row) > 0") < line_status.index("row.rd_status === 'missing'")
    assert card_status.index("issoSandDone(item) > 0") < card_status.index("statuses.includes('no_rd')")
