import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { privateJson } from './store';

export interface HostTaskIdentity { apiUrl: string; runtime: string; address: string }
export interface HostTaskRequest { requestId: string; recipientAddress: string; text: string }
export interface HostTaskReceipt {
  state: 'accepted'; requestId: string; senderAddress: string; recipientAddress: string; replayed: boolean;
}
interface TaskRecord {
  version: 1; identity: HostTaskIdentity; request: HostTaskRequest; caseId: string;
  state: 'prepared' | 'accepted'; messageId?: string;
}
export class HostTaskError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'HostTaskError'; }
}
export const validTaskId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function validateHostTask(value: unknown): HostTaskRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostTaskError('TASK_INVALID');
  const task = value as HostTaskRequest;
  if (Object.keys(task).some(key => !['requestId', 'recipientAddress', 'text'].includes(key)) || !validTaskId(task.requestId)
    || typeof task.recipientAddress !== 'string' || task.recipientAddress.length > 254
    || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(task.recipientAddress)
    || typeof task.text !== 'string' || !task.text.trim() || Buffer.byteLength(task.text, 'utf8') > 15_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(task.text)) throw new HostTaskError('TASK_INVALID');
  return { requestId: task.requestId, recipientAddress: task.recipientAddress, text: task.text };
}
const sameIdentity = (a: HostTaskIdentity, b: HostTaskIdentity) => a?.apiUrl === b.apiUrl && a?.runtime === b.runtime && a?.address === b.address;
const taskPath = (directory: string, id: string) => path.join(directory, `host-task-${id}.json`);
const caseIdFor = (identity: HostTaskIdentity, requestId: string) => `case_${createHash('sha256').update(JSON.stringify([identity.apiUrl, identity.address, requestId])).digest('hex').slice(0, 32)}`;

export async function readHostTask(directory: string, identity: HostTaskIdentity, requestId: string): Promise<TaskRecord | null> {
  if (!validTaskId(requestId)) throw new HostTaskError('TASK_INVALID');
  const filename = taskPath(directory, requestId);
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new HostTaskError('TASK_STATE_INVALID');
  try {
    const record = JSON.parse(await readFile(filename, 'utf8')) as TaskRecord;
    const task = validateHostTask(record.request);
    if (record.version !== 1 || !sameIdentity(record.identity, identity) || task.requestId !== requestId
      || record.caseId !== caseIdFor(identity, requestId) || !['prepared', 'accepted'].includes(record.state)
      || record.state === 'accepted' && (typeof record.messageId !== 'string' || !/^msg_[a-zA-Z0-9_-]{1,128}$/.test(record.messageId))) throw new Error();
    return record;
  } catch { throw new HostTaskError('TASK_STATE_INVALID'); }
}

/** Trusted host operation only. Reuses the running connector's rotation and server authorization. */
export function createHostTaskSender(directory: string, identity: HostTaskIdentity,
  connector: () => Pick<EnvoiConnector, 'startCase'>, save: typeof privateJson = privateJson) {
  // InstalledConnection also carries private adapter configuration; never copy it into task journals.
  identity = { apiUrl: identity.apiUrl, runtime: identity.runtime, address: identity.address };
  const flights = new Map<string, { fingerprint: string; promise: Promise<HostTaskReceipt> }>();
  const receipt = (record: TaskRecord, replayed: boolean): HostTaskReceipt => ({ state: 'accepted',
    requestId: record.request.requestId, senderAddress: identity.address, recipientAddress: record.request.recipientAddress, replayed });
  return async (value: unknown): Promise<HostTaskReceipt> => {
    const request = validateHostTask(value);
    if (request.recipientAddress === identity.address) throw new HostTaskError('TASK_SELF_RECIPIENT');
    const fingerprint = JSON.stringify(request);
    const active = flights.get(request.requestId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new HostTaskError('TASK_IDEMPOTENCY_CONFLICT');
      return active.promise;
    }
    const promise = (async () => {
      let record = await readHostTask(directory, identity, request.requestId);
      if (record && JSON.stringify(record.request) !== fingerprint) throw new HostTaskError('TASK_IDEMPOTENCY_CONFLICT');
      if (record?.state === 'accepted') return receipt(record, true);
      // Do not persist a send from a connection which is still preparing its runtime.
      const live = connector();
      if (!record) {
        record = { version: 1, identity: { ...identity }, request, caseId: caseIdFor(identity, request.requestId), state: 'prepared' };
        await save(taskPath(directory, request.requestId), record);
      }
      const raw: unknown = await live.startCase(`host-task:${request.requestId}`, {
        caseId: record.caseId, recipientEmail: request.recipientAddress, text: request.text, intent: 'request'
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HostTaskError('TASK_RESPONSE_INVALID');
      const sent = raw as Record<string, unknown>;
      if (sent.caseId !== record.caseId || sent.recipientEmail !== request.recipientAddress || sent.text !== request.text
        || sent.transport !== 'native' || typeof sent.id !== 'string' || !/^msg_[a-zA-Z0-9_-]{1,128}$/.test(sent.id)) throw new HostTaskError('TASK_RESPONSE_INVALID');
      record = { ...record, state: 'accepted', messageId: sent.id };
      await save(taskPath(directory, request.requestId), record);
      return receipt(record, false);
    })();
    flights.set(request.requestId, { fingerprint, promise });
    try { return await promise; } finally { flights.delete(request.requestId); }
  };
}
