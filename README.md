# Codex Resets 126 Mail Monitor

English | [简体中文](README.zh-CN.md)

[![Test](https://github.com/turmony/codex-resets/actions/workflows/test.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/test.yml)
[![Monitor](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml)

A lightweight GitHub Actions monitor that checks the public Codex Resets status API every three hours and sends reset forecasts and announcements to a NetEase 126 mailbox.

## Features

- Runs every three hours at Beijing minute 30 with no dedicated server.
- Sends activation, forecast, forecast-update, and confirmed-reset emails.
- Uses one 126 mailbox as both sender and recipient.
- Stores only public notification markers in `state.json` to prevent duplicates.

## Quick Start

1. Fork this repository or push it to a public GitHub repository.
2. Enable **IMAP/SMTP** in NetEase 126 Mail and generate an SMTP authorization code. POP3/SMTP is not needed.
3. Add these repository Actions secrets under **Settings → Secrets and variables → Actions**:

   | Secret | Value |
   | --- | --- |
   | `MAIL_EMAIL` | Your 126 email address |
   | `MAIL_SMTP_AUTH_CODE` | Your 126 SMTP authorization code, not your account password |

4. Under **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**.
5. Open **Actions → Monitor Codex Resets** and run the workflow once. A successful first run sends an activation email and creates `state.json`.

When migrating an existing monitor from QQ, replace the old Actions secrets with `MAIL_EMAIL` and `MAIL_SMTP_AUTH_CODE`. Existing notification state is retained, so a manual run sends no email if the public status has not changed. To request one activation email in the new mailbox, reset `state.json` to its initial values before that run.

## Notifications

The monitor is scheduled with `30 1-22/3 * * *` in UTC, corresponding to 00:30, 03:30, 06:30, ..., 21:30 Beijing time. GitHub Actions scheduling is best effort and may be delayed or skipped.

Emails are sent only when monitoring is activated or when a public forecast or confirmed reset changes. The source may provide a forecast window without an exact reset time or timezone; the monitor does not invent one.

## Security and Limitations

- Never commit or share a 126 email address, authorization code, password, or token.
- Secrets are available only to the production workflow; pull-request tests do not receive them.
- `state.json` contains public API-derived markers only.
- This project reports third-party global status information. It cannot read personal Codex quota, usage, or account state, and forecasts are not an OpenAI service commitment.
- GitHub may disable scheduled workflows after 60 days without repository activity. Re-enable the workflow and run it manually if checks stop.

## Development

Requires Python 3.12. Run the test suite with:

```bash
uv run --python 3.12 python -m unittest discover -s tests -v
```
