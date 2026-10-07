import { describe, expect, it } from 'vitest';
import { applyInboxPreference, filterInboxCases, readAcknowledgementForCase, selectInboxCase } from '../src/inbox-preferences';
import type { InboxCase, InboxPreference } from '../src/inbox-preferences';
import { mergeHistory } from '../src/history';
import type { HumanView, WorkCase } from '../src/types';

const observedRevision = 'a'.repeat(64);
const newerRevision = 'b'.repeat(64);

function preference(overrides: Partial<InboxPreference> = {}): InboxPreference {
  return { read: false, archived: false, folderId: null, readThrough: null, revision: observedRevision, ...overrides };
}

function humanView(cases: WorkCase[]): HumanView {
  const createdAt = new Date().toISOString();
  return {
    inbox: { id: 'inbox_one', organizationId: 'org_one', name: 'Inbox', ownerAgentId: null, ownerHumanId: 'human_one', status: 'active', createdAt },
    mode: 'human-observer', canManageInbox: false, capabilities: [],
    summary: { agents: 0, cases: 200, messages: 0, assets: 0, needsMe: 0 },
    navigation: { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 },
    history: { cases: { total: 200, hasMore: true, nextCursor: 'older-page' } },
    folders: [{ id: 'folder_one', name: 'Travel' }],
    agents: [], cases, caseQueue: cases, messages: [], assets: [],
    calendarProviders: {
      google: { id: 'google', label: 'Google Calendar', configured: false },
      outlook: { id: 'outlook', label: 'Outlook Calendar', configured: false }
    },
    calendarConnectors: [], deliveryReceipts: [], invitations: [], contacts: [], recentEvents: []
  };
}

describe('human inbox filtering', () => {
  it('uses the Done annotation instead of protocol state', () => {
    const cases = [
      { id: 'case_completed', state: 'completed', inboxPreference: preference() },
      { id: 'case_working', state: 'inProgress', inboxPreference: preference({ archived: true }) },
      { id: 'case_needs_human', state: 'waitingForHuman', needsAttention: true, inboxPreference: preference({ archived: true }) }
    ];
    expect(filterInboxCases(cases).map(workCase => workCase.id)).toEqual(['case_completed']);
    expect(filterInboxCases(cases, { view: 'done' }).map(workCase => workCase.id)).toEqual(['case_working', 'case_needs_human']);
    expect(filterInboxCases(cases, { view: 'all' })).toEqual(cases);
  });

  it('moves a refreshed conversation back to main when archive is cleared', () => {
    const done = { id: 'case_one', state: 'waitingForHuman', inboxPreference: preference({ archived: true, folderId: 'folder_one', read: true }) };
    const restored = { ...done, inboxPreference: { ...done.inboxPreference, archived: false } };
    expect(filterInboxCases([done])).toEqual([]);
    expect(filterInboxCases([restored])).toEqual([restored]);
    expect(filterInboxCases([restored], { view: 'done' })).toEqual([]);
    expect(restored.state).toBe(done.state);
    expect(restored.inboxPreference.folderId).toBe('folder_one');
    expect(restored.inboxPreference.read).toBe(true);
  });

  it('keeps unread independent of needsAttention and does not infer it from readThrough', () => {
    const cases = [
      { id: 'case_seen', needsAttention: true, inboxPreference: preference({ read: true, readThrough: observedRevision }) },
      { id: 'case_new_message', needsAttention: false, inboxPreference: preference({ readThrough: observedRevision, revision: newerRevision }) },
      { id: 'case_legacy', needsAttention: false }
    ];
    expect(filterInboxCases(cases, { read: true }).map(workCase => workCase.id)).toEqual(['case_seen']);
    expect(filterInboxCases(cases, { read: false }).map(workCase => workCase.id)).toEqual(['case_new_message', 'case_legacy']);
  });

  it('intersects folder, Done, and read filters while preserving server order', () => {
    const cases = [
      { id: 'case_other', inboxPreference: preference({ archived: true, folderId: 'folder_other' }) },
      { id: 'case_second', inboxPreference: preference({ archived: true, folderId: 'folder_one' }) },
      { id: 'case_first', inboxPreference: preference({ archived: true, folderId: 'folder_one' }) },
      { id: 'case_read', inboxPreference: preference({ archived: true, folderId: 'folder_one', read: true }) },
      { id: 'case_unfiled' }
    ];
    expect(filterInboxCases(cases, { view: 'done', folderId: 'folder_one', read: false }).map(workCase => workCase.id)).toEqual(['case_second', 'case_first']);
    expect(filterInboxCases(cases, { view: 'all', folderId: null }).map(workCase => workCase.id)).toEqual(['case_unfiled']);
  });

  it('accepts optional annotations and never mutates cases or preferences', () => {
    const cases: readonly InboxCase[] = Object.freeze([
      Object.freeze({ id: 'case_one', inboxPreference: Object.freeze(preference()) }),
      Object.freeze({ id: 'case_two', inboxPreference: null }),
      Object.freeze({ id: 'case_three' })
    ]);
    const original = structuredClone(cases);
    expect(filterInboxCases(cases)).toEqual(cases);
    expect(selectInboxCase(cases, 'case_one')).toBe(cases[0]);
    expect(readAcknowledgementForCase(cases[0])).toEqual({ read: true, readThrough: observedRevision });
    expect(cases).toEqual(original);
  });
});

describe('selection and explicit read acknowledgement', () => {
  it('selects only the requested visible case without automatically selecting another', () => {
    const cases = [
      { id: 'case_main', inboxPreference: preference() },
      { id: 'case_done', inboxPreference: preference({ archived: true }) }
    ];
    expect(selectInboxCase(cases, null)).toBeNull();
    expect(selectInboxCase(cases, 'case_missing')).toBeNull();
    expect(selectInboxCase(cases, 'case_done')).toBeNull();
    expect(selectInboxCase(cases, 'case_done', { view: 'done' })).toBe(cases[1]);
    expect(cases.every(workCase => !workCase.inboxPreference.read)).toBe(true);
  });

  it('snapshots the clicked case revision without acknowledging a newer refresh', () => {
    const clickedCase = { id: 'case_one', inboxPreference: preference() };
    const acknowledgement = readAcknowledgementForCase(clickedCase);
    const refreshedCase = { ...clickedCase, inboxPreference: preference({ revision: newerRevision }) };
    expect(acknowledgement).toEqual({ read: true, readThrough: observedRevision });
    expect(readAcknowledgementForCase(refreshedCase)).toEqual({ read: true, readThrough: newerRevision });
    expect(clickedCase.inboxPreference.read).toBe(false);
    expect(refreshedCase.inboxPreference.read).toBe(false);
  });

  it('does not fabricate an acknowledgement when the server revision is absent or malformed', () => {
    expect(readAcknowledgementForCase({ id: 'case_legacy' })).toBeNull();
    expect(readAcknowledgementForCase({ id: 'case_null', inboxPreference: null })).toBeNull();
    for (const revision of ['', 'x'.repeat(64), 'a'.repeat(65), 'A'.repeat(64)]) {
      expect(readAcknowledgementForCase({ id: 'case_one', inboxPreference: preference({ revision }) })).toBeNull();
    }
  });
});

describe('applying a preference response', () => {
  it('copies only the matching display case and preserves canonical state and all other records', () => {
    const createdAt = new Date().toISOString();
    const target: WorkCase = Object.freeze({
      id: 'case_one', state: 'waitingForHuman', needsAttention: true,
      createdAt, updatedAt: createdAt, events: [], authorityRefs: ['grant_one'],
      inboxPreference: Object.freeze(preference())
    });
    const other: WorkCase = Object.freeze({ id: 'case_two', state: 'completed', createdAt });
    const view = Object.freeze(humanView([target, other]));
    Object.freeze(view.caseQueue);
    const original = structuredClone(view);
    const response = preference({ archived: true, read: true, folderId: 'folder_one', readThrough: observedRevision });
    const updated = applyInboxPreference(view, target.id, response);
    expect(updated).not.toBe(view);
    expect(updated.caseQueue).not.toBe(view.caseQueue);
    expect(updated.caseQueue[0]).not.toBe(target);
    expect(updated.caseQueue[0].inboxPreference).toEqual(response);
    expect(updated.caseQueue[0].inboxPreference).not.toBe(response);
    expect(updated.caseQueue[0].state).toBe('waitingForHuman');
    expect(updated.caseQueue[0].needsAttention).toBe(true);
    expect(updated.caseQueue[0].createdAt).toBe(target.createdAt);
    expect(updated.caseQueue[0].updatedAt).toBe(target.updatedAt);
    expect(updated.caseQueue[0].events).toBe(target.events);
    expect(updated.caseQueue[0].authorityRefs).toBe(target.authorityRefs);
    expect(updated.caseQueue[1]).toBe(other);
    for (const key of Object.keys(view) as Array<keyof HumanView>) {
      if (key !== 'caseQueue') expect(updated[key]).toBe(view[key]);
    }
    expect(updated.cases[0]).toBe(target);
    expect(updated.cases[0].inboxPreference?.archived).toBe(false);
    expect(view).toEqual(original);
  });

  it('keeps an older loaded case annotation through subsequent head-only history refresh', () => {
    const createdAt = new Date().toISOString();
    const olderAt = new Date(Date.parse(createdAt) - 1000).toISOString();
    const head: WorkCase = { id: 'case_head', state: 'inProgress', createdAt, updatedAt: createdAt, inboxPreference: preference() };
    const older: WorkCase = { id: 'case_older', state: 'waitingForHuman', createdAt: olderAt, updatedAt: olderAt, inboxPreference: preference() };
    const view = humanView([head, older]);
    const response = preference({ archived: true, read: true, folderId: 'folder_one', readThrough: observedRevision });
    const updated = applyInboxPreference(view, older.id, response);
    const freshHead = humanView([{ ...head, objective: 'Refreshed head' }]);
    const refreshed = mergeHistory(updated, freshHead);
    const retained = refreshed.caseQueue.find(workCase => workCase.id === older.id)!;
    expect(retained).toBe(updated.caseQueue[1]);
    expect(retained.inboxPreference).toEqual(response);
    expect(retained.state).toBe(older.state);
    expect(retained.updatedAt).toBe(older.updatedAt);
    expect(refreshed.cases.find(workCase => workCase.id === older.id)).toBe(older);
    expect(refreshed.history?.cases?.nextCursor).toBe('older-page');
    expect(filterInboxCases(refreshed.caseQueue).map(workCase => workCase.id)).toEqual(['case_head']);
    expect(filterInboxCases(refreshed.caseQueue, { view: 'done' }).map(workCase => workCase.id)).toEqual(['case_older']);
  });

  it('does not insert an unloaded case and allows clearing Done without changing task state', () => {
    const createdAt = new Date().toISOString();
    const view = humanView([{ id: 'case_one', state: 'completed', createdAt, inboxPreference: preference({ archived: true }) }]);
    expect(applyInboxPreference(view, 'case_missing', preference())).toBe(view);
    const updated = applyInboxPreference(view, 'case_one', preference({ folderId: 'folder_one' }));
    expect(updated.caseQueue[0].state).toBe('completed');
    expect(updated.caseQueue[0].inboxPreference?.archived).toBe(false);
    expect(filterInboxCases(updated.caseQueue)).toEqual(updated.caseQueue);
    expect(updated.cases).toBe(view.cases);
  });
});
