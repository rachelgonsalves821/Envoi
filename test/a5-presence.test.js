// a5-presence v1 (task A-3), end to end through the HTTP API. The lifecycle runs on FileStore,
// and on PostgreSQL when DATABASE_URL is set (CI test:postgres). Cases that need to edit or
// inspect stored documents run on FileStore only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  accessCredentialParts, agentRoute, agentStatus, api, claim, editData, eventually, expireAccessToken, expireFamily, launch,
  newRotationId, openEventStream, owner, pauseAgent, readData, refresh, resumeAgent, revokeAgent, send, sleep, waitForMessageStatus, writeData
} from './a3-harness.js';

const schemas = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'a5-presence', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertContract(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const backends = [{ name: 'FileStore', env: {}, suffix: '51' }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, suffix: '52' }] : [])];

async function ownerConnection(baseUrl, who) {
  const res = await api(baseUrl, `/api/inboxes/${who.inbox.id}/agents`, { session: who.session });
  assert.equal(res.status, 200, res.text);
  assertContract('ownerAgentList', res.payload);
  return res.payload.find(agent => agent.id === who.agent.id).connection;
}
const waitForConnection = (baseUrl, who, check, message) => eventually(async () => {
  const connection = await ownerConnection(baseUrl, who);
  return check(connection) ? connection : null;
}, { message });

for (const backend of backends) {
  test(`[${backend.name}] presence follows an installation through setup, work, refresh, pause, resume and revoke`, { timeout: 60000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const bob = await owner(baseUrl, `${backend.suffix}01`);

    // Enrollment is never presence (§3).
    const enrolled = await ownerConnection(baseUrl, bob);
    assert.equal(enrolled.state, 'never_seen');
    assert.deepEqual(enrolled.presence, { lastSeenAt: null, lastSuccessfulRefreshAt: null, lastWorkClaimAt: null, lastProcessedAt: null });
    assert.ok(Date.parse(enrolled.credentialExpiresAt) > Date.now(), 'the live family reports its rolling expiry');

    // A setup check reads status: lastSeenAt only, still not a check-in for an active agent.
    const status = await agentStatus(baseUrl, bob.agentApiToken);
    assert.equal(status.status, 200, status.text);
    assertContract('agentStatusWithPresence', status.payload);
    const setupOnly = await waitForConnection(baseUrl, bob, connection => connection.presence.lastSeenAt, 'the status read to be recorded');
    assert.equal(setupOnly.state, 'never_seen', 'setup traffic is not a work-loop check-in');
    assert.equal(setupOnly.seenAt, null);

    // The work loop claims: seen recently.
    const idle = await claim(baseUrl, bob.agentApiToken);
    assert.equal(idle.payload.state, 'idle', idle.text);
    const working = await waitForConnection(baseUrl, bob, connection => connection.presence.lastWorkClaimAt, 'the claim to be recorded');
    assert.equal(working.state, 'seen_recently');
    assert.equal(working.seenAt, working.presence.lastWorkClaimAt);
    assert.ok(working.presence.lastSeenAt >= working.presence.lastWorkClaimAt, 'lastSeenAt leads');

    // A second claim inside the throttle does not move the field.
    await claim(baseUrl, bob.agentApiToken);
    await sleep(300);
    assert.equal((await ownerConnection(baseUrl, bob)).presence.lastWorkClaimAt, working.presence.lastWorkClaimAt, 'throttled');

    // A refresh records itself and leads lastSeenAt past its own throttle.
    const rotated = await refresh(baseUrl, bob.agentRefreshToken, newRotationId());
    assert.equal(rotated.status, 200, rotated.text);
    const refreshed = await waitForConnection(baseUrl, bob, connection => connection.presence.lastSuccessfulRefreshAt, 'the refresh to be recorded');
    assert.ok(refreshed.presence.lastSeenAt >= refreshed.presence.lastSuccessfulRefreshAt, 'lastSeenAt leads the refresh');
    const token = rotated.payload.agentApiToken;

    // The agent's own token on the agents list never sees connection (§4.2).
    const asAgent = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents`, { token });
    assert.equal(asAgent.status, 200, asAgent.text);
    assert.ok(asAgent.payload.every(agent => !('connection' in agent)), 'connection is for the owning humans only');

    // Pause: the response carries connection; while paused the basis is lastSeenAt.
    const paused = await pauseAgent(baseUrl, bob);
    assertContract('ownerAgent', paused);
    assert.equal(paused.paused, true);
    assert.equal(paused.connection.seenAt, paused.connection.presence.lastSeenAt);
    assert.equal(paused.connection.state, 'seen_recently');

    // Resume: resumedAt is recorded and the grace keeps the paused-time basis, so no flap.
    const resumed = await resumeAgent(baseUrl, bob);
    assertContract('ownerAgent', resumed);
    assert.ok(resumed.resumedAt, 'resume records resumedAt');
    assert.equal(resumed.connection.state, 'seen_recently');

    // Revoke: revoked, no expiry, last-known presence kept.
    await revokeAgent(baseUrl, bob);
    const revoked = await ownerConnection(baseUrl, bob);
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.credentialExpiresAt, null);
    assert.ok(revoked.presence.lastWorkClaimAt, 'the last-known presence stays visible');
  });
}

// Each case uses a fresh installation whose first request is the one under test, so neither the
// 60 s throttle nor the server's per-process cache can hide a wrong write.
async function presenceParts(server, who) {
  const index = await readData(server, ...accessCredentialParts(who.agentApiToken));
  return ['auth', 'agent-presence', index.inboxId, index.agentId, `${index.familyId}.json`];
}

test('[FileStore] rejected credentials, model-held tokens and paused lease requests do not count as check-ins', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const settle = () => sleep(400);

  // A model-held mcp_read token is not the installation (§3). Its record is written directly so
  // that no access-token request comes first.
  const reader = await owner(baseUrl, '5301');
  const index = await readData(server, ...accessCredentialParts(reader.agentApiToken));
  const readToken = `envoi_mcp_read_${'r'.repeat(43)}`;
  await writeData(server, accessCredentialParts(readToken), { tokenType: 'mcp_read', agentId: index.agentId, inboxId: index.inboxId, familyId: index.familyId, caseId: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null });
  const listed = await api(baseUrl, '/mcp', {
    token: readToken,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.equal(listed.status, 200, listed.text);
  await settle();
  assert.equal(await readData(server, ...await presenceParts(server, reader)), null, 'mcp_read requests never write presence');

  // A paused agent's lease request (409 AGENT_PAUSED) counts for lastSeenAt only.
  const paused = await owner(baseUrl, '5302');
  await pauseAgent(baseUrl, paused);
  const leased = await api(baseUrl, '/api/agent/work/work_example/renew', { token: paused.agentApiToken, body: { leaseToken: 'lease_example' } });
  assert.equal(leased.payload?.code, 'AGENT_PAUSED', leased.text);
  const pausedParts = await presenceParts(server, paused);
  const afterPausedLease = await eventually(() => readData(server, ...pausedParts), { message: 'the paused request to be recorded' });
  assert.ok(afterPausedLease.lastSeenAt);
  assert.equal(afterPausedLease.lastWorkClaimAt, null, 'AGENT_PAUSED is not work-loop activity');

  // A rejected credential never writes (any 401).
  const rejected = await owner(baseUrl, '5303');
  await expireAccessToken(server, rejected.agentApiToken);
  const expired = await claim(baseUrl, rejected.agentApiToken);
  assert.equal(expired.payload?.code, 'ACCESS_TOKEN_EXPIRED', expired.text);
  await settle();
  assert.equal(await readData(server, ...await presenceParts(server, rejected)), null, '401s never write presence');
});

test('[FileStore] a first completion records processing, a replay does not, and the stream connect counts once', { timeout: 60000 }, async t => {
  let server = await launch();
  t.after(() => server.stop());
  const [alice, bob, watcher] = await Promise.all([owner(server.baseUrl, '5401'), owner(server.baseUrl, '5402'), owner(server.baseUrl, '5403')]);
  const parts = await presenceParts(server, bob);

  // The event stream connect is the installation's first request: it records while still open.
  const stream = await openEventStream(server, watcher.inbox.id, watcher.agentApiToken, { query: '?from=latest' });
  assert.equal(stream.status, 200);
  const watcherParts = await presenceParts(server, watcher);
  const connected = await eventually(() => readData(server, ...watcherParts), { message: 'the stream connect to be recorded' });
  assert.ok(connected.lastSeenAt);
  assert.equal(connected.lastWorkClaimAt, null, 'a stream is not work-loop activity');

  const { baseUrl } = server;
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a5_processing' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  const claimed = await claim(baseUrl, bob.agentApiToken);
  assert.equal(claimed.payload.state, 'claimed', claimed.text);
  const complete = base => api(base, `/api/agent/work/${claimed.payload.work.workId}/complete`, { token: bob.agentApiToken, key: 'a5-complete', body: { leaseToken: claimed.payload.work.leaseToken } });
  assert.equal((await complete(baseUrl)).status, 201);
  const processed = await eventually(async () => (await readData(server, ...parts))?.lastProcessedAt && readData(server, ...parts), { message: 'processing to be recorded' });
  assert.ok(processed.lastSeenAt >= processed.lastProcessedAt, 'lastSeenAt leads');

  // Clear the stored value and restart, so neither the throttle nor the process cache can mask
  // the replay rule: a replay that counted as processing would write lastProcessedAt again.
  stream.close();
  await server.stop(true);
  await editData(server, parts, value => ({ ...value, lastProcessedAt: null }));
  server = await launch({}, server.dataDir);
  const replay = await complete(server.baseUrl);
  assert.equal(replay.status, 200, replay.text);
  await sleep(400);
  assert.equal((await readData(server, ...parts)).lastProcessedAt, null, 'an idempotent replay is not processing');
});

test('[FileStore] expiry shows needs_reconnect and removal deletes presence', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const bob = await owner(baseUrl, '5501');
  await claim(baseUrl, bob.agentApiToken);
  const index = await readData(server, ...accessCredentialParts(bob.agentApiToken));
  await eventually(() => readData(server, 'auth', 'agent-presence', index.inboxId, index.agentId, `${index.familyId}.json`), { message: 'presence to exist' });

  await expireFamily(server, bob.agentApiToken);
  const expired = await ownerConnection(baseUrl, bob);
  assert.equal(expired.state, 'needs_reconnect');

  const removed = await api(baseUrl, agentRoute(bob, 'remove'), { session: bob.session, body: { deleteHistory: false } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(await readData(server, 'auth', 'agent-presence', index.inboxId, index.agentId, `${index.familyId}.json`), null, 'removal deletes presence');
});
