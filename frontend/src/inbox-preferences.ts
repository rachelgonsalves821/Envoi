import type { HumanView, InboxPreference as ViewInboxPreference } from './types';

export type InboxPreference = ViewInboxPreference;

export interface InboxCase {
  id: string;
  inboxPreference?: InboxPreference | null;
}

export interface InboxCaseFilter {
  view?: 'main' | 'done' | 'all';
  folderId?: string | null;
  read?: boolean;
}

export interface ReadAcknowledgement {
  read: true;
  readThrough: string;
}

export function filterInboxCases<Case extends InboxCase>(cases: readonly Case[], filter: InboxCaseFilter = {}): Case[] {
  const view = filter.view ?? 'main';
  return cases.filter(workCase => {
    const preference = workCase.inboxPreference;
    const archived = preference?.archived === true;
    return (view === 'all' || (view === 'done' ? archived : !archived))
      && (filter.folderId === undefined || (preference?.folderId ?? null) === filter.folderId)
      && (filter.read === undefined || (preference?.read === true) === filter.read);
  });
}

export function selectInboxCase<Case extends InboxCase>(cases: readonly Case[], caseId: string | null, filter: InboxCaseFilter = {}): Case | null {
  if (caseId === null) return null;
  return filterInboxCases(cases, filter).find(workCase => workCase.id === caseId) ?? null;
}

export function readAcknowledgementForCase(workCase: InboxCase): ReadAcknowledgement | null {
  const revision = workCase.inboxPreference?.revision;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) return null;
  return { read: true, readThrough: revision };
}

export function applyInboxPreference(view: HumanView, caseId: string, preference: InboxPreference): HumanView {
  let changed = false;
  const caseQueue = view.caseQueue.map(workCase => {
    if (workCase.id !== caseId) return workCase;
    changed = true;
    return { ...workCase, inboxPreference: { ...preference } };
  });
  return changed ? { ...view, caseQueue } : view;
}
