import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

async function launch(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10_000);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function api(baseUrl, route, { token, session, body, key } = {}) {
  const method = body ? 'POST' : 'GET';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function signIn(baseUrl, suffix) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165556${suffix}`, displayName: `Owner ${suffix}` } });
  assert.equal(started.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } })).status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  return session;
}

async function workspaceAgent(baseUrl, session, name, slug) {
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name } });
  assert.equal(workspace.status, 201, JSON.stringify(workspace.payload));
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] } });
  assert.equal(enrollment.status, 201);
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name, slug } });
  assert.equal(enrolled.status, 201);
  return { session, workspace: workspace.payload, ...enrolled.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected participant directory entry did not appear');
}

test('the human participant directory carries each counterparty agent organization so the UI can tell coworkers from other organizations', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-participant-org-'));
  const server = await launch(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const { baseUrl } = server;

  // One person with two workspaces shares one organization; a second person has their own.
  const ownerSession = await signIn(baseUrl, '7101');
  const payments = await workspaceAgent(baseUrl, ownerSession, 'Payments agent', 'org-payments');
  const platform = await workspaceAgent(baseUrl, ownerSession, 'Platform agent', 'org-platform');
  const outsider = await workspaceAgent(baseUrl, await signIn(baseUrl, '7102'), 'Vendor agent', 'org-vendor');
  assert.equal(payments.agent.organizationId, platform.agent.organizationId);
  assert.notEqual(payments.agent.organizationId, outsider.agent.organizationId);

  const send = (from, to, caseId, key) => api(baseUrl, `/api/inboxes/${from.inbox.id}/messages`, {
    token: from.agentApiToken, key,
    body: { senderAgentId: from.agent.id, recipientEmail: to.agent.address, caseId, type: 'request', intent: 'request', text: `Hello from ${from.agent.name}` }
  });
  assert.equal((await send(payments, platform, 'case_same_org', 'same-org-1')).status, 202);
  assert.equal((await send(payments, outsider, 'case_other_org', 'other-org-1')).status, 202);

  const directory = await eventually(async () => {
    const view = await api(baseUrl, `/api/inboxes/${payments.inbox.id}/human-view`, { session: ownerSession });
    const entries = view.payload.participantDirectory || {};
    return entries[platform.agent.id] && entries[outsider.agent.id] ? { inbox: view.payload.inbox, entries } : null;
  });

  const coworker = directory.entries[platform.agent.id];
  assert.equal(coworker.type, 'externalAgent');
  assert.equal(coworker.organizationId, directory.inbox.organizationId);

  const external = directory.entries[outsider.agent.id];
  assert.equal(external.type, 'externalAgent');
  assert.equal(external.organizationId, outsider.agent.organizationId);
  assert.notEqual(external.organizationId, directory.inbox.organizationId);

  // Only identifiers are projected for other organizations, never their names or members.
  for (const entry of [coworker, external]) {
    assert.deepEqual(Object.keys(entry).sort(), ['accessState', 'address', 'displayName', 'id', 'inboxId', 'organizationId', 'type']);
  }
});
