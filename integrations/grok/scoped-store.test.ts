import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileScopedRunStore, type ScopedRunRecord } from './scoped-store';

describe('private durable scoped run store', () => {
  it('holds the same lock through directory aliases and Windows path casing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-scoped-alias-'));
    try {
      const state = path.join(directory, 'state');
      const alias = path.join(directory, 'alias');
      await mkdir(state);
      await symlink(state, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const first = new FileScopedRunStore(state);
      const second = new FileScopedRunStore(process.platform === 'win32' ? alias.toUpperCase() : alias);
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>(resolve => { started = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const order: string[] = [];
      const old = first.exclusive('work_one', async () => { order.push('old'); started(); await blocked; order.push('old-finished'); });
      await held;
      const recovered = second.exclusive('work_one', async () => { order.push('recovered'); });
      await second.exclusive('other_work', async () => { order.push('independent'); });
      expect(order).toEqual(['old', 'independent']);
      release();
      await Promise.all([old, recovered]);
      expect(order).toEqual(['old', 'independent', 'old-finished', 'recovered']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('serializes recovery across reopened store instances without blocking unrelated work', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-scoped-lock-'));
    try {
      const first = new FileScopedRunStore(directory);
      const second = new FileScopedRunStore(directory);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      let started!: () => void;
      const held = new Promise<void>(resolve => { started = resolve; });
      const order: string[] = [];
      const old = first.exclusive('work_one', async () => { order.push('old'); started(); await blocked; order.push('old-finished'); });
      await held;
      const recovered = second.exclusive('work_one', async () => { order.push('recovered'); });
      await second.exclusive('other_work', async () => { order.push('independent'); });
      expect(order).toEqual(['old', 'independent']);
      release();
      await Promise.all([old, recovered]);
      expect(order).toEqual(['old', 'independent', 'old-finished', 'recovered']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves pending tool arguments across reopen and replaces completed state atomically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-scoped-run-'));
    try {
      const record: ScopedRunRecord = { version: 1, workId: 'work_one', model: 'model', input: [],
        pending: [{ type: 'function_call', call_id: 'call_one', name: 'envoi_case_reply', arguments: '{"idempotencyKey":"same-key"}' }], providerCalls: 1, completed: false };
      const store = new FileScopedRunStore(directory);
      expect(await store.load(record.workId)).toBeNull();
      await store.save(record);
      expect(await new FileScopedRunStore(directory).load(record.workId)).toEqual(record);
      await store.save({ ...record, pending: [], completed: true });
      expect(JSON.parse(await readFile(path.join(directory, 'scoped-runs', 'work_one.json'), 'utf8')).completed).toBe(true);
      await expect(store.load('../escape')).rejects.toThrow('Invalid scoped work identity');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('fails closed on a corrupted or mismatched journal instead of silently starting a new turn', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-scoped-corrupt-'));
    try {
      const store = new FileScopedRunStore(directory);
      const record: ScopedRunRecord = { version: 1, workId: 'work_one', model: 'model', input: [], pending: [], providerCalls: 1, completed: false };
      await store.save(record);
      const filename = path.join(directory, 'scoped-runs', 'work_one.json');
      await writeFile(filename, '{broken');
      await expect(store.load('work_one')).rejects.toThrow();
      await writeFile(filename, JSON.stringify({ ...record, workId: 'different_work' }));
      await expect(store.load('work_one')).rejects.toThrow('Invalid scoped run record');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
