import { describe, expect, it, vi } from 'vitest';
import { SinaloaConnector, type ConnectorSession, type HumanInstructionWorkMessage, type WorkHandler } from '../src/connector';

const instruction = (): HumanInstructionWorkMessage => ({
  id: 'instruction_one', kind: 'humanInstruction', senderType: 'human', senderHumanId: 'human_one',
  recipientInboxId: 'inbox_one', recipientAgentId: 'agent_one', from: { humanId: 'human_one' },
  caseId: 'case_one', type: 'instruction', text: 'Please summarize the current options.', status: 'delivered'
});
const session = (): ConnectorSession => ({
  agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@agents.example', cursor: null,
  agentApiToken: 'access-one', agentRefreshToken: 'refresh-one',
  agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function fixture(message: Record<string, unknown> = instruction(), process?: WorkHandler['process'], options: { shortLease?: boolean; rejectReply?: boolean; replyChanges?: Record<string, unknown>; replyStatus?: number } = {}) {
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  let saved = session();
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body, headers: new Headers(init?.headers) });
    const workId = 'instruction_one';
    if (path.endsWith('/claim')) {
      attempts += 1;
      return json({ work: { workId, message, leaseToken: `fence_${attempts}`,
        leaseExpiresAt: new Date(Date.now() + (options.shortLease ? 250 : 60_000)).toISOString() } });
    }
    if (path.endsWith('/renew')) return json({ workId, leaseToken: `fence_${attempts}`, leaseExpiresAt: new Date(Date.now() + 1_000).toISOString() });
    if (path.endsWith('/acknowledge') || path.endsWith('/complete')) {
      const state = path.endsWith('/acknowledge') ? 'acknowledged' : 'processed';
      return json({ workId, status: state, receipt: { messageId: message.id, state } });
    }
    if (path.endsWith('/fail')) return json({ workId, status: 'retryable' });
    if (path === '/api/agent-token') return json({ ...saved, agentApiToken: 'access-two', agentRefreshToken: 'refresh-two' });
    if (path === '/api/agent/instructions/instruction_one/reply') {
      if (options.rejectReply && new Headers(init?.headers).get('authorization') === 'Bearer access-one') return json({ error: 'Expired' }, 401);
      expect(body.leaseToken).toBe(`fence_${attempts}`);
      return json({ id: 'local_reply', kind: 'humanInstructionReply', inboxId: 'inbox_one', caseId: 'case_one',
        senderType: 'agent', senderAgentId: 'agent_one', senderInboxId: 'inbox_one', recipientInboxId: 'inbox_one',
        recipientHumanId: 'human_one', from: { agentId: 'agent_one', address: 'one@agents.example' },
        inReplyTo: 'instruction_one', type: 'message', text: String(body.text).trim(), status: 'delivered', ...options.replyChanges }, options.replyStatus ?? 201);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const handler: WorkHandler = { admit: vi.fn(async () => {}), process: process ?? vi.fn(async (_message, context) => {
    await context.reply('Here are the options.', 'bridge:instruction_one:reply:1');
  }) };
  const connector = new SinaloaConnector('https://api.example', {
    load: async () => saved, save: async next => { saved = next; }
  }, { fetch: fetcher, handler });
  return { connector, requests, handler, saved: () => saved };
}

describe('truthful human instruction connector work', () => {
  it('admits address-free human work and replies locally under the normal fenced settlement flow', async () => {
    const { connector, requests, handler } = fixture();
    expect(await connector.processWorkOnce()).toBe(true);
    expect(handler.admit).toHaveBeenCalledWith(instruction());
    expect(requests[0].body).toEqual({ acceptHumanInstructions: true });
    expect(requests.map(item => item.path)).toEqual([
      '/api/agent/work/claim', '/api/agent/work/instruction_one/acknowledge',
      '/api/agent/instructions/instruction_one/reply', '/api/agent/work/instruction_one/complete'
    ]);
    const reply = requests[2];
    expect(reply.body).toEqual({ text: 'Here are the options.', leaseToken: 'fence_1' });
    expect(reply.headers.get('authorization')).toBe('Bearer access-one');
    expect(reply.headers.get('idempotency-key')).toBe('bridge:instruction_one:reply:1');
    for (const settlement of [requests[1], requests[3]]) expect(settlement.body).toEqual({ leaseToken: 'fence_1' });
  });

  it.each([
    { senderType: 'agent' }, { type: 'message' }, { senderHumanId: 'different_human' },
    { from: { humanId: 'human_one', address: 'forged@agents.example' } },
    { from: { humanId: 'human_one', agentId: 'forged_agent' } }, { from: null },
    { senderAgentId: 'forged_agent' }, { senderInboxId: 'forged_inbox' }, { senderEmail: 'forged@agents.example' },
    { recipientInboxId: 'other_inbox' }, { recipientAgentId: 'other_agent' }, { caseId: null },
    { caseId: '../other_case' }, { text: '' }, { status: 'processed' },
    { kind: 'nativeAgentMessage', from: { humanId: 'human_one', address: 'forged@agents.example' } },
    { kind: 'nativeAgentMessage', senderType: 'agent', from: { agentId: 'forged_agent', address: 'forged@agents.example' } }
  ])('rejects malformed or mixed human envelopes before admission: %j', async changes => {
    const { connector, requests, handler } = fixture({ ...instruction(), ...changes });
    await expect(connector.processWorkOnce()).rejects.toThrow();
    expect(handler.admit).not.toHaveBeenCalled();
    expect(handler.process).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('refreshes rejected credentials and reuses the same local reply request and key', async () => {
    const { connector, requests, saved } = fixture(instruction(), undefined, { rejectReply: true });
    await connector.processWorkOnce();
    const replies = requests.filter(item => item.path.endsWith('/reply'));
    expect(replies).toHaveLength(2);
    expect(replies.map(item => item.headers.get('authorization'))).toEqual(['Bearer access-one', 'Bearer access-two']);
    expect(replies.map(item => item.headers.get('idempotency-key'))).toEqual(Array(2).fill('bridge:instruction_one:reply:1'));
    expect(replies[0].body).toEqual(replies[1].body);
    expect(saved().agentRefreshToken).toBe('refresh-two');
  });

  it('keeps replies text-only and reports a retryable fenced failure for typed native writes', async () => {
    const { connector, requests } = fixture(instruction(), async (_message, context) => {
      await context.reply('Approved', 'stable_key', { intent: 'accept', payload: { decision: { approved: true } } });
    });
    await expect(connector.processWorkOnce()).rejects.toThrow('text only');
    expect(requests.map(item => item.path)).not.toContain('/api/agent/instructions/instruction_one/reply');
    expect(requests.at(-1)).toMatchObject({ path: '/api/agent/work/instruction_one/fail', body: { leaseToken: 'fence_1', retryable: true, reasonCode: 'HANDLER_FAILED' } });
  });

  it('renews the same human lease during long processing', async () => {
    const { connector, requests } = fixture(instruction(), async (_message, context) => {
      await new Promise(resolve => setTimeout(resolve, 320));
      await context.reply('Summary', 'stable_key');
    }, { shortLease: true });
    await connector.processWorkOnce();
    const renewals = requests.filter(item => item.path.endsWith('/renew'));
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals.every(item => item.body.leaseToken === 'fence_1')).toBe(true);
    expect(requests.at(-1)?.path).toContain('/complete');
  });

  it('does not reply or complete after cancellation invalidates a human lease', async () => {
    const stop = new AbortController();
    const { connector, requests } = fixture(instruction(), async (_message, context) => {
      stop.abort();
      await context.reply('Too late', 'stable_key');
    });
    await expect(connector.processWorkOnce(stop.signal)).rejects.toThrow('lease');
    expect(requests).toHaveLength(2);
  });

  it('reuses a stable reply key on reclaims while acknowledgements and completions use new fences', async () => {
    let count = 0;
    const { connector, requests } = fixture(instruction(), async (_message, context) => {
      await context.reply('Summary', 'bridge:instruction_one:reply:1');
      if (++count === 1) throw new Error('Process interrupted after reply');
    });
    await expect(connector.processWorkOnce()).rejects.toThrow('interrupted');
    await connector.processWorkOnce();
    const replies = requests.filter(item => item.path.endsWith('/reply'));
    expect(replies.map(item => item.headers.get('idempotency-key'))).toEqual(Array(2).fill('bridge:instruction_one:reply:1'));
    const acknowledgements = requests.filter(item => item.path.endsWith('/acknowledge'));
    expect(acknowledgements.map(item => item.body.leaseToken)).toEqual(['fence_1', 'fence_2']);
    expect(acknowledgements[0].headers.get('idempotency-key')).not.toBe(acknowledgements[1].headers.get('idempotency-key'));
    expect(requests.at(-1)?.body).toEqual({ leaseToken: 'fence_2' });
    expect(replies.map(item => item.body.leaseToken)).toEqual(['fence_1', 'fence_2']);
  });

  it.each([
    { id: '' }, { kind: 'nativeAgentMessage' }, { inReplyTo: 'other_instruction' }, { caseId: 'other_case' },
    { senderAgentId: 'other_agent' }, { recipientHumanId: 'other_human' }, { recipientInboxId: 'other_inbox' },
    { from: { agentId: 'other_agent', address: 'forged@agents.example' } }, { status: 'queued' }, { text: 'Different reply' }
  ])('does not complete on a mismatched successful reply response: %j', async replyChanges => {
    const { connector, requests } = fixture(instruction(), undefined, { replyChanges });
    await expect(connector.processWorkOnce()).rejects.toThrow('invalid human instruction reply');
    expect(requests.some(item => item.path.endsWith('/complete'))).toBe(false);
    expect(requests.at(-1)?.path).toContain('/fail');
  });

  it('does not complete if the handler swallows a failed human reply', async () => {
    const { connector, requests } = fixture(instruction(), async (_message, context) => {
      await context.reply('Summary', 'stable_key').catch(() => {});
    }, { replyStatus: 409 });
    await expect(connector.processWorkOnce()).rejects.toThrow();
    expect(requests.some(item => item.path.endsWith('/complete'))).toBe(false);
    expect(requests.at(-1)?.path).toContain('/fail');
  });
});
