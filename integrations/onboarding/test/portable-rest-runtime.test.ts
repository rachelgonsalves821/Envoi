import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('REST host privately adopts activation and processes canonical replies after restart', async () => {
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
  const fixture = async (name: string) => (JSON.parse(await readFile(
    new URL(`../../../test/contract-fixtures/agent-registration/${name}.json`, import.meta.url), 'utf8')) as {
    response: { body: Record<string, any> }
  }).response.body;
  const created = await fixture('registration-created');
  const approved = await fixture('registration-approved');
  const activated = await fixture('activation-created');
  const status = await fixture('agent-status-installation');
  const now = Date.now();
  created.expiresAt = new Date(now + 600_000).toISOString();
  created.claim.expiresAt = created.expiresAt;
  approved.activationExpiresAt = new Date(now + 780_000).toISOString();
  activated.agent.id = 'agent_one';
  activated.agent.address = 'one@envoi.mail';
  activated.inboxId = 'inbox_one';
  activated.installation.agentId = 'agent_one';
  activated.installation.connectionRoute = 'authenticated_rest';
  activated.installation.runtime = runtime;
  activated.agentTokenExpiresAt = new Date(now + 900_000).toISOString();
  activated.agentRefreshTokenExpiresAt = new Date(now + 86_400_000).toISOString();
  status.installation.connectionRoute = 'authenticated_rest';
  status.agent.id = activated.agent.id;
  status.agent.address = activated.agent.address;
  status.inboxId = activated.inboxId;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const route = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path: route, body, headers: new Headers(init?.headers) });
    if (route === '/api/onboarding/routes') return Response.json(await fixture('routes-available-rest'));
    if (route === '/api/agent-registrations') {
      expect(body).toMatchObject({ connectionRoute: 'authenticated_rest', runtime,
        helper: { name: 'rest-host', version: '1.0.0' } });
      return Response.json(created, { status: 201 });
    }
    if (route === '/api/agent-registrations/registration_example') return Response.json(approved);
    if (route === '/api/agent-installations/activate') {
      expect(body).toMatchObject({ registrationId: 'registration_example', deliveryMode: 'envoi_link' });
      expect(typeof body.activationId).toBe('string');
      return Response.json(activated, { status: 201 });
    }
    if (route === '/api/agent/status') return Response.json(status);
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
    const first = await createPortableRestHost(options);
    const pending = await first.connect();
    expect(pending).toMatchObject({ state: 'pending_approval' });
    expect(JSON.stringify(pending)).not.toContain('envoi_reg_');
    const journalPath = path.join(directory, 'helper-state.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
    expect(journal.bootstrapToken).toBe(created.bootstrapToken);
    // Advance the fixture's polling interval without waiting five real seconds.
    await writeFile(journalPath, JSON.stringify({ ...journal, nextPollAt: 0 }));
    const connected = await first.resume();
    expect(connected).toMatchObject({ state: 'connected', connectionRoute: 'authenticated_rest',
      reachability: 'not_verified_closed_app' });
    expect(JSON.stringify(connected)).not.toMatch(/envoi_reg_|envoi_agent_/);
    const saved = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')) as Record<string, any>;
    expect(saved.agentApiToken).toBe(activated.agentApiToken);
    expect(saved._onboarding.installation.connectionRoute).toBe('authenticated_rest');
    expect((JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>).bootstrapToken).toBeUndefined();
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
    expect(requests.filter(request => request.path.startsWith('/api/agent/work/') || request.path.endsWith('/reply')
      || request.path === '/api/inboxes/inbox_one/messages').every(request => request.headers.get('authorization')
        === `Bearer ${activated.agentApiToken}`)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
