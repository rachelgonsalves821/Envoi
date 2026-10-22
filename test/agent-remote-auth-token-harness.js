// Shared harness for the agent-remote-auth RA-A2 and RA-A3 route tests (token, refresh, revocation, bootstrap, /mcp).
// Not a test file: `npm test` runs only test/*.test.js. Each test launches the real server as a child process on a
// temporary FileStore, or on PostgreSQL when DATABASE_URL is set (CI test:postgres), with the route flags set only in that
// child process. Nothing here calls a real host or model.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, deleteData, launch, owner, readData, writeData } from './a3-harness.js';
import { freshIp, withdrawRequest } from './agent-registration-harness.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { FileStore } from '../src/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loadSchemas = async name => JSON.parse(await readFile(path.join(here, 'contract-fixtures', name, 'schemas.json'), 'utf8'));
export const remoteSchemas = await loadSchemas('agent-remote-auth');
export const registrationSchemas = await loadSchemas('agent-registration');
export const remoteFixture = async id => JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-remote-auth', `${id}.json`), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(remoteSchemas);
ajv.addSchema(registrationSchemas);
export function assertSchema(contract, name, value) {
  const validate = ajv.getSchema(`${contract.$id}#/definitions/${name}`);
  assert.ok(validate, `${name} exists`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}
export const assertRemote = (name, value) => assertSchema(remoteSchemas, name, value);
// The stored-record schemas pin the canonical https origin; a test server is a loopback origin, so a record is checked with
// its origin replaced by the production one.
const canonical = value => JSON.parse(JSON.stringify(value).replace(/http:\/\/127\.0\.0\.1:\d+\/mcp/g, 'https://www.envoi-agents.com/mcp'));
export const assertStored = (name, value) => assertSchema(registrationSchemas, name, canonical(value));

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const PAST = '2000-01-01T00:00:00.000Z';
export const backends = [{ name: 'FileStore', env: {} }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL } }] : [])];
export { api, freshIp, launch, owner, withdrawRequest };

export async function freePort() {
  return new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => resolve(free)); }); });
}

// A confidential client's secret is configured only as its SHA-256 (agent-remote-auth §3.2).
export const providerSecret = 'provider-client-secret-for-tests';
export const clientSecret = 'confidential-client-secret-for-tests';
export const publicClient = { clientId: 'client_desktop-example', clientName: 'Desktop Example', connectionRoute: 'remote_mcp_oauth', redirectUris: ['http://127.0.0.1/callback'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Example' };
export const confidentialClient = { clientId: 'client_confidential-example', clientName: 'Confidential Example', connectionRoute: 'remote_mcp_oauth', redirectUris: ['https://host.example/callback'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: sha256(clientSecret), bootstrapCode: false, provider: 'Example' };
export const providerClient = { clientId: 'client_example-provider', clientName: 'Example Provider connector', connectionRoute: 'provider_connector', redirectUris: ['https://provider.example/callback'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: sha256(providerSecret), bootstrapCode: true, provider: 'Example Provider' };
export const plainProviderClient = { clientId: 'client_plain-provider', clientName: 'Plain Provider', connectionRoute: 'provider_connector', redirectUris: ['https://plain.example/callback'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: sha256(providerSecret), bootstrapCode: false, provider: 'Plain' };

// The flags live only in the child server process. ENVOI_PUBLIC_URL is this server's own loopback origin, so the browser
// session's CSRF origin matches it, and iss and resource are built from it.
export async function remoteServer(t, backend, { providers = false, clients = [publicClient, confidentialClient], env = {}, dataDir = null, port = null } = {}) {
  const chosen = port ?? await freePort();
  const origin = `http://127.0.0.1:${chosen}`;
  const serverEnv = {
    ...backend.env, ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_REMOTE_MCP_OAUTH: 'true',
    ...(providers ? { ENVOI_PROVIDER_CONNECTORS: 'true' } : {}), ENVOI_TRUSTED_PROXY: 'cloudflare',
    ENVOI_PORT: String(chosen), ENVOI_PUBLIC_URL: origin, ENVOI_OAUTH_CLIENTS: JSON.stringify(clients), ...env
  };
  const server = await launch(serverEnv, dataDir);
  t.after(() => server.stop());
  return Object.assign(server, { origin, resource: `${origin}/mcp`, serverEnv, port: chosen, backend });
}
// Restart on the same port and the same data.
export async function restart(t, server) {
  await server.stop(true);
  const next = await launch(server.serverEnv, server.backend.name === 'FileStore' ? server.dataDir : null);
  t.after(() => next.stop());
  return Object.assign(next, { origin: server.origin, resource: server.resource, serverEnv: server.serverEnv, port: server.port, backend: server.backend });
}

// Stored documents, read and edited the same way on both stores. `list` returns every document in a directory.
export function documents(t, server) {
  if (server.backend.name === 'FileStore') {
    return {
      get: parts => readData(server, ...parts), put: (parts, value) => writeData(server, parts, value), remove: parts => deleteData(server, ...parts),
      async list(parts) {
        let entries;
        try { entries = await readdir(path.join(server.dataDir, ...parts), { recursive: true, withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const values = [];
        for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) values.push(JSON.parse(await readFile(path.join(entry.parentPath || entry.path, entry.name), 'utf8')));
        return values;
      }
    };
  }
  const store = new PostgresStore(server.backend.env.DATABASE_URL);
  t.after(() => store.close());
  return {
    get: parts => store.getJson(path.join(...parts)), put: (parts, value) => store.putJson(path.join(...parts), value), remove: parts => store.deleteJson(path.join(...parts)),
    list: parts => store.listJson(path.join(...parts))
  };
}
// A store over the server's own data, for code that runs in the test process (a reaper or a cleanup job).
export async function openStore(t, server) {
  if (server.backend.name === 'FileStore') return new FileStore(server.dataDir);
  const store = new PostgresStore(server.backend.env.DATABASE_URL);
  t.after(() => store.close());
  return store;
}
export async function edit(docs, parts, change) {
  const current = await docs.get(parts);
  assert.ok(current, `expected ${parts.join('/')} to exist`);
  const draft = structuredClone(current);
  const next = change(draft) || draft;
  await docs.put(parts, next);
  return next;
}

export async function listFilesRecursive(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath || entry.path, entry.name));
}
export const registrationParts = id => ['auth', 'agent-registrations', `${id}.json`];
export const codeParts = code => ['auth', 'oauth-codes', `${sha256(code)}.json`];
export const accessParts = token => ['auth', 'agent-credentials', `${sha256(token)}.json`];
export const refreshParts = token => ['auth', 'agent-refresh-credentials', `${sha256(token)}.json`];
export const familyParts = (inboxId, agentId, familyId) => ['auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`];
export const recoveryParts = token => ['auth', 'agent-oauth-refresh-recovery', `${sha256(token)}.json`];
export const installationsRoute = (inboxId, agentId) => `/api/inboxes/${inboxId}/agents/${agentId}/installations`;

// PKCE (RFC 7636 S256).
export const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

export async function formPost(baseUrl, route, params, { basic = null, ip = freshIp(), headers = {}, raw = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip,
      ...(basic ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString('base64')}` } : {}), ...headers
    },
    body: raw ?? new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined)).toString()
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, headers: response.headers, payload, text };
}
export const tokenPost = (server, params, options) => formPost(server.baseUrl, '/oauth/token', params, options);
export const revokePost = (server, params, options) => formPost(server.baseUrl, '/oauth/revoke', params, options);

export function assertOAuthError(res, error, status = error === 'invalid_client' ? 401 : 400) {
  assert.equal(res.status, status, `${error}: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  assert.equal(res.payload?.error, error, res.text);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('pragma'), 'no-cache');
  assertRemote('oauthError', res.payload);
  assert.equal(res.payload.error_description, remoteSchemas['x-oauth-errors'][error].description, 'the error text is the fixed one');
  return res.payload;
}
export function assertTokenResponse(res, scope = 'envoi.agent envoi.send') {
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('pragma'), 'no-cache');
  assertRemote('tokenResponse', res.payload);
  assert.equal(res.payload.scope, scope);
  assert.equal(res.payload.token_type, 'Bearer');
  return res.payload;
}

// A fresh handle from the real authorize endpoint, approved by `who`, returning what the host would hold.
let counter = 0;
export async function connect(server, who, { client = publicClient, redirectUri = null, scope = 'envoi.agent envoi.send', target = null, grantedPermissions = ['send_agent_messages', 'receive_agent_messages'] } = {}) {
  counter += 1;
  const { verifier, challenge } = pkce();
  const redirect = redirectUri || (client.redirectUris[0].startsWith('http://') ? 'http://127.0.0.1:53682/callback' : client.redirectUris[0]);
  const query = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', resource: server.resource, scope, state: `state-${counter}` });
  const authorized = await fetch(`${server.baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const handle = new URL(authorized.headers.get('location')).searchParams.get('request');
  assert.ok(handle, 'the authorization request handle');
  const body = { target: target || { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: `OAuth agent ${counter}`, localPart: `oauth-agent-${crypto.randomBytes(3).toString('hex')}` }, grantedPermissions, policyProfile: 'default' };
  const approved = await api(server.baseUrl, `/api/oauth/authorization-requests/${encodeURIComponent(handle)}/approve`, { session: who.session, body });
  assert.equal(approved.status, 200, approved.text);
  const code = new URL(approved.payload.redirectTo).searchParams.get('code');
  assert.match(code, /^envoi_oauth_code_[A-Za-z0-9_-]{43}$/);
  return { code, verifier, redirectUri: redirect, registrationId: approved.payload.registrationId, client, who, handle, body, approved: approved.payload };
}
// The identical approval again (a lost response, a reload, a double click): the decision, never a code.
export const retryApprove = (server, grant) => api(server.baseUrl, `/api/oauth/authorization-requests/${encodeURIComponent(grant.handle)}/approve`, { session: grant.who.session, body: grant.body });
export const codeParams = (grant, overrides = {}) => ({
  grant_type: 'authorization_code', code: grant.code, redirect_uri: grant.redirectUri, code_verifier: grant.verifier, resource: grant.resource, client_id: grant.client.clientId, ...overrides
});
// The exchange of a grant by its own client, with the right authentication.
export const exchange = (server, grant, overrides = {}, options = {}) => {
  const params = codeParams({ ...grant, resource: server.resource }, overrides);
  const confidential = grant.client.tokenEndpointAuthMethod === 'client_secret_basic';
  if (confidential) delete params.client_id;
  return tokenPost(server, params, { basic: confidential ? { id: grant.client.clientId, secret: grant.client.clientId === providerClient.clientId || grant.client.clientId === plainProviderClient.clientId ? providerSecret : clientSecret } : null, ...options });
};
export const refreshParams = (client, refreshToken, extra = {}) => ({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, ...extra });

// What the server stored for a connection the host exchanged: registration, family and installation.
export async function stored(docs, registrationId) {
  const registration = await docs.get(registrationParts(registrationId));
  assert.ok(registration, 'the registration exists');
  const family = registration.credentialFamilyId ? await docs.get(familyParts(registration.agentInboxId, registration.agentId, registration.credentialFamilyId)) : null;
  return { registration, family };
}
export async function installationView(server, who, registration) {
  const res = await api(server.baseUrl, installationsRoute(registration.agentInboxId, registration.agentId), { session: who.session });
  assert.equal(res.status, 200, res.text);
  return res.payload.installations.find(item => item.id === registration.installationId);
}
