// a3-pause-auth v1 (A-1): stable credential codes, refresh outcome order and
// access-route precedence (handoffs.md §1, §2, §2.1, §2.2). Test-first.
// Expiry and recovery-window cases are simulated by editing FileStore JSON on
// disk while the server runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  REQUEST_ID_PATTERN, accessCredentialParts, agentStatus, api, assertError, assertSchema, claim, deleteData, editData,
  expireAccessToken, expireFamily, launch, newRotationId, openEventStream, owner, ownerEvents, PAST, readData,
  recoveryParts, refresh, refreshCredentialParts, revokeAgent
} from './a3-harness.js';

const unknownRefresh = () => `sinaloa_agent_refresh_${crypto.randomBytes(48).toString('base64url')}`;
const unknownAccess = () => `sinaloa_agent_access_${crypto.randomBytes(32).toString('base64url')}`;

test('refresh: missing or malformed rotationId is ROTATION_ID_REQUIRED, checked first, and does not consume the token', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3101');

  assertError(await refresh(baseUrl, agent.agentRefreshToken), 'ROTATION_ID_REQUIRED');
  assertError(await refresh(baseUrl, agent.agentRefreshToken, 'short'), 'ROTATION_ID_REQUIRED');
  assertError(await refresh(baseUrl, agent.agentRefreshToken, '-starts-with-dash-0001'), 'ROTATION_ID_REQUIRED');
  // Checked before the token is looked up: an unknown or malformed token gets the same code.
  assertError(await refresh(baseUrl, unknownRefresh()), 'ROTATION_ID_REQUIRED');
  assertError(await refresh(baseUrl, 'not-a-refresh-token'), 'ROTATION_ID_REQUIRED');

  assert.equal((await readData(server, ...refreshCredentialParts(agent.agentRefreshToken)))?.usedAt, null, 'token not consumed');
  const rotated = await refresh(baseUrl, agent.agentRefreshToken, newRotationId());
  assert.equal(rotated.status, 200, `the stored credential stays valid: ${rotated.text}`);
  assertSchema('tokenPair', rotated.payload);
});

test('refresh: unknown, malformed, self-expired and pre-A-1 used tokens are REFRESH_TOKEN_INVALID', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3201');

  const unknown = assertError(await refresh(baseUrl, unknownRefresh(), newRotationId()), 'REFRESH_TOKEN_INVALID');
  const malformed = assertError(await refresh(baseUrl, 'not-a-refresh-token', newRotationId()), 'REFRESH_TOKEN_INVALID');
  assert.equal(unknown.message, malformed.message, 'identical whether or not a similar token exists');
  assertError(await refresh(baseUrl, undefined, newRotationId()), 'REFRESH_TOKEN_INVALID');

  // Step 6: unused token past its own expiry while the family is valid.
  await editData(server, refreshCredentialParts(agent.agentRefreshToken), value => ({ ...value, expiresAt: PAST }));
  assertError(await refresh(baseUrl, agent.agentRefreshToken, newRotationId()), 'REFRESH_TOKEN_INVALID');
  assert.equal((await claim(baseUrl, agent.agentApiToken)).status, 200, 'family remains valid');

  // Step 5, first bullet: a used record written before A-1 (no stored rotationId hash),
  // after its recovery envelope was reaped.
  // Assumption: A-1 stores the consuming rotationId hash under a field whose name contains "rotation".
  const second = await owner(baseUrl, '3202');
  const rotationId = newRotationId();
  assert.equal((await refresh(baseUrl, second.agentRefreshToken, rotationId)).status, 200);
  await editData(server, refreshCredentialParts(second.agentRefreshToken), value => Object.fromEntries(Object.entries(value).filter(([key]) => !/rotation/i.test(key))));
  await deleteData(server, ...recoveryParts(second.agentRefreshToken));
  assertError(await refresh(baseUrl, second.agentRefreshToken, rotationId), 'REFRESH_TOKEN_INVALID');
});

test('refresh: the same token and rotationId return the identical successor', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3301');
  const rotationId = newRotationId();
  const first = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.equal(first.status, 200, first.text);
  assertSchema('tokenPair', first.payload);
  const second = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.payload, first.payload);
  const third = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.deepEqual(third.payload, first.payload);
  assert.equal((await claim(baseUrl, first.payload.agentApiToken)).status, 200);
});

test('refresh: a different rotationId on a used token is REFRESH_REPLAY and revokes the family (reason refresh_replay)', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3401');
  const rotationId = newRotationId();
  const successor = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.equal(successor.status, 200, successor.text);
  const stream = await openEventStream(server, agent.inbox.id, successor.payload.agentApiToken);
  assert.equal(stream.status, 200, stream.text);
  await stream.waitFor(item => item.event === 'ready', { message: 'ready' });

  assertError(await refresh(baseUrl, agent.agentRefreshToken, newRotationId()), 'REFRESH_REPLAY');

  const revoked = { reason: 'refresh_replay' };
  assertError(await claim(baseUrl, successor.payload.agentApiToken), 'CREDENTIAL_REVOKED', revoked);
  assertError(await agentStatus(baseUrl, successor.payload.agentApiToken), 'CREDENTIAL_REVOKED', revoked);
  assertError(await claim(baseUrl, agent.agentApiToken), 'CREDENTIAL_REVOKED', revoked);
  assertError(await refresh(baseUrl, successor.payload.agentRefreshToken, newRotationId()), 'CREDENTIAL_REVOKED', revoked);
  // §2.2: family revoked (step 3) is checked before the used-token branch (step 5).
  assertError(await refresh(baseUrl, agent.agentRefreshToken, rotationId), 'CREDENTIAL_REVOKED', revoked);

  const ended = await stream.waitFor(item => item.event === 'credential.ended', { message: 'credential.ended' });
  assert.equal(ended.id, undefined);
  assert.deepEqual(ended.data, { code: 'CREDENTIAL_REVOKED', reason: 'refresh_replay' });
  assert.equal(await stream.waitForEnd(), true);
  const audit = (await ownerEvents(baseUrl, agent)).find(event => event.type === 'agent.refresh_replay_detected');
  assert.ok(audit, 'replay is audited for the owner');
  assert.doesNotMatch(JSON.stringify(audit), /sinaloa_agent_(?:access|refresh)_/);
});

test('refresh: same rotationId after the recovery window or with an undecryptable envelope is REFRESH_RECOVERY_EXPIRED', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [one, two, three] = await Promise.all([owner(baseUrl, '3501'), owner(baseUrl, '3502'), owner(baseUrl, '3503')]);

  // (i) recovery record present but past its 5-minute window.
  const r1 = newRotationId();
  const s1 = await refresh(baseUrl, one.agentRefreshToken, r1);
  assert.equal(s1.status, 200, s1.text);
  await editData(server, recoveryParts(one.agentRefreshToken), value => ({ ...value, expiresAt: PAST }));
  assertError(await refresh(baseUrl, one.agentRefreshToken, r1), 'REFRESH_RECOVERY_EXPIRED');
  assert.equal((await claim(baseUrl, s1.payload.agentApiToken)).status, 200, 'recovery expiry does not revoke the family');

  // (ii) recovery record already reaped.
  const r2 = newRotationId();
  const s2 = await refresh(baseUrl, two.agentRefreshToken, r2);
  assert.equal(s2.status, 200, s2.text);
  assert.ok(await deleteData(server, ...recoveryParts(two.agentRefreshToken)), 'recovery record existed');
  assertError(await refresh(baseUrl, two.agentRefreshToken, r2), 'REFRESH_RECOVERY_EXPIRED');
  assert.equal((await claim(baseUrl, s2.payload.agentApiToken)).status, 200);

  // (iii) envelope cannot be decrypted (e.g. after a data-encryption key change).
  const r3 = newRotationId();
  const s3 = await refresh(baseUrl, three.agentRefreshToken, r3);
  assert.equal(s3.status, 200, s3.text);
  await editData(server, recoveryParts(three.agentRefreshToken), value => ({ ...value, encrypted: { ...value.encrypted, tag: Buffer.alloc(16).toString('base64') } }));
  assertError(await refresh(baseUrl, three.agentRefreshToken, r3), 'REFRESH_RECOVERY_EXPIRED');
});

test('owner revoke: refresh and access tokens get CREDENTIAL_REVOKED (reason revoked)', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3601');
  await revokeAgent(baseUrl, agent);
  assertError(await refresh(baseUrl, agent.agentRefreshToken, newRotationId()), 'CREDENTIAL_REVOKED', { reason: 'revoked' });
  assertError(await claim(baseUrl, agent.agentApiToken), 'CREDENTIAL_REVOKED', { reason: 'revoked' });
  const stream = await openEventStream(server, agent.inbox.id, agent.agentApiToken);
  assert.notEqual(stream.status, 200);
  assertError(stream, 'CREDENTIAL_REVOKED', { reason: 'revoked' });
});

test('access-route precedence: AUTHENTICATION_REQUIRED, revoked beats expired, expired family beats expired token', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob, carol] = await Promise.all([owner(baseUrl, '3701'), owner(baseUrl, '3702'), owner(baseUrl, '3703')]);

  const missing = assertError(await claim(baseUrl, undefined), 'AUTHENTICATION_REQUIRED');
  const unknown = assertError(await claim(baseUrl, unknownAccess()), 'AUTHENTICATION_REQUIRED');
  const garbage = assertError(await claim(baseUrl, 'garbage'), 'AUTHENTICATION_REQUIRED');
  assert.equal(unknown.message, garbage.message, 'identical whether or not a similar token exists');
  assert.equal(missing.message.length > 0, true);
  assertError(await agentStatus(baseUrl, undefined), 'AUTHENTICATION_REQUIRED');
  assertError(await api(baseUrl, '/mcp', { headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), 'AUTHENTICATION_REQUIRED');
  // A valid token for a different inbox than the route.
  assertError(await api(baseUrl, `/api/inboxes/${bob.inbox.id}/messages`, { token: alice.agentApiToken }), 'AUTHENTICATION_REQUIRED');
  const wrongInboxStream = await openEventStream(server, bob.inbox.id, alice.agentApiToken);
  assertError(wrongInboxStream, 'AUTHENTICATION_REQUIRED');

  // Revoked family with an also-expired access token: CREDENTIAL_REVOKED (2) beats ACCESS_TOKEN_EXPIRED (4).
  await expireAccessToken(server, alice.agentApiToken);
  assertError(await claim(baseUrl, alice.agentApiToken), 'ACCESS_TOKEN_EXPIRED');
  await revokeAgent(baseUrl, alice);
  assertError(await claim(baseUrl, alice.agentApiToken), 'CREDENTIAL_REVOKED', { reason: 'revoked' });
  assertError(await agentStatus(baseUrl, alice.agentApiToken), 'CREDENTIAL_REVOKED', { reason: 'revoked' });

  // Expired family with an also-expired access token: CREDENTIAL_EXPIRED (3) beats ACCESS_TOKEN_EXPIRED (4).
  await expireAccessToken(server, carol.agentApiToken);
  await expireFamily(server, carol.agentApiToken);
  assertError(await claim(baseUrl, carol.agentApiToken), 'CREDENTIAL_EXPIRED');
  assertError(await api(baseUrl, `/api/inboxes/${carol.inbox.id}/messages`, { token: carol.agentApiToken }), 'CREDENTIAL_EXPIRED');

  assert.ok(await readData(server, ...accessCredentialParts(bob.agentApiToken)), 'bob unaffected');
  assert.equal((await claim(baseUrl, bob.agentApiToken)).status, 200);
});

test('error envelope requestId echoes a valid x-request-id and replaces an invalid one', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const valid = 'req_A3-test.01:abc';
  const echoed = assertError(await claim(baseUrl, undefined, {}, { 'x-request-id': valid }), 'AUTHENTICATION_REQUIRED');
  assert.equal(echoed.requestId, valid);
  const maxLength = 'r'.repeat(128);
  assert.equal(assertError(await claim(baseUrl, undefined, {}, { 'x-request-id': maxLength }), 'AUTHENTICATION_REQUIRED').requestId, maxLength);

  for (const invalid of ['bad id with spaces', 'r'.repeat(129), 'semi;colon', '<script>']) {
    const body = assertError(await claim(baseUrl, undefined, {}, { 'x-request-id': invalid }), 'AUTHENTICATION_REQUIRED');
    assert.notEqual(body.requestId, invalid, `invalid x-request-id ${JSON.stringify(invalid)} must not be echoed`);
    assert.notEqual(body.requestId, invalid.slice(0, 128));
    assert.match(body.requestId, REQUEST_ID_PATTERN);
  }
  // Refresh errors use the same envelope.
  assert.equal(assertError(await api(baseUrl, '/api/agent-token', { headers: { 'x-request-id': valid }, body: { grantType: 'refresh_token', agentRefreshToken: unknownRefresh() } }), 'ROTATION_ID_REQUIRED').requestId, valid);
});

test('rate limit: 429 RATE_LIMITED with retry-after header matching retryAfterSeconds', async t => {
  // ratePolicy in src/server.js: non-GET routes allow 180 requests/minute per
  // identity (and per source IP), so ~181 claims trigger it in about a second.
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '3801');
  let limited = null;
  for (let index = 0; index < 400 && !limited; index += 1) {
    const res = await claim(baseUrl, agent.agentApiToken);
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 200, res.text);
  }
  assert.ok(limited, 'rate limit was reached');
  const body = assertError(limited, 'RATE_LIMITED');
  const header = limited.headers.get('retry-after');
  assert.match(String(header), /^\d+$/);
  assert.ok(Number(header) >= 1);
  assert.equal(body.retryAfterSeconds, Number(header));
});

test('too many concurrent event streams: 429 RATE_LIMITED with retry-after', async t => {
  const server = await launch({ ENVOI_MAX_SSE_PER_PRINCIPAL: '1' });
  t.after(() => server.stop());
  const agent = await owner(server.baseUrl, '3901');
  const first = await openEventStream(server, agent.inbox.id, agent.agentApiToken);
  assert.equal(first.status, 200, first.text);
  const second = await openEventStream(server, agent.inbox.id, agent.agentApiToken);
  const body = assertError(second, 'RATE_LIMITED');
  const header = second.headers.get('retry-after');
  assert.match(String(header), /^\d+$/, 'retry-after header is present');
  assert.equal(body.retryAfterSeconds, Number(header));
  first.close();
});
