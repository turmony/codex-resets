import { timingSafeEqual } from 'node:crypto';
import { runMonitor } from './monitor';
import { validateMail } from './emailer';

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
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') {
      let configured = true;
      try { validateMail(env.MAIL_EMAIL, env.MAIL_SMTP_AUTH_CODE); } catch { configured = false; }
      return json({ service: 'codex-resets-monitor', schedule: '30 1-22/3 * * *', enabled: env.MONITOR_ENABLED === 'true', configured });
    }
    if (!['/status', '/check', '/verify-mail'].includes(path)) return json({ error: 'not found' }, 404);
    if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
    try {
      if (path === '/status' && request.method === 'GET') {
        const db = env.DB.withSession('first-primary');
        const monitor = await db.prepare('SELECT state_json, last_checked_at, last_result FROM monitor WHERE id = 1').first();
        const pending = await db.prepare("SELECT kind, status, COUNT(*) AS count FROM notifications WHERE status NOT IN ('sent','cancelled') GROUP BY kind, status").all();
        return json({ monitor, pending: pending.results });
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
