import type { HumanView, Inbox } from './types';
import { workspaceRequester } from './session-validation';

type SnapshotResult = { ok: true; view: HumanView } | { ok: false; error: unknown };
type InitialWorkspace = { selected: Inbox; view: HumanView } | { selected: null; view: null };
type EarlySavedView = { humanId: string; provider: 'local' | 'workos'; onAuthorized: (selected: Inbox, view: HumanView) => void };

// A saved workspace lets a returning owner overlap the authorized view read
// with directory discovery. Modern snapshots can render after verifying their
// requester; legacy snapshots wait for directory membership.
export async function loadInitialWorkspace(
  savedId: string | null,
  directory: () => Promise<Inbox[]>,
  snapshot: (workspaceId: string) => Promise<HumanView>,
  earlySavedView?: EarlySavedView
): Promise<InitialWorkspace> {
  const prefetched: Promise<SnapshotResult> | null = savedId
    ? snapshot(savedId).then(view => {
      // A modern human-view response already contains the authorized requester.
      // It can render the saved inbox before the independent directory finishes.
      // Legacy or unverified responses still wait for directory membership.
      if (earlySavedView) {
        const actor = workspaceRequester(view, savedId);
        if (actor?.id === earlySavedView.humanId && actor.auth.provider === earlySavedView.provider && actor.auth.assurance !== 'phone')
          earlySavedView.onAuthorized(view.inbox, view);
      }
      return { ok: true as const, view };
    }).catch(error => ({ ok: false as const, error }))
    : null;
  const workspaces = await directory();
  const selected = workspaces.find(item => item.id === savedId) || workspaces[0] || null;
  if (!selected) return { selected: null, view: null };
  if (prefetched && selected.id === savedId) {
    const result = await prefetched;
    if (!result.ok) throw result.error;
    return { selected, view: result.view };
  }
  return { selected, view: await snapshot(selected.id) };
}
