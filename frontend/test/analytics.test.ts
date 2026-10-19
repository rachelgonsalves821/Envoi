import { afterEach, describe, expect, it, vi } from 'vitest';

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { init, capture: vi.fn() } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  init.mockClear();
});

describe('analytics privacy filter', () => {
  it('keeps ingestion fields while removing private browser and product data', async () => {
    vi.stubEnv('VITE_POSTHOG_PROJECT_TOKEN', 'phc_test');
    vi.stubGlobal('window', { location: { origin: 'https://www.envoi-agents.com', pathname: '/private/case/123' } });
    vi.resetModules();
    const { initAnalytics } = await import('../src/analytics');
    initAnalytics();

    const beforeSend = init.mock.calls[0][1].before_send;
    const properties = {
      token: 'phc_test', distinct_id: 'anonymous-visit',
      $current_url: 'https://www.envoi-agents.com/private/case/123?email=private@example.com',
      email: 'private@example.com', case_content: 'private case text'
    };
    expect(beforeSend({ event: '$pageview', properties: { ...properties } }).properties).toEqual({
      token: 'phc_test', distinct_id: 'anonymous-visit',
      $process_person_profile: false, $current_url: 'https://www.envoi-agents.com/'
    });
    expect(beforeSend({ event: 'instruction_sent', properties: { ...properties } }).properties).toEqual({
      token: 'phc_test', distinct_id: 'anonymous-visit', $process_person_profile: false
    });
    expect(beforeSend({ event: '$autocapture', properties: { ...properties } })).toBeNull();
  });
});
