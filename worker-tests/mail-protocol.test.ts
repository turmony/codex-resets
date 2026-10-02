import { describe, expect, it, vi } from 'vitest';
import { sendMail, verifySMTP, SMTPDeliveryError } from '../worker/smtp';
import { findReceived } from '../worker/imap';
import type { SocketFactory, WireSocket } from '../worker/transport';

const address = 'fixture' + '@126.com', auth = 'fixture-authorization', event = 'b'.repeat(64);
const signal = () => new AbortController().signal;
const success = ['220 ready', '250-smtp', '250 AUTH LOGIN', '334 user', '334 password', '235 authenticated', '250 sender', '250 recipient', '354 data', '250 accepted'];

function wire(lines: string[], failQuit = false) {
  const writes: string[] = [];
  const socket: WireSocket = {
    readable: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.join('\r\n') + '\r\n')); c.close(); } }),
    writable: new WritableStream<Uint8Array>({ write(data) { const text = new TextDecoder().decode(data); writes.push(text); if (failQuit && text === 'QUIT\r\n') throw new Error('QUIT failed'); } }),
    opened: Promise.resolve({ remoteAddress: 'smtp.test:465', localAddress: '127.0.0.1' }), closed: Promise.resolve(), close: async () => {},
  };
  const factory = vi.fn<SocketFactory>(() => socket);
  return { factory, writes };
}
describe('mail protocols and ambiguity boundary', () => {
  it('verifies SMTP authentication without sending any message', async () => {
    const { factory, writes } = wire(success.slice(0, 6));
    await verifySMTP(address, auth, signal(), factory);
    expect(writes.join('')).toContain('AUTH LOGIN');
    expect(writes.join('')).not.toContain('MAIL FROM');
    expect(writes.join('')).not.toContain('DATA');
  });
  it('uses implicit TLS SMTP port 465, a stable ID, and no resend after failed QUIT', async () => {
    const { factory, writes } = wire(success, true), beforeData = vi.fn(async () => {});
    await sendMail(address, auth, event, { subject: '中文', body: '通知正文' }, signal(), beforeData, factory);
    expect(factory).toHaveBeenCalledExactlyOnceWith('smtp.126.com', 465);
    expect(beforeData).toHaveBeenCalledTimes(1);
    expect(writes.filter(w => w.includes('X-Codex-Event:'))).toHaveLength(1);
    expect(writes.join('')).toContain('Message-ID: <' + event + '@codex-resets.local>');
  });
  it('classifies a disconnect after message transmission as uncertain', async () => {
    const { factory } = wire(success.slice(0, -1));
    await expect(sendMail(address, auth, event, { subject: 's', body: 'b' }, signal(), async () => {}, factory)).rejects.toMatchObject({ uncertain: true });
  });
  it('classifies an explicit DATA rejection as safe to retry later', async () => {
    const { factory } = wire([...success.slice(0, -1), '550 rejected']);
    await expect(sendMail(address, auth, event, { subject: 's', body: 'b' }, signal(), async () => {}, factory)).rejects.toMatchObject({ uncertain: false });
  });
  it('does not transmit the body if lease fencing fails before DATA', async () => {
    const { factory, writes } = wire(success);
    await expect(sendMail(address, auth, event, { subject: 's', body: 'b' }, signal(), async () => { throw new Error('lease lost'); }, factory)).rejects.toBeInstanceOf(SMTPDeliveryError);
    expect(writes.join('')).not.toContain('X-Codex-Event:');
  });
  it('never leaks provider replies or auth codes in SMTP errors', async () => {
    const { factory } = wire(['220 ready', '550 ' + auth]);
    try { await sendMail(address, auth, event, { subject: 's', body: 'b' }, signal(), async () => {}, factory); throw new Error('expected failure'); }
    catch (error) { expect(String(error)).not.toContain(auth); }
  });
  it('finds a matching incoming message with read-only IMAP operations', async () => {
    const { factory, writes } = wire(['* OK ready', 'C0001 OK ID', 'C0002 OK LOGIN', '* LIST (\\HasNoChildren) "/" "INBOX"', 'C0003 OK LIST', '* 1 EXISTS', 'C0004 OK EXAMINE', '* SEARCH 123', 'C0005 OK SEARCH']);
    expect(await findReceived(address, auth, event, signal(), factory)).toBe(true);
    expect(factory).toHaveBeenCalledExactlyOnceWith('imap.126.com', 993);
    expect(writes.join('')).toContain('EXAMINE "INBOX"');
    expect(writes.join('')).not.toContain('STORE');
  });
  it('fails closed if mailbox enumeration cannot be fully parsed', async () => {
    const { factory } = wire(['* OK ready', 'C0001 OK ID', 'C0002 OK LOGIN', '* LIST () "/" {10}', 'C0003 OK LIST']);
    await expect(findReceived(address, auth, event, signal(), factory)).rejects.toThrow('imap reconciliation unavailable');
  });
  it('searches spam folders and body markers if headers were removed', async () => {
    const { factory, writes } = wire(['* OK ready', 'C0001 OK ID', 'C0002 OK LOGIN', '* LIST () "/" "INBOX"', '* LIST () "/" "Spam"', 'C0003 OK LIST', 'C0004 OK EXAMINE', '* SEARCH', 'C0005 OK SEARCH', '* SEARCH', 'C0006 OK SEARCH', 'C0007 OK EXAMINE', '* SEARCH', 'C0008 OK SEARCH', '* SEARCH 9', 'C0009 OK SEARCH']);
    expect(await findReceived(address, auth, event, signal(), factory)).toBe(true);
    expect(writes.join('')).toContain('EXAMINE "Spam"');
    expect(writes.join('')).toContain('UID SEARCH BODY');
  });
});
