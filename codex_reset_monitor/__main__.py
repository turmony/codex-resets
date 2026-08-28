"""Executable entry point for the Codex reset monitor."""

from datetime import datetime, timezone
import os
from pathlib import Path
import sys

from .api import StatusAPIError, fetch_status
from .emailer import (
    MailConfigurationError,
    MailDeliveryError,
    MailRenderingError,
    QQMailer,
)
from .monitor import MonitorRunError, process_status
from .state import StateError, load_state, save_state


_SANITIZED_ERRORS = (
    MailConfigurationError,
    MailDeliveryError,
    MailRenderingError,
    MonitorRunError,
    StateError,
    StatusAPIError,
)


def main() -> int:
    """Run one monitor check and return a shell-compatible exit status."""
    try:
        mailer = QQMailer(
            os.environ.get("QQ_EMAIL"),
            os.environ.get("QQ_SMTP_AUTH_CODE"),
        )
        state_path = Path("state.json")
        state = load_state(state_path)
        status = fetch_status()

        def persist(updated_state):
            save_state(state_path, updated_state)

        process_status(
            status,
            state,
            datetime.now(timezone.utc),
            mailer.send,
            persist,
        )
    except _SANITIZED_ERRORS as error:
        print(f"monitor failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
