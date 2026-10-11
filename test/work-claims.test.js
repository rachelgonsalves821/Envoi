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

async function startServer(dataDir = null, environment = {}) {
  const directory = dataDir || await mkdtemp(path.join(tmpdir(), 'sinaloa-work-claims-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: directory, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, dataDir: directory, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function request(baseUrl, pathname, { token, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(!token && method !== 'GET' ? browserSession.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  browserSession.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function fixture(t, environment = {}) {
  let server = await startServer(null, environment);
  t.after(async () => {
    await server.stop();
    await rm(server.dataDir, { recursive: true, force: true });
  });
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Work owner' } });
  const verified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const setup = await request(server.baseUrl, '/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
  const mfa = await request(server.baseUrl, '/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  const workspace = await request(server.baseUrl, '/api/inboxes', { token: verified.payload.sessionToken, body: { name: 'Work claims' } });
  async function enroll(name) {
    const token = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: verified.payload.sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
    const agent = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: token.payload.enrollmentToken, name, slug: name.toLowerCase() } });
    return agent.payload;
  }
  const sender = await enroll('Sender');
  const recipient = await enroll('Recipient');
  const fixtureStore = new FileStore(server.dataDir);
  const message = {
    id: 'msg_work_contract_1', messageId: 'msg_work_contract_1', caseId: 'case_work_contract_1',
    senderInboxId: sender.inbox.id, recipientInboxId: recipient.inbox.id,
    senderAgentId: sender.agent.id, recipientAgentId: recipient.agent.id,
    senderEmail: sender.agent.address, from: { agentId: sender.agent.id, address: sender.agent.address },
    to: [{ agentId: recipient.agent.id, address: recipient.agent.address }],
    type: 'message', text: 'Canonical work payload', content: [{ type: 'text', text: 'Canonical work payload' }],
    createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), status: 'delivered'
  };
  await fixtureStore.putJson(path.join('inboxes', recipient.inbox.id, 'messages', `${message.id}.json`), message);
  await fixtureStore.putJson(path.join('inboxes', sender.inbox.id, 'messages', `${message.id}.json`), message);
  return {
    get server() { return server; },
    set server(value) { server = value; },
    humanToken: verified.payload.sessionToken,
    recipient,
    sender,
    message,
    fixtureStore,
    claim: (token = recipient.agentApiToken) => request(server.baseUrl, '/api/agent/work/claim', { token, body: {} }),
    work: (action, workId, token, body, key) => request(server.baseUrl, `/api/agent/work/${workId}/${action}`, { token, body, ...(key ? { headers: { 'Idempotency-Key': key } } : {}) })
  };
}

test('claims are exclusive and fenced completion creates one replayable processed receipt', async t => {
  const state = await fixture(t);
  const simultaneous = await Promise.all([state.claim(), state.claim()]);
  assert.deepEqual(simultaneous.map(result => result.status), [200, 200]);
  const granted = simultaneous.map(result => result.payload.work).filter(Boolean);
  assert.equal(granted.length, 1);
  const work = granted[0];
  assert.equal(work.workId, state.message.id);
  assert.deepEqual(work.message, state.message);
  const unfencedLegacySettlement = await request(state.server.baseUrl, `/api/inboxes/${state.recipient.inbox.id}/messages/${work.workId}/acknowledgements`, {
    token: state.recipient.agentApiToken, headers: { 'Idempotency-Key': 'legacy-bypass-attempt' }, body: { state: 'processed' }
  });
  assert.equal(unfencedLegacySettlement.status, 410);
  assert.equal((await state.fixtureStore.getJson(path.join('inboxes', state.recipient.inbox.id, 'messages', `${work.workId}.json`))).status, 'delivered');

  const alternateFamilyId = 'credential_family_alternate';
  const alternateToken = 'envoi_agent_access_alternate_family';
  const alternateTokenHash = crypto.createHash('sha256').update(alternateToken).digest('hex');
  await state.fixtureStore.putJson(path.join('auth', 'agent-credentials', `${alternateTokenHash}.json`), {
    tokenType: 'access', agentId: state.recipient.agent.id, inboxId: state.recipient.inbox.id, familyId: alternateFamilyId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null
  });
  await state.fixtureStore.putJson(path.join('auth', 'agent-credential-families', state.recipient.inbox.id, state.recipient.agent.id, `${alternateFamilyId}.json`), {
    id: alternateFamilyId, agentId: state.recipient.agent.id, inboxId: state.recipient.inbox.id,
    refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null
  });
  const wrongFamily = await state.work('renew', work.workId, alternateToken, { leaseToken: work.leaseToken });
  assert.equal(wrongFamily.status, 409);

  const renewed = await state.work('renew', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken });
  assert.equal(renewed.status, 200);
  assert.ok(Date.parse(renewed.payload.leaseExpiresAt) > Date.parse(work.leaseExpiresAt));
  const acknowledged = await state.work('acknowledge', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken }, 'admit-once');
  assert.equal(acknowledged.status, 201);
  assert.equal(acknowledged.payload.status, 'acknowledged');
  const replayedAdmission = await state.work('acknowledge', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken }, 'admit-once');
  assert.equal(replayedAdmission.status, 200);
  assert.deepEqual(replayedAdmission.payload, acknowledged.payload);

  const completed = await state.work('complete', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken }, 'complete-once');
  assert.equal(completed.status, 201);
  assert.equal(completed.payload.status, 'processed');
  const replayed = await state.work('complete', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken }, 'complete-once');
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.payload, completed.payload);
  const conflictingReplay = await state.work('complete', work.workId, state.recipient.agentApiToken, { leaseToken: 'different-fence' }, 'complete-once');
  assert.equal(conflictingReplay.status, 409);
  const processedReceipts = (await state.fixtureStore.listJson(path.join('inboxes', state.recipient.inbox.id, 'delivery-receipts'))).filter(receipt => receipt.messageId === work.workId && receipt.state === 'processed');
  assert.equal(processedReceipts.length, 1);
  const secondMessage = { ...state.message, id: 'msg_work_contract_2', messageId: 'msg_work_contract_2', caseId: 'case_work_contract_2', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() };
  await state.fixtureStore.putJson(path.join('inboxes', state.recipient.inbox.id, 'messages', `${secondMessage.id}.json`), secondMessage);
  const secondWork = (await state.claim()).payload.work;
  const conflictingKey = await state.work('complete', secondWork.workId, state.recipient.agentApiToken, { leaseToken: secondWork.leaseToken }, 'complete-once');
  assert.equal(conflictingKey.status, 409);
  assert.equal((await state.claim()).payload.work, null);
});

test('expired leases are reclaimed under a new fence and retry failures observe backoff', async t => {
  const state = await fixture(t, { SINALOA_AGENT_WORK_LEASE_MS: '1000', SINALOA_AGENT_WORK_RETRY_BASE_MS: '40' });
  const first = (await state.claim()).payload.work;
  const claimPath = path.join('inboxes', state.recipient.inbox.id, 'work-claims', `${first.workId}.json`);
  const firstClaim = await state.fixtureStore.getJson(claimPath);
  await state.fixtureStore.putJson(claimPath, { ...firstClaim, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
  const reclaimed = (await state.claim()).payload.work;
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  const staleSettlement = await state.work('complete', first.workId, state.recipient.agentApiToken, { leaseToken: first.leaseToken }, 'stale-complete');
  assert.equal(staleSettlement.status, 409);
  const acknowledged = await state.work('acknowledge', reclaimed.workId, state.recipient.agentApiToken, { leaseToken: reclaimed.leaseToken }, 'admit-reclaimed');
  assert.equal(acknowledged.status, 201);
  const retryable = await state.work('fail', reclaimed.workId, state.recipient.agentApiToken, { leaseToken: reclaimed.leaseToken, retryable: true, reasonCode: 'temporary' });
  assert.deepEqual(retryable.payload, { workId: state.message.id, status: 'retryable' });
  const retryState = await state.fixtureStore.getJson(claimPath);
  assert.equal(retryState.status, 'retryable');
  assert.equal(retryState.attempts, 2);
  assert.ok(Date.parse(retryState.retryAt) - Date.parse(retryState.failure.createdAt) >= 80, 'The second attempt must schedule exponential backoff');
  // The original 80 ms can expire before a CI HTTP round trip finishes. Check
  // both sides of the persisted deadline without relying on runner speed.
  await state.fixtureStore.putJson(claimPath, { ...retryState, retryAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await state.claim()).payload.work, null);
  await state.fixtureStore.putJson(claimPath, { ...retryState, retryAt: new Date(Date.now() - 60_000).toISOString() });
  const retryClaim = (await state.claim()).payload.work;
  assert.ok(retryClaim);
  assert.notEqual(retryClaim.leaseToken, reclaimed.leaseToken);
  const replayedAcknowledgement = await state.work('acknowledge', retryClaim.workId, state.recipient.agentApiToken, { leaseToken: retryClaim.leaseToken }, 'admit-retry-attempt');
  assert.equal(replayedAcknowledgement.status, 200);
  assert.deepEqual(replayedAcknowledgement.payload.receipt, acknowledged.payload.receipt);
  const completed = await state.work('complete', retryClaim.workId, state.recipient.agentApiToken, { leaseToken: retryClaim.leaseToken }, 'complete-retry-attempt');
  assert.equal(completed.status, 201);
  const terminalMessage = { ...state.message, id: 'msg_work_terminal', messageId: 'msg_work_terminal', caseId: 'case_work_terminal', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() };
  await state.fixtureStore.putJson(path.join('inboxes', state.recipient.inbox.id, 'messages', `${terminalMessage.id}.json`), terminalMessage);
  const terminalWork = (await state.claim()).payload.work;
  const terminal = await state.work('fail', terminalWork.workId, state.recipient.agentApiToken, { leaseToken: terminalWork.leaseToken, retryable: false, reasonCode: 'permanent' });
  assert.equal(terminal.payload.status, 'failed');
  assert.equal((await state.claim()).payload.work, null);
  for (const inboxId of [state.sender.inbox.id, state.recipient.inbox.id]) {
    const failedMessage = await state.fixtureStore.getJson(path.join('inboxes', inboxId, 'messages', `${terminalMessage.id}.json`));
    const receipt = await state.fixtureStore.getJson(path.join('inboxes', inboxId, 'delivery-receipts', `delivery_receipt_${terminalMessage.id}_failed.json`));
    assert.equal(failedMessage.status, 'failed');
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.reasonCode, 'permanent');
  }
});

test('retry attempts are capped and an expired final lease fails visibly to both humans', async t => {
  const state = await fixture(t, { SINALOA_AGENT_WORK_LEASE_MS: '1000', SINALOA_AGENT_WORK_MAX_ATTEMPTS: '2', SINALOA_AGENT_WORK_RETRY_BASE_MS: '500' });
  const first = (await state.claim()).payload.work;
  const firstFailure = await state.work('fail', first.workId, state.recipient.agentApiToken, { leaseToken: first.leaseToken, retryable: true, reasonCode: 'temporary' });
  assert.equal(firstFailure.payload.status, 'retryable');
  assert.equal((await state.claim()).payload.work, null);
  await new Promise(resolve => setTimeout(resolve, 550));
  const second = (await state.claim()).payload.work;
  assert.ok(second);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await state.claim()).payload.work, null);
  for (const inboxId of [state.sender.inbox.id, state.recipient.inbox.id]) {
    const failedMessage = await state.fixtureStore.getJson(path.join('inboxes', inboxId, 'messages', `${state.message.id}.json`));
    const receipt = await state.fixtureStore.getJson(path.join('inboxes', inboxId, 'delivery-receipts', `delivery_receipt_${state.message.id}_failed.json`));
    assert.equal(failedMessage.status, 'failed');
    assert.equal(receipt.reasonCode, 'MAX_ATTEMPTS_EXCEEDED');
    assert.equal(receipt.attempts, 2);
  }
});

test('claims persist across restart and settlement rejects revoked credentials or lost receive permission', async t => {
  const state = await fixture(t);
  const work = (await state.claim()).payload.work;
  await state.server.stop();
  state.server = await startServer(state.server.dataDir);
  const renewed = await state.work('renew', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken });
  assert.equal(renewed.status, 200);

  await state.fixtureStore.putJson(path.join('inboxes', state.recipient.inbox.id, 'agents', `${state.recipient.agent.id}.json`), { ...state.recipient.agent, permissions: ['send_agent_messages'] });
  const permissionLost = await state.work('complete', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken }, 'permission-lost');
  assert.equal(permissionLost.status, 403);
  await state.fixtureStore.putJson(path.join('inboxes', state.recipient.inbox.id, 'agents', `${state.recipient.agent.id}.json`), { ...state.recipient.agent, status: 'paused' });
  const paused = await state.work('renew', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken });
  // a3-pause-auth v1: a paused agent's settlement is refused as AGENT_PAUSED, never a generic 401.
  assert.deepEqual([paused.status, paused.payload.code], [409, 'AGENT_PAUSED']);
  await state.fixtureStore.putJson(path.join('inboxes', state.recipient.inbox.id, 'agents', `${state.recipient.agent.id}.json`), state.recipient.agent);

  const revoked = await request(state.server.baseUrl, `/api/inboxes/${state.recipient.inbox.id}/agents/${state.recipient.agent.id}/credentials/revoke`, { token: state.humanToken, body: {} });
  assert.equal(revoked.status, 200);
  const settlementAfterRevoke = await state.work('fail', work.workId, state.recipient.agentApiToken, { leaseToken: work.leaseToken, retryable: false });
  assert.deepEqual([settlementAfterRevoke.status, settlementAfterRevoke.payload.code], [401, 'CREDENTIAL_REVOKED']);
});
