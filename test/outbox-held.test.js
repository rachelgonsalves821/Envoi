import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';

const past = '2026-01-01T00:00:00.000Z';
const future = '2999-01-01T00:00:00.000Z';

async function createStore() {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-outbox-held-')));
  await store.init();
  return store;
}

function record(id, { sender = 'inbox_sender', key = 'case_one', availableAt = past } = {}) {
  return { id, kind: 'test', messageId: id, senderInboxId: sender, recipientInboxId: 'inbox_recipient', orderingKey: key, status: 'queued', attempts: 0, maxAttempts: 5, availableAt, createdAt: availableAt, updatedAt: availableAt };
}

const enqueue = (store, id, options) => store.enqueueOutbox([], record(id, options));
const heldFields = value => [value.heldReason, value.heldAt, value.heldFromStatus];

test('holding a claimed record needs the current lease and does not consume an attempt', async () => {
  const store = await createStore();
  await enqueue(store, 'first');
  const claimed = await store.claimOutbox('worker_one');
  assert.equal(claimed.id, 'first');

  await assert.rejects(() => store.holdOutbox('first', [{ path: 'docs/stale.json', value: { stale: true } }], { reason: 'sender_paused', lease: { ...claimed, leaseToken: 'wrong' } }), error => error.code === 'LEASE_LOST' && error.statusCode === 409);
  await assert.rejects(() => store.holdOutbox('first', [], { reason: 'sender_paused' }), error => error.code === 'LEASE_LOST');
  assert.equal(await store.getJson('docs/stale.json'), null);
  assert.equal((await store.getOutbox('first')).status, 'processing');

  const held = await store.holdOutbox('first', [{ path: 'docs/held.json', value: { status: 'held' } }], { reason: 'sender_paused', lease: claimed });
  assert.equal(held.status, 'held');
  assert.equal(held.attempts, 0);
  assert.equal(held.availableAt, past);
  assert.equal(held.heldReason, 'sender_paused');
  assert.equal(held.heldFromStatus, 'queued');
  assert.ok(!Number.isNaN(Date.parse(held.heldAt)));
  assert.equal(held.lockedAt, null);
  assert.equal(held.lockedBy, null);
  assert.equal(held.leaseToken, null);
  assert.deepEqual(await store.getOutbox('first'), held);
  assert.deepEqual(await store.getJson('docs/held.json'), { status: 'held' });
  await assert.rejects(() => store.holdOutbox('first', [], { reason: 'sender_paused', lease: claimed }), error => error.code === 'LEASE_LOST');

  await enqueue(store, 'second', { key: 'case_two' });
  const firstAttempt = await store.claimOutbox('worker_one');
  assert.equal(firstAttempt.id, 'second');
  await store.failOutbox('second', [], { error: 'timeout', nextAttemptAt: past, lease: firstAttempt });
  const secondAttempt = await store.claimOutbox('worker_one');
  assert.equal(secondAttempt.id, 'second');
  const heldRetry = await store.holdOutbox('second', [], { reason: 'sender_paused', lease: secondAttempt });
  assert.equal(heldRetry.attempts, 1);
  assert.equal(heldRetry.heldFromStatus, 'retrying');
  assert.equal(heldRetry.lastError, 'timeout');
  assert.equal(heldRetry.availableAt, past);
});

test('a held record is never claimed and blocks only later records with the same ordering key', async () => {
  const store = await createStore();
  await enqueue(store, 'paused', { sender: 'inbox_paused', key: 'case_one' });
  await enqueue(store, 'reply', { sender: 'inbox_active', key: 'case_one' });
  await enqueue(store, 'other', { sender: 'inbox_active', key: 'case_two' });
  await store.holdQueuedOutbox({ senderInboxId: 'inbox_paused', reason: 'sender_paused' });

  const claimed = await store.claimOutbox('worker_one');
  assert.equal(claimed.id, 'other');
  await store.completeOutbox('other', [], {}, claimed);
  assert.equal(await store.claimOutbox('worker_one', 0), null);
  assert.equal((await store.getOutbox('paused')).status, 'held');
  assert.equal((await store.getOutbox('reply')).status, 'queued');
});

test('holdQueuedOutbox holds only the sender queued and retrying records', async () => {
  const store = await createStore();
  await enqueue(store, 'done', { key: 'case_done' });
  const done = await store.claimOutbox('worker_one');
  await store.completeOutbox('done', [], {}, done);
  await enqueue(store, 'retrying', { key: 'case_retry' });
  const retrying = await store.claimOutbox('worker_one');
  await store.failOutbox('retrying', [], { error: 'timeout', nextAttemptAt: future, lease: retrying });
  await enqueue(store, 'processing', { key: 'case_processing' });
  const processing = await store.claimOutbox('worker_one');
  assert.equal(processing.id, 'processing');
  await enqueue(store, 'queued', { key: 'case_queued' });
  await enqueue(store, 'foreign', { sender: 'inbox_other', key: 'case_foreign' });

  const heldAt = '2026-02-01T00:00:00.000Z';
  const held = await store.holdQueuedOutbox({ senderInboxId: 'inbox_sender', reason: 'sender_paused', heldAt });
  assert.deepEqual(held.map(value => value.id), ['retrying', 'queued']);
  assert.deepEqual(held.map(value => value.heldFromStatus), ['retrying', 'queued']);
  assert.ok(held.every(value => value.status === 'held' && value.heldReason === 'sender_paused' && value.heldAt === heldAt));

  const storedRetry = await store.getOutbox('retrying');
  assert.equal(storedRetry.status, 'held');
  assert.equal(storedRetry.attempts, 1);
  assert.equal(storedRetry.availableAt, future);
  assert.equal((await store.getOutbox('queued')).availableAt, past);
  assert.equal((await store.getOutbox('processing')).status, 'processing');
  assert.equal((await store.getOutbox('done')).status, 'delivered');
  assert.equal((await store.getOutbox('foreign')).status, 'queued');
  assert.deepEqual(heldFields(await store.getOutbox('foreign')), [undefined, undefined, undefined]);
  assert.deepEqual(await store.holdQueuedOutbox({ senderInboxId: 'inbox_nobody', reason: 'sender_paused' }), []);
});

test('releasing held records restores their status and delivers in sequence order', async () => {
  const store = await createStore();
  await enqueue(store, 'first', { key: 'case_one' });
  const attempt = await store.claimOutbox('worker_one');
  await store.failOutbox('first', [], { error: 'timeout', nextAttemptAt: past, lease: attempt });
  await enqueue(store, 'second', { key: 'case_one' });
  await enqueue(store, 'reply', { sender: 'inbox_active', key: 'case_one' });
  await store.holdQueuedOutbox({ senderInboxId: 'inbox_sender', reason: 'sender_paused' });
  assert.equal(await store.claimOutbox('worker_one'), null);

  const released = await store.releaseHeldOutbox({ senderInboxId: 'inbox_sender' });
  assert.deepEqual(released.map(value => [value.id, value.status, value.attempts]), [['first', 'retrying', 1], ['second', 'queued', 0]]);
  for (const value of released) {
    assert.deepEqual(heldFields(value), [undefined, undefined, undefined]);
    assert.equal(value.availableAt, past);
    assert.deepEqual(await store.getOutbox(value.id), value);
  }
  assert.deepEqual(await store.releaseHeldOutbox({ senderInboxId: 'inbox_sender' }), []);

  const delivered = [];
  for (let claimed = await store.claimOutbox('worker_one'); claimed; claimed = await store.claimOutbox('worker_one')) {
    delivered.push(claimed.id);
    await store.completeOutbox(claimed.id, [], {}, claimed);
  }
  assert.deepEqual(delivered, ['first', 'second', 'reply']);
});

test('cancelling a held record releases the barrier and cancelling anything else is a no-op', async () => {
  const store = await createStore();
  await enqueue(store, 'paused', { key: 'case_one' });
  await enqueue(store, 'reply', { sender: 'inbox_active', key: 'case_one' });
  await store.holdQueuedOutbox({ senderInboxId: 'inbox_sender', reason: 'sender_paused' });

  assert.equal(await store.cancelHeldOutbox('reply', [{ path: 'docs/reply.json', value: { status: 'cancelled' } }]), null);
  assert.equal(await store.getJson('docs/reply.json'), null);
  assert.equal((await store.getOutbox('reply')).status, 'queued');
  assert.equal(await store.cancelHeldOutbox('missing'), null);
  assert.equal(await store.claimOutbox('worker_one'), null);

  const cancelled = await store.cancelHeldOutbox('paused', [{ path: 'docs/paused.json', value: { status: 'cancelled' } }]);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!Number.isNaN(Date.parse(cancelled.cancelledAt)));
  assert.deepEqual(heldFields(cancelled), [undefined, undefined, undefined]);
  assert.equal(cancelled.attempts, 0);
  assert.deepEqual(await store.getOutbox('paused'), cancelled);
  assert.deepEqual(await store.getJson('docs/paused.json'), { status: 'cancelled' });
  assert.equal(await store.cancelHeldOutbox('paused'), null);

  const claimed = await store.claimOutbox('worker_one');
  assert.equal(claimed.id, 'reply');
});

test('queryOutbox filters by ordering key and sender inbox', async () => {
  const store = await createStore();
  await enqueue(store, 'one', { sender: 'inbox_a', key: 'case_one' });
  await enqueue(store, 'two', { sender: 'inbox_b', key: 'case_one' });
  await enqueue(store, 'three', { sender: 'inbox_a', key: 'case_two' });
  await store.holdQueuedOutbox({ senderInboxId: 'inbox_a', reason: 'sender_paused' });
  const ids = values => values.map(value => value.id).sort();

  assert.deepEqual(ids(await store.queryOutbox()), ['one', 'three', 'two']);
  assert.deepEqual(ids(await store.queryOutbox({ orderingKey: 'case_one' })), ['one', 'two']);
  assert.deepEqual(ids(await store.queryOutbox({ senderInboxId: 'inbox_a' })), ['one', 'three']);
  assert.deepEqual(ids(await store.queryOutbox({ orderingKey: 'case_one', senderInboxId: 'inbox_a' })), ['one']);
  assert.deepEqual(ids(await store.queryOutbox({ senderInboxId: 'inbox_a', status: 'held' })), ['one', 'three']);
  assert.deepEqual(ids(await store.queryOutbox({ orderingKey: 'case_one', status: 'queued' })), ['two']);
  assert.deepEqual(ids(await store.queryOutbox({ inboxId: 'inbox_recipient', orderingKey: 'case_two' })), ['three']);
  assert.deepEqual(await store.queryOutbox({ orderingKey: 'case_missing' }), []);
});
