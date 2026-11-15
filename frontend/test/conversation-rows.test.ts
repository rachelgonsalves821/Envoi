import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ConversationEntry } from '../src/App';
import { timelineForCase } from '../src/model';
import type { CaseEvent, HumanView, WorkCase } from '../src/types';

const workCase = { id: 'case_rows', principal: 'human_owner', actingAgent: 'agent_mine' } as WorkCase;
const view = {
  inbox: { id: 'inbox_mine', ownerAgentId: 'agent_mine' },
  messages: [],
  agents: [{ id: 'agent_mine', displayName: 'Milo' }],
  requester: { id: 'human_owner', auth: { provider: 'local', assurance: 'totp' } },
  participantDirectory: {
    agent_mine: { id: 'agent_mine', type: 'internalAgent', displayName: 'Milo', accessState: 'active' },
    agent_other: { id: 'agent_other', type: 'externalAgent', displayName: 'Ledger Co billing agent', accessState: 'active' }
  }
} as unknown as HumanView;

function message(id: string, sender: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'message', actor: sender, createdAt, payload: { senderAgentId: sender, messageType: 'counteroffer', text: 'Hello there', deliveryState: 'delivered', ...extra }, linkedPolicyEvaluation: null, precedingEventRef: null } as unknown as CaseEvent;
}
const render = (event: CaseEvent, previous?: CaseEvent) => renderToStaticMarkup(createElement(ConversationEntry, { event, previous, workCase, view }));

it('groups consecutive messages from one sender within ten minutes', () => {
  const first = message('e1', 'agent_other', '2026-10-06T12:00:00Z');
  expect(render(message('e2', 'agent_other', '2026-10-06T12:02:00Z'), first)).toContain('conversation-message theirs continued');
  expect(render(message('e3', 'agent_other', '2026-10-06T12:20:00Z'), first)).not.toContain('continued');
});

it('labels own-agent messages and human instructions with distinct roles and avatars', () => {
  const own = render(message('e4', 'agent_mine', '2026-10-06T12:00:00Z'));
  expect(own).toContain('conversation-message mine own-agent');
  expect(own).toContain('>Your agent<');
  expect(own).toContain('lucide-bot');
  const instruction = render({ ...message('e5', 'human_owner', '2026-10-06T12:00:00Z'), payload: { senderHumanId: 'human_owner', messageType: 'instruction', text: 'Pay it', deliveryState: 'delivered' } } as unknown as CaseEvent);
  expect(instruction).not.toContain('own-agent');
  expect(instruction).toContain('lucide-user-round');
  expect(instruction).toContain('>Human<');
  expect(instruction).toContain('>Owner instruction<');
});

it('labels peer agents in direct and group chats without giving them the own-agent styling', () => {
  const event = message('peer', 'agent_other', '2026-10-06T12:00:00Z');
  expect(render(event)).toContain('>External agent<');
  const group = renderToStaticMarkup(createElement(ConversationEntry, {
    event, workCase: { ...workCase, caseMode: 'group', members: [] }, view
  }));
  expect(group).toContain('>Agent<');
  expect(group).toContain('lucide-bot');
  expect(group).not.toContain('own-agent');
});

it.each([
  ['approveOnce', 'human_owner', 'Rachel Gonsalves', 'approved'],
  ['decline', 'human_teammate', 'Sam Lee', 'rejected'],
  ['decline', 'human_missing', undefined, 'rejected']
])('attributes a recorded %s to the actor in the workspace timeline', (actionKey, actorId, actorDisplayName, verb) => {
  const [event] = timelineForCase({
    ...workCase,
    timeline: [{
      id: 'decision', type: 'humanAction', actorId, actorDisplayName,
      createdAt: '2026-10-06T12:00:00Z', summary: 'Legacy action summary.',
      policyEvaluationId: null, payload: { action: { actionKey, outcome: 'ok' } }
    }]
  }, []);
  const markup = render(event);
  expect(markup).toContain(`<strong>${actorDisplayName || 'A workspace member'}</strong><span class="meta-role">Human</span>`);
  expect(markup).toContain('lucide-user-round');
  expect(markup).toContain(`${verb[0].toUpperCase()}${verb.slice(1)} the agent proposal`);
});

it('keeps failed actions and agent messages out of the human decision history', () => {
  const agentEvent = message('agent-event', 'agent_other', '2026-10-06T12:00:00Z', {
    action: { actionKey: 'approveOnce', outcome: 'ok' }
  });
  expect(render(agentEvent)).not.toContain('proposal-decision');
  expect(render({
    ...agentEvent, type: 'humanAction',
    payload: { action: { actionKey: 'decline', outcome: 'failed' } }
  })).not.toContain('proposal-decision');
});

it.each(['direct', 'group'])('renders a download in the viewing inbox for a %s chat attachment', mode => {
  const event = message('e6', 'agent_other', '2026-10-06T12:00:00Z', {
    attachments: [{ id: 'obj_pdf', filename: 'proposal.pdf' }]
  });
  const markup = renderToStaticMarkup(createElement(ConversationEntry, {
    event, workCase: mode === 'group' ? { ...workCase, caseMode: 'group', members: [] } : workCase, view
  }));
  expect(markup).toContain('href="/api/inboxes/inbox_mine/assets/obj_pdf/content"');
  expect(markup).toContain('download="proposal.pdf"');
  expect(markup).toContain('Download proposal.pdf');
});
