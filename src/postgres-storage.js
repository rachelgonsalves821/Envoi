import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

export class PostgresStore {
  constructor(connectionString) { this.pool = new Pool({ connectionString, max: Number(process.env.SINALOA_DB_POOL_SIZE || 10), ssl: process.env.SINALOA_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined }); }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sinaloa_documents (
        path TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS sinaloa_documents_path_prefix ON sinaloa_documents (path text_pattern_ops);
      CREATE TABLE IF NOT EXISTS sinaloa_outbox (
        id TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TIMESTAMPTZ NOT NULL,
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        last_error TEXT,
        delivered_at TIMESTAMPTZ,
        dead_lettered_at TIMESTAMPTZ,
        delivery_sequence BIGSERIAL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE sinaloa_outbox ADD COLUMN IF NOT EXISTS delivery_sequence BIGSERIAL;
      CREATE INDEX IF NOT EXISTS sinaloa_outbox_delivery_queue ON sinaloa_outbox (status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS sinaloa_outbox_conversation_order ON sinaloa_outbox ((value->>'orderingKey'), delivery_sequence);
    `);
  }
  async ensureInbox() {}
  async putJson(relative, value) { await this.pool.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [relative.replaceAll('\\', '/'), value]); }
  async writeDocuments(client, documents) {
    for (const document of documents) {
      await client.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [document.path.replaceAll('\\', '/'), document.value]);
    }
  }
  async putJsonBatch(documents) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeDocuments(client, documents);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  rowToOutbox(row) {
    if (!row) return null;
    return {
      ...row.value,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: new Date(row.available_at).toISOString(),
      lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
      lockedBy: row.locked_by,
      lastError: row.last_error,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
      deadLetteredAt: row.dead_lettered_at ? new Date(row.dead_lettered_at).toISOString() : null,
      sequence: Number(row.delivery_sequence),
      updatedAt: new Date(row.updated_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString()
    };
  }
  async enqueueOutbox(documents, record) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [record.id]);
      const existing = await client.query('SELECT * FROM sinaloa_outbox WHERE id = $1', [record.id]);
      if (existing.rowCount) { await client.query('ROLLBACK'); return { ...this.rowToOutbox(existing.rows[0]), enqueueCreated: false }; }
      await this.writeDocuments(client, documents);
      const result = await client.query(`INSERT INTO sinaloa_outbox(id, value, status, attempts, max_attempts, available_at, created_at, updated_at)
        VALUES($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`, [record.id, record, record.status, record.attempts || 0, record.maxAttempts || 5, record.availableAt, record.createdAt]);
      await client.query('COMMIT');
      return { ...this.rowToOutbox(result.rows[0]), enqueueCreated: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async getOutbox(id) { const result = await this.pool.query('SELECT * FROM sinaloa_outbox WHERE id = $1', [id]); return this.rowToOutbox(result.rows[0]); }
  async queryOutbox({ inboxId = null, status = null, limit = 100 } = {}) {
    const values = [];
    const conditions = [];
    if (inboxId) { values.push(inboxId); conditions.push(`(value->>'senderInboxId' = $${values.length} OR value->>'recipientInboxId' = $${values.length})`); }
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
    values.push(Math.max(1, Math.min(Number(limit) || 100, 200)));
    const result = await this.pool.query(`SELECT * FROM sinaloa_outbox ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(row => this.rowToOutbox(row));
  }
  async claimOutbox(workerId, leaseMs = 30_000) {
    const result = await this.pool.query(`WITH candidate AS (
      SELECT pending.id FROM sinaloa_outbox AS pending
      WHERE ((pending.status IN ('queued', 'retrying') AND pending.available_at <= NOW())
        OR (pending.status = 'processing' AND pending.locked_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond')))
      AND NOT EXISTS (
        SELECT 1 FROM sinaloa_outbox AS earlier
        WHERE earlier.id <> pending.id
          AND earlier.value->>'orderingKey' = pending.value->>'orderingKey'
          AND earlier.status NOT IN ('delivered', 'deadLettered')
          AND earlier.delivery_sequence < pending.delivery_sequence
      )
      ORDER BY pending.available_at, pending.delivery_sequence
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE sinaloa_outbox AS outbox
    SET status = 'processing', locked_at = NOW(), locked_by = $1, updated_at = NOW()
    FROM candidate WHERE outbox.id = candidate.id RETURNING outbox.*`, [workerId, leaseMs]);
    return this.rowToOutbox(result.rows[0]);
  }
  async completeOutbox(id, documents, resultValue = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET status = 'delivered', delivered_at = NOW(), updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, value = value || $2::jsonb WHERE id = $1 RETURNING *`, [id, JSON.stringify({ result: resultValue })]);
      await client.query('COMMIT');
      return this.rowToOutbox(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async failOutbox(id, documents, { error, nextAttemptAt, forceDeadLetter = false }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET
        attempts = attempts + 1,
        status = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN 'deadLettered' ELSE 'retrying' END,
        available_at = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN available_at ELSE $3 END,
        dead_lettered_at = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN NOW() ELSE NULL END,
        updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = $2
        WHERE id = $1 RETURNING *`, [id, error, nextAttemptAt, forceDeadLetter]);
      await client.query('COMMIT');
      return this.rowToOutbox(result.rows[0]);
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally { client.release(); }
  }
  async retryOutbox(id, documents = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET status = 'queued', attempts = 0, available_at = NOW(), updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, dead_lettered_at = NULL WHERE id = $1 AND status = 'deadLettered' RETURNING *`, [id]);
      await client.query('COMMIT');
      return this.rowToOutbox(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
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
