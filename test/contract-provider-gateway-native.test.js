import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), 'utf8'));

async function load() {
  const schemas = await readJson('provider-gateway-native', 'schemas.json');
  const stage1 = await readJson('provider-browser-poll', 'schemas.json');
  const dir = path.join(root, 'provider-gateway-native');
  const fixtures = new Map();
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'schemas.json')) {
    const fixture = await readJson('provider-gateway-native', file);
    fixtures.set(fixture.id, fixture);
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schemas);
  return { schemas, stage1, fixtures, def: name => ajv.getSchema(`${schemas.$id}#/definitions/${name}`), ajv };
}
const https = fixtures => [...fixtures.values()].filter(fixture => fixture.kind === 'http');

test('provider-gateway-native: requests and responses match their closed schemas and byte limits', async () => {
  const { schemas, fixtures, def, ajv } = await load();
  const { requestMaxBytes, responseMaxBytes } = schemas['x-limits'];
  for (const fixture of https(fixtures)) {
    const { request, response } = fixture;
    assert.ok(Buffer.byteLength(JSON.stringify(request.body)) <= requestMaxBytes, `${fixture.id}: request size`);
    assert.ok(Buffer.byteLength(JSON.stringify(response.body)) <= responseMaxBytes, `${fixture.id}: response size`);
    const validate = def(response.schema);
    assert.equal(validate(response.body), true, `${fixture.id}: ${ajv.errorsText(validate.errors)}`);
    if (request.path.endsWith('/work/act')) {
      const valid = def('actRequest')(request.body);
      assert.equal(valid, fixture.id !== 'act-request-invalid-extra-field', `${fixture.id}: act request closed object`);
    }
  }
  assert.deepEqual(schemas['x-endpoints'].filter(e => e.auth === 'gateway_session').map(e => e.path).sort(), ['/api/agent-gateway/work/act', '/api/agent-gateway/work/claim', '/api/agent-gateway/work/renew']);
});

test('provider-gateway-native: the work packet exposes only opaque refs, marks content untrusted and carries no bytes or secrets', async () => {
  const { schemas, fixtures } = await load();
  const claim = fixtures.get('claim-work');
  const { packet } = claim.response.body;
  assert.equal(packet.untrusted, true);
  assert.ok(packet.allowedActions.every(action => schemas['x-actions'].supported.includes(action)));
  assert.ok(packet.snapshot.recentEvents.length <= schemas['x-limits'].snapshotRecentEventsMax);
  assert.ok(packet.snapshot.assets.every(asset => asset.bytesAvailable === false), 'no asset bytes or download URL');
  const text = JSON.stringify(claim.response.body);
  assert.doesNotMatch(text, /\blease_[A-Za-z0-9]{6,}|leaseToken|\binstallation_[A-Za-z0-9]{6,}|credentialFamily|\bagent_[A-Za-z0-9]{10,}|\binbox_[A-Za-z0-9]{6,}|\bowner_[A-Za-z0-9]{6,}|envoi_(?:agent|case_session|mcp)|https?:\/\//, 'no internal id, token or URL');
  assert.match(JSON.stringify(packet.snapshot.recentEvents), /Ignore previous instructions/, 'the fixture keeps an injection attempt as untrusted data');
  assert.ok(schemas['x-no-exposure'].includes('lease tokens'));
  assert.equal(fixtures.get('claim-run-budget-reached').context.itemsClaimedThisRun, schemas['x-limits'].itemsPerRun);
  assert.equal(fixtures.get('claim-idle').response.body.packet, null);
});

test('provider-gateway-native: idempotency, fences and consent', async () => {
  const { schemas, fixtures } = await load();
  const sent = fixtures.get('reply-sent');
  const replay = fixtures.get('reply-replayed-same-key');
  assert.deepEqual(replay.request.body, sent.request.body, 'the retry repeats the same key and body');
  assert.deepEqual({ ...replay.response.body, replayed: false }, sent.response.body, 'the replay differs only by replayed');
  assert.equal(replay.response.body.replayed, true);
  const conflict = fixtures.get('reply-key-conflict');
  assert.equal(conflict.request.body.idempotencyKey, sent.request.body.idempotencyKey);
  assert.notEqual(conflict.request.body.text, sent.request.body.text);
  assert.equal(conflict.response.status, 409);
  assert.equal(sent.response.body.settled, true);
  for (const id of ['reply-needs-owner-approval', 'request-owner']) {
    const body = fixtures.get(id).response.body;
    assert.equal(body.state, 'owner_approval_pending', id);
    assert.equal(body.settled, false, `${id}: nothing is settled or sent`);
    assert.ok(body.requestRef, id);
  }
  assert.equal(fixtures.get('defer-releases-lease').response.body.state, 'deferred');
  assert.equal(fixtures.get('act-action-unsupported').response.status, 400);
  assert.ok(schemas['x-actions'].unsupported.includes(fixtures.get('act-action-unsupported').request.body.action));
  assert.ok(!schemas['x-actions'].supported.includes('complete_case'));
  assert.equal(fixtures.get('reply-wrong-run').request.body.runId !== fixtures.get('reply-sent').request.body.runId, true);
  assert.equal(fixtures.get('renew-once').response.body.renewalsLeft, 0);
  assert.equal(fixtures.get('renew-twice-refused').response.body.code, 'LEASE_LOST');
});

test('provider-gateway-native: scope, pause, revoke and expiry refuse with no effect, and Stage 1 is untouched', async () => {
  const { schemas, stage1, fixtures } = await load();
  for (const fixture of https(fixtures)) {
    if (!fixture.request.path.startsWith('/api/agent-gateway/work/')) continue;
    assert.equal(fixture.request.auth, 'gateway_session');
    assert.ok(fixture.request.headers['x-envoi-gateway-csrf'] && fixture.request.headers.cookie.startsWith('__Host-envoi_agent_gateway='), `${fixture.id}: Stage 1 cookie and CSRF`);
    if (fixture.response.status === 200 && fixture.flags.ENVOI_PROVIDER_GATEWAY_NATIVE_V1) assert.equal(fixture.context.session.scope, 'native_work', `${fixture.id}: success needs native scope`);
  }
  assert.equal(fixtures.get('claim-read-only-session').context.session.scope, 'read_notify');
  assert.equal(fixtures.get('claim-read-only-session').response.body.code, 'GATEWAY_SCOPE_DENIED');
  assert.equal(fixtures.get('claim-paused').response.status, 409);
  assert.equal(fixtures.get('reply-after-pause').response.status, 409);
  assert.equal(fixtures.get('reply-after-revoke').response.body.code, 'CREDENTIAL_REVOKED');
  assert.equal(fixtures.get('claim-session-expired').response.body.code, 'GATEWAY_SESSION_EXPIRED');
  assert.ok(Date.parse(fixtures.get('claim-session-expired').context.session.absoluteExpiresAt) < Date.parse('2026-10-24T12:00:00.000Z'));
  assert.equal(fixtures.get('claim-flag-off').response.status, 404);
  assert.equal(fixtures.get('scope-upgrade-from-gateway-session-denied').response.status, 401, 'a delegated cookie is not owner authority');
  assert.equal(fixtures.get('scope-upgrade-owner').request.auth, 'human_session');
  for (const e of schemas['x-endpoints']) assert.ok(!/\/(?:check|notifications\/ack|session\/renew|pairings?)$/.test(e.path), `${e.path}: no Stage 1 route is redefined`);
  assert.equal(stage1['x-codes'].AGENT_PAUSED.status, 409, 'Stage 1 paused behaviour is the model');
  assert.equal(schemas['x-flags'].ENVOI_PROVIDER_GATEWAY_NATIVE_V1.default, false);
  assert.equal(schemas['x-limits'].sessionAbsoluteDays, 7);
});
