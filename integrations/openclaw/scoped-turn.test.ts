import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import { FileScopedRunStore, type ScopedRunRecord, type ScopedRunStore } from '../grok/scoped-store';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createOpenClawBridge } from './runtime';
import { openClawScopedTurn } from './scoped-turn';

const call = (id = 'call_one', text = 'Hello') => ({ type: 'function_call', id: `item_${id}`, status: 'completed',
  call_id: id, name: 'envoi_case_reply', arguments: JSON.stringify({ text, idempotencyKey: id }) });
const done = () => Response.json({ status: 'completed', output: [{ type: 'message', id: 'msg_final', role: 'assistant',
  status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }] });
const response = (...output: unknown[]) => Response.json({ status: 'completed', output });

function harness() {
  let saved: ScopedRunRecord | null = null;
  const store: ScopedRunStore = {
    load: vi.fn(async () => saved ? structuredClone(saved) : null),
    save: vi.fn(async value => { saved = structuredClone(value); }),
    exclusive: async (_workId, action) => action()
  };
  const controller = new AbortController();
  const turn = {
    instruction: 'Use only scoped tools', context: { agentAddress: 'agent@example.com' }, snapshot: { notice: 'Canonical' },
    tools: [{ name: 'envoi_case_reply', inputSchema: { type: 'object' } }], signal: controller.signal,
    callTool: vi.fn(async () => ({ messageRef: 'message_one', status: 'queued' }))
  } as unknown as ScopedModelTurn;
  const config = { gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'private-gateway-token', agentId: 'isolated', store };
  return { store, turn, config, controller, saved: () => saved, effect: vi.mocked(turn.callTool) };
}

describe('OpenClaw scoped Responses transport', () => {
  it('uses the strict Gateway request shape without persistent session routing or exposed credentials', async () => {
    const test = harness();
    const bodies: any[] = [];
    const item = call();
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:18789/v1/responses');
      expect(init!.redirect).toBe('error');
      expect(init!.headers).toEqual({ authorization: 'Bearer private-gateway-token', 'content-type': 'application/json' });
      const body = JSON.parse(String(init!.body)); bodies.push(body);
      expect(Object.keys(body).sort()).toEqual(['input', 'max_output_tokens', 'model', 'store', 'stream', 'tools']);
      expect(body.model).toBe('openclaw/isolated');
      expect(body.input.every((input: any) => typeof input.type === 'string')).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/private-gateway-token|host_work|envoi_case_session_|leaseToken/);
      return bodies.length === 1 ? response(item) : done();
    });
    await openClawScopedTurn({ ...test.config, fetch: fetcher })(test.turn, { workId: 'host_work' });
    expect(bodies[1].input).toContainEqual(item);
    expect(bodies[1].input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_one' });
    expect(test.effect).toHaveBeenCalledExactlyOnceWith('envoi_case_reply', { text: 'Hello', idempotencyKey: 'call_one' });
    expect(test.saved()?.completed).toBe(true);
  });

  it('serializes a batch in output order and recovers only its uncertain remaining call', async () => {
    const test = harness();
    const first = call('first'), second = call('second');
    const fetcher = vi.fn(async () => response(first, second));
    test.effect.mockResolvedValueOnce({ messageRef: 'first' } as never).mockRejectedValueOnce(new Error('Lost second result'));
    await expect(openClawScopedTurn({ ...test.config, fetch: fetcher })(test.turn, { workId: 'work_one' })).rejects.toThrow('Lost second result');
    expect(test.saved()?.pending).toEqual([second]);
    const recovered = vi.fn(async (_url, init) => {
      const input = JSON.parse(String(init!.body)).input;
      expect(input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id)).toEqual(['first', 'second']);
      expect(input.at(-1).type).toBe('message');
      return done();
    });
    await openClawScopedTurn({ ...test.config, fetch: recovered })(test.turn, { workId: 'work_one' });
    expect(test.effect.mock.calls.map(args => args[1])).toEqual([
      { text: 'Hello', idempotencyKey: 'first' }, { text: 'Hello', idempotencyKey: 'second' }, { text: 'Hello', idempotencyKey: 'second' }
    ]);
  });

  it.each(['https://evil.example/path', 'http://remote.example', 'https://user:password@gateway.example',
    'https://gateway.example?token=secret', 'https://gateway.example/#fragment'])('rejects unsafe Gateway origin %s', gatewayUrl => {
    const test = harness();
    expect(() => openClawScopedTurn({ ...test.config, gatewayUrl })).toThrow('Gateway');
  });

  it('reloads a real multi-call journal after the first result is lost', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-batch-'));
    try {
      const test = harness();
      const store = new FileScopedRunStore(directory);
      test.effect.mockRejectedValueOnce(new Error('First result lost'));
      await expect(openClawScopedTurn({ ...test.config, store, fetch: vi.fn(async () => response(call('first'), call('second'))) })
        (test.turn, { workId: 'work' })).rejects.toThrow('First result lost');
      const reopened = new FileScopedRunStore(directory);
      expect((await reopened.load('work'))?.pending.map(item => item.call_id)).toEqual(['first', 'second']);
      const fetcher = vi.fn(async () => {
        expect(test.effect.mock.calls.map(args => args[1])).toEqual([
          { text: 'Hello', idempotencyKey: 'first' }, { text: 'Hello', idempotencyKey: 'first' }, { text: 'Hello', idempotencyKey: 'second' }
        ]);
        return done();
      });
      await openClawScopedTurn({ ...test.config, store: reopened, fetch: fetcher })(test.turn, { workId: 'work' });
      expect((await reopened.load('work'))?.completed).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('can persist human-wait completion while a real batch still contains later calls', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-human-'));
    try {
      const test = harness();
      const store = new FileScopedRunStore(directory);
      const human = { ...call('human'), name: 'envoi_request_human', arguments: JSON.stringify({ authorityRef: 'authority_one', question: 'Approve?', idempotencyKey: 'human' }) };
      const turn = { ...test.turn, tools: [...test.turn.tools, { name: 'envoi_request_human' as const, inputSchema: { type: 'object' } }] };
      test.effect.mockImplementation(async () => {
        const record = await store.load('work');
        expect(record?.pending).toHaveLength(2);
        await store.save({ ...record!, completed: true, pending: [] });
        throw new EnvoiError('Turn ended for human input', undefined, 'TURN_END_REQUIRED');
      });
      const fetcher = vi.fn(async () => response(human, call('later')));
      await expect(openClawScopedTurn({ ...test.config, store, fetch: fetcher })(turn, { workId: 'work' }))
        .rejects.toMatchObject({ code: 'TURN_END_REQUIRED' });
      expect((await new FileScopedRunStore(directory).load('work'))?.completed).toBe(true);
      expect(test.effect).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['', 'bad\r\ntoken'])('rejects invalid Gateway credentials', gatewayToken => {
    expect(() => openClawScopedTurn({ ...harness().config, gatewayToken })).toThrow('token');
  });

  it.each(['', '../agent', 'agent/session'])('rejects invalid agent routing %s', agentId => {
    expect(() => openClawScopedTurn({ ...harness().config, agentId })).toThrow('agent ID');
  });

  it.each(['incomplete', 'failed', 'cancelled'])('rejects %s output before effects', async status => {
    const test = harness();
    await expect(openClawScopedTurn({ ...test.config, fetch: vi.fn(async () => Response.json({ status, output: [call()] })) })
      (test.turn, { workId: 'work' })).rejects.toMatchObject({ code: 'SCOPED_PROVIDER_RESPONSE_INVALID' });
    expect(test.effect).not.toHaveBeenCalled();
  });

  it('does not fall back to legacy routes when Responses is disabled', async () => {
    const test = harness();
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(openClawScopedTurn({ ...test.config, fetch: fetcher })(test.turn, { workId: 'work' }))
      .rejects.toMatchObject({ code: 'SCOPED_PROVIDER_UNAVAILABLE', status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.effect).not.toHaveBeenCalled();
  });

  it.each([{ gatewayUrl: 'https://different.example' }, { agentId: 'different' }])('refuses recovery after routing changes %j', async change => {
    const test = harness();
    await openClawScopedTurn({ ...test.config, fetch: vi.fn(async () => done()) })(test.turn, { workId: 'work' });
    const fetcher = vi.fn(async () => done());
    await expect(openClawScopedTurn({ ...test.config, ...change, fetch: fetcher })(test.turn, { workId: 'work' }))
      .rejects.toMatchObject({ code: 'SCOPED_MODEL_CHANGED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects duplicate batch IDs before executing any call', async () => {
    const test = harness();
    await expect(openClawScopedTurn({ ...test.config, fetch: vi.fn(async () => response(call(), call())) })(test.turn, { workId: 'work' }))
      .rejects.toMatchObject({ code: 'SCOPED_PROVIDER_RESPONSE_INVALID' });
    expect(test.effect).not.toHaveBeenCalled();
  });

  it('wires only explicit scoped mode without starting a legacy relay or reading an asset manifest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-scoped-'));
    try {
      const store = new FileBridgeStore(directory); await store.init();
      await store.save({ agentId: 'agent_one', inboxId: 'inbox_one', address: 'agent@example.com', cursor: null } as never);
      const test = harness(); const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
      const config = { apiUrl: 'https://envoi.example', stateDir: directory, gatewayUrl: test.config.gatewayUrl,
        gatewayToken: test.config.gatewayToken, agentId: test.config.agentId };
      const bridge = await createOpenClawBridge(config, { env: { ENVOI_SCOPED_TOOLS: 'true', OPENCLAW_MCP_RELAY_PORT: '1',
        ENVOI_ASSET_MANIFEST_PATH: '/do/not/read' }, fetch: fetcher });
      expect(() => bridge.connector.mintMcpReadToken('case_one')).toThrow(expect.objectContaining({ code: 'LEGACY_MODEL_ACCESS_DISABLED' }));
      expect(fetcher).not.toHaveBeenCalled(); await bridge.close();
      await expect(createOpenClawBridge(config, { env: { ENVOI_SCOPED_TOOLS: 'yes' }, fetch: fetcher })).rejects.toThrow('must be true or false');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
