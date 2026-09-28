import { describe, expect, it, vi } from 'vitest';
import { SinaloaClient, SinaloaError, newCaseId, putSignedAsset, rotateAgentToken } from '../src/index';

describe('Sinaloa TypeScript client', () => {
  it('starts two separate cases with caller-persisted IDs and sends typed follow-up events', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') });
      return new Response(JSON.stringify({ caseId: calls.at(-1)?.body.caseId, status: 'queued' }), { status: 202 });
    });
    const client = new SinaloaClient('https://api.example', 'secret', { fetch: fetcher as typeof fetch });
    const first = newCaseId();
    const second = newCaseId();
    expect(first).not.toBe(second);
    const input = { senderAgentId: 'agent_one', recipientEmail: 'peer@sinaloa.mail', text: 'Need input' };
    await client.startCase('inbox_one', 'first-case-key', { ...input, caseId: first });
    await client.startCase('inbox_one', 'second-case-key', { ...input, caseId: second });
    await client.sendCaseEvent('inbox_one', 'first-offer-key', { ...input, caseId: first, intent: 'offer', payload: { proposal: { price: 3 } } });
    expect(calls.map(call => call.body.caseId)).toEqual([first, second, first]);
    expect(calls.map(call => call.body.intent)).toEqual(['request', 'request', 'offer']);
    expect(calls.map(call => call.key)).toEqual(['first-case-key', 'second-case-key', 'first-offer-key']);
    expect(calls[0].url).toBe('https://api.example/api/inboxes/inbox_one/messages');
    expect(() => client.startCase('inbox_one', 'unsafe-key', { ...input, caseId: '' })).toThrow('persisted caseId');
  });

  it('uses the signed asset target without sending agent credentials', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(init?.redirect).toBe('error');
      return new Response(null, { status: 200 });
    });
    await putSignedAsset({ url: 'https://r2.example/signed', method: 'PUT', headers: { 'content-type': 'text/plain' } }, new Uint8Array([1, 2]), { fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(putSignedAsset({ url: 'http://r2.example/signed', method: 'PUT' }, new Uint8Array([1]))).rejects.toThrow('HTTPS');
  });

  it('encodes path segments and parses JSON', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), { status: 200 }));
    const client = new SinaloaClient('https://api.example', 'secret', { fetch: fetcher as typeof fetch });
    await client.delta('inbox/../../other');
    expect(fetcher.mock.calls[0][0]).toContain('/api/inboxes/inbox%2F..%2F..%2Fother/events/delta');
  });

  it('reads array-shaped case and message lists from the canonical REST API', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ id: 'case_one' }]), { status: 200 }));
    const client = new SinaloaClient('https://api.example', 'secret', { fetch: fetcher as typeof fetch });
    expect(await client.listCases('inbox_one')).toEqual([{ id: 'case_one' }]);
    expect(await client.listCaseMessages('inbox_one', 'case_one')).toEqual([{ id: 'case_one' }]);
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
