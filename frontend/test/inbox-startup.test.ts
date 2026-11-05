import { describe, expect, it, vi } from 'vitest';
import { loadInboxStartup, readInboxViews } from '../src/inbox-startup';
import type { HumanView, Inbox } from '../src/types';

const identity = { humanId: 'owner', provider: 'workos' };
const inbox = { id: 'saved' } as Inbox;
const snapshot = (requester: unknown = { id: 'owner', auth: { provider: 'workos', assurance: 'provider' } }) => ({ inbox, requester }) as HumanView;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('fresh authorized inbox startup', () => {
  it('returns the authorized saved inbox while directory discovery is still pending, without a duplicate read', async () => {
    const directory = deferred<Inbox[]>();
    const read = vi.fn().mockResolvedValue(snapshot());
    const result = await loadInboxStartup('saved', identity, { directory: () => directory.promise, snapshot: read });
    expect(result.selected).toBe(inbox);
    expect(result.view?.requester?.id).toBe('owner');
    expect(read).toHaveBeenCalledExactlyOnceWith('saved');
    directory.resolve([inbox]);
    await expect(result.directory).resolves.toEqual([inbox]);
  });

  it('keeps a directory error observable after the independent inbox has rendered', async () => {
    const directory = deferred<Inbox[]>();
    const result = await loadInboxStartup('saved', identity, { directory: () => directory.promise, snapshot: async () => snapshot() });
    const failure = expect(result.directory).rejects.toThrow('directory offline');
    directory.reject(new Error('directory offline'));
    await failure;
    expect(result.selected?.id).toBe('saved');
  });

  it.each([
    { id: 'another-owner', auth: { provider: 'workos', assurance: 'provider' } },
    { id: 'owner', auth: { provider: 'local', assurance: 'mfa' } },
    { id: 'owner', auth: { provider: 'local', assurance: 'phone' } },
    {}, null
  ])('never returns an unverified or different-account saved inbox: %j', async requester => {
    await expect(loadInboxStartup('saved', identity, { directory: async () => [inbox], snapshot: async () => snapshot(requester) })).rejects.toThrow();
  });

  it('refuses the wrong inbox even when the requester is correct', async () => {
    await expect(loadInboxStartup('saved', identity, { directory: async () => [inbox], snapshot: async () => ({ ...snapshot(), inbox: { id: 'wrong' } }) as HumanView })).rejects.toThrow('another workspace');
  });

  it('holds legacy snapshots until directory membership has been confirmed', async () => {
    const directory = deferred<Inbox[]>();
    let ready = false;
    const legacy = { inbox } as HumanView;
    const pending = loadInboxStartup('saved', identity, { directory: () => directory.promise, snapshot: async () => legacy }).then(result => { ready = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    directory.resolve([inbox]);
    await expect(pending).resolves.toMatchObject({ selected: inbox, view: legacy });
  });

  it('discards a removed legacy saved inbox and reads the authorized directory fallback', async () => {
    const fallback = { id: 'new' } as Inbox;
    const read = vi.fn(async (id: string) => ({ inbox: id === 'saved' ? inbox : fallback }) as HumanView);
    const result = await loadInboxStartup('saved', identity, { directory: async () => [fallback], snapshot: read });
    expect(result.selected).toBe(fallback);
    expect(result.view?.inbox).toBe(fallback);
    expect(read.mock.calls).toEqual([['saved'], ['new']]);
  });

  it('keeps a saved-inbox denial rather than treating directory metadata as a grant', async () => {
    await expect(loadInboxStartup('saved', identity, { directory: async () => [inbox], snapshot: async () => { throw new Error('denied'); } })).rejects.toThrow('denied');
  });

  it('returns setup without making a speculative snapshot read for a new account', async () => {
    const read = vi.fn();
    await expect(loadInboxStartup(null, identity, { directory: async () => [], snapshot: read })).resolves.toMatchObject({ selected: null, view: null });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['x'.repeat(129), '../private', 'https://elsewhere.example/inbox'])('ignores malformed stored identifiers: %s', async saved => {
    const read = vi.fn();
    await expect(loadInboxStartup(saved, identity, { directory: async () => [], snapshot: read })).resolves.toMatchObject({ selected: null });
    expect(read).not.toHaveBeenCalled();
  });
});

it('publishes a ready sibling before a delayed inbox and retains successful siblings after a refusal', async () => {
  const slow = deferred<string>();
  const accepted: string[] = [];
  const pending = readInboxViews([{ id: 'slow' }, { id: 'fast' }, { id: 'denied' }] as Inbox[], async item => {
    if (item.id === 'slow') return slow.promise;
    if (item.id === 'denied') throw new Error('denied');
    return 'fast';
  }, value => accepted.push(value));
  await Promise.resolve(); await Promise.resolve();
  expect(accepted).toEqual(['fast']);
  slow.resolve('slow'); await pending;
  expect(accepted).toEqual(['fast', 'slow']);
});
