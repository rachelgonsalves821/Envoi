import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PostgresStore } from '../src/postgres-storage.js';

test('PostgreSQL store preserves atomic and paginated document semantics', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const prefix = `test/${crypto.randomUUID()}`;
  await store.putJson(`${prefix}/messages/one.json`, { id: 'one', caseId: 'case-a', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.putJson(`${prefix}/messages/two.json`, { id: 'two', caseId: 'case-a', createdAt: '2026-01-02T00:00:00.000Z' });
  assert.equal((await store.getJson(`${prefix}/messages/one.json`)).id, 'one');
  assert.equal(await store.putJsonIfAbsent(`${prefix}/identity.json`, { state: 'reserved' }), true);
  assert.equal(await store.putJsonIfAbsent(`${prefix}/identity.json`, { state: 'overwritten' }), false);
  await store.putJson(`${prefix}/token.json`, { usedAt: null, value: 'secret' });
  assert.equal((await store.claimJson(`${prefix}/token.json`, 'usedAt', '2026-01-03T00:00:00.000Z')).usedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(await store.claimJson(`${prefix}/token.json`, 'usedAt', 'later'), null);
  const outboxId = `delivery_${crypto.randomUUID()}`;
  const outboxCreatedAt = new Date().toISOString();
  const queued = await store.enqueueOutbox([
    { path: `${prefix}/messages/queued.json`, value: { id: 'queued', status: 'queued' } }
  ], { id: outboxId, kind: 'test', messageId: 'queued', senderInboxId: 'sender', recipientInboxId: 'recipient', status: 'queued', attempts: 0, maxAttempts: 2, availableAt: outboxCreatedAt, createdAt: outboxCreatedAt, updatedAt: outboxCreatedAt });
  assert.equal(queued.enqueueCreated, true);
  assert.equal((await store.getJson(`${prefix}/messages/queued.json`)).status, 'queued');
  const claimed = await store.claimOutbox('postgres-test-worker');
  assert.equal(claimed.id, outboxId);
  assert.equal(claimed.status, 'processing');
  await store.completeOutbox(outboxId, [{ path: `${prefix}/messages/queued.json`, value: { id: 'queued', status: 'delivered' } }], { receiptId: 'receipt_1' });
  assert.equal((await store.getOutbox(outboxId)).status, 'delivered');
  assert.equal((await store.getJson(`${prefix}/messages/queued.json`)).status, 'delivered');
  const first = await store.queryJson(`${prefix}/messages`, { limit: 1, filters: { caseId: 'case-a' } });
  assert.deepEqual(first.map(item => item.id), ['two']);
  const second = await store.queryJson(`${prefix}/messages`, { limit: 1, before: first[0].createdAt, filters: { caseId: 'case-a' } });
  assert.deepEqual(second.map(item => item.id), ['one']);
  assert.equal(await store.deleteJson(`${prefix}/messages/one.json`), true);
  assert.equal(await store.getJson(`${prefix}/messages/one.json`), null);
});
