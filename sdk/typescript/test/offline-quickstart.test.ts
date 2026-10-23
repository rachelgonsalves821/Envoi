import { describe, expect, it, vi } from 'vitest';
import { createStrictOfflineFetch, DEMO, runOfflineQuickstart } from '../examples/offline-quickstart.ts';

describe('offline TypeScript SDK quickstart', () => {
  it('executes the real SDK with exact requests and stable retry identifiers', async () => {
    const realFetch = vi.fn(() => { throw new Error('unexpected real network transport'); });
    vi.stubGlobal('fetch', realFetch);
    try {
      const { summary, requests } = await runOfflineQuickstart();
      expect(realFetch).not.toHaveBeenCalled();
      expect(requests).toHaveLength(7);
      expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
        ['POST', `/api/inboxes/${DEMO.inboxId}/messages`],
        ['POST', `/api/inboxes/${DEMO.inboxId}/messages`],
        ['POST', `/api/inboxes/${DEMO.inboxId}/messages`],
        ['POST', `/api/inboxes/${DEMO.inboxId}/messages`],
        ['GET', `/api/inboxes/${DEMO.inboxId}/events/delta`],
        ['POST', '/api/agent-token'], ['POST', '/api/agent-token']
      ]);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[2]).toEqual(requests[3]);
      expect(requests[5]).toEqual(requests[6]);
      expect(requests[0].headers['idempotency-key']).toBe(DEMO.startKey);
      expect(requests[2].headers['idempotency-key']).toBe(DEMO.eventKey);
      expect(DEMO.startKey).not.toBe(DEMO.eventKey);
      expect(requests.slice(0, 4).map(request => (request.body as {caseId: string}).caseId)).toEqual(Array(4).fill(DEMO.caseId));
      expect(requests[4].url).toBe(`${DEMO.origin}/api/inboxes/${DEMO.inboxId}/events/delta?limit=2&cursor=cursor_before`);
      expect(requests[4].body).toBeNull();
      expect(requests[5].body).toEqual({ grantType: 'refresh_token', agentRefreshToken: DEMO.refreshToken, rotationId: DEMO.rotationId });
      expect(requests[5].headers.authorization).toBeUndefined();
      expect(requests.slice(0, 5).every(request => request.headers.authorization === `Bearer ${DEMO.accessToken}`)).toBe(true);
      expect(summary).toContain('Offline SDK example');
      expect(summary).not.toContain(DEMO.accessToken);
      expect(summary).not.toContain(DEMO.refreshToken);
      expect(summary).not.toContain('synthetic-next-access');
      expect(summary).not.toContain('synthetic-next-refresh');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects requests outside the exact offline scenario', async () => {
    const { fetcher } = createStrictOfflineFetch();
    await expect(fetcher('https://outside.invalid/', { method: 'GET' })).rejects.toThrow('unexpected request URL');
  });
});
