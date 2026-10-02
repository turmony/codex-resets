import { base64, mimeMessage, validateMail, type MailContent } from './emailer';
import { LineChannel, tlsSocket, type SocketFactory } from './transport';

export class SMTPDeliveryError extends Error {
  constructor(public readonly uncertain: boolean) { super(uncertain ? 'smtp outcome uncertain' : 'smtp submission failed'); }
}
async function reply(channel: LineChannel, expected: number): Promise<void> {
  let code: string | undefined;
  for (let i = 0; i < 100; i++) {
    const match = /^(\d{3})([ -])/.exec(await channel.line());
    if (!match || (code && code !== match[1])) throw new Error('invalid smtp reply');
    code = match[1];
    if (match[2] === ' ') {
      if (Number(code) !== expected) throw new RejectedReply();
      return;
    }
  }
  throw new Error('smtp response limit');
}
class RejectedReply extends Error {}

async function authenticate(channel: LineChannel, email: string, authCode: string): Promise<void> {
  const command = async (value: string, code: number) => { await channel.write(value + '\r\n'); await reply(channel, code); };
  await reply(channel, 220);
  await command('EHLO monitor.codex-resets.local', 250);
  await command('AUTH LOGIN', 334);
  await command(base64(email), 334);
  await command(base64(authCode), 235);
}

export async function verifySMTP(email: string, authCode: string, signal: AbortSignal, factory: SocketFactory = tlsSocket): Promise<void> {
  validateMail(email, authCode);
  let channel: LineChannel | undefined;
  try {
    channel = new LineChannel(factory('smtp.126.com', 465), AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    await authenticate(channel, email, authCode);
    await channel.write('QUIT\r\n').catch(() => {});
  } catch { throw new Error('smtp verification unavailable'); }
  finally { await channel?.close(); }
}

export async function sendMail(
  email: string, authCode: string, eventId: string, content: MailContent,
  signal: AbortSignal, beforeData: () => Promise<void>, factory: SocketFactory = tlsSocket,
): Promise<void> {
  validateMail(email, authCode);
  const message = mimeMessage(email, eventId, content, Date.now());
  let channel: LineChannel | undefined, uncertain = false, accepted = false;
  try {
    channel = new LineChannel(factory('smtp.126.com', 465), AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    const command = async (value: string, code: number) => { await channel!.write(value + '\r\n'); await reply(channel!, code); };
    await authenticate(channel, email, authCode);
    await command(`MAIL FROM:<${email}>`, 250);
    await command(`RCPT TO:<${email}>`, 250);
    await command('DATA', 354);
    // Durable intent and fencing must succeed before transmitting any message bytes.
    await beforeData();
    uncertain = true;
    await channel.write(message.replace(/(^|\r\n)\./g, '$1..') + '.\r\n');
    try { await reply(channel, 250); }
    catch (error) { if (error instanceof RejectedReply) uncertain = false; throw error; }
    accepted = true;
    // QUIT/cleanup failure after the final 250 must never become a send failure.
    await channel.write('QUIT\r\n').catch(() => {});
  } catch {
    if (!accepted) throw new SMTPDeliveryError(uncertain);
  } finally { await channel?.close(); }
}
