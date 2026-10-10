// a4-wake v1 (A-2): stream and delta cursor rules, the claim hint and the work.available
// wake reasons, checked against test/contract-fixtures/a4-wake/schemas.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  api, claim, eventually, launch, openEventStream, owner, ownerEvents, pauseAgent, readData, resumeAgent, send,
  waitForMessageStatus, workClaimParts
} from './a3-harness.js';

const schemas = JSON.parse(await readFile(new URL('./contract-fixtures/a4-wake/schemas.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertA4(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}
function assertA4Error(res, code) {
  assert.equal(res.status, schemas['x-codes'][code].status, res.text);
  assertA4('errorEnvelope', res.payload);
  assert.deepEqual([res.payload.code, res.payload.error], [code, code]);
}
const delta = (baseUrl, who, query = '') => api(baseUrl, `/api/inboxes/${who.inbox.id}/events/delta${query}`, { token: who.agentApiToken });
const caseAction = (baseUrl, who, caseId, actionKey) => api(baseUrl, `/api/inboxes/${who.inbox.id}/cases/${caseId}/actions`, { session: who.session, key: `a4-${caseId}-${actionKey}`, body: { actionKey } });
const wakeEvents = async (baseUrl, who) => (await ownerEvents(baseUrl, who)).filter(event => event.type === 'work.available');

test('delta and stream enforce the cursor and limit rules', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const alice = await owner(baseUrl, '4101');
  // Each case read token issuance is an audited event, so the inbox has history to resume through.
  let readToken;
  for (let index = 0; index < 3; index += 1) {
    const issued = await api(baseUrl, '/api/agent/mcp-read-token', { token: alice.agentApiToken, body: {} });
    assert.equal(issued.status, 201, issued.text);
    readToken = issued.payload.mcpAccessToken;
  }

  const first = await delta(baseUrl, alice);
  assert.equal(first.status, 200, first.text);
  assertA4('deltaPage', first.payload);
  assert.ok(first.payload.events.length > 0, 'enrollment produced events');
  const newest = first.payload.nextCursor;
  const earlier = first.payload.events[0].cursor;

  const empty = await delta(baseUrl, alice, `?cursor=${newest}`);
  assert.deepEqual(empty.payload, { events: [], nextCursor: newest, hasMore: false });
  assertA4Error(await delta(baseUrl, alice, '?cursor=not-a-cursor'), 'EVENT_CURSOR_INVALID');
  assertA4Error(await delta(baseUrl, alice, `?cursor=${'9'.repeat(20)}`), 'EVENT_CURSOR_INVALID');
  assertA4Error(await delta(baseUrl, alice, `?cursor=${newest}&limit=500`), 'EVENT_LIMIT_INVALID');
  assertA4Error(await delta(baseUrl, alice, '?limit=0'), 'EVENT_LIMIT_INVALID');

  const malformed = await openEventStream(server, alice.inbox.id, alice.agentApiToken, { headers: { 'last-event-id': 'not-a-cursor' } });
  assertA4Error(malformed, 'EVENT_CURSOR_INVALID');
  const beyond = await openEventStream(server, alice.inbox.id, alice.agentApiToken, { headers: { 'last-event-id': '9'.repeat(20) } });
  assertA4Error(beyond, 'EVENT_CURSOR_INVALID');

  // Resume replays only later events, each with its cursor as the SSE id; ready reports the last one.
  const resumed = await openEventStream(server, alice.inbox.id, alice.agentApiToken, { headers: { 'last-event-id': earlier } });
  const ready = await resumed.waitFor(event => event.event === 'ready', { message: 'ready after resume' });
  const replayed = resumed.events.filter(event => event.id !== undefined);
  assert.ok(replayed.length > 0 && replayed.every(event => event.id > earlier && event.id === event.data.cursor));
  assertA4('readyFrame', ready.data);
  assert.equal(ready.data.cursor, replayed.at(-1).id);
  resumed.close();

  // Last-Event-ID wins over ?cursor=, so an invalid query cursor is ignored.
  const precedence = await openEventStream(server, alice.inbox.id, alice.agentApiToken, { headers: { 'last-event-id': newest }, query: '?cursor=not-a-cursor' });
  assert.equal((await precedence.waitFor(event => event.event === 'ready')).data.cursor, newest);
  precedence.close();

  // from=latest: no history, ready carries the newest cursor as the baseline.
  const latest = await openEventStream(server, alice.inbox.id, alice.agentApiToken, { query: '?from=latest' });
  const latestReady = await latest.waitFor(event => event.event === 'ready');
  assert.equal(latestReady.data.cursor, newest);
  assert.equal(latest.events.filter(event => event.id !== undefined).length, 0, 'no history replayed');
  latest.close();

  // A model-held case read token cannot open the stream or page history.
  assertA4Error(await openEventStream(server, alice.inbox.id, readToken), 'AUTHENTICATION_REQUIRED');
  assertA4Error(await api(baseUrl, `/api/inboxes/${alice.inbox.id}/events/delta`, { token: readToken }), 'AUTHENTICATION_REQUIRED');
});

test('an empty claim hints when retry-delayed work becomes claimable; a paused claim never does', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '4201'), owner(baseUrl, '4202')]);
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a4_hint' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');

  const claimed = await claim(baseUrl, bob.agentApiToken);
  assert.equal(claimed.payload.state, 'claimed', claimed.text);
  const failed = await api(baseUrl, `/api/agent/work/${sent.payload.id}/fail`, { token: bob.agentApiToken, body: { leaseToken: claimed.payload.work.leaseToken, retryable: true } });
  assert.equal(failed.status, 200, failed.text);
  const retryAt = (await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id))).retryAt;

  const idle = await claim(baseUrl, bob.agentApiToken);
  assertA4('claimIdleWithHint', idle.payload);
  assert.ok(idle.payload.nextAvailableInMs > 0 && idle.payload.nextAvailableInMs <= Date.parse(retryAt) - Date.now() + 1000);
  assert.ok(Date.parse(idle.payload.nextAvailableAt) >= Date.now() - 1000, 'never in the past');

  await pauseAgent(baseUrl, bob);
  assertA4('claimPausedNoHint', (await claim(baseUrl, bob.agentApiToken)).payload);
});

test('resuming a paused case wakes the participant with waiting work, without naming the human', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '4301'), owner(baseUrl, '4302')]);
  const caseId = 'case_a4_case_resumed';
  const sent = await send(baseUrl, alice, bob, { caseId });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  assert.equal((await caseAction(baseUrl, bob, caseId, 'pause')).status, 201);
  assert.equal((await claim(baseUrl, bob.agentApiToken)).payload.state, 'idle', 'paused case work is not offered');

  assert.equal((await caseAction(baseUrl, bob, caseId, 'resume')).status, 201);
  const event = await eventually(async () => (await wakeEvents(baseUrl, bob)).find(item => item.reason === 'case_resumed'), { message: 'case_resumed wake' });
  assertA4('workAvailableEvent', event);
  assert.deepEqual([event.agentId, event.caseId], [bob.agent.id, caseId]);
  assert.equal((await wakeEvents(baseUrl, alice)).some(item => item.reason === 'case_resumed'), false, 'alice has no waiting inbound work in the case');
  assert.equal((await claim(baseUrl, bob.agentApiToken)).payload.work?.workId, sent.payload.id);
});

test('resuming a sender wakes the counterparty whose work from it was unclaimable', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '4401'), owner(baseUrl, '4402')]);
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a4_counterparty' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  await pauseAgent(baseUrl, alice);
  assert.equal((await claim(baseUrl, bob.agentApiToken)).payload.state, 'idle', 'work from a sender that cannot act is skipped');

  await resumeAgent(baseUrl, alice);
  const event = await eventually(async () => (await wakeEvents(baseUrl, bob)).find(item => item.reason === 'counterparty_resumed'), { message: 'counterparty_resumed wake' });
  assertA4('workAvailableEvent', event);
  assert.equal(event.agentId, bob.agent.id);
  assert.equal((await claim(baseUrl, bob.agentApiToken)).payload.work?.workId, sent.payload.id);
});

test('a reconnect releases leases held by the replaced installation without using an attempt', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '4501'), owner(baseUrl, '4502')]);
  const sent = await send(baseUrl, alice, bob, { caseId: 'case_a4_lease_released' });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, bob, sent.payload.id, 'delivered');
  const held = await claim(baseUrl, bob.agentApiToken);
  assert.equal(held.payload.state, 'claimed', held.text);
  const before = await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id));

  const token = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/reconnect-token`, { session: bob.session, body: {} });
  assert.equal(token.status, 201, token.text);
  const redeemed = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: token.payload.enrollmentToken } });
  assert.equal(redeemed.status, 200, redeemed.text);

  const event = await eventually(async () => (await wakeEvents(baseUrl, bob)).find(item => item.reason === 'lease_released'), { message: 'lease_released wake' });
  assertA4('workAvailableEvent', event);
  const reclaimed = await claim(baseUrl, redeemed.payload.agentApiToken);
  assert.equal(reclaimed.payload.work?.workId, sent.payload.id, 'claimable immediately, not after the lease expires');
  const after = await readData(server, ...workClaimParts(bob.inbox.id, sent.payload.id));
  assert.equal(after.attempts, before.attempts, 'the released lease did not cost an attempt');
  assert.ok(after.fence > before.fence, 'new fence');
});
