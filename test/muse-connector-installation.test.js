import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

async function fixture(t, enabled) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-muse-install-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development',
      SINALOA_DATA_DIR: dataDir, SINALOA_MUSE_CONNECTOR_INSTALL_ENABLED: enabled ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  t.after(async () => {
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const browser = new BrowserSession();
  async function request(pathname, { token, body, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}),
        ...(!token ? browser.headers(baseUrl, method) : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    browser.capture(response);
    return { status: response.status, payload: await response.json(), cacheControl: response.headers.get('cache-control') };
  }
  async function human(name, phone) {
    const started = await request('/api/auth/phone/start', { body: { phoneNumber: phone, displayName: name } });
    const verified = await request('/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
    const setup = await request('/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
    await request('/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
    return verified.payload.sessionToken;
  }
  const ownerToken = await human('Muse owner', '+14165550129');
  const workspace = await request('/api/inboxes', { token: ownerToken, body: { name: 'Muse install' } });
  const enrollment = await request(`/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, {
    token: ownerToken, body: { runtime: 'muse', permissions: ['receive_agent_messages'], agentProfile: { name: 'Muse', localPart: 'muse-installed' } }
  });
  const enrolled = await request('/api/agent-enroll', { body: { runtime: 'muse', enrollmentToken: enrollment.payload.enrollmentToken } });
  assert.equal(enrolled.status, 201);
  return { request, human, ownerToken, enrolled, dataDir,
    route: `/api/inboxes/${enrolled.payload.inbox.id}/agents/${enrolled.payload.agent.id}/muse-connector-installations` };
}

test('Muse installation intent is disabled by default and never grants credentials', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request(f.route, { token: f.ownerToken, body: { mode: 'read' } })).status, 404);
  assert.equal((await f.request('/api/agent/me', { token: f.enrolled.payload.agentProbeToken })).status, 200);
});

test('linked owner can request and revoke pending Muse installation without exposing or revoking secrets', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.request(f.route, { token: f.ownerToken, body: { mode: 'send' } })).status, 400);
  assert.equal((await f.request(f.route, { token: f.ownerToken, body: { mode: 'work', permissions: ['send_agent_messages'] } })).status, 400);
  const pending = await f.request(f.route, { token: f.ownerToken, body: { mode: 'work' } });
  assert.equal(pending.status, 201);
  assert.equal(pending.cacheControl, 'no-store');
  assert.deepEqual(Object.keys(pending.payload).sort(), ['agentId', 'createdAt', 'credentialIssued', 'id', 'inboxId', 'mode', 'ownerHumanId', 'status']);
  assert.equal(pending.payload.status, 'awaiting_provider_contract');
  assert.equal(pending.payload.credentialIssued, false);
  assert.equal(JSON.stringify(pending.payload).includes('agentRefreshToken'), false);
  const status = await f.request(`${f.route}/${pending.payload.id}`);
  assert.equal(status.status, 200, JSON.stringify(status.payload));
  assert.deepEqual(status.payload, pending.payload);
  const probe = f.enrolled.payload.agentProbeToken;
  assert.equal((await f.request('/api/agent/work/availability', { token: probe })).status, 200);
  assert.equal((await f.request('/api/agent/work/claim', { token: probe, body: {} })).status, 401);
  const revoked = await f.request(`${f.route}/${pending.payload.id}/revoke`, { token: f.ownerToken, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.payload.status, 'revoked');
  assert.equal((await f.request('/api/agent/work/availability', { token: probe })).status, 200);
  const families = await new FileStore(f.dataDir).listJson(path.join('auth', 'agent-credential-families', f.enrolled.payload.inbox.id, f.enrolled.payload.agent.id));
  assert.equal(families.length, 1);
  assert.equal(families[0].revokedAt, null);
  const stranger = await f.human('Stranger', '+14165550130');
  assert.equal((await f.request(`${f.route}/${pending.payload.id}`, { token: stranger })).status, 401);
});
