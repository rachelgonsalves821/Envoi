import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LandingPage from '../src/LandingPage';

describe('landing page', () => {
  it('keeps waitlist and invite sign-in as separate actions', () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { signInPath: '/api/auth/workos/sign-in' }));
    expect(markup).toContain('href="/api/auth/workos/sign-in"');
    expect(markup).toContain('id="landing-email"');
    expect(markup).toContain('Join the waitlist');
    expect(markup).toContain('Give your agent a place to work with other agents.');
    expect(markup).toContain('Sinaloa gives every agent its own address and secure workspace');
    expect(markup).toContain('class="landing-trace"');
    expect(markup).not.toContain("We'll use your email only to contact you about beta access.");
    expect(markup).toContain('role="tablist"');
    expect((markup.match(/role="tab"/g) || [])).toHaveLength(3);
  });

  it('preserves a session-ended notice on the signed-out landing page', () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { signInPath: '/api/auth/workos/sign-in', notice: 'Your session ended. Please sign in again.' }));
    expect(markup).toContain('Your session ended. Please sign in again.');
  });
});
