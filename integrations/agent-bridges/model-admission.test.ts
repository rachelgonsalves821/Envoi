import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScopedModelAdmission, parseAdmissionJson, type ScopedInferenceBinding } from './model-admission';
import { FileScopedRunStore, validAdmissionCheckpoint, type ScopedRunRecord, type ScopedRunStore } from '../grok/scoped-store';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { responsesScopedTurn } from './responses-turn';
import type { ScopedModelTurn } from './scoped-turn';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const directories: string[] = [];
const gates: Array<ReturnType<typeof createScopedModelAdmission>> = [];
const time = Date.parse('2026-10-18T20:00:00Z');
const sessionContract = contractRegistry.contracts.find(contract => contract.id === 'case-session')!;
const sessionFixture = loadContractFixture(sessionContract, 'session-created.json') as Record<string, any>;
const binding = (): ScopedInferenceBinding => ({
  agentId: sessionFixture.response.body.session.agentId,
  installationId: 'installation_test', workId: sessionFixture.response.body.session.workId,
  caseId: sessionFixture.response.body.session.caseId, fence: 1, generation: 'turn_1',
  providerBuild: 'a'.repeat(40), policyDigest: 'b'.repeat(64), model: 'offline-fixture-model',
  endpoint: 'https://provider.example/v1/responses', expiresAt: time + 60000,
  allowedTools: ['envoi_case_snapshot', 'envoi_case_reply']
});
const record = (value = binding()): ScopedRunRecord => ({
  version: 1, workId: value.workId, model: value.model,
  input: [{ role: 'system', content: 'Use only captured case tools.' }, { role: 'user', content: 'Canonical case snapshot' }],
  pending: [], providerCalls: 0, completed: false
});
function memoryStore(initial = record()) {
  let saved: ScopedRunRecord | null = structuredClone(initial);
  let tail: Promise<unknown> = Promise.resolve();
  const store: ScopedRunStore = {
    load: vi.fn(async () => saved && structuredClone(saved)),
    save: vi.fn(async value => { saved = structuredClone(value); }),
    exclusive: (_id, action) => {
      const current = tail.catch(() => {}).then(action);
      tail = current;
      return current;
    }
  };
  return { store, value: () => saved && structuredClone(saved), set: (value: ScopedRunRecord | null) => { saved = value; } };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(overrides: Partial<Parameters<typeof createScopedModelAdmission>[0]> = {}) {
  const state = memoryStore();
  const controller = new AbortController();
  const forward = vi.fn(async () => bytes({ output: 'synthetic response' }));
  const validateAuthority = vi.fn(async () => {});
  const consumeResponse = vi.fn((current: ScopedRunRecord, response: unknown) => {
    current.input.push({ role: 'assistant', content: JSON.stringify(response) });
    return current;
  });
  const gate = createScopedModelAdmission({ binding: binding(), signal: controller.signal, store: state.store,
    forward, validateAuthority, consumeResponse, now: () => time, ...overrides });
  gates.push(gate);
  return { gate, state, controller, forward, validateAuthority, consumeResponse };
}
afterEach(async () => {
  gates.splice(0).forEach(gate => gate.retire());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('bounded duplicate-aware serialized request parser', () => {
  it('accepts JSON primitives, escaped strings, whitespace and null-prototype objects', () => {
    expect(parseAdmissionJson(Buffer.from(' {"text":"a\\\"b","values":[null,true,false,-1.25e2]} \n')))
      .toEqual({ text: 'a"b', values: [null, true, false, -125] });
    const parsed = parseAdmissionJson(Buffer.from('{"__proto__":{"polluted":true}}')) as object;
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it.each(['', '{', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}',
    '[{"x":1,"x":2}]', '{"x":1,}', '[1,]', '01', '1e999', 'true false', '"unterminated', '"\\z"', '"bad\nline"', '\u00a0{}'])
  ('refuses malformed or ambiguous JSON without raw diagnostics: %s', source => {
    expect(() => parseAdmissionJson(Buffer.from(source))).toThrowError(expect.objectContaining({ code: 'MODEL_REQUEST_INVALID' }));
  });
  it('bounds bytes, nesting, nodes and malformed UTF8', () => {
    for (const value of [Buffer.alloc(262145, 32), Buffer.from('['.repeat(50) + '0' + ']'.repeat(50)),
      bytes(Array.from({ length: 17000 }, () => 0)), Buffer.from([0xc3, 0x28])]) {
      expect(() => parseAdmissionJson(value)).toThrowError(expect.objectContaining({ code: 'MODEL_REQUEST_INVALID' }));
    }
  });
});

describe('offline fixed-binding model admission', () => {
  it('uses the canonical schemas, private host binding and a fixed endpoint, without any network', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden'); });
    const test = harness();
    const ticket = await test.gate.prepare('request_1');
    const request = JSON.parse(ticket.body);
    expect(request.tools.map((tool: { name: string }) => tool.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
    expect(request).toMatchObject({ model: binding().model, store: false, stream: false, max_output_tokens: 4096 });
    expect(ticket.capability).toMatch(/^[a-f0-9]{64}$/);
    expect(ticket.body).not.toContain(ticket.capability);
    for (const value of [binding().installationId, binding().workId, binding().generation, binding().policyDigest]) expect(ticket.body).not.toContain(value);
    expect(Object.isFrozen(ticket)).toBe(true);
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).resolves.toContain('synthetic response');
    expect(test.forward).toHaveBeenCalledTimes(1);
    expect(test.forward.mock.calls[0][0]).toMatchObject({ endpoint: binding().endpoint, body: ticket.body });
    expect(test.state.value()?.admission?.state).toBe('completed');
    expect(test.consumeResponse).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['model', 'tools', 'input', 'store', 'stream', 'max_output_tokens', 'previous_response_id', 'conversation',
    'prompt', 'metadata', 'background', 'user', 'instructions', 'parallel_tool_calls'])
  ('refuses a changed/extra %s field before forwarding', async field => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const request = JSON.parse(ticket.body); request[field] = field === 'tools' ? [] : 'foreign';
    await expect(test.gate.submit(ticket.capability, bytes(request))).rejects.toMatchObject({ code: 'MODEL_REQUEST_MISMATCH' });
    expect(test.forward).not.toHaveBeenCalled();
    expect(test.state.value()?.admission?.state).toBe('prepared');
  });

  it('rejects extra, missing, duplicate and altered-schema tools but accepts JSON key reordering', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    for (const change of [
      (request: any) => request.tools.push({ type: 'web_search' }),
      (request: any) => request.tools.pop(),
      (request: any) => request.tools.push(request.tools[0]),
      (request: any) => request.tools[0].parameters = {},
      (request: any) => request.tools[0].name = 'shell'
    ]) {
      const request = JSON.parse(ticket.body); change(request);
      await expect(test.gate.submit(ticket.capability, bytes(request))).rejects.toMatchObject({ code: 'MODEL_REQUEST_MISMATCH' });
    }
    expect(test.forward).not.toHaveBeenCalled();
    const reordered = Object.fromEntries(Object.entries(JSON.parse(ticket.body)).reverse());
    await test.gate.submit(ticket.capability, bytes(reordered));
    expect(test.forward).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate keys even when JSON.parse would yield the expected request', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const ambiguous = `{"model":"foreign",${ticket.body.slice(1)}`;
    await expect(test.gate.submit(ticket.capability, Buffer.from(ambiguous))).rejects.toMatchObject({ code: 'MODEL_REQUEST_INVALID' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('captures binding immutably and does not let a capability target another case', async () => {
    const original = binding(); const test = harness({ binding: original });
    original.model = 'changed'; original.endpoint = 'https://evil.example/v1/responses';
    (original.allowedTools as string[]).push('shell');
    const ticket = await test.gate.prepare('request_1');
    expect(JSON.parse(ticket.body).model).toBe('offline-fixture-model');
    const otherBinding = { ...binding(), caseId: 'case_other', generation: 'turn_other' };
    const other = harness({ binding: otherBinding });
    await expect(other.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_INVALID' });
    expect(other.forward).not.toHaveBeenCalled();
  });

  it.each([
    { allowedTools: ['envoi_case_reply'] }, { allowedTools: ['envoi_case_snapshot', 'shell'] },
    { allowedTools: ['envoi_case_snapshot', 'envoi_case_snapshot'] }, { fence: 0 }, { generation: '' },
    { expiresAt: time - 1 }, { expiresAt: time + 900001 }, { policyDigest: ['b'.repeat(64)] },
    { providerBuild: '' }, { endpoint: 'http://provider.example/v1/responses' },
    { endpoint: 'https://secret@provider.example/v1/responses' }, { endpoint: 'https://provider.example/v1/responses?target=evil' }
  ])('refuses invalid host configuration %j', invalid => {
    expect(() => harness({ binding: { ...binding(), ...invalid } as ScopedInferenceBinding }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_BINDING_INVALID' }));
  });

  it.each([
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.example' }] }],
    [{ role: 'user', content: 'text', conversation: 'foreign' }],
    [{ type: 'item_reference', id: 'foreign' }],
    [{ type: 'function_call', call_id: 'id', name: 'shell', arguments: '{}' }],
    [{ type: 'function_call_output', call_id: 'missing', output: 'text' }],
    [{ type: 'function_call', call_id: 'id', name: 'envoi_case_reply', arguments: '{}' }]
  ])('refuses unsupported references or unmatched tool history %j', async input => {
    const test = harness(); test.state.set({ ...record(), input });
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_CONTEXT_INVALID' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('accepts bounded text-only content and matched canonical tool history', async () => {
    const test = harness(); test.state.set({ ...record(), input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Untrusted https://example.invalid text, not fetched' }] },
      { type: 'function_call', call_id: 'call_1', name: 'envoi_case_snapshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{}' }
    ] });
    const ticket = await test.gate.prepare('request_1');
    await test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    expect(test.forward).toHaveBeenCalledTimes(1);
  });
});

describe('generation cancellation and durable inference recovery', () => {
  it('single-flights concurrent identical submissions and never re-samples a completed request ID', async () => {
    const ready = deferred<void>(); const finish = deferred<Uint8Array>();
    const forward = vi.fn(async () => { ready.resolve(); return finish.promise; });
    const test = harness({ forward }); const ticket = await test.gate.prepare('request_1');
    const first = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    const second = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    await ready.promise; expect(forward).toHaveBeenCalledTimes(1);
    finish.resolve(bytes({ output: 'done' }));
    expect(await first).toBe(await second);
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_REQUEST_REPLAY' });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('persists started BEFORE the external callback, and durable response handling BEFORE reporting success', async () => {
    const test = harness();
    test.forward.mockImplementation(async () => {
      expect(test.state.value()?.admission?.state).toBe('started');
      return bytes({ output: 'done' });
    });
    test.consumeResponse.mockImplementation(current => { current.completed = true; return current; });
    const ticket = await test.gate.prepare('request_1');
    await test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    expect(test.state.value()).toMatchObject({ completed: true, admission: { state: 'completed' } });
  });

  it('reserves every completed ID across later requests instead of only the last ID', async () => {
    const test = harness();
    for (const id of ['request_1', 'request_2']) {
      const ticket = await test.gate.prepare(id);
      await test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    }
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_REQUEST_REPLAY' });
    expect(test.forward).toHaveBeenCalledTimes(2);
    expect(test.state.value()?.admission?.history).toEqual(['request_1', 'request_2']);
  });

  it('revalidates cached response access without any new provider forwarding', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    await test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    test.validateAuthority.mockRejectedValue(new Error('owner paused'));
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after store exclusion cleanup before publishing public success', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const original = test.state.store.exclusive;
    test.state.store.exclusive = async (id, action) => {
      const result = await original(id, action); test.controller.abort(); return result;
    };
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).toHaveBeenCalledTimes(1);
  });

  it.each(['input', 'pending', 'completed'])('rejects changed journal %s between prepare and submit', async change => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const current = test.state.value()!;
    if (change === 'input') current.input.push({ role: 'user', content: 'different case context' });
    if (change === 'pending') current.pending.push({ type: 'function_call', call_id: 'c', name: 'envoi_case_reply', arguments: '{}' });
    if (change === 'completed') current.completed = true;
    test.state.set(current);
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toHaveProperty('code', change === 'input' ? 'MODEL_REQUEST_MISMATCH' : 'MODEL_TOOLS_PENDING');
    expect(test.forward).not.toHaveBeenCalled(); expect(test.consumeResponse).not.toHaveBeenCalled();
  });

  it('cancels a hanging authority check and releases the serialized journal for recovery', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    let checks = 0; const hung = deferred<void>();
    test.validateAuthority.mockImplementation(async () => { if (++checks === 2) { hung.resolve(); await new Promise<void>(() => {}); } });
    const pending = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    await hung.promise; test.gate.retire();
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    await expect(test.state.store.exclusive(binding().workId, async () => 'released')).resolves.toBe('released');
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('bounds an authority check that never resolves', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time);
    const test = harness({ validateAuthority: async () => new Promise<void>(() => {}) });
    const pending = expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    await vi.advanceTimersByTimeAsync(10000); await pending;
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('returns the same owned response bytes that were consumed before an async save', async () => {
    const response = bytes({ output: 'original' });
    const test = harness({ forward: async () => response }); const ticket = await test.gate.prepare('request_1');
    const save = test.state.store.save;
    test.state.store.save = async current => {
      if (current.admission?.state === 'completed') response.fill(32);
      await save(current);
    };
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).resolves.toBe('{"output":"original"}');
    expect(test.state.value()?.input.at(-1)).toMatchObject({ content: '{"output":"original"}' });
  });

  it('sanitizes exclusion/acquisition failures rather than returning private filesystem paths', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    test.state.store.exclusive = async () => { throw new Error('C:/private/credentials mkdir denied'); };
    await expect(test.gate.prepare('request_2')).rejects.toMatchObject({ code: 'MODEL_JOURNAL_UNAVAILABLE', message: 'Scoped model admission refused' });
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_JOURNAL_UNAVAILABLE', message: 'Scoped model admission refused' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('does not forward when preparation or the durable started write fails', async () => {
    const test = harness();
    const save = test.state.store.save;
    test.state.store.save = async () => { throw new Error('secret storage path'); };
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_JOURNAL_UNAVAILABLE', message: 'Scoped model admission refused' });
    test.state.store.save = save;
    const ticket = await test.gate.prepare('request_1');
    test.state.store.save = async () => { throw new Error('secret storage path'); };
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN', message: 'Scoped model admission refused' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('refreshes authority again after serialized admission obtains its turn', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const acquired = deferred<void>(); const release = deferred<void>();
    const occupying = test.state.store.exclusive(binding().workId, async () => { acquired.resolve(); await release.promise; });
    await acquired.promise;
    const outsideChecked = deferred<void>(); let allowed = true;
    test.validateAuthority.mockImplementation(async () => { outsideChecked.resolve(); if (!allowed) throw new Error('canonical control changed'); });
    const pending = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    await outsideChecked.promise; allowed = false; release.resolve(); await occupying;
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('does not persist a response after post-forward canonical authority is denied', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    test.forward.mockImplementation(async () => {
      test.validateAuthority.mockRejectedValue(new Error('authority revoked'));
      return bytes({ output: 'late' });
    });
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.consumeResponse).not.toHaveBeenCalled();
    expect(test.state.value()?.admission?.state).toBe('started');
  });

  it('cancels a noncooperating forwarding callback and ignores its late response', async () => {
    const ready = deferred<AbortSignal>(); const finish = deferred<Uint8Array>();
    const test = harness({ forward: async request => { ready.resolve(request.signal); return finish.promise; } });
    const ticket = await test.gate.prepare('request_1');
    const response = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    const signal = await ready.promise;
    test.controller.abort(new Error('private credential'));
    await expect(response).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(signal.aborted).toBe(true);
    finish.resolve(bytes({ output: 'late' })); await Promise.resolve();
    expect(test.consumeResponse).not.toHaveBeenCalled();
    expect(test.state.value()?.admission?.state).toBe('started');
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
  });

  it('rechecks generation after asynchronous authority and before forwarding registration', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const ready = deferred<void>(); const finish = deferred<void>();
    test.validateAuthority.mockImplementation(async () => { ready.resolve(); await finish.promise; });
    const request = test.gate.submit(ticket.capability, Buffer.from(ticket.body));
    await ready.promise; test.gate.retire(); finish.resolve();
    await expect(request).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('rechecks generation after the started checkpoint is saved', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    const original = test.state.store.save;
    test.state.store.save = async current => { await original(current); if (current.admission?.state === 'started') test.controller.abort(); };
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it('registers the forwarding abort before a synchronous callback-triggered cancellation', async () => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    test.forward.mockImplementation(async () => { test.controller.abort(); return bytes({ output: 'late' }); });
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).toHaveBeenCalledTimes(1);
    expect(test.consumeResponse).not.toHaveBeenCalled();
  });

  it('expires an idle or active binding without polling, with no new execution', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time);
    const test = harness({ now: Date.now }); const ticket = await test.gate.prepare('request_1');
    await vi.advanceTimersByTimeAsync(60000);
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    expect(test.forward).not.toHaveBeenCalled();
  });

  it.each(['forward', 'response', 'consumer', 'save'])('leaves an uncertain outcome durable after a %s failure, with sanitized errors', async stage => {
    const test = harness(); const ticket = await test.gate.prepare('request_1');
    if (stage === 'forward') test.forward.mockRejectedValue(new Error('private token raw body'));
    if (stage === 'response') test.forward.mockResolvedValue(Buffer.from('{"secret":1,"secret":2}'));
    if (stage === 'consumer') test.consumeResponse.mockImplementation(() => { throw new Error('private raw result'); });
    if (stage === 'save') {
      const save = test.state.store.save;
      test.state.store.save = async current => { if (current.admission?.state === 'completed') throw new Error('private path'); await save(current); };
    }
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN', message: 'Scoped model admission refused' });
    expect(test.state.value()?.admission?.state).toBe('started');
    const fresh = harness({ store: test.state.store, binding: { ...binding(), generation: 'turn_2', fence: 2 } });
    await expect(fresh.gate.prepare('request_2')).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN' });
    expect(fresh.forward).not.toHaveBeenCalled();
  });

  it('recovers a prepared but unstarted request with a fresh capability and fences the previous gate', async () => {
    const test = harness(); const old = await test.gate.prepare('request_1');
    const fresh = harness({ store: test.state.store, binding: { ...binding(), generation: 'turn_2', fence: 2 } });
    const ticket = await fresh.gate.prepare('request_1');
    expect(ticket.capability).not.toBe(old.capability);
    await expect(test.gate.submit(old.capability, Buffer.from(old.body))).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN' });
    expect(test.forward).not.toHaveBeenCalled();
    await fresh.gate.submit(ticket.capability, Buffer.from(ticket.body));
    expect(fresh.forward).toHaveBeenCalledTimes(1);
    await expect(test.gate.prepare('request_2')).rejects.toMatchObject({ code: 'MODEL_BINDING_STALE' });
  });

  it('refuses authority denial, corrupt journal, mismatched model, outstanding tools and request exhaustion', async () => {
    const denied = harness({ validateAuthority: async () => { throw new Error('private lease'); } });
    await expect(denied.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_AUTHORITY_LOST' });
    const test = harness();
    for (const value of [null, { ...record(), model: 'other' }, { ...record(), admission: {} } as ScopedRunRecord]) {
      test.state.set(value);
      await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_JOURNAL_INVALID' });
    }
    test.state.set({ ...record(), pending: [{ type: 'function_call', call_id: 'c', name: 'envoi_case_reply', arguments: '{}' }] });
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_TOOLS_PENDING' });
    test.state.set({ ...record(), providerCalls: 16 });
    await expect(test.gate.prepare('request_1')).rejects.toMatchObject({ code: 'MODEL_REQUEST_LIMIT' });
  });

  it('reopens the existing private file journal and refuses uncertain re-sampling without storing capabilities', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'envoi-admission-')); directories.push(directory);
    const store = new FileScopedRunStore(directory); await store.save(record());
    const test = harness({ store, forward: async () => { throw new Error('lost response'); } });
    const ticket = await test.gate.prepare('request_1');
    await expect(test.gate.submit(ticket.capability, Buffer.from(ticket.body))).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN' });
    const reopened = new FileScopedRunStore(directory);
    expect(JSON.stringify(await reopened.load(binding().workId))).not.toContain(ticket.capability);
    const fresh = harness({ store: reopened, binding: { ...binding(), generation: 'turn_2' } });
    await expect(fresh.gate.prepare('request_2')).rejects.toMatchObject({ code: 'MODEL_OUTCOME_UNCERTAIN' });
    expect(fresh.forward).not.toHaveBeenCalled();
  });

  it('rejects corrupt persisted admission metadata, including coercible digest types', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'envoi-admission-corrupt-')); directories.push(directory);
    const store = new FileScopedRunStore(directory);
    await mkdir(path.join(directory, 'scoped-runs'), { recursive: true });
    const checkpoint = { version: 1, requestId: 'r', bindingDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64), fence: 1, history: ['r'], state: 'started' };
    expect(validAdmissionCheckpoint(checkpoint)).toBe(true);
    for (const admission of [{ ...checkpoint, bindingDigest: ['a'.repeat(64)] }, { ...checkpoint, state: 'unknown' }, { ...checkpoint, extra: true }]) {
      await writeFile(path.join(directory, 'scoped-runs', `${binding().workId}.json`), JSON.stringify({ ...record(), admission }));
      await expect(store.load(binding().workId)).rejects.toThrow('Invalid scoped run record');
    }
  });

  it('refuses legacy Responses recovery for a work journal owned by the admission host', async () => {
    const test = harness(); await test.gate.prepare('request_1');
    const request = vi.fn(async () => { throw new Error('Unexpected provider sampling'); });
    const run = responsesScopedTurn({ model: binding().model, label: 'offline fixture', store: test.state.store, request });
    await expect(run({ signal: test.controller.signal } as ScopedModelTurn, { workId: binding().workId }))
      .rejects.toMatchObject({ code: 'SCOPED_ADMISSION_REQUIRED' });
    expect(request).not.toHaveBeenCalled();
  });
});
