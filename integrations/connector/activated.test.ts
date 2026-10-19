import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { ConnectorSetupError, type ConnectorAdapter } from './adapter';
import { adoptActivatedConnection, readConnection, startConnection, type ActivatedConnection } from './core';
import { privateJson } from './store';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function fixtureBody(contractId: string, filename: string): any {
  const contract = contractRegistry.contracts.find(value => value.id === contractId)!;
  return (loadContractFixture(contract, filename) as any).response.body;
}
async function fixture(runtime: 'hermes' | 'openclaw' = 'hermes', paused = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:05:00.000Z'));
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-activated-')); directories.push(directory);
  const activation: ActivatedConnection = fixtureBody('agent-registration', paused ? 'activation-paused-agent.json' : 'activation-created.json');
  // Same canonical route-neutral envelope with the other supported adapter declaration.
  activation.installation.runtime.type = runtime;
  const status = fixtureBody(paused ? 'a3-pause-auth' : 'agent-registration', paused ? 'paused-status.json' : 'agent-status-installation.json');
  const requests: { url: string; init?: RequestInit }[] = [];
  let failConfigure = false, remoteRevoked = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/health')) return Response.json({ service: 'envoi' });
    if (url.endsWith('/api/agent/status')) {
      if (remoteRevoked) return Response.json(fixtureBody('a3-pause-auth', 'credential-revoked-claim.json'), { status: 401 });
      return Response.json(status);
    }
    if (url.endsWith('/api/agent/connection-status')) return Response.json({ checkedAt: new Date().toISOString() });
    throw new Error('Unexpected request: ' + url);
  }) as typeof fetch;
  const store = new FileBridgeStore(directory);
  const configure = vi.fn(async () => {
    expect((await store.load())?.agentId).toBe(activation.agent.id);
    if (failConfigure) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Retry the same installation');
  });
  const verify = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const discover = vi.fn(async (_options, previous) => previous ?? { profile: runtime, localSecret: 'private-runtime-config' });
  const adapter: ConnectorAdapter<any> = { runtime, discover,
    preflight: vi.fn(async () => {}), configure,
    async createBridge(_configuration, context) {
      return { connector: new EnvoiConnector(context.apiUrl, store, { fetch: context.fetch }), verify, close };
    }, describe: () => ({ runtime }) };
  const resolver = vi.fn(() => adapter);
  const options = { stateDir: directory, completionId: 'private-completion-id', fetch: fetcher,
    secureDirectory: async (value: string) => { await mkdir(value, { recursive: true }); return path.resolve(value); } };
  const adopt = () => adoptActivatedConnection('https://envoi.example', runtime, activation, resolver, options);
  return { directory, activation, requests, store, options, resolver, adapter, configure, discover, verify, close, adopt,
    failConfigure: (value: boolean) => { failConfigure = value; }, revoke: () => { remoteRevoked = true; },
    pause: () => { status.state = 'paused'; status.agent.status = 'paused'; } };
}

describe('approved activated credentials runtime handoff', () => {
  for (const runtime of ['hermes', 'openclaw'] as const) {
    it(`adopts ${runtime} using the canonical activation and status, never legacy enrollment`, async () => {
      const f = await fixture(runtime);
      const result = await f.adopt();
      expect(result).toEqual({ stateDir: f.directory, runtime, address: f.activation.agent.address, agentId: f.activation.agent.id, checks: 'passed' });
      expect(f.requests.map(value => new URL(value.url).pathname)).toEqual([
        '/api/agent/status', '/api/agent/status', ...(runtime === 'hermes' ? ['/api/agent/status'] : []), '/api/agent/connection-status'
      ]);
      expect(f.requests.every(value => value.init?.redirect === 'error')).toBe(true);
      expect(f.configure).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
      expect((await f.store.load() as any)._onboarding).toMatchObject({ completionId: f.options.completionId, installation: { id: f.activation.installation.id } });
      expect((await readConnection(f.directory)).activationSetup).toMatchObject({ completionId: f.options.completionId, installationId: f.activation.installation.id });
      expect(JSON.stringify(result)).not.toContain('PLACEHOLDER');
      expect(JSON.stringify(f.requests)).not.toContain('private-runtime-config');
      expect((await readdir(f.directory)).some(value => value.endsWith('.tmp') || value.endsWith('.lock'))).toBe(false);
    });
  }

  it('recovers after configuration failure, preserving rotated credentials, inbox cursors and helper completion marker', async () => {
    const f = await fixture(); f.failConfigure(true);
    await expect(f.adopt()).rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
    const saved = (await f.store.load())!;
    await f.store.save({ ...saved, agentApiToken: 'rotated-access-secret', agentRefreshToken: 'rotated-refresh-secret',
      cursor: 'durable-cursor', cursors: { [saved.inboxId]: 'durable-cursor' } });
    f.requests.length = 0; f.failConfigure(false);
    await f.adopt();
    const recovered = (await f.store.load())!;
    expect(recovered.agentRefreshToken).toBe('rotated-refresh-secret'); expect(recovered.cursor).toBe('durable-cursor');
    expect(recovered.cursors).toEqual({ [saved.inboxId]: 'durable-cursor' });
    expect((recovered as any)._onboarding.completionId).toBe(f.options.completionId);
    expect(f.requests[0].init?.headers).toMatchObject({ authorization: 'Bearer rotated-access-secret' });
    expect(f.discover.mock.calls[1][1]).toEqual({ profile: 'hermes', localSecret: 'private-runtime-config' });
    expect(f.requests.some(value => /activate|enroll/.test(value.url))).toBe(false);
  });

  it('accepts the helper credential commit even when connection configuration was never written', async () => {
    const f = await fixture(); f.failConfigure(true);
    await expect(f.adopt()).rejects.toThrow();
    await rm(path.join(f.directory, 'connection.json'));
    f.failConfigure(false); await f.adopt();
    expect((await readConnection(f.directory)).activationSetup?.completionId).toBe(f.options.completionId);
    expect((await f.store.load() as any)._onboarding.installation.id).toBe(f.activation.installation.id);
  });

  it('attaches an existing paused identity without verification, claiming, ready report or resume', async () => {
    const f = await fixture('hermes', true);
    expect((await f.adopt()).checks).toBe('deferred_while_paused');
    expect((await f.store.load())?.lifecycle).toMatchObject({ state: 'PAUSED', paused: true });
    expect(f.requests.every(value => value.url.endsWith('/api/agent/status'))).toBe(true);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('defers readiness if the owner pauses during Hermes adoption recovery', async () => {
    const f = await fixture();
    f.verify.mockImplementationOnce(async () => { f.pause(); throw new ConnectorSetupError('TOOLS_NOT_READY', 'Waiting'); });
    const result = await adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, toolRecoveryRetryMs: 1 });
    expect(result.checks).toBe('deferred_while_paused');
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.requests.some(request => request.url.endsWith('/api/agent/connection-status'))).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('stops Hermes adoption recovery on revocation before another model attempt', async () => {
    const f = await fixture();
    f.verify.mockImplementationOnce(async () => { f.revoke(); throw new ConnectorSetupError('TOOLS_NOT_READY', 'Waiting'); });
    await expect(adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, toolRecoveryRetryMs: 1 })).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.requests.some(request => request.url.endsWith('/api/agent/connection-status'))).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('persists revocation and makes zero subsequent service or adapter calls', async () => {
    const f = await fixture(); await f.adopt(); f.revoke(); f.requests.length = 0;
    const configurationCalls = f.configure.mock.calls.length;
    await expect(f.adopt()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(f.requests).toHaveLength(1);
    expect((await f.store.load())?.lifecycle?.state).toBe('REVOKED');
    f.requests.length = 0;
    await expect(f.adopt()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    await expect(startConnection(f.directory, new AbortController().signal, f.resolver, f.options)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(f.requests).toHaveLength(0); expect(f.configure).toHaveBeenCalledTimes(configurationCalls);
  });

  it('replaces a definitively revoked installation only with an explicit bound same-identity activation, then starts it', async () => {
    const f = await fixture(); await f.adopt(); f.revoke();
    await expect(f.adopt()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    const prior = await f.store.load() as any;
    const previousInstallationId = f.activation.installation.id;
    f.activation.installation.id = 'installation_explicit_successor';
    const successorCompletion = 'completion_explicit_successor';
    // This mirrors the helper's one atomic post-confirmation activation commit.
    const successor = { ...prior, lifecycle: undefined, agentApiToken: 'successor-access', agentRefreshToken: 'successor-refresh',
      _onboarding: { ...prior._onboarding, completionId: successorCompletion, installation: f.activation.installation,
        previousCompletionId: f.options.completionId, previousInstallationId, previousAgentId: prior.agentId,
        previousInboxId: prior.inboxId, previousAddress: prior.address } };
    await privateJson(path.join(f.directory, 'session.json'), { ...successor,
      _onboarding: { ...successor._onboarding, previousCompletionId: 'unbound-old-completion' } });
    await expect(adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, completionId: successorCompletion })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await privateJson(path.join(f.directory, 'session.json'), { ...successor,
      _onboarding: { ...successor._onboarding, previousAgentId: 'other-identity' } });
    await expect(adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, completionId: successorCompletion })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await privateJson(path.join(f.directory, 'session.json'), successor);
    // The replacement is newly active; the previous server revocation does not apply.
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/agent/status')) {
        const status = fixtureBody('agent-registration', 'agent-status-installation.json');
        status.installation.id = f.activation.installation.id; return Response.json(status);
      }
      return await f.options.fetch(input, init);
    }) as typeof fetch;
    await adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, fetch: fetcher, completionId: successorCompletion });
    expect((await readConnection(f.directory)).activationSetup).toMatchObject({ completionId: successorCompletion,
      installationId: f.activation.installation.id, agentId: prior.agentId, inboxId: prior.inboxId });
    expect((await f.store.load())?.agentRefreshToken).toBe('successor-refresh');
    const run = vi.spyOn(EnvoiConnector.prototype, 'run').mockImplementation(async () => {});
    try {
      await startConnection(f.directory, new AbortController().signal, f.resolver, { ...f.options, fetch: fetcher, control: false });
      expect(run).toHaveBeenCalledTimes(1);
    } finally { run.mockRestore(); }
  });

  it('refuses a different completion or installation without changing saved credentials', async () => {
    const f = await fixture(); await f.adopt();
    const before = await readFile(path.join(f.directory, 'session.json'), 'utf8'); f.requests.length = 0;
    await expect(adoptActivatedConnection('https://envoi.example', 'hermes', f.activation, f.resolver,
      { ...f.options, completionId: 'other-completion' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    f.activation.installation.id = 'installation_other';
    await expect(f.adopt()).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(await readFile(path.join(f.directory, 'session.json'), 'utf8')).toBe(before);
    expect(f.requests).toHaveLength(0);
  });

  it('refuses a different origin or runtime on recovery before forwarding any credentials', async () => {
    const f = await fixture(); await f.adopt();
    await rm(path.join(f.directory, 'connection.json')); f.requests.length = 0;
    await expect(adoptActivatedConnection('https://other.example', 'hermes', f.activation, f.resolver, f.options))
      .rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    f.activation.installation.runtime.type = 'openclaw';
    await expect(adoptActivatedConnection('https://envoi.example', 'openclaw', f.activation, f.resolver, f.options))
      .rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(f.requests).toHaveLength(0);
  });

  it('refuses missing operational credentials after configuration instead of restoring stale activation tokens', async () => {
    const f = await fixture(); await f.adopt();
    await rm(path.join(f.directory, 'session.json')); f.requests.length = 0;
    await expect(f.adopt()).rejects.toMatchObject({ code: 'STATE_INVALID' });
    expect(f.requests).toHaveLength(0); expect(await f.store.load()).toBeNull();
  });

  it('refuses an unmarked legacy session instead of replacing it', async () => {
    const f = await fixture(); await f.adopt();
    const { _onboarding: _removed, ...legacy } = await f.store.load() as any;
    await privateJson(path.join(f.directory, 'session.json'), legacy); f.requests.length = 0;
    await expect(f.adopt()).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(f.requests).toHaveLength(0);
  });

  it.each(['runtime', 'route', 'ended', 'identity', 'tokens'])('rejects invalid %s before persisting or preparing a runtime', async kind => {
    const f = await fixture();
    if (kind === 'runtime') f.activation.installation.runtime.type = 'grok';
    if (kind === 'route') f.activation.installation.connectionRoute = 'remote_mcp';
    if (kind === 'ended') f.activation.installation.status = 'ended';
    if (kind === 'identity') f.activation.installation.agentId = 'other-agent';
    if (kind === 'tokens') f.activation.agentRefreshToken = '';
    await expect(f.adopt()).rejects.toMatchObject({ code: 'ACTIVATION_INVALID' });
    expect(f.requests).toHaveLength(0); expect(f.discover).not.toHaveBeenCalled();
    expect(await f.store.load()).toBeNull();
  });
});
