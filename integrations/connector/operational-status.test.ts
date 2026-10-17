import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { operationalConnectionStatus } from './core';
import { privateJson } from './store';

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function body(contractId: string, filename: string): any {
  return (loadContractFixture(contractRegistry.contracts.find(value => value.id === contractId)!, filename) as any).response.body;
}
async function fixture(live = false) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T12:05:00Z'));
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-status-')); directories.push(directory);
  const activation = body('agent-registration', 'activation-created.json');
  const store = new FileBridgeStore(directory); await store.init();
  const context = { origin: 'https://envoi.example', runtime: activation.installation.runtime,
    stateDirectory: directory, completionId: 'completion_example' };
  await privateJson(path.join(directory, 'session.json'), { agentId: activation.agent.id, inboxId: activation.inboxId,
    address: activation.agent.address, cursor: 'saved-cursor', agentApiToken: activation.agentApiToken,
    agentRefreshToken: activation.agentRefreshToken, agentTokenExpiresAt: activation.agentTokenExpiresAt,
    agentRefreshTokenExpiresAt: activation.agentRefreshTokenExpiresAt,
    _onboarding: { ...context, agent: activation.agent, installation: activation.installation, effectivePermissions: activation.effectivePermissions } });
  const status = body('agent-registration', 'agent-status-installation.json');
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let respond = async () => Response.json(status);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init }); return await respond();
  });
  const queryControl = vi.fn(async () => { if (live) return { status: 'running' }; throw Object.assign(new Error('No control'), { code: 'ENOENT' }); });
  const options = { fetch: fetcher as typeof fetch, queryControl };
  const read = () => operationalConnectionStatus(context, options);
  return { directory, activation, store, context, options, status, requests, fetcher, queryControl, read,
    respond: (callback: () => Promise<Response>) => { respond = callback; } };
}

describe('private operational status ownership', () => {
  it('uses stopped connector lifecycle under its lock and returns the actual canonical response', async () => {
    const f = await fixture();
    f.respond(async () => { expect(await readdir(f.directory)).toContain('connector.lock'); return Response.json(f.status); });
    expect(await f.read()).toEqual(f.status);
    expect((await f.store.load())?.lifecycle?.state).toBe('RUNNING');
    expect((await f.store.load())?.cursor).toBe('saved-cursor');
    expect((await readdir(f.directory))).not.toContain('connector.lock');
    expect(f.requests.map(value => value.url)).toEqual(['https://envoi.example/api/agent/status']);
  });

  it('reads actual remote status while a foreground connector owns refresh, without modifying session state', async () => {
    const f = await fixture(true);
    await writeFile(path.join(f.directory, 'connector.lock'), JSON.stringify({ pid: process.pid, nonce: 'foreground' }));
    const before = await readFile(path.join(f.directory, 'session.json'), 'utf8');
    expect(await f.read()).toEqual(f.status);
    expect(await readFile(path.join(f.directory, 'session.json'), 'utf8')).toBe(before);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].init).toMatchObject({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
      headers: { authorization: `Bearer ${f.activation.agentApiToken}` } });
  });

  it('reloads a foreground successor once on ACCESS_TOKEN_EXPIRED and never calls refresh', async () => {
    const f = await fixture(true); let calls = 0;
    f.respond(async () => {
      if (++calls === 1) {
        const current = (await f.store.load())!;
        await f.store.save({ ...current, agentApiToken: 'foreground-successor', agentRefreshToken: 'foreground-refresh-successor' });
        return Response.json(body('a3-pause-auth', 'access-token-expired.json'), { status: 401 });
      }
      return Response.json(f.status);
    });
    expect(await f.read()).toEqual(f.status);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].init?.headers).toMatchObject({ authorization: 'Bearer foreground-successor' });
    expect(f.requests.every(value => value.url.endsWith('/api/agent/status'))).toBe(true);
  });

  it('does not refresh or retry when the foreground token has not changed', async () => {
    const f = await fixture(true);
    f.respond(async () => Response.json(body('a3-pause-auth', 'access-token-expired.json'), { status: 401 }));
    await expect(f.read()).rejects.toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
    expect(f.requests).toHaveLength(1);
  });

  it('bounds the foreground retry even if the successor is expired', async () => {
    const f = await fixture(true);
    f.respond(async () => {
      const current = (await f.store.load())!;
      await f.store.save({ ...current, agentApiToken: current.agentApiToken + '-rotated' });
      return Response.json(body('a3-pause-auth', 'access-token-expired.json'), { status: 401 });
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
    expect(f.requests).toHaveLength(2);
  });

  it('lets the stopped connector rotate normally and preserves completion metadata', async () => {
    const f = await fixture(); vi.setSystemTime(new Date('2026-10-08T12:05:00Z'));
    await f.store.save({ ...(await f.store.load())!, agentTokenExpiresAt: '2026-10-08T12:00:00Z' });
    const rotated = body('a3-pause-auth', 'paused-refresh.json');
    f.respond(async () => f.requests.at(-1)!.url.endsWith('/api/agent-token') ? Response.json(rotated) : Response.json(f.status));
    expect(await f.read()).toEqual(f.status);
    expect(f.requests.map(value => new URL(value.url).pathname)).toEqual(['/api/agent-token', '/api/agent/status']);
    expect((await f.store.load())?.agentRefreshToken).toBe(rotated.agentRefreshToken);
    expect((await f.store.load() as any)._onboarding.completionId).toBe(f.context.completionId);
  });

  it.each(['REVOKED', 'NEEDS_RECONNECT'] as const)('guards saved %s before even querying local control', async state => {
    const f = await fixture(true);
    await f.store.save({ ...(await f.store.load())!, lifecycle: { state, paused: false, failures: 0, changedAt: new Date().toISOString(),
      code: state === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'CREDENTIAL_EXPIRED' } });
    await expect(f.read()).rejects.toBeInstanceOf(EnvoiError);
    expect(f.queryControl).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('persists remote revocation while stopped and makes no later service calls', async () => {
    const f = await fixture();
    f.respond(async () => Response.json(body('a3-pause-auth', 'credential-revoked-claim.json'), { status: 401 }));
    await expect(f.read()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect((await f.store.load())?.lifecycle?.state).toBe('REVOKED');
    await expect(f.read()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(f.requests).toHaveLength(1);
  });

  it.each(['agent', 'inbox', 'installation', 'missing-installation'])('rejects %s response mismatch instead of reporting connected', async kind => {
    const f = await fixture(true);
    if (kind === 'agent') f.status.agent.id = 'other-agent';
    if (kind === 'inbox') f.status.inboxId = 'other-inbox';
    if (kind === 'installation') f.status.installation.id = 'other-installation';
    if (kind === 'missing-installation') delete f.status.installation;
    await expect(f.read()).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('rejects a changed origin before contacting either control or Envoi', async () => {
    const f = await fixture(true); f.context.origin = 'https://other.example';
    await expect(f.read()).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(f.queryControl).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not refresh if a foreground owner races the control probe', async () => {
    const f = await fixture();
    f.queryControl.mockImplementation(async () => {
      await writeFile(path.join(f.directory, 'connector.lock'), JSON.stringify({ pid: process.pid, nonce: 'racing-foreground' }));
      throw new Error('Control not ready');
    });
    await expect(f.read()).rejects.toThrow('already running'); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
