import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { HttpWakeReceiver, isWakeState, type WakeNotification, type WakeRequest, type WakeState, type WakeStore } from './http-wake-receiver';

const contract = contractRegistry.contracts.find(candidate => candidate.id === 'http-wake')!;
const schemas = loadContractFixture(contract, contract.schemas!) as { 'x-receiver-checks': { check: string }[]; 'x-limits': Record<string, number> };
const origin = 'https://envoi.example.org';
const installationId = 'installation_receiver_test';

interface FixtureStep {
  delivery?: { request?: { method: string; headers: Record<string, string>; bodyText: string } };
  receiver?: {
    clock: string; registeredUrl: string; subscriptionIds: string[]; jwks: unknown; seenIds: string[];
    verdict: string; reason: string | null; respondStatus: number; respondHeaders: Record<string, string>; action: string;
  };
}

const fixtureCases = contract.fixtures.flatMap(filename => {
  const fixture = loadContractFixture(contract, filename) as FixtureStep & { id: string; steps?: FixtureStep[] };
  return [fixture, ...(fixture.steps ?? [])].flatMap((step, index) => step.receiver && step.delivery?.request
    && (step.receiver.verdict !== 'process' || step.receiver.respondStatus === 200)
    ? [{ name: `${fixture.id}:${index}`, ...step, receiver: step.receiver, request: step.delivery.request }] : []);
});

class MemoryStore implements WakeStore {
  state: WakeState;
  private tail = Promise.resolve();
  constructor(state: WakeState) { this.state = structuredClone(state); }
  async read(): Promise<WakeState> { return structuredClone(this.state); }
  update(mutator: (state: WakeState) => void): Promise<void> {
    const operation = this.tail.then(() => {
      const next = structuredClone(this.state);
      mutator(next);
      this.state = next;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}

function emptyState(): WakeState { return { version: 1, subscriptions: {}, accepted: {}, endedReasons: {} }; }

function fixtureHarness(fixture = fixtureCases.find(candidate => candidate.name === 'wake-delivered-signed:0')!) {
  const state = emptyState();
  for (const subscriptionId of fixture.receiver.subscriptionIds) {
    state.subscriptions[subscriptionId] = { url: fixture.receiver.registeredUrl, status: 'active', installationId };
  }
  for (const notificationId of fixture.receiver.seenIds) {
    const notification = JSON.parse(fixture.request.bodyText) as WakeNotification;
    const receivedAt = Date.parse(fixture.receiver.clock);
    state.accepted[notificationId] = { receivedAt, expiresAt: receivedAt + 3_900_000, notification: { version: 1, type: notification.type, subscriptionId: notification.subscriptionId, id: notificationId }, pending: false, acknowledged: true };
  }
  let current = Date.parse(fixture.receiver.clock);
  const store = new MemoryStore(state);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(fixture.receiver.jwks), { headers: { 'cache-control': 'max-age=300' } }));
  const options = { origin, registeredUrl: fixture.receiver.registeredUrl, store, fetch: fetcher, now: () => current };
  const request: WakeRequest = { method: fixture.request.method, headers: { ...fixture.request.headers }, body: Buffer.from(fixture.request.bodyText) };
  return { store, request, fetcher, options, receiver: new HttpWakeReceiver(options), advance: (duration: number) => { current += duration; } };
}

function signedHarness() {
  const harness = fixtureHarness();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'EdDSA', use: 'sig', status: 'active' };
  harness.fetcher.mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=300' } }));
  const notification = JSON.parse(Buffer.from(harness.request.body).toString()) as WakeNotification;
  function requestFor(value: unknown, raw?: Uint8Array): WakeRequest {
    const body = raw ?? Buffer.from(JSON.stringify(value));
    const headers = { ...harness.request.headers, 'envoi-wake-key-id': 'test-key' } as Record<string, string>;
    const prefix = `envoi-wake/1\ntest-key\n${headers['envoi-wake-timestamp']}\n${headers['envoi-wake-id']}\n${harness.options.registeredUrl}\n`;
    headers['envoi-wake-signature'] = `v1=${sign(null, Buffer.concat([Buffer.from(prefix), body]), privateKey).toString('base64url')}`;
    return { method: 'POST', headers, body };
  }
  return { ...harness, notification, requestFor };
}

describe('http-wake receiver canonical fixtures', () => {
  it('consumes each ordered receiver check and the approved limits', () => {
    expect(schemas['x-receiver-checks'].map(check => check.check)).toEqual(['malformed', 'unknown_key', 'key_expired', 'timestamp_out_of_window', 'signature_invalid', 'not_a_notification', 'challenge_for_unknown_subscription', 'subscription_unknown', 'duplicate', 'process']);
    expect(schemas['x-limits'].requestBodyMaxBytes).toBe(1024);
    expect(schemas['x-limits'].dedupeCacheRecommendedSeconds).toBe(3900);
    expect(fixtureCases.length).toBeGreaterThan(45);
  });

  it.each(fixtureCases)('$name', async fixture => {
    const harness = fixtureHarness(fixture);
    const response = await harness.receiver.receive(harness.request);
    expect(response.status).toBe(fixture.receiver.respondStatus);
    expect(response.headers).toEqual(fixture.receiver.respondHeaders);
    const actionable = fixture.receiver.verdict === 'process' && fixture.receiver.action !== 'none' && fixture.receiver.action !== 'activate';
    expect(!!response.notification).toBe(actionable);
    if (response.notification) {
      expect(harness.store.state.accepted[response.notification.id].pending).toBe(true);
      expect(harness.store.state.accepted[response.notification.id].acknowledged).toBe(false);
      expect(response.acceptedId).toBe(response.notification.id);
      expect(harness.store.state.accepted[response.notification.id].expiresAt).toBe(Date.parse(fixture.receiver.clock) + 3_900_000);
      expect(response.notification).not.toHaveProperty('hint');
    }
    if (fixture.receiver.action === 'activate') {
      expect(response.notification).toBeUndefined();
      const accepted = Object.values(harness.store.state.accepted).find(entry => entry.notification.type === 'wake.challenge');
      expect(accepted?.pending).toBe(false);
      expect(accepted?.notification.challenge).toBeUndefined();
    }
  });
});

describe('http-wake durable acceptance', () => {
  it('does not acknowledge before durable insertion finishes and does not dispatch effects', async () => {
    const harness = fixtureHarness();
    let release!: () => void;
    const checkpoint = new Promise<void>(resolve => { release = resolve; });
    const update = harness.store.update.bind(harness.store);
    harness.store.update = async mutator => { await checkpoint; await update(mutator); };
    let settled = false;
    const received = harness.receiver.receive(harness.request).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(harness.fetcher).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(harness.store.state.accepted).toEqual({});
    release();
    const result = await received;
    expect(result.status).toBe(200);
    expect(harness.store.state.accepted[result.notification!.id].pending).toBe(true);
    expect(harness.store.state.accepted[result.notification!.id].acknowledged).toBe(false);
    result.notification!.type = 'mutated-after-return';
    expect(Object.values(harness.store.state.accepted)[0].notification.type).toBe('wake.work_available');
  });

  it('preserves pending dispatch across receiver recreation and acknowledges duplicates without requeue', async () => {
    const harness = fixtureHarness();
    expect((await harness.receiver.receive(harness.request)).notification).toBeDefined();
    const reopened = new HttpWakeReceiver(harness.options);
    expect(await reopened.receive(harness.request)).toEqual({ status: 200, headers: {}, acceptedId: JSON.parse(Buffer.from(harness.request.body).toString()).id });
    expect(Object.values(harness.store.state.accepted)).toHaveLength(1);
    expect(Object.values(harness.store.state.accepted)[0].pending).toBe(true);
    expect(Object.values(harness.store.state.accepted)[0].acknowledged).toBe(false);
  });

  it('returns a verified duplicate id without changing either acknowledgement state', async () => {
    const harness = fixtureHarness();
    const initial = await harness.receiver.receive(harness.request);
    const identifier = initial.acceptedId!;
    expect(identifier).toBe(initial.notification!.id);
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 200, headers: {}, acceptedId: identifier });
    expect(harness.store.state.accepted[identifier].acknowledged).toBe(false);
    await harness.store.update(state => { state.accepted[identifier].acknowledged = true; });
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 200, headers: {}, acceptedId: identifier });
    expect(harness.store.state.accepted[identifier].acknowledged).toBe(true);
    expect(harness.store.state.accepted[identifier].pending).toBe(true);
    await harness.store.update(state => { state.accepted[identifier].pending = false; });
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 200, headers: {}, acceptedId: identifier });
    expect(harness.store.state.accepted[identifier].pending).toBe(false);
  });

  it('does not make a durable pending entry dispatchable before a separate post-flush acknowledgement', async () => {
    const harness = fixtureHarness();
    const result = await harness.receiver.receive(harness.request);
    const pending = async () => Object.values((await harness.store.read()).accepted).filter(entry => entry.pending && entry.acknowledged);
    expect(await pending()).toEqual([]);
    await harness.store.update(state => { state.accepted[result.acceptedId!].acknowledged = true; });
    expect(await pending()).toHaveLength(1);
  });

  it('never exposes an accepted id for an unverified replay', async () => {
    const harness = fixtureHarness();
    const initial = await harness.receiver.receive(harness.request);
    harness.request.body = Buffer.from(`${Buffer.from(harness.request.body)} `);
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 401, headers: {} });
    expect(harness.store.state.accepted[initial.acceptedId!].acknowledged).toBe(false);
  });

  it('deduplicates simultaneous receiver instances through the atomic store', async () => {
    const harness = fixtureHarness();
    const responses = await Promise.all([harness.receiver.receive(harness.request), new HttpWakeReceiver(harness.options).receive(harness.request)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(responses.filter(response => response.notification)).toHaveLength(1);
  });

  it('defers a failed save without accepting the id', async () => {
    const harness = fixtureHarness();
    harness.store.update = vi.fn().mockRejectedValue(new Error('private-path-secret'));
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 503, headers: {} });
    expect(harness.store.state.accepted).toEqual({});
  });

  it('bounds concurrent verification and store waits to sixteen requests', async () => {
    const harness = fixtureHarness();
    let release!: () => void;
    const checkpoint = new Promise<void>(resolve => { release = resolve; });
    const update = harness.store.update.bind(harness.store);
    const entered = vi.fn();
    harness.store.update = async mutator => { entered(); await checkpoint; await update(mutator); };
    const requests = Array.from({ length: 16 }, () => harness.receiver.receive(harness.request));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(16));
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 503, headers: {} });
    release();
    const responses = await Promise.all(requests);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses.filter(response => response.notification)).toHaveLength(1);
  });

  it.each(['pending', 'active'] as const)('holds %s and replacement subscriptions for the registered URL', async status => {
    const harness = fixtureHarness();
    Object.values(harness.store.state.subscriptions)[0].status = status;
    harness.store.state.subscriptions.wake_sub_replacement = { url: harness.options.registeredUrl, installationId, status: 'pending' };
    expect((await harness.receiver.receive(harness.request)).status).toBe(200);
  });

  it.each(['revoked_by_owner', 'replaced', 'expired'])('uses installation-keyed sticky reason %s', async reason => {
    const harness = fixtureHarness();
    harness.store.state.endedReasons[installationId] = reason;
    expect((await harness.receiver.receive(harness.request)).status).toBe(reason === 'revoked_by_owner' ? 400 : 200);
  });

  it('rejects a subscription bound to another registered URL even when the Host header matches', async () => {
    const harness = fixtureHarness();
    harness.request.headers.host = 'hooks.example.com';
    Object.values(harness.store.state.subscriptions)[0].url = 'https://other.example.org/wake';
    expect((await harness.receiver.receive(harness.request)).status).toBe(400);
  });

  it('ignores spoofed Host and forwarding headers for signature construction', async () => {
    const harness = fixtureHarness();
    Object.assign(harness.request.headers, { host: 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http' });
    expect((await harness.receiver.receive(harness.request)).status).toBe(200);
  });

  it.each([256, 4096])('defers at the %i pending or accepted capacity without eviction', async count => {
    const harness = fixtureHarness();
    const receivedAt = Date.parse('2026-10-17T11:41:40.400Z');
    for (let index = 0; index < count; index++) {
      const id = `wake_evt_${String(index).padStart(16, '0')}`;
      harness.store.state.accepted[id] = { receivedAt, expiresAt: receivedAt + 3_900_000, notification: { version: 1, id, type: 'wake.work_available', subscriptionId: 'wake_sub_signed' }, pending: count === 256, acknowledged: true };
    }
    expect((await harness.receiver.receive(harness.request)).status).toBe(503);
    expect(Object.keys(harness.store.state.accepted)).toHaveLength(count);
  });

  it('prunes expired completed entries but retains acknowledged pending recovery records', async () => {
    const harness = fixtureHarness();
    const notification = JSON.parse(Buffer.from(harness.request.body).toString()) as WakeNotification;
    for (const [suffix, pending] of [['0000000000000000', false], ['1111111111111111', true]] as const) {
      const id = `wake_evt_${suffix}`;
      harness.store.state.accepted[id] = { receivedAt: 1, expiresAt: 3_900_001, notification: { ...notification, id }, pending, acknowledged: true };
    }
    expect((await harness.receiver.receive(harness.request)).status).toBe(200);
    expect(harness.store.state.accepted.wake_evt_0000000000000000).toBeUndefined();
    expect(harness.store.state.accepted.wake_evt_1111111111111111.pending).toBe(true);
  });

  it('reclaims an expired full pending queue left by crashes before acknowledgement', async () => {
    const harness = fixtureHarness();
    for (let index = 0; index < 256; index++) {
      const id = `wake_evt_${String(index).padStart(16, '0')}`;
      harness.store.state.accepted[id] = { receivedAt: 1, expiresAt: 3_900_001,
        notification: { version: 1, id, type: 'wake.work_available', subscriptionId: 'wake_sub_signed' }, pending: true, acknowledged: false };
    }
    expect(isWakeState(harness.store.state)).toBe(true);
    const result = await harness.receiver.receive(harness.request);
    expect(result.status).toBe(200);
    expect(Object.keys(harness.store.state.accepted)).toEqual([result.acceptedId]);
    expect(harness.store.state.accepted[result.acceptedId!].acknowledged).toBe(false);
  });

  it('does not collect unacknowledged pending entries before their exact replay expiry', async () => {
    const harness = fixtureHarness();
    const expiresAt = Date.parse('2026-10-17T11:41:40.400Z') + 1;
    const id = 'wake_evt_0000000000000000';
    harness.store.state.accepted[id] = { receivedAt: expiresAt - 3_900_000, expiresAt,
      notification: { version: 1, id, type: 'wake.work_available', subscriptionId: 'wake_sub_signed' }, pending: true, acknowledged: false };
    expect((await harness.receiver.receive(harness.request)).status).toBe(200);
    expect(harness.store.state.accepted[id]).toBeDefined();
    harness.advance(1);
    expect((await harness.receiver.receive(harness.request)).status).toBe(200);
    expect(harness.store.state.accepted[id]).toBeUndefined();
  });
});

describe('http-wake raw-byte and envelope boundaries', () => {
  it('verifies exact bytes rather than reserialized JSON', async () => {
    const harness = fixtureHarness();
    harness.request.body = Buffer.from(`${Buffer.from(harness.request.body)} `);
    expect((await harness.receiver.receive(harness.request)).status).toBe(401);
    expect(harness.store.state.accepted).toEqual({});
  });

  it.each([null, [], {}, { version: 2 }, { type: 'wake.work_available', version: 1, id: 'wake_evt_0000000000000000', subscriptionId: 'wake_sub_signed' }])('rejects signed invalid envelope %j', async value => {
    const harness = signedHarness();
    expect((await harness.receiver.receive(harness.requestFor(value))).status).toBe(400);
  });

  it('rejects signed malformed JSON and invalid UTF-8 after signature verification', async () => {
    const harness = signedHarness();
    for (const raw of [Buffer.from('{'), Buffer.from([0xff])]) {
      expect((await harness.receiver.receive(harness.requestFor(null, raw))).status).toBe(400);
    }
  });

  it('keeps only typed known fields and accepts additive minimal envelopes', async () => {
    const harness = signedHarness();
    const value = { ...harness.notification, sequence: [], reason: {}, createdAt: 'invalid', extra: { private: 'do-not-store' } };
    const result = await harness.receiver.receive(harness.requestFor(value));
    expect(result.status).toBe(200);
    expect(result.notification).toEqual({ version: 1, type: value.type, id: value.id, subscriptionId: value.subscriptionId });
    expect(JSON.stringify(harness.store.state)).not.toContain('do-not-store');
  });

  it('schedules a real canonical challenge only after durable acceptance', async () => {
    const harness = signedHarness();
    const challenge = `envoi_wake_challenge_${Buffer.alloc(32, 11).toString('base64url')}`;
    const value = { ...harness.notification, type: 'wake.challenge', challenge, expiresAt: '2026-10-17T11:51:40.000Z' };
    const result = await harness.receiver.receive(harness.requestFor(value));
    expect(result.notification?.challenge).toBe(challenge);
    expect(harness.store.state.accepted[value.id].pending).toBe(true);
  });

  it.each(['envoi_wake_challenge_PLACEHOLDER_example', `envoi_wake_challenge_${'a'.repeat(43)}`, 'invalid'])('acknowledges but does not schedule invalid challenge %s', async challenge => {
    const harness = signedHarness();
    const value = { ...harness.notification, type: 'wake.challenge', challenge, expiresAt: '2026-10-17T11:51:40.000Z' };
    expect(await harness.receiver.receive(harness.requestFor(value))).toEqual({ status: 200, headers: {} });
    expect(harness.store.state.accepted[value.id].pending).toBe(false);
    expect(harness.store.state.accepted[value.id].notification.challenge).toBeUndefined();
  });

  it('runs malformed before key lookup, key lookup before clock and signature before JSON', async () => {
    const harness = fixtureHarness();
    harness.request.method = 'GET';
    expect((await harness.receiver.receive(harness.request)).status).toBe(400);
    expect(harness.fetcher).not.toHaveBeenCalled();
    harness.request.method = 'POST';
    harness.request.headers['envoi-wake-key-id'] = 'unknown';
    harness.request.headers['envoi-wake-timestamp'] = '1';
    harness.request.body = Buffer.from('{');
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 503, headers: { 'retry-after': '60' } });
  });

  it.each([13, 14, 15, 16])('rejects a %i-digit timestamp before looking up an unknown key', async digits => {
    const harness = fixtureHarness();
    harness.request.headers['envoi-wake-key-id'] = 'unknown';
    harness.request.headers['envoi-wake-timestamp'] = '1'.repeat(digits);
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 400, headers: {} });
    expect(harness.fetcher).not.toHaveBeenCalled();
    expect(harness.store.state.accepted).toEqual({});
  });

  it('allows a canonical twelve-digit timestamp through malformed checks before unknown-key deferral', async () => {
    const harness = fixtureHarness();
    harness.request.headers['envoi-wake-key-id'] = 'unknown';
    harness.request.headers['envoi-wake-timestamp'] = '1'.repeat(12);
    expect(await harness.receiver.receive(harness.request)).toEqual({ status: 503, headers: { 'retry-after': '60' } });
    expect(harness.fetcher).toHaveBeenCalledOnce();
  });

  it.each(['http://hooks.example.org/wake', 'https://hooks.example.org/wake?', 'https://hooks.example.org/wake#', 'https://USER@hooks.example.org/wake', 'https://hooks.example.org:444/wake', `https://hooks.example.org/${'a'.repeat(2048)}`, 'https://HOOKS.example.org/wake'])('rejects noncanonical or out-of-contract URL %s', registeredUrl => {
    const harness = fixtureHarness();
    expect(() => new HttpWakeReceiver({ ...harness.options, registeredUrl })).toThrow();
  });

  it('validates durable state without coercion or arbitrary stored fields', () => {
    expect(isWakeState(emptyState())).toBe(true);
    const harness = fixtureHarness();
    for (const status of [[], { toString: 'not callable' }, null]) {
      const state = structuredClone(harness.store.state) as unknown as { subscriptions: Record<string, { status: unknown }> };
      Object.values(state.subscriptions)[0].status = status;
      expect(isWakeState(state)).toBe(false);
    }
    harness.store.state.endedReasons.wake_sub_wrong_key = 'revoked_by_owner';
    expect(isWakeState(harness.store.state)).toBe(false);
  });

  it.each([undefined, null, 0, 1, 'false', [], {}])('requires a boolean durable acknowledgement rather than %j', async acknowledged => {
    const harness = fixtureHarness();
    const result = await harness.receiver.receive(harness.request);
    const state = JSON.parse(JSON.stringify(harness.store.state));
    state.accepted[result.acceptedId!].acknowledged = acknowledged;
    expect(isWakeState(state)).toBe(false);
  });

  it('enforces sixty-four subscriptions and installation reasons in the shared durable validator', () => {
    const state = emptyState();
    for (let index = 0; index < 64; index++) {
      state.subscriptions[`wake_sub_${String(index).padStart(3, '0')}`] = { installationId, url: 'https://hooks.example.org/wake', status: 'active' };
      state.endedReasons[`installation_${String(index).padStart(3, '0')}`] = 'expired';
    }
    expect(isWakeState(state)).toBe(true);
    state.subscriptions.wake_sub_overflow = { installationId, url: 'https://hooks.example.org/wake', status: 'active' };
    expect(isWakeState(state)).toBe(false);
    delete state.subscriptions.wake_sub_overflow;
    state.endedReasons.installation_overflow = 'expired';
    expect(isWakeState(state)).toBe(false);
  });
});
