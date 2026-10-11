import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, CSRF_RELOAD_REQUIRED_EVENT, SESSION_EXPIRED_EVENT } from './api';

export function watchCsrfReload(browser: Pick<Window, 'addEventListener' | 'removeEventListener'>, onRequired: (required: boolean) => void) {
  const requireReload = () => onRequired(true);
  const expired = () => onRequired(false);
  browser.addEventListener(CSRF_RELOAD_REQUIRED_EVENT, requireReload);
  browser.addEventListener(SESSION_EXPIRED_EVENT, expired);
  return () => {
    browser.removeEventListener(CSRF_RELOAD_REQUIRED_EVENT, requireReload);
    browser.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  };
}

export function CsrfReloadNotice({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  return <div className="csrf-reload-notice" role="alert">
    <span>Your browser needs an update before this action can continue.</span>
    <button type="button" className="button secondary compact" onClick={onReload}>Reload</button>
  </div>;
}

export function CsrfReloadBoundary({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState(false);
  useEffect(() => watchCsrfReload(window, setRequired), []);
  return <>{children}{required && <CsrfReloadNotice />}</>;
}

// EventSource hides HTTP status. Probe the session after an error and close the
// current stream/show sign-in on 401, without treating an outage as sign-out.
export function createHumanStreamRecovery(options: {
  isCurrent: () => boolean;
  checkSession: () => Promise<unknown>;
  onExpired: () => void;
  onUnavailable: () => void;
}) {
  let pending: Promise<void> | null = null;
  return () => {
    if (!options.isCurrent()) return Promise.resolve();
    if (pending) return pending;
    options.onUnavailable();
    pending = options.checkSession().then(() => undefined).catch(caught => {
      if (options.isCurrent() && caught instanceof ApiError && caught.status === 401) options.onExpired();
    }).finally(() => { pending = null; });
    return pending;
  };
}
