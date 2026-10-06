import { describe, expect, it, vi } from 'vitest';
import { SESSION_END_KEY, SESSION_ENDED_NOTICE, SESSION_NOTICE_KEY, hasRememberedSession, invalidateSessionRequests, isCurrentSession, publishSessionEnd, rememberSessionStatus, ridesOutTabSwitch, sessionEndedNotice, sessionGeneration, trackSessionRequest, watchSessionLifecycle } from '../src/session-lifecycle';

function browserFixture(isActive?: () => boolean) {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const callbacks = { suspend: vi.fn(), resume: vi.fn(), endedElsewhere: vi.fn() };
  const stop = watchSessionLifecycle(browser, document, { ...callbacks, isActive });
  return { browser, document, callbacks, stop };
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

  it('still suspends and resumes once when the tab is actually hidden after a blur', () => {
    const { browser, document, callbacks, stop } = browserFixture();
    browser.dispatchEvent(new Event('blur'));
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.suspend).toHaveBeenCalledExactlyOnceWith('tab');
    expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('tab');
    stop();
  });

  it('only rides out tab switches during the initial account load', () => {
    expect(ridesOutTabSwitch('tab', 'loading')).toBe(true);
    expect(ridesOutTabSwitch('history', 'loading')).toBe(false);
    for (const boot of ['ready', 'setup', 'error', 'signedOut']) expect(ridesOutTabSwitch('tab', boot)).toBe(false);
  });

  it('keeps hidden tabs private and resumes once when visible despite overlapping focus events', () => {
    const { browser, document, callbacks, stop } = browserFixture();
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.suspend).toHaveBeenCalledTimes(1);
    expect(callbacks.suspend).toHaveBeenCalledWith('tab');
    expect(callbacks.resume).not.toHaveBeenCalled();
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.resume).toHaveBeenCalledTimes(1);
    expect(callbacks.resume).toHaveBeenCalledWith('tab');
    stop();
  });

  it('upgrades a tab curtain to discarded history state before browser navigation', () => {
    const { browser, document, callbacks, stop } = browserFixture();
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('pagehide'));
    expect(callbacks.suspend.mock.calls).toEqual([['tab'], ['history']]);
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

  it('does not revalidate a suspended account after another tab ends the session', () => {
    let authenticated = true;
    const { browser, document, callbacks, stop } = browserFixture(() => authenticated);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    callbacks.endedElsewhere.mockImplementation(() => { authenticated = false; });
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_END_KEY, newValue: 'remote-logout' }));
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('focus'));
    expect(callbacks.endedElsewhere).toHaveBeenCalledTimes(1);
    expect(callbacks.resume).not.toHaveBeenCalled();
    stop();
  });

  it('only responds to session-end messages and removes every listener on cleanup', () => {
    const { browser, document, callbacks, stop } = browserFixture();
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinaloa.workspace', newValue: 'workspace1' }));
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
