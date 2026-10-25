// Approved agent-remote-auth-cimd v1: real validators and local HTTP with fixture metadata.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { clientMetadataRejection, createAuthorizationRequestSealer, createAuthorizeRequestHandler,
  createClientResolver, parsePreRegisteredClients } from '../src/agent-remote-auth.js';

const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const registry = await read('./contract-fixtures/index.json');
const entry = registry.contracts.find(contract => contract.id === 'agent-remote-auth-cimd');
const cases = await Promise.all(entry.fixtures.map(name => read(`./contract-fixtures/${entry.dir}/${name}`)));
const original = await read('./contract-fixtures/agent-remote-auth/authorize-redirects-to-consent.json');
const origin = 'https://www.envoi-agents.com';
const flags = { registration: true, installations: true, remoteMcpOAuth: true };
const parameters = document => {
  const params = new URL(original.request.path, origin).searchParams;
  params.set('client_id', document.client_id);
  params.set('redirect_uri', document.redirect_uris[0]);
  return params;
};

for (const row of cases) {
  test(`approved CIMD server validator: ${row.id}`, () => {
    assert.equal(clientMetadataRejection(row.document, row.document.client_id), row.expected.valid ? null : row.expected.rejection);
  });
}

test('accepted modern metadata preserves all non-auth document checks', () => {
  const document = cases.find(row => row.id === 'modern-chatgpt-preference').document;
  const sparseMethods = ['none']; sparseMethods.length = 2;
  for (const [changes, expected] of [
    [{ client_id: 'https://other.example/client.json' }, 'client_id_mismatch'],
    [{ client_name: 'bad\u202ename' }, 'client_name_invalid'],
    [{ redirect_uris: ['https://127.0.0.1/callback'] }, 'redirect_uris_invalid'],
    [{ grant_types: ['client_credentials'] }, 'grant_types_invalid'],
    [{ response_types: ['token'] }, 'response_types_invalid'],
    [{ token_endpoint_auth_methods_supported: sparseMethods }, 'auth_method_not_none']
  ]) assert.equal(clientMetadataRejection({ ...document, ...changes }, document.client_id), expected);
});

test('resolved CIMD clients stay public; invalid lists are not cached; confidential clients are unchanged', async () => {
  const row = cases.find(candidate => candidate.id === 'modern-chatgpt-preference');
  let document = row.document, fetches = 0, now = 0;
  const confidential = { clientId: 'client_fixture', clientName: 'Fixture', connectionRoute: 'provider_connector',
    redirectUris: ['https://provider.example/cb'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: 'a'.repeat(64), bootstrapCode: false, provider: 'Fixture' };
  const resolver = createClientResolver({ origin, flags: { ...flags, providerConnectors: true },
    preRegistered: parsePreRegisteredClients(JSON.stringify([confidential])), now: () => now,
    fetchClientMetadata: async () => { fetches++; return { document, cacheControl: 'max-age=300' }; } });
  const client = await resolver(document.client_id);
  assert.equal(client.tokenEndpointAuthMethod, 'none');
  assert.equal(client.connectionRoute, 'remote_mcp_oauth');
  assert.equal(client.bootstrapCode, false);
  assert.equal((await resolver('client_fixture')).tokenEndpointAuthMethod, 'client_secret_basic');
  document = { ...document, token_endpoint_auth_methods_supported: ['private_key_jwt'] };
  assert.equal((await resolver(document.client_id)).tokenEndpointAuthMethod, 'none', 'existing bounded cache policy');
  now = 300_000;
  assert.equal(await resolver(document.client_id), null);
  assert.equal(await resolver(document.client_id), null);
  assert.equal(fetches, 3, 'an invalid refetch is not cached');
});

test('local HTTP authorization handler accepts the approved vectors and retains redirect, PKCE and resource refusals', async t => {
  const byId = new Map(cases.map(row => [row.id, row]));
  const sealer = createAuthorizationRequestSealer({ keyMaterial: crypto.randomBytes(32) });
  // The real authorization handler/resolver run behind loopback HTTP. Metadata lookup is fixture-injected;
  // this is not a live provider HTTPS fetch or an end-to-end host/consent/token exchange.
  const server = createServer(async (request, response) => {
    try {
      const row = byId.get(request.headers['x-fixture-id']);
      const resolveClient = createClientResolver({ origin, flags,
        fetchClientMetadata: async () => ({ document: row.document, cacheControl: 'no-store' }) });
      const handler = createAuthorizeRequestHandler({ origin, flags, resolveClient, sealer });
      const outcome = await handler(new URL(request.url, origin).searchParams);
      response.writeHead(302, { location: outcome.location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const address = server.address();
  const request = async (row, edit = () => {}) => {
    const query = parameters(row.document); edit(query);
    return fetch(`http://127.0.0.1:${address.port}/oauth/authorize?${query}`, { redirect: 'manual', headers: { 'x-fixture-id': row.id } });
  };
  for (const row of cases) {
    const response = await request(row);
    assert.equal(response.status, 302, row.id);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const location = new URL(response.headers.get('location'));
    if (!row.expected.valid) {
      assert.equal(location.href, `${origin}/authorize-agent?error=invalid_client`, row.id);
      continue;
    }
    assert.equal(`${location.origin}${location.pathname}`, `${origin}/authorize-agent`);
    const sealed = sealer.open(location.searchParams.get('request'));
    assert.equal(sealed.clientId, row.document.client_id);
    assert.equal(sealed.redirectUri, row.document.redirect_uris[0]);
    assert.equal(sealed.resource, `${origin}/mcp`);
    assert.equal(sealed.codeChallenge, parameters(row.document).get('code_challenge'));
    assert.deepEqual(sealed.scopes, ['envoi.agent', 'envoi.send']);
  }
  const row = cases.find(candidate => candidate.id === 'modern-chatgpt-preference');
  for (const [edit, expected, target] of [
    [params => params.set('redirect_uri', 'https://attacker.invalid/cb'), 'invalid_redirect_uri', origin],
    [params => params.delete('code_challenge'), 'invalid_request', 'https://chatgpt.com'],
    [params => params.set('code_challenge_method', 'plain'), 'invalid_request', 'https://chatgpt.com'],
    [params => params.set('resource', 'https://other.example/mcp'), 'invalid_target', 'https://chatgpt.com'],
    [params => params.set('scope', 'envoi.email'), 'invalid_scope', 'https://chatgpt.com']
  ]) {
    const response = await request(row, edit);
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin, target);
    assert.equal(location.searchParams.get('error'), expected);
  }
});
