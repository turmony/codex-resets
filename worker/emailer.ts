import type { ResetInfo, ScheduledResetInfo, StatusSnapshot, WatchInfo } from './domain';

export interface MailContent { subject: string; body: string }
function times(label: string, time: string): string[] {
  const utc = new Date(time);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(utc);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const beijing = `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
  return [`${label}：${fmt(utc)} UTC`, `${label}：${beijing} 北京时间`];
}
function source(text: string, url: string | null): string[] {
  return [`公告原文：${text}`, ...(url ? [`来源链接：${url}`] : []), '数据来源：Codex Resets https://codex-resets.com'];
}
function watchLines(watch: WatchInfo): string[] {
  return [`预测概率：${watch.reset_chance_percent === null ? '未知' : `${watch.reset_chance_percent}%`}`, `预测级别：${watch.level}`, `预测窗口：${watch.forecast_window}`,
    ...times('观察时间', watch.observed_at), ...times('失效时间', watch.expires_at), ...source(watch.text, watch.source.url)];
}
export function renderActivation(status: StatusSnapshot, checkedAt: string): MailContent {
  const lines = ['Codex Resets 监控已启用。'];
  if (status.latest_reset) lines.push(`当前重置类型：${status.latest_reset.reset_type}`, ...times('公告时间', status.latest_reset.announced_at), ...source(status.latest_reset.text, status.latest_reset.source.url));
  if (status.active_watch) lines.push(...watchLines(status.active_watch));
  return { subject: '[Codex Resets] 监控已启用', body: [...lines, ...times('检测时间', checkedAt)].join('\n') };
}
export function renderWatch(watch: WatchInfo, checkedAt: string, isUpdate: boolean): MailContent {
  const probability = watch.reset_chance_percent === null ? '概率未知' : `概率 ${watch.reset_chance_percent}%`;
  return { subject: `[Codex Resets] ${isUpdate ? '重置预警已更新' : '重置预警'}：${probability}`, body: ['以下内容为预测，不代表已确认重置。', ...watchLines(watch), ...times('检测时间', checkedAt)].join('\n') };
}
export function renderReset(reset: ResetInfo, checkedAt: string): MailContent {
  return { subject: '[Codex Resets] Codex 已重置', body: [`重置类型：${reset.reset_type}`, ...times('公告时间', reset.announced_at), ...source(reset.text, reset.source.url), ...times('检测时间', checkedAt)].join('\n') };
}
export function renderScheduled(reset: ScheduledResetInfo, checkedAt: string, isUpdate: boolean): MailContent {
  const pending = reset.scheduled_for !== null && Date.parse(reset.scheduled_for) <= Date.parse(checkedAt);
  return {
    subject: `[Codex Resets] 重置计划已${isUpdate ? '更新' : '公布'}`,
    body: [
      '以下内容为已公布的重置计划，实际完成仍需后续确认。',
      ...(pending ? ['计划时间已过，仍等待实际完成确认。'] : []),
      `重置类型：${reset.reset_type}`,
      ...(reset.scheduled_for === null ? ['计划时间：尚未明确'] : times('计划时间', reset.scheduled_for)),
      ...times('公告时间', reset.announced_at), ...source(reset.text, reset.source.url), ...times('检测时间', checkedAt),
    ].join('\n'),
  };
}
export function base64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function validateMail(email: unknown, authCode: unknown): asserts email is string {
  if (typeof email !== 'string' || !/^[A-Za-z0-9._%+-]+@126\.com$/i.test(email) ||
      typeof authCode !== 'string' || !authCode.trim() || /[\r\n\0]/.test(authCode)) throw new Error('mail secrets missing or invalid');
}
export function mimeMessage(email: string, eventId: string, content: MailContent, now: number): string {
  if (!/^[a-f0-9]{64}$/.test(eventId) || /[\r\n]/.test(email)) throw new Error('invalid mail envelope');
  const body = base64(`${content.body}\n\n通知事件：${eventId}\n`).match(/.{1,76}/g)?.join('\r\n') ?? '';
  // Split encoded words at Unicode character boundaries to keep RFC 2047 headers bounded.
  const parts: string[] = []; let part = '';
  for (const ch of content.subject) { if (new TextEncoder().encode(part + ch).length > 42) { parts.push(part); part = ''; } part += ch; }
  if (part) parts.push(part);
  const subject = parts.map(p => `=?UTF-8?B?${base64(p)}?=`).join('\r\n ');
  return [`From: ${email}`, `To: ${email}`, `Subject: ${subject}`, `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${eventId}@codex-resets.local>`, `X-Codex-Event: ${eventId}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body, ''].join('\r\n');
}
