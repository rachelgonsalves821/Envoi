import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CaseRow, CaseWorkspace, ConversationEntry, ExchangeLedgerEvent, previewView } from '../src/App';
import { caseSourceView, exchangeParties, localAgentId, resolveParticipant } from '../src/model';
import type { Agent, CaseEvent, HumanView, WorkCase } from '../src/types';

const createdAt = '2026-10-15T12:00:00Z';
const agents: Agent[] = [
  { id: 'agent_je', name: 'Je', address: 'je@example.test', principalHumanId: 'human_sender', status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages'] },
  { id: 'agent_rachel', name: 'Rachel probe', address: 'probe@example.test', principalHumanId: 'human_recipient', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] }
];
const events: CaseEvent[] = [
  { id: 'send1', type: 'message', actor: 'agent_je', createdAt, payload: { senderAgentId: 'agent_je', recipientAgentId: 'agent_rachel', text: 'Send1', deliveryState: 'delivered' }, linkedPolicyEvaluation: null, precedingEventRef: null },
  { id: 'reply1', type: 'message', actor: 'agent_rachel', createdAt, payload: { senderAgentId: 'agent_rachel', recipientAgentId: 'agent_je', text: 'Reply1', deliveryState: 'processed' }, linkedPolicyEvaluation: null, precedingEventRef: null }
];
const workCase: WorkCase = {
  id: 'case_shared', schemaVersion: '1.0', objective: 'Shared case', state: 'inProgress', principal: 'human_sender',
  actingAgent: 'agent_je', participants: ['agent_je', 'agent_rachel'], events, proposals: [], policyEvaluations: [], evidence: [], createdAt
};

function source(ownerAgentId: string | null): HumanView {
  const sender = ownerAgentId === 'agent_je';
  return {
    inbox: { id: sender ? 'inbox_sender' : 'inbox_recipient', organizationId: sender ? 'org_sender' : 'org_recipient', name: 'Agent inbox', ownerAgentId, ownerHumanId: sender ? 'human_sender' : 'human_recipient', status: 'active', createdAt },
    requester: { id: sender ? 'human_sender' : 'human_recipient', auth: { provider: 'local', assurance: 'totp' } },
    mode: 'human-observer', canManageInbox: true, capabilities: [], summary: { agents: 1, cases: 1, messages: 2, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
    agents: agents.filter(agent => agent.id === ownerAgentId),
    participantDirectory: Object.fromEntries(agents.map(agent => [agent.id, { id: agent.id, type: agent.id === ownerAgentId ? 'internalAgent' : 'externalAgent', displayName: agent.name, address: agent.address, organizationId: agent.id === 'agent_je' ? 'org_sender' : 'org_recipient', orgRef: agent.id === 'agent_je' ? 'Sender organization' : 'Recipient organization', accessState: 'active' }])),
    caseQueue: [workCase], cases: [workCase], messages: [], assets: [], invitations: [], deliveryReceipts: [], recentEvents: [], calendarConnectors: [], calendarProviders: { google: { id: 'google', label: 'Google', configured: false }, outlook: { id: 'outlook', label: 'Outlook', configured: false } }
  } as HumanView;
}

function thread(view: HumanView, item = workCase, canManageInbox = true) {
  return renderToStaticMarkup(createElement(CaseWorkspace, { workCase: item, view, canManageInbox, railOpen: true, onRailToggle: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(), onPreferencesChanged: vi.fn(), notify: vi.fn() }));
}

function row(view: HumanView, item = workCase) {
  return renderToStaticMarkup(createElement(CaseRow, { workCase: item, view, showOwner: true, selected: false, onSelect: vi.fn() }));
}

describe('case inbox perspective', () => {
  it.each([
    ['agent_je', 'Je', 'Rachel probe', 'Recipient organization', 'mine', 'theirs', 'outbound'],
    ['agent_rachel', 'Rachel probe', 'Je', 'Sender organization', 'theirs', 'mine', 'inbound']
  ])('renders the same case for %s', (ownerId, localName, otherName, otherOrg, firstSide, replySide, direction) => {
    const view = source(ownerId);
    const markup = thread(view);
    expect(markup).toContain(`<small>Your agent</small><strong>${localName}</strong>`);
    expect(markup).toContain(`<small>Agent for ${otherOrg}</small><strong>${otherName}</strong>`);
    expect(markup).toContain(`aria-label="Instructions for ${localName}"`);
    expect(markup).toContain(`<h2>${localName} can</h2>`);
    expect(markup).not.toContain(`<h2>${otherName} can</h2>`);
    expect(markup).not.toMatch(/Pause agent|Reconnect runtime|Revoke agent access|Remove agent/);
    expect(markup.match(/<input aria-label="Instructions[^>]+>/)?.[0]).not.toContain('disabled');
    expect(row(view)).toContain(`<span class="thread-sender">${otherName}</span>`);
    expect(row(view)).toContain(`title="${localName}"`);
    for (const [event, side] of [[events[0], firstSide], [events[1], replySide]] as const) {
      const message = renderToStaticMarkup(createElement(ConversationEntry, { event, view, workCase }));
      expect(message).toContain(`conversation-message ${side}`);
      expect(message.includes('message-delivery')).toBe(side === 'mine');
    }
    const ledger = renderToStaticMarkup(createElement(ExchangeLedgerEvent, { event: events[0], view, workCase }));
    expect(ledger).toContain(`direction-${direction}`);
    expect(resolveParticipant(workCase, ownerId, view.agents, view.participantDirectory, localAgentId(workCase, view))).toMatchObject({ relationship: 'localAgent', type: 'internalAgent' });
    expect(workCase.actingAgent).toBe('agent_je');
    expect(workCase.principal).toBe('human_sender');
  });

  it.each(['agent_je', 'agent_rachel'])('labels a coworker from %s without changing inbox authority', ownerId => {
    const view = source(ownerId);
    const counterpartyId = agents.find(agent => agent.id !== ownerId)!.id;
    view.participantDirectory![counterpartyId] = { ...view.participantDirectory![counterpartyId], organizationId: view.inbox.organizationId, orgRef: undefined };
    const markup = thread(view);
    expect(markup).toContain('<small>Agent in your organization</small>');
    expect(markup).not.toContain('Agent for another organization');
    expect(markup).toContain('>Block agent</button>');
    expect(markup).not.toMatch(/Pause agent|Reconnect runtime|Revoke agent access|Remove agent/);
    expect(resolveParticipant(workCase, counterpartyId, view.agents, view.participantDirectory, ownerId)).toMatchObject({ relationship: 'counterpartyAgent', type: 'externalAgent' });
    const ownAgent = view.agents[0];
    const otherName = view.participantDirectory![counterpartyId].displayName;
    expect(markup).toContain(`<h2>${ownAgent.name} can</h2>`);
    expect(markup).not.toContain(`<h2>${otherName} can</h2>`);
    expect(markup.match(/<input aria-label="Instructions[^>]+>/)?.[0]).not.toContain('disabled');

    view.participantDirectory![counterpartyId].accessState = 'blocked';
    const blocked = thread(view);
    expect(blocked).toContain('<small>Agent in your organization</small>');
    expect(blocked).toContain('>Blocked</span>');
    expect(blocked).toContain('>Unblock agent</button>');

    const observer = thread(view, workCase, false);
    expect(observer).toContain('<small>Agent in your organization</small>');
    expect(observer).not.toMatch(/>Block agent<|>Unblock agent</);
    expect(observer.match(/<input aria-label="Instructions[^>]+>/)?.[0]).toContain('disabled');
    view.agents = [{ ...ownAgent, permissions: [] }];
    expect(thread(view).match(/<input aria-label="Instructions[^>]+>/)?.[0]).toContain('disabled');
  });

  it.each([
    ['different IDs', 'org_sender', 'org_recipient'],
    ['null counterparty ID', 'org_sender', null],
    ['absent counterparty ID', 'org_sender', undefined],
    ['empty counterparty ID', 'org_sender', ''],
    ['null inbox ID', null, 'org_recipient'],
    ['absent inbox ID', undefined, 'org_recipient'],
    ['empty inbox ID', '', 'org_recipient'],
    ['both null IDs', null, null],
    ['both absent IDs', undefined, undefined],
    ['both empty IDs', '', '']
  ])('keeps the fallback with %s despite matching email domains', (_name, inboxId, counterpartyId) => {
    const original = source('agent_je');
    const view = {
      ...original,
      inbox: { ...original.inbox, organizationId: inboxId },
      participantDirectory: { ...original.participantDirectory, agent_rachel: { ...original.participantDirectory!.agent_rachel, organizationId: counterpartyId, orgRef: undefined } }
    } as HumanView;
    const markup = thread(view);
    expect(markup).toContain('<small>Agent for another organization</small>');
    expect(markup).not.toContain('Agent in your organization');
    expect(markup).toContain('je@example.test');
    expect(markup).toContain('probe@example.test');
  });

  it.each([
    ['matching source inbox', 'org_child', 'org_child', 'Agent in your organization'],
    ['matching aggregate inbox only', 'org_child', 'org_aggregate', 'Agent for another organization'],
    ['missing source inbox ID', undefined, 'org_aggregate', 'Agent for another organization'],
    ['missing counterparty ID', 'org_child', undefined, 'Agent for another organization']
  ])('uses the child inbox organization in All inboxes with %s', (_name, inboxId, counterpartyId, label) => {
    const original = source('agent_rachel');
    const child = {
      ...original,
      inbox: { ...original.inbox, kind: 'agent', parentInboxId: 'inbox_all', organizationId: inboxId },
      participantDirectory: { ...original.participantDirectory, agent_je: { ...original.participantDirectory!.agent_je, organizationId: counterpartyId, orgRef: undefined } }
    } as HumanView;
    const unrelated = source('agent_je');
    const unrelatedCase = { ...workCase };
    unrelated.caseQueue = [unrelatedCase];
    const aggregate: HumanView = { ...unrelated, inbox: { ...unrelated.inbox, id: 'inbox_all', ownerAgentId: null, organizationId: 'org_aggregate' }, agents, sourceViews: [unrelated, child], caseQueue: [unrelatedCase, workCase] };
    expect(caseSourceView(workCase, aggregate)).toBe(child);
    const markup = thread(aggregate);
    expect(markup).toContain(`<small>${label}</small><strong>Je</strong>`);
    expect(markup).toContain('<small>Your agent</small><strong>Rachel probe</strong>');
    expect(markup).toContain('>Block agent</button>');
    expect(thread(aggregate, unrelatedCase)).toContain('<small>Agent for Recipient organization</small>');
  });

  it('uses each aggregate row source, even when both copies have the same case id', () => {
    const sender = source('agent_je');
    const recipientCase = { ...workCase };
    const recipient = { ...source('agent_rachel'), caseQueue: [recipientCase] };
    const aggregate = { ...sender, inbox: { ...sender.inbox, ownerAgentId: null }, agents, sourceViews: [sender, recipient], caseQueue: [workCase, recipientCase] };
    expect(caseSourceView(workCase, aggregate)).toBe(sender);
    expect(caseSourceView(recipientCase, aggregate)).toBe(recipient);
    expect(row(aggregate, workCase)).toContain('<span class="thread-sender">Rachel probe</span>');
    expect(row(aggregate, recipientCase)).toContain('<span class="thread-sender">Je</span>');
    expect(thread(aggregate, recipientCase)).toContain('aria-label="Instructions for Rachel probe"');
    expect(localAgentId({ ...workCase }, aggregate)).toBeUndefined();
    expect(localAgentId({ ...workCase, id: 'case_not_in_sources' }, aggregate)).toBeUndefined();
    expect(caseSourceView({ ...workCase }, { ...aggregate, sourceViews: [recipient] })).toBe(recipient);
  });

  it.each(['missing', 'ambiguous', 'unrelated'] as const)('fails safely with %s local identity', kind => {
    let view = { ...source(null), agents };
    if (kind === 'ambiguous') view = { ...view, sourceViews: [source('agent_je'), source('agent_rachel')] };
    if (kind === 'unrelated') view = { ...view, inbox: { ...view.inbox, ownerAgentId: 'agent_unrelated' } };
    expect(localAgentId(workCase, view)).toBeUndefined();
    const markup = thread(view);
    expect(markup).toContain('Local identity unavailable');
    expect(markup).not.toContain('<small>Your agent</small>');
    expect(markup).not.toContain('participant-card mine');
    expect(markup).not.toContain('Block agent');
    expect(markup).toContain('Local permissions unavailable');
    expect(markup.match(/<input aria-label="Instructions unavailable[^>]+>/)?.[0]).toContain('disabled');
    const message = renderToStaticMarkup(createElement(ConversationEntry, { event: events[0], view, workCase }));
    expect(message).toContain('conversation-message theirs');
    expect(message).not.toContain('message-delivery');
    expect(exchangeParties(workCase, events[0], agents, view.participantDirectory).direction).toBe('betweenParties');
    expect(resolveParticipant(workCase, 'agent_je', agents).relationship).toBe('counterpartyAgent');
  });

  it('keeps unavailable counterparty identity explicit without adopting it as local', () => {
    const view = { ...source('agent_rachel'), participantDirectory: {} };
    const markup = thread(view);
    expect(markup).toContain('<small>Your agent</small><strong>Rachel probe</strong>');
    expect(markup).toContain('Agent je');
    expect(markup).toContain('Address unavailable');
    expect(resolveParticipant(workCase, 'agent_je', view.agents, {}, localAgentId(workCase, view))).toMatchObject({ relationship: 'unknown', accessState: 'unavailable' });
  });

  it('does not substitute the initiator when local agent metadata is unavailable', () => {
    const view = { ...source('agent_rachel'), agents: [agents[0]], participantDirectory: {} };
    const markup = thread(view);
    expect(markup).not.toContain('<small>Your agent</small><strong>Je</strong>');
    expect(markup).toContain('Local permissions unavailable');
    expect(markup).not.toContain('<h2>Je can</h2>');
    expect(markup.match(/<input aria-label="Instructions[^>]+>/)?.[0]).toContain('disabled');
  });

  it('preserves canonical recipient inference while changing viewer-relative direction', () => {
    const event = { ...events[0], payload: { text: 'Actor-only legacy message' } };
    const sender = source('agent_je');
    const recipient = source('agent_rachel');
    for (const [view, direction] of [[sender, 'outbound'], [recipient, 'inbound']] as const) {
      const exchange = exchangeParties(workCase, event, view.agents, view.participantDirectory, localAgentId(workCase, view));
      expect(exchange).toMatchObject({ sender: { id: 'agent_je' }, recipient: { id: 'agent_rachel' }, direction });
      const markup = renderToStaticMarkup(createElement(ConversationEntry, { event, view, workCase }));
      expect(markup).toContain(`conversation-message ${direction === 'outbound' ? 'mine' : 'theirs'}`);
    }
  });

  it('preserves requester-relative human instructions for both viewers', () => {
    const event = { ...events[0], actor: 'human_sender', payload: { senderHumanId: 'human_sender', messageType: 'instruction', text: 'Please check' } };
    const sender = renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view: source('agent_je') }));
    const recipient = renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view: source('agent_rachel') }));
    expect(sender).toContain('conversation-message mine');
    expect(sender).toContain('>You<');
    expect(recipient).toContain('conversation-message theirs');
    expect(recipient).not.toContain('>You<');
  });

  it('preserves the existing Milo preview perspective', () => {
    const item = previewView.caseQueue[0];
    const markup = thread(previewView, item);
    expect(markup).toContain('<small>Your agent</small><strong>Milo</strong>');
    expect(markup).toContain('Luma Events agent');
    expect(markup).toContain('aria-label="Instructions for Milo"');
    expect(markup).toContain('<h2>Milo can</h2>');
    expect(markup).toContain('conversation-message mine');
    expect(markup).toContain('conversation-message theirs');
  });
});
