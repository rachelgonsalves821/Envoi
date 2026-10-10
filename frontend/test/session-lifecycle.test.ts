import { describe, expect, it, vi } from 'vitest';
import { CURTAIN_RETURN_AFTER_MS, QUIET_RETURN_AFTER_MS, SESSION_END_KEY, SESSION_ENDED_NOTICE, SESSION_IDENTITY_KEY, SESSION_NOTICE_KEY, announcedHumanId, publishSessionIdentity, hasRememberedSession, invalidateSessionRequests, isCurrentSession, publishSessionEnd, rememberSessionStatus, ridesOutTabSwitch, sessionEndedNotice, sessionGeneration, trackSessionRequest, watchSessionLifecycle } from '../src/session-lifecycle';

function browserFixture(isActive?: () => boolean) {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const clock = { time: 1_000_000 };
  const callbacks = { suspend: vi.fn(), resume: vi.fn(), endedElsewhere: vi.fn(), identityAnnounced: vi.fn() };
  const stop = watchSessionLifecycle(browser, document, { ...callbacks, isActive }, { now: () => clock.time });
  const hide = () => { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); browser.dispatchEvent(new Event('focus')); };
  return { browser, document, callbacks, stop, clock, hide, show };
}

describe('private page lifecycle', () => {
  it('suspends synchronously before history capture and validates once on restoration', () => {
    const { browser, callbacks, stop } = browserFixture();
    browser.dispatchEvent(new Event('pagehide'));
    expect(callbacks.suspend).toHaveBeenCalledTimes(1);
    expect(callbacks.suspend).toHaveBeenCalledWith('history');
    browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.resume).toHaveBeenCalledTimes(1);
    expect(callbacks.resume).toHaveBeenCalledWith('history');
    stop();
  });

  it('rechecks a persisted page even if no pagehide event was delivered', () => {
    const { browser, callbacks, stop } = browserFixture();
    browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(callbacks.suspend).toHaveBeenCalledTimes(1);
    expect(callbacks.resume).toHaveBeenCalledTimes(1);
    expect(callbacks.suspend.mock.invocationCallOrder[0]).toBeLessThan(callbacks.resume.mock.invocationCallOrder[0]);
    stop();
  });

  it('ignores window blur and focus while the page stays visible', () => {
    const { browser, callbacks, stop } = browserFixture();
    browser.dispatchEvent(new Event('blur'));
    browser.dispatchEvent(new Event('focus'));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('does nothing for a short absence, whether the window blurred or the tab hid', () => {
    const { browser, clock, hide, show, callbacks, stop } = browserFixture();
    browser.dispatchEvent(new Event('blur'));
    clock.time += QUIET_RETURN_AFTER_MS - 1;
    browser.dispatchEvent(new Event('focus'));
    hide();
    clock.time += QUIET_RETURN_AFTER_MS - 1;
    show();
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('validates quietly, without suspending, after a medium absence', () => {
    const { clock, hide, show, callbacks, stop } = browserFixture();
    hide();
    clock.time += 5 * 60_000;
    show();
    show();
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('quiet');
    stop();
  });

  it('treats a long stay in another window as an absence even though the tab stayed visible', () => {
    const { browser, clock, callbacks, stop } = browserFixture();
    browser.dispatchEvent(new Event('blur'));
    clock.time += 5 * 60_000;
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('quiet');
    stop();
  });

  it('hides the workspace until verified only after a long absence', () => {
    const { clock, hide, show, callbacks, stop } = browserFixture();
    hide();
    clock.time += CURTAIN_RETURN_AFTER_MS;
    show();
    expect(callbacks.suspend).toHaveBeenCalledExactlyOnceWith('tab');
    expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('tab');
    expect(callbacks.suspend.mock.invocationCallOrder[0]).toBeLessThan(callbacks.resume.mock.invocationCallOrder[0]);
    stop();
  });

  it('does not count an absence while signed out toward a later check', () => {
    let authenticated = false;
    const { browser, clock, callbacks, stop } = browserFixture(() => authenticated);
    browser.dispatchEvent(new Event('blur'));
    authenticated = true;
    clock.time += 5 * 60_000;
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('upgrades a hidden tab to discarded history state before browser navigation', () => {
    const { browser, document, clock, hide, callbacks, stop } = browserFixture();
    hide();
    clock.time += 5 * 60_000;
    browser.dispatchEvent(new Event('pagehide'));
    expect(callbacks.suspend.mock.calls).toEqual([['history']]);
    document.visibilityState = 'visible';
    browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('history');
    stop();
  });

  it('preserves pending signed-out verification forms across tab changes and history restoration', () => {
    const { browser, document, callbacks, stop } = browserFixture(() => false);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('pagehide'));
    browser.dispatchEvent(new Event('blur'));
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('does not revalidate an account after another tab ends the session', () => {
    let authenticated = true;
    const { clock, hide, show, callbacks, browser, stop } = browserFixture(() => authenticated);
    hide();
    callbacks.endedElsewhere.mockImplementation(() => { authenticated = false; });
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_END_KEY, newValue: 'remote-logout' }));
    clock.time += CURTAIN_RETURN_AFTER_MS;
    show();
    expect(callbacks.endedElsewhere).toHaveBeenCalledTimes(1);
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('reports which account another tab signed in as, and ignores everything else', () => {
    const { browser, callbacks, stop } = browserFixture();
    const announce = (key: string, newValue: string | null) => browser.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
    announce(SESSION_IDENTITY_KEY, 'human_b|1:random');
    announce(SESSION_IDENTITY_KEY, null);
    announce(SESSION_IDENTITY_KEY, 'malformed');
    announce('envoi.workspace', 'human_c|1:random');
    expect(callbacks.identityAnnounced).toHaveBeenCalledExactlyOnceWith('human_b');
    stop();
  });

  it('publishes a fresh identity signal per load and tolerates unavailable storage', () => {
    const setItem = vi.fn();
    publishSessionIdentity('human_a', { setItem });
    publishSessionIdentity('human_a', { setItem });
    expect(setItem.mock.calls[0][0]).toBe(SESSION_IDENTITY_KEY);
    expect(announcedHumanId(setItem.mock.calls[0][1])).toBe('human_a');
    expect(setItem.mock.calls[0][1]).not.toBe(setItem.mock.calls[1][1]);
    expect(announcedHumanId(null)).toBeNull();
    expect(() => publishSessionIdentity('human_a', { setItem: () => { throw new Error('disabled'); } })).not.toThrow();
  });

  it('only responds to session-end messages and removes every listener on cleanup', () => {
    const { browser, document, callbacks, stop } = browserFixture();
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'envoi.workspace', newValue: 'workspace1' }));
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_END_KEY, newValue: null }));
    expect(callbacks.endedElsewhere).not.toHaveBeenCalled();
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_END_KEY, newValue: '1:random' }));
    expect(callbacks.endedElsewhere).toHaveBeenCalledTimes(1);
    stop();
    browser.dispatchEvent(new Event('pagehide'));
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_END_KEY, newValue: '2:random' }));
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(callbacks.suspend).not.toHaveBeenCalled();
    expect(callbacks.endedElsewhere).toHaveBeenCalledTimes(1);
  });

  it('publishes a fresh signal even for repeated logout and tolerates unavailable storage', () => {
    const setItem = vi.fn();
    publishSessionEnd({ setItem });
    publishSessionEnd({ setItem });
    expect(setItem.mock.calls[0][0]).toBe(SESSION_END_KEY);
    expect(setItem.mock.calls[0][1]).not.toBe(setItem.mock.calls[1][1]);
    expect(() => publishSessionEnd({ setItem: () => { throw new Error('disabled'); } })).not.toThrow();
  });
});

describe('session generation', () => {
  it('aborts in-flight requests and rejects responses that still complete', () => {
    const generation = sessionGeneration();
    const pending = trackSessionRequest();
    invalidateSessionRequests();
    expect(pending.signal.aborted).toBe(true);
    expect(isCurrentSession(generation)).toBe(false);
    expect(() => pending.check()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    const fresh = trackSessionRequest();
    expect(fresh.signal.aborted).toBe(false);
    expect(() => fresh.check()).not.toThrow();
    pending.release();
    fresh.release();
  });

  it('does not abort requests already released', () => {
    const complete = trackSessionRequest();
    complete.release();
    invalidateSessionRequests();
    expect(complete.signal.aborted).toBe(false);
  });
});

describe('per-tab session notice', () => {
  it('keeps a fresh visit notice-free, remembers a prior session, and clears the notice after sign-in', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(hasRememberedSession(storage)).toBe(false);
    expect(sessionEndedNotice(storage)).toBe('');
    rememberSessionStatus('active', storage);
    expect(hasRememberedSession(storage)).toBe(true);
    expect(sessionEndedNotice(storage)).toBe('');
    rememberSessionStatus('ended', storage);
    expect(sessionEndedNotice(storage)).toBe(SESSION_ENDED_NOTICE);
    expect(values).toEqual(new Map([[SESSION_NOTICE_KEY, 'ended']]));
    rememberSessionStatus('active', storage);
    expect(sessionEndedNotice(storage)).toBe('');
  });

  it('rejects unexpected stored content and tolerates browser storage restrictions', () => {
    const storage = { getItem: () => '{"user":"someone","token":"not accepted"}', setItem: vi.fn() };
    expect(hasRememberedSession(storage)).toBe(false);
    expect(sessionEndedNotice(storage)).toBe('');
    const disabled = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); } };
    expect(sessionEndedNotice(disabled)).toBe('');
    expect(hasRememberedSession(disabled)).toBe(false);
    expect(() => rememberSessionStatus('ended', disabled)).not.toThrow();
  });
});
