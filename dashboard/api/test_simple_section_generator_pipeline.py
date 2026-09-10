from __future__ import annotations

import sys
from datetime import date
from unittest import mock

import wip_routes


class _Body:
    def __init__(self, **kwargs):
        self.report_key = kwargs.get('report_key', 'simple_section_report')
        self.section_codes = kwargs.get('section_codes')
        self.date_from = kwargs.get('date_from')
        self.date_to = kwargs.get('date_to')
        self.work_tags = kwargs.get('work_tags')
        self.object_type_codes = kwargs.get('object_type_codes')
        self.object_codes = kwargs.get('object_codes')
        self.cumulative_as_of_end_date = kwargs.get('cumulative_as_of_end_date')
        self.show_daily_pk_details = kwargs.get('show_daily_pk_details')
        self.general_equipment_plan_counts = kwargs.get('general_equipment_plan_counts')


def test_simple_section_report_is_exposed_in_generator_pipeline_reports():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['simple_section_report']
    assert spec['file_type'] == 'xlsx'
    assert spec['period_mode'] == 'range'


def test_temp_roads_tsm_report_is_exposed_in_generator_pipeline_reports():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['temp_roads_tsm_xlsx']
    assert spec['file_type'] == 'xlsx'
    assert spec['period_mode'] == 'date_to'


def test_temp_roads_tsm_state_loader_ignores_display_excluded_filter(tmp_path, monkeypatch):
    import importlib
    from pathlib import Path

    pipeline_src = Path("/opt/vsm/ops/report_pipeline/temp_roads/src")
    if not (pipeline_src / "generate_temp_roads_tsm_xlsx.py").exists():
        return
    if str(pipeline_src) not in sys.path:
        sys.path.insert(0, str(pipeline_src))
    tsm_module = importlib.import_module("generate_temp_roads_tsm_xlsx")
    fake_pdf_module = tmp_path / "fake_temp_roads_pdf.py"
    fake_pdf_module.write_text(
        """
from types import SimpleNamespace
REPORT_DATE = None
TARGET_DATE = None

def is_display_excluded_road_code(code):
    return True

def build_model():
    assert is_display_excluded_road_code('АД15') is False
    return {
        'road_rows': [
            SimpleNamespace(
                road_code='АД15',
                total_length_ad_m=10,
                per_status_state_len={
                    'pioneer_fill': 1,
                    'subgrade_not_to_grade': 2,
                    'dso': 3,
                    'ready_for_shpgs': 4,
                    'shpgs_done': 5,
                },
            )
        ]
    }
""".strip(),
        encoding="utf-8",
    )

    monkeypatch.setattr(tsm_module, "PIPELINE_PDF_MODULE", fake_pdf_module)

    state = tsm_module.load_state_by_road(date(2026, 6, 25))

    assert state["АД15"] == {
        "road_length_m": 10.0,
        "pioneer_fill": 1.0,
        "subgrade_not_to_grade": 2.0,
        "dso": 3.0,
        "ready_for_shpgs": 4.0,
        "shpgs_done": 5.0,
    }


def test_transport_section_report_is_exposed_in_generator_pipeline_reports():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['transport_section_report']
    assert spec['file_type'] == 'xlsx'
    assert spec['period_mode'] == 'range'


def test_financial_plan_fact_report_is_exposed_in_generator_pipeline_reports():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['financial_plan_fact']
    assert spec['file_type'] == 'xlsx'
    assert spec['period_mode'] == 'range'
    assert 'план' in spec['label'].lower()


def test_admin_dumptruck_report_is_exposed_in_generator_pipeline_reports():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['admin_dumptruck']
    assert spec['file_type'] == 'xlsx'
    assert spec['period_mode'] == 'date_to'
    assert 'Административный отчет' in spec['label']


def test_resolve_admin_dumptruck_template_prefers_latest_named_report_date(tmp_path):
    older = tmp_path / 'Административный отчет 19.07.2026.xlsx'
    newer = tmp_path / 'Административный отчет 20.07.2026.xlsx'
    runtime = tmp_path / 'runtime_check_admin_dumptruck_2026-07-21.xlsx'
    older.write_bytes(b'older')
    newer.write_bytes(b'newer')
    runtime.write_bytes(b'runtime')

    with (
        mock.patch.object(wip_routes, 'ADMIN_DUMPTRUCK_TEMPLATE_ENV', None),
        mock.patch.object(wip_routes, 'ADMIN_DUMPTRUCK_REPORT_DIR', tmp_path),
    ):
        resolved = wip_routes._resolve_admin_dumptruck_template()

    assert resolved == newer.resolve()


def test_isso_support_report_is_exposed_as_extended_cards_report():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['isso_support']
    assert spec['file_type'] == 'pdf'
    assert spec['period_mode'] == 'date_to'
    assert 'Отсыпка площадок ИССО' in spec['label']
    assert 'карточками по каждому ИССО' in spec['description']


def test_mainline_structural_scheme_report_is_exposed_as_a3_pdf():
    spec = wip_routes.GENERATOR_PIPELINE_REPORTS['mainline_structural_scheme']
    assert spec['file_type'] == 'pdf'
    assert spec['period_mode'] == 'date_to'
    assert 'Структурная схема ОХ' in spec['label']
    assert 'A3 PDF' in spec['description']


def test_generate_isso_support_pipeline_invokes_extended_db_report(tmp_path):
    script = tmp_path / 'generate_isso_support_report.py'
    script.write_text('# fake pipeline\n', encoding='utf-8')
    captured: dict[str, object] = {}

    def fake_run_report_pipeline(cmd, cwd, **kwargs):
        captured['cmd'] = list(cmd)
        captured['cwd'] = cwd
        output = cmd[cmd.index('--out') + 1]
        with open(output, 'wb') as fh:
            fh.write(b'%PDF extended isso cards')
        return '{"pages": 2, "objects": 1}'

    with (
        mock.patch.object(wip_routes, 'ISSO_SUPPORT_REPORT_SCRIPT', script),
        mock.patch.object(wip_routes, '_run_report_pipeline', side_effect=fake_run_report_pipeline),
    ):
        data, filename_ascii, filename_utf8 = wip_routes._generate_isso_support_pipeline_pdf(date(2026, 7, 5))

    cmd = captured['cmd']
    assert data == b'%PDF extended isso cards'
    assert cmd[0]
    assert str(script) in cmd
    assert '--month' in cmd
    assert cmd[cmd.index('--month') + 1] == '2026-07-01'
    assert '--source-xlsx' not in cmd
    assert filename_ascii == 'VSM_ISSO_Platform_Fill_Extended_2026-07-01.pdf'
    assert filename_utf8 == 'Отсыпка площадок ИССО расширенный 07.2026.pdf'


def test_generate_mainline_structural_scheme_uses_guarded_subprocess(tmp_path):
    script = tmp_path / 'mainline_structural_scheme.py'
    script.write_text('# fake mainline scheme pipeline\n', encoding='utf-8')
    captured: dict[str, object] = {}

    def fake_run_report_pipeline(cmd, cwd, **kwargs):
        captured['cmd'] = list(cmd)
        captured['cwd'] = cwd
        captured['kwargs'] = kwargs
        output = cmd[cmd.index('--output') + 1]
        with open(output, 'wb') as fh:
            fh.write(b'%PDF mainline scheme')
        return '{"sections": 1, "objects": 2}'

    with (
        mock.patch.object(wip_routes, 'MAINLINE_STRUCTURAL_SCHEME_SCRIPT', script),
        mock.patch.object(wip_routes, '_run_report_pipeline', side_effect=fake_run_report_pipeline),
    ):
        data, filename_ascii, filename_utf8 = wip_routes._generate_mainline_structural_scheme_pipeline_pdf(
            date(2026, 8, 31),
            ['UCH_1'],
        )

    cmd = captured['cmd']
    assert data == b'%PDF mainline scheme'
    assert cmd[0]
    assert str(script) in cmd
    assert cmd[cmd.index('--to') + 1] == '2026-08-31'
    assert cmd[cmd.index('--sections') + 1] == 'UCH_1'
    assert captured['cwd'] == script.parent.parent
    assert captured['kwargs']['low_priority'] is True
    assert captured['kwargs']['extra_env']['MPLBACKEND'] == 'Agg'
    assert filename_ascii == 'VSM_Mainline_Structural_Scheme_2026-08-31_UCH_1.pdf'
    assert filename_utf8 == 'Структурная схема ОХ 31.08.2026 UCH_1.pdf'


def test_find_temp_roads_tsm_source_prefers_latest_on_or_before_date(tmp_path):
    older = tmp_path / 'ТСМ отчет по ВрАД 2026-06-22.xlsx'
    newer = tmp_path / 'ТСМ отчет по ВрАД 2026-06-24.xlsx'
    future = tmp_path / 'ТСМ отчет по ВрАД 2026-06-27.xlsx'
    for path in (older, newer, future):
        path.write_bytes(b'x')

    with mock.patch.object(wip_routes, 'TEMP_ROADS_TSM_WORKSPACE', tmp_path):
        picked = wip_routes._find_temp_roads_tsm_source_file(date(2026, 6, 25))
        assert picked == newer


def test_generator_pipeline_export_dispatches_simple_section_report():
    captured: dict[str, object] = {}

    def fake_generate(d_from: date, d_to: date, section_codes: list[str] | None):
        captured['d_from'] = d_from
        captured['d_to'] = d_to
        captured['section_codes'] = section_codes
        return b'xlsx-bytes', 'simple.xlsx', 'Простой отчет.xlsx'

    body = _Body(
        report_key='simple_section_report',
        section_codes=['UCH_3', 'UCH_5'],
        date_from='2026-06-01',
        date_to='2026-06-16',
    )

    with mock.patch.object(wip_routes, '_generate_simple_section_pipeline_xlsx', side_effect=fake_generate):
        response = wip_routes.generator_pipeline_export(body, _user=object())

    assert captured == {
        'd_from': date(2026, 6, 1),
        'd_to': date(2026, 6, 16),
        'section_codes': ['UCH_3', 'UCH_31', 'UCH_32', 'UCH_5'],
    }
    assert response.body == b'xlsx-bytes'
    assert response.media_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'attachment;' in response.headers['content-disposition'].lower()


def test_generator_pipeline_export_dispatches_transport_section_report():
    captured: dict[str, object] = {}

    def fake_generate(d_from: date, d_to: date, section_codes: list[str] | None):
        captured['d_from'] = d_from
        captured['d_to'] = d_to
        captured['section_codes'] = section_codes
        return b'transport-bytes', 'transport.xlsx', 'Перевозный отчет.xlsx'

    body = _Body(
        report_key='transport_section_report',
        section_codes=['UCH_3', 'UCH_5'],
        date_from='2026-06-01',
        date_to='2026-06-16',
    )

    with mock.patch.object(wip_routes, '_generate_transport_section_pipeline_xlsx', side_effect=fake_generate):
        response = wip_routes.generator_pipeline_export(body, _user=object())

    assert captured == {
        'd_from': date(2026, 6, 1),
        'd_to': date(2026, 6, 16),
        'section_codes': ['UCH_3', 'UCH_31', 'UCH_32', 'UCH_5'],
    }
    assert response.body == b'transport-bytes'
    assert response.media_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'attachment;' in response.headers['content-disposition'].lower()


def test_generator_pipeline_export_dispatches_financial_plan_fact_report():
    captured: dict[str, object] = {}

    def fake_generate(d_from: date, d_to: date, section_codes: list[str] | None):
        captured['d_from'] = d_from
        captured['d_to'] = d_to
        captured['section_codes'] = section_codes
        return b'financial-bytes', 'financial.xlsx', 'Финансовый план-факт.xlsx'

    body = _Body(
        report_key='financial_plan_fact',
        section_codes=['UCH_3', 'UCH_5'],
        date_from='2026-08-01',
        date_to='2026-08-31',
    )

    with mock.patch.object(wip_routes, '_generate_financial_plan_fact_pipeline_xlsx', side_effect=fake_generate):
        response = wip_routes.generator_pipeline_export(body, _user=object())

    assert captured == {
        'd_from': date(2026, 8, 1),
        'd_to': date(2026, 8, 31),
        'section_codes': ['UCH_3', 'UCH_31', 'UCH_32', 'UCH_5'],
    }
    assert response.body == b'financial-bytes'
    assert response.media_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'attachment;' in response.headers['content-disposition'].lower()


def test_generator_pipeline_export_dispatches_temp_roads_tsm_report():
    captured: dict[str, object] = {}

    def fake_generate(report_date: date):
        captured['report_date'] = report_date
        return b'tsm-bytes', 'tsm.xlsx', 'ТСМ отчет.xlsx'

    body = _Body(
        report_key='temp_roads_tsm_xlsx',
        date_from='2026-06-24',
        date_to='2026-06-25',
    )

    with mock.patch.object(wip_routes, '_generate_temp_roads_tsm_pipeline_xlsx', side_effect=fake_generate):
        response = wip_routes.generator_pipeline_export(body, _user=object())

    assert captured == {'report_date': date(2026, 6, 25)}
    assert response.body == b'tsm-bytes'
    assert response.media_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'attachment;' in response.headers['content-disposition'].lower()


def test_generator_pipeline_export_dispatches_admin_dumptruck_report():
    captured: dict[str, object] = {}

    def fake_generate(report_date: date):
        captured['report_date'] = report_date
        return b'admin-bytes', 'admin.xlsx', 'Административный отчет.xlsx'

    body = _Body(
        report_key='admin_dumptruck',
        date_from='2026-07-20',
        date_to='2026-07-21',
    )

    with mock.patch.object(wip_routes, '_generate_admin_dumptruck_pipeline_xlsx', side_effect=fake_generate):
        response = wip_routes.generator_pipeline_export(body, _user=object())

    assert captured == {'report_date': date(2026, 7, 21)}
    assert response.body == b'admin-bytes'
    assert response.media_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'attachment;' in response.headers['content-disposition'].lower()


def test_admin_dumptruck_background_job_info_uses_wrapper_and_template(tmp_path):
    wrapper = tmp_path / 'generate_admin_dumptruck_report.sh'
    template = tmp_path / 'Административный отчет 20.07.2026.xlsx'
    wrapper.write_text('#!/usr/bin/env bash\nexit 0\n', encoding='utf-8')
    template.write_bytes(b'template')

    with (
        mock.patch.object(wip_routes, 'ADMIN_DUMPTRUCK_WRAPPER', wrapper),
        mock.patch.object(wip_routes, 'ADMIN_DUMPTRUCK_TEMPLATE_ENV', None),
        mock.patch.object(wip_routes, 'ADMIN_DUMPTRUCK_REPORT_DIR', tmp_path),
        mock.patch.object(wip_routes, '_xlsx_report_cache_fingerprint', return_value='f' * 64),
    ):
        info = wip_routes._xlsx_pipeline_job_info(
            'admin_dumptruck',
            date(2026, 7, 20),
            date(2026, 7, 21),
        )

    assert info['report_key'] == 'admin_dumptruck'
    assert info['script'] == str(wrapper)
    assert info['template'] == str(template.resolve())
    assert info['output_name'] == 'admin_dumptruck_report.xlsx'
    assert info['filename_ascii'] == 'VSM_Admin_Dumptruck_2026-07-21.xlsx'
    assert info['filename_utf8'] == 'Административный отчет 2026-07-21.xlsx'
    assert info['artifact'].endswith('/admin_dumptruck/admin_dumptruck_2026-07-20_2026-07-21_ffffffffffffffffffff.xlsx')


def test_financial_plan_fact_background_job_info_uses_pipeline_script(tmp_path):
    script = tmp_path / 'generate_financial_plan_fact_report.py'
    script.write_text('# fake financial pipeline\n', encoding='utf-8')

    with (
        mock.patch.object(wip_routes, 'FINANCIAL_PLAN_FACT_REPORT_SCRIPT', script),
        mock.patch.object(wip_routes, '_xlsx_report_cache_fingerprint', return_value='e' * 64) as fingerprint,
    ):
        info = wip_routes._xlsx_pipeline_job_info(
            'financial_plan_fact',
            date(2026, 8, 1),
            date(2026, 8, 31),
            section_codes=['UCH_1', 'UCH_3'],
        )

    assert info['report_key'] == 'financial_plan_fact'
    assert info['script'] == str(script)
    assert info['template'] == str(script)
    assert info['output_name'] == 'financial_plan_fact.xlsx'
    assert info['filename_ascii'] == 'VSM_Financial_Plan_Fact_2026-08-01_2026-08-31.xlsx'
    assert info['filename_utf8'] == 'Финансовый план-факт 1, 3 2026-08-01 - 2026-08-31.xlsx'
    assert info['section_codes'] == ['UCH_1', 'UCH_3']
    assert info['artifact'].endswith('/financial_plan_fact/financial_plan_fact_2026-08-01_2026-08-31_eeeeeeeeeeeeeeeeeeee.xlsx')
    assert fingerprint.call_args.kwargs['filter_env']['VSM_FINANCIAL_PLAN_FACT_SECTION_CODES_JSON'] == '["UCH_1", "UCH_3"]'


def test_ensure_xlsx_export_job_artifact_dispatches_financial_plan_fact(tmp_path):
    artifact = tmp_path / 'financial.xlsx'
    meta_path = tmp_path / 'financial.metadata.json'
    lock_path = tmp_path / 'financial.lock'
    job = {
        'report_key': 'financial_plan_fact',
        'date_from': '2026-08-01',
        'date_to': '2026-08-31',
        'fingerprint': 'e' * 64,
        'artifact': str(artifact),
        'meta_path': str(meta_path),
        'lock_path': str(lock_path),
        'section_codes': ['UCH_1'],
    }

    with mock.patch.object(wip_routes, '_ensure_cached_financial_plan_fact_xlsx_artifact', return_value=artifact) as ensure:
        result = wip_routes._ensure_xlsx_export_job_artifact(job)

    assert result == artifact
    ensure.assert_called_once()
    assert ensure.call_args.kwargs['section_codes'] == ['UCH_1']


def test_generator_pipeline_export_job_accepts_admin_dumptruck_background_export():
    body = _Body(
        report_key='admin_dumptruck',
        date_from='2026-07-20',
        date_to='2026-07-21',
    )
    info = {
        'job_id': 'admin-job-1',
        'report_key': 'admin_dumptruck',
        'date_from': '2026-07-20',
        'date_to': '2026-07-21',
        'script': '/tmp/generate_admin_dumptruck_report.sh',
        'template': '/tmp/template.xlsx',
        'output_name': 'admin_dumptruck_report.xlsx',
        'filename_ascii': 'VSM_Admin_Dumptruck_2026-07-21.xlsx',
        'filename_utf8': 'Административный отчет 2026-07-21.xlsx',
        'filter_env': {},
        'fingerprint': 'f' * 64,
        'artifact': '/tmp/admin_dumptruck.xlsx',
        'meta_path': '/tmp/admin_dumptruck.metadata.json',
        'lock_path': '/tmp/admin_dumptruck.lock',
        'media_type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
    started: dict[str, object] = {}

    class FakeThread:
        def __init__(self, target=None, args=(), daemon=None):
            started['target'] = target
            started['args'] = args
            started['daemon'] = daemon

        def start(self):
            started['started'] = True

    with (
        mock.patch.object(wip_routes, '_xlsx_pipeline_job_info', return_value=info),
        mock.patch.object(wip_routes, '_cached_xlsx_ready', return_value=False),
        mock.patch.object(wip_routes.threading, 'Thread', FakeThread),
        mock.patch.dict(wip_routes.XLSX_EXPORT_JOBS, {}, clear=True),
    ):
        response = wip_routes.generator_pipeline_export_job(body, _user=object())

    assert response['job_id'] == 'admin-job-1'
    assert response['status'] == 'queued'
    assert response['ready'] is False
    assert response['filename'] == 'Административный отчет 2026-07-21.xlsx'
    assert started['args'] == ('admin-job-1',)
    assert started['daemon'] is True
    assert started['started'] is True


def test_run_report_pipeline_kills_process_when_memory_limit_exceeded(tmp_path):
    with (
        mock.patch.object(wip_routes, 'REPORT_PIPELINE_MEMORY_LIMIT_MB', 1),
        mock.patch.object(wip_routes, 'REPORT_PIPELINE_MEMORY_CHECK_INTERVAL_SECONDS', 0.01),
        mock.patch.object(wip_routes, '_process_tree_memory_kb', return_value=2048),
    ):
        try:
            wip_routes._run_report_pipeline(
                [sys.executable, '-c', 'import time; time.sleep(10)'],
                tmp_path,
                timeout=2,
            )
        except wip_routes.HTTPException as exc:
            assert exc.status_code == 507
            assert 'memory limit' in str(exc.detail)
        else:
            raise AssertionError('pipeline should have been killed by memory guard')


def test_run_report_pipeline_uses_generator_lock(tmp_path):
    events = []

    class FakeLock:
        def __enter__(self):
            events.append('enter')

        def __exit__(self, exc_type, exc, tb):
            events.append('exit')

    with (
        mock.patch.object(wip_routes, 'XLSX_GENERATOR_RUN_LOCK', FakeLock()),
        mock.patch.object(wip_routes, '_run_report_pipeline_locked', return_value='ok') as run_locked,
    ):
        result = wip_routes._run_report_pipeline(
            [sys.executable, '-c', 'print("ok")'],
            tmp_path,
            timeout=2,
            low_priority=True,
        )

    assert result == 'ok'
    assert events == ['enter', 'exit']
    run_locked.assert_called_once_with(
        [sys.executable, '-c', 'print("ok")'],
        tmp_path,
        timeout=2,
        extra_env=None,
        low_priority=True,
    )
