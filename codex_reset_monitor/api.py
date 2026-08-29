import json
import math
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .domain import StatusSnapshot, StatusValidationError, parse_status


STATUS_URL = "https://codex-resets.com/api/v1/status"
REQUEST_TIMEOUT_SECONDS = 15
MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (1, 2)
MAX_RETRY_AFTER_SECONDS = 30
REQUEST_USER_AGENT = "codex-reset-monitor/1.0 (+https://github.com/turmony/codex-resets)"


class StatusAPIError(Exception):
    """Raised when the Codex Resets status endpoint cannot be read safely."""


def _retry_after_seconds(error: HTTPError, fallback: int) -> int | float:
    value = error.headers.get("Retry-After") if error.headers else None
    try:
        delay = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(delay) or delay < 0:
        return fallback
    return min(delay, MAX_RETRY_AFTER_SECONDS)


def fetch_status(*, opener: Callable = urlopen, sleep: Callable = time.sleep) -> StatusSnapshot:
    for attempt in range(MAX_ATTEMPTS):
        request = Request(
            STATUS_URL,
            headers={
                "Accept": "application/json",
                "User-Agent": REQUEST_USER_AGENT,
            },
        )
        try:
            with opener(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return parse_status(payload)
        except HTTPError as error:
            retryable = error.code == 429 or 500 <= error.code <= 599
            if not retryable or attempt == MAX_ATTEMPTS - 1:
                raise StatusAPIError(
                    f"Codex Resets API request failed (HTTP {error.code})"
                ) from None
            delay = (
                _retry_after_seconds(error, RETRY_DELAYS_SECONDS[attempt])
                if error.code == 429
                else RETRY_DELAYS_SECONDS[attempt]
            )
        except URLError:
            if attempt == MAX_ATTEMPTS - 1:
                raise StatusAPIError("Codex Resets API request failed (network)") from None
            delay = RETRY_DELAYS_SECONDS[attempt]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, StatusValidationError):
            raise StatusAPIError("Codex Resets API request failed (invalid response)") from None
        sleep(delay)

    raise StatusAPIError("Codex Resets API request failed")
