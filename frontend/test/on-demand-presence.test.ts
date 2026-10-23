import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { AgentCard } from '../src/App';
import { connectionLabel, lastContactLabel } from '../src/agent-presence';
import type { Agent, Inbox } from '../src/types';

interface OwnerFixture {
  id: string;
  response: { body: Agent | Agent[] };
  client: { surface: string; agentLabel: string; connectionLabel: string; connectionDetail?: string };
}

const contract = contractRegistry.contracts.find(item => item.id === 'a5-presence-on-demand')!;
const fixtures = contract.fixtures.map(filename => loadContractFixture(contract, filename) as OwnerFixture)
  .filter(fixture => fixture.client.surface === 'owner_ui');
const agentFrom = (fixture: OwnerFixture) => Array.isArray(fixture.response.body) ? fixture.response.body[0] : fixture.response.body;
const workspace: Inbox = {
  id: 'inbox_example', organizationId: 'org_example', name: 'Example inbox', ownerAgentId: 'agent_example',
  ownerHumanId: 'human_example', status: 'active', createdAt: '2026-10-01T09:00:00.000Z'
};

describe('a5-presence-on-demand owner consumer', () => {
  it('consumes the separate thirteen-fixture amendment without changing the frozen v1 fixture set', () => {
    expect(contract).toMatchObject({ id: 'a5-presence-on-demand', version: 1 });
    expect(fixtures).toHaveLength(13);
    expect(contractRegistry.contracts.find(item => item.id === 'a5-presence')?.fixtures).toHaveLength(16);
  });

  it.each(fixtures)('$id renders the contracted agent, connection and detail from the server snapshot', fixture => {
    const agent = agentFrom(fixture);
    const detail = fixture.client.connectionDetail?.replace('{relative}',
      agent.connection?.seenAt ? connectionLabel({ ...agent.connection, state: 'not_seen_recently' }).replace('Last checked in ', '') : '');
    const expected = [fixture.client.agentLabel, fixture.client.connectionLabel, detail].filter(Boolean).join(' · ');
    const markup = renderToStaticMarkup(createElement(AgentCard, {
      agent, workspace, humanId: workspace.ownerHumanId, canManageInbox: true,
      emailTransport: null, onRefresh: vi.fn(), notify: vi.fn()
    }));
    expect(markup).toContain(`<span class="agent-presence">${expected}</span>`);
    if (agent.connection?.state === 'on_demand') {
      expect(markup).not.toMatch(/Seen recently|Not checked in yet|Last checked in|\b(Online|Running|Connected|Offline|Failing)\b/);
      expect(markup).not.toContain('needs attention');
    }
  });

  it('uses a neutral, clock-independent last-request age and retains the old-client fallback', () => {
    const agent = agentFrom(fixtures.find(fixture => fixture.id === 'owner-on-demand-idle')!);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:00Z'));
    expect(connectionLabel(agent.connection)).toBe('On demand · Last request 9 days ago');
    expect(connectionLabel({ ...agent.connection!, state: 'future_state' })).toBe('Status unknown');
    expect(connectionLabel({ ...agent.connection!, seenAt: 'invalid' })).toBe('Status unknown');
    vi.restoreAllMocks();
  });

  it('calls recorded on-demand activity a request in existing-agent replacement review', () => {
    const agent = agentFrom(fixtures.find(fixture => fixture.id === 'owner-on-demand-idle')!);
    expect(connectionLabel(agent.connection)).toContain('Last request 9 days ago');
    expect(lastContactLabel(agent.connection)).toBe('Last request');
    expect(lastContactLabel({ ...agent.connection!, state: 'seen_recently' })).toBe('Last check-in');
  });
});
