import { connect } from 'cloudflare:sockets';

export type WireSocket = Pick<Socket, 'readable' | 'writable' | 'opened' | 'closed' | 'close'>;
export type SocketFactory = (host: string, port: number) => WireSocket;
export const tlsSocket: SocketFactory = (hostname, port) => connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false });

/** Bounded, deadline-controlled line protocol; server replies never appear in logs. */
export class LineChannel {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  private buffer = '';
  private received = 0;
  private readonly abort: () => void;
  private readonly aborted: Promise<never>;

  constructor(private readonly socket: WireSocket, private readonly signal: AbortSignal) {
    this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter();
    // Socket.opened/closed can reject independently from stream reads.
    void socket.opened.catch(() => {}); void socket.closed.catch(() => {});
    let rejectAbort!: (error: Error) => void;
    this.aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    this.abort = () => { rejectAbort(new Error('mail connection unavailable')); void socket.close().catch(() => {}); };
    signal.addEventListener('abort', this.abort, { once: true });
    void this.aborted.catch(() => {});
    if (signal.aborted) this.abort();
  }
  async write(value: string): Promise<void> {
    this.signal.throwIfAborted();
    await Promise.race([this.writer.write(new TextEncoder().encode(value)), this.aborted]);
  }
  async line(): Promise<string> {
    for (;;) {
      this.signal.throwIfAborted();
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) { const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2); return line; }
      if (this.buffer.length > 65536) throw new Error('mail response limit');
      const { value, done } = await Promise.race([this.reader.read(), this.aborted]);
      if (done) throw new Error('mail connection closed');
      this.received += value.byteLength;
      if (this.received > 262144) throw new Error('mail response limit');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort);
    await this.socket.close().catch(() => {});
  }
}
