import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } }
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM auth_attempts'),
    env.DB.prepare('UPDATE admin_auth SET password_hash = NULL, version = 0, updated_at = NULL WHERE id = 1'),
    env.DB.prepare('DELETE FROM notifications'),
    env.DB.prepare('UPDATE monitor SET state_json = ?, lease_token = NULL, lease_until = 0, last_checked_at = NULL, last_result = NULL WHERE id = 1')
      .bind(JSON.stringify({ version: 1, initialized: false, notified_reset_id: null, active_watch_fingerprint: null, state_updated_at: null })),
  ]);
});
