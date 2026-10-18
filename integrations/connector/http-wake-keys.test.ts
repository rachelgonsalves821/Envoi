import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { HttpWakeKeys, WAKE_KEY_FETCH_TIMEOUT_MS, WAKE_KEY_SET_MAX_BYTES } from './http-wake-keys';
import { HttpWakeReceiver, type WakeState } from './http-wake-receiver';

const contract = contractRegistry.contracts.find(candidate => candidate.id === 'http-wake')!;
const fixture = (name: string) => loadContractFixture(contract, `${name}.json`) as any;
const published = fixture('keys-published').response.body;
const activeId = published.keys[0].kid as string;
const nextId = published.keys[1].kid as string;
const origin = 'https://envoi.example.org';

function harness() {
  let current = Date.parse('2026-10-17T11:41:40.000Z');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(published), { headers: { 'cache-control': 'public, max-age=300, s-maxage=0' } }));
  const options = { origin, fetch: fetcher, now: () => current };
  return { fetcher, keys: new HttpWakeKeys(options), options, advance: (duration: number) => { current += duration; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('http-wake fixed-origin JWKS', () => {
  it('uses only the configured origin with no auth, cookies or redirects', async () => {
    const test = harness();
    expect(await test.keys.get(activeId)).toBeDefined();
    const [url, options] = test.fetcher.mock.calls[0];
    expect(url).toBe(`${origin}/.well-known/envoi-wake-keys.json`);
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['http://envoi.example.org', 'https://user:password@envoi.example.org', 'https://envoi.example.org/path', 'https://envoi.example.org/?', 'https://envoi.example.org/#'])('refuses unsafe origin %s', configured => {
    expect(() => new HttpWakeKeys({ origin: configured })).toThrow();
  });

  it('honors cache max-age minus Age and refreshes at exact expiry', async () => {
    const test = harness();
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify(published), { headers: { 'cache-control': 'max-age=300', age: '290' } }));
    expect(await test.keys.get(activeId)).toBeDefined();
    test.advance(9999);
    expect(await test.keys.get(nextId)).toBeDefined();
    expect(test.fetcher).toHaveBeenCalledOnce();
    test.advance(1);
    expect(await test.keys.get(activeId)).toBeDefined();
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('caps server max-age at 300 seconds and does not reset Age for download time', async () => {
    const test = harness();
    test.fetcher.mockImplementation(async () => {
      test.advance(1000);
      return new Response(JSON.stringify(published), { headers: { 'cache-control': 'max-age=999999', age: '290' } });
    });
    await test.keys.get(activeId);
    test.advance(9000);
    await test.keys.get(activeId);
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { 'cache-control': 'no-store, max-age=300' }, { 'cache-control': 'no-cache, max-age=300' }, { 'cache-control': 'max-age=300', age: 'invalid' }, { 'cache-control': 'max-age=300, max-age=10' }, { 'cache-control': 'max-age=300', age: '301' }])('does not cache an unusable freshness policy %j', async headers => {
    const test = harness();
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify(published), { headers }));
    await test.keys.get(activeId);
    await test.keys.get(activeId);
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('throttles forged unknown kids globally, not per kid, including concurrent callers', async () => {
    const test = harness();
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => test.keys.get(`unknown-${index}`)));
    expect(results.every(result => result === undefined)).toBe(true);
    expect(test.fetcher).toHaveBeenCalledOnce();
    test.advance(59_999);
    expect(await test.keys.get('another-unknown')).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledOnce();
    test.advance(1);
    await test.keys.get('another-unknown');
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a still-fresh old cache after a failed unknown-key refresh', async () => {
    const test = harness();
    await test.keys.get(activeId);
    test.advance(60_000);
    test.fetcher.mockRejectedValue(new Error('private-network-detail'));
    expect(await test.keys.get('unknown')).toBeUndefined();
    expect(await test.keys.get(activeId)).toBeDefined();
    test.advance(240_000);
    expect(await test.keys.get(activeId)).toBeUndefined();
  });

  it('refreshes rotation and removes old keys at cache expiry', async () => {
    const test = harness();
    await test.keys.get(activeId);
    test.advance(300_000);
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify(fixture('keys-emergency').response.body), { headers: { 'cache-control': 'max-age=300' } }));
    expect(await test.keys.get(activeId)).toBeUndefined();
    expect(await test.keys.get('wk_2026_10_emergency_d')).toBeDefined();
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('ignores unsupported keys and unknown members, without rejecting a supported next key', async () => {
    const test = harness();
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify({ future: true, keys: [{ kty: 'RSA', kid: 'future' }, ...published.keys.map((key: object) => ({ ...key, future: true }))] })));
    expect(await test.keys.get(nextId)).toBeDefined();
  });

  it.each([
    null, [], {}, { keys: {} }, { keys: [null] }, { keys: Array(33).fill({ kty: 'RSA' }) },
    { keys: [published.keys[0], published.keys[0]] },
    { keys: [{ ...published.keys[0], x: 'a'.repeat(43) }] },
    { keys: [{ ...published.keys[0], status: { toString: 'not callable' } }] },
    { keys: [{ ...published.keys[0], notAfter: 'invalid' }] },
    { keys: [{ ...published.keys[0], status: 'retired' }] }
  ])('fails closed for malformed key set %j', async value => {
    const test = harness();
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify(value)));
    expect(await test.keys.get(activeId)).toBeUndefined();
    expect(await test.keys.get('unknown')).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it.each([302, 404, 500])('fails closed on HTTP %i', async status => {
    const test = harness();
    test.fetcher.mockImplementation(async () => new Response('{}', { status, headers: { location: 'https://attacker.invalid/keys' } }));
    expect(await test.keys.get(activeId)).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it('bounds declared and streamed body length', async () => {
    for (const headers of [{ 'content-length': String(WAKE_KEY_SET_MAX_BYTES + 1) }, {}]) {
      const test = harness();
      test.fetcher.mockImplementation(async () => new Response(' '.repeat(WAKE_KEY_SET_MAX_BYTES + 1), { headers }));
      expect(await test.keys.get(activeId)).toBeUndefined();
    }
  });

  it('times out an uncooperative fetch and never installs its late key set', async () => {
    vi.useFakeTimers();
    const test = harness();
    let release!: (response: Response) => void;
    test.fetcher.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = test.keys.get(activeId);
    await vi.advanceTimersByTimeAsync(WAKE_KEY_FETCH_TIMEOUT_MS);
    expect(await pending).toBeUndefined();
    expect(test.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    release(new Response(JSON.stringify(published), { headers: { 'cache-control': 'max-age=300' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await test.keys.get(activeId)).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it('times out a body stream even after headers arrive', async () => {
    vi.useFakeTimers();
    const test = harness();
    const cancelled = vi.fn();
    test.fetcher.mockImplementation(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const pending = test.keys.get(activeId);
    await vi.advanceTimersByTimeAsync(WAKE_KEY_FETCH_TIMEOUT_MS);
    expect(await pending).toBeUndefined();
    expect(cancelled).toHaveBeenCalled();
  });

  it('uses the canonical emergency-rotation sequence without losing its retry', async () => {
    const sequence = fixture('wake-emergency-rotation').steps.filter((step: any) => step.receiver);
    let current = Date.parse(sequence[0].receiver.clock);
    let jwks = sequence[0].receiver.jwks;
    let state: WakeState = { version: 1, subscriptions: { wake_sub_emergency: { url: sequence[0].receiver.registeredUrl, installationId: 'installation_emergency', status: 'active' } }, accepted: {}, endedReasons: {} };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(jwks), { headers: { 'cache-control': 'max-age=300' } }));
    const receiver = new HttpWakeReceiver({ origin, registeredUrl: sequence[0].receiver.registeredUrl, fetch: fetcher, now: () => current,
      store: { read: async () => structuredClone(state), update: async mutator => { const next = structuredClone(state); mutator(next); state = next; } } });
    for (const step of sequence) {
      current = Date.parse(step.receiver.clock);
      jwks = step.receiver.jwks;
      const request = step.delivery.request;
      const result = await receiver.receive({ method: request.method, headers: request.headers, body: Buffer.from(request.bodyText) });
      expect(result.status).toBe(step.receiver.respondStatus);
    }
    expect(Object.values(state.accepted)).toHaveLength(1);
    expect(Object.values(state.accepted)[0].pending).toBe(true);
    expect(Object.values(state.accepted)[0].acknowledged).toBe(false);
  });
});
