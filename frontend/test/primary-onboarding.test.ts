import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { AppShell } from '../src/App';
import { ConnectionActions } from '../src/onboarding/ConnectPage';
import type { HumanView, Inbox } from '../src/types';

const registration = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
const availability = (name: string) => (loadContractFixture(registration, `${name}.json`) as any).response.body;

/** Follow the state which renders the legacy dialog, rather than relying on a setter's spelling. */
function legacyEntryViolations(source: string) {
  const gate = source.match(/\{([\w$]+)\s*&&\s*<EnrollmentDialog\b/)?.[1];
  if (!gate) throw new Error('Missing legacy dialog gate');
  const setter = source.match(new RegExp(`const\\s*\\[${gate},\\s*([\\w$]+)\\]`))?.[1];
  if (!setter) throw new Error('Missing legacy dialog gate');
  const violations: string[] = [];
  let openings = 0;
  for (const match of source.matchAll(new RegExp(`\\b${setter}\\(true\\)`, 'g'))) {
    openings++;
    const position = match.index!;
    const entry = source.slice(source.lastIndexOf('<', position), position);
    const attribute = entry.match(/\b(on\w+)=\{\(\)\s*=>\s*$/)?.[1];
    if (!entry.startsWith('<IntegrationsPage ') || attribute !== 'onAdvancedConnect') violations.push(attribute || 'non-explicit entry');
  }
  if (openings !== 1) violations.push('legacy entry count');
  return violations;
}

describe('primary onboarding uses the common claim journey', () => {
  it.each(['routes-available', 'routes-available-rest'])('offers common connect and claim links for %s', name => {
    const html = renderToStaticMarkup(createElement(ConnectionActions, { initialAvailability: availability(name) }));
    expect(html).toContain('href="/connect"');
    expect(html).toContain('href="/claim"');
    expect(html).not.toMatch(/enrollment|token|Grok|OAuth|setup file/i);
  });

  it.each([undefined, null, {}, availability('routes-disabled')])('keeps unavailable or unknown routes behind the availability page', body => {
    const html = renderToStaticMarkup(createElement(ConnectionActions, { initialAvailability: body }));
    expect(html).toContain('Check available connections');
    expect(html).not.toContain('href="/claim"');
    expect(html).not.toContain('class="button primary"');
  });

  it('does not turn malformed server availability into a working route', () => {
    const body = structuredClone(availability('routes-available'));
    body.routes[0].available = 'true';
    const html = renderToStaticMarkup(createElement(ConnectionActions, { initialAvailability: body }));
    expect(html).toContain('Check available connections');
    expect(html).not.toContain('href="/claim"');
  });

  it('keeps legacy token setup inside Advanced on the actual agent-management page', () => {
    const workspace = { id: 'inbox_primary', organizationId: 'org_primary', ownerHumanId: 'human_primary', ownerAgentId: null, name: 'Workspace', status: 'active', createdAt: '2026-10-25T12:00:00Z' } as Inbox;
    const view = { inbox: workspace, canManageInbox: true, mode: 'human-observer', agents: [], caseQueue: [], cases: [], messages: [], assets: [], folders: [], participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [], calendarProviders: {}, summary: { agents: 0, cases: 0, messages: 0, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 }, capabilities: [] } as HumanView;
    const html = renderToStaticMarkup(createElement(AppShell, { config: { provider: 'local', hosted: false }, human: { id: 'human_primary', displayName: 'Owner' }, organizations: [], workspaces: [workspace], workspace, view, initialSection: 'integrations', onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: '' }));
    expect(html).toContain('href="/connect"');
    const advanced = html.match(/<details class="onboarding-advanced">[\s\S]*?<\/details>/)?.[0];
    expect(advanced).toContain('Advanced · Quick Connect');
    expect(advanced).toContain('Set up with legacy Quick Connect');
    expect(html.replace(advanced!, '')).not.toContain('Set up with legacy Quick Connect');
    expect(html).not.toContain('Copy agent prompt');
    expect(html).not.toContain('Download setup file');
  });

  it('allows opening the shell legacy dialog only through the explicit Advanced callback', () => {
    expect(legacyEntryViolations(readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'))).toEqual([]);
  });

  it('detects the former primary-button token-flow regression independently of state names', () => {
    const old = `export function AppShell() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Connect an agent</button>{open && <EnrollmentDialog />}</>;
    }`;
    expect(legacyEntryViolations(old)).toEqual(['onClick']);
  });
});
