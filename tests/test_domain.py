import unittest
from datetime import timezone

from codex_reset_monitor.domain import StatusValidationError, parse_status
from tests.fixtures import valid_status_payload


class ParseStatusTests(unittest.TestCase):
    def test_parses_reset_watch_and_utc_timestamps(self):
        payload = valid_status_payload()
        self.assertIn("reset_type", payload["data"]["latest_reset"])
        self.assertNotIn("type", payload["data"]["latest_reset"])

        status = parse_status(payload)
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

    def test_rejects_timestamp_without_timezone(self):
        payload = valid_status_payload()
        payload["meta"]["generated_at"] = "2026-08-28T12:00:00"

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_non_rfc3339_space_separated_timestamp(self):
        payload = valid_status_payload()
        payload["meta"]["generated_at"] = "2026-08-28 12:00:00Z"

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_timestamp_with_z_outside_the_timezone_suffix(self):
        payload = valid_status_payload()
        payload["meta"]["generated_at"] = "2026-08-28ZT12:00:00+00:00"

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_unknown_reset_type(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"]["reset_type"] = "unexpected"

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_legacy_only_reset_type_field(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"]["type"] = payload["data"]["latest_reset"].pop("reset_type")

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_unknown_watch_level(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["level"] = "low"

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_rejects_empty_required_string(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"]["source"]["author"] = ""

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)

    def test_accepts_probability_boundaries(self):
        for probability in (0, 100):
            with self.subTest(probability=probability):
                payload = valid_status_payload()
                payload["data"]["active_watch"]["reset_chance_percent"] = probability
                self.assertEqual(parse_status(payload).active_watch.reset_chance_percent, probability)

    def test_rejects_boolean_probability(self):
        payload = valid_status_payload()
        payload["data"]["active_watch"]["reset_chance_percent"] = True

        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status(payload)
