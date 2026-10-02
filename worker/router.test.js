import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createForwardedRequest,
  isAllowedHostname,
  parseAllowedHostnames,
  selectEnvironment,
  serviceUnavailableResponse,
  withNoStoreHeaders
} from './router.js';

test('allowed hostnames are normalized and enforced', () => {
  assert.deepEqual([...parseAllowedHostnames(' WWW.ENVOI-AGENTS.COM., beta.example.com ')], [
    'www.envoi-agents.com',
    'beta.example.com'
  ]);
  assert.equal(isAllowedHostname(new URL('https://www.envoi-agents.com/api'), 'www.envoi-agents.com'), true);
  assert.equal(isAllowedHostname(new URL('https://attacker.example/api'), 'www.envoi-agents.com'), false);
  assert.equal(isAllowedHostname(new URL('https://preview.workers.dev/api'), ''), false);
  assert.equal(isAllowedHostname(new URL('https://preview.workers.dev/api'), undefined), false);
});

test('only allowlisted non-empty environment values reach the container', () => {
  assert.deepEqual(selectEnvironment(
    { SAFE: 'value', EMPTY: '', SECRET_NOT_LISTED: 'never' },
    ['SAFE', 'EMPTY'],
    { NODE_ENV: 'production' }
  ), { NODE_ENV: 'production', SAFE: 'value' });
});

test('forwarded headers are derived from the trusted request URL and Cloudflare IP', async () => {
  const original = new Request('https://www.envoi-agents.com:8443/api/messages?cursor=a%2Fb', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '203.0.113.42',
      'x-forwarded-for': '198.51.100.99',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ hello: 'world' })
  });

  const forwarded = createForwardedRequest(original);
  assert.equal(new URL(forwarded.url).pathname, '/api/messages');
  assert.equal(new URL(forwarded.url).search, '?cursor=a%2Fb');
  assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'www.envoi-agents.com:8443');
  assert.equal(forwarded.headers.get('x-forwarded-port'), '8443');
  assert.equal(forwarded.headers.get('x-forwarded-for'), '203.0.113.42');
  assert.equal(forwarded.headers.get('x-real-ip'), '203.0.113.42');
  assert.deepEqual(await forwarded.json(), { hello: 'world' });
});

test('forwarded headers discard spoofed client IP data outside Cloudflare', () => {
  const forwarded = createForwardedRequest(new Request('http://127.0.0.1:8787/health', {
    headers: { 'x-forwarded-for': '198.51.100.99', 'x-real-ip': '198.51.100.99' }
  }));
  assert.equal(forwarded.headers.has('x-forwarded-for'), false);
  assert.equal(forwarded.headers.has('x-real-ip'), false);
});

test('proxied responses remain streaming-compatible and cannot be cached', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\n\n'));
      controller.close();
    }
  });
  const response = withNoStoreHeaders(new Response(stream, {
    headers: { 'content-type': 'text/event-stream' }
  }));

  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(await response.text(), 'event: ready\n\n');
});

test('container failures return a sanitized retryable response', async () => {
  const response = serviceUnavailableResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), {
    error: 'SERVICE_UNAVAILABLE',
    message: 'Envoi is temporarily unavailable'
  });
});
