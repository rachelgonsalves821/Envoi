import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), 'utf8'));
// Obvious placeholders: both decode to "PLACEHOLDER-FIXTURE-SECRET-000n".
const SECRETS = ['whsec_UExBQ0VIT0xERVItRklYVFVSRS1TRUNSRVQtMDAwMQ==', `whsec_${Buffer.from('PLACEHOLDER-FIXTURE-SECRET-0002').toString('base64')}`];
const sign = (secret, id, timestamp, body) => `v1,${crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`;

async function load() {
  const schemas = await readJson('provider-event-wake', 'schemas.json');
  const dir = path.join(root, 'provider-event-wake');
  const fixtures = new Map();
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'schemas.json')) {
    const fixture = await readJson('provider-event-wake', file);
    fixtures.set(fixture.id, fixture);
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schemas);
  return { schemas, fixtures, def: name => ajv.getSchema(`${schemas.$id}#/definitions/${name}`), ajv };
}
const deliveries = fixtures => [...fixtures.values()].filter(fixture => fixture.kind === 'delivery');

test('provider-event-wake: every delivery is Standard Webhooks HMAC-SHA256 over id.timestamp.rawBody, signed once', async () => {
  const { schemas, fixtures } = await load();
  for (const secret of SECRETS) {
    const bytes = Buffer.from(secret.slice(6), 'base64').length;
    assert.ok(bytes >= schemas['x-secret'].minBytes && bytes <= schemas['x-secret'].maxBytes, 'fixture secret is within 24..64 bytes');
  }
  let rotation = 0;
  for (const fixture of deliveries(fixtures)) {
    const { headers, bodyText } = fixture.delivery.request;
    assert.ok(Buffer.byteLength(bodyText) <= schemas['x-limits'].additional.eventBodyMaxBytes, `${fixture.id}: body size`);
    assert.match(headers['webhook-timestamp'], /^[0-9]{10}$/, fixture.id);
    for (const name of schemas['x-signing'].headers) assert.ok(headers[name], `${fixture.id}: ${name}`);
    const entries = headers['webhook-signature'].split(' ');
    const expected = SECRETS.map(secret => sign(secret, headers['webhook-id'], headers['webhook-timestamp'], bodyText));
    if (entries.length === 2) {
      rotation += 1;
      assert.deepEqual(entries, [expected[1], expected[0]], `${fixture.id}: new secret first, then the old one`);
    } else {
      assert.equal(entries.length, 1, fixture.id);
      assert.ok(expected.includes(entries[0]), `${fixture.id}: signature verifies with a fixture secret`);
    }
    for (const entry of entries) assert.match(entry, /^v1,[A-Za-z0-9+/]+=*$/, fixture.id);
    // A signature over reformatted bytes must fail: the raw body is signed exactly as sent.
    assert.notEqual(sign(SECRETS[0], headers['webhook-id'], headers['webhook-timestamp'], JSON.stringify(JSON.parse(bodyText), null, 1)), entries[0], `${fixture.id}: whitespace changes the signature`);
    assert.equal(headers['webhook-id'], JSON.parse(bodyText).eventId ?? JSON.parse(bodyText).id ?? headers['webhook-id'], `${fixture.id}: webhook-id is the event id`);
    assert.equal('x-mcp-subscription-id' in headers, fixture.delivery.profile === 'mcp_events', `${fixture.id}: subscription header only for events`);
  }
  assert.equal(rotation, 1);
});

test('provider-event-wake: notifications are opaque and a retry keeps the id but not the signature', async () => {
  const { schemas, fixtures } = await load();
  const reasons = new Set(schemas['x-events'].flatMap(event => event.payloadSchema.properties.reason.enum));
  for (const fixture of deliveries(fixtures)) {
    const body = JSON.parse(fixture.delivery.request.bodyText);
    if (body.type === 'verification') { assert.deepEqual(Object.keys(body).sort(), ['challenge', 'type']); continue; }
    const text = fixture.delivery.request.bodyText;
    assert.doesNotMatch(text, /(?:case|message|work|lease|inbox|agent|installation|asset|family)_[0-9a-zA-Z]{12,}/, `${fixture.id}: no object id`);
    assert.doesNotMatch(text, /envoi_agent_|envoi_case_session_|whsec_|https?:\/\//, `${fixture.id}: no token, secret or URL`);
    const reason = body.data?.reason ?? body.reason;
    assert.ok(reasons.has(reason), `${fixture.id}: reason ${reason}`);
    if (fixture.delivery.profile === 'mcp_events') assert.deepEqual(Object.keys(body).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp'], fixture.id);
  }
  const first = fixtures.get('delivery-work-available').delivery.request;
  const retry = fixtures.get('delivery-retry-new-signature').delivery;
  assert.equal(retry.attempt, 2);
  assert.equal(retry.request.headers['webhook-id'], first.headers['webhook-id']);
  assert.equal(retry.request.bodyText, first.bodyText);
  assert.notEqual(retry.request.headers['webhook-timestamp'], first.headers['webhook-timestamp']);
  assert.notEqual(retry.request.headers['webhook-signature'], first.headers['webhook-signature']);
});

test('provider-event-wake: outcomes follow the retry tables; a 2xx is receipt, never completion', async () => {
  const { schemas, fixtures } = await load();
  for (const fixture of deliveries(fixtures)) {
    const { profile, response, outcome } = fixture.delivery;
    // A request a receiver rejects for its clock is a receiver-side control, not a sender outcome.
    if (outcome === 'receiver_rejected') { assert.equal(fixture.delivery.receiver.verdict, 'reject', fixture.id); assert.equal(response.status, 401, fixture.id); continue; }
    const noRetry = schemas['x-no-retry-statuses'][profile].includes(response.status);
    const retry = schemas['x-retry-statuses'][profile].includes(response.status);
    if (response.status >= 200 && response.status < 300) assert.ok(['verified', 'acknowledged', 'accepted_receipt_only'].includes(outcome), fixture.id);
    else if (noRetry) assert.ok(['subscription_ended_receiver_gone', 'target_needs_secret', 'target_needs_attention'].includes(outcome), fixture.id);
    else assert.ok(retry && outcome === 'retry_scheduled', fixture.id);
    if (response.status === 429 || response.headers?.['retry-after']) assert.match(response.headers['retry-after'], /^[0-9]+$/, fixture.id);
  }
  assert.equal(fixtures.get('grok-delivery-accepted').delivery.outcome, 'accepted_receipt_only');
  assert.equal(fixtures.get('delivery-410-ends-subscription').delivery.outcome, 'subscription_ended_receiver_gone');
  assert.equal(fixtures.get('grok-delivery-401-needs-secret').delivery.outcome, 'target_needs_secret');
  const verification = fixtures.get('verification-request').delivery;
  assert.equal(verification.response.body.challenge, JSON.parse(verification.request.bodyText).challenge, 'the callback echoes the challenge');
});

test('provider-event-wake: events methods, results and errors match the tables; no secret leaves Envoi', async () => {
  const { schemas, fixtures, def, ajv } = await load();
  const ids = ['subscribe-created', 'subscribe-renewed-same-identity', 'subscribe-replay-truncated'];
  for (const id of ids) assert.equal(def('subscribeResult')(fixtures.get(id).response.body.result), true, `${id}: ${ajv.errorsText(def('subscribeResult').errors)}`);
  assert.equal(fixtures.get('subscribe-created').response.body.result.id, fixtures.get('subscribe-renewed-same-identity').response.body.result.id, 'deterministic id');
  assert.equal(fixtures.get('subscribe-replay-truncated').response.body.result.truncated, true);
  assert.deepEqual(fixtures.get('events-list').response.body.result.events, schemas['x-events']);
  for (const event of schemas['x-events']) assert.deepEqual(event.delivery, ['webhook']);
  assert.deepEqual(fixtures.get('discover-events-capability').response.body.result.capabilities.events, {});
  for (const fixture of fixtures.values()) {
    if (fixture.kind !== 'http') continue;
    const error = fixture.response.body.error;
    if (error?.code === -32015) {
      assert.equal(error.message, schemas['x-callback-errors'].name, fixture.id);
      assert.ok(schemas['x-callback-errors'].reasons.includes(error.data.reason), `${fixture.id}: ${error.data.reason}`);
    }
    assert.doesNotMatch(JSON.stringify(fixture.response), /whsec_/, `${fixture.id}: no response carries a secret`);
    if (fixture.request.headers?.['mcp-protocol-version'] === schemas['x-protocol'].existingToolsProtocolVersion && fixture.request.body.method.startsWith('events/')) assert.equal(error.code, -32601, `${fixture.id}: events exist only at ${schemas['x-protocol'].eventsProtocolVersion}`);
    if (fixture.request.body?.method?.startsWith?.('events/') && fixture.request.headers['mcp-protocol-version'] === schemas['x-protocol'].eventsProtocolVersion && fixture.flags.ENVOI_MCP_EVENTS_V1 && fixture.context.route === 'remote_mcp_oauth' && fixture.context.agentStatus === 'active') {
      // a qualifying family at the events version either succeeds or gives a callback/params error, never method-not-found
      assert.notEqual(error?.code, -32601, fixture.id);
    }
  }
  assert.equal(fixtures.get('subscribe-paused').response.status, 409);
  assert.deepEqual(fixtures.get('unsubscribe-ok').response.body.result, {});
  assert.deepEqual(fixtures.get('unsubscribe-unknown-is-idempotent').response.body, { ...fixtures.get('unsubscribe-ok').response.body });
});

test('provider-event-wake: the Grok target never exposes its secret and only the owner can change it', async () => {
  const { schemas, fixtures, def, ajv } = await load();
  for (const id of ['grok-target-put', 'grok-target-get-no-secret']) {
    const response = fixtures.get(id).response;
    assert.equal(def('grokTargetResponse')(response.body), true, `${id}: ${ajv.errorsText(def('grokTargetResponse').errors)}`);
    assert.equal(response.body.target.secretSet, true);
    assert.doesNotMatch(JSON.stringify(response), /secret"\s*:\s*"|whsec_/);
  }
  for (const id of ['grok-target-put', 'grok-target-put-origin-not-allowed', 'grok-target-put-secret-invalid', 'grok-target-get-no-secret']) {
    const request = fixtures.get(id).request;
    assert.equal(request.auth, 'human_session', id);
    assert.ok(request.headers['x-envoi-csrf'] && request.headers.origin, `${id}: CSRF and origin`);
  }
  assert.equal(fixtures.get('grok-target-agent-token-refused').request.auth, 'bearer');
  assert.equal(fixtures.get('grok-target-agent-token-refused').response.status, 401);
  assert.deepEqual(Object.keys(schemas['x-target-states']).sort(), ['active', 'ended', 'needs_attention', 'needs_secret']);
});

test('provider-event-wake: unproven interface facts stay explicit gates and flags default off', async () => {
  const { schemas, fixtures } = await load();
  const evidence = fixtures.get('grok-evidence-gates').evidence;
  assert.deepEqual(evidence.unproven.map(item => item.gate).sort(), [...schemas['x-evidence-gates']].sort());
  for (const source of evidence.sources) assert.match(source.url, /^https:\/\//);
  assert.ok(evidence.unproven.some(item => item.gate === 'G1' && /claim/.test(item.claim)), 'Grok processing needs a proven claim path');
  assert.ok(evidence.unproven.some(item => item.gate === 'D3' && /MCP 2\.0/.test(item.claim)), 'MCP 2.0 at /mcp is a stated prerequisite');
  for (const flag of Object.values(schemas['x-flags'])) { assert.equal(flag.default, false); assert.equal(flag.failsStartupClosed, true); }
  assert.deepEqual(schemas['x-notification'].newFields, []);
  assert.equal(schemas['x-limits'].additional.grokTargetsPerAgent, 1);
});

test('provider-event-wake: unsubscribe and subscribe requests are the documented closed forms, and a request without delivery.mode is not one', async () => {
  const { fixtures, def, ajv } = await load();
  for (const fixture of fixtures.values()) {
    const body = fixture.request?.body;
    if (!body || !['events/subscribe', 'events/unsubscribe'].includes(body.method)) continue;
    const name = body.method === 'events/subscribe' ? 'subscribeParams' : 'unsubscribeParams';
    const valid = def(name)(body.params);
    // Only the fixtures that exercise a refused request may fail the request schema.
    const refusedForm = ['subscribe-secret-invalid', 'subscribe-event-unknown', 'unsubscribe-delivery-mode-missing'].includes(fixture.id);
    const refusedByPolicy = fixture.response?.body?.error?.reason === 'secret_invalid';
    assert.equal(valid || refusedForm || refusedByPolicy, true, `${fixture.id}: ${ajv.errorsText(def(name).errors)}`);
    if (!refusedForm) assert.equal(valid, true, fixture.id);
  }
  for (const id of ['unsubscribe-ok', 'unsubscribe-unknown-is-idempotent']) {
    const params = fixtures.get(id).request.body.params;
    assert.equal(params.delivery.mode, 'webhook', id);
    assert.deepEqual(fixtures.get(id).response.body.result, {}, `${id}: empty result, no secret`);
    assert.doesNotMatch(JSON.stringify(fixtures.get(id).response), /whsec_|secret/, id);
  }
  const missing = fixtures.get('unsubscribe-delivery-mode-missing');
  assert.equal(def('unsubscribeParams')(missing.request.body.params), false);
  assert.equal(missing.response.body.error.code, -32602);
  assert.equal(missing.response.body.error.data.reason, 'delivery_mode_required');
  assert.equal(def('unsubscribeParams')(fixtures.get('unsubscribe-ok').request.body.params), true);
});

test('provider-event-wake: verification is cached per principal and URL for a bounded time and invalidated by every binding change', async () => {
  const { schemas, fixtures } = await load();
  const policy = schemas['x-verification-cache'];
  const ttl = policy.ttlSeconds;
  assert.equal(ttl, schemas['x-limits'].additional.verificationCacheSeconds);
  for (const reason of ['expiry', 'secret_changed', 'url_changed', 'allowlist_changed', 'subscription_ended', 'installation_ended', 'flag_off']) assert.ok(policy.invalidatedBy.includes(reason), reason);
  assert.ok(policy.destinationChecksOnHit.length >= 4, 'destination checks are never cached');
  const cases = ['subscribe-created', 'subscribe-renewed-same-identity', 'subscribe-renewed-secret-rotated', 'subscribe-verification-cache-expired', 'subscribe-verification-binding-changed', 'subscribe-cache-hit-address-now-disallowed'];
  const secretOf = fixture => fixture.request.body.params.delivery.secret;
  const urlOf = fixture => fixture.request.body.params.delivery.url;
  for (const id of cases) {
    const fixture = fixtures.get(id);
    const { effects, context } = fixture;
    const cache = context.verificationCache;
    if (effects.verificationCache === 'hit') {
      assert.equal(effects.verificationSent, false, id);
      assert.ok(cache.ageSeconds <= ttl, `${id}: inside the window`);
      assert.equal(cache.url, urlOf(fixture), `${id}: same canonical URL`);
      assert.equal(secretOf(fixture), 'whsec_UExBQ0VIT0xERVItRklYVFVSRS1TRUNSRVQtMDAwMQ==', `${id}: same secret as the cached verification`);
      assert.equal(effects.destinationChecksRerun, true, `${id}: destination checks run on a hit`);
    } else if (effects.verificationCache === 'dropped') {
      assert.equal(effects.verificationSent, false, id);
      assert.equal(fixture.response.body.error.data.reason, 'address_not_allowed', id);
      assert.ok(cache.ageSeconds <= ttl, `${id}: the entry was valid, yet destination validation still refused`);
    } else {
      assert.equal(effects.verificationSent, true, `${id}: a miss, expiry or invalidation verifies again`);
      if (effects.verificationCache === 'expired') assert.ok(cache.ageSeconds > ttl, id);
      if (effects.verificationCache === 'invalidated_secret') assert.notEqual(secretOf(fixture), 'whsec_UExBQ0VIT0xERVItRklYVFVSRS1TRUNSRVQtMDAwMQ==', id);
      if (effects.verificationCache === 'invalidated_url') assert.notEqual(urlOf(fixture), cache.url, id);
    }
  }
  assert.equal(fixtures.get('subscribe-renewed-secret-rotated').effects.dualSignSeconds, schemas['x-limits'].additional.secretDualSignSeconds);
  assert.equal(fixtures.get('subscribe-created').effects.verificationCache, 'miss');
  assert.match(policy.storage, /never the secret/);
  const hit = fixtures.get('subscribe-renewed-same-identity').response.body.result;
  assert.equal(hit.id, fixtures.get('subscribe-created').response.body.result.id, 'a renewal keeps the deterministic id');
});

test('provider-event-wake: signing clocks are causal and receivers apply a 300 s freshness window with fresh, stale, future and retry controls', async () => {
  const { schemas, fixtures } = await load();
  const tolerance = schemas['x-clock'].toleranceSeconds;
  const unix = iso => Math.floor(Date.parse(iso) / 1000);
  for (const fixture of deliveries(fixtures)) {
    const { delivery } = fixture;
    const ts = Number(delivery.request.headers['webhook-timestamp']);
    assert.equal(ts, unix(delivery.sentAt), `${fixture.id}: webhook-timestamp is the signing time`);
    const body = JSON.parse(delivery.request.bodyText);
    const created = body.timestamp ?? body.createdAt;
    if (created) assert.ok(unix(created) <= ts, `${fixture.id}: an event is never signed before it exists`);
    if (delivery.receiver) {
      const delta = unix(delivery.receiver.asOf) - ts;
      assert.equal(delivery.receiver.deltaSeconds, delta, fixture.id);
      assert.equal(delivery.receiver.verdict, Math.abs(delta) <= tolerance ? 'accept' : 'reject', `${fixture.id}: verdict follows the window`);
      assert.equal(delivery.receiver.reason, Math.abs(delta) <= tolerance ? null : delta > 0 ? 'timestamp_stale' : 'timestamp_future', fixture.id);
    }
    if (['acknowledged', 'accepted_receipt_only', 'verified'].includes(delivery.outcome)) assert.equal(delivery.receiver.verdict, 'accept', `${fixture.id}: a success is fresh at the receiver`);
    if (delivery.previousAttempt) {
      assert.ok(unix(delivery.sentAt) >= unix(delivery.previousAttempt.sentAt) + delivery.previousAttempt.retryAfterSeconds, `${fixture.id}: a retry waits for Retry-After`);
      assert.ok(unix(delivery.sentAt) > unix(delivery.previousAttempt.sentAt), fixture.id);
    }
  }
  const verdict = id => fixtures.get(id).delivery.receiver;
  assert.equal(verdict('delivery-work-available').verdict, 'accept');
  assert.equal(verdict('delivery-replayed-stale').reason, 'timestamp_stale');
  assert.equal(verdict('delivery-future-timestamp-rejected').reason, 'timestamp_future');
  assert.equal(verdict('delivery-clock-edge-300s-accepted').deltaSeconds, tolerance);
  assert.equal(verdict('delivery-clock-edge-301s-rejected').deltaSeconds, tolerance + 1);
  assert.equal(verdict('grok-delivery-accepted').verdict, 'accept');
  assert.equal(verdict('grok-delivery-replayed-stale').reason, 'timestamp_stale');
  // A stale replay carries the very same valid signature: the clock check, not the HMAC, rejects it.
  assert.deepEqual(fixtures.get('delivery-replayed-stale').delivery.request, fixtures.get('delivery-work-available').delivery.request);
  // Retries are signed at the retry time with the same webhook-id.
  for (const [retry, first] of [['delivery-retry-new-signature', 'delivery-503-retries'], ['grok-delivery-retry-fresh-clock', 'grok-delivery-429-retry-after']]) {
    const a = fixtures.get(first).delivery, b = fixtures.get(retry).delivery;
    assert.equal(b.request.headers['webhook-id'], a.request.headers['webhook-id'], retry);
    assert.notEqual(b.request.headers['webhook-signature'], a.request.headers['webhook-signature'], retry);
    assert.ok(unix(b.sentAt) - unix(a.sentAt) >= Number(a.response.headers['retry-after']), `${retry}: after Retry-After`);
  }
  assert.match(schemas['x-clock'].senderRule, /never reuses/);
});

