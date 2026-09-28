import crypto from 'node:crypto';

export function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return Object.freeze({ verifier, challenge, method: 'S256' });
}

export async function exchangeCalendarAuthorizationCode({ provider, code, redirectUri, codeVerifier, timeoutMs = 15_000, fetcher = fetch }) {
  if (!provider?.tokenUrl || !provider.clientId || !provider.clientSecret) throw new TypeError('Calendar OAuth provider is incomplete');
  if (!code || !redirectUri || !codeVerifier) throw new TypeError('Calendar OAuth exchange inputs are incomplete');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Calendar OAuth timeout must be an integer from 1 to 120000');
  let response;
  try {
    response = await fetcher(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw Object.assign(new Error('Calendar token exchange is unavailable'), { statusCode: 502, code: 'CALENDAR_OAUTH_UNAVAILABLE' });
  }
  const tokenSet = await response.json().catch(() => ({}));
  if (!response.ok || !tokenSet.access_token) {
    throw Object.assign(new Error('Calendar token exchange failed'), { statusCode: 502, code: 'CALENDAR_OAUTH_EXCHANGE_FAILED' });
  }
  return tokenSet;
}
