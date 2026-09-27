import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class FileStore {
  constructor(root) {
    this.root = root;
    this.claims = new Set();
    this.outboxMutation = Promise.resolve();
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

  inboxDir(inboxId) { return path.join(this.root, 'inboxes', inboxId); }
  file(...parts) { return path.join(this.root, ...parts); }

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
