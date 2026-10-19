// http-wake v1 §6.5: a notification is written in the same transaction as its trigger. The server
// queues a delivery's wake while delivering, so anything written there must commit with the
// delivery's settlement or not at all. Shared by the FileStore and PostgreSQL tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DeliveryWorker } from '../src/delivery-worker.js';

export async function assertDeliveryWritesCommitWithSettlement(store, { expireLease }) {
  const prefix = `test/${crypto.randomUUID()}`;
  const enqueue = async (id, maxAttempts = 3) => {
    const createdAt = new Date().toISOString();
    await store.enqueueOutbox([], { id, kind: 'test', status: 'queued', attempts: 0, maxAttempts, availableAt: createdAt, createdAt, updatedAt: createdAt });
  };
  const wakePath = id => `${prefix}/wake-${id}.json`;
  // Stands in for httpWake.trigger: a store write made while delivering, before the settlement.
  const deliver = async record => { await store.putJson(wakePath(record.id), { wake: record.id }); return { documents: [], result: {} }; };
  const processClaimed = async record => {
    store.claimOutbox = async () => record;
    try { return await new DeliveryWorker({ store, deliver }).processOne(); } finally { delete store.claimOutbox; }
  };
  const claim = async (id, workerId, leaseMs) => {
    const record = await store.claimOutbox(workerId, leaseMs);
    assert.equal(record?.id, id, `claimed ${id}`);
    return record;
  };

  const committed = `delivery_${crypto.randomUUID()}`;
  await enqueue(committed);
  assert.equal(await processClaimed(await claim(committed, 'worker_one')), true);
  assert.equal((await store.getOutbox(committed)).status, 'delivered');
  assert.deepEqual(await store.getJson(wakePath(committed)), { wake: committed }, 'the wake commits with the delivery');

  // A worker whose lease was taken over cannot settle; its wake is rolled back with the delivery.
  const fenced = `delivery_${crypto.randomUUID()}`;
  await enqueue(fenced);
  const original = await claim(fenced, 'worker_one');
  await expireLease(original);
  const replacement = await claim(fenced, 'worker_two', 1_000);
  assert.equal(await processClaimed(original), true);
  assert.equal(await store.getJson(wakePath(fenced)), null, 'a delivery that lost its lease never wakes');
  await store.completeOutbox(fenced, [], {}, replacement);

  // A settlement that fails records the failure instead; the wake is rolled back.
  const rejected = `delivery_${crypto.randomUUID()}`;
  await enqueue(rejected, 1);
  const record = await claim(rejected, 'worker_one');
  store.completeOutbox = async () => { throw new Error('settlement failed'); };
  try { assert.equal(await processClaimed(record), true); } finally { delete store.completeOutbox; }
  assert.equal((await store.getOutbox(rejected)).status, 'deadLettered');
  assert.equal(await store.getJson(wakePath(rejected)), null, 'a failed delivery never wakes');
}
