import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { parseStatus } from '../worker/domain';
import { runMonitor } from '../worker/monitor';
import { Store, type NotificationRow } from '../worker/store';
import { SMTPDeliveryError } from '../worker/smtp';
import { dependencies, payload } from './fixtures';

function scheduledPayload(overrides: Record<string, unknown> = {}) {
  const raw = payload();
  return { ...raw, data: { ...raw.data, active_watch: null, scheduled_reset: {
    id: 'scheduled-1', status: 'scheduled', reset_type: 'regular',
    announced_at: '2026-10-02T02:14:51Z', scheduled_for: '2026-10-02T17:00:00Z',
    text: 'Global reset landing tomorrow 10am PST for all paid ChatGPT accounts.',
    source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/scheduled-1' },
    ...overrides,
  } } };
}
function scheduledStatus(overrides: Record<string, unknown> = {}) {
  return parseStatus(scheduledPayload(overrides));
}
async function initialized() {
  await env.DB.prepare("UPDATE monitor SET state_json = json_set(state_json, '$.initialized', json('true'), '$.notified_reset_id', 'reset-1') WHERE id = 1").run();
}
async function rows() {
  return (await env.DB.prepare('SELECT * FROM notifications ORDER BY rowid').all<NotificationRow>()).results;
}
async function uncertain() {
  await initialized();
  const deps = dependencies(scheduledStatus());
  deps.send.mockRejectedValue(new SMTPDeliveryError(true));
  expect(await runMonitor(env, deps)).toMatchObject({ failed: 1 });
  await env.DB.prepare("UPDATE notifications SET attempted_at = ? WHERE kind = 'scheduled'")
    .bind(new Date(Date.now() - 3600000).toISOString()).run();
}

describe('scheduled reset notifications', () => {
  it('preserves the explicit announcement and normalizes its timestamps', () => {
    expect(scheduledStatus()).toMatchObject({ scheduled_reset: {
      id: 'scheduled-1', status: 'scheduled', scheduled_for: '2026-10-02T17:00:00Z',
    } });
    expect(scheduledStatus({ scheduled_for: null })).toMatchObject({ scheduled_reset: { scheduled_for: null } });
  });
  it.each([
    { status: 'completed' }, { reset_type: 'unknown' }, { id: '' },
    { announced_at: 'invalid' }, { scheduled_for: 'invalid' },
    { source: { type: 'unknown' } },
  ])('rejects malformed scheduled announcements: %j', overrides => {
    expect(() => scheduledStatus(overrides)).toThrow();
  });
  it('accepts null or absent scheduled data for legacy snapshots', () => {
    const raw = payload();
    expect(parseStatus(raw)).toMatchObject({ scheduled_reset: null });
    expect(parseStatus({ ...raw, data: { ...raw.data, scheduled_reset: null } })).toMatchObject({ scheduled_reset: null });
  });
  it('sends a scheduled announcement once without changing executed-reset markers', async () => {
    await initialized();
    const deps = dependencies(scheduledStatus());
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 1, failed: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({ kind: 'scheduled', status: 'sent', attempts: 1 });
    const content = JSON.parse(row.payload_json).content;
    expect(content.subject).toBe('[Codex Resets] 重置计划已公布');
    expect(content.body).toContain('2026-10-03 01:00:00 北京时间');
    expect(content.body).toContain('2026-10-02 17:00:00 UTC');
    expect(content.body).toContain('https://x.com/thsottiaux/status/scheduled-1');
    expect(await new Store(env.DB).state()).toMatchObject({ notified_reset_id: 'reset-1', active_watch_fingerprint: null });
    deps.fetchStatus.mockResolvedValue({ ...scheduledStatus(), generated_at: new Date().toISOString() });
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 0 });
    expect(await rows()).toHaveLength(1);
  });
  it.each([
    { scheduled_for: '2026-10-02T18:00:00Z' }, { text: 'The announced plan has changed.' },
  ])('notifies a meaningful plan update: %j', async overrides => {
    await initialized();
    await runMonitor(env, dependencies(scheduledStatus()));
    expect(await runMonitor(env, dependencies(scheduledStatus(overrides)))).toMatchObject({ sent: 1 });
    const notifications = await rows();
    expect(notifications).toHaveLength(2);
    expect(JSON.parse(notifications[1].payload_json).content.subject).toBe('[Codex Resets] 重置计划已更新');
  });
  it('does not label a different announcement as an update', async () => {
    await initialized();
    await runMonitor(env, dependencies(scheduledStatus()));
    await runMonitor(env, dependencies(scheduledStatus({ id: 'scheduled-2' })));
    expect(JSON.parse((await rows())[1].payload_json).content.subject).toBe('[Codex Resets] 重置计划已公布');
  });
  it('does not repeat the same plan when timestamps use an equivalent UTC offset', async () => {
    await initialized();
    await runMonitor(env, dependencies(scheduledStatus()));
    expect(await runMonitor(env, dependencies(scheduledStatus({ scheduled_for: '2026-10-03T01:00:00+08:00' })))).toMatchObject({ sent: 0 });
    expect(await rows()).toHaveLength(1);
  });
  it('sends a plan with an unknown execution time', async () => {
    await initialized();
    expect(await runMonitor(env, dependencies(scheduledStatus({ scheduled_for: null })))).toMatchObject({ sent: 1 });
    expect(JSON.parse((await rows())[0].payload_json).content.body).toContain('计划时间：尚未明确');
  });
  it('keeps a past-due plan pending confirmation instead of expiring or completing it', async () => {
    await initialized();
    expect(await runMonitor(env, dependencies(scheduledStatus({ scheduled_for: '2020-01-01T00:00:00Z' })))).toMatchObject({ sent: 1 });
    const [row] = await rows();
    expect(JSON.parse(row.payload_json)).toMatchObject({ expiresAt: null });
    expect(JSON.parse(row.payload_json).content.body).toContain('计划时间已过，仍等待实际完成确认');
    expect(await new Store(env.DB).state()).toMatchObject({ notified_reset_id: 'reset-1' });
  });
  it('notifies execution separately even when the announcement ID is unchanged', async () => {
    await initialized();
    await runMonitor(env, dependencies(scheduledStatus()));
    const status = scheduledStatus();
    status.latest_reset = { ...status.latest_reset!, id: 'scheduled-1' };
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 1 });
    expect((await rows()).map(row => row.kind)).toEqual(['scheduled', 'reset']);
    expect(await new Store(env.DB).state()).toMatchObject({ notified_reset_id: 'scheduled-1' });
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 0 });
  });
  it('sends only execution when the first snapshot already confirms the scheduled announcement', async () => {
    await initialized();
    const status = scheduledStatus(); status.latest_reset = { ...status.latest_reset!, id: 'scheduled-1' };
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 1 });
    expect((await rows()).map(row => row.kind)).toEqual(['reset']);
  });
  it('records a plan on first activation without repeating it on the next check', async () => {
    expect(await runMonitor(env, dependencies(scheduledStatus()))).toMatchObject({ sent: 2 });
    expect((await rows()).map(row => row.kind)).toEqual(['activation', 'scheduled']);
    expect(await runMonitor(env, dependencies(scheduledStatus()))).toMatchObject({ sent: 0 });
  });
  it('defers the first plan until activation commits so later execution is notified separately', async () => {
    const deps = dependencies(scheduledStatus());
    deps.send.mockImplementation(async row => { if (row.kind === 'activation') throw new SMTPDeliveryError(false); });
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 0, failed: 1, deferred: 1 });
    expect((await rows()).map(row => row.kind)).toEqual(['activation']);
    expect(await new Store(env.DB).state()).toMatchObject({ initialized: false });
    deps.send.mockResolvedValue();
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 2 });
    const status = scheduledStatus(); status.latest_reset = { ...status.latest_reset!, id: 'scheduled-1' };
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 1 });
    expect((await rows()).map(row => row.kind)).toEqual(['activation', 'scheduled', 'reset']);
  });
  it('retries a definite submission failure through the same queued event', async () => {
    await initialized();
    const deps = dependencies(scheduledStatus());
    deps.send.mockRejectedValueOnce(new SMTPDeliveryError(false));
    expect(await runMonitor(env, deps)).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 1 });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });
  it('reconciles received uncertain mail without resubmitting it', async () => {
    await uncertain();
    const deps = dependencies(scheduledStatus()); deps.find.mockResolvedValue(true);
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 0, deferred: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });
  it('retries missing uncertain mail after delivery grace', async () => {
    await uncertain();
    expect(await runMonitor(env, dependencies(scheduledStatus()))).toMatchObject({ sent: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });
  it('waits for delivery grace before resubmitting an uncertain plan', async () => {
    await uncertain();
    await env.DB.prepare("UPDATE notifications SET attempted_at = ? WHERE kind = 'scheduled'").bind(new Date().toISOString()).run();
    expect(await runMonitor(env, dependencies(scheduledStatus()))).toMatchObject({ sent: 0, deferred: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'uncertain', attempts: 1 });
  });
  it('defers uncertain mail when IMAP cannot establish the outcome', async () => {
    await uncertain();
    const deps = dependencies(scheduledStatus()); deps.find.mockRejectedValue(new Error('IMAP unavailable'));
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 0, deferred: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'uncertain', attempts: 1 });
  });
  it('cancels a superseded uncertain plan after reconciliation and sends the current plan', async () => {
    await uncertain();
    expect(await runMonitor(env, dependencies(scheduledStatus({ scheduled_for: '2026-10-02T18:00:00Z' })))).toMatchObject({ sent: 1 });
    expect((await rows()).map(row => row.status)).toEqual(['cancelled', 'sent']);
  });
  it('labels the current plan as an update after finding the previous revision in IMAP', async () => {
    await uncertain();
    const deps = dependencies(scheduledStatus({ scheduled_for: '2026-10-02T18:00:00Z' })); deps.find.mockResolvedValue(true);
    expect(await runMonitor(env, deps)).toMatchObject({ sent: 1 });
    const notifications = await rows();
    expect(notifications.map(row => row.status)).toEqual(['sent', 'sent']);
    expect(JSON.parse(notifications[1].payload_json).content.subject).toBe('[Codex Resets] 重置计划已更新');
  });
  it('cancels a withdrawn uncertain plan after IMAP confirms no matching mail', async () => {
    await uncertain();
    const status = scheduledStatus(); status.scheduled_reset = null;
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'cancelled', attempts: 1 });
  });
  it('cancels a withdrawn pending plan without resubmitting it', async () => {
    await initialized();
    const deps = dependencies(scheduledStatus()); deps.send.mockRejectedValue(new SMTPDeliveryError(false));
    await runMonitor(env, deps);
    const raw = payload();
    const status = parseStatus({ ...raw, data: { ...raw.data, active_watch: null, scheduled_reset: null } });
    expect(await runMonitor(env, dependencies(status))).toMatchObject({ sent: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'cancelled', attempts: 1 });
  });
  it('retries only D1 completion after SMTP has accepted a plan', async () => {
    await initialized();
    const store = new Store(env.DB);
    vi.spyOn(store, 'complete').mockRejectedValue(new Error('D1 unavailable'));
    await expect(runMonitor(env, dependencies(scheduledStatus()), store)).rejects.toThrow();
    expect((await rows())[0]).toMatchObject({ status: 'accepted', attempts: 1 });
    expect(await runMonitor(env, dependencies(scheduledStatus()))).toMatchObject({ sent: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });
});
