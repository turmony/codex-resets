import io
import json
import unittest
from urllib.error import HTTPError, URLError

from codex_reset_monitor.api import StatusAPIError, fetch_status
from tests.fixtures import valid_status_payload


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False


class FetchStatusTests(unittest.TestCase):
    def test_retries_temporary_url_error_then_succeeds(self):
        calls = []
        sleeps = []

        def opener(request, timeout):
            calls.append((request, timeout))
            if len(calls) == 1:
                raise URLError("temporary detail that must be hidden")
            return FakeResponse(valid_status_payload())

        status = fetch_status(opener=opener, sleep=sleeps.append)

        self.assertEqual(status.latest_reset.id, "reset-1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], 15)
        self.assertEqual(sleeps, [1])

    def test_sends_json_request_to_status_endpoint(self):
        calls = []

        def opener(request, timeout):
            calls.append((request, timeout))
            return FakeResponse(valid_status_payload())

        fetch_status(opener=opener)

        request, timeout = calls[0]
        self.assertEqual(request.full_url, "https://codex-resets.com/api/v1/status")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(timeout, 15)

    def test_caps_retry_after_for_rate_limit(self):
        calls = []
        sleeps = []

        def opener(request, timeout):
            calls.append((request, timeout))
            if len(calls) == 1:
                raise HTTPError(request.full_url, 429, "Too Many Requests", {"Retry-After": "99"}, io.BytesIO())
            return FakeResponse(valid_status_payload())

        fetch_status(opener=opener, sleep=sleeps.append)

        self.assertEqual(sleeps, [30])

    def test_does_not_retry_non_retryable_http_error(self):
        calls = []

        def opener(request, timeout):
            calls.append((request, timeout))
            raise HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO())

        with self.assertRaises(StatusAPIError):
            fetch_status(opener=opener)

        self.assertEqual(len(calls), 1)

    def test_hides_details_after_all_url_error_attempts(self):
        sleeps = []

        def opener(request, timeout):
            raise URLError("private transport detail")

        with self.assertRaisesRegex(StatusAPIError, "^Codex Resets API request failed$"):
            fetch_status(opener=opener, sleep=sleeps.append)

        self.assertEqual(sleeps, [1, 2])
