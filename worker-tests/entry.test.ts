import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../worker/index';

describe('Worker HTTP entry', () => {
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
});
