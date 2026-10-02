import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { planNotifications, runMonitor } from '../worker/monitor';
import { parseState, watchFingerprint } from '../worker/domain';
import { LeaseLost, Store, type NotificationRow } from '../worker/store';
import { SMTPDeliveryError } from '../worker/smtp';
import { dependencies, freshStatus } from './fixtures';

async function initialized() {
  await env.DB.prepare("UPDATE monitor SET state_json = json_set(state_json, '$.initialized', json('true'), '$.notified_reset_id', 'reset-1') WHERE id = 1").run();
}
async function pending(kind: 'forecast' | 'reset' = 'forecast', status: 'sending' | 'accepted' | 'uncertain' = 'uncertain') {
  await initialized();
  const snapshot = freshStatus();
  if (kind === 'reset') snapshot.latest_reset!.id = 'reset-2';
  const store = new Store(env.DB); await store.acquire();
  const plan = (await planNotifications(snapshot, await store.state(), Date.now())).find(p => p.kind === kind)!;
  const row = await store.prepare(plan); await store.submitting(row); await store.setStatus(row, status);
  await env.DB.prepare('UPDATE notifications SET attempted_at = ? WHERE event_id = ?').bind(new Date(Date.now() - 3 * 3600000).toISOString(), row.event_id).run();
  await store.release();
  return { snapshot, row };
}
describe('D1 and notification recovery', () => {
  it('sends activation once and atomically records reset and forecast markers', async () => {
    const deps = dependencies();
    expect((await runMonitor(env, deps)).sent).toBe(1);
    const state = await new Store(env.DB).state();
    expect(state.initialized).toBe(true);
    expect(state.notified_reset_id).toBe('reset-1');
    expect(state.active_watch_fingerprint).toBe(await watchFingerprint((await deps.fetchStatus(new AbortController().signal)).active_watch!));
    expect((await runMonitor(env, deps)).sent).toBe(0);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('supports null marker fields in a first activation without breaking the state schema', async () => {
    const deps = dependencies({ active_watch: null, latest_reset: null, generated_at: new Date().toISOString() });
    await runMonitor(env, deps);
    expect(await new Store(env.DB).state()).toMatchObject({ initialized: true, notified_reset_id: null, active_watch_fingerprint: null });
  });
  it('retains imported initialized state without sending activation again', async () => {
    await initialized();
    const status = freshStatus(); status.active_watch = null;
    const deps = dependencies(status);
    expect((await runMonitor(env, deps)).sent).toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('prevents overlapping scheduled and manual sends with a database lease', async () => {
    const store = new Store(env.DB); expect(await store.acquire()).toBe(true);
    const deps = dependencies();
    expect((await runMonitor(env, deps)).result).toBe('busy');
    expect(deps.fetchStatus).not.toHaveBeenCalled(); await store.release();
  });
  it('fences an old execution after lease takeover', async () => {
    const a = new Store(env.DB); await a.acquire();
    await env.DB.prepare('UPDATE monitor SET lease_until = 0').run();
    const b = new Store(env.DB); await b.acquire();
    await expect(a.clearWatch()).rejects.toBeInstanceOf(LeaseLost);
    await a.release(); expect(await new Store(env.DB).acquire()).toBe(false);
  });
  it('sends forecast and confirmed reset independently if one SMTP attempt fails', async () => {
    await initialized();
    const status = freshStatus(); status.latest_reset!.id = 'reset-2';
    const deps = dependencies(status);
    deps.send.mockImplementation(async row => { if (row.kind === 'forecast') throw new SMTPDeliveryError(false); });
    const result = await runMonitor(env, deps);
    expect(result).toMatchObject({ result: 'partial', failed: 1, sent: 1 });
    expect(await new Store(env.DB).state()).toMatchObject({ active_watch_fingerprint: null, notified_reset_id: 'reset-2' });
    deps.send.mockClear(); deps.send.mockResolvedValue();
    await runMonitor(env, deps); expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send.mock.calls[0][0].kind).toBe('forecast');
  });
  it('retries only database saving after SMTP acceptance', async () => {
    const store = new Store(env.DB), complete = store.complete.bind(store);
    const mocked = vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('simulated DB failure')).mockImplementation(complete);
    const deps = dependencies(); await runMonitor(env, deps, store);
    expect(mocked).toHaveBeenCalledTimes(2); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('recovers persisted acceptance after all completion writes fail', async () => {
    const store = new Store(env.DB);
    vi.spyOn(store, 'complete').mockRejectedValue(new Error('simulated DB failure'));
    const deps = dependencies(); await expect(runMonitor(env, deps, store)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT status FROM notifications').first<{ status: string }>())!.status).toBe('accepted');
    await runMonitor(env, deps);
    expect(deps.send).toHaveBeenCalledTimes(1); expect(deps.find).not.toHaveBeenCalled();
  });
  it('repairs markers from received mail without resending after a crash', async () => {
    const { snapshot } = await pending();
    const deps = dependencies(snapshot); deps.find.mockResolvedValue(true);
    await runMonitor(env, deps);
    expect(deps.find).toHaveBeenCalledTimes(1); expect(deps.send).not.toHaveBeenCalled();
    expect((await new Store(env.DB).state()).active_watch_fingerprint).toBe(await watchFingerprint(snapshot.active_watch!));
  });
  it('does not blindly resend when IMAP is unavailable', async () => {
    const { snapshot } = await pending();
    const deps = dependencies(snapshot); deps.find.mockRejectedValue(new Error('unavailable'));
    expect((await runMonitor(env, deps)).deferred).toBe(1); expect(deps.send).not.toHaveBeenCalled();
  });
  it('waits for delivery grace before a missing message can be retried', async () => {
    const { snapshot } = await pending();
    await env.DB.prepare('UPDATE notifications SET attempted_at = ?').bind(new Date().toISOString()).run();
    const deps = dependencies(snapshot); await runMonitor(env, deps);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('retries a missing mail only after grace and successful IMAP search', async () => {
    const { snapshot } = await pending();
    const deps = dependencies(snapshot); await runMonitor(env, deps);
    expect(deps.find).toHaveBeenCalledTimes(1); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('cancels expired uncertain forecasts instead of mailing old information', async () => {
    const { snapshot } = await pending(); snapshot.active_watch!.expires_at = new Date(Date.now() - 1000).toISOString();
    const deps = dependencies(snapshot); await runMonitor(env, deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT status FROM notifications').first<{status:string}>())!.status).toBe('cancelled');
  });
  it('leaves deduplication state untouched on invalid upstream data', async () => {
    const deps = dependencies(); deps.fetchStatus.mockRejectedValue(new Error('invalid API'));
    await expect(runMonitor(env, deps)).rejects.toThrow(); expect(deps.send).not.toHaveBeenCalled();
    expect((await new Store(env.DB).state()).initialized).toBe(false);
  });
  it('commits neither the result nor markers if the state trigger fails', async () => {
    const { row } = await pending();
    await env.DB.exec("CREATE TRIGGER test_fail BEFORE UPDATE OF state_json ON monitor BEGIN SELECT RAISE(ABORT, 'simulated'); END;");
    try {
      const store = new Store(env.DB); await store.acquire(); await expect(store.complete(row)).rejects.toThrow();
      expect((await env.DB.prepare('SELECT status FROM notifications WHERE event_id = ?').bind(row.event_id).first<NotificationRow>())!.status).toBe('uncertain');
      const state = parseState(JSON.parse((await env.DB.prepare('SELECT state_json FROM monitor').first<{state_json:string}>())!.state_json));
      expect(state.active_watch_fingerprint).toBeNull();
    } finally { await env.DB.exec('DROP TRIGGER test_fail;'); }
  });
});
