# Codex Reset QQ Email Monitor Design

## Objective

Build a small public GitHub repository that checks the Codex Resets public API at the start of every hour and emails a QQ mailbox when a reset forecast appears, materially changes, or a reset is confirmed.

The sender and recipient are the same QQ mailbox. The mailbox address and SMTP authorization code are supplied manually through GitHub Actions Secrets and must never be committed or printed.

## Scope

The monitor reports website-classified global Codex reset announcements. It does not read an individual user's Codex quota, predict a reset from historical averages, or represent an official OpenAI status service.

The first version includes:

- Hourly scheduled checks and manual workflow dispatch.
- Reset forecast, forecast update, and confirmed-reset notifications.
- A one-time activation email on first successful execution.
- Durable deduplication through a public repository state file.
- Automated tests that never access mailbox secrets or send email.

The first version does not include a web interface, database, Telegram notifications, SMS, or cancellation emails when a forecast disappears.

## External Interfaces

### Codex Resets API

The monitor calls:

`GET https://codex-resets.com/api/v1/status`

Relevant response fields are:

- `data.latest_reset.id`: stable identifier used to deduplicate confirmed resets.
- `data.latest_reset.reset_type`: `regular` or `banked`.
- `data.latest_reset.announced_at`: confirmed announcement time.
- `data.latest_reset.text`: announcement text.
- `data.latest_reset.source.url`: source post URL.
- `data.active_watch`: optional active forecast.
- `data.active_watch.level`: `elevated` or `strong`.
- `data.active_watch.reset_chance_percent`: optional forecast probability.
- `data.active_watch.forecast_window`: human-readable forecast window.
- `data.active_watch.observed_at`: time the forecast was observed.
- `data.active_watch.expires_at`: forecast expiration.
- `data.active_watch.text`: forecast source text.
- `data.active_watch.source`: forecast source information.
- `meta.generated_at`: API generation time.

An active watch is a forecast, not an exact promised reset time. Emails must label it accordingly.

### QQ SMTP

Mail is sent through QQ SMTP over implicit TLS:

- Host: `smtp.qq.com`
- Port: `465`
- Username and sender: `QQ_EMAIL`
- Recipient: `QQ_EMAIL`
- Password: `QQ_SMTP_AUTH_CODE`

Both values are GitHub Actions Secrets. The authorization code is not a QQ account password.

## Architecture

The repository contains four focused parts:

1. A GitHub Actions workflow schedules and invokes the monitor.
2. An API client fetches and validates the current status.
3. A decision layer compares the response with durable state and produces notification events.
4. A mailer renders and sends messages through QQ SMTP.

Data flow:

```text
GitHub Actions (hourly or manual)
  -> GET /api/v1/status
  -> compare response with state.json
  -> render zero or more notification emails
  -> send through QQ SMTP
  -> update state only for successfully sent notifications
  -> commit state.json when it changed
```

Python's standard library is sufficient. No third-party HTTP or email package is required.

## Scheduling

The workflow uses:

```yaml
schedule:
  - cron: "0 * * * *"
workflow_dispatch:
```

GitHub cron is expressed in UTC. Because Beijing is UTC+8 with a whole-hour offset, UTC minute `00` is also Beijing minute `00`. GitHub Actions scheduling is best-effort and may start several minutes after the hour, particularly during peak load.

A workflow concurrency group prevents overlapping checks from sending duplicate messages.

## Notification Rules

### First successful run

When no initialized state exists, send one activation email containing:

- The current latest reset and its Beijing and UTC times.
- The current forecast state, if any.
- The check time.

After successful delivery, initialize the state. If sending fails, leave the state uninitialized so the next run retries.

### Forecast appeared

When `active_watch` changes from absent to present, send a reset forecast email.

### Forecast updated

Create a deterministic forecast fingerprint from fields that affect the user-facing prediction:

- Level.
- Probability.
- Forecast window.
- Observation and expiration times.
- Source URL and text.

When the fingerprint changes, send one forecast-update email. Identical forecasts do not generate duplicate mail.

### Forecast disappeared

When `active_watch` becomes absent or expires, update the stored forecast state without sending an email. A later new forecast must still generate a new notification.

### Reset confirmed

When `latest_reset.id` differs from the stored notified reset ID, send a confirmed-reset email. The confirmation is authoritative for this monitor and must not be described as a prediction.

If a forecast update and confirmed reset are both observed during one check, send both messages independently. Persist each notification's state only after that message succeeds so a partial SMTP failure can be retried without duplicating the successful message.

## Email Format

Subjects are concise and distinguish urgency:

- `[Codex Resets] 监控已启用`
- `[Codex Resets] 重置预警：概率 70%`
- `[Codex Resets] 重置预警已更新：概率 85%`
- `[Codex Resets] Codex 已重置`

Messages include applicable fields from the API:

- Forecast probability, level, and time window.
- Reset type (`regular` or `banked`).
- UTC and Asia/Shanghai timestamps.
- Source text and source URL.
- Monitor check time.

Messages use UTF-8 and provide a plain-text body. They must not contain the QQ SMTP authorization code or diagnostic environment data.

## State

`state.json` is committed to the public repository. It contains only public API-derived identifiers and operational timestamps, for example:

```json
{
  "version": 1,
  "initialized": true,
  "notified_reset_id": "public-reset-id",
  "active_watch_fingerprint": null,
  "state_updated_at": "2026-08-28T14:00:00Z"
}
```

This is the complete version-1 state shape. `notified_reset_id` records successful reset mail, while `active_watch_fingerprint` records successful forecast mail or `null` after a forecast disappears. `state_updated_at` changes only when one of these durable state fields changes, so an unchanged hourly check does not create a commit. These independent markers support partial retry without adding another delivery ledger. The file never contains email addresses, authorization codes, environment variables, SMTP responses, or other private data.

The process atomically rewrites the local state file immediately after each successful message. If another message in the same run fails, its marker remains unchanged. The workflow's state-persistence step runs even after a notification-step failure and commits any successfully advanced markers before the run finishes as failed. Automated commits use the GitHub-provided token and a bot identity. No commit is made for an unchanged status.

## Security

- `QQ_EMAIL` and `QQ_SMTP_AUTH_CODE` exist only as GitHub Actions Secrets.
- The workflow file references secrets by name and never embeds their values.
- Only scheduled and manually dispatched notification jobs receive the secrets.
- Pull requests, fork workflows, and ordinary test jobs cannot access or send with the secrets.
- Logs never print environment variables, message headers containing the mailbox, SMTP credentials, or raw SMTP configuration.
- Authentication failures are reduced to sanitized error categories.
- The mail implementation uses Python `smtplib.SMTP_SSL` and the standard TLS certificate validation behavior.
- Third-party mail-sending Actions are not used.
- The checkout Action is pinned to a reviewed immutable commit SHA and receives credentials only when the state commit requires them.
- Workflow permissions default to read-only. The notification job receives only the minimum `contents: write` permission required to commit `state.json`.
- Secret-scanning checks guard against accidentally committing credential-like values.

The public source code and `state.json` are safe to disclose; the mailbox address is treated as private even though it is less sensitive than the authorization code.

## Failure Handling

- API requests have a bounded timeout and limited retries with backoff.
- HTTP `429` honors `Retry-After` within a bounded workflow duration.
- Invalid or incomplete API responses fail closed: no email is sent and state is unchanged.
- SMTP failures do not advance the relevant notification marker.
- State writes are atomic within the process.
- Git commit conflicts or failed pushes fail the workflow rather than silently discarding state.
- The job exits nonzero on unrecovered API, SMTP, validation, or persistence failures so the failure is visible in GitHub Actions.

The first version does not send separate monitor-health emails. This avoids recursive failure behavior and notification noise; GitHub's workflow failure status remains the operational signal.

## Testing

Automated tests cover:

- Valid, missing, and malformed API responses.
- First-run activation behavior.
- Forecast appearance and material forecast updates.
- Forecast disappearance without email.
- New confirmed reset detection.
- Unchanged-state deduplication.
- Simultaneous forecast and reset notifications.
- Partial SMTP failure and retry state.
- UTC-to-Asia/Shanghai formatting.
- State serialization without secret or mailbox fields.
- Sanitized error reporting.

Tests use fixtures and a fake mailer. They never load GitHub Secrets, contact QQ SMTP, or send real email.

A manual `workflow_dispatch` run performs the first real integration check. Success is confirmed by receipt of the activation email and a committed initialized state.

## Acceptance Criteria

- The public repository runs the monitor at Beijing minute `00` every hour, subject to GitHub scheduling delay.
- The first successful run sends exactly one activation email.
- A new forecast, material forecast update, and confirmed reset each produce the intended QQ email.
- Repeated identical API responses do not produce duplicate mail.
- Forecast disappearance does not send mail.
- State changes occur only after the corresponding email succeeds.
- Repository files and GitHub logs contain neither the QQ address nor SMTP authorization code.
- Automated tests pass without network or secret access.
