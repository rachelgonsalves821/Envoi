import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorSession, HumanInstructionWorkMessage } from '../../sdk/typescript/src/connector';
import { bridgeHandler, workPrompt, withRecordedMcpReply, type BridgeDecision, type BridgeLedger } from './bridge';
import { FileBridgeStore } from './file-store';
import { authorizedHermesWrite } from '../hermes/lease-write';
import { createHermesBridge } from '../hermes/runtime';
import { createOpenClawBridge } from '../openclaw/runtime';
import { createGrokBridge } from '../grok/runtime';

const message: HumanInstructionWorkMessage = {
  id: 'instruction_one', kind: 'humanInstruction', senderType: 'human', senderHumanId: 'human_one',
  recipientInboxId: 'inbox_one', recipientAgentId: 'agent_one', from: { humanId: 'human_one' },
  caseId: 'case_one', type: 'instruction', text: 'Summarize our options.', status: 'delivered'
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function ledger(): BridgeLedger {
  const replies = new Map<string, BridgeDecision>();
  return { admit: vi.fn(async () => {}), replyFor: async id => replies.get(id) ?? null,
    saveReply: async (id, reply) => { replies.set(id, reply); } };
}

describe('human instructions in shared bridges', () => {
  it('identifies human guidance without inventing a sender or granting approval, native writes or asset sharing', () => {
    const prompt = workPrompt(message, [], { allowEnvoiMcpWrites: true, assetHandles: [{ handle: 'report', filename: 'report.pdf' }] });
    expect(prompt).toContain('authenticated human instruction');
    expect(prompt).toContain('not human approval, a policy decision, or authority');
    expect(prompt).toContain('transport processing only');
    expect(prompt).toContain('"sender":{"humanId":"human_one"}');
    expect(prompt).not.toContain('envoi_send_message');
    expect(prompt).not.toContain('report.pdf');
    expect(prompt).not.toContain('sender address as the reply target');
  });

  it('persists one provider decision and reuses a text-only local reply on retries', async () => {
    const turn = vi.fn(async () => ({ text: 'Here are your options.', intent: 'message' as const }));
    const handler = bridgeHandler(ledger(), turn);
    const reply = vi.fn(async () => ({}));
    const context = { signal: new AbortController().signal, reply };
    await handler.process(message, context);
    await handler.process(message, context);
    expect(turn).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith('Here are your options.', 'bridge:instruction_one:reply:1');
  });

  it.each([
    { text: 'Offer', intent: 'offer' as const, proposal: { amount: 1 } },
    { text: 'Approved', intent: 'accept' as const, decision: { approved: true } },
    { text: 'File', intent: 'message' as const, assetHandle: 'report' },
    { text: 'Status', intent: 'status' as const }
  ])('rejects native typed or asset replies to a human instruction: %j', async decision => {
    const exchange = vi.fn(async () => {});
    const handler = bridgeHandler(ledger(), async () => decision, exchange);
    const reply = vi.fn(async () => ({}));
    await expect(handler.process(message, { signal: new AbortController().signal, reply })).rejects.toThrow('local text message only');
    expect(reply).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('does not treat native MCP reply markers as proof of a human reply', async () => {
    const turn = vi.fn(async () => ({ text: 'Summary', intent: 'message' as const }));
    const wasSent = vi.fn(async () => true);
    expect(await withRecordedMcpReply(turn, wasSent)(message, new AbortController().signal)).toEqual({ text: 'Summary', intent: 'message' });
    expect(wasSent).not.toHaveBeenCalled();
  });

  it('denies Hermes native writes for human work, even with a forged native reply target', () => {
    const active = { message, signal: new AbortController().signal };
    expect(authorizedHermesWrite(active, 'envoi_send_message', {
      caseId: 'case_one', recipientAddress: 'peer@agents.example', idempotencyKey: 'bridge:instruction_one:reply:1'
    })).toBe(false);
    expect(authorizedHermesWrite(active, 'envoi_start_case', { idempotencyKey: 'interactive_send' })).toBe(false);
  });

  it.each(['OpenClaw', 'Hermes', 'Grok'])('processes human work and sends only a local text reply through the %s runtime with mocked hosts', async runtime => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-human-bridge-'));
    let bridge: { connector: { processWorkOnce(): Promise<boolean> }; close(): Promise<void> } | undefined;
    try {
      const store = new FileBridgeStore(directory);
      await store.init();
      const session: ConnectorSession = {
        agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@agents.example', cursor: null,
        agentApiToken: 'access-one', agentRefreshToken: 'refresh-one',
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      };
      await store.save(session);
      const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
      const prompts: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requests.push({ path: pathname, body, headers: new Headers(init?.headers) });
        if (pathname === '/api/agent/work/claim') return json({ work: { workId: message.id, message, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
        if (pathname.endsWith('/acknowledge') || pathname.endsWith('/complete')) {
          expect(body).toEqual({ leaseToken: 'fence_one' });
          const state = pathname.endsWith('/acknowledge') ? 'acknowledged' : 'processed';
          return json({ workId: message.id, status: state, receipt: { messageId: message.id, state } });
        }
        if (pathname === '/api/inboxes/inbox_one/messages' && !init?.body) return json([]);
        if (pathname === '/api/agent/instructions/instruction_one/reply') return json({
          id: 'local_reply', kind: 'humanInstructionReply', inboxId: 'inbox_one', caseId: 'case_one',
          senderType: 'agent', senderAgentId: 'agent_one', senderInboxId: 'inbox_one', recipientInboxId: 'inbox_one',
          recipientHumanId: 'human_one', from: { agentId: 'agent_one', address: 'one@agents.example' },
          inReplyTo: message.id, type: 'message', text: body.text, status: 'delivered'
        }, 201);
        const output = JSON.stringify({ text: 'Your options are summarized.', intent: 'message' });
        if (pathname === '/v1/chat/completions') {
          prompts.push(body.messages[0].content);
          return json({ choices: [{ finish_reason: 'stop', message: { content: output } }] });
        }
        if (pathname === '/v1/runs') { prompts.push(body.input); return json({ run_id: 'run_human' }, 202); }
        if (pathname === '/v1/runs/run_human') return json({ run_id: 'run_human', status: 'completed', output });
        if (pathname === '/v1/responses') {
          prompts.push(body.input);
          return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] });
        }
        throw new Error(`Unexpected bridge request: ${pathname}`);
      });
      const common = { apiUrl: 'https://api.example', stateDir: directory };
      if (runtime === 'OpenClaw') bridge = await createOpenClawBridge({ ...common, gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'gateway', agentId: 'agent_one' }, { env: {}, fetch: fetcher });
      if (runtime === 'Hermes') bridge = await createHermesBridge({ ...common, hermesUrl: 'http://127.0.0.1:8642', hermesKey: 'hermes' }, { env: {}, fetch: fetcher });
      if (runtime === 'Grok') bridge = await createGrokBridge({ ...common, apiKey: 'xai', model: 'grok' }, { env: {}, fetch: fetcher });
      expect(await bridge!.connector.processWorkOnce()).toBe(true);
      expect(await bridge!.connector.processWorkOnce()).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('authenticated human instruction');
      const replies = requests.filter(item => item.path.endsWith('/reply'));
      expect(replies).toHaveLength(2);
      for (const reply of replies) {
        expect(reply.body).toEqual({ text: 'Your options are summarized.', leaseToken: 'fence_one' });
        expect(reply.headers.get('idempotency-key')).toBe('bridge:instruction_one:reply:1');
        expect(reply.headers.get('authorization')).toBe('Bearer access-one');
      }
      expect(requests.filter(item => item.path.endsWith('/messages') && item.body.text)).toHaveLength(0);
      expect(await new FileBridgeStore(directory).isHumanInstruction(message.id)).toBe(true);
    } finally {
      await bridge?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
