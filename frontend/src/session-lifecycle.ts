export const SESSION_END_KEY = 'sinaloa.session-ended';
export const SESSION_NOTICE_KEY = 'sinaloa.session-status';
export const SESSION_ENDED_NOTICE = 'Your session ended. Please sign in again.';

type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;

function rememberedSession(storage?: SessionStorage) {
  try {
    const value = (storage || sessionStorage).getItem(SESSION_NOTICE_KEY);
    return value === 'active' || value === 'ended' ? value : null;
  } catch { return null; }
}

export function hasRememberedSession(storage?: SessionStorage) {
  return rememberedSession(storage) !== null;
}

export function sessionEndedNotice(storage?: SessionStorage) {
  return rememberedSession(storage) === 'ended' ? SESSION_ENDED_NOTICE : '';
}

export function rememberSessionStatus(status: 'active' | 'ended', storage?: SessionStorage) {
  try { (storage || sessionStorage).setItem(SESSION_NOTICE_KEY, status); }
  catch { /* A notice is optional when browser storage is unavailable. */ }
}

// Requests and state loaders share this generation. A response from a former
// session must never populate a restored page or a newly authenticated account.
let generation = 0;
const requests = new Set<AbortController>();

export class SessionRequestCancelled extends Error {
  constructor() {
    super('This request belongs to a session that is no longer active.');
    this.name = 'AbortError';
  }
}

export function sessionGeneration() { return generation; }
export function isCurrentSession(value: number) { return value === generation; }
export function invalidateSessionRequests() {
  generation += 1;
  for (const controller of requests) controller.abort();
  requests.clear();
  return generation;
}

export function trackSessionRequest() {
  const controller = new AbortController();
  const started = generation;
  requests.add(controller);
  return {
    signal: controller.signal,
    check: () => { if (!isCurrentSession(started)) throw new SessionRequestCancelled(); },
    release: () => requests.delete(controller)
  };
}

type Browser = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type Visibility = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
export type SuspensionReason = 'tab' | 'history';

export function publishSessionEnd(storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(SESSION_END_KEY, `${Date.now()}:${crypto.randomUUID()}`); }
  catch { /* Storage can be disabled; server authorization still applies. */ }
}

export function watchSessionLifecycle(browser: Browser, document: Visibility, callbacks: {
  isActive?: () => boolean;
  suspend: (reason: SuspensionReason) => void;
  resume: (reason: SuspensionReason) => void;
  endedElsewhere: () => void;
}) {
  let suspended: SuspensionReason | null = null;
  let blurred = false;
  const suspend = (reason: SuspensionReason) => {
    if (callbacks.isActive?.() === false) return;
    if (suspended === 'history' || suspended === reason) return;
    suspended = reason;
    callbacks.suspend(reason);
  };
  const resume = () => {
    if (!suspended || document.visibilityState === 'hidden') return;
    const reason = suspended;
    suspended = null;
    blurred = false;
    if (callbacks.isActive?.() !== false) callbacks.resume(reason);
  };
  const pageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) suspend('history');
    resume();
  };
  const visibility = () => document.visibilityState === 'hidden' ? suspend('tab') : resume();
  const pageHide = () => suspend('history');
  const blur = () => { blurred = true; };
  const focus = () => {
    if (blurred && !suspended) suspend('tab');
    resume();
  };
  const storage = (event: Event) => {
    const change = event as StorageEvent;
    if (change.key === SESSION_END_KEY && change.newValue) callbacks.endedElsewhere();
  };
  browser.addEventListener('pagehide', pageHide);
  browser.addEventListener('pageshow', pageShow);
  browser.addEventListener('blur', blur);
  browser.addEventListener('focus', focus);
  browser.addEventListener('storage', storage);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    browser.removeEventListener('pagehide', pageHide);
    browser.removeEventListener('pageshow', pageShow);
    browser.removeEventListener('blur', blur);
    browser.removeEventListener('focus', focus);
    browser.removeEventListener('storage', storage);
    document.removeEventListener('visibilitychange', visibility);
  };
}
