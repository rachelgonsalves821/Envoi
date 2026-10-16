import './envoi-environment-bootstrap.js';
import pg from 'pg';
import { runMigrations } from './migrations.js';
import { createPostgresOptions } from './postgres-options.js';
import { configuredDeploymentIdentity, verifyDeploymentIdentityBeforeInit } from './deployment-identity.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');

const pool = new Pool(createPostgresOptions(connectionString, process.env, { max: 1 }));

try {
  // Migrate only this deployment's database. Stamping a new one is left to the server's first start.
  await verifyDeploymentIdentityBeforeInit({
    getJson: async relative => (await pool.query('SELECT value FROM sinaloa_documents WHERE path = $1', [relative])).rows[0]?.value ?? null
  }, configuredDeploymentIdentity());
  const result = await runMigrations(pool);
  console.log(`Database schema is current (${result.count} migrations)`);
} finally {
  await pool.end();
}
