import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from codex_reset_monitor.domain import SourceInfo, WatchInfo
from codex_reset_monitor.state import MonitorState, StateError, load_state, save_state, watch_fingerprint


class MonitorStateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "state.json"

    def tearDown(self):
        self.tempdir.cleanup()

    def test_missing_file_returns_uninitialized_state(self):
        self.assertEqual(load_state(self.path), MonitorState.initial())

    def test_round_trip_uses_only_approved_keys(self):
        state = MonitorState(1, True, "reset-1", "abc", "2026-08-28T14:00:00Z")
        save_state(self.path, state)
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(set(raw), {"version", "initialized", "notified_reset_id", "active_watch_fingerprint", "state_updated_at"})
        self.assertNotIn("email", self.path.read_text(encoding="utf-8").lower())
        self.assertEqual(load_state(self.path), state)

    def test_rejects_unknown_version(self):
        self.path.write_text('{"version": 2}', encoding="utf-8")
        with self.assertRaisesRegex(StateError, "monitor state is invalid"):
            load_state(self.path)

    def test_rejects_unknown_keys(self):
        self.path.write_text(json.dumps({"version": 1, "initialized": False, "notified_reset_id": None,
                                         "active_watch_fingerprint": None, "state_updated_at": None, "extra": 1}), encoding="utf-8")
        with self.assertRaisesRegex(StateError, "monitor state is invalid"):
            load_state(self.path)

    def test_atomic_save_leaves_no_temporary_file(self):
        save_state(self.path, MonitorState.initial())
        self.assertEqual([item.name for item in self.path.parent.iterdir()], ["state.json"])
        self.assertTrue(self.path.read_text(encoding="utf-8").endswith("\n"))

    def test_malformed_state_is_sanitized(self):
        self.path.write_text('{"version": 1, "secret": "private"}', encoding="utf-8")
        with self.assertRaises(StateError) as context:
            load_state(self.path)
        self.assertEqual(str(context.exception), "monitor state is invalid")
        self.assertNotIn("private", str(context.exception))


def make_watch(**changes):
    values = {
        "level": "elevated",
        "reset_chance_percent": 25,
        "forecast_window": "next 7 days",
        "observed_at": datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc),
        "expires_at": datetime(2026, 9, 4, 14, 0, tzinfo=timezone.utc),
        "text": "Elevated reset risk.",
        "source": SourceInfo("official", "Codex", "https://example.test/status"),
    }
    values.update(changes)
    return WatchInfo(**values)


class WatchFingerprintTests(unittest.TestCase):
    def test_identical_watches_have_lowercase_sha256_fingerprint(self):
        fingerprint = watch_fingerprint(make_watch())
        self.assertEqual(fingerprint, watch_fingerprint(make_watch()))
        self.assertEqual(len(fingerprint), 64)
        self.assertRegex(fingerprint, r"^[0-9a-f]{64}$")

    def test_each_material_watch_field_changes_fingerprint(self):
        base = make_watch()
        variants = [
            {"level": "strong"}, {"reset_chance_percent": 26},
            {"forecast_window": "next 14 days"},
            {"observed_at": datetime(2026, 8, 28, 15, 0, tzinfo=timezone.utc)},
            {"expires_at": datetime(2026, 9, 5, 14, 0, tzinfo=timezone.utc)},
            {"text": "Different text."},
            {"source": SourceInfo("official", "Another author", "https://example.test/status")},
            {"source": SourceInfo("community", "Codex", "https://example.test/status")},
            {"source": SourceInfo("official", "Codex", "https://example.test/other")},
        ]
        for change in variants:
            with self.subTest(change=change):
                self.assertNotEqual(watch_fingerprint(base), watch_fingerprint(make_watch(**change)))

    def test_none_probability_is_material(self):
        self.assertNotEqual(watch_fingerprint(make_watch(reset_chance_percent=None)), watch_fingerprint(make_watch(reset_chance_percent=0)))


if __name__ == "__main__":
    unittest.main()
