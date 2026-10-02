export interface SourceInfo { type: 'observed' | 'x_post'; author: string | null; url: string | null }
export interface ResetInfo { id: string; reset_type: 'regular' | 'banked'; announced_at: string; text: string; source: SourceInfo }
export interface WatchInfo { level: 'elevated' | 'strong'; reset_chance_percent: number | null; forecast_window: string; observed_at: string; expires_at: string; text: string; source: SourceInfo }
export interface StatusSnapshot { latest_reset: ResetInfo | null; active_watch: WatchInfo | null; generated_at: string }
export interface MonitorState { version: 1; initialized: boolean; notified_reset_id: string | null; active_watch_fingerprint: string | null; state_updated_at: string | null }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid status response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 65536) throw new Error('invalid status response');
  return value;
}
export function timestamp(value: unknown): string {
  const raw = text(value);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) throw new Error('invalid timestamp');
  const [, day, hh, mm, ss, fraction, offset] = match;
  const date = new Date(`${day}T${hh}:${mm}:${ss}${offset}`);
  // Date.parse normalizes invalid dates; reject them instead, just like Python.
  const local = new Date(`${day}T00:00:00Z`);
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59 ||
      !Number.isFinite(date.getTime()) || !Number.isFinite(local.getTime()) || local.toISOString().slice(0, 10) !== day ||
      (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) throw new Error('invalid timestamp');
  const micros = (fraction ?? '').slice(0, 6).padEnd(6, '0');
  return date.toISOString().slice(0, 19) + (micros === '000000' ? '' : `.${micros}`) + 'Z';
}
function source(value: unknown): SourceInfo {
  const v = object(value);
  if (v.type === 'observed') return { type: v.type, author: null, url: v.url === undefined ? null : text(v.url) };
  if (v.type !== 'x_post') throw new Error('invalid source');
  return { type: v.type, author: text(v.author), url: text(v.url) };
}
export function parseStatus(value: unknown): StatusSnapshot {
  const raw = object(value), data = object(raw.data), meta = object(raw.meta);
  let latest_reset: ResetInfo | null = null, active_watch: WatchInfo | null = null;
  if (data.latest_reset !== null) {
    const v = object(data.latest_reset);
    if (v.reset_type !== 'regular' && v.reset_type !== 'banked') throw new Error('invalid reset');
    latest_reset = { id: text(v.id), reset_type: v.reset_type, announced_at: timestamp(v.announced_at), text: text(v.text), source: source(v.source) };
  }
  if (data.active_watch !== null) {
    const v = object(data.active_watch), chance = v.reset_chance_percent;
    if ((v.level !== 'elevated' && v.level !== 'strong') ||
        (chance !== null && (typeof chance !== 'number' || !Number.isInteger(chance) || chance < 0 || chance > 100))) throw new Error('invalid forecast');
    active_watch = { level: v.level, reset_chance_percent: chance as number | null, forecast_window: text(v.forecast_window), observed_at: timestamp(v.observed_at), expires_at: timestamp(v.expires_at), text: text(v.text), source: source(v.source) };
  }
  return { latest_reset, active_watch, generated_at: timestamp(meta.generated_at) };
}
export function parseState(value: unknown): MonitorState {
  const v = object(value);
  if (Object.keys(v).sort().join() !== ['active_watch_fingerprint','initialized','notified_reset_id','state_updated_at','version'].join() ||
      v.version !== 1 || typeof v.initialized !== 'boolean' ||
      ['notified_reset_id','active_watch_fingerprint','state_updated_at'].some(k => v[k] !== null && typeof v[k] !== 'string')) throw new Error('invalid monitor state');
  return {
    version: 1, initialized: v.initialized,
    notified_reset_id: v.notified_reset_id as string | null,
    active_watch_fingerprint: v.active_watch_fingerprint as string | null,
    state_updated_at: v.state_updated_at as string | null,
  };
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function watchFingerprint(watch: WatchInfo): Promise<string> {
  // Same sorted keys, UTF-8 JSON and UTC datetime.isoformat() as the Python version.
  return sha256(JSON.stringify({
    expires_at: watch.expires_at.replace(/Z$/, '+00:00'),
    forecast_window: watch.forecast_window,
    level: watch.level,
    observed_at: watch.observed_at.replace(/Z$/, '+00:00'),
    reset_chance_percent: watch.reset_chance_percent,
    source_url: watch.source.url,
    text: watch.text,
  }));
}
export function effectiveStatus(status: StatusSnapshot, now: number): StatusSnapshot {
  return { ...status, active_watch: status.active_watch && Date.parse(status.active_watch.expires_at) > now ? status.active_watch : null };
}
