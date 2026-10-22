import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { planRemoteMcpAuthorization } from './authorization-plan.mjs';

const fixture = async name => JSON.parse(await readFile(
  new URL(`../../../test/contract-fixtures/agent-remote-auth/${name}.json`, import.meta.url), 'utf8'));

async function inputs() {
  const [resource, server, authorize] = await Promise.all([
    fixture('protected-resource-metadata'),
    fixture('authorization-server-metadata'),
    fixture('authorize-redirects-to-consent'),
  ]);
  return {
    origin: 'https://www.envoi-agents.com',
    protectedResource: resource.response.body,
    authorizationServer: server.response.body,
    clientMetadata: authorize.context.clientMetadataDocument,
    redirectUri: authorize.context.clientMetadataDocument.redirect_uris[0],
    codeVerifier: authorize.context.codeVerifier,
    state: new URL(authorize.request.path, 'https://www.envoi-agents.com').searchParams.get('state'),
    expected: authorize,
  };
}

test('approved remote-auth discovery and PKCE fixture produce the exact authorization request', async () => {
  const { expected, ...input } = await inputs();
  const plan = planRemoteMcpAuthorization(input);
  const expectedUrl = new URL(expected.request.path, input.origin);
  assert.equal(plan.authorizationUrl, expectedUrl.href);
  assert.deepEqual(Object.keys(plan), ['authorizationUrl', 'issuer', 'resource']);
  assert.equal(plan.resource, `${input.origin}/mcp`);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(input.codeVerifier));
  assert.doesNotMatch(JSON.stringify(plan), /refresh_token|access_token|wake|reachable/i);
});

test('trusted issuer, resource, client and redirect must agree before a browser URL is built', async () => {
  const { expected: _expected, ...input } = await inputs();
  const changes = [
    { origin: 'https://other.example' },
    { origin: 'https://www.envoi-agents.com/path' },
    { protectedResource: { ...input.protectedResource, resource: 'https://other.example/mcp' } },
    { authorizationServer: { ...input.authorizationServer, issuer: 'https://other.example' } },
    { authorizationServer: { ...input.authorizationServer, code_challenge_methods_supported: ['plain'] } },
    { authorizationServer: { ...input.authorizationServer, client_id_metadata_document_supported: false } },
    { clientMetadata: { ...input.clientMetadata, client_id: 'http://other.example/client.json' } },
    { clientMetadata: { ...input.clientMetadata, token_endpoint_auth_method: 'client_secret_basic' } },
    { redirectUri: 'https://other.example/callback' },
    { redirectUri: 'http://localhost/callback' },
  ];
  for (const change of changes) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, ...change }),
      /Invalid remote MCP authorization setup/, JSON.stringify(change));
  }
});

test('the caller must hold a valid private verifier and state; scopes stay within the approved set', async () => {
  const { expected: _expected, ...input } = await inputs();
  for (const codeVerifier of ['short', 'A'.repeat(129), 'A'.repeat(42) + '!']) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, codeVerifier }), /Invalid remote MCP/);
  }
  for (const state of ['', 'A'.repeat(513), 'line\nbreak']) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, state }), /Invalid remote MCP/);
  }
  for (const scopes of [[], ['envoi.send'], ['envoi.agent', 'envoi.agent'], ['envoi.agent', 'use_email_transport']]) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, scopes }), /Invalid remote MCP/);
  }
  const narrowed = planRemoteMcpAuthorization({ ...input, scopes: ['envoi.agent'] });
  assert.equal(new URL(narrowed.authorizationUrl).searchParams.get('scope'), 'envoi.agent');
});
