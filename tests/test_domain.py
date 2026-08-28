import unittest
from datetime import timezone

from codex_reset_monitor.domain import StatusValidationError, parse_status
from tests.fixtures import valid_status_payload


class ParseStatusTests(unittest.TestCase):
    def test_parses_reset_watch_and_utc_timestamps(self):
        status = parse_status(valid_status_payload())
        self.assertEqual(status.latest_reset.id, "reset-1")
        self.assertEqual(status.latest_reset.reset_type, "regular")
        self.assertEqual(status.active_watch.reset_chance_percent, 70)
        self.assertEqual(status.generated_at.tzinfo, timezone.utc)

    def test_allows_null_latest_reset_and_active_watch(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"] = None
        payload["data"]["active_watch"] = None
        status = parse_status(payload)
        self.assertIsNone(status.latest_reset)
        self.assertIsNone(status.active_watch)

    def test_rejects_missing_required_data(self):
        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status({"data": {}})
