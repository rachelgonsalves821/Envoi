// C-A1: the case-session v1 server (docs/architecture/agent-native-v2/handoffs.md#case-session-v1),
// checked against the contract's codes and schemas. Runs on FileStore, and on PostgreSQL when
// DATABASE_URL is set (CI test:postgres). C-A1 implements no case tool yet, so every session carries
// an empty tool set (§6.4); the tool fixtures are checked in-process in case-session-mcp.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, claim, eventually, launch, newRotationId, owner, ownerEvents, pauseAgent, refresh, resumeAgent, revokeAgent, send, sha256, waitForMessageStatus, workClaimParts } from './a3-harness.js';
import { documents } from './agent-registration-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'case-session', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const xCodes = schemas['x-codes'];
const ttlMs = schemas['x-limits'].sessionTtlSeconds * 1000;

function assertSchema(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schema ${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}
function assertCode(res, code, extra = {}) {
  assert.equal(res.payload?.code, code, `expected ${code}; got HTTP ${res.status} ${res.text?.slice(0, 400)}`);
  assert.equal(res.status, xCodes[code].status, `${code} uses HTTP ${xCodes[code].status}`);
  assertSchema('errorEnvelope', res.payload);
  for (const [field, value] of Object.entries(extra)) assert.deepEqual(res.payload[field], value, `${code}.${field}`);
  return res.payload;
}
// The schema needs envoi_case_snapshot in every session; C-A1 implements no tool, so the set is
// checked to be exactly the empty implemented subset and the rest of the body against the schema.
// The test server has no https public origin, so the transport URL is checked against its own.
function assertSessionCreated(res, baseUrl) {
  assert.equal(res.status, 201, res.text);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.payload.session.allowedTools, [], 'only implemented tools are carried (§6.4)');
  assert.equal(res.payload.session.transport.url, `${baseUrl}/mcp`);
  assertSchema('sessionCreated', { ...res.payload, session: { ...res.payload.session, allowedTools: ['envoi_case_snapshot'], transport: { ...res.payload.session.transport, url: 'https://envoi.example/mcp' } } });
  return res.payload;
}

const sessionsOn = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' };
// Owner phone suffixes must be unique across every PostgreSQL test file, which share one database
// (agent-activation uses 81 and 82).
const backends = [{ name: 'FileStore', env: {}, suffix: '91' }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, suffix: '92' }] : [])];

const sessionRoute = workId => `/api/agent/work/${workId}/session`;
const mint = (baseUrl, who, workId, leaseToken, token = who.agentApiToken) => api(baseUrl, sessionRoute(workId), { token, body: { leaseToken } });
const end = (baseUrl, who, workId, leaseToken, sessionId) => api(baseUrl, `${sessionRoute(workId)}/end`, { token: who.agentApiToken, body: { leaseToken, sessionId } });
async function mcp(baseUrl, token, method, params = {}, { httpMethod = 'POST', id = 1 } = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: httpMethod,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: httpMethod === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id, method, params }) : undefined
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, headers: response.headers, payload, text };
}
const initialize = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'case-session-test', version: '1.0' } };
function assertEnded(res, reason) {
  assertCode(res, 'CASE_SESSION_ENDED', { reason });
  assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="Envoi agent MCP", error="invalid_token"');
}
const sessionParts = (inboxId, sessionId) => ['inboxes', inboxId, 'case-sessions', `${sessionId}.json`];

// A delivered message from alice to bob, claimed by bob.
async function claimedWork(baseUrl, alice, bob, label) {
  const sent = await send(baseUrl, alice, bob, { caseId: `case_cs_${label}_${crypto.randomBytes(4).toString('hex')}` });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  const claimed = await claim(baseUrl, bob.agentApiToken);
  assert.equal(claimed.payload.work?.workId, sent.payload.id, claimed.text);
  return { ...claimed.payload.work, caseId: sent.payload.caseId };
}

test('case sessions require installations, and fail closed at startup', async () => {
  await assert.rejects(launch({ ENVOI_CASE_SESSIONS_V1: 'true' }), /ENVOI_CASE_SESSIONS_V1 requires ENVOI_INSTALLATIONS_V2/);
});

for (const backend of backends) {
  const pair = async (baseUrl, n) => Promise.all([owner(baseUrl, `${backend.suffix}${n}0`), owner(baseUrl, `${backend.suffix}${n}1`)]);

  test(`[${backend.name}] with the flag off nothing exists but the status field`, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [alice, bob] = await pair(baseUrl, 0);
    const work = await claimedWork(baseUrl, alice, bob, 'off');
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'FEATURE_DISABLED');
    assertCode(await api(baseUrl, sessionRoute(work.workId), { body: { leaseToken: work.leaseToken } }), 'FEATURE_DISABLED');
    assertCode(await end(baseUrl, bob, work.workId, work.leaseToken, 'case_session_x'), 'FEATURE_DISABLED');
    const status = await api(baseUrl, '/api/agent/status', { token: bob.agentApiToken });
    assert.deepEqual(status.payload.caseSessions, { available: false, version: 1 });
    const unknown = await mcp(baseUrl, `envoi_case_session_${crypto.randomBytes(32).toString('base64url')}`, 'initialize', initialize);
    assertCode(unknown, 'AUTHENTICATION_REQUIRED');
    // Settlement bodies keep today's shape.
    const stale = await api(baseUrl, `/api/agent/work/${work.workId}/renew`, { token: bob.agentApiToken, body: { leaseToken: 'wrong' } });
    assert.deepEqual([stale.status, stale.payload.code, stale.payload.message, stale.payload.reason], [409, 'REQUEST_FAILED', 'Work lease fence is stale', undefined]);
  });

  test(`[${backend.name}] mint, use on /mcp, and end a session`, { timeout: 60000 }, async t => {
    const server = await launch({ ...backend.env, ...sessionsOn });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [alice, bob] = await pair(baseUrl, 1);
    const status = await api(baseUrl, '/api/agent/status', { token: bob.agentApiToken });
    assert.deepEqual(status.payload.caseSessions, { available: true, version: 1 });
    assertSchema('agentStatusCaseSessions', status.payload);

    const work = await claimedWork(baseUrl, alice, bob, 'mint');
    const created = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl);
    const { session, lease } = created;
    assert.match(session.token, /^envoi_case_session_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([session.agentId, session.workId, session.workKind, session.caseId, session.fence], [bob.agent.id, work.workId, 'agent_message', work.caseId, 1]);
    assert.deepEqual(session.counterparty, { kind: 'agent', address: alice.agent.address });
    assert.match(session.installationId, /^installation_legacy_/);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), ttlMs);
    assert.deepEqual(lease, { workId: work.workId, leaseExpiresAt: work.leaseExpiresAt }, 'minting does not renew the lease');

    // The server stores only the token's hash.
    const store = documents(t, backend, server);
    const stored = await store.get(sessionParts(bob.inbox.id, session.id));
    assert.equal(stored.tokenHash, sha256(session.token));
    assert.ok(!JSON.stringify(stored).includes(session.token));
    const audit = (await ownerEvents(baseUrl, bob)).find(event => event.type === 'agent.case_session_created');
    assert.deepEqual([audit.sessionId, audit.workId, audit.caseId, audit.fence, audit.agentId], [session.id, work.workId, work.caseId, 1, bob.agent.id]);
    assert.ok(!JSON.stringify(audit).includes(session.token) && !JSON.stringify(audit).includes(work.leaseToken));

    // /mcp with the session: the transport rules still apply, and the effective set is empty.
    const init = await mcp(baseUrl, session.token, 'initialize', initialize);
    assert.equal(init.status, 200, init.text);
    assertSchema('mcpInitializeResult', init.payload);
    assert.deepEqual((await mcp(baseUrl, session.token, 'tools/list')).payload.result.tools, []);
    for (const name of ['envoi_case_snapshot', 'envoi_send_message', 'envoi_complete_work', 'envoi_claim_work']) {
      const refused = await mcp(baseUrl, session.token, 'tools/call', { name, arguments: {} });
      assert.equal(refused.status, 200);
      assert.deepEqual([refused.payload.error.code, refused.payload.error.data.code], [-32602, 'TOOL_NOT_IN_SESSION'], name);
    }
    assert.equal((await mcp(baseUrl, session.token, 'resources/list')).payload.error.code, -32601);
    assert.equal((await mcp(baseUrl, session.token, 'ping', {}, { httpMethod: 'GET' })).status, 405);

    // §6.1: the session token is an unrecognized bearer everywhere else.
    for (const [route, body] of [
      ['/api/agent/work/claim', {}],
      [`/api/agent/work/${work.workId}/renew`, { leaseToken: work.leaseToken }],
      [`/api/agent/work/${work.workId}/complete`, { leaseToken: work.leaseToken }],
      [sessionRoute(work.workId), { leaseToken: work.leaseToken }],
      [`${sessionRoute(work.workId)}/end`, { leaseToken: work.leaseToken, sessionId: session.id }],
      ['/api/agent/status', undefined],
      [`/api/inboxes/${bob.inbox.id}/messages`, undefined],
      [`/api/inboxes/${bob.inbox.id}/events/delta`, undefined]
    ]) assertCode(await api(baseUrl, route, { token: session.token, body, key: body ? 'k' : undefined }), 'AUTHENTICATION_REQUIRED');
    // ...and a session, an mcp_read or a bootstrap token cannot mint.
    const read = await api(baseUrl, '/api/agent/mcp-read-token', { token: bob.agentApiToken, body: { caseId: work.caseId } });
    for (const token of [session.token, read.payload?.mcpAccessToken, `envoi_reg_${crypto.randomBytes(24).toString('base64url')}`].filter(Boolean)) {
      assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken, token), 'AUTHENTICATION_REQUIRED');
    }

    // §8: the host ends it; a replay repeats the first end exactly, and the token stops working.
    const ended = await end(baseUrl, bob, work.workId, work.leaseToken, session.id);
    assert.equal(ended.status, 200, ended.text);
    assertSchema('sessionEnded', ended.payload);
    assert.equal(ended.payload.session.endedReason, 'ended_by_host');
    assert.deepEqual((await end(baseUrl, bob, work.workId, work.leaseToken, session.id)).payload, ended.payload);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'ended_by_host');
    const endedAudits = (await ownerEvents(baseUrl, bob)).filter(event => event.type === 'agent.case_session_ended' && event.sessionId === session.id);
    assert.equal(endedAudits.length, 1, 'exactly one end audit per session');
    assert.ok(!(await ownerEvents(baseUrl, bob)).some(event => event.type === 'case_session.ended'), 'the host\'s own end writes no event');
    // Another lease, another work id or an unknown id: one identical answer.
    for (const [workId, leaseToken, sessionId] of [[work.workId, 'other-lease', session.id], [`msg_${crypto.randomUUID()}`, work.leaseToken, session.id], [work.workId, work.leaseToken, 'case_session_unknown']]) {
      assertCode(await end(baseUrl, bob, workId, leaseToken, sessionId), 'CASE_SESSION_NOT_FOUND');
    }

    // Mint row order: body, then work, then lease.
    for (const bad of [{}, { leaseToken: '' }, { leaseToken: 'x'.repeat(257) }, { leaseToken: work.leaseToken, extra: 1 }, []]) {
      assertCode(await api(baseUrl, sessionRoute(work.workId), { token: bob.agentApiToken, body: bad }), 'CASE_SESSION_REQUEST_INVALID');
    }
    assertCode(await mint(baseUrl, bob, `msg_${crypto.randomUUID()}`, work.leaseToken), 'WORK_NOT_FOUND');
    assertCode(await mint(baseUrl, alice, work.workId, work.leaseToken), 'WORK_NOT_FOUND');
    assertCode(await mint(baseUrl, bob, work.workId, 'not-the-lease'), 'WORK_LEASE_STALE', { reason: 'superseded' });

    // A second mint supersedes the first session.
    const first = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    const second = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    assertEnded(await mcp(baseUrl, first.token, 'ping'), 'superseded');
    assert.equal((await mcp(baseUrl, second.token, 'ping')).status, 200);

    // Settlement ends it (work_settled), and the lease then reads as settled.
    const done = await api(baseUrl, `/api/agent/work/${work.workId}/complete`, { token: bob.agentApiToken, key: `cs-complete-${backend.suffix}`, body: { leaseToken: work.leaseToken } });
    assert.equal(done.status, 201, done.text);
    assertEnded(await mcp(baseUrl, second.token, 'ping'), 'work_settled');
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'WORK_LEASE_STALE', { reason: 'settled' });
    // §7.3: coded settlement errors with the flag on, with today's statuses and messages.
    const again = await api(baseUrl, `/api/agent/work/${work.workId}/renew`, { token: bob.agentApiToken, body: { leaseToken: work.leaseToken } });
    assertCode(again, 'WORK_LEASE_STALE', { reason: 'settled', message: 'Work lease has expired or was consumed' });
    assertCode(await api(baseUrl, `/api/agent/work/${work.workId}/renew`, { token: bob.agentApiToken, body: { leaseToken: 'wrong' } }), 'WORK_LEASE_STALE', { reason: 'superseded' });
    assertCode(await api(baseUrl, `/api/agent/work/msg_${crypto.randomUUID()}/renew`, { token: bob.agentApiToken, body: { leaseToken: 'wrong' } }), 'WORK_NOT_FOUND');
  });

  test(`[${backend.name}] pauses, revokes, re-fencing and expiry end sessions`, { timeout: 90000 }, async t => {
    const server = await launch({ ...backend.env, ...sessionsOn });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const store = documents(t, backend, server);
    const [alice, bob] = await pair(baseUrl, 2);
    const eventsFor = async (type, sessionId) => (await ownerEvents(baseUrl, bob)).filter(event => event.type === type && event.sessionId === sessionId);

    // Agent pause: agent_paused with an event, the lease released, and resume never revives it.
    let work = await claimedWork(baseUrl, alice, bob, 'pause');
    let session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    await pauseAgent(baseUrl, bob);
    const [paused] = await eventsFor('case_session.ended', session.id);
    assertSchema('caseSessionEndedEvent', paused);
    assert.deepEqual([paused.reason, paused.workId, paused.caseId, paused.agentId], ['agent_paused', work.workId, work.caseId, bob.agent.id]);
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'AGENT_PAUSED');
    // Ending is always safe, even while paused.
    const endedPaused = await end(baseUrl, bob, work.workId, work.leaseToken, session.id);
    assert.deepEqual([endedPaused.status, endedPaused.payload.session.endedReason], [200, 'agent_paused']);
    await resumeAgent(baseUrl, bob);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'agent_paused');
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'WORK_LEASE_STALE', { reason: 'released' });
    assertCode(await api(baseUrl, `/api/agent/work/${work.workId}/renew`, { token: bob.agentApiToken, body: { leaseToken: work.leaseToken } }), 'WORK_LEASE_STALE', { reason: 'released' });
    const reclaimed = await claim(baseUrl, bob.agentApiToken);
    assert.deepEqual([reclaimed.payload.work?.workId, (await store.get(workClaimParts(bob.inbox.id, work.workId))).attempts], [work.workId, 1], 'the pause cost no attempt');
    work = { ...reclaimed.payload.work, caseId: work.caseId };

    // Case pause (§7.4): case_controlled with an event, the lease released without an attempt.
    session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    assert.equal(session.fence, 2);
    const casePause = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${work.caseId}/actions`, { session: bob.session, key: `cs-case-pause-${backend.suffix}`, body: { actionKey: 'pause' } });
    assert.equal(casePause.status, 201, casePause.text);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'case_controlled');
    assert.equal((await eventsFor('case_session.ended', session.id))[0]?.reason, 'case_controlled');
    const released = await store.get(workClaimParts(bob.inbox.id, work.workId));
    assert.deepEqual([released.status, released.reofferWithoutAttempt, released.leaseExpiresAt, typeof released.releasedAt], ['retryable', true, null, 'string']);
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'CASE_CONTROLLED', { caseId: work.caseId });
    const caseResume = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${work.caseId}/actions`, { session: bob.session, key: `cs-case-resume-${backend.suffix}`, body: { actionKey: 'resume' } });
    assert.equal(caseResume.status, 201, caseResume.text);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'case_controlled');
    const afterResume = await claim(baseUrl, bob.agentApiToken);
    assert.deepEqual([afterResume.payload.work?.workId, (await store.get(workClaimParts(bob.inbox.id, work.workId))).attempts], [work.workId, 1], 'the case pause cost no attempt');
    work = { ...afterResume.payload.work, caseId: work.caseId };

    // A claim that re-fences the work ends the old fence's session (lease_lost).
    session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    await store.edit(workClaimParts(bob.inbox.id, work.workId), claimRecord => ({ ...claimRecord, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'WORK_LEASE_STALE', { reason: 'expired' });
    const refenced = await claim(baseUrl, bob.agentApiToken);
    assert.equal(refenced.payload.work?.workId, work.workId, refenced.text);
    assert.equal((await store.get(sessionParts(bob.inbox.id, session.id))).endedReason, 'lease_lost', 'recorded by the claim');
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'lease_lost');
    work = { ...refenced.payload.work, caseId: work.caseId };

    // A counterparty pause is derived on the next use (work_ineligible) and releases the lease.
    session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    await pauseAgent(baseUrl, alice);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'work_ineligible');
    assert.equal((await store.get(workClaimParts(bob.inbox.id, work.workId))).reofferWithoutAttempt, true);
    await resumeAgent(baseUrl, alice);
    const eligible = await claim(baseUrl, bob.agentApiToken);
    work = { ...eligible.payload.work, caseId: work.caseId };
    // A WORK_NOT_ELIGIBLE mint releases the lease too.
    const block = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/block`, { session: bob.session, body: {} });
    assert.equal(block.status, 200, block.text);
    assertCode(await mint(baseUrl, bob, work.workId, work.leaseToken), 'WORK_NOT_ELIGIBLE', { reason: 'relationship_blocked' });
    assert.equal((await store.get(workClaimParts(bob.inbox.id, work.workId))).reofferWithoutAttempt, true);
    assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/unblock`, { session: bob.session, body: {} })).status, 200);
    const unblocked = await claim(baseUrl, bob.agentApiToken);
    work = { ...unblocked.payload.work, caseId: work.caseId };

    // Expiry outranks every later condition, and the end route reports endedAt = expiresAt.
    session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    const past = new Date(Date.now() - 1000).toISOString();
    await store.edit(sessionParts(bob.inbox.id, session.id), record => ({ ...record, expiresAt: past }));
    await pauseAgent(baseUrl, bob);
    assertCode(await mcp(baseUrl, session.token, 'ping'), 'CASE_SESSION_EXPIRED');
    const expired = await end(baseUrl, bob, work.workId, work.leaseToken, session.id);
    assert.deepEqual([expired.payload.session.endedReason, expired.payload.session.endedAt], ['expired', past]);
    assert.equal((await eventsFor('case_session.ended', session.id)).length, 0, 'an expiry writes no event');
    await resumeAgent(baseUrl, bob);

    // Credential end: an owner revoke ends every session of the agent, and a recorded reason wins.
    const next = await claim(baseUrl, bob.agentApiToken);
    work = { ...next.payload.work, caseId: work.caseId };
    session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    await revokeAgent(baseUrl, bob);
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'credential_ended');
  });

  test(`[${backend.name}] the sessions epoch: a restart keeps sessions, a disable never revives them`, { timeout: 90000 }, async t => {
    const first = await launch({ ...backend.env, ...sessionsOn });
    const dataDir = first.dataDir;
    t.after(() => first.stop());
    const [alice, bob] = await pair(first.baseUrl, 3);
    const work = await claimedWork(first.baseUrl, alice, bob, 'epoch');
    const session = assertSessionCreated(await mint(first.baseUrl, bob, work.workId, work.leaseToken), first.baseUrl).session;
    await first.stop(true);

    // Restarted while activeUntil is fresh: the epoch stays, so the session still works.
    const second = await launch({ ...backend.env, ...sessionsOn }, dataDir);
    assert.equal((await mcp(second.baseUrl, session.token, 'ping')).status, 200);
    await second.stop(true);

    // A flag-off start moves the epoch; turning the flag back on does not revive the session.
    const off = await launch(backend.env, dataDir);
    assertCode(await mcp(off.baseUrl, session.token, 'ping'), 'AUTHENTICATION_REQUIRED');
    assertCode(await mint(off.baseUrl, bob, work.workId, work.leaseToken), 'FEATURE_DISABLED');
    await off.stop(true);
    const back = await launch({ ...backend.env, ...sessionsOn }, dataDir);
    assertCode(await mcp(back.baseUrl, session.token, 'ping'), 'AUTHENTICATION_REQUIRED');
    assertCode(await end(back.baseUrl, bob, work.workId, work.leaseToken, session.id), 'CASE_SESSION_NOT_FOUND');
    // A session minted after the move works.
    const fresh = assertSessionCreated(await mint(back.baseUrl, bob, work.workId, work.leaseToken), back.baseUrl).session;
    assert.equal((await mcp(back.baseUrl, fresh.token, 'ping')).status, 200);

    // A code rollback stops the heartbeat, so activeUntil lapses and the next flag-on start moves the epoch.
    await back.stop(true);
    const epochDoc = documents(t, backend, { dataDir });
    await epochDoc.edit(['config', 'case-sessions-epoch'], value => ({ ...value, activeUntil: new Date(Date.now() - 1000).toISOString() }));
    const rolled = await launch({ ...backend.env, ...sessionsOn }, dataDir);
    t.after(() => rolled.stop());
    assertCode(await mcp(rolled.baseUrl, fresh.token, 'ping'), 'AUTHENTICATION_REQUIRED');
  });

  test(`[${backend.name}] installation revoke, refresh replay, take-over and decline end sessions; other hosts cannot`, { timeout: 90000 }, async t => {
    const server = await launch({ ...backend.env, ...sessionsOn });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const store = documents(t, backend, server);

    // Installation revoke ends that installation's sessions (credential_ended) in the same transaction.
    const [alice, bob] = await pair(baseUrl, 5);
    let work = await claimedWork(baseUrl, alice, bob, 'installation');
    let session = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    const revokeInstallation = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/installations/${session.installationId}/revoke`, { session: bob.session, body: {} });
    assert.equal(revokeInstallation.status, 200, revokeInstallation.text);
    assert.equal((await store.get(sessionParts(bob.inbox.id, session.id))).endedReason, 'credential_ended');
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'credential_ended');

    // Refresh replay revokes the family, and with it the family's sessions.
    const [carol, dave] = await pair(baseUrl, 6);
    work = await claimedWork(baseUrl, carol, dave, 'replay');
    session = assertSessionCreated(await mint(baseUrl, dave, work.workId, work.leaseToken), baseUrl).session;
    assert.equal((await refresh(baseUrl, dave.agentRefreshToken, newRotationId())).status, 200);
    assert.equal((await refresh(baseUrl, dave.agentRefreshToken, newRotationId())).payload?.code, 'REFRESH_REPLAY');
    assert.equal((await store.get(sessionParts(dave.inbox.id, session.id))).endedReason, 'credential_ended');
    assertEnded(await mcp(baseUrl, session.token, 'ping'), 'credential_ended');

    // Take-over pauses the case and decline revokes it: both release the work and end its session.
    const [erin, frank] = await pair(baseUrl, 7);
    for (const actionKey of ['takeOver', 'decline']) {
      work = await claimedWork(baseUrl, erin, frank, actionKey);
      session = assertSessionCreated(await mint(baseUrl, frank, work.workId, work.leaseToken), baseUrl).session;
      // Another host cannot end it, and malformed and unknown tokens look alike.
      assertCode(await end(baseUrl, erin, work.workId, work.leaseToken, session.id), 'CASE_SESSION_NOT_FOUND');
      const unknown = await mcp(baseUrl, `envoi_case_session_${crypto.randomBytes(32).toString('base64url')}`, 'ping');
      const malformed = await mcp(baseUrl, 'envoi_case_session_short', 'ping');
      assertCode(unknown, 'AUTHENTICATION_REQUIRED');
      assert.deepEqual([malformed.status, malformed.payload.code, malformed.payload.message, malformed.headers.get('www-authenticate')], [unknown.status, unknown.payload.code, unknown.payload.message, unknown.headers.get('www-authenticate')]);
      const action = await api(baseUrl, `/api/inboxes/${frank.inbox.id}/cases/${work.caseId}/actions`, { session: frank.session, key: `cs-${actionKey}-${backend.suffix}`, body: { actionKey } });
      assert.equal(action.status, 201, action.text);
      assert.equal((await store.get(sessionParts(frank.inbox.id, session.id))).endedReason, 'case_controlled', actionKey);
      assert.ok((await ownerEvents(baseUrl, frank)).some(event => event.type === 'case_session.ended' && event.sessionId === session.id), actionKey);
      assert.equal((await store.get(workClaimParts(frank.inbox.id, work.workId))).reofferWithoutAttempt, true, actionKey);
      assertEnded(await mcp(baseUrl, session.token, 'ping'), 'case_controlled');
    }
  });

  test(`[${backend.name}] cleanup records expiry and removes records 24 h after it`, { timeout: 60000 }, async t => {
    const server = await launch({ ...backend.env, ...sessionsOn, ENVOI_CASE_SESSION_CLEANUP_INTERVAL_MS: '200' });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const store = documents(t, backend, server);
    const [alice, bob] = await pair(baseUrl, 4);
    const work = await claimedWork(baseUrl, alice, bob, 'cleanup');
    const recent = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    const old = assertSessionCreated(await mint(baseUrl, bob, work.workId, work.leaseToken), baseUrl).session;
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
    await store.edit(sessionParts(bob.inbox.id, recent.id), record => ({ ...record, endedReason: null, endedAt: null, status: 'active', expiresAt: hourAgo }));
    await store.edit(sessionParts(bob.inbox.id, old.id), record => ({ ...record, expiresAt: dayAgo }));
    await store.edit(['auth', 'case-sessions', `${sha256(old.token)}.json`], record => ({ ...record, expiresAt: dayAgo }));
    // Polled while the server rewrites these files; on Windows a read can fail mid-rename, so a failed read just polls again.
    const read = parts => store.get(parts).catch(() => undefined);
    await eventually(async () => (await read(sessionParts(bob.inbox.id, old.id))) === null, { message: 'old session removed', timeoutMs: 15000 });
    assert.equal(await store.get(['auth', 'case-sessions', `${sha256(old.token)}.json`]), null);
    assertCode(await mcp(baseUrl, old.token, 'ping'), 'AUTHENTICATION_REQUIRED');
    const kept = await eventually(async () => { const record = await read(sessionParts(bob.inbox.id, recent.id)); return record?.endedReason === 'expired' && record; }, { message: 'expiry recorded', timeoutMs: 15000 });
    assert.equal(kept.endedAt, hourAgo);
    assertCode(await mcp(baseUrl, recent.token, 'ping'), 'CASE_SESSION_EXPIRED');
  });
}
