import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { createProtocolMessage } from '../src/protocol-v1.js';
import { FileStore } from '../src/storage.js';

const browserSession = new BrowserSession();

async function startServer(environment = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-test-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, SINALOA_ENABLE_CALENDAR_WRITES: 'true', SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS: 'true', SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR: '10000', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, dataDir, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function request(baseUrl, pathname, options = {}) {
  const { token, body, headers = {}, session = browserSession, method = body ? 'POST' : 'GET' } = options;
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(Object.hasOwn(options, 'token') && !token ? session.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  session.capture(response);
  const payload = await response.json();
  return { status: response.status, payload };
}

// Returns as soon as the check passes; the ceiling only absorbs full-suite load.
async function waitFor(check, { timeoutMs = 15000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for asynchronous delivery');
}

async function readSseEvent(baseUrl, pathname, { token, lastEventId, matches, timeoutMs = 3000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop();
      for (const block of blocks) {
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (matches(event)) return event;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  throw new Error('SSE stream ended before the expected event');
}

async function waitForStreamClose(reader, timeoutMs = 2000) {
  return Promise.race([
    (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) return true;
      }
    })(),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

test('verified human issues a single-use permissioned agent enrollment', async t => {
  const server = await startServer();
  t.after(server.stop);
  const readiness = await request(server.baseUrl, '/ready');
  assert.equal(readiness.status, 200);
  assert.equal(readiness.payload.ready, true);
  assert.equal(readiness.payload.checks.database.ready, true);
  assert.equal(readiness.payload.checks.malwareScanner.critical, false);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  assert.equal(started.status, 201);
  const throttled = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  assert.equal(throttled.status, 429);
  const concurrentPhoneVerification = await Promise.all([
    request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } }),
    request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } })
  ]);
  assert.deepEqual(concurrentPhoneVerification.map(result => result.status).sort(), [200, 400]);
  const verified = concurrentPhoneVerification.find(result => result.status === 200);
  assert.equal(verified.status, 200);
  assert.equal(verified.payload.sessionToken, undefined);
  assert.equal(verified.payload.secondFactorRequired, true);
  assert.equal(verified.payload.mfaSetupRequired, true);
  assert.equal('totpSecret' in verified.payload.human, false);
  assert.equal('pendingTotpSecret' in verified.payload.human, false);
  const sessionToken = verified.payload.sessionToken;
  const newHumanResume = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  assert.equal(newHumanResume.status, 200);
  assert.equal(newHumanResume.payload.auth.assurance, 'phone');
  assert.equal(newHumanResume.payload.mfaSetupRequired, true);
  const phoneOnlyWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Denied' } });
  assert.equal(phoneOnlyWorkspace.status, 401);
  const totpSetup = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  assert.equal(totpSetup.status, 201);
  const totpSetupReplay = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  assert.equal(totpSetupReplay.status, 201);
  assert.equal(totpSetupReplay.payload.secret, totpSetup.payload.secret);
  const totpCode = generateSync({ secret: totpSetup.payload.secret });
  const totpVerified = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: totpCode } });
  assert.equal(totpVerified.status, 200);
  assert.equal(totpVerified.payload.assurance, 'mfa');
  const replayedTotp = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: totpCode } });
  assert.equal(replayedTotp.status, 401);

  const rateDirectory = path.join(server.dataDir, 'auth', 'phone-rate-limits');
  const [rateFilename] = await readdir(rateDirectory);
  await writeFile(path.join(rateDirectory, rateFilename), JSON.stringify({ starts: [] }, null, 2));
  const returningStarted = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  const returningVerified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: returningStarted.payload.challengeId, code: returningStarted.payload.developmentCode } });
  assert.equal(returningVerified.status, 200);
  assert.equal(returningVerified.payload.secondFactorRequired, true);
  assert.equal(returningVerified.payload.mfaSetupRequired, false);
  assert.equal('totpSecret' in returningVerified.payload.human, false);
  assert.equal('pendingTotpSecret' in returningVerified.payload.human, false);
  const returningHumanResume = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  assert.equal(returningHumanResume.status, 200);
  assert.equal(returningHumanResume.payload.auth.assurance, 'phone');
  assert.equal(returningHumanResume.payload.mfaSetupRequired, false);
  const cookieOnlyHeaders = browserSession.headers(server.baseUrl, 'GET');
  const missingCsrfResponse = await fetch(`${server.baseUrl}/api/auth/totp/setup`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieOnlyHeaders.cookie }, body: '{}' });
  assert.equal(missingCsrfResponse.status, 403);
  assert.match((await missingCsrfResponse.json()).error, /CSRF/i);
  const forbiddenReenrollment = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  assert.equal(forbiddenReenrollment.status, 403);
  assert.match(forbiddenReenrollment.payload.message, /Existing second factor/i);
  const returningTotpCode = generateSync({ secret: totpSetup.payload.secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  const returningTotpVerified = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: returningTotpCode } });
  assert.equal(returningTotpVerified.status, 200);
  assert.equal(returningTotpVerified.payload.assurance, 'mfa');
  const completedMfaProfile = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  assert.equal(completedMfaProfile.payload.auth.assurance, 'mfa');
  assert.equal('mfaSetupRequired' in completedMfaProfile.payload, false);
  const workspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Owner workspace' } });
  assert.equal(workspace.status, 201);
  assert.ok(workspace.payload.organizationId.startsWith('org_'));
  const organizations = await request(server.baseUrl, '/api/organizations', { token: sessionToken });
  assert.equal(organizations.status, 200);
  assert.equal(organizations.payload.length, 1);
  assert.equal(organizations.payload[0].id, workspace.payload.organizationId);
  const organizationWorkspaces = await request(server.baseUrl, `/api/organizations/${workspace.payload.organizationId}/workspaces`, { token: sessionToken });
  assert.equal(organizationWorkspaces.status, 200);
  assert.equal(organizationWorkspaces.payload[0].id, workspace.payload.id);
  const organizationCreated = await request(server.baseUrl, '/api/organizations', { token: sessionToken, headers: { 'Idempotency-Key': 'organization-create-1' }, body: { name: 'Second workspace' } });
  assert.equal(organizationCreated.status, 201);
  const organizationReplay = await request(server.baseUrl, '/api/organizations', { token: sessionToken, headers: { 'Idempotency-Key': 'organization-create-1' }, body: { name: 'Second workspace' } });
  assert.equal(organizationReplay.status, 201);
  assert.equal(organizationReplay.payload.id, organizationCreated.payload.id);
  const organizationConflict = await request(server.baseUrl, '/api/organizations', { token: sessionToken, headers: { 'Idempotency-Key': 'organization-create-1' }, body: { name: 'Changed workspace' } });
  assert.equal(organizationConflict.status, 409);
  const organizationsBeforeRace = await request(server.baseUrl, '/api/organizations', { token: sessionToken });
  const racedOrganizations = await Promise.all([
    request(server.baseUrl, '/api/organizations', { token: sessionToken, headers: { 'Idempotency-Key': 'organization-concurrent-1' }, body: { name: 'Concurrent workspace' } }),
    request(server.baseUrl, '/api/organizations', { token: sessionToken, headers: { 'Idempotency-Key': 'organization-concurrent-1' }, body: { name: 'Concurrent workspace' } })
  ]);
  assert.ok(racedOrganizations.every(result => [201, 409].includes(result.status)));
  assert.ok(racedOrganizations.some(result => result.status === 201));
  const organizationsAfterRace = await request(server.baseUrl, '/api/organizations', { token: sessionToken });
  assert.equal(organizationsAfterRace.payload.length, organizationsBeforeRace.payload.length + 1);
  const tokenResponse = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  assert.equal(tokenResponse.status, 201);
  const concurrentEnrollment = await Promise.all([
    request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Worker', slug: 'worker' } }),
    request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Worker', slug: 'worker' } })
  ]);
  assert.deepEqual(concurrentEnrollment.map(result => result.status).sort(), [201, 401]);
  const enrolled = concurrentEnrollment.find(result => result.status === 201);
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.payload.agent.address, 'worker@envoi.mail');
  assert.ok(enrolled.payload.agentApiToken.startsWith('envoi_agent_access_'));
  assert.ok(enrolled.payload.agentRefreshToken.startsWith('envoi_agent_refresh_'));
  assert.ok(new Date(enrolled.payload.agentTokenExpiresAt) > new Date());
  assert.equal('credentialHash' in enrolled.payload.agent, false);
  const rotated = await request(server.baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: enrolled.payload.agentRefreshToken, rotationId: 'rotation-enrollment-1' } });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.payload.agentApiToken, enrolled.payload.agentApiToken);
  assert.notEqual(rotated.payload.agentRefreshToken, enrolled.payload.agentRefreshToken);
  const replayedRefresh = await request(server.baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: enrolled.payload.agentRefreshToken, rotationId: 'rotation-enrollment-1' } });
  assert.equal(replayedRefresh.status, 200);
  assert.deepEqual(replayedRefresh.payload, rotated.payload);
  // A different rotationId now revokes the whole family (a3-pause-auth v1 REFRESH_REPLAY), which
  // would turn the reconnect below into a re-enrollment; agent-mcp.test.js covers that path.
  enrolled.payload.agentApiToken = rotated.payload.agentApiToken;
  enrolled.payload.agentRefreshToken = rotated.payload.agentRefreshToken;
  const senderInboxId = enrolled.payload.inbox.id;
  assert.notEqual(senderInboxId, workspace.payload.id);
  assert.equal(enrolled.payload.inbox.ownerAgentId, enrolled.payload.agent.id);
  const reconnectDenied = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/agents/${enrolled.payload.agent.id}/credentials/reconnect-token`, { token: sessionToken, body: {}, session: new BrowserSession() });
  assert.equal(reconnectDenied.status, 403);
  const reconnectToken = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/agents/${enrolled.payload.agent.id}/credentials/reconnect-token`, { token: sessionToken, body: {} });
  assert.equal(reconnectToken.status, 201);
  assert.equal(reconnectToken.payload.address, enrolled.payload.agent.address);
  const previousAccessToken = enrolled.payload.agentApiToken;
  const previousRefreshToken = enrolled.payload.agentRefreshToken;
  const reconnectAttempts = await Promise.all([
    request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnectToken.payload.enrollmentToken } }),
    request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnectToken.payload.enrollmentToken } })
  ]);
  assert.deepEqual(reconnectAttempts.map(result => result.status).sort(), [200, 401]);
  const reconnected = reconnectAttempts.find(result => result.status === 200);
  assert.equal(reconnected.status, 200);
  assert.equal(reconnected.payload.agent.id, enrolled.payload.agent.id);
  assert.equal(reconnected.payload.inbox.id, senderInboxId);
  assert.equal(reconnected.payload.agent.address, enrolled.payload.agent.address);
  assert.equal((await request(server.baseUrl, `/api/inboxes/${senderInboxId}/agent-view?agentId=${enrolled.payload.agent.id}`, { token: previousAccessToken })).status, 401);
  assert.equal((await request(server.baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: previousRefreshToken, rotationId: 'rotation-revoked-1' } })).status, 401);
  assert.equal((await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnectToken.payload.enrollmentToken } })).status, 401);
  enrolled.payload.agentApiToken = reconnected.payload.agentApiToken;
  enrolled.payload.agentRefreshToken = reconnected.payload.agentRefreshToken;
  const reused = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Replay' } });
  assert.equal(reused.status, 401);
  const recipientWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Recipient workspace' } });
  const recipientToken = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
  const recipient = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: recipientToken.payload.enrollmentToken, name: 'Recipient', slug: 'recipient' } });
  const recipientInboxId = recipient.payload.inbox.id;
  assert.notEqual(recipientInboxId, recipientWorkspace.payload.id);
  const recipientAgentView = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/agent-view?agentId=${recipient.payload.agent.id}`, { token: recipient.payload.agentApiToken });
  assert.equal(recipientAgentView.status, 200);
  assert.deepEqual(recipientAgentView.payload.capabilities.sort(), ['receive_agent_messages', 'send_agent_messages']);
  const spoofed = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { headers: { 'Idempotency-Key': 'spoof-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: recipient.payload.agent.address, text: 'spoof' } });
  assert.equal(spoofed.status, 401);
  const rawRecipientId = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'raw-id-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, text: 'not address routed' } });
  assert.equal(rawRecipientId.status, 400);
  const mixedRecipientIdentifiers = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'mixed-id-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, recipientEmail: recipient.payload.agent.address, text: 'not address only' } });
  assert.equal(mixedRecipientIdentifiers.status, 400);
  const unavailableRecipient = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'unknown-address-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: 'unknown@envoi.mail', text: 'unknown' } });
  assert.equal(unavailableRecipient.status, 404);
  const messageBody = { senderAgentId: enrolled.payload.agent.id, recipientEmail: recipient.payload.agent.address, text: 'authenticated cross-inbox message' };
  const sent = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: messageBody });
  assert.equal(sent.status, 202);
  assert.ok(['queued', 'delivered'].includes(sent.payload.status));
  const firstRecipientView = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/human-view`, { token: sessionToken });
  assert.equal(firstRecipientView.status, 200);
  assert.equal(firstRecipientView.payload.canManageInbox, true);
  assert.deepEqual(firstRecipientView.payload.invitations, []);
  assert.equal(firstRecipientView.payload.publicEmailTransport.enabled, false);
  assert.equal(firstRecipientView.payload.publicEmailTransport.ready, false);
  assert.equal(firstRecipientView.payload.publicEmailTransport.reason, 'disabledByConfiguration');
  assert.equal(sent.payload.schemaVersion, '1.0');
  assert.equal(sent.payload.messageId, sent.payload.id);
  assert.equal(sent.payload.conversationId, sent.payload.caseId);
  assert.equal(sent.payload.from.agentId, enrolled.payload.agent.id);
  assert.equal(sent.payload.to[0].agentId, recipient.payload.agent.id);
  const delivered = await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
    return response.payload.find(item => item.id === sent.payload.id && item.status === 'delivered');
  });
  assert.ok(delivered.deliveredAt);
  const retry = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: messageBody });
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.id, sent.payload.id);
  const conflict = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: { ...messageBody, text: 'different' } });
  assert.equal(conflict.status, 409);
  const hidden = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`);
  assert.equal(hidden.status, 401);
  const wrongInboxCredential = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: recipient.payload.agentApiToken });
  assert.equal(wrongInboxCredential.status, 401);
  const visible = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
  assert.equal(visible.status, 200);
  assert.equal(visible.payload.length, 1);
  assert.equal(visible.payload[0].id, sent.payload.id);
  assert.equal(visible.payload[0].status, 'delivered');
  const legacyAcknowledgement = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages/${sent.payload.id}/acknowledgements`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'legacy-ack-message-1' }, body: { state: 'processed' } });
  assert.equal(legacyAcknowledgement.status, 410);
  const firstWork = await request(server.baseUrl, '/api/agent/work/claim', { token: recipient.payload.agentApiToken, body: {} });
  assert.equal(firstWork.payload.work.workId, sent.payload.id);
  const acknowledged = await request(server.baseUrl, `/api/agent/work/${sent.payload.id}/acknowledge`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'ack-message-1' }, body: { leaseToken: firstWork.payload.work.leaseToken } });
  assert.equal(acknowledged.status, 201);
  assert.equal(acknowledged.payload.receipt.state, 'acknowledged');
  const acknowledgedReplay = await request(server.baseUrl, `/api/agent/work/${sent.payload.id}/acknowledge`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'ack-message-1' }, body: { leaseToken: firstWork.payload.work.leaseToken } });
  assert.equal(acknowledgedReplay.status, 200);
  const processed = await request(server.baseUrl, `/api/agent/work/${sent.payload.id}/complete`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'processed-message-1' }, body: { leaseToken: firstWork.payload.work.leaseToken } });
  assert.equal(processed.status, 201);
  assert.equal(processed.payload.receipt.state, 'processed');
  const initialDelta = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/events/delta?limit=200`, { token: enrolled.payload.agentApiToken });
  assert.equal(initialDelta.status, 200);
  assert.ok(initialDelta.payload.events.length > 0);
  assert.ok(initialDelta.payload.nextCursor);
  const receipts = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/delivery-receipts`, { token: sessionToken });
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'delivered'));
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'acknowledged'));
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'processed'));
  const deliveries = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/deliveries`, { token: sessionToken });
  assert.ok(deliveries.payload.some(delivery => delivery.messageId === sent.payload.id && delivery.status === 'delivered'));
  const credentialFamilyId = deliveries.payload.find(delivery => delivery.messageId === sent.payload.id).senderCredentialFamilyId;
  assert.ok(credentialFamilyId);
  const fixtureStore = new FileStore(server.dataDir);
  const queueDelayedMessage = async (messageId, targetRecipient, delayMs = 1000) => {
    const createdAt = new Date().toISOString();
    const caseId = `case_${messageId}`;
    const message = { ...sent.payload, id: messageId, messageId, caseId, conversationId: caseId, recipientAgentId: targetRecipient.agent.id, recipientInboxId: targetRecipient.inbox.id, recipientEmail: targetRecipient.agent.address, to: [{ agentId: targetRecipient.agent.id, address: targetRecipient.agent.address }], text: messageId, content: [{ type: 'text', text: messageId }], createdAt, queuedAt: createdAt, status: 'queued' };
    const outbox = { id: `delivery_${messageId}`, kind: 'nativeAgentMessage', messageId, senderInboxId, recipientInboxId: targetRecipient.inbox.id, senderCredentialFamilyId: credentialFamilyId, orderingKey: caseId, status: 'queued', attempts: 0, maxAttempts: 5, availableAt: new Date(Date.now() + delayMs).toISOString(), createdAt, updatedAt: createdAt };
    await fixtureStore.enqueueOutbox([{ path: path.join('inboxes', senderInboxId, 'messages', `${messageId}.json`), value: message }], outbox);
    return outbox.id;
  };
  const second = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-2' }, body: { ...messageBody, text: 'second message' } });
  assert.equal(second.status, 202);
  const incrementalDelta = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/events/delta?cursor=${encodeURIComponent(initialDelta.payload.nextCursor)}&limit=200`, { token: enrolled.payload.agentApiToken });
  assert.equal(incrementalDelta.status, 200);
  assert.ok(incrementalDelta.payload.events.some(event => event.messageId === second.payload.id && event.type === 'message.queued'));
  const replayedEvent = await readSseEvent(server.baseUrl, `/api/inboxes/${senderInboxId}/events`, {
    token: enrolled.payload.agentApiToken,
    lastEventId: initialDelta.payload.nextCursor,
    matches: event => event.messageId === second.payload.id && event.type === 'message.queued'
  });
  assert.equal(replayedEvent.messageId, second.payload.id);
  await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
    return response.payload.find(item => item.id === second.payload.id && item.status === 'delivered');
  });
  const secondWork = await request(server.baseUrl, '/api/agent/work/claim', { token: recipient.payload.agentApiToken, body: {} });
  assert.equal(secondWork.payload.work.workId, second.payload.id);
  const directlyProcessed = await request(server.baseUrl, `/api/agent/work/${second.payload.id}/complete`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'processed-message-2' }, body: { leaseToken: secondWork.payload.work.leaseToken } });
  assert.equal(directlyProcessed.status, 201);
  const regressiveAcknowledgement = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages/${second.payload.id}/acknowledgements`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'late-ack-message-2' }, body: { state: 'acknowledged' } });
  assert.equal(regressiveAcknowledgement.status, 410);
  const messageAfterRegressiveAcknowledgement = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
  assert.equal(messageAfterRegressiveAcknowledgement.payload.find(message => message.id === second.payload.id).status, 'processed');
  const firstPage = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages?limit=1`, { token: sessionToken });
  assert.equal(firstPage.payload.length, 1);
  assert.equal(firstPage.payload[0].id, second.payload.id);
  const secondPage = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages?limit=1&before=${encodeURIComponent(second.payload.createdAt)}`, { token: sessionToken });
  assert.equal(secondPage.payload.length, 1);
  assert.equal(secondPage.payload[0].id, sent.payload.id);
  const blocked = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/contacts/${enrolled.payload.agent.id}/block`, { token: sessionToken, body: {} });
  assert.equal(blocked.status, 200);
  const rejected = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-3' }, body: { ...messageBody, text: 'blocked message' } });
  assert.equal(rejected.status, 403);
  const blockedDeliveryId = await queueDelayedMessage('msg_blocked_before_delivery', recipient.payload);
  await waitFor(async () => (await fixtureStore.getOutbox(blockedDeliveryId))?.status === 'deadLettered', { timeoutMs: 10000 });
  const blockedRecipientMessages = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
  assert.equal(blockedRecipientMessages.payload.some(message => message.id === 'msg_blocked_before_delivery'), false);

  const thirdToken = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
  assert.equal(thirdToken.status, 409);
  const raceSession = new BrowserSession();
  const racePhone = await request(server.baseUrl, '/api/auth/phone/start', { session: raceSession, body: { phoneNumber: '+14165550124', displayName: 'Race owner' } });
  const raceVerified = await request(server.baseUrl, '/api/auth/phone/verify', { session: raceSession, body: { challengeId: racePhone.payload.challengeId, code: racePhone.payload.developmentCode } });
  const raceSetup = await request(server.baseUrl, '/api/auth/totp/setup', { session: raceSession, token: raceVerified.payload.sessionToken, body: {} });
  await request(server.baseUrl, '/api/auth/totp/verify', { session: raceSession, token: raceVerified.payload.sessionToken, body: { code: generateSync({ secret: raceSetup.payload.secret }) } });
  const raceWorkspace = await request(server.baseUrl, '/api/inboxes', { session: raceSession, token: raceVerified.payload.sessionToken, body: { name: 'Concurrent message workspace' } });
  const raceToken = await request(server.baseUrl, `/api/inboxes/${raceWorkspace.payload.id}/agent-enrollment-tokens`, { session: raceSession, token: raceVerified.payload.sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
  const raceRecipient = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: raceToken.payload.enrollmentToken, name: 'Race Recipient', slug: 'race-recipient' } });
  const concurrentMessages = await Promise.all([
    request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'concurrent-message-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: raceRecipient.payload.agent.address, text: 'first concurrent contact' } }),
    request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'concurrent-message-2' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: raceRecipient.payload.agent.address, text: 'second concurrent contact' } })
  ]);
  assert.deepEqual(concurrentMessages.map(result => result.status), [202, 202]);
  assert.notEqual(concurrentMessages[0].payload.id, concurrentMessages[1].payload.id);
  const duplicateFirstSend = await Promise.all([1, 2].map(() => request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'concurrent-message-duplicate' }, body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: raceRecipient.payload.agent.address, text: 'same concurrent message' } })));
  assert.deepEqual(duplicateFirstSend.map(result => result.status).sort(), [200, 202]);
  assert.equal(duplicateFirstSend[0].payload.id, duplicateFirstSend[1].payload.id);
  await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/messages`, { token: raceRecipient.payload.agentApiToken });
    return [...concurrentMessages, duplicateFirstSend[0]].every(result => response.payload.some(message => message.id === result.payload.id && message.status === 'delivered'));
  });
  const raceInvitations = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/invitations`, { session: raceSession, token: raceVerified.payload.sessionToken });
  assert.deepEqual(raceInvitations.payload, []);

  const legacyKey = 'legacy-pending-1';
  const legacyBody = { senderAgentId: enrolled.payload.agent.id, recipientEmail: raceRecipient.payload.agent.address, text: 'legacy pending message' };
  const legacyMessageId = `msg_${crypto.createHash('sha256').update(`${enrolled.payload.agent.id}:${legacyKey}`).digest('hex').slice(0, 32)}`;
  const legacyInvitationId = `invitation_${crypto.createHash('sha256').update(`${enrolled.payload.agent.id}:${raceRecipient.payload.agent.id}`).digest('hex').slice(0, 40)}`;
  const legacyAt = new Date().toISOString();
  const legacyMessage = {
    id: legacyMessageId,
    ...createProtocolMessage({ messageId: legacyMessageId, conversationId: 'conversation_legacy', from: { agentId: enrolled.payload.agent.id, address: enrolled.payload.agent.address }, to: [{ agentId: raceRecipient.payload.agent.id, address: raceRecipient.payload.agent.address }], text: legacyBody.text, createdAt: legacyAt }),
    caseId: 'conversation_legacy', senderInboxId, recipientInboxId: raceRecipient.payload.inbox.id,
    senderType: 'agent', senderAgentId: enrolled.payload.agent.id, recipientAgentId: raceRecipient.payload.agent.id,
    recipientEmail: raceRecipient.payload.agent.address, transport: 'native', type: 'message', text: legacyBody.text,
    payload: null, createdAt: legacyAt, status: 'pendingContactApproval', invitationId: legacyInvitationId
  };
  const legacyInvitation = { id: legacyInvitationId, senderAgentId: enrolled.payload.agent.id, recipientAgentId: raceRecipient.payload.agent.id, senderInboxId, recipientInboxId: raceRecipient.payload.inbox.id, state: 'pending', messageId: legacyMessageId, createdAt: legacyAt, updatedAt: legacyAt };
  for (const targetInboxId of [senderInboxId, raceRecipient.payload.inbox.id]) {
    const invitationDirectory = path.join(server.dataDir, 'inboxes', targetInboxId, 'invitations');
    await mkdir(invitationDirectory, { recursive: true });
    await writeFile(path.join(invitationDirectory, `${legacyInvitationId}.json`), JSON.stringify(legacyInvitation));
  }
  await writeFile(path.join(server.dataDir, 'inboxes', senderInboxId, 'messages', `${legacyMessageId}.json`), JSON.stringify(legacyMessage));
  const resumedLegacy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': legacyKey }, body: legacyBody });
  assert.equal(resumedLegacy.status, 202);
  assert.equal(resumedLegacy.payload.id, legacyMessageId);
  await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/messages`, { token: raceRecipient.payload.agentApiToken });
    return response.payload.some(message => message.id === legacyMessageId && message.status === 'delivered');
  });
  const supersededInvitation = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/invitations`, { session: raceSession, token: raceVerified.payload.sessionToken });
  assert.equal(supersededInvitation.payload.find(invitation => invitation.id === legacyInvitationId).state, 'superseded');
  const declinedLegacy = { ...legacyInvitation, state: 'declined', updatedAt: new Date().toISOString() };
  await writeFile(path.join(server.dataDir, 'inboxes', raceRecipient.payload.inbox.id, 'invitations', `${legacyInvitationId}.json`), JSON.stringify(declinedLegacy));
  await writeFile(path.join(server.dataDir, 'inboxes', raceRecipient.payload.inbox.id, 'contacts', `${enrolled.payload.agent.id}.json`), JSON.stringify({ agentId: enrolled.payload.agent.id, state: 'declined', approved: false, blocked: false }));
  const declinedSend = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'declined-legacy-1' }, body: { ...legacyBody, text: 'direct send remains valid' } });
  assert.equal(declinedSend.status, 202);
  // A historical declined invitation does not block an exact-address native send.
  await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/messages`, { token: raceRecipient.payload.agentApiToken });
    return response.payload.some(message => message.id === declinedSend.payload.id && message.status === 'delivered');
  });

  const schedulingNow = Date.now();
  const caseDeadline = new Date(schedulingNow + 24 * 60 * 60_000).toISOString();
  const meetingStart = new Date(schedulingNow + 90 * 60_000).toISOString();
  const meetingEnd = new Date(schedulingNow + 120 * 60_000).toISOString();
  const caseCreated = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases`, { token: enrolled.payload.agentApiToken, body: { objective: 'Schedule Q4 planning with Acme', collaborationMode: 'scheduling', participants: [recipient.payload.agent.id], constraints: { workingHoursEnd: '16:00', timezone: 'America/Toronto' }, deadline: caseDeadline } });
  assert.equal(caseCreated.status, 201, JSON.stringify(caseCreated.payload));
  assert.equal(caseCreated.payload.schemaVersion, '1.0');
  const progress = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'case-progress-1' }, body: { actionKey: 'case.classify', outcome: 'ok', nextState: 'inProgress' } });
  assert.equal(progress.status, 201);
  assert.equal(progress.payload.case.state, 'inProgress');
  const activeAgentView = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/agent-view?agentId=${enrolled.payload.agent.id}`, { token: enrolled.payload.agentApiToken });
  assert.equal(activeAgentView.status, 200);
  assert.ok(activeAgentView.payload.queue.activeCases.some(item => item.id === caseCreated.payload.id));
  assert.deepEqual(activeAgentView.payload.capabilities.sort(), ['create_assets', 'execute_cases', 'receive_agent_messages', 'send_agent_messages']);
  const concurrentEvents = await Promise.all([
    request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/events`, { token: enrolled.payload.agentApiToken, body: { type: 'message', payload: { marker: 'concurrent-a' } } }),
    request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/events`, { token: enrolled.payload.agentApiToken, body: { type: 'message', payload: { marker: 'concurrent-b' } } })
  ]);
  assert.deepEqual(concurrentEvents.map(result => result.status), [201, 201]);
  const caseAfterConcurrentEvents = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}`, { token: enrolled.payload.agentApiToken });
  assert.deepEqual(caseAfterConcurrentEvents.payload.events.filter(event => event.payload?.marker?.startsWith('concurrent-')).map(event => event.payload.marker).sort(), ['concurrent-a', 'concurrent-b']);
  const ownerProfile = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  const membershipPath = path.join(server.dataDir, 'organizations', workspace.payload.organizationId, 'members', `${ownerProfile.payload.id}.json`);
  const ownerMembership = { organizationId: workspace.payload.organizationId, humanId: ownerProfile.payload.id, role: 'owner', status: 'active', createdAt: workspace.payload.createdAt };
  await writeFile(membershipPath, JSON.stringify({ ...ownerMembership, role: 'member' }, null, 2));
  const observerView = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/human-view`, { token: sessionToken });
  assert.equal(observerView.status, 200);
  assert.equal(observerView.payload.canManageInbox, false);
  const observerIntervention = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: sessionToken, headers: { 'Idempotency-Key': 'observer-must-not-pause' }, body: { actionKey: 'pause' } });
  assert.equal(observerIntervention.status, 403);
  await writeFile(membershipPath, JSON.stringify(ownerMembership, null, 2));
  const messagingOnlyCaseMutation = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/cases/${sent.payload.caseId}/events`, { token: recipient.payload.agentApiToken, body: { type: 'message', payload: { marker: 'must-not-write' } } });
  assert.equal(messagingOnlyCaseMutation.status, 403);
  const messagingOnlyCaseAction = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/cases/${sent.payload.caseId}/actions`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'messaging-only-action' }, body: { actionKey: 'case.classify', outcome: 'ok', nextState: 'inProgress' } });
  assert.equal(messagingOnlyCaseAction.status, 403);
  const unknownPolicy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/policy-evaluations`, { token: enrolled.payload.agentApiToken, body: { requestedAction: 'wireFunds' } });
  assert.equal(unknownPolicy.status, 201);
  assert.equal(unknownPolicy.payload.decision, 'deny');
  assert.equal(unknownPolicy.payload.reasonCode, 'unsupportedAction');
  const unknownWithoutPolicy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'unknown-action-1' }, body: { actionKey: 'wireFunds', outcome: 'ok' } });
  assert.equal(unknownWithoutPolicy.status, 400);
  const deniedUnknown = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'unknown-action-2' }, body: { actionKey: 'wireFunds', outcome: 'ok', policyEvaluationId: unknownPolicy.payload.id } });
  assert.equal(deniedUnknown.status, 403);
  const proposal = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/proposals`, { token: enrolled.payload.agentApiToken, body: { kind: 'schedule', expiresAt: meetingEnd, options: [{ id: 'option_1630', value: { start: meetingStart, end: meetingEnd, timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', outOfPolicyFlags: ['outsideWorkingHours'] }] } });
  assert.equal(proposal.status, 201);
  const policy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/policy-evaluations`, { token: enrolled.payload.agentApiToken, body: { requestedAction: 'calendar.confirmMeeting', expiresAt: meetingEnd } });
  assert.equal(policy.status, 201);
  assert.equal(policy.payload.decision, 'needsHuman');
  const blockedAccept = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/proposals/${proposal.payload.id}/accept`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'proposal-accept-1' }, body: { optionId: 'option_1630', policyEvaluationId: policy.payload.id } });
  assert.equal(blockedAccept.status, 202);
  assert.equal(blockedAccept.payload.action.outcome, 'needsApproval');
  const humanApproval = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: sessionToken, headers: { 'Idempotency-Key': 'human-approve-1' }, body: { actionKey: 'approveOnce', externalRefs: { policyEvaluationId: policy.payload.id } } });
  assert.equal(humanApproval.status, 201);
  assert.equal(humanApproval.payload.case.state, 'authorized');
  const humanApprovalReplay = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: sessionToken, headers: { 'Idempotency-Key': 'human-approve-1' }, body: { actionKey: 'approveOnce', externalRefs: { policyEvaluationId: policy.payload.id } } });
  assert.equal(humanApprovalReplay.status, 200);
  assert.equal(humanApprovalReplay.payload.replay, true);
  const changedHumanReplay = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: sessionToken, headers: { 'Idempotency-Key': 'human-approve-1' }, body: { actionKey: 'decline', externalRefs: { policyEvaluationId: policy.payload.id } } });
  assert.equal(changedHumanReplay.status, 409);

  const paymentCase = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases`, { token: enrolled.payload.agentApiToken, body: { objective: 'Pay approved launch supplier', collaborationMode: 'collaboration' } });
  assert.equal(paymentCase.status, 201);
  const paymentExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const paymentPayload = { counterparties: [{ type: 'human', email: 'supplier@example.com' }], amount: { minorUnits: 5000, currency: 'CAD' }, executeNotAfter: paymentExpiry };
  const paymentPolicy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/policy-evaluations`, { token: enrolled.payload.agentApiToken, body: { requestedAction: 'payment.send', actionPayload: paymentPayload, expiresAt: paymentExpiry } });
  assert.equal(paymentPolicy.status, 201);
  assert.equal(paymentPolicy.payload.decision, 'allow');
  const alteredPayment = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'payment-altered-1' }, body: { actionKey: 'payment.send', outcome: 'ok', policyEvaluationId: paymentPolicy.payload.id, actionPayload: { ...paymentPayload, amount: { minorUnits: 9000, currency: 'CAD' } } } });
  assert.equal(alteredPayment.status, 409);
  const paymentAttempts = await Promise.all(['payment-authorized-1', 'payment-authorized-2'].map(key => request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': key }, body: { actionKey: 'payment.send', outcome: 'ok', policyEvaluationId: paymentPolicy.payload.id, actionPayload: paymentPayload } })));
  assert.deepEqual(paymentAttempts.map(result => result.status).sort(), [201, 409]);
  const authorizedPayment = paymentAttempts.find(result => result.status === 201);
  const authorizedPaymentKey = authorizedPayment.payload.action.idempotencyKey;
  assert.equal(authorizedPayment.payload.action.externalRefs.policyEvaluationId, paymentPolicy.payload.id);
  assert.ok(authorizedPayment.payload.action.externalRefs.policyExecutionId);
  const authorizedPaymentReplay = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': authorizedPaymentKey }, body: { actionKey: 'payment.send', outcome: 'ok', policyEvaluationId: paymentPolicy.payload.id, actionPayload: paymentPayload } });
  assert.equal(authorizedPaymentReplay.status, 200);
  assert.equal(authorizedPaymentReplay.payload.replay, true);
  const changedPaymentReplay = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': authorizedPaymentKey }, body: { actionKey: 'payment.send', outcome: 'failed', policyEvaluationId: paymentPolicy.payload.id, actionPayload: paymentPayload } });
  assert.equal(changedPaymentReplay.status, 409);
  const changedPayloadReplay = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': authorizedPaymentKey }, body: { actionKey: 'payment.send', outcome: 'ok', policyEvaluationId: paymentPolicy.payload.id, actionPayload: { ...paymentPayload, amount: { minorUnits: 4999, currency: 'CAD' } } } });
  assert.equal(changedPayloadReplay.status, 409);
  const reusedOneTimePolicy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${paymentCase.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'payment-authorized-3' }, body: { actionKey: 'payment.send', outcome: 'ok', policyEvaluationId: paymentPolicy.payload.id, actionPayload: paymentPayload } });
  assert.equal(reusedOneTimePolicy.status, 409);
  const projectedHumanView = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/human-view`, { token: sessionToken });
  assert.equal(projectedHumanView.status, 200);
  const projectedCase = projectedHumanView.payload.caseQueue.find(item => item.id === caseCreated.payload.id);
  const authoritativeCase = projectedHumanView.payload.cases.find(item => item.id === caseCreated.payload.id);
  assert.equal(projectedCase.state, 'authorized');
  assert.equal(projectedCase.collaborationMode, 'scheduling');
  assert.equal(projectedCase.actingAgent, authoritativeCase.actingAgent);
  assert.deepEqual(projectedCase.participants, authoritativeCase.participants);
  assert.deepEqual(projectedCase.events, authoritativeCase.events);
  assert.equal(projectedCase.stateLabel, 'Authorized');
  assert.equal(projectedCase.bucket, 'activeWork');
  assert.equal(typeof projectedHumanView.payload.navigation.activeWork, 'number');
  assert.deepEqual(projectedHumanView.payload.participantDirectory[enrolled.payload.agent.id], {
    id: enrolled.payload.agent.id,
    type: 'internalAgent',
    displayName: 'Worker',
    address: 'worker@envoi.mail',
    organizationId: workspace.payload.organizationId,
    inboxId: senderInboxId,
    accessState: 'active'
  });
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].type, 'externalAgent');
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].displayName, 'Recipient');
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].address, 'recipient@envoi.mail');
  assert.equal(projectedHumanView.payload.recentEvents.filter(event => event.type === 'policy.re_evaluated' && event.policyEvaluationId === paymentPolicy.payload.id && event.decision === 'allow').length, 1);

  const recipientStream = await fetch(`${server.baseUrl}/api/inboxes/${recipientInboxId}/events`, { headers: { authorization: `Bearer ${recipient.payload.agentApiToken}` } });
  assert.equal(recipientStream.status, 200);
  const recipientReader = recipientStream.body.getReader();
  await recipientReader.read();
  const rejectedRecipient = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/agent-onboarding/${recipient.payload.agent.id}/reject`, { token: sessionToken, body: {} });
  assert.equal(rejectedRecipient.status, 200);
  assert.equal(rejectedRecipient.payload.agent.status, 'rejected');
  const rejectedAgentView = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/agent-view?agentId=${recipient.payload.agent.id}`, { token: sessionToken });
  assert.equal(rejectedAgentView.status, 200);
  assert.deepEqual(rejectedAgentView.payload.capabilities, []);
  assert.equal(await waitForStreamClose(recipientReader), true);
  const rejectedRecipientRead = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/events/delta`, { token: recipient.payload.agentApiToken });
  assert.equal(rejectedRecipientRead.status, 401);
  const rejectedRecipientRefresh = await request(server.baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: recipient.payload.agentRefreshToken, rotationId: 'rotation-rejected-1' } });
  assert.equal(rejectedRecipientRefresh.status, 401);

  const revokedDeliveryId = await queueDelayedMessage('msg_revoked_before_delivery', raceRecipient.payload, 1500);
  const revokedCredentials = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/agents/${enrolled.payload.agent.id}/credentials/revoke`, { token: sessionToken, body: {} });
  assert.equal(revokedCredentials.status, 200);
  assert.ok(revokedCredentials.payload.credentialFamilyCount >= 1);
  await waitFor(async () => (await fixtureStore.getOutbox(revokedDeliveryId))?.status === 'deadLettered');
  const revokedRecipientMessages = await request(server.baseUrl, `/api/inboxes/${raceRecipient.payload.inbox.id}/messages`, { session: raceSession, token: raceVerified.payload.sessionToken });
  assert.equal(revokedRecipientMessages.payload.some(message => message.id === 'msg_revoked_before_delivery'), false);
  const rejectedAfterRevocation = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-revoked' }, body: { ...messageBody, text: 'must not send' } });
  assert.equal(rejectedAfterRevocation.status, 401);

  const logout = await request(server.baseUrl, '/api/auth/logout', { token: sessionToken, body: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  assert.equal(afterLogout.status, 401);
});

test('chosen beta agent addresses are exact, unique, and capped per human', async t => {
  const server = await startServer({ SINALOA_AGENT_DOMAIN: 'agents.envoi-agents.com', SINALOA_ENFORCE_BETA_AGENT_LIMIT: '1' });
  t.after(server.stop);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550991', displayName: 'Address Owner' } });
  const verified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const sessionToken = verified.payload.sessionToken;
  const browserRequest = (pathname, options = {}) => request(server.baseUrl, pathname, { token: sessionToken, ...options });
  const setup = await browserRequest('/api/auth/totp/setup', { body: {} });
  assert.equal(setup.status, 201, JSON.stringify(setup.payload));
  assert.equal((await browserRequest('/api/auth/totp/verify', { body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await browserRequest('/api/inboxes', { body: { name: 'Address workspace' } });
  assert.equal(workspace.status, 201);
  const availabilityPath = `/api/inboxes/${workspace.payload.id}/agent-address-availability?localPart=MiLo`;
  const available = await browserRequest(availabilityPath);
  assert.deepEqual(available.payload, { localPart: 'milo', address: 'milo@agents.envoi-agents.com', available: true });
  assert.equal((await browserRequest(`/api/inboxes/${workspace.payload.id}/agent-address-availability?localPart=admin`)).status, 400);
  const enroll = localPart => browserRequest(`/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, {
    body: { permissions: ['send_agent_messages', 'receive_agent_messages'], agentProfile: { name: 'Milo', localPart } }
  });
  const [firstToken, competingToken] = await Promise.all([enroll('MiLo'), enroll('milo')]);
  assert.equal(firstToken.status, 201);
  assert.equal(competingToken.status, 201);
  const attempts = await Promise.all([firstToken, competingToken].map(item => request(server.baseUrl, '/api/agent-enroll', {
    body: { enrollmentToken: item.payload.enrollmentToken, name: 'Runtime supplied name', slug: 'cannot-override' }
  })));
  assert.deepEqual(attempts.map(item => item.status).sort(), [201, 409]);
  const firstAgent = attempts.find(item => item.status === 201).payload;
  assert.equal(firstAgent.agent.address, 'milo@agents.envoi-agents.com');
  assert.equal((await browserRequest(availabilityPath)).payload.available, false);
  const parent = await browserRequest(`/api/inboxes/${workspace.payload.id}/human-view`);
  assert.ok(parent.payload.recentEvents.some(event => event.type === 'agent.enrollment_redeemed' && event.agentId === firstAgent.agent.id));
  const secondToken = await enroll('mira');
  assert.equal(secondToken.status, 201);
  const secondAgent = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: secondToken.payload.enrollmentToken } });
  assert.equal(secondAgent.status, 201);
  assert.equal(secondAgent.payload.agent.address, 'mira@agents.envoi-agents.com');
  const newDomainMessage = await request(server.baseUrl, `/api/inboxes/${firstAgent.inbox.id}/messages`, {
    token: firstAgent.agentApiToken,
    headers: { 'Idempotency-Key': 'envoi-domain-first-send' },
    body: { senderAgentId: firstAgent.agent.id, recipientEmail: secondAgent.payload.agent.address, text: 'New domain delivery test' }
  });
  assert.equal(newDomainMessage.status, 202);
  assert.equal(newDomainMessage.payload.to[0].address, secondAgent.payload.agent.address);
  const deliveredNewDomainMessage = await waitFor(async () => {
    const messages = await request(server.baseUrl, `/api/inboxes/${secondAgent.payload.inbox.id}/messages`, { token: sessionToken });
    return messages.payload.find(message => message.id === newDomainMessage.payload.id && message.status === 'delivered');
  });
  assert.equal(deliveredNewDomainMessage.from.address, firstAgent.agent.address);
  const retiredAddress = await request(server.baseUrl, `/api/inboxes/${firstAgent.inbox.id}/messages`, {
    token: firstAgent.agentApiToken,
    headers: { 'Idempotency-Key': 'retired-domain-denied' },
    body: { senderAgentId: firstAgent.agent.id, recipientEmail: 'mira@agents.sinaloa-inbox.com', text: 'Old address should not route' }
  });
  assert.equal(retiredAddress.status, 404);
  assert.equal((await enroll('third')).status, 409);
});

test('failed enrollment rolls back token claim and all account records', async t => {
  const oversizedPublicDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}.com`;
  const server = await startServer({
    SINALOA_ENABLE_EXTERNAL_EMAIL: 'true',
    SINALOA_EMAIL_PROVIDER: 'resend',
    SINALOA_PUBLIC_EMAIL_DOMAIN: oversizedPublicDomain,
    SINALOA_EMAIL_DOMAIN_VERIFIED: 'true',
    RESEND_API_KEY: 're_test_atomic_rollback',
    RESEND_WEBHOOK_SECRET: 'whsec_test_atomic_rollback'
  });
  t.after(server.stop);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550999', displayName: 'Rollback Owner' } });
  const verified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const sessionToken = verified.payload.sessionToken;
  const totpSetup = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  const totpVerified = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: generateSync({ secret: totpSetup.payload.secret }) } });
  assert.equal(totpVerified.status, 200);
  const workspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Rollback workspace' } });
  const enrollment = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'], agentProfile: { name: 'Rollback Agent', slug: 'rollback-agent' } } });
  const failed = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken } });
  assert.equal(failed.status, 500);

  const tokenHash = crypto.createHash('sha256').update(enrollment.payload.enrollmentToken).digest('hex');
  const tokenRecord = JSON.parse(await readFile(path.join(server.dataDir, 'auth', 'enrollment-tokens', `${tokenHash}.json`), 'utf8'));
  assert.equal(tokenRecord.usedAt, null);
  const listFiles = directory => readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'identities')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'directory', 'agents')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'directory', 'native-addresses')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'directory', 'email-addresses')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'auth', 'agent-credentials')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'auth', 'agent-refresh-credentials')), []);
  assert.deepEqual(await listFiles(path.join(server.dataDir, 'organizations', workspace.payload.organizationId, 'workspaces')), [`${workspace.payload.id}.json`]);
});
