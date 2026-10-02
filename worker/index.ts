import { runMonitor } from './monitor';
import { validateMail } from './emailer';
import { html, css, js } from './page';
import { Auth, AuthError, authBody, matchesSecret, sessionCookie, clearCookie } from './auth';

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

function json(value: unknown, status = 200, cookie?: string): Response {
  return Response.json(value, { status, headers: { ...headers, ...(cookie ? { 'Set-Cookie': cookie } : {}), ...(status === 429 ? { 'Retry-After': '900' } : {}) } });
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
    const authPaths = ['/auth/status', '/auth/setup', '/auth/login', '/auth/logout', '/auth/password', '/auth/reset'];
    if (![...authPaths, '/status', '/check', '/verify-mail'].includes(path)) return json({ error: 'not found' }, 404);
    try {
      const auth = new Auth(env);
      if (authPaths.includes(path)) {
        if (path === '/auth/status' && request.method === 'GET') {
          return json({ password_set: !!(await auth.row()).password_hash, authenticated: !!await auth.session(request) });
        }
        if (path === '/auth/status' || request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (request.headers.get('Origin') !== url.origin) return json({ error: '拒绝跨站操作，请在本项目页面操作。' }, 403);
        if (path === '/auth/logout') {
          await auth.logout(request);
          return json({ message: '已退出登录。' }, 200, clearCookie());
        }
        const current = path === '/auth/password' ? await auth.session(request) : null;
        if (path === '/auth/password' && !current) return json({ error: '登录已失效，请重新登录。' }, 401, clearCookie());
        await auth.limit(request);
        const body = await authBody(request);
        if (path === '/auth/login') return json({ message: '登录成功。' }, 200, sessionCookie(await auth.login(body.password, request)));
        if (path === '/auth/setup') {
          await auth.setup(body.newPassword, body.recoveryCode);
          return json({ message: '密码已设置，请使用新密码登录。' }, 200, clearCookie());
        }
        if (path === '/auth/password') {
          await auth.change(body.currentPassword, body.newPassword, current!);
          return json({ message: '密码已修改，所有会话已退出，请使用新密码登录。' }, 200, clearCookie());
        }
        await auth.reset(body.newPassword, body.recoveryCode);
        return json({ message: '密码已重置，所有会话已退出，请使用新密码登录。' }, 200, clearCookie());
      }
      const current = await auth.session(request);
      // Transitional CLI access ends as soon as the owner sets a password.
      const bearer = request.headers.get('Authorization');
      const bootstrap = !current && bearer?.startsWith('Bearer ') && !(await auth.row()).password_hash && await matchesSecret(bearer.slice(7), env.ADMIN_TOKEN);
      if (!current && !bootstrap) return json({ error: '登录已失效，请重新登录。' }, 401, clearCookie());
      if (request.method !== 'GET' && (current ? request.headers.get('Origin') !== url.origin : request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)) {
        return json({ error: 'cross-site operation denied' }, 403);
      }
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
    } catch (error) {
      if (error instanceof AuthError) return json({ error: error.message }, error.status);
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
