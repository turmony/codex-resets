import { readFile } from 'node:fs/promises';

const [action = 'status'] = process.argv.slice(2);
if (!['status','check','verify-mail'].includes(action)) throw new Error('Usage: npm run admin -- status|check|verify-mail');
const base = process.env.MONITOR_URL || 'https://codex-resets-monitor.turmony.workers.dev';
const origin = new URL(base).origin;
const authStatus = await fetch(`${base}/auth/status`, { signal: AbortSignal.timeout(15000) });
if (!authStatus.ok) throw new Error('Cannot read authentication status');
const headers = { Origin: origin };
if ((await authStatus.json()).password_set) {
  const password = process.env.ADMIN_PASSWORD || await readFile('.wrangler/admin-password', 'utf8')
    .then(value => value.replace(/\r?\n$/, ''))
    .catch(() => { throw new Error('Provide ADMIN_PASSWORD or the ignored .wrangler/admin-password file. The recovery code cannot access monitoring after password setup.'); });
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(15000),
  });
  if (!login.ok) throw new Error('Login failed: ' + (await login.json()).error);
  const cookie = login.headers.get('Set-Cookie');
  if (!cookie) throw new Error('Login returned no session');
  headers.Cookie = cookie.split(';')[0];
} else {
  // Compatibility during the owner's first-password setup only.
  const token = process.env.ADMIN_TOKEN || (await readFile('.wrangler/admin-token', 'utf8')).trim();
  headers.Authorization = `Bearer ${token}`;
}
try {
  const response = await fetch(`${base}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', headers, signal: AbortSignal.timeout(200000),
  });
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
} finally {
  if (headers.Cookie) {
    try {
      const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
      if (!logout.ok) throw new Error('logout rejected');
    } catch {
      console.error('Could not revoke this CLI session; it will expire within 12 hours.');
      process.exitCode = 1;
    }
  }
}
