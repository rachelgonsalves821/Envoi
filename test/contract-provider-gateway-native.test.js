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
      // Closed object AND the UTF-8 byte guard: a character count cannot enforce a byte limit.
      const valid = def('actRequest')(request.body) && (request.body.text === undefined || Buffer.byteLength(request.body.text, 'utf8') <= schemas['x-limits'].replyTextMaxBytes);
      const invalid = ['act-request-invalid-extra-field', 'reply-text-multibyte-over-byte-limit', 'reply-text-one-byte-over-limit'];
      assert.equal(valid, !invalid.includes(fixture.id), `${fixture.id}: act request closed object and byte guard`);
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

const bytes = text => Buffer.byteLength(text, 'utf8');

test('provider-gateway-native: UTF-8 byte limits are enforced on bytes at and around the boundary, never on characters', async () => {
  const { schemas, fixtures } = await load();
  const limit = schemas['x-limits'].replyTextMaxBytes;
  const text = id => fixtures.get(id).request.body.text;
  assert.equal(bytes(text('reply-text-ascii-at-byte-limit')), limit);
  assert.equal(bytes(text('reply-text-multibyte-at-byte-limit')), limit);
  assert.equal(Array.from(text('reply-text-multibyte-at-byte-limit')).length, 1024, 'four bytes per character');
  assert.ok(bytes(text('reply-text-multibyte-over-byte-limit')) > limit && text('reply-text-multibyte-over-byte-limit').length < limit * 2, 'over in bytes');
  assert.ok(Array.from(text('reply-text-multibyte-over-byte-limit')).length < limit, 'under the limit when counted in characters');
  assert.ok(Buffer.byteLength(JSON.stringify(fixtures.get('reply-text-multibyte-over-byte-limit').request.body)) < schemas['x-limits'].requestMaxBytes, 'the whole request is still under the request cap, so only the text guard refuses it');
  assert.equal(bytes(text('reply-text-one-byte-over-limit')), limit + 1);
  for (const id of ['reply-text-multibyte-over-byte-limit', 'reply-text-one-byte-over-limit']) {
    assert.equal(fixtures.get(id).response.status, 400);
    assert.equal(fixtures.get(id).response.body.reason, 'text_too_long');
    assert.equal(schemas['x-utf8-guards'][0].reason, 'text_too_long');
  }
  for (const id of ['reply-text-ascii-at-byte-limit', 'reply-text-multibyte-at-byte-limit']) assert.equal(fixtures.get(id).response.body.state, 'sent');
  const summary = fixtures.get('claim-summary-truncated-on-code-point').response.body.packet.snapshot.recentEvents[0];
  assert.equal(bytes(summary.summary), schemas['x-limits'].summaryMaxBytes);
  assert.equal(summary.truncated, true);
  assert.equal(Buffer.from(summary.summary, 'utf8').toString('utf8'), summary.summary, 'cut on a code point boundary: valid UTF-8, no replacement character');
  assert.doesNotMatch(summary.summary, /ï¿½/);
  assert.ok(fixtures.get('claim-summary-truncated-on-code-point').context.originalSummaryBytes > schemas['x-limits'].summaryMaxBytes);
  for (const fixture of fixtures.values()) {
    if (fixture.response?.body?.packet) for (const event of fixture.response.body.packet.snapshot.recentEvents) assert.ok(bytes(event.summary) <= schemas['x-limits'].summaryMaxBytes, `${fixture.id}: summary bytes`);
    if (fixture.response) assert.ok(bytes(JSON.stringify(fixture.response.body)) <= schemas['x-limits'].responseMaxBytes, `${fixture.id}: response bytes`);
  }
});

test('provider-gateway-native: a lost claim response replays the outstanding item without a second lease or a second budget charge', async () => {
  const { schemas, fixtures } = await load();
  const first = fixtures.get('claim-work').response.body;
  const replay = fixtures.get('claim-lost-response-replay');
  assert.deepEqual({ ...replay.response.body, replayed: false }, first, 'the same packet, only replayed differs');
  assert.equal(replay.response.body.replayed, true);
  assert.equal(replay.effects.newLease, false);
  assert.equal(replay.effects.itemsClaimedThisRunAfter, replay.context.itemsClaimedThisRun, 'the budget is not charged twice');
  const restart = fixtures.get('claim-lost-response-after-restart');
  assert.equal(restart.context.serverRestarted, true);
  assert.deepEqual(restart.response.body, replay.response.body, 'a durable outstanding record survives a restart');
  const next = fixtures.get('claim-next-item-after-settlement');
  assert.equal(next.context.outstandingClaim.settled, true);
  assert.notEqual(next.response.body.packet.workRef, first.packet.workRef, 'after settlement the run advances to a new item');
  assert.equal(next.effects.itemsClaimedThisRunAfter, next.context.itemsClaimedThisRun + 1);
  assert.equal(next.response.body.replayed, false);
  const expired = fixtures.get('claim-replay-after-lease-expiry');
  assert.equal(expired.context.outstandingClaim.leaseExpired, true);
  assert.notEqual(expired.response.body.packet.workRef, first.packet.workRef);
  assert.equal(expired.effects.attemptsChargedToExpiredClaim, 1, 'the expired claim already counted once under the existing queue rules');
  const other = fixtures.get('claim-other-run-while-active');
  assert.equal(other.response.status, 409);
  assert.equal(other.response.body.code, 'GATEWAY_CHECK_ACTIVE');
  assert.equal(other.response.headers['retry-after'], String(other.response.body.retryAfterSeconds));
  assert.notEqual(other.request.body.runId, other.context.outstandingClaim.runId);
  assert.ok(schemas['x-claim-replay'].survivesRestart);
  for (const fixture of fixtures.values()) if (fixture.response?.schema === 'claimResult') assert.equal(typeof fixture.response.body.replayed, 'boolean', fixture.id);
});

test('provider-gateway-native: the owner upgrade ends the old session and the replacement comes only from the owner-confirmed repair', async () => {
  const { schemas, fixtures } = await load();
  const upgrade = fixtures.get('scope-upgrade-owner').response.body;
  assert.equal(upgrade.generation, upgrade.previousGeneration + 1);
  assert.equal(upgrade.repair, 'owner_confirmed_repair');
  assert.equal(JSON.stringify(fixtures.get('scope-upgrade-owner').response).includes('set-cookie'), false, 'the upgrade issues no cookie');
  const old = fixtures.get('old-session-refused-after-upgrade');
  assert.equal(old.context.session.generation, upgrade.previousGeneration);
  assert.equal(old.context.currentGeneration, upgrade.generation);
  assert.equal(old.response.status, 401);
  assert.equal(old.response.body.code, 'GATEWAY_SESSION_EXPIRED');
  assert.equal(old.response.body.reason, 'generation_changed');
  const pairing = fixtures.get('repair-pairing-created');
  assert.deepEqual(Object.keys(pairing.request.body).sort(), ['requestedName', 'requestedPermissions', 'runtime'], 'the Stage 1 pairing body is unchanged');
  assert.deepEqual(pairing.request.body.requestedPermissions, ['receive_agent_messages'], 'scope never comes from the request');
  assert.equal(pairing.request.path, '/api/agent-gateway/pairings');
  const activate = fixtures.get('repair-activate-native-scope');
  assert.equal(activate.request.path, '/api/agent-gateway/pairing/activate');
  assert.doesNotMatch(JSON.stringify(activate.response.body), /PLACEHOLDER|token|cookie/i, 'no credential in the body');
  const cookies = activate.response.headers['set-cookie'];
  assert.ok(cookies.some(c => c.startsWith('__Host-envoi_agent_gateway=') && c.includes('HttpOnly') && c.includes('Secure') && c.includes('SameSite=Strict')));
  assert.ok(cookies.some(c => c.startsWith('__Host-envoi_agent_pair=;') && c.includes('Max-Age=0')), 'the pending cookie is cleared');
  assert.ok(Date.parse(activate.response.body.expiresAt) - Date.parse(activate.context.ownerConfirmedAt) <= schemas['x-limits'].sessionAbsoluteDays * 86400000, 'the seven-day bound runs from the owner confirmation');
  const claim = fixtures.get('claim-new-generation-ok');
  assert.equal(claim.context.session.generation, upgrade.generation);
  assert.equal(claim.context.session.scope, 'native_work');
  assert.equal(claim.response.status, 200);
  assert.notEqual(claim.request.headers.cookie, fixtures.get('claim-work').request.headers.cookie, 'a different cookie');
  assert.equal(fixtures.get('scope-upgrade-from-gateway-session-denied').response.status, 401, 'no self-upgrade');
  assert.equal(schemas['x-session-repair'].steps.length, 4);
});

