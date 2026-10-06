export const SESSION_END_KEY = 'sinaloa.session-ended';
export const SESSION_IDENTITY_KEY = 'sinaloa.session-identity';
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
// 'quiet' is a return after a medium absence: validate in the background without
// hiding anything. 'tab' is a long absence and 'history' is a browser restore.
export type ResumeReason = SuspensionReason | 'quiet';

// Returning sooner than this does nothing; the session cannot have meaningfully
// changed and every request is still authorized by the server.
export const QUIET_RETURN_AFTER_MS = 60_000;
// After this long away the workspace is hidden until the account is verified,
// like an idle lock. Between the two thresholds the check is invisible.
export const CURTAIN_RETURN_AFTER_MS = 30 * 60_000;

export function publishSessionEnd(storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(SESSION_END_KEY, `${Date.now()}:${crypto.randomUUID()}`); }
  catch { /* Storage can be disabled; server authorization still applies. */ }
}

// Tabs share one session cookie. Announcing the account this tab loaded lets other
// tabs notice that someone else signed in, instead of continuing to display (and
// act for) the previous account.
export function publishSessionIdentity(humanId: string, storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(SESSION_IDENTITY_KEY, `${humanId}|${Date.now()}:${crypto.randomUUID()}`); }
  catch { /* Storage can be disabled; the server still rejects mismatched writes. */ }
}

export function announcedHumanId(value: string | null | undefined) {
  const separator = value ? value.indexOf('|') : -1;
  return separator > 0 ? value!.slice(0, separator) : null;
}

// A tab switch that happens while the first account load is still running should
// not throw that load away: the load is already fetching fresh, authorized data,
// and restarting it only makes the wait longer. Other boot states and history
// restoration keep their existing handling.
export function ridesOutTabSwitch(reason: SuspensionReason, boot: string) {
  return reason === 'tab' && boot === 'loading';
}

export function watchSessionLifecycle(browser: Browser, document: Visibility, callbacks: {
  isActive?: () => boolean;
  suspend: (reason: SuspensionReason) => void;
  resume: (reason: ResumeReason) => void;
  endedElsewhere: () => void;
  identityAnnounced?: (humanId: string) => void;
}, options: { now?: () => number; quietAfterMs?: number; curtainAfterMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const quietAfterMs = options.quietAfterMs ?? QUIET_RETURN_AFTER_MS;
  const curtainAfterMs = options.curtainAfterMs ?? CURTAIN_RETURN_AFTER_MS;
  const active = () => callbacks.isActive?.() !== false;
  let suspended: 'history' | null = null;
  let awayAt: number | null = null;

  // Browser history snapshots keep the page, so private state is discarded first.
  const suspendHistory = () => {
    if (!active() || suspended) return;
    suspended = 'history';
    callbacks.suspend('history');
  };
  // Leaving means the window lost focus or the tab was hidden. Only the length of
  // the absence matters: a quick click into DevTools or a split-screen neighbour
  // changes nothing, while a long absence earns a check.
  const leave = () => { if (awayAt === null && active()) awayAt = now(); };
  const returnToPage = () => {
    if (document.visibilityState === 'hidden') return;
    if (suspended) {
      suspended = null;
      awayAt = null;
      if (active()) callbacks.resume('history');
      return;
    }
    if (awayAt === null) return;
    const awayMs = now() - awayAt;
    awayAt = null;
    if (!active() || awayMs < quietAfterMs) return;
    if (awayMs >= curtainAfterMs) { callbacks.suspend('tab'); callbacks.resume('tab'); }
    else callbacks.resume('quiet');
  };

  const pageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) suspendHistory();
    returnToPage();
  };
  const visibility = () => document.visibilityState === 'hidden' ? leave() : returnToPage();
  const storage = (event: Event) => {
    const change = event as StorageEvent;
    if (change.key === SESSION_END_KEY && change.newValue) callbacks.endedElsewhere();
    if (change.key === SESSION_IDENTITY_KEY) {
      const humanId = announcedHumanId(change.newValue);
      if (humanId) callbacks.identityAnnounced?.(humanId);
    }
  };
  browser.addEventListener('pagehide', suspendHistory);
  browser.addEventListener('pageshow', pageShow);
  browser.addEventListener('blur', leave);
  browser.addEventListener('focus', returnToPage);
  browser.addEventListener('storage', storage);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    browser.removeEventListener('pagehide', suspendHistory);
    browser.removeEventListener('pageshow', pageShow);
    browser.removeEventListener('blur', leave);
    browser.removeEventListener('focus', returnToPage);
    browser.removeEventListener('storage', storage);
    document.removeEventListener('visibilitychange', visibility);
  };
}
