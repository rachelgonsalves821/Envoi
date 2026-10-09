import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { operationalBacklogSnapshot } from '../src/operational-backlog.js';
import { FileStore } from '../src/storage.js';

test('file-backed outbox logs only aggregate backlog and age', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-backlog-')));
  await store.init();
  await store.putJson('outbox/delivery_1.json', { id: 'delivery_1', status: 'queued', createdAt: '2026-09-29T00:00:00.000Z', senderInboxId: 'secret-tenant', lastError: 'private content' });
  await store.putJson('outbox/delivery_2.json', { id: 'delivery_2', status: 'deadLettered', createdAt: '2026-09-29T00:01:00.000Z' });
  // Held for a paused sender: counted, but it does not age the pending backlog.
  await store.putJson('outbox/delivery_3.json', { id: 'delivery_3', status: 'held', createdAt: '2026-09-28T00:00:00.000Z' });
  const snapshot = await operationalBacklogSnapshot({ store, at: new Date('2026-09-29T00:02:00.000Z') });
  assert.deepEqual(snapshot, {
    event: 'sinaloa.operational_backlog',
    at: '2026-09-29T00:02:00.000Z',
    outbox: { queued: 1, retrying: 0, processing: 0, held: 1, deadLettered: 1, oldestPendingAgeSeconds: 120 },
    scans: null
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-tenant|private content|delivery_1/);
});

test('PostgreSQL-backed outbox and scans use aggregate queries', async () => {
  const queries = [];
  const store = { query: async statement => {
    queries.push(statement);
    return { rows: [{ status: 'retrying', count: '2', oldestCreatedAt: '2026-09-29T00:00:00.000Z' }, { status: 'deadLettered', count: 1, oldestCreatedAt: '2026-09-28T00:00:00.000Z' }] };
  } };
  const scanJobStore = { query: async statement => {
    queries.push(statement);
    return { rows: [{ status: 'processing', count: 1, oldestCreatedAt: '2026-09-29T00:01:00.000Z' }] };
  } };
  const snapshot = await operationalBacklogSnapshot({ store, scanJobStore, at: new Date('2026-09-29T00:02:00.000Z') });
  assert.equal(snapshot.outbox.retrying, 2);
  assert.equal(snapshot.outbox.oldestPendingAgeSeconds, 120);
  assert.equal(snapshot.scans.processing, 1);
  assert.equal(snapshot.scans.oldestPendingAgeSeconds, 60);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(statement => /count\(\*\)/.test(statement)));
});
