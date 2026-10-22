import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { FileWakeStore } from './http-wake-store';
import { parseHostedWakeConfig, runHostedWake } from './hosted-wake-runner';
import { startConnection } from './core';
import { startQuickConnect } from '../openclaw/quick-connect';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

describe('hosted wake runner', () => {
  it('requires a complete scoped, fixed-URL loopback configuration', () => {
    expect(parseHostedWakeConfig({})).toBeNull();
    expect(() => parseHostedWakeConfig({ ENVOI_WAKE_URL: 'https://hooks.example/envoi/hermes' })).toThrow();
    expect(() => parseHostedWakeConfig({ ENVOI_WAKE_URL: 'http://hooks.example/envoi/hermes', ENVOI_WAKE_PORT: '18761', ENVOI_WAKE_INSTALLATION_ID: 'installation_example' })).toThrow();
    expect(() => parseHostedWakeConfig({ ENVOI_WAKE_URL: 'https://hooks.example/envoi/hermes?token=x', ENVOI_WAKE_PORT: '18761', ENVOI_WAKE_INSTALLATION_ID: 'installation_example' })).toThrow();
    expect(() => parseHostedWakeConfig({ ENVOI_WAKE_URL: 'https://hooks.example/envoi/hermes', ENVOI_WAKE_PORT: '80', ENVOI_WAKE_INSTALLATION_ID: 'installation_example' })).toThrow();
    expect(parseHostedWakeConfig({ ENVOI_WAKE_URL: 'https://hooks.example/envoi/hermes', ENVOI_WAKE_PORT: '18761', ENVOI_WAKE_INSTALLATION_ID: 'installation_example' }))
      .toEqual({ registeredUrl: 'https://hooks.example/envoi/hermes', port: 18761, installationId: 'installation_example' });
  });

  it('rejects incomplete hosted configuration before either normal helper touches state', async () => {
    const env = { ENVOI_WAKE_URL: 'https://hooks.example/envoi/wake' };
    const secureDirectory = vi.fn(async (directory: string) => directory);
    const resolveAdapter = vi.fn();
    await expect(startConnection('unused-hermes-state', new AbortController().signal, resolveAdapter,
      { env, secureDirectory })).rejects.toThrow('Hosted wake needs URL');
    await expect(startQuickConnect('unused-openclaw-state', new AbortController().signal,
      { env, secureDirectory })).rejects.toThrow('Hosted wake needs URL');
    expect(secureDirectory).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('listens only on loopback, runs canonical polling, and releases private wake state on shutdown', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'envoi-hosted-wake-'));
    temporary.push(stateDir);
    const port = await freePort();
    const session: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail', cursor: null,
      agentApiToken: 'private-test-access', agentRefreshToken: 'private-test-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      paths.push(route);
      if (route === '/api/agent/status') return Response.json({ state: 'active', agent: { id: session.agentId }, inboxId: session.inboxId,
        installation: { id: 'installation_example' }, caseSessions: { available: true, version: 1 },
        httpWake: { available: false, version: 1, subscription: null } });
      if (route === '/api/agent/work/claim') return Response.json({ work: null, state: 'idle', nextAvailableInMs: 30_000 });
      throw new Error(`Unexpected upstream route: ${route}`);
    });
    const connector = new EnvoiConnector('https://envoi.example', { load: async () => session, save: async () => {} }, {
      fetch: fetcher as typeof fetch, caseSessionHandler: { admit: async () => {}, process: async () => {} }
    });
    const stop = new AbortController();
    const run = runHostedWake({ connector, session, stateDir, config: { registeredUrl: 'https://hooks.example/envoi/hermes', port,
      installationId: 'installation_example' }, signal: stop.signal });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { response = await fetch(`http://127.0.0.1:${port}/envoi/hermes`, { method: 'GET' }); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(response?.status).toBe(400);
      await vi.waitFor(() => expect(paths).toContain('/api/agent/work/claim'));
    } finally { stop.abort(); await run; }
    const reopened = await FileWakeStore.open(path.join(stateDir, 'wake'));
    await reopened.close();
  });
});
