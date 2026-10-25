import { describe, expect, it, vi } from 'vitest';
import { PrivateHostTransport } from './private-host-http';

function transport(body: unknown, status = 429, retryAfter?: string) {
  return new PrivateHostTransport({ origin: 'https://envoi.example', headers: async () => ({}), fetch: vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) }
  })) as typeof fetch });
}
describe('bounded private host Retry-After handling', () => {
  it('retains the larger safe header/body delay without exposing the raw message', async () => {
    const client = transport({ code: 'RATE_LIMITED', retryAfterSeconds: 120, message: 'private response data' }, 429, '60');
    const error = await client.post('/mcp', {}).catch(error => error);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 120 });
    expect(JSON.stringify(error)).not.toContain('private response data');
  });
  it('also preserves an active-check delay on HTTP409', async () => {
    await expect(transport({ code: 'GATEWAY_CHECK_ACTIVE', retryAfterSeconds: 75 }, 409).post('/api/agent-gateway/work/claim', { runId: 'saved' })).rejects.toMatchObject({ code: 'GATEWAY_CHECK_ACTIVE', retryAfterSeconds: 75 });
  });
  it.each([0, -1, 0.5, '120', null, 9007199254740992])('ignores invalid body delay %s', async value => {
    const error = await transport({ code: 'RATE_LIMITED', retryAfterSeconds: value }, 429, 'not-a-date-or-delay').post('/mcp', {}).catch(error => error);
    expect(error.retryAfterSeconds).toBeUndefined();
  });
  it('bounds a valid very large delay to one day', async () => {
    await expect(transport({ code: 'RATE_LIMITED', retryAfterSeconds: 99999999 }, 429, '99999999').post('/mcp', {})).rejects.toMatchObject({ retryAfterSeconds: 86400 });
  });
  it('supports an HTTP date delay without retaining the header value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      await expect(transport({ code: 'RATE_LIMITED' }, 429, 'Sat, 24 Oct 2026 12:02:00 GMT').post('/mcp', {})).rejects.toMatchObject({ retryAfterSeconds: 120 });
    } finally { vi.useRealTimers(); }
  });
});
