import pg from 'pg';
import crypto from 'node:crypto';
import { runMigrations } from './migrations.js';
import { createPostgresOptions } from './postgres-options.js';

const { Pool } = pg;

export class PostgresStore {
  constructor(connectionString) { this.pool = new Pool(createPostgresOptions(connectionString)); }
  async init() {
    await runMigrations(this.pool);
  }
  async ensureInbox() {}
  async nextEventSequence(inboxId) {
    const result = await this.pool.query(`INSERT INTO sinaloa_event_sequences(inbox_id, value) VALUES($1, 1)
      ON CONFLICT(inbox_id) DO UPDATE SET value = sinaloa_event_sequences.value + 1 RETURNING value`, [inboxId]);
    return Number(result.rows[0].value);
  }
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
  async reserveObjectQuota(workspaceId, bytes, quotaBytes, reservationTtlMs = 1_200_000) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO sinaloa_object_quota_usage(workspace_id, quota_bytes) VALUES($1, $2)
        ON CONFLICT(workspace_id) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes, updated_at = NOW()`, [workspaceId, quotaBytes]);
      const usage = await client.query('SELECT * FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
      const row = usage.rows[0];
      const expired = await client.query(`UPDATE sinaloa_object_quota_reservations SET status = 'released', updated_at = NOW()
        WHERE workspace_id = $1 AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= NOW() RETURNING bytes`, [workspaceId]);
      const expiredBytes = expired.rows.reduce((total, value) => total + Number(value.bytes), 0);
      if (expiredBytes) await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW() WHERE workspace_id = $1', [workspaceId, expiredBytes]);
      const activeReserved = Number(row.reserved_bytes) - expiredBytes;
      if (Number(row.used_bytes) + activeReserved + bytes > quotaBytes) throw Object.assign(new Error('Workspace object quota exceeded'), { code: 'QUOTA_EXCEEDED', statusCode: 413 });
      const createdAt = new Date();
      const reservation = { id: `quota_${crypto.randomUUID()}`, workspaceId, bytes, state: 'reserved', createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + reservationTtlMs).toISOString() };
      await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = reserved_bytes + $2, updated_at = NOW() WHERE workspace_id = $1', [workspaceId, bytes]);
      await client.query('INSERT INTO sinaloa_object_quota_reservations(id, workspace_id, bytes, status, created_at, expires_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $5)', [reservation.id, workspaceId, bytes, reservation.state, reservation.createdAt, reservation.expiresAt]);
      await client.query('COMMIT');
      return reservation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async settleObjectQuota(reservationId, commit) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM sinaloa_object_quota_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
      const reservation = result.rows[0];
      if (!reservation) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
      const expired = reservation.status === 'reserved' && reservation.expires_at && new Date(reservation.expires_at) <= new Date();
      if (reservation.status === 'reserved') {
        await client.query(`UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), used_bytes = used_bytes + $3, updated_at = NOW() WHERE workspace_id = $1`, [reservation.workspace_id, Number(reservation.bytes), commit ? Number(reservation.bytes) : 0]);
        await client.query('UPDATE sinaloa_object_quota_reservations SET status = $2, updated_at = NOW() WHERE id = $1', [reservationId, expired ? 'released' : commit ? 'committed' : 'released']);
        reservation.status = expired ? 'released' : commit ? 'committed' : 'released';
      }
      await client.query('COMMIT');
      if (expired && commit) throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
      if (commit && reservation.status === 'released') throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
      return { id: reservation.id, workspaceId: reservation.workspace_id, bytes: Number(reservation.bytes), state: reservation.status, createdAt: new Date(reservation.created_at).toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  commitObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, true); }
  releaseObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, false); }
  async reclaimExpiredObjectQuota(now = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const workspaces = await client.query(`SELECT DISTINCT workspace_id FROM sinaloa_object_quota_reservations
        WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= $1`, [now]);
      let releasedReservations = 0;
      let releasedBytes = 0;
      for (const { workspace_id: workspaceId } of workspaces.rows) {
        await client.query('SELECT workspace_id FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
        const expired = await client.query(`UPDATE sinaloa_object_quota_reservations SET status = 'released', updated_at = NOW()
          WHERE workspace_id = $1 AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= $2 RETURNING bytes`, [workspaceId, now]);
        const bytes = expired.rows.reduce((total, value) => total + Number(value.bytes), 0);
        if (bytes) await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW() WHERE workspace_id = $1', [workspaceId, bytes]);
        releasedReservations += expired.rowCount;
        releasedBytes += bytes;
      }
      await client.query('COMMIT');
      return { releasedReservations, releasedBytes };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async objectQuotaUsage(workspaceId, quotaBytes) {
    const result = await this.pool.query('SELECT * FROM sinaloa_object_quota_usage WHERE workspace_id = $1', [workspaceId]);
    const row = result.rows[0];
    return row ? { workspaceId, used: Number(row.used_bytes), reserved: Number(row.reserved_bytes), quota: Number(row.quota_bytes) } : { workspaceId, used: 0, reserved: 0, quota: quotaBytes };
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
