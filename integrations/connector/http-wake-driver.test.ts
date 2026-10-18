import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type CaseSessionWorkHandler, type ConnectorSession, type ConnectorOptions } from '../../sdk/typescript/src/connector';
import type { WakeState, WakeStore } from './http-wake-receiver';
import { createScopedWakeHost } from './http-wake-driver';

const origin = 'https://envoi.example';
const registeredUrl = 'https://hooks.example.com/envoi/wake';
const identity = { agentId: 'agent_example', installationId: 'installation_example', inboxId: 'inbox_example' };
const clock = Date.parse('2026-10-17T12:01:03Z');

interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

interface Fixture {
  response?: FixtureResponse;
  steps?: { request?: { path: string }; response?: FixtureResponse }[];
}

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(new URL(`../../test/contract-fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
}

async function fixtureResponse(name: string): Promise<FixtureResponse> {
  const response = (await fixture(name)).response;
  if (!response) throw new Error(`Missing fixture response: ${name}`);
  return response;
}

function respond(response: FixtureResponse): Response {
  return Response.json(structuredClone(response.body), { status: response.status, headers: response.headers });
}

function privateMemoryStore(): WakeStore {
  let saved: WakeState = { version: 1, subscriptions: {}, accepted: {}, endedReasons: {} };
  let writes = Promise.resolve();
  return {
    read: async () => { await writes; return structuredClone(saved); },
    update: mutate => {
      const operation = writes.then(() => {
        const next = structuredClone(saved);
        mutate(next);
        saved = next;
      });
      writes = operation.catch(() => {});
      return operation;
    }
  };
}

async function setup(mode: 'scoped' | 'legacy' | 'none' = 'scoped') {
  const status = await fixtureResponse('case-session/agent-status-case-sessions');
  status.body.httpWake = { available: false, version: 1, subscription: null };
  const idle = await fixtureResponse('a4-wake/claim-idle-next-available');
  const routes = new Map<string, () => Response>([
    ['/api/agent/status', () => respond(status)],
    ['/api/agent/work/claim', () => respond(idle)]
  ]);
  const requests: { url: string; options?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    requests.push({ url, options });
    if (new URL(url).origin !== origin) throw new Error('Unexpected service origin');
    const route = routes.get(new URL(url).pathname);
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route();
  });
  let credentials: ConnectorSession = {
    agentId: identity.agentId, inboxId: identity.inboxId, address: 'example@envoi.mail', cursor: null,
    agentApiToken: 'private-access-test', agentRefreshToken: 'private-refresh-test',
    agentTokenExpiresAt: new Date(clock + 3_600_000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(clock + 86_400_000).toISOString()
  };
  const handler = {
    admit: vi.fn<CaseSessionWorkHandler['admit']>().mockResolvedValue(undefined),
    process: vi.fn<CaseSessionWorkHandler['process']>().mockResolvedValue(undefined)
  };
  const legacy = { admit: vi.fn(async () => {}), process: vi.fn(async () => {}) };
  const options: ConnectorOptions = {
    fetch: fetcher as typeof fetch,
    ...(mode === 'scoped' ? { caseSessionHandler: handler } : mode === 'legacy' ? { handler: legacy } : {})
  };
  const connector = new EnvoiConnector(origin, {
    load: async () => structuredClone(credentials),
    save: async saved => { credentials = structuredClone(saved); }
  }, options);
  const store = privateMemoryStore();
  const create = () => createScopedWakeHost({ connector, store, origin, identity, registeredUrl });
  return { connector, store, handler, legacy, options, status, idle, routes, fetcher, requests, create };
}

async function canonicalWork(scenario: Awaited<ReturnType<typeof setup>>, suffix = 'example') {
  const flow = await fixture('http-wake/wake-then-claim-and-mint');
  const claim = flow.steps?.find(step => step.request?.path === '/api/agent/work/claim')?.response;
  const minted = flow.steps?.find(step => step.request?.path === '/api/agent/work/msg_example/session')?.response;
  if (!claim || !minted) throw new Error('Missing approved claim-to-session fixture steps');
  const ended = await fixtureResponse('case-session/session-end');
  const workId = `msg_${suffix}`;
  const caseId = `case_${suffix}`;
  const sessionId = `case_session_${suffix}`;
  const work = claim.body.work as Record<string, unknown>;
  work.workId = workId;
  Object.assign(work.message as Record<string, unknown>, { id: workId, messageId: workId, caseId, conversationId: caseId });
  Object.assign(minted.body.session as Record<string, unknown>, { id: sessionId, workId, caseId });
  (minted.body.lease as Record<string, unknown>).workId = workId;
  (ended.body.session as Record<string, unknown>).id = sessionId;
  let claims = 0;
  scenario.routes.set('/api/agent/work/claim', () => respond(claims++ === 0 ? claim : scenario.idle));
  scenario.routes.set(`/api/agent/work/${workId}/acknowledge`, () => Response.json({ workId, status: 'acknowledged', receipt: { messageId: workId, state: 'acknowledged' } }));
  scenario.routes.set(`/api/agent/work/${workId}/session`, () => respond(minted));
  scenario.routes.set(`/api/agent/work/${workId}/session/end`, () => respond(ended));
  scenario.routes.set(`/api/agent/work/${workId}/complete`, () => Response.json({ workId, status: 'processed', receipt: { messageId: workId, state: 'processed' } }));
  return claim;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(clock); });
afterEach(() => { vi.useRealTimers(); });

describe('actual scoped connector wake binding', () => {
  it('constructs without network access and takes the frozen SDK capability directly', async () => {
    const scenario = await setup();
    const capability = vi.spyOn(scenario.connector, 'scopedWakeWorkDriver');
    const host = scenario.create();
    expect(capability).toHaveBeenCalledOnce();
    expect(Object.isFrozen(capability.mock.results[0].value)).toBe(true);
    expect(scenario.fetcher).not.toHaveBeenCalled();
    await host.poll();
    expect(scenario.requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/agent/status', '/api/agent/status', '/api/agent/work/claim'
    ]);
    expect(scenario.handler.admit).not.toHaveBeenCalled();
    expect(scenario.handler.process).not.toHaveBeenCalled();
    expect(capability.mock.results[0].value.nextAvailableInMs()).toBe(scenario.idle.body.nextAvailableInMs);
    await vi.advanceTimersByTimeAsync(5000);
    expect(capability.mock.results[0].value.nextAvailableInMs()).toBe(25_000);
    expect(JSON.stringify(scenario.requests)).not.toContain('private-refresh-test');
    expect(JSON.stringify(await scenario.store.read())).not.toContain('private-access-test');
  });

  it.each(['legacy', 'none'] as const)('rejects %s admission synchronously before network or handler execution', async mode => {
    const scenario = await setup(mode);
    expect(scenario.create).toThrowError(expect.objectContaining({ code: 'SCOPED_HANDLER_REQUIRED' }));
    expect(scenario.fetcher).not.toHaveBeenCalled();
    expect(scenario.legacy.process).not.toHaveBeenCalled();
  });

  it('does not accept a hand-written driver-shaped object as a connector', async () => {
    const scenario = await setup();
    const impostor = { scopedWakeWorkDriver: vi.fn() };
    expect(() => createScopedWakeHost({ connector: impostor as unknown as EnvoiConnector, store: scenario.store, origin, identity, registeredUrl })).toThrow('EnvoiConnector instance');
    expect(impostor.scopedWakeWorkDriver).not.toHaveBeenCalled();
    expect(scenario.fetcher).not.toHaveBeenCalled();
  });

  it('refuses an origin different from the actual connector before network access', async () => {
    const scenario = await setup();
    expect(() => createScopedWakeHost({ connector: scenario.connector, store: scenario.store, origin: 'https://other.example', identity, registeredUrl })).toThrow('origins must match');
    expect(scenario.fetcher).not.toHaveBeenCalled();
  });

  it.each(['agent', 'inbox', 'installation'] as const)('refuses a canonical status with the wrong %s before claiming', async changed => {
    const scenario = await setup();
    if (changed === 'agent') scenario.status.body.agent = { ...(scenario.status.body.agent as Record<string, unknown>), id: 'agent_other' };
    if (changed === 'inbox') scenario.status.body.inboxId = 'inbox_other';
    if (changed === 'installation') scenario.status.body.installation = { ...(scenario.status.body.installation as Record<string, unknown>), id: 'installation_other' };
    await expect(scenario.create().poll()).rejects.toThrow('identity changed');
    expect(scenario.requests.map(request => new URL(request.url).pathname)).toEqual(['/api/agent/status']);
    expect(scenario.handler.admit).not.toHaveBeenCalled();
  });

  it('fails closed when the selected server has no approved case-session transport', async () => {
    const scenario = await setup();
    scenario.status.body.caseSessions = { available: false, version: 1 };
    await expect(scenario.create().poll()).resolves.toBeUndefined();
    expect(scenario.requests.some(request => request.url.endsWith('/api/agent/work/claim'))).toBe(false);
    expect(scenario.handler.process).not.toHaveBeenCalled();
  });

  it('honors the actual idle claim hint in the host scheduler', async () => {
    const scenario = await setup();
    const stop = new AbortController();
    const running = scenario.create().run(stop.signal, 60_000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scenario.requests.filter(request => request.url.endsWith('/api/agent/work/claim'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(scenario.requests.filter(request => request.url.endsWith('/api/agent/work/claim'))).toHaveLength(2);
    } finally {
      stop.abort();
      await running;
    }
  });

  it('does not retry a background claim 429 early when an older idle hint is already due', async () => {
    const scenario = await setup();
    const limited = await fixtureResponse('a3-pause-auth/rate-limited');
    const retryAfterMs = Number(limited.body.retryAfterSeconds) * 1000;
    const hintMs = Number(scenario.idle.body.nextAvailableInMs);
    let claims = 0;
    scenario.routes.set('/api/agent/work/claim', () => respond(claims++ === 1 ? limited : scenario.idle));
    const stop = new AbortController();
    const running = scenario.create().run(stop.signal, 60_000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(1);
      await vi.advanceTimersByTimeAsync(hintMs);
      expect(claims).toBe(2);
      await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
      expect(claims).toBe(2);
      expect(scenario.handler.process).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(claims).toBe(3);
      const claimRequests = scenario.requests.filter(request => request.url.endsWith('/api/agent/work/claim'));
      expect(claimRequests).toHaveLength(3);
      expect(claimRequests[2].options?.body).toBe(claimRequests[1].options?.body);
      expect(scenario.requests.some(request => request.url.endsWith('/api/agent-token'))).toBe(false);
    } finally {
      stop.abort();
      await running;
    }
  });

  it('routes one canonical claim through scoped admission, mint, session end, and fenced completion', async () => {
    const scenario = await setup();
    await canonicalWork(scenario);
    let modelContext: unknown;
    scenario.handler.process.mockImplementation(async channel => {
      modelContext = channel.modelContext();
      expect(channel.modelContext().allowedTools).toContain('envoi_case_snapshot');
    });
    await scenario.create().poll();
    expect(scenario.handler.admit).toHaveBeenCalledOnce();
    expect(scenario.handler.process).toHaveBeenCalledOnce();
    const [, context] = scenario.handler.process.mock.calls[0];
    expect(context.workId).toBe('msg_example');
    expect(JSON.stringify(modelContext)).not.toMatch(/private-access-test|private-refresh-test|lease_PLACEHOLDER|envoi_case_session_/);
    expect(scenario.legacy.process).not.toHaveBeenCalled();
    const paths = scenario.requests.map(request => new URL(request.url).pathname);
    expect(paths.indexOf('/api/agent/work/msg_example/acknowledge')).toBeLessThan(paths.indexOf('/api/agent/work/msg_example/session'));
    expect(paths).toContain('/api/agent/work/msg_example/complete');
    expect(paths.at(-1)).toBe('/api/agent/work/claim');
    expect(paths).not.toContain('/mcp');
    expect(paths).not.toContain('/api/agent-token');
  });

  it('continues to different canonical work after a case-local authority cancellation without settling the cancelled work', async () => {
    const scenario = await setup();
    const cancelled = await canonicalWork(scenario);
    const next = await canonicalWork(scenario, 'next');
    const controlled = await fixtureResponse('case-session/mint-case-controlled');
    scenario.routes.set('/api/agent/work/msg_example/session', () => respond(controlled));
    let claims = 0;
    scenario.routes.set('/api/agent/work/claim', () => respond([cancelled, next][claims++] ?? scenario.idle));
    await scenario.create().poll();
    expect(scenario.handler.admit).toHaveBeenCalledTimes(2);
    expect(scenario.handler.process).toHaveBeenCalledOnce();
    expect(scenario.handler.process.mock.calls[0][1].workId).toBe('msg_next');
    const paths = scenario.requests.map(request => new URL(request.url).pathname);
    expect(paths).not.toContain('/api/agent/work/msg_example/complete');
    expect(paths).not.toContain('/api/agent/work/msg_example/fail');
    expect(paths).toContain('/api/agent/work/msg_next/complete');
    expect(paths.filter(path => path === '/api/agent/work/claim')).toHaveLength(3);
    expect((await scenario.connector.lifecycle()).state).toBe('RUNNING');
  });

  it('keeps credential revocation terminal through the composed host with no subsequent network or enrollment', async () => {
    const scenario = await setup();
    const revoked = await fixtureResponse('http-wake/subscription-create-credential-revoked');
    scenario.routes.set('/api/agent/work/claim', () => respond(revoked));
    const host = scenario.create();
    await expect(host.poll()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect((await scenario.connector.lifecycle()).state).toBe('REVOKED');
    const requests = scenario.requests.length;
    await expect(host.poll()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(scenario.requests).toHaveLength(requests);
    expect(scenario.handler.admit).not.toHaveBeenCalled();
    expect(scenario.handler.process).not.toHaveBeenCalled();
    expect(scenario.requests.some(request => /enroll|agent-token/.test(request.url))).toBe(false);
  });
});
