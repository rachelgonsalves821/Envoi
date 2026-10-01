import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { installSessionCookieResponse } from '../src/session-response.js';
import { WorkOSAuthService } from '../src/workos-auth.js';

async function responseWith(t, handler, renewed = 'renewed-sealed-session', delegated = false) {
  let consumed = false;
  const server = http.createServer((req, res) => {
    const auth = delegated ? new WorkOSAuthService({}, {
      clientId: 'client_fixture', apiKey: 'key_fixture', cookiePassword: 'a'.repeat(32),
      redirectUri: 'https://app.example/callback', workos: {}
    }) : { takeSessionCookie() { if (consumed) return null; consumed = true; return renewed; } };
    installSessionCookieResponse(req, res, auth);
    if (delegated && renewed) auth.queueSessionCookie(req, renewed);
    handler(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  await response.body?.cancel();
  return response;
}

test('session refresh reaches browser while preserving a previously set CSRF cookie', async t => {
  const response = await responseWith(t, res => {
    res.setHeader('set-cookie', ['sinaloa_csrf=csrf; Path=/']);
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(value => value.startsWith('sinaloa_session=renewed-sealed-session;') && value.includes('HttpOnly')));
  assert.ok(cookies.some(value => value.startsWith('sinaloa_csrf=csrf;')));
});
for (const raw of [false, true]) test(`refresh preserves explicitly supplied ${raw ? 'raw' : 'object'} headers`, async t => {
  const response = await responseWith(t, res => {
    res.writeHead(200, 'OK', raw ? ['Set-Cookie', 'sinaloa_csrf=explicit; Path=/', 'Content-Type', 'text/plain'] : { 'Set-Cookie': ['sinaloa_csrf=explicit; Path=/'], 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get('content-type'), 'text/plain');
});
test('pending refresh never overrides an explicit session logout', async t => {
  const response = await responseWith(t, res => {
    res.writeHead(200, { 'set-cookie': ['sinaloa_session=; Path=/; Max-Age=0'] }); res.end('ok');
  });
  assert.deepEqual(response.headers.getSetCookie(), ['sinaloa_session=; Path=/; Max-Age=0']);
});
test('ordinary responses emit no authentication cookie without a successful refresh', async t => {
  const response = await responseWith(t, res => { res.writeHead(200); res.end('ok'); }, null);
  assert.deepEqual(response.headers.getSetCookie(), []);
});
for (const raw of [false, true]) test(`delegated WorkOS cookie writer preserves ${raw ? 'raw' : 'object'} headers`, async t => {
  const response = await responseWith(t, res => {
    res.writeHead(200, 'OK', raw ? ['Set-Cookie', 'sinaloa_csrf=explicit; Path=/', 'Content-Type', 'text/plain'] : { 'Set-Cookie': ['sinaloa_csrf=explicit; Path=/'], 'Content-Type': 'text/plain' });
    res.end('ok');
  }, 'renewed-sealed-session', true);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(value => value.startsWith('sinaloa_session=renewed-sealed-session;')));
  assert.ok(cookies.some(value => value.startsWith('sinaloa_csrf=explicit;')));
  assert.equal(response.headers.get('content-type'), 'text/plain');
});
for (const cookie of ['sinaloa_session=; Path=/; Max-Age=0', 'sinaloa_session=callback; Path=/; HttpOnly']) test(`delegated renewal preserves explicit session cookie: ${cookie}`, async t => {
  const response = await responseWith(t, res => {
    res.writeHead(200, { 'set-cookie': [cookie] }); res.end('ok');
  }, 'renewed-sealed-session', true);
  assert.deepEqual(response.headers.getSetCookie(), [cookie]);
});
