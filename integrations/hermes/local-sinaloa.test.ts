import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { enrollConnector } from '../../sdk/typescript/src/connector';
import { newCaseId, SinaloaClient } from '../../sdk/typescript/src/index';
import { BrowserSession } from '../../test/browser-session.js';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createHermesBridge } from './runtime';

async function server(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development',
      SINALOA_DATA_DIR: dataDir, SINALOA_AGENT_WORK_RETRY_BASE_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local Sinaloa server start timed out')), 15_000);
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
  throw new Error('Local Sinaloa delivery timed out');
}

describe('Hermes bridge against real local Sinaloa', () => {
  it('wakes on two offline exact-address cases, resumes a run after restart, records one reply per case, and stops on revoke', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sinaloa-hermes-local-'));
    let app: Awaited<ReturnType<typeof server>> | null = null;
    try {
      app = await server(path.join(directory, 'server'));
      const senderStore = new FileBridgeStore(path.join(directory, 'sender'));
      const hermesStore = new FileBridgeStore(path.join(directory, 'hermes'));
      await Promise.all([senderStore.init(), hermesStore.init()]);
      const sender = await owner(app.baseUrl, '7301', senderStore);
      const recipient = await owner(app.baseUrl, '7302', hermesStore);
      const senderClient = new SinaloaClient(app.baseUrl, sender.agent.agentApiToken);
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
      expect(await connector.processWorkOnce()).toBe(true);
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
        const recipientCase = await new SinaloaClient(app.baseUrl, (await hermesStore.load())!.agentApiToken)
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
