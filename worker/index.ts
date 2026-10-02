import { timingSafeEqual } from 'node:crypto';
import { runMonitor } from './monitor';
import { validateMail } from './emailer';
import { html, css, js } from './page';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function health(env: Env) {
  let configured = true;
  try { validateMail(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE); } catch { configured = false; }
  return { service: 'codex-resets-monitor', schedule: '30 1-22/3 * * *', enabled: env.MONITOR_ENABLED === 'true', configured };
}

function nextScheduledAt(now: number): string {
  // UTC 01:30, 04:30, ..., 22:30; the next planned slot, not a delivery guarantee.
  const interval = 3 * 60 * 60 * 1000, offset = 90 * 60 * 1000;
  return new Date((Math.floor((now - offset) / interval) + 1) * interval + offset).toISOString();
}

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token || !request.headers.get('Authorization')?.startsWith('Bearer ')) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization')!.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers });
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (['/', '/app.css', '/app.js'].includes(path)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
      const content = path === '/' ? html : path === '/app.css' ? css : js;
      const type = path === '/' ? 'text/html' : path === '/app.css' ? 'text/css' : 'text/javascript';
      return new Response(request.method === 'HEAD' ? null : content, { headers: { ...headers, 'Content-Type': type + '; charset=utf-8' } });
    }
    if (path === '/health' && request.method === 'GET') {
      return json(health(env));
    }
    if (!['/status', '/check', '/verify-mail'].includes(path)) return json({ error: 'not found' }, 404);
    if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'GET' && request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'cross-site operation denied' }, 403);
    try {
      if (path === '/status' && request.method === 'GET') {
        const db = env.DB.withSession('first-primary');
        const monitor = await db.prepare('SELECT state_json, last_checked_at, last_result FROM monitor WHERE id = 1').first();
        const pending = await db.prepare("SELECT kind, status, COUNT(*) AS count FROM notifications WHERE status NOT IN ('sent','cancelled') GROUP BY kind, status").all();
        const recent = await db.prepare('SELECT kind, status, created_at, attempted_at, completed_at, attempts, last_error FROM notifications ORDER BY created_at DESC, event_id DESC LIMIT 20').all();
        return json({ monitor, pending: pending.results, recent: recent.results, health: health(env), next_scheduled_at: nextScheduledAt(Date.now()) });
      }
      if (path === '/check' && request.method === 'POST') return json(await runMonitor(env));
      if (path === '/verify-mail' && request.method === 'POST') {
        // Does not send an email. It checks TLS, login, folder enumeration and search.
        const { findReceived } = await import('./imap');
        const { verifySMTP } = await import('./smtp');
        const { sha256 } = await import('./domain');
        const signal = AbortSignal.timeout(60000);
        await verifySMTP(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE, signal);
        await findReceived(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE, await sha256('verification:' + crypto.randomUUID()), signal);
        return json({ smtp: 'ok', imap: 'ok' });
      }
      return json({ error: 'method not allowed' }, 405);
    } catch {
      console.error(JSON.stringify({ event: 'request_failed', path }));
      return json({ error: 'operation failed; check Worker logs and service configuration' }, 503);
    }
  },
  async scheduled(_controller, env): Promise<void> {
    try {
      const result = await runMonitor(env);
      console.log(JSON.stringify({ event: 'monitor_check', ...result }));
      if (result.result === 'partial' || result.result === 'unconfigured') throw new Error('monitor check incomplete');
    } catch {
      console.error(JSON.stringify({ event: 'monitor_failed' }));
      throw new Error('monitor check failed');
    }
  },
} satisfies ExportedHandler<Env>;
