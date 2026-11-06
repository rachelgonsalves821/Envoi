import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { assertSameOriginAuthLinks } from '../marketing-preview/scripts/auth-link-policy.mjs';

const origins = [
  'https://sinaloa-staging.rachelgonsalves821.workers.dev',
  'https://www.envoi-agents.com',
  'http://localhost:4328'
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const signIn = '<a href="/api/auth/workos/sign-in?returnTo=%2Fapp" data-analytics-auth="sign-in">Sign in</a>';
const signUp = '<a href="/api/auth/workos/sign-up?returnTo=%2Fapp" data-analytics-auth="sign-up">Sign up</a>';

it('the build guard accepts both same-origin authentication actions', () => {
  expect(() => assertSameOriginAuthLinks(signIn + signUp, '/')).not.toThrow();
});

it('the build guard preserves the local account introduction without allowing cross-origin signup', () => {
  const entry = '<a href="/create-account/" data-analytics-auth="sign-up">Start now</a>';
  expect(() => assertSameOriginAuthLinks(signIn + signUp + entry, '/')).not.toThrow();
  const external = entry.replace('/create-account/', 'https://www.envoi-agents.com/create-account/');
  expect(() => assertSameOriginAuthLinks(signIn + signUp + external, '/')).toThrow();
  expect(() => assertSameOriginAuthLinks(signIn + entry, '/')).toThrow();
});

for (const [label, href] of [
  ['absolute production', 'https://www.envoi-agents.com/api/auth/workos/sign-in?returnTo=%2Fapp'],
  ['absolute staging', 'https://sinaloa-staging.rachelgonsalves821.workers.dev/api/auth/workos/sign-in?returnTo=%2Fapp'],
  ['protocol-relative', '//www.envoi-agents.com/api/auth/workos/sign-in?returnTo=%2Fapp'],
  ['missing return path', '/api/auth/workos/sign-in'],
  ['external return path', '/api/auth/workos/sign-in?returnTo=https://www.envoi-agents.com/app'],
  ['fragment', '/api/auth/workos/sign-in?returnTo=%2Fapp#other'],
  ['wrong route', '/other-login?returnTo=%2Fapp']
]) {
  it(`the build guard rejects a ${label} auth link`, () => {
    const changed = signIn.replace('/api/auth/workos/sign-in?returnTo=%2Fapp', href);
    expect(() => assertSameOriginAuthLinks(changed + signUp, '/')).toThrow();
  });
}

it('the build guard rejects an extra cross-origin footer link and missing actions', () => {
  const external = '<a href="https://www.envoi-agents.com/api/auth/workos/sign-up?returnTo=%2Fapp">Footer signup</a>';
  expect(() => assertSameOriginAuthLinks(signIn + signUp + external, '/')).toThrow();
  expect(() => assertSameOriginAuthLinks(signIn, '/')).toThrow();
  expect(() => assertSameOriginAuthLinks(signUp, '/')).toThrow();
  expect(() => assertSameOriginAuthLinks('', '/')).toThrow();
});

for (const origin of origins) {
  for (const page of ['index.html', 'product/index.html']) {
    it(`${page} keeps every rendered login/signup link on ${origin}`, () => {
      const html = readFileSync(new URL(`../../web/marketing/${page}`, import.meta.url), 'utf8');
      for (const route of ['sign-in', 'sign-up']) {
        const anchors = [...html.matchAll(/<a\b[^>]*>/g)]
          .map(([anchor]) => anchor.match(/\bhref="([^"]+)"/)?.[1])
          .filter((href): href is string => !!href && new URL(href, origin).pathname === `/api/auth/workos/${route}`);
        expect(anchors.length).toBeGreaterThan(0);
        for (const href of anchors) {
          const target = new URL(href, origin);
          expect(target.origin).toBe(origin);
          expect(target.pathname).toBe(`/api/auth/workos/${route}`);
          expect(target.searchParams.get('returnTo')).toBe('/app');
          expect(target.hash).toBe('');
        }
      }
    });
  }

  it(`landing preview keeps login on ${origin} despite a stale production build URL`, () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_PUBLIC_URL', 'https://www.envoi-agents.com');
    vi.stubGlobal('window', { location: new URL(`${origin}/?landing-preview`) });
    const html = renderToStaticMarkup(createElement(App));
    const links = [...html.matchAll(/href="([^"]+)"/g)]
      .map(([, href]) => new URL(href, origin))
      .filter(url => url.pathname === '/api/auth/workos/sign-in');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.origin).toBe(origin);
  });
}
