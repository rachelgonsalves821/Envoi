import { describe, expect, it } from 'vitest';
import { internalRoute } from '../src/internal-navigation';

describe('internal navigation', () => {
  const origin = 'https://www.envoi-agents.com';

  it.each(['/app', '/claim', '/connect', '/authorize-agent?handle=request-1'])('keeps %s in the mounted app', href => {
    expect(internalRoute(href, origin)).toBe(href);
  });

  it('leaves external, resource, authentication and modified links to the browser', () => {
    expect(internalRoute('https://elsewhere.example/app', origin)).toBeNull();
    expect(internalRoute('/connect/SKILL.md', origin)).toBeNull();
    expect(internalRoute('/api/auth/workos/sign-in', origin)).toBeNull();
    expect(internalRoute('/app', origin, '_blank')).toBeNull();
    expect(internalRoute('/app', origin, '', true)).toBeNull();
    expect(internalRoute('/app', origin, '', false, true)).toBeNull();
    expect(internalRoute('/app', origin, '', false, false, 1)).toBeNull();
  });
});
