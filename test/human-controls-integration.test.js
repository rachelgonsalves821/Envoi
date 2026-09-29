import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

async function launch() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-controls-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10000);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, dataDir, get stderr() { return stderr; }, stop: async () => { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); await rm(dataDir, { recursive: true, force: true }); } };
}

async function api(baseUrl, route, { token, session, body, key } = {}) {
  const method = body ? 'POST' : 'GET';
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const phone = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165554${suffix}`, displayName: `Control owner ${suffix}` } });
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: phone.payload.challengeId, code: phone.payload.developmentCode } });
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Controls ${suffix}` } });
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Control agent ${suffix}`, slug: `control-${suffix}` } });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.payload));
  return { session, human: verified.payload.human, ...enrolled.payload };
}

async function eventually(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected delivery did not complete');
}

test('human pause, case pause, block and revoke gate REST, MCP, work and assets', async t => {
  const server = await launch();
  t.after(server.stop);
  const { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([owner(baseUrl, '4101'), owner(baseUrl, '4102'), owner(baseUrl, '4103')]);
  const caseId = 'case_control_A_B';
  const send = (who, other, key, text) => api(baseUrl, `/api/inboxes/${who.inbox.id}/messages`, { token: who.agentApiToken, key, body: { senderAgentId: who.agent.id, recipientEmail: other.agent.address, caseId, type: 'request', text } });
  const first = await send(alice, bob, 'control-first', 'First control message');
  assert.equal(first.status, 202);
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/messages?caseId=${caseId}`, { token: bob.agentApiToken })).payload.some(item => item.id === first.payload.id && item.status === 'delivered'));
  const claim = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
  assert.equal(claim.status, 200);
  assert.equal(claim.payload.work.workId, first.payload.id);
  const pause = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/pause`, { session: bob.session, body: {} });
  assert.equal(pause.status, 200, `${JSON.stringify(pause.payload)} ${server.stderr}`);
  assert.equal(pause.payload.paused, true);
  assert.equal(pause.payload.credentialRevoked, false);
  assert.equal((await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} })).status, 401);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: claim.payload.work.leaseToken } })).status, 401);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/complete`, { token: bob.agentApiToken, key: 'paused-complete', body: { leaseToken: claim.payload.work.leaseToken } })).status, 401);
  assert.equal((await api(baseUrl, '/mcp', { token: bob.agentApiToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal((await send(alice, bob, 'paused-recipient', 'Must wait')).status, 404);
  const bobView = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/human-view`, { session: bob.session });
  assert.equal(bobView.payload.agents.find(agent => agent.id === bob.agent.id).paused, true);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: outsider.session, body: {} })).status, 403);
  const resume = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: bob.session, body: {} });
  assert.equal(resume.status, 200);
  assert.equal(resume.payload.paused, false);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: claim.payload.work.leaseToken } })).status, 200);

  const unauthorizedDecision = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: outsider.session, key: 'outsider-decision', body: { actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: 'forged' } } });
  assert.equal(unauthorizedDecision.status, 403);
  const casePause = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-pause', body: { actionKey: 'pause' } });
  assert.equal(casePause.status, 201, JSON.stringify(casePause.payload));
  assert.equal(casePause.payload.case.state, 'paused');
  const pauseReplay = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-pause', body: { actionKey: 'pause' } });
  assert.equal(pauseReplay.status, 200);
  assert.equal(pauseReplay.payload.action.id, casePause.payload.action.id);
  assert.equal((await send(alice, bob, 'paused-case-send', 'Must wait')).status, 409);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/complete`, { token: bob.agentApiToken, key: 'case-paused-complete', body: { leaseToken: claim.payload.work.leaseToken } })).status, 409);
  const caseResume = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-resume', body: { actionKey: 'resume' } });
  assert.equal(caseResume.status, 201, JSON.stringify(caseResume.payload));
  assert.equal(caseResume.payload.case.state, 'inProgress');

  const bytes = Buffer.from('control asset');
  const upload = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/asset-uploads`, { token: alice.agentApiToken, key: 'control-upload', body: { filename: 'control.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('base64'), caseId } });
  assert.equal(upload.status, 201);
  const grantRoute = `/api/inboxes/${alice.inbox.id}/assets/${upload.payload.object.id}/grants`;
  assert.equal((await api(baseUrl, grantRoute, { token: alice.agentApiToken, key: 'control-grant', body: { caseId, recipientAgentId: bob.agent.id } })).status, 201);
  const blocked = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/block`, { session: alice.session, body: {} });
  assert.equal(blocked.status, 200);
  assert.equal((await send(bob, alice, 'blocked-send', 'Must be blocked')).status, 403);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: claim.payload.work.leaseToken } })).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/assets/${upload.payload.object.id}/download`, { token: bob.agentApiToken })).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/approve`, { session: alice.session, body: {} })).status, 404);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/unblock`, { session: alice.session, body: {} })).status, 200);
  assert.equal((await send(bob, alice, 'unblocked-send', 'Allowed again')).status, 202);
  const revoked = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/revoke`, { session: bob.session, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/human-view`, { session: bob.session })).payload.agents.find(agent => agent.id === bob.agent.id).credentialRevoked, true);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: bob.session, body: {} })).status, 409);
  assert.equal((await api(baseUrl, '/api/agent-token', { body: { agentRefreshToken: bob.agentRefreshToken } })).status, 401);
  assert.equal((await api(baseUrl, '/mcp', { token: bob.agentApiToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).status, 401);
});
