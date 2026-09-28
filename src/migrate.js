import pg from 'pg';
import { runMigrations } from './migrations.js';
import { createPostgresOptions } from './postgres-options.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');

const pool = new Pool(createPostgresOptions(connectionString, process.env, { max: 1 }));

try {
  const result = await runMigrations(pool);
  console.log(`Database schema is current (${result.count} migrations)`);
} finally {
  await pool.end();
}
