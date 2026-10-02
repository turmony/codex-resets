import { describe, expect, it } from 'vitest';
import { parseStatus, timestamp, watchFingerprint } from '../worker/domain';
import { planNotifications } from '../worker/monitor';
import { mimeMessage, renderActivation } from '../worker/emailer';
import { payload } from './fixtures';

describe('status and legacy compatibility', () => {
  it('retains exactly the Python fingerprint across migration', async () => {
    expect(await watchFingerprint(parseStatus(payload()).active_watch!)).toBe('fbd076f7df28475f4f6269e897bf3d47adaedfa3f337fd637fc9b745ca815410');
    expect(timestamp('2026-08-28T11:00:00.1234567+01:00')).toBe('2026-08-28T10:00:00.123456Z');
  });
  it.each(['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00', '2026-01-01T00:00:00+24:00', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59-01:00'])('rejects invalid timestamp %s', value => { expect(() => timestamp(value)).toThrow(); });
  it('uses the original Asia/Shanghai timezone, including historical daylight saving', () => {
    const content = renderActivation({ latest_reset: null, active_watch: null, generated_at: '1991-07-01T00:00:00Z' }, '1991-07-01T00:00:00Z');
    expect(content.body).toContain('1991-07-01 00:00:00 UTC');
    expect(content.body).toContain('1991-07-01 09:00:00 北京时间');
  });
  it('rejects malformed status without converting false into zero probability', () => {
    const data = payload();
    expect(() => parseStatus({ ...data, data: { ...data.data, active_watch: { ...data.data.active_watch, reset_chance_percent: false } } })).toThrow();
  });
  it('does not mail expired forecasts', async () => {
    const plans = await planNotifications(parseStatus(payload()), { version: 1, initialized: true, notified_reset_id: 'reset-1', active_watch_fingerprint: null, state_updated_at: null }, Date.parse('2026-09-01T00:00:00Z'));
    expect(plans).toEqual([]);
  });
  it('encodes Chinese safely, preserves event markers and bounds MIME lines', () => {
    const mail = mimeMessage('fixture' + '@126.com', 'a'.repeat(64), { subject: '[Codex Resets] 重置预警已更新：概率 70%', body: '中文邮件内容' }, Date.now());
    expect(mail).toContain('X-Codex-Event: ' + 'a'.repeat(64));
    expect(mail).toContain('Content-Transfer-Encoding: base64');
    expect(mail.split('\r\n').every(line => line.length <= 998)).toBe(true);
    expect(mail).not.toContain('Subject: [Codex');
  });
});
