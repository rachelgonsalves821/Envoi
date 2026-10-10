import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, enrollConnector, type ConnectorSession } from '../src/connector';
import { EnvoiError, responsePayload } from '../src/index';
import { lifecyclePolicy, retryDelay } from '../src/lifecycle';
import { loadContractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';
const contract = loadContractRegistry().contracts.find(c => c.id === 'a3-pause-auth')!;
const schemas = loadContractFixture(contract, contract.schemas!) as any;
const fixtures = contract.fixtures.map(p => loadContractFixture(contract, p) as any);
const fixture = (id: string) => fixtures.find(f => f.id === id)!;
const response = (f: any, status = f.response.status) => new Response(f.response.bodyText ?? JSON.stringify(f.response.body), { status, headers: f.response.headers });
function memory(initial?: Partial<ConnectorSession>) {
  let value: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'agent@example.test', cursor: null,
    agentApiToken: 'access', agentRefreshToken: 'refresh', agentTokenExpiresAt: new Date(Date.now()+3600000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now()+86400000).toISOString(), ...initial };
  return { load: async () => structuredClone(value), save: async (next: ConnectorSession) => { value = structuredClone(next); } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const handler = { admit: vi.fn(async () => {}), process: vi.fn(async () => {}) };
describe('approved A3 fixtures drive the shared connector lifecycle', () => {
  it.each(Object.entries(schemas['x-codes']))('matches the approved policy for %s independent of HTTP status', (code, policy: any) => {
    expect(lifecyclePolicy(new EnvoiError('display', 418, code))).toMatchObject({ lifecycle: policy.lifecycle, retry: policy.retry, guidance: policy.guidance });
    for (const [reason, guidance] of Object.entries(policy.guidanceByReason ?? {}))
      expect(lifecyclePolicy(new EnvoiError('display', 200, code, { reason })).guidance).toBe(guidance);
  });
  it.each(fixtures.filter(f => f.response?.schema === 'errorEnvelope'))('parses the display message and code from $id', async f => {
    await expect(responsePayload(response(f), 'fallback')).rejects.toMatchObject({ message: f.response.body.message, code: f.response.body.code });
  });
  it('does not revoke or refresh from an unknown 401', async () => {
    const store = memory(); const fetcher = vi.fn(async () => Response.json({ message: 'Unknown failure' }, { status: 401 }));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    await expect(c.pollOnce()).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await c.lifecycle()).state).not.toBe('REVOKED');
  });
  it.each(['refresh-replay', 'event-credential-ended'])('persists terminal %s and fences every operation after restart', async id => {
    const store = memory(); const fetcher = vi.fn(async () => Response.json({}));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler });
    const f = fixture(id);
    if (f.event) await c.observeEvent(f.event.data, f.event.event);
    else { let error: unknown; try { await responsePayload(response(f), 'fallback'); } catch (e) { error = e; } await c.observeError(error); }
    const restarted = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler });
    expect((await restarted.lifecycle()).state).toBe('REVOKED');
    for (const op of [() => restarted.currentAccessToken(), () => restarted.pollOnce(), () => restarted.processWorkOnce(),
      () => restarted.forwardMcpRequest('{}'), () => restarted.mintMcpReadToken()]) await expect(op()).rejects.toBeInstanceOf(EnvoiError);
    expect(fetcher).not.toHaveBeenCalled(); expect((await store.load()).cursor).toBeNull();
  });
  it('keeps paused reads and refresh but fences claims and MCP, then resumes from an event', async () => {
    const store = memory(); const fetcher = vi.fn(async () => Response.json({ events: [], hasMore: false, nextCursor: null }));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler });
    await c.observeEvent(fixture('event-agent-paused').event.data);
    await c.pollOnce(); expect(await c.processWorkOnce()).toBe(false);
    await expect(c.forwardMcpRequest('{}')).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
    expect(await c.currentAccessToken()).toBe('access'); expect((await c.lifecycle()).state).toBe('PAUSED');
    await c.observeEvent(fixture('event-agent-resumed').event.data); expect((await c.lifecycle()).state).toBe('RUNNING');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses paused claim state, not successful HTTP, to stop further claims', async () => {
    const store = memory(); const fetcher = vi.fn(async () => response(fixture('paused-claim')));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler });
    expect(await c.processWorkOnce()).toBe(false); expect(await c.processWorkOnce()).toBe(false);
    expect((await c.lifecycle()).state).toBe('PAUSED'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shows update your connector for ROTATION_ID_REQUIRED and never enrolls', async () => {
    const store = memory(); const fetcher = vi.fn(async () => Response.json({ code: 'ROTATION_ID_REQUIRED', message: 'Rotation ID required' }, { status: 400 }));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    await expect(c.pollOnce()).rejects.toMatchObject({ code: 'ROTATION_ID_REQUIRED' });
    expect(await c.lifecycle()).toMatchObject({ state: 'NEEDS_RECONNECT', guidance: 'update your connector' });
    await expect(c.currentAccessToken()).rejects.toThrow('update your connector'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds jittered retry and respects the server floor', () => {
    expect(retryDelay(1, 0)).toBe(500); expect(retryDelay(100, 1)).toBe(30000);
    expect(retryDelay(1, 0, 90)).toBe(90000);
  });
  it('persists retry across restart without losing pause or rotation recovery', async () => {
    const store = memory(); const c = new EnvoiConnector('https://api.example', store);
    await c.observeEvent(fixture('event-agent-paused').event.data);
    await c.observeError(new EnvoiError('Busy', 418, 'RATE_LIMITED', { retryAfterSeconds: 90 }));
    expect(await new EnvoiConnector('https://api.example', store).lifecycle()).toMatchObject({ state: 'DEGRADED', paused: true, failures: 1 });
    expect(Date.parse((await c.lifecycle()).retryAt!)).toBeGreaterThanOrEqual(Date.now()+89000);
    expect(await c.processWorkOnce().catch(() => false)).toBe(false);
  });
  it('keeps reconnect enrollment paused', async () => {
    const store = memory(); const f = fixture('reconnect-while-paused');
    const saved = await enrollConnector('https://api.example', 'explicit-reconnect', store, { fetch: vi.fn(async () => response(f)) });
    expect(saved.lifecycle).toMatchObject({ state: 'PAUSED', paused: true });
  });
});

const futureTokens = () => ({ agentApiToken: 'new-access', agentRefreshToken: 'new-refresh',
  agentTokenExpiresAt: new Date(Date.now()+3600000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now()+86400000).toISOString() });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
describe('lifecycle request and work races', () => {
  it.each(fixtures.filter(f => f.response?.schema === 'errorEnvelope'))('applies $id through the real request path', async f => {
    const store = memory();
    const fetcher = vi.fn(async (input: any) => {
      if (String(input).endsWith('/api/agent-token')) return Response.json(futureTokens());
      if (fetcher.mock.calls.filter(args => !String(args[0]).endsWith('/api/agent-token')).length === 1) return response(f, 418);
      return Response.json({ events: [], hasMore: false, nextCursor: null });
    });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    const policy = schemas['x-codes'][f.response.body.code];
    if (policy.retry === 'refresh_then_retry_once') { await c.pollOnce(); expect(fetcher).toHaveBeenCalledTimes(3); }
    else await expect(c.pollOnce()).rejects.toMatchObject({ code: f.response.body.code, message: f.response.body.message });
    const state = await c.lifecycle();
    if (!['UNCHANGED', 'NOT_APPLICABLE'].includes(policy.lifecycle)) expect(state.state).toBe(policy.lifecycle);
    if (policy.lifecycle === 'REVOKED' || policy.lifecycle === 'NEEDS_RECONNECT') {
      const calls = fetcher.mock.calls.length; await expect(c.currentAccessToken()).rejects.toBeInstanceOf(EnvoiError); expect(fetcher).toHaveBeenCalledTimes(calls);
    }
  });
  it.each(['agent.paused', 'credential.ended'])('aborts the live handler on %s and rejects late reply/settlement', async event => {
    const store = memory(); const started = deferred(); const release = deferred();
    let workSignal!: AbortSignal;
    const fetcher = vi.fn(async (input: any) => {
      if (String(input).endsWith('/claim')) {
        const payload = structuredClone(fixture('claimed-work').response.body);
        payload.work.leaseExpiresAt = new Date(Date.now()+60000).toISOString(); return Response.json(payload);
      }
      if (String(input).endsWith('/acknowledge')) return Response.json({ workId: 'msg_example', status: 'acknowledged', receipt: { messageId: 'msg_example', state: 'acknowledged' } });
      throw new Error('Forbidden late request: ' + input);
    });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler: { admit: async () => {}, process: async (_, ctx) => {
      workSignal = ctx.signal; started.resolve(); await release.promise;
      await expect(ctx.reply('Too late', 'stable-reply')).rejects.toThrow('lease');
    } } });
    const work = c.processWorkOnce().then(() => null, error => error);
    await started.promise;
    await c.observeEvent(event === 'agent.paused' ? fixture('event-agent-paused').event.data : fixture('event-credential-ended').event.data, event);
    expect(workSignal.aborted).toBe(true); release.resolve(); expect(await work).toBeInstanceOf(EnvoiError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await c.lifecycle()).state).toBe(event === 'agent.paused' ? 'PAUSED' : 'REVOKED');
  });
  it.each(['agent.paused', 'credential.ended'])('preserves %s when an in-flight refresh ignores abort and returns late', async event => {
    const store = memory({ agentTokenExpiresAt: new Date(Date.now()-1000).toISOString() });
    const sent = deferred<AbortSignal>(); const returned = deferred<Response>();
    const fetcher = vi.fn(async (_: any, init?: RequestInit) => { sent.resolve(init!.signal!); return returned.promise; });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    const pending = c.currentAccessToken().then(value => value, error => error);
    const signal = await sent.promise;
    await c.observeEvent(event === 'agent.paused' ? fixture('event-agent-paused').event.data : fixture('event-credential-ended').event.data, event);
    expect(signal.aborted).toBe(event === 'credential.ended'); returned.resolve(Response.json(futureTokens()));
    const result = await pending;
    if (event === 'agent.paused') { expect(result).toBe('new-access'); expect((await store.load()).pendingRotation).toBeUndefined(); }
    else { expect(result).toBeInstanceOf(EnvoiError); expect((await store.load()).agentRefreshToken).toBe('refresh'); expect((await store.load()).pendingRotation).toBeDefined(); }
    expect((await c.lifecycle()).state).toBe(event === 'agent.paused' ? 'PAUSED' : 'REVOKED');
  });
  it('bounds access-expiry refresh to one attempt', async () => {
    const store = memory(); const fetcher = vi.fn(async (url: any) => String(url).endsWith('/api/agent-token') ? Response.json(futureTokens()) : response(fixture('access-token-expired')));
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    await expect(c.pollOnce()).rejects.toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not turn a controlled case into an agent pause or send fail settlement', async () => {
    const store = memory(); const fetcher = vi.fn(async (url: any) => {
      if (String(url).endsWith('/claim')) { const body = structuredClone(fixture('claimed-work').response.body); body.work.leaseExpiresAt = new Date(Date.now()+60000).toISOString(); return Response.json(body); }
      return response(fixture('case-controlled'));
    });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler });
    await expect(c.processWorkOnce()).rejects.toMatchObject({ code: 'CASE_CONTROLLED' });
    expect((await c.lifecycle()).paused).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('claims immediately on resume without waiting for work.available or the safety interval', async () => {
    vi.useFakeTimers(); const store = memory(); const stop = new AbortController();
    const fetcher = vi.fn(async (url: any) => {
      if (String(url).endsWith('/claim')) { stop.abort(); return response(fixture('idle-claim')); }
      return Response.json({ events: [], hasMore: false, nextCursor: null });
    });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler, pollIntervalMs: 60000 });
    await c.observeEvent(fixture('event-agent-paused').event.data);
    const running = c.run(stop.signal);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(1);
    await c.observeEvent(fixture('event-agent-resumed').event.data);
    await vi.advanceTimersByTimeAsync(1); await running;
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/claim'))).toBe(true);
    expect((await c.lifecycle()).state).toBe('STOPPED');
  });
  it('waits for a persisted rate-limit deadline after restart', async () => {
    vi.useFakeTimers(); const store = memory(); const c = new EnvoiConnector('https://api.example', store);
    await c.observeError(new EnvoiError('Busy', 429, 'RATE_LIMITED', { retryAfterSeconds: 5 }));
    const stop = new AbortController(); const fetcher = vi.fn(async () => { stop.abort(); return Response.json({ events: [], hasMore: false, nextCursor: null }); });
    const restarted = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    const running = restarted.run(stop.signal);
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await running; expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown and durable recovery boundaries', () => {
  it('preserves a retry deadline across an interrupted wait and a second restart', async () => {
    vi.useFakeTimers(); const store = memory(); const c = new EnvoiConnector('https://api.example', store);
    await c.observeError(new EnvoiError('Busy', 429, 'RATE_LIMITED', { retryAfterSeconds: 10 }));
    const firstStop = new AbortController(); const fetcher = vi.fn(async () => Response.json({ events: [], hasMore: false, nextCursor: null }));
    const running = new EnvoiConnector('https://api.example', store, { fetch: fetcher }).run(firstStop.signal);
    await vi.advanceTimersByTimeAsync(1000); firstStop.abort(); await running;
    expect((await c.lifecycle()).state).toBe('STOPPED'); expect((await c.lifecycle()).retryAt).toBeDefined();
    const secondStop = new AbortController(); const restarted = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    const secondRun = restarted.run(secondStop.signal); await vi.advanceTimersByTimeAsync(8999); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(1); secondStop.abort(); await secondRun;
  });
  it('requires owner reconnect after long offline expiry and retains pause', async () => {
    const store = memory({ agentTokenExpiresAt: new Date(Date.now()-1000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now()-1000).toISOString() });
    const fetcher = vi.fn(); const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
    await c.observeEvent(fixture('event-agent-paused').event.data);
    await expect(c.currentAccessToken()).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' });
    expect(await c.lifecycle()).toMatchObject({ state: 'NEEDS_RECONNECT', paused: true }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed if terminal state cannot be persisted, including concurrent MCP calls', async () => {
    const store = memory(); const failing = { load: store.load, save: vi.fn(async () => { throw new Error('private path'); }) };
    const fetcher = vi.fn(); const c = new EnvoiConnector('https://api.example', failing, { fetch: fetcher, handler });
    await expect(c.observeEvent(fixture('event-credential-ended').event.data, 'credential.ended')).rejects.toThrow('persistence failed');
    for (const operation of [() => c.currentAccessToken(), () => c.processWorkOnce(), () => c.forwardMcpRequest('{}')])
      await expect(operation()).rejects.toThrow('persistence failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['network', 'html-5xx'])('uses bounded outage retry for %s without treating auth HTTP statuses as lifecycle codes', async kind => {
    const store = memory(); const fetcher = vi.fn(async () => { if (kind === 'network') throw new TypeError('fetch failed'); return response(fixture('edge-unavailable')); });
    const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher }); await expect(c.pollOnce()).rejects.toBeInstanceOf(EnvoiError);
    expect(await c.lifecycle()).toMatchObject({ state: 'DEGRADED', failures: 1 });
  });
});

it('does not mistake a locally aborted native write for an outage', async () => {
  const store = memory(); const sent = deferred();
  const fetcher = vi.fn(async (_: any, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); sent.resolve();
  }));
  const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher });
  const operation = c.startCase('stable-key', { caseId: 'case_example', recipientEmail: 'peer@example.test', text: 'Hello' }).then(() => null, error => error);
  await sent.promise; await c.observeEvent(fixture('event-agent-paused').event.data);
  expect(await operation).toMatchObject({ code: 'AGENT_PAUSED' }); expect((await c.lifecycle()).state).toBe('PAUSED');
});
it('never settles an interrupted old lease after a rapid pause and resume', async () => {
  const store = memory(); const started = deferred(); const release = deferred();
  const fetcher = vi.fn(async (input: any) => {
    if (String(input).endsWith('/claim')) { const body = structuredClone(fixture('claimed-work').response.body); body.work.leaseExpiresAt = new Date(Date.now()+60000).toISOString(); return Response.json(body); }
    if (String(input).endsWith('/acknowledge')) return Response.json({ workId: 'msg_example', status: 'acknowledged', receipt: { messageId: 'msg_example', state: 'acknowledged' } });
    throw new Error('Forbidden stale lease settlement');
  });
  const c = new EnvoiConnector('https://api.example', store, { fetch: fetcher, handler: { admit: async () => {}, process: async () => { started.resolve(); await release.promise; } } });
  const work = c.processWorkOnce().then(() => null, error => error); await started.promise;
  await c.observeEvent(fixture('event-agent-paused').event.data); await c.observeEvent(fixture('event-agent-resumed').event.data);
  release.resolve(); expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(fetcher).toHaveBeenCalledTimes(2);
});
