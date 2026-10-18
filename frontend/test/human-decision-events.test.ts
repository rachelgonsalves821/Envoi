import { describe, expect, it } from 'vitest';
import { createEventCursorStore, PROGRESS_ONLY_EVENTS, WORKSPACE_EVENT_TYPES } from '../src/event-replay';

describe('approved Phase C owner events', () => {
  it.each(['case.human_decision_requested', 'case.human_decision_resolved', 'agent.case_session_created',
    'agent.case_session_ended', 'case_session.ended', 'agent.case_tool_used', 'agent.wake_subscription_created',
    'agent.wake_subscription_activated', 'agent.wake_subscription_ended'])(
    'refreshes the owning workspace on audit %s', name => {
      expect(WORKSPACE_EVENT_TYPES.filter(type => type === name)).toHaveLength(1);
      expect(PROGRESS_ONLY_EVENTS.has(name)).toBe(false);
      const store = createEventCursorStore();
      const scope = store.scope('human_fixture', 'inbox_fixture', () => true);
      expect(scope.record(new MessageEvent(name, { lastEventId: 'event_0001', data: JSON.stringify({ type: name, inboxId: 'inbox_fixture' }) }))).toBe(true);
      expect(scope.url()).toContain('cursor=event_0001');
      store.clear();
      expect(scope.record(new MessageEvent(name, { lastEventId: 'event_0002', data: '{}' }))).toBe(false);
    }
  );
});
