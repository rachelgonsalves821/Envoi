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

async function waitFor(check, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for asynchronous delivery');
}

test('verified human issues a single-use permissioned agent enrollment', async t => {
  const server = await startServer();
  t.after(server.stop);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  assert.equal(started.status, 201);
  const throttled = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Owner' } });
  assert.equal(throttled.status, 429);
  const verified = await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const sessionToken = verified.payload.sessionToken;
  const phoneOnlyWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Denied' } });
  assert.equal(phoneOnlyWorkspace.status, 401);
  const totpSetup = await request(server.baseUrl, '/api/auth/totp/setup', { token: sessionToken, body: {} });
  assert.equal(totpSetup.status, 201);
  const totpCode = generateSync({ secret: totpSetup.payload.secret });
  const totpVerified = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: totpCode } });
  assert.equal(totpVerified.status, 200);
  assert.equal(totpVerified.payload.assurance, 'mfa');
  const replayedTotp = await request(server.baseUrl, '/api/auth/totp/verify', { token: sessionToken, body: { code: totpCode } });
  assert.equal(replayedTotp.status, 401);
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
  const tokenResponse = await request(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  assert.equal(tokenResponse.status, 201);
  const enrolled = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Worker', slug: 'worker' } });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.payload.agent.address, 'worker@sinaloa.mail');
  assert.ok(enrolled.payload.agentApiToken.startsWith('sinaloa_agent_'));
  assert.equal('credentialHash' in enrolled.payload.agent, false);
  const senderInboxId = enrolled.payload.inbox.id;
  assert.notEqual(senderInboxId, workspace.payload.id);
  assert.equal(enrolled.payload.inbox.ownerAgentId, enrolled.payload.agent.id);
  const reused = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: tokenResponse.payload.enrollmentToken, name: 'Replay' } });
  assert.equal(reused.status, 401);
  const recipientWorkspace = await request(server.baseUrl, '/api/inboxes', { token: sessionToken, body: { name: 'Recipient workspace' } });
  const recipientToken = await request(server.baseUrl, `/api/inboxes/${recipientWorkspace.payload.id}/agent-enrollment-tokens`, { token: sessionToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
  const recipient = await request(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: recipientToken.payload.enrollmentToken, name: 'Recipient', slug: 'recipient' } });
  const recipientInboxId = recipient.payload.inbox.id;
  assert.notEqual(recipientInboxId, recipientWorkspace.payload.id);
  const spoofed = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { headers: { 'Idempotency-Key': 'spoof-1' }, body: { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, text: 'spoof' } });
  assert.equal(spoofed.status, 401);
  const messageBody = { senderAgentId: enrolled.payload.agent.id, recipientAgentId: recipient.payload.agent.id, text: 'authenticated cross-inbox message' };
  const sent = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-1' }, body: messageBody });
  assert.equal(sent.status, 202);
  assert.equal(sent.payload.status, 'queued');
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
  const visible = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
  assert.equal(visible.status, 200);
  assert.equal(visible.payload.length, 1);
  assert.equal(visible.payload[0].id, sent.payload.id);
  assert.equal(visible.payload[0].status, 'delivered');
  const acknowledged = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages/${sent.payload.id}/acknowledgements`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'ack-message-1' }, body: { state: 'acknowledged' } });
  assert.equal(acknowledged.status, 201);
  assert.equal(acknowledged.payload.state, 'acknowledged');
  const acknowledgedReplay = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages/${sent.payload.id}/acknowledgements`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'ack-message-1' }, body: { state: 'acknowledged' } });
  assert.equal(acknowledgedReplay.status, 200);
  const processed = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages/${sent.payload.id}/acknowledgements`, { token: recipient.payload.agentApiToken, headers: { 'Idempotency-Key': 'processed-message-1' }, body: { state: 'processed' } });
  assert.equal(processed.status, 201);
  assert.equal(processed.payload.state, 'processed');
  const receipts = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/delivery-receipts`, { token: sessionToken });
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'delivered'));
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'acknowledged'));
  assert.ok(receipts.payload.some(receipt => receipt.messageId === sent.payload.id && receipt.state === 'processed'));
  const deliveries = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/deliveries`, { token: sessionToken });
  assert.ok(deliveries.payload.some(delivery => delivery.messageId === sent.payload.id && delivery.status === 'delivered'));
  const second = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/messages`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'message-2' }, body: { ...messageBody, text: 'second message' } });
  assert.equal(second.status, 202);
  await waitFor(async () => {
    const response = await request(server.baseUrl, `/api/inboxes/${recipientInboxId}/messages`, { token: sessionToken });
    return response.payload.find(item => item.id === second.payload.id && item.status === 'delivered');
  });
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

  const caseCreated = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases`, { token: enrolled.payload.agentApiToken, body: { objective: 'Schedule Q4 planning with Acme', collaborationMode: 'scheduling', participants: [recipient.payload.agent.id], constraints: { workingHoursEnd: '16:00', timezone: 'America/Toronto' }, deadline: '2026-10-03T03:59:00.000Z' } });
  assert.equal(caseCreated.status, 201);
  assert.equal(caseCreated.payload.schemaVersion, '1.0');
  const progress = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/actions`, { token: enrolled.payload.agentApiToken, headers: { 'Idempotency-Key': 'case-progress-1' }, body: { actionKey: 'case.classify', outcome: 'ok', nextState: 'inProgress' } });
  assert.equal(progress.status, 201);
  assert.equal(progress.payload.case.state, 'inProgress');
  const proposal = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/proposals`, { token: enrolled.payload.agentApiToken, body: { kind: 'schedule', expiresAt: '2026-10-01T21:00:00.000Z', options: [{ id: 'option_1630', value: { start: '2026-10-01T20:30:00.000Z', end: '2026-10-01T21:00:00.000Z', timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', outOfPolicyFlags: ['outsideWorkingHours'] }] } });
  assert.equal(proposal.status, 201);
  const policy = await request(server.baseUrl, `/api/inboxes/${senderInboxId}/cases/${caseCreated.payload.id}/policy-evaluations`, { token: enrolled.payload.agentApiToken, body: { requestedAction: 'calendar.confirmMeeting', reasonCode: 'outsidePreferredWorkingHours', outOfPolicyFlags: ['outsideWorkingHours'], expiresAt: '2026-10-01T21:00:00.000Z' } });
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
    address: 'worker@sinaloa.mail',
    organizationId: workspace.payload.organizationId,
    inboxId: senderInboxId,
    accessState: 'active'
  });
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].type, 'externalAgent');
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].displayName, 'Recipient');
  assert.equal(projectedHumanView.payload.participantDirectory[recipient.payload.agent.id].address, 'recipient@sinaloa.mail');

  const logout = await request(server.baseUrl, '/api/auth/logout', { token: sessionToken, body: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await request(server.baseUrl, '/api/auth/me', { token: sessionToken });
  assert.equal(afterLogout.status, 401);
});
