// envoi-browser-names v1 (task N2-server): the browser cookie and CSRF header cutover. Cookie
// strings are checked against the approved contract fixtures; behaviour runs on a real server
// with the local provider (the WorkOS routes need a live provider, so their cookies are covered
// by the fixture equivalence and the AUTH_FLOW_INVALID unit test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../src/storage.js';
import {
  WorkOSAuthService, assertBrowserCookieNames, authFlowCookieHeader, csrfCookieHeader, retiredCookieClears, retiredCookieNames,
  retiredCookiesIn, sessionCookieHeader, verifyCsrfRequest
} from '../src/workos-auth.js';
import { api, launch, owner } from './a3-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async id => JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'envoi-browser-names', `${id}.json`), 'utf8'));
const sorted = values => [...values].sort();

// Builds cookies under an exact environment, then restores it.
function withEnv(values, build) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return build(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const production = build => withEnv({ ENVOI_AUTH_MODE: 'production', ENVOI_COOKIE_SECURE: '', WORKOS_COOKIE_DOMAIN: '' }, build);

test('the server builds exactly the cookies of every approved fixture', async () => {
  const cases = {
    'sign-in-start-sets-flow-cookie': () => [authFlowCookieHeader('PLACEHOLDER'), ...retiredCookieClears(['sinaloa_workos_flow'])],
    'sign-in-sets-cookies': () => [sessionCookieHeader('PLACEHOLDER'), csrfCookieHeader('PLACEHOLDER'), authFlowCookieHeader('', { clear: true }), ...retiredCookieClears()],
    'callback-old-flow-cookie': () => [authFlowCookieHeader('', { clear: true }), ...retiredCookieClears()],
    'logout-clears-cookies': () => [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true }), ...retiredCookieClears()],
    'logout-old-cookies-only': () => [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true }), ...retiredCookieClears()],
    'me-old-cookies-only': () => retiredCookieClears(retiredCookiesIn('sinaloa_session=PLACEHOLDER; sinaloa_csrf=PLACEHOLDER'))
  };
  for (const [id, build] of Object.entries(cases)) {
    assert.deepEqual(sorted(production(build)), sorted((await fixture(id)).response.headers['set-cookie']), id);
  }
  // Local phone verification runs outside production, so its cookies carry no Secure.
  const phone = withEnv({ ENVOI_AUTH_MODE: 'development', ENVOI_COOKIE_SECURE: '', WORKOS_COOKIE_DOMAIN: '' }, () => [sessionCookieHeader('PLACEHOLDER'), csrfCookieHeader('PLACEHOLDER'), ...retiredCookieClears()]);
  assert.deepEqual(sorted(phone), sorted((await fixture('phone-verify-sets-cookies')).response.headers['set-cookie']), 'phone-verify-sets-cookies');
});

test('the retired session cookie is cleared host-only and, with a cookie domain, also with that domain', () => {
  const clears = withEnv({ ENVOI_AUTH_MODE: 'production', WORKOS_COOKIE_DOMAIN: 'envoi-agents.com' }, () => retiredCookieClears(['sinaloa_session']));
  assert.equal(clears.length, 2);
  assert.ok(clears.some(value => !value.includes('Domain=')), 'host-only form');
  assert.ok(clears.some(value => value.includes('Domain=envoi-agents.com')), 'domain form');
  assert.ok(clears.every(value => value.startsWith('sinaloa_session=;') && value.endsWith('Max-Age=0')));
});

test('only the retired names a request carried are reported, by name', () => {
  assert.deepEqual(retiredCookiesIn('sinaloa_csrf=x; envoi_session=y'), ['sinaloa_csrf']);
  assert.deepEqual(retiredCookiesIn(''), []);
  assert.deepEqual(retiredCookieNames, ['sinaloa_session', 'sinaloa_csrf', 'sinaloa_workos_flow']);
});

test('only x-envoi-csrf passes the CSRF check', () => {
  const cookie = 'envoi_csrf=token';
  withEnv({ ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' }, () => {
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://www.envoi-agents.com', 'x-envoi-csrf': 'token' } }), true);
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://www.envoi-agents.com', 'x-sinaloa-csrf': 'token' } }), false, 'the retired header is ignored');
  });
});

test('startup refuses a retired cookie name or a session name equal to the CSRF name', () => {
  for (const name of retiredCookieNames) assert.throws(() => assertBrowserCookieNames({ session: name, csrf: 'envoi_csrf' }), /retired/);
  assert.throws(() => assertBrowserCookieNames({ session: 'envoi_session', csrf: 'sinaloa_csrf' }), /retired/);
  assert.throws(() => assertBrowserCookieNames({ session: 'same', csrf: 'same' }), /must differ/);
  assert.doesNotThrow(() => assertBrowserCookieNames({ session: 'envoi_session', csrf: 'envoi_csrf' }));
});

test('a missing or mismatched sign-in flow fails with AUTH_FLOW_INVALID, which the callback turns into a redirect', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-browser-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://www.envoi-agents.com/api/auth/workos/callback', workos: {}, invitedEmails: 'owner@example.com' });
  await assert.rejects(auth.completeAuthorization({ code: 'code', state: 'state', browserBinding: undefined }), error => error.code === 'AUTH_FLOW_INVALID' && error.statusCode === 401);
  await assert.rejects(auth.completeAuthorization({ code: 'code', state: 'state', browserBinding: 'b'.repeat(43) }), error => error.code === 'AUTH_FLOW_INVALID');
});

test('a server started with a retired cookie override refuses to start', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-browser-names-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(here, '..'),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', SINALOA_PORT: '0', ENVOI_AUTH_MODE: 'development', SINALOA_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, SINALOA_DATA_DIR: dataDir, WORKOS_COOKIE_NAME: 'sinaloa_session' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0, output);
  assert.match(output, /retired/);
  assert.doesNotMatch(output, /listening on/);
});

test('a real server sets and clears the Envoi names, ignores old cookies and refuses the old CSRF header', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const setCookies = res => res.headers.getSetCookie();
  const names = values => values.map(value => value.slice(0, value.indexOf('=')));
  const cleared = values => values.filter(value => /^[^=]+=;/.test(value) && /Max-Age=0/.test(value)).map(value => value.slice(0, value.indexOf('=')));

  // Phone verification sets envoi_* and clears the three retired names.
  const alice = await owner(baseUrl, '6101');
  const reverify = await api(baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165556101', displayName: 'N2 owner' } });
  const verified = await api(baseUrl, '/api/auth/phone/verify', { body: { challengeId: reverify.payload.challengeId, code: reverify.payload.developmentCode } });
  assert.equal(verified.status, 200, verified.text);
  assert.ok(names(setCookies(verified)).includes('envoi_session') && names(setCookies(verified)).includes('envoi_csrf'));
  assert.deepEqual(sorted(cleared(setCookies(verified))), sorted(retiredCookieNames));
  assert.ok(!('sessionCookieValue' in verified.payload), 'the session value never reaches the body');

  // CORS advertises only the Envoi header.
  const allow = verified.headers.get('access-control-allow-headers');
  assert.match(allow, /x-envoi-csrf/);
  assert.doesNotMatch(allow, /x-sinaloa-csrf/);

  // A mutation with the Envoi cookies and origin, but only the retired header, fails the CSRF gate.
  const sessionHeaders = alice.session.headers(baseUrl, 'POST');
  const oldHeader = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/pause`, {
    headers: { cookie: sessionHeaders.cookie, origin: sessionHeaders.origin, 'x-sinaloa-csrf': sessionHeaders['x-envoi-csrf'] }, body: {}
  });
  assert.equal(oldHeader.status, 403, oldHeader.text);
  assert.deepEqual(oldHeader.payload, { error: 'CSRF validation failed' });

  // A browser holding only retired cookies is not signed in and is told to drop them.
  const stale = await api(baseUrl, '/api/auth/me', { headers: { cookie: 'sinaloa_session=PLACEHOLDER; sinaloa_csrf=PLACEHOLDER' } });
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.payload, { error: 'Authenticated human session required' });
  assert.deepEqual(sorted(cleared(setCookies(stale))), ['sinaloa_csrf', 'sinaloa_session']);

  // Logout with the Envoi header passes the gate and clears new and retired names.
  const out = await api(baseUrl, '/api/auth/logout', { session: alice.session, body: {} });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(sorted(cleared(setCookies(out))), sorted(['envoi_session', 'envoi_csrf', ...retiredCookieNames]));
});
