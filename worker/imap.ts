import { validateMail } from './emailer';
import { LineChannel, tlsSocket, type SocketFactory } from './transport';

const quote = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** Read-only reconciliation; search all selectable folders, including spam. */
export async function findReceived(
  email: string, authCode: string, eventId: string, signal: AbortSignal, factory: SocketFactory = tlsSocket,
): Promise<boolean> {
  validateMail(email, authCode);
  if (!/^[a-f0-9]{64}$/.test(eventId)) throw new Error('invalid event');
  let channel: LineChannel | undefined;
  try {
    channel = new LineChannel(factory('imap.126.com', 993), AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    if (!/^\* OK\b/i.test(await channel.line())) throw new Error('imap unavailable');
    let serial = 0;
    const command = async (value: string): Promise<string[]> => {
      const tag = 'C' + (++serial).toString().padStart(4, '0'), lines: string[] = [];
      await channel!.write(`${tag} ${value}\r\n`);
      for (let i = 0; i < 1024; i++) {
        const line = await channel!.line();
        if (line.startsWith(tag + ' ')) {
          if (!line.toUpperCase().startsWith(tag + ' OK')) throw new Error('imap command failed');
          return lines;
        }
        if (/^\* BYE\b/i.test(line)) throw new Error('imap closed');
        lines.push(line);
      }
      throw new Error('imap response limit');
    };
    // NetEase requires the client identification extension for some mailboxes.
    await command('ID ("name" "codex-resets-monitor" "version" "2.0.0" "vendor" "codex-resets")');
    await command(`LOGIN ${quote(email)} ${quote(authCode)}`);
    const listing = await command('LIST "" "*"');
    const folders = new Set<string>(['INBOX']);
    for (const line of listing.filter(l => /^\* LIST\b/i.test(l))) {
      if (/\\Noselect\b/i.test(line)) continue;
      // Standard quoted or atom mailbox names. Literal names require a richer
      // parser; fail closed rather than claim an incomplete search found nothing.
      const match = /^\* LIST \([^)]*\) (?:NIL|"(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|[^\s{}]+)$/i.exec(line);
      if (!match) throw new Error('unsupported mailbox listing');
      const name = match[1].startsWith('"') ? match[1].slice(1, -1).replace(/\\(.)/g, '$1') : match[1];
      folders.add(name);
    }
    if (folders.size > 32) throw new Error('imap folder limit');
    for (const folder of folders) {
      await command(`EXAMINE ${quote(folder)}`);
      const lines = await command(`UID SEARCH OR HEADER X-Codex-Event ${quote(eventId)} HEADER Message-ID ${quote(`<${eventId}@codex-resets.local>`)}`);
      const search = lines.find(l => /^\* SEARCH(?: |$)/i.test(l));
      if (search === undefined) throw new Error('invalid imap search');
      if (/^\* SEARCH \d/i.test(search)) return true;
      // Fallback if the SMTP provider rewrote Message-ID or removed custom headers.
      const body = await command(`UID SEARCH BODY ${quote(eventId)}`);
      const bodySearch = body.find(l => /^\* SEARCH(?: |$)/i.test(l));
      if (bodySearch === undefined) throw new Error('invalid imap search');
      if (/^\* SEARCH \d/i.test(bodySearch)) return true;
    }
    return false;
  } catch { throw new Error('imap reconciliation unavailable'); }
  finally { await channel?.close(); }
}
