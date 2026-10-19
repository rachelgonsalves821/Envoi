// Case-tools integration: real HTTP, scoped credentials and durable effects on both stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, claim, eventually, launch, owner, ownerEvents, ownerMessages, pauseAgent, revokeAgent, send, waitForMessageStatus, workClaimParts } from './a3-harness.js';
import { documents } from './agent-registration-harness.js';

const contract = JSON.parse(await readFile(new URL('./contract-fixtures/case-tools/schemas.json', import.meta.url)));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(contract);
const backends = [{ name: 'FileStore', env: {}, prefix: '95' }, ...(process.env.DATABASE_URL
  ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, prefix: '96' }] : [])];
const flags = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' };
const resultSchema = name => contract['x-tools'].find(tool => tool.name === name).resultSchema;
function validate(name, value) {
  const check = ajv.getSchema(`${contract.$id}#/definitions/${name}`);
  assert.ok(check, `published ${name} schema`);
  assert.ok(check(value), `${name}: ${ajv.errorsText(check.errors)}\n${JSON.stringify(value)}`);
  return value;
}
async function call(baseUrl, token, name, args = {}) {
  return api(baseUrl, '/mcp', { token,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
}
function envelope(response) {
  assert.equal(response.status, 200, response.text);
  assert.ok(response.payload?.result?.content?.[0]?.text, response.text);
  return JSON.parse(response.payload.result.content[0].text);
}
async function tool(baseUrl, session, name, args = {}) {
  const response = await call(baseUrl, session.token, name, args);
  const body = envelope(response);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(response.payload.result.isError, false);
  assert.equal(body.tool, name);
  return validate(resultSchema(name), body.result);
}
async function toolError(baseUrl, session, name, args, code) {
  const response = await call(baseUrl, session.token, name, args);
  const body = envelope(response);
  assert.equal(response.payload.result.isError, true, response.text);
  assert.equal(body.ok, false);
  assert.equal(body.code, code, response.text);
  assert.equal(body.retryable, contract['x-tool-errors'][code].retryable);
}
const snapshot = (baseUrl, session, args) => tool(baseUrl, session, 'envoi_case_snapshot', args);
async function mint(baseUrl, who, work) {
  const response = await api(baseUrl, `/api/agent/work/${work.workId}/session`, { token: who.agentApiToken, body: { leaseToken: work.leaseToken } });
  assert.equal(response.status, 201, response.text);
  assert.ok(response.payload.session.allowedTools.includes('envoi_case_snapshot'));
  return response.payload.session;
}
async function settle(baseUrl, who, work) {
  const response = await api(baseUrl, `/api/agent/work/${work.workId}/complete`, { token: who.agentApiToken,
    key: `settle-${work.workId}`, body: { leaseToken: work.leaseToken } });
  assert.ok([200, 201].includes(response.status), response.text);
}
async function claimCase(baseUrl, who, caseId, options = {}) {
  return eventually(async () => {
    const response = await claim(baseUrl, who.agentApiToken, options);
    assert.equal(response.status, 200, response.text);
    if (!response.payload.work) return null;
    assert.equal(response.payload.work.message.caseId, caseId, response.text);
    return { ...response.payload.work, caseId };
  }, { message: `claim work in ${caseId}` });
}
async function begin(baseUrl, alice, bob, text = 'Please agree a delivery date.') {
  const sent = await send(baseUrl, alice, bob, { caseId: `case_tools_${crypto.randomBytes(8).toString('hex')}`, text });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  const work = await claimCase(baseUrl, bob, sent.payload.caseId);
  const session = await mint(baseUrl, bob, work);
  return { caseId: sent.payload.caseId, work, session };
}
async function scanner(t) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: Buffer.concat(chunks).toString().includes('infected') ? 'infected' : 'clean', engine: 'case-tools-test' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/scan`;
}

for (const backend of backends) {
  const pair = (baseUrl, number) => {
    // Preserve the original xx10/11 .. xx90/91 identities; added regressions
    // occupy xx12/13, xx22/23, etc. Every phone/slug remains disjoint and four digits.
    const first = number > 9 ? (number - 9) * 10 + 2 : number * 10;
    return Promise.all([owner(baseUrl, `${backend.prefix}${first}`), owner(baseUrl, `${backend.prefix}${first + 1}`)]);
  };
  async function start(t, number, extraEnv = {}) {
    const server = await launch({ ...backend.env, ...flags, ...extraEnv });
    t.after(() => server.stop());
    const [alice, bob] = await pair(server.baseUrl, number);
    return { server, baseUrl: server.baseUrl, alice, bob };
  }
  // A native offer received by Alice, evaluated under the default human-required
  // agreements policy and requested through the scoped tool, without settling yet.
  async function pendingApproval(t, number, extraEnv = {}) {
    const context = await start(t, number, extraEnv);
    const { baseUrl, alice, bob } = context;
    const first = await begin(baseUrl, alice, bob);
    await tool(baseUrl, first.session, 'envoi_case_propose', { text: 'Offer Friday', terms: { day: 'Friday' }, idempotencyKey: 'offer' });
    await settle(baseUrl, bob, first.work);
    const work = await claimCase(baseUrl, alice, first.caseId);
    const session = await mint(baseUrl, alice, work);
    const shown = await snapshot(baseUrl, session);
    const authority = await tool(baseUrl, session, 'envoi_authority_check', { action: 'accept_proposal', proposalRef: shown.proposal.ref,
      optionRef: shown.proposal.options[0].ref, idempotencyKey: 'check' });
    assert.equal(authority.decision, 'needsHuman');
    await tool(baseUrl, session, 'envoi_request_human', { authorityRef: authority.authorityRef, question: 'Approve Friday?', idempotencyKey: 'request' });
    const event = (await ownerEvents(baseUrl, alice)).find(value => value.type === 'case.human_decision_requested' && value.caseId === first.caseId);
    assert.ok(event?.requestId && event.policyEvaluationId, 'canonical owner event identifies its request and evaluation');
    return { ...context, caseId: first.caseId, work, session, shown, authority, requestId: event.requestId, evaluationId: event.policyEvaluationId };
  }

  test(`[${backend.name}] snapshot privacy, scope rejection, reply idempotency and reclaimed replay`, { timeout: 90000 }, async t => {
    const { server, baseUrl, alice, bob } = await start(t, 1);
    const first = await begin(baseUrl, alice, bob, 'First case public request');
    const privateText = `PRIVATE_OWNER_INSTRUCTION_${crypto.randomBytes(10).toString('hex')}`;
    const instruction = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${first.caseId}/instructions`, {
      session: alice.session, key: 'private-owner-instruction', body: { text: privateText, recipientAgentId: alice.agent.id } });
    assert.equal(instruction.status, 201, instruction.text);
    const shown = await snapshot(baseUrl, first.session);
    assert.equal(shown.requestedResponse.text, 'First case public request');
    assert.equal(shown.counterparty.address, alice.agent.address);
    assert.equal(shown.you.address, bob.agent.address);
    assert.ok(shown.recentEvents.some(event => event.ref === shown.requestedResponse.ref && event.text === null));
    const serialized = JSON.stringify(shown);
    for (const secret of [privateText, first.caseId, first.work.workId, first.session.id, alice.human.id, bob.human.id, alice.inbox.id, bob.inbox.id])
      assert.ok(!serialized.includes(secret), `snapshot leaks ${secret}`);
    for (const args of [{ caseId: first.caseId }, { recipientAgentId: alice.agent.id }, { recipientEmail: alice.agent.address }]) {
      const response = await call(baseUrl, first.session.token, 'envoi_case_reply', { text: 'forged', idempotencyKey: 'override', ...args });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.payload.error?.data?.code, 'TOOL_ARGUMENTS_INVALID', response.text);
    }
    const args = { text: 'One durable scoped reply', idempotencyKey: 'reply-one' };
    const sent = await tool(baseUrl, first.session, 'envoi_case_reply', args);
    assert.equal(sent.inReplyTo, shown.requestedResponse.ref);
    assert.deepEqual(sent.recipient, shown.counterparty);
    const replay = await tool(baseUrl, first.session, 'envoi_case_reply', { ...args, intent: 'message', inReplyTo: shown.requestedResponse.ref });
    assert.deepEqual(replay, { ...sent, replayed: true });
    await toolError(baseUrl, first.session, 'envoi_case_reply', { ...args, text: 'conflicting payload' }, 'IDEMPOTENCY_CONFLICT');
    await toolError(baseUrl, first.session, 'envoi_case_reply', { ...args, inReplyTo: 'm_aaaaaaaaaaaaaaaa' }, 'REF_NOT_FOUND');
    assert.deepEqual(await tool(baseUrl, first.session, 'envoi_case_reply', args), { ...sent, replayed: true });
    const store = documents(t, backend, server);
    await store.edit(workClaimParts(bob.inbox.id, first.work.workId), value => ({ ...value, leaseExpiresAt: '2000-01-01T00:00:00.000Z' }));
    const reclaimed = await claimCase(baseUrl, bob, first.caseId);
    const resumed = await mint(baseUrl, bob, reclaimed);
    const resumedSnapshot = await snapshot(baseUrl, resumed);
    assert.equal(resumedSnapshot.requestedResponse.ref, shown.requestedResponse.ref);
    assert.deepEqual(await tool(baseUrl, resumed, 'envoi_case_reply', args), { ...sent, replayed: true });
    assert.equal((await ownerMessages(baseUrl, bob, first.caseId)).filter(message => message.text === args.text).length, 1);
    const second = await begin(baseUrl, alice, bob, 'Second case public request');
    const secondSnapshot = await snapshot(baseUrl, second.session);
    assert.notEqual(secondSnapshot.requestedResponse.ref, shown.requestedResponse.ref);
    assert.ok(!JSON.stringify(secondSnapshot).includes('First case public request'));
    await toolError(baseUrl, second.session, 'envoi_case_reply', { text: 'wrong reference', idempotencyKey: 'cross-case', inReplyTo: shown.requestedResponse.ref }, 'REF_NOT_FOUND');
    const other = await tool(baseUrl, second.session, 'envoi_case_reply', args);
    assert.notEqual(other.messageRef, sent.messageRef, 'idempotency is scoped by work');
  });

  for (const [index, mode, expected] of [[2, 'expiry', 'CASE_SESSION_EXPIRED'], [3, 'pause', 'CASE_SESSION_ENDED'], [4, 'revoke', 'CASE_SESSION_ENDED'], [5, 'fence', 'CASE_SESSION_ENDED']]) {
    test(`[${backend.name}] ${mode} denies a late tool effect without persisting a message`, { timeout: 60000 }, async t => {
      const { server, baseUrl, alice, bob } = await start(t, index);
      const { caseId, work, session } = await begin(baseUrl, alice, bob);
      await snapshot(baseUrl, session);
      const store = documents(t, backend, server);
      const before = (await ownerMessages(baseUrl, bob, caseId)).map(message => message.id).sort();
      if (mode === 'expiry') await store.edit(['inboxes', bob.inbox.id, 'case-sessions', `${session.id}.json`], value => ({ ...value, expiresAt: '2000-01-01T00:00:00.000Z' }));
      if (mode === 'pause') await pauseAgent(baseUrl, bob);
      if (mode === 'revoke') await revokeAgent(baseUrl, bob);
      if (mode === 'fence') await store.edit(workClaimParts(bob.inbox.id, work.workId), value => ({ ...value, fence: value.fence + 1 }));
      const response = await call(baseUrl, session.token, 'envoi_case_reply', { text: `LATE_${mode}`, idempotencyKey: `late-${mode}` });
      assert.equal(response.status, 401, response.text);
      assert.equal(response.payload.code, expected, response.text);
      if (mode !== 'expiry') assert.equal(response.payload.reason, { pause: 'agent_paused', revoke: 'credential_ended', fence: 'lease_lost' }[mode]);
      assert.deepEqual((await ownerMessages(baseUrl, bob, caseId)).map(message => message.id).sort(), before);
      assert.ok(!(await ownerMessages(baseUrl, alice, caseId)).some(message => message.text === `LATE_${mode}`));
    });
  }

  test(`[${backend.name}] proposals counter and reject through each party's distinct references`, { timeout: 90000 }, async t => {
    const { baseUrl, alice, bob } = await start(t, 6);
    const first = await begin(baseUrl, alice, bob);
    await tool(baseUrl, first.session, 'envoi_case_propose', { text: 'Offer Monday', terms: { day: 'Monday' }, idempotencyKey: 'offer' });
    await toolError(baseUrl, first.session, 'envoi_case_propose', { text: 'Duplicate offer', terms: { day: 'Tuesday' }, idempotencyKey: 'offer-two' }, 'PROPOSAL_EXISTS');
    await settle(baseUrl, bob, first.work);
    const aliceWork = await claimCase(baseUrl, alice, first.caseId);
    const aliceSession = await mint(baseUrl, alice, aliceWork);
    const aliceSnapshot = await snapshot(baseUrl, aliceSession);
    assert.equal(aliceSnapshot.proposal.lastActor, 'other_agent');
    const counter = await tool(baseUrl, aliceSession, 'envoi_case_decide', { proposalRef: aliceSnapshot.proposal.ref,
      decision: 'counter', terms: { day: 'Tuesday' }, text: 'Counter Tuesday', idempotencyKey: 'counter' });
    assert.equal(counter.proposalStatus, 'countered');
    const ownCounter = await snapshot(baseUrl, aliceSession);
    assert.equal(ownCounter.proposal.lastActor, 'you');
    assert.deepEqual(ownCounter.proposal.options.map(option => option.value), [{ day: 'Tuesday' }]);
    await settle(baseUrl, alice, aliceWork);
    const bobWork = await claimCase(baseUrl, bob, first.caseId);
    const bobSession = await mint(baseUrl, bob, bobWork);
    const bobSnapshot = await snapshot(baseUrl, bobSession);
    assert.notEqual(bobSnapshot.proposal.ref, aliceSnapshot.proposal.ref);
    assert.equal(bobSnapshot.proposal.lastActor, 'other_agent');
    const rejected = await tool(baseUrl, bobSession, 'envoi_case_decide', { proposalRef: bobSnapshot.proposal.ref,
      decision: 'reject', text: 'Reject Tuesday', idempotencyKey: 'reject' });
    assert.equal(rejected.proposalStatus, 'withdrawn');
    assert.equal((await snapshot(baseUrl, bobSession)).proposal, null);
  });

  test(`[${backend.name}] human approval resumes canonical decision work and guards accept`, { timeout: 90000 }, async t => {
    const scannerUrl = await scanner(t);
    const { baseUrl, alice, bob } = await start(t, 7, { ENVOI_MALWARE_SCANNER_URL: scannerUrl });
    const first = await begin(baseUrl, alice, bob);
    await tool(baseUrl, first.session, 'envoi_case_propose', { text: 'Offer Wednesday', terms: { day: 'Wednesday' }, idempotencyKey: 'offer' });
    await settle(baseUrl, bob, first.work);
    const work = await claimCase(baseUrl, alice, first.caseId);
    const session = await mint(baseUrl, alice, work);
    const shown = await snapshot(baseUrl, session);
    const authority = await tool(baseUrl, session, 'envoi_authority_check', { action: 'accept_proposal', proposalRef: shown.proposal.ref,
      optionRef: shown.proposal.options[0].ref, idempotencyKey: 'check' });
    assert.equal(authority.decision, 'needsHuman');
    const decision = { proposalRef: shown.proposal.ref, optionRef: shown.proposal.options[0].ref, authorityRef: authority.authorityRef,
      decision: 'accept', text: 'Accept Wednesday', idempotencyKey: 'accept' };
    await toolError(baseUrl, session, 'envoi_case_decide', decision, 'AUTHORITY_PENDING');
    const requested = await tool(baseUrl, session, 'envoi_request_human', { authorityRef: authority.authorityRef, question: 'Approve this day?', idempotencyKey: 'request' });
    assert.equal(requested.endTurn, true);
    const pending = await snapshot(baseUrl, session);
    assert.equal(pending.case.status, shown.case.status, 'request does not change shared case state');
    assert.equal(pending.authority.pendingHumanDecision, true);
    assert.ok(!pending.allowedActions.includes('envoi_case_complete'));
    await settle(baseUrl, alice, work);
    const canonical = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${first.caseId}`, { session: alice.session });
    assert.equal(canonical.status, 200, canonical.text);
    const evaluation = canonical.payload.policyEvaluations.findLast(value => value.actor === alice.agent.id && value.requestedAction === 'proposal.accept');
    assert.ok(evaluation, canonical.text);
    const approved = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${first.caseId}/actions`, { session: alice.session,
      key: 'owner-approve', body: { actionKey: 'approveOnce', externalRefs: { policyEvaluationId: evaluation.id } } });
    assert.equal(approved.status, 201, approved.text);
    const resumedWork = await claimCase(baseUrl, alice, first.caseId);
    assert.equal(resumedWork.message.kind, 'humanDecision');
    const resumed = await mint(baseUrl, alice, resumedWork);
    const resumedSnapshot = await snapshot(baseUrl, resumed);
    assert.equal(resumedSnapshot.requestedResponse.kind, 'human_decision');
    assert.equal(resumedSnapshot.requestedResponse.intent, 'approveOnce');
    assert.equal(resumedSnapshot.authority.lastPolicyDecision.humanApproval, 'approved');
    assert.equal(resumedSnapshot.authority.lastPolicyDecision.authorityRef, authority.authorityRef);
    const accepted = await tool(baseUrl, resumed, 'envoi_case_decide', decision);
    assert.equal(accepted.proposalStatus, 'accepted');
    assert.equal(accepted.caseStatus, 'authorized');
    assert.equal((await snapshot(baseUrl, resumed)).proposal, null);
    // The exact authenticated human approval that allowed this agent's accept
    // also allows its completion; it must not invent a second approval request.
    const content = Buffer.from('Approved agreement evidence');
    const reserved = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/asset-uploads`, { token: alice.agentApiToken, key: 'approved-evidence', body: {
      caseId: first.caseId, filename: 'approved.txt', mimeType: 'text/plain', size: content.length,
      checksumSha256: crypto.createHash('sha256').update(content).digest('base64') } });
    assert.equal(reserved.status, 201, reserved.text);
    const uploaded = await fetch(reserved.payload.upload.url, { method: 'PUT', headers: reserved.payload.upload.headers, body: content });
    assert.equal(uploaded.status, 204);
    const scanned = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/assets/${reserved.payload.object.id}/complete`, { token: alice.agentApiToken, body: {} });
    assert.equal(scanned.status, 200, scanned.text);
    const assetRef = (await snapshot(baseUrl, resumed)).assets[0].ref;
    await tool(baseUrl, resumed, 'envoi_case_share_asset', { assetRef, idempotencyKey: 'approved-share' });
    const completed = await tool(baseUrl, resumed, 'envoi_case_complete', { result: 'Approved agreement fulfilled', evidenceRefs: [assetRef], idempotencyKey: 'approved-complete' });
    assert.equal(completed.humanApproval, 'approved');
    const final = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${first.caseId}`, { session: alice.session });
    assert.equal(final.status, 200, final.text);
    assert.equal(final.payload.receipt.authorityBasis, approved.payload.action.id);
    assert.deepEqual(final.payload.receipt.evidenceRefs, [reserved.payload.object.id]);
    const otherView = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${first.caseId}`, { session: bob.session });
    assert.deepEqual(otherView.payload.receipt, final.payload.receipt, 'both owners see the same canonical receipt');
    assert.equal((await ownerEvents(baseUrl, alice)).filter(event => event.type === 'case.human_decision_requested' && event.caseId === first.caseId).length, 1);
  });

  test(`[${backend.name}] scanned asset sharing and completion preserve grants and work settlement`, { timeout: 90000 }, async t => {
    const scannerUrl = await scanner(t);
    const { baseUrl, alice, bob } = await start(t, 8, { ENVOI_MALWARE_SCANNER_URL: scannerUrl });
    const first = await begin(baseUrl, alice, bob);
    const content = Buffer.from('Canonical evidence document');
    const started = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/asset-uploads`, { token: bob.agentApiToken, key: 'reserve-evidence', body: {
      caseId: first.caseId, filename: 'evidence.txt', mimeType: 'text/plain', size: content.length,
      checksumSha256: crypto.createHash('sha256').update(content).digest('base64') } });
    assert.equal(started.status, 201, started.text);
    const pending = await snapshot(baseUrl, first.session);
    assert.equal(pending.assets.length, 1);
    assert.equal(pending.assets[0].scan, 'pending');
    const assetRef = pending.assets[0].ref;
    await toolError(baseUrl, first.session, 'envoi_case_share_asset', { assetRef, idempotencyKey: 'pending-share' }, 'ASSET_NOT_CLEAN');
    await toolError(baseUrl, first.session, 'envoi_case_list_assets', { assetRef, includeContent: true }, 'ASSET_NOT_CLEAN');
    const uploaded = await fetch(started.payload.upload.url, { method: 'PUT', headers: started.payload.upload.headers, body: content });
    assert.equal(uploaded.status, 204);
    const scanned = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/assets/${started.payload.object.id}/complete`, { token: bob.agentApiToken, body: {} });
    assert.equal(scanned.status, 200, scanned.text);
    assert.equal(scanned.payload.state, 'clean');
    const read = await tool(baseUrl, first.session, 'envoi_case_list_assets', { assetRef, includeContent: true });
    assert.equal(read.content.text, content.toString());
    assert.equal(read.asset.checksumSha256, started.payload.object.checksumSha256);
    assert.ok(!JSON.stringify(read).includes(started.payload.upload.url));
    await toolError(baseUrl, first.session, 'envoi_case_complete', { result: 'Delivered evidence', evidenceRefs: [assetRef], idempotencyKey: 'unshared-complete' }, 'EVIDENCE_NOT_SHARED');
    const shared = await tool(baseUrl, first.session, 'envoi_case_share_asset', { assetRef, idempotencyKey: 'share' });
    assert.equal(shared.alreadyShared, false);
    assert.equal((await snapshot(baseUrl, first.session)).assets[0].shared, true);
    const complete = await tool(baseUrl, first.session, 'envoi_case_complete', { result: 'Delivered evidence', evidenceRefs: [assetRef], idempotencyKey: 'complete' });
    assert.equal(complete.caseStatus, 'completed');
    const closed = await snapshot(baseUrl, first.session);
    assert.equal(closed.case.status, 'completed');
    assert.deepEqual(closed.allowedActions, ['envoi_case_snapshot', 'envoi_case_list_assets']);
    assert.ok(closed.recentEvents.some(event => event.kind === 'receipt' && event.ref === complete.receiptRef));
    const currentWork = (await ownerMessages(baseUrl, bob, first.caseId)).find(message => message.id === first.work.workId);
    assert.notEqual(currentWork.status, 'processed', 'case outcome does not settle work');
    assert.deepEqual(await tool(baseUrl, first.session, 'envoi_case_complete', { result: 'Delivered evidence', evidenceRefs: [assetRef], idempotencyKey: 'complete' }), { ...complete, replayed: true });
    await toolError(baseUrl, first.session, 'envoi_case_reply', { text: 'late closed reply', idempotencyKey: 'closed' }, 'CASE_CLOSED');
    await settle(baseUrl, bob, first.work);
  });

  test(`[${backend.name}] own human instructions mint a human-scoped snapshot and reply`, { timeout: 60000 }, async t => {
    const { baseUrl, alice, bob } = await start(t, 9);
    const first = await begin(baseUrl, alice, bob);
    await settle(baseUrl, bob, first.work);
    const issued = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${first.caseId}/instructions`, { session: bob.session,
      key: 'own-instruction', body: { text: 'Summarize this case for me.', recipientAgentId: bob.agent.id } });
    assert.equal(issued.status, 201, issued.text);
    const work = await claimCase(baseUrl, bob, first.caseId, { acceptHumanInstructions: true });
    const session = await mint(baseUrl, bob, work);
    const shown = await snapshot(baseUrl, session);
    assert.deepEqual(shown.counterparty, { kind: 'human' });
    assert.equal(shown.requestedResponse.kind, 'instruction');
    assert.equal(shown.requestedResponse.intent, null);
    await toolError(baseUrl, session, 'envoi_case_reply', { text: 'Invalid clarify', intent: 'clarify', idempotencyKey: 'bad-instruction' }, 'NOT_SUPPORTED_FOR_WORK');
    const reply = await tool(baseUrl, session, 'envoi_case_reply', { text: 'Here is your case summary.', idempotencyKey: 'instruction-reply' });
    assert.equal(reply.status, 'delivered');
    assert.deepEqual(reply.recipient, { kind: 'human' });
    await toolError(baseUrl, session, 'envoi_case_reply', { text: 'Here is your case summary.', intent: 'clarify', idempotencyKey: 'instruction-reply' }, 'NOT_SUPPORTED_FOR_WORK');
    assert.ok(!(await ownerMessages(baseUrl, alice, first.caseId)).some(message => message.text === 'Here is your case summary.'));
  });

  test(`[${backend.name}] counterparty humans cannot approve another workspace's pending authority`, { timeout: 90000 }, async t => {
    const { baseUrl, alice, bob, caseId, session, shown, evaluationId } = await pendingApproval(t, 10);
    const actionRoute = `/api/inboxes/${bob.inbox.id}/cases/${caseId}/actions`;
    const ordinary = await api(baseUrl, actionRoute, { session: bob.session, key: 'foreign-ordinary', body: {
      actionKey: 'approveOnce', externalRefs: { policyEvaluationId: evaluationId } } });
    assert.ok([403, 409].includes(ordinary.status), ordinary.text);
    // Exercise the real legacy completion approval branch in a state where its
    // state/result checks pass, so workspace isolation must do the rejection.
    const waiting = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { token: alice.agentApiToken,
      key: 'legacy-review-state', body: { actionKey: 'case.note', outcome: 'ok', nextState: 'waitingForHuman' } });
    assert.equal(waiting.status, 201, waiting.text);
    const legacy = await api(baseUrl, actionRoute, { session: bob.session, key: 'foreign-legacy', body: {
      actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: 'Forged approval', policyEvaluationId: evaluationId } } });
    assert.ok([403, 409].includes(legacy.status), legacy.text);
    const after = await snapshot(baseUrl, session);
    assert.equal(after.authority.lastPolicyDecision.humanApproval, 'pending');
    assert.equal(after.authority.pendingHumanDecision, true);
    assert.equal(after.proposal.ref, shown.proposal.ref);
    assert.ok(!(await ownerMessages(baseUrl, alice, caseId)).some(message => message.kind === 'humanDecision'));
  });

  test(`[${backend.name}] a declined request creates one decision work item and leaves the case open`, { timeout: 90000 }, async t => {
    const { baseUrl, alice, bob, caseId, work, session, shown, evaluationId } = await pendingApproval(t, 11);
    await settle(baseUrl, alice, work);
    const args = { actionKey: 'decline', externalRefs: { policyEvaluationId: evaluationId } };
    const declined = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'owner-decline', body: args });
    assert.equal(declined.status, 201, declined.text);
    const replay = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'owner-decline', body: args });
    assert.equal(replay.status, 200, replay.text);
    const resumedWork = await claimCase(baseUrl, alice, caseId);
    assert.equal(resumedWork.message.kind, 'humanDecision');
    assert.equal(resumedWork.message.outcome, 'declined');
    const resumed = await mint(baseUrl, alice, resumedWork);
    const after = await snapshot(baseUrl, resumed);
    assert.equal(after.requestedResponse.intent, 'decline');
    assert.equal(after.case.status, shown.case.status);
    assert.equal(after.authority.pendingHumanDecision, false);
    assert.equal(after.authority.lastPolicyDecision.humanApproval, 'pending');
    assert.equal((await ownerMessages(baseUrl, alice, caseId)).filter(message => message.kind === 'humanDecision').length, 1);
    const counterpart = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${caseId}`, { session: bob.session });
    assert.equal(counterpart.payload.state, shown.case.status, 'decline never revokes the shared case');
    const ended = await call(baseUrl, session.token, 'envoi_case_reply', { text: 'Stale decision turn', idempotencyKey: 'old-turn' });
    assert.equal(ended.payload.code, 'CASE_SESSION_ENDED');
  });

  test(`[${backend.name}] cleanup expires a request exactly once without changing the signed binding`, { timeout: 90000 }, async t => {
    const { server, baseUrl, alice, caseId, work, shown, requestId, evaluationId } = await pendingApproval(t, 12,
      { ENVOI_HUMAN_DECISION_CLEANUP_INTERVAL_MS: '100' });
    await settle(baseUrl, alice, work);
    const store = documents(t, backend, server);
    const requestPath = ['inboxes', alice.inbox.id, 'case-human-requests', `${requestId}.json`];
    const bindingPath = ['inboxes', alice.inbox.id, 'policy-bindings', `${evaluationId}.json`];
    const signedBinding = await store.get(bindingPath);
    await store.edit(requestPath, request => ({ ...request, expiresAt: '2000-01-01T00:00:00.000Z' }));
    await eventually(async () => (await store.get(requestPath))?.status === 'expired', { message: 'cleanup resolves expired human request' });
    const resumedWork = await claimCase(baseUrl, alice, caseId);
    assert.equal(resumedWork.message.kind, 'humanDecision');
    assert.equal(resumedWork.message.outcome, 'expired');
    const resumed = await mint(baseUrl, alice, resumedWork);
    const after = await snapshot(baseUrl, resumed);
    assert.equal(after.requestedResponse.intent, 'expired');
    assert.equal(after.authority.pendingHumanDecision, false);
    assert.equal(after.case.status, shown.case.status);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await ownerMessages(baseUrl, alice, caseId)).filter(message => message.kind === 'humanDecision' && message.requestId === requestId).length, 1);
    assert.equal((await ownerEvents(baseUrl, alice)).filter(event => event.type === 'case.human_decision_resolved' && event.requestId === requestId).length, 1);
    assert.deepEqual(await store.get(bindingPath), signedBinding, 'expiry never edits the signed authority binding');
  });

  test(`[${backend.name}] policy changes invalidate approved authority before any accept effect`, { timeout: 90000 }, async t => {
    const { server, baseUrl, alice, caseId, work, shown, authority, evaluationId } = await pendingApproval(t, 13);
    await settle(baseUrl, alice, work);
    const approval = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session,
      key: 'owner-approve', body: { actionKey: 'approveOnce', externalRefs: { policyEvaluationId: evaluationId } } });
    assert.equal(approval.status, 201, approval.text);
    const resumedWork = await claimCase(baseUrl, alice, caseId);
    const resumed = await mint(baseUrl, alice, resumedWork);
    const store = documents(t, backend, server);
    await store.put(['inboxes', alice.inbox.id, 'policies', 'active.json'], { agreements: { requireHumanApproval: false } });
    const before = (await ownerMessages(baseUrl, alice, caseId)).map(message => message.id).sort();
    const executionPath = ['inboxes', alice.inbox.id, 'policy-executions', `${evaluationId}.json`];
    assert.equal(await store.get(executionPath), null);
    await toolError(baseUrl, resumed, 'envoi_case_decide', { proposalRef: shown.proposal.ref, optionRef: shown.proposal.options[0].ref,
      authorityRef: authority.authorityRef, decision: 'accept', text: 'Must reject stale policy authority', idempotencyKey: 'changed-policy-accept' }, 'AUTHORITY_CHANGED');
    assert.deepEqual((await ownerMessages(baseUrl, alice, caseId)).map(message => message.id).sort(), before);
    assert.equal(await store.get(executionPath), null, 'refused accept never consumes authority');
    const after = await snapshot(baseUrl, resumed);
    assert.equal(after.proposal.status, 'open');
    assert.equal(after.proposal.lastActor, 'other_agent');
  });
}
