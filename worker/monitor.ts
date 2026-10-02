import { effectiveStatus, scheduledFingerprint, sha256, watchFingerprint, type MonitorState, type StatusSnapshot } from './domain';
import { renderActivation, renderReset, renderScheduled, renderWatch, validateMail } from './emailer';
import { fetchStatus, sleep } from './api';
import { findReceived } from './imap';
import { sendMail, SMTPDeliveryError } from './smtp';
import { LeaseLost, Store, type NotificationPayload, type NotificationPlan, type NotificationRow } from './store';

export interface Dependencies {
  fetchStatus: (signal: AbortSignal) => Promise<StatusSnapshot>;
  send: (row: NotificationRow, payload: NotificationPayload, signal: AbortSignal, beforeData: () => Promise<void>) => Promise<void>;
  find: (row: NotificationRow, signal: AbortSignal) => Promise<boolean>;
}
export interface RunResult { result: 'ok' | 'partial' | 'busy' | 'disabled' | 'unconfigured'; sent: number; deferred: number; failed: number }

export async function planNotifications(status: StatusSnapshot, state: MonitorState, now: number, scheduledIsUpdate = false): Promise<NotificationPlan[]> {
  status = effectiveStatus(status, now);
  const at = new Date(now).toISOString(), plans: NotificationPlan[] = [];
  const fingerprint = status.active_watch ? await watchFingerprint(status.active_watch) : null;
  if (!state.initialized) {
    plans.push({ eventId: await sha256('activation:v1'), kind: 'activation', payload: {
      content: renderActivation(status, at), expiresAt: status.active_watch?.expires_at ?? null, fingerprint,
      patch: { initialized: true, notified_reset_id: status.latest_reset?.id ?? null, active_watch_fingerprint: fingerprint },
    } });
  }
  if (state.initialized && status.active_watch && fingerprint !== state.active_watch_fingerprint) plans.push({ eventId: await sha256('forecast:' + fingerprint), kind: 'forecast', payload: {
    content: renderWatch(status.active_watch, at, state.active_watch_fingerprint !== null),
    expiresAt: status.active_watch.expires_at, fingerprint, patch: { active_watch_fingerprint: fingerprint },
  } });
  if (status.scheduled_reset) {
    const scheduled = status.scheduled_reset, fingerprint = await scheduledFingerprint(scheduled);
    plans.push({ eventId: await sha256('scheduled:' + fingerprint), kind: 'scheduled', payload: {
      content: renderScheduled(scheduled, at, scheduledIsUpdate), expiresAt: null, fingerprint,
      scheduledResetId: scheduled.id, patch: {},
    } });
  }
  if (state.initialized && status.latest_reset && status.latest_reset.id !== state.notified_reset_id) plans.push({ eventId: await sha256('reset:' + status.latest_reset.id), kind: 'reset', payload: {
    content: renderReset(status.latest_reset, at), expiresAt: null, fingerprint: null, patch: { notified_reset_id: status.latest_reset.id },
  } });
  return plans;
}

/** Retry database writes only; this function never calls SMTP. */
async function commitAccepted(store: Store, row: NotificationRow): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await store.complete(row); return; }
    catch (error) { if (error instanceof LeaseLost || attempt === 2) throw error; await sleep((attempt + 1) * 100); }
  }
}

export async function runMonitor(env: Env, injected?: Dependencies, store = new Store(env.DB)): Promise<RunResult> {
  const report: RunResult = { result: 'ok', sent: 0, deferred: 0, failed: 0 };
  if (env.MONITOR_ENABLED !== 'true') return { ...report, result: 'disabled' };
  if (!injected) {
    try { validateMail(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE); }
    catch { return { ...report, result: 'unconfigured' }; }
  }
  const deps = injected ?? {
    fetchStatus,
    send: (row, payload, signal, beforeData) => sendMail(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE, row.event_id, payload.content, signal, beforeData),
    find: (row, signal) => findReceived(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE, row.event_id, signal),
  } satisfies Dependencies;
  if (!await store.acquire()) return { ...report, result: 'busy' };
  const signal = AbortSignal.timeout(180000);
  try {
    const status = effectiveStatus(await deps.fetchStatus(signal), Date.now());
    const currentFingerprint = status.active_watch ? await watchFingerprint(status.active_watch) : null;
    const currentScheduledFingerprint = status.scheduled_reset ? await scheduledFingerprint(status.scheduled_reset) : null;
    const blockedKinds = new Set<string>(), tried = new Set<string>();
    // The persisted accepted state proves SMTP acceptance, even after a crash.
    // sending/uncertain require read-only IMAP reconciliation before a resend.
    for (const row of await store.recoverable()) {
      if (row.status === 'pending') continue;
      tried.add(row.event_id);
      const payload = JSON.parse(row.payload_json) as NotificationPayload;
      if (row.status === 'accepted') { await commitAccepted(store, row); continue; }
      let found: boolean;
      try { await store.assertLease(); found = await deps.find(row, signal); }
      catch { report.deferred++; blockedKinds.add(row.kind); continue; }
      if (found) { await commitAccepted(store, row); continue; }
      const invalid = payload.expiresAt !== null && Date.parse(payload.expiresAt) <= Date.now();
      const superseded = (row.kind === 'forecast' && payload.fingerprint !== currentFingerprint) ||
        (row.kind === 'scheduled' && payload.fingerprint !== currentScheduledFingerprint);
      if (invalid || superseded) { await store.setStatus(row, 'cancelled', 'event expired or superseded'); continue; }
      // One complete polling interval is ample normal delivery grace, but a
      // missing email still cannot mathematically prove SMTP never accepted it.
      if (!row.attempted_at || Date.now() - Date.parse(row.attempted_at) < 30 * 60000) {
        report.deferred++; blockedKinds.add(row.kind); continue;
      }
      await store.setStatus(row, 'pending');
      tried.delete(row.event_id);
    }
    const state = await store.state();
    if (!status.active_watch && state.active_watch_fingerprint !== null && !blockedKinds.has('forecast')) await store.clearWatch();
    const scheduledIsUpdate = status.scheduled_reset ? await store.hasSentScheduled(status.scheduled_reset.id) : false;
    const plans = await planNotifications(status, await store.state(), Date.now(), scheduledIsUpdate);
    // Cancel obsolete never-submitted events; they must not live as endless pending work.
    const planned = new Set(plans.map(p => p.eventId));
    for (const row of await store.recoverable()) {
      if (row.status === 'pending' && !planned.has(row.event_id)) await store.setStatus(row, 'cancelled', 'event superseded');
    }
    for (const plan of plans) {
      if (blockedKinds.has(plan.kind) || tried.has(plan.eventId)) continue;
      // A delivered plan must not precede initialization: a later activation
      // would otherwise absorb its execution into the baseline reset marker.
      if (plan.kind === 'scheduled' && !state.initialized && !(await store.state()).initialized) {
        report.deferred++; continue;
      }
      const row = await store.prepare(plan);
      if (row.status === 'sent') continue;
      const payload = JSON.parse(row.payload_json) as NotificationPayload;
      if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) { await store.setStatus(row, 'cancelled', 'event expired'); continue; }
      signal.throwIfAborted();
      await store.assertLease();
      await store.submitting(row);
      try {
        await deps.send(row, payload, signal, () => store.assertLease());
      } catch (error) {
        const uncertain = !(error instanceof SMTPDeliveryError) || error.uncertain;
        await store.setStatus(row, uncertain ? 'uncertain' : 'pending', uncertain ? 'smtp outcome uncertain' : 'smtp submission failed');
        report.failed++; continue;
      }
      // Record acceptance as early as possible. If this write fails, attempt
      // the atomic completion directly; do not enter the delivery catch again.
      await store.setStatus(row, 'accepted').catch(() => {});
      await commitAccepted(store, row);
      report.sent++;
    }
    report.result = report.failed || report.deferred ? 'partial' : 'ok';
    await store.checked(report.result);
    return report;
  } catch (error) {
    await store.checked('failed').catch(() => {});
    throw error;
  } finally { await store.release().catch(() => {}); }
}
