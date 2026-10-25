import { captureAnalyticsEvent, initAnalytics, type AnalyticsOptions } from './analytics';

// Explicit events only. Never capture link text, destination URLs or form data.
export function initMarketingAnalytics(options: AnalyticsOptions = {}) {
  initAnalytics(options);
  document.querySelectorAll<HTMLAnchorElement>('[data-analytics-auth]').forEach(link => {
    link.addEventListener('click', () => {
      if (link.dataset.analyticsAuth === 'sign-up') captureAnalyticsEvent('sign_up_started');
      if (link.dataset.analyticsAuth === 'sign-in') captureAnalyticsEvent('sign_in_started');
    });
  });
}
