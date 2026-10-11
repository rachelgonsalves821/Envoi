// updateJson (a5-presence §2 "compared in storage"): an atomic read-modify-write in its own
// transaction. Runs on FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';

const backends = [
  { name: 'FileStore', open: async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'envoi-update-json-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new FileStore(dir);
    await store.init();
    return store;
  } },
  ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', open: async t => {
    const { PostgresStore } = await import('../src/postgres-storage.js');
    const store = new PostgresStore(process.env.DATABASE_URL);
    t.after(() => store.close());
    await store.init();
    return store;
  } }] : [])
];
// Advances `value` only upward, like a presence timestamp.
const raiseTo = value => current => ((current?.value ?? -1) < value ? { value } : null);

for (const backend of backends) {
  test(`[${backend.name}] concurrent first writes to one document keep only the highest value`, async t => {
    const store = await backend.open(t);
    const key = `test/update-json/${crypto.randomUUID()}.json`;
    const values = [3, 9, 1, 7, 5, 8, 2, 6];
    await Promise.all(values.map(value => store.updateJson(key, raiseTo(value))));
    assert.deepEqual(await store.getJson(key), { value: 9 });
    assert.deepEqual(await store.updateJson(key, raiseTo(4)), { value: 9 }, 'a lower value leaves the document and returns it');
  });

  test(`[${backend.name}] a rejected guard document skips the write`, async t => {
    const store = await backend.open(t);
    const key = `test/update-json/${crypto.randomUUID()}.json`;
    const guardPath = `test/update-json/${crypto.randomUUID()}-family.json`;
    const guard = { path: guardPath, valid: family => Boolean(family) && !family.revokedAt };
    assert.equal(await store.updateJson(key, raiseTo(1), { guard }), null, 'a missing guard document rejects');
    await store.putJson(guardPath, { revokedAt: '2026-10-11T00:00:00.000Z' });
    assert.equal(await store.updateJson(key, raiseTo(1), { guard }), null, 'a revoked guard document rejects');
    assert.equal(await store.getJson(key), null, 'nothing was written');
    await store.putJson(guardPath, { revokedAt: null });
    assert.deepEqual(await store.updateJson(key, raiseTo(1), { guard }), { value: 1 });
  });

  test(`[${backend.name}] updateJson started inside a transaction commits on its own`, async t => {
    const store = await backend.open(t);
    const key = `test/update-json/${crypto.randomUUID()}.json`;
    const other = `test/update-json/${crypto.randomUUID()}-other.json`;
    let escaped;
    await store.withTransaction([`test:${key}`], async () => {
      escaped = store.updateJson(key, raiseTo(1));
      await store.putJson(other, { ok: true });
      throw new Error('caller rolls back');
    }).catch(() => {});
    assert.deepEqual(await escaped, { value: 1 });
    assert.deepEqual(await store.getJson(key), { value: 1 }, 'not rolled back with the caller');
    assert.equal(await store.getJson(other), null, 'the caller still rolled back');
  });
}
