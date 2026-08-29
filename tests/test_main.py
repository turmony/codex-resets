from contextlib import redirect_stderr
from datetime import datetime, timezone
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from codex_reset_monitor.api import StatusAPIError
from codex_reset_monitor.domain import parse_status
from codex_reset_monitor.state import MonitorState
from codex_reset_monitor.__main__ import main

from tests.fixtures import valid_status_payload


class MainTests(unittest.TestCase):
    def test_missing_secrets_returns_failure_without_printing_values(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stderr(stderr):
            result = main()

        self.assertEqual(result, 1)
        self.assertEqual(stderr.getvalue(), "monitor failed: QQ email configuration is invalid\n")

    def test_success_uses_relative_state_path_and_returns_zero(self):
        state = MonitorState.initial()
        status = parse_status(valid_status_payload())
        updated_state = MonitorState(
            version=1,
            initialized=True,
            notified_reset_id="reset-1",
            active_watch_fingerprint="fingerprint",
            state_updated_at="2026-08-28T14:00:00Z",
        )
        loaded_paths = []
        saved = []
        process_calls = []

        class FakeMailer:
            def __init__(self, email, auth_code):
                self.email = email
                self.auth_code = auth_code

            def send(self, content):
                raise AssertionError("the patched process function must not send mail")

        def load(path):
            loaded_paths.append(path)
            return state

        def process(found_status, found_state, checked_at, send, persist):
            process_calls.append((found_status, found_state, checked_at, send))
            persist(updated_state)
            return updated_state

        def save(path, saved_state):
            saved.append((path, saved_state))

        with (
            patch.dict(
                os.environ,
                {"QQ_EMAIL": "monitor@qq.com", "QQ_SMTP_AUTH_CODE": "sample-auth-code"},
                clear=True,
            ),
            patch("codex_reset_monitor.__main__.load_state", side_effect=load),
            patch("codex_reset_monitor.__main__.fetch_status", return_value=status),
            patch("codex_reset_monitor.__main__.QQMailer", FakeMailer),
            patch("codex_reset_monitor.__main__.process_status", side_effect=process),
            patch("codex_reset_monitor.__main__.save_state", side_effect=save),
        ):
            result = main()

        self.assertEqual(result, 0)
        self.assertEqual(loaded_paths, [Path("state.json")])
        self.assertEqual(saved, [(Path("state.json"), updated_state)])
        self.assertEqual(process_calls[0][:2], (status, state))
        self.assertIsInstance(process_calls[0][2], datetime)
        self.assertEqual(process_calls[0][2].tzinfo, timezone.utc)

    def test_known_adapter_failure_is_sanitized_without_environment_values(self):
        stderr = io.StringIO()
        mailbox = "sample-mailbox@qq.com"
        auth_code = "sample-authorization-code"

        with (
            patch.dict(
                os.environ,
                {"QQ_EMAIL": mailbox, "QQ_SMTP_AUTH_CODE": auth_code},
                clear=True,
            ),
            patch(
                "codex_reset_monitor.__main__.fetch_status",
                side_effect=StatusAPIError("Codex Resets API request failed"),
            ),
            redirect_stderr(stderr),
        ):
            result = main()

        self.assertEqual(result, 1)
        self.assertEqual(stderr.getvalue(), "monitor failed: Codex Resets API request failed\n")
        self.assertNotIn(mailbox, stderr.getvalue())
        self.assertNotIn(auth_code, stderr.getvalue())

    def test_http_403_status_error_is_treated_as_non_fatal_skip(self):
        stderr = io.StringIO()
        with (
            patch.dict(
                os.environ,
                {"QQ_EMAIL": "monitor@qq.com", "QQ_SMTP_AUTH_CODE": "sample-auth-code"},
                clear=True,
            ),
            patch(
                "codex_reset_monitor.__main__.fetch_status",
                side_effect=StatusAPIError("Codex Resets API request failed (HTTP 403)"),
            ),
            redirect_stderr(stderr),
        ):
            result = main()

        self.assertEqual(result, 0)
        self.assertEqual(
            stderr.getvalue(),
            "monitor skipped: Codex Resets API request failed (HTTP 403)\n",
        )


if __name__ == "__main__":
    unittest.main()
