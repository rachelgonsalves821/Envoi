import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-test-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function request(baseUrl, pathname, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  return { status: response.status, payload };
}

test('verified human issues a single-use permissioned agent enrollment', async t => {
  const server = await startServer();
  t.after(server.stop);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  assert.equal(started.status, 201);
  const verified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const sessionToken = verified.payload.sessionToken;
  const phoneOnlyWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Denied' } });
  assert.equal(phoneOnlyWorkspace.status, 401);
  const totpSetup = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  assert.equal(totpSetup.status, 201);
  const totpVerified = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: generateSync({ secret: totpSetup.payload.secret }) } });
  assert.equal(totpVerified.status, 200);
  assert.equal(totpVerified.payload.assurance, 'mfa');
  const workspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Owner workspace' } });
  assert.equal(workspace.status, 201);
  const tokenResponse = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets'] } });
  assert.equal(tokenResponse.status, 201);
  const enrolled = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Worker', slug: 'worker' } });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.payload.agent.address, 'worker@sinaloa.mail');
  assert.ok(enrolled.payload.agentApiToken.startsWith('sinaloa_agent_'));
  const reused = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Replay' } });
  assert.equal(reused.status, 401);
  const spoofed = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: enrolled.payload.agent.id, text: 'spoof' } });
  assert.equal(spoofed.status, 401);
  const sent = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: enrolled.payload.agent.id, text: 'authenticated' } });
  assert.equal(sent.status, 201);
  const hidden = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`);
  assert.equal(hidden.status, 401);
  const visible = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: sessionToken });
  assert.equal(visible.status, 200);
  assert.equal(visible.payload.length, 1);
});
