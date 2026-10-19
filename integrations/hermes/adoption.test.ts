import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { adoptActivatedConnection, type ActivatedConnection } from '../connector/core';
import { ConnectorSetupError, type ConnectorAdapter } from '../connector/adapter';
import { hermesAdapter } from './adapter';
import type { HermesConfiguration } from './config';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('envoi-hermes-adoption-')) throw new Error('Unexpected fixture cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
const response = (body: unknown, status = 200) => Response.json(body, { status });
function fixtureBody(contractId: string, filename: string): any {
  return (loadContractFixture(contractRegistry.contracts.find(row => row.id === contractId)!, filename) as any).response.body;
}

/** No real Hermes/profile/provider or Envoi server: only the disposable MCP relay is real HTTP.
 * A simulated Gateway ticks every 60 seconds and parks failed endpoints for 300 seconds.
 * Advancing 15 seconds per model attempt keeps this integration test fast; default wall-clock
 * 300-second recovery is independently covered by runtime-readiness.test.ts with fake timers.
 */
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:05:00.000Z'));
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-adoption-')); directories.push(root);
  const home = path.join(root, 'fixture-profile'), directory = path.join(root, 'fixture-state');
  await mkdir(home); await mkdir(directory);
  const configPath = path.join(home, 'config.yaml');
  await writeFile(configPath, 'model:\n  default: fixture-provider\n');
  await writeFile(path.join(home, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=fixture-api-key\n');
  const activation: ActivatedConnection = fixtureBody('agent-registration', 'activation-created.json');
  activation.installation.runtime.type = 'hermes';
  const status = fixtureBody('agent-registration', 'agent-status-installation.json');
  const apiUrl = 'https://envoi.example';
  const urls: string[] = [], phases: string[] = [], closes: number[] = [];
  let clock = 0, nextReconcile = 60_000, probeAt = 0, parked = false, connected = false;
  let invokeIdentity = true, verificationRuns = 0, identityCalls = 0, open = 0, maximumOpen = 0;
  let runCount = 0, bridgeCount = 0;
  const runs = new Map<string, string>();
  async function relay() { return JSON.parse(await readFile(path.join(directory, 'hermes-relay.json'), 'utf8')); }
  async function rpc(method: string, params?: unknown) {
    const saved = await relay();
    const result = await fetch(`http://127.0.0.1:${saved.port}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${saved.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method, ...(params ? { params } : {}) })
    });
    expect(result.ok).toBe(true);
    return result.json();
  }
  async function reconcile() {
    if (parked ? clock < probeAt : clock < nextReconcile) return;
    nextReconcile = clock + 60_000;
    const yaml = await readFile(configPath, 'utf8');
    const saved = await relay();
    if (!yaml.includes(saved.serverName)) return;
    try { await rpc('tools/list'); connected = true; parked = false; }
    catch { connected = false; parked = true; probeAt = clock + 300_000; }
  }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input); urls.push(url);
    const pathname = new URL(url).pathname;
    if (url.startsWith(apiUrl)) {
      if (pathname === '/api/agent/status') return response(status);
      if (pathname === '/api/agent/connection-status') return response({ checkedAt: new Date().toISOString() });
      if (pathname === '/mcp') {
        const request = JSON.parse(String(init?.body));
        if (request.method === 'tools/list') return response({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'envoi_agent_info', inputSchema: { type: 'object' } }] } });
        expect(request).toMatchObject({ method: 'tools/call', params: { name: 'envoi_agent_info' } });
        identityCalls++;
        return response({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ agentId: activation.agent.id }) }] } });
      }
      throw new Error('Unexpected Envoi fixture request: ' + pathname);
    }
    expect(new URL(url).origin).toBe('http://127.0.0.1:18652');
    if (pathname === '/v1/capabilities') return response({ features: { run_submission: true, run_status: true, run_stop: true } });
    if (pathname === '/v1/runs' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `fixture_run_${++runCount}`;
      expect(runs.has(body.session_id)).toBe(false);
      runs.set(body.session_id, id);
      if (body.input.includes('setup verification')) {
        verificationRuns++; clock += 15_000;
        await reconcile();
        if (connected && invokeIdentity) await rpc('tools/call', { name: 'envoi_agent_info', arguments: {} });
      }
      return response({ run_id: id }, 202);
    }
    if (pathname.startsWith('/v1/runs/')) return response({ run_id: pathname.split('/').at(-1), status: 'completed', output: 'I called the identity tool' });
    throw new Error('Unexpected Hermes fixture request');
  });
  const adapter: ConnectorAdapter<any> = { ...hermesAdapter,
    async createBridge(config: HermesConfiguration, context) {
      const before = await readFile(configPath, 'utf8');
      if (bridgeCount++ === 0) expect(before).not.toContain('mcp_servers:');
      const bridge = await hermesAdapter.createBridge(config, context);
      expect(await readFile(configPath, 'utf8')).toContain('mcp_servers:');
      open++; maximumOpen = Math.max(maximumOpen, open);
      let closed = false;
      return { ...bridge, async close() { await bridge.close(); if (!closed) { closed = true; closes.push(--open); } } };
    }
  };
  const options = { stateDir: directory, completionId: 'fixture-completion', configPath, gatewayUrl: 'http://127.0.0.1:18652',
    env: {}, fetch: fetcher, secureDirectory: async (value: string) => value,
    toolRecoveryTimeoutMs: 2_000, toolRecoveryRetryMs: 1,
    onProgress: (phase: string) => phases.push(phase) };
  const adopt = (overrides: Partial<typeof options> & { signal?: AbortSignal } = {}) =>
    adoptActivatedConnection(apiUrl, 'hermes', activation, () => adapter, { ...options, ...overrides });
  return { root, directory, home, configPath, urls, phases, closes, adopt, relay, rpc, options,
    snapshot: () => ({ clock, verificationRuns, identityCalls, open, maximumOpen, parked }),
    refuseIdentity: () => { invokeIdentity = false; }, permitIdentity: () => { invokeIdentity = true; },
    async parkAfterDisconnect() {
      // Model the Gateway's failed connect while no helper owns the saved port.
      expect(await rpc('tools/list').then(() => false, () => true)).toBe(true);
      connected = false; parked = true; probeAt = clock + 300_000;
    }
  };
}

describe('Hermes local-helper adoption with delayed Gateway MCP discovery', () => {
  it('keeps one live relay until late config reconciliation and a real identity call succeed', async () => {
    const f = await fixture();
    const result = await f.adopt();
    expect(result.checks).toBe('passed');
    expect(f.snapshot()).toMatchObject({ clock: 60_000, verificationRuns: 4, identityCalls: 1, maximumOpen: 1, open: 0 });
    expect(f.phases.filter(value => value.startsWith('Waiting'))).toHaveLength(3);
    expect(f.urls.filter(url => url.endsWith('/api/agent/connection-status'))).toHaveLength(1);
    expect(f.urls.some(url => /register|activate|enroll|work\/claim/.test(url))).toBe(false);
    await expect(f.rpc('tools/list')).rejects.toThrow(); // failed/finished adoption releases the port
  });

  it('resumes saved enrollment after timeout and waits through a parked-server probe on the same port', async () => {
    const f = await fixture(); f.refuseIdentity();
    await expect(f.adopt({ toolRecoveryTimeoutMs: 80 })).rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
    const before = await f.relay();
    const session = JSON.parse(await readFile(path.join(f.directory, 'session.json'), 'utf8'));
    expect(f.snapshot().open).toBe(0);
    expect(f.urls.some(url => url.endsWith('/api/agent/connection-status'))).toBe(false);
    await expect(f.rpc('tools/list')).rejects.toThrow();
    await f.parkAfterDisconnect(); f.permitIdentity();
    const runBefore = f.snapshot().verificationRuns;
    const recovered = await f.adopt();
    expect(recovered.checks).toBe('passed');
    expect(f.snapshot().verificationRuns - runBefore).toBe(20);
    expect(f.snapshot()).toMatchObject({ identityCalls: 1, maximumOpen: 1, open: 0, parked: false });
    expect(await f.relay()).toEqual(before);
    const resumed = JSON.parse(await readFile(path.join(f.directory, 'session.json'), 'utf8'));
    expect(resumed.agentId).toBe(session.agentId);
    expect(resumed.agentRefreshToken).toBe(session.agentRefreshToken);
    expect(resumed._onboarding).toEqual(session._onboarding);
    expect(f.urls.some(url => /register|activate|enroll|work\/claim/.test(url))).toBe(false);
    // Neither previous close left an EADDRINUSE nor recovery created a duplicate listener.
    await f.adopt();
    expect(await f.relay()).toEqual(before);
    expect(f.snapshot().maximumOpen).toBe(1);
  });

  it('times out safely when Hermes only claims it called the tool; saved state stays resumable', async () => {
    const f = await fixture(); f.refuseIdentity();
    const error = await f.adopt({ toolRecoveryTimeoutMs: 40 }).catch(error => error);
    expect(error).toBeInstanceOf(ConnectorSetupError);
    expect(error.code).toBe('TOOLS_NOT_READY');
    expect(error.message).toContain('saved enrollment is unchanged');
    expect(error.message).not.toContain((await f.relay()).token);
    expect(f.snapshot().identityCalls).toBe(0);
    expect(f.snapshot().open).toBe(0);
    expect(f.urls.some(url => url.endsWith('/api/agent/connection-status'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(f.directory, 'session.json'), 'utf8'))._onboarding.completionId).toBe('fixture-completion');
    expect((await readFile(path.join(f.directory, 'connection.json'), 'utf8'))).toContain('fixture-completion');
  });

  it('cancels backoff without another verification or a ready report', async () => {
    const f = await fixture(); f.refuseIdentity();
    const stop = new AbortController();
    await expect(f.adopt({ signal: stop.signal, onProgress(phase) { if (phase.startsWith('Waiting')) stop.abort(); } }))
      .rejects.toMatchObject({ code: 'SETUP_CANCELLED' });
    expect(f.snapshot()).toMatchObject({ verificationRuns: 1, open: 0 });
    expect(f.urls.some(url => url.endsWith('/api/agent/connection-status'))).toBe(false);
  });
});
