// a5-presence v1 (task A-3), end to end through the HTTP API. Every §3 row and the lifecycle run
// on FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres). Negative cases that
// need to edit or inspect stored documents run on FileStore only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  accessCredentialParts, agentRoute, agentStatus, api, claim, editData, eventually, expireAccessToken, expireFamily, launch,
  newRotationId, openEventStream, owner, pauseAgent, readData, refresh, resumeAgent, revokeAgent, send, waitForMessageStatus, writeData
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
const set = presence => Object.keys(presence).filter(field => presence[field]).sort();

async function ownerConnection(baseUrl, who) {
  const res = await api(baseUrl, `/api/inboxes/${who.inbox.id}/agents`, { session: who.session });
  assert.equal(res.status, 200, res.text);
  assertContract('ownerAgentList', res.payload);
  return res.payload.find(agent => agent.id === who.agent.id).connection;
}
// Waits until the presence write lands. Every field of one write lands in one document write, so
// once `field` is visible the request's other fields are final too.
const waitForPresence = (baseUrl, who, field) => eventually(async () => {
  const connection = await ownerConnection(baseUrl, who);
  return connection.presence[field] ? connection : null;
}, { message: `${field} to be recorded` });

// §3, one row per case, each on a fresh installation whose only agent request is the one under test.
const rows = [
  { name: 'refresh 200', expect: ['lastSeenAt', 'lastSuccessfulRefreshAt'], run: async ({ baseUrl, who }) => assert.equal((await refresh(baseUrl, who.agentRefreshToken, newRotationId())).status, 200) },
  { name: 'claim idle', expect: ['lastSeenAt', 'lastWorkClaimAt'], run: async ({ baseUrl, who }) => assert.equal((await claim(baseUrl, who.agentApiToken)).payload.state, 'idle') },
  { name: 'claim while paused', expect: ['lastSeenAt'], run: async ({ baseUrl, who }) => {
    await pauseAgent(baseUrl, who);
    assert.equal((await claim(baseUrl, who.agentApiToken)).payload.state, 'paused');
  } },
  { name: 'lease request with a non-paused outcome', expect: ['lastSeenAt', 'lastWorkClaimAt'], run: async ({ baseUrl, who }) => {
    const renewed = await api(baseUrl, '/api/agent/work/work_unknown/renew', { token: who.agentApiToken, body: { leaseToken: 'lease_example' } });
    assert.equal(renewed.status, 404, renewed.text);
  } },
  { name: 'other authenticated request (status)', expect: ['lastSeenAt'], run: async ({ baseUrl, who }) => assert.equal((await agentStatus(baseUrl, who.agentApiToken)).status, 200) },
  { name: 'event stream connect', expect: ['lastSeenAt'], run: async ({ server, who }) => {
    const stream = await openEventStream(server, who.inbox.id, who.agentApiToken, { query: '?from=latest' });
    assert.equal(stream.status, 200);
    return () => stream.close();
  } }
];

for (const backend of backends) {
  test(`[${backend.name}] each §3 row writes exactly its fields`, { timeout: 90000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    for (const [index, row] of rows.entries()) {
      const who = await owner(baseUrl, `${backend.suffix}${10 + index}`);
      assert.deepEqual(set((await ownerConnection(baseUrl, who)).presence), [], `${row.name}: enrollment and human requests write nothing`);
      const cleanup = await row.run({ server, baseUrl, who });
      const connection = await waitForPresence(baseUrl, who, 'lastSeenAt');
      assert.deepEqual(set(connection.presence), [...row.expect].sort(), row.name);
      cleanup?.();
    }

    // complete 201 also records processing (it needs work from a second installation).
    const [alice, bob] = await Promise.all([owner(baseUrl, `${backend.suffix}20`), owner(baseUrl, `${backend.suffix}21`)]);
    const sent = await send(baseUrl, alice, bob, { caseId: `case_a5_complete_${backend.suffix}` });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
    const claimed = await claim(baseUrl, bob.agentApiToken);
    assert.equal(claimed.payload.state, 'claimed', claimed.text);
    const done = await api(baseUrl, `/api/agent/work/${claimed.payload.work.workId}/complete`, { token: bob.agentApiToken, key: `a5-complete-${backend.suffix}`, body: { leaseToken: claimed.payload.work.leaseToken } });
    assert.equal(done.status, 201, done.text);
    const processed = await waitForPresence(baseUrl, bob, 'lastProcessedAt');
    assert.ok(processed.presence.lastSeenAt >= processed.presence.lastProcessedAt, 'lastSeenAt leads');
  });

  test(`[${backend.name}] presence follows an installation through setup, work, refresh, pause and revoke`, { timeout: 60000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const bob = await owner(baseUrl, `${backend.suffix}01`);

    const enrolled = await ownerConnection(baseUrl, bob);
    assert.equal(enrolled.state, 'never_seen', 'enrollment is never presence');
    assert.ok(Date.parse(enrolled.credentialExpiresAt) > Date.now(), 'the live family reports its rolling expiry');

    // A setup check reads status: lastSeenAt only, which is not a check-in for an active agent.
    const status = await agentStatus(baseUrl, bob.agentApiToken);
    assertContract('agentStatusWithPresence', status.payload);
    const setupOnly = await waitForPresence(baseUrl, bob, 'lastSeenAt');
    assert.equal(setupOnly.state, 'never_seen', 'setup traffic is not a work-loop check-in');
    assert.equal(setupOnly.seenAt, null);

    await claim(baseUrl, bob.agentApiToken);
    const working = await waitForPresence(baseUrl, bob, 'lastWorkClaimAt');
    assert.equal(working.state, 'seen_recently');
    assert.equal(working.seenAt, working.presence.lastWorkClaimAt);

    // A refresh leads lastSeenAt past its own throttle.
    const rotated = await refresh(baseUrl, bob.agentRefreshToken, newRotationId());
    assert.equal(rotated.status, 200, rotated.text);
    const refreshed = await waitForPresence(baseUrl, bob, 'lastSuccessfulRefreshAt');
    assert.ok(refreshed.presence.lastSeenAt >= refreshed.presence.lastSuccessfulRefreshAt, 'lastSeenAt leads the refresh');

    // The agent's own token on the agents list never sees connection (§4.2).
    const asAgent = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents`, { token: rotated.payload.agentApiToken });
    assert.equal(asAgent.status, 200, asAgent.text);
    assert.ok(asAgent.payload.every(agent => !('connection' in agent)), 'connection is for the owning humans only');

    const paused = await pauseAgent(baseUrl, bob);
    assertContract('ownerAgent', paused);
    assert.equal(paused.connection.seenAt, paused.connection.presence.lastSeenAt, 'paused: the basis is lastSeenAt');

    await revokeAgent(baseUrl, bob);
    const revoked = await ownerConnection(baseUrl, bob);
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.credentialExpiresAt, null);
    assert.ok(revoked.presence.lastWorkClaimAt, 'the last-known presence stays visible');
  });

  test(`[${backend.name}] the resume grace keeps the paused-time basis until the connector claims`, { timeout: 60000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    // This installation never claims before the resume, so without the grace it would be never_seen.
    const bob = await owner(baseUrl, `${backend.suffix}30`);
    await pauseAgent(baseUrl, bob);
    assert.equal((await agentStatus(baseUrl, bob.agentApiToken)).payload.state, 'paused');
    await waitForPresence(baseUrl, bob, 'lastSeenAt');

    const resumed = await resumeAgent(baseUrl, bob);
    assertContract('ownerAgent', resumed);
    assert.ok(resumed.resumedAt, 'resume records resumedAt');
    assert.equal(resumed.connection.presence.lastWorkClaimAt, null);
    assert.equal(resumed.connection.state, 'seen_recently', 'the grace bridges the resume');
    assert.equal(resumed.connection.seenAt, resumed.connection.presence.lastSeenAt);

    await claim(baseUrl, bob.agentApiToken);
    const claimed = await waitForPresence(baseUrl, bob, 'lastWorkClaimAt');
    assert.equal(claimed.seenAt, claimed.presence.lastWorkClaimAt, 'after the first claim the basis is the work loop');
  });
}

// FileStore only. Presence writes run first in, first out and FileStore transactions too, so once a
// later barrier request's presence lands, any write from an earlier request has landed as well.
async function presenceParts(server, who) {
  const index = await readData(server, ...accessCredentialParts(who.agentApiToken));
  return ['auth', 'agent-presence', index.inboxId, index.agentId, `${index.familyId}.json`];
}
async function barrier(server, suffix) {
  const witness = await owner(server.baseUrl, suffix);
  assert.equal((await agentStatus(server.baseUrl, witness.agentApiToken)).status, 200);
  const parts = await presenceParts(server, witness);
  await eventually(() => readData(server, ...parts), { message: 'the barrier write' });
}

test('[FileStore] rejected credentials, model-held tokens and paused lease requests do not count', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;

  // A model-held mcp_read token is not the installation. Its record is written directly so no
  // access-token request comes first.
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

  // A rejected credential never writes (any 401).
  const rejected = await owner(baseUrl, '5302');
  await expireAccessToken(server, rejected.agentApiToken);
  assert.equal((await claim(baseUrl, rejected.agentApiToken)).payload?.code, 'ACCESS_TOKEN_EXPIRED');

  // A paused agent's lease request (409 AGENT_PAUSED) counts for lastSeenAt only.
  const paused = await owner(baseUrl, '5303');
  await pauseAgent(baseUrl, paused);
  const leased = await api(baseUrl, '/api/agent/work/work_example/renew', { token: paused.agentApiToken, body: { leaseToken: 'lease_example' } });
  assert.equal(leased.payload?.code, 'AGENT_PAUSED', leased.text);

  await barrier(server, '5309');
  assert.equal(await readData(server, ...await presenceParts(server, reader)), null, 'mcp_read requests never write presence');
  assert.equal(await readData(server, ...await presenceParts(server, rejected)), null, '401s never write presence');
  const afterPausedLease = await readData(server, ...await presenceParts(server, paused));
  assert.ok(afterPausedLease?.lastSeenAt, 'the paused request was seen');
  assert.equal(afterPausedLease.lastWorkClaimAt, null, 'AGENT_PAUSED is not work-loop activity');
});

test('[FileStore] the throttle and the replay rule hold across a restart', { timeout: 60000 }, async t => {
  let server = await launch();
  t.after(() => server.stop());
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '5401'), owner(server.baseUrl, '5402')]);
  const parts = await presenceParts(server, bob);
  const sent = await send(server.baseUrl, alice, bob, { caseId: 'case_a5_replay' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(server.baseUrl, bob, sent.payload.id, 'delivered');
  const claimed = await claim(server.baseUrl, bob.agentApiToken);
  const complete = () => api(server.baseUrl, `/api/agent/work/${claimed.payload.work.workId}/complete`, { token: bob.agentApiToken, key: 'a5-replay', body: { leaseToken: claimed.payload.work.leaseToken } });
  assert.equal((await complete()).status, 201);
  const first = await eventually(async () => (await readData(server, ...parts))?.lastProcessedAt && readData(server, ...parts), { message: 'processing to be recorded' });

  // A restart empties the per-process cache, so only the stored comparison can hold these back.
  await server.stop(true);
  await editData(server, parts, value => ({ ...value, lastProcessedAt: null }));
  server = await launch({}, server.dataDir);
  assert.equal((await complete()).status, 200, 'an idempotent replay');
  assert.equal((await claim(server.baseUrl, bob.agentApiToken)).payload.state, 'idle');
  await barrier(server, '5409');
  const after = await readData(server, ...parts);
  assert.equal(after.lastProcessedAt, null, 'a replay is not processing');
  assert.equal(after.lastWorkClaimAt, first.lastWorkClaimAt, 'a claim inside 60 s does not move the field');
  assert.equal(after.lastSeenAt, first.lastSeenAt, 'nor does lastSeenAt');
});

test('[FileStore] expiry shows needs_reconnect and removal deletes presence for good', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const bob = await owner(baseUrl, '5501');
  await claim(baseUrl, bob.agentApiToken);
  const parts = await presenceParts(server, bob);
  await eventually(() => readData(server, ...parts), { message: 'presence to exist' });

  await expireFamily(server, bob.agentApiToken);
  assert.equal((await ownerConnection(baseUrl, bob)).state, 'needs_reconnect');

  const removed = await api(baseUrl, agentRoute(bob, 'remove'), { session: bob.session, body: { deleteHistory: false } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(await readData(server, ...parts), null, 'removal deletes presence');
  // The removed agent's credential cannot recreate it (the in-flight-request race is covered by the
  // family guard in test/agent-presence.test.js and test/update-json.test.js).
  await api(baseUrl, '/api/agent/status', { token: bob.agentApiToken });
  await barrier(server, '5509');
  assert.equal(await readData(server, ...parts), null, 'nothing recreates the record');
});
