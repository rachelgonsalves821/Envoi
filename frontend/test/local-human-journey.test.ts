import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../../test/browser-session.js';
import { onboardingSteps } from '../src/model';
import type { HumanView, Inbox } from '../src/types';

type JsonResult = { status: number; payload: any };

async function request(baseUrl: string, route: string, options: { session?: BrowserSession; body?: unknown; method?: string } = {}): Promise<JsonResult> {
  const method = options.method || (options.body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.session?.headers(baseUrl, method) || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  options.session?.capture(response);
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-r1-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_AUTH_MODE: 'development', ENVOI_PORT: '0', ENVOI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 1000); });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local server start timed out: ${stderr}`)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local server exited with ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return {
    baseUrl,
    async stop() {
      if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      if (path.dirname(path.resolve(dataDir)) !== path.resolve(tmpdir())) throw new Error('Refusing to remove data outside the test temp directory');
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function createOwner(baseUrl: string, displayName: string, phoneNumber: string) {
  const session = new BrowserSession();
  const started = await request(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber, displayName } });
  expect(started.status).toBe(201);
  expect((await request(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } })).status).toBe(200);
  const setup = await request(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  expect(setup.status).toBe(201);
  expect((await request(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status).toBe(200);
  const workspace = await request(baseUrl, '/api/inboxes', { session, body: { name: `${displayName} workspace` } });
  expect(workspace.status).toBe(201);
  return { session, workspace: workspace.payload as Inbox };
}

describe('local two-owner human journey', () => {
  it('keeps redemption proof, owner views, and expired sessions separate', async () => {
    const server = await startServer();
    try {
      const alice = await createOwner(server.baseUrl, 'Alice', '+14165551101');
      const bob = await createOwner(server.baseUrl, 'Bob', '+14165551102');
      expect((await request(server.baseUrl, `/api/inboxes/${alice.workspace.id}/human-view`, { session: alice.session })).status).toBe(200);
      expect((await request(server.baseUrl, `/api/inboxes/${bob.workspace.id}/human-view`, { session: bob.session })).status).toBe(200);
      const token = await request(server.baseUrl, `/api/inboxes/${alice.workspace.id}/agent-enrollment-tokens`, {
        session: alice.session,
        body: { permissions: ['receive_agent_messages', 'send_agent_messages'], agentProfile: { name: 'Alice agent' } }
      });
      expect(token.status).toBe(201);
      const enrolled = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: token.payload.enrollmentToken, name: 'Alice agent' } });
      expect(enrolled.status).toBe(201);
      expect((await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: token.payload.enrollmentToken, name: 'Replay' } })).status).toBe(401);

      const parent = await request(server.baseUrl, `/api/inboxes/${alice.workspace.id}/human-view`, { session: alice.session });
      const child = await request(server.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/human-view`, { session: alice.session });
      expect(parent.status).toBe(200);
      expect(child.status).toBe(200);
      expect(parent.payload.recentEvents.some((event: { type: string }) => event.type === 'agent.inbox_created')).toBe(true);
      expect(onboardingSteps(parent.payload as HumanView, [enrolled.payload.inbox as Inbox]).find(step => step.id === 'sdk')?.complete).toBe(false);
      expect(onboardingSteps(child.payload as HumanView).find(step => step.id === 'sdk')?.complete).toBe(true);
      expect([401, 403]).toContain((await request(server.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/human-view`, { session: bob.session })).status);
      expect([401, 403]).toContain((await request(server.baseUrl, `/api/inboxes/${bob.workspace.id}/human-view`, { session: alice.session })).status);

      expect((await request(server.baseUrl, '/api/auth/logout', { session: alice.session, body: {} })).status).toBe(200);
      expect((await request(server.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/human-view`, { session: alice.session })).status).toBe(401);
      expect((await request(server.baseUrl, `/api/inboxes/${bob.workspace.id}/human-view`, { session: bob.session })).status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 30000);
});
