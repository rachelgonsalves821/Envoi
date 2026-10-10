// a3-pause-auth v1 (A-1): paused-agent behavior matrix (handoffs.md §3–§5,
// build-plan-v3 §18). Test-first: written against the approved contract before
// the server implementation, so these fail on pre-A-1 code by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentRoute, agentStatus, api, assertError, assertSchema, claim,
  expireAccessToken, expireFamily, launch, newRotationId, openEventStream, owner, pauseAgent, readData,
  refresh, resumeAgent, revokeAgent, send, sleep, waitForMessageStatus, workClaimParts
} from './a3-harness.js';

const mcpHeaders = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
const mcp = (baseUrl, token, method, id = 1, params) => api(baseUrl, '/mcp', { token, headers: mcpHeaders, body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } });

async function reconnect(baseUrl, who) {
  const issued = await api(baseUrl, agentRoute(who, 'credentials/reconnect-token'), { session: who.session, body: {} });
  assert.equal(issued.status, 201, `reconnect-token: ${issued.text}`);
  assertSchema('reconnectTokenIssued', issued.payload);
  const redeemed = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: issued.payload.enrollmentToken } });
  return { issued, redeemed };
}

test('active sender → paused recipient: 202 queued, delivered, work held until resume, then claimed with attempts 1', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1101'), owner(baseUrl, '1102')]);
  const caseId = 'case_a3_paused_recipient';
  await pauseAgent(baseUrl, bob);

  const sent = await send(baseUrl, alice, bob, { caseId, text: 'For a paused recipient' });
  assert.equal(sent.status, 202, `send to paused recipient must be accepted: ${sent.text}`);
  assertSchema('sendAccepted', sent.payload);
  assert.equal(sent.payload.status, 'queued');
  assert.equal(sent.payload.caseId, caseId);

  // Delivery proceeds normally to the paused recipient's inbox; only the work is held.
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  await waitForMessageStatus(baseUrl, alice, sent.payload.id, 'delivered');

  const held = await claim(baseUrl, bob.agentApiToken);
  assert.equal(held.status, 200, held.text);
  assertSchema('claimPaused', held.payload);
  assert.deepEqual(held.payload, { work: null, state: 'paused' });
  assert.equal(await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id)), null, 'a paused claim must not create a work claim or consume an attempt');

  await resumeAgent(baseUrl, bob);
  const claimed = await claim(baseUrl, bob.agentApiToken);
  assert.equal(claimed.status, 200, claimed.text);
  assertSchema('claimClaimed', claimed.payload);
  assert.equal(claimed.payload.state, 'claimed');
  assert.equal(claimed.payload.work.workId, sent.payload.id);
  const record = await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id));
  assert.equal(record?.attempts, 1, 'held work is claimed on its first attempt after resume');

  const idle = await claim(baseUrl, bob.agentApiToken);
  assert.equal(idle.status, 200, idle.text);
  assertSchema('claimIdle', idle.payload);
  // a4-wake §5 adds an optional hint; here it is the expiry of the lease bob still holds.
  assert.deepEqual([idle.payload.work, idle.payload.state], [null, 'idle']);
});

test('delivered work then recipient paused: work is held (claim state paused) and offered after resume', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1201'), owner(baseUrl, '1202')]);
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a3_delivered_then_paused' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');

  await pauseAgent(baseUrl, bob);
  const held = await claim(baseUrl, bob.agentApiToken);
  assert.equal(held.status, 200, held.text);
  assert.deepEqual(held.payload, { work: null, state: 'paused' });
  assert.equal(await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id)), null);

  await resumeAgent(baseUrl, bob);
  const claimed = await claim(baseUrl, bob.agentApiToken);
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.payload.state, 'claimed');
  assert.equal(claimed.payload.work.workId, sent.payload.id);
  assert.equal((await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id)))?.attempts, 1);
});

test('pause during an active lease: settlement returns AGENT_PAUSED, attempts unchanged, work re-offered with a new fence after resume', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1301'), owner(baseUrl, '1302')]);
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a3_lease' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');

  const first = await claim(baseUrl, bob.agentApiToken);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.payload.state, 'claimed');
  const workId = first.payload.work.workId;
  const oldLease = first.payload.work.leaseToken;
  const before = await readData(server, ...workClaimParts(bob.inbox.id, workId));
  assert.equal(before.attempts, 1);

  await pauseAgent(baseUrl, bob);
  const settle = (action, body, key) => api(baseUrl, `/api/agent/work/${workId}/${action}`, { token: bob.agentApiToken, key, body });
  assertError(await settle('complete', { leaseToken: oldLease }, 'a3-lease-complete'), 'AGENT_PAUSED');
  assertError(await settle('renew', { leaseToken: oldLease }), 'AGENT_PAUSED');
  assertError(await settle('acknowledge', { leaseToken: oldLease }, 'a3-lease-ack'), 'AGENT_PAUSED');
  assertError(await settle('fail', { leaseToken: oldLease, retryable: true }), 'AGENT_PAUSED');
  // §2.1: a paused agent learns it is paused before any validation error.
  assertError(await settle('fail', { leaseToken: oldLease }), 'AGENT_PAUSED');
  const paused = await claim(baseUrl, bob.agentApiToken);
  assert.deepEqual(paused.payload, { work: null, state: 'paused' });
  const during = await readData(server, ...workClaimParts(bob.inbox.id, workId));
  assert.equal(during.attempts, before.attempts, 'pause and paused settlement attempts must not consume work attempts');
  assert.notEqual(during.status, 'completed');

  await resumeAgent(baseUrl, bob);
  const again = await claim(baseUrl, bob.agentApiToken);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.payload.state, 'claimed', 'the invalidated lease must be re-offered immediately after resume');
  assert.equal(again.payload.work.workId, workId);
  assert.notEqual(again.payload.work.leaseToken, oldLease);
  const after = await readData(server, ...workClaimParts(bob.inbox.id, workId));
  assert.ok(Number(after.fence) > Number(before.fence), 're-offer uses a new fence');
  // Assumption: the attempt invalidated by the pause is not counted, so the
  // re-offer is still attempt 1 ("pause alone never consumes a work attempt").
  assert.equal(after.attempts, before.attempts, 'attempts did not increase because of the pause');

  const stale = await settle('complete', { leaseToken: oldLease }, 'a3-lease-complete-stale');
  assert.notEqual(stale.status, 200, 'the pre-pause lease stays invalid after resume');
  const done = await settle('complete', { leaseToken: again.payload.work.leaseToken }, 'a3-lease-complete-new');
  assert.equal(done.status, 201, done.text); // completion creates the processed receipt
});

test('pause longer than the access-token TTL: refresh 200, expired access token ACCESS_TOKEN_EXPIRED, status reports paused', async t => {
  const server = await launch({ ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS: '60' });
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1401'), owner(baseUrl, '1402')]);
  await pauseAgent(baseUrl, bob);

  const rotated = await refresh(baseUrl, bob.agentRefreshToken, newRotationId());
  assert.equal(rotated.status, 200, `refresh while paused must succeed: ${rotated.text}`);
  assertSchema('tokenPair', rotated.payload);
  assert.equal('state' in rotated.payload || 'status' in rotated.payload, false, 'refresh does not reveal paused state');

  const status = await agentStatus(baseUrl, rotated.payload.agentApiToken);
  assert.equal(status.status, 200, status.text);
  assertSchema('pausedAgentStatus', status.payload);
  assert.equal(status.payload.state, 'paused');
  assert.deepEqual(status.payload.agent, { ...status.payload.agent, id: bob.agent.id, address: bob.agent.address, status: 'paused' });
  assert.equal(status.payload.inboxId, bob.inbox.id);

  const report = await api(baseUrl, '/api/agent/connection-status', { token: rotated.payload.agentApiToken, body: { version: 1, runtime: 'openclaw', phase: 'ready', runtimeTest: 'passed' } });
  assert.equal(report.status, 200, report.text);
  assert.deepEqual((await claim(baseUrl, rotated.payload.agentApiToken)).payload, { work: null, state: 'paused' });

  // Simulate the original access token outliving its TTL during the pause.
  await expireAccessToken(server, bob.agentApiToken);
  assertError(await claim(baseUrl, bob.agentApiToken), 'ACCESS_TOKEN_EXPIRED');
  assertError(await agentStatus(baseUrl, bob.agentApiToken), 'ACCESS_TOKEN_EXPIRED');
  // §2.1: ACCESS_TOKEN_EXPIRED (4) wins over AGENT_PAUSED (5).
  assertError(await send(baseUrl, bob, alice, { caseId: 'case_a3_ttl' }), 'ACCESS_TOKEN_EXPIRED');

  const second = await refresh(baseUrl, rotated.payload.agentRefreshToken, newRotationId());
  assert.equal(second.status, 200, second.text);

  await resumeAgent(baseUrl, bob);
  const active = await agentStatus(baseUrl, second.payload.agentApiToken);
  assert.equal(active.status, 200, active.text);
  assertSchema('agentStatus', active.payload);
  assert.equal(active.payload.state, 'active');
  assert.equal(active.payload.agent.status, 'active');
  assert.deepEqual((await claim(baseUrl, second.payload.agentApiToken)).payload, { work: null, state: 'idle' });
});

test('pause during token rotation: same token and rotationId recover the identical successor while paused', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const bob = await owner(baseUrl, '1501');
  const rotationId = newRotationId();
  const first = await refresh(baseUrl, bob.agentRefreshToken, rotationId);
  assert.equal(first.status, 200, first.text);

  // The connector "lost" the response, then the owner paused it before the retry.
  await pauseAgent(baseUrl, bob);
  const recovered = await refresh(baseUrl, bob.agentRefreshToken, rotationId);
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.payload, first.payload);

  const status = await agentStatus(baseUrl, recovered.payload.agentApiToken);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.payload.state, 'paused');
  const next = await refresh(baseUrl, recovered.payload.agentRefreshToken, newRotationId());
  assert.equal(next.status, 200, next.text);
});

test('30+ day offline expiry while paused: CREDENTIAL_EXPIRED, reconnect while paused keeps identity and pause until explicit resume', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [agent, peer] = await Promise.all([owner(baseUrl, '1601'), owner(baseUrl, '1602')]);
  await pauseAgent(baseUrl, agent);

  // Simulate >30 days offline: the family's rolling expiry has passed. Pause does not extend it.
  await expireFamily(server, agent.agentApiToken);
  assertError(await refresh(baseUrl, agent.agentRefreshToken, newRotationId()), 'CREDENTIAL_EXPIRED');
  assertError(await claim(baseUrl, agent.agentApiToken), 'CREDENTIAL_EXPIRED');

  // Owner reconnects the same identity while it is still paused.
  const { redeemed } = await reconnect(baseUrl, agent);
  assert.equal(redeemed.status, 200, `redeem while paused: ${redeemed.text}`);
  assertSchema('reconnectRedeemed', redeemed.payload);
  assert.equal(redeemed.payload.agent.id, agent.agent.id);
  assert.equal(redeemed.payload.agent.address, agent.agent.address);
  assert.equal(redeemed.payload.agent.status, 'paused');
  assert.equal(redeemed.payload.inbox.id, agent.inbox.id);

  // Every earlier family is revoked as replaced; revoked outranks expired (§2.1).
  assertError(await claim(baseUrl, agent.agentApiToken), 'CREDENTIAL_REVOKED', { reason: 'replaced' });
  assertError(await refresh(baseUrl, agent.agentRefreshToken, newRotationId()), 'CREDENTIAL_REVOKED', { reason: 'replaced' });

  const fresh = redeemed.payload.agentApiToken;
  assert.deepEqual((await claim(baseUrl, fresh)).payload, { work: null, state: 'paused' });
  const status = await agentStatus(baseUrl, fresh);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.payload.state, 'paused');
  assertError(await send(baseUrl, agent, peer, { token: fresh, caseId: 'case_a3_reconnect' }), 'AGENT_PAUSED');
  const refreshed = await refresh(baseUrl, redeemed.payload.agentRefreshToken, newRotationId());
  assert.equal(refreshed.status, 200, refreshed.text);

  await resumeAgent(baseUrl, agent);
  const latest = refreshed.payload.agentApiToken;
  assert.equal((await agentStatus(baseUrl, latest)).payload?.state, 'active');
  assert.deepEqual((await claim(baseUrl, latest)).payload, { work: null, state: 'idle' });
  const sent = await send(baseUrl, agent, peer, { token: latest, caseId: 'case_a3_reconnect' });
  assert.equal(sent.status, 202, sent.text);
});

test('reconnect while paused closes the replaced family stream with credential.ended (replaced)', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '1701');
  await pauseAgent(baseUrl, agent);

  const stream = await openEventStream(server, agent.inbox.id, agent.agentApiToken);
  assert.equal(stream.status, 200, `paused agent may open SSE: ${stream.text}`);
  await stream.waitFor(item => item.event === 'ready', { message: 'ready' });

  const { redeemed } = await reconnect(baseUrl, agent);
  assert.equal(redeemed.status, 200, redeemed.text);
  const ended = await stream.waitFor(item => item.event === 'credential.ended', { message: 'credential.ended' });
  assert.equal(ended.id, undefined, 'credential.ended carries no SSE id');
  assertSchema('credentialEndedEvent', ended.data);
  assert.deepEqual(ended.data, { code: 'CREDENTIAL_REVOKED', reason: 'replaced' });
  assert.equal(await stream.waitForEnd(), true, 'the stream closes after credential.ended');
  assert.equal((await agentStatus(baseUrl, redeemed.payload.agentApiToken)).payload?.state, 'paused');
});

test('MCP while paused: /mcp is HTTP 409 AGENT_PAUSED; mcp_read tokens and mcp-read-token issuance too', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1801'), owner(baseUrl, '1802')]);
  const caseId = 'case_a3_mcp';
  const sent = await send(baseUrl, alice, bob, { caseId });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, alice, sent.payload.id, 'delivered');

  const readToken = await api(baseUrl, '/api/agent/mcp-read-token', { token: alice.agentApiToken, body: { caseId } });
  assert.equal(readToken.status, 201, readToken.text);
  const mcpRead = readToken.payload.mcpAccessToken;
  const caseRoute = `/api/inboxes/${alice.inbox.id}/cases/${caseId}`;
  assert.equal((await api(baseUrl, caseRoute, { token: mcpRead })).status, 200, 'baseline: mcp_read works while active');
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'tools/list')).status, 200, 'baseline: MCP works while active');

  await pauseAgent(baseUrl, alice);
  const initialize = await mcp(baseUrl, alice.agentApiToken, 'initialize', 1, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a3-test', version: '1.0.0' } });
  assertError(initialize, 'AGENT_PAUSED');
  assert.equal(initialize.payload.jsonrpc, undefined, 'not a JSON-RPC result');
  assertError(await mcp(baseUrl, alice.agentApiToken, 'tools/list', 2), 'AGENT_PAUSED');
  assertError(await mcp(baseUrl, mcpRead, 'tools/list', 3), 'AGENT_PAUSED');
  assertError(await api(baseUrl, caseRoute, { token: mcpRead }), 'AGENT_PAUSED');
  assertError(await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages?caseId=${caseId}`, { token: mcpRead }), 'AGENT_PAUSED');
  assertError(await api(baseUrl, '/api/agent/mcp-read-token', { token: alice.agentApiToken, body: { caseId } }), 'AGENT_PAUSED');

  // The paused access token may still read what it could already read (§3).
  assert.equal((await api(baseUrl, caseRoute, { token: alice.agentApiToken })).status, 200);

  await resumeAgent(baseUrl, alice);
  assert.equal((await api(baseUrl, caseRoute, { token: mcpRead })).status, 200, 'mcp_read works again after resume');
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'tools/list', 4)).status, 200);
});

test('SSE: pause keeps the stream open; resume sends agent.resumed then work.available; revoke ends it with credential.ended', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '1901'), owner(baseUrl, '1902')]);
  const stream = await openEventStream(server, alice.inbox.id, alice.agentApiToken);
  assert.equal(stream.status, 200, stream.text);
  await stream.waitFor(item => item.event === 'ready', { message: 'ready' });

  await pauseAgent(baseUrl, alice);
  const paused = await stream.waitFor(item => item.event === 'agent.paused', { message: 'agent.paused' });
  assertSchema('agentPausedEvent', paused.data);
  assert.equal(paused.data.agentId, alice.agent.id);
  assert.equal(paused.data.humanId, alice.human.id);
  assert.equal(paused.data.status, 'paused');
  assert.equal(paused.id, paused.data.cursor, 'persisted events use the cursor as SSE id');
  await sleep(500);
  assert.equal(stream.ended, false, 'pausing must not close the agent stream');

  // A paused agent can also open a new stream.
  const second = await openEventStream(server, alice.inbox.id, alice.agentApiToken);
  assert.equal(second.status, 200, `paused agent SSE connect: ${second.text}`);
  second.close();

  // Held work for the paused agent.
  const sent = await send(baseUrl, bob, alice, { caseId: 'case_a3_sse' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, alice, sent.payload.id, 'delivered');

  await resumeAgent(baseUrl, alice);
  const resumed = await stream.waitFor(item => item.event === 'agent.resumed', { message: 'agent.resumed' });
  assertSchema('agentResumedEvent', resumed.data);
  assert.equal(resumed.data.agentId, alice.agent.id);
  assert.equal(resumed.data.status, 'active');
  const available = await stream.waitFor(item => item.event === 'work.available', { message: 'work.available' });
  assertSchema('workAvailableEvent', available.data);
  assert.equal(available.data.agentId, alice.agent.id);
  assert.equal(available.data.reason, 'agent_resumed');
  assert.equal(available.id, available.data.cursor);
  assert.ok(stream.events.indexOf(resumed) < stream.events.indexOf(available), 'work.available follows agent.resumed');

  await revokeAgent(baseUrl, alice);
  const ended = await stream.waitFor(item => item.event === 'credential.ended', { message: 'credential.ended' });
  assert.equal(ended.id, undefined, 'credential.ended has no SSE id');
  assertSchema('credentialEndedEvent', ended.data);
  assert.equal(ended.data.code, 'CREDENTIAL_REVOKED');
  if ('reason' in ended.data) assert.equal(ended.data.reason, 'revoked');
  assert.equal(await stream.waitForEnd(), true, 'stream closes after credential.ended');
});

test('case pause: CASE_CONTROLLED carries caseId; AGENT_PAUSED wins when both apply; case resume does not unpause the agent', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '2001'), owner(baseUrl, '2002')]);
  const caseId = 'case_a3_case_pause';
  const first = await send(baseUrl, alice, bob, { caseId });
  assert.equal(first.status, 202, first.text);
  await waitForMessageStatus(baseUrl, alice, first.payload.id, 'delivered');

  const caseAction = (key, actionKey) => api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key, body: { actionKey } });
  assert.equal((await caseAction('a3-case-pause', 'pause')).status, 201);
  assertError(await send(baseUrl, alice, bob, { caseId }), 'CASE_CONTROLLED', { caseId });
  const other = await send(baseUrl, alice, bob, { caseId: 'case_a3_other_case' });
  assert.equal(other.status, 202, 'case control is case-scoped');

  await pauseAgent(baseUrl, alice);
  assertError(await send(baseUrl, alice, bob, { caseId }), 'AGENT_PAUSED');

  assert.equal((await caseAction('a3-case-resume', 'resume')).status, 201);
  assertError(await send(baseUrl, alice, bob, { caseId }), 'AGENT_PAUSED');
  const status = await agentStatus(baseUrl, alice.agentApiToken);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.payload.state, 'paused', 'a case resume cannot override an agent pause');
  assert.deepEqual((await claim(baseUrl, alice.agentApiToken)).payload, { work: null, state: 'paused' });

  await resumeAgent(baseUrl, alice);
  const resumed = await send(baseUrl, alice, bob, { caseId });
  assert.equal(resumed.status, 202, resumed.text);
});
