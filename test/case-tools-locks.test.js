import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileStore } from '../src/storage.js';
import { PostgresStore } from '../src/postgres-storage.js';

for (const backend of ['file', 'postgres']) {
  test(`${backend}: timed-out transaction never runs later and the lock queue recovers`, { skip: backend === 'postgres' && !process.env.DATABASE_URL }, async t => {
    const root = backend === 'file' ? await mkdtemp(path.join(tmpdir(), 'envoi-tool-lock-')) : null;
    const store = root ? new FileStore(root) : new PostgresStore(process.env.DATABASE_URL);
    await store.init();
    t.after(async () => { if (store.close) await store.close(); if (root) await rm(root, { recursive: true, force: true }); });
    const key = `test:tool-lock:${crypto.randomUUID()}`;
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const holder = store.withTransaction([key], async () => { started(); await barrier; });
    await ready;
    let ran = false;
    try { await assert.rejects(store.withTransaction([key], async () => { ran = true; }, { lockWaitMs: 40 }), error => ['LOCK_TIMEOUT', '55P03'].includes(error.code)); }
    finally { release(); await holder; }
    await store.withTransaction([key], async () => assert.equal(ran, false), { lockWaitMs: 500 });
  });
}
