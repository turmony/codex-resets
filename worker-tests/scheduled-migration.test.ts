import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Store } from '../worker/store';

it('preserves every legacy delivery state and the completion trigger when adding scheduled notifications', async () => {
  const original = env.TEST_MIGRATIONS.find(m => m.name === '0001_monitor.sql')!;
  const migration = env.TEST_MIGRATIONS.find(m => m.name === '0003_scheduled_notifications.sql')!;
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER notification_completed'),
    env.DB.prepare('DROP TABLE notifications'),
    ...original.queries.filter(sql => /CREATE TABLE notifications|CREATE INDEX notifications_recovery|CREATE TRIGGER notification_completed/.test(sql))
      .map(sql => env.DB.prepare(sql)),
  ]);
  const statuses = ['pending', 'sending', 'uncertain', 'accepted', 'sent', 'cancelled'];
  await env.DB.batch(statuses.map((status, i) => env.DB.prepare(
    'INSERT INTO notifications (event_id, kind, status, payload_json, created_at, attempted_at, completed_at, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('legacy-' + i, i % 2 ? 'reset' : 'forecast', status,
    '{"patch":{"notified_reset_id":"legacy-reset"}}', '2026-10-01T00:00:00Z',
    '2026-10-01T00:01:00Z', status === 'sent' ? '2026-10-01T00:02:00Z' : null, i, 'legacy-error')));
  const beforeRows = (await env.DB.prepare('SELECT * FROM notifications ORDER BY event_id').all()).results;
  const beforeState = await new Store(env.DB).state();

  await env.DB.batch(migration.queries.map(sql => env.DB.prepare(sql)));

  expect((await env.DB.prepare('SELECT * FROM notifications ORDER BY event_id').all()).results).toEqual(beforeRows);
  expect(await new Store(env.DB).state()).toEqual(beforeState);
  await env.DB.prepare("UPDATE notifications SET status = 'sent', completed_at = '2026-10-02T00:00:00Z' WHERE event_id = 'legacy-3'").run();
  expect(await new Store(env.DB).state()).toMatchObject({ notified_reset_id: 'legacy-reset', state_updated_at: '2026-10-02T00:00:00Z' });
  await env.DB.prepare("INSERT INTO notifications (event_id, kind, status, payload_json, created_at) VALUES ('new-plan', 'scheduled', 'pending', '{\"patch\":{}}', '2026-10-02T00:00:00Z')").run();
  await env.DB.prepare("UPDATE notifications SET status = 'sent', completed_at = '2026-10-02T00:01:00Z' WHERE event_id = 'new-plan'").run();
  expect(await new Store(env.DB).state()).toMatchObject({ notified_reset_id: 'legacy-reset', initialized: false, active_watch_fingerprint: null });
});
