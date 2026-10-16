import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDatabaseTarget, databaseTargetFingerprint, parseConsumerApplicationName } from '../src/consumer-identity.js';
import { createPostgresOptions } from '../src/postgres-options.js';

export async function inspectQueueConsumers(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const connections = await client.query("SELECT pid, application_name FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY pid");
    const leases = await client.query("SELECT locked_by, COUNT(*)::integer AS lease_count FROM sinaloa_outbox WHERE status = 'processing' GROUP BY locked_by ORDER BY locked_by");
    return {
      connections: connections.rows.map(row => ({ processId: row.pid, ...parseConsumerApplicationName(row.application_name) })),
      leases: leases.rows.map(row => ({ workerId: /^delivery_[a-f0-9-]{36}$/.test(String(row.locked_by)) ? row.locked_by : null, leaseCount: row.lease_count }))
    };
  } finally { await client.query('ROLLBACK'); }
}

export async function queueConsumerReport(mode, env = process.env, createClient = options => new pg.Client(options)) {
  if (!['fingerprint', 'inventory'].includes(mode)) throw new Error('Use fingerprint or inventory');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required in the private environment');
  const fingerprint = databaseTargetFingerprint(env.DATABASE_URL);
  if (mode === 'fingerprint') return { databaseFingerprint: fingerprint, connected: false };
  if (!env.ENVOI_EXPECTED_DATABASE_FINGERPRINT) throw new Error('Pin ENVOI_EXPECTED_DATABASE_FINGERPRINT before inventory');
  assertDatabaseTarget(env.DATABASE_URL, env.ENVOI_EXPECTED_DATABASE_FINGERPRINT);
  const client = createClient(createPostgresOptions(env.DATABASE_URL, env, { max: 1, applicationName: 'envoi-queue-inventory' }));
  try { await client.connect(); return { databaseFingerprint: fingerprint, ...await inspectQueueConsumers(client) }; }
  finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one mode');
    console.log(JSON.stringify(await queueConsumerReport(process.argv[2]), null, 2));
  } catch { console.error(JSON.stringify({ error: 'QUEUE_CONSUMER_INSPECTION_FAILED', guidance: 'Use fingerprint or inventory with private DATABASE_URL, verified TLS and an explicit matching target pin. No database changes are performed.' })); process.exitCode = 1; }
}
