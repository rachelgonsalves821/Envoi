import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';
import { ApiError, SESSION_EXPIRED_EVENT, api, csrfToken, expectedHumanHeaders, request, setCsrfCookieName, setExpectedHuman } from '../src/api';

// N2 consumption checks run with the paired server/client tree.
const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'envoi-browser-names' && item.version === 1);
if (!contract?.schemas) throw new Error('envoi-browser-names v1 publication required; set ENVOI_CONTRACT_FIXTURES_ROOT to the canonical publication directory');
interface Fixture {
  contract: string; version: number; id: string; oldNamesInRequest?: boolean;
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; schema: string; body: any; headers?: { location?: string; 'cache-control'?: string; 'set-cookie'?: string[] } };
  cookies: { set: string[]; cleared: string[] };
  client: { lifecycle: string; retry: string; guidance: string; next: string };
}
const fixtures = contract.fixtures.map(file => loadContractFixture(contract, file, source) as Fixture);
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const byId = (id: string) => {
  const found = fixtures.find(item => item.id === id);
  if (!found) throw new Error('Missing fixture: ' + id);
  return found;
};
function validate(definition: string, value: unknown) {
  const check = ajv.getSchema(schemas.$id + '#/definitions/' + definition);
  if (!check) throw new Error('Missing schema: ' + definition);
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}
const table = [
  ['sinaloa_session', 'envoi_session', '/', true, 'Lax', 'WORKOS_COOKIE_DOMAIN when set'],
  ['sinaloa_csrf', 'envoi_csrf', '/', false, 'Strict', 'never'],
  ['sinaloa_workos_flow', 'envoi_workos_flow', '/api/auth/workos', true, 'Lax', 'never']
] as const;
const oldNames = table.map(row => row[0]);
function parseCookie(line: string) {
  const [pair, ...attributes] = line.split(';').map(part => part.trim());
  const equals = pair.indexOf('=');
  const attrs = new Map(attributes.map(part => {
    const split = part.indexOf('=');
    return split < 0 ? [part.toLowerCase(), ''] : [part.slice(0, split).toLowerCase(), part.slice(split + 1)];
  }));
  return { name: pair.slice(0, equals), value: pair.slice(equals + 1), attrs };
}
function applyCookies(fixture: Fixture, jar: Map<string, string>) {
  // These fixtures specify host-only cookies. Path is part of a browser cookie's identity.
  for (const line of fixture.response.headers?.['set-cookie'] ?? []) {
    const cookie = parseCookie(line);
    const key = cookie.name + '@' + cookie.attrs.get('path');
    if (cookie.attrs.get('max-age') === '0') jar.delete(key);
    else jar.set(key, cookie.value);
  }
}
function oldJar() {
  return new Map(table.map(row => [row[0] + '@' + row[2], 'pre-cutover']));
}
function response(fixture: Fixture) {
  return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status, headers: { 'content-type': 'application/json' } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  setExpectedHuman(null);
  setCsrfCookieName();
});

describe('envoi-browser-names v1 shared fixture review', () => {
  it('loads all nine unique fixtures directly from the registry and pins the independent naming table', () => {
    expect(fixtures).toHaveLength(9);
    expect(new Set(fixtures.map(item => item.id)).size).toBe(9);
    expect(schemas['x-browser-cookies']).toEqual(table.map(([old, next, cookiePath, httpOnly, sameSite, domain]) => ({
      old, new: next, path: cookiePath, httpOnly, sameSite, domain
    })));
    expect(schemas['x-browser-headers']).toEqual({ 'x-sinaloa-csrf': 'x-envoi-csrf' });
    // Pin the paired cutover versions.
    const registry = loadContractRegistry(source);
    expect(registry.contracts.find(item => item.id === 'a3-pause-auth')?.version).toBe(3);
    expect(registry.contracts.find(item => item.id === 'a4-wake')?.version).toBe(2);
  });

  it.each(fixtures)('validates $id response and consumes its browser guidance', fixture => {
    validate('fixture', fixture);
    validate(fixture.response.schema, fixture.response.body);
    expect(fixture.contract).toBe('envoi-browser-names');
    expect(fixture.version).toBe(1);
    expect(fixture.client).toMatchObject({ lifecycle: 'NOT_APPLICABLE', retry: 'none' });
    const guidance: Record<string, string> = {
      'callback-old-flow-cookie': 'sign_in_again',
      'me-old-cookies-only': 'sign_in_again',
      'logout-old-cookies-only': 'sign_in_again',
      'csrf-old-header-rejected': 'reload_browser'
    };
    expect(fixture.client.guidance).toBe(guidance[fixture.id] ?? 'none');
    const headers = fixture.request.headers ?? {};
    if (Object.keys(headers).some(key => key.includes('sinaloa')) || /sinaloa_/.test(headers.cookie ?? '')) {
      expect(fixture.oldNamesInRequest).toBe(true);
    }
    if (fixture.response.status === 302) {
      expect(fixture.response.body).toBeNull();
      expect(fixture.response.headers?.['cache-control']).toBe('no-store');
      expect(fixture.response.headers?.location).toBeTruthy();
    }
  });

  it.each(fixtures)('consumes $id Set-Cookie as an unordered set with correct scope and lifetime', fixture => {
    const cookies = (fixture.response.headers?.['set-cookie'] ?? []).map(parseCookie);
    expect(new Set(cookies.map(cookie => cookie.name)).size).toBe(cookies.length);
    expect(cookies.filter(cookie => cookie.attrs.get('max-age') !== '0').map(cookie => cookie.name).sort()).toEqual([...fixture.cookies.set].sort());
    expect(cookies.filter(cookie => cookie.attrs.get('max-age') === '0').map(cookie => cookie.name).sort()).toEqual([...fixture.cookies.cleared].sort());
    for (const cookie of cookies) {
      const row = table.find(item => item[0] === cookie.name || item[1] === cookie.name);
      expect(row, cookie.name).toBeDefined();
      expect(cookie.attrs.get('path')).toBe(row![2]);
      expect(cookie.attrs.has('httponly')).toBe(row![3]);
      expect(cookie.attrs.get('samesite')).toBe(row![4]);
      expect(cookie.attrs.has('domain')).toBe(false); // publication is explicitly host-only
      expect(cookie.attrs.has('secure')).toBe(fixture.id !== 'phone-verify-sets-cookies');
      if (oldNames.includes(cookie.name as typeof oldNames[number])) {
        expect(cookie.value).toBe('');
        expect(cookie.attrs.get('max-age')).toBe('0');
      } else if (cookie.attrs.get('max-age') !== '0') {
        expect(cookie.value).toBeTruthy();
        expect(cookie.attrs.get('max-age')).toBe(cookie.name === 'envoi_workos_flow' ? '600' : '86400');
      } else {
        expect(cookie.value).toBe('');
      }
    }
    const forward = oldJar(); const reverse = oldJar();
    applyCookies(fixture, forward);
    applyCookies({ ...fixture, response: { ...fixture.response, headers: { ...fixture.response.headers, 'set-cookie': [...(fixture.response.headers?.['set-cookie'] ?? [])].reverse() } } }, reverse);
    expect([...forward].sort()).toEqual([...reverse].sort());
  });

  it('sets the flow at sign-in start and replaces all retired cookies on callback or phone verification', () => {
    const jar = oldJar();
    applyCookies(byId('sign-in-start-sets-flow-cookie'), jar);
    expect(jar.has('sinaloa_workos_flow@/api/auth/workos')).toBe(false);
    expect(jar.has('envoi_workos_flow@/api/auth/workos')).toBe(true);
    applyCookies(byId('sign-in-sets-cookies'), jar);
    expect([...jar.keys()].sort()).toEqual(['envoi_csrf@/', 'envoi_session@/']);
    expect(byId('sign-in-sets-cookies').response.headers?.location).toBe('/');
    const local = oldJar();
    applyCookies(byId('phone-verify-sets-cookies'), local);
    expect([...local.keys()].sort()).toEqual(['envoi_csrf@/', 'envoi_session@/']);
  });

  it('clears only request-carried retired names on me 401 and all retired names on failed callback', () => {
    const me = byId('me-old-cookies-only');
    expect(me.response).toMatchObject({ status: 401, body: { error: 'Authenticated human session required' } });
    expect([...me.cookies.cleared].sort()).toEqual(['sinaloa_csrf', 'sinaloa_session']);
    const jar = oldJar();
    applyCookies(me, jar);
    expect([...jar.keys()]).toEqual(['sinaloa_workos_flow@/api/auth/workos']);
    const callback = byId('callback-old-flow-cookie');
    expect(callback.response.headers?.location).toBe('/?auth_error=sign_in_failed');
    jar.set('envoi_workos_flow@/api/auth/workos', 'new-flow');
    applyCookies(callback, jar);
    expect(jar.size).toBe(0);
  });

  it('logout covers both authenticated new cookies and ignored old cookies, including nullable logoutUrl', () => {
    for (const id of ['logout-clears-cookies', 'logout-old-cookies-only']) {
      const fixture = byId(id); const jar = oldJar();
      jar.set('envoi_session@/', 'new-session'); jar.set('envoi_csrf@/', 'new-csrf');
      applyCookies(fixture, jar);
      expect(jar.size).toBe(0);
      expect(fixture.response.status).toBe(200);
    }
    expect(byId('logout-clears-cookies').response.body.revoked).toBe(true);
    expect(new URL(byId('logout-clears-cookies').response.body.logoutUrl).origin).toBe('https://api.workos.com');
    expect(byId('logout-old-cookies-only').response.body).toEqual({ revoked: false, logoutUrl: null });
    expect(byId('logout-old-cookies-only').request.headers?.cookie).not.toContain('envoi_session=');
  });

  it('the positive mutation supplies both matching Origin and new CSRF header; the negative isolates the old header', () => {
    const positive = byId('logout-clears-cookies');
    const negative = byId('csrf-old-header-rejected');
    for (const fixture of [positive, negative]) {
      const headers = fixture.request.headers!;
      expect(headers.origin).toBe('https://www.envoi-agents.com');
      expect(headers.cookie).toContain('envoi_session=');
      setCsrfCookieName('envoi_csrf');
      expect(csrfToken(headers.cookie)).toBe('PLACEHOLDER');
      expect(headers[fixture === positive ? 'x-envoi-csrf' : 'x-sinaloa-csrf']).toBe(csrfToken(headers.cookie));
    }
    expect(positive.request.headers?.['x-sinaloa-csrf']).toBeUndefined();
    expect(negative.request.headers?.['x-envoi-csrf']).toBeUndefined();
    expect(negative.response).toMatchObject({ status: 403, body: { error: 'CSRF validation failed' } });
    expect(negative.client.next).toContain('Do not retry');
    expect(expectedHumanHeaders('POST', negative.request.path, 'human_example')).toEqual({ 'x-envoi-expected-human': 'human_example' });
  });
});

describe('existing frontend consumes published response shapes', () => {
  it('authConfig learns envoi_csrf and the existing cookie reader ignores the retired cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(byId('auth-config-csrf-cookie'))));
    await expect(api.authConfig()).resolves.toEqual(byId('auth-config-csrf-cookie').response.body);
    expect(csrfToken('sinaloa_csrf=retired; envoi_csrf=new-token')).toBe('new-token');
    expect(csrfToken('sinaloa_csrf=retired')).toBeNull();
  });

  it.each(['logout-clears-cookies', 'logout-old-cookies-only'])('logout consumes %s without requiring logoutUrl to be a string', async id => {
    const fixture = byId(id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture)));
    await expect(api.logout()).resolves.toEqual(fixture.response.body);
  });

  it('phoneVerify retains the second-factor decision', async () => {
    const fixture = byId('phone-verify-sets-cookies');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture)));
    await expect(api.phoneVerify('challenge_example', '000000')).resolves.toEqual(fixture.response.body);
  });

  it('me 401 announces session expiry for the existing stream-error identity probe', async () => {
    // EventSource does not expose HTTP status. App.onerror currently calls api.me().
    // This proves response consumption at that boundary, not the mounted UI or a real stream.
    const fixture = byId('me-old-cookies-only');
    const browserWindow = new EventTarget(); const expired = vi.fn();
    browserWindow.addEventListener(SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture)));
    await expect(api.me()).rejects.toMatchObject({ status: 401, message: fixture.response.body.error });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('persistent plain CSRF failure remains an ApiError usable by the Reload UI', async () => {
    const fixture = byId('csrf-old-header-rejected');
    setCsrfCookieName('envoi_csrf'); setExpectedHuman('human_example');
    vi.stubGlobal('document', { cookie: fixture.request.headers!.cookie });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(fixture))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'human_example' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request(fixture.request.path, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      name: 'ApiError', status: 403, message: 'CSRF validation failed', code: 'CSRF validation failed'
    } satisfies Partial<ApiError>);
    // Unchanged CSRF tokens cannot recover an old-header or wrong-Origin rejection.
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([fixture.request.path, '/api/auth/me']);
  });
});

