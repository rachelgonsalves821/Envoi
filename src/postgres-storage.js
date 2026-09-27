import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

export class PostgresStore {
  constructor(connectionString) { this.pool = new Pool({ connectionString, max: Number(process.env.SINALOA_DB_POOL_SIZE || 10), ssl: process.env.SINALOA_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sinaloa_documents (path TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE INDEX IF NOT EXISTS sinaloa_documents_path_prefix ON sinaloa_documents (path text_pattern_ops);`);
  }
  async ensureInbox() {}
  async putJson(relative, value) { await this.pool.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [relative.replaceAll('\\', '/'), value]); }
  async getJson(relative, fallback = null) { const result = await this.pool.query('SELECT value FROM sinaloa_documents WHERE path = $1', [relative.replaceAll('\\', '/')]); return result.rows[0]?.value ?? fallback; }
  async listJson(relativeDir) { const prefix = `${relativeDir.replaceAll('\\', '/')}/`; const result = await this.pool.query('SELECT value FROM sinaloa_documents WHERE path LIKE $1 ORDER BY path', [`${prefix}%`]); return result.rows.filter((row) => row.value && typeof row.value === 'object' && !Array.isArray(row.value)).map((row) => row.value); }
  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
  now() { return new Date().toISOString(); }
  async close() { await this.pool.end(); }
}
