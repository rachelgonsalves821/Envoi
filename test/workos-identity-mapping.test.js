import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { WorkOSAuthService } from '../src/workos-auth.js';
import { databaseTargetFingerprint } from '../src/consumer-identity.js';
import { prepareWorkosIdentityMapping, validateWorkosIdentityMapping, executeWorkosIdentityMapping, mappingDigest } from '../scripts/workos-identity-mapping.mjs';

function fixture(connectionString = 'postgresql://test:test@127.0.0.1:5432/mapping_test') {
  const documents = []; const users = []; const organizations = [];
  for (const name of ['one', 'two']) {
    const humanId = `human_${name}`; const orgId = `org_local_${name}`;
    users.push({ localHumanId: humanId, from: `user_old_${name}`, to: `user_new_${name}` });
    organizations.push({ localOrganizationId: orgId, ownerHumanId: humanId, from: `org_old_${name}`, to: `org_new_${name}` });
    documents.push(
      { path: `humans/${humanId}.json`, value: { id: humanId, authProvider: 'workos', workosUserId: `user_old_${name}`, email: `${name}@example.com`, emailVerified: true, verifiedAt: '2026-01-01', displayName: name, createdAt: '2026-01-01', updatedAt: '2026-01-02' } },
      { path: `auth/workos-user-index/user_old_${name}.json`, value: { humanId } },
      { path: `organizations/${orgId}/organization.json`, value: { id: orgId, ownerHumanId: humanId, workosOrganizationId: `org_old_${name}`, status: 'active', name, slug: name, createdAt: '2026-01-01' } },
      { path: `auth/workos-organization-index/org_old_${name}.json`, value: { organizationId: orgId } },
      { path: `organizations/${orgId}/members/${humanId}.json`, value: { organizationId: orgId, humanId, role: 'owner', status: 'active', createdAt: '2026-01-01' } },
      { path: `humans/${humanId}/organizations/${orgId}.json`, value: { organizationId: orgId, role: 'owner' } }
    );
  }
  return { documents, users, organizations, databaseFingerprint: databaseTargetFingerprint(connectionString),
    deployment: { environment: 'beta', legacyUnstampedReleaseSha: null }, sourceInventoryDigest: 'a'.repeat(64) };
}
const plan = () => prepareWorkosIdentityMapping(fixture());
const expectCode = code => error => error.code === code;

test('mapping preserves every local identity, membership and reference and removes old provider aliases', () => {
  const input = fixture(); const before = structuredClone(input); const m = prepareWorkosIdentityMapping(input);
  assert.deepEqual(input, before); assert.equal(m.changes.length, 12); assert.equal(m.afterDocuments.length, 12);
  assert.deepEqual(validateWorkosIdentityMapping(m), m);
  const after = new Map(m.afterDocuments.map(d => [d.path, d.value]));
  for (const d of m.beforeDocuments) {
    if (d.path.startsWith('auth/')) assert.equal(after.has(d.path), false);
    else {
      const value = structuredClone(after.get(d.path));
      if ('workosUserId' in value) value.workosUserId = d.value.workosUserId;
      if ('workosOrganizationId' in value) value.workosOrganizationId = d.value.workosOrganizationId;
      assert.deepEqual(value, d.value);
    }
  }
  assert.equal(after.get('auth/workos-user-index/user_new_one.json').humanId, 'human_one');
  assert.equal(after.get('auth/workos-organization-index/org_new_two.json').organizationId, 'org_local_two');
});

test('mapping rejects incomplete cohorts, missing indexes, duplicate or aliased provider identities and inactive owners', () => {
  const cases = [
    f => { f.users.pop(); f.organizations.pop(); },
    f => { f.documents.splice(1, 1); },
    f => { f.users[1].to = f.users[0].to; },
    f => { f.users[1].to = f.users[0].from; },
    f => { f.organizations[1].to = f.organizations[0].to; },
    f => { f.documents.find(d => d.path.includes('/members/')).value.status = 'inactive'; },
    f => { f.documents.find(d => d.path.includes('/members/')).value.role = 'member'; },
    f => { f.documents.find(d => d.path.endsWith('organization.json')).value.ownerHumanId = 'human_two'; },
    f => { f.documents.push(structuredClone(f.documents[0])); },
    f => { f.users[0].localHumanId = '../escape'; }
  ];
  for (const change of cases) { const f = fixture(); change(f); assert.throws(() => prepareWorkosIdentityMapping(f)); }
});

test('mapping refuses target collisions and email-only matching', () => {
  const collision = fixture(); collision.documents.push({ path: 'auth/workos-user-index/user_new_one.json', value: { humanId: 'human_two' } });
  assert.throws(() => prepareWorkosIdentityMapping(collision), expectCode('PROVIDER_INDEX_COLLISION'));
  const emailOnly = fixture(); emailOnly.documents[0].value.workosUserId = 'user_someone_else';
  assert.throws(() => prepareWorkosIdentityMapping(emailOnly), expectCode('SOURCE_USER_MISMATCH'));
});

test('digest rejects tampering, including a rehashed attempt to edit history or broaden the transform', () => {
  const m = plan(); m.changes[0].path = 'cases/case_one/case.json';
  assert.throws(() => validateWorkosIdentityMapping(m), expectCode('MAPPING_DIGEST_MISMATCH'));
  const { digest: _ignored, ...body } = m; m.digest = mappingDigest(body);
  assert.throws(() => validateWorkosIdentityMapping(m), expectCode('INVALID_MAPPING_TRANSFORM'));
});

test('write execution requires explicit maintenance and recovery acknowledgements before touching SQL', async () => {
  const client = { connectionParameters: { host: '127.0.0.1', port: 5432, database: 'mapping_test' }, query: () => assert.fail('must not query') };
  const m = plan();
  for (const options of [{ dryRun: false }, { dryRun: false, approvedDigest: m.digest, maintenanceConfirmed: true }]) {
    await assert.rejects(() => executeWorkosIdentityMapping(client, m, options), expectCode('CUTOVER_APPROVAL_AND_RECOVERY_REQUIRED'));
  }
  const other = { ...client, connectionParameters: { ...client.connectionParameters, database: 'another_database' } };
  await assert.rejects(() => executeWorkosIdentityMapping(other, m), expectCode('DATABASE_TARGET_MISMATCH'));
});

test('real auth upsert resolves both new provider IDs to the existing local humans and preserves workspace references', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-workos-mapping-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir); await store.init(); const m = plan();
  for (const d of m.afterDocuments) await store.putJson(d.path, d.value);
  const auth = new WorkOSAuthService(store, { clientId: 'client_fixture', apiKey: 'sk_fixture', cookiePassword: 'x'.repeat(32), redirectUri: 'https://example.test/callback', workos: {} });
  for (const u of m.users) {
    const human = await auth.upsertHuman({ id: u.to, email: `${u.localHumanId.slice(6)}@example.com`, name: u.localHumanId, emailVerified: true });
    assert.equal(human.id, u.localHumanId);
    const refs = await store.listJson(`humans/${human.id}/organizations`);
    assert.equal(refs.length, 1); assert.equal(refs[0].organizationId, `org_local_${human.id.slice(6)}`);
  }
  assert.equal((await store.listJson('humans')).length, 2);
});

// An isolated schema on the CI loopback test database. Never run this write test
// against a hosted database, including the private Production preparation binding.
const databaseUrl = process.env.DATABASE_URL;
const postgresAvailable = databaseUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname);
test('PostgreSQL mapping is atomic, read-only by default, idempotent and reverses without overwriting later changes', { skip: !postgresAvailable }, async t => {
  const client = new pg.Client({ connectionString: databaseUrl }); await client.connect();
  const schema = `workos_mapping_${crypto.randomUUID().replaceAll('-', '')}`;
  t.after(async () => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await client.end(); });
  await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
  await client.query('CREATE TABLE sinaloa_documents(path TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const f = fixture(databaseUrl); const m = prepareWorkosIdentityMapping(f);
  const history = [
    { path: 'inboxes/inbox_one/inbox.json', value: { id: 'inbox_one', organizationId: 'org_local_one', ownerHumanId: 'human_one' } },
    { path: 'inboxes/inbox_two/agents/agent_two.json', value: { id: 'agent_two', inboxId: 'inbox_two', ownerHumanId: 'human_two', credentialHash: 'fixture-only' } },
    { path: 'cases/case_one/case.json', value: { id: 'case_one', organizationId: 'org_local_one', messages: ['message_one'] } }
  ];
  const seed = async () => {
    await client.query('TRUNCATE sinaloa_documents');
    for (const d of [...f.documents, ...history, { path: 'deployment/identity.json', value: { environment: 'beta' } }]) {
      await client.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2)', [d.path, d.value]);
    }
  };
  const snapshot = async () => (await client.query('SELECT path, value FROM sinaloa_documents ORDER BY path')).rows;
  const apply = { dryRun: false, approvedDigest: m.digest, maintenanceConfirmed: true, recoveryReference: 'isolated-CI-seed' };
  await seed(); const original = await snapshot();
  await t.test('default dry run changes no documents', async () => {
    assert.equal((await executeWorkosIdentityMapping(client, m)).status, 'DRY_RUN_VALID'); assert.deepEqual(await snapshot(), original);
  });
  await t.test('a projected inventory missing existing fields is refused without writes', async () => {
    const partial = structuredClone(f); delete partial.documents.find(d => d.path === 'humans/human_one.json').value.verifiedAt;
    const incomplete = prepareWorkosIdentityMapping(partial);
    await assert.rejects(() => executeWorkosIdentityMapping(client, incomplete), expectCode('IDENTITY_INVENTORY_CHANGED'));
    assert.deepEqual(await snapshot(), original);
  });
  await t.test('a mid-transaction database error rolls back every earlier index and identity change without leaking rows', async () => {
    await client.query(`CREATE FUNCTION refuse_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.path = 'organizations/org_local_two/organization.json' AND NEW.value->>'workosOrganizationId' = 'org_new_two'
      THEN RAISE EXCEPTION 'private-row-must-never-leak: %', NEW.value; END IF; RETURN NEW; END $$`);
    await client.query('CREATE TRIGGER refuse_mapping BEFORE INSERT OR UPDATE ON sinaloa_documents FOR EACH ROW EXECUTE FUNCTION refuse_mapping()');
    await assert.rejects(() => executeWorkosIdentityMapping(client, m, apply), error => error.code === 'P0001' && !error.message.includes('private-row'));
    assert.deepEqual(await snapshot(), original); await client.query('DROP TRIGGER refuse_mapping ON sinaloa_documents');
  });
  await t.test('forward and inverse are idempotent and preserve inboxes, agents, history and owner isolation', async () => {
    assert.equal((await executeWorkosIdentityMapping(client, m, apply)).documentWrites, 12);
    assert.equal((await executeWorkosIdentityMapping(client, m, apply)).status, 'NO_OP');
    for (const d of history) assert.deepEqual((await client.query('SELECT value FROM sinaloa_documents WHERE path = $1', [d.path])).rows[0].value, d.value);
    for (const u of m.users) assert.equal((await client.query('SELECT value FROM sinaloa_documents WHERE path = $1', [`auth/workos-user-index/${u.to}.json`])).rows[0].value.humanId, u.localHumanId);
    const inverse = { ...apply, direction: 'inverse' };
    assert.equal((await executeWorkosIdentityMapping(client, m, inverse)).status, 'APPLIED');
    assert.deepEqual(await snapshot(), original); assert.equal((await executeWorkosIdentityMapping(client, m, inverse)).status, 'NO_OP');
  });
  await t.test('inverse refuses to overwrite an owner profile edited after cutover', async () => {
    await executeWorkosIdentityMapping(client, m, apply);
    await client.query("UPDATE sinaloa_documents SET value = jsonb_set(value, '{displayName}', '\"later-owner-edit\"') WHERE path = 'humans/human_one.json'");
    const changed = await snapshot();
    await assert.rejects(() => executeWorkosIdentityMapping(client, m, { ...apply, direction: 'inverse' }), expectCode('IDENTITY_INVENTORY_CHANGED'));
    assert.deepEqual(await snapshot(), changed); await seed();
  });
  await t.test('an unmapped registration or conflicting target index refuses the whole operation', async () => {
    await client.query("INSERT INTO sinaloa_documents(path, value) VALUES('auth/workos-user-index/user_new_one.json', '{\"humanId\":\"human_two\"}')");
    const changed = await snapshot(); await assert.rejects(() => executeWorkosIdentityMapping(client, m, apply), expectCode('IDENTITY_INVENTORY_CHANGED'));
    assert.deepEqual(await snapshot(), changed); await seed();
  });
  await t.test('another deployment is rejected and an unstamped legacy source needs the explicit audited release pin', async () => {
    await client.query("UPDATE sinaloa_documents SET value = '{\"environment\":\"staging\"}' WHERE path = 'deployment/identity.json'");
    await assert.rejects(() => executeWorkosIdentityMapping(client, m), expectCode('DEPLOYMENT_IDENTITY_MISMATCH'));
    await client.query("DELETE FROM sinaloa_documents WHERE path = 'deployment/identity.json'");
    await assert.rejects(() => executeWorkosIdentityMapping(client, m), expectCode('DEPLOYMENT_IDENTITY_MISMATCH'));
    const legacy = prepareWorkosIdentityMapping({ ...f, deployment: { environment: 'beta', legacyUnstampedReleaseSha: '1'.repeat(40) } });
    assert.equal((await executeWorkosIdentityMapping(client, legacy)).status, 'DRY_RUN_VALID');
    assert.equal((await client.query("SELECT COUNT(*) FROM sinaloa_documents WHERE path = 'deployment/identity.json'")).rows[0].count, '0');
  });
});
