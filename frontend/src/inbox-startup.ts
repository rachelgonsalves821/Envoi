import type { HumanView, Inbox } from './types';
import { workspaceRequester } from './session-validation';

type Identity = { humanId: string; provider: string };
type SnapshotResult = { view: HumanView; error?: never } | { view?: never; error: unknown };

export function verifyInboxSnapshot(view: HumanView, inboxId: string, identity: Identity) {
  const actor = workspaceRequester(view, inboxId);
  if (actor && (actor.id !== identity.humanId || actor.auth.provider !== identity.provider || actor.auth.assurance === 'phone')) {
    throw new Error('The inbox session changed. Refresh your account to continue.');
  }
  return actor;
}

// The saved identifier is a hint, never a cached grant or cached inbox content.
// A fresh snapshot can bypass directory latency only when it verifies the actor.
export async function loadInboxStartup(savedId: string | null, identity: Identity, readers: {
  directory: () => Promise<Inbox[]>;
  snapshot: (id: string) => Promise<HumanView>;
}) {
  const hint = savedId && /^[A-Za-z0-9_-]{1,128}$/.test(savedId) ? savedId : null;
  const directory = readers.directory();
  // Attach immediately: directory failure must not become an unhandled rejection
  // while the independently authorized snapshot is still being read.
  void directory.catch(() => undefined);
  let saved: SnapshotResult | undefined;
  if (hint) {
    saved = await readers.snapshot(hint).then(view => ({ view }), error => ({ error }));
    if (saved.view && verifyInboxSnapshot(saved.view, hint, identity)) {
      return { selected: saved.view.inbox, view: saved.view, directory };
    }
  }
  const inboxes = await directory;
  const selected = inboxes.find(inbox => inbox.id === hint) || inboxes[0] || null;
  if (!selected) return { selected: null, view: null, directory };
  if (selected.id === hint && saved && !saved.view) throw saved.error;
  const view = selected.id === hint && saved?.view ? saved.view : await readers.snapshot(selected.id);
  verifyInboxSnapshot(view, selected.id, identity);
  return { selected, view, directory };
}

// Let each authorized inbox appear as soon as it is ready. A slow sibling must
// not hold up every other inbox behind Promise.all's final batch commit.
export async function readInboxViews<T>(inboxes: Inbox[], read: (inbox: Inbox) => Promise<T>, accept: (value: T) => void) {
  await Promise.all(inboxes.map(async inbox => {
    try { accept(await read(inbox)); } catch { /* Keep the last authorized view; retry on the existing refresh interval. */ }
  }));
}
