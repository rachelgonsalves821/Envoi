import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEventCursorStore, PROGRESS_ONLY_EVENTS, subscribeReplayRecovery, WORKSPACE_EVENT_TYPES } from '../src/event-replay';

it('refreshes bounded replay notices while preserving native reconnect state', () => {
  const stream = new EventTarget();
  const close = vi.fn();
  Object.assign(stream, { close });
  const refresh = vi.fn(); const notify = vi.fn();
  const cleanup = subscribeReplayRecovery(stream, refresh, notify);
  stream.dispatchEvent(new Event('replay_required'));
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenCalledWith('Catching up on workspace activity…');
  expect(close).not.toHaveBeenCalled();
  cleanup();
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
});

function message(type: string, cursor: string, payload: unknown = {}) {
  return new MessageEvent(type, { lastEventId: cursor, data: JSON.stringify(payload) });
}

it('resumes manual reconnects with encoded, workspace-scoped progress', () => {
  const store = createEventCursorStore();
  const scope = store.scope('human', 'workspace one', () => true);
  const cursor = '2026-10-04T12:00:00.000Z|evt&1';
  expect(scope.record(message('case.created', cursor))).toBe(true);
  expect(new URL(scope.url(), 'https://example.com').searchParams.get('cursor')).toBe(cursor);
  expect(scope.url()).toContain('workspace%20one');
  expect(store.scope('human', 'workspace one', () => true).url()).toBe(scope.url());
  expect(store.scope('human', 'other', () => true).url()).not.toContain('?');
  expect(store.scope('other human', 'workspace one', () => true).url()).not.toContain('?');
});

it('clears all account progress on logout and rejects old callbacks after sign-in', () => {
  const store = createEventCursorStore(); const old = store.scope('human', 'workspace', () => true);
  old.record(message('case.created', '0001')); store.clear();
  expect(old.record(message('case.created', '0002'))).toBe(false);
  expect(store.scope('human', 'workspace', () => true).url()).not.toContain('?');
});

it('ignores obsolete workspace callbacks, regressing progress, and invalid cursors', () => {
  let current = true;
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => current);
  scope.record(message('case.created', '0002'));
  expect(scope.record(message('case.created', '0001'))).toBe(false);
  expect(scope.record(message('case.created', 'bad\nvalue'))).toBe(false);
  expect(scope.record(message('case.created', 'x'.repeat(513)))).toBe(false);
  current = false;
  expect(scope.record(message('case.created', '0003'))).toBe(false);
  expect(store.scope('human', 'workspace', () => true).url()).toContain('cursor=0002');
});

it('accepts ready progress beyond unhandled event types without advancing beyond the delivered checkpoint', () => {
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => true);
  scope.record(message('case.created', '0001'));
  // Native EventSource carries the previous actual id into ready, even when its
  // named data event had no application listener. The server adds no ready id.
  expect(scope.record(message('ready', '0003', { inboxId: 'workspace', cursor: '9999' }), true)).toBe(true);
  expect(scope.url()).toContain('cursor=0003');
  expect(scope.record(message('ready', '0002', { inboxId: 'workspace', cursor: '0002' }), true)).toBe(false);
  expect(scope.record(message('ready', '0004', { inboxId: 'other', cursor: '0004' }), true)).toBe(false);
});

it('can use the server ready payload when no inherited id is available, and keeps progress received before ready', () => {
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => true);
  expect(scope.record(message('ready', '', { inboxId: 'workspace', cursor: '0002' }), true)).toBe(true);
  scope.record(message('case.created', '0003'));
  expect(store.scope('human', 'workspace', () => true).url()).toContain('cursor=0003');
  expect(scope.record(new MessageEvent('ready', { data: 'not json', lastEventId: '0004' }), true)).toBe(false);
});

it('covers the literal data events emitted by the server and keeps control events separate', () => {
  const source = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const emitted = [...source.matchAll(/(?:audit|writeAudit)\(\s*(?:[^,\n]+,\s*)?['"]([a-z][a-z_.]+)['"]/g)].map(match => match[1]);
  expect(emitted.length).toBeGreaterThan(25);
  for (const type of emitted) expect(WORKSPACE_EVENT_TYPES, type).toContain(type);
  for (const type of ['agent.reenroll_token_created', 'agent.reconnect_token_created']) expect(WORKSPACE_EVENT_TYPES).toContain(type);
  expect(WORKSPACE_EVENT_TYPES).not.toContain('session.revoked');
  expect(WORKSPACE_EVENT_TYPES).not.toContain('ready');
  expect(PROGRESS_ONLY_EVENTS.has('agent.mcp_read_token_issued')).toBe(true);
  expect(PROGRESS_ONLY_EVENTS.has('case.action_recorded')).toBe(false);
});
