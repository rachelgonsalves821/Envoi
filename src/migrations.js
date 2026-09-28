import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const checksum = sql => crypto.createHash('sha256').update(sql).digest('hex');

export async function loadMigrations(directory = new URL('../db/', import.meta.url)) {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  if (!names.length) throw new Error('No database migrations were found');
  return Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: checksum(sql) };
  }));
}

export async function runMigrations(pool, { directory, logger = console } = {}) {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('sinaloa-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS sinaloa_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const appliedResult = await client.query('SELECT name, checksum FROM sinaloa_schema_migrations ORDER BY name');
    const applied = new Map(appliedResult.rows.map(row => [row.name, row.checksum]));
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        if (applied.get(migration.name) !== migration.checksum) throw new Error(`Applied migration checksum changed: ${migration.name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO sinaloa_schema_migrations(name, checksum) VALUES($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
        logger.info?.(`Applied database migration ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied: migrations.map(migration => migration.name), count: migrations.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('sinaloa-schema-migrations'))").catch(() => {});
    client.release();
  }
}
