from dataclasses import replace
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from codex_reset_monitor.domain import parse_status
from codex_reset_monitor.monitor import MonitorRunError, process_status
from codex_reset_monitor.state import MonitorState, watch_fingerprint

from tests.fixtures import valid_status_payload


CHECKED_AT = datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc)


def initialized_state(status):
    return MonitorState(
        version=1,
        initialized=True,
        notified_reset_id=status.latest_reset.id if status.latest_reset else None,
        active_watch_fingerprint=(
            watch_fingerprint(status.active_watch) if status.active_watch else None
        ),
        state_updated_at="2026-08-28T13:00:00Z",
    )


class ProcessStatusTests(unittest.TestCase):
    def test_first_run_sends_activation_then_initializes_all_markers(self):
        status = parse_status(valid_status_payload())
        sent = []
        persisted = []

        result = process_status(
            status,
            MonitorState.initial(),
            CHECKED_AT,
            sent.append,
            persisted.append,
        )

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] 监控已启用"])
        self.assertTrue(result.initialized)
        self.assertEqual(result.notified_reset_id, "reset-1")
        self.assertEqual(result.active_watch_fingerprint, watch_fingerprint(status.active_watch))
        self.assertEqual(result.state_updated_at, "2026-08-28T14:00:00Z")
        self.assertEqual(persisted, [result])

    def test_identical_initialized_snapshot_sends_and_persists_nothing(self):
        status = parse_status(valid_status_payload())
        sent = []
        persisted = []
        state = initialized_state(status)

        result = process_status(status, state, CHECKED_AT, sent.append, persisted.append)

        self.assertEqual(result, state)
        self.assertEqual(sent, [])
        self.assertEqual(persisted, [])

    def test_new_watch_sends_forecast_and_persists_its_fingerprint(self):
        status = parse_status(valid_status_payload())
        sent = []
        persisted = []
        state = replace(initialized_state(status), active_watch_fingerprint=None)

        result = process_status(status, state, CHECKED_AT, sent.append, persisted.append)

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] 重置预警：概率 70%"])
        self.assertEqual(result.active_watch_fingerprint, watch_fingerprint(status.active_watch))
        self.assertEqual(result.notified_reset_id, "reset-1")
        self.assertEqual(result.state_updated_at, "2026-08-28T14:00:00Z")
        self.assertEqual(persisted, [result])

    def test_changed_watch_sends_update_and_replaces_its_fingerprint(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = 85
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        sent = []
        persisted = []

        result = process_status(
            status, initialized_state(original_status), CHECKED_AT, sent.append, persisted.append
        )

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] 重置预警已更新：概率 85%"])
        self.assertEqual(result.active_watch_fingerprint, watch_fingerprint(status.active_watch))
        self.assertEqual(persisted, [result])

    def test_missing_watch_clears_fingerprint_without_sending_mail(self):
        original_status = parse_status(valid_status_payload())
        payload = valid_status_payload()
        payload["data"]["active_watch"] = None
        status = parse_status(payload)
        sent = []
        persisted = []

        result = process_status(
            status, initialized_state(original_status), CHECKED_AT, sent.append, persisted.append
        )

        self.assertEqual(sent, [])
        self.assertIsNone(result.active_watch_fingerprint)
        self.assertEqual(result.notified_reset_id, "reset-1")
        self.assertEqual(result.state_updated_at, "2026-08-28T14:00:00Z")
        self.assertEqual(persisted, [result])

    def test_new_reset_sends_confirmation_and_persists_only_new_reset_id(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"]["id"] = "reset-2"
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        sent = []
        persisted = []

        result = process_status(
            status, initialized_state(original_status), CHECKED_AT, sent.append, persisted.append
        )

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] Codex 已重置"])
        self.assertEqual(result.notified_reset_id, "reset-2")
        self.assertEqual(result.active_watch_fingerprint, watch_fingerprint(original_status.active_watch))
        self.assertEqual(persisted, [result])

    def test_forecast_success_is_durable_when_reset_mail_fails(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = 85
        payload["data"]["latest_reset"]["id"] = "reset-2"
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        state = initialized_state(original_status)
        sent = []
        persisted = []

        def send(mail):
            sent.append(mail.subject)
            if mail.subject == "[Codex Resets] Codex 已重置":
                raise RuntimeError("smtp detail must not escape")

        with self.assertRaisesRegex(MonitorRunError, "^one or more notifications failed$"):
            process_status(status, state, CHECKED_AT, send, persisted.append)

        self.assertEqual(sent, ["[Codex Resets] 重置预警已更新：概率 85%", "[Codex Resets] Codex 已重置"])
        self.assertEqual(len(persisted), 1)
        self.assertEqual(persisted[0].active_watch_fingerprint, watch_fingerprint(status.active_watch))
        self.assertEqual(persisted[0].notified_reset_id, "reset-1")

    def test_reset_success_is_durable_when_forecast_mail_fails(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = 85
        payload["data"]["latest_reset"]["id"] = "reset-2"
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        state = initialized_state(original_status)
        sent = []
        persisted = []

        def send(mail):
            sent.append(mail.subject)
            if "重置预警" in mail.subject:
                raise RuntimeError("smtp detail must not escape")

        with self.assertRaisesRegex(MonitorRunError, "^one or more notifications failed$"):
            process_status(status, state, CHECKED_AT, send, persisted.append)

        self.assertEqual(sent, ["[Codex Resets] 重置预警已更新：概率 85%", "[Codex Resets] Codex 已重置"])
        self.assertEqual(len(persisted), 1)
        self.assertEqual(persisted[0].active_watch_fingerprint, state.active_watch_fingerprint)
        self.assertEqual(persisted[0].notified_reset_id, "reset-2")

    def test_reset_succeeds_when_forecast_rendering_fails(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = 85
        payload["data"]["latest_reset"]["id"] = "reset-2"
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        state = initialized_state(original_status)
        sent = []
        persisted = []

        with patch(
            "codex_reset_monitor.monitor.render_watch",
            side_effect=RuntimeError("render detail must not escape"),
        ), self.assertRaisesRegex(MonitorRunError, "^one or more notifications failed$"):
            process_status(status, state, CHECKED_AT, sent.append, persisted.append)

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] Codex 已重置"])
        self.assertEqual(len(persisted), 1)
        self.assertEqual(persisted[0].active_watch_fingerprint, state.active_watch_fingerprint)
        self.assertEqual(persisted[0].notified_reset_id, "reset-2")

    def test_persist_failure_after_mail_stops_before_later_notifications(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = 85
        payload["data"]["latest_reset"]["id"] = "reset-2"
        status = parse_status(payload)
        original_status = parse_status(valid_status_payload())
        sent = []

        def send(mail):
            sent.append(mail.subject)

        def persist(_state):
            raise RuntimeError("disk detail must not escape")

        with self.assertRaisesRegex(MonitorRunError, "^monitor state could not be persisted$"):
            process_status(status, initialized_state(original_status), CHECKED_AT, send, persist)

        self.assertEqual(sent, ["[Codex Resets] 重置预警已更新：概率 85%"])


if __name__ == "__main__":
    unittest.main()
