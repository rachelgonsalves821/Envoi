import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

const browserSession = new BrowserSession();
async function request(baseUrl, pathname, { token, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(!token && method !== 'GET' ? browserSession.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  browserSession.capture(response);
  return { status: response.status, payload: await response.json() };
}
async function eventually(check) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for native delivery');
}

test('owner-approved Muse grant sends one canonical message only to a bound Hermes recipient', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-muse-send-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  t.after(async () => { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); await rm(dataDir, { recursive: true, force: true }); });
  const started = await request(baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550130', displayName: 'Send test owner' } });
  const verified = await request(baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const setup = await request(baseUrl, '/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
  await request(baseUrl, '/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  const workspace = await request(baseUrl, '/api/inboxes', { token: verified.payload.sessionToken, body: { name: 'Muse send test' } });
  async function enroll(runtime, name, localPart, permissions) {
    const token = await request(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: verified.payload.sessionToken, body: { runtime, permissions, agentProfile: { name, localPart } } });
    assert.equal(token.status, 201);
    const enrolled = await request(baseUrl, '/api/agent-enroll', { body: { runtime, enrollmentToken: token.payload.enrollmentToken } });
    assert.equal(enrolled.status, 201);
    return enrolled.payload;
  }
  const muse = await enroll('muse', 'Muse', 'muse-send', ['receive_agent_messages']);
  const hermes = await enroll('hermes', 'Hermes', 'hermes-recv', ['send_agent_messages', 'receive_agent_messages']);
  const grantRoute = `/api/inboxes/${muse.inbox.id}/agents/${muse.agent.id}/muse-send-test-grants`;
  assert.equal((await request(baseUrl, grantRoute, { token: verified.payload.sessionToken, body: { recipientAddress: muse.agent.address } })).status, 404);
  const issued = await request(baseUrl, grantRoute, { token: verified.payload.sessionToken, body: { recipientAddress: hermes.agent.address } });
  assert.equal(issued.status, 201);
  assert.equal(issued.payload.scope, 'muse_send_test');
  assert.equal(issued.payload.recipientAddress, hermes.agent.address);
  assert.ok(issued.payload.sendTestToken.startsWith('envoi_muse_send_test_'));
  assert.ok(Date.parse(issued.payload.expiresAt) <= Date.now() + 300_000);
  assert.equal(issued.payload.agentApiToken, undefined);
  assert.equal(issued.payload.agentRefreshToken, undefined);
  const token = issued.payload.sendTestToken;
  const store = new FileStore(dataDir);
  const route = `/api/inboxes/${muse.inbox.id}/messages`;
  const body = { senderAgentId: muse.agent.id, recipientEmail: hermes.agent.address, text: 'Hello Hermes, this is one approved Muse send.' };

  assert.equal((await request(baseUrl, '/api/agent/work/availability', { token })).status, 401);
  assert.equal((await request(baseUrl, '/api/agent/me', { token })).status, 401);
  assert.equal((await request(baseUrl, '/api/agent/work/claim', { token, body: {} })).status, 401);
  assert.equal((await request(baseUrl, '/api/agent-token', { body: { agentRefreshToken: token } })).status, 401);
  assert.equal((await request(baseUrl, `/api/inboxes/${muse.inbox.id}/messages`, { token })).status, 401);
  assert.equal((await request(baseUrl, route, { token, body: { ...body, recipientEmail: 'another@agents.sinaloa.mail' } })).status, 403);
  assert.equal((await request(baseUrl, route, { token, body: { ...body, caseId: 'case_injection' } })).status, 400);
  assert.equal((await request(baseUrl, route, { token, body: { ...body, idempotencyKey: 'client-chosen' } })).status, 400);
  const mcp = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 401);
  assert.equal((await request(baseUrl, route, { token: muse.agentProbeToken, body, headers: { 'Idempotency-Key': 'muse-probe-cannot-send' } })).status, 401);

  // The protocol rejects this header only after the grant has been claimed.
  // Its transaction must restore the grant and leave no canonical message.
  const failedAfterClaim = await request(baseUrl, route, { token, body, headers: { traceparent: 'x'.repeat(513) } });
  assert.equal(failedAfterClaim.status, 422);
  const grantPath = path.join('auth', 'muse-send-test-grants', `${issued.payload.grantId}.json`);
  assert.equal((await store.getJson(grantPath)).usedAt, null);
  assert.deepEqual(await store.listJson(path.join('inboxes', muse.inbox.id, 'messages')), []);

  const first = await request(baseUrl, route, { token, body });
  assert.equal(first.status, 202);
  assert.equal(first.payload.senderAgentId, muse.agent.id);
  assert.equal(first.payload.recipientAgentId, hermes.agent.id);
  const replay = await request(baseUrl, route, { token, body });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.id, first.payload.id);
  assert.equal((await request(baseUrl, route, { token, body: { ...body, text: 'Second, forbidden send' } })).status, 409);
  assert.equal((await request(baseUrl, route, { token, body: { ...body, recipientEmail: 'another@agents.sinaloa.mail' } })).status, 403);

  const delivered = await eventually(async () => {
    const message = await store.getJson(path.join('inboxes', hermes.inbox.id, 'messages', `${first.payload.id}.json`));
    return message?.status === 'delivered' ? message : null;
  });
  assert.equal(delivered.text, body.text);
  const tokenIndexPath = path.join('auth', 'agent-credentials', `${crypto.createHash('sha256').update(token).digest('hex')}.json`);
  const tokenIndex = await store.getJson(tokenIndexPath);
  await store.putJson(tokenIndexPath, { ...tokenIndex, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await request(baseUrl, route, { token, body })).status, 401);
  const claimed = await request(baseUrl, '/api/agent/work/claim', { token: hermes.agentApiToken, body: {} });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.payload.work?.message?.id, first.payload.id);

  const secondGrant = await request(baseUrl, grantRoute, { token: verified.payload.sessionToken, body: { recipientAddress: hermes.agent.address } });
  assert.equal(secondGrant.status, 201);
  const revoked = await request(baseUrl, `/api/inboxes/${muse.inbox.id}/agents/${muse.agent.id}/credentials/revoke`, { token: verified.payload.sessionToken, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await request(baseUrl, route, { token: secondGrant.payload.sendTestToken, body: { ...body, text: 'Revoked send' } })).status, 401);
  const messages = await store.listJson(path.join('inboxes', muse.inbox.id, 'messages'));
  assert.equal(messages.filter(message => message.senderAgentId === muse.agent.id).length, 1);
});
