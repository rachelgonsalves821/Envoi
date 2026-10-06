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

test('Muse enrollment issues only a bounded read probe, scoped to its inbox and revoked with its family', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-muse-probe-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  t.after(async () => { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); await rm(dataDir, { recursive: true, force: true }); });
  const started = await request(baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550128', displayName: 'Muse owner' } });
  const verified = await request(baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const setup = await request(baseUrl, '/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
  await request(baseUrl, '/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  const workspace = await request(baseUrl, '/api/inboxes', { token: verified.payload.sessionToken, body: { name: 'Muse test' } });
  const route = `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`;
  const broad = await request(baseUrl, route, { token: verified.payload.sessionToken, body: { runtime: 'muse', permissions: ['send_agent_messages', 'receive_agent_messages'], agentProfile: { name: 'Muse', localPart: 'muse-test' } } });
  assert.equal(broad.status, 400);
  const minted = await request(baseUrl, route, { token: verified.payload.sessionToken, body: { runtime: 'muse', permissions: ['receive_agent_messages'], agentProfile: { name: 'Muse', localPart: 'muse-test' } } });
  assert.equal(minted.status, 201);
  assert.equal(minted.payload.quickConnect, undefined);
  assert.equal(minted.payload.enrollmentUrl, undefined);
  const enrolled = await request(baseUrl, '/api/agent-enroll', { body: { runtime: 'muse', enrollmentToken: minted.payload.enrollmentToken } });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.payload.scope, 'agent_probe');
  assert.equal(enrolled.payload.agent.runtime, 'muse');
  assert.deepEqual(enrolled.payload.agent.permissions, ['receive_agent_messages']);
  assert.ok(enrolled.payload.agentProbeToken.startsWith('envoi_agent_probe_'));
  assert.ok(Date.parse(enrolled.payload.agentProbeExpiresAt) <= Date.now() + 300_000);
  assert.equal(enrolled.payload.agentApiToken, undefined);
  assert.equal(enrolled.payload.agentRefreshToken, undefined);
  const token = enrolled.payload.agentProbeToken;
  const inboxId = enrolled.payload.inbox.id;
  const store = new FileStore(dataDir);
  assert.deepEqual(await store.listJson(path.join('auth', 'agent-refresh-credentials')), []);

  const senderToken = await request(baseUrl, route, { token: verified.payload.sessionToken, body: { runtime: 'openclaw', permissions: ['send_agent_messages', 'receive_agent_messages'], agentProfile: { name: 'Sender', localPart: 'muse-sender' } } });
  const sender = await request(baseUrl, '/api/agent-enroll', { body: { runtime: 'openclaw', enrollmentToken: senderToken.payload.enrollmentToken } });
  assert.equal(sender.status, 201);
  const deliveredAt = new Date().toISOString();
  const message = {
    id: 'msg_muse_probe', messageId: 'msg_muse_probe', caseId: 'case_muse_probe',
    senderInboxId: sender.payload.inbox.id, recipientInboxId: inboxId,
    senderAgentId: sender.payload.agent.id, recipientAgentId: enrolled.payload.agent.id,
    senderEmail: sender.payload.agent.address, from: { agentId: sender.payload.agent.id, address: sender.payload.agent.address },
    to: [{ agentId: enrolled.payload.agent.id, address: enrolled.payload.agent.address }],
    type: 'message', text: 'Private message body', content: [{ type: 'text', text: 'Private message body' }],
    createdAt: deliveredAt, deliveredAt, status: 'delivered'
  };
  await store.putJson(path.join('inboxes', inboxId, 'messages', `${message.id}.json`), message);

  const available = await request(baseUrl, '/api/agent/work/availability', { token });
  assert.equal(available.status, 200);
  assert.deepEqual(Object.keys(available.payload).sort(), ['checkedAt', 'exhausted', 'leased', 'oldestReadyAt', 'ready', 'retrying']);
  assert.equal(available.payload.ready, 1);
  assert.equal(JSON.stringify(available.payload).includes('Private message body'), false);
  assert.equal(JSON.stringify(available.payload).includes(message.id), false);
  assert.equal((await request(baseUrl, `/api/agent/work/availability?inboxId=${sender.payload.inbox.id}`, { token })).payload.ready, 1);
  assert.equal((await request(baseUrl, '/api/agent/work/claim', { token, body: {} })).status, 401);
  assert.equal((await request(baseUrl, '/api/agent-token', { body: { agentRefreshToken: token } })).status, 401);
  assert.equal((await request(baseUrl, '/api/agent/mcp-read-token', { token, body: {} })).status, 401);
  assert.equal((await request(baseUrl, `/api/inboxes/${inboxId}/messages`, { token, headers: { 'Idempotency-Key': 'muse-probe-send-denial' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: 'other@agents.envoi-agents.com', text: 'denied' } })).status, 401);
  const mcp = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 401);
  assert.equal((await request(baseUrl, '/api/agent-enroll', { body: { runtime: 'muse', enrollmentToken: minted.payload.enrollmentToken } })).status, 401);

  const indexPath = path.join('auth', 'agent-credentials', `${crypto.createHash('sha256').update(token).digest('hex')}.json`);
  const index = await store.getJson(indexPath);
  assert.equal(index.tokenType, 'agent_probe');
  await store.putJson(indexPath, { ...index, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await request(baseUrl, '/api/agent/work/availability', { token })).status, 401);
  await store.putJson(indexPath, index);
  const revoked = await request(baseUrl, `/api/inboxes/${inboxId}/agents/${enrolled.payload.agent.id}/credentials/revoke`, { token: verified.payload.sessionToken, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await request(baseUrl, '/api/agent/work/availability', { token })).status, 401);

  const reconnect = await request(baseUrl, `/api/inboxes/${inboxId}/agents/${enrolled.payload.agent.id}/credentials/reconnect-token`, { token: verified.payload.sessionToken, body: { runtime: 'muse', permissions: ['receive_agent_messages'] } });
  assert.equal(reconnect.status, 201);
  assert.equal(reconnect.payload.quickConnect, undefined);
  assert.equal(reconnect.payload.enrollmentUrl, undefined);
  const resumed = await request(baseUrl, '/api/agent-enroll', { body: { runtime: 'muse', enrollmentToken: reconnect.payload.enrollmentToken } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.payload.agent.address, enrolled.payload.agent.address);
  assert.ok(resumed.payload.agentProbeToken.startsWith('envoi_agent_probe_'));
  assert.equal(resumed.payload.agentApiToken, undefined);
  assert.equal(resumed.payload.agentRefreshToken, undefined);
  assert.equal((await request(baseUrl, '/api/agent/work/availability', { token: resumed.payload.agentProbeToken })).payload.ready, 1);
  assert.equal((await request(baseUrl, '/api/agent/work/availability', { token })).status, 401);
});
