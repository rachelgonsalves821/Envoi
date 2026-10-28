import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppShell, EnrollmentDialog } from '../src/App';
import { ConnectionActions } from '../src/onboarding/ConnectPage';
import type { HumanView, Inbox } from '../src/types';

const workspace = { id: 'inbox_primary', organizationId: 'org_primary', ownerHumanId: 'human_primary', ownerAgentId: null, name: 'Workspace', status: 'active', createdAt: '2026-10-25T12:00:00Z' } as Inbox;
const view = { inbox: workspace, canManageInbox: true, mode: 'human-observer', agents: [], caseQueue: [], cases: [], messages: [], assets: [], folders: [], participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [], calendarProviders: {}, summary: { agents: 0, cases: 0, messages: 0, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 }, capabilities: [] } as HumanView;

describe('owner agent onboarding stays in the workspace', () => {
  it('renders a button instead of a separate-page link', () => {
    const html = renderToStaticMarkup(createElement(ConnectionActions, { onConnect: vi.fn() }));
    expect(html).toContain('<button type="button" class="button primary">Connect an agent</button>');
    expect(html).not.toContain('href="/connect"');
    expect(html).not.toContain('claim code');
  });

  it('makes the popup the primary action on Manage agents', () => {
    const html = renderToStaticMarkup(createElement(AppShell, { config: { provider: 'local', hosted: false }, human: { id: 'human_primary', displayName: 'Owner' }, organizations: [], workspaces: [workspace], workspace, view, initialSection: 'integrations', onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: '' }));
    expect(html).toContain('Connect an agent</button>');
    expect(html).not.toContain('href="/connect"');
    expect(html).not.toContain('Advanced · Quick Connect');
    for (const agent of ['openclaw', 'hermes', 'grok', 'muse', 'instinct', 'dots']) expect(html).toContain('/agents/' + agent + '.');
  });

  it('shows the three owner steps and six agent choices in the popup', () => {
    const html = renderToStaticMarkup(createElement(EnrollmentDialog, { workspace, result: null, setResult: vi.fn(), onClose: vi.fn() }));
    expect(html).toContain('Agent type');
    expect(html).toContain('Email address');
    expect(html).toContain('Setup instructions');
    for (const agent of ['OpenClaw', 'Hermes', 'Grok', 'Muse', 'Instinct', 'Dots']) expect(html).toContain(agent);
  });

  it('wires all workspace Connect actions to the popup', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ConnectionActions onConnect={onConnect} />');
    expect(source).toContain('onConnect={openConnect}');
    expect(source).toContain('{connectOpen && <EnrollmentDialog');
    expect(source).not.toContain('onAdvancedConnect');
  });
});
