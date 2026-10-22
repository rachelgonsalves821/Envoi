import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createPortableRestHost } from '../portable-rest';

test('trusted REST runtime refuses work before completed private activation', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.envoi-portable-rest-test-'));
  const options = {
    origin: 'https://www.envoi-agents.com', directory,
    runtime: { type: 'generic_https', version: '1.0.0' }, helper: { name: 'rest-host', version: '1.0.0' },
    deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false } as const,
    confirm: async () => true,
    handler: { admit: async () => {}, process: async () => {} },
    fetch: async () => { throw new Error('must not contact Envoi before completion'); },
  };
  try {
    const host = await createPortableRestHost(options);
    await expect(host.run(new AbortController().signal)).rejects.toThrow();
    await writeFile(path.join(directory, 'helper-state.json'), JSON.stringify({ version: 1, origin: options.origin,
      connectionRoute: 'local_helper', phase: 'completed', runtime: options.runtime, completionId: 'activation_example' }));
    await expect(host.run(new AbortController().signal)).rejects.toThrow('PORTABLE_REST_SETUP_INCOMPLETE');
    await writeFile(path.join(directory, 'helper-state.json'), JSON.stringify({ version: 1, origin: options.origin,
      connectionRoute: 'authenticated_rest', phase: 'completed', runtime: options.runtime, completionId: 'activation_example' }));
    await writeFile(path.join(directory, 'session.json'), JSON.stringify({ agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail',
      agentApiToken: 'envoi_agent_access_PRIVATE', agentRefreshToken: 'envoi_agent_refresh_PRIVATE',
      agentTokenExpiresAt: '2099-01-01T00:00:00Z', agentRefreshTokenExpiresAt: '2099-01-01T00:00:00Z', cursor: null,
      _onboarding: { origin: options.origin, completionId: 'activation_example', runtime: options.runtime,
        agent: { id: 'agent_other', address: 'one@envoi.mail' }, installation: { id: 'installation_one', agentId: 'agent_one',
          connectionRoute: 'authenticated_rest', deliveryMode: 'envoi_link', runtime: options.runtime } } }));
    await expect(host.run(new AbortController().signal)).rejects.toThrow('PORTABLE_REST_STATE_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('completed REST host processes canonical replies from the same private session after restart', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.envoi-portable-rest-test-'));
  const origin = 'https://www.envoi-agents.com';
  const runtime = { type: 'generic_https', version: '1.0.0' };
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const processed: string[] = [];
  const instruction = { id: 'instruction_one', kind: 'humanInstruction', senderType: 'human', senderHumanId: 'human_one',
    recipientInboxId: 'inbox_one', recipientAgentId: 'agent_one', from: { humanId: 'human_one' },
    caseId: 'case_one', type: 'instruction', text: 'Please respond.', status: 'delivered' };
  const native = { id: 'message_two', senderAgentId: 'agent_two', recipientAgentId: 'agent_one',
    from: { agentId: 'agent_two', address: 'two@envoi.mail' }, text: 'Please confirm.', status: 'delivered' };
  const work = [instruction, native];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const route = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path: route, body, headers: new Headers(init?.headers) });
    if (route === '/api/agent/work/claim') {
      const message = work.shift();
      return Response.json(message ? { work: { workId: message.id, message, leaseToken: `fence_${message.id}`,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } } : { work: null, state: 'idle' });
    }
    if (route.endsWith('/acknowledge') || route.endsWith('/complete')) {
      const state = route.endsWith('/acknowledge') ? 'acknowledged' : 'processed';
      const workId = route.split('/')[4];
      return Response.json({ workId, status: state, receipt: { messageId: workId, state } });
    }
    if (route === '/api/agent/instructions/instruction_one/reply') return Response.json({
      id: 'reply_one', kind: 'humanInstructionReply', inboxId: 'inbox_one', caseId: 'case_one',
      senderType: 'agent', senderAgentId: 'agent_one', senderInboxId: 'inbox_one', recipientInboxId: 'inbox_one',
      recipientHumanId: 'human_one', from: { agentId: 'agent_one', address: 'one@envoi.mail' },
      inReplyTo: 'instruction_one', type: 'message', text: body.text, status: 'delivered'
    }, { status: 201 });
    if (route === '/api/inboxes/inbox_one/messages') return Response.json({ id: 'reply_two' }, { status: 201 });
    throw new Error(`Unexpected route ${route}`);
  });
  const options = { origin, directory, runtime, helper: { name: 'rest-host', version: '1.0.0' },
    deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false } as const,
    confirm: async () => true,
    handler: { admit: async () => {}, process: async (message: { id: string }, context: { reply: (text: string, key: string) => Promise<unknown> }) => {
      processed.push(message.id);
      await context.reply(`Reply to ${message.id}`, `rest:${message.id}:reply`);
    } }, fetch: fetcher };
  try {
    await writeFile(path.join(directory, 'helper-state.json'), JSON.stringify({ version: 1, origin,
      connectionRoute: 'authenticated_rest', phase: 'completed', runtime, completionId: 'activation_example' }));
    await writeFile(path.join(directory, 'session.json'), JSON.stringify({ agentId: 'agent_one', inboxId: 'inbox_one',
      address: 'one@envoi.mail', agentApiToken: 'envoi_agent_access_PRIVATE', agentRefreshToken: 'envoi_agent_refresh_PRIVATE',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null,
      _onboarding: { origin, completionId: 'activation_example', runtime,
        agent: { id: 'agent_one', address: 'one@envoi.mail' }, installation: { id: 'installation_one', agentId: 'agent_one',
          connectionRoute: 'authenticated_rest', deliveryMode: 'envoi_link', runtime } } }));
    const first = await createPortableRestHost(options);
    expect(await first.connector.processWorkOnce()).toBe(true);
    const restarted = await createPortableRestHost(options);
    expect(await restarted.connector.processWorkOnce()).toBe(true);
    expect(await restarted.connector.processWorkOnce()).toBe(false);
    expect(processed).toEqual(['instruction_one', 'message_two']);
    expect(requests.filter(request => request.path.endsWith('/complete'))).toHaveLength(2);
    const humanReply = requests.find(request => request.path.endsWith('/reply'))!;
    expect(humanReply.body).toEqual({ text: 'Reply to instruction_one', leaseToken: 'fence_instruction_one' });
    expect(humanReply.headers.get('idempotency-key')).toBe('rest:instruction_one:reply');
    const nativeReply = requests.find(request => request.path === '/api/inboxes/inbox_one/messages')!;
    expect(nativeReply.body).toMatchObject({ senderAgentId: 'agent_one', recipientEmail: 'two@envoi.mail', text: 'Reply to message_two' });
    expect(nativeReply.headers.get('idempotency-key')).toBe('rest:message_two:reply');
    expect(requests.every(request => request.headers.get('authorization') === 'Bearer envoi_agent_access_PRIVATE')).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
