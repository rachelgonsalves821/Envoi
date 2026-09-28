import crypto from 'node:crypto';

const JOB_PREFIX = 'object-storage/scan-jobs/';
const TERMINAL_SCAN_STATES = new Set(['clean', 'infected']);

function copy(value) { return structuredClone(value); }
function frozen(value) { return Object.freeze(copy(value)); }
function iso(value) { return (value instanceof Date ? value : new Date(value)).toISOString(); }
function jobPath(id) { return `${JOB_PREFIX}${id}.json`; }

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer of at least ${minimum}`);
  return value;
}

function safeError(error) {
  const message = String(error?.message || 'Malware scan failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, 500);
  return { code: String(error?.code || 'SCAN_FAILED').slice(0, 80), message };
}

function isRetryable(error) {
  return !['CHECKSUM_MISMATCH', 'OBJECT_NOT_FOUND', 'UPLOAD_VERIFICATION_FAILED', 'INVALID_SCAN_RESULT'].includes(error?.code);
}

export class InMemoryMalwareScanJobStore {
  #jobs = new Map();

  async enqueue(job) {
    const current = this.#jobs.get(job.id);
    if (current) return frozen(current);
    this.#jobs.set(job.id, copy(job));
    return frozen(job);
  }

  async get(id) { return this.#jobs.has(id) ? frozen(this.#jobs.get(id)) : null; }

  async claim(id, workerId, leaseMs, now = new Date()) {
    const job = this.#jobs.get(id);
    if (!job || !this.#claimable(job, now)) return null;
    return this.#lease(job, workerId, leaseMs, now);
  }

  async claimNext(workerId, leaseMs, now = new Date()) {
    const next = [...this.#jobs.values()]
      .filter(job => this.#claimable(job, now))
      .sort((a, b) => String(a.availableAt).localeCompare(String(b.availableAt)) || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    return next ? this.#lease(next, workerId, leaseMs, now) : null;
  }

  async complete(id, workerId, outcome) {
    const job = this.#owned(id, workerId, 'processing');
    Object.assign(job, outcome, { lockedBy: null, lockedAt: null, leaseExpiresAt: null, updatedAt: outcome.completedAt });
    return frozen(job);
  }

  async fail(id, workerId, failure) {
    const job = this.#owned(id, workerId, 'processing');
    Object.assign(job, failure, { lockedBy: null, lockedAt: null, leaseExpiresAt: null, updatedAt: failure.failedAt });
    return frozen(job);
  }

  async claimRetention(workerId, leaseMs, now = new Date()) {
    const nowMs = new Date(now).getTime();
    const next = [...this.#jobs.values()]
      .filter(job => (['clean', 'infected', 'deadLettered'].includes(job.status) && job.retentionUntil && new Date(job.retentionUntil).getTime() <= nowMs)
        || (job.status === 'retentionProcessing' && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs))
      .sort((a, b) => String(a.retentionUntil).localeCompare(String(b.retentionUntil)))[0];
    if (!next) return null;
    next.statusBeforeRetention = next.status === 'retentionProcessing' ? next.statusBeforeRetention : next.status;
    return this.#lease(next, workerId, leaseMs, now, 'retentionProcessing');
  }

  async finishRetention(id, workerId) {
    this.#owned(id, workerId, 'retentionProcessing');
    this.#jobs.delete(id);
    return true;
  }

  async deferRetention(id, workerId, retentionUntil, error) {
    const job = this.#owned(id, workerId, 'retentionProcessing');
    Object.assign(job, { status: job.statusBeforeRetention, statusBeforeRetention: null, retentionUntil, retentionError: safeError(error), lockedBy: null, lockedAt: null, leaseExpiresAt: null, updatedAt: iso(new Date()) });
    return frozen(job);
  }

  #claimable(job, now) {
    const nowMs = new Date(now).getTime();
    return (['queued', 'retrying'].includes(job.status) && new Date(job.availableAt).getTime() <= nowMs)
      || (job.status === 'processing' && new Date(job.leaseExpiresAt).getTime() <= nowMs);
  }

  #lease(job, workerId, leaseMs, now, status = 'processing') {
    const timestamp = iso(now);
    Object.assign(job, { status, lockedBy: workerId, lockedAt: timestamp, leaseExpiresAt: iso(new Date(new Date(now).getTime() + leaseMs)), updatedAt: timestamp });
    return frozen(job);
  }

  #owned(id, workerId, status) {
    const job = this.#jobs.get(id);
    if (!job || job.status !== status || job.lockedBy !== workerId) throw new Error('Malware scan job lease was lost');
    return job;
  }
}

export class PostgresMalwareScanJobStore {
  constructor(storeOrPool) {
    this.pool = storeOrPool?.pool ?? storeOrPool;
    if (!this.pool || typeof this.pool.query !== 'function') throw new TypeError('A PostgreSQL pool or PostgresStore is required');
  }

  async enqueue(job) {
    const result = await this.pool.query(`INSERT INTO sinaloa_documents(path, value) VALUES($1, $2)
      ON CONFLICT(path) DO UPDATE SET value = sinaloa_documents.value RETURNING value`, [jobPath(job.id), job]);
    return frozen(result.rows[0].value);
  }

  async get(id) {
    const result = await this.pool.query('SELECT value FROM sinaloa_documents WHERE path = $1', [jobPath(id)]);
    return result.rows[0] ? frozen(result.rows[0].value) : null;
  }

  claim(id, workerId, leaseMs, now = new Date()) {
    return this.#claimWhere('path = $4', [jobPath(id)], workerId, leaseMs, now);
  }

  claimNext(workerId, leaseMs, now = new Date()) {
    return this.#claimWhere(`path = (SELECT path FROM sinaloa_documents
      WHERE path LIKE $4 AND (((value->>'status') IN ('queued', 'retrying') AND (value->>'availableAt')::timestamptz <= $2::timestamptz)
        OR ((value->>'status') = 'processing' AND (value->>'leaseExpiresAt')::timestamptz <= $2::timestamptz))
      ORDER BY (value->>'availableAt')::timestamptz, value->>'createdAt' FOR UPDATE SKIP LOCKED LIMIT 1)`, [`${JOB_PREFIX}%`], workerId, leaseMs, now);
  }

  async #claimWhere(where, trailingValues, workerId, leaseMs, now) {
    const timestamp = iso(now);
    const leaseExpiresAt = iso(new Date(new Date(now).getTime() + leaseMs));
    const result = await this.pool.query(`UPDATE sinaloa_documents SET value = value || jsonb_build_object(
        'status', 'processing', 'lockedBy', $1::text, 'lockedAt', $2::text, 'leaseExpiresAt', $3::text, 'updatedAt', $2::text), updated_at = NOW()
      WHERE ${where}
        AND (((value->>'status') IN ('queued', 'retrying') AND (value->>'availableAt')::timestamptz <= $2::timestamptz)
          OR ((value->>'status') = 'processing' AND (value->>'leaseExpiresAt')::timestamptz <= $2::timestamptz))
      RETURNING value`, [workerId, timestamp, leaseExpiresAt, ...trailingValues]);
    return result.rows[0] ? frozen(result.rows[0].value) : null;
  }

  async complete(id, workerId, outcome) { return this.#finish(id, workerId, 'processing', outcome); }
  async fail(id, workerId, failure) { return this.#finish(id, workerId, 'processing', failure); }

  async #finish(id, workerId, expectedStatus, patch) {
    const value = { ...patch, lockedBy: null, lockedAt: null, leaseExpiresAt: null, updatedAt: patch.completedAt ?? patch.failedAt ?? patch.updatedAt };
    const result = await this.pool.query(`UPDATE sinaloa_documents SET value = value || $3::jsonb, updated_at = NOW()
      WHERE path = $1 AND value->>'status' = $4 AND value->>'lockedBy' = $2 RETURNING value`, [jobPath(id), workerId, JSON.stringify(value), expectedStatus]);
    if (!result.rows[0]) throw new Error('Malware scan job lease was lost');
    return frozen(result.rows[0].value);
  }

  async claimRetention(workerId, leaseMs, now = new Date()) {
    const timestamp = iso(now);
    const leaseExpiresAt = iso(new Date(new Date(now).getTime() + leaseMs));
    const result = await this.pool.query(`WITH candidate AS (
        SELECT path FROM sinaloa_documents WHERE path LIKE $1
          AND (((value->>'status') IN ('clean', 'infected', 'deadLettered') AND (value->>'retentionUntil')::timestamptz <= $2::timestamptz)
            OR ((value->>'status') = 'retentionProcessing' AND (value->>'leaseExpiresAt')::timestamptz <= $2::timestamptz))
        ORDER BY (value->>'retentionUntil')::timestamptz FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE sinaloa_documents AS document SET value = document.value || jsonb_build_object(
        'statusBeforeRetention', CASE WHEN document.value->>'status' = 'retentionProcessing' THEN document.value->>'statusBeforeRetention' ELSE document.value->>'status' END,
        'status', 'retentionProcessing', 'lockedBy', $3::text,
        'lockedAt', $2::text, 'leaseExpiresAt', $4::text, 'updatedAt', $2::text), updated_at = NOW()
      FROM candidate WHERE document.path = candidate.path RETURNING document.value`, [`${JOB_PREFIX}%`, timestamp, workerId, leaseExpiresAt]);
    return result.rows[0] ? frozen(result.rows[0].value) : null;
  }

  async finishRetention(id, workerId) {
    const result = await this.pool.query(`DELETE FROM sinaloa_documents WHERE path = $1
      AND value->>'status' = 'retentionProcessing' AND value->>'lockedBy' = $2 RETURNING path`, [jobPath(id), workerId]);
    if (!result.rowCount) throw new Error('Malware scan retention lease was lost');
    return true;
  }

  async deferRetention(id, workerId, retentionUntil, error) {
    const job = await this.get(id);
    if (!job || job.status !== 'retentionProcessing' || job.lockedBy !== workerId) throw new Error('Malware scan retention lease was lost');
    return this.#finish(id, workerId, 'retentionProcessing', {
      status: job.statusBeforeRetention,
      statusBeforeRetention: null,
      retentionUntil,
      retentionError: safeError(error),
      updatedAt: iso(new Date())
    });
  }
}

export class DurableMalwareScanLifecycle {
  constructor({
    jobStore, adapter, metadataStore, quotaLedger, scanner, maxAttempts = 5, leaseMs = 60_000,
    retryBaseMs = 5_000, retryMaxMs = 15 * 60_000, infectedRetentionMs = 30 * 24 * 60 * 60_000,
    deadLetterRetentionMs = 7 * 24 * 60 * 60_000, completedJobRetentionMs = 90 * 24 * 60 * 60_000,
    retentionRetryMs = 60 * 60_000, clock = () => new Date(), random = Math.random
  } = {}) {
    if (!jobStore || !['enqueue', 'get', 'claim', 'claimNext', 'complete', 'fail', 'claimRetention', 'finishRetention', 'deferRetention'].every(method => typeof jobStore[method] === 'function')) throw new TypeError('A durable malware scan job store is required');
    if (!adapter || !['getObject', 'deleteObject'].every(method => typeof adapter[method] === 'function')) throw new TypeError('An object adapter is required');
    if (!metadataStore || !['get', 'updateScan'].every(method => typeof metadataStore[method] === 'function')) throw new TypeError('An object metadata store is required');
    if (!quotaLedger || typeof quotaLedger.deleteCommitted !== 'function') throw new TypeError('A quota ledger with committed-byte deletion is required');
    if (!scanner || typeof scanner.scan !== 'function') throw new TypeError('A malware scanner is required');
    this.jobStore = jobStore;
    this.adapter = adapter;
    this.metadataStore = metadataStore;
    this.quotaLedger = quotaLedger;
    this.scanner = scanner;
    this.config = {
      maxAttempts: positiveInteger(maxAttempts, 'maxAttempts'), leaseMs: positiveInteger(leaseMs, 'leaseMs', 1_000),
      retryBaseMs: positiveInteger(retryBaseMs, 'retryBaseMs'), retryMaxMs: positiveInteger(retryMaxMs, 'retryMaxMs'),
      infectedRetentionMs: positiveInteger(infectedRetentionMs, 'infectedRetentionMs'), deadLetterRetentionMs: positiveInteger(deadLetterRetentionMs, 'deadLetterRetentionMs'),
      completedJobRetentionMs: positiveInteger(completedJobRetentionMs, 'completedJobRetentionMs'), retentionRetryMs: positiveInteger(retentionRetryMs, 'retentionRetryMs')
    };
    this.clock = clock;
    this.random = random;
  }

  async enqueue(objectId) {
    const object = await this.metadataStore.get(objectId);
    if (!object) throw Object.assign(new Error('Object metadata was not found'), { code: 'OBJECT_NOT_FOUND', statusCode: 404 });
    if (TERMINAL_SCAN_STATES.has(object.state)) return null;
    const now = iso(this.clock());
    return this.jobStore.enqueue({
      id: `scan_${objectId}`, objectId, status: 'queued', attempts: 0, maxAttempts: this.config.maxAttempts,
      availableAt: now, lockedBy: null, lockedAt: null, leaseExpiresAt: null, lastError: null,
      retentionUntil: null, createdAt: now, updatedAt: now
    });
  }

  async processObject(objectId, workerId = `inline-${crypto.randomUUID()}`) {
    const job = await this.enqueue(objectId);
    if (!job) return this.metadataStore.get(objectId);
    const claimed = await this.jobStore.claim(job.id, workerId, this.config.leaseMs, this.clock());
    if (!claimed) throw Object.assign(new Error('Malware scan is queued or already processing'), { code: 'SCAN_NOT_CLAIMABLE', statusCode: 409 });
    return this.#process(claimed, workerId);
  }

  async processNext(workerId) {
    const claimed = await this.jobStore.claimNext(workerId, this.config.leaseMs, this.clock());
    return claimed ? this.#process(claimed, workerId) : null;
  }

  async #process(job, workerId) {
    const now = this.clock();
    try {
      const object = await this.metadataStore.get(job.objectId);
      if (!object) throw Object.assign(new Error('Object metadata was not found'), { code: 'OBJECT_NOT_FOUND' });
      if (TERMINAL_SCAN_STATES.has(object.state)) {
        await this.jobStore.complete(job.id, workerId, this.#completion(object.state, now));
        return object;
      }
      const body = await this.adapter.getObject(object.key);
      if (!body) throw Object.assign(new Error('Object is missing from storage'), { code: 'OBJECT_NOT_FOUND' });
      if (body.length !== object.size || crypto.createHash('sha256').update(body).digest('base64') !== object.checksumSha256) {
        throw Object.assign(new Error('Stored object failed immutable size or checksum verification'), { code: 'CHECKSUM_MISMATCH' });
      }
      const result = await this.scanner.scan({ body, object });
      if (!result || !TERMINAL_SCAN_STATES.has(result.status)) throw Object.assign(new Error('Scanner returned an invalid result'), { code: 'INVALID_SCAN_RESULT' });
      const scannedAt = iso(now);
      const updated = await this.metadataStore.updateScan(object.id, { state: result.status, scannedAt, result: { status: result.status, engine: result.engine ?? null, signature: result.signature ?? null } });
      await this.jobStore.complete(job.id, workerId, this.#completion(result.status, now, scannedAt));
      return updated;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const retryable = isRetryable(error);
      const deadLettered = !retryable || attempts >= Number(job.maxAttempts || this.config.maxAttempts);
      const delay = this.#retryDelay(attempts);
      const failedAt = iso(now);
      const nextAttemptAt = iso(new Date(now.getTime() + delay));
      const retentionUntil = deadLettered ? iso(new Date(now.getTime() + this.config.deadLetterRetentionMs)) : null;
      const failure = {
        status: deadLettered ? 'deadLettered' : 'retrying', attempts, availableAt: deadLettered ? job.availableAt : nextAttemptAt,
        failedAt, deadLetteredAt: deadLettered ? failedAt : null, retentionUntil, lastError: safeError(error)
      };
      await this.jobStore.fail(job.id, workerId, failure);
      await this.metadataStore.updateScan(job.objectId, {
        state: 'error', scannedAt: failedAt,
        result: { status: 'error', ...safeError(error), attempts, retryable: !deadLettered, nextAttemptAt: deadLettered ? null : nextAttemptAt, deadLetteredAt: deadLettered ? failedAt : null }
      });
      error.scanJob = frozen(failure);
      throw error;
    }
  }

  async reapRetention(workerId) {
    const job = await this.jobStore.claimRetention(workerId, this.config.leaseMs, this.clock());
    if (!job) return null;
    try {
      if (['infected', 'deadLettered'].includes(job.statusBeforeRetention)) {
        const object = await this.metadataStore.get(job.objectId);
        if (object) {
          await this.adapter.deleteObject(object.key);
          await this.quotaLedger.deleteCommitted(object.reservationId);
          await this.metadataStore.updateScan(object.id, {
            state: 'deleted', scannedAt: iso(this.clock()),
            result: { status: 'deleted', reason: `${job.statusBeforeRetention} retention expired`, previousScan: object.scan ?? null }
          });
        }
      }
      await this.jobStore.finishRetention(job.id, workerId);
      return frozen({ id: job.id, objectId: job.objectId, action: job.statusBeforeRetention === 'clean' ? 'purged-job' : 'deleted-object' });
    } catch (error) {
      await this.jobStore.deferRetention(job.id, workerId, iso(new Date(this.clock().getTime() + this.config.retentionRetryMs)), error);
      throw error;
    }
  }

  #completion(status, now, completedAt = iso(now)) {
    const retentionMs = status === 'infected' ? this.config.infectedRetentionMs : this.config.completedJobRetentionMs;
    return { status, completedAt, retentionUntil: iso(new Date(now.getTime() + retentionMs)), lastError: null };
  }

  #retryDelay(attempts) {
    const exponential = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * (2 ** Math.max(0, attempts - 1)));
    return Math.max(1, Math.round(exponential * (0.8 + this.random() * 0.4)));
  }
}
