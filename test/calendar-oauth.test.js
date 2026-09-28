import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPkcePair, exchangeCalendarAuthorizationCode } from '../src/calendar-oauth.js';

const provider = { clientId: 'client', clientSecret: 'must-not-leak', tokenUrl: 'https://calendar.example/token' };

test('calendar OAuth creates RFC 7636 S256 proof and binds the verifier during exchange', async () => {
  const pkce = createPkcePair();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier).digest('base64url'));
  assert.equal(pkce.method, 'S256');
  const tokenSet = await exchangeCalendarAuthorizationCode({
    provider,
    code: 'authorization-code',
    redirectUri: 'https://app.example/callback',
    codeVerifier: pkce.verifier,
    fetcher: async (_url, options) => {
      assert.equal(options.body.get('code_verifier'), pkce.verifier);
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ access_token: 'token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(tokenSet.access_token, 'token');
});

test('calendar OAuth bounds provider latency and sanitizes provider failures', async () => {
  await assert.rejects(() => exchangeCalendarAuthorizationCode({
    provider, code: 'code', redirectUri: 'https://app.example/callback', codeVerifier: createPkcePair().verifier, timeoutMs: 5,
    fetcher: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }), error => error.code === 'CALENDAR_OAUTH_UNAVAILABLE' && !error.message.includes(provider.clientSecret) && !error.message.includes(provider.tokenUrl));
  await assert.rejects(() => exchangeCalendarAuthorizationCode({
    provider, code: 'code', redirectUri: 'https://app.example/callback', codeVerifier: createPkcePair().verifier,
    fetcher: async () => new Response(JSON.stringify({ error: 'secret-provider-detail' }), { status: 400 })
  }), error => error.code === 'CALENDAR_OAUTH_EXCHANGE_FAILED' && !error.message.includes('secret-provider-detail'));
});
