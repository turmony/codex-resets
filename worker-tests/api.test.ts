import { describe, expect, it, vi } from 'vitest';
import { boundedText, fetchStatus } from '../worker/api';
import { payload } from './fixtures';

const signal = () => new AbortController().signal;
describe('bounded API client', () => {
  it('fetches and validates the public snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    const status = await fetchStatus(signal(), fetcher);
    expect(status.latest_reset!.id).toBe('reset-1');
    expect(fetcher.mock.calls[0][0]).toBe('https://codex-resets.com/api/v1/status');
  });
  it('retries a rate limit before succeeding', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValue(Response.json(payload()));
    expect((await fetchStatus(signal(), fetcher)).active_watch!.reset_chance_percent).toBe(70);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry a permanent error or invalid schema', async () => {
    for (const response of [new Response('', { status: 403 }), Response.json({ data: {} })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(fetchStatus(signal(), fetcher)).rejects.toThrow('status API unavailable or invalid');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('limits response size even when Content-Length is missing', async () => {
    await expect(boundedText(new Response('x'.repeat(262145)))).rejects.toThrow('response too large');
  });
});
