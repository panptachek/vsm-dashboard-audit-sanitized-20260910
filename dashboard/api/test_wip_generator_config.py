#!/usr/bin/env python3
from __future__ import annotations

import unittest
import base64
import json

try:
    import fastapi  # noqa: F401
except ModuleNotFoundError:
    import sys
    import types

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda fn: fn

        post = put = patch = delete = get

    def passthrough(*args, **kwargs):
        return None

    fastapi_stub = types.ModuleType("fastapi")
    fastapi_stub.APIRouter = APIRouter
    fastapi_stub.Depends = passthrough
    fastapi_stub.File = passthrough
    fastapi_stub.Header = passthrough
    fastapi_stub.Query = passthrough
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.UploadFile = object
    sys.modules["fastapi"] = fastapi_stub

    responses_stub = types.ModuleType("fastapi.responses")
    responses_stub.FileResponse = object
    responses_stub.Response = object
    responses_stub.StreamingResponse = object
    sys.modules["fastapi.responses"] = responses_stub

    pydantic_stub = types.ModuleType("pydantic")
    pydantic_stub.BaseModel = object
    pydantic_stub.Field = lambda default=None, **kwargs: default
    sys.modules.setdefault("pydantic", pydantic_stub)

    main_stub = types.ModuleType("main")
    main_stub.query = lambda *args, **kwargs: []
    main_stub.query_one = lambda *args, **kwargs: None
    main_stub.get_conn = lambda: None
    sys.modules["main"] = main_stub

    auth_stub = types.ModuleType("auth")
    auth_stub.current_user = lambda: None
    auth_stub.require_admin = lambda: None
    auth_stub.require_settings_manager = lambda: None
    auth_stub.require_statements_project_writer = lambda: None
    sys.modules["auth"] = auth_stub

import wip_routes


class WipGeneratorConfigTests(unittest.TestCase):
    def test_normalize_general_report_config_preserves_block_order(self):
        payload = {
            "blocks": [
                {
                    "id": "custom_ops",
                    "kind": "custom",
                    "title": "Операторский блок",
                    "rows": [
                        {
                            "id": "custom_ops_row_1",
                            "code": "custom_ops_row_1",
                            "label": "Новая строка",
                            "source": "work_category",
                            "filters": {"tags": ["Планировка"]},
                        }
                    ],
                },
                {"id": "equipment_day", "title": "Техника"},
                {"id": "top_quarries", "title": "Возка"},
            ]
        }
        config = wip_routes._normalize_general_report_config(payload)
        self.assertEqual(
            [block["id"] for block in config["blocks"]],
            ["custom_ops", "equipment_day", "top_quarries", "work_summary"],
        )

    def test_matching_work_rule_returns_full_rule(self):
        rules = [
            {
                "id": "sand_1",
                "code": "SAND",
                "label": "Песок",
                "enabled": True,
                "filters": {
                    "tags": ["Устройство насыпи"],
                    "object_type_codes": ["MAIN_TRACK"],
                    "object_codes": [],
                    "source_buckets": ["own"],
                },
            }
        ]
        matched = wip_routes._general_matching_work_rule(
            rules,
            tag="Устройство насыпи",
            object_type_code="MAIN_TRACK",
            object_code=None,
            source_bucket="own",
        )
        self.assertIsNotNone(matched)
        self.assertEqual(matched["label"], "Песок")
        self.assertEqual(
            wip_routes._general_configured_work_category(
                rules,
                tag="Устройство насыпи",
                object_type_code="MAIN_TRACK",
                object_code=None,
                source_bucket="own",
            ),
            "SAND",
        )

    def test_debug_kind_uses_row_source(self):
        self.assertEqual(
            wip_routes._general_report_debug_kind_from_row(
                {"id": "custom_ops", "kind": "custom"},
                {"source": "top_quarry"},
            ),
            "top_quarries",
        )
        self.assertEqual(
            wip_routes._general_report_debug_kind_from_row(
                {"id": "custom_ops", "kind": "custom"},
                {"source": "equipment_count"},
            ),
            "equipment_day",
        )

    def test_normalize_generator_report_parameters_preserves_options(self):
        payload = {
            "reports": {
                "dim": {
                    "cumulative_as_of_end_date": True,
                    "include_quarry_totals": False,
                    "grouping": "objects",
                    "work_tags": [" Выемка ", ""],
                    "object_type_codes": ["MAIN_TRACK"],
                    "object_codes": ["АД4.8"],
                    "sections": [
                        {"id": "main_track", "title": "Основной ход", "enabled": False},
                        {"id": "custom_ops", "title": "Новый раздел", "enabled": True},
                    ],
                }
            }
        }
        config = wip_routes._normalize_generator_report_parameters(payload)
        report = config["reports"]["dim"]
        self.assertIn("mstroy_graph", config["reports"])
        self.assertTrue(report["cumulative_as_of_end_date"])
        self.assertTrue(report["show_daily_pk_details"])
        self.assertFalse(report["include_quarry_totals"])
        self.assertEqual(report["grouping"], "objects")
        self.assertEqual(report["work_tags"], ["Выемка"])
        self.assertEqual(report["object_type_codes"], ["MAIN_TRACK"])
        self.assertEqual(report["object_codes"], ["АД4.8"])
        sections_by_id = {section["id"]: section for section in report["sections"]}
        self.assertFalse(sections_by_id["main_track"]["enabled"])
        self.assertEqual(sections_by_id["main_track"]["title"], "Основной ход")
        self.assertEqual(sections_by_id["custom_ops"]["title"], "Новый раздел")

    def test_report_parameters_env_applies_saved_filters_and_sections(self):
        parameters = wip_routes._normalize_generator_report_parameters({
            "reports": {
                "mstroy_graph": {
                    "cumulative_as_of_end_date": True,
                    "include_quarry_totals": False,
                    "work_tags": ["ПРС"],
                    "object_type_codes": ["PIPE"],
                    "object_codes": ["PIPE_2665"],
                    "sections": [
                        {"id": "pile_fields", "title": "Усиление", "enabled": True},
                        {"id": "materials", "title": "Материалы", "enabled": False},
                    ],
                }
            }
        })

        env = wip_routes._report_parameters_env("mstroy_graph", parameters=parameters)

        self.assertEqual(env["DIM_REPORT_CUMULATIVE_AS_OF_END_DATE"], "1")
        self.assertEqual(env["DIM_REPORT_INCLUDE_QUARRY_TOTALS"], "0")
        self.assertEqual(env["DIM_REPORT_FILTER_WORK_TAGS"], '["ПРС"]')
        self.assertEqual(env["DIM_REPORT_FILTER_OBJECT_TYPES"], '["PIPE"]')
        self.assertEqual(env["DIM_REPORT_FILTER_OBJECTS"], '["PIPE_2665"]')
        self.assertIn("pile_fields", env["DIM_REPORT_ENABLED_SECTIONS"])
        self.assertNotIn("materials", env["DIM_REPORT_ENABLED_SECTIONS"])
        self.assertIn("Усиление", env["DIM_REPORT_SECTION_TITLES_JSON"])

    def test_find_block_and_row_supports_cross_block_lookup(self):
        config = {
            "blocks": [
                {"id": "top_quarries", "rows": [{"id": "row_a"}]},
                {"id": "custom_ops", "rows": [{"id": "row_b"}]},
            ]
        }
        block, row = wip_routes._general_report_find_block_and_row("row_b", config=config)
        self.assertEqual(block["id"], "custom_ops")
        self.assertEqual(row["id"], "row_b")

    def test_daily_report_email_settings_normalizes_legacy_addresses(self):
        payload = wip_routes._normalize_daily_report_email_settings({
            "enabled": False,
            "recipients": "FIRST@example.com; second@example.com\nfirst@example.com",
            "cc": ["copy@example.com, COPY@example.com"],
            "bcc": "hidden@example.com",
            "subject_prefix": " VSM тест ",
            "send_time_local": "08:30",
        })

        self.assertFalse(payload["enabled"])
        self.assertEqual(payload["groups"][0]["name"], "Основная группа")
        self.assertEqual(payload["groups"][0]["recipients"], ["first@example.com", "second@example.com"])
        self.assertEqual(payload["groups"][0]["cc"], ["copy@example.com"])
        self.assertNotIn("bcc", payload["groups"][0])
        self.assertEqual(payload["groups"][0]["subject_prefix"], "VSM тест")
        self.assertEqual(payload["send_time_local"], "08:30")
        self.assertTrue(payload["file_options"])

    def test_daily_report_email_message_uses_attachment_text_without_bcc(self):
        msg, recipients = wip_routes._daily_report_email_message(
            config={
                "from_email": "VSM <robot@example.com>",
                "from_addr": "robot@example.com",
                "reply_to": "",
            },
            group={
                "name": "Производство",
                "recipients": ["ops@example.com"],
                "cc": ["lead@example.com"],
                "bcc": ["hidden@example.com"],
                "subject_prefix": "VSM тест",
            },
            attachments=[
                {
                    "key": "general",
                    "label": "Общий отчет",
                    "filename_ascii": "general.pdf",
                    "media_type": "application/pdf",
                    "content": b"%PDF",
                    "size_bytes": 4,
                    "report_date_from": "2026-08-03",
                    "report_date": "2026-08-09",
                    "cumulative_as_of_end_date": True,
                },
                {
                    "key": wip_routes.DAILY_REPORT_WORD_INSTRUCTION_ATTACHMENT_KEY,
                    "label": "Word-инструкция по проверке отчета",
                    "filename_ascii": "instruction.docx",
                    "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "content": b"docx",
                    "size_bytes": 4,
                    "report_date": None,
                },
            ],
            send_date=wip_routes.date_cls(2026, 8, 10),
        )

        body = msg.get_body(preferencelist=("plain",)).get_content()
        self.assertEqual(recipients, ["ops@example.com", "lead@example.com"])
        self.assertIn("Добрый день!", body)
        self.assertIn("Во вложении файлы ежедневной рассылки служебной отчетности:", body)
        self.assertIn("- Общий отчет — период 03.08.2026 - 09.08.2026, накопительные итоги на 09.08.2026", body)
        self.assertIn("- Word-инструкция по проверке отчета — без даты", body)
        self.assertNotIn("hidden@example.com", recipients)

    def test_daily_report_email_resend_payload_encodes_attachments(self):
        requests: list[object] = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"id":"email_123"}'

        original_urlopen = wip_routes.urllib.request.urlopen
        try:
            def fake_urlopen(request, timeout):
                requests.append((request, timeout))
                return FakeResponse()

            wip_routes.urllib.request.urlopen = fake_urlopen
            config = {
                "provider": "resend",
                "provider_label": "Resend API",
                "api_key": "re_test",
                "api_url": "https://api.resend.com/emails",
                "from_email": "VSM Reports <onboarding@resend.dev>",
                "from_addr": "onboarding@resend.dev",
                "reply_to": "reply@example.com",
                "timeout_seconds": 7,
            }
            msg, _recipients = wip_routes._daily_report_email_message(
                config=config,
                group={
                    "name": "Производство",
                    "recipients": ["ops@example.com"],
                    "cc": ["lead@example.com"],
                    "subject_prefix": "VSM тест",
                },
                attachments=[
                    {
                        "key": "general",
                        "label": "Общий отчет",
                        "filename_ascii": "general.xlsx",
                        "media_type": wip_routes.XLSX_MEDIA_TYPE,
                        "content": b"xlsx-bytes",
                        "size_bytes": 10,
                        "report_date": "2026-08-09",
                    }
                ],
                send_date=wip_routes.date_cls(2026, 8, 10),
            )

            message_id = wip_routes._daily_report_email_send_resend_message(
                config=config,
                msg=msg,
                recipients=["ops@example.com"],
                cc=["lead@example.com"],
                attachments=[
                    {
                        "filename_ascii": "general.xlsx",
                        "filename_utf8": "Общий отчет.xlsx",
                        "content": b"xlsx-bytes",
                    }
                ],
            )
        finally:
            wip_routes.urllib.request.urlopen = original_urlopen

        self.assertEqual(message_id, "email_123")
        self.assertEqual(len(requests), 1)
        request, timeout = requests[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(timeout, 7)
        self.assertEqual(payload["from"], "VSM Reports <onboarding@resend.dev>")
        self.assertEqual(payload["to"], ["ops@example.com"])
        self.assertEqual(payload["cc"], ["lead@example.com"])
        self.assertEqual(payload["reply_to"], ["reply@example.com"])
        self.assertEqual(payload["attachments"][0]["filename"], "Общий отчет.xlsx")
        self.assertEqual(payload["attachments"][0]["content"], base64.b64encode(b"xlsx-bytes").decode("ascii"))

    def test_daily_report_email_gmail_api_sends_raw_message(self):
        requests: list[object] = []
        responses = [b'{"access_token":"ya29.test"}', b'{"id":"gmail_123"}']

        class FakeResponse:
            def __init__(self, payload: bytes):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return self.payload

        original_urlopen = wip_routes.urllib.request.urlopen
        try:
            def fake_urlopen(request, timeout):
                requests.append((request, timeout))
                return FakeResponse(responses.pop(0))

            wip_routes.urllib.request.urlopen = fake_urlopen
            config = {
                "provider": "gmail_api",
                "provider_label": "Gmail API",
                "client_id": "client-id",
                "client_secret": "client-secret",
                "refresh_token": "refresh-token",
                "token_url": "https://oauth2.googleapis.com/token",
                "send_url": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                "from_email": "VSM Reports <sender@example.com>",
                "from_addr": "sender@example.com",
                "reply_to": "reply@example.com",
                "timeout_seconds": 9,
            }
            msg, _recipients = wip_routes._daily_report_email_message(
                config=config,
                group={
                    "name": "Проверка",
                    "recipients": ["ops@example.com"],
                    "cc": [],
                    "subject_prefix": "VSM тест",
                },
                attachments=[],
                send_date=wip_routes.date_cls(2026, 8, 10),
            )

            message_id = wip_routes._daily_report_email_send_gmail_api_message(config=config, msg=msg)
        finally:
            wip_routes.urllib.request.urlopen = original_urlopen

        self.assertEqual(message_id, "gmail_123")
        self.assertEqual(len(requests), 2)
        token_request, token_timeout = requests[0]
        send_request, send_timeout = requests[1]
        self.assertEqual(token_timeout, 9)
        self.assertEqual(send_timeout, 9)
        self.assertEqual(token_request.full_url, "https://oauth2.googleapis.com/token")
        token_payload = wip_routes.urllib.parse.parse_qs(token_request.data.decode("utf-8"))
        self.assertEqual(token_payload["grant_type"], ["refresh_token"])
        self.assertEqual(token_payload["refresh_token"], ["refresh-token"])
        self.assertEqual(send_request.get_header("Authorization"), "Bearer ya29.test")
        send_payload = json.loads(send_request.data.decode("utf-8"))
        raw_message = base64.urlsafe_b64decode(send_payload["raw"].encode("ascii"))
        self.assertIn(b"Subject: VSM", raw_message)
        self.assertIn(b"ops@example.com", raw_message)

    def test_daily_report_email_attachment_text_suffix_formats_plain_totals(self):
        suffix = wip_routes._daily_report_email_attachment_text_suffix({
            "key": "general",
            "report_date_from": "2026-08-03",
            "report_date": "2026-08-09",
            "cumulative_as_of_end_date": False,
        })

        self.assertEqual(suffix, " — период 03.08.2026 - 09.08.2026, итоги на 09.08.2026")

    def test_daily_report_email_settings_normalizes_groups_and_files(self):
        payload = wip_routes._normalize_daily_report_email_settings({
            "enabled": True,
            "send_time_local": "09:15",
            "groups": [
                {
                    "id": "ops",
                    "name": "Производство",
                    "recipients": "ops@example.com; lead@example.com",
                    "report_keys": [
                        "daily_report_template_xlsx",
                        "daily_report_instruction_docx",
                        "general",
                        "equipment",
                        "general",
                    ],
                    "report_configs": {
                        "general": {
                            "date_mode": "custom",
                            "date_from": "2026-08-01",
                            "date": "2026-08-09",
                            "cumulative_as_of_end_date": True,
                            "use_cache": True,
                        }
                    },
                }
            ],
        }, require_recipients_when_enabled=True)

        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["groups"][0]["id"], "ops")
        self.assertEqual(payload["groups"][0]["recipients"], ["ops@example.com", "lead@example.com"])
        self.assertEqual(
            payload["groups"][0]["report_keys"],
            ["daily_report_template_xlsx", "daily_report_instruction_docx", "general", "equipment"],
        )
        self.assertEqual(payload["groups"][0]["report_configs"]["general"]["date"], "2026-08-09")
        self.assertEqual(payload["groups"][0]["report_configs"]["general"]["date_from"], "2026-08-01")
        self.assertTrue(payload["groups"][0]["report_configs"]["general"]["cumulative_as_of_end_date"])
        self.assertTrue(payload["groups"][0]["report_configs"]["general"]["use_cache"])
        self.assertEqual(payload["send_time_local"], "09:15")
        option_keys = {option["key"] for option in payload["file_options"]}
        self.assertIn("daily_report_template_xlsx", option_keys)
        self.assertIn("daily_report_instruction_docx", option_keys)
        generator_options = {option["key"]: option for option in payload["file_options"] if option.get("kind") == "generator"}
        self.assertTrue(generator_options["general"]["configurable_date"])

    def test_daily_report_email_settings_excludes_mainline_scheme_from_mailing(self):
        payload = wip_routes._normalize_daily_report_email_settings({
            "enabled": True,
            "groups": [
                {
                    "name": "Производство",
                    "recipients": ["ops@example.com"],
                    "report_keys": ["mainline_structural_scheme", "general"],
                    "report_configs": {
                        "general": {
                            "date_mode": "custom",
                            "date": "2026-08-31",
                            "use_cache": False,
                        }
                    },
                }
            ],
        }, require_recipients_when_enabled=True, strict_file_keys=False)

        self.assertEqual(payload["groups"][0]["report_keys"], ["general"])
        self.assertFalse(payload["groups"][0]["report_configs"]["general"]["use_cache"])
        generator_options = {option["key"]: option for option in payload["file_options"] if option.get("kind") == "generator"}
        self.assertNotIn("mainline_structural_scheme", generator_options)
        self.assertTrue(generator_options["general"]["supports_cache_reuse"])

    def test_daily_report_email_settings_rejects_mainline_scheme_on_save(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [
                    {
                        "name": "Производство",
                        "recipients": ["ops@example.com"],
                        "report_keys": ["mainline_structural_scheme"],
                    }
                ],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("mainline_structural_scheme", getattr(raised.exception, "detail", str(raised.exception)))

    def test_daily_report_email_settings_keeps_cache_reuse_optional(self):
        payload = wip_routes._normalize_daily_report_email_settings({
            "enabled": True,
            "groups": [
                {
                    "name": "Производство",
                    "recipients": ["ops@example.com"],
                    "report_keys": ["general"],
                    "report_configs": {
                        "general": {
                            "date_mode": "custom",
                            "date": "2026-08-31",
                            "use_cache": False,
                        }
                    },
                }
            ],
        }, require_recipients_when_enabled=True)

        config = payload["groups"][0]["report_configs"]["general"]
        self.assertFalse(config["use_cache"])
        generator_options = {option["key"]: option for option in payload["file_options"] if option.get("kind") == "generator"}
        self.assertTrue(generator_options["general"]["supports_cache_reuse"])

    def test_daily_report_email_settings_rejects_invalid_email(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [{"name": "Производство", "recipients": ["not-an-email"], "report_keys": ["general"]}],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("Некорректные email", getattr(raised.exception, "detail", str(raised.exception)))

    def test_daily_report_email_settings_rejects_invalid_file_key(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [{"name": "Производство", "recipients": ["ops@example.com"], "report_keys": ["unknown_file"]}],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("Некорректные файлы", getattr(raised.exception, "detail", str(raised.exception)))

    def test_daily_report_email_settings_rejects_invalid_report_date(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [
                    {
                        "name": "Производство",
                        "recipients": ["ops@example.com"],
                        "report_keys": ["general"],
                        "report_configs": {"general": {"date_mode": "custom", "date": "09.08.2026"}},
                    }
                ],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("ожидается дата YYYY-MM-DD", getattr(raised.exception, "detail", str(raised.exception)))

    def test_daily_report_email_settings_rejects_reversed_report_period(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [
                    {
                        "name": "Производство",
                        "recipients": ["ops@example.com"],
                        "report_keys": ["general"],
                        "report_configs": {
                            "general": {
                                "date_mode": "custom",
                                "date_from": "2026-08-10",
                                "date": "2026-08-09",
                            }
                        },
                    }
                ],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("дата начала должна быть не позже даты окончания", getattr(raised.exception, "detail", str(raised.exception)))

    def test_daily_report_email_effective_period_defaults_week_for_range_reports(self):
        send_date = wip_routes.date_cls(2026, 8, 10)
        d_from, d_to = wip_routes._daily_report_email_effective_report_period(
            "general",
            wip_routes._daily_report_email_default_report_config(),
            send_date,
        )
        self.assertEqual(d_from.isoformat(), "2026-08-03")
        self.assertEqual(d_to.isoformat(), "2026-08-09")

        d_from, d_to = wip_routes._daily_report_email_effective_report_period(
            "equipment",
            wip_routes._daily_report_email_default_report_config(),
            send_date,
        )
        self.assertEqual(d_from.isoformat(), "2026-08-09")
        self.assertEqual(d_to.isoformat(), "2026-08-09")

    def test_daily_report_email_custom_range_without_start_defaults_week(self):
        payload = wip_routes._normalize_daily_report_email_settings({
            "enabled": True,
            "groups": [
                {
                    "name": "Производство",
                    "recipients": ["ops@example.com"],
                    "report_keys": ["general"],
                    "report_configs": {"general": {"date_mode": "custom", "date": "2026-08-09"}},
                }
            ],
        }, require_recipients_when_enabled=True)

        config = payload["groups"][0]["report_configs"]["general"]
        self.assertEqual(config["date_from"], "2026-08-03")
        self.assertEqual(config["date"], "2026-08-09")

    def test_daily_report_email_settings_requires_recipient_when_enabled(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [{"name": "Производство", "recipients": [], "report_keys": ["general"]}],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)

    def test_daily_report_email_settings_requires_files_when_enabled(self):
        with self.assertRaises(Exception) as raised:
            wip_routes._normalize_daily_report_email_settings({
                "enabled": True,
                "groups": [{"name": "Производство", "recipients": ["ops@example.com"], "report_keys": []}],
            }, require_recipients_when_enabled=True)

        self.assertEqual(getattr(raised.exception, "status_code", None), 400)
        self.assertIn("выберите хотя бы один файл", getattr(raised.exception, "detail", str(raised.exception)))


if __name__ == "__main__":
    unittest.main()
