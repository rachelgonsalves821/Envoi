// Real adapter/loopback relay, synthetic hosted services and model; no real runtime/provider.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermesAdapter } from './adapter';
import { waitForRuntimeTools } from '../connector/runtime-readiness';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';

const agentId = 'review_agent', inboxId = 'review_inbox';
const session = (): ConnectorSession => ({ agentId, inboxId, address: 'review@envoi.example', cursor: null,
  agentApiToken: 'synthetic-review-access', agentRefreshToken: 'synthetic-review-refresh',
  agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });

describe('Hermes cached-catalog readiness recovery', () => {
  it.each([
    { scenario: 'recovers a missed proof without rediscovery', exhaust: false },
    { scenario: 'caps cached proofs and renews the budget only after discovery', exhaust: true }
  ])('$scenario', async ({ exhaust }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-integrated-review-'));
    const home = path.join(root, 'profile'), stateDir = path.join(root, 'state');
    await mkdir(home); await mkdir(stateDir);
    const configPath = path.join(home, 'config.yaml');
    await writeFile(configPath, 'model:\n  default: synthetic-model\n');
    await writeFile(path.join(home, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=synthetic-local-key\n');
    await writeFile(path.join(stateDir, 'session.json'), JSON.stringify(session()));
    let modelRuns = 0, identityCalls = 0, allowIdentity = false, upstreamLists = 0, gatewayLists = 0;
    let relay: { port: number; token: string };
    const rpc = async (method: string, params: unknown = {}) => {
      if (method === 'tools/list') gatewayLists++;
      const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: 'POST',
        headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'review', method, params }) });
      expect(response.status).toBe(200); return response.json();
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://review.envoi.example') {
        if (url.pathname === '/api/agent/status') return Response.json({ state: 'active', agent: { id: agentId }, inboxId });
        const request = JSON.parse(String(init?.body));
        if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'review', version: '1' } } });
        if (request.method === 'tools/list') {
          upstreamLists++;
          return Response.json({ jsonrpc: '2.0', id: request.id,
            result: { tools: [{ name: 'envoi_agent_info', inputSchema: { type: 'object' } }] } });
        }
        expect(request.method).toBe('tools/call'); identityCalls++;
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ agentId }) }] } });
      }
      expect(url.origin).toBe('http://127.0.0.1:18671');
      if (url.pathname === '/v1/runs' && init?.method === 'POST') {
        modelRuns++;
        if (allowIdentity) await rpc('tools/call', { name: 'envoi_agent_info', arguments: {} });
        return Response.json({ run_id: 'review_run' }, { status: 202 });
      }
      return Response.json({ run_id: 'review_run', status: 'completed', output: 'Completed' });
    };
    const bridge = await hermesAdapter.createBridge({ home, profile: 'default', configPath,
      apiUrl: 'http://127.0.0.1:18671', apiKey: 'synthetic-local-key' }, {
      apiUrl: 'https://review.envoi.example', stateDir, env: {}, fetch: fetcher
    });
    const stop = new AbortController();
    // Test cleanup guard, independent of the production readiness deadline.
    const cleanupTimer = setTimeout(() => stop.abort(), 10_000);
    let pending: Promise<void> | undefined;
    try {
      relay = JSON.parse(await readFile(path.join(stateDir, 'hermes-relay.json'), 'utf8'));
      // The real relay sees discovery before the first proof; the Gateway need not list it again.
      await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-gateway', version: '1' } });
      await rpc('tools/list');
      expect(bridge.readyToVerify!()).toBe(true);
      let parkAt = 7, announceParked!: () => void;
      let parked = new Promise<void>(resolve => { announceParked = resolve; });
      pending = waitForRuntimeTools(bridge, stop.signal, { timeoutMs: null, retryMs: 5,
        onWaiting: () => {
          if (!exhaust) allowIdentity = true;
          else if (modelRuns >= parkAt) announceParked();
        }
      });
      // Observe rejection even if an assertion below fails before awaiting it.
      void pending.catch(() => {});
      if (exhaust) {
        for (const count of [7, 14]) {
          if (count === 14) {
            parkAt = count;
            parked = new Promise<void>(resolve => { announceParked = resolve; });
            await rpc('tools/list');
          }
          await Promise.race([parked, pending.then(() => { throw new Error('Recovery ended before the retry budget parked'); })]);
          await new Promise(resolve => setTimeout(resolve, 40));
          expect(modelRuns).toBe(count); // Fresh proof plus six cached retries, then no billing.
          expect(identityCalls).toBe(0);
          expect(bridge.readyToVerify!()).toBe(false);
        }
        allowIdentity = true;
        await rpc('tools/list');
      }
      await pending;
      expect(modelRuns).toBe(exhaust ? 15 : 2);
      expect(identityCalls).toBe(1);
      expect(gatewayLists).toBe(exhaust ? 3 : 1);
      expect(upstreamLists).toBe(1); // Gateway rediscovery can use the proven local catalog.
    } finally {
      clearTimeout(cleanupTimer); stop.abort(); await pending?.catch(() => {});
      await bridge.close();
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('envoi-integrated-review-')) throw new Error('Unsafe fixture cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['owner', 'deadline'] as const)('aborts an in-flight status check on %s cancellation', async mode => {
    const original = session();
    let saved = structuredClone(original);
    let release!: (response: Response) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let transportSignal: AbortSignal | undefined;
    const connector = new EnvoiConnector('https://review.envoi.example', {
      load: async () => saved, save: async value => { saved = value; }
    }, { fetch: async (_url, init) => {
      transportSignal = init?.signal ?? undefined; entered();
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
      });
    } });
    const stop = new AbortController();
    const pending = waitForRuntimeTools({ connector, close: async () => {}, verify: async signal => { signal?.throwIfAborted(); } },
      stop.signal, { timeoutMs: mode === 'deadline' ? 50 : null }).catch(error => error);
    await started;
    if (mode === 'owner') stop.abort();
    try {
      const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still-pending'), 250))]);
      expect(outcome).toMatchObject({ code: mode === 'owner' ? 'SETUP_CANCELLED' : 'TOOLS_NOT_READY' });
      expect(transportSignal?.aborted).toBe(true);
      expect(saved).toEqual(original);
    } finally { release(Response.json({ state: 'active', agent: { id: agentId }, inboxId })); await pending; }
  });
});
