// a3-pause-auth v1 (A-1): held outbound work and the D1 per-case barrier
// (handoffs.md §3 "Held work", claude-codex-build-plan §1 D1). Test-first.
//
// Making "M1 queued but undelivered at pause time" deterministic:
// native delivery is kicked right after enqueue, so send-then-pause races the
// delivery worker. Each test installs an outbox gate (see installOutboxGate in
// a3-harness.js): a synthetic, never-claimable outbox record with sequence 0 and
// the test's caseId as orderingKey. The existing strict per-orderingKey rule in
// FileStore.claimOutbox keeps every later item of that case in `queued` while
// the gate exists. The test sends M1, pauses the sender, then removes the gate.
// From that point only the server's pause hold can keep M1 undelivered, so a
// delivery observed after gate removal is a real failure, not a race.
// This needs no server hook. On FileStore the gate is an on-disk outbox record;
// on PostgreSQL (run when DATABASE_URL is set, as in CI's test:postgres step) it is
// a row inserted through PostgresStore, which the SQL barrier treats the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  api, assertError, assertSchema, agentStatus, claim, eventually, installOutboxGate, launch, outboxParts, owner,
  ownerEvents, ownerMessages, pauseAgent, readData, resumeAgent, send, sleep, waitForMessageStatus
} from './a3-harness.js';
import { PostgresStore } from '../src/postgres-storage.js';

// Build plan D1 gate: these tests must pass on PostgreSQL and FileStore.
const backends = [{ name: 'FileStore', env: {} }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL } }] : [])];

async function outboxAccess(t, backend, server) {
  if (backend.name === 'FileStore') {
    return {
      gate: caseId => installOutboxGate(server, caseId),
      read: messageId => readData(server, ...outboxParts(messageId))
    };
  }
  const store = new PostgresStore(backend.env.DATABASE_URL);
  t.after(() => store.close());
  return {
    gate: async caseId => {
      const id = `delivery_a3_test_gate_${crypto.randomBytes(6).toString('hex')}`;
      const now = new Date().toISOString();
      await store.enqueueOutbox([], { id, kind: 'nativeAgentMessage', messageId: `msg_${id}`, senderInboxId: 'inbox_a3_test_gate', recipientInboxId: 'inbox_a3_test_gate', orderingKey: caseId, status: 'queued', attempts: 0, maxAttempts: 5, availableAt: '2999-01-01T00:00:00.000Z', createdAt: now, updatedAt: now });
      return { id, remove: () => store.query('DELETE FROM sinaloa_outbox WHERE id = $1', [id]) };
    },
    read: messageId => store.getOutbox(`delivery_${messageId}`)
  };
}

// Long enough for several delivery-worker polls (ENVOI_DELIVERY_POLL_MS defaults to 250 ms).
const SETTLE_MS = 1200;

async function queueBehindGate(outbox, server, from, to, caseId) {
  const gate = await outbox.gate(caseId);
  const sent = await send(server.baseUrl, from, to, { caseId, text: 'M1 queued before the pause' });
  assert.equal(sent.status, 202, sent.text);
  await sleep(600);
  const record = await outbox.read(sent.payload.id);
  assert.equal(record?.status, 'queued', 'harness: the gate keeps M1 queued');
  assert.equal(record.orderingKey, caseId);
  return { gate, m1: sent.payload, outboxBefore: record };
}

async function heldM1(server, who, messageId) {
  return eventually(async () => (await ownerMessages(server.baseUrl, who)).find(item => item.id === messageId && item.status === 'held'), { message: `${messageId} to be held` });
}

for (const backend of backends) {
test(`[${backend.name}] paused sender: AGENT_PAUSED on send; its queued message is held (sender_paused) without using attempts; delivered after resume`, async t => {
  const server = await launch(backend.env);
  t.after(() => server.stop());
  const { baseUrl } = server;
  const outbox = await outboxAccess(t, backend, server);
  const [alice, bob] = await Promise.all([owner(baseUrl, '2101'), owner(baseUrl, '2102')]);
  const caseId = 'case_a3_paused_sender';
  const { gate, m1, outboxBefore } = await queueBehindGate(outbox, server, alice, bob, caseId);

  await pauseAgent(baseUrl, alice);
  assertError(await send(baseUrl, alice, bob, { caseId }), 'AGENT_PAUSED');
  assertError(await send(baseUrl, alice, bob, { caseId: 'case_a3_paused_sender_other' }), 'AGENT_PAUSED');
  await gate.remove();
  await sleep(SETTLE_MS);

  // The paused agent itself can read the held state (fixture sender-paused-held-message).
  const listed = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages?caseId=${caseId}`, { token: alice.agentApiToken });
  assert.equal(listed.status, 200, `paused agent read: ${listed.text}`);
  assertSchema('heldSenderMessageList', listed.payload);
  const held = listed.payload.find(item => item.id === m1.id);
  assert.equal(held?.status, 'held');
  assert.equal(held.heldReason, 'sender_paused');
  assert.ok(!Number.isNaN(Date.parse(held.heldAt)), 'heldAt is a timestamp');
  assert.equal(held.deliveryAttempts ?? 0, outboxBefore.attempts, 'no delivery attempt was consumed');
  const ownerView = (await ownerMessages(baseUrl, alice, caseId)).find(item => item.id === m1.id);
  assert.equal(ownerView?.status, 'held', 'the owner sees the held message');
  assert.equal(ownerView.heldReason, 'sender_paused');

  const heldRecord = await outbox.read(m1.id);
  assert.equal(heldRecord.status, 'held', `held item stays durable, got ${heldRecord.status}`);
  assert.equal(heldRecord.attempts, outboxBefore.attempts, 'outbox attempts unchanged');
  assert.equal(heldRecord.availableAt, outboxBefore.availableAt, 'next-attempt time unchanged (no backoff)');
  assert.equal((await ownerMessages(baseUrl, bob)).some(item => item.id === m1.id), false, 'not delivered while paused');

  await resumeAgent(baseUrl, alice);
  await waitForMessageStatus(baseUrl, bob, m1.id, 'delivered');
  await waitForMessageStatus(baseUrl, alice, m1.id, 'delivered');
});

test(`[${backend.name}] D1 (a): reply behind a held message is accepted as queued, waits, and is delivered after M1 once the sender resumes`, async t => {
  const server = await launch(backend.env);
  t.after(() => server.stop());
  const { baseUrl } = server;
  const outbox = await outboxAccess(t, backend, server);
  const [alice, bob] = await Promise.all([owner(baseUrl, '2201'), owner(baseUrl, '2202')]);
  const caseId = 'case_a3_d1_resume';
  const { gate, m1 } = await queueBehindGate(outbox, server, alice, bob, caseId);
  await pauseAgent(baseUrl, alice);
  await gate.remove();
  await heldM1(server, alice, m1.id);

  const reply = await send(baseUrl, bob, alice, { caseId, text: 'Reply in the same case' });
  assert.equal(reply.status, 202, `the counterparty's reply is accepted like any send: ${reply.text}`);
  assertSchema('sendAccepted', reply.payload);
  assert.equal(reply.payload.status, 'queued');
  for (const field of ['heldReason', 'heldBehindMessageId', 'heldAt']) assert.equal(field in reply.payload, false, `reply response must not reveal ${field}`);
  assert.equal(reply.text.includes(m1.id), false, 'the counterparty never sees the held message id');

  await sleep(SETTLE_MS);
  assert.equal((await ownerMessages(baseUrl, alice)).some(item => item.id === reply.payload.id && item.status === 'delivered'), false, 'reply is not delivered while M1 is held');
  assert.equal((await ownerMessages(baseUrl, bob)).some(item => item.id === m1.id), false, 'M1 is not delivered while paused');
  const counterpartyView = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/messages?caseId=${caseId}`, { token: bob.agentApiToken });
  assert.equal(counterpartyView.status, 200, counterpartyView.text);
  const bobCopy = counterpartyView.payload.find(item => item.id === reply.payload.id);
  assert.ok(bobCopy, 'the counterparty sees its reply');
  assert.ok(!['delivered', 'deadLettered', 'failed'].includes(bobCopy.status), `reply waits, got ${bobCopy.status}`);
  assert.equal('heldBehindMessageId' in bobCopy, false, 'the counterparty never sees a held message id');
  assert.equal(counterpartyView.text.includes(m1.id), false, 'the counterparty view never contains the held message id');

  await resumeAgent(baseUrl, alice);
  await waitForMessageStatus(baseUrl, bob, m1.id, 'delivered');
  await waitForMessageStatus(baseUrl, alice, reply.payload.id, 'delivered');
  // Order: both deliveries emit message.delivered into bob's inbox (recipient of M1, sender of the reply).
  const delivered = (await ownerEvents(baseUrl, bob)).filter(event => event.type === 'message.delivered');
  const m1Event = delivered.find(event => event.messageId === m1.id);
  const replyEvent = delivered.find(event => event.messageId === reply.payload.id);
  assert.ok(m1Event && replyEvent, 'both deliveries are recorded');
  assert.ok(Number(m1Event.sequence) < Number(replyEvent.sequence), 'M1 is delivered before the reply');
});

test(`[${backend.name}] D1 (b): human cancellation of the held message releases the barrier; the reply is delivered and the agent stays paused`, async t => {
  const server = await launch(backend.env);
  t.after(() => server.stop());
  const { baseUrl } = server;
  const outbox = await outboxAccess(t, backend, server);
  const [alice, bob] = await Promise.all([owner(baseUrl, '2301'), owner(baseUrl, '2302')]);
  const caseId = 'case_a3_d1_cancel';
  const { gate, m1 } = await queueBehindGate(outbox, server, alice, bob, caseId);
  await pauseAgent(baseUrl, alice);
  await gate.remove();
  await heldM1(server, alice, m1.id);

  const reply = await send(baseUrl, bob, alice, { caseId, text: 'Reply behind a cancelled message' });
  assert.equal(reply.status, 202, reply.text);
  await sleep(SETTLE_MS);
  assert.equal((await ownerMessages(baseUrl, alice)).some(item => item.id === reply.payload.id && item.status === 'delivered'), false);

  const cancelRoute = `/api/inboxes/${alice.inbox.id}/messages/${m1.id}/cancel`;
  const outsider = await api(baseUrl, cancelRoute, { session: bob.session, body: {} });
  assert.ok([401, 403, 404].includes(outsider.status), `only a workspace manager may cancel, got ${outsider.status}`);
  const cancelled = await api(baseUrl, cancelRoute, { session: alice.session, body: {} });
  assert.equal(cancelled.status, 200, cancelled.text);
  assertSchema('cancelledMessage', cancelled.payload);
  assert.equal(cancelled.payload.id, m1.id);
  assert.equal(cancelled.payload.caseId, caseId);
  assert.equal(cancelled.payload.status, 'cancelled');

  await waitForMessageStatus(baseUrl, alice, reply.payload.id, 'delivered');
  await sleep(SETTLE_MS);
  assert.equal((await ownerMessages(baseUrl, bob)).some(item => item.id === m1.id && item.status === 'delivered'), false, 'cancelled M1 is never delivered');
  assert.equal((await ownerMessages(baseUrl, alice)).find(item => item.id === m1.id)?.status, 'cancelled');

  const event = (await ownerEvents(baseUrl, alice)).find(item => item.type === 'message.cancelled' && item.messageId === m1.id);
  assert.ok(event, 'message.cancelled is published to the cancelling owner inbox');
  assertSchema('messageCancelledEvent', event);
  assert.equal(event.caseId, caseId);
  assert.equal(event.humanId, alice.human.id);

  // Cancellation does not resume the agent.
  assert.deepEqual((await claim(baseUrl, alice.agentApiToken)).payload, { work: null, state: 'paused' });
  const status = await agentStatus(baseUrl, alice.agentApiToken);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.payload.state, 'paused');
});

for (const ending of ['revoke', 'remove']) {
  test(`[${backend.name}] ${ending} while paused cancels held sends so the counterparty's case is released`, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const outbox = await outboxAccess(t, backend, server);
    const suffix = ending === 'revoke' ? '2401' : '2501';
    const [alice, bob] = await Promise.all([owner(baseUrl, suffix), owner(baseUrl, String(Number(suffix) + 1))]);
    const caseId = `case_a3_${ending}_held`;
    const { gate, m1 } = await queueBehindGate(outbox, server, alice, bob, caseId);
    await pauseAgent(baseUrl, alice);
    await gate.remove();
    await heldM1(server, alice, m1.id);
    const reply = await send(baseUrl, bob, alice, { caseId, text: 'Reply behind a held message' });
    assert.equal(reply.status, 202, reply.text);
    await sleep(SETTLE_MS);
    assert.notEqual((await outbox.read(reply.payload.id)).status, 'delivered', 'the reply waits behind M1');

    // Resume is impossible after either action, so the held message must not keep blocking the case.
    const route = ending === 'revoke'
      ? `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/credentials/revoke`
      : `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/remove`;
    const ended = await api(baseUrl, route, { session: alice.session, body: ending === 'revoke' ? {} : { deleteHistory: false } });
    assert.equal(ended.status, 200, ended.text);
    assert.equal((await outbox.read(m1.id)).status, 'cancelled');
    // The reply is no longer blocked. Its recipient is now gone, so it settles as a dead letter.
    await eventually(async () => (await outbox.read(reply.payload.id))?.status === 'deadLettered', { message: 'reply released from the barrier and settled' });
    assert.equal((await ownerMessages(baseUrl, bob)).some(item => item.id === m1.id), false, 'the cancelled message is never delivered');
  });
}
}
