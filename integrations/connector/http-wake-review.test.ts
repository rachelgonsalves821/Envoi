import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { EnvoiWakeHostTransport, HttpWakeHost, type WakeAvailability, type WakeSubscription } from './http-wake-host';
import type { WakeNotification, WakeState, WakeStore } from './http-wake-receiver';

const identity = { agentId: 'agent_example', installationId: 'installation_example', inboxId: 'inbox_example' };
const origin = 'https://envoi.example';
const receiverUrl = 'https://hooks.example.com/envoi/wake';
const clock = Date.parse('2026-10-17T12:00:00Z');

interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function canonicalResponse(name: string): Promise<FixtureResponse> {
  const fixture = JSON.parse(await readFile(new URL(`../../test/contract-fixtures/http-wake/${name}.json`, import.meta.url), 'utf8')) as {
    response?: FixtureResponse;
    steps?: { response?: FixtureResponse }[];
  };
  const response = fixture.response ?? fixture.steps?.find(step => step.response)?.response;
  if (!response) throw new Error(`Missing canonical response: ${name}`);
  return response;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

function authenticated(fetcher: typeof fetch, binding = identity) {
  let saved: ConnectorSession = {
    agentId: binding.agentId, inboxId: binding.inboxId, address: 'example@envoi.mail', cursor: null,
    agentApiToken: 'private-test-token', agentRefreshToken: 'private-test-refresh',
    agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
  };
  return new EnvoiConnector(origin, {
    load: async () => structuredClone(saved),
    save: async session => { saved = structuredClone(session); }
  }, { fetch: fetcher });
}

function memoryStore(): WakeStore {
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

function subscription(patch: Partial<WakeSubscription> = {}): WakeSubscription {
  return {
    id: 'wake_sub_example', agentId: identity.agentId, installationId: identity.installationId,
    url: receiverUrl, status: 'active', endedReason: null, expiresAt: '2026-10-18T12:00:00Z',
    replacesSubscriptionId: null, ...patch
  };
}

function setup() {
  const store = memoryStore();
  const transport = {
    identity,
    status: vi.fn(async (): Promise<{ paused: boolean; wake: WakeAvailability | null }> => ({
      paused: false, wake: { available: true, version: 1, subscription: subscription() }
    })),
    list: vi.fn(async (): Promise<WakeSubscription[]> => [subscription()]),
    create: vi.fn(async () => subscription({ id: 'wake_sub_next', status: 'pending', expiresAt: null, replacesSubscriptionId: 'wake_sub_example' })),
    activate: vi.fn(async () => subscription()),
    end: vi.fn(async () => subscription({ status: 'ended', endedReason: 'ended_by_host' }))
  };
  const driver = {
    processWorkOnce: vi.fn(async (): Promise<boolean> => false),
    revalidateLiveLeases: vi.fn(async () => {})
  };
  const host = new HttpWakeHost(transport, store, driver, receiverUrl, () => clock);
  return { store, transport, driver, host };
}

async function accept(store: WakeStore, notification: WakeNotification) {
  await store.update(state => {
    state.subscriptions[notification.subscriptionId] = { url: receiverUrl, status: 'active', installationId: identity.installationId };
    state.accepted[notification.id] = { receivedAt: clock, expiresAt: clock + 3_900_000, pending: true, acknowledged: true, notification };
  });
}

async function flushCallbacks() {
  for (let turn = 0; turn < 60; turn++) await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); });

describe('independent wake review regressions', () => {
  it('does not dispatch durable accepted work until the verified response has finished', async () => {
    const scenario = setup();
    const identifier = 'wake_evt_review_unflushed_hint';
    await accept(scenario.store, { version: 1, type: 'wake.work_available', id: identifier, subscriptionId: 'wake_sub_example' });
    await scenario.store.update(state => { state.accepted[identifier].acknowledged = false; });
    await scenario.host.dispatchPending();
    expect(scenario.driver.processWorkOnce).not.toHaveBeenCalled();
    expect((await scenario.store.read()).accepted[identifier].pending).toBe(true);
    await scenario.host.acknowledge(identifier);
    await scenario.host.dispatchPending();
    expect(scenario.driver.processWorkOnce).toHaveBeenCalledOnce();
    expect((await scenario.store.read()).accepted[identifier].pending).toBe(false);
  });

  it.each([receiverUrl, 'https://old-hooks.example.com/envoi/wake'])('remembers a hidden owner-revoked replacement at %s, including after restart', async revokedUrl => {
    const response = await canonicalResponse('subscription-revoked-by-owner');
    const revoked = subscription({
      ...(response.body.subscription as WakeSubscription),
      id: 'wake_sub_next', agentId: identity.agentId, installationId: identity.installationId,
      url: revokedUrl, replacesSubscriptionId: 'wake_sub_example'
    });
    const scenario = setup();
    await scenario.store.update(state => {
      state.subscriptions.wake_sub_next = { url: revokedUrl, status: 'pending', installationId: identity.installationId };
    });
    scenario.transport.list.mockResolvedValue([revoked, subscription()]);
    await scenario.host.maintain();
    expect(scenario.transport.create).not.toHaveBeenCalled();
    expect((await scenario.store.read()).endedReasons[identity.installationId]).toBe('revoked_by_owner');
    scenario.transport.status.mockResolvedValue({ paused: false, wake: { available: true, version: 1, subscription: null } });
    scenario.transport.list.mockResolvedValue([]);
    await new HttpWakeHost(scenario.transport, scenario.store, scenario.driver, receiverUrl, () => clock).maintain();
    expect(scenario.transport.create).not.toHaveBeenCalled();
  });

  it('does not resurrect or replace a locally ended subscription from a delayed list snapshot', async () => {
    const scenario = setup();
    await scenario.store.update(state => {
      state.subscriptions.wake_sub_example = { url: receiverUrl, status: 'active', installationId: identity.installationId };
    });
    const listed = deferred<WakeSubscription[]>();
    const listing = deferred<void>();
    scenario.transport.list.mockImplementationOnce(() => { listing.resolve(); return listed.promise; });
    const maintenance = scenario.host.maintain();
    await listing.promise;
    try { await scenario.host.endSubscription('wake_sub_example'); }
    finally { listed.resolve([subscription()]); }
    await maintenance;
    const state = await scenario.store.read();
    expect(state.endedReasons[identity.installationId]).toBe('ended_by_host');
    expect(state.subscriptions.wake_sub_example).toBeUndefined();
    expect(scenario.transport.create).not.toHaveBeenCalled();
  });

  it('keeps canonical safety claims working after rollback with a durable challenge pending', async () => {
    const response = await canonicalResponse('rollback-flag-off');
    const scenario = setup();
    scenario.transport.status.mockResolvedValue({ paused: false, wake: response.body.httpWake as unknown as WakeAvailability });
    scenario.transport.activate.mockRejectedValue(new EnvoiError('Disabled', 404, 'FEATURE_DISABLED'));
    await accept(scenario.store, {
      version: 1, type: 'wake.challenge', id: 'wake_evt_review_challenge', subscriptionId: 'wake_sub_example',
      challenge: `envoi_wake_challenge_${'a'.repeat(43)}`, expiresAt: '2026-10-17T12:10:00Z'
    });
    await scenario.host.poll();
    await flushCallbacks();
    expect(scenario.transport.activate).not.toHaveBeenCalled();
    expect(scenario.driver.processWorkOnce).toHaveBeenCalled();
    expect(scenario.transport.create).not.toHaveBeenCalled();
  });

  it('revalidates a control wake without waiting for blocked work to finish', async () => {
    const scenario = setup();
    const released = deferred<boolean>();
    const started = deferred<void>();
    scenario.driver.processWorkOnce.mockImplementationOnce(() => { started.resolve(); return released.promise; });
    await accept(scenario.store, { version: 1, type: 'wake.work_available', id: 'wake_evt_review_work_hint', subscriptionId: 'wake_sub_example' });
    const work = scenario.host.dispatchPending();
    await started.promise;
    let control: Promise<void> | undefined;
    try {
      await accept(scenario.store, { version: 1, type: 'wake.control_changed', id: 'wake_evt_review_control_hint', subscriptionId: 'wake_sub_example', reason: 'case_controlled' });
      control = scenario.host.dispatchPending();
      await flushCallbacks();
      expect(scenario.driver.revalidateLiveLeases).toHaveBeenCalledOnce();
      expect(scenario.driver.processWorkOnce).toHaveBeenCalledOnce();
    } finally {
      released.resolve(false);
      await Promise.all([work, control]);
    }
  });

  it('preserves safety claims when feature disable races with challenge activation', async () => {
    const response = await canonicalResponse('subscription-create-feature-disabled');
    const scenario = setup();
    scenario.transport.list.mockResolvedValue([subscription({ expiresAt: '2026-11-16T12:00:00Z' })]);
    scenario.transport.activate.mockRejectedValue(new EnvoiError('Disabled', response.status, response.body.code as string));
    await accept(scenario.store, {
      version: 1, type: 'wake.challenge', id: 'wake_evt_review_disable_race', subscriptionId: 'wake_sub_example',
      challenge: `envoi_wake_challenge_${'a'.repeat(43)}`, expiresAt: '2026-10-17T12:10:00Z'
    });
    await scenario.host.poll();
    await flushCallbacks();
    expect(scenario.transport.activate).toHaveBeenCalledOnce();
    expect(scenario.driver.processWorkOnce).toHaveBeenCalled();
    expect((await scenario.store.read()).accepted.wake_evt_review_disable_race.pending).toBe(false);
  });

  it('honors the canonical 600-second create limit without retrying subscription creation early', async () => {
    const response = await canonicalResponse('subscription-create-rate-limited');
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    const scenario = setup();
    scenario.transport.create.mockRejectedValueOnce(new EnvoiError('Limited', response.status, response.body.code as string, {
      reason: response.body.reason as string, retryAfterSeconds: response.body.retryAfterSeconds as number
    }));
    const stop = new AbortController();
    const host = new HttpWakeHost(scenario.transport, scenario.store, scenario.driver, receiverUrl, Date.now);
    const running = host.run(stop.signal, 60_000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scenario.transport.create).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(599_999);
      expect(scenario.transport.create).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(scenario.transport.create).toHaveBeenCalledTimes(2);
    } finally {
      stop.abort();
      await running;
    }
  });

  it('reads safety status within 900 seconds while model work remains blocked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    const scenario = setup();
    scenario.transport.list.mockResolvedValue([subscription({ expiresAt: '2026-11-16T12:00:00Z' })]);
    const released = deferred<boolean>();
    scenario.driver.processWorkOnce.mockImplementationOnce(() => released.promise);
    const stop = new AbortController();
    const host = new HttpWakeHost(scenario.transport, scenario.store, scenario.driver, receiverUrl, Date.now);
    const running = host.run(stop.signal, 60_000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scenario.driver.processWorkOnce).toHaveBeenCalledOnce();
      const initialReads = scenario.transport.status.mock.calls.length;
      await vi.advanceTimersByTimeAsync(900_000);
      expect(scenario.transport.status.mock.calls.length).toBeGreaterThan(initialReads);
      expect(scenario.driver.processWorkOnce).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      released.resolve(false);
      await running;
    }
  });

  it('rejects an installation change even when an older server omits httpWake', async () => {
    const response = await canonicalResponse('agent-status-http-wake');
    const body = structuredClone(response.body);
    delete body.httpWake;
    body.installation = { ...(body.installation as Record<string, unknown>), id: 'installation_other' };
    const fetcher = vi.fn(async () => Response.json(body));
    const transport = new EnvoiWakeHostTransport(origin, identity, authenticated(fetcher as typeof fetch));
    await expect(transport.status()).rejects.toThrow();
  });

  it.each([
    'subscription-create-rate-limited',
    'subscription-create-credential-revoked',
    'subscription-activate-challenge-expired'
  ])('preserves the canonical error envelope for %s', async name => {
    const response = await canonicalResponse(name);
    expect(response.body.code).toBe(response.body.error);
    const fetcher = vi.fn(async () => Response.json(response.body, { status: response.status, headers: response.headers }));
    const transport = new EnvoiWakeHostTransport(origin, identity, authenticated(fetcher as typeof fetch));
    const operation = name.startsWith('subscription-activate')
      ? transport.activate('wake_sub_example', `envoi_wake_challenge_${'a'.repeat(43)}`)
      : transport.create(receiverUrl);
    await expect(operation).rejects.toMatchObject({
      status: response.status, code: response.body.code, reason: response.body.reason,
      requestId: response.body.requestId,
      ...(response.body.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.body.retryAfterSeconds })
    });
  });

  it('accepts more than 32 canonical retained subscription records', async () => {
    const response = await canonicalResponse('host-subscription-list');
    const rows = response.body.subscriptions as WakeSubscription[];
    const ended = rows.find(entry => entry.status === 'ended')!;
    const subscriptions = Array.from({ length: 33 }, (_, index) => ({ ...ended, id: `wake_sub_review_history_${index}` }));
    const fetcher = vi.fn(async () => Response.json({ ...response.body, subscriptions }));
    const binding = { agentId: ended.agentId, installationId: ended.installationId, inboxId: identity.inboxId };
    const transport = new EnvoiWakeHostTransport(origin, binding, authenticated(fetcher as typeof fetch, binding));
    await expect(transport.list()).resolves.toHaveLength(33);
  });

  it('refreshes through the actual connector once and replays the same wake create', async () => {
    const expired = await canonicalResponse('subscription-create-access-token-expired');
    const successful = await canonicalResponse('subscription-created');
    const created = successful.body.subscription as WakeSubscription;
    const binding = { ...identity, agentId: created.agentId, installationId: created.installationId };
    const requests: { url: string; options?: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      requests.push({ url, options });
      if (url.endsWith('/api/agent-token')) return Response.json({
        agentApiToken: 'rotated-test-access', agentRefreshToken: 'rotated-test-refresh',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      return requests.length === 1
        ? Response.json(expired.body, { status: expired.status, headers: expired.headers })
        : Response.json(successful.body, { status: successful.status, headers: successful.headers });
    });
    const transport = new EnvoiWakeHostTransport(origin, binding, authenticated(fetcher as typeof fetch, binding));
    await expect(transport.create(receiverUrl)).resolves.toMatchObject({ status: 'pending' });
    expect(requests.map(request => request.url)).toEqual([
      `${origin}/api/agent/wake-subscriptions`, `${origin}/api/agent-token`, `${origin}/api/agent/wake-subscriptions`
    ]);
    expect(requests[2].options?.body).toBe(requests[0].options?.body);
    expect(new Headers(requests[2].options?.headers).get('authorization')).toBe('Bearer rotated-test-access');
    expect(String(requests[0].options?.body)).not.toContain('private-test-refresh');
  });

  it('persists canonical credential revocation and prevents subsequent wake requests', async () => {
    const response = await canonicalResponse('subscription-create-credential-revoked');
    const fetcher = vi.fn(async () => Response.json(response.body, { status: response.status, headers: response.headers }));
    const connector = authenticated(fetcher as typeof fetch);
    const transport = new EnvoiWakeHostTransport(origin, identity, connector);
    await expect(transport.create(receiverUrl)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED', reason: 'revoked' });
    expect((await connector.lifecycle()).state).toBe('REVOKED');
    await expect(transport.create(receiverUrl)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
