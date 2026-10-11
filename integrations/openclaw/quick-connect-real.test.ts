import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { enrollConnector, EnvoiConnector } from '../../sdk/typescript/src/connector';
import { newCaseId } from '../../sdk/typescript/src/index';
import { BrowserSession } from '../../test/browser-session.js';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { setupQuickConnect, startQuickConnect } from './quick-connect';

async function startEnvoi(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0',
      ENVOI_AUTH_MODE: 'development', ENVOI_HUMAN_AUTH_PROVIDER: 'local',
      ENVOI_PUBLIC_URL: '', ENVOI_AGENT_DOMAIN: 'envoi.mail', ENVOI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local Quick Connect server start timed out')), 15_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local Quick Connect server exited with ${code}`)); });
      child.stdout?.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    return { baseUrl, child };
  } catch (error) { child.kill('SIGTERM'); throw error; }
}

async function api(baseUrl: string, pathname: string, session: BrowserSession, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...session.headers(baseUrl, method) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  session.capture(response);
  return { status: response.status, payload: await response.json() as Record<string, any> };
}

async function owner(baseUrl: string) {
  const session = new BrowserSession();
  const phone = await api(baseUrl, '/api/auth/phone/start', session,
    { phoneNumber: '+141655509731', displayName: 'Quick Connect integration owner' });
  expect(phone.status).toBe(201);
  expect((await api(baseUrl, '/api/auth/phone/verify', session,
    { challengeId: phone.payload.challengeId, code: phone.payload.developmentCode })).status).toBe(200);
  const totp = await api(baseUrl, '/api/auth/totp/setup', session, {});
  expect(totp.status).toBe(201);
  expect((await api(baseUrl, '/api/auth/totp/verify', session,
    { code: generateSync({ secret: totp.payload.secret }) })).status).toBe(200);
  const workspace = await api(baseUrl, '/api/inboxes', session, { name: 'Quick Connect exchange workspace' });
  expect(workspace.status).toBe(201);
  return { session, workspaceId: workspace.payload.id as string };
}

async function waitFor<T>(label: string, check: () => Promise<T | null | false>, failure: () => unknown = () => null): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (failure()) throw new Error(`Connector stopped before ${label}`);
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('Quick Connect against real Envoi and an HTTP Gateway fixture', () => {
  it('receives unsolicited work, replies in its case, and resumes saved enrollment without duplicate replies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-quick-connect-real-'));
    const stateDir = path.join(root, 'receiver');
    const secureDirectory = async (directory: string) => { await mkdir(directory, { recursive: true }); return directory; };
    const gatewayToken = 'local-gateway-token-kept-on-host';
    const gatewayTurns: Array<{ model: string; user: string; authorization?: string; content: string }> = [];
    const gateway = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST' || req.headers.authorization !== `Bearer ${gatewayToken}`) {
        res.writeHead(401); res.end('{}'); return;
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt: string = input.messages[0].content;
      gatewayTurns.push({ model: input.model, user: input.user, authorization: req.headers.authorization, content: prompt });
      const isPreflight = input.user.startsWith('envoi:connection-test:');
      const incoming = isPreflight ? null : JSON.parse(prompt.split('\n\n').at(-1)!);
      const content = isPreflight ? 'Connection test received.' : JSON.stringify({ text: `Processed ${incoming.incoming.text}`, intent: 'message' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    });
    let app: Awaited<ReturnType<typeof startEnvoi>> | null = null;
    let stop: AbortController | null = null;
    let running: Promise<void> | null = null;
    let connectorFailure: unknown = null;
    try {
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const gatewayAddress = gateway.address();
      if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('Gateway fixture address unavailable');
      app = await startEnvoi(path.join(root, 'server'));
      const { baseUrl } = app;
      const { session, workspaceId } = await owner(baseUrl);
      const enroll = async (name: string, localPart: string) => {
        const result = await api(baseUrl, `/api/inboxes/${workspaceId}/agent-enrollment-tokens`, session,
          { agentProfile: { name, localPart }, permissions: ['send_agent_messages', 'receive_agent_messages'] });
        expect(result.status).toBe(201);
        return result.payload;
      };
      const senderEnrollment = await enroll('Sender', 'quick-real-sender');
      const senderStore = new FileBridgeStore(path.join(root, 'sender'));
      await senderStore.init();
      const sender = await enrollConnector(baseUrl, senderEnrollment.enrollmentToken, senderStore, { name: 'Sender' });
      const senderConnector = new EnvoiConnector(baseUrl, senderStore);
      const enrollment = await enroll('Receiver', 'quick-real-receiver');
      const statusPath = `/api/inboxes/${workspaceId}/agent-enrollment-tokens/${enrollment.enrollmentId}/status`;
      expect((await api(baseUrl, statusPath, session)).payload.phase).toBe('waiting');
      let enrollmentRequests = 0;
      let gatewaySecretSentToEnvoi = false;
      const trackedFetch: typeof fetch = async (input, init) => {
        const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (address.origin === baseUrl) {
          if (address.pathname === '/api/agent-enroll') enrollmentRequests += 1;
          gatewaySecretSentToEnvoi ||= JSON.stringify(init?.headers).includes(gatewayToken) || String(init?.body || '').includes(gatewayToken);
        }
        return fetch(input, init);
      };
      const configured = await setupQuickConnect(enrollment.quickConnect, {
        stateDir, secureDirectory, env: {}, homeDir: root, configPath: path.join(root, 'openclaw.json'), fetch: trackedFetch,
        readFile: async () => JSON.stringify({ gateway: { port: gatewayAddress.port, auth: { mode: 'token', token: gatewayToken },
          http: { endpoints: { chatCompletions: { enabled: true } } } }, agents: { list: [{ id: 'main' }] } })
      });
      expect(configured.address).toBe('quick-real-receiver@envoi.mail');
      expect(configured.checks).toBe('passed');
      expect(enrollmentRequests).toBe(1);
      expect((await api(baseUrl, statusPath, session)).payload.phase).toBe('ready');
      const receiverStore = new FileBridgeStore(stateDir);
      const originalSession = await receiverStore.load();
      expect(originalSession?.inboxId).toBeTruthy();

      const start = async () => {
        connectorFailure = null;
        stop = new AbortController();
        let ready = false;
        running = startQuickConnect(stateDir, stop.signal, { secureDirectory, env: {}, fetch: trackedFetch,
          pollIntervalMs: 20, onReady: () => { ready = true; } }).catch(error => { connectorFailure = error; });
        await waitFor('connector startup', async () => ready, () => connectorFailure);
      };
      const stopConnector = async () => {
        stop?.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connector shutdown timed out')), 5_000); })]);
        } finally { clearTimeout(timer); }
        expect(connectorFailure).toBeNull();
        running = null;
        stop = null;
      };
      const caseId = newCaseId();
      const first = await senderConnector.startCase('quick-real-first', { recipientEmail: configured.address, caseId, text: 'First unsolicited message' });
      expect(first.caseId).toBe(caseId);
      await start();
      const received = async (messageId: string, replyText: string) => waitFor('processed incoming message and same-case reply', async () => {
        const messages = await senderConnector.listCaseMessages(caseId, 50);
        const incoming = messages.find(message => message.id === messageId);
        const replies = messages.filter(message => message.senderAgentId === configured.agentId && message.text === replyText);
        return incoming?.status === 'processed' && replies.length === 1 && replies[0].caseId === caseId ? messages : null;
      }, () => connectorFailure);
      await received(first.id, 'Processed First unsolicited message');
      expect(gatewayTurns.filter(turn => turn.user === `envoi:${caseId}`)).toHaveLength(1);
      await stopConnector();

      // The one-time enrollment is already consumed. Restart with persisted credentials,
      // including a rotation due to local access-token expiry, without redeeming again.
      await receiverStore.save({ ...originalSession!, agentTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
      const second = await senderConnector.sendCaseEvent('quick-real-second', {
        recipientEmail: configured.address, caseId, text: 'Second unsolicited message', intent: 'message'
      });
      await start();
      const messages = await received(second.id, 'Processed Second unsolicited message');
      expect(messages.filter(message => message.senderAgentId === configured.agentId)).toHaveLength(2);
      expect(messages.filter(message => message.senderAgentId === configured.agentId).every(message => message.recipientAgentId === sender.agentId)).toBe(true);
      expect(messages.find(message => message.id === first.id)?.status).toBe('processed');
      expect(messages.filter(message => message.text === 'Processed First unsolicited message')).toHaveLength(1);
      expect(gatewayTurns.filter(turn => turn.user === `envoi:${caseId}`)).toHaveLength(2);
      expect(gatewayTurns.every(turn => turn.model === 'openclaw/main')).toBe(true);
      expect(enrollmentRequests).toBe(1);
      const restartedSession = await receiverStore.load();
      expect(restartedSession?.agentId).toBe(originalSession?.agentId);
      expect(restartedSession?.inboxId).toBe(originalSession?.inboxId);
      expect(restartedSession?.agentRefreshToken).not.toBe(originalSession?.agentRefreshToken);
      expect(gatewaySecretSentToEnvoi).toBe(false);
      const status = (await api(baseUrl, statusPath, session)).payload;
      expect(status.phase).toBe('ready');
      expect(JSON.stringify(status)).not.toContain(gatewayToken);
      expect(JSON.stringify(status)).not.toContain(restartedSession?.agentApiToken);
      await stopConnector();
    } finally {
      stop?.abort();
      if (running) await running;
      if (app?.child && app.child.exitCode === null) {
        const child = app.child;
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      }
      gateway.closeAllConnections();
      if (gateway.listening) await new Promise<void>(resolve => gateway.close(() => resolve()));
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
