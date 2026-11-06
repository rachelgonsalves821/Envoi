import { describe, expect, it, vi } from 'vitest';
import { appLocation, appPath, createAppNavigation, type AppLocation } from '../src/app-navigation';

const initial: AppLocation = { inbox: 'root', section: 'documents', folder: null, case: null };
const child: AppLocation = { inbox: 'child', section: 'needsMe', folder: 'launch', case: 'child:case_1' };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(select: (location: AppLocation) => Promise<void> = async () => {}) {
  const handlers = { select, cancel: vi.fn(), commit: vi.fn(), write: vi.fn(), error: vi.fn() };
  return { handlers, navigation: createAppNavigation(initial, handlers) };
}

describe('authorized app history', () => {
  it('round trips inbox, section, folder and source-qualified case on direct load/refresh', () => {
    const url = new URL(appPath(child), 'https://example.test');
    expect(appLocation(url.search, initial)).toEqual(child);
    expect(appLocation('?section=not-a-view&inbox=child', initial)).toEqual({ ...child, section: 'inbox', folder: null, case: null });
    expect(appLocation('', child)).toBe(child);
    expect(appPath(child, true)).toContain('preview=1');
  });
  it('keeps the visible location and history unchanged while a selection is pending', async () => {
    const response = deferred();
    const { navigation, handlers } = fixture(() => response.promise);
    const pending = navigation.go(child);
    expect(navigation.current()).toBe(initial);
    expect(handlers.commit).not.toHaveBeenCalled();
    expect(handlers.write).not.toHaveBeenCalled();
    response.resolve();
    await expect(pending).resolves.toBe(true);
    expect(handlers.commit).toHaveBeenCalledWith(child);
    expect(handlers.write).toHaveBeenCalledWith(child, false);
  });
  it('restores Back then Forward without pushing new history entries', async () => {
    const { navigation, handlers } = fixture();
    await navigation.go(child);
    await navigation.go(initial, 'restore');
    expect(navigation.current()).toEqual(initial);
    await navigation.go(child, 'restore');
    expect(navigation.current()).toEqual(child);
    expect(handlers.select).toBeDefined();
    expect(handlers.commit.mock.calls.map(call => call[0])).toEqual([child, initial, child]);
    expect(handlers.write).toHaveBeenCalledTimes(1);
  });
  it.each(['network failure', 'denied', 'wrong inbox'])('repairs a refused history entry after %s without committing it', async reason => {
    const { navigation, handlers } = fixture(async () => { throw new Error(reason); });
    await expect(navigation.go(child, 'restore')).resolves.toBe(false);
    expect(navigation.current()).toBe(initial);
    expect(handlers.commit).not.toHaveBeenCalled();
    expect(handlers.write).toHaveBeenCalledExactlyOnceWith(initial, true);
  });
  it('does not push history for a failed click', async () => {
    const { navigation, handlers } = fixture(async () => { throw new Error('denied'); });
    await navigation.go(child);
    expect(handlers.write).not.toHaveBeenCalled();
    expect(handlers.commit).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('ignores a stale %s after a newer authorized navigation', async outcome => {
    const old = deferred();
    const { navigation, handlers } = fixture(location => location.inbox === 'child' ? old.promise : Promise.resolve());
    const pending = navigation.go(child, 'restore');
    await navigation.go(initial);
    if (outcome === 'resolve') old.resolve(); else old.reject(new Error('old refusal'));
    await expect(pending).resolves.toBe(false);
    expect(handlers.commit).toHaveBeenCalledExactlyOnceWith(initial);
    expect(handlers.write).toHaveBeenCalledExactlyOnceWith(initial, false);
    expect(handlers.error).not.toHaveBeenCalled();
  });
  it('cancels a pending switch when another top-level route or session wins', async () => {
    const response = deferred();
    const { navigation, handlers } = fixture(() => response.promise);
    const pending = navigation.go(child);
    navigation.cancel();
    response.resolve();
    await expect(pending).resolves.toBe(false);
    expect(handlers.cancel).toHaveBeenCalledTimes(2);
    expect(handlers.commit).not.toHaveBeenCalled();
    expect(handlers.write).not.toHaveBeenCalled();
  });
});
