import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { WorkOS } from '@workos-inc/node';
import { FileStore } from '../src/storage.js';
import { WorkOSAuthService } from '../src/workos-auth.js';

const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = () => ({
  headers: new Map(), headersSent: false,
  getHeader(name) { return this.headers.get(name); },
  setHeader(name, value) { this.headers.set(name, value); },
  writeHead() { this.headersSent = true; }
});

async function fixture({ sessionHours = 24 } = {}) {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-session-')));
  await store.init();
  let now = 1_800_000_000_000;
  const user = { id: 'user_one', email: 'member@example.com', emailVerified: true };
  const tokens = new Map([
    ['old', { sid: 'sid_one', iat: now / 1000 - 600, exp: now / 1000 - 1 }],
    ['new', { sid: 'sid_one', iat: now / 1000, exp: now / 1000 + 300 }]
  ]);
  const calls = { authenticate: 0, refresh: 0, revoke: 0 };
  let refresh = async () => ({ authenticated: true, sealedSession: 'new' });
  let revoke = async () => {};
  const workos = { userManagement: {
    getSessionFromCookie: async ({ sessionData }) => {
      const claims = tokens.get(sessionData);
      return claims ? { accessToken: jwt(claims), refreshToken: 'refresh_secret', user } : {};
    },
    loadSealedSession: ({ sessionData }) => ({
      authenticate: async () => {
        calls.authenticate += 1;
        const claims = tokens.get(sessionData);
        if (!claims) return { authenticated: false, reason: 'invalid_session_cookie' };
        if (claims.exp * 1000 <= now) return { authenticated: false, reason: 'invalid_jwt' };
        return { authenticated: true, user, sessionId: claims.sid, accessToken: jwt(claims) };
      },
      refresh: async () => { calls.refresh += 1; return refresh(); }
    }),
    getLogoutUrl: ({ sessionId }) => `https://auth.example/logout?session_id=${sessionId}`,
    revokeSession: async ({ sessionId }) => { assert.equal(sessionId, 'sid_one'); calls.revoke += 1; return revoke(); }
  } };
  const options = { clientId: 'client_one', apiKey: 'sk_test', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://app.example/callback', invitedEmails: user.email, workos, sessionHours, now: () => now };
  const auth = new WorkOSAuthService(store, options);
  const request = (cookie = 'old') => {
    const req = { headers: { cookie: `sinaloa_session=${cookie}` } };
    const res = response();
    auth.bindResponse(req, res);
    return { req, res };
  };
  return { store, auth, options, calls, request, tokens, setNow: value => { now = value; }, now: () => now, setRefresh: value => { refresh = value; }, setRevoke: value => { revoke = value; } };
}

test('expired access token renews once per request and appends the cookie without removing CSRF cookies', async () => {
  const f = await fixture();
  const { req, res } = f.request();
  const session = await f.auth.getSession(req);
  const human = await f.auth.getHuman(req);
  assert.equal(session.sessionId, 'sid_one');
  assert.equal(human.providerUserId, 'user_one');
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.authenticate, 2, 'original and replacement are each verified once');
  res.setHeader('Set-Cookie', ['sinaloa_csrf=csrf; Path=/', 'sinaloa_session=old; Path=/']);
  res.writeHead(200);
  const cookies = res.getHeader('Set-Cookie');
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0], 'sinaloa_csrf=csrf; Path=/');
  assert.match(cookies[1], /^sinaloa_session=new;/);
  assert.match(cookies[1], /HttpOnly/);
  assert.equal(await f.auth.validateSessionLease(await f.auth.captureSessionLease(req)), true);
});

test('concurrent and late old-cookie requests share a sealed replacement across auth service instances', async () => {
  const f = await fixture();
  const second = new WorkOSAuthService(f.store, f.options);
  const gate = deferred();
  const started = deferred();
  f.setRefresh(async () => { started.resolve(); await gate.promise; return { authenticated: true, sealedSession: 'new' }; });
  const first = f.auth.getSession(f.request().req);
  await started.promise;
  const concurrent = second.getSession(f.request().req);
  gate.resolve();
  const sessions = await Promise.all([first, concurrent]);
  assert.equal(f.calls.refresh, 1);
  assert.deepEqual(sessions.map(value => value.sealedSession), ['new', 'new']);
  f.setNow(f.now() + 29_000);
  assert.equal((await second.getSession(f.request().req)).sealedSession, 'new');
  assert.equal(f.calls.refresh, 1);
  f.setNow(f.now() + 2_000);
  await second.getSession(f.request().req);
  assert.equal(f.calls.refresh, 2, 'old cookie replay stops after 30 seconds');
});

test('temporary provider refresh failures return 503, retain the cookie and permit retry', async () => {
  const f = await fixture();
  f.setRefresh(async () => ({ authenticated: false, reason: 'network_error', retryable: true }));
  const { req, res } = f.request();
  await assert.rejects(f.auth.getSession(req), { statusCode: 503, code: 'auth_unavailable' });
  res.writeHead(503);
  assert.equal(res.getHeader('Set-Cookie'), undefined);
  f.setRefresh(async () => ({ authenticated: true, sealedSession: 'new' }));
  assert.equal((await f.auth.getSession(f.request().req)).sessionId, 'sid_one');
});

test('terminal refresh failure clears the cookie and rejects other cookies for the same session', async () => {
  const f = await fixture();
  f.setRefresh(async () => ({ authenticated: false, reason: 'invalid_grant', retryable: false }));
  const { req, res } = f.request();
  assert.equal(await f.auth.getSession(req), null);
  res.writeHead(401, { 'set-cookie': 'sinaloa_csrf=stale; Path=/' });
  assert.deepEqual(res.getHeader('Set-Cookie').map(value => value.split(';')[0]), ['sinaloa_session=', 'sinaloa_csrf=']);
  assert.ok(res.getHeader('Set-Cookie').every(value => value.includes('Max-Age=0')));
  assert.equal(await f.auth.getSession(f.request('new').req), null);
});

test('removing an invitation clears authenticated and CSRF cookies without admitting the session', async () => {
  const f = await fixture();
  f.auth.invitedEmails.clear();
  const { req, res } = f.request('new');
  assert.equal(await f.auth.getSession(req), null);
  res.writeHead(401);
  assert.deepEqual(res.getHeader('Set-Cookie').map(value => value.split(';')[0]), ['sinaloa_session=', 'sinaloa_csrf=']);
  assert.ok(res.getHeader('Set-Cookie').every(value => value.includes('Max-Age=0')));
  assert.equal(f.calls.refresh, 0);
});

test('logout revokes old and rotated cookies durably even if the provider is unavailable', async () => {
  const f = await fixture();
  const lease = await f.auth.captureSessionLease(f.request().req);
  f.setRevoke(async () => { throw new Error('network unavailable'); });
  const { req, res } = f.request();
  const result = await f.auth.logout(req);
  assert.equal(result.revoked, true);
  assert.equal(result.sessionId, 'sid_one');
  assert.equal(result.providerRevoked, false);
  assert.match(result.logoutUrl, /sid_one/);
  res.writeHead(200);
  assert.match(res.getHeader('Set-Cookie')[0], /Max-Age=0/);
  const restarted = new WorkOSAuthService(f.store, f.options);
  assert.equal(await restarted.getSession(f.request().req), null);
  assert.equal(await restarted.getSession(f.request('new').req), null);
  assert.equal(await restarted.validateSessionLease(lease), false);
});

test('logout racing token rotation cannot restore authorization with the replacement', async () => {
  const f = await fixture();
  const gate = deferred();
  const started = deferred();
  f.setRefresh(async () => { started.resolve(); await gate.promise; return { authenticated: true, sealedSession: 'new' }; });
  const renewal = f.auth.getSession(f.request().req);
  await started.promise;
  const logout = f.auth.logout(f.request().req);
  gate.resolve();
  await Promise.all([renewal, logout]);
  assert.equal(await f.auth.getSession(f.request('new').req), null);
  assert.equal(await f.auth.validateSessionLease({ sessionId: 'sid_one' }), false);
});

test('logout disconnects streams immediately after durable revocation while provider revoke is pending', async () => {
  const f = await fixture();
  const lease = await f.auth.captureSessionLease(f.request().req);
  const providerStarted = deferred();
  const providerGate = deferred();
  const disconnected = [];
  f.setRevoke(async () => { providerStarted.resolve(); await providerGate.promise; });
  const pendingLogout = f.auth.logout(f.request().req, { onRevoked: sessionId => { disconnected.push(sessionId); } });
  await providerStarted.promise;
  assert.deepEqual(disconnected, ['sid_one']);
  assert.equal(await f.auth.validateSessionLease(lease), false);
  assert.equal(await f.auth.getSession(f.request().req), null);
  assert.equal(await f.auth.getSession(f.request('new').req), null);
  providerGate.resolve();
  assert.equal((await pendingLogout).providerRevoked, true);
});

test('renewal never extends the fixed application maximum session lifetime', async () => {
  const f = await fixture({ sessionHours: 1 });
  const initial = f.now();
  assert.ok(await f.auth.getSession(f.request().req));
  f.setNow(initial + 50 * 60_000);
  f.tokens.set('new', { sid: 'sid_one', iat: f.now() / 1000, exp: f.now() / 1000 + 300 });
  assert.equal(await f.auth.getSession(f.request('new').req), null, 'maximum uses original token issuance, not refreshed issuance');
  assert.equal(f.calls.refresh, 1);
});

test('stream lease expires unless an ordinary HTTP request renews its authorization', async () => {
  const f = await fixture();
  const lease = await f.auth.captureSessionLease(f.request().req);
  f.setNow(f.now() + 301_000);
  assert.equal(await f.auth.validateSessionLease(lease), false);
  assert.equal(f.calls.refresh, 1, 'stream validation does not rotate a cookie');
  f.tokens.set('newer', { sid: 'sid_one', iat: f.now() / 1000, exp: f.now() / 1000 + 300 });
  f.setRefresh(async () => ({ authenticated: true, sealedSession: 'newer' }));
  assert.ok(await f.auth.getSession(f.request('new').req));
  assert.equal(await f.auth.validateSessionLease(lease), true);
});

test('the installed SDK unseals expired cookies for logout identity and rejects altered seals', async () => {
  const f = await fixture();
  const workos = new WorkOS('sk_test', { clientId: 'client_one' });
  const sealedSession = await workos.userManagement.sealSessionDataFromAuthenticationResponse({
    authenticationResponse: { accessToken: jwt({ sid: 'sid_one', iat: f.now() / 1000 - 600, exp: f.now() / 1000 - 1 }), refreshToken: 'secret', user: { id: 'user_one', email: 'member@example.com', emailVerified: true } },
    cookiePassword: f.options.cookiePassword
  });
  let revokedId;
  workos.userManagement.revokeSession = async ({ sessionId }) => { revokedId = sessionId; };
  const auth = new WorkOSAuthService(f.store, { ...f.options, workos });
  const result = await auth.logout({ headers: { cookie: `sinaloa_session=${encodeURIComponent(sealedSession)}` } });
  assert.equal(result.sessionId, 'sid_one');
  assert.equal(revokedId, 'sid_one');
  const altered = await auth.logout({ headers: { cookie: `sinaloa_session=${encodeURIComponent(sealedSession.replace('Fe26.2', 'Fe26.3'))}` } });
  assert.equal(altered.revoked, false);
});

test('real SDK verification and refresh issue a replacement cookie for an expired signed access token', async () => {
  const f = await fixture();
  f.setNow(Date.now());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sign = exp => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sid: 'sid_one', iat: Math.floor(f.now() / 1000) - 600, exp })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
  };
  const workos = new WorkOS('sk_test', { clientId: 'client_one' });
  workos.userManagement.getJWKS = async () => async () => publicKey;
  const user = { id: 'user_one', email: 'member@example.com', emailVerified: true };
  const old = { accessToken: sign(Math.floor(f.now() / 1000) - 1), refreshToken: 'refresh_old', user };
  const sealedSession = await workos.userManagement.sealSessionDataFromAuthenticationResponse({ authenticationResponse: old, cookiePassword: f.options.cookiePassword });
  let refreshCalls = 0;
  workos.userManagement.authenticateWithRefreshToken = async options => {
    assert.equal(options.refreshToken, 'refresh_old');
    assert.equal(options.session.sealSession, true);
    refreshCalls += 1;
    const next = { accessToken: sign(Math.floor(f.now() / 1000) + 300), refreshToken: 'refresh_new', user };
    return { ...next, sealedSession: await workos.userManagement.sealSessionDataFromAuthenticationResponse({ authenticationResponse: next, cookiePassword: options.session.cookiePassword }) };
  };
  const auth = new WorkOSAuthService(f.store, { ...f.options, workos });
  const req = { headers: { cookie: `sinaloa_session=${encodeURIComponent(sealedSession)}` } };
  const res = response();
  auth.bindResponse(req, res);
  const session = await auth.getSession(req);
  assert.equal(session.sessionId, 'sid_one');
  assert.equal(refreshCalls, 1);
  assert.notEqual(session.sealedSession, sealedSession);
  res.writeHead(200, { 'set-cookie': 'sinaloa_csrf=token; Path=/' });
  assert.equal(res.getHeader('Set-Cookie')[0], 'sinaloa_csrf=token; Path=/');
  assert.equal(res.getHeader('Set-Cookie')[1].split(';')[0], `sinaloa_session=${encodeURIComponent(session.sealedSession)}`);
});
