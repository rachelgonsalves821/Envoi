import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionInvitations } from '../src/App';
import type { AgentConnectionInvitation, Inbox } from '../src/types';

const workspace: Inbox = {
  id: 'inbox_1',
  organizationId: 'org_1',
  name: 'Test workspace',
  ownerAgentId: 'agent_recipient',
  ownerHumanId: 'human_1',
  status: 'active',
  createdAt: '2026-09-27T18:00:00.000Z'
};

function invitation(overrides: Partial<AgentConnectionInvitation> = {}): AgentConnectionInvitation {
  return {
    id: 'invitation_pending',
    fromAddress: 'sender@sinaloa.example',
    toAddress: 'recipient@sinaloa.example',
    senderAgentId: 'agent_sender',
    recipientAgentId: 'agent_recipient',
    direction: 'incoming',
    actionable: true,
    state: 'pending',
    createdAt: '2026-09-27T19:00:00.000Z',
    updatedAt: '2026-09-27T19:00:00.000Z',
    ...overrides
  };
}

function renderInvitations(invitations: AgentConnectionInvitation[], canManageInbox = true) {
  return renderToStaticMarkup(createElement(ConnectionInvitations, {
    invitations,
    error: '',
    workspace,
    canManageInbox,
    onReload: vi.fn(),
    onRefresh: vi.fn(),
    notify: vi.fn()
  }));
}

describe('human invitation supervision', () => {
  it('renders clear decision controls only for pending invitations', () => {
    const markup = renderInvitations([
      invitation(),
      invitation({ id: 'invitation_accepted', fromAddress: 'accepted@sinaloa.example', state: 'accepted', conversationId: 'conversation_1' }),
      invitation({ id: 'invitation_declined', fromAddress: 'declined@sinaloa.example', state: 'declined' }),
      invitation({ id: 'invitation_superseded', fromAddress: 'retried@sinaloa.example', state: 'superseded' })
    ]);

    expect(markup).toContain('1 need review');
    expect(markup).toContain('sender@sinaloa.example');
    expect(markup).toContain('To recipient@sinaloa.example');
    expect(markup).toContain('>Accept</button>');
    expect(markup).toContain('>Decline</button>');
    expect(markup).not.toContain('Accept connection invitation from accepted@sinaloa.example');
    expect(markup).not.toContain('Decline connection invitation from declined@sinaloa.example');
    expect(markup).not.toContain('Accept connection invitation from retried@sinaloa.example');
  });

  it('renders outgoing pending invitations as non-actionable status', () => {
    const markup = renderInvitations([
      invitation({ direction: 'outgoing', actionable: false, fromAddress: 'mine@sinaloa.example', toAddress: 'other@sinaloa.example' })
    ]);

    expect(markup).toContain('0 need review');
    expect(markup).toContain('other@sinaloa.example');
    expect(markup).toContain('From mine@sinaloa.example');
    expect(markup).toContain('Awaiting recipient approval');
    expect(markup).not.toContain('>Accept</button>');
    expect(markup).not.toContain('>Decline</button>');
  });

  it('shows the supervised empty state without decision controls', () => {
    const markup = renderInvitations([]);

    expect(markup).toContain('No incoming invitations');
    expect(markup).not.toContain('>Accept</button>');
    expect(markup).not.toContain('>Decline</button>');
  });

  it('keeps incoming invitations visible but not actionable for read-only members', () => {
    const markup = renderInvitations([invitation()], false);

    expect(markup).toContain('sender@sinaloa.example');
    expect(markup).toContain('0 need review');
    expect(markup).not.toContain('>Accept</button>');
    expect(markup).not.toContain('>Decline</button>');
  });
});
