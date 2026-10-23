import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
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
