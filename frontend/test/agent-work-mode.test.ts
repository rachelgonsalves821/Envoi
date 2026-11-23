import path from 'node:path';
import Ajv from 'ajv';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkModeSetting } from '../src/AgentWorkModeSetting';
import { agentListeningBadge } from '../src/agent-listening';
import { saveDotsSetupMode, syncMessageFor } from '../src/agent-work-mode';
import type { Agent } from '../src/types';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';

const root = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const registry = loadContractRegistry(root);
const contract = registry.contracts.find(entry => entry.id === 'agent-work-mode');

interface WorkModeFixture {
  id: string;
  request: { method: string; path: string };
  response: { status: number; body: Record<string, unknown> };
}

if (contract) describe('agent-work-mode v1 inherited response shapes', () => {
  const fixtures = contract.fixtures.map(file => loadContractFixture(contract, file, root) as WorkModeFixture);
  const listening = registry.contracts.find(entry => entry.id === 'agent-listening-status');
  if (!listening?.schemas) throw new Error('Missing listening-status fixtures');
  const schema = loadContractFixture(listening, listening.schemas, root) as { $id: string };
  const ajv = new Ajv({ strict: false, allErrors: true }).addSchema(schema);
  const ownerAgent = ajv.getSchema(schema.$id + '#/definitions/ownerAgentWithListening')!;

  it.each(fixtures.filter(fixture => fixture.request.method === 'PUT' && fixture.response.status === 200))(
    '$id preserves the full owner agent view', fixture => {
      const { workMode, ...agent } = fixture.response.body;
      expect(workMode).toBeDefined();
      expect(ownerAgent(agent), ajv.errorsText(ownerAgent.errors)).toBe(true);
    }
  );

  it('keeps the existing claimed-work envelope for owner instructions in Off mode', () => {
    const fixture = fixtures.find(entry => entry.id === 'claim-off-connector-offers-instruction');
    expect(fixture?.response.body).toMatchObject({
      state: 'claimed',
      work: {
        workId: expect.any(String), leaseToken: expect.any(String), leaseExpiresAt: expect.any(String),
        message: { id: expect.any(String), kind: 'humanInstruction' }
      }
    });
  });
});

const agent: Agent = { id: 'agent_mark', name: 'Mark', address: 'mark@envoi-agents.com', principalHumanId: 'human_owner',
  status: 'active', onboardingStatus: 'approved', permissions: [],
  backgroundReceiving: { state: 'off', since: null, lastAlertAt: null, endedReason: null,
    waiting: { count: 1, more: false, oldestAt: '2026-11-15T17:00:00.000Z' } } };

function render(agent: Agent, canManage = true) {
  return renderToStaticMarkup(createElement(AgentWorkModeSetting, { agent, inboxId: 'inbox_mark', canManage, onRefresh: vi.fn() }));
}

afterEach(() => vi.unstubAllGlobals());

it('offers owner settings only when workMode is known and keeps the older banner otherwise', () => {
  const current: Agent = { ...agent, workMode: { mode: 'routine', updatedAt: null } };
  expect(render(current)).toContain('When messages arrive');
  expect(render(current)).toContain('Waiting for Mark to turn it on');
  expect(render(current)).toContain('Copy message');
  expect(render(current)).toContain('ChatGPT needs Mark to switch this on itself.');
  expect(render(current)).toContain('Pause holds all work until you resume.');
  expect(render(current).match(/role="tooltip"/g)).toHaveLength(3);
  expect(syncMessageFor(current)).toBe('Sync with Envoi for mark@envoi-agents.com');
  expect(render(current, false)).not.toContain('When messages arrive');
  expect(render(agent)).toContain('Copy fix instructions');
});

it('shows Off status for both agent types and hides the listening banner', () => {
  const current: Agent = { ...agent, workMode: { mode: 'off', updatedAt: null } };
  expect(render(current)).toContain('Off: Mark only works when you ask');
  expect(render({ ...current, backgroundReceiving: { ...current.backgroundReceiving!, state: 'connector' } })).toContain('Off: Mark only handles your instructions');
  expect(render(current)).not.toMatch(/Copy (message|fix instructions)/);
});

it('keeps the same action on the row and page until Envoi reports that the Dot is on', () => {
  const waiting = { ...agent.backgroundReceiving!, waiting: { count: 0, more: false, oldestAt: null } };
  const initial: Agent = { ...agent, workMode: { mode: 'ask', updatedAt: null }, backgroundReceiving: waiting };
  const listening: Agent = { ...initial, backgroundReceiving: { ...waiting, state: 'on' } };
  expect(agentListeningBadge(initial)).toBe('Action needed');
  expect(render(initial)).toContain('Copy message');
  expect(agentListeningBadge(listening)).toBe('Background receiving: On');
  expect(render(listening)).not.toContain('Copy message');
  expect(agentListeningBadge({ ...initial, backgroundReceiving: undefined })).toBeNull();
  expect(render({ ...initial, backgroundReceiving: undefined })).not.toContain('Copy message');
});

it.each(['routine', 'ask'] as const)('explains unavailable receiving in %s mode with or without waiting work', mode => {
  for (const count of [0, 1]) {
    const current: Agent = {
      ...agent, workMode: { mode, updatedAt: null },
      backgroundReceiving: { ...agent.backgroundReceiving!, state: 'unavailable',
        waiting: { count, more: false, oldestAt: count ? agent.backgroundReceiving!.waiting.oldestAt : null } }
    };
    expect(agentListeningBadge(current)).toBe('On demand only');
    const html = render(current);
    expect(html).toContain('Mark only works when you ask');
    expect(html).toContain('/docs/fix/#background-receiving-unavailable');
    expect(html).not.toContain('Sync with Envoi');
    if (count) expect(html).toContain('1 message is waiting');
  }
});

it('resolves the dedicated inbox and maps the wizard’s On demand choice to Off', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([
    { id: 'workspace', kind: 'workspace', ownerAgentId: null, status: 'active' },
    { id: 'inbox_elsewhere', kind: 'agent', parentInboxId: 'another_workspace', ownerAgentId: 'agent_mark', status: 'active' },
    { id: 'inbox_mark', kind: 'agent', parentInboxId: 'workspace', ownerAgentId: 'agent_mark', status: 'active' }
  ])).mockResolvedValueOnce(Response.json(agent));
  vi.stubGlobal('fetch', fetchMock);
  await saveDotsSetupMode('org', 'workspace', 'agent_mark', 'on_demand', new AbortController().signal);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/organizations/org/workspaces');
  expect(fetchMock.mock.calls[1]).toMatchObject([
    '/api/inboxes/inbox_mark/agents/agent_mark/work-mode', { method: 'PUT', body: JSON.stringify({ mode: 'off' }) }
  ]);
});
