// agent-registration v1 review follow-ups (after A-4.4): the §4 approverEmailHint is never
// misstated (a fixed development hint only for an email-less human outside production; otherwise
// approve is refused before anything is written), and the registration's sourceHash is keyed.
// The module runs directly against a real FileStore, as in agent-registration-cleanup.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { createAgentSlots, registrationPath } from '../src/agent-approval.js';
import { createInstallationReader } from '../src/agent-installations.js';
import { addressHoldPath, createAgentRegistrations, hintForHuman, statusView } from '../src/agent-registration.js';
import { hashToken, sourceHmac, sourceKey, verificationCodeKey } from '../src/agent-registration-codes.js';
import { createPollLimiter, createRegistrationLimits } from '../src/agent-registration-limits.js';

const codeKey = verificationCodeKey(Buffer.from('followups-test-key'));
const hintPattern = /^[^@\s*]\*\*\*@[a-z0-9.-]+\.[a-z]{2,}$/; // definitions.approverEmailHint
const body = () => ({
  requestedName: 'Follow-up agent', requestedPermissions: ['send_agent_messages', 'receive_agent_messages'], connectionRoute: 'local_helper',
  runtime: { type: 'hermes', version: null }, deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false }
});

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-followups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const limits = createRegistrationLimits({ store });
  const registrations = createAgentRegistrations({
    store, flags: { registration: true, installations: true, authenticatedRest: false }, codeKey,
    limits, pollLimiter: createPollLimiter(), agentSlots: createAgentSlots({ store }),
    installations: createInstallationReader({ store, agentCredentialFamilyPath: (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`) }),
    withInboxMutation: (inboxId, operation, related = [], keys = []) => store.withTransaction([`inbox:${inboxId}:mutations`, ...keys], () => operation(async () => ({}))),
    canManageLive: async () => true, normalizeLocalPart: value => value, addressForLocalPart: localPart => `${localPart}@envoi.mail`,
    identityTaken: async () => false, semanticDigest: value => JSON.stringify(value), log: () => {}, ...options
  });
  const inboxId = `inbox_${crypto.randomBytes(6).toString('hex')}`;
  await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), { id: inboxId, kind: 'workspace', organizationId: 'org_followups', name: 'Follow-up workspace', status: 'active' });
  return { store, root, limits, registrations, inboxId };
}

const ip = () => `2001:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}::1`;
const humanWith = email => ({ id: `human_${crypto.randomBytes(6).toString('hex')}`, ...(email === undefined ? {} : { email }) });
const approveInput = (code, inboxId, localPart) => ({ verificationCode: code, target: { kind: 'new_agent', workspaceInboxId: inboxId, name: 'Follow-up agent', localPart }, grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default' });

async function pending(env) {
  const address = ip();
  const response = await env.registrations.create(body(), { ip: address, claimUrl: 'https://envoi.test/claim' });
  return { response, address, registration: await env.store.getJson(registrationPath(response.registrationId)) };
}
async function files(root) {
  return (await readdir(root, { recursive: true })).filter(file => file.endsWith('.json')).sort();
}

test('hintForHuman: masked email, fixed development hint only without an email outside production', () => {
  assert.equal(hintForHuman({ email: 'Owner.Name@Example.COM' }), 'o***@example.com');
  assert.equal(hintForHuman({ email: 'Owner.Name@Example.COM' }, { production: true }), 'o***@example.com');
  assert.equal(hintForHuman({ phone: '+15555550100' }), 'd***@development.invalid');
  assert.equal(hintForHuman({ email: '' }), 'd***@development.invalid');
  assert.equal(hintForHuman(null), 'd***@development.invalid');
  assert.equal(hintForHuman({ phone: '+15555550100' }, { production: true }), null, 'production never gets the development hint');
  // An email exists but cannot be expressed in the schema pattern: never replaced by another hint.
  assert.equal(hintForHuman({ email: 'owner@example.xn--p1ai' }), null);
  assert.equal(hintForHuman({ email: 'owner@example.xn--p1ai' }, { production: true }), null);
  assert.equal(hintForHuman({ email: '*owner@example.com' }), null);
  for (const hint of ['o***@example.com', 'd***@development.invalid']) assert.match(hint, hintPattern);
});

test('[FileStore] production: an approver whose email cannot be hinted is refused, and nothing is written', async t => {
  const env = await setup(t, { production: true });
  const human = humanWith('owner@example.xn--p1ai');
  const { response, registration } = await pending(env);
  const before = await files(env.root);
  const code = response.claim.verificationCode;
  // More refusals than the claim-failure limit: a refusal is not a claim failure.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await assert.rejects(env.registrations.approve(human, registration.id, approveInput(code, env.inboxId, 'followup')), error => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'CLAIM_FORBIDDEN');
      assert.doesNotMatch(error.message, /xn--|owner@/, 'the message names no email');
      return true;
    });
  }
  assert.deepEqual(await env.store.getJson(registrationPath(registration.id)), registration, 'the registration is unchanged');
  assert.equal(statusView(registration).status, 'pending_claim');
  assert.equal(await env.store.getJson(addressHoldPath('followup@envoi.mail')), null, 'no address hold');
  const after = await files(env.root);
  assert.deepEqual(after.filter(file => !file.startsWith(path.join('rate-limits', 'agent-claims'))), before, 'no registration, index, hold or audit document');
  assert.equal(await env.limits.claimLockRetryAfter(human.id), 0, 'no claim failure counted');

  // A production human with no email at all is refused the same way.
  await assert.rejects(env.registrations.approve(humanWith(undefined), registration.id, approveInput(code, env.inboxId, 'followup')), { statusCode: 403, code: 'CLAIM_FORBIDDEN' });
  // The code and state checks come first, so the refusal is no oracle: a wrong code is still CLAIM_CODE_INVALID.
  await assert.rejects(env.registrations.approve(human, registration.id, approveInput('0000-0000', env.inboxId, 'followup')), { statusCode: 404, code: 'CLAIM_CODE_INVALID' });

  // A hintable approver can still approve the same registration.
  const approved = await env.registrations.approve(humanWith('Owner@Example.com'), registration.id, approveInput(code, env.inboxId, 'followup'));
  assert.equal(approved.status, 'approved');
  assert.equal((await env.store.getJson(registrationPath(registration.id))).approverEmailHint, 'o***@example.com');
});

test('[FileStore] development: a human with no email gets the fixed hint; an unhintable email is still refused', async t => {
  const env = await setup(t, { production: false });
  const first = await pending(env);
  await env.registrations.approve(humanWith(undefined), first.registration.id, approveInput(first.response.claim.verificationCode, env.inboxId, 'nomail'));
  const stored = await env.store.getJson(registrationPath(first.registration.id));
  assert.equal(stored.approverEmailHint, 'd***@development.invalid');
  assert.equal(statusView(stored).approverEmailHint, 'd***@development.invalid');

  const second = await pending(env);
  await assert.rejects(env.registrations.approve(humanWith('owner@example.xn--p1ai'), second.registration.id, approveInput(second.response.claim.verificationCode, env.inboxId, 'punycode')), { statusCode: 403, code: 'CLAIM_FORBIDDEN' });
  assert.deepEqual(await env.store.getJson(registrationPath(second.registration.id)), second.registration);
});

test('[FileStore] a WorkOS-like verified email gets the masked hint', async t => {
  const env = await setup(t, { production: true });
  const { response, registration } = await pending(env);
  await env.registrations.approve(humanWith('Jane.Doe@Mail.Example.org'), registration.id, approveInput(response.claim.verificationCode, env.inboxId, 'workos'));
  const stored = await env.store.getJson(registrationPath(registration.id));
  assert.equal(stored.approverEmailHint, 'j***@mail.example.org');
  assert.match(statusView(stored).approverEmailHint, hintPattern);
});

test('[FileStore] production defaults from ENVOI_AUTH_MODE when the factory is not told', async t => {
  const previous = process.env.ENVOI_AUTH_MODE;
  t.after(() => { if (previous === undefined) delete process.env.ENVOI_AUTH_MODE; else process.env.ENVOI_AUTH_MODE = previous; });
  process.env.ENVOI_AUTH_MODE = 'production';
  const production = await setup(t);
  const one = await pending(production);
  await assert.rejects(production.registrations.approve(humanWith(undefined), one.registration.id, approveInput(one.response.claim.verificationCode, production.inboxId, 'prodmode')), { statusCode: 403, code: 'CLAIM_FORBIDDEN' });
  process.env.ENVOI_AUTH_MODE = 'development';
  const development = await setup(t);
  const two = await pending(development);
  const approved = await development.registrations.approve(humanWith(undefined), two.registration.id, approveInput(two.response.claim.verificationCode, development.inboxId, 'devmode'));
  assert.equal(approved.status, 'approved');
});

test('[FileStore] the stored sourceHash is keyed, not a plain SHA-256 of the address', async t => {
  const env = await setup(t);
  const { address, registration } = await pending(env);
  assert.notEqual(registration.sourceHash, hashToken(`agent-registration-source:${address}`).slice(0, 32));
  assert.equal(registration.sourceHash, sourceHmac(address, sourceKey(codeKey)).slice(0, 32));
  assert.notEqual(sourceHmac(address, sourceKey(verificationCodeKey(Buffer.from('another-key')))).slice(0, 32), registration.sourceHash);
});
