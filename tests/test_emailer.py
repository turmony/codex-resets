import smtplib
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfoNotFoundError

from codex_reset_monitor.domain import parse_status
from tests.fixtures import valid_status_payload


class FakeSMTP:
    instances = []
    failure = None

    def __init__(self, host, port, *, timeout, context):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.context = context
        self.login_arguments = None
        self.messages = []
        type(self).instances.append(self)

    def __enter__(self):
        if type(self).failure is not None:
            raise type(self).failure("private transport detail")
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def login(self, email, auth_code):
        self.login_arguments = (email, auth_code)

    def send_message(self, message):
        self.messages.append(message)


class RenderMailTests(unittest.TestCase):
    def setUp(self):
        self.payload = valid_status_payload()
        self.payload["data"]["latest_reset"]["announced_at"] = "2026-08-27T16:35:05Z"
        self.payload["data"]["latest_reset"]["text"] = "A regular reset announcement."
        self.status = parse_status(self.payload)
        self.checked_at = datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc)

    def test_activation_contains_current_reset_and_beijing_time(self):
        from codex_reset_monitor.emailer import render_activation

        content = render_activation(self.status, self.checked_at)

        self.assertEqual(content.subject, "[Codex Resets] 监控已启用")
        self.assertIn("2026-08-27 16:35:05 UTC", content.body)
        self.assertIn("2026-08-28 00:35:05 北京时间", content.body)
        self.assertIn("reset announcement", content.body)

    def test_new_watch_uses_probability_subject_and_includes_prediction_fields(self):
        from codex_reset_monitor.emailer import render_watch

        content = render_watch(self.status.active_watch, self.checked_at, is_update=False)

        self.assertEqual(content.subject, "[Codex Resets] 重置预警：概率 70%")
        self.assertIn("预测概率：70%", content.body)
        self.assertIn("预测窗口：within 24 hours", content.body)
        self.assertIn("公告原文：A reset is being watched.", content.body)

    def test_updated_watch_uses_updated_probability_subject(self):
        from codex_reset_monitor.emailer import render_watch

        self.payload["data"]["active_watch"]["reset_chance_percent"] = 85
        watch = parse_status(self.payload).active_watch
        content = render_watch(watch, self.checked_at, is_update=True)

        self.assertEqual(content.subject, "[Codex Resets] 重置预警已更新：概率 85%")

    def test_watch_with_unknown_probability_uses_unknown_subject(self):
        from codex_reset_monitor.emailer import render_watch

        self.payload["data"]["active_watch"]["reset_chance_percent"] = None
        watch = parse_status(self.payload).active_watch
        content = render_watch(watch, self.checked_at, is_update=False)

        self.assertTrue(content.subject.endswith("概率未知"))

    def test_modern_times_use_utc_plus_eight_when_zoneinfo_is_unavailable(self):
        from codex_reset_monitor.emailer import render_reset

        with patch(
            "codex_reset_monitor.emailer.ZoneInfo",
            side_effect=ZoneInfoNotFoundError("tzdata unavailable"),
        ):
            content = render_reset(self.status.latest_reset, self.checked_at)

        self.assertIn("2026-08-28 00:35:05 北京时间", content.body)

    def test_historical_times_fail_safely_when_zoneinfo_is_unavailable(self):
        from codex_reset_monitor.emailer import render_reset

        self.payload["data"]["latest_reset"]["announced_at"] = "1991-09-15T16:35:05Z"
        reset = parse_status(self.payload).latest_reset
        with patch(
            "codex_reset_monitor.emailer.ZoneInfo",
            side_effect=ZoneInfoNotFoundError("tzdata unavailable"),
        ):
            with self.assertRaisesRegex(Exception, "^Beijing time conversion unavailable$") as raised:
                render_reset(reset, self.checked_at)

        self.assertEqual(type(raised.exception).__name__, "MailRenderingError")

    def test_reset_includes_type_source_and_both_times(self):
        from codex_reset_monitor.emailer import render_reset

        content = render_reset(self.status.latest_reset, self.checked_at)

        self.assertEqual(content.subject, "[Codex Resets] Codex 已重置")
        self.assertIn("重置类型：regular", content.body)
        self.assertIn("A regular reset announcement.", content.body)
        self.assertIn("https://codex-resets.com/resets/reset-1", content.body)
        self.assertIn("2026-08-27 16:35:05 UTC", content.body)
        self.assertIn("2026-08-28 00:35:05 北京时间", content.body)
        self.assertIn("检测时间：2026-08-28 14:00:00 UTC", content.body)


class QQMailerTests(unittest.TestCase):
    def setUp(self):
        from codex_reset_monitor.emailer import MailContent

        FakeSMTP.instances = []
        FakeSMTP.failure = None
        self.content = MailContent("[Codex Resets] 测试", "中文正文")

    def test_sends_utf8_message_over_qq_smtp(self):
        from codex_reset_monitor.emailer import QQMailer

        QQMailer("monitor@qq.com", "auth-code", smtp_factory=FakeSMTP).send(self.content)

        smtp = FakeSMTP.instances[0]
        self.assertEqual((smtp.host, smtp.port, smtp.timeout), ("smtp.qq.com", 465, 20))
        self.assertEqual(smtp.login_arguments, ("monitor@qq.com", "auth-code"))
        message = smtp.messages[0]
        self.assertEqual(message["From"], "monitor@qq.com")
        self.assertEqual(message["To"], "monitor@qq.com")
        self.assertEqual(message["Subject"], "[Codex Resets] 测试")
        self.assertEqual(message.get_content(), "中文正文\n")

    def test_rejects_non_qq_address_without_leaking_it(self):
        from codex_reset_monitor.emailer import MailConfigurationError, QQMailer

        with self.assertRaisesRegex(MailConfigurationError, "^QQ email configuration is invalid$"):
            QQMailer("monitor@example.com", "auth-code", smtp_factory=FakeSMTP)

    def test_rejects_empty_authorization_code(self):
        from codex_reset_monitor.emailer import MailConfigurationError, QQMailer

        with self.assertRaisesRegex(MailConfigurationError, "^QQ email configuration is invalid$"):
            QQMailer("monitor@qq.com", "", smtp_factory=FakeSMTP)

    def test_retries_smtp_and_os_errors_then_sanitizes_failure(self):
        from codex_reset_monitor.emailer import MailDeliveryError, QQMailer

        for error in (smtplib.SMTPException, OSError):
            with self.subTest(error=error.__name__):
                FakeSMTP.instances = []
                FakeSMTP.failure = error
                sleeps = []
                mailer = QQMailer("private@qq.com", "private-auth", smtp_factory=FakeSMTP, sleep=sleeps.append)

                with self.assertRaisesRegex(MailDeliveryError, "^QQ SMTP delivery failed$"):
                    mailer.send(self.content)

                self.assertEqual(len(FakeSMTP.instances), 2)
                self.assertEqual(sleeps, [1])
