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
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir },
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

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165551${suffix}`, displayName: `Owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Workspace ${suffix}` } });
  assert.equal(workspace.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] } });
  assert.equal(enrollment.status, 201);
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Agent ${suffix}`, slug: `case-${suffix}` } });
  assert.equal(enrolled.status, 201);
  return { session, human: verified.payload.human, ...enrolled.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected case delivery did not become visible');
}

test('two independent owners share ordered typed cases without cross-case or authority leakage', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-shared-case-'));
  let server = await launch(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([owner(baseUrl, '2101'), owner(baseUrl, '2102'), owner(baseUrl, '2103')]);
  assert.notEqual(alice.human.id, bob.human.id);
  assert.notEqual(alice.agent.id, bob.agent.id);
  assert.notEqual(alice.inbox.id, bob.inbox.id);
  const send = (who, recipient, caseId, type, intent, text, payload, key, authority) => api(baseUrl, `/api/inboxes/${who.inbox.id}/messages`, {
    token: who.agentApiToken, key,
    body: { senderAgentId: who.agent.id, recipientEmail: recipient.agent.address, caseId, type, intent, text, payload, ...(authority ? { authority } : {}) }
  });
  const read = (who, caseId) => api(baseUrl, `/api/inboxes/${who.inbox.id}/cases/${caseId}`, { token: who.agentApiToken });
  const [a1, b1] = await Promise.all([
    send(alice, bob, 'case_beta_A', 'request', 'request', 'Review answer A', { request: { question: 'Which answer?' } }, 'a-request-1'),
    send(alice, bob, 'case_beta_B', 'request', 'request', 'Review answer B', { request: { question: 'Which evidence?' } }, 'b-request-1')
  ]);
  assert.equal(a1.status, 202, JSON.stringify(a1.payload));
  assert.equal(b1.status, 202, JSON.stringify(b1.payload));
  assert.notEqual(a1.payload.caseId, b1.payload.caseId);
  await eventually(async () => (await read(bob, 'case_beta_A')).status === 200 && (await read(bob, 'case_beta_B')).status === 200);
  const injection = await send(outsider, bob, 'case_beta_A', 'request', 'request', 'Inject', {}, 'x-inject');
  assert.equal(injection.status, 403);
  assert.equal(injection.payload.error, 'CASE_PARTICIPANT_MISMATCH');
  const spoof = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: alice.agentApiToken, key: 'spoof', body: { senderAgentId: bob.agent.id, recipientEmail: bob.agent.address, caseId: 'case_beta_A', text: 'Spoof' } });
  assert.ok([401, 403].includes(spoof.status));
  const [b2, a2] = await Promise.all([
    send(bob, alice, 'case_beta_B', 'status', 'status', 'Collecting evidence', { progress: 'collecting' }, 'b-status-2'),
    send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Propose 42', { proposal: { answer: '42' } }, 'a-proposal-2')
  ]);
  assert.equal(b2.status, 202, JSON.stringify(b2.payload));
  assert.equal(a2.status, 202, JSON.stringify(a2.payload));
  const replay = await send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Propose 42', { proposal: { answer: '42' } }, 'a-proposal-2');
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.id, a2.payload.id);
  const conflict = await send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Changed', { proposal: { answer: '42' } }, 'a-proposal-2');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.error, 'IDEMPOTENCY_CONFLICT');
  const a3 = await send(bob, alice, 'case_beta_A', 'counterproposal', 'counteroffer', 'Use 43', { counterproposal: { proposalMessageId: a2.payload.id, answer: '43' } }, 'a-counter-3');
  assert.equal(a3.status, 202, JSON.stringify(a3.payload));
  const a4 = await send(alice, bob, 'case_beta_A', 'decision', 'accept', 'Accept for review', { decision: { kind: 'accept', proposalMessageId: a3.payload.id } }, 'a-decision-4', { claimedByAgent: true, humanApproval: 'approved' });
  assert.equal(a4.status, 202, JSON.stringify(a4.payload));
  const pending = (await read(alice, 'case_beta_A')).payload;
  assert.equal(pending.state, 'waitingForHuman');
  assert.equal(pending.receipt, null);
  assert.equal(pending.events.find(event => event.id === `evt_${a4.payload.id}`).payload.verifiedHumanApproval, false);
  assert.equal(a4.payload.authority.humanApproval, 'notRequired');
  const forgedCompletion = await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Forged', { completion: { result: '43', authorityBasis: 'action_forged' } }, 'forged-completion', { humanApproval: 'approved' });
  assert.equal(forgedCompletion.status, 409);
  const forgedAction = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A/actions`, { token: alice.agentApiToken, key: 'agent-forged-approval', body: { actionKey: 'approveOnce', outcome: 'ok', nextState: 'authorized', externalRefs: { requestedAction: 'case.complete', result: '43', serverAuthenticatedHuman: true } } });
  assert.ok([403, 409].includes(forgedAction.status));
  const forgedReceipt = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A/receipt`, { token: alice.agentApiToken, body: { result: '43', authorityBasis: 'action_forged', humanApprovalStatus: 'approved' } });
  assert.equal(forgedReceipt.status, 409);
  const approval = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/case_beta_A/actions`, { session: bob.session, key: 'human-approve-a-1', body: { actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: '43' }, reasonCode: 'reviewed' } });
  assert.equal(approval.status, 201, JSON.stringify(approval.payload));
  assert.equal(approval.payload.action.actor, bob.human.id);
  assert.equal(approval.payload.case.state, 'authorized');
  const completion = await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Joint answer 43 complete', { completion: { result: '43', authorityBasis: approval.payload.action.id } }, 'a-complete-5');
  assert.equal(completion.status, 202, JSON.stringify(completion.payload));
  assert.equal((await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Joint answer 43 complete', { completion: { result: '43', authorityBasis: approval.payload.action.id } }, 'a-complete-5')).payload.id, completion.payload.id);
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${alice.inbox.id}/delivery-receipts`, { token: alice.agentApiToken })).payload.some(item => item.messageId === completion.payload.id && item.state === 'delivered'));
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/delivery-receipts`, { token: bob.agentApiToken })).payload.some(item => item.messageId === a1.payload.id && item.state === 'delivered'));
  const claimed = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.payload.work.workId, a1.payload.id);
  const processed = await api(baseUrl, `/api/agent/work/${a1.payload.id}/complete`, { token: bob.agentApiToken, key: 'process-a1', body: { leaseToken: claimed.payload.work.leaseToken } });
  assert.equal(processed.status, 201, JSON.stringify(processed.payload));
  assert.equal((await api(baseUrl, `/api/agent/work/${a1.payload.id}/complete`, { token: bob.agentApiToken, key: 'process-a1', body: { leaseToken: claimed.payload.work.leaseToken } })).status, 200);
  const a = (await read(alice, 'case_beta_A')).payload;
  const aOther = (await read(bob, 'case_beta_A')).payload;
  const b = (await read(alice, 'case_beta_B')).payload;
  assert.deepEqual(aOther, a);
  assert.equal(a.state, 'completed');
  assert.equal(a.receipt.result, '43');
  assert.equal(a.receipt.humanApprovalStatus, 'approved');
  assert.equal(a.receipt.authorityBasis, approval.payload.action.id);
  assert.equal(a.proposals.length, 1);
  assert.equal(a.proposals[0].status, 'accepted');
  assert.equal(a.proposals[0].options.length, 2);
  assert.equal(a.proposals[0].options[0].expired, true);
  assert.equal(a.proposals[0].options[1].value.answer, '43');
  assert.equal(b.state, 'inProgress');
  assert.equal(b.receipt, null);
  assert.deepEqual((await read(bob, 'case_beta_B')).payload, b);
  assert.deepEqual(a.events.filter(event => event.payload.messageId).map(event => event.payload.messageId), [a1.payload.id, a2.payload.id, a3.payload.id, a4.payload.id, completion.payload.id]);
  assert.deepEqual(b.events.filter(event => event.payload.messageId).map(event => event.payload.messageId), [b1.payload.id, b2.payload.id]);
  for (let index = 1; index < a.events.length; index += 1) assert.equal(a.events[index].precedingEventRef, a.events[index - 1].id);
  assert.equal(a.events.filter(event => event.id === `evt_${a2.payload.id}`).length, 1);
  for (const who of [alice, bob]) {
    const view = await api(baseUrl, `/api/inboxes/${who.inbox.id}/human-view`, { session: who.session });
    assert.equal(view.status, 200);
    assert.deepEqual(view.payload.cases.find(item => item.id === 'case_beta_A'), a);
    assert.deepEqual(view.payload.cases.find(item => item.id === 'case_beta_B'), b);
    const receipts = await api(baseUrl, `/api/inboxes/${who.inbox.id}/delivery-receipts`, { token: who.agentApiToken });
    assert.equal(receipts.payload.filter(item => item.messageId === a1.payload.id && item.state === 'processed').length, 1);
  }
  await server.stop();
  server = await launch(dataDir);
  assert.deepEqual((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A`, { token: alice.agentApiToken })).payload, (await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/cases/case_beta_A`, { token: bob.agentApiToken })).payload);
  assert.equal((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A`, { token: alice.agentApiToken })).payload.receipt.id, a.receipt.id);
});
