import pg from 'pg';
import { runMigrations } from './migrations.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');

const pool = new Pool({
  connectionString,
  max: 1,
  ssl: process.env.SINALOA_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

try {
  const result = await runMigrations(pool);
  console.log(`Database schema is current (${result.count} migrations)`);
} finally {
  await pool.end();
}
