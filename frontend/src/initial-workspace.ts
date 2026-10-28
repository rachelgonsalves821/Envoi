import type { HumanView, Inbox } from './types';

type SnapshotResult = { ok: true; view: HumanView } | { ok: false; error: unknown };
type InitialWorkspace = { selected: Inbox; view: HumanView } | { selected: null; view: null };

// A saved workspace lets a returning owner overlap the authorized view read
// with directory discovery. The view is not used until the directory confirms
// that the current account can still select that workspace.
export async function loadInitialWorkspace(
  savedId: string | null,
  directory: () => Promise<Inbox[]>,
  snapshot: (workspaceId: string) => Promise<HumanView>
): Promise<InitialWorkspace> {
  const prefetched: Promise<SnapshotResult> | null = savedId
    ? snapshot(savedId).then(view => ({ ok: true, view }), error => ({ ok: false, error }))
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
