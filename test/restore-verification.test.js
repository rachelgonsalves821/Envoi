import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  RESTORE_TABLES, assertDistinctEndpoints, compareSnapshots, fingerprintRows,
  readDatabaseSnapshot, safeRestoreDiagnostic, validateLedger, validateRestoreConfiguration
} from '../scripts/verify-restored-data.mjs';

const migrations = [{ name: '001_fixture.sql', checksum: 'a'.repeat(64) }];
function snapshot() {
  return {
    tables: Object.fromEntries(RESTORE_TABLES.map(({ label }) => [label, fingerprintRows([`{"fixture":"${label}"}`])])),
    representative: { cases: 2, messages: 4, assets: 1 },
    ledger: migrations.map(({ name, checksum }) => ({ name, checksum }))
  };
}
function fixtureDatabase() {
  return Object.fromEntries(RESTORE_TABLES.map(({ label, table, key }) => {
    const records = label === 'docs' ? [
      { path: 'inboxes/fixture/assets/asset.json', value: { privateText: 'private fixture payload' }, updated_at: '2026-09-29T00:00:00+00:00' },
      { path: 'inboxes/fixture/cases/case.json', value: { state: 'completed' }, updated_at: '2026-09-29T00:00:00+00:00' },
      { path: 'inboxes/fixture/messages/message.json', value: { text: 'private fixture message' }, updated_at: '2026-09-29T00:00:00+00:00' }
    ] : label === 'migration_ledger' ? migrations.map(migration => ({ ...migration, applied_at: '2026-09-29T00:00:00+00:00' }))
      : [{ [key]: `${label}_fixture`, value: 'fixture', updated_at: '2026-09-29T00:00:00+00:00' }];
    return [table, records.map(row => ({ scan_key: row[key], row_json: JSON.stringify(row) })).sort((a, b) => a.scan_key.localeCompare(b.scan_key))];
  }));
}
function fixtureClient(dataset, { failureTable } = {}) {
  const calls = [];
  return { calls, query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === "SET LOCAL TIME ZONE 'UTC'" || sql === 'ROLLBACK') return { rows: [] };
    const table = /FROM ([a-z_]+) AS t/.exec(sql)?.[1];
    assert.ok(RESTORE_TABLES.some(candidate => candidate.table === table), 'SQL uses a fixed application table');
    assert.match(sql, /ORDER BY [a-z_]+ COLLATE "C" LIMIT \$[12]$/);
    if (table === failureTable) throw Object.assign(new Error('private fixture URL/credential/row must never be printed'), { code: 'private-secret-code' });
    const after = params.length === 2 ? params[0] : null;
    const limit = params.at(-1);
    return { rows: dataset[table].filter(row => after === null || row.scan_key > after).slice(0, limit) };
  } };
}

test('restore fingerprints preserve exact row bytes, bigint precision and row boundaries', () => {
  const first = fingerprintRows(['{"amount":9007199254740993}', '{"content":"fixture"}']);
  assert.equal(first.rows, 2);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, fingerprintRows(['{"amount":9007199254740993}', '{"content":"fixture"}']));
  assert.notEqual(first.sha256, fingerprintRows(['{"amount":9007199254740992}', '{"content":"fixture"}']).sha256);
  assert.notEqual(fingerprintRows(['a', 'bc']).sha256, fingerprintRows(['ab', 'c']).sha256);
  assert.notEqual(first.sha256, fingerprintRows(['{"content":"fixture"}', '{"amount":9007199254740993}']).sha256);
});

test('equivalent populated snapshots produce only approved count/fingerprint diagnostics', () => {
  const source = snapshot();
  const result = compareSnapshots(source, structuredClone(source), migrations);
  assert.equal(result.ok, true);
  assert.equal(result.tables.length, RESTORE_TABLES.length);
  assert.deepEqual(result.representative, source.representative);
  assert.ok(result.tables.every(table => Object.keys(table).sort().join(',') === 'rows,sha256,table'));
  assert.doesNotMatch(JSON.stringify(result), /private|inboxes\/|fixture\.sql|userId|DATABASE_URL/);
});

test('row-count, changed content and missing-table mismatches fail verification', () => {
  for (const mutation of [
    target => { target.tables.docs.rows += 1; },
    target => { target.tables.outbox.sha256 = 'b'.repeat(64); },
    target => { delete target.tables.reservations; }
  ]) {
    const source = snapshot();
    const target = structuredClone(source);
    mutation(target);
    assert.throws(() => compareSnapshots(source, target, migrations), { code: 'RESTORE_DATA_MISMATCH' });
  }
});

test('empty-schema and incomplete representative restores cannot establish recovery evidence', () => {
  for (const kind of ['cases', 'messages', 'assets']) {
    const source = snapshot();
    source.representative[kind] = 0;
    assert.throws(() => compareSnapshots(source, structuredClone(source), migrations), { code: 'RESTORE_SOURCE_NOT_POPULATED' });
  }
});

test('migration ledger must exactly match the current migration checksums', () => {
  assert.doesNotThrow(() => validateLedger(migrations, migrations));
  for (const bad of [[], [{ ...migrations[0], checksum: 'b'.repeat(64) }], [{ ...migrations[0], name: 'unexpected.sql' }], [...migrations, migrations[0]]]) {
    assert.throws(() => validateLedger(bad, migrations), { code: 'RESTORE_LEDGER_MISMATCH' });
  }
  const source = snapshot();
  const target = structuredClone(source);
  target.ledger[0].checksum = 'b'.repeat(64);
  assert.throws(() => compareSnapshots(source, target, migrations), { code: 'RESTORE_LEDGER_MISMATCH' });
});

test('restore endpoints ignore credential changes and normalize direct/pooler aliases', () => {
  for (const [source, target] of [
    ['postgresql://first:secret@host.example/app', 'postgres://second:changed@HOST.example:5432/app'],
    ['postgresql://first:secret@ep-fixture.neon.tech/app', 'postgresql://second:changed@ep-fixture-pooler.neon.tech/app'],
    ['postgresql://first:secret@host.example/app', 'postgresql://second:changed@host.example/app?application_name=restore']
  ]) assert.throws(() => assertDistinctEndpoints(source, target), { code: 'RESTORE_SAME_ENDPOINT' });
  assert.doesNotThrow(() => assertDistinctEndpoints('postgresql://fixture@source.example/app', 'postgresql://fixture@target.example/app'));
  assert.throws(() => assertDistinctEndpoints('not a database URL', 'postgresql://fixture@target.example/app'), { code: 'RESTORE_CONFIGURATION_INVALID' });
  assert.throws(() => assertDistinctEndpoints('postgresql://fixture@source.example/app?host=target.example', 'postgresql://fixture@target.example/app'), { code: 'RESTORE_CONFIGURATION_INVALID' });
});

test('configuration requires operator attestations and forces verified production TLS independently', () => {
  const env = {
    SINALOA_RESTORE_SOURCE_DATABASE_URL: 'postgresql://fixture:private@source.example/app',
    SINALOA_RESTORE_TARGET_DATABASE_URL: 'postgresql://fixture:private@target.example/app',
    SINALOA_RESTORE_SOURCE_QUIESCED: '1', SINALOA_RESTORE_TARGET_ISOLATED: '1',
    SINALOA_DB_SSL_MODE: 'disable', SINALOA_AUTH_MODE: 'development',
    SINALOA_RESTORE_SOURCE_DB_CA: 'source fixture CA', SINALOA_RESTORE_TARGET_DB_CA: 'target fixture CA'
  };
  const options = validateRestoreConfiguration(env);
  assert.equal(options.source.ssl.rejectUnauthorized, true);
  assert.equal(options.target.ssl.rejectUnauthorized, true);
  assert.equal(options.source.ssl.ca, 'source fixture CA');
  assert.equal(options.target.ssl.ca, 'target fixture CA');
  assert.equal(options.source.max, 1);
  assert.throws(() => validateRestoreConfiguration({ ...env, SINALOA_RESTORE_TARGET_ISOLATED: '0' }), { code: 'RESTORE_ATTESTATION_REQUIRED' });
  assert.throws(() => validateRestoreConfiguration({ ...env, SINALOA_RESTORE_SOURCE_QUIESCED: undefined }), { code: 'RESTORE_ATTESTATION_REQUIRED' });
  assert.throws(() => validateRestoreConfiguration({ ...env, SINALOA_RESTORE_SOURCE_DATABASE_URL: `${env.SINALOA_RESTORE_SOURCE_DATABASE_URL}?ssl=false` }), { code: 'RESTORE_CONFIGURATION_INVALID' });
});

test('snapshot reads fixed tables using bounded stable pages inside a read-only repeatable transaction', async () => {
  const database = fixtureDatabase();
  const source = fixtureClient(database);
  const target = fixtureClient(structuredClone(database));
  const left = await readDatabaseSnapshot(source, migrations, { pageSize: 2 });
  const right = await readDatabaseSnapshot(target, migrations, { pageSize: 1 });
  const result = compareSnapshots(left, right, migrations);
  assert.equal(result.ok, true);
  assert.deepEqual(result.representative, { cases: 1, messages: 1, assets: 1 });
  assert.equal(result.tables.find(table => table.table === 'docs').rows, 3);
  assert.equal(source.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(source.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(source.calls.filter(call => call.sql.startsWith('SELECT')).every(call => call.params.at(-1) <= 2));
  assert.ok(source.calls.some(call => call.sql.includes('WHERE path COLLATE "C" > $1')));
  assert.ok(source.calls.every(call => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY)\b/.test(call.sql)));
  assert.doesNotMatch(JSON.stringify(result), /private fixture|inboxes\/fixture|quota_usage_fixture/);
});

test('failed database reads always end the snapshot and return sanitized diagnostics', async () => {
  const client = fixtureClient(fixtureDatabase(), { failureTable: 'sinaloa_outbox' });
  let failure;
  try { await readDatabaseSnapshot(client, migrations); } catch (error) { failure = error; }
  assert.deepEqual(safeRestoreDiagnostic(failure), { ok: false, code: 'RESTORE_DATABASE_READ_FAILED' });
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(safeRestoreDiagnostic(Object.assign(new Error('secret database URL'), { code: 'secret-provider-code' })), { ok: false, code: 'RESTORE_VERIFICATION_FAILED' });
});

test('CLI rejects missing private settings without printing inherited credentials or provider data', () => {
  const env = { ...process.env, SINALOA_RESTORE_SOURCE_DATABASE_URL: '', SINALOA_RESTORE_TARGET_DATABASE_URL: '', SINALOA_RESTORE_SOURCE_QUIESCED: '', SINALOA_RESTORE_TARGET_ISOLATED: '', DATABASE_URL: 'postgresql://private:do-not-print@private.example/private' };
  const result = spawnSync(process.execPath, ['scripts/verify-restored-data.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: 'RESTORE_CONFIGURATION_INVALID' });
  assert.doesNotMatch(result.stderr, /private|do-not-print|postgresql/);
});
