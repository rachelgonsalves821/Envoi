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

async function request(baseUrl, pathname, { token, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
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
  assert.equal('credentialHash' in enrolled.payload.agent, false);
  const reused = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Replay' } });
  assert.equal(reused.status, 401);
  const recipientWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Recipient workspace' } });
  const recipientToken = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
  const recipient = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: recipientToken.payload.enrollmentToken, name: 'Recipient', slug: 'recipient' } });
  const spoofed = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { headers: { 'Idempotency-Key': 'spoof-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, text: 'spoof' } });
  assert.equal(spoofed.status, 401);
  const messageBody = { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, text: 'authenticated cross-inbox message' };
  const sent = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: messageBody });
  assert.equal(sent.status, 201);
  assert.equal(sent.payload.status, 'delivered');
  const retry = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: messageBody });
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.id, sent.payload.id);
  const conflict = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: { ...messageBody, text: 'different' } });
  assert.equal(conflict.status, 409);
  const hidden = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`);
  assert.equal(hidden.status, 401);
  const visible = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/messages`, { token: sessionToken });
  assert.equal(visible.status, 200);
  assert.equal(visible.payload.length, 1);
  assert.equal(visible.payload[0].id, sent.payload.id);
  const second = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-2' }, body: { ...messageBody, text: 'second message' } });
  assert.equal(second.status, 201);
  const firstPage = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/messages?limit=1`, { token: sessionToken });
  assert.equal(firstPage.payload.length, 1);
  assert.equal(firstPage.payload[0].id, second.payload.id);
  const secondPage = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/messages?limit=1&before=${encodeURIComponent(second.payload.createdAt)}`, { token: sessionToken });
  assert.equal(secondPage.payload.length, 1);
  assert.equal(secondPage.payload[0].id, sent.payload.id);
  const blocked = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/contacts/${enrolled.payload.agent.id}/block`, { token: sessionToken, body: {} });
  assert.equal(blocked.status, 200);
  const rejected = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-3' }, body: { ...messageBody, text: 'blocked message' } });
  assert.equal(rejected.status, 403);
});
