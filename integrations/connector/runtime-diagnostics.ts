import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateJson } from './store';
import type { ConnectorRunOperation } from '../../sdk/typescript/src/connector';

export type RuntimePhase = 'starting' | 'service_check' | 'runtime_check' | 'tool_verification'
  | 'ready' | 'retry_wait' | 'stopped' | 'failed';
export type FailureOperation = RuntimePhase | ConnectorRunOperation | 'receive_loop' | 'hosted_wake';

export interface RuntimeDiagnostic {
  version: 1;
  phase: RuntimePhase;
  startedAt: string;
  updatedAt: string;
  runtimeChecks: 'pending' | 'passed' | 'deferred_while_paused';
  errorCode?: string;
  retryAt?: string;
  failure?: { operation: FailureOperation; httpStatus?: number; requestId?: string };
}

const phases = new Set<RuntimePhase>(['starting', 'service_check', 'runtime_check', 'tool_verification',
  'ready', 'retry_wait', 'stopped', 'failed']);
const checks = new Set<RuntimeDiagnostic['runtimeChecks']>(['pending', 'passed', 'deferred_while_paused']);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const receiveOperations = new Set<FailureOperation>(['wake_stream', 'event_recovery', 'work_processing', 'status_check', 'receive_loop', 'hosted_wake']);
const httpStatus = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
// Connector requests do not supply a request ID. Envoi generates UUIDs for them.
const requestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function runtimeFailureDetails(operation: FailureOperation, status: unknown, id: unknown): NonNullable<RuntimeDiagnostic['failure']> {
  return { operation, ...(httpStatus(status) ? { httpStatus: status } : {}), ...(requestId(id) ? { requestId: id } : {}) };
}

/** Persist only fixed fields and stable codes, never an exception message or runtime configuration. */
export async function writeRuntimeDiagnostic(directory: string, value: RuntimeDiagnostic, lastFailure = false) {
  await privateJson(path.join(directory, lastFailure ? 'last-runtime-failure.json' : 'runtime-diagnostic.json'), value);
}

export async function readRuntimeDiagnostic(directory: string, lastFailure = false): Promise<RuntimeDiagnostic | null> {
  const filename = path.join(directory, lastFailure ? 'last-runtime-failure.json' : 'runtime-diagnostic.json');
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return null;
  try {
    const value = JSON.parse(await readFile(filename, 'utf8')) as RuntimeDiagnostic;
    if (!value || value.version !== 1 || !phases.has(value.phase) || !checks.has(value.runtimeChecks)
      || !timestamp(value.startedAt) || !timestamp(value.updatedAt)
      || value.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,119}$/.test(value.errorCode)
      || value.retryAt !== undefined && !timestamp(value.retryAt)
      || lastFailure && value.phase !== 'failed'
      || Object.keys(value).some(key => !['version', 'phase', 'startedAt', 'updatedAt', 'runtimeChecks', 'errorCode', 'retryAt', 'failure'].includes(key))) return null;
    if (value.failure !== undefined) {
      const { failure } = value;
      if (value.phase !== 'failed' || !failure || typeof failure !== 'object'
        || !(phases.has(failure.operation as RuntimePhase) || receiveOperations.has(failure.operation))
        || failure.httpStatus !== undefined && !httpStatus(failure.httpStatus)
        || failure.requestId !== undefined && !requestId(failure.requestId)
        || Object.keys(failure).some(key => !['operation', 'httpStatus', 'requestId'].includes(key))) return null;
    }
    return value;
  } catch { return null; }
}
