# Codex Resets QQ Mail Monitor

English | [简体中文](README.zh-CN.md)

[![Test](https://github.com/turmony/codex-resets/actions/workflows/test.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/test.yml)
[![Monitor](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml)

A lightweight GitHub Actions monitor that checks the public Codex Resets status API every hour and sends reset forecasts and announcements to a QQ mailbox.

## Features

- Runs at the start of every hour with no dedicated server.
- Sends activation, forecast, forecast-update, and confirmed-reset emails.
- Uses one QQ mailbox as both sender and recipient.
- Stores only public notification markers in `state.json` to prevent duplicates.

## Quick Start

1. Fork this repository or push it to a public GitHub repository.
2. Enable SMTP in QQ Mail and generate an SMTP authorization code.
3. Add these repository Actions secrets under **Settings → Secrets and variables → Actions**:

   | Secret | Value |
   | --- | --- |
   | `QQ_EMAIL` | Your QQ email address |
   | `QQ_SMTP_AUTH_CODE` | Your QQ SMTP authorization code |

4. Under **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**.
5. Open **Actions → Monitor Codex Resets** and run the workflow once. A successful first run sends an activation email and creates `state.json`.

## Notifications

The monitor is scheduled with `0 * * * *`. This is the start of every hour in both UTC and Beijing time, although GitHub Actions may start a few minutes late.

Emails are sent only when monitoring is activated or when a public forecast or confirmed reset changes. The source may provide a forecast window without an exact reset time or timezone; the monitor does not invent one.

## Security and Limitations

- Never commit or share a QQ email address, authorization code, password, or token.
- Secrets are available only to the production workflow; pull-request tests do not receive them.
- `state.json` contains public API-derived markers only.
- This project reports third-party global status information. It cannot read personal Codex quota, usage, or account state, and forecasts are not an OpenAI service commitment.
- GitHub may disable scheduled workflows after 60 days without repository activity. Re-enable the workflow and run it manually if checks stop.

## Development

Requires Python 3.12. Run the test suite with:

```bash
uv run --python 3.12 python -m unittest discover -s tests -v
```
