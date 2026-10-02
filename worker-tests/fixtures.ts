import { parseStatus, type StatusSnapshot } from '../worker/domain';
import type { Dependencies } from '../worker/monitor';
import { vi } from 'vitest';

export function payload() {
  return {
    data: {
      latest_reset: { id: 'reset-1', reset_type: 'regular', announced_at: '2026-08-28T10:00:00Z', text: 'A regular reset was announced.', source: { type: 'x_post', author: 'thsottiaux', url: 'https://codex-resets.com/resets/reset-1' } },
      active_watch: { level: 'elevated', reset_chance_percent: 70, forecast_window: 'within 24 hours', observed_at: '2026-08-28T11:00:00+01:00', expires_at: '2026-08-29T11:00:00+01:00', text: 'A reset is being watched.', source: { type: 'x_post', author: 'thsottiaux', url: 'https://codex-resets.com/watches/active' } },
    }, meta: { generated_at: '2026-08-28T12:00:00Z' },
  };
}
export function freshStatus(): StatusSnapshot {
  const status = parseStatus(payload());
  status.active_watch!.expires_at = new Date(Date.now() + 24 * 3600000).toISOString();
  return status;
}
export function dependencies(status = freshStatus()) {
  return {
    fetchStatus: vi.fn<Dependencies['fetchStatus']>().mockResolvedValue(status),
    send: vi.fn<Dependencies['send']>().mockImplementation(async (_row, _payload, _signal, beforeData) => { await beforeData(); }),
    find: vi.fn<Dependencies['find']>().mockResolvedValue(false),
  };
}
