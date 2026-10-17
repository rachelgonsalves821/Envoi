// agent-registration v1 (task A-4.1), through the HTTP API: route availability, the legacy
// installation projection, agent status, the owner installation routes, per-installation revoke,
// and the narrowed startup reconciliation (§6.5, §12). Every test runs on FileStore, and on
// PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { agentStatus, api, claim, deleteData, launch, newRotationId, openEventStream, owner, readData, refresh, send, sha256, sleep, waitForMessageStatus, writeData } from './a3-harness.js';
import { PostgresStore } from '../src/postgres-storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-registration', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertContract(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schema ${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}
// The owner_ui and helper rows of x-codes give the status of each code.
function assertCode(res, code) {
  assert.equal(res.payload?.code, code, res.text);
  assert.equal(res.payload.error, code);
  assert.equal(res.status, schemas['x-codes'][code].status, res.text);
  assertContract('errorEnvelope', res.payload);
}

const markerParts = ['system', 'agent-revocations-reconciled-v1.json'];
const backends = [{ name: 'FileStore', env: {}, suffix: '61' }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, suffix: '62' }] : [])];
const on = { ENVOI_INSTALLATIONS_V2: 'true' };

// Stored documents, read and edited the same way on both stores.
function documents(t, backend, server) {
  if (backend.name === 'FileStore') return { get: parts => readData(server, ...parts), put: (parts, value) => writeData(server, parts, value), remove: parts => deleteData(server, ...parts) };
  const store = new PostgresStore(backend.env.DATABASE_URL);
  t.after(() => store.close());
  return { get: parts => store.getJson(path.join(...parts)), put: (parts, value) => store.putJson(path.join(...parts), value), remove: parts => store.deleteJson(path.join(...parts)) };
}
const installationsRoute = who => `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/installations`;
const agentParts = who => ['inboxes', who.inbox.id, 'agents', `${who.agent.id}.json`];

async function relaunch(backend, server, env) {
  await server.stop(true);
  return launch({ ...backend.env, ...env }, backend.name === 'FileStore' ? server.dataDir : null);
}

for (const backend of backends) {
  test(`[${backend.name}] with the flags off nothing new is offered`, { timeout: 60000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const routes = await api(server.baseUrl, '/api/onboarding/routes');
    assert.equal(routes.status, 200);
    assert.equal(routes.headers.get('cache-control'), 'public, max-age=60');
    assertContract('routeAvailability', routes.payload);
    assert.equal(routes.payload.registrationEnabled, false);
    assert.equal(routes.payload.installationsEnabled, false);
    assert.ok([...routes.payload.routes, ...routes.payload.deliveryModes].every(item => item.available === false));

    const who = await owner(server.baseUrl, `${backend.suffix}01`);
    assertCode(await api(server.baseUrl, installationsRoute(who), { session: who.session }), 'FEATURE_DISABLED');
    assertCode(await api(server.baseUrl, `${installationsRoute(who)}/installation_example/revoke`, { session: who.session, body: {} }), 'FEATURE_DISABLED');
    const status = await agentStatus(server.baseUrl, who.agentApiToken);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.payload.installation, undefined, 'status has no installation with the flags off');
  });

  test(`[${backend.name}] installations project legacy families and end one installation without freezing the identity`, { timeout: 90000 }, async t => {
    let server = await launch({ ...backend.env, ...on });
    t.after(() => server.stop());
    const routes = await api(server.baseUrl, '/api/onboarding/routes');
    assert.equal(routes.payload.installationsEnabled, true);
    assert.equal(routes.payload.registrationEnabled, false, 'registration needs its own flag');
    assert.ok(routes.payload.routes.every(item => item.available === false), 'no route without registration');

    const [who, other] = await Promise.all([owner(server.baseUrl, `${backend.suffix}11`), owner(server.baseUrl, `${backend.suffix}12`)]);
    const listed = await api(server.baseUrl, installationsRoute(who), { session: who.session });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assertContract('ownerInstallationList', listed.payload);
    assert.equal(listed.payload.agentId, who.agent.id);
    assert.equal(listed.payload.installations.length, 1);
    const [installation] = listed.payload.installations;
    assert.match(installation.id, /^installation_legacy_/);
    assert.deepEqual({ status: installation.status, legacy: installation.legacy, connectionRoute: installation.connectionRoute, deliveryMode: installation.deliveryMode, endedReason: installation.endedReason, endedAt: installation.endedAt },
      { status: 'active', legacy: true, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', endedReason: null, endedAt: null });
    assert.equal(installation.runtime.version, null);

    const status = await agentStatus(server.baseUrl, who.agentApiToken);
    assert.equal(status.status, 200, status.text);
    assertContract('agentStatusWithInstallation', status.payload);
    assert.deepEqual(status.payload.installation, { id: installation.id, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', legacy: true });

    // Another workspace's human cannot see or end it.
    assert.notEqual((await api(server.baseUrl, installationsRoute(who), { session: other.session })).status, 200);
    assert.notEqual((await api(server.baseUrl, `${installationsRoute(who)}/${installation.id}/revoke`, { session: other.session, body: {} })).status, 200);
    assertCode(await api(server.baseUrl, `${installationsRoute(who)}/installation_unknown/revoke`, { session: who.session, body: {} }), 'INSTALLATION_NOT_FOUND');

    // A lease held by the installation is released when it ends.
    const sent = await send(server.baseUrl, other, who, { caseId: `case_a41_${backend.suffix}` });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(server.baseUrl, who, sent.payload.id, 'delivered');
    assert.ok((await claim(server.baseUrl, who.agentApiToken)).payload.work, 'the installation holds a lease');

    const revoked = await api(server.baseUrl, `${installationsRoute(who)}/${installation.id}/revoke`, { session: who.session, body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    assertContract('installationRevoked', revoked.payload);
    assert.equal(revoked.payload.installation.id, installation.id);
    assert.equal(revoked.payload.installation.status, 'ended');
    assert.equal(revoked.payload.installation.endedReason, 'revoked');
    // A second revoke changes nothing.
    const again = await api(server.baseUrl, `${installationsRoute(who)}/${installation.id}/revoke`, { session: who.session, body: {} });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.payload.installation.endedAt, revoked.payload.installation.endedAt);

    const denied = await refresh(server.baseUrl, who.agentRefreshToken, newRotationId());
    assert.equal(denied.payload?.code, 'CREDENTIAL_REVOKED', denied.text);
    assert.equal(denied.payload.reason, 'revoked');
    assert.equal((await agentStatus(server.baseUrl, who.agentApiToken)).payload?.code, 'CREDENTIAL_REVOKED');

    const events = await api(server.baseUrl, `/api/inboxes/${who.inbox.id}/events/delta?limit=200`, { session: who.session });
    const types = events.payload.events.map(event => event.type);
    assert.ok(types.includes('agent.installation_revoked'), types.join(','));
    assert.ok(events.payload.events.some(event => event.type === 'work.available' && event.reason === 'lease_released'), 'the released lease is announced');

    const docs = documents(t, backend, server);
    const stored = await docs.get(agentParts(who));
    assert.deepEqual({ status: stored.status, onboardingStatus: stored.onboardingStatus }, { status: 'active', onboardingStatus: 'approved' }, 'the identity is not frozen');

    // §6.5: not even after a restart, and not even if the reconciliation runs again.
    await docs.remove(markerParts);
    server = await relaunch(backend, server, on);
    const afterRestart = await documents(t, backend, server).get(agentParts(who));
    assert.deepEqual({ status: afterRestart.status, onboardingStatus: afterRestart.onboardingStatus }, { status: 'active', onboardingStatus: 'approved' }, 'restart must not freeze the agent');
    const restartedList = await api(server.baseUrl, installationsRoute(who), { session: who.session });
    assert.equal(restartedList.payload.installations[0].status, 'ended');
    assert.equal(restartedList.payload.installations[0].endedReason, 'revoked');
  });

  test(`[${backend.name}] a REFRESH_REPLAY of the only family does not freeze the agent at restart`, { timeout: 60000 }, async t => {
    let server = await launch({ ...backend.env, ...on });
    t.after(() => server.stop());
    const who = await owner(server.baseUrl, `${backend.suffix}21`);
    assert.equal((await refresh(server.baseUrl, who.agentRefreshToken, newRotationId())).status, 200);
    assert.equal((await refresh(server.baseUrl, who.agentRefreshToken, newRotationId())).payload?.code, 'REFRESH_REPLAY');
    const docs = documents(t, backend, server);
    await docs.remove(markerParts);
    server = await relaunch(backend, server, on);
    const stored = await documents(t, backend, server).get(agentParts(who));
    assert.deepEqual({ status: stored.status, onboardingStatus: stored.onboardingStatus }, { status: 'active', onboardingStatus: 'approved' });
    const listed = await api(server.baseUrl, installationsRoute(who), { session: who.session });
    assert.equal(listed.payload.installations[0].endedReason, 'refresh_replay');
    assert.ok(await documents(t, backend, server).get(markerParts), 'the reconciliation records that it ran');
  });
}

// Two active installations of one agent (fixture owner-installations-legacy-several): ending one
// leaves the other's token, refresh and stream alone. FileStore only, because the second family is
// seeded on disk the way the pre-6e9d4bf legacy approve left them.
test('[FileStore] revoking one of two installations ends only that one', { timeout: 60000 }, async t => {
  const server = await launch(on);
  t.after(() => server.stop());
  const who = await owner(server.baseUrl, '6131');
  const index = await readData(server, 'auth', 'agent-credentials', `${sha256(who.agentApiToken)}.json`);
  const familyParts = id => ['auth', 'agent-credential-families', who.inbox.id, who.agent.id, `${id}.json`];
  const family = await readData(server, ...familyParts(index.familyId));
  const secondId = 'credential_family_00000000-0000-4000-8000-000000000002';
  const second = { access: `envoi_agent_access_${'s'.repeat(43)}`, refresh: `envoi_agent_refresh_${'r'.repeat(64)}` };
  const issuedAt = new Date().toISOString();
  await writeData(server, familyParts(secondId), { ...family, id: secondId, createdAt: '2026-01-01T00:00:00.000Z', rotationCounter: 1 });
  await writeData(server, ['auth', 'agent-credentials', `${sha256(second.access)}.json`], { tokenType: 'access', agentId: who.agent.id, inboxId: who.inbox.id, familyId: secondId, issuedAt, expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null });
  await writeData(server, ['auth', 'agent-refresh-credentials', `${sha256(second.refresh)}.json`], { tokenType: 'refresh', agentId: who.agent.id, inboxId: who.inbox.id, familyId: secondId, issuedAt, expiresAt: family.refreshExpiresAt, usedAt: null, revokedAt: null });

  const listed = (await api(server.baseUrl, installationsRoute(who), { session: who.session })).payload.installations;
  assert.deepEqual(listed.map(item => item.status), ['active', 'active']);
  const first = listed.find(item => item.id.endsWith(index.familyId.replace('credential_family_', '')));
  const streams = { first: await openEventStream(server, who.inbox.id, who.agentApiToken), second: await openEventStream(server, who.inbox.id, second.access) };
  assert.equal(streams.first.status, 200);
  assert.equal(streams.second.status, 200);

  const revoked = await api(server.baseUrl, `${installationsRoute(who)}/${first.id}/revoke`, { session: who.session, body: {} });
  assert.equal(revoked.status, 200, revoked.text);
  const ended = await streams.first.waitFor(frame => frame.event === 'credential.ended', { message: 'credential.ended on the revoked installation' });
  assert.equal(ended.data.code, 'CREDENTIAL_REVOKED');
  await sleep(500);
  assert.equal(streams.second.ended, false, 'the other installation keeps its stream');
  assert.ok(!streams.second.events.some(frame => frame.event === 'credential.ended'));
  assert.equal((await agentStatus(server.baseUrl, second.access)).status, 200, 'the other installation still works');
  assert.equal((await refresh(server.baseUrl, second.refresh, newRotationId())).status, 200);
  assert.equal((await agentStatus(server.baseUrl, who.agentApiToken)).payload?.code, 'CREDENTIAL_REVOKED');
  const after = (await api(server.baseUrl, installationsRoute(who), { session: who.session })).payload.installations;
  assert.deepEqual(after.map(item => [item.id === first.id, item.status]).sort(), [[false, 'active'], [true, 'ended']]);
  streams.second.close();
});

test('registration without installations refuses to start', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(here, '..'), env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_AGENT_REGISTRATION_V2: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2/);
});
