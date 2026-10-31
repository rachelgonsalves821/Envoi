import { expect, it, vi } from 'vitest';
import { createWorkspaceSwitch } from '../src/workspace-switch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('uses only the latest authorized inbox when responses arrive out of order', async () => {
  const first = deferred<{ id: string }>();
  const second = deferred<{ id: string }>();
  const switcher = createWorkspaceSwitch<{ id: string }>();
  const verify = vi.fn((value: { id: string }, id: string) => {
    if (value.id !== id) throw new Error('Wrong inbox');
  });
  const read = vi.fn((id: string) => id === 'first' ? first.promise : second.promise);
  const oldSelection = switcher.load('first', read, verify);
  const newSelection = switcher.load('second', read, verify);
  second.resolve({ id: 'second' });
  await expect(newSelection).resolves.toEqual({ id: 'second' });
  first.resolve({ id: 'first' });
  await expect(oldSelection).resolves.toBeNull();
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith({ id: 'second' }, 'second');
});

it('cancels a pending inbox selection when the user returns to the current inbox', async () => {
  const response = deferred<{ id: string }>();
  const switcher = createWorkspaceSwitch<{ id: string }>();
  const verify = vi.fn();
  const pending = switcher.load('agent', () => response.promise, verify);
  switcher.cancel();
  response.resolve({ id: 'agent' });
  await expect(pending).resolves.toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it('refuses a mismatched authorized view', async () => {
  const switcher = createWorkspaceSwitch<{ id: string }>();
  await expect(switcher.load('expected', async () => ({ id: 'wrong' }), (value, id) => {
    if (value.id !== id) throw new Error('Wrong inbox');
  })).rejects.toThrow('Wrong inbox');
});
