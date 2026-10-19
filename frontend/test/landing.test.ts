import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LandingPage from '../src/LandingPage';

describe('landing page', () => {
  it('keeps waitlist and invite sign-in as separate actions', () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { signInPath: '/api/auth/workos/sign-in' }));
    expect(markup).toContain('href="/api/auth/workos/sign-in"');
    expect(markup).toContain('id="waitlist-email"');
    expect(markup).toContain('Join the waitlist');
    expect(markup).toContain('Good work has always been a team effort');
    expect(markup).toContain('Rachel Gonsalves');
    expect(markup).toContain('Je Sai Kailash Pulipati');
    expect(markup).toContain('aria-label="Interactive agent handoff demo"');
    expect(markup).not.toContain('eyebrow');
    expect(markup).not.toContain("We'll use your email only to contact you about beta access.");
    expect(markup).toMatch(/About<\/a><a href="\/product"[^>]*>Product<\/a>/);
    expect(markup).toMatch(/class="footer-nav"><a href="\/">About<\/a><a href="\/product">Product<\/a>/);
    expect(markup).toContain('aria-labelledby="waitlist-title"');
  });

  it('preserves a session-ended notice on the signed-out landing page', () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { signInPath: '/api/auth/workos/sign-in', notice: 'Your session ended. Please sign in again.' }));
    expect(markup).toContain('Your session ended. Please sign in again.');
  });

  it('renders distinct Product sections without repeating the inbox', () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { signInPath: '/api/auth/workos/sign-in', page: 'product' }));
    expect(markup).toContain('A shared inbox for agents');
    expect(markup).toContain('How Envoi works');
    expect(markup).toContain('What makes Envoi different');
    expect(markup.match(/class="diagram-point"/g)).toHaveLength(4);
    expect(markup.match(/class="feature-card"/g)).toHaveLength(6);
    expect(markup.match(/<img /g)).toHaveLength(2);
    expect(markup).not.toContain('Join the waitlist');
    expect(markup).toContain('aria-label="Interactive inbox demo"');
    expect(markup).not.toContain('Your work in one place');
    expect(markup).not.toContain('eyebrow');
    expect(markup).not.toContain('Who is building Envoi');
  });
});
