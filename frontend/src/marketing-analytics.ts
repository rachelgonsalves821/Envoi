import { captureAnalyticsEvent, captureAnalyticsPageview, initAnalytics, type AnalyticsOptions } from './analytics';

// Explicit events only. Never capture link text, destination URLs or form data.
export function initMarketingAnalytics(options: AnalyticsOptions = {}) {
  initAnalytics(options);
  const boundBodies = new WeakSet<HTMLElement>();
  let boundWithoutBody = false;
  let firstPage = true;
  const bindPage = () => {
    if (document.body) {
      if (boundBodies.has(document.body)) return;
      boundBodies.add(document.body);
    } else {
      if (boundWithoutBody) return;
      boundWithoutBody = true;
    }
    if (firstPage) firstPage = false;
    else captureAnalyticsPageview();
    document.querySelectorAll<HTMLAnchorElement>('[data-analytics-auth]').forEach(link => {
      link.addEventListener('click', () => {
        if (link.dataset.analyticsAuth === 'sign-up') captureAnalyticsEvent('sign_up_started');
        if (link.dataset.analyticsAuth === 'sign-in') captureAnalyticsEvent('sign_in_started');
      });
    });
  };
  bindPage();
  document.addEventListener?.('astro:page-load', bindPage);
}
