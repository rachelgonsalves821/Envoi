import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectorSession, ConnectorStore, WorkMessage } from '../../sdk/typescript/src/connector';
import type { BridgeDecision, BridgeLedger } from './bridge';

const safeId = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new TypeError('Invalid message ID');
  return value;
};

/** One process per enrollment. Use a private directory on persistent storage. */
export class FileBridgeStore implements ConnectorStore, BridgeLedger {
  constructor(private readonly directory: string) {}

  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await mkdir(path.join(this.directory, 'work'), { recursive: true, mode: 0o700 }); }

  private async readJson<T>(filename: string): Promise<T | null> {
    try { return JSON.parse(await readFile(filename, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private async replaceJson(filename: string, value: unknown) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  }

  load() { return this.readJson<ConnectorSession>(path.join(this.directory, 'session.json')); }
  save(session: ConnectorSession) { return this.replaceJson(path.join(this.directory, 'session.json'), session); }

  async admit(message: WorkMessage) {
    const filename = path.join(this.directory, 'work', `${safeId(message.id)}.json`);
    try { await writeFile(filename, JSON.stringify({ id: message.id, caseId: message.caseId || null, admittedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }

  replyFor(messageId: string) { return this.readJson<BridgeDecision>(path.join(this.directory, 'work', `${safeId(messageId)}.reply.json`)); }
  saveReply(messageId: string, reply: BridgeDecision) { return this.replaceJson(path.join(this.directory, 'work', `${safeId(messageId)}.reply.json`), reply); }
  async mcpReplySent(messageId: string) {
    return (await this.readJson<{ sent: true }>(path.join(this.directory, 'work', `${safeId(messageId)}.mcp-reply.json`)))?.sent === true;
  }
  markMcpReplySent(messageId: string) {
    return this.replaceJson(path.join(this.directory, 'work', `${safeId(messageId)}.mcp-reply.json`), { sent: true });
  }
}
