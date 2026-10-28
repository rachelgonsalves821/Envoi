import { expect, it, vi } from 'vitest';
import { loadInitialWorkspace } from '../src/initial-workspace';
import type { HumanView, Inbox } from '../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const workspace = (id: string) => ({ id }) as Inbox;
const view = (id: string) => ({ inbox: { id } }) as HumanView;

it('starts the saved inbox read alongside directory discovery but waits for membership', async () => {
  const directory = deferred<Inbox[]>();
  const snapshot = deferred<HumanView>();
  const readDirectory = vi.fn(() => directory.promise);
  const readSnapshot = vi.fn(() => snapshot.promise);
  let ready = false;
  const loading = loadInitialWorkspace('saved', readDirectory, readSnapshot).then(result => { ready = true; return result; });
  expect(readDirectory).toHaveBeenCalledTimes(1);
  expect(readSnapshot).toHaveBeenCalledWith('saved');
  snapshot.resolve(view('saved'));
  await Promise.resolve();
  expect(ready).toBe(false);
  directory.resolve([workspace('saved')]);
  await expect(loading).resolves.toEqual({ selected: workspace('saved'), view: view('saved') });
});

it('discards an inaccessible saved inbox and loads the current account workspace', async () => {
  const readSnapshot = vi.fn(async (id: string) => {
    if (id === 'old-account') throw new Error('Access denied');
    return view(id);
  });
  await expect(loadInitialWorkspace('old-account', async () => [workspace('current')], readSnapshot))
    .resolves.toEqual({ selected: workspace('current'), view: view('current') });
  expect(readSnapshot.mock.calls.map(([id]) => id)).toEqual(['old-account', 'current']);
});

it('does not open a saved inbox when its authorized view is denied', async () => {
  const denied = new Error('Access denied');
  await expect(loadInitialWorkspace('saved', async () => [workspace('saved')], async () => { throw denied; }))
    .rejects.toBe(denied);
});

it('does not request a view when the account has no workspace', async () => {
  const readSnapshot = vi.fn(async () => view('saved'));
  await expect(loadInitialWorkspace('saved', async () => [], readSnapshot))
    .resolves.toEqual({ selected: null, view: null });
});
