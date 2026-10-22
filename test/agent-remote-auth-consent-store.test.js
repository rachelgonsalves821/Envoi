// agent-remote-auth v1 (approved revision 4) §5 consent, on agent-registration v1 revision 5 §14 storage (task RA-A1
// part 2). The registration module runs directly against a real store, FileStore and (in CI) PostgreSQL: the records a
// consent writes, retries derived from storage, one decision per handle, denials, cleanup and the rate limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { FileStore } from '../src/storage.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { createAgentSlots, registrationPath } from '../src/agent-approval.js';
import { createInstallationReader } from '../src/agent-installations.js';
import { cleanupCursorPath, consentDecisionPath, createAgentRegistrations, createdBucketPath, oauthCleanupCursorPath, oauthCleanupPath, oauthCodePath, sha256Hex } from '../src/agent-registration.js';
import { verificationCodeKey } from '../src/agent-registration-codes.js';
import { createPollLimiter, createRegistrationLimits } from '../src/agent-registration-limits.js';
import { permissionsForScopes, scopeForPermissions } from '../src/agent-remote-auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const registrationSchemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-registration', 'schemas.json'), 'utf8'));
const remoteSchemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-remote-auth', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(registrationSchemas);
ajv.addSchema(remoteSchemas);
const assertSchema = (contract, name, value) => {
  const validate = ajv.getSchema(`${contract.$id}#/definitions/${name}`);
  assert.ok(validate, `${name} exists`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
};

const hour = 3_600_000;
async function fileStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-consent-'));
  const store = new FileStore(dir);
  await store.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return Object.assign(store, { dataDir: dir });
}
async function postgresStore(t) {
  const store = new PostgresStore(process.env.DATABASE_URL);
  await store.init();
  t.after(() => store.close());
  await store.deleteJson(cleanupCursorPath);
  await store.deleteJson(oauthCleanupCursorPath);
  return store;
}
const stores = [['FileStore', fileStore], ...(process.env.DATABASE_URL ? [['PostgreSQL', postgresStore]] : [])];

function module(store) {
  return createAgentRegistrations({
    store, flags: { registration: true, installations: true, authenticatedRest: false }, codeKey: verificationCodeKey(Buffer.from('consent-test-key')),
    limits: createRegistrationLimits({ store }), pollLimiter: createPollLimiter(), agentSlots: createAgentSlots({ store }),
    installations: createInstallationReader({ store, agentCredentialFamilyPath: (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`) }),
    withInboxMutation: (inboxId, operation, related = [], keys = []) => store.withTransaction([`inbox:${inboxId}:mutations`, ...keys], () => operation(async () => ({}))),
    canManageLive: async () => true, normalizeLocalPart: value => value, addressForLocalPart: localPart => `${localPart}@envoi.mail`,
    identityTaken: async () => false, semanticDigest: value => sha256Hex(JSON.stringify(value)), log: () => {}
  });
}
const unique = () => crypto.randomBytes(6).toString('hex');
const human = () => ({ id: `human_${unique()}`, email: 'owner@example.com' });
async function workspace(store) {
  const id = `inbox_ws_${unique()}`;
  await store.putJson(path.join('inboxes', id, 'inbox.json'), { id, kind: 'workspace', status: 'active', organizationId: `org_${unique()}`, name: 'Example workspace' });
  return id;
}
// An opened authorization request handle, as the server's consent route builds it (agent-remote-auth §4.2).
function request(overrides = {}) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const scopes = overrides.scopes || ['envoi.agent', 'envoi.send'];
  return {
    clientId: 'client_desktop-example', connectionRoute: 'remote_mcp_oauth', redirectUri: 'http://127.0.0.1:53682/callback',
    codeChallenge: 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM', scopes, state: 'state-1', resource: 'https://www.envoi-agents.com/mcp', iat: exp - 600, exp,
    permissions: permissionsForScopes(scopes), scopeFor: scopeForPermissions, expiresAt: new Date(exp * 1000).toISOString(), ...overrides
  };
}
const approveBody = (workspaceInboxId, localPart = `agent-${unique()}`) => ({ target: { kind: 'new_agent', workspaceInboxId, name: 'Example agent', localPart }, grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default' });
const handleDigest = () => sha256Hex(`v1.${crypto.randomBytes(48).toString('base64url')}`);
const rejects = async (promise, code) => assert.rejects(promise, error => error.code === code, `expected ${code}`);

for (const [name, open] of stores) {
  test(`[${name}] first approval: the code once, hash-only records that match revision 5 §14.3-§14.4`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const digest = handleDigest();
    const body = approveBody(await workspace(store));
    const outcome = await registrations.approveConsent(owner, request(), digest, body);
    assert.match(outcome.code, /^envoi_oauth_code_[A-Za-z0-9_-]{43}$/);
    assertSchema(remoteSchemas, 'consentApproved', { redirectTo: 'http://127.0.0.1:53682/callback?code=x', ...outcome.approved });
    const registration = await store.getJson(registrationPath(outcome.approved.registrationId));
    assertSchema(registrationSchemas, 'storedOAuthRegistration', registration);
    assert.equal(registration.oauth.codeHash, sha256Hex(outcome.code), 'only the hash of the code');
    assert.deepEqual([registration.oauth.handleDigest, registration.oauth.scope, registration.status, registration.runtime], [digest, 'envoi.agent envoi.send', 'approved', { type: 'remote_mcp', version: null }]);
    assert.ok(!('tokenHash' in registration) && !('codeHmac' in registration), 'no bootstrap token and no verification code');
    const decision = await store.getJson(consentDecisionPath(digest));
    assertSchema(registrationSchemas, 'storedConsentDecision', decision);
    assert.deepEqual([decision.decision, decision.humanId, decision.registrationId], ['approved', owner.id, registration.id]);
    const code = await store.getJson(oauthCodePath(registration.oauth.codeHash));
    assertSchema(registrationSchemas, 'storedOAuthCode', code);
    assert.deepEqual([code.registrationId, code.expiresAt, code.usedAt, code.kind], [registration.id, registration.activationExpiresAt, null, 'authorization_code']);
    assert.equal(Date.parse(registration.activationExpiresAt) - Date.parse(registration.approvedAt), 60_000, 'the code lives 60 s');
    for (const key of [registration.oauth.codeHash, digest]) {
      const entry = await store.getJson(oauthCleanupPath(registration.createdAt, key));
      assertSchema(registrationSchemas, 'storedOAuthCleanupIndex', entry);
      assert.deepEqual([entry.registrationId, entry.deleteAfter], [registration.id, null], 'a parent-backed child has no deadline of its own');
    }
    assert.ok(await store.getJson(createdBucketPath(registration.createdAt, registration.id)), 'registration cleanup will reach it');
    if (store.dataDir) {
      // Nothing stored anywhere contains the code or a code-bearing redirect.
      const files = (await readdir(store.dataDir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
      for (const file of files) {
        const content = await readFile(path.join(file.parentPath || file.path, file.name), 'utf8');
        assert.ok(!content.includes(outcome.code) && !content.includes('code=envoi_oauth_code_') && !content.includes('redirectTo'), `${file.name} holds no code`);
      }
    }
  });

  test(`[${name}] retries are derived from storage: pending_exchange, completed, expired, withdrawn; never a second code`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const digest = handleDigest();
    const body = approveBody(await workspace(store));
    const first = await registrations.approveConsent(owner, request(), digest, body);
    const retry = await registrations.approveConsent(owner, request(), digest, body);
    assert.equal(retry.code, undefined, 'a retry never carries a code');
    assertSchema(remoteSchemas, 'consentDecided', retry.decided);
    assert.equal(retry.decided.status, 'pending_exchange');
    // Even with the handle no longer openable (expired), the decision is answered from storage.
    assert.equal((await registrations.approveConsent(owner, null, digest, body)).decided.status, 'pending_exchange');
    assert.equal((await registrations.consentViewDecision(owner, digest)).status, 'pending_exchange');
    const id = first.approved.registrationId;
    const edit = async change => store.putJson(registrationPath(id), { ...await store.getJson(registrationPath(id)), ...change });
    await edit({ status: 'activated', activatedAt: new Date().toISOString() });
    assert.equal((await registrations.approveConsent(owner, null, digest, body)).decided.status, 'completed');
    await edit({ status: 'approved', activationExpiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await registrations.approveConsent(owner, null, digest, body)).decided.status, 'expired');
    await edit({ status: 'withdrawn' });
    assert.equal((await registrations.approveConsent(owner, null, digest, body)).decided.status, 'withdrawn');
    // One registration per decided handle: nothing else was created for it.
    const decision = await store.getJson(consentDecisionPath(digest));
    assert.equal(decision.registrationId, id);
  });

  test(`[${name}] one decision per handle: other body, deny after approve, another human, an unopenable handle`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const other = human();
    const digest = handleDigest();
    const ws = await workspace(store);
    const body = approveBody(ws);
    await registrations.approveConsent(owner, request(), digest, body);
    await rejects(registrations.approveConsent(owner, request(), digest, { ...body, grantedPermissions: ['receive_agent_messages'] }), 'CLAIM_ALREADY_DECIDED');
    await rejects(registrations.denyConsent(owner, request(), digest), 'CLAIM_ALREADY_DECIDED');
    await rejects(registrations.approveConsent(other, request(), digest, body), 'AUTHORIZATION_REQUEST_INVALID');
    await rejects(registrations.denyConsent(other, request(), digest), 'AUTHORIZATION_REQUEST_INVALID');
    await rejects(registrations.consentViewDecision(other, digest), 'AUTHORIZATION_REQUEST_INVALID');
    await rejects(registrations.approveConsent(owner, null, handleDigest(), body), 'AUTHORIZATION_REQUEST_INVALID');
    await rejects(registrations.approveConsent(owner, request(), handleDigest(), { ...body, verificationCode: 'ABCD-EFGH' }), 'CLAIM_INVALID');
    await rejects(registrations.approveConsent(owner, request(), handleDigest(), { ...body, grantedPermissions: [] }), 'CLAIM_INVALID');
    // The held address: a second new_agent approval for it inside the window is ADDRESS_TAKEN.
    await rejects(registrations.approveConsent(human(), request(), handleDigest(), approveBody(ws, body.target.localPart)), 'ADDRESS_TAKEN');
  });

  test(`[${name}] concurrent approvals of one handle: exactly one registration and one code`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const digest = handleDigest();
    const body = approveBody(await workspace(store));
    const results = await Promise.allSettled([1, 2, 3].map(() => registrations.approveConsent(owner, request(), digest, body)));
    const codes = results.filter(result => result.status === 'fulfilled' && result.value.code);
    assert.equal(codes.length, 1, 'one approval issued the code');
    assert.ok(results.every(result => result.status === 'fulfilled'), 'the others are identical retries');
    assert.ok(results.filter(result => result.value.decided).every(result => result.value.decided.registrationId === codes[0].value.approved.registrationId), 'the same registration');
  });

  test(`[${name}] deny: only the decision record, repeatable, then it lapses with its handle`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const digest = handleDigest();
    const opened = request();
    assert.deepEqual(await registrations.denyConsent(owner, opened, digest), { denied: true });
    assert.deepEqual(await registrations.denyConsent(owner, null, digest), { denied: true }, 'the same human repeating it');
    await rejects(registrations.approveConsent(owner, opened, digest, approveBody(await workspace(store))), 'CLAIM_ALREADY_DECIDED');
    assert.deepEqual(await registrations.consentViewDecision(owner, digest), { status: 'denied' });
    const decision = await store.getJson(consentDecisionPath(digest));
    assertSchema(registrationSchemas, 'storedConsentDecision', decision);
    assert.deepEqual([decision.decision, decision.registrationId, decision.bodyDigest, decision.handleExpiresAt], ['denied', null, null, opened.expiresAt]);
    const entry = await store.getJson(oauthCleanupPath(decision.decidedAt, digest));
    assert.deepEqual([entry.registrationId, entry.deleteAfter], [null, opened.expiresAt], 'a denial has its own deadline, the handle expiry');
    // After the handle expires the denial is gone for every purpose, then the sweep deletes it.
    await store.putJson(consentDecisionPath(digest), { ...decision, handleExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await rejects(registrations.consentViewDecision(owner, digest), 'AUTHORIZATION_REQUEST_INVALID');
    await store.putJson(oauthCleanupPath(decision.decidedAt, digest), { ...entry, deleteAfter: new Date(Date.now() - 1000).toISOString() });
    await registrations.sweepOAuthCleanup(new Date());
    assert.equal(await store.getJson(consentDecisionPath(digest)), null, 'swept after its deadline');
    assert.equal(await store.getJson(oauthCleanupPath(decision.decidedAt, digest)), null);
  });

  test(`[${name}] retention: children live exactly as long as their registration, and orphans are swept`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    const digest = handleDigest();
    const body = approveBody(await workspace(store));
    const outcome = await registrations.approveConsent(owner, request(), digest, body);
    const registration = await store.getJson(registrationPath(outcome.approved.registrationId));
    const created = Date.parse(registration.createdAt);
    const present = async () => [
      Boolean(await store.getJson(registrationPath(registration.id))), Boolean(await store.getJson(oauthCodePath(registration.oauth.codeHash))),
      Boolean(await store.getJson(consentDecisionPath(digest))), Boolean(await store.getJson(oauthCleanupPath(registration.createdAt, digest)))
    ];
    // The index sweep never deletes a present registration's children, however old: 23 h, 24 h 30 min, 24 h 59 min.
    for (const offset of [23 * hour, 24.5 * hour, 25 * hour - 60_000]) {
      await registrations.sweepOAuthCleanup(new Date(created + offset));
      assert.deepEqual(await present(), [true, true, true, true], `kept at +${offset / hour} h while the registration exists`);
      assert.equal((await registrations.approveConsent(owner, null, digest, body)).decided?.registrationId, registration.id, 'a retry is still answered');
    }
    // No registration cleanup before 24 h.
    await registrations.cleanup(new Date(created + 23.5 * hour));
    assert.deepEqual(await present(), [true, true, true, true], 'nothing deleted before 24 h');
    // Registration cleanup deletes the registration and its children together.
    await registrations.cleanup(new Date(created + 25 * hour));
    assert.deepEqual(await present(), [false, false, false, false], 'deleted together by 25 h');
    assert.equal(await registrations.consentViewDecision(owner, digest), null, 'no decision left; the handle itself has long expired');
    // Orphans: a registration deleted elsewhere (an older server) leaves its children; the sweep deletes them.
    // (The sweeps above ran a day ahead of real time and left the cursor there; real time never runs behind it.)
    await store.deleteJson(oauthCleanupCursorPath);
    const orphanDigest = handleDigest();
    const orphan = await registrations.approveConsent(owner, request(), orphanDigest, approveBody(await workspace(store)));
    const orphanRegistration = await store.getJson(registrationPath(orphan.approved.registrationId));
    await store.deleteJson(registrationPath(orphanRegistration.id));
    await rejects(registrations.consentViewDecision(owner, orphanDigest), 'AUTHORIZATION_REQUEST_INVALID');
    await registrations.sweepOAuthCleanup(new Date(Date.parse(orphanRegistration.createdAt) + hour));
    assert.equal(await store.getJson(oauthCodePath(orphanRegistration.oauth.codeHash)), null, 'orphan code index swept');
    assert.equal(await store.getJson(consentDecisionPath(orphanDigest)), null, 'orphan decision swept');
  });

  test(`[${name}] consent approvals are rate limited per human: 10 per hour`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const owner = human();
    for (let attempt = 0; attempt < 10; attempt += 1) await rejects(registrations.approveConsent(owner, null, handleDigest(), {}), 'AUTHORIZATION_REQUEST_INVALID');
    await assert.rejects(registrations.approveConsent(owner, null, handleDigest(), {}), error => error.code === 'RATE_LIMITED' && error.publicFields?.retryAfterSeconds > 0);
    await rejects(registrations.approveConsent(human(), null, handleDigest(), {}), 'AUTHORIZATION_REQUEST_INVALID');
  });
}
