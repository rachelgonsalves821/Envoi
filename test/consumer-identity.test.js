import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createConsumerIdentity, databaseTargetFingerprint, assertDatabaseTarget, consumerLogger, parseConsumerApplicationName } from '../src/consumer-identity.js';
import { createPostgresOptions } from '../src/postgres-options.js';
import { inspectQueueConsumers, queueConsumerReport } from '../scripts/queue-consumers.mjs';
import { DeliveryWorker } from '../src/delivery-worker.js';

const url = 'postgresql://user:DO_NOT_PUBLISH@private-db.example/staging_private';
const sha = 'a'.repeat(40);
const identity = () => createConsumerIdentity({ connectionString: url, releaseSha: sha, host: 'private-host', instanceId: '11111111-2222-4333-8444-555555555555' });

test('destination pin excludes credentials but distinguishes host, port and database', () => {
  const pin = databaseTargetFingerprint(url);
  assert.equal(pin, databaseTargetFingerprint('postgres://other:changed@PRIVATE-DB.example:5432/staging_private'));
  for (const other of [url.replace('private-db', 'another-db'), url.replace('/staging_private', '/beta_private'), url.replace('.example/', '.example:5433/')]) {
    assert.notEqual(databaseTargetFingerprint(other), pin);
    assert.throws(() => assertDatabaseTarget(other, pin), /does not match/);
  }
  assert.equal(assertDatabaseTarget(url, pin), pin);
  assert.doesNotMatch(pin, /private|PUBLISH|user/);
});

test('invalid URLs, ambiguous routing and malformed pins fail without leaking configuration', () => {
  for (const value of ['DO_NOT_PUBLISH', 'https://user:DO_NOT_PUBLISH@private-db.example/staging', 'postgres://user:DO_NOT_PUBLISH@private-db.example/', `${url}?host=DO_NOT_PUBLISH`, `${url}?options=DO_NOT_PUBLISH`]) {
    assert.throws(() => databaseTargetFingerprint(value), error => !error.message.includes('DO_NOT_PUBLISH') && !error.message.includes('private-db'));
  }
  assert.throws(() => assertDatabaseTarget(url, 'bad'), /does not match/);
  assert.throws(() => createPostgresOptions(url, { ENVOI_EXPECTED_DATABASE_FINGERPRINT: '0'.repeat(64) }), /does not match/);
});

test('PostgreSQL receives a full-SHA process identity even with a conflicting URL application_name', () => {
  const value = identity();
  const options = createPostgresOptions(`${url}?application_name=untrusted`, {}, { applicationName: value.applicationName });
  const client = new pg.Client(options);
  assert.equal(client.connectionParameters.application_name, value.applicationName);
  assert.ok(Buffer.byteLength(value.applicationName) <= 63);
  assert.deepEqual(parseConsumerApplicationName(value.applicationName), { role: 'api-delivery', releaseSha: sha, instanceTag: value.instanceTag });
  assert.equal(value.workerId, 'delivery_11111111-2222-4333-8444-555555555555');
});

test('URL TLS settings cannot override the verified-TLS options', () => {
  for (const parameter of ['ssl=false', 'sslmode=disable', 'uselibpqcompat=true']) assert.throws(() => createPostgresOptions(`${url}?${parameter}`, { ENVOI_AUTH_MODE: 'production', ENVOI_DB_SSL_MODE: 'verify-full' }), /not DATABASE_URL query parameters/);
});

test('consumer logs allowlist identity and lease IDs without hostnames, tokens, payloads or raw errors', () => {
  const lines = [];const log = consumerLogger(identity(), value => lines.push(value));
  log('claimed', { id: 'delivery_one', messageId: 'msg_one', orderingKey: 'case_one', status: 'processing', attempts: 0, leaseToken: 'DO_NOT_PUBLISH', text: 'DO_NOT_PUBLISH', lastError: 'DO_NOT_PUBLISH' });
  const text = JSON.stringify(lines);
  assert.doesNotMatch(text, /private|DO_NOT_PUBLISH|leaseToken|lastError/);
  assert.equal(lines[0].workerId, identity().workerId);
  assert.equal(lines[0].releaseSha, sha);
  assert.equal(lines[0].id, 'delivery_one');
  assert.equal(lines[0].databaseFingerprint, databaseTargetFingerprint(url));
  log('claimed', { id: 'case_envoi_agent_access_DO_NOT_PUBLISH', messageId: 'envoi_agent_access_DO_NOT_PUBLISH' });
  assert.equal('id' in lines[1], false);
  assert.equal('messageId' in lines[1], false);
  assert.doesNotThrow(() => consumerLogger(identity(), () => { throw Error('logging unavailable'); })('claimed'));
});

test('inventory ignores arbitrary application text and never changes database state', async () => {
  const statements=[];const client={query:async sql=>{statements.push(sql);if(sql.includes('pg_stat_activity'))return {rows:[{pid:1,application_name:identity().applicationName},{pid:2,application_name:'DO_NOT_PUBLISH'}]};if(sql.includes('sinaloa_outbox'))return {rows:[{locked_by:identity().workerId,lease_count:2},{locked_by:'DO_NOT_PUBLISH',lease_count:1}]};return {rows:[]};}};
  const report=await inspectQueueConsumers(client);
  assert.equal(statements[0],'BEGIN READ ONLY');assert.equal(statements.at(-1),'ROLLBACK');
  assert.ok(statements.slice(1,-1).every(sql=>sql.startsWith('SELECT ')));
  assert.doesNotMatch(JSON.stringify(report),/DO_NOT_PUBLISH|application_name/);
  assert.equal(report.connections[0].releaseSha,sha);assert.equal(report.connections[1].role,'unattributed');
  assert.equal(report.leases[0].workerId,identity().workerId);assert.equal(report.leases[1].workerId,null);
});

test('inventory refuses an unpinned or wrong destination before creating a client; fingerprint mode is offline', async () => {
  let created=0;const factory=()=>{created++;throw Error('unexpected connection');};
  assert.deepEqual(await queueConsumerReport('fingerprint',{DATABASE_URL:url},factory),{databaseFingerprint:databaseTargetFingerprint(url),connected:false});
  await assert.rejects(()=>queueConsumerReport('inventory',{DATABASE_URL:url},factory),/Pin /);
  await assert.rejects(()=>queueConsumerReport('inventory',{DATABASE_URL:url,ENVOI_EXPECTED_DATABASE_FINGERPRINT:'0'.repeat(64)},factory),/does not match/);
  assert.equal(created,0);
});

test('inventory rolls back and closes its connection on a query failure', async () => {
  const statements=[];let closed=false;
  const client={connect:async()=>{},end:async()=>{closed=true;},query:async sql=>{statements.push(sql);if(sql.includes('pg_stat_activity'))throw Error('query failure');return {rows:[]};}};
  await assert.rejects(()=>queueConsumerReport('inventory',{DATABASE_URL:url,ENVOI_EXPECTED_DATABASE_FINGERPRINT:databaseTargetFingerprint(url)},()=>client),/query failure/);
  assert.equal(closed,true);assert.equal(statements.at(-1),'ROLLBACK');
});

test('lease telemetry records claim and settlement without changing delivery when observer fails', async () => {
  const events=[];const record={id:'delivery_one',messageId:'msg_one',status:'processing',attempts:0};let completed=false;
  const worker=new DeliveryWorker({workerId:identity().workerId,store:{claimOutbox:async id=>{assert.equal(id,identity().workerId);return record;},withTransaction:async(_keys,run)=>run(),completeOutbox:async()=>{completed=true;return {...record,status:'delivered'};}},deliver:async()=>({}),observe:(event,value)=>{events.push([event,value?.id]);throw Error('telemetry failure');}});
  assert.equal(await worker.processOne(),true);assert.equal(completed,true);assert.deepEqual(events,[['claimed','delivery_one'],['settled','delivery_one']]);
});


test('server refuses a pinned destination when DATABASE_URL is missing instead of falling back to FileStore', () => {
  assert.throws(() => execFileSync(process.execPath, ['src/server.js'], {
    env: { ...process.env, ENVOI_AUTH_MODE: 'development', DATABASE_URL: '', ENVOI_EXPECTED_DATABASE_FINGERPRINT: 'a'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true
  }), error => error.status !== 0 && error.stderr.toString().includes('ENVOI_EXPECTED_DATABASE_FINGERPRINT requires DATABASE_URL'));
});


test('destination fingerprint matches pg encoding semantics and cannot inherit an unpinned PGPORT', () => {
  assert.equal(databaseTargetFingerprint('postgres://%64b.example:05432/test'), databaseTargetFingerprint('postgres://db.example/test'));
  assert.notEqual(databaseTargetFingerprint('postgres://db.example/staging%2Fdb'), databaseTargetFingerprint('postgres://db.example/staging/db'));
  const previous = process.env.PGPORT;
  try {
    process.env.PGPORT = '6543';
    const client = new pg.Client(createPostgresOptions('postgres://db.example/test', {}));
    assert.equal(client.connectionParameters.port, 5432);
  } finally { if (previous === undefined) delete process.env.PGPORT; else process.env.PGPORT = previous; }
});
