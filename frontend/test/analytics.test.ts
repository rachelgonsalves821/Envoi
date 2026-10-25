import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult, PostHogConfig } from 'posthog-js';
import { createRequire } from 'node:module';

const { init, capture } = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { init, capture } }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_POSTHOG_PROJECT_TOKEN', 'phc_test');
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
  vi.stubGlobal('window', { location: {
    origin: 'https://www.envoi-agents.com', pathname: '/app',
    search: '?code=private-code&email=private@example.com', hash: '#private-message'
  } });
  vi.stubGlobal('location', window.location);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function start() {
  const analytics = await import('../src/analytics');
  analytics.initAnalytics();
  return { ...analytics, config: init.mock.calls[0][1] as Partial<PostHogConfig> };
}

function event(name = '$pageview'): CaptureResult {
  return {
    uuid: '019a1ac0-0000-7000-8000-000000000001', event: name, timestamp: new Date(0),
    properties: {
      token: 'phc_test', distinct_id: 'anonymous-browser', $device_id: 'anonymous-device',
      $session_id: '019a1ac0-0000-7000-8000-000000000002', $window_id: 'anonymous-window',
      $current_url: 'https://www.envoi-agents.com/app?email=private@example.com',
      $referrer: 'https://private.example/message', email: 'private@example.com',
      caseId: 'private-case', content: 'private message', $set: { email: 'private@example.com' }
    },
    $set: { email: 'private@example.com' }, $set_once: { name: 'Private Name' }
  };
}

describe('anonymous PostHog ingestion', () => {
  it('passes the installed SDK ingestion guard with token and anonymous session IDs intact', async () => {
    const { config } = await start();
    // Execute the installed SDK's actual before_send guard without init or network.
    const browserWindow = window;
    vi.unstubAllGlobals();
    // The published main bundle mangles private method names; use its shipped
    // unminified implementation for this version-pinned SDK boundary regression.
    const { PostHog } = createRequire(import.meta.url)('posthog-js/lib/src/posthog-core.js');
    const sdk = new PostHog();
    vi.stubGlobal('window', browserWindow);
    sdk.config.before_send = config.before_send;
    const result = Reflect.get(sdk, '_runBeforeSend').call(sdk, event()) as CaptureResult;
    expect(result).not.toBeNull();
    expect(result.properties).toEqual({
      token: 'phc_test', distinct_id: 'anonymous-browser', $device_id: 'anonymous-device',
      $session_id: '019a1ac0-0000-7000-8000-000000000002', $window_id: 'anonymous-window',
      $process_person_profile: false, $current_url: 'https://www.envoi-agents.com/app'
    });
    expect(result.uuid).toBe(event().uuid);
    expect(result.timestamp).toEqual(new Date(0));
    expect(JSON.stringify(result)).not.toMatch(/private|Private|email|\$set/);
  });

  it('applies the same allowlist to custom events and rejects unapproved automatic events', async () => {
    const { config } = await start();
    const filter = config.before_send as (event: CaptureResult | null) => CaptureResult | null;
    for (const name of ['instruction_sent', 'waitlist_joined', 'sign_up_started', 'sign_in_started']) {
      const result = filter(event(name));
      expect(result?.properties.token).toBe('phc_test');
      expect(result?.properties.$session_id).toBe(event().properties.$session_id);
      expect(JSON.stringify(result)).not.toMatch(/private|Private|email|\$set/);
    }
    for (const name of ['$autocapture', '$identify', '$snapshot', 'unknown']) expect(filter(event(name))).toBeNull();
    expect(filter(null)).toBeNull();
  });

  it.each(['/', '/product/', '/app', '/connect', '/claim', '/authorize-agent', '/cases/private-id'])('sanitizes page location %s', async pathname => {
    window.location.pathname = pathname;
    const { config } = await start();
    const filter = config.before_send as (event: CaptureResult) => CaptureResult;
    const safePath = pathname === '/cases/private-id' ? '/' : pathname.replace(/\/$/, '') || '/';
    expect(filter(event()).properties.$current_url).toBe(`https://www.envoi-agents.com${safePath}`);
  });

  it('initializes once with replay, automatic capture and person profiles disabled', async () => {
    const { initAnalytics, config } = await start();
    initAnalytics();
    expect(init).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls).toEqual([['$pageview']]);
    expect(config).toMatchObject({ autocapture: false, capture_pageview: false,
      capture_pageleave: false, disable_session_recording: true, person_profiles: 'never',
      advanced_disable_feature_flags: true, disable_surveys: true, disable_external_dependency_loading: true });
  });

  it('supports the public Astro overrides and stays disabled in unconfigured development', async () => {
    vi.stubEnv('VITE_POSTHOG_PROJECT_TOKEN', '');
    vi.stubEnv('PROD', false);
    const { initAnalytics, captureAnalyticsEvent } = await import('../src/analytics');
    initAnalytics();
    captureAnalyticsEvent('beta_app_opened');
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    initAnalytics({ projectToken: 'phc_marketing', apiHost: 'https://eu.i.posthog.com' });
    expect(init).toHaveBeenCalledWith('phc_marketing', expect.objectContaining({ api_host: 'https://eu.i.posthog.com' }));
  });

  it('does not let SDK exceptions fail a user action or app startup', async () => {
    const { captureAnalyticsEvent, initAnalytics } = await import('../src/analytics');
    init.mockImplementationOnce(() => { throw new Error('SDK unavailable'); });
    expect(() => initAnalytics()).not.toThrow();
    initAnalytics();
    capture.mockImplementation(() => { throw new Error('SDK unavailable'); });
    expect(() => captureAnalyticsEvent('instruction_sent')).not.toThrow();
  });

  it('captures a successful API action once and never captures a refused action', async () => {
    await start();
    capture.mockClear();
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":"Denied"}', { status: 403 })));
    const { request } = await import('../src/api');
    await request('/api/inboxes/private/cases/private/instructions', { method: 'POST', body: '{"text":"private message"}' });
    await expect(request('/api/inboxes/private/cases/private/instructions', { method: 'POST' })).rejects.toMatchObject({ status: 403 });
    expect(capture.mock.calls).toEqual([['instruction_sent']]);
  });

  it('records marked marketing auth links without preventing navigation or reading link text', async () => {
    const signUp = Object.assign(new EventTarget(), { dataset: { analyticsAuth: 'sign-up' } });
    const signIn = Object.assign(new EventTarget(), { dataset: { analyticsAuth: 'sign-in' } });
    const unknown = Object.assign(new EventTarget(), { dataset: { analyticsAuth: 'private' } });
    vi.stubGlobal('document', { querySelectorAll: () => [signUp, signIn, unknown] });
    const { initMarketingAnalytics } = await import('../src/marketing-analytics');
    initMarketingAnalytics();
    const click = new Event('click', { cancelable: true });
    signUp.dispatchEvent(click);
    signIn.dispatchEvent(new Event('click'));
    unknown.dispatchEvent(new Event('click'));
    expect(click.defaultPrevented).toBe(false);
    expect(capture.mock.calls).toEqual([['$pageview'], ['sign_up_started'], ['sign_in_started']]);
  });
});
