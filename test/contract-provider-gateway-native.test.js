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
    assert.ok(Buffer.byteLength(JSON.stringify(request.body ?? '')) <= requestMaxBytes, `${fixture.id}: request size`);
    const responseValue = response.body ?? response.bodyText;
    assert.ok(Buffer.byteLength(JSON.stringify(responseValue)) <= responseMaxBytes, `${fixture.id}: response size`);
    const validate = def(response.schema);
    assert.equal(validate(responseValue), true, `${fixture.id}: ${ajv.errorsText(validate.errors)}`);
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
    if (fixture.response) assert.ok(bytes(JSON.stringify(fixture.response.body ?? fixture.response.bodyText)) <= schemas['x-limits'].responseMaxBytes, `${fixture.id}: response bytes`);
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


const ms = iso => Date.parse(iso);

test('provider-gateway-native: the repaired session is acquired in causal order and its claim and reply happen inside a live lease and run budget (G1)', async () => {
  const { schemas, fixtures } = await load();
  const at = id => ms(fixtures.get(id).context.asOf);
  const upgrade = fixtures.get('scope-upgrade-owner');
  assert.equal(at('scope-upgrade-owner'), ms(upgrade.response.body.effectiveAt), 'the upgrade takes effect at its own clock');
  const confirmed = ms(fixtures.get('repair-activate-native-scope').context.ownerConfirmedAt);
  const order = ['scope-upgrade-owner', 'old-session-refused-after-upgrade', 'repair-pairing-created', 'repair-activate-native-scope', 'repair-acquire-session-csrf', 'claim-new-generation-ok', 'reply-sent-after-repair'];
  for (let i = 1; i < order.length; i += 1) assert.ok(at(order[i]) > at(order[i - 1]), `${order[i]} runs after ${order[i - 1]}`);
  assert.ok(at('repair-pairing-created') < confirmed && confirmed < at('repair-activate-native-scope'), 'owner confirmation sits between pairing and activation');
  const activate = fixtures.get('repair-activate-native-scope');
  assert.equal(ms(activate.response.body.expiresAt) - confirmed, schemas['x-limits'].sessionAbsoluteDays * 86400000, 'seven days exactly from the owner confirmation');
  assert.equal(ms(fixtures.get('claim-new-generation-ok').context.session.absoluteExpiresAt), ms(activate.response.body.expiresAt), 'the claim session carries that bound');
  assert.equal(ms(fixtures.get('repair-pairing-created').response.body.expiresAt) - at('repair-pairing-created'), 600000, 'the pending pairing lasts ten minutes from its clock');
  // The CSRF step: the generation-5 token comes from the existing inbox shell, and is not the generation-4 token.
  const shell = fixtures.get('repair-acquire-session-csrf');
  assert.equal(shell.request.path, '/agent-gateway/inbox');
  assert.match(shell.response.bodyText, /name="csrf" value="PLACEHOLDER_gateway_csrf_g5"/);
  const claim = fixtures.get('claim-new-generation-ok');
  assert.equal(claim.request.headers['x-envoi-gateway-csrf'], 'PLACEHOLDER_gateway_csrf_g5');
  assert.notEqual(claim.request.headers['x-envoi-gateway-csrf'], fixtures.get('claim-work').request.headers['x-envoi-gateway-csrf'], 'not the generation-4 token');
  // A live lease and run budget at the successful claim and at the repaired reply.
  const lease = ms(claim.response.body.packet.leaseExpiresAt);
  assert.equal(lease, at('claim-new-generation-ok') + schemas['x-limits'].leaseSeconds * 1000, 'the lease is granted at the claim clock');
  assert.ok(lease > confirmed && lease > at('repair-activate-native-scope'), 'the lease cannot precede the authorization that allows it');
  const reply = fixtures.get('reply-sent-after-repair');
  const runEnd = ms(reply.context.runStartedAt) + schemas['x-limits'].runBudgetSeconds * 1000;
  assert.ok(at('reply-sent-after-repair') < lease && at('reply-sent-after-repair') <= runEnd, 'the repaired reply is inside the live lease and the run budget');
  assert.equal(reply.context.session.generation, 5);
  assert.equal(reply.request.body.workRef, claim.response.body.packet.workRef);
  assert.equal(reply.request.body.runId, claim.response.body.packet.runId);
  assert.equal(reply.response.body.state, 'sent');
  // Sequence fixtures name their fixtures, and each step runs at that fixture's own clock.
  const sequence = fixtures.get('repair-sequence');
  let last = -Infinity;
  for (const step of sequence.steps) {
    assert.ok(ms(step.at) > last, 'steps strictly increase');
    last = ms(step.at);
    if (step.fixture) assert.equal(ms(step.at), at(step.fixture), `${step.fixture} runs at its step time`);
  }
  const consent = fixtures.get('consent-model').steps.map(step => step.fixture).filter(Boolean);
  assert.ok(consent.includes('reply-sent-after-repair') && !consent.includes('reply-sent'), 'the repaired reply stands in for the generation-4 fixture');
});

test('provider-gateway-native: the 120 s run budget is checked before the 150 s lease, and recovery is a fresh authorized run after expiry (G2)', async () => {
  const { schemas, fixtures } = await load();
  const L = schemas['x-limits'];
  assert.equal(L.runBudgetSeconds, 120);
  assert.equal(L.leaseSeconds, 150);
  assert.ok(L.leaseSeconds > L.runBudgetSeconds);
  assert.deepEqual(schemas['x-check-order'].map(item => item.split(':')[0].split(',')[0]).slice(0, 3), ['session', 'flag and scope', 'agent pause']);
  const orderText = schemas['x-check-order'].join('|');
  assert.ok(orderText.indexOf('run binding') < orderText.indexOf('run budget') && orderText.indexOf('run budget') < orderText.indexOf('lease and fence'), 'run binding, then run budget, then lease');
  assert.ok(orderText.indexOf('idempotency record') < orderText.indexOf('run budget'), 'a settled replay precedes the run check');
  // Every claim that grants a new lease does so at asOf + leaseSeconds.
  for (const fixture of fixtures.values()) {
    const body = fixture.response?.body;
    if (body?.packet && body.replayed === false) assert.equal(ms(body.packet.leaseExpiresAt) - ms(fixture.context.asOf), L.leaseSeconds * 1000, `${fixture.id}: lease = asOf + 150 s`);
    if (fixture.context?.runStartedAt && fixture.context?.asOf && fixture.response?.status === 200 && fixture.request?.path?.startsWith('/api/agent-gateway/work/')) {
      const elapsed = ms(fixture.context.asOf) - ms(fixture.context.runStartedAt);
      assert.ok(elapsed >= 0 && elapsed <= L.runBudgetSeconds * 1000 || fixture.id === 'reply-replay-after-run-expiry', `${fixture.id}: a successful work call is inside its run budget (${elapsed / 1000}s)`);
    }
  }
  const old = { started: ms(fixtures.get('claim-work').context.runStartedAt), leaseEnds: ms(fixtures.get('claim-work').response.body.packet.leaseExpiresAt) };
  const budgetEnd = old.started + L.runBudgetSeconds * 1000;
  assert.ok(budgetEnd < old.leaseEnds, 'the run ends before its lease does');
  // Expired run: refused although the lease is live; nothing leased, sent or extended.
  for (const id of ['claim-expired-run-refused', 'act-expired-run-refused']) {
    const fixture = fixtures.get(id);
    const asOf = ms(fixture.context.asOf);
    assert.ok(asOf > budgetEnd && asOf < old.leaseEnds, `${id}: after the run budget, before the lease ends`);
    assert.equal(fixture.response.status, 409, id);
    assert.equal(fixture.response.body.code, 'GATEWAY_RUN_EXPIRED', id);
    assert.equal(fixture.request.body.runId, 'run_example');
  }
  assert.equal(fixtures.get('claim-expired-run-refused').effects.newLease, false);
  assert.equal(fixtures.get('act-expired-run-refused').effects.effect, 'none');
  // Fresh authorized run while the old lease is live: nothing to claim, no duplicate lease.
  const fresh = fixtures.get('claim-fresh-run-while-old-lease-live');
  assert.notEqual(fresh.request.body.runId, 'run_example');
  assert.ok(ms(fresh.context.asOf) - ms(fresh.context.previousRunStartedAt) >= L.minSecondsBetweenRuns * 1000, 'a fresh run respects the minimum interval between runs');
  assert.equal(fresh.response.body.state, 'idle');
  assert.equal(ms(fresh.context.asOf) + fresh.response.body.retryAfterSeconds * 1000, old.leaseEnds, 'the idle hint is the time left on the old lease');
  // After lease expiry: the same item, new run, new lease, one attempt charged to the expired claim, no budget charge to the old run.
  const after = fixtures.get('claim-replay-after-lease-expiry');
  assert.ok(ms(after.context.asOf) > old.leaseEnds, 'the lease has expired');
  assert.notEqual(after.request.body.runId, 'run_example');
  assert.ok(ms(after.context.asOf) - ms(after.context.previousRunStartedAt) >= L.minSecondsBetweenRuns * 1000);
  assert.equal(after.context.itemsClaimedThisRun, 0, 'a fresh run starts with an empty item budget');
  assert.equal(after.effects.itemsClaimedThisRunAfter, 1);
  assert.equal(after.effects.attemptsChargedToExpiredClaim, 1);
  assert.notEqual(after.response.body.packet.workRef, fixtures.get('claim-work').response.body.packet.workRef);
  assert.equal(after.response.body.packet.runId, 'run_after_expiry');
  // In-budget behaviour is unchanged: replay, restart replay, next item, other-run refusal.
  for (const id of ['claim-lost-response-replay', 'claim-lost-response-after-restart']) {
    const fixture = fixtures.get(id);
    assert.ok(ms(fixture.context.asOf) <= budgetEnd && ms(fixture.context.asOf) < old.leaseEnds, `${id}: in budget with a live lease`);
    assert.equal(fixture.response.body.replayed, true, id);
  }
  const next = fixtures.get('claim-next-item-after-settlement');
  assert.ok(ms(next.context.asOf) <= budgetEnd);
  assert.equal(ms(next.response.body.packet.leaseExpiresAt), ms(next.context.asOf) + L.leaseSeconds * 1000);
  const other = fixtures.get('claim-other-run-while-active');
  assert.equal(ms(other.context.asOf) + other.response.body.retryAfterSeconds * 1000, budgetEnd, 'the other run waits for the run guard to end');
  // A settled reply still replays from its record after the run expired: no new effect, lease or budget.
  const replay = fixtures.get('reply-replay-after-run-expiry');
  assert.ok(ms(replay.context.asOf) > budgetEnd);
  assert.deepEqual(replay.request.body, fixtures.get('reply-sent').request.body);
  assert.equal(replay.response.body.replayed, true);
  assert.equal(replay.effects.effect, 'none');
  assert.equal(schemas['x-codes'].GATEWAY_RUN_EXPIRED.status, 409);
});

