# Codex Reset QQ Email Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public GitHub Actions monitor that checks Codex Resets hourly at Beijing minute `00`, emails one QQ mailbox from itself on forecasts and confirmed resets, and durably prevents duplicate notifications.

**Architecture:** A dependency-free Python package fetches and validates `/api/v1/status`, compares it with a public `state.json`, renders Chinese plain-text mail, and sends through QQ SMTP. Pure decision logic is separated from network and persistence adapters so unit tests run without network access or secrets; GitHub Actions commits state changes even when a later notification in the same run fails.

**Tech Stack:** Python 3.12 standard library, `unittest`, GitHub Actions on `ubuntu-latest`, QQ SMTP over TLS (`smtp.qq.com:465`).

**Spec:** `docs/superpowers/specs/2026-08-28-codex-reset-email-monitor-design.md`

## Global Constraints

- Schedule is exactly `0 * * * *`; this is minute `00` in both UTC and Asia/Shanghai, subject to GitHub scheduling delay.
- Runtime dependencies are limited to the Python 3.12 standard library.
- The only secret inputs are `QQ_EMAIL` and `QQ_SMTP_AUTH_CODE`; neither value may be committed or logged.
- Sender and recipient are both `QQ_EMAIL`.
- Notification jobs run only on `schedule` and `workflow_dispatch`, never on `pull_request`.
- `state.json` contains only version, initialization state, public API-derived markers, and a public state-update timestamp.
- State advances only after the corresponding message succeeds; an unchanged check creates no commit.
- Forecast disappearance updates state without sending mail.
- Tests must not make network calls, read real secrets, or send mail.
- Workflow actions are pinned to immutable commit SHAs.

## File Map

- `codex_reset_monitor/domain.py`: validated domain dataclasses, timestamp parsing, and API payload parsing.
- `codex_reset_monitor/api.py`: bounded HTTP fetch, retry, rate-limit handling, and sanitized API errors.
- `codex_reset_monitor/state.py`: state schema, watch fingerprinting, validation, and atomic JSON persistence.
- `codex_reset_monitor/emailer.py`: Chinese message rendering and QQ SMTP delivery.
- `codex_reset_monitor/monitor.py`: notification decision flow and partial-success persistence.
- `codex_reset_monitor/__main__.py`: environment validation and executable entry point.
- `codex_reset_monitor/__init__.py`: package version only; no side effects.
- `tests/`: standard-library unit tests and reusable fixtures/fakes.
- `.github/workflows/test.yml`: secret-free tests on pushes and pull requests.
- `.github/workflows/monitor.yml`: hourly/manual production monitor and state commit.
- `.gitignore`: Python local artifacts.
- `README.md`: public setup, secret configuration, operation, and security guidance.

---

### Task 1: Validated Status Model and API Client

**Files:**
- Create: `codex_reset_monitor/__init__.py`
- Create: `codex_reset_monitor/domain.py`
- Create: `codex_reset_monitor/api.py`
- Create: `tests/__init__.py`
- Create: `tests/fixtures.py`
- Create: `tests/test_domain.py`
- Create: `tests/test_api.py`

**Interfaces:**
- Produces: `parse_status(payload: Mapping[str, Any]) -> StatusSnapshot`
- Produces: `fetch_status(*, opener=urlopen, sleep=time.sleep) -> StatusSnapshot`
- Produces dataclasses: `SourceInfo`, `ResetInfo`, `WatchInfo`, `StatusSnapshot`
- Produces sanitized exception: `StatusAPIError`

- [ ] **Step 1: Add reusable API fixtures and failing domain tests**

Create `tests/fixtures.py` with a `valid_status_payload()` factory containing a confirmed reset, an active watch, and `meta.generated_at`. Create `tests/test_domain.py` with focused assertions:

```python
import unittest
from datetime import timezone

from codex_reset_monitor.domain import StatusValidationError, parse_status
from tests.fixtures import valid_status_payload


class ParseStatusTests(unittest.TestCase):
    def test_parses_reset_watch_and_utc_timestamps(self):
        status = parse_status(valid_status_payload())
        self.assertEqual(status.latest_reset.id, "reset-1")
        self.assertEqual(status.latest_reset.reset_type, "regular")
        self.assertEqual(status.active_watch.reset_chance_percent, 70)
        self.assertEqual(status.generated_at.tzinfo, timezone.utc)

    def test_allows_null_latest_reset_and_active_watch(self):
        payload = valid_status_payload()
        payload["data"]["latest_reset"] = None
        payload["data"]["active_watch"] = None
        status = parse_status(payload)
        self.assertIsNone(status.latest_reset)
        self.assertIsNone(status.active_watch)

    def test_rejects_missing_required_data(self):
        with self.assertRaisesRegex(StatusValidationError, "invalid status response"):
            parse_status({"data": {}})
```

- [ ] **Step 2: Run the domain tests and verify the import failure**

Run: `python -m unittest tests.test_domain -v`

Expected: FAIL because `codex_reset_monitor.domain` does not exist.

- [ ] **Step 3: Implement immutable domain models and strict parsing**

In `domain.py`, define frozen dataclasses using these exact fields:

```python
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
```

Implement `_parse_timestamp()` to accept RFC 3339 `Z` or offsets, require timezone awareness, and normalize to UTC. Validate nonempty strings, `reset_type in {"regular", "banked"}`, `level in {"elevated", "strong"}`, and probability as `None` or an integer from 0 through 100. Wrap `KeyError`, `TypeError`, and `ValueError` as `StatusValidationError("invalid status response") from None` so raw payload content never appears in logs.

- [ ] **Step 4: Run the domain tests**

Run: `python -m unittest tests.test_domain -v`

Expected: all domain tests PASS.

- [ ] **Step 5: Add failing HTTP retry and sanitization tests**

Create `tests/test_api.py` with fake response/context-manager objects. Include this complete retry test:

```python
class FetchStatusTests(unittest.TestCase):
    def test_retries_temporary_url_error_then_succeeds(self):
        calls = []
        sleeps = []

        def opener(request, timeout):
            calls.append((request, timeout))
            if len(calls) == 1:
                raise URLError("temporary detail that must be hidden")
            return FakeResponse(valid_status_payload())

        status = fetch_status(opener=opener, sleep=sleeps.append)

        self.assertEqual(status.latest_reset.id, "reset-1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], 15)
        self.assertEqual(sleeps, [1])
```

`FakeResponse` returns `json.dumps(payload).encode("utf-8")` from `read()` and implements `__enter__`/`__exit__`. Add four more exact cases: a first-attempt success asserting URL `https://codex-resets.com/api/v1/status`, header `Accept: application/json`, and timeout `15`; an HTTP 429 with `Retry-After: 99` followed by success asserting sleep `[30]`; an HTTP 404 asserting one opener call and `StatusAPIError`; and three `URLError` failures asserting sleeps `[1, 2]` and final exception text exactly `Codex Resets API request failed`.

- [ ] **Step 6: Run the API tests and verify failure**

Run: `python -m unittest tests.test_api -v`

Expected: FAIL because `codex_reset_monitor.api` does not exist.

- [ ] **Step 7: Implement the API client**

Implement `fetch_status` with constants:

```python
STATUS_URL = "https://codex-resets.com/api/v1/status"
REQUEST_TIMEOUT_SECONDS = 15
MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (1, 2)
MAX_RETRY_AFTER_SECONDS = 30
```

Use `urllib.request.Request`, `urllib.request.urlopen`, `json.loads`, and the injected `sleep`. Retry `URLError`, HTTP 429, and HTTP 5xx; honor a numeric `Retry-After` for 429 capped to 30 seconds. Do not retry other HTTP 4xx responses. Convert transport, decoding, and validation failures at the public boundary to `StatusAPIError("Codex Resets API request failed") from None`.

- [ ] **Step 8: Run Task 1 tests and commit**

Run: `python -m unittest tests.test_domain tests.test_api -v`

Expected: all tests PASS.

Commit:

```bash
git add codex_reset_monitor tests
git commit -m "feat: add validated Codex Resets API client"
```

---

### Task 2: Durable State and Forecast Fingerprints

**Files:**
- Create: `codex_reset_monitor/state.py`
- Create: `tests/test_state.py`

**Interfaces:**
- Consumes: `WatchInfo` from Task 1.
- Produces: `MonitorState.initial() -> MonitorState`
- Produces: `load_state(path: Path) -> MonitorState`
- Produces: `save_state(path: Path, state: MonitorState) -> None`
- Produces: `watch_fingerprint(watch: WatchInfo) -> str`
- Produces sanitized exception: `StateError`

- [ ] **Step 1: Write failing schema, fingerprint, and persistence tests**

Create tests that assert the complete public schema and atomic behavior:

```python
class MonitorStateTests(unittest.TestCase):
    def test_missing_file_returns_uninitialized_state(self):
        state = load_state(self.path)
        self.assertEqual(state, MonitorState.initial())

    def test_round_trip_uses_only_approved_keys(self):
        state = MonitorState(
            version=1,
            initialized=True,
            notified_reset_id="reset-1",
            active_watch_fingerprint="abc",
            state_updated_at="2026-08-28T14:00:00Z",
        )
        save_state(self.path, state)
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(set(raw), {
            "version", "initialized", "notified_reset_id",
            "active_watch_fingerprint", "state_updated_at",
        })
        self.assertNotIn("email", self.path.read_text(encoding="utf-8").lower())

    def test_rejects_unknown_version(self):
        self.path.write_text('{"version": 2}', encoding="utf-8")
        with self.assertRaisesRegex(StateError, "monitor state is invalid"):
            load_state(self.path)

    def test_atomic_save_leaves_no_temporary_file(self):
        save_state(self.path, MonitorState.initial())
        self.assertEqual([item.name for item in self.path.parent.iterdir()], ["state.json"])
```

Add fingerprint tests proving identical watches produce identical 64-character lowercase SHA-256 strings and changing level, probability, window, observation time, expiration time, text, or source fields changes the fingerprint.

- [ ] **Step 2: Run state tests and verify failure**

Run: `python -m unittest tests.test_state -v`

Expected: FAIL because `codex_reset_monitor.state` does not exist.

- [ ] **Step 3: Implement exact state validation and atomic writes**

Define:

```python
@dataclass(frozen=True)
class MonitorState:
    version: int
    initialized: bool
    notified_reset_id: str | None
    active_watch_fingerprint: str | None
    state_updated_at: str | None
```

`MonitorState.initial()` returns version 1, `initialized=False`, and all markers `None`. `load_state` accepts only the five exact keys and version 1. `save_state` serializes sorted, indented UTF-8 JSON with a trailing newline, writes to a temporary file in the destination directory, flushes and `os.fsync()`s it, then replaces the destination with `os.replace()`.

`watch_fingerprint` serializes all material watch/source fields as canonical JSON (`sort_keys=True`, compact separators, UTF-8 preserved) and returns `hashlib.sha256(serialized.encode("utf-8")).hexdigest()`.

All public state failures raise `StateError("monitor state is invalid") from None` without including file content.

- [ ] **Step 4: Run state tests and commit**

Run: `python -m unittest tests.test_state -v`

Expected: all tests PASS.

Commit:

```bash
git add codex_reset_monitor/state.py tests/test_state.py
git commit -m "feat: add durable notification state"
```

---

### Task 3: Chinese Email Rendering and QQ SMTP Adapter

**Files:**
- Create: `codex_reset_monitor/emailer.py`
- Create: `tests/test_emailer.py`

**Interfaces:**
- Consumes: `ResetInfo`, `StatusSnapshot`, and `WatchInfo` from Task 1.
- Produces: `MailContent(subject: str, body: str)`.
- Produces: `render_activation(status, checked_at) -> MailContent`.
- Produces: `render_watch(watch, checked_at, *, is_update) -> MailContent`.
- Produces: `render_reset(reset, checked_at) -> MailContent`.
- Produces: `QQMailer(email, auth_code, smtp_factory=smtplib.SMTP_SSL).send(content) -> None`.
- Produces sanitized exceptions: `MailConfigurationError`, `MailDeliveryError`.

- [ ] **Step 1: Write failing rendering tests**

Test exact subject prefixes and required body information. Include this complete timestamp case:

```python
class RenderMailTests(unittest.TestCase):
    def test_activation_contains_current_reset_and_beijing_time(self):
        status = parse_status(valid_status_payload())
        checked_at = datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc)

        content = render_activation(status, checked_at)

        self.assertEqual(content.subject, "[Codex Resets] 监控已启用")
        self.assertIn("2026-08-27 16:35:05 UTC", content.body)
        self.assertIn("2026-08-28 00:35:05 北京时间", content.body)
        self.assertIn("reset announcement", content.body)
```

Use an announced UTC time of `2026-08-27T16:35:05Z`. Add exact cases asserting a new 70% watch subject `[Codex Resets] 重置预警：概率 70%`; an updated 85% subject `[Codex Resets] 重置预警已更新：概率 85%`; a null probability subject ending in `概率未知`; and a reset subject `[Codex Resets] Codex 已重置` whose body includes `regular`, source text, source URL, both UTC/Beijing times, and the check time.

- [ ] **Step 2: Write failing SMTP security tests**

Use a fake SMTP context manager that records constructor arguments, `login`, and `send_message`. Assert:

- Host is `smtp.qq.com`, port is `465`, and timeout is `20`.
- `login` receives the injected email and authorization code.
- `From` and `To` are the same email.
- UTF-8 Chinese text survives in the `EmailMessage`.
- A non-`@qq.com` address raises `MailConfigurationError("QQ email configuration is invalid")`.
- An empty authorization code raises the same sanitized configuration error.
- `SMTPException` and `OSError` are retried once, then raise exactly `QQ SMTP delivery failed` without the address or authorization code.

- [ ] **Step 3: Run email tests and verify failure**

Run: `python -m unittest tests.test_emailer -v`

Expected: FAIL because `codex_reset_monitor.emailer` does not exist.

- [ ] **Step 4: Implement rendering and SMTP delivery**

Use `zoneinfo.ZoneInfo("Asia/Shanghai")` and one `_format_times(datetime) -> tuple[str, str]` helper. Render plain text with stable labels such as `预测概率`, `预测窗口`, `重置类型`, `公告时间`, `检测时间`, `公告原文`, and `来源链接`.

`QQMailer` validates `email.strip().lower().endswith("@qq.com")` and nonempty inputs. Construct `EmailMessage`, set UTF-8 plain text, and use `smtplib.SMTP_SSL("smtp.qq.com", 465, timeout=20, context=ssl.create_default_context())`. Retry once after a one-second injected sleep. Raise sanitized exceptions with `from None`; never include SMTP arguments, mailbox, message headers, or credentials in the exception text.

- [ ] **Step 5: Run email tests and commit**

Run: `python -m unittest tests.test_emailer -v`

Expected: all tests PASS.

Commit:

```bash
git add codex_reset_monitor/emailer.py tests/test_emailer.py
git commit -m "feat: render and send QQ reset notifications"
```

---

### Task 4: Notification Orchestration and Executable Entry Point

**Files:**
- Create: `codex_reset_monitor/monitor.py`
- Create: `codex_reset_monitor/__main__.py`
- Create: `tests/test_monitor.py`
- Create: `tests/test_main.py`

**Interfaces:**
- Consumes: all public interfaces from Tasks 1 through 3.
- Produces: `process_status(status, state, checked_at, send, persist) -> MonitorState`.
- Produces: `main() -> int`, executable with `python -m codex_reset_monitor`.
- Produces sanitized exception: `MonitorRunError`.

- [ ] **Step 1: Write failing first-run and deduplication tests**

Use fake `send` and `persist` callables that record calls. Include this complete initialization test:

```python
class ProcessStatusTests(unittest.TestCase):
    def test_first_run_sends_activation_then_initializes_all_markers(self):
        status = parse_status(valid_status_payload())
        sent = []
        persisted = []

        result = process_status(
            status,
            MonitorState.initial(),
            datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc),
            sent.append,
            persisted.append,
        )

        self.assertEqual([mail.subject for mail in sent], ["[Codex Resets] 监控已启用"])
        self.assertTrue(result.initialized)
        self.assertEqual(result.notified_reset_id, "reset-1")
        self.assertEqual(result.active_watch_fingerprint, watch_fingerprint(status.active_watch))
        self.assertEqual(persisted, [result])
```

Add exact cases asserting: an identical initialized snapshot produces zero sends and zero persists; a newly present watch sends the 70% forecast and persists its fingerprint; a changed watch sends the update subject and replaces the fingerprint; a missing watch clears a non-null fingerprint with one persist and no send; and a new reset sends the confirmed-reset subject and persists only the new reset ID. Initialization must record the current reset ID and watch fingerprint, preventing immediate historical follow-up messages.

- [ ] **Step 2: Write failing partial-success tests**

Add tests where forecast and reset both change:

- Forecast succeeds and reset fails: fingerprint advances, reset ID remains old, persisted state reflects only forecast success, and `MonitorRunError` is raised after both attempts.
- Forecast fails and reset succeeds: fingerprint remains old, reset ID advances, and `MonitorRunError` is raised after both attempts.
- Persistence failure after successful mail stops processing immediately and raises `MonitorRunError`, because sending additional mail without durable local state would increase duplicate risk.

- [ ] **Step 3: Run monitor tests and verify failure**

Run: `python -m unittest tests.test_monitor -v`

Expected: FAIL because `codex_reset_monitor.monitor` does not exist.

- [ ] **Step 4: Implement deterministic orchestration**

Implement this order:

1. On uninitialized state, send activation, derive both current markers, persist once, and return.
2. On an initialized state, process active-watch disappearance or changed fingerprint.
3. Process changed reset ID independently even if watch mail failed.
4. After each successful mail, replace only its marker plus `state_updated_at` and immediately call `persist`.
5. Collect mail failures using sanitized category strings and raise `MonitorRunError("one or more notifications failed") from None` only after all independent notification attempts finish.
6. Do not persist and do not change `state_updated_at` for a completely unchanged snapshot.

Use `dataclasses.replace` for immutable state transitions. Convert `checked_at` to normalized UTC RFC 3339 with a trailing `Z` for `state_updated_at`.

- [ ] **Step 5: Write failing entry-point tests**

Patch environment reads and adapters. Include this complete missing-secret test:

```python
class MainTests(unittest.TestCase):
    def test_missing_secrets_returns_failure_without_printing_values(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stderr(stderr):
            result = main()

        self.assertEqual(result, 1)
        self.assertEqual(stderr.getvalue(), "monitor failed: QQ email configuration is invalid\n")
```

Add a success case patching `load_state`, `fetch_status`, `QQMailer`, `process_status`, and `save_state`, asserting return code 0 and fixed relative path `Path("state.json")`. Add a known-failure case whose fake adapter raises `StatusAPIError("Codex Resets API request failed")`, asserting exact sanitized stderr and confirming that neither the injected sample mailbox nor sample authorization code appears.

- [ ] **Step 6: Implement `__main__.py`**

Read `QQ_EMAIL` and `QQ_SMTP_AUTH_CODE` with `os.environ.get`. Validate by constructing `QQMailer`; do not print either value. Load state, fetch status, call `process_status` with `mailer.send` and a persistence closure calling `save_state(Path("state.json"), state)`. Use `datetime.now(timezone.utc)` for the check time.

Return `0` on success. Catch only the application's sanitized exception types and print `monitor failed: <sanitized message>` to stderr before returning `1`. End with `raise SystemExit(main())`.

- [ ] **Step 7: Run orchestration and entry-point tests and commit**

Run: `python -m unittest tests.test_monitor tests.test_main -v`

Expected: all tests PASS.

Commit:

```bash
git add codex_reset_monitor/monitor.py codex_reset_monitor/__main__.py tests/test_monitor.py tests/test_main.py
git commit -m "feat: orchestrate durable reset notifications"
```

---

### Task 5: Public GitHub Workflows, Security Checks, and Operator Guide

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/monitor.yml`
- Create: `.gitignore`
- Create: `tests/test_repository_security.py`
- Create: `README.md`

**Interfaces:**
- Consumes: `python -m unittest discover -s tests -v` and `python -m codex_reset_monitor`.
- Produces: public-repository CI, hourly production execution, durable state commits, and setup documentation.

- [ ] **Step 1: Add failing repository-security tests**

Create tests that scan runtime source, workflow files, `state.json` when present, and README. Include this complete workflow contract test:

```python
class RepositorySecurityTests(unittest.TestCase):
    def test_monitor_schedule_permissions_and_pins(self):
        text = Path(".github/workflows/monitor.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 * * * *"', text)
        self.assertIn("contents: write", text)
        self.assertNotIn("pull_request:", text)
        uses = re.findall(r"uses:\s+[^@]+@([^\s#]+)", text)
        self.assertTrue(uses)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", value) for value in uses))
```

Add exact cases that: scan runtime source, workflows, README, and optional `state.json` with `(?i)\b[0-9]{5,12}@qq\.com\b` and find no match; serialize `MonitorState` and find no key containing `email`, `auth`, `password`, or `secret`; assert `test.yml` has `pull_request`, `contents: read`, and no `secrets.`; and assert both workflow files pin every `uses:` entry to a 40-character lowercase hexadecimal SHA. Allow symbolic strings `QQ_EMAIL`, `QQ_SMTP_AUTH_CODE`, and `${{ secrets.QQ_EMAIL }}` because they contain no value.

- [ ] **Step 2: Run the security tests and verify workflow-file failures**

Run: `python -m unittest tests.test_repository_security -v`

Expected: FAIL because workflow files do not exist.

- [ ] **Step 3: Create the secret-free test workflow**

Create `.github/workflows/test.yml` with `permissions: contents: read`, triggers for `push` and `pull_request`, and one Ubuntu job. Pin:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
- uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
  with:
    python-version: "3.12"
```

Run `python -m unittest discover -s tests -v`. This workflow must contain no `secrets.` reference.

- [ ] **Step 4: Create the hourly production workflow**

Create `.github/workflows/monitor.yml` with only `schedule` (`cron: "0 * * * *"`) and `workflow_dispatch`. Configure:

```yaml
permissions:
  contents: write
concurrency:
  group: codex-reset-monitor
  cancel-in-progress: false
```

Use the same pinned checkout and setup-python SHAs. The monitor step has `id: monitor`, `continue-on-error: true`, and only these secret environment variables:

```yaml
env:
  QQ_EMAIL: ${{ secrets.QQ_EMAIL }}
  QQ_SMTP_AUTH_CODE: ${{ secrets.QQ_SMTP_AUTH_CODE }}
run: python -m codex_reset_monitor
```

Add a state step with `if: always()` that checks `git status --porcelain -- state.json`; when changed, configure the GitHub Actions bot identity, add only `state.json`, commit, `git pull --rebase`, and push. Add a final step with `if: steps.monitor.outcome == 'failure'` that exits 1 so notification failures remain visible after state persistence.

- [ ] **Step 5: Add `.gitignore` and the public operator guide**

Ignore `.venv/`, `__pycache__/`, `*.py[cod]`, `.coverage`, and editor/OS artifacts. README sections must explain:

- The monitor reports third-party classified global reset announcements, not personal quota.
- The hourly Beijing/UTC minute-zero schedule and possible GitHub delay.
- How to create a public repository without committing secrets.
- How to enable QQ SMTP and generate an authorization code.
- How to add `QQ_EMAIL` and `QQ_SMTP_AUTH_CODE` under **Settings → Secrets and variables → Actions**.
- How to enable read/write workflow permissions needed only for `state.json`.
- How to run the workflow manually and expect the activation email.
- What forecast, update, and confirmation emails mean.
- How to rotate/revoke the QQ authorization code and disable the workflow.
- That no actual mailbox or authorization code belongs in issues, commits, logs, screenshots, or support messages.

- [ ] **Step 6: Run the entire local test suite and security scan**

Run: `python -m unittest discover -s tests -v`

Expected: all tests PASS with no network access and no mail sent.

Run: `git grep -nE '[0-9]{5,12}@qq\.com|QQ_SMTP_AUTH_CODE[[:space:]]*=' -- ':!docs/superpowers/plans/*'`

Expected: no output. Symbolic workflow references use `${{ secrets.QQ_SMTP_AUTH_CODE }}` and therefore do not match an assignment.

- [ ] **Step 7: Perform a safe CLI failure check**

Run with both secret environment variables absent:

```bash
python -m codex_reset_monitor
```

Expected: exit code 1 with a sanitized configuration error; output contains no mailbox or authorization code. Do not perform a live SMTP test locally.

- [ ] **Step 8: Commit the workflows and documentation**

```bash
git add .github .gitignore README.md tests/test_repository_security.py
git commit -m "feat: automate hourly QQ reset alerts"
```

---

### Task 6: Final Verification and Public-Repository Handoff

**Files:**
- Verify: all tracked files
- Verify: `docs/superpowers/specs/2026-08-28-codex-reset-email-monitor-design.md`
- Verify: `docs/superpowers/plans/2026-08-28-codex-reset-email-monitor.md`

**Interfaces:**
- Consumes: the complete repository from Tasks 1 through 5.
- Produces: verified local commits and exact user steps for publishing and secret entry.

- [ ] **Step 1: Verify tests and repository cleanliness**

Run:

```bash
python -m unittest discover -s tests -v
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: all tests PASS, `git diff --check` prints nothing, the worktree is clean, and the planned commits are present.

- [ ] **Step 2: Verify the workflow contract without secrets**

Confirm from tracked YAML that:

- Test workflow has read-only permission and no secret references.
- Monitor workflow triggers only on schedule/manual invocation.
- Cron is exactly `0 * * * *`.
- Concurrency is enabled without canceling a running monitor.
- Monitor secrets are scoped only to the monitor step.
- State persistence runs after monitor failure.
- A final step re-fails the job after persistence.

- [ ] **Step 3: Prepare the handoff without creating external state**

Report the local branch and commits. Give the user these external steps, but do not perform them without a later explicit request:

1. Create a public GitHub repository.
2. Add it as the local `origin` and push `main`.
3. Add `QQ_EMAIL` and `QQ_SMTP_AUTH_CODE` as Actions Secrets.
4. Enable Actions read/write workflow permission for state commits.
5. Manually run the monitor workflow once.
6. Verify the activation email and the first `state.json` bot commit.

Do not ask the user to paste either secret into chat.
