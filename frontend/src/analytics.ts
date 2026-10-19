import posthog from 'posthog-js';

// PostHog project tokens are public browser credentials. Production builds use
// Envoi's US Cloud project; the variables allow a different project if needed.
const projectToken = (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN ||
  (import.meta.env.PROD ? 'phc_nayMdaa954vNC4Dkx33k9Ui38kPQyp2xhn2YUYiFFfHH' : '')).trim();
const apiHost = (import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').trim();

function publicPage() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return path === '/about' || path === '/product' ? path : '/';
}

export function initAnalytics() {
  if (!projectToken || !apiHost || !/^https:\/\//.test(apiHost)) return;

  posthog.init(projectToken, {
    api_host: apiHost,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    person_profiles: 'never',
    before_send: event => {
      if (!event || !['$pageview', 'waitlist_joined', 'beta_app_opened'].includes(event.event)) return null;
      // Do not send query strings, emails, case content, or other SDK-added page properties.
      event.properties = event.event === '$pageview'
        ? { $current_url: `${window.location.origin}${publicPage()}` }
        : {};
      return event;
    }
  });

  posthog.capture('$pageview');
}

export function captureAnalyticsEvent(event: 'waitlist_joined' | 'beta_app_opened') {
  if (projectToken && /^https:\/\//.test(apiHost)) posthog.capture(event);
}
