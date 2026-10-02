import { parseState, type MonitorState } from './domain';
import type { MailContent } from './emailer';

export type Kind = 'activation' | 'forecast' | 'scheduled' | 'reset';
export type DeliveryStatus = 'pending' | 'sending' | 'uncertain' | 'accepted' | 'sent' | 'cancelled';
export interface NotificationPayload {
  content: MailContent;
  patch: Partial<MonitorState>;
  expiresAt: string | null;
  fingerprint: string | null;
  scheduledResetId?: string;
}
export interface NotificationRow {
  event_id: string; kind: Kind; status: DeliveryStatus; payload_json: string;
  created_at: string; attempted_at: string | null; completed_at: string | null; attempts: number; last_error: string | null;
}
export interface NotificationPlan { eventId: string; kind: Kind; payload: NotificationPayload }
export interface MonitorRow { state_json: string; lease_token: string | null; lease_until: number; last_checked_at: string | null; last_result: string | null }

const FENCE = 'EXISTS (SELECT 1 FROM monitor WHERE id = 1 AND lease_token = ? AND lease_until > ?)';
export class LeaseLost extends Error { constructor() { super('monitor lease lost'); } }

export class Store {
  readonly session: D1DatabaseSession;
  readonly token = crypto.randomUUID();
  constructor(db: D1Database) { this.session = db.withSession('first-primary'); }
  async acquire(): Promise<boolean> {
    const now = Date.now();
    const result = await this.session.prepare('UPDATE monitor SET lease_token = ?, lease_until = ? WHERE id = 1 AND lease_until <= ?')
      .bind(this.token, now + 300000, now).run();
    return result.meta.changes === 1;
  }
  async assertLease(): Promise<void> {
    const row = await this.session.prepare('SELECT id FROM monitor WHERE id = 1 AND lease_token = ? AND lease_until > ?').bind(this.token, Date.now()).first();
    if (!row) throw new LeaseLost();
  }
  async release(): Promise<void> {
    await this.session.prepare('UPDATE monitor SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?').bind(this.token).run();
  }
  async state(): Promise<MonitorState> {
    const row = await this.session.prepare('SELECT state_json FROM monitor WHERE id = 1').first<{ state_json: string }>();
    if (!row) throw new Error('monitor database not initialized');
    return parseState(JSON.parse(row.state_json));
  }
  private async guarded(sql: string, values: (string | number | null)[]): Promise<void> {
    const result = await this.session.prepare(sql).bind(...values, this.token, Date.now()).run();
    // D1 counts writes performed by triggers too; completion normally changes
    // both a notification and the monitor row. Zero means the fence rejected it.
    if (result.meta.changes === 0) throw new LeaseLost();
  }
  async clearWatch(): Promise<void> {
    // json_patch removes null keys; json_set keeps the state schema intact.
    await this.guarded(`UPDATE monitor SET state_json = json_set(state_json, '$.active_watch_fingerprint', NULL, '$.state_updated_at', ?) WHERE id = 1 AND ${FENCE}`, [new Date().toISOString()]);
  }
  async recoverable(): Promise<NotificationRow[]> {
    const result = await this.session.prepare("SELECT * FROM notifications WHERE status IN ('pending','sending','uncertain','accepted') ORDER BY created_at, event_id LIMIT 32").all<NotificationRow>();
    return result.results;
  }
  async hasSentScheduled(resetId: string): Promise<boolean> {
    return !!await this.session.prepare("SELECT event_id FROM notifications WHERE kind = 'scheduled' AND status = 'sent' AND json_extract(payload_json, '$.scheduledResetId') = ? LIMIT 1")
      .bind(resetId).first();
  }
  async prepare(plan: NotificationPlan): Promise<NotificationRow> {
    await this.assertLease();
    await this.session.prepare(`INSERT INTO notifications (event_id, kind, status, payload_json, created_at)
      SELECT ?, ?, 'pending', ?, ? WHERE ${FENCE} ON CONFLICT(event_id) DO NOTHING`)
      .bind(plan.eventId, plan.kind, JSON.stringify(plan.payload), new Date().toISOString(), this.token, Date.now()).run();
    const row = await this.session.prepare('SELECT * FROM notifications WHERE event_id = ?').bind(plan.eventId).first<NotificationRow>();
    if (!row) throw new LeaseLost();
    // Regenerate never-submitted activation content from the latest snapshot.
    if ((row.status === 'pending' && row.kind === 'activation') || row.status === 'cancelled') {
      await this.guarded(`UPDATE notifications SET status = 'pending', payload_json = ?, last_error = NULL WHERE event_id = ? AND ${FENCE}`, [JSON.stringify(plan.payload), plan.eventId]);
      return { ...row, status: 'pending', payload_json: JSON.stringify(plan.payload) };
    }
    return row;
  }
  async submitting(row: NotificationRow): Promise<void> {
    await this.guarded(`UPDATE notifications SET status = 'sending', attempted_at = ?, attempts = attempts + 1, last_error = NULL WHERE event_id = ? AND ${FENCE}`,
      [new Date().toISOString(), row.event_id]);
  }
  async setStatus(row: NotificationRow, status: DeliveryStatus, error: string | null = null): Promise<void> {
    await this.guarded(`UPDATE notifications SET status = ?, last_error = ? WHERE event_id = ? AND ${FENCE}`, [status, error, row.event_id]);
  }
  async complete(row: NotificationRow): Promise<void> {
    // The SQLite trigger updates state in the same transaction as this result.
    await this.guarded(`UPDATE notifications SET status = 'sent', completed_at = ?, last_error = NULL WHERE event_id = ? AND ${FENCE}`, [new Date().toISOString(), row.event_id]);
  }
  async checked(result: string): Promise<void> {
    await this.guarded(`UPDATE monitor SET last_checked_at = ?, last_result = ? WHERE id = 1 AND ${FENCE}`, [new Date().toISOString(), result]);
  }
}
