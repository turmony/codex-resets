def valid_status_payload():
    return {
        "data": {
            "latest_reset": {
                "id": "reset-1",
                "type": "regular",
                "announced_at": "2026-08-28T10:00:00Z",
                "text": "A regular reset was announced.",
                "source": {
                    "type": "official",
                    "author": "Codex Resets",
                    "url": "https://codex-resets.com/resets/reset-1",
                },
            },
            "active_watch": {
                "level": "elevated",
                "reset_chance_percent": 70,
                "forecast_window": "within 24 hours",
                "observed_at": "2026-08-28T11:00:00+01:00",
                "expires_at": "2026-08-29T11:00:00+01:00",
                "text": "A reset is being watched.",
                "source": {
                    "type": "analysis",
                    "author": "Codex Resets",
                    "url": "https://codex-resets.com/watches/active",
                },
            },
        },
        "meta": {"generated_at": "2026-08-28T12:00:00Z"},
    }
