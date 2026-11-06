import { expect, it, vi } from 'vitest';
import { createWorkspaceSwitch } from '../src/workspace-switch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each(['failed', 'denied', 'wrong inbox'])('retains the authorized inbox and section during a %s selection', async outcome => {
  const response = deferred<{ id: string }>();
  const switcher = createWorkspaceSwitch<{ id: string }>();
  let visible = { id: 'authorized', section: 'documents' };
  const pending = switcher.load('next', () => response.promise, value => {
    if (value.id !== 'next') throw new Error('wrong inbox');
  }).then(value => { if (value) visible = { id: value.id, section: 'inbox' }; });
  expect(visible).toEqual({ id: 'authorized', section: 'documents' });
  const refused = expect(pending).rejects.toThrow(outcome);
  if (outcome === 'wrong inbox') response.resolve({ id: 'other' });
  else response.reject(new Error(outcome));
  await refused;
  expect(visible).toEqual({ id: 'authorized', section: 'documents' });
});

it('aborts the superseded request and ignores its late rejection', async () => {
  const first = deferred<{ id: string }>();
  const switcher = createWorkspaceSwitch<{ id: string }>();
  let signal!: AbortSignal;
  const verify = vi.fn();
  const old = switcher.load('old', (_id, nextSignal) => { signal = nextSignal; return first.promise; }, verify);
  await expect(switcher.load('new', async () => ({ id: 'new' }), verify)).resolves.toEqual({ id: 'new' });
  expect(signal.aborted).toBe(true);
  first.reject(new Error('late transport failure'));
  await expect(old).resolves.toBeNull();
  expect(verify).toHaveBeenCalledTimes(1);
});
