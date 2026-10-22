// agent-remote-auth v1 (approved revision 4) §6-§9: the pure helpers of the token endpoint, with no server and no storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  authenticateClient, bootstrapGrantParameters, codeGrantParameters, insufficientScopeChallenge, mcpChallenge, oauthError, openRefreshRecovery, parseBasic, parseTokenForm, pkceMatches,
  refreshGrantParameters, sameScopes, sealRefreshRecovery, sha256Hex, wellFormedVerifier
} from '../src/agent-remote-auth-token.js';
import { oauthErrorDescriptions } from '../src/agent-remote-auth.js';

test('PKCE S256 matches the RFC 7636 appendix B vector, and only a well-formed verifier can match', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.ok(pkceMatches(verifier, challenge));
  assert.ok(!pkceMatches(`${verifier}x`, challenge));
  assert.ok(!pkceMatches('A'.repeat(43), challenge));
  assert.ok(!pkceMatches(verifier, `${challenge.slice(0, -1)}A`));
  assert.ok(!pkceMatches(undefined, challenge) && !pkceMatches(verifier, undefined));
  for (const bad of ['short', 'A'.repeat(42), 'A'.repeat(129), `${'A'.repeat(43)}!`, `${'A'.repeat(43)} `, '']) assert.ok(!wellFormedVerifier(bad), bad);
  for (const good of ['A'.repeat(43), 'A'.repeat(128), `${'a1-._~'.repeat(8)}ab`]) assert.ok(wellFormedVerifier(good), good);
});

test('the form is read once per parameter: repeats, oversized values and too many parameters are refused', () => {
  assert.deepEqual([...parseTokenForm('a=1&b=2').params], [['a', '1'], ['b', '2']]);
  assert.deepEqual([...parseTokenForm('scope=envoi.agent%20envoi.send').params], [['scope', 'envoi.agent envoi.send']]);
  assert.ok(parseTokenForm('a=1&a=2').invalid);
  assert.ok(parseTokenForm(`a=${'x'.repeat(5000)}`).invalid);
  assert.ok(parseTokenForm(Array.from({ length: 30 }, (_, index) => `k${index}=1`).join('&')).invalid);
  assert.ok(parseTokenForm(undefined).invalid);
  assert.equal(parseTokenForm('').params.size, 0);
});

test('HTTP Basic carries the form-urlencoded client id and secret (RFC 6749 §2.3.1)', () => {
  const header = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  assert.deepEqual(parseBasic(header('client_a', 's3cret')), { id: 'client_a', secret: 's3cret' });
  assert.deepEqual(parseBasic(header('client_a', 'a%3Ab%2Bc+d')), { id: 'client_a', secret: 'a:b+c d' }, 'the secret is decoded once');
  assert.equal(parseBasic('Bearer abc'), null);
  assert.equal(parseBasic(undefined), null);
  assert.ok(parseBasic('Basic !!!').malformed);
  assert.ok(parseBasic(header('', 'x')).malformed);
  assert.ok(parseBasic(`Basic ${Buffer.from('nocolon').toString('base64')}`).malformed);
  assert.ok(parseBasic(header('client_a', '%E0%A4%A')).malformed, 'bad percent-encoding');
});

test('client authentication: public clients name themselves, confidential clients send Basic, every other shape is invalid_client', async () => {
  const secret = 'the-secret';
  const clients = new Map([
    ['client_public', { clientId: 'client_public', tokenEndpointAuthMethod: 'none' }],
    ['client_confidential', { clientId: 'client_confidential', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: sha256Hex(secret) }]
  ]);
  const resolveClient = async id => clients.get(id) || null;
  const basic = (id, value) => `Basic ${Buffer.from(`${id}:${value}`).toString('base64')}`;
  const auth = (input) => authenticateClient({ resolveClient, ...input });
  assert.equal((await auth({ bodyClientId: 'client_public' })).client.clientId, 'client_public');
  assert.equal((await auth({ authorization: basic('client_confidential', secret) })).client.clientId, 'client_confidential');
  assert.equal((await auth({ authorization: basic('client_confidential', secret), bodyClientId: 'client_confidential' })).client.clientId, 'client_confidential');
  const refusals = [
    { bodyClientId: 'client_unknown' }, {}, { bodyClientId: '' },
    { authorization: basic('client_public', 'x'), bodyClientId: 'client_public' }, { authorization: basic('client_public', 'x') },
    { bodyClientId: 'client_confidential' }, { authorization: basic('client_confidential', 'wrong') },
    { authorization: basic('client_confidential', secret), bodyClientId: 'client_public' },
    { authorization: 'Basic !!!' }, { authorization: basic('client_confidential', secret.toUpperCase()) }
  ];
  for (const input of refusals) {
    const result = await auth(input);
    assert.equal(result.client, undefined, JSON.stringify(input));
    assert.equal(result.error.status, 401);
    assert.equal(result.error.body.error, 'invalid_client');
    assert.equal(Boolean(result.error.headers['www-authenticate']), String(input.authorization || '').startsWith('Basic'), `the Basic challenge only when Basic was used: ${JSON.stringify(input)}`);
  }
});

test('OAuth errors carry fixed text and the right status; the Basic challenge and retry-after are added only where they apply', () => {
  for (const [error, status] of [['invalid_request', 400], ['invalid_client', 401], ['invalid_grant', 400], ['unauthorized_client', 400], ['unsupported_grant_type', 400], ['invalid_scope', 400], ['invalid_target', 400], ['temporarily_unavailable', 429]]) {
    const response = oauthError(error);
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error, error_description: oauthErrorDescriptions[error] });
    assert.deepEqual([response.headers['cache-control'], response.headers.pragma], ['no-store', 'no-cache']);
    assert.equal(response.headers['www-authenticate'], undefined);
  }
  assert.equal(oauthError('invalid_client', { basic: true }).headers['www-authenticate'], 'Basic realm="Envoi"');
  assert.equal(oauthError('invalid_grant', { basic: true }).headers['www-authenticate'], undefined);
  assert.equal(oauthError('temporarily_unavailable', { retryAfterSeconds: 30 }).headers['retry-after'], '30');
});

test('grant parameters: each named parameter once and well formed, nothing looked up', () => {
  const params = entries => new Map(Object.entries(entries));
  const verifier = 'A'.repeat(43);
  const code = `envoi_oauth_code_${'a'.repeat(43)}`;
  assert.deepEqual(codeGrantParameters(params({ code, redirect_uri: 'https://x.example/cb', code_verifier: verifier, resource: 'https://e.example/mcp' })), { code, redirectUri: 'https://x.example/cb', verifier, resource: 'https://e.example/mcp' });
  for (const missing of ['code', 'redirect_uri', 'code_verifier', 'resource']) {
    const all = { code, redirect_uri: 'https://x.example/cb', code_verifier: verifier, resource: 'https://e.example/mcp' };
    delete all[missing];
    assert.equal(codeGrantParameters(params(all)), null, missing);
  }
  assert.equal(codeGrantParameters(params({ code: 'nope', redirect_uri: 'https://x.example/cb', code_verifier: verifier, resource: 'r' })), null);
  assert.deepEqual(bootstrapGrantParameters(params({ bootstrap_code: `envoi_boot_${'b'.repeat(43)}`, resource: 'r' })), { code: `envoi_boot_${'b'.repeat(43)}`, resource: 'r' });
  assert.equal(bootstrapGrantParameters(params({ bootstrap_code: code, resource: 'r' })), null, 'an authorization code is not a bootstrap code');
  assert.deepEqual(refreshGrantParameters(params({ refresh_token: 'envoi_agent_refresh_x' })), { token: 'envoi_agent_refresh_x', scope: null, resource: null });
  assert.deepEqual(refreshGrantParameters(params({ refresh_token: 't', scope: 'envoi.agent', resource: 'r' })), { token: 't', scope: 'envoi.agent', resource: 'r' });
  assert.equal(refreshGrantParameters(params({})), null);
  assert.equal(refreshGrantParameters(params({ refresh_token: 't', scope: '' })), null);
});

test('scopes are compared as sets; the challenges are exactly the contract text', () => {
  assert.ok(sameScopes('envoi.send envoi.agent', 'envoi.agent envoi.send'));
  assert.ok(sameScopes('envoi.agent  envoi.agent envoi.send', 'envoi.agent envoi.send'));
  assert.ok(!sameScopes('envoi.agent', 'envoi.agent envoi.send'));
  assert.ok(!sameScopes('envoi.agent envoi.files', 'envoi.agent envoi.send'));
  const origin = 'https://www.envoi-agents.com';
  assert.equal(mcpChallenge(origin), 'Bearer resource_metadata="https://www.envoi-agents.com/.well-known/oauth-protected-resource/mcp", scope="envoi.agent envoi.send"');
  assert.equal(mcpChallenge(origin, { invalidToken: true }), 'Bearer resource_metadata="https://www.envoi-agents.com/.well-known/oauth-protected-resource/mcp", scope="envoi.agent envoi.send", error="invalid_token"');
  assert.equal(insufficientScopeChallenge(origin, 'envoi.send'), 'Bearer error="insufficient_scope", scope="envoi.send", resource_metadata="https://www.envoi-agents.com/.well-known/oauth-protected-resource/mcp"');
});

test('the refresh recovery envelope opens only for the old token, the family, the client and the server key', () => {
  const key = Buffer.from('server-key-for-tests');
  const old = `envoi_agent_refresh_${crypto.randomBytes(48).toString('base64url')}`;
  const ref = { familyId: 'credential_family_a', oauthClientId: 'client_x-example' };
  const response = { access_token: 'envoi_agent_access_a', token_type: 'Bearer', expires_in: 900, refresh_token: 'envoi_agent_refresh_b', scope: 'envoi.agent' };
  const envelope = sealRefreshRecovery(old, key, ref, response);
  assert.match(envelope.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.match(envelope.tag, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!JSON.stringify(envelope).includes('envoi_agent_'), 'the envelope is ciphertext');
  assert.deepEqual(openRefreshRecovery(old, key, ref, envelope), response);
  assert.equal(openRefreshRecovery(`${old}x`, key, ref, envelope), null, 'another token');
  assert.equal(openRefreshRecovery(old, key, { ...ref, familyId: 'credential_family_b' }, envelope), null, 'another family');
  assert.equal(openRefreshRecovery(old, key, { ...ref, oauthClientId: 'client_y-example' }, envelope), null, 'another client');
  assert.equal(openRefreshRecovery(old, Buffer.from('another-key'), ref, envelope), null, 'another server key');
  assert.equal(openRefreshRecovery(old, key, ref, { ...envelope, tag: sealRefreshRecovery(old, key, ref, response).tag }), null, 'a tag of another sealing');
  assert.equal(openRefreshRecovery(old, key, ref, { iv: 'x', ciphertext: 'y', tag: 'z' }), null);
  assert.notEqual(sealRefreshRecovery(old, key, ref, response).ciphertext, envelope.ciphertext, 'a fresh iv every time');
});
