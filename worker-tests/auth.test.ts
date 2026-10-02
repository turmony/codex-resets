import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { Auth, AuthError } from '../worker/auth';

const code = 'private-recovery-code-fixture';
const password = '密码测试六位';
const newPassword = 'new123';
const testEnv = { ...env, ADMIN_TOKEN: code, MONITOR_ENABLED: 'false' };
const origin = 'https://monitor.test';
function request(path: string, body?: unknown, cookie?: string, extra: HeadersInit = {}) {
  return new Request<unknown, IncomingRequestCfProperties>(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function post(path: string, body: unknown, cookie?: string) { return worker.fetch(request(path, body, cookie), testEnv); }
function cookie(response: Response): string { return response.headers.get('Set-Cookie')!.split(';')[0]; }
async function login(): Promise<Response> { return post('/auth/login', { password }); }
async function setup(): Promise<void> { await new Auth(testEnv).setup(password, code); }

describe('password authentication and recovery', () => {
  it('requires the recovery code to set the first password and forbids setup afterwards', async () => {
    const before = await worker.fetch(request('/auth/status'), testEnv);
    expect(await before.json()).toEqual({ password_set: false, authenticated: false });
    expect((await post('/auth/setup', { newPassword: password, recoveryCode: 'wrong' })).status).toBe(401);
    expect((await post('/auth/setup', { newPassword: 'short', recoveryCode: code })).status).toBe(400);
    expect((await post('/auth/setup', { newPassword: password, recoveryCode: code })).status).toBe(200);
    expect((await post('/auth/setup', { newPassword, recoveryCode: code })).status).toBe(409);
    const state = await worker.fetch(request('/auth/status'), testEnv);
    expect(await state.json()).toEqual({ password_set: true, authenticated: false });
    const row = await new Auth(testEnv).row();
    expect(row.password_hash).toMatch(/^pbkdf2-sha256-hmac-v1:/);
    expect(row.password_hash).not.toContain(password);
    expect(row.password_hash).not.toContain(code);
  });
  it('authenticates a salted verifier and issues an opaque secure cookie stored only as a hash', async () => {
    await setup();
    expect((await post('/auth/login', { password: 'incorrect-password' })).status).toBe(401);
    const result = await login();
    expect(result.status).toBe(200);
    const value = result.headers.get('Set-Cookie')!;
    for (const attribute of ['__Host-monitor-session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) expect(value).toContain(attribute);
    const session = cookie(result);
    const rows = await env.DB.prepare('SELECT * FROM admin_sessions').all();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain(session.split('=')[1]);
    const status = await worker.fetch(request('/status', undefined, session), testEnv);
    expect(status.status).toBe(200);
    const raw = await status.text();
    for (const secret of [password, code, 'password_hash', 'token_hash']) expect(raw).not.toContain(secret);
    expect(await (await worker.fetch(request('/auth/status', undefined, session), testEnv)).json()).toEqual({ password_set: true, authenticated: true });
    // Ordinary bearer access is retired after the password is set.
    expect((await worker.fetch(request('/status', undefined, undefined, { Authorization: 'Bearer ' + code }), testEnv)).status).toBe(401);
  });
  it('requires the current password for changes and invalidates every existing session atomically', async () => {
    await setup();
    const session1 = cookie(await login()), session2 = cookie(await login());
    expect((await post('/auth/password', { currentPassword: 'wrong', newPassword }, session1)).status).toBe(400);
    expect((await worker.fetch(request('/status', undefined, session1), testEnv)).status).toBe(200);
    const result = await post('/auth/password', { currentPassword: password, newPassword }, session1);
    expect(result.status).toBe(200);
    expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first<{ n: number }>())!.n).toBe(0);
    for (const session of [session1, session2]) expect((await worker.fetch(request('/status', undefined, session), testEnv)).status).toBe(401);
    expect((await login()).status).toBe(401);
    expect((await post('/auth/login', { password: newPassword })).status).toBe(200);
  });
  it('resets a forgotten password using the recovery code without an active session', async () => {
    await setup();
    const session = cookie(await login());
    const marker = JSON.stringify({ version: 1, initialized: true, notified_reset_id: 'preserved-reset', active_watch_fingerprint: 'preserved-watch', state_updated_at: '2026-10-01T00:00:00Z' });
    await env.DB.prepare('UPDATE monitor SET state_json = ? WHERE id = 1').bind(marker).run();
    expect((await post('/auth/reset', { recoveryCode: 'wrong', newPassword })).status).toBe(401);
    expect((await post('/auth/reset', { recoveryCode: code, newPassword })).status).toBe(200);
    expect((await worker.fetch(request('/status', undefined, session), testEnv)).status).toBe(401);
    expect((await login()).status).toBe(401);
    expect((await post('/auth/login', { password: newPassword })).status).toBe(200);
    expect((await env.DB.prepare('SELECT state_json FROM monitor WHERE id = 1').first<{ state_json: string }>())!.state_json).toBe(marker);
  });
  it('rejects forged and expired cookies and revokes the session on logout', async () => {
    await setup();
    const session1 = cookie(await login()), session2 = cookie(await login());
    expect((await worker.fetch(request('/status', undefined, '__Host-monitor-session=' + 'f'.repeat(64)), testEnv)).status).toBe(401);
    const result = await post('/auth/logout', {}, session1);
    expect(result.status).toBe(200);
    expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await worker.fetch(request('/status', undefined, session1), testEnv)).status).toBe(401);
    expect((await worker.fetch(request('/status', undefined, session2), testEnv)).status).toBe(200);
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ?').bind(Date.now() - 1).run();
    expect((await worker.fetch(request('/status', undefined, session2), testEnv)).status).toBe(401);
  });
  it('blocks cross-site login and cookie-authenticated writes before execution', async () => {
    await setup();
    const crossSite = request('/auth/login', { password }, undefined, { Origin: 'https://untrusted.test' });
    expect((await worker.fetch(crossSite, testEnv)).status).toBe(403);
    const noOrigin = request('/auth/login', { password }); noOrigin.headers.delete('Origin');
    expect((await worker.fetch(noOrigin, testEnv)).status).toBe(403);
    const session = cookie(await login());
    const check = request('/check', {}, session); check.headers.delete('Origin');
    expect((await worker.fetch(check, testEnv)).status).toBe(403);
    expect((await worker.fetch(request('/check', {}, session), testEnv)).status).toBe(200);
    expect((await worker.fetch(request('/auth/password', { currentPassword: password, newPassword }), testEnv)).status).toBe(401);
  });
  it('bounds and validates authentication request bodies', async () => {
    for (const [body, type, status] of [
      ['x'.repeat(4097), 'application/json', 413],
      ['{broken', 'application/json', 400],
      ['[]', 'application/json', 400],
      ['null', 'application/json', 400],
      ['{}', 'text/plain', 400],
    ] as const) {
      const response = await worker.fetch(new Request(origin + '/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body }), testEnv);
      expect(response.status).toBe(status);
    }
  });
  it('limits password guessing persistently before deriving a verifier', async () => {
    await setup();
    for (let i = 0; i < 10; i++) expect((await post('/auth/login', { password: 'wrong-password' })).status).toBe(401);
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('900');
    await env.DB.prepare('UPDATE auth_attempts SET expires_at = ?').bind(Date.now() - 1).run();
    expect((await login()).status).toBe(200);
  });
  it('caps distributed authentication attempts and the number of per-IP limiter rows', async () => {
    for (let i = 0; i < 60; i++) {
      const response = await worker.fetch(request('/auth/login', { password }, undefined, { 'CF-Connecting-IP': '192.0.2.' + i }), testEnv);
      expect(response.status).toBe(409); // Uninitialized account, no password hash work.
    }
    const limited = await worker.fetch(request('/auth/login', { password }, undefined, { 'CF-Connecting-IP': '192.0.2.100' }), testEnv);
    expect(limited.status).toBe(429);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first<{ n: number }>())!.n).toBe(61);
  });
  it('allows only one concurrent first-password setup', async () => {
    const first = new Auth(testEnv), second = new Auth(testEnv);
    const results = await Promise.allSettled([first.setup(password, code), second.setup(newPassword, code)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(AuthError);
    expect(failed.reason.status).toBe(409);
    expect((await new Auth(testEnv).row()).version).toBe(1);
  });
  it('does not create a session if the password is reset during login', async () => {
    await setup();
    const auth = new Auth(testEnv);
    const gate = vi.spyOn(auth, 'session').mockImplementation(async () => {
      await new Auth(testEnv).reset(newPassword, code);
      return null;
    });
    try {
      await expect(auth.login(password, request('/auth/login', { password }))).rejects.toMatchObject({ status: 401 });
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first<{ n: number }>())!.n).toBe(0);
    } finally { gate.mockRestore(); }
  });
  it('rolls back a password change if session invalidation cannot commit', async () => {
    await setup();
    const session = cookie(await login()), before = await new Auth(testEnv).row();
    await env.DB.prepare("CREATE TRIGGER test_revoke_failure BEFORE DELETE ON admin_sessions BEGIN SELECT RAISE(ABORT, 'fixture revocation failure'); END").run();
    try {
      await expect(new Auth(testEnv).reset(newPassword, code)).rejects.toThrow();
      expect(await new Auth(testEnv).row()).toEqual(before);
      expect((await worker.fetch(request('/status', undefined, session), testEnv)).status).toBe(200);
    } finally { await env.DB.prepare('DROP TRIGGER test_revoke_failure').run(); }
  });
  it('rejects old verifiers after recovery secret rotation and restores access via the new code', async () => {
    await setup();
    const rotated = { ...testEnv, ADMIN_TOKEN: 'rotated-recovery-code-fixture' };
    expect((await worker.fetch(request('/auth/login', { password }), rotated)).status).toBe(401);
    await new Auth(rotated).reset(newPassword, rotated.ADMIN_TOKEN);
    expect((await worker.fetch(request('/auth/login', { password: newPassword }), rotated)).status).toBe(200);
  });
});
