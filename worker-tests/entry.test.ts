import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';

describe('Worker HTTP entry', () => {
  it('serves a public dashboard and separate assets without embedding secrets', async () => {
    const testEnv = { ...env, ADMIN_TOKEN: 'private-admin-fixture', MAIL_EMAIL: 'private-mail@126.com', MAIL_SMTP_AUTH_CODE: 'private-smtp-fixture' };
    for (const [path, type] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const response = await worker.fetch(new Request('https://monitor.test' + path), testEnv);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain(type);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      const body = await response.text();
      for (const secret of [testEnv.ADMIN_TOKEN, testEnv.MAIL_EMAIL, testEnv.MAIL_SMTP_AUTH_CODE]) expect(body).not.toContain(secret);
      if (path === '/') expect(body).toContain('Codex Resets 邮件监控');
    }
  });
  it('supports HEAD for the dashboard and refuses writes to page routes', async () => {
    const head = await worker.fetch(new Request('https://monitor.test/', { method: 'HEAD' }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await worker.fetch(new Request('https://monitor.test/', { method: 'POST' }), env);
    expect(post.status).toBe(405);
  });
  it('exposes only a minimal public health response', async () => {
    const response = await worker.fetch(new Request('https://monitor.test/health'), env);
    expect(response.status).toBe(200);
    const data = await response.json(); expect(data).toMatchObject({ schedule: '30 1-22/3 * * *' });
    expect(JSON.stringify(data)).not.toContain('state_json');
  });
  it('reports paused monitoring and invalid mail configuration accurately', async () => {
    const testEnv = { ...env, MONITOR_ENABLED: 'false', MAIL_EMAIL: 'invalid', MAIL_SMTP_AUTH_CODE: 'fixture' };
    const response = await worker.fetch(new Request('https://monitor.test/health'), testEnv);
    expect(await response.json()).toMatchObject({ enabled: false, configured: false });
  });
  it('requires authentication before manual checks, status, or mail verification', async () => {
    for (const path of ['/check', '/status', '/verify-mail']) {
      const response = await worker.fetch(new Request('https://monitor.test' + path, { method: 'POST' }), env);
      expect(response.status).toBe(401);
    }
  });
  it('rejects an incorrect admin bearer without starting work', async () => {
    const testEnv = { ...env, ADMIN_TOKEN: 'private-test-admin-token' };
    const response = await worker.fetch(new Request('https://monitor.test/check', { method: 'POST', headers: { Authorization: 'Bearer incorrect' } }), testEnv);
    expect(response.status).toBe(401);
  });
  it('reads D1 status with a valid admin bearer', async () => {
    const token = 'private-test-admin-token', testEnv = { ...env, ADMIN_TOKEN: token };
    const response = await worker.fetch(new Request('https://monitor.test/status', { headers: { Authorization: 'Bearer ' + token } }), testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('pending');
  });
  it('bounds authenticated notification history and excludes mail payloads', async () => {
    const token = 'private-test-admin-token', testEnv = { ...env, ADMIN_TOKEN: token };
    await env.DB.batch(Array.from({ length: 22 }, (_, i) => env.DB.prepare(
      'INSERT INTO notifications (event_id, kind, status, payload_json, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('event-' + i, 'forecast', i < 2 ? 'pending' : 'sent', '{"secret_content":"private-email-body"}', new Date(Date.UTC(2026, 9, 1, i)).toISOString(), i)));
    const response = await worker.fetch(new Request('https://monitor.test/status', { headers: { Authorization: 'Bearer ' + token } }), testEnv);
    const raw = await response.text();
    const data = JSON.parse(raw);
    expect(data.recent).toHaveLength(20);
    expect(data.recent[0].attempts).toBe(21);
    expect(data.recent[19].attempts).toBe(2);
    expect(data.pending).toEqual([{ kind: 'forecast', status: 'pending', count: 2 }]);
    expect(data.health).toMatchObject({ enabled: true, schedule: '30 1-22/3 * * *' });
    for (const privateField of ['payload_json', 'secret_content', 'private-email-body', 'event_id', token]) expect(raw).not.toContain(privateField);
  });
  it('reports the next cron slot across UTC midnight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T22:30:00Z'));
    try {
      const response = await worker.fetch(new Request('https://monitor.test/status', { headers: { Authorization: 'Bearer private-test-admin-token' } }), { ...env, ADMIN_TOKEN: 'private-test-admin-token' });
      expect(await response.json()).toMatchObject({ next_scheduled_at: '2026-10-03T01:30:00.000Z' });
    } finally { clock.mockRestore(); }
  });
  it('rejects cross-site admin operations before starting work', async () => {
    const token = 'private-test-admin-token', testEnv = { ...env, ADMIN_TOKEN: token };
    for (const path of ['/check', '/verify-mail']) {
      const response = await worker.fetch(new Request('https://monitor.test' + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://untrusted.test' },
      }), testEnv);
      expect(response.status).toBe(403);
    }
  });
});
