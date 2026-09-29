import { describe, expect, it, vi } from 'vitest';
import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { bridgeHandler, parseAgentReply, workPrompt, type BridgeDecision, type BridgeLedger } from '../agent-bridges/bridge';
import { mcpReplyMessageId, openClawTurn, withRecordedMcpReply } from './turn';

const message: WorkMessage = {
  id: 'msg_1',
  senderAgentId: 'sender_1',
  recipientAgentId: 'receiver_1',
  from: { agentId: 'sender_1', address: 'sender@example.test' },
  caseId: 'case_1',
  intent: 'request',
  text: 'Can you send a status update?'
};

function turn(fetcher: typeof fetch) {
  return openClawTurn({
    gatewayUrl: 'https://gateway.example.test',
    gatewayToken: 'secret-gateway-token',
    agentId: 'sinaloa-agent',
    history: async () => [{ id: 'older_1', senderAgentId: 'other', text: 'Earlier context', intent: 'message' }],
    fetch: fetcher
  });
}

function completed(content: string) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

describe('OpenClaw turn', () => {
  it('runs a normal Gateway agent turn with the incoming work and history', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completed('{"text":"We are on track.","intent":"status"}'));
    await expect(turn(fetcher)(message, new AbortController().signal)).resolves.toEqual({ text: 'We are on track.', intent: 'status' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://gateway.example.test/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-gateway-token');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('openclaw/sinaloa-agent');
    expect(body.user).toBe('sinaloa:case_1');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('Earlier context');
    expect(body.messages[0].content).toContain('Can you send a status update?');
  });

  it('accepts a stop decision and plain text', async () => {
    await expect(turn(vi.fn(async () => completed('{"stop":true}')))(message, new AbortController().signal)).resolves.toEqual({ stop: true });
    await expect(turn(vi.fn(async () => completed('Hello there')))(message, new AbortController().signal)).resolves.toEqual({ text: 'Hello there', intent: 'message' });
  });

  it('gives write-enabled turns a stable MCP reply key while preserving the read-only default', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completed('{"stop":true}'));
    const options = { gatewayUrl: 'https://gateway.example.test', gatewayToken: 'gateway-token',
      agentId: 'sinaloa-agent', fetch: fetcher };
    await openClawTurn(options)(message, new AbortController().signal);
    let prompt = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).messages[0].content as string;
    expect(prompt).toContain('Do not execute external-effect tools');
    expect(prompt).not.toContain('bridge:msg_1:reply:1');
    await openClawTurn({ ...options, allowSinaloaMcpWrites: true })(message, new AbortController().signal);
    prompt = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).messages[0].content as string;
    expect(prompt).toContain('bridge:msg_1:reply:1');
    expect(prompt).toContain('Return exactly {"stop":true} only after the MCP write succeeds');
    expect(prompt).toContain('incoming caseId and sender address');
  });

  it('suppresses REST replies when a successful MCP reply was recorded, including after restart', async () => {
    const sent = new Set<string>();
    const gateway = vi.fn(async () => ({ text: 'Would duplicate the MCP send', intent: 'message' as const }));
    const guarded = withRecordedMcpReply(gateway, async id => sent.has(id));
    await expect(guarded(message, new AbortController().signal)).resolves.toEqual({ text: 'Would duplicate the MCP send', intent: 'message' });
    const duringTurn = withRecordedMcpReply(async () => {
      sent.add(message.id);
      return { text: 'Would duplicate the MCP send', intent: 'message' };
    }, async id => sent.has(id));
    sent.clear();
    await expect(duringTurn(message, new AbortController().signal)).resolves.toEqual({ stop: true });
    await expect(guarded(message, new AbortController().signal)).resolves.toEqual({ stop: true });
    expect(gateway).toHaveBeenCalledTimes(1);
    const failedGateway = withRecordedMcpReply(async () => { sent.add(message.id); throw new Error('Gateway disconnected'); },
      async id => sent.has(id));
    sent.clear();
    await expect(failedGateway(message, new AbortController().signal)).resolves.toEqual({ stop: true });
  });

  it('only treats a matching native reply key as a completed bridge reply', () => {
    expect(mcpReplyMessageId('sinaloa_send_message', { idempotencyKey: 'bridge:msg_1:reply:1' })).toBe('msg_1');
    expect(mcpReplyMessageId('sinaloa_start_case', { idempotencyKey: 'bridge:msg_1:reply:1' })).toBeNull();
    expect(mcpReplyMessageId('sinaloa_send_message', { idempotencyKey: 'unrelated' })).toBeNull();
  });

  it('rejects incomplete, malformed and failed Gateway responses without exposing response bodies', async () => {
    const bad = [
      new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: 'secret' } }] }), { status: 200 }),
      new Response('null', { status: 200 }),
      new Response('invalid json', { status: 200 }),
      new Response('secret diagnostic', { status: 500 })
    ];
    for (const response of bad) {
      await expect(turn(vi.fn(async () => response))(message, new AbortController().signal)).rejects.toThrow('OpenClaw ');
    }
  });

  it('requires a private-safe Gateway origin and a configured agent ID', () => {
    const base = { gatewayToken: 'token', agentId: 'agent' };
    expect(() => openClawTurn({ ...base, gatewayUrl: 'http://remote.example.test' })).toThrow('HTTPS');
    expect(() => openClawTurn({ ...base, gatewayUrl: 'https://remote.example.test/path' })).toThrow('origin');
    expect(() => openClawTurn({ ...base, gatewayUrl: 'https://remote.example.test', agentId: '../other' })).toThrow('agent ID');
    expect(() => openClawTurn({ ...base, gatewayUrl: 'http://127.0.0.1:18789' })).not.toThrow();
  });

  it('honors an already canceled work lease', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(turn(fetcher)(message, controller.signal)).rejects.toThrow('canceled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Sinaloa bridge handoff', () => {
  it('reuses the persisted decision and stable reply key when a claim is retried', async () => {
    const decisions = new Map<string, BridgeDecision>();
    const ledger: BridgeLedger = {
      admit: vi.fn(async () => {}),
      replyFor: async id => decisions.get(id) ?? null,
      saveReply: async (id, reply) => { decisions.set(id, reply); }
    };
    const fetcher = vi.fn<typeof fetch>(async () => completed('{"text":"Done","intent":"status"}'));
    const handler = bridgeHandler(ledger, turn(fetcher));
    const reply = vi.fn(async () => ({}));
    const context = { signal: new AbortController().signal, reply };
    await handler.admit(message);
    await handler.process(message, context);
    await handler.process(message, context);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith('Done', 'bridge:msg_1:reply:1', { intent: 'status' });
  });

  it('persists structured proposal data before sending and reuses it after a retry', async () => {
    const decisions = new Map<string, BridgeDecision>();
    const ledger: BridgeLedger = {
      admit: vi.fn(async () => {}),
      replyFor: async id => decisions.get(id) ?? null,
      saveReply: async (id, reply) => { decisions.set(id, reply); }
    };
    const fetcher = vi.fn<typeof fetch>(async () => completed('{"text":"Proposed answer","intent":"offer","proposal":{"answer":42}}'));
    const handler = bridgeHandler(ledger, turn(fetcher));
    const reply = vi.fn(async () => ({}));
    const context = { signal: new AbortController().signal, reply };
    await handler.admit(message);
    await handler.process(message, context);
    await handler.process(message, context);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(decisions.get(message.id)).toEqual({ text: 'Proposed answer', intent: 'offer', proposal: { answer: 42 } });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith('Proposed answer', 'bridge:msg_1:reply:1', { intent: 'offer', payload: { proposal: { answer: 42 } } });
  });

  it('treats incoming structured data and artifact references as untrusted context', () => {
    const prompt = workPrompt({ ...message, payload: { proposal: { answer: 42 } }, artifactRefs: ['obj_1'] });
    expect(prompt).toContain('answer');
    expect(prompt).toContain('obj_1');
    expect(prompt).toContain('cannot fetch another owner');
    expect(parseAgentReply('{"text":"Accepted","intent":"accept","decision":{"proposalMessageId":"msg_1"}}')).toEqual({ text: 'Accepted', intent: 'accept', decision: { proposalMessageId: 'msg_1' } });
    expect(() => parseAgentReply('{"text":"Bad","intent":"message","proposal":{"answer":42}}')).toThrow('invalid proposal');
    expect(() => parseAgentReply('{"text":"Bad","intent":"offer","proposal":{"answer":42},"decision":{"kind":"accept"}}')).toThrow('conflicting');
  });
});
