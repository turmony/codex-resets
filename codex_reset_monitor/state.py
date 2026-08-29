"""Durable monitor state and stable active-watch fingerprints."""

from dataclasses import asdict, dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile

from .domain import WatchInfo


class StateError(Exception):
    """Raised when monitor state cannot be safely read or written."""


@dataclass(frozen=True)
class MonitorState:
    version: int
    initialized: bool
    notified_reset_id: str | None
    active_watch_fingerprint: str | None
    state_updated_at: str | None

    @classmethod
    def initial(cls) -> "MonitorState":
        return cls(1, False, None, None, None)


_KEYS = frozenset({
    "version", "initialized", "notified_reset_id",
    "active_watch_fingerprint", "state_updated_at",
})


def _invalid() -> StateError:
    return StateError("monitor state is invalid")


def _parse_state(raw: object) -> MonitorState:
    if not isinstance(raw, dict) or set(raw) != _KEYS:
        raise _invalid()
    version = raw["version"]
    initialized = raw["initialized"]
    if not isinstance(version, int) or isinstance(version, bool) or version != 1 or not isinstance(initialized, bool):
        raise _invalid()
    for key in ("notified_reset_id", "active_watch_fingerprint", "state_updated_at"):
        value = raw[key]
        if value is not None and not isinstance(value, str):
            raise _invalid()
    return MonitorState(**raw)


def load_state(path: Path) -> MonitorState:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return _parse_state(raw)
    except FileNotFoundError:
        return MonitorState.initial()
    except (OSError, UnicodeError, json.JSONDecodeError, StateError, TypeError, ValueError):
        raise _invalid() from None


def _validate_state(state: MonitorState) -> None:
    if not isinstance(state, MonitorState):
        raise _invalid()
    _parse_state(asdict(state))


def save_state(path: Path, state: MonitorState) -> None:
    try:
        _validate_state(state)
        payload = json.dumps(asdict(state), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        path = Path(path)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.",
            suffix=".tmp", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    except StateError:
        raise _invalid() from None
    except (OSError, UnicodeError, TypeError, ValueError):
        raise _invalid() from None
    finally:
        if "temporary_path" in locals() and temporary_path.exists():
            try:
                temporary_path.unlink()
            except OSError:
                pass


def _timestamp(value: datetime) -> str:
    return value.isoformat()


def watch_fingerprint(watch: WatchInfo) -> str:
    try:
        material = {
            "level": watch.level,
            "reset_chance_percent": watch.reset_chance_percent,
            "forecast_window": watch.forecast_window,
            "observed_at": _timestamp(watch.observed_at),
            "expires_at": _timestamp(watch.expires_at),
            "text": watch.text,
            "source_url": watch.source.url,
        }
        serialized = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    except (AttributeError, TypeError, ValueError):
        raise _invalid() from None
