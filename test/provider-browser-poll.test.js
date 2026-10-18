import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/storage.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { createProviderBrowserPoll, gatewayLimits } from '../src/provider-browser-poll.js';
import { browserPollAvailable, readOnboardingFlags, routeAvailability } from '../src/onboarding-flags.js';

const backends = ['FileStore', ...(process.env.DATABASE_URL ? ['PostgreSQL'] : [])];
const code = expected => error => error.code === expected;
for (const backend of backends) {
  async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-gateway-'));
    const store = backend === 'FileStore' ? new FileStore(root) : new PostgresStore(process.env.DATABASE_URL);
    await store.init();
    const prefix = crypto.randomUUID();
    const scopedStore = backend === 'FileStore' ? store : { now: () => store.now(), getJson: (p,...a) => store.getJson(path.join('gateway-tests',prefix,p),...a), putJson: (p,v) => store.putJson(path.join('gateway-tests',prefix,p),v), deleteJson: p => store.deleteJson(path.join('gateway-tests',prefix,p)), listJson: p => store.listJson(path.join('gateway-tests',prefix,p)), withTransaction: (keys,fn) => store.withTransaction(keys.map(k=>`${prefix}:${k}`),fn) };
    t.after(async () => { if (backend === 'PostgreSQL') await store.close(); await rm(root, { recursive: true, force: true }); });
    let clock = Date.now(), enabled = true, paused = false, revoked = false, creates = 0, activations = 0, uncertain = false;
    const rows = [{ id: 'message1', sequence: 1, caseId: 'case1', senderAddress: 'peer@envoi.mail', summary: 'Please reply' }, { id: 'message2', sequence: 2, caseId: 'case2', senderAddress: 'peer2@envoi.mail', summary: 'Other work' }];
    const key = crypto.randomBytes(32), adapter = {
      lockKeys: b => [`inbox:${b.installationId}`],
      createRegistration: async () => { creates++; if (uncertain) throw new Error('lost registration response'); return { registrationId: 'registration_1', bootstrapToken: 'envoi_reg_PRIVATE', claim: { url: 'https://envoi.example/claim', verificationCode: 'ABCD-EFGH' } }; },
      registrationStatus: async () => ({ state: 'approved' }), confirmOwner: async (_r, who) => { if (who !== 'owner') throw Object.assign(new Error(), { code: 'GATEWAY_SCOPE_DENIED' }); return { humanId: 'human1' }; },
      activate: async () => { activations++; return { installationId: 'installation1', generation: 'gen1', credentials: { access: 'envoi_agent_access_PRIVATE' } }; },
      authorize: async () => { if (revoked) throw Object.assign(new Error(), { code: 'CREDENTIAL_REVOKED' }); return { address: 'agent@envoi.mail', paused }; },
      highWater: async () => Math.max(...rows.map(r => r.sequence),0), pending: async (_b, { after, high }) => rows.filter(r => r.sequence > after && r.sequence <= high)
    };
    const make = () => createProviderBrowserPoll({ store: scopedStore, key, adapter, enabled: () => enabled, now: () => clock });
    let gateway = make();
    const setup = await gateway.setup();
    const begin = () => gateway.begin(setup.secret, setup.csrf, { requestedName: 'Agent', requestedPermissions: ['receive_agent_messages'], runtime: { type: 'muse', version: null } }, {});
    const connect = async () => { const pairing = await begin(); await gateway.confirm({ verificationCode: pairing.verificationCode, comparisonPhrase: pairing.comparisonPhrase }, 'owner'); return gateway.activate(setup.secret, setup.csrf, { operationId: setup.operationId }); };
    return { root, setup, begin, connect, rows, get gateway() { return gateway; }, restart() { gateway = make(); }, advance(ms) { clock += ms; },
      disable() { enabled = false; }, pause() { paused = true; }, resume() { paused = false; }, revoke() { revoked = true; }, uncertain() { uncertain = true; }, counts() { return { creates, activations }; } };
  }
  test(`[${backend}] pending setup cannot read or activate; owner comparison is mandatory; recover lost cookie without second installation`, async t => {
    const f = await fixture(t), p = await f.begin();
    await assert.rejects(f.gateway.session(f.setup.secret), code('GATEWAY_SESSION_REQUIRED'));
    await assert.rejects(f.gateway.activate(f.setup.secret, f.setup.csrf, { operationId: f.setup.operationId }), code('GATEWAY_PAIRING_STATE'));
    await assert.rejects(f.gateway.confirm({ verificationCode: p.verificationCode, comparisonPhrase: 'wrong' }, 'owner'), code('GATEWAY_PAIRING_STATE'));
    await assert.rejects(f.gateway.confirm({ verificationCode: p.verificationCode, comparisonPhrase: p.comparisonPhrase }, 'not-owner'), code('GATEWAY_SCOPE_DENIED'));
    await f.gateway.confirm({ verificationCode: p.verificationCode, comparisonPhrase: p.comparisonPhrase }, 'owner');
    const first = await f.gateway.activate(f.setup.secret, f.setup.csrf, { operationId: f.setup.operationId });
    f.restart();
    const repeat = await f.gateway.activate(f.setup.secret, f.setup.csrf, { operationId: f.setup.operationId });
    assert.equal(first.secret, repeat.secret); assert.deepEqual(f.counts(), { creates: 1, activations: 1 });
    assert.doesNotMatch(JSON.stringify(first), /envoi_(reg|agent_access)_PRIVATE/);
    f.advance(gatewayLimits.recovery + 1);
    await f.gateway.cleanup();
    await assert.rejects(f.gateway.activate(f.setup.secret, f.setup.csrf, { operationId: f.setup.operationId }), code('GATEWAY_RECOVERY_REQUIRED'));
  });
  test(`[${backend}] notification acknowledgement rechecks eligibility and session end is idempotent`, async t => {
    const f = await fixture(t), s = await f.connect();
    const checked = await f.gateway.check(s.secret, s.csrf, { runId:'r' });
    f.rows.splice(0,1);
    await assert.rejects(f.gateway.acknowledge(s.secret, s.csrf, { runId:'r', notificationRefs:[checked.items[0].notificationRef] }), code('GATEWAY_SCOPE_DENIED'));
    assert.equal((await f.gateway.end(s.secret, s.csrf, {})).state, 'ended');
    assert.equal((await f.gateway.end(s.secret, s.csrf, {})).state, 'ended');
    await assert.rejects(f.gateway.session(s.secret), code('GATEWAY_SESSION_REQUIRED'));
  });
  test(`[${backend}] uncertain non-idempotent registration never automatically retries after restart`, async t => {
    const f = await fixture(t); f.uncertain(); await assert.rejects(f.begin()); f.restart();
    await assert.rejects(f.begin(), code('GATEWAY_RECOVERY_REQUIRED')); assert.equal(f.counts().creates, 1);
  });
  test(`[${backend}] pagination freezes high water; check is not ack; atomic ack survives restart and rejects forged refs`, async t => {
    const f = await fixture(t), s = await f.connect();
    const first = await f.gateway.check(s.secret, s.csrf, { runId: 'run1', limit: 1 }); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    f.rows.push({ id: 'later', caseId: 'case3', sequence: 3, summary: 'New during snapshot' });
    const second = await f.gateway.check(s.secret, s.csrf, { runId: 'run1', cursor: first.nextCursor }); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
    await assert.rejects(f.gateway.acknowledge(s.secret, s.csrf, { runId: 'run1', notificationRefs: [first.items[0].notificationRef, 'forged'] }), code('GATEWAY_CURSOR_INVALID'));
    f.advance(121_000); f.restart();
    const repeat = await f.gateway.check(s.secret, s.csrf, { runId: 'run2' }); assert.equal(repeat.items.length, 3, 'failed ack batch did not partially record presentation');
    await f.gateway.acknowledge(s.secret, s.csrf, { runId: 'run2', notificationRefs: repeat.items.map(i => i.notificationRef) });
    f.advance(121_000); f.restart();
    assert.equal((await f.gateway.check(s.secret, s.csrf, { runId: 'run3' })).items.length, 0);
    assert.equal(f.rows.length, 3, 'canonical work remains present');
  });
  test(`[${backend}] csrf, overlap, pause/revoke, idle and absolute expiry fail closed`, async t => {
    const f = await fixture(t), s = await f.connect();
    await assert.rejects(f.gateway.check(s.secret, undefined, { runId: 'run1' }), code('GATEWAY_CSRF_INVALID'));
    await assert.rejects(f.gateway.check(s.secret, 'wrong', { runId: 'run1' }), code('GATEWAY_CSRF_INVALID'));
    const checked = await f.gateway.check(s.secret, s.csrf, { runId: 'run1' });
    await assert.rejects(f.gateway.check(s.secret, s.csrf, { runId: 'overlap' }), code('GATEWAY_CHECK_ACTIVE'));
    f.pause(); await assert.rejects(f.gateway.check(s.secret, s.csrf, { runId: 'run1' }), code('AGENT_PAUSED'));
    await assert.rejects(f.gateway.acknowledge(s.secret, s.csrf, { runId: 'run1', notificationRefs: [checked.items[0].notificationRef] }), code('AGENT_PAUSED'));
    assert.equal((await f.gateway.session(s.secret)).state, 'paused');
    f.resume(); f.revoke(); await assert.rejects(f.gateway.session(s.secret), code('CREDENTIAL_REVOKED'));
    const g = await fixture(t), other = await g.connect(); g.advance(gatewayLimits.idle);
    await assert.rejects(g.gateway.session(other.secret), code('GATEWAY_SESSION_EXPIRED'));
    const h = await fixture(t), active = await h.connect();
    for (let i = 0; i < 6; i++) { h.advance(23 * 3_600_000); await h.gateway.renew(active.secret, active.csrf, {}); }
    h.advance(31 * 3_600_000); await assert.rejects(h.gateway.renew(active.secret, active.csrf, {}), code('GATEWAY_SESSION_EXPIRED'));
  });
  test(`[${backend}] scope closed schema, untrusted content, overdue boundary and disabled gateway`, async t => {
    const f = await fixture(t), s = await f.connect();
    assert.equal((await f.gateway.session(s.secret)).polling.checkState, 'not_yet_checked');
    f.rows[0].summary = `envoi_agent_access_PRIVATE ${'😀'.repeat(9000)}`;
    const check = await f.gateway.check(s.secret, s.csrf, { runId: 'test' }); assert.equal(check.items[0].truncated, true); assert.doesNotMatch(check.items[0].summary, /envoi_agent_access_/);
    await assert.rejects(f.gateway.check(s.secret, s.csrf, { runId: 'test', agentId: 'other' }), code('GATEWAY_REQUEST_INVALID'));
    f.advance((1800 + 360) * 1000); assert.equal((await f.gateway.session(s.secret)).polling.checkState, 'scheduled');
    f.advance(1); assert.equal((await f.gateway.session(s.secret)).polling.checkState, 'overdue');
    f.disable(); await assert.rejects(f.gateway.session(s.secret), code('FEATURE_DISABLED'));
    if (backend === 'FileStore') {
      const files = await readdir(path.join(f.root, 'auth', 'provider-browser-poll'));
      const raw = (await Promise.all(files.map(name => readFile(path.join(f.root, 'auth', 'provider-browser-poll', name), 'utf8')))).join('');
      assert.doesNotMatch(raw, /envoi_agent_access_PRIVATE|envoi_reg_PRIVATE|Please reply/);
    }
  });
}

test('new flag validates dependencies and preserves the unversioned v1 route contract', () => {
  assert.throws(() => readOnboardingFlags({ ENVOI_PROVIDER_BROWSER_POLL: 'true' }));
  const flags = readOnboardingFlags({ ENVOI_PROVIDER_BROWSER_POLL: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_AUTHENTICATED_REST_ROUTE: 'true' });
  assert.equal(browserPollAvailable(flags), true);
  assert.equal(routeAvailability(flags).deliveryModes.find(v => v.deliveryMode === 'poll').available, false);
});
