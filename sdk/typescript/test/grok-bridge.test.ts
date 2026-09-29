import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bridgeHandler, parseAgentReply } from '../../../integrations/agent-bridges/bridge';
import { FileBridgeStore } from '../../../integrations/agent-bridges/file-store';
import { xaiTurn } from '../../../integrations/agent-bridges/providers';
import type { WorkMessage } from '../src/connector';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const message = (): WorkMessage => ({
  id: 'msg_one', senderAgentId: 'agent_a', recipientAgentId: 'agent_b',
  from: { agentId: 'agent_a', address: 'a@sinaloa.mail' }, caseId: 'case_one', text: 'Can we agree?', intent: 'request'
});

describe('Grok-backed durable bridge', () => {
  it('sends case history to the xAI Responses API without Sinaloa credentials in the prompt', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xai-secret');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'grok-4.7', store: false });
      expect(body.input).toContain('Earlier proposal');
      expect(body.input).not.toContain('xai-secret');
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"text":"Agreed","intent":"accept"}' }] }] }), { status: 200 });
    });
    const turn = xaiTurn({ apiKey: 'xai-secret', model: 'grok-4.7', fetch: fetcher as typeof fetch,
      history: async () => [{ id: 'msg_prev', senderAgentId: 'agent_b', intent: 'offer', text: 'Earlier proposal' }] });
    expect(await turn(message(), new AbortController().signal)).toEqual({ text: 'Agreed', intent: 'accept' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('persists the model reply before sending and reuses it after a failed settlement', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sinaloa-grok-test-'));
    dirs.push(dir);
    const store = new FileBridgeStore(dir);
    await store.init();
    const turn = vi.fn(async () => ({ text: 'Yes', intent: 'message' as const }));
    const handler = bridgeHandler(store, turn);
    const incoming = message();
    await handler.admit(incoming);
    const replies: string[] = [];
    const context = { signal: new AbortController().signal, reply: async (_text: string, key: string) => {
      replies.push(key);
      if (replies.length === 1) throw new Error('simulate server interruption');
    } };
    await expect(handler.process(incoming, context)).rejects.toThrow('server interruption');
    await handler.process(incoming, context);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(replies).toEqual(['bridge:msg_one:reply:1', 'bridge:msg_one:reply:1']);
    expect(await new FileBridgeStore(dir).replyFor(incoming.id)).toEqual({ text: 'Yes', intent: 'message' });
  });

  it('treats plain text as an ordinary message and rejects empty replies', () => {
    expect(parseAgentReply('Hello')).toEqual({ text: 'Hello', intent: 'message' });
    expect(parseAgentReply('{"stop":true}')).toEqual({ stop: true });
    expect(() => parseAgentReply('   ')).toThrow('empty');
  });

  it('does not create reply loops for receipts or a persisted stop decision', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sinaloa-stop-test-'));
    dirs.push(dir);
    const store = new FileBridgeStore(dir);
    await store.init();
    const turn = vi.fn(async () => ({ stop: true as const }));
    const handler = bridgeHandler(store, turn);
    const reply = vi.fn(async () => ({}));
    const context = { signal: new AbortController().signal, reply };
    await handler.admit(message());
    await handler.process(message(), context);
    await handler.process(message(), context);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    const receipt = { ...message(), id: 'msg_receipt', intent: 'receipt' };
    await handler.admit(receipt);
    await handler.process(receipt, context);
    expect(turn).toHaveBeenCalledTimes(1);
  });
});
