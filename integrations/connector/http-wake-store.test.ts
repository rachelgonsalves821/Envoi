import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { FileWakeStore, validateWakeState, emptyWakeState } from './http-wake-store';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'envoi-wake-store-'));
  try { await run(directory); }
  finally {
    const resolved = resolve(directory);
    if (relative(resolve(tmpdir()), resolved).startsWith('..') || !resolved.includes('envoi-wake-store-')) throw new Error('Invalid test cleanup');
    await rm(resolved, { recursive: true, force: true });
  }
}

describe('private durable wake storage', () => {
  it('persists accepted work and owner-revocation memory across a clean restart', () => fixture(async directory => {
    const first = await FileWakeStore.open(directory);
    try {
      await first.update(state => {
        state.endedReasons.installation_example = 'revoked_by_owner';
        state.accepted.wake_evt_abcdefghijklmnop = { receivedAt: 1, expiresAt: 3_900_001, pending: true, acknowledged: true,
          notification: { version: 1, id: 'wake_evt_abcdefghijklmnop', type: 'wake.work_available', subscriptionId: 'wake_sub_example' } };
      });
    } finally { await first.close(); }
    const next = await FileWakeStore.open(directory);
    try { const state = await next.read(); expect(state.endedReasons.installation_example).toBe('revoked_by_owner'); expect(state.accepted.wake_evt_abcdefghijklmnop.pending).toBe(true); }
    finally { await next.close(); }
  }));
  it('serializes concurrent updates and refuses a second process owner', () => fixture(async directory => {
    const store = await FileWakeStore.open(directory);
    try {
      await expect(FileWakeStore.open(directory)).rejects.toThrow();
      await Promise.all(Array.from({ length: 12 }, (_, index) => store.update(state => { state.endedReasons[`installation_item_${index}`] = 'expired'; })));
      expect(Object.keys((await store.read()).endedReasons)).toHaveLength(12);
    } finally { await store.close(); }
  }));
  it('never overwrites a prior durable state after a rejected mutation', () => fixture(async directory => {
    const store = await FileWakeStore.open(directory);
    try {
      await store.update(state => { state.endedReasons.installation_example = 'revoked_by_owner'; });
      const original = await readFile(join(directory, 'wake.json'), 'utf8');
      await expect(store.update(state => { (state as unknown as { version: number }).version = 2; })).rejects.toThrow();
      expect(await readFile(join(directory, 'wake.json'), 'utf8')).toBe(original);
    } finally { await store.close(); }
  }));
  it('refuses corrupt private state rather than recreating subscriptions', () => fixture(async directory => {
    await writeFile(join(directory, 'wake.json'), '{invalid');
    await expect(FileWakeStore.open(directory)).rejects.toThrow('could not be opened');
  }));
  it('rejects non-object digests, malformed maps and short replay retention', () => {
    expect(() => validateWakeState(null)).toThrow();
    const state = emptyWakeState();
    state.accepted.wake_evt_abcdefghijklmnop = { receivedAt: 100, expiresAt: 100, pending: true, acknowledged: true,
      notification: { version: 1, type: 'wake.work_available', id: 'wake_evt_abcdefghijklmnop', subscriptionId: 'wake_sub_example' } };
    expect(() => validateWakeState(state)).toThrow();
  });
});
