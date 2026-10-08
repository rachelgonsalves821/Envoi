import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { reapAgentRotationRecovery } from '../src/agent-rotation-recovery.js';

test('expired encrypted rotation recovery is deleted; unexpired recovery remains', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-rotation-reaper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStore(directory);
  const root = path.join('auth', 'agent-rotation-recovery');
  const expiredHash = 'a'.repeat(64);
  const liveHash = 'b'.repeat(64);
  const expiredPath = path.join(root, `${expiredHash}.json`);
  const livePath = path.join(root, `${liveHash}.json`);
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  await store.putJson(expiredPath, { tokenHash: expiredHash, expiresAt: new Date(now - 1).toISOString(), encrypted: { ciphertext: 'private' } });
  await store.putJson(livePath, { tokenHash: liveHash, expiresAt: new Date(now + 1).toISOString(), encrypted: { ciphertext: 'private' } });

  assert.equal(await reapAgentRotationRecovery(store, now), 1);
  assert.equal(await store.getJson(expiredPath), null);
  assert.ok(await store.getJson(livePath));
  assert.equal(await reapAgentRotationRecovery(store, now + 2), 1);
  assert.equal(await store.getJson(livePath), null);
});
