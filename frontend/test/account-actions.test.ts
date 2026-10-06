import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AgentCard, FailureScreen, LoadingScreen, SignOutControl } from '../src/App';
import type { Agent, Inbox } from '../src/types';

it('keeps the same explicit sign-out control on application, loading and recovery screens', () => {
  const onLogout = vi.fn();
  const controls = [
    createElement(SignOutControl, { onLogout }),
    createElement(LoadingScreen, { onLogout }),
    createElement(FailureScreen, { message: 'Try again', onRetry: vi.fn(), onLogout })
  ];
  for (const control of controls) {
    const markup = renderToStaticMarkup(control);
    expect(markup).toContain('account-actions');
    expect(markup).toContain('Sign out');
  }
});

it('offers removal separately from freezing and hides management actions from non-managers', () => {
  const props = {
    agent: { id: 'agent_owned', name: 'Milo', address: 'milo@agents.envoi-agents.com', status: 'active', onboardingStatus: 'approved', permissions: [] } as unknown as Agent,
    workspace: { id: 'inbox_owned', ownerHumanId: 'human_owner' } as Inbox,
    humanId: 'human_owner', emailTransport: null, onRefresh: vi.fn(), notify: vi.fn()
  };
  const manager = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: true }));
  expect(manager).toContain('Remove agent');
  expect(manager).toContain('Revoke agent access');
  const member = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: false }));
  expect(member).not.toContain('Remove agent');
  expect(member).not.toContain('Revoke agent access');
});
