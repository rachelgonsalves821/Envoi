import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

async function launch(dataDir, environment = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0',
      SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server start timed out: ${stderr}`)); }, 10_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function api(baseUrl, route, { token, session, body, key, headers = {} } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? session.headers(baseUrl, method) : {}),
      ...(key === undefined ? {} : { 'idempotency-key': key }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+1416555${suffix}`, displayName: `Instruction owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Instructions ${suffix}` } });
  assert.equal(workspace.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] } });
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Instruction Agent ${suffix}`, slug: `instructions-${suffix}` } });
  assert.equal(enrolled.status, 201);
  return { session, human: verified.payload.human, ...enrolled.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected native delivery did not appear');
}

async function fixture(context, environment = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-instruction-http-'));
  let server = await launch(dataDir, environment);
  context.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const [peer, own] = await Promise.all([owner(server.baseUrl, '3101'), owner(server.baseUrl, '3102')]);
  const caseId = 'case_human_instruction';
  const sent = await api(server.baseUrl, `/api/inboxes/${peer.inbox.id}/messages`, {
    token: peer.agentApiToken, key: 'native-existing-case',
    body: { senderAgentId: peer.agent.id, recipientEmail: own.agent.address, caseId, type: 'message', text: 'Initial shared case message' }
  });
  assert.equal(sent.status, 202);
  const claim = (body = { acceptHumanInstructions: true }) => api(server.baseUrl, '/api/agent/work/claim', { token: own.agentApiToken, body });
  const native = await eventually(async () => (await claim()).payload.work);
  const settled = await api(server.baseUrl, `/api/agent/work/${native.workId}/complete`, { token: own.agentApiToken, key: 'native-settled', body: { leaseToken: native.leaseToken } });
  assert.equal(settled.status, 201);
  const store = new FileStore(dataDir);
  const instructionRoute = `/api/inboxes/${own.inbox.id}/cases/${caseId}/instructions`;
  return {
    get baseUrl() { return server.baseUrl; }, own, peer, store, caseId, instructionRoute, native,
    send: (text = 'Please ask about Tuesday.', key = 'instruction-one') => api(server.baseUrl, instructionRoute, { session: own.session, key, body: { text } }),
    claim,
    settle: (work, action, key = `settle-${action}`, extra = {}) => api(server.baseUrl, `/api/agent/work/${work.workId}/${action}`, {
      token: own.agentApiToken, key, body: { leaseToken: work.leaseToken, ...extra }
    }),
    reply: (work, text = 'I will ask about Tuesday.', key = 'reply-one', token = own.agentApiToken) => api(server.baseUrl, `/api/agent/instructions/${work.workId}/reply`, {
      token, key, body: { text, leaseToken: work.leaseToken }
    }),
    restart: async () => { await server.stop(); server = await launch(dataDir, environment); }
  };
}

test('legacy claims skip queued human work and still claim native work until explicit human opt-in', async context => {
  const state = await fixture(context);
  const instruction = await state.send();
  assert.equal(instruction.status, 201);
  assert.equal((await state.claim({})).payload.work, null);
  assert.equal((await state.claim({ acceptHumanInstructions: false })).payload.work, null);
  const emptyResponse = await fetch(`${state.baseUrl}/api/agent/work/claim`, {
    method: 'POST', headers: { authorization: `Bearer ${state.own.agentApiToken}` }
  });
  assert.equal(emptyResponse.status, 200);
  assert.equal((await emptyResponse.json()).work, null);
  for (const acceptHumanInstructions of ['true', 1, null, {}, []]) {
    assert.equal((await state.claim({ acceptHumanInstructions })).status, 400);
  }
  for (const body of [null, [], 'invalid']) assert.equal((await state.claim(body)).status, 400);
  const native = await api(state.baseUrl, `/api/inboxes/${state.peer.inbox.id}/messages`, {
    token: state.peer.agentApiToken, key: 'native-after-human', body: {
      senderAgentId: state.peer.agent.id, recipientEmail: state.own.agent.address,
      caseId: state.caseId, type: 'message', text: 'Native work after the queued instruction'
    }
  });
  assert.equal(native.status, 202);
  const nativeWork = await eventually(async () => (await state.claim({})).payload.work);
  assert.equal(nativeWork.workId, native.payload.id);
  assert.equal(nativeWork.message.senderAgentId, state.peer.agent.id);
  assert.equal((await state.settle(nativeWork, 'complete', 'legacy-native-complete')).status, 201);
  const instructionClaimPath = path.join('inboxes', state.own.inbox.id, 'work-claims', `${instruction.payload.id}.json`);
  assert.equal(await state.store.getJson(instructionClaimPath), null);
  assert.equal((await state.store.getJson(path.join('inboxes', state.own.inbox.id, 'messages', `${instruction.payload.id}.json`))).status, 'delivered');
  assert.equal((await state.claim({})).payload.work, null);
  const optedIn = (await state.claim()).payload.work;
  assert.equal(optedIn.workId, instruction.payload.id);
  assert.equal(optedIn.message.kind, 'humanInstruction');
});

test('real instruction route reaches fenced claim, durable own-case reply and completion across restart', async context => {
  const state = await fixture(context);
  const before = await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/cases/${state.caseId}`, { token: state.own.agentApiToken });
  const submissions = await Promise.all([state.send(), state.send()]);
  assert.deepEqual(submissions.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(submissions[0].payload, submissions[1].payload);
  const message = submissions[0].payload;
  assert.equal(message.senderHumanId, state.own.human.id);
  assert.deepEqual(message.from, { humanId: state.own.human.id });
  assert.equal(message.senderAgentId, undefined);
  assert.equal(message.senderInboxId, undefined);
  const work = (await state.claim()).payload.work;
  assert.equal(work.workId, message.id);
  assert.equal(work.message.kind, 'humanInstruction');
  assert.ok(work.leaseToken && Number.isFinite(Date.parse(work.leaseExpiresAt)));
  assert.equal((await state.claim()).payload.work, null);
  const legacy = await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/messages/${message.id}/acknowledgements`, {
    token: state.own.agentApiToken, key: 'legacy-attempt', body: { state: 'processed' }
  });
  assert.equal(legacy.status, 410);
  await state.restart();
  assert.equal((await state.settle(work, 'renew')).status, 200);
  const acknowledged = await state.settle(work, 'acknowledge');
  assert.equal(acknowledged.status, 201);
  assert.equal(acknowledged.payload.receipt.senderHumanId, state.own.human.id);
  assert.equal((await state.settle(work, 'acknowledge')).status, 200);
  assert.equal((await state.reply(work, 'Unauthorized', 'other-agent', state.peer.agentApiToken)).status, 404);
  const reply = await state.reply(work);
  assert.equal(reply.status, 201);
  assert.equal(reply.payload.kind, 'humanInstructionReply');
  assert.equal(reply.payload.senderAgentId, state.own.agent.id);
  assert.equal(reply.payload.recipientHumanId, state.own.human.id);
  assert.equal(reply.payload.recipientAgentId, undefined);
  assert.equal(reply.payload.caseId, state.caseId);
  assert.equal(reply.payload.inReplyTo, message.id);
  assert.deepEqual((await state.reply(work)).payload, reply.payload);
  assert.equal((await state.reply(work, 'Changed text')).status, 409);
  const completed = await state.settle(work, 'complete');
  assert.equal(completed.status, 201);
  assert.equal(completed.payload.status, 'processed');
  assert.equal((await state.settle(work, 'complete')).status, 200);
  assert.equal((await state.reply(work)).status, 200);
  assert.equal((await state.reply(work, 'Too late', 'late-reply')).status, 409);
  assert.equal((await state.claim()).payload.work, null);
  const view = await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/human-view`, { session: state.own.session });
  assert.equal(view.status, 200);
  assert.ok(view.payload.messages.some(item => item.id === message.id && item.status === 'processed'));
  assert.ok(view.payload.messages.some(item => item.id === reply.payload.id && item.text === reply.payload.text));
  const ownCase = await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/cases/${state.caseId}`, { token: state.own.agentApiToken });
  const peerCase = await api(state.baseUrl, `/api/inboxes/${state.peer.inbox.id}/cases/${state.caseId}`, { token: state.peer.agentApiToken });
  assert.deepEqual(ownCase.payload, peerCase.payload);
  assert.equal(ownCase.payload.state, before.payload.state);
  assert.deepEqual(ownCase.payload.authorityRefs, before.payload.authorityRefs);
  assert.deepEqual(ownCase.payload.policyEvaluations, before.payload.policyEvaluations);
  assert.equal((await state.store.listJson('outbox')).length, 1);
  assert.equal((await state.store.listJson(path.join('inboxes', state.peer.inbox.id, 'messages'))).some(item => item.id === reply.payload.id), false);
});

test('HTTP authority, input, case ownership and browser session protections reject invalid instructions', async context => {
  const state = await fixture(context);
  assert.equal((await api(state.baseUrl, state.instructionRoute, { token: state.own.agentApiToken, key: 'agent-spoof', body: { text: 'No human' } })).status, 401);
  assert.equal((await api(state.baseUrl, state.instructionRoute, { session: state.peer.session, key: 'foreign-human', body: { text: 'Other owner' } })).status, 403);
  assert.equal((await api(state.baseUrl, state.instructionRoute, { session: state.own.session, body: { text: 'No key' } })).status, 400);
  for (const body of [{ text: '' }, { text: 'bad\0text' }, { text: 'ok', senderHumanId: state.peer.human.id }, { text: 'ok', recipientAgentId: state.peer.agent.id }]) {
    const result = await api(state.baseUrl, state.instructionRoute, { session: state.own.session, key: 'malformed', body });
    assert.ok([400, 403].includes(result.status));
  }
  assert.equal((await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/cases/case_missing/instructions`, { session: state.own.session, key: 'missing', body: { text: 'Missing case' } })).status, 404);
  assert.equal((await api(state.baseUrl, state.instructionRoute, { session: state.own.session, key: 'account-mismatch', headers: { 'x-envoi-expected-human': state.peer.human.id }, body: { text: 'Wrong displayed account' } })).status, 409);
  assert.equal((await api(state.baseUrl, state.instructionRoute, { session: state.own.session, key: 'csrf', headers: { 'x-sinaloa-csrf': 'wrong' }, body: { text: 'No CSRF' } })).status, 403);
  assert.equal((await state.send()).status, 201);
  assert.equal((await state.send('Changed text')).status, 409);
  const work = (await state.claim()).payload.work;
  assert.equal((await api(state.baseUrl, `/api/agent/instructions/${work.workId}/reply`, { token: state.own.agentApiToken, key: 'missing-fence', body: { text: 'Missing lease' } })).status, 400);
  assert.equal((await state.reply({ ...work, leaseToken: 'wrong-fence' })).status, 409);
  assert.equal((await state.reply(state.native)).status, 404);
});

test('controlled case, permission loss and credential revocation stop claim, reply and settlement', async context => {
  const state = await fixture(context);
  assert.equal((await state.send()).status, 201);
  const work = (await state.claim()).payload.work;
  const membershipPath = path.join('organizations', state.own.inbox.organizationId, 'members', `${state.own.human.id}.json`);
  const membership = await state.store.getJson(membershipPath);
  await state.store.putJson(membershipPath, { ...membership, status: 'removed' });
  assert.equal((await state.reply(work)).status, 403);
  assert.equal((await state.settle(work, 'complete')).status, 403);
  assert.equal((await state.claim()).payload.work, null);
  await state.store.putJson(membershipPath, membership);
  const canonicalPath = path.join('shared-cases', `${state.caseId}.json`);
  const value = await state.store.getJson(canonicalPath);
  await state.store.putJson(canonicalPath, { ...value, state: 'paused' });
  assert.equal((await state.reply(work)).status, 409);
  assert.equal((await state.settle(work, 'complete')).status, 409);
  assert.equal((await state.send('Paused case', 'paused')).status, 409);
  assert.equal((await state.claim()).payload.work, null);
  await state.store.putJson(canonicalPath, value);
  const agentPath = path.join('inboxes', state.own.inbox.id, 'agents', `${state.own.agent.id}.json`);
  const agent = await state.store.getJson(agentPath);
  await state.store.putJson(agentPath, { ...agent, permissions: ['receive_agent_messages'] });
  assert.equal((await state.reply(work)).status, 403);
  assert.equal((await state.send('Receive-only allowed', 'receive-only')).status, 201);
  await state.store.putJson(agentPath, { ...agent, permissions: ['send_agent_messages'] });
  assert.equal((await state.claim()).status, 403);
  assert.equal((await state.reply(work)).status, 403);
  assert.equal((await state.settle(work, 'complete')).status, 403);
  await state.store.putJson(agentPath, agent);
  const revoked = await api(state.baseUrl, `/api/inboxes/${state.own.inbox.id}/agents/${state.own.agent.id}/credentials/revoke`, { session: state.own.session, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await state.claim()).status, 401);
  assert.equal((await state.reply(work)).status, 401);
  assert.equal((await state.settle(work, 'fail', 'revoke-fail', { retryable: false })).status, 401);
  assert.equal((await state.send('Revoked', 'revoked')).status, 403);
  assert.equal((await state.store.getJson(path.join('inboxes', state.own.inbox.id, 'messages', `${work.workId}.json`))).status, 'delivered');
});

test('expired human work fences, retry backoff and permanent failures use existing claim lifecycle', async context => {
  const state = await fixture(context, { SINALOA_AGENT_WORK_MAX_ATTEMPTS: '2', SINALOA_AGENT_WORK_RETRY_BASE_MS: '1000' });
  await state.send();
  const first = (await state.claim()).payload.work;
  const claimPath = path.join('inboxes', state.own.inbox.id, 'work-claims', `${first.workId}.json`);
  const claim = await state.store.getJson(claimPath);
  await state.store.putJson(claimPath, { ...claim, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await state.reply(first)).status, 409);
  const second = (await state.claim()).payload.work;
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal((await state.reply(first)).status, 409);
  const failed = await state.settle(second, 'fail', 'permanent-fail', { retryable: false, reasonCode: 'TEST_FAILURE' });
  assert.equal(failed.status, 200);
  assert.equal(failed.payload.status, 'failed');
  assert.equal((await state.claim()).payload.work, null);
  const receipt = await state.store.getJson(path.join('inboxes', state.own.inbox.id, 'delivery-receipts', `delivery_receipt_${first.workId}_failed.json`));
  assert.equal(receipt.senderHumanId, state.own.human.id);
  assert.equal(receipt.senderAgentId, undefined);
  await state.send('Retry instruction', 'retry-instruction');
  const retryWork = (await state.claim()).payload.work;
  assert.equal((await state.settle(retryWork, 'fail', 'retry', { retryable: true })).payload.status, 'retryable');
  assert.equal((await state.claim()).payload.work, null);
  const retryPath = path.join('inboxes', state.own.inbox.id, 'work-claims', `${retryWork.workId}.json`);
  const retryClaim = await state.store.getJson(retryPath);
  await state.store.putJson(retryPath, { ...retryClaim, retryAt: '2000-01-01T00:00:00.000Z' });
  const lastWork = (await state.claim()).payload.work;
  const lastClaim = await state.store.getJson(retryPath);
  await state.store.putJson(retryPath, { ...lastClaim, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await state.claim()).payload.work, null);
  assert.equal((await state.store.getJson(retryPath)).status, 'failed');
  assert.equal((await state.store.getJson(path.join('inboxes', state.own.inbox.id, 'messages', `${lastWork.workId}.json`))).status, 'failed');
});
