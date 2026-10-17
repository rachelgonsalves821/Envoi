import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';

async function createStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sinaloa-transaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  return store;
}

test('file transactions serialize mutations and roll back staged documents', async t => {
  const store = await createStore(t);
  await store.putJson('test/count.json', { count: 0 });
  await Promise.all(Array.from({ length: 8 }, () => store.withTransaction(['test/count'], async () => {
    const current = await store.getJson('test/count.json');
    await store.withTransaction(['test/count'], () => store.putJson('test/count.json', { count: current.count + 1 }));
  })));
  assert.deepEqual(await store.getJson('test/count.json'), { count: 8 });
  await assert.rejects(() => store.withTransaction(['test/count'], async () => {
    await store.putJsonBatch([{ path: 'test/count.json', value: { count: 99 } }, { path: 'test/new.json', value: { created: true } }]);
    throw new Error('abort');
  }), /abort/);
  assert.deepEqual(await store.getJson('test/count.json'), { count: 8 });
  assert.equal(await store.getJson('test/new.json'), null);
});

test('file reads see committed transaction contents and stable compound pages', async t => {
  const store = await createStore(t);
  let begin;
  const entered = new Promise(resolve => { begin = resolve; });
  let finish;
  const release = new Promise(resolve => { finish = resolve; });
  const pending = store.withTransaction(['test/history'], async () => {
    await store.putJson('test/history/one.json', { id: 'one', createdAt: '2026-01-01T00:00:00.000Z' });
    begin();
    await release;
    await store.putJson('test/history/two.json', { id: 'two', createdAt: '2026-01-01T00:00:00.000Z' });
  });
  await entered;
  const observed = store.countJson('test/history');
  finish();
  await pending;
  assert.equal(await observed, 2);
  const newest = await store.queryJson('test/history', { limit: 1 });
  assert.deepEqual(newest.map(item => item.id), ['two']);
  const older = await store.queryJson('test/history', { limit: 1, before: { value: newest[0].createdAt, id: newest[0].id } });
  assert.deepEqual(older.map(item => item.id), ['one']);
  const forward = await store.queryJson('test/history', { limit: 1, after: { value: older[0].createdAt, id: older[0].id }, order: 'asc' });
  assert.deepEqual(forward.map(item => item.id), ['two']);
});

// Another process reading a document (a test fixture, an antivirus or indexer scan) holds it open.
// Windows then refuses the atomic replace, which once left a delivery stuck until its lease expired.
test('a document held open by a reader is still replaced', { skip: process.platform !== 'win32' && 'Windows-only file locking' }, async t => {
  const store = await createStore(t);
  await store.putJson('test/held.json', { version: 1 });
  const reader = await open(store.file('test/held.json'), 'r');
  setTimeout(() => { void reader.close(); }, 100);
  await store.putJson('test/held.json', { version: 2 });
  assert.deepEqual(await store.getJson('test/held.json'), { version: 2 });
});
