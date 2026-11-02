import type { HumanView, Inbox } from './types';
import { workspaceRequester } from './session-validation';

const KEY = 'envoi.agent-inbox-ids';
type CacheStore = Pick<Storage, 'getItem' | 'setItem'>;
type Cached = { version: 1; humanId: string; items: Array<{ id: string; parentInboxId: string; ownerAgentId: string }> };
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Cache identifiers only. No agent name, address, grant, or inbox content is
// trusted from browser storage; each provisional inbox needs a fresh view.
export function rememberAgentInboxIds(storage: CacheStore, humanId: string, workspaces: Inbox[]) {
  try {
    const items = workspaces.filter(item => item.kind === 'agent' && item.status === 'active'
      && safeId(item.id) && safeId(item.parentInboxId) && safeId(item.ownerAgentId))
      .slice(0, 100).map(item => ({ id: item.id, parentInboxId: item.parentInboxId!, ownerAgentId: item.ownerAgentId! }));
    storage.setItem(KEY, JSON.stringify({ version: 1, humanId, items } satisfies Cached));
  } catch { /* Browser preferences are optional. */ }
}

export function provisionalAgentInboxes(storage: CacheStore, humanId: string, root: Inbox): Inbox[] {
  if (root.kind !== 'workspace') return [];
  try {
    const saved = JSON.parse(storage.getItem(KEY) || 'null') as Cached | null;
    if (saved?.version !== 1 || saved.humanId !== humanId || !Array.isArray(saved.items) || saved.items.length > 100) return [];
    const ids = new Set<string>();
    return saved.items.flatMap(item => {
      if (!item || !safeId(item.id) || !safeId(item.parentInboxId) || !safeId(item.ownerAgentId)
        || item.parentInboxId !== root.id || ids.has(item.id)) return [];
      ids.add(item.id);
      return [{ ...root, id: item.id, name: '', ownerAgentId: item.ownerAgentId,
        parentInboxId: root.id, kind: 'agent' as const, status: 'provisional' }];
    });
  } catch { return []; }
}

export function authorizedChildView(view: HumanView, inbox: Inbox, humanId: string, provider: string): boolean {
  const actor = workspaceRequester(view, inbox.id);
  if (inbox.status === 'provisional' && (view.inbox.kind !== 'agent' || view.inbox.parentInboxId !== inbox.parentInboxId
    || view.inbox.ownerAgentId !== inbox.ownerAgentId || !actor)) return false;
  if (!actor) return true;
  return actor.id === humanId && actor.auth.provider === provider && actor.auth.assurance !== 'phone';
}
