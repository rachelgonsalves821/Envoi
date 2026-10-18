import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { CaseToolError } from '../../sdk/typescript/src/case-tools';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import { xaiScopedTurn } from './scoped-turn';
import type { ScopedRunRecord, ScopedRunStore } from './scoped-store';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createGrokBridge } from './runtime';

const call = (name = 'envoi_case_reply', args: unknown = { text: 'Hello', idempotencyKey: 'stable-key' }) => ({
  type: 'function_call', call_id: 'call-one', name, arguments: JSON.stringify(args)
});
const done = () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }] });
const response = (...output: unknown[]) => Response.json({ status: 'completed', output });

function harness() {
  let saved: ScopedRunRecord | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const store: ScopedRunStore = {
    load: vi.fn(async () => saved ? structuredClone(saved) : null),
    save: vi.fn(async value => { saved = structuredClone(value); }),
    exclusive: async (_workId, action) => {
      const current = tail.catch(() => {}).then(action);
      tail = current;
      return current;
    }
  };
  const controller = new AbortController();
  const turn = {
    instruction: 'Only use scoped tools', context: { agentAddress: 'agent@example.com' },
    snapshot: { requestedResponse: { text: 'Current request' } },
    tools: [{ name: 'envoi_case_reply', inputSchema: { type: 'object' } }, { name: 'envoi_request_human', inputSchema: { type: 'object' } }],
    signal: controller.signal, callTool: vi.fn(async () => ({ messageRef: 'm_one', status: 'queued' }))
  } as unknown as ScopedModelTurn;
  return { store, turn, controller, saved: () => saved, effect: vi.mocked(turn.callTool) };
}

describe('xAI Responses API scoped runtime', () => {
  it('wires explicit scoped mode into the existing connector without exposing legacy model access', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-xai-scoped-'));
    try {
      const store = new FileBridgeStore(directory);
      await store.init();
      await store.save({ agentId: 'agent_test', inboxId: 'inbox_test', address: 'agent@example.com', cursor: null } as never);
      const fetcher = vi.fn(async () => { throw new Error('No network expected'); });
      const config = { apiUrl: 'https://envoi.example', stateDir: directory, apiKey: 'private-key', model: 'model' };
      const bridge = await createGrokBridge(config, { env: { ENVOI_SCOPED_TOOLS: 'true', ENVOI_ASSET_MANIFEST_PATH: '/never/read/legacy/manifest' }, fetch: fetcher });
      expect(() => bridge.connector.mintMcpReadToken('case_one')).toThrow(expect.objectContaining({ code: 'LEGACY_MODEL_ACCESS_DISABLED' }));
      expect(fetcher).not.toHaveBeenCalled();
      await bridge.close();
      await expect(createGrokBridge(config, { env: { ENVOI_SCOPED_TOOLS: 'yes' }, fetch: fetcher })).rejects.toThrow('must be true or false');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps credentials and work identity private and exchanges only typed local function calls', async () => {
    const test = harness();
    const requests: any[] = [];
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.x.ai/v1/responses');
      expect(init.redirect).toBe('error');
      expect(init.headers.authorization).toBe('Bearer private-provider-key');
      const body = JSON.parse(init.body); requests.push(body);
      expect(body).toMatchObject({ model: 'approved-model', store: false, stream: false, parallel_tool_calls: false });
      expect(body.tools.every((tool: any) => tool.type === 'function' && !tool.authorization)).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/private-provider-key|msg_private_host|envoi_case_session_|leaseToken/);
      return requests.length === 1 ? response(call()) : done();
    });
    test.effect.mockImplementation(async () => {
      expect(test.saved()?.pending).toEqual([call()]);
      return { messageRef: 'm_one', status: 'queued' } as never;
    });
    await xaiScopedTurn({ apiKey: 'private-provider-key', model: 'approved-model', store: test.store, fetch: fetcher })(test.turn, { workId: 'msg_private_host' });
    expect(test.effect).toHaveBeenCalledWith('envoi_case_reply', { text: 'Hello', idempotencyKey: 'stable-key' });
    expect(requests[1].input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call-one' });
    expect(test.saved()?.completed).toBe(true);
  });

  it('replays the saved uncertain call with its original key before sampling another response', async () => {
    const test = harness();
    const fetcher = vi.fn(async () => response(call()));
    const run = xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher });
    test.effect.mockRejectedValueOnce(new Error('Result was lost'));
    await expect(run(test.turn, { workId: 'work_one' })).rejects.toThrow('Result was lost');
    expect(test.saved()?.pending).toEqual([call()]);
    const recoveredFetch = vi.fn(async (_url, init) => {
      expect(test.effect).toHaveBeenCalledTimes(2);
      const input = JSON.parse(init.body).input;
      expect(input.at(-2)).toMatchObject({ type: 'function_call_output', call_id: 'call-one' });
      expect(JSON.parse(input.at(-1).content).notice).toContain('Fresh canonical state');
      return done();
    });
    await xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: recoveredFetch })(test.turn, { workId: 'work_one' });
    expect(test.effect.mock.calls[1]).toEqual(test.effect.mock.calls[0]);
    expect(recoveredFetch).toHaveBeenCalledTimes(1);
  });

  it('waits for an old cancelled writer before recovering the same work journal', async () => {
    const test = harness();
    const save = vi.mocked(test.store.save).getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    vi.mocked(test.store.save).mockImplementation(async record => {
      if (record.pending.length && !held) { held = true; started(); await blocked; }
      await save(record);
    });
    const fetcher = vi.fn().mockResolvedValueOnce(response(call())).mockImplementation(async () => done());
    const run = xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher });
    const first = run(test.turn, { workId: 'work_one' });
    const failed = expect(first).rejects.toThrow('Cancelled old runner');
    await writing;
    test.controller.abort(new Error('Cancelled old runner'));
    const recovered = run({ ...test.turn, signal: new AbortController().signal }, { workId: 'work_one' });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.effect).not.toHaveBeenCalled();
    release();
    await failed;
    await recovered;
    expect(test.effect).toHaveBeenCalledTimes(1);
    expect(test.saved()).toMatchObject({ completed: true, providerCalls: 2, pending: [] });
  });

  it('retries TOOL_BUSY with the identical call before requesting another model response', async () => {
    const test = harness();
    test.effect.mockRejectedValueOnce(new CaseToolError('TOOL_BUSY', true));
    const fetcher = vi.fn().mockResolvedValueOnce(response(call())).mockImplementation(async () => {
      expect(test.effect).toHaveBeenCalledTimes(2);
      return done();
    });
    await xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' });
    expect(test.effect.mock.calls[1]).toEqual(test.effect.mock.calls[0]);
    expect(test.saved()?.completed).toBe(true);
  });

  it('retains the same pending call after bounded TOOL_BUSY retry exhaustion', async () => {
    const test = harness();
    test.effect.mockRejectedValue(new CaseToolError('TOOL_BUSY', true));
    const fetcher = vi.fn(async () => response(call()));
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'TOOL_BUSY' });
    expect(test.effect).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.saved()).toMatchObject({ completed: false, pending: [call()] });
  });

  it('durably returns invalid arguments to the model so it can correct them instead of poisoning retries', async () => {
    const test = harness();
    test.effect.mockRejectedValueOnce(new EnvoiError('Invalid arguments', undefined, 'TOOL_ARGUMENTS_INVALID'));
    const fetcher = vi.fn().mockResolvedValueOnce(response(call('envoi_case_reply', {})))
      .mockImplementationOnce(async (_url, init) => {
        const result = JSON.parse(JSON.parse(init.body).input.at(-1).output);
        expect(result).toEqual({ ok: false, code: 'TOOL_ARGUMENTS_INVALID', retryable: false });
        return response({ ...call(), call_id: 'corrected-call' });
      }).mockImplementation(async () => done());
    await xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' });
    expect(test.effect.mock.calls[1][1]).toEqual({ text: 'Hello', idempotencyKey: 'stable-key' });
    expect(test.saved()).toMatchObject({ completed: true, pending: [] });
  });

  it('does not resample a completed turn or turn provider text into a reply', async () => {
    const test = harness();
    const fetcher = vi.fn(async () => done());
    const run = xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher });
    await run(test.turn, { workId: 'work_one' });
    await run(test.turn, { workId: 'work_one' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.effect).not.toHaveBeenCalled();
  });

  it('stops without tool effects when persisting the model call fails', async () => {
    const test = harness();
    vi.mocked(test.store.save).mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('Disk full'));
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: vi.fn(async () => response(call())) })(test.turn, { workId: 'work_one' }))
      .rejects.toThrow('Disk full');
    expect(test.effect).not.toHaveBeenCalled();
  });

  it('replays the original key when saving an already-returned tool result fails', async () => {
    const test = harness();
    const save = vi.mocked(test.store.save).getMockImplementation()!;
    let writes = 0;
    vi.mocked(test.store.save).mockImplementation(async record => {
      if (++writes === 3) throw new Error('Result journal failed');
      await save(record);
    });
    const fetcher = vi.fn().mockResolvedValueOnce(response(call())).mockImplementation(async () => done());
    const run = xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher });
    await expect(run(test.turn, { workId: 'work_one' })).rejects.toThrow('Result journal failed');
    expect(test.saved()?.pending).toEqual([call()]);
    await run(test.turn, { workId: 'work_one' });
    expect(test.effect.mock.calls[1]).toEqual(test.effect.mock.calls[0]);
    expect(test.saved()?.completed).toBe(true);
  });

  it('cancels TOOL_BUSY backoff without resampling or performing another tool attempt', async () => {
    const test = harness();
    test.effect.mockImplementation(async () => {
      test.controller.abort(new Error('Authority lost'));
      throw new CaseToolError('TOOL_BUSY', true);
    });
    const fetcher = vi.fn(async () => response(call()));
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' })).rejects.toBeDefined();
    expect(test.effect).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.saved()?.pending).toEqual([call()]);
  });

  it.each([
    { status: 'incomplete', output: [call()] },
    { status: 'completed', output: [] },
    { status: 'completed', output: [call('envoi_start_case')] },
    { status: 'completed', output: [call(), { ...call(), call_id: 'call-two' }] },
    { status: 'completed', output: [{ type: 'mcp_call', name: 'envoi_case_reply' }] }
  ])('rejects invalid or unsupported provider output without a tool effect: %j', async payload => {
    const test = harness();
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: vi.fn(async () => Response.json(payload)) })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'SCOPED_PROVIDER_RESPONSE_INVALID' });
    expect(test.effect).not.toHaveBeenCalled();
  });

  it.each(['{broken', 'null', '[]'])('returns malformed arguments %s to the model without poisoning recovery', async argumentsText => {
    const test = harness();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ...call(), arguments: argumentsText }))
      .mockImplementation(async (_url, init) => {
        expect(JSON.parse(JSON.parse(init.body).input.at(-1).output)).toEqual({ ok: false, code: 'TOOL_ARGUMENTS_INVALID', retryable: false });
        return done();
      });
    const run = xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher });
    await run(test.turn, { workId: 'work_one' });
    await run(test.turn, { workId: 'work_one' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(test.effect).not.toHaveBeenCalled();
    expect(test.saved()).toMatchObject({ completed: true, pending: [] });
  });

  it('gives the model only a sanitized typed tool refusal and never falls back to REST', async () => {
    const test = harness();
    test.effect.mockRejectedValueOnce(new CaseToolError('AUTHORITY_DENIED', false));
    const fetcher = vi.fn().mockResolvedValueOnce(response(call())).mockImplementationOnce(async (_url, init) => {
      const result = JSON.parse(JSON.parse(init.body).input.at(-1).output);
      expect(result).toEqual({ ok: false, code: 'AUTHORITY_DENIED', retryable: false });
      return done();
    });
    await xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' });
    expect(test.effect).toHaveBeenCalledTimes(1);
  });

  it('stops on authority loss and preserves the pending call for server-authorized recovery only', async () => {
    const test = harness();
    test.effect.mockRejectedValueOnce(new EnvoiError('Ended', 401, 'CASE_SESSION_ENDED'));
    const fetcher = vi.fn(async () => response(call()));
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'CASE_SESSION_ENDED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.saved()?.completed).toBe(false);
  });

  it('records human waiting as a completed turn without another provider request', async () => {
    const test = harness();
    const waiting = new EnvoiError('Await human', undefined, 'TURN_END_REQUIRED');
    test.effect.mockImplementationOnce(async () => { test.controller.abort(waiting); throw waiting; });
    const fetcher = vi.fn(async () => response(call('envoi_request_human', { authorityRef: 'g_one', question: 'Approve?', idempotencyKey: 'ask-one' })));
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'TURN_END_REQUIRED' });
    expect(test.saved()?.completed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing host identity or changing the model on an interrupted work item', async () => {
    const test = harness();
    const fetcher = vi.fn(async () => done());
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, {}))
      .rejects.toMatchObject({ code: 'SCOPED_HOST_CONTEXT_REQUIRED' });
    await test.store.save({ version: 1, workId: 'work_one', model: 'original', input: [], pending: [], providerCalls: 1, completed: false });
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'different', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'SCOPED_MODEL_CHANGED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('limits response bytes and provider requests across restart', async () => {
    const test = harness();
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: vi.fn(async () => new Response('x'.repeat(262145))) })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'SCOPED_PROVIDER_RESPONSE_INVALID' });
    await test.store.save({ version: 1, workId: 'work_one', model: 'model', input: [], pending: [], providerCalls: 16, completed: false });
    const fetcher = vi.fn(async () => done());
    await expect(xaiScopedTurn({ apiKey: 'key', model: 'model', store: test.store, fetch: fetcher })(test.turn, { workId: 'work_one' }))
      .rejects.toMatchObject({ code: 'SCOPED_TURN_LIMIT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
