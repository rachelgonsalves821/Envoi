import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScopedModelTransport } from './model-transport';
import { createScopedModelAdmission } from './model-admission';
import type { ScopedRunRecord, ScopedRunStore } from '../grok/scoped-store';

const endpoint = 'https://provider.example/v1/responses';
const token = 'FIXTURE_ONLY_PRIVATE_PROVIDER_CREDENTIAL';
const request = (signal = new AbortController().signal) => ({ endpoint, body: '{"model":"fixture"}', signal });
const response = (body: string | null = '{"output":"fixture"}', init: ResponseInit = {}) => new Response(body,
  { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });
function harness(options: { timeoutMs?: number } = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const forward = createScopedModelTransport({ endpoint, token, fetch: fetcher, ...options });
  return { fetcher, forward };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('offline fixed model transport', () => {
  it('uses one captured destination and credential without ambient network or user headers', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Ambient network forbidden'); });
    const test = harness(); const result = await test.forward(request());
    expect(Buffer.from(result).toString()).toBe('{"output":"fixture"}');
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    expect(test.fetcher.mock.calls[0][0]).toBe(endpoint);
    expect(test.fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', body: request().body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
    expect(ambient).not.toHaveBeenCalled();
  });

  it('captures configuration once rather than following mutable caller settings', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const options = { endpoint, token, fetch: fetcher, timeoutMs: 1000 };
    const forward = createScopedModelTransport(options);
    options.endpoint = 'https://evil.example/v1/responses'; options.token = 'changed';
    options.fetch = vi.fn(async () => { throw new Error('Wrong fetch'); });
    await forward(request());
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }));
  });

  it.each([
    { endpoint: 'http://provider.example/v1/responses' }, { endpoint: 'https://secret@provider.example/v1/responses' },
    { endpoint: 'https://provider.example/v1/responses?route=foreign' }, { endpoint: 'https://provider.example/v1/responses#secret' },
    { endpoint: 'https://provider.example/admin' }, { endpoint: 'not a URL' },
    { token: '' }, { token: 'secret\r\nHeader: injected' }, { token: 'x'.repeat(4097) },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120001 }, { timeoutMs: 1.5 }
  ])('refuses invalid transport configuration %j', invalid => {
    expect(() => createScopedModelTransport({ endpoint, token, fetch: vi.fn(), ...invalid }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_TRANSPORT_CONFIG_INVALID', message: 'Scoped model transport refused' }));
  });

  it('refuses route overrides and malformed/oversized requests before credential transmission', async () => {
    const test = harness();
    await expect(test.forward({ ...request(), endpoint: 'https://evil.example/v1/responses' })).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_ROUTE_INVALID' });
    for (const body of ['', '{', '{"x":1,"x":2}', ' '.repeat(262145)]) {
      await expect(test.forward({ ...request(), body })).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_REQUEST_INVALID' });
    }
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each([202, 204, 301, 302, 307, 308, 401, 403, 429, 500, 503])('refuses HTTP %s without retrying or returning raw diagnostics', async status => {
    const test = harness();
    test.fetcher.mockResolvedValue(response(status === 204 ? null : 'private provider body', { status }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID', message: 'Scoped model transport refused' });
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { 'content-type': 'text/html' }, { 'content-type': 'text/event-stream' }, { 'content-type': 'application/json; charset=latin1' },
    { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }, { 'content-length': '262145' },
    { 'content-length': '-1' }, { 'content-length': '2,3' }, { 'content-length': '2' }
  ])('refuses unsupported or contradictory response headers %j', async headers => {
    const test = harness(); test.fetcher.mockResolvedValue(response(undefined, { headers }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID' });
  });

  it('accepts bounded UTF8 JSON with exact length, rejects duplicate/malformed/empty JSON', async () => {
    const test = harness(); const body = '{"text":"é"}';
    test.fetcher.mockResolvedValue(response(body, { headers: { 'content-type': 'application/json; charset="utf-8"', 'content-length': String(Buffer.byteLength(body)), 'content-encoding': 'identity' } }));
    expect(Buffer.from(await test.forward(request())).toString()).toBe(body);
    for (const invalid of ['', '{', '{"x":1,"x":2}', '1e999']) {
      test.fetcher.mockResolvedValue(response(invalid));
      await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID' });
    }
  });

  it('rejects redirected or foreign-origin results even from a fetch implementation that ignored redirect:error', async () => {
    const test = harness();
    for (const field of ['redirected', 'url']) {
      const result = response(); Object.defineProperty(result, field, { value: field === 'redirected' ? true : 'https://evil.example/v1/responses' });
      test.fetcher.mockResolvedValue(result);
      await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID' });
    }
  });

  it('cancels oversized response streams without reading or exposing the remaining private body', async () => {
    const cancel = vi.fn(); let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(262145)); }, cancel }, { highWaterMark: 0 });
    const test = harness(); test.fetcher.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID' });
    expect(reads).toBe(1); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('copies streamed bytes before later reads can mutate the source buffer', async () => {
    const first = Buffer.from('{"text":"ok"}'); let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (++reads === 1) controller.enqueue(first); else { first.fill(32); controller.close(); } } }, { highWaterMark: 0 });
    const test = harness(); test.fetcher.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    expect(Buffer.from(await test.forward(request())).toString()).toBe('{"text":"ok"}');
  });

  it('bounds empty-chunk microtask streams even when timers cannot run', async () => {
    let reads = 0; const cancel = vi.fn(); const test = harness();
    test.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_RESPONSE_INVALID' });
    expect(reads).toBe(4096); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('checks elapsed monotonic time between reads instead of depending only on timer delivery', async () => {
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed++);
    const test = harness({ timeoutMs: 10 }); let reads = 0;
    test.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(Buffer.from(' ')); }
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_TIMEOUT' });
    expect(reads).toBeGreaterThan(0); expect(reads).toBeLessThan(10);
  });

  it('owns and cancels the response if cancellation lands between fetch resolution and admission of its result', async () => {
    const test = harness(); const controller = new AbortController(); const cancel = vi.fn();
    test.fetcher.mockImplementation(() => {
      const pending = Promise.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
      void pending.then(() => { queueMicrotask(() => controller.abort()); });
      return pending;
    });
    await expect(test.forward(request(controller.signal))).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_CANCELLED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a pre-cancelled request without sending any credential', async () => {
    const controller = new AbortController(); controller.abort(new Error(token)); const test = harness();
    await expect(test.forward(request(controller.signal))).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_CANCELLED' });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('cancels a noncooperating fetch and never accepts its late body', async () => {
    const ready = deferred<void>(); const late = deferred<Response>(); const controller = new AbortController(); const test = harness();
    test.fetcher.mockImplementation(async () => { ready.resolve(); return late.promise; });
    const running = test.forward(request(controller.signal)); await ready.promise; controller.abort(new Error(token));
    await expect(running).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_CANCELLED', message: 'Scoped model transport refused' });
    const cancel = vi.fn();
    late.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds fetch and streaming stalls, even when the fetch implementation ignores AbortSignal', async () => {
    vi.useFakeTimers();
    for (const stage of ['fetch', 'body']) {
      const test = harness({ timeoutMs: 50 }); const cancel = vi.fn();
      test.fetcher.mockImplementation(async () => stage === 'fetch' ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
      const result = expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(50); await result;
      if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes provider transport/read exceptions without automatic retries', async () => {
    const test = harness(); test.fetcher.mockRejectedValue(new Error(`upstream ${token} private body`));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_UNAVAILABLE', message: 'Scoped model transport refused' });
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    test.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }), { headers: { 'content-type': 'application/json' } }));
    await expect(test.forward(request())).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_UNAVAILABLE', message: 'Scoped model transport refused' });
  });
});

describe('offline admission composed with fixed transport', () => {
  it('forwards only a captured canonical request and durably records its result through fake fetch', async () => {
    let state: ScopedRunRecord = { version: 1, workId: 'work_fixture', model: 'fixture-model',
      input: [{ role: 'user', content: 'Canonical snapshot fixture' }], pending: [], completed: false, providerCalls: 0 };
    const store: ScopedRunStore = { load: async () => structuredClone(state), save: async value => { state = structuredClone(value); }, exclusive: async (_id, action) => action() };
    const test = harness(); const controller = new AbortController();
    const gate = createScopedModelAdmission({ binding: {
      agentId: 'agent_fixture', installationId: 'installation_fixture', workId: state.workId, caseId: 'case_fixture',
      fence: 1, generation: 'generation_fixture', providerBuild: 'a'.repeat(40), policyDigest: 'b'.repeat(64),
      model: state.model, endpoint, expiresAt: Date.now() + 60000, allowedTools: ['envoi_case_snapshot']
    }, signal: controller.signal, store, validateAuthority: async () => {}, forward: test.forward,
    consumeResponse: (current, result) => { current.input.push({ role: 'assistant', content: JSON.stringify(result) }); return current; } });
    try {
      const ticket = await gate.prepare('request_1'); const changed = JSON.parse(ticket.body); changed.tools.push({ type: 'web_search' });
      await expect(gate.submit(ticket.capability, Buffer.from(JSON.stringify(changed)))).rejects.toMatchObject({ code: 'MODEL_REQUEST_MISMATCH' });
      expect(test.fetcher).not.toHaveBeenCalled();
      await gate.submit(ticket.capability, Buffer.from(ticket.body));
      expect(test.fetcher).toHaveBeenCalledTimes(1);
      expect(test.fetcher.mock.calls[0][1]?.body).toBe(ticket.body);
      expect(ticket.body).not.toContain(token); expect(ticket.body).not.toContain(ticket.capability);
      expect(state.admission?.state).toBe('completed');
    } finally { gate.retire(); }
  });
});
