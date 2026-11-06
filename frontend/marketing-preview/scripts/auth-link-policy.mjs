import assert from 'node:assert/strict';

// Check the rendered anchors, including footer/CTA links, rather than source defaults.
// A production absolute URL must fail even when the artifact is built for production.
export function assertSameOriginAuthLinks(html, page) {
  const routes = new Set(['sign-in', 'sign-up']);
  const found = new Set();
  for (const [anchor] of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = anchor.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    const marked = anchor.match(/\bdata-analytics-auth\s*=\s*["']([^"']*)["']/i)?.[1];
    const url = new URL(href || '', 'https://staging.example.test');
    const route = url.pathname.match(/^\/api\/auth\/workos\/(sign-in|sign-up)$/)?.[1];
    if (!route && !marked) continue;
    assert.ok(route && routes.has(route), `${page}: unknown auth route: ${href}`);
    if (marked) assert.equal(marked, route, `${page}: auth action must match its route`);
    assert.equal(href, `/api/auth/workos/${route}?returnTo=%2Fapp`,
      `${page}: auth links must stay on the serving origin and return to /app: ${href}`);
    found.add(route);
  }
  for (const route of routes) assert.ok(found.has(route), `${page}: missing ${route} link`);
}
