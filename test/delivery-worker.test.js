import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { DeliveryWorker } from '../src/delivery-worker.js';

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
  await store.completeOutbox(first.id, []);
  const second = await store.claimOutbox('worker_two');
  assert.equal(second.id, 'delivery_second');
});
