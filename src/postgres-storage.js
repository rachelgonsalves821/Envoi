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
  async putJsonIfAbsent(relative, value) { const result = await this.pool.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO NOTHING RETURNING path', [relative.replaceAll('\\', '/'), value]); return result.rowCount === 1; }
  async claimJson(relative, field, value) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)) throw new Error('Invalid claim field');
    const result = await this.pool.query(`UPDATE sinaloa_documents SET value = jsonb_set(value, $2, to_jsonb($3::text)), updated_at = NOW() WHERE path = $1 AND (value->>$4) IS NULL RETURNING value`, [relative.replaceAll('\\', '/'), `{${field}}`, value, field]);
    return result.rows[0]?.value ?? null;
  }
  async getJson(relative, fallback = null) { const result = await this.pool.query('SELECT value FROM sinaloa_documents WHERE path = $1', [relative.replaceAll('\\', '/')]); return result.rows[0]?.value ?? fallback; }
  async deleteJson(relative) { const result = await this.pool.query('DELETE FROM sinaloa_documents WHERE path = $1', [relative.replaceAll('\\', '/')]); return result.rowCount === 1; }
  async listJson(relativeDir) { const prefix = `${relativeDir.replaceAll('\\', '/')}/`; const result = await this.pool.query('SELECT value FROM sinaloa_documents WHERE path LIKE $1 ORDER BY path', [`${prefix}%`]); return result.rows.filter((row) => row.value && typeof row.value === 'object' && !Array.isArray(row.value)).map((row) => row.value); }
  async queryJson(relativeDir, { limit = 100, before = null, filters = {}, sortField = 'createdAt' } = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(sortField)) throw new Error('Invalid sort field');
    const values = [`${relativeDir.replaceAll('\\', '/')}/%`];
    const conditions = ['path LIKE $1'];
    for (const [key, value] of Object.entries(filters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error('Invalid filter field');
      values.push(key, String(value));
      conditions.push(`value->>$${values.length - 1} = $${values.length}`);
    }
    if (before) { values.push(sortField, before); conditions.push(`value->>$${values.length - 1} < $${values.length}`); }
    values.push(Math.max(1, Math.min(Number(limit) || 100, 200)));
    const result = await this.pool.query(`SELECT value FROM sinaloa_documents WHERE ${conditions.join(' AND ')} ORDER BY value->>'${sortField}' DESC LIMIT $${values.length}`, values);
    return result.rows.map(row => row.value);
  }
  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
  now() { return new Date().toISOString(); }
  async close() { await this.pool.end(); }
}
