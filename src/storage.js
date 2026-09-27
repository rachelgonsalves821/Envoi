import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class FileStore {
  constructor(root) {
    this.root = root;
    this.claims = new Set();
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
