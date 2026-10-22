import crypto from 'node:crypto';
import path from 'node:path';
import { bootstrapGrantType, oauthErrorDescriptions } from './agent-remote-auth.js';

// agent-remote-auth v1 (approved revision 4, Policy B) §6-§8, task RA-A2: the pure parts of the token and revocation
// endpoints. Form parsing, client authentication, PKCE, the refresh recovery envelope and the response shapes live
// here; the stateful flows (activation, rotation, replay revocation) live in server.js beside the credential code
// they share with agent-registration. Nothing here reads or writes storage.

export const tokenRequestMaxBytes = 8192;
export const tokenFormMaxParameters = 24;
export const refreshRecoverySeconds = 60;
// x-limits.tokenRequestsPerSourcePerMinute.
export const tokenRequestsPerSourcePerMinute = 60;
export const oauthTokenTypes = Object.freeze(['oauth_access', 'oauth_refresh']);
export const oauthRefreshRecoveryDir = path.join('auth', 'agent-oauth-refresh-recovery');
export const oauthRefreshRecoveryPath = tokenHash => path.join(oauthRefreshRecoveryDir, `${tokenHash}.json`);
// The lock a refresh rotation, the first use of an oauth_access token and a recovery all take (agent-registration §14.2, §14.5).
export const oauthFamilyLockKey = familyId => `oauth-family:${familyId}`;

export const sha256Hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
export const wellFormedVerifier = value => typeof value === 'string' && verifierPattern.test(value);
const codePattern = /^envoi_oauth_code_[A-Za-z0-9_-]{1,86}$/;
const bootstrapPattern = /^envoi_boot_[A-Za-z0-9_-]{1,86}$/;

// x-oauth-errors: status 400, except invalid_client (401) and temporarily_unavailable (429). The body names the error
// and carries fixed text; it never says which check failed and never holds a token.
export function oauthError(error, { basic = false, retryAfterSeconds = null } = {}) {
  const status = error === 'invalid_client' ? 401 : error === 'temporarily_unavailable' ? 429 : 400;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache' };
  if (error === 'invalid_client' && basic) headers['www-authenticate'] = 'Basic realm="Envoi"';
  if (retryAfterSeconds) headers['retry-after'] = String(retryAfterSeconds);
  return { status, headers, body: { error, error_description: oauthErrorDescriptions[error] } };
}
export const oauthSuccess = body => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache' },
  body
});

// §6: `application/x-www-form-urlencoded`. Returns { params } or { invalid: true } for a repeated or oversized parameter.
export function parseTokenForm(raw) {
  if (typeof raw !== 'string') return { invalid: true };
  let search;
  try { search = new URLSearchParams(raw); } catch { return { invalid: true }; }
  const params = new Map();
  for (const [key, value] of search) {
    if (params.has(key) || params.size >= tokenFormMaxParameters || key.length > 64 || value.length > 4096) return { invalid: true };
    params.set(key, value);
  }
  return { params };
}

// RFC 6749 §2.3.1: the user name and password of HTTP Basic are form-urlencoded before they are joined.
function decodeFormComponent(value) {
  try { return decodeURIComponent(value.replace(/\+/g, '%20')); } catch { return null; }
}
export function parseBasic(header) {
  if (typeof header !== 'string' || !/^Basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 1) return { malformed: true };
  const id = decodeFormComponent(decoded.slice(0, split));
  const secret = decodeFormComponent(decoded.slice(split + 1));
  return id && secret !== null ? { id, secret } : { malformed: true };
}

const timingEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// §6 "Client authentication". A public client sends client_id in the body and no secret; a client_secret_basic client
// sends HTTP Basic and no client_id in the body, or the same one. Any mismatch, a missing or wrong secret, or a secret
// sent by a public client is invalid_client. `basic` says whether the client presented HTTP Basic, which decides whether
// the 401 carries the Basic challenge.
export async function authenticateClient({ authorization, bodyClientId, resolveClient }) {
  const basic = parseBasic(authorization);
  const presentedBasic = Boolean(basic);
  if (basic?.malformed) return { error: oauthError('invalid_client', { basic: true }) };
  const clientId = basic ? basic.id : bodyClientId;
  const fail = () => ({ error: oauthError('invalid_client', { basic: presentedBasic }) });
  if (typeof clientId !== 'string' || !clientId) return fail();
  if (basic && bodyClientId !== undefined && bodyClientId !== null && bodyClientId !== basic.id) return fail();
  const client = await resolveClient(clientId);
  if (!client) return fail();
  if (client.tokenEndpointAuthMethod === 'none') {
    // A public client names itself in the body and sends no secret.
    if (basic || typeof bodyClientId !== 'string') return fail();
    return { client };
  }
  if (!basic || !timingEqual(sha256Hex(basic.secret), client.clientSecretSha256)) return fail();
  return { client };
}

// §6.1: RFC 7636 S256.
export function pkceMatches(verifier, challenge) {
  if (!wellFormedVerifier(verifier) || typeof challenge !== 'string') return false;
  return timingEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
}

// §6.1 row 2, per grant: every named parameter present once and well formed. Unknown parameters are ignored. Returns the
// values, or null. `invalid_request` is the only error row 2 gives.
export function codeGrantParameters(params) {
  const code = params.get('code');
  const redirectUri = params.get('redirect_uri');
  const verifier = params.get('code_verifier');
  const resource = params.get('resource');
  if (typeof code !== 'string' || !codePattern.test(code) || !redirectUri || redirectUri.length > 2048 || !wellFormedVerifier(verifier) || !resource || resource.length > 2048) return null;
  return { code, redirectUri, verifier, resource };
}
export function bootstrapGrantParameters(params) {
  const code = params.get('bootstrap_code');
  const resource = params.get('resource');
  if (typeof code !== 'string' || !bootstrapPattern.test(code) || !resource || resource.length > 2048) return null;
  return { code, resource };
}
export function refreshGrantParameters(params) {
  const token = params.get('refresh_token');
  if (typeof token !== 'string' || !token || token.length > 512) return null;
  for (const name of ['scope', 'resource']) if (params.has(name) && (!params.get(name) || params.get(name).length > 2048)) return null;
  return { token, scope: params.has('scope') ? params.get('scope') : null, resource: params.has('resource') ? params.get('resource') : null };
}
export const grantTypes = Object.freeze({ authorization_code: 'authorization_code', refresh_token: 'refresh_token', bootstrap: bootstrapGrantType });

// §6.2 row 7: the requested scope, as a set, must equal the family's current scopes.
export const sameScopes = (requested, current) => {
  const a = [...new Set(String(requested).split(' ').filter(Boolean))].sort();
  const b = [...new Set(String(current).split(' ').filter(Boolean))].sort();
  return a.length === b.length && a.every((scope, index) => scope === b[index]);
};

export const tokenResponse = ({ accessToken, refreshToken, expiresIn, scope }) => ({
  access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refreshToken, scope
});

// agent-registration §14.5: the recovery envelope of one rotation. The key is derived from the OLD raw refresh token, so a
// database read plus the server key cannot decrypt it; familyId and oauthClientId are bound, so it cannot be replayed into
// another family or for another client.
const recoveryInfo = 'envoi-oauth-refresh-recovery-v1';
const recoveryKey = (rawRefreshToken, serverKey) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(rawRefreshToken), crypto.createHash('sha256').update(serverKey).digest(), Buffer.from(recoveryInfo), 32));
const recoveryContext = (familyId, oauthClientId) => Buffer.from(`${familyId}\n${oauthClientId}`);
export function sealRefreshRecovery(rawRefreshToken, serverKey, { familyId, oauthClientId }, response) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', recoveryKey(rawRefreshToken, serverKey), iv);
  cipher.setAAD(recoveryContext(familyId, oauthClientId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
export function openRefreshRecovery(rawRefreshToken, serverKey, { familyId, oauthClientId }, envelope) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', recoveryKey(rawRefreshToken, serverKey), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(recoveryContext(familyId, oauthClientId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

// §9: the challenge on every 401 from /mcp while a route flag is on. error="invalid_token" only when the request carried a
// bearer token that failed.
export function mcpChallenge(origin, { invalidToken = false, scope = 'envoi.agent envoi.send' } = {}) {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"${invalidToken ? ', error="invalid_token"' : ''}`;
}
// §9 "Insufficient scope": a 403 names every scope the call needs, in x-scopes order.
export const insufficientScopeChallenge = (origin, scope) => `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
