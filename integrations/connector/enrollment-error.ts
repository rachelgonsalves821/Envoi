import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorEnrollmentError, ConnectorPersistenceError } from '../../sdk/typescript/src/connector';
import { ConnectorSetupError } from './adapter';
import { privateJson } from './store';

const codes = ['ENROLLMENT_HTTP_ERROR', 'ENROLLMENT_TOKEN_REJECTED', 'ENROLLMENT_RUNTIME_MISMATCH',
  'ENROLLMENT_OWNER_INVALID', 'ENROLLMENT_ADDRESS_TAKEN', 'ENROLLMENT_AGENT_LIMIT', 'ENROLLMENT_AUTH_UNAVAILABLE',
  'ENROLLMENT_TIMEOUT', 'ENROLLMENT_TRANSPORT_FAILED', 'ENROLLMENT_RESPONSE_INVALID',
  'ENROLLMENT_PERSISTENCE_FAILED', 'ENROLLMENT_UNCERTAIN'] as const;
type EnrollmentCode = typeof codes[number];
export interface EnrollmentDiagnostic { code: EnrollmentCode; checkedAt: string; httpStatus?: number; requestId?: string }
const advice: Partial<Record<EnrollmentCode, string>> = {
  ENROLLMENT_TOKEN_REJECTED: 'The token was rejected as invalid, expired, or already used.',
  ENROLLMENT_RUNTIME_MISMATCH: 'The selected runtime does not match the enrollment token.',
  ENROLLMENT_OWNER_INVALID: 'The issuing workspace owner could not be authorized. Check workspace membership.',
  ENROLLMENT_ADDRESS_TAKEN: 'The requested address is already reserved or enrolled.',
  ENROLLMENT_AGENT_LIMIT: 'The workspace owner has reached the active-agent limit.',
  ENROLLMENT_AUTH_UNAVAILABLE: 'Envoi could not check the workspace owner with its authentication provider.',
  ENROLLMENT_TIMEOUT: 'The enrollment request timed out; its server outcome is unknown.',
  ENROLLMENT_TRANSPORT_FAILED: 'The enrollment connection failed; its server outcome is unknown.',
  ENROLLMENT_RESPONSE_INVALID: 'Envoi responded without a valid credential session.',
  ENROLLMENT_PERSISTENCE_FAILED: 'Envoi returned credentials, but saving them locally failed. Check storage permissions and capacity.'
};

export async function enrollmentSetupError(error: unknown, directory: string) {
  const known = error instanceof ConnectorEnrollmentError || error instanceof ConnectorPersistenceError;
  const code = error instanceof ConnectorPersistenceError ? 'ENROLLMENT_PERSISTENCE_FAILED'
    : error instanceof ConnectorEnrollmentError && codes.includes(error.code as EnrollmentCode) ? error.code as EnrollmentCode : 'ENROLLMENT_UNCERTAIN';
  const diagnostic: EnrollmentDiagnostic = { code, checkedAt: new Date().toISOString(),
    ...(known && error.status !== undefined ? { httpStatus: error.status } : {}),
    ...(known && error.requestId ? { requestId: error.requestId } : {}) };
  // Failure to write diagnostics must not hide the enrollment failure or retry it.
  await privateJson(path.join(directory, 'enrollment-error.json'), diagnostic).catch(() => {});
  return new ConnectorSetupError(code, `${advice[code] ?? 'Enrollment did not finish.'}${diagnostic.httpStatus ? ` HTTP ${diagnostic.httpStatus}.` : ''}${diagnostic.requestId ? ` Request ID: ${diagnostic.requestId}.` : ''} State directory: ${directory}. Preserve it and check Agent connections before creating another token; it may have been consumed. Use Reconnect runtime for an existing identity if credentials were lost.`);
}

export async function readEnrollmentDiagnostic(directory: string): Promise<EnrollmentDiagnostic | undefined> {
  try {
    const filename = path.join(directory, 'enrollment-error.json');
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return;
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!value || !codes.includes(value.code) || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return;
    // Whitelist fields rather than returning arbitrary saved file contents.
    return { code: value.code, checkedAt: new Date(value.checkedAt).toISOString(),
      ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
      ...(typeof value.requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.requestId) ? { requestId: value.requestId } : {}) };
  } catch { return; }
}
