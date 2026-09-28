import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard, AgentPermissionPicker, DecisionCard } from '../src/App';
import { DEFAULT_AGENT_PERMISSIONS, selectedAgentPermissions } from '../src/agent-permissions';
import type { Agent, HumanView, Inbox, WorkCase } from '../src/types';

describe('agent permission review', () => {
  it('defaults to messaging without file sharing or task execution', () => {
    expect(selectedAgentPermissions(DEFAULT_AGENT_PERMISSIONS)).toEqual(['receive_agent_messages', 'send_agent_messages']);
    const markup = renderToStaticMarkup(createElement(AgentPermissionPicker, { selected: DEFAULT_AGENT_PERMISSIONS, onChange: vi.fn() }));
    expect(markup).toContain('Execute tasks');
    expect(markup).toContain('Share files');
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it('includes elevated access only when explicitly selected', () => {
    expect(selectedAgentPermissions(['execute_cases'])).toEqual(['receive_agent_messages', 'execute_cases']);
    expect(selectedAgentPermissions(['create_assets', 'send_agent_messages'])).toEqual(['receive_agent_messages', 'send_agent_messages', 'create_assets']);
  });
});

describe('human action visibility', () => {
  const workCase = {
    id: 'case_1', objective: 'Approve the deposit', state: 'waitingForHuman',
    decision: { question: 'Approve the deposit?', availableActions: ['approveOnce', 'pause'] }
  } as WorkCase;
  const view = { agents: [], participantDirectory: {}, messages: [] } as unknown as HumanView;

  function renderDecision(canManageInbox: boolean) {
    return renderToStaticMarkup(createElement(DecisionCard, {
      workCase, view, events: [], canManageInbox, busy: null, onAction: vi.fn(), onPolicy: vi.fn()
    }));
  }

  it('shows decisions for observation without exposing mutation controls', () => {
    const markup = renderDecision(false);
    expect(markup).toContain('Workspace administrator review');
    expect(markup).toContain('Approve the deposit?');
    expect(markup).not.toContain('class="decision-actions"');
  });

  it('shows decision actions to authorized workspace managers', () => {
    const markup = renderDecision(true);
    expect(markup).toContain('class="decision-actions"');
    expect(markup).toContain('Pause conversation');
  });

  it('lets a linked human review their pending agent without exposing other agents', () => {
    const agent = { id: 'agent_1', name: 'Milo', address: 'milo@sinaloa.mail', principalHumanId: 'human_1', status: 'pending_approval', onboardingStatus: 'pending_approval', permissions: [] } as Agent;
    const workspace = { id: 'inbox_1', ownerHumanId: 'human_1' } as Inbox;
    const props = { agent, workspace, emailTransport: null, canManageInbox: false, onRefresh: vi.fn(), notify: vi.fn() };
    const linked = renderToStaticMarkup(createElement(AgentCard, { ...props, humanId: 'human_1' }));
    const unrelated = renderToStaticMarkup(createElement(AgentCard, { ...props, humanId: 'human_2' }));
    expect(linked).toContain('Review agent access');
    expect(unrelated).not.toContain('Review agent access');
  });
});
