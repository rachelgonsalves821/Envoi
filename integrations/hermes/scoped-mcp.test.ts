import { describe, expect, it, vi } from 'vitest';
import { CaseToolError } from '../../sdk/typescript/src/case-tools';
import { EnvoiError } from '../../sdk/typescript/src/index';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import { bindScopedMcpTurn } from './scoped-mcp';
import { CaseSessionChannel } from '../../sdk/typescript/src/case-session';
import { scopedTurnHandler } from '../agent-bridges/scoped-turn';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';

function harness(label = 'one') {
  const controller = new AbortController();
  const effect = vi.fn(async () => ({ messageRef: `message_${label}` }));
  const turn = { instruction: 'Scoped', signal: controller.signal, context: { agentAddress: `${label}@example.com` }, snapshot: {},
    tools: [{ name: 'envoi_case_reply', inputSchema: { type: 'object' } }], callTool: effect } as unknown as ScopedModelTurn;
  const binding = bindScopedMcpTurn(turn);
  const rpc = async (method: string, params?: unknown, id: string | number = 1) => JSON.parse((await binding.dispatch(JSON.stringify({ jsonrpc: '2.0', id, method, params })))!);
  const call = () => rpc('tools/call', { name: 'envoi_case_reply', arguments: { text: label, idempotencyKey: label } });
  const initialize = async () => {
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Hermes', version: 'test' } });
    await binding.dispatch(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  };
  return { binding, rpc, call, initialize, controller, effect, turn };
}

describe('Hermes immutable per-turn MCP boundary', () => {
  it('consumes the approved canonical snapshot and reply through the real private SDK channel', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06Z'));
    const sessions = contractRegistry.contracts.find(contract => contract.id === 'case-session')!;
    const tools = contractRegistry.contracts.find(contract => contract.id === 'case-tools')!;
    const source = loadContractFixture(sessions, 'session-created.json') as Record<string, any>;
    const session = source.response.body.session;
    const reply = loadContractFixture(tools, 'reply-agent-work.json') as Record<string, any>;
    const requests: string[] = [];
    const channel = new CaseSessionChannel(source.response.body, {
      agentId: session.agentId, workId: session.workId, caseId: session.caseId, workKind: session.workKind,
      counterpartyAddress: session.counterparty.address, agentAddress: source.client.modelVisible.agentAddress
    }, { origin: 'https://envoi.example', fetch: vi.fn(async (_url, options) => {
      const request = JSON.parse(String(options!.body)); requests.push(request.params.name);
      const target = loadContractFixture(tools, request.params.name === 'envoi_case_snapshot' ? 'snapshot-agent-work.json' : 'reply-agent-work.json') as Record<string, any>;
      const body = structuredClone(target.response.body); body.id = request.id;
      return Response.json(body);
    }) });
    try {
      const handler = scopedTurnHandler({ admit: async () => {}, async run(turn) {
        const binding = bindScopedMcpTurn(turn);
        const send = async (method: string, params?: unknown) => JSON.parse((await binding.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))!);
        try {
          expect(requests).toEqual(['envoi_case_snapshot']);
          await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Hermes', version: 'test' } });
          await binding.dispatch(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
          const rejected = await send('tools/call', { ...reply.request.body.params, arguments: { ...reply.request.body.params.arguments, recipientAddress: 'other@example.com' } });
          expect(rejected.error.code).toBe(-32602);
          const result = await send('tools/call', reply.request.body.params);
          expect(result.result).toEqual(reply.response.body.result);
          expect(requests).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
          expect(JSON.stringify(result)).not.toContain(session.token);
        } finally { binding.close(); }
      } });
      await handler.process(channel, { signal: channel.signal, workId: session.workId });
    } finally { channel.invalidate(); vi.useRealTimers(); }
  });

  it('requires negotiation and advertises only captured tools without host credentials or identity', async () => {
    const test = harness();
    expect((await test.call()).error).toBeDefined();
    await test.initialize();
    const tools = await test.rpc('tools/list');
    expect(tools.result.tools).toEqual(test.turn.tools);
    expect(JSON.stringify(tools)).not.toMatch(/agentAddress|example.com|installation|token|lease|workId/);
    expect(test.binding.discovered).toBe(true);
    const reply = await test.call();
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ ok: true, tool: 'envoi_case_reply', result: { messageRef: 'message_one' } });
    expect(reply.result.isError).toBe(false);
    test.binding.close();
  });

  it('keeps simultaneous cases separate and cannot redirect a closed callback to a successor', async () => {
    const first = harness('first'), second = harness('second');
    await Promise.all([first.initialize(), second.initialize()]);
    await Promise.all([first.call(), second.call()]);
    first.binding.close();
    expect((await first.call()).error).toBeDefined();
    await second.call();
    expect(first.effect).toHaveBeenCalledExactlyOnceWith('envoi_case_reply', { text: 'first', idempotencyKey: 'first' });
    expect(second.effect).toHaveBeenCalledTimes(2);
    expect(second.effect.mock.calls.every(args => (args as unknown[])[1] && JSON.stringify(args).includes('second'))).toBe(true);
    second.binding.close();
  });

  it('captures the dispatcher and schemas instead of consulting a mutable current turn', async () => {
    const test = harness();
    const original = structuredClone(test.turn.tools);
    (test.turn.tools as unknown as Array<any>)[0].inputSchema = { type: 'array' };
    test.turn.callTool = vi.fn(async () => { throw new Error('Replacement must not be used'); });
    await test.initialize();
    expect((await test.rpc('tools/list')).result.tools).toEqual(original);
    await test.call(); expect(test.effect).toHaveBeenCalledTimes(1);
    test.binding.close();
  });

  it('cancels pending and queued requests promptly without leaking late results or admitting later tools', async () => {
    const test = harness(); await test.initialize();
    let release!: () => void;
    test.effect.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { messageRef: 'late_private' }; });
    const first = test.call();
    await vi.waitFor(() => expect(test.effect).toHaveBeenCalledTimes(1));
    const second = test.call();
    test.controller.abort();
    const outputs = await Promise.all([first, second]);
    expect(outputs.every(output => output.error && !JSON.stringify(output).includes('late_private'))).toBe(true);
    release(); await Promise.resolve();
    expect((await test.call()).error).toBeDefined(); expect(test.effect).toHaveBeenCalledTimes(1);
  });

  it('serializes calls and bounds queued admission', async () => {
    const test = harness(); await test.initialize();
    let release!: () => void;
    test.effect.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { messageRef: 'first' }; });
    const requests = Array.from({ length: 16 }, () => test.call());
    await vi.waitFor(() => expect(test.effect).toHaveBeenCalledTimes(1));
    const refused = await test.call();
    expect(JSON.parse(refused.result.content[0].text)).toMatchObject({ ok: false, code: 'TOOL_BUSY', retryable: true });
    release(); await Promise.all(requests); expect(test.effect).toHaveBeenCalledTimes(16);
    test.binding.close();
  });

  it('closes before releasing a fatal operation so an already queued callback cannot start', async () => {
    const test = harness(); await test.initialize();
    test.effect.mockRejectedValueOnce(new EnvoiError('Expired', undefined, 'CASE_SESSION_EXPIRED'));
    const results = await Promise.all([test.call(), test.call()]);
    expect(results.every(reply => reply.error)).toBe(true);
    expect(test.effect).toHaveBeenCalledTimes(1);
    expect(test.binding.active).toBe(false);
  });

  it('suppresses success when closed between operation completion and dispatch resumption', async () => {
    const test = harness(); await test.initialize();
    test.effect.mockImplementationOnce(() => {
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { test.binding.close(); })));
      return Promise.resolve({ messageRef: 'late_private' });
    });
    const reply = await test.call();
    expect(test.effect).toHaveBeenCalledTimes(1);
    expect(test.binding.active).toBe(false);
    expect(reply).toMatchObject({ error: { code: -32000 } });
    expect(JSON.stringify(reply)).not.toContain('late_private');
  });

  it.each(['AUTHORITY_DENIED', 'TOOL_BUSY', 'ASSET_NOT_CLEAN'])('preserves typed refusal %s without forwarding raw errors', async code => {
    const test = harness(); await test.initialize();
    test.effect.mockRejectedValueOnce(new CaseToolError(code, code === 'TOOL_BUSY'));
    const reply = await test.call();
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ ok: false, tool: 'envoi_case_reply', code, retryable: code === 'TOOL_BUSY' });
    expect(test.binding.active).toBe(true); test.binding.close();
  });

  it.each(['CREDENTIAL_REVOKED', 'CASE_SESSION_EXPIRED', 'TURN_END_REQUIRED'])('permanently closes on host/session failure %s', async code => {
    const test = harness(); await test.initialize();
    test.effect.mockRejectedValueOnce(new EnvoiError('private-token-must-not-escape', undefined, code));
    expect(JSON.stringify(await test.call())).not.toContain('private-token');
    expect(test.binding.active).toBe(false);
    await test.call(); expect(test.effect).toHaveBeenCalledTimes(1);
  });

  it.each(['[]', 'null', 'bad json', JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }), ' '.repeat(262145)])('rejects malformed or oversized request %j', async raw => {
    const test = harness(); expect(JSON.parse((await test.binding.dispatch(raw))!).error).toBeDefined(); test.binding.close();
  });

  it.each(['envoi_start_case', 'envoi_agent_info', 'envoi_send_message', 'terminal'])('refuses unavailable tool %s', async name => {
    const test = harness(); await test.initialize();
    expect((await test.rpc('tools/call', { name, arguments: {} })).error.code).toBe(-32602);
    expect(test.effect).not.toHaveBeenCalled(); test.binding.close();
  });

  it('rejects method/scope overrides and does not re-execute observed ACP updates', async () => {
    const test = harness(); await test.initialize();
    expect((await test.rpc('tools/call', { name: 'envoi_case_reply', arguments: {}, caseId: 'other' })).error).toBeDefined();
    expect((await test.rpc('session/update', { function_call: { name: 'envoi_case_reply' } })).error.code).toBe(-32601);
    expect(test.effect).not.toHaveBeenCalled(); test.binding.close();
  });
});
