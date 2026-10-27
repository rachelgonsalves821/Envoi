// Disposable CI-loopback database only. Never use a hosted DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresStore } from '../src/postgres-storage.js';
import { WorkOSAuthService } from '../src/workos-auth.js';
const databaseUrl = process.env.DATABASE_URL;
const target = databaseUrl ? new URL(databaseUrl) : null;
const loopback = target && ['postgres:', 'postgresql:'].includes(target.protocol)
  && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  && ['', '5432'].includes(target.port) && target.pathname === '/sinaloa_test'
  && target.username === 'sinaloa' && target.search === '';
test('PostgreSQL public quota is atomic across pools, rolls back partial writes, and survives restart', { skip: !loopback, timeout: 60000 }, async t => {
  const admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
  const schema = 'signup_quota_' + crypto.randomBytes(12).toString('hex');
  assert.match(schema, /^signup_quota_[a-f0-9]{24}$/);
  // Keep the production URL-routing guard intact. This trusted test-only pool
  // option selects the private schema before either pool opens a connection.
  const a = new PostgresStore(databaseUrl, { max: 1 }), b = new PostgresStore(databaseUrl, { max: 1 });
  a.pool.options.options = '-c search_path=' + schema;
  b.pool.options.options = '-c search_path=' + schema;
  t.after(async () => { await a.close(); await b.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.sinaloa_documents(path TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const options = { clientId: 'client_fixture', apiKey: 'synthetic_only', cookiePassword: 'x'.repeat(32), redirectUri: 'https://fixture.example/callback', workos: {}, signupMode: 'public', publicSignupLimit: 100, invitedEmails: 'owner@example.test,second_owner@example.test' };
  const first = new WorkOSAuthService(a, options), second = new WorkOSAuthService(b, options);
  const user = id => ({ id, email: id + '@example.test', emailVerified: true });
  const originalBatch = a.putJsonBatch.bind(a);
  a.putJsonBatch = async documents => { await originalBatch(documents.slice(0, 1)); throw new Error('synthetic failed write'); };
  await assert.rejects(first.upsertHuman(user('failed')), /synthetic failed write/);
  a.putJsonBatch = originalBatch;
  assert.deepEqual(await a.listJson('humans'), []);
  assert.equal(await a.getJson('auth/workos-public-admissions.json'), null);
  const owner = await first.upsertHuman(user('owner'));
  const secondOwner = await second.upsertHuman(user('second_owner'));
  const anchors = [owner, secondOwner].flatMap((human, i) => [
    { path: `organizations/org_preserved_${i}/organization.json`, value: { id: `org_preserved_${i}`, ownerHumanId: human.id, status: 'active' } },
    { path: `organizations/org_preserved_${i}/members/${human.id}.json`, value: { organizationId: `org_preserved_${i}`, humanId: human.id, role: 'admin', status: 'active' } },
    { path: `inboxes/inbox_preserved_${i}/inbox.json`, value: { id: `inbox_preserved_${i}`, organizationId: `org_preserved_${i}`, ownerHumanId: human.id } }
  ]);
  await a.putJsonBatch(anchors);
  const initial = await first.upsertHuman(user('public_0'));
  await Promise.all(Array.from({ length: 98 }, (_, i) => (i % 2 ? first : second).upsertHuman(user('public_' + (i + 1)))));
  const race = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).upsertHuman(user('boundary_' + i))));
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(race.filter(r => r.status === 'rejected' && r.reason.code === 'PUBLIC_SIGNUP_FULL').length, 11);
  assert.equal((await b.getJson('auth/workos-public-admissions.json')).userIds.length, 100);
  const restarted = new WorkOSAuthService(b, options);
  assert.equal((await restarted.upsertHuman(user('public_0'))).id, initial.id);
  assert.equal((await restarted.upsertHuman(user('owner'))).id, owner.id);
  assert.equal((await restarted.upsertHuman(user('second_owner'))).id, secondOwner.id);
  for (const document of anchors) assert.deepEqual(await b.getJson(document.path), document.value);
  await assert.rejects(restarted.upsertHuman(user('one_too_many')), { code: 'PUBLIC_SIGNUP_FULL' });
  assert.equal((await b.listJson('humans')).length, 102);
});
