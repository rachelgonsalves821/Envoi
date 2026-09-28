import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { DeliveryWorker } from '../src/delivery-worker.js';

test('resolved webhook routing locks delivery and failure against inbox mutations', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-webhook-lock-')));
  await store.init();
  const now = store.now();
  await store.enqueueOutbox([], { id: 'webhook_lock', kind: 'emailWebhook', senderInboxId: null, recipientInboxId: null, status: 'queued', attempts: 0, maxAttempts: 2, availableAt: now, createdAt: now, updatedAt: now });
  const key = 'inbox:actual:mutations';
  const casePath = path.join('inboxes', 'actual', 'cases', 'case.json');
  await store.putJson(casePath, { id: 'case', events: [] });
  const claimed = await store.claimOutbox('webhook-test', 30_000);
  store.claimOutbox = async () => claimed;
  let release; let entered; let prepared;
  const held = new Promise(resolve => { release = resolve; });
  const acquired = new Promise(resolve => { entered = resolve; });
  const preparedSignal = new Promise(resolve => { prepared = resolve; });
  const mutation = store.withTransaction([key], async () => {
    entered(); await held;
    await store.putJson(casePath, { id: 'case', events: ['human-change'] });
  });
  await acquired;
  let delivered = false;
  const lockCalls = [];
  const transaction = store.withTransaction.bind(store);
  store.withTransaction = (keys, callback) => { lockCalls.push(keys); return transaction(keys, callback); };
  const worker = new DeliveryWorker({ store, prepare: async () => { prepared(); return { lockKeys: [key], context: { inboxId: 'actual' } }; },
    deliver: async (_record, context) => {
      delivered = true; assert.equal(context.inboxId, 'actual');
      assert.deepEqual((await store.getJson(casePath)).events, ['human-change']);
      throw new Error('test retry');
    },
    onFailure: async (_record, _error, { context }) => {
      assert.equal(context.inboxId, 'actual');
      const value = await store.getJson(casePath); value.events.push('failure-recorded');
      return { documents: [{ path: casePath, value }] };
    }
  });
  const processing = worker.processOne(); await preparedSignal;
  assert.equal(delivered, false);
  release(); await mutation; await processing;
  assert.ok(lockCalls.length >= 2);
  assert.ok(lockCalls.every(keys => keys.includes(key)));
  assert.deepEqual((await store.getJson(casePath)).events, ['human-change', 'failure-recorded']);
});

test('delivery worker retries transient failures, dead-letters, and supports operator replay', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-delivery-test-')));
  await store.init();
  const createdAt = store.now();
  await store.enqueueOutbox([], {
    id: 'delivery_1',
    kind: 'test',
    messageId: 'message_1',
    senderInboxId: 'inbox_sender',
    recipientInboxId: 'inbox_recipient',
    status: 'queued',
    attempts: 0,
    maxAttempts: 2,
    availableAt: createdAt,
    createdAt,
    updatedAt: createdAt
  });

  let shouldFail = true;
  const settled = [];
  const worker = new DeliveryWorker({
    store,
    retryBaseMs: 0,
    retryMaxMs: 0,
    deliver: async () => {
      if (shouldFail) throw new Error('temporary recipient outage');
      return { documents: [], result: { accepted: true } };
    },
    onSettled: record => settled.push(record.status)
  });

  assert.equal(await worker.processOne(), true);
  assert.equal((await store.getOutbox('delivery_1')).status, 'retrying');
  assert.equal((await store.getOutbox('delivery_1')).attempts, 1);
  assert.equal(await worker.processOne(), true);
  const deadLettered = await store.getOutbox('delivery_1');
  assert.equal(deadLettered.status, 'deadLettered');
  assert.equal(deadLettered.attempts, 2);
  assert.match(deadLettered.lastError, /temporary recipient outage/);

  await store.retryOutbox('delivery_1');
  shouldFail = false;
  assert.equal(await worker.processOne(), true);
  const delivered = await store.getOutbox('delivery_1');
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.result.accepted, true);
  assert.deepEqual(settled, ['retrying', 'deadLettered', 'delivered']);
});

test('permanent delivery failures bypass retries and enter the dead-letter queue', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-delivery-permanent-')));
  await store.init();
  const createdAt = store.now();
  await store.enqueueOutbox([], {
    id: 'delivery_permanent',
    kind: 'test',
    messageId: 'message_permanent',
    senderInboxId: 'inbox_sender',
    recipientInboxId: 'inbox_recipient',
    status: 'queued',
    attempts: 0,
    maxAttempts: 5,
    availableAt: createdAt,
    createdAt,
    updatedAt: createdAt
  });
  const worker = new DeliveryWorker({
    store,
    deliver: async () => { throw Object.assign(new Error('recipient blocked sender'), { permanent: true }); }
  });
  await worker.processOne();
  const record = await store.getOutbox('delivery_permanent');
  assert.equal(record.status, 'deadLettered');
  assert.equal(record.attempts, 1);
});

test('outbox preserves order within a conversation while allowing leased workers', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-delivery-order-')));
  await store.init();
  const firstAt = '2026-09-27T10:00:00.000Z';
  const secondAt = '2026-09-27T10:00:01.000Z';
  const base = { kind: 'test', senderInboxId: 'sender', recipientInboxId: 'recipient', orderingKey: 'case_1', status: 'queued', attempts: 0, maxAttempts: 5 };
  await store.enqueueOutbox([], { ...base, id: 'delivery_first', messageId: 'message_first', availableAt: firstAt, createdAt: firstAt, updatedAt: firstAt });
  await store.enqueueOutbox([], { ...base, id: 'delivery_second', messageId: 'message_second', availableAt: secondAt, createdAt: secondAt, updatedAt: secondAt });

  const first = await store.claimOutbox('worker_one');
  assert.equal(first.id, 'delivery_first');
  assert.equal(await store.claimOutbox('worker_two'), null);
  await store.completeOutbox(first.id, [], {}, first);
  const second = await store.claimOutbox('worker_two');
  assert.equal(second.id, 'delivery_second');
});

test('reclaimed delivery lease fences stale settlements and their documents', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-delivery-fence-')));
  await store.init();
  const createdAt = store.now();
  await store.enqueueOutbox([], { id: 'delivery_fenced', kind: 'test', status: 'queued', attempts: 0, maxAttempts: 2, availableAt: createdAt, createdAt, updatedAt: createdAt });
  const original = await store.claimOutbox('worker_one');
  await store.putJson('outbox/delivery_fenced.json', { ...original, lockedAt: '2000-01-01T00:00:00.000Z' });
  const replacement = await store.claimOutbox('worker_two', 1_000);
  assert.notEqual(original.leaseToken, replacement.leaseToken);
  await assert.rejects(() => store.completeOutbox(original.id, [{ path: 'test/stale.json', value: { stale: true } }], {}, original), error => error.code === 'LEASE_LOST');
  await assert.rejects(() => store.failOutbox(original.id, [{ path: 'test/stale.json', value: { stale: true } }], { error: 'old worker', nextAttemptAt: createdAt, lease: original }), error => error.code === 'LEASE_LOST');
  assert.equal(await store.getJson('test/stale.json'), null);
  await store.completeOutbox(replacement.id, [{ path: 'test/current.json', value: { current: true } }], {}, replacement);
  assert.equal((await store.getOutbox(replacement.id)).status, 'delivered');
  assert.deepEqual(await store.getJson('test/current.json'), { current: true });
});
