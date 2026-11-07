import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '@envoi/protocol/connector';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(expired = false) {
  let saved: ConnectorSession = { agentId: 'agent_cancel', inboxId: 'inbox_cancel', address: 'cancel@envoi.example', cursor: null,
    agentApiToken: 'synthetic-access', agentRefreshToken: 'synthetic-refresh',
    agentTokenExpiresAt: new Date(Date.now() + (expired ? -1_000 : 900_000)).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  return { store: { load: async () => saved, save: async (next: ConnectorSession) => { saved = next; } }, current: () => saved };
}
const status = () => Response.json({ state: 'active', agent: { id: 'agent_cancel' }, inboxId: 'inbox_cancel' });
const tokens = () => Response.json({ agentApiToken: 'synthetic-next-access', agentRefreshToken: 'synthetic-next-refresh',
  agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
function heldFetch(signal?: AbortSignal | null) {
  const response = deferred<Response>();
  const promise = new Promise<Response>((resolve, reject) => {
    const abort = () => reject(signal?.reason);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    response.promise.then(value => { signal?.removeEventListener('abort', abort); resolve(value); });
  });
  return { promise, release: response.resolve };
}
async function promptly<T>(pending: Promise<T>) {
  return Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 250))]);
}

describe('status cancellation and shared credential refresh', () => {
  it('does not send status or refresh for an already cancelled caller', async () => {
    const f = fixture(true), fetcher = vi.fn<typeof fetch>();
    const connector = new EnvoiConnector('https://envoi.example', f.store, { fetch: fetcher });
    const owner = new AbortController(); owner.abort();
    await expect(connector.checkStatus(owner.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['expired', '401'] as const)('cancels %s refresh and preserves its rotation ID for recovery', async mode => {
    const f = fixture(mode === 'expired'), entered = deferred<void>();
    let transport: AbortSignal | null | undefined, held: ReturnType<typeof heldFetch>;
    let first = true;
    const rotationIds: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/api/agent-token')) {
        rotationIds.push(JSON.parse(String(init?.body)).rotationId);
        if (first) {
          first = false; transport = init?.signal; held = heldFetch(transport); entered.resolve(); return held.promise;
        }
        return tokens();
      }
      if (mode === '401' && first) return Response.json({ code: 'ACCESS_TOKEN_EXPIRED' }, { status: 401 });
      return status();
    });
    const connector = new EnvoiConnector('https://envoi.example', f.store, { fetch: fetcher });
    const owner = new AbortController(), pending = connector.checkStatus(owner.signal).catch(error => error);
    await entered.promise; owner.abort();
    try {
      expect(await promptly(pending)).toMatchObject({ code: 'REQUEST_CANCELLED' });
      expect(transport?.aborted).toBe(true);
      expect(f.current().pendingRotation?.rotationId).toBe(rotationIds[0]);
      expect(f.current().lifecycle?.state).not.toBe('DEGRADED');
      await connector.checkStatus();
      expect(rotationIds).toEqual([rotationIds[0], rotationIds[0]]);
      expect(f.current().agentRefreshToken).toBe('synthetic-next-refresh');
      expect(f.current().pendingRotation).toBeUndefined();
    } finally { held!.release(tokens()); await pending; }
  });

  it('does not abort a shared refresh still needed by another status caller', async () => {
    const f = fixture(true), entered = deferred<void>();
    let transport: AbortSignal | null | undefined, held: ReturnType<typeof heldFetch>;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/api/agent-token')) {
        transport = init?.signal; held = heldFetch(transport); entered.resolve(); return held.promise;
      }
      return status();
    });
    const connector = new EnvoiConnector('https://envoi.example', f.store, { fetch: fetcher });
    const owner = new AbortController(), cancelled = connector.checkStatus(owner.signal).catch(error => error);
    await entered.promise;
    // This caller has no cancellation signal and must retain the shared rotation.
    const other = connector.checkStatus();
    await new Promise(resolve => setTimeout(resolve, 0));
    owner.abort();
    try {
      expect(await promptly(cancelled)).toMatchObject({ code: 'REQUEST_CANCELLED' });
      expect(transport?.aborted).toBe(false);
      held!.release(tokens());
      await other;
      expect(f.current().agentRefreshToken).toBe('synthetic-next-refresh');
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/agent-token'))).toHaveLength(1);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/agent/status'))).toHaveLength(1);
    } finally { held!.release(tokens()); await Promise.all([cancelled, other]); }
  });

  it('aborts a shared refresh when every caller cancels', async () => {
    const f = fixture(true), entered = deferred<void>();
    let transport: AbortSignal | null | undefined, held: ReturnType<typeof heldFetch>;
    const connector = new EnvoiConnector('https://envoi.example', f.store, { fetch: async (_url, init) => {
      transport = init?.signal; held = heldFetch(transport); entered.resolve(); return held.promise;
    } });
    const a = new AbortController(), b = new AbortController();
    const first = connector.checkStatus(a.signal).catch(error => error);
    await entered.promise;
    const second = connector.checkStatus(b.signal).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    a.abort(); b.abort();
    try {
      const results = await promptly(Promise.all([first, second]));
      expect(results).toMatchObject([{ code: 'REQUEST_CANCELLED' }, { code: 'REQUEST_CANCELLED' }]);
      expect(transport?.aborted).toBe(true);
      expect(f.current().pendingRotation).toBeDefined();
    } finally { held!.release(tokens()); await Promise.all([first, second]); }
  });

  it('persists an already received successor when its caller cancels during the save', async () => {
    const f = fixture(true), saving = deferred<void>(), finishSave = deferred<void>();
    const store = { load: f.store.load, save: async (next: ConnectorSession) => {
      if (next.agentRefreshToken === 'synthetic-next-refresh') { saving.resolve(); await finishSave.promise; }
      await f.store.save(next);
    } };
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/api/agent-token') ? tokens() : status());
    const connector = new EnvoiConnector('https://envoi.example', store, { fetch: fetcher });
    const owner = new AbortController(), pending = connector.checkStatus(owner.signal).catch(error => error);
    await saving.promise; owner.abort();
    try {
      expect(await promptly(pending)).toMatchObject({ code: 'REQUEST_CANCELLED' });
    } finally { finishSave.resolve(); await pending; }
    await connector.checkStatus();
    expect(f.current().agentRefreshToken).toBe('synthetic-next-refresh');
    expect(f.current().pendingRotation).toBeUndefined();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/agent-token'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/agent/status'))).toHaveLength(1);
  });
});
