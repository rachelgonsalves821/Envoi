import { describe, expect, it, vi } from 'vitest';
import { SinaloaClient, SinaloaError, rotateAgentToken } from '../src/index';

describe('Sinaloa TypeScript client', () => {
  it('encodes path segments and parses JSON', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), { status: 200 }));
    const client = new SinaloaClient('https://api.example', 'secret', { fetch: fetcher as typeof fetch });
    await client.delta('inbox/../../other');
    expect(fetcher.mock.calls[0][0]).toContain('/api/inboxes/inbox%2F..%2F..%2Fother/events/delta');
  });

  it('sanitizes HTML and empty error bodies', async () => {
    const fetcher = vi.fn(async () => new Response('<html>provider secret</html>', { status: 502 }));
    const client = new SinaloaClient('https://api.example', 'do-not-leak', { fetch: fetcher as typeof fetch });
    await expect(client.delta('inbox')).rejects.toMatchObject({ message: 'Sinaloa request failed with HTTP 502', status: 502 });
    await expect(client.delta('inbox')).rejects.not.toThrow(/provider secret|do-not-leak/);
  });

  it('returns structured remote errors and bounds timeouts', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Conflict', code: 'REUSED' }), { status: 409 }));
    const client = new SinaloaClient('https://api.example', 'secret', { fetch: fetcher as typeof fetch, timeoutMs: 50 });
    await expect(client.delta('inbox')).rejects.toMatchObject({ message: 'Conflict', status: 409, code: 'REUSED' });
    expect(() => new SinaloaClient('https://api.example', 'secret', { timeoutMs: 0 })).toThrow(RangeError);
  });

  it('aborts timed-out token rotation without exposing the refresh token', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const failure = rotateAgentToken('https://api.example', 'refresh-do-not-leak', { fetch: fetcher as typeof fetch, timeoutMs: 5 });
    await expect(failure).rejects.toBeInstanceOf(SinaloaError);
    await expect(failure).rejects.not.toThrow(/refresh-do-not-leak/);
  });
});
