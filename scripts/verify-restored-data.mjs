import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyEnvoiEnvironmentAliases } from '../src/envoi-environment.js';
import { createPostgresOptions } from '../src/postgres-options.js';
import { loadMigrations } from '../src/migrations.js';

export const RESTORE_TABLES = Object.freeze([
  { label: 'docs', table: 'sinaloa_documents', key: 'path' },
  { label: 'outbox', table: 'sinaloa_outbox', key: 'id' },
  { label: 'quota_usage', table: 'sinaloa_object_quota_usage', key: 'workspace_id' },
  { label: 'reservations', table: 'sinaloa_object_quota_reservations', key: 'id' },
  { label: 'event_sequences', table: 'sinaloa_event_sequences', key: 'inbox_id' },
  { label: 'migration_ledger', table: 'sinaloa_schema_migrations', key: 'name' }
].map(table => Object.freeze(table)));
const safeCodes = new Set([
  'RESTORE_CONFIGURATION_INVALID', 'RESTORE_SAME_ENDPOINT', 'RESTORE_ATTESTATION_REQUIRED',
  'RESTORE_MIGRATIONS_UNAVAILABLE', 'RESTORE_CONNECTION_FAILED', 'RESTORE_DATABASE_READ_FAILED',
  'RESTORE_LEDGER_MISMATCH', 'RESTORE_SOURCE_NOT_POPULATED', 'RESTORE_DATA_MISMATCH',
  'RESTORE_VERIFICATION_FAILED'
]);
class RestoreVerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new RestoreVerificationError(code); };

// Ignore credentials and connection options when checking resource identity.
// Neon direct and pooler aliases must not count as independent restore targets.
export function endpointIdentity(connectionString) {
  try {
    const parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) fail('RESTORE_CONFIGURATION_INVALID');
    // Connection-option overrides could make different URL hosts reach the
    // same database, or override our verified TLS configuration.
    if ([...parsed.searchParams.keys()].some(key => !['application_name', 'channel_binding'].includes(key))) fail('RESTORE_CONFIGURATION_INVALID');
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/-pooler(?=\.)/, '');
    return `${hostname}:${parsed.port || '5432'}/${decodeURIComponent(parsed.pathname.slice(1))}`;
  } catch {
    fail('RESTORE_CONFIGURATION_INVALID');
  }
}
export function assertDistinctEndpoints(sourceUrl, targetUrl) {
  if (endpointIdentity(sourceUrl) === endpointIdentity(targetUrl)) fail('RESTORE_SAME_ENDPOINT');
}
export function validateRestoreConfiguration(env = process.env) {
  env = applyEnvoiEnvironmentAliases({ ...env });
  const sourceUrl = env.ENVOI_RESTORE_SOURCE_DATABASE_URL;
  const targetUrl = env.ENVOI_RESTORE_TARGET_DATABASE_URL;
  assertDistinctEndpoints(sourceUrl, targetUrl);
  if (env.ENVOI_RESTORE_SOURCE_QUIESCED !== '1' || env.ENVOI_RESTORE_TARGET_ISOLATED !== '1') fail('RESTORE_ATTESTATION_REQUIRED');
  try {
    const forced = { ...env, ENVOI_AUTH_MODE: 'production', SINALOA_AUTH_MODE: 'production', ENVOI_DB_SSL_MODE: 'verify-full', SINALOA_DB_SSL_MODE: 'verify-full', ENVOI_DB_POOL_SIZE: '1', SINALOA_DB_POOL_SIZE: '1' };
    const sourceCa = env.ENVOI_RESTORE_SOURCE_DB_CA || env.ENVOI_DB_CA;
    const targetCa = env.ENVOI_RESTORE_TARGET_DB_CA || env.ENVOI_DB_CA;
    return {
      source: createPostgresOptions(sourceUrl, { ...forced, ENVOI_DB_CA: sourceCa, SINALOA_DB_CA: sourceCa }, { max: 1 }),
      target: createPostgresOptions(targetUrl, { ...forced, ENVOI_DB_CA: targetCa, SINALOA_DB_CA: targetCa }, { max: 1 })
    };
  } catch {
    fail('RESTORE_CONFIGURATION_INVALID');
  }
}
export function safeRestoreDiagnostic(error) {
  return { ok: false, code: error instanceof RestoreVerificationError && safeCodes.has(error.code) ? error.code : 'RESTORE_VERIFICATION_FAILED' };
}
function addRow(hash, rowJson) {
  if (typeof rowJson !== 'string') fail('RESTORE_DATABASE_READ_FAILED');
  const bytes = Buffer.from(rowJson, 'utf8');
  // Length framing distinguishes rows without parsing/re-rounding bigint values.
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}
export function fingerprintRows(rowJsonStrings) {
  const hash = crypto.createHash('sha256');
  let rows = 0;
  for (const rowJson of rowJsonStrings) { addRow(hash, rowJson); rows += 1; }
  return { rows, sha256: hash.digest('hex') };
}
export function validateLedger(ledger, migrations) {
  if (!Array.isArray(ledger) || ledger.length !== migrations.length) fail('RESTORE_LEDGER_MISMATCH');
  const expected = new Map(migrations.map(migration => [migration.name, migration.checksum]));
  const seen = new Set();
  for (const row of ledger) {
    if (seen.has(row.name) || !expected.has(row.name) || expected.get(row.name) !== row.checksum) fail('RESTORE_LEDGER_MISMATCH');
    seen.add(row.name);
  }
}
export function compareSnapshots(source, target, migrations) {
  validateLedger(source.ledger, migrations);
  validateLedger(target.ledger, migrations);
  if (['cases', 'messages', 'assets'].some(kind => !(source.representative?.[kind] > 0))) fail('RESTORE_SOURCE_NOT_POPULATED');
  for (const { label } of RESTORE_TABLES) {
    const left = source.tables?.[label];
    const right = target.tables?.[label];
    if (!left || !right || left.rows !== right.rows || left.sha256 !== right.sha256) fail('RESTORE_DATA_MISMATCH');
  }
  return {
    ok: true,
    tables: RESTORE_TABLES.map(({ label }) => ({ table: label, rows: source.tables[label].rows, sha256: source.tables[label].sha256 })),
    representative: { cases: source.representative.cases, messages: source.representative.messages, assets: source.representative.assets }
  };
}

// Only the fixed schema identifiers above enter SQL. C collation makes paging
// deterministic across locales; full to_jsonb text preserves all columns,
// large JSON numerics and bigint fields. UTC makes timestamp text stable.
export async function readDatabaseSnapshot(client, migrations, { pageSize = 100 } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) fail('RESTORE_CONFIGURATION_INVALID');
  const snapshot = { tables: {}, representative: { cases: 0, messages: 0, assets: 0 }, ledger: [] };
  let started = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    started = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    for (const { label, table, key } of RESTORE_TABLES) {
      const hash = crypto.createHash('sha256');
      let rows = 0;
      let after = null;
      while (true) {
        const result = await client.query(
          `SELECT ${key} AS scan_key, to_jsonb(t)::text AS row_json FROM ${table} AS t ${after === null ? '' : `WHERE ${key} COLLATE "C" > $1 COLLATE "C"`} ORDER BY ${key} COLLATE "C" LIMIT $${after === null ? 1 : 2}`,
          after === null ? [pageSize] : [after, pageSize]
        );
        if (result.rows.length > pageSize) fail('RESTORE_DATABASE_READ_FAILED');
        for (const row of result.rows) {
          addRow(hash, row.row_json);
          rows += 1;
          if (label === 'docs') {
            const kind = /^inboxes\/[^/]+\/(cases|messages|assets)\/[^/]+\.json$/.exec(row.scan_key)?.[1];
            if (kind) snapshot.representative[kind] += 1;
          }
          if (label === 'migration_ledger') {
            const ledgerRow = JSON.parse(row.row_json);
            snapshot.ledger.push({ name: ledgerRow.name, checksum: ledgerRow.checksum });
          }
        }
        if (result.rows.length < pageSize) break;
        after = result.rows.at(-1).scan_key;
        if (typeof after !== 'string') fail('RESTORE_DATABASE_READ_FAILED');
      }
      snapshot.tables[label] = { rows, sha256: hash.digest('hex') };
    }
    validateLedger(snapshot.ledger, migrations);
    return snapshot;
  } catch (error) {
    if (error instanceof RestoreVerificationError) throw error;
    fail('RESTORE_DATABASE_READ_FAILED');
  } finally {
    if (started) await client.query('ROLLBACK').catch(() => {});
  }
}
export async function verifyRestoredData(env = process.env) {
  const options = validateRestoreConfiguration(env);
  let migrations;
  try { migrations = await loadMigrations(); } catch { fail('RESTORE_MIGRATIONS_UNAVAILABLE'); }
  const source = new pg.Client(options.source);
  const target = new pg.Client(options.target);
  try {
    try { await Promise.all([source.connect(), target.connect()]); } catch { fail('RESTORE_CONNECTION_FAILED'); }
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      readDatabaseSnapshot(source, migrations), readDatabaseSnapshot(target, migrations)
    ]);
    return compareSnapshots(sourceSnapshot, targetSnapshot, migrations);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyRestoredData())); }
  catch (error) { console.error(JSON.stringify(safeRestoreDiagnostic(error))); process.exitCode = 1; }
}
