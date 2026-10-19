import posthog from 'posthog-js';

// PostHog project tokens are public browser credentials. Production builds use
// Envoi's US Cloud project; the variables allow a different project if needed.
const projectToken = (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN ||
  (import.meta.env.PROD ? 'phc_nayMdaa954vNC4Dkx33k9Ui38kPQyp2xhn2YUYiFFfHH' : '')).trim();
const apiHost = (import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').trim();

type AnalyticsEvent =
  | 'waitlist_joined'
  | 'beta_app_opened'
  | 'workspace_created'
  | 'agent_enrollment_started'
  | 'agent_approved'
  | 'case_decision_submitted'
  | 'instruction_sent'
  | 'invitation_accepted';

const productEvents: AnalyticsEvent[] = [
  'waitlist_joined', 'beta_app_opened', 'workspace_created',
  'agent_enrollment_started', 'agent_approved', 'case_decision_submitted',
  'instruction_sent', 'invitation_accepted'
];

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
      if (!event || !['$pageview', ...productEvents].includes(event.event)) return null;
      // The SDK keeps the project token and anonymous browser ID in properties.
      // Dropping the token here makes the SDK discard the event before sending it.
      // Keep only the fields needed for anonymous ingestion and our public path.
      const { token, distinct_id } = event.properties ?? {};
      event.properties = event.event === '$pageview'
        ? { token, distinct_id, $process_person_profile: false, $current_url: `${window.location.origin}${publicPage()}` }
        : { token, distinct_id, $process_person_profile: false };
      return event;
    }
  });

  posthog.capture('$pageview');
}

export function captureAnalyticsEvent(event: AnalyticsEvent) {
  if (projectToken && /^https:\/\//.test(apiHost)) posthog.capture(event);
}

export function captureSuccessfulProductAction(pathname: string, method = 'GET') {
  if (method.toUpperCase() !== 'POST') return;
  const route = pathname.split('?')[0];
  const event: AnalyticsEvent | undefined = route === '/api/inboxes' ? 'workspace_created'
    : /^\/api\/inboxes\/[^/]+\/agent-enrollment-tokens$/.test(route) ? 'agent_enrollment_started'
    : /^\/api\/inboxes\/[^/]+\/agent-onboarding\/[^/]+\/approve$/.test(route) ? 'agent_approved'
    : /^\/api\/inboxes\/[^/]+\/cases\/[^/]+\/actions$/.test(route) ? 'case_decision_submitted'
    : /^\/api\/inboxes\/[^/]+\/cases\/[^/]+\/instructions$/.test(route) ? 'instruction_sent'
    : /^\/api\/inboxes\/[^/]+\/invitations\/[^/]+\/accept$/.test(route) ? 'invitation_accepted'
    : undefined;
  if (event) captureAnalyticsEvent(event);
}
