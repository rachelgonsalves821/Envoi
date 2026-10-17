// agent-registration v1 §2 cleanup and §9 holds (task A-4.3): every registration record and
// what it indexes is kept at least 24 h after creation and deleted by 25 h, whatever its state;
// a hold or code index goes only if it still names the registration; recovery envelopes go when
// their 300 s window ends. The module runs directly against a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { approvalSlotIndexPath, approverIndexPath, createAgentSlots, registrationPath } from '../src/agent-approval.js';
import { createInstallationReader } from '../src/agent-installations.js';
import { activationRecoveryPath, addressHoldPath, codeIndexPath, createAgentRegistrations, createdBucketPath, decidedBucketPath, tokenIndexPath } from '../src/agent-registration.js';
import { hashToken, normalizeVerificationCode, verificationCodeHmac, verificationCodeKey } from '../src/agent-registration-codes.js';
import { createPollLimiter, createRegistrationLimits } from '../src/agent-registration-limits.js';

const hour = 3_600_000;
const codeKey = verificationCodeKey(Buffer.from('cleanup-test-key'));
const body = () => ({
  requestedName: 'Cleanup agent', requestedPermissions: ['send_agent_messages', 'receive_agent_messages'], connectionRoute: 'local_helper',
  runtime: { type: 'hermes', version: null }, deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false }
});

async function fileStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-cleanup-'));
  const store = new FileStore(dir);
  await store.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return store;
}
async function postgresStore(t) {
  const store = new PostgresStore(process.env.DATABASE_URL);
  await store.init();
  t.after(() => store.close());
  return store;
}
const stores = [['FileStore', fileStore], ...(process.env.DATABASE_URL ? [['PostgreSQL', postgresStore]] : [])];

function module(store) {
  return createAgentRegistrations({
    store, flags: { registration: true, installations: true, authenticatedRest: false }, codeKey,
    limits: createRegistrationLimits({ store }), pollLimiter: createPollLimiter(),
    agentSlots: createAgentSlots({ store }),
    installations: createInstallationReader({ store, agentCredentialFamilyPath: (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`) }),
    withInboxMutation: (inboxId, operation, related = [], keys = []) => store.withTransaction([`inbox:${inboxId}:mutations`, ...keys], () => operation(async () => ({}))),
    canManageLive: async () => true, normalizeLocalPart: value => value, addressForLocalPart: localPart => `${localPart}@envoi.mail`,
    identityTaken: async () => false, semanticDigest: value => JSON.stringify(value), log: () => {}
  });
}
const ip = () => `2001:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}::1`;
const human = () => ({ id: `human_${crypto.randomBytes(6).toString('hex')}`, email: 'owner@example.com' });

async function created(store, registrations) {
  const response = await registrations.create(body(), { ip: ip(), claimUrl: 'https://envoi.test/claim' });
  const registration = await store.getJson(registrationPath(response.registrationId));
  return { response, registration, createdAt: new Date(registration.createdAt) };
}
async function workspace(store) {
  const id = `inbox_${crypto.randomBytes(6).toString('hex')}`;
  await store.putJson(path.join('inboxes', id, 'inbox.json'), { id, kind: 'workspace', organizationId: 'org_cleanup', name: 'Cleanup workspace', status: 'active' });
  return id;
}
const after = (date, ms) => new Date(date.getTime() + ms);

for (const [name, open] of stores) {
  test(`[${name}] a pending registration is kept 24 h and gone by 25 h, with its indexes`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const { response, registration, createdAt } = await created(store, registrations);
    const paths = [registrationPath(registration.id), tokenIndexPath(registration.tokenHash), codeIndexPath(registration.codeHmac), createdBucketPath(registration.createdAt, registration.id)];
    await registrations.cleanup(after(createdAt, 23 * hour));
    await registrations.cleanup(after(createdAt, 24 * hour - 1000));
    for (const item of paths) assert.ok(await store.getJson(item), `kept before 24 h: ${item}`);
    // The cursor from the earlier runs must not make this run skip the bucket.
    const deleted = await registrations.cleanup(after(createdAt, 24 * hour + 60_000));
    assert.ok(deleted >= 1);
    for (const item of paths) assert.equal(await store.getJson(item), null, `deleted by 25 h: ${item}`);
    assert.equal(normalizeVerificationCode(response.claim.verificationCode).length, 8);
  });

  test(`[${name}] an approval's hold and indexes go too, but a hold or code another registration took is kept`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const inboxId = await workspace(store);
    const approver = human();
    const localPart = `c${crypto.randomBytes(4).toString('hex')}`;
    const { response, registration, createdAt } = await created(store, registrations);
    await registrations.approve(approver, registration.id, { verificationCode: response.claim.verificationCode, target: { kind: 'new_agent', workspaceInboxId: inboxId, name: 'Cleanup agent', localPart }, grantedPermissions: ['receive_agent_messages'], policyProfile: 'default' });
    const address = `${localPart}@envoi.mail`;
    const indexPaths = [approvalSlotIndexPath(approver.id, registration.id), approverIndexPath(approver.id, registration.id), decidedBucketPath(registration.createdAt, registration.id), addressHoldPath(address)];
    for (const item of indexPaths) assert.ok(await store.getJson(item), `written at approval: ${item}`);
    await registrations.cleanup(after(createdAt, 24 * hour + 60_000));
    for (const item of indexPaths) assert.equal(await store.getJson(item), null, `deleted with the registration: ${item}`);

    // A second approval whose hold and code index were taken over by a later registration.
    const second = await created(store, registrations);
    const otherLocalPart = `d${crypto.randomBytes(4).toString('hex')}`;
    await registrations.approve(approver, second.registration.id, { verificationCode: second.response.claim.verificationCode, target: { kind: 'new_agent', workspaceInboxId: inboxId, name: 'Cleanup agent', localPart: otherLocalPart }, grantedPermissions: ['receive_agent_messages'], policyProfile: 'default' });
    const taken = { registrationId: 'registration_later', expiresAt: after(second.createdAt, 30 * hour).toISOString() };
    await store.putJson(addressHoldPath(`${otherLocalPart}@envoi.mail`), taken);
    await store.putJson(codeIndexPath(second.registration.codeHmac), { registrationId: 'registration_later' });
    await registrations.cleanup(after(second.createdAt, 24 * hour + 60_000));
    assert.equal(await store.getJson(registrationPath(second.registration.id)), null);
    assert.deepEqual(await store.getJson(addressHoldPath(`${otherLocalPart}@envoi.mail`)), taken, 'a hold naming another registration stays');
    assert.deepEqual(await store.getJson(codeIndexPath(second.registration.codeHmac)), { registrationId: 'registration_later' }, 'a code index naming another registration stays');
    assert.equal(second.registration.codeHmac, verificationCodeHmac(normalizeVerificationCode(second.response.claim.verificationCode), codeKey));
  });

  test(`[${name}] recovery envelopes go when their window ends`, async t => {
    const store = await open(t);
    const registrations = module(store);
    const now = new Date();
    const expired = hashToken(`envoi_reg_${crypto.randomBytes(32).toString('base64url')}`);
    const live = hashToken(`envoi_reg_${crypto.randomBytes(32).toString('base64url')}`);
    await store.putJson(activationRecoveryPath(expired), { tokenHash: expired, registrationId: 'registration_x', activationIdHash: 'h', expiresAt: new Date(now.getTime() - 1000).toISOString(), encrypted: {} });
    await store.putJson(activationRecoveryPath(live), { tokenHash: live, registrationId: 'registration_y', activationIdHash: 'h', expiresAt: new Date(now.getTime() + 300_000).toISOString(), encrypted: {} });
    await registrations.cleanup(now);
    assert.equal(await store.getJson(activationRecoveryPath(expired)), null);
    assert.ok(await store.getJson(activationRecoveryPath(live)));
  });
}

// Each case gets its own store: a clock run ahead in one case would put its cursor past
// registrations the next case creates at the real time, which a monotonic clock never does.
test('[FileStore] downtime never skips a bucket', async t => {
  const store = await fileStore(t);
  const registrations = module(store);
  const first = await created(store, registrations);
  // The first-ever run comes 30 h later.
  assert.equal(await registrations.cleanup(after(first.createdAt, 30 * hour)), 1);
  assert.equal(await store.getJson(registrationPath(first.registration.id)), null);
});

test('[FileStore] a cursor from an early run does not skip a bucket after long downtime', async t => {
  const store = await fileStore(t);
  const registrations = module(store);
  // A cursor from a run at +1 h, then nothing until +40 h.
  const second = await created(store, registrations);
  await registrations.cleanup(after(second.createdAt, hour));
  assert.ok(await store.getJson(registrationPath(second.registration.id)));
  assert.equal(await registrations.cleanup(after(second.createdAt, 40 * hour)), 1);
  assert.equal(await store.getJson(registrationPath(second.registration.id)), null);
});
