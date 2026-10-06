import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard } from '../src/App';
import type { Agent, Inbox } from '../src/types';

const workspace: Inbox = {
  id: 'inbox_muse', organizationId: 'org_1', name: 'Muse inbox', ownerAgentId: 'agent_muse',
  ownerHumanId: 'human_1', status: 'active', createdAt: '2026-10-06T00:00:00.000Z'
};
const muse: Agent = {
  id: 'agent_muse', name: 'Muse test', address: 'muse@agents.envoi-agents.com', runtime: 'muse',
  principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved',
  permissions: ['receive_agent_messages']
};

function renderAgent(agent: Agent, canManageInbox: boolean) {
  return renderToStaticMarkup(createElement(AgentCard, {
    agent, workspace, humanId: 'human_1', canManageInbox, emailTransport: null,
    onRefresh: async () => {}, notify: vi.fn()
  }));
}

describe('Muse staging send grant control', () => {
  it('offers an explicit one-message grant only for an active Muse identity managed by the owner', () => {
    expect(renderAgent(muse, true)).toContain('Allow one Muse test message');
    expect(renderAgent(muse, false)).not.toContain('Allow one Muse test message');
    expect(renderAgent({ ...muse, runtime: 'hermes' }, true)).not.toContain('Allow one Muse test message');
    expect(renderAgent({ ...muse, pausedAt: '2026-10-06T00:01:00.000Z' }, true)).not.toContain('Allow one Muse test message');
    expect(renderAgent({ ...muse, status: 'revoked', credentialRevoked: true }, true)).not.toContain('Allow one Muse test message');
  });
});
