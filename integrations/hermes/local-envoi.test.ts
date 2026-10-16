import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { enrollConnector } from '../../sdk/typescript/src/connector';
import { newCaseId, EnvoiClient } from '../../sdk/typescript/src/index';
import { BrowserSession } from '../../test/browser-session.js';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createHermesBridge } from './runtime';

async function server(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development',
      ENVOI_DATA_DIR: dataDir, ENVOI_AGENT_WORK_RETRY_BASE_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local Envoi server start timed out')), 15_000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local server exited ${code}`)); });
    child.stdout?.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, child };
}

async function api(baseUrl: string, pathname: string, browser: BrowserSession, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { ...browser.headers(baseUrl, method), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  browser.capture(response);
  return { status: response.status, payload: await response.json() as any };
}

async function owner(baseUrl: string, suffix: string, store: FileBridgeStore) {
  const browser = new BrowserSession();
  const start = await api(baseUrl, '/api/auth/phone/start', browser,
    { phoneNumber: `+14165550${suffix}`, displayName: `Hermes owner ${suffix}` });
  expect(start.status).toBe(201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', browser,
    { challengeId: start.payload.challengeId, code: start.payload.developmentCode });
  expect(verified.status).toBe(200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', browser, {});
  expect(setup.status).toBe(201);
  const mfa = await api(baseUrl, '/api/auth/totp/verify', browser,
    { code: generateSync({ secret: setup.payload.secret }) });
  expect(mfa.status).toBe(200);
  const inbox = await api(baseUrl, '/api/inboxes', browser, { name: `Hermes owner ${suffix}` });
  expect(inbox.status).toBe(201);
  const token = await api(baseUrl, `/api/inboxes/${inbox.payload.id}/agent-enrollment-tokens`, browser,
    { permissions: ['send_agent_messages', 'receive_agent_messages'] });
  expect(token.status).toBe(201);
  const agent = await enrollConnector(baseUrl, token.payload.enrollmentToken, store, { name: `Agent ${suffix}` });
  return { browser, agent, inboxId: inbox.payload.id as string };
}

async function eventually<T>(call: () => Promise<T | null>, timeoutMs = 7_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await call();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local Envoi delivery timed out');
}

describe('Hermes bridge against real local Envoi', () => {
  it('polls with SSE unavailable and settles one MCP reply before the provider tail finishes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-poll-'));
    const stop = new AbortController();
    let app: Awaited<ReturnType<typeof server>> | null = null;
    let bridge: Awaited<ReturnType<typeof createHermesBridge>> | null = null;
    let running: Promise<void> | undefined;
    try {
      app = await server(path.join(directory, 'server'));
      const senderStore = new FileBridgeStore(path.join(directory, 'sender'));
      const recipientStore = new FileBridgeStore(path.join(directory, 'recipient'));
      await Promise.all([senderStore.init(), recipientStore.init()]);
      const sender = await owner(app.baseUrl, '7303', senderStore);
      const recipient = await owner(app.baseUrl, '7304', recipientStore);
      const relayToken = 'local-test-relay-token-with-32-characters';
      let emptyClaims = 0;
      let sseFailures = 0;
      let runCount = 0;
      let replyCount = 0;
      let stopCount = 0;
      let work: { id: string; caseId: string } | undefined;
      let input = '';
      const fetcher: typeof fetch = async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.origin === 'http://127.0.0.1:8642') {
          if (parsed.pathname === '/v1/runs') {
            runCount++;
            input = JSON.parse(String(init?.body)).input;
            return Response.json({ run_id: 'run_poll', status: 'started' }, { status: 202 });
          }
          if (parsed.pathname.endsWith('/stop')) { stopCount++; return Response.json({}); }
          if (!replyCount) {
            expect(input).toContain(work!.id);
            const response = await fetch(bridge!.relayUrl!, { method: 'POST',
              headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'envoi_send_message',
                arguments: { recipientAddress: sender.agent.address, caseId: work!.caseId, text: 'ACK POLLING',
                  idempotencyKey: `bridge:${work!.id}:reply:1` } } }) });
            expect(response.status).toBe(200);
            const result = await response.json() as any;
            expect(JSON.parse(result.result.content[0].text).status).toBe(202);
            replyCount++;
          }
          return Response.json({ run_id: 'run_poll', status: 'running' });
        }
        if (/\/events$/.test(parsed.pathname)) { sseFailures++; throw new Error('SSE unavailable'); }
        const response = await fetch(url, init);
        if (parsed.pathname.endsWith('/work/claim')) {
          const payload = await response.clone().json() as any;
          if (payload.work === null) emptyClaims++;
        }
        return response;
      };
      bridge = await createHermesBridge({ apiUrl: app.baseUrl, stateDir: path.join(directory, 'recipient'),
        hermesUrl: 'http://127.0.0.1:8642', hermesKey: 'local-test-key', relayToken, relayPort: 0, writeEnabled: true }, { fetch: fetcher, env: {} });
      running = bridge.connector.run(stop.signal);
      await eventually(async () => emptyClaims > 0 && sseFailures > 0 ? true : null);
      work = await new EnvoiClient(app.baseUrl, sender.agent.agentApiToken).startCase(sender.agent.inboxId,
        'polling-regression', { senderAgentId: sender.agent.agentId, recipientEmail: recipient.agent.address, text: 'Reply once', caseId: newCaseId() });
      await eventually(async () => {
        const result = await api(app!.baseUrl, `/api/inboxes/${recipient.agent.inboxId}/delivery-receipts`, recipient.browser);
        return result.payload.some((item: { messageId: string; state: string }) => item.messageId === work!.id && item.state === 'processed') ? true : null;
      }, 25_000);
      const delta = await api(app.baseUrl, `/api/inboxes/${recipient.agent.inboxId}/events/delta?limit=200`, recipient.browser);
      const claims = delta.payload.events.filter((item: { type: string; workId: string }) => item.type === 'agent.work_claimed' && item.workId === work!.id);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ attempts: 1, fence: 1 });
      const receipts = await api(app.baseUrl, `/api/inboxes/${recipient.agent.inboxId}/delivery-receipts`, recipient.browser);
      expect(receipts.payload.filter((item: { messageId: string; state: string }) => item.messageId === work!.id && item.state === 'processed')).toHaveLength(1);
      expect(delta.payload.events.filter((item: { type: string; messageId: string }) => item.type === 'message.processed' && item.messageId === work!.id)).toHaveLength(1);
      expect(runCount).toBe(1);
      expect(replyCount).toBe(1);
      expect(stopCount).toBe(1);
      expect(sseFailures).toBeGreaterThan(0);
      expect(await recipientStore.replyFor(work.id)).toEqual({ stop: true });
    } finally {
      stop.abort();
      try { await running; } finally {
        await bridge?.close();
        if (app?.child && app.child.exitCode === null) await new Promise<void>(resolve => { app!.child.once('exit', resolve); app!.child.kill('SIGTERM'); });
        if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('wakes on two offline exact-address cases, resumes a run after restart, records one reply per case, and stops on revoke', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-local-'));
    let app: Awaited<ReturnType<typeof server>> | null = null;
    try {
      app = await server(path.join(directory, 'server'));
      const senderStore = new FileBridgeStore(path.join(directory, 'sender'));
      const hermesStore = new FileBridgeStore(path.join(directory, 'hermes'));
      await Promise.all([senderStore.init(), hermesStore.init()]);
      const sender = await owner(app.baseUrl, '7301', senderStore);
      const recipient = await owner(app.baseUrl, '7302', hermesStore);
      const senderClient = new EnvoiClient(app.baseUrl, sender.agent.agentApiToken);
      const caseIds = [newCaseId(), newCaseId()];
      const sent = await Promise.all(caseIds.map((caseId, index) => senderClient.startCase(sender.agent.inboxId,
        `hermes-case-${index}`, { senderAgentId: sender.agent.agentId, recipientEmail: recipient.agent.address,
          caseId, text: `Question ${index + 1}` })));
      await eventually(async () => {
        const result = await api(app!.baseUrl, `/api/inboxes/${recipient.agent.inboxId}/messages`, recipient.browser);
        return sent.every(item => result.payload.some((message: { id: string; status: string }) =>
          message.id === item.id && message.status === 'delivered')) ? true : null;
      });

      const created = new Map<string, { body: string; runId: string }>();
      let loseOnePoll = true;
      const hermesFetch: typeof fetch = async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/runs') {
          const key = new Headers(init?.headers).get('idempotency-key')!;
          const body = String(init?.body);
          const previous = created.get(key);
          if (previous && previous.body !== body) return new Response(null, { status: 409 });
          if (!previous) created.set(key, { body, runId: `run_${created.size + 1}` });
          return new Response(JSON.stringify({ run_id: created.get(key)!.runId, status: 'started' }), { status: 202 });
        }
        if (loseOnePoll) { loseOnePoll = false; throw new Error('Hermes status connection lost'); }
        const runId = pathname.split('/').at(-1)!;
        const input = [...created.values()].find(value => value.runId === runId)?.body || '';
        const text = input.includes('Question 1') ? 'Hermes answer one' : 'Hermes answer two';
        return new Response(JSON.stringify({ run_id: runId, status: 'completed', output: JSON.stringify({ text, intent: 'message' }) }));
      };
      const fetcher: typeof fetch = (url, init) => String(url).startsWith('http://127.0.0.1:8642') ? hermesFetch(url, init) : fetch(url, init);
      const configuration = { apiUrl: app.baseUrl, stateDir: path.join(directory, 'hermes'), hermesUrl: 'http://127.0.0.1:8642', hermesKey: 'private-key' };
      let bridge = await createHermesBridge(configuration, { fetch: fetcher, env: {} });
      let connector = bridge.connector;
      await expect(connector.processWorkOnce()).rejects.toThrow('Hermes status connection lost');
      await bridge.close();
      bridge = await createHermesBridge(configuration, { fetch: fetcher, env: {} });
      connector = bridge.connector;
      await eventually(async () => await connector.processWorkOnce() ? true : null);
      // The other case can finish before the failed run's server retry delay
      // expires. An empty claim is normal; keep polling as the service does.
      await eventually(async () => await connector.processWorkOnce() ? true : null);
      expect(created.size).toBe(2);
      const sessions = [...created.values()].map(item => (JSON.parse(item.body) as { session_id: string }).session_id);
      expect(sessions[0]).not.toBe(sessions[1]);
      await eventually(async () => {
        const listed = await api(app!.baseUrl, `/api/inboxes/${sender.agent.inboxId}/messages`, sender.browser);
        return listed.payload.filter((item: { text: string; status: string }) =>
          item.text?.startsWith('Hermes answer') && item.status === 'delivered').length === 2 ? true : null;
      });
      for (const caseId of caseIds) {
        const senderCase = await senderClient.listCaseMessages(sender.agent.inboxId, caseId);
        const recipientCase = await new EnvoiClient(app.baseUrl, (await hermesStore.load())!.agentApiToken)
          .listCaseMessages(recipient.agent.inboxId, caseId);
        expect(senderCase).toHaveLength(2);
        expect(recipientCase).toHaveLength(2);
      }
      const receipts = await api(app.baseUrl, `/api/inboxes/${recipient.agent.inboxId}/delivery-receipts`, recipient.browser);
      for (const item of sent) {
        expect(receipts.payload.filter((receipt: { messageId: string; state: string }) =>
          receipt.messageId === item.id && receipt.state === 'processed')).toHaveLength(1);
      }
      const revoked = await api(app.baseUrl,
        `/api/inboxes/${recipient.agent.inboxId}/agents/${recipient.agent.agentId}/credentials/revoke`, recipient.browser, {});
      expect(revoked.status).toBe(200);
      await expect(connector.processWorkOnce()).rejects.toThrow();
      expect(created.size).toBe(2);
    } finally {
      if (app?.child && app.child.exitCode === null) {
        await new Promise<void>(resolve => { app!.child.once('exit', () => resolve()); app!.child.kill('SIGTERM'); });
      }
      if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
