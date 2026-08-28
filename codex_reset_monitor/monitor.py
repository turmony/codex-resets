"""Notification orchestration with durable, per-notification markers."""

from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable

from .domain import StatusSnapshot
from .emailer import MailContent, render_activation, render_reset, render_watch
from .state import MonitorState, watch_fingerprint


class MonitorRunError(Exception):
    """Raised with a safe description when a monitor run cannot complete."""


def _updated_at(checked_at: datetime) -> str:
    return checked_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _persist(state: MonitorState, persist: Callable[[MonitorState], None]) -> None:
    try:
        persist(state)
    except Exception:
        raise MonitorRunError("monitor state could not be persisted") from None


def _deliver(
    render: Callable[[], MailContent], send: Callable[[MailContent], None]
) -> bool:
    try:
        send(render())
    except Exception:
        return False
    return True


def process_status(
    status: StatusSnapshot,
    state: MonitorState,
    checked_at: datetime,
    send: Callable[[MailContent], None],
    persist: Callable[[MonitorState], None],
) -> MonitorState:
    """Send required notifications and durably record each successful outcome."""
    checked_at_utc = checked_at.astimezone(timezone.utc)
    updated_at = _updated_at(checked_at_utc)

    if not state.initialized:
        if not _deliver(lambda: render_activation(status, checked_at), send):
            raise MonitorRunError("one or more notifications failed") from None
        initialized = replace(
            state,
            initialized=True,
            notified_reset_id=status.latest_reset.id if status.latest_reset else None,
            active_watch_fingerprint=(
                watch_fingerprint(status.active_watch) if status.active_watch else None
            ),
            state_updated_at=updated_at,
        )
        _persist(initialized, persist)
        return initialized

    current = state
    failed_notifications: list[str] = []

    if (
        status.active_watch is None
        or status.active_watch.expires_at <= checked_at_utc
    ):
        if current.active_watch_fingerprint is not None:
            current = replace(
                current,
                active_watch_fingerprint=None,
                state_updated_at=updated_at,
            )
            _persist(current, persist)
    else:
        fingerprint = watch_fingerprint(status.active_watch)
        if fingerprint != current.active_watch_fingerprint:
            if _deliver(
                lambda: render_watch(
                    status.active_watch,
                    checked_at,
                    is_update=current.active_watch_fingerprint is not None,
                ),
                send,
            ):
                current = replace(
                    current,
                    active_watch_fingerprint=fingerprint,
                    state_updated_at=updated_at,
                )
                _persist(current, persist)
            else:
                failed_notifications.append("forecast")

    if status.latest_reset is not None and status.latest_reset.id != current.notified_reset_id:
        if _deliver(lambda: render_reset(status.latest_reset, checked_at), send):
            current = replace(
                current,
                notified_reset_id=status.latest_reset.id,
                state_updated_at=updated_at,
            )
            _persist(current, persist)
        else:
            failed_notifications.append("reset")

    if failed_notifications:
        raise MonitorRunError("one or more notifications failed") from None
    return current
