// agent-remote-auth v1 (approved revision 4) §5, task RA-A1 part 2: the owner consent routes on the real server, with
// the flags set only in this test's child process and a pre-registered loopback client, so nothing calls a real host.
// The storage rules behind these routes are covered by agent-remote-auth-consent-store.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, launch, owner } from './a3-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async name => JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-remote-auth', `${name}.json`), 'utf8'));
const schemas = await fixture('schemas');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const assertSchema = (name, value) => {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `${name} exists`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
};

// ENVOI_PUBLIC_URL is this server's own loopback origin (allowed for local tests), so the browser session's CSRF origin
// matches it and iss/resource are built from it.
const port = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => resolve(free)); }); });
const origin = `http://127.0.0.1:${port}`;
const preRegistered = [{ clientId: 'client_desktop-example', clientName: 'Desktop Example', connectionRoute: 'remote_mcp_oauth', redirectUris: ['http://127.0.0.1/callback'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Example' }];
const env = { ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_REMOTE_MCP_OAUTH: 'true', ENVOI_PORT: String(port), ENVOI_PUBLIC_URL: origin, ENVOI_OAUTH_CLIENTS: JSON.stringify(preRegistered) };
const challenge = 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM';

// A fresh handle from the real authorize endpoint.
async function authorize(baseUrl, state) {
  const query = new URLSearchParams({ response_type: 'code', client_id: 'client_desktop-example', redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp`, scope: 'envoi.agent envoi.send', state });
  const response = await fetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location')).searchParams.get('request');
}
const consentPath = (handle, action) => `/api/oauth/authorization-requests/${encodeURIComponent(handle)}${action ? `/${action}` : ''}`;
const post = (baseUrl, who, handle, action, body = {}) => api(baseUrl, consentPath(handle, action), { session: who.session, body });
const view = (baseUrl, who, handle) => api(baseUrl, consentPath(handle), { session: who.session });
const expectError = (res, status, code) => {
  assert.equal(res.status, status, `${code}: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  assert.equal(res.payload?.code, code);
  assertSchema('errorEnvelope', res.payload);
};
const listFiles = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath || entry.path, entry.name));

test('[server] consent: view, approve once, identical retries across a restart, deny, and one decision per handle', async t => {
  let server = await launch(env);
  t.after(() => server.stop());
  const { baseUrl } = server;
  const first = await owner(baseUrl, '7301');
  const second = await owner(baseUrl, '7302');
  const handle = await authorize(baseUrl, 'state-consent-1');

  // Signed out, and an unusable handle (identical for unknown, tampered and too long).
  expectError(await api(baseUrl, consentPath(handle)), 401, 'AUTHENTICATION_REQUIRED');
  const invalid = await fixture('consent-request-invalid');
  // Tamper in the middle: the last base64url character carries unused bits, so changing only the tail can leave the bytes (and the
  // seal) intact, which made this case fail one run in four.
  const tampered = `${handle.slice(0, 20)}${handle[20] === 'A' ? 'B' : 'A'}${handle.slice(21)}`;
  for (const bad of ['v1.unknown', tampered, `v1.${'a'.repeat(2100)}`]) {
    const res = await view(baseUrl, first, bad);
    expectError(res, 404, 'AUTHORIZATION_REQUEST_INVALID');
    assert.equal(res.payload.message, invalid.response.body.message);
  }

  // §5.1 the view: the pre-registered client, the loopback redirect host, requested and grantable permissions.
  const shown = await view(baseUrl, first, handle);
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.headers.get('cache-control'), 'no-store');
  assertSchema('consentView', shown.payload);
  assert.deepEqual(shown.payload.client, { name: 'Desktop Example', clientIdHost: null, redirectHost: '127.0.0.1:53682', loopbackRedirect: true, registration: 'pre_registered', provider: 'Example' });
  assert.deepEqual(shown.payload.requestedPermissions, ['receive_agent_messages', 'send_agent_messages']);
  assert.ok(!('decision' in shown.payload));

  // CSRF is checked before the handler while the flag is on (M2 moved only the flags-off answer ahead of it).
  const noCsrf = await api(baseUrl, consentPath(handle, 'approve'), { session: first.session, body: {}, headers: { origin: 'https://attacker.example' } });
  assert.equal(noCsrf.status, 403);
  for (const action of ['approve', 'deny']) {
    const missing = await fetch(`${baseUrl}${consentPath(handle, action)}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: first.session.headers(baseUrl, 'GET').cookie }, body: '{}' });
    assert.equal(missing.status, 403, `${action} without a CSRF header is refused when enabled`);
  }

  // §5.2 the first approval returns the code once, in the redirect.
  const body = { target: { kind: 'new_agent', workspaceInboxId: first.inbox.parentInboxId, name: 'Consent agent', localPart: 'consent-agent-7301' }, grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default' };
  const approved = await post(baseUrl, first, handle, 'approve', body);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.headers.get('cache-control'), 'no-store');
  assertSchema('consentApproved', approved.payload);
  const redirect = new URL(approved.payload.redirectTo);
  assert.equal(`${redirect.origin}${redirect.pathname}`, 'http://127.0.0.1:53682/callback');
  assert.deepEqual([...redirect.searchParams.keys()], ['code', 'state', 'iss'], 'code, then state, then iss');
  assert.match(redirect.searchParams.get('code'), /^envoi_oauth_code_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([redirect.searchParams.get('state'), redirect.searchParams.get('iss')], ['state-consent-1', origin]);
  const code = redirect.searchParams.get('code');
  assert.equal(Date.parse(approved.payload.codeExpiresAt) - Date.now() <= 60_000, true, 'the code lives at most 60 s');

  // An identical retry is answered from storage, never with a second code; a reload shows the decision.
  const retry = await post(baseUrl, first, handle, 'approve', body);
  assert.equal(retry.status, 200, retry.text);
  assertSchema('consentDecided', retry.payload);
  assert.deepEqual([retry.payload.status, retry.payload.registrationId, 'redirectTo' in retry.payload], ['pending_exchange', approved.payload.registrationId, false]);
  const reloaded = await view(baseUrl, first, handle);
  assertSchema('consentView', reloaded.payload);
  assert.equal(reloaded.payload.decision.status, 'pending_exchange');

  // One decision per handle: another body, a deny, another human.
  expectError(await post(baseUrl, first, handle, 'approve', { ...body, grantedPermissions: ['receive_agent_messages'] }), 409, 'CLAIM_ALREADY_DECIDED');
  expectError(await post(baseUrl, first, handle, 'deny'), 409, 'CLAIM_ALREADY_DECIDED');
  expectError(await view(baseUrl, second, handle), 404, 'AUTHORIZATION_REQUEST_INVALID');
  expectError(await post(baseUrl, second, handle, 'approve', body), 404, 'AUTHORIZATION_REQUEST_INVALID');

  // A restart: the outcome survives in storage.
  await server.stop(true);
  server = await launch(env, server.dataDir);
  const afterRestart = await post(server.baseUrl, first, handle, 'approve', body);
  assert.equal(afterRestart.status, 200, afterRestart.text);
  assert.deepEqual([afterRestart.payload.status, afterRestart.payload.registrationId], ['pending_exchange', approved.payload.registrationId]);
  assert.equal((await view(server.baseUrl, first, handle)).payload.decision.status, 'pending_exchange');

  // §5.3 deny on a fresh handle: access_denied to the checked redirect, repeatable, and nothing approvable after.
  const denyHandle = await authorize(server.baseUrl, 'state-consent-2');
  const denied = await post(server.baseUrl, first, denyHandle, 'deny');
  assert.equal(denied.status, 200, denied.text);
  assertSchema('consentDenied', denied.payload);
  assert.equal(denied.payload.redirectTo, `http://127.0.0.1:53682/callback?error=access_denied&error_description=The+owner+denied+the+request.&state=state-consent-2&iss=${encodeURIComponent(origin)}`);
  assert.deepEqual((await post(server.baseUrl, first, denyHandle, 'deny')).payload, denied.payload, 'the same outcome on repeat');
  expectError(await post(server.baseUrl, first, denyHandle, 'approve', body), 409, 'CLAIM_ALREADY_DECIDED');
  assert.deepEqual((await view(server.baseUrl, first, denyHandle)).payload.decision, { status: 'denied' });
  expectError(await post(server.baseUrl, second, denyHandle, 'deny'), 404, 'AUTHORIZATION_REQUEST_INVALID');

  // The token endpoints are RA-A2; the code is not exchangeable yet.
  assert.equal((await fetch(`${server.baseUrl}/oauth/token`, { method: 'POST', body: '' })).status, 404);

  // No code, handle or code-bearing redirect anywhere in storage or the logs.
  for (const file of await listFiles(server.dataDir)) {
    const content = await readFile(file, 'utf8');
    assert.ok(!content.includes(code) && !content.includes(handle) && !content.includes(denyHandle) && !content.includes('envoi_oauth_code_'), `${path.relative(server.dataDir, file)} holds no code or handle`);
  }
  const logs = server.stdout + server.stderr;
  assert.ok(!logs.includes(code) && !logs.includes(handle.slice(3, 43)) && !logs.includes(denyHandle.slice(3, 43)), 'no code or handle in the logs');
});

test('[server] flags off: the consent routes are FEATURE_DISABLED and store nothing', async t => {
  const server = await launch({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
  t.after(() => server.stop());
  const who = await owner(server.baseUrl, '7303');
  for (const action of [null, 'approve', 'deny']) {
    const res = action ? await post(server.baseUrl, who, 'v1.x', action) : await view(server.baseUrl, who, 'v1.x');
    expectError(res, 404, 'FEATURE_DISABLED');
  }
  // M7 (review 6349153739): no registration, code, decision, cleanup entry or other grant state. The OAuth cleanup
  // cursor is a separate directory of maintenance metadata (positions only) and is not matched here.
  const files = (await listFiles(server.dataDir)).map(file => path.relative(server.dataDir, file).split(path.sep).join('/'));
  const grantState = /^auth\/(oauth-consent-decisions|oauth-codes|oauth-cleanup|agent-registrations|agent-registration-tokens|agent-registration-codes|agent-registration-recovery)\//;
  assert.deepEqual(files.filter(file => grantState.test(file)), [], 'no remote-auth or registration records');
  const cursor = files.find(file => file === 'auth/oauth-cleanup-cursor/cursor.json');
  if (cursor) assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(server.dataDir, cursor), 'utf8'))).sort(), ['keptFromMs', 'nextBucketStartMs', 'ranAt', 'version']);
});
