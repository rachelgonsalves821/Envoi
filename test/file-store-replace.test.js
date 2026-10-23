import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';

const windowsOnly = { skip: process.platform !== 'win32' && 'real held-reader replacement is a Windows file-sharing behaviour' };
const past = '2026-01-01T00:00:00.000Z';
const fsError = (code, syscall = 'rename') => Object.assign(new Error(`${code}: simulated ${syscall}`), { code, syscall });

async function createStore(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-file-store-replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root, options);
  await store.init();
  return store;
}

// Wraps the real rename so a test can observe attempts without changing behaviour.
function countingRename() {
  const calls = [];
  const renameFile = async (from, to) => { calls.push({ from, to }); return rename(from, to); };
  return { calls, renameFile };
}

const files = async target => (await readdir(path.dirname(target))).sort();

async function holdReader(t, target) {
  const handle = await open(target, 'r');
  let closed = false;
  const release = async () => { if (!closed) { closed = true; await handle.close(); } };
  t.after(release);
  return release;
}

test('real Windows held reader: replacement succeeds once the reader is released during bounded retry', windowsOnly, async t => {
  const { calls, renameFile } = countingRename();
  let release;
  const sleeps = [];
  const store = await createStore(t, { renameFile, sleep: async delay => { sleeps.push(delay); await release(); } });
  await store.putJson('outbox/a.json', { status: 'processing', attempts: 0 });
  const target = store.file('outbox/a.json');
  release = await holdReader(t, target);
  calls.length = 0;
  await store.putJson('outbox/a.json', { status: 'deadLettered', attempts: 1 });
  assert.deepEqual(await store.getJson('outbox/a.json'), { status: 'deadLettered', attempts: 1 });
  assert.equal(calls.length, 2, 'one failed and one successful rename');
  assert.equal(calls[0].from, calls[1].from, 'the same prepared temporary file is reused');
  assert.equal(sleeps.length, 1);
  assert.deepEqual(await files(target), ['a.json']);
});

test('real Windows held reader: exhaustion propagates EPERM, keeps previous JSON and removes the temporary file', windowsOnly, async t => {
  const { calls, renameFile } = countingRename();
  const delays = [1, 2, 3];
  const slept = [];
  const store = await createStore(t, { renameFile, replaceRetryDelaysMs: delays, sleep: async delay => { slept.push(delay); } });
  await store.putJson('outbox/a.json', { status: 'processing', attempts: 0 });
  const target = store.file('outbox/a.json');
  const release = await holdReader(t, target);
  calls.length = 0;
  await assert.rejects(() => store.putJson('outbox/a.json', { status: 'deadLettered', attempts: 1 }), error => error.code === 'EPERM' && error.syscall === 'rename');
  assert.equal(calls.length, delays.length + 1);
  assert.deepEqual(slept, delays);
  assert.deepEqual(await store.getJson('outbox/a.json'), { status: 'processing', attempts: 0 });
  assert.deepEqual(await files(target), ['a.json']);
  await release();
  await store.putJson('outbox/a.json', { status: 'deadLettered', attempts: 1 });
  assert.deepEqual(await store.getJson('outbox/a.json'), { status: 'deadLettered', attempts: 1 });
  assert.deepEqual(await files(target), ['a.json']);
});

test('outbox attempt accounting is unchanged when the settlement replacement is delayed by a held reader', windowsOnly, async t => {
  let release;
  const store = await createStore(t, { sleep: async () => { await release(); } });
  await store.enqueueOutbox([], { id: 'one', kind: 'test', messageId: 'one', senderInboxId: 's', recipientInboxId: 'r', orderingKey: 'case_one', status: 'queued', attempts: 0, maxAttempts: 5, availableAt: past, createdAt: past, updatedAt: past });
  const claimed = await store.claimOutbox('worker_one');
  release = await holdReader(t, store.file('outbox/one.json'));
  const failed = await store.failOutbox('one', [{ path: 'docs/side-effect.json', value: { ok: true } }], { error: 'timeout', nextAttemptAt: past, lease: claimed });
  assert.equal(failed.attempts, 1);
  assert.equal(failed.status, 'retrying');
  assert.equal((await store.getOutbox('one')).attempts, 1);
  assert.deepEqual(await store.getJson('docs/side-effect.json'), { ok: true });
  await assert.rejects(() => store.failOutbox('one', [], { error: 'again', nextAttemptAt: past, lease: claimed }), error => error.code === 'LEASE_LOST');
  assert.equal((await store.getOutbox('one')).attempts, 1);
});

test('outbox exhaustion keeps the lease and attempts, and the identical settlement then succeeds exactly once', windowsOnly, async t => {
  const store = await createStore(t, { replaceRetryDelaysMs: [1, 1], sleep: async () => {} });
  await store.enqueueOutbox([], { id: 'one', kind: 'test', messageId: 'one', senderInboxId: 's', recipientInboxId: 'r', orderingKey: 'case_one', status: 'queued', attempts: 0, maxAttempts: 5, availableAt: past, createdAt: past, updatedAt: past });
  const claimed = await store.claimOutbox('worker_one');
  const release = await holdReader(t, store.file('outbox/one.json'));
  const settle = () => store.failOutbox('one', [{ path: 'docs/side-effect.json', value: { ok: true } }], { error: 'recipient rejected', nextAttemptAt: past, forceDeadLetter: true, lease: claimed });
  await assert.rejects(settle, error => error.code === 'EPERM');
  const unchanged = await store.getOutbox('one');
  assert.equal(unchanged.status, 'processing');
  assert.equal(unchanged.attempts, 0);
  assert.equal(unchanged.leaseToken, claimed.leaseToken);
  assert.equal(await store.getJson('docs/side-effect.json'), null, 'the transaction rolled back the sibling document');
  await release();
  const settled = await settle();
  assert.equal(settled.status, 'deadLettered');
  assert.equal(settled.attempts, 1);
  assert.deepEqual(await store.getJson('docs/side-effect.json'), { ok: true });
});

test('win32 retries EPERM and EBUSY on the same temporary file until rename succeeds', async t => {
  for (const code of ['EPERM', 'EBUSY']) {
    const calls = [];
    const slept = [];
    const store = await createStore(t, {
      platform: 'win32',
      replaceRetryDelaysMs: [4, 8, 16],
      sleep: async delay => { slept.push(delay); },
      renameFile: async (from, to) => { calls.push(from); if (calls.length < 3) throw fsError(code); return rename(from, to); }
    });
    await store.putJson('docs/a.json', { version: 1 });
    calls.length = 0;
    slept.length = 0;
    await store.putJson('docs/a.json', { version: 2 });
    assert.equal(calls.length, 3, code);
    assert.equal(new Set(calls).size, 1, 'one prepared temporary file');
    assert.deepEqual(slept, [4, 8]);
    assert.deepEqual(await store.getJson('docs/a.json'), { version: 2 });
    assert.deepEqual(await files(store.file('docs/a.json')), ['a.json']);
  }
});

test('win32 exhaustion performs a bounded number of renames, surfaces the last error and preserves previous JSON', async t => {
  let calls = 0;
  const store = await createStore(t, {
    platform: 'win32',
    replaceRetryDelaysMs: [1, 1, 1, 1],
    sleep: async () => {},
    renameFile: async (from, to) => { calls += 1; if (calls === 1) return rename(from, to); throw fsError('EPERM'); }
  });
  await store.putJson('docs/a.json', { version: 1 });
  calls = 1;
  await assert.rejects(() => store.putJson('docs/a.json', { version: 2 }), error => error.code === 'EPERM');
  assert.equal(calls, 1 + 5);
  assert.deepEqual(await store.getJson('docs/a.json'), { version: 1 });
  assert.deepEqual(await files(store.file('docs/a.json')), ['a.json']);
});

test('permanent errors are not retried on win32 and leave previous JSON with no temporary file', async t => {
  for (const code of ['ENOSPC', 'EACCES', 'EIO', 'EXDEV']) {
    let calls = 0;
    const slept = [];
    const store = await createStore(t, {
      platform: 'win32',
      sleep: async delay => { slept.push(delay); },
      renameFile: async (from, to) => { calls += 1; if (calls > 1) throw fsError(code); return rename(from, to); }
    });
    await store.putJson('docs/a.json', { version: 1 });
    await assert.rejects(() => store.putJson('docs/a.json', { version: 2 }), error => error.code === code);
    assert.equal(calls, 2, `${code} is attempted once`);
    assert.deepEqual(slept, []);
    assert.deepEqual(await store.getJson('docs/a.json'), { version: 1 });
    assert.deepEqual(await files(store.file('docs/a.json')), ['a.json']);
  }
});

test('non-Windows platforms never retry rename, including EPERM and EBUSY', async t => {
  for (const platform of ['linux', 'darwin']) {
    for (const code of ['EPERM', 'EBUSY']) {
      let calls = 0;
      const slept = [];
      const store = await createStore(t, {
        platform,
        sleep: async delay => { slept.push(delay); },
        renameFile: async (from, to) => { calls += 1; if (calls > 1) throw fsError(code); return rename(from, to); }
      });
      await store.putJson('docs/a.json', { version: 1 });
      await assert.rejects(() => store.putJson('docs/a.json', { version: 2 }), error => error.code === code);
      assert.equal(calls, 2, `${platform}/${code}`);
      assert.deepEqual(slept, []);
      assert.deepEqual(await store.getJson('docs/a.json'), { version: 1 });
      assert.deepEqual(await files(store.file('docs/a.json')), ['a.json']);
    }
  }
});

const versionOf = async file => JSON.parse(await readFile(file, 'utf8')).version;

test('a transaction whose later document cannot be replaced restores every earlier document and reports the original error', async t => {
  let armed = false;
  const store = await createStore(t, {
    platform: 'win32',
    replaceRetryDelaysMs: [1],
    sleep: async () => {},
    renameFile: async (from, to) => {
      if (armed && path.basename(to) === 'b.json' && await versionOf(from) === 2) throw fsError('EPERM');
      return rename(from, to);
    }
  });
  await store.putJsonBatch([{ path: 'docs/a.json', value: { version: 1 } }, { path: 'docs/b.json', value: { version: 1 } }]);
  armed = true;
  await assert.rejects(() => store.withTransaction([], async () => {
    await store.putJson('docs/a.json', { version: 2 });
    await store.putJson('docs/b.json', { version: 2 });
  }), error => error.code === 'EPERM' && !error.rollbackErrors);
  assert.deepEqual(await store.getJson('docs/a.json'), { version: 1 });
  assert.deepEqual(await store.getJson('docs/b.json'), { version: 1 });
  assert.deepEqual(await files(store.file('docs/a.json')), ['a.json', 'b.json']);
});

test('a failing rollback does not stop the remaining restores or hide the original error', async t => {
  let armed = false;
  const store = await createStore(t, {
    platform: 'linux',
    renameFile: async (from, to) => {
      const name = path.basename(to);
      if (armed && name === 'c.json') throw fsError('ENOSPC');
      if (armed && name === 'b.json' && await versionOf(from) === 1) throw fsError('EIO');
      return rename(from, to);
    }
  });
  await store.putJsonBatch(['a', 'b', 'c'].map(name => ({ path: `docs/${name}.json`, value: { version: 1 } })));
  armed = true;
  await assert.rejects(() => store.withTransaction([], async () => {
    for (const name of ['a', 'b', 'c']) await store.putJson(`docs/${name}.json`, { version: 2 });
  }), error => error.code === 'ENOSPC' && error.rollbackErrors?.length === 1 && error.rollbackErrors[0].code === 'EIO');
  assert.deepEqual(await store.getJson('docs/a.json'), { version: 1 }, 'a is restored although b could not be');
  assert.deepEqual(await store.getJson('docs/b.json'), { version: 2 });
  assert.deepEqual(await store.getJson('docs/c.json'), { version: 1 });
  assert.deepEqual(await files(store.file('docs/a.json')), ['a.json', 'b.json', 'c.json']);
});
