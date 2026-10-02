import { parseStatus, type StatusSnapshot } from './domain';

export const STATUS_URL = 'https://codex-resets.com/api/v1/status';
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MAX_BYTES = 262144;

export async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let result = '', size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('response too large');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function fetchStatus(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<StatusSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let delay = (attempt + 1) * 1000;
    try {
      const response = await fetcher(STATUS_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'codex-resets-email-monitor/2.0 (+https://github.com/turmony/codex-resets)' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (response.ok) {
        try { return parseStatus(JSON.parse(await boundedText(response))); }
        catch { throw new InvalidResponse(); }
      }
      await response.body?.cancel();
      if (response.status !== 429 && response.status < 500) throw new InvalidResponse();
      const after = response.headers.get('Retry-After');
      if (response.status === 429 && after !== null && Number.isFinite(Number(after)) && Number(after) >= 0) delay = Math.min(Number(after), 30) * 1000;
    } catch (error) {
      if (error instanceof InvalidResponse || signal.aborted) throw new Error('status API unavailable or invalid');
    }
    if (attempt < 2) { await sleep(delay); signal.throwIfAborted(); }
  }
  throw new Error('status API unavailable or invalid');
}
class InvalidResponse extends Error {}
