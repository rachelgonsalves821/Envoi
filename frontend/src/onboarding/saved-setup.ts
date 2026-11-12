import { ApiError, request } from '../api';
import { savedSetup as validateSavedSetup } from './remote-auth.validator.mjs';
import type { RegistrationPermission } from './types';

type SavedPermission = Exclude<RegistrationPermission, 'use_email_transport'>;
export interface SavedSetupPreferences {
  setupId: string;
  workspaceInboxId: string;
  workspaceName: string;
  name: string;
  localPart: string;
  address: string;
  permissions: SavedPermission[];
  expiresAt: string;
}
export interface ConsentSavedSetup extends SavedSetupPreferences {
  notRequested: SavedPermission[];
  addressAvailable: boolean;
}
type SetupAgent = { name: string; address: string };
export type SavedSetup = SavedSetupPreferences & { runtime: 'dots'; createdAt: string } & (
  | { status: 'waiting' | 'replaced' }
  | { status: 'approved'; agent: SetupAgent }
  | { status: 'connected'; agent: SetupAgent & { id: string; lastSeenAt: string | null }; effectivePermissions: SavedPermission[] }
  | { status: 'expired'; reason: 'not_used' | 'approval_lapsed' }
);
type SavedSetupInput = Pick<SavedSetupPreferences, 'name' | 'localPart' | 'permissions'>;

const collection = (workspaceInboxId: string) => `/api/inboxes/${encodeURIComponent(workspaceInboxId)}/agent-setups`;

function readSetup(raw: unknown, workspaceInboxId: string): SavedSetup {
  if (!validateSavedSetup(raw)) throw new Error('Envoi returned an invalid setup status.');
  const setup = raw as SavedSetup;
  if (setup.workspaceInboxId !== workspaceInboxId) throw new Error('Envoi returned setup for a different workspace.');
  return setup;
}

export const savedSetupApi = {
  async create(workspaceInboxId: string, input: SavedSetupInput, signal?: AbortSignal) {
    const setup = readSetup(await request(collection(workspaceInboxId), {
      method: 'POST', body: JSON.stringify({ runtime: 'dots', ...input }), signal
    }), workspaceInboxId);
    if (setup.status !== 'waiting') throw new Error('Envoi did not return a new setup.');
    return setup;
  },
  async status(workspaceInboxId: string, setupId: string, signal?: AbortSignal) {
    const setup = readSetup(await request(`${collection(workspaceInboxId)}/${encodeURIComponent(setupId)}`, { signal }), workspaceInboxId);
    if (setup.setupId !== setupId) throw new Error('Envoi returned status for a different setup.');
    return setup;
  }
};

export function savedSetupStage(setup: SavedSetup) {
  return setup.status === 'connected' && setup.agent.lastSeenAt ? 'ready' : setup.status;
}

export function watchSavedSetup(options: {
  request: (signal: AbortSignal) => Promise<SavedSetup>;
  onStatus: (setup: SavedSetup) => void;
  onUnavailable: (terminal: boolean) => void;
}) {
  const stop = new AbortController();
  let timer = setTimeout(() => void poll(), 5_000);
  async function poll() {
    if (stop.signal.aborted) return;
    let delay = 5_000;
    try {
      const setup = await options.request(AbortSignal.any([stop.signal, AbortSignal.timeout(12_000)]));
      if (stop.signal.aborted) return;
      options.onStatus(setup);
      const stage = savedSetupStage(setup);
      if (stage === 'ready' || stage === 'expired' || stage === 'replaced') return;
    } catch (error) {
      if (stop.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      const terminal = error instanceof ApiError && [401, 403, 404].includes(error.status);
      options.onUnavailable(terminal);
      if (terminal) return;
      if (error instanceof ApiError && error.status === 429 && error.retryAfterSeconds !== undefined) {
        delay = Math.max(delay, Math.min(2_147_483_647, error.retryAfterSeconds * 1000));
      }
    }
    if (!stop.signal.aborted) timer = setTimeout(() => void poll(), delay);
  }
  return () => { clearTimeout(timer); stop.abort(); };
}
