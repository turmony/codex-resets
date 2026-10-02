import { timingSafeEqual } from 'node:crypto';
import { sha256 } from './domain';

const COOKIE = '__Host-monitor-session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ITERATIONS = 100000;
const encoder = new TextEncoder();

export class AuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
interface AuthRow { password_hash: string | null; version: number }
export interface Session { tokenHash: string; version: number }

function hex(bytes: Uint8Array): string { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
function randomHex(length: number): string { return hex(crypto.getRandomValues(new Uint8Array(length))); }
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value.match(/../g)!.map(part => parseInt(part, 16)));
}
function password(value: unknown, newPassword = false): string {
  if (typeof value !== 'string' || value.length > 128 || value.length < (newPassword ? 12 : 1)) {
    throw new AuthError(newPassword ? '新密码须为 12–128 个字符，可以使用中文或空格。' : '请输入密码。', 400);
  }
  return value;
}

export async function matchesSecret(value: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(value)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

async function derive(value: string, salt: string, pepper: string): Promise<string> {
  // A server-side HMAC pepper protects D1 password verifiers if D1 alone leaks.
  // Workers caps PBKDF2 iterations at 100,000; never use a fast plain hash.
  const pepperKey = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = await crypto.subtle.sign('HMAC', pepperKey, encoder.encode(value));
  const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: ITERATIONS }, key, 256);
  return hex(new Uint8Array(bits));
}
async function hashPassword(value: string, pepper: string): Promise<string> {
  const salt = randomHex(16);
  return 'pbkdf2-sha256-hmac-v1:' + salt + ':' + await derive(value, salt, pepper);
}
async function verifyPassword(value: string, stored: string, pepper: string): Promise<boolean> {
  const match = /^pbkdf2-sha256-hmac-v1:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(stored);
  if (!match) throw new Error('invalid password verifier');
  const actual = await derive(value, match[1], pepper);
  return timingSafeEqual(fromHex(actual), fromHex(match[2]));
}

/** Bound JSON bodies before parsing; do not buffer arbitrary request streams. */
export async function authBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError('请求必须为 JSON。', 400);
  }
  if (!request.body) throw new AuthError('请求内容为空。', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuthError('请求读取超时。', 408)), 10000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 4096) throw new AuthError('请求内容过大。', 413);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new AuthError('请求内容不是有效 JSON。', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('请求必须为 JSON 对象。', 400);
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
}
export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export class Auth {
  readonly db: D1DatabaseSession;
  constructor(readonly env: Env) { this.db = env.DB.withSession('first-primary'); }
  async row(): Promise<AuthRow> {
    const row = await this.db.prepare('SELECT password_hash, version FROM admin_auth WHERE id = 1').first<AuthRow>();
    if (!row) throw new Error('authentication database not initialized');
    return row;
  }
  private pepper(): string {
    if (!this.env.ADMIN_TOKEN) throw new Error('recovery secret missing');
    return this.env.ADMIN_TOKEN;
  }
  async session(request: Request): Promise<Session | null> {
    const raw = request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
    const tokenHash = await sha256(raw);
    const row = await this.db.prepare('SELECT s.auth_version FROM admin_sessions s JOIN admin_auth a ON a.id = 1 AND a.version = s.auth_version WHERE s.token_hash = ? AND s.expires_at > ?')
      .bind(tokenHash, Date.now()).first<{ auth_version: number }>();
    return row ? { tokenHash, version: row.auth_version } : null;
  }
  async recovery(code: unknown): Promise<void> {
    if (typeof code !== 'string' || code.length > 512 || !await matchesSecret(code, this.env.ADMIN_TOKEN)) {
      throw new AuthError('恢复码无效。', 401);
    }
  }
  async limit(request: Request): Promise<void> {
    const now = Date.now(), period = 15 * 60 * 1000;
    // Count before password hashing. Global bound also limits per-IP row growth.
    const ip = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
    for (const [scope, maximum] of [['global', 60], ['ip:' + ip, 10]] as const) {
      const allowed = await this.db.prepare(`INSERT INTO auth_attempts (scope, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(scope) DO UPDATE SET
          count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
          expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        WHERE expires_at <= ? OR count < ? RETURNING count`)
        .bind(scope, now + period, now, now, now, maximum).first();
      if (!allowed) throw new AuthError('尝试过于频繁，请 15 分钟后再试。', 429);
    }
    await this.db.prepare('DELETE FROM auth_attempts WHERE expires_at <= ?').bind(now).run();
  }
  async setup(value: unknown, code: unknown): Promise<void> {
    await this.recovery(code);
    const valueString = password(value, true), row = await this.row();
    if (row.password_hash) throw new AuthError('密码已设置，请登录或使用重置密码。', 409);
    const hash = await hashPassword(valueString, this.pepper());
    const result = await this.db.prepare('UPDATE admin_auth SET password_hash = ?, version = version + 1, updated_at = ? WHERE id = 1 AND password_hash IS NULL AND version = ?')
      .bind(hash, new Date().toISOString(), row.version).run();
    if (result.meta.changes === 0) throw new AuthError('密码状态已变化，请刷新后重试。', 409);
  }
  async login(value: unknown, request: Request): Promise<string> {
    const valueString = password(value), row = await this.row();
    if (!row.password_hash) throw new AuthError('请先设置登录密码。', 409);
    if (!await verifyPassword(valueString, row.password_hash, this.pepper())) throw new AuthError('密码不正确。', 401);
    const token = randomHex(32), tokenHash = await sha256(token);
    // A concurrent password reset must not mint a session for the old password.
    const statements = [this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(Date.now())];
    const previous = await this.session(request);
    if (previous) statements.push(this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(previous.tokenHash));
    statements.push(this.db.prepare('INSERT INTO admin_sessions (token_hash, auth_version, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND version = ? AND password_hash = ?)')
      .bind(tokenHash, row.version, Date.now() + SESSION_MS, row.version, row.password_hash));
    const result = await this.db.batch(statements);
    if (result.at(-1)!.meta.changes === 0) throw new AuthError('密码状态已变化，请重新登录。', 401);
    return token;
  }
  async logout(request: Request): Promise<void> {
    const current = await this.session(request);
    if (current) await this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(current.tokenHash).run();
  }
  async change(currentPassword: unknown, newPassword: unknown, session: Session): Promise<void> {
    const old = password(currentPassword), value = password(newPassword, true), row = await this.row();
    if (!row.password_hash || row.version !== session.version) throw new AuthError('登录已失效，请重新登录。', 401);
    if (!await verifyPassword(old, row.password_hash, this.pepper())) throw new AuthError('当前密码不正确。', 400);
    await this.replace(value, row.version);
  }
  async reset(newPassword: unknown, code: unknown): Promise<void> {
    await this.recovery(code);
    const value = password(newPassword, true), row = await this.row();
    if (!row.password_hash) throw new AuthError('请先设置登录密码。', 409);
    await this.replace(value, row.version);
  }
  private async replace(value: string, version: number): Promise<void> {
    const hash = await hashPassword(value, this.pepper());
    const result = await this.db.prepare('UPDATE admin_auth SET password_hash = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?')
      .bind(hash, new Date().toISOString(), version).run();
    if (result.meta.changes === 0) throw new AuthError('密码状态已变化，请刷新后重试。', 409);
    // The migration's trigger invalidates every session in this same transaction.
  }
}
