from dataclasses import asdict
import json
from pathlib import Path
import re
import unittest

from codex_reset_monitor.state import MonitorState


_QQ_MAILBOX = re.compile(r"(?i)\b[0-9]{5,12}@qq\.com\b")
_PINNED_ACTION = re.compile(r"uses:\s+[^@]+@([^\s#]+)")


class RepositorySecurityTests(unittest.TestCase):
    def test_public_artifacts_contain_no_numeric_qq_mailbox(self):
        """A real QQ mailbox accidentally committed to public artifacts is rejected."""
        artifacts = [
            *Path("codex_reset_monitor").glob("*.py"),
            Path(".github/workflows/test.yml"),
            Path(".github/workflows/monitor.yml"),
            Path("README.md"),
        ]
        state_path = Path("state.json")
        if state_path.exists():
            artifacts.append(state_path)

        matches = {
            path: _QQ_MAILBOX.findall(path.read_text(encoding="utf-8"))
            for path in artifacts
        }

        self.assertEqual(matches, {path: [] for path in artifacts})

    def test_serialized_state_has_no_credentials_or_mailbox_fields(self):
        """A state-schema expansion cannot introduce private credential fields."""
        state = MonitorState.initial()
        serialized = json.dumps(asdict(state), ensure_ascii=False)

        self.assertFalse(
            any(
                forbidden in key.lower()
                for key in json.loads(serialized)
                for forbidden in ("email", "auth", "password", "secret")
            )
        )

    def test_test_workflow_is_pull_request_safe_and_secret_free(self):
        """Untrusted pull-request CI never receives Actions secrets."""
        text = Path(".github/workflows/test.yml").read_text(encoding="utf-8")

        self.assertIn("pull_request", text)
        self.assertIn("contents: read", text)
        self.assertNotIn("secrets.", text)

    def test_monitor_schedule_permissions_and_pins(self):
        text = Path(".github/workflows/monitor.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 * * * *"', text)
        self.assertIn("workflow_dispatch: {}", text)
        self.assertIn("contents: write", text)
        self.assertNotIn("pull_request:", text)
        uses = re.findall(r"uses:\s+[^@]+@([^\s#]+)", text)
        self.assertTrue(uses)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", value) for value in uses))

    def test_monitor_checkout_uses_latest_default_branch_tip(self):
        text = Path(".github/workflows/monitor.yml").read_text(encoding="utf-8")
        checkout = re.search(
            r"(?m)^\s*- uses: actions/checkout@[0-9a-f]{40}[^\n]*\n"
            r"\s+with:\n"
            r"\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}\s*$",
            text,
        )

        self.assertIsNotNone(checkout)

    def test_all_workflow_actions_are_immutable_pins(self):
        """A mutable action tag cannot change production behavior unnoticed."""
        for path in (Path(".github/workflows/test.yml"), Path(".github/workflows/monitor.yml")):
            uses = _PINNED_ACTION.findall(path.read_text(encoding="utf-8"))
            self.assertTrue(uses, path)
            self.assertTrue(
                all(re.fullmatch(r"[0-9a-f]{40}", value) for value in uses),
                path,
            )


if __name__ == "__main__":
    unittest.main()
