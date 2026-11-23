import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';
import { AgentListeningNotice } from '../src/AgentListeningNotice';
import { listeningBadge, listeningBanner, listeningConnectorRuntime, listeningFixInstructions } from '../src/agent-listening';
import type { Installation } from '../src/onboarding/types';
import { envoiWorkRule } from '../src/quick-connect';
import type { Agent } from '../src/types';

const origin = 'https://www.envoi-agents.com';
const root = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(root).contracts.find(item => item.id === 'agent-listening-status');
if (process.env.ENVOI_CONTRACT_FIXTURES_ROOT && !contract) throw new Error('Missing agent-listening-status v1 fixtures');

type Banner = NonNullable<ReturnType<typeof listeningBanner>>;
interface OwnerFixture {
  id: string;
  context: { now: string };
  response: { body: Agent[] };
  client: { surface: string; badge: string; banner: (Banner & { copyText?: string }) | null };
}
const fixtures = contract?.fixtures.map(file => loadContractFixture(contract, file, root) as OwnerFixture)
  .filter(fixture => fixture.client.surface === 'owner_ui') ?? [];
const agent: Agent = { id: 'agent_mark', name: 'Mark', address: 'mark@envoi-agents.com', principalHumanId: 'human_example',
  status: 'active', onboardingStatus: 'approved', permissions: [] };
const receiving = { state: 'starting', since: '2026-11-12T19:20:00.000Z', lastAlertAt: null, endedReason: null,
  waiting: { count: 1, more: false, oldestAt: '2026-11-12T19:26:00.000Z' } };

it('omits both surfaces for absent and future states', () => {
  for (const backgroundReceiving of [undefined, { ...receiving, state: 'future' }]) {
    expect(listeningBadge(backgroundReceiving)).toBeNull();
    expect(listeningBanner({ ...agent, backgroundReceiving })).toBeNull();
  }
});

it('shows the Starting banner after 600 seconds and only while work is waiting', () => {
  const starting = { ...agent, backgroundReceiving: receiving };
  expect(listeningBanner(starting, '2026-11-12T19:30:00.000Z')).toBeNull();
  expect(listeningBanner(starting, '2026-11-12T19:30:01.000Z')?.action).toBe('monitoring_prompt');
  expect(listeningBanner({ ...agent, backgroundReceiving: { ...receiving, waiting: { count: 0, more: false, oldestAt: null } } }, '2026-11-12T19:30:01.000Z')).toBeNull();
});

it('uses the recorded connector runtime, including ended installations', () => {
  const installation = { status: 'ended', runtime: { type: 'hermes' } } as Installation;
  expect(listeningConnectorRuntime([installation])).toBe('hermes');
  expect(listeningConnectorRuntime([installation, { ...installation, status: 'active', runtime: { type: 'openclaw', version: null } }])).toBe('openclaw');
  expect(listeningConnectorRuntime([])).toBeUndefined();
});

// The server contract can be supplied from its publishing worktree before it reaches this PR's base.
if (fixtures.length) describe('agent-listening-status v1 owner fixtures', () => {
  it.each(fixtures)('$id renders its published badge, banner and action', fixture => {
    const [agent] = fixture.response.body;
    const expected = fixture.client.banner;
    const badge = agent.backgroundReceiving?.state === 'connector' ? null : fixture.client.badge;
    expect(listeningBadge(agent.backgroundReceiving)).toBe(badge);
    const banner = listeningBanner(agent, fixture.context.now);
    const html = renderToStaticMarkup(createElement(AgentListeningNotice, { agent, inboxId: 'inbox_example', onReconnect: vi.fn() }));
    if (!expected || !banner) {
      expect(banner).toBeNull();
      expect(expected).toBeNull();
      expect(html).toBe('');
      return;
    }
    const { copyText, ...expectedBanner } = expected;
    expect(banner).toEqual(expectedBanner);
    expect(html).toContain(expected.docs);
    const copy = listeningFixInstructions(banner, agent, origin, 'openclaw');
    if (expected.action === 'reconnect' || expected.action === 'none') {
      expect(copy).toBeNull();
      expect(html).not.toContain('Copy fix instructions');
      expect(html.includes('>Reconnect</button>')).toBe(expected.action === 'reconnect');
    } else {
      expect(html).toContain('Copy fix instructions');
      expect(copy).toContain(agent.address);
      if (expected.action === 'restart_connector') expect(copy).toBe(copyText);
      else expect(copy).toContain(envoiWorkRule());
    }
  });
});
