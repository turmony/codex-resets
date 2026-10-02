# Codex Resets 126 Mail Monitor

English | [简体中文](README.zh-CN.md)

[![Test](https://github.com/turmony/codex-resets/actions/workflows/test.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/test.yml)

A Cloudflare Worker checks the public Codex Resets API every three hours and sends activation, forecast, forecast-update, and confirmed-reset notifications through one NetEase 126 mailbox. GitHub stores the code; Workers Builds tests and deploys pushes to `main`. D1 preserves notification state across deployments.

See the [deployment guide](docs/cloudflare-migration.zh-CN.md) and [HTML call-chain diagram](docs/diagrams/project-call-chain.html).

## Development

Requires Node.js 24. Install and validate with:

```bash
npm ci
npm run types
npm run typecheck
npm test
npm run build
```

Use `npm run db:local` and `npm run dev` for local development. Store local secrets in the ignored `.dev.vars` file. Runtime tests use isolated D1 storage and mocked mail transports, never production resources.

## Deployment

Configure your Cloudflare account and D1 database in `wrangler.jsonc`, apply SQL migrations, and add `MAIL_EMAIL`, `MAIL_SMTP_AUTH_CODE`, and `ADMIN_TOKEN` as Worker **Secrets**. Enable IMAP/SMTP for your 126 mailbox and use its authorization code, not its login password. Run `npm run deploy` after initial provisioning. Never store mail credentials in source, plaintext variables, or build variables.

Connect the repository to Workers Builds with production branch `main`, build command `npm run types && npm run typecheck && npm test`, and deploy command `npm run deploy`. The build token needs Workers Scripts Edit and D1 Edit on the target account. Runtime secrets remain on the Worker.

## Scheduling and recovery

`30 1-22/3 * * *` runs at Beijing 00:30, 03:30, ..., 21:30. There is no additional ten-minute polling loop. Importing initialized legacy state avoids a second activation email.

Each notification is persisted before sending. Once SMTP accepts it, one D1 transaction records the result and deduplication markers. A database failure retries database saving only. An uncertain SMTP result is reconciled through read-only IMAP on the next run; failed reconciliation postpones resending. A successful search with no matching message permits a retry after a 30-minute delivery grace. Expired forecasts are never retried.

SMTP acceptance and D1 writes cannot form a single distributed atomic transaction. This recovery policy reduces duplicates; it does not guarantee exactly-once inbox delivery.

## Operations

The [dashboard](https://codex-resets-monitor.turmony.workers.dev/) follows the light card layout in `ikuuu-daily-checkin`. Sign in with your own password to view the last check, next scheduled check, deduplication markers, pending notifications and the latest 20 notification records, or run a manual check and verify mail connections. There is no automatic polling.

On first use, enter the original admin token as the recovery code and set a 6–128 character password. You can change the password while signed in, or use “Forgot password” and the recovery code to reset it. Both actions revoke every session atomically and preserve monitoring history. Back up the recovery code from the ignored `.wrangler/admin-token` file offline.

D1 stores a salted, secret-peppered PBKDF2 verifier rather than plaintext passwords. Sessions use a secure HttpOnly SameSite=Strict cookie with a 12-hour expiry. Authentication requests are rate limited. Public `GET /health` and `GET /auth/status` return small summaries; management operations require a session. Mail verification checks SMTP/IMAP TLS and authentication without sending mail.

```bash
npm run admin -- status
npm run admin -- verify-mail
npm run admin -- check
```

After password setup, the admin helper logs in using `ADMIN_PASSWORD` or the optional ignored `.wrangler/admin-password` file, and logs out after the operation. Before first setup only, it accepts the original `ADMIN_TOKEN` or `.wrangler/admin-token`. Set `MONITOR_URL` for another deployment. If necessary, configure `HTTPS_PROXY` and run `node --use-env-proxy scripts/admin.mjs status`. Passwords and session cookies are never printed.

The original Python implementation remains available for rollback and regression testing. Its Actions workflow is manual-only and requires `run_legacy`. Pause the Worker and synchronize its latest D1 markers back to `state.json` before using the legacy monitor.

This project reports third-party global status, cannot read personal Codex quota or usage, and makes no OpenAI service commitment. Cron delivery is not a precise real-time guarantee.
