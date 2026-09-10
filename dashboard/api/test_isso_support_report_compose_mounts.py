from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = [
    ROOT / "docker-compose.yml",
    ROOT / "docker-compose.wip.yml",
    ROOT / "docker-compose.rf.yml",
]
REQUIRED_REPORT_FILES = [
    "generate_isso_support_report.py",
    "isso_db_template_report.py",
    "isso_xlsx_template_report.py",
    "isso_workbook_layout.py",
]


def test_isso_support_report_dependencies_are_mounted_into_api_containers():
    for compose_file in COMPOSE_FILES:
        text = compose_file.read_text(encoding="utf-8")
        for filename in REQUIRED_REPORT_FILES:
            assert f"/opt/vsm/reports_outgoing/{filename}" in text, f"{filename} missing in {compose_file.name}"
