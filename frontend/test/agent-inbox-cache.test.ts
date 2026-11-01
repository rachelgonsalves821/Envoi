import { expect, it } from 'vitest';
import { authorizedChildView, provisionalAgentInboxes, rememberAgentInboxIds } from '../src/agent-inbox-cache';
import type { HumanView, Inbox } from '../src/types';

const root = { id: 'root_1', kind: 'workspace', ownerHumanId: 'human_1', name: 'Workspace', status: 'active' } as Inbox;
const child = { ...root, id: 'agent_1', kind: 'agent', parentInboxId: root.id, ownerAgentId: 'agent_owner', name: 'Private name' } as Inbox;
const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
};

it('caches only agent identifiers and gates them by current human and root inbox', () => {
  const cache = storage();
  rememberAgentInboxIds(cache, 'human_1', [root, child]);
  const serialized = [...cache.data.values()][0];
  expect(serialized).toContain('agent_owner');
  expect(serialized).not.toContain('Private name');
  expect(provisionalAgentInboxes(cache, 'other_human', root)).toEqual([]);
  expect(provisionalAgentInboxes(cache, 'human_1', { ...root, id: 'other_root' })).toEqual([]);
  expect(provisionalAgentInboxes(cache, 'human_1', root)).toMatchObject([{ id: 'agent_1', status: 'provisional', name: '' }]);
});

it('requires a fresh matching requester and child ownership before showing a cached agent', () => {
  const provisional = { ...child, status: 'provisional' };
  const authorized = { inbox: child, requester: { id: 'human_1', auth: { provider: 'local', assurance: 'mfa' } } } as HumanView;
  expect(authorizedChildView(authorized, provisional, 'human_1', 'local')).toBe(true);
  expect(authorizedChildView({ inbox: child } as HumanView, provisional, 'human_1', 'local')).toBe(false);
  expect(authorizedChildView({ ...authorized, requester: { ...authorized.requester!, id: 'other_human' } } as HumanView, provisional, 'human_1', 'local')).toBe(false);
  expect(authorizedChildView({ ...authorized, inbox: { ...child, ownerAgentId: 'another_agent' } }, provisional, 'human_1', 'local')).toBe(false);
});
