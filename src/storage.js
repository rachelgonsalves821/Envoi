import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolvePathWithin } from './path-safety.js';

export class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.claims = new Set();
    this.outboxMutation = Promise.resolve();
    this.objectQuotaMutation = Promise.resolve();
    this.eventSequenceMutation = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  async ensureInbox(inboxId) {
    const dir = this.inboxDir(inboxId);
    await Promise.all([
      mkdir(path.join(dir, 'messages'), { recursive: true }),
      mkdir(path.join(dir, 'cases'), { recursive: true }),
      mkdir(path.join(dir, 'assets'), { recursive: true }),
      mkdir(path.join(dir, 'events'), { recursive: true }),
      mkdir(path.join(dir, 'agents'), { recursive: true }),
      mkdir(path.join(dir, 'contacts'), { recursive: true })
    ]);
    return dir;
  }

  inboxDir(inboxId) { return this.file('inboxes', inboxId); }
  file(...parts) { return resolvePathWithin(this.root, ...parts); }

  async putJson(relative, value) {
    const target = this.file(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value, null, 2));
  }

  async putJsonBatch(documents) {
    await Promise.all(documents.map(({ path: relative, value }) => this.putJson(relative, value)));
  }

  async withOutboxMutation(operation) {
    const pending = this.outboxMutation.then(operation, operation);
    this.outboxMutation = pending.catch(() => {});
    return pending;
  }

  async nextEventSequence(inboxId) {
    const operation = async () => {
      const relative = path.join('inboxes', inboxId, 'event-sequence.json');
      const current = await this.getJson(relative, { value: 0 });
      const value = Number(current.value || 0) + 1;
      await this.putJson(relative, { value });
      return value;
    };
    const pending = this.eventSequenceMutation.then(operation, operation);
    this.eventSequenceMutation = pending.catch(() => {});
    return pending;
  }

  async enqueueOutbox(documents, record) {
    return this.withOutboxMutation(async () => {
      const existing = await this.getOutbox(record.id);
      if (existing) return { ...existing, enqueueCreated: false };
      const records = await this.listJson('outbox');
      const persisted = { ...record, sequence: records.reduce((maximum, value) => Math.max(maximum, Number(value.sequence || 0)), 0) + 1 };
      await this.putJsonBatch(documents);
      await this.putJson(path.join('outbox', `${record.id}.json`), persisted);
      return { ...persisted, enqueueCreated: true };
    });
  }

  async getOutbox(id) { return this.getJson(path.join('outbox', `${id}.json`)); }

  async queryOutbox({ inboxId = null, status = null, limit = 100 } = {}) {
    const values = await this.listJson('outbox');
    return values
      .filter(value => !inboxId || value.senderInboxId === inboxId || value.recipientInboxId === inboxId)
      .filter(value => !status || value.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
  }

  async claimOutbox(workerId, leaseMs = 30_000) {
    return this.withOutboxMutation(async () => {
      const now = Date.now();
      const records = await this.listJson('outbox');
      const next = records
        .filter(record => {
          if (['queued', 'retrying'].includes(record.status)) return new Date(record.availableAt).getTime() <= now;
          return record.status === 'processing' && record.lockedAt && now - new Date(record.lockedAt).getTime() >= leaseMs;
        })
        .filter(record => !record.orderingKey || !records.some(earlier => earlier.id !== record.id
          && earlier.orderingKey === record.orderingKey
          && !['delivered', 'deadLettered'].includes(earlier.status)
          && Number(earlier.sequence || 0) < Number(record.sequence || 0)))
        .sort((a, b) => String(a.availableAt).localeCompare(String(b.availableAt)) || Number(a.sequence || 0) - Number(b.sequence || 0))[0];
      if (!next) return null;
      next.status = 'processing';
      next.lockedAt = this.now();
      next.lockedBy = workerId;
      next.updatedAt = next.lockedAt;
      await this.putJson(path.join('outbox', `${next.id}.json`), next);
      return next;
    });
  }

  async completeOutbox(id, documents, result = {}) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      if (!record) return null;
      const now = this.now();
      await this.putJsonBatch(documents);
      Object.assign(record, { status: 'delivered', deliveredAt: now, updatedAt: now, lockedAt: null, lockedBy: null, lastError: null, result });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async failOutbox(id, documents, { error, nextAttemptAt, forceDeadLetter = false }) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      if (!record) return null;
      const now = this.now();
      const attempts = Number(record.attempts || 0) + 1;
      const deadLettered = forceDeadLetter || attempts >= Number(record.maxAttempts || 5);
      await this.putJsonBatch(documents);
      Object.assign(record, {
        attempts,
        status: deadLettered ? 'deadLettered' : 'retrying',
        availableAt: deadLettered ? record.availableAt : nextAttemptAt,
        deadLetteredAt: deadLettered ? now : null,
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: error
      });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async retryOutbox(id, documents = []) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      if (!record || record.status !== 'deadLettered') return null;
      const now = this.now();
      await this.putJsonBatch(documents);
      Object.assign(record, { status: 'queued', attempts: 0, availableAt: now, updatedAt: now, lockedAt: null, lockedBy: null, lastError: null, deadLetteredAt: null });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async withObjectQuotaMutation(operation) {
    const pending = this.objectQuotaMutation.then(operation, operation);
    this.objectQuotaMutation = pending.catch(() => {});
    return pending;
  }

  async reclaimExpiredObjectQuotaUnsafe(now) {
    const reservations = await this.listJson(path.join('object-storage', 'quota-reservations'));
    const expired = reservations.filter(reservation => reservation.state === 'reserved' && reservation.expiresAt && new Date(reservation.expiresAt) <= new Date(now));
    if (!expired.length) return { releasedReservations: 0, releasedBytes: 0 };
    const usageByWorkspace = new Map();
    for (const reservation of expired) {
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = usageByWorkspace.get(reservation.workspaceId) ?? await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.reserved = Math.max(0, Number(usage.reserved || 0) - Number(reservation.bytes));
      usageByWorkspace.set(reservation.workspaceId, usage);
      reservation.state = 'released';
      reservation.releasedAt = now;
      reservation.updatedAt = now;
    }
    await this.putJsonBatch([
      ...[...usageByWorkspace.values()].map(usage => ({ path: path.join('object-storage', 'quota-usage', `${usage.workspaceId}.json`), value: usage })),
      ...expired.map(reservation => ({ path: path.join('object-storage', 'quota-reservations', `${reservation.id}.json`), value: reservation }))
    ]);
    return { releasedReservations: expired.length, releasedBytes: expired.reduce((total, reservation) => total + Number(reservation.bytes), 0) };
  }

  async reclaimExpiredObjectQuota(now = this.now()) {
    return this.withObjectQuotaMutation(() => this.reclaimExpiredObjectQuotaUnsafe(now));
  }

  async reserveObjectQuota(workspaceId, bytes, quotaBytes, reservationTtlMs = 1_200_000) {
    return this.withObjectQuotaMutation(async () => {
      const now = this.now();
      await this.reclaimExpiredObjectQuotaUnsafe(now);
      const usagePath = path.join('object-storage', 'quota-usage', `${workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId, used: 0, reserved: 0, quota: quotaBytes });
      if (Number(usage.used || 0) + Number(usage.reserved || 0) + bytes > quotaBytes) throw Object.assign(new Error('Workspace object quota exceeded'), { code: 'QUOTA_EXCEEDED', statusCode: 413 });
      const reservation = { id: `quota_${crypto.randomUUID()}`, workspaceId, bytes, state: 'reserved', createdAt: now, expiresAt: new Date(new Date(now).getTime() + reservationTtlMs).toISOString() };
      usage.reserved = Number(usage.reserved || 0) + bytes;
      usage.quota = quotaBytes;
      await this.putJsonBatch([
        { path: usagePath, value: usage },
        { path: path.join('object-storage', 'quota-reservations', `${reservation.id}.json`), value: reservation }
      ]);
      return reservation;
    });
  }

  async settleObjectQuota(reservationId, commit) {
    return this.withObjectQuotaMutation(async () => {
      const reservationPath = path.join('object-storage', 'quota-reservations', `${reservationId}.json`);
      const reservation = await this.getJson(reservationPath);
      if (!reservation) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
      if (reservation.state !== 'reserved') {
        if (commit && reservation.expiresAt && reservation.state === 'released') throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
        return reservation;
      }
      if (reservation.expiresAt && new Date(reservation.expiresAt) <= new Date()) {
        const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
        const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
        usage.reserved = Math.max(0, Number(usage.reserved || 0) - reservation.bytes);
        reservation.state = 'released';
        reservation.releasedAt = this.now();
        reservation.updatedAt = reservation.releasedAt;
        await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
        if (commit) throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
        return reservation;
      }
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.reserved = Math.max(0, Number(usage.reserved || 0) - reservation.bytes);
      if (commit) usage.used = Number(usage.used || 0) + reservation.bytes;
      reservation.state = commit ? 'committed' : 'released';
      reservation.updatedAt = this.now();
      await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
      return reservation;
    });
  }

  commitObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, true); }
  releaseObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, false); }
  async deleteCommittedObjectQuota(reservationId) {
    return this.withObjectQuotaMutation(async () => {
      const reservationPath = path.join('object-storage', 'quota-reservations', `${reservationId}.json`);
      const reservation = await this.getJson(reservationPath);
      if (!reservation) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
      if (reservation.state === 'released') return reservation;
      if (reservation.state !== 'committed') throw Object.assign(new Error('Object quota is not committed'), { code: 'QUOTA_NOT_COMMITTED', statusCode: 409 });
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.used = Math.max(0, Number(usage.used || 0) - Number(reservation.bytes));
      reservation.state = 'released';
      reservation.releasedAt = this.now();
      reservation.updatedAt = reservation.releasedAt;
      await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
      return reservation;
    });
  }
  async objectQuotaUsage(workspaceId, quotaBytes) { return this.getJson(path.join('object-storage', 'quota-usage', `${workspaceId}.json`), { workspaceId, used: 0, reserved: 0, quota: quotaBytes }); }

  async putJsonIfAbsent(relative, value) {
    const target = this.file(relative);
    await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, JSON.stringify(value, null, 2), { flag: 'wx' }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }

  async claimJson(relative, field, value) {
    if (this.claims.has(relative)) return null;
    this.claims.add(relative);
    try {
      const current = await this.getJson(relative);
      if (!current || current[field] != null) return null;
      current[field] = value;
      await this.putJson(relative, current);
      return current;
    } finally { this.claims.delete(relative); }
  }

  async getJson(relative, fallback = null) {
    try { return JSON.parse(await readFile(this.file(relative), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async deleteJson(relative) { try { await unlink(this.file(relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

  async listJson(relativeDir) {
    try {
      const names = await readdir(this.file(relativeDir));
      return Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => this.getJson(path.join(relativeDir, name))));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async queryJson(relativeDir, { limit = 100, before = null, filters = {}, sortField = 'createdAt' } = {}) {
    const items = await this.listJson(relativeDir);
    return items
      .filter(item => Object.entries(filters).every(([key, value]) => item[key] === value))
      .filter(item => !before || String(item[sortField] || '') < before)
      .sort((a, b) => String(b[sortField] || '').localeCompare(String(a[sortField] || '')))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
  }

  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
  now() { return new Date().toISOString(); }
}
