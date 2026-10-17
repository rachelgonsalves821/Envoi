import { describe, expect, it } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { PROGRESS_ONLY_EVENTS, WORKSPACE_EVENT_TYPES } from '../src/event-replay';

describe('approved CaseSession owner events', () => {
  it('subscribes to both canonical session-end control events', () => {
    const contract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
    for (const name of ['event-case-session-ended-agent-paused.json', 'event-case-session-ended-case-paused.json']) {
      const fixture = loadContractFixture(contract, name) as { event: { event: string; data: { type: string } } };
      expect(fixture.event.event).toBe('case_session.ended');
      expect(fixture.event.data.type).toBe(fixture.event.event);
      expect(WORKSPACE_EVENT_TYPES).toContain(fixture.event.event);
    }
  });

  it('refreshes the owner audit view for session creation/end instead of treating them as presence-only progress', () => {
    for (const name of ['agent.case_session_created', 'agent.case_session_ended', 'case_session.ended']) {
      expect(WORKSPACE_EVENT_TYPES).toContain(name);
      expect(PROGRESS_ONLY_EVENTS.has(name)).toBe(false);
    }
    expect(new Set(WORKSPACE_EVENT_TYPES).size).toBe(WORKSPACE_EVENT_TYPES.length);
  });
});
