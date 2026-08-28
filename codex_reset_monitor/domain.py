from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping


class StatusValidationError(Exception):
    """Raised when a status response does not match the expected schema."""


@dataclass(frozen=True)
class SourceInfo:
    type: str
    author: str
    url: str


@dataclass(frozen=True)
class ResetInfo:
    id: str
    reset_type: str
    announced_at: datetime
    text: str
    source: SourceInfo


@dataclass(frozen=True)
class WatchInfo:
    level: str
    reset_chance_percent: int | None
    forecast_window: str
    observed_at: datetime
    expires_at: datetime
    text: str
    source: SourceInfo


@dataclass(frozen=True)
class StatusSnapshot:
    latest_reset: ResetInfo | None
    active_watch: WatchInfo | None
    generated_at: datetime


def _parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError
    return timestamp.astimezone(timezone.utc)


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError
    return value


def _parse_source(payload: Mapping[str, Any]) -> SourceInfo:
    return SourceInfo(
        type=_required_string(payload["type"]),
        author=_required_string(payload["author"]),
        url=_required_string(payload["url"]),
    )


def _parse_reset(payload: Mapping[str, Any]) -> ResetInfo:
    reset_type = _required_string(payload["type"])
    if reset_type not in {"regular", "banked"}:
        raise ValueError
    return ResetInfo(
        id=_required_string(payload["id"]),
        reset_type=reset_type,
        announced_at=_parse_timestamp(payload["announced_at"]),
        text=_required_string(payload["text"]),
        source=_parse_source(payload["source"]),
    )


def _parse_watch(payload: Mapping[str, Any]) -> WatchInfo:
    level = _required_string(payload["level"])
    if level not in {"elevated", "strong"}:
        raise ValueError
    probability = payload["reset_chance_percent"]
    if isinstance(probability, bool) or (
        probability is not None and (not isinstance(probability, int) or not 0 <= probability <= 100)
    ):
        raise ValueError
    return WatchInfo(
        level=level,
        reset_chance_percent=probability,
        forecast_window=_required_string(payload["forecast_window"]),
        observed_at=_parse_timestamp(payload["observed_at"]),
        expires_at=_parse_timestamp(payload["expires_at"]),
        text=_required_string(payload["text"]),
        source=_parse_source(payload["source"]),
    )


def parse_status(payload: Mapping[str, Any]) -> StatusSnapshot:
    try:
        data = payload["data"]
        meta = payload["meta"]
        if not isinstance(data, Mapping) or not isinstance(meta, Mapping):
            raise TypeError
        latest_reset = data["latest_reset"]
        active_watch = data["active_watch"]
        return StatusSnapshot(
            latest_reset=None if latest_reset is None else _parse_reset(latest_reset),
            active_watch=None if active_watch is None else _parse_watch(active_watch),
            generated_at=_parse_timestamp(meta["generated_at"]),
        )
    except (KeyError, TypeError, ValueError):
        raise StatusValidationError("invalid status response") from None
