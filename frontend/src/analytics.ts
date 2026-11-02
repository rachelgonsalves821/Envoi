import posthog from 'posthog-js';

// PostHog project tokens are public browser credentials. Production builds use
// Envoi's US Cloud project; the variables allow a different project if needed.
const defaultProjectToken = (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN ||
  (import.meta.env.PROD ? 'phc_nayMdaa954vNC4Dkx33k9Ui38kPQyp2xhn2YUYiFFfHH' : '')).trim();
const defaultApiHost = (import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').trim();
export type AnalyticsOptions = { projectToken?: string; apiHost?: string };
let initialized = false;

type AnalyticsEvent =
  | 'waitlist_joined'
  | 'sign_up_started'
  | 'sign_in_started'
  | 'beta_app_opened'
  | 'workspace_created'
  | 'agent_enrollment_started'
  | 'agent_approved'
  | 'case_decision_submitted'
  | 'instruction_sent'
  | 'invitation_accepted';

const productEvents: AnalyticsEvent[] = [
  'waitlist_joined', 'sign_up_started', 'sign_in_started', 'beta_app_opened', 'workspace_created',
  'agent_enrollment_started', 'agent_approved', 'case_decision_submitted',
  'instruction_sent', 'invitation_accepted'
];

function publicPage() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return ['/', '/about', '/product', '/app', '/connect', '/claim', '/authorize-agent'].includes(path) ? path : '/';
}

export function initAnalytics(options: AnalyticsOptions = {}) {
  if (initialized) return;
  const projectToken = (options.projectToken || defaultProjectToken).trim();
  const apiHost = (options.apiHost || defaultApiHost).trim();
  if (!projectToken || !apiHost || !/^https:\/\//.test(apiHost)) return;

  try {
    posthog.init(projectToken, {
      api_host: apiHost,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      advanced_disable_feature_flags: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      person_profiles: 'never',
      before_send: event => {
        if (!event || !['$pageview', ...productEvents].includes(event.event)) return null;
        // The SDK drops events without properties.token. Preserve only anonymous
        // ingestion/session fields, never form values, account IDs or raw URLs.
        const { token, distinct_id, $device_id, $session_id, $window_id } = event.properties;
        return {
          event: event.event, uuid: event.uuid, timestamp: event.timestamp,
          properties: { token, distinct_id, $device_id, $session_id, $window_id,
            $process_person_profile: false, $current_url: `${window.location.origin}${publicPage()}` }
        };
      }
    });

    initialized = true;
    posthog.capture('$pageview');
  } catch {
    // Analytics must never prevent loading the app or completing a user action.
  }
}

export function captureAnalyticsEvent(event: AnalyticsEvent) {
  if (!initialized) return;
  try { posthog.capture(event); } catch { /* Do not turn a saved action into an error. */ }
}

export function captureAnalyticsPageview() {
  if (!initialized) return;
  try { posthog.capture('$pageview'); } catch { /* Navigation must remain usable. */ }
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
