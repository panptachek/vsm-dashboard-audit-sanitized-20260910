#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import ast
import unittest

ROOT = Path(__file__).resolve().parents[1]
WIP_ROUTES = (ROOT / "api" / "wip_routes.py").read_text(encoding="utf-8")
WIP_ANALYTICS = (ROOT / "api" / "wip_analytics_routes.py").read_text(encoding="utf-8")
REPORTS_ROUTES = (ROOT / "api" / "reports_routes.py").read_text(encoding="utf-8")
MAIN_API = (ROOT / "api" / "main.py").read_text(encoding="utf-8")
DB_ADMIN = (ROOT / "api" / "db_admin_routes.py").read_text(encoding="utf-8")
DASHBOARD_PAGE = (ROOT / "frontend" / "src" / "pages-wip-v2" / "DashboardPage.tsx").read_text(encoding="utf-8")
SETTINGS_PAGE = (ROOT / "frontend" / "src" / "pages-wip-v2" / "SettingsPage.tsx").read_text(encoding="utf-8")
REPORTS_PAGE = (ROOT / "frontend" / "src" / "pages-wip-v2" / "ReportsPage.tsx").read_text(encoding="utf-8")
PILE_CONTROL_PAGE = (ROOT / "frontend" / "src" / "pages-wip-v2" / "PileControlPage.tsx").read_text(encoding="utf-8")
DATABASE_PAGE = (ROOT / "frontend" / "src" / "pages-wip-v2" / "DatabasePage.tsx").read_text(encoding="utf-8")


class PileControlIsolationStaticTest(unittest.TestCase):
    def test_common_approved_report_filter_excludes_pile_control(self) -> None:
        helper_block = WIP_ROUTES.split("def _pile_control_report_condition", 1)[1].split("MOVEMENT_TYPE_LABELS", 1)[0]
        self.assertIn("_non_pile_control_report_condition('dr_scope')", helper_block)
        self.assertIn("web_pile_control", helper_block)
        self.assertIn("review_flags", helper_block)

    def test_pile_control_summary_does_not_fallback_to_regular_pile_facts(self) -> None:
        control_block = WIP_ROUTES.split('@router.get("/pile-control/summary")', 1)[1].split("# ── overview table day totals", 1)[0]
        self.assertIn("COALESCE(dr.source_type, '') = 'web_pile_control'", control_block)
        self.assertIn("review_flags", control_block)
        self.assertNotIn("OR EXISTS", control_block)

    def test_non_control_surfaces_have_pile_control_exclusion(self) -> None:
        reinforcement_block = WIP_ROUTES.split('@router.get("/reinforcement-sections/summary")', 1)[1].split('@router.get("/pile-control/summary")', 1)[0]
        self.assertIn("AND NOT (", reinforcement_block)
        self.assertIn("web_pile_control", reinforcement_block)

        self.assertIn('AND {_approved_report_exists("dwi")}', WIP_ANALYTICS)
        self.assertIn('AND {_approved_report_exists("mm")}', WIP_ANALYTICS)

        completed_count_block = REPORTS_ROUTES.split("completed_count", 1)[0].rsplit("SELECT SUM(dwi.volume)::numeric", 1)[1]
        self.assertIn("AND NOT (", completed_count_block)
        self.assertIn("web_pile_control", completed_count_block)

    def test_report_lists_include_pile_control_rows_but_fact_queries_stay_isolated(self) -> None:
        report_where_block = REPORTS_ROUTES.split("def _report_list_where", 1)[1].split("def _decorate_report_list_rows", 1)[0]
        self.assertNotIn("web_pile_control", report_where_block)
        self.assertNotIn("review_flags", report_where_block)

        main_report_list_block = MAIN_API.split("def reports_list", 1)[1].split("def report_detail", 1)[0]
        self.assertNotIn("_non_pile_control_report_condition(\"dr\")", main_report_list_block)
        self.assertIn("_approved_report_exists(\"dwi\")", MAIN_API)
        self.assertIn("_approved_report_exists(\"mm\")", MAIN_API)

    def test_db_admin_views_exclude_pile_control(self) -> None:
        self.assertIn("def _non_pile_control_report_condition", DB_ADMIN)
        self.assertIn("def _daily_report_filter_parts", DB_ADMIN)

        relations_block = DB_ADMIN.split("def reference_relations", 1)[1].split('@router.get("/reference-relations/work-type-object-detail")', 1)[0]
        self.assertIn("_non_pile_control_report_condition('dr')", relations_block)

        detail_block = DB_ADMIN.split("def work_type_object_detail", 1)[1].split('@router.get("/tables")', 1)[0]
        self.assertIn("_non_pile_control_report_condition('dr')", detail_block)

        table_rows_block = DB_ADMIN.split("def table_rows", 1)[1].split('@router.get("/tables/{table}/columns/{column}/suggestions")', 1)[0]
        self.assertIn("_daily_report_filter_parts(table, set(columns))", table_rows_block)

        suggestions_block = DB_ADMIN.split("def column_suggestions", 1)[1].split('@router.post("/tables/{table}/validate")', 1)[0]
        self.assertIn('_non_pile_control_report_condition("t")', suggestions_block)
        self.assertIn('_non_pile_control_report_condition("dr_scope")', suggestions_block)

    def test_database_reference_relations_and_pile_rates_are_scoped(self) -> None:
        self.assertIn('PILE_LENGTH_RATE_WORK_CODES = {"PILE_TRIAL", "PILE_MAIN"}', DB_ADMIN)
        self.assertIn("def _work_type_supports_pile_length_rates", DB_ADMIN)
        self.assertIn("current_pile_lengths_by_work", DB_ADMIN)
        self.assertIn("item[\"pile_rates\"] = []", DB_ADMIN)
        self.assertIn("not _work_type_supports_pile_length_rates(before)", DB_ADMIN)
        self.assertIn("Расценки забивки свай по длине доступны только для работ PILE_TRIAL и PILE_MAIN", DB_ADMIN)

        relations_block = DB_ADMIN.split("def reference_relations", 1)[1].split('@router.get("/reference-relations/work-type-object-detail")', 1)[0]
        self.assertIn("obj.object_code", relations_block)
        self.assertIn("wt.code AS work_type_code", relations_block)
        self.assertIn("tw.code AS work_type_code", relations_block)
        self.assertIn("fact_report_count", relations_block)

        self.assertIn("const PILE_LENGTH_RATE_WORK_CODES = new Set(['PILE_TRIAL', 'PILE_MAIN'])", DATABASE_PAGE)
        self.assertNotIn("DEFAULT_PILE_RATE_LENGTHS", DATABASE_PAGE)
        self.assertIn("function supportsPileLengthRates", DATABASE_PAGE)
        self.assertIn("showPileLengthRates &&", DATABASE_PAGE)
        self.assertIn("Расценки забивки свай по фактическим длинам", DATABASE_PAGE)
        self.assertIn("function relationRawText", DATABASE_PAGE)
        self.assertIn("kind === 'object' || kind === 'work_type'", DATABASE_PAGE)
        self.assertIn("selectedWorkCode", DATABASE_PAGE)
        self.assertIn("selectedObjectCode", DATABASE_PAGE)
        self.assertIn("/reports?report_id=", DATABASE_PAGE)
        self.assertNotIn("Работы с ненулевым проектным объемом", DATABASE_PAGE)
        self.assertIn("Объекты с ненулевым объемом по этой работе", DATABASE_PAGE)

    def test_pile_control_exclusion_helpers_are_not_left_as_plain_sql_literals(self) -> None:
        checked_sources = {
            "db_admin_routes.py": DB_ADMIN,
            "wip_routes.py": WIP_ROUTES,
            "main.py": MAIN_API,
        }
        offenders = []
        for name, source in checked_sources.items():
            tree = ast.parse(source, filename=name)
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    if "{_non_pile_control_report_condition" in node.value:
                        offenders.append(f"{name}:{node.lineno}")
        self.assertEqual([], offenders)

    def test_general_report_generation_paths_exclude_pile_control(self) -> None:
        pile_block = WIP_ROUTES.split("def _query_general_pile_data", 1)[1].split("def _category_bucket", 1)[0]
        self.assertGreaterEqual(pile_block.count('_approved_report_exists("dwi")'), 3)
        self.assertIn("PILE_HEADCAP_INSTALLATION", pile_block)

        general_pipeline_block = WIP_ROUTES.split("def _generate_general_pipeline_xlsx", 1)[1].split("XLSX_PIPELINE_REPORT_SPECS", 1)[0]
        self.assertIn('script_name="generate_general_report.py"', general_pipeline_block)

        cache_fingerprint_block = WIP_ROUTES.split("def _xlsx_report_cache_fingerprint", 1)[1].split("def _xlsx_cache_paths", 1)[0]
        self.assertIn('DIM_PIPELINE_DIR.glob("generate_*_report.py")', cache_fingerprint_block)
        self.assertIn('"scripts_sha256": script_hashes', cache_fingerprint_block)

    def test_generator_and_debug_options_exclude_pile_control_reports(self) -> None:
        option_markers = (
            "def _general_report_quarry_options",
            "def _general_report_source_options",
            "def _general_report_movement_options",
            "def _dashboard_debug_tag_options",
            "def _dashboard_debug_source_object_options",
            "def _dashboard_debug_source_object_type_options",
        )
        for marker in option_markers:
            with self.subTest(marker=marker):
                block = WIP_ROUTES.split(marker, 1)[1].split("\ndef ", 1)[0]
                self.assertIn("daily_reports dr", block)
                self.assertIn("_non_pile_control_report_condition('dr')", block)

        section_reference_block = WIP_ROUTES.split("def _section_reference_payload", 1)[1].split("@router.get", 1)[0]
        self.assertIn('_approved_report_exists("dwi")', section_reference_block)

    def test_regular_reports_upload_pane_does_not_offer_pile_control_input(self) -> None:
        upload_block = REPORTS_PAGE.split("function UploadPane", 1)[1].split("function BatchPreviewPane", 1)[0]
        self.assertNotIn("emptyPileControlPayload", upload_block)
        self.assertNotIn(">Контроль свай</button>", upload_block)

    def test_report_wizard_hides_staff_park_and_exposes_headcap_operation(self) -> None:
        body_block = REPORTS_PAGE.split("function buildReportPayloadBody", 1)[1].split("function PreviewPane", 1)[0]
        self.assertIn("park: []", body_block)
        self.assertIn("staff_counts: []", body_block)

        preview_block = REPORTS_PAGE.split("function PreviewPane", 1)[1].split("      {/* import */}", 1)[0]
        self.assertNotIn("<StaffCountsSection", preview_block)
        self.assertNotIn("<EquipmentParkSection", preview_block)

        extracted_block = REPORTS_PAGE.split("function ExtractedView", 1)[1].split("function sourceLineOf", 1)[0]
        self.assertNotIn("Численность персонала", extracted_block)
        self.assertNotIn("Парк техники", extracted_block)

        pile_block = REPORTS_PAGE.split("function PileDrivingPreviewSection", 1)[1].split("function ReferenceSelect", 1)[0]
        self.assertIn("Операция свайной работы", pile_block)
        self.assertIn("Монтаж наголовников", pile_block)
        self.assertIn("applyOperation(i, option)", pile_block)
        self.assertIn("pileOperationPatch(operation)", REPORTS_PAGE)
        self.assertIn("report_equipment_unit_id: null", pile_block)
        self.assertIn("const isHeadcap = normalizePileOperation(current) === 'headcap'", pile_block)
        self.assertIn("pile_type: isHeadcap && !isPipe ? '' : field.pile_type || ''", pile_block)
        self.assertIn("pile_length_label: isHeadcap && !isPipe ? '' : field.pile_length_label || ''", pile_block)
        self.assertEqual(pile_block.count("{operation === 'driving' && ("), 3)
        self.assertNotIn("value={normalizePileOperation(row)}", pile_block)

    def test_pile_control_value_cards_open_time_and_field_details(self) -> None:
        control_block = WIP_ROUTES.split('@router.get("/pile-control/summary")', 1)[1].split('@router.post("/pile-control/problems', 1)[0]
        self.assertIn("fact_details", control_block)
        self.assertIn("reported_at", control_block)
        self.assertIn("field_code", control_block)
        self.assertIn("pf_obj_detail.field_code", control_block)
        self.assertIn("pf_obj.object_id = dwi.object_id", control_block)
        self.assertIn("pk_label", control_block)
        self.assertIn("equipment_keys", control_block)
        self.assertIn("STRING_AGG(DISTINCT COALESCE(reu.equipment_unit_id::text, reu.id::text)", control_block)

        self.assertIn("function buildFieldSummaries", PILE_CONTROL_PAGE)
        self.assertIn("function uniqueFactDetailCount", PILE_CONTROL_PAGE)
        self.assertIn("time_label", PILE_CONTROL_PAGE)
        self.assertIn("interval_label: intervalLabel", PILE_CONTROL_PAGE)
        self.assertIn("Время забивки и поля", PILE_CONTROL_PAGE)
        self.assertIn("Время забивки", PILE_CONTROL_PAGE)
        self.assertIn("onOpenSectionFacts", PILE_CONTROL_PAGE)
        self.assertIn("onOpenSectionFacts(section)", PILE_CONTROL_PAGE)
        self.assertIn("pc-matrix-value", PILE_CONTROL_PAGE)
        self.assertIn("factFieldLabel(detail)", PILE_CONTROL_PAGE)
        self.assertIn("function openEquipmentFacts", PILE_CONTROL_PAGE)
        self.assertIn("equipmentDetailMatches(detail, item)", PILE_CONTROL_PAGE)
        self.assertIn("EquipmentFactButton", PILE_CONTROL_PAGE)
        self.assertIn("detailLabel={`${item.label}, день`}", PILE_CONTROL_PAGE)
        self.assertIn("title={`Детализация: ${section.label}, ${interval.label}`}", PILE_CONTROL_PAGE)
        self.assertIn("aria-label={`Детализация: ${label}, ${value}`}", PILE_CONTROL_PAGE)
        self.assertIn("onOpenFacts(item, 'day')", PILE_CONTROL_PAGE)

    def test_report_wizard_has_isso_support_input_mode(self) -> None:
        self.assertIn("isso_support_input", REPORTS_PAGE)
        self.assertIn("function IssoSupportInputPane", REPORTS_PAGE)
        self.assertIn("/api/wip/reports/isso-support-input", REPORTS_PAGE)
        upload_block = REPORTS_PAGE.split("function UploadPane", 1)[1].split("      {mode === 'file' ? (", 1)[0]
        self.assertIn("Данные по отсыпке", upload_block)
        self.assertIn("Отсыпка площадок ИССО", upload_block)
        self.assertLess(upload_block.index("Данные по отсыпке"), upload_block.index("Отсыпка площадок ИССО"))
        self.assertIn("onIssoSupportInput={openIssoSupportInputWizard}", REPORTS_PAGE)
        header_block = REPORTS_PAGE.split("mode === 'list' && (", 1)[1].split("        )}", 1)[0]
        self.assertNotIn("Отсыпка площадок ИССО", header_block)
        self.assertIn("Весь ИССО силами МС-11", REPORTS_PAGE)
        self.assertIn("МС-11 зашел", REPORTS_PAGE)
        self.assertIn("fact_months", REPORTS_PAGE)
        self.assertIn("normalizeIssoFactMonths", REPORTS_PAGE)
        self.assertIn("Факт ${issoMonthShortLabel", REPORTS_PAGE)

        self.assertIn('@router.get("/reports/isso-support-input")', WIP_ROUTES)
        self.assertIn('@router.put("/reports/isso-support-input/lines/{line_id}")', WIP_ROUTES)
        self.assertIn("raw_payload = %s::jsonb", WIP_ROUTES)
        self.assertIn("isso_front_transfer_monthly_plan", WIP_ROUTES)
        self.assertIn("IssoSupportInputFactMonthBody", WIP_ROUTES)
        self.assertIn("_isso_support_input_fact_month_map_from_body", WIP_ROUTES)
        self.assertIn("def _require_isso_support_input_user", WIP_ROUTES)
        self.assertIn("reports:input", WIP_ROUTES)

    def test_non_control_ui_copy_does_not_claim_pile_input_sources(self) -> None:
        self.assertNotIn("из отчетов М и ввода контроля", DASHBOARD_PAGE)
        self.assertNotIn("из отчетов М и ввода контроля свай", SETTINGS_PAGE)


if __name__ == "__main__":
    unittest.main()
