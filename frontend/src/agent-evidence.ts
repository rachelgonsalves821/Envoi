import type { Agent } from './types';

export function ownerAgentEvidence(agents: Agent[], agentId: string) {
  if (!Array.isArray(agents) || !/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('Owner evidence unavailable.');
  const agent = agents.find(item => item.id === agentId);
  const connection = agent?.connection;
  if (!agent || !connection?.presence) throw new Error('An authenticated owner connection view is required.');
  return JSON.stringify([{
    id: agent.id, name: agent.name, address: agent.address, status: agent.status,
    paused: agent.paused, credentialRevoked: agent.credentialRevoked,
    connection: {
      state: connection.state, asOf: connection.asOf, seenAt: connection.seenAt,
      credentialExpiresAt: connection.credentialExpiresAt,
      presence: {
        lastSeenAt: connection.presence.lastSeenAt,
        lastSuccessfulRefreshAt: connection.presence.lastSuccessfulRefreshAt,
        lastWorkClaimAt: connection.presence.lastWorkClaimAt,
        lastProcessedAt: connection.presence.lastProcessedAt
      }
    }
  }], null, 2);
}

export function downloadOwnerEvidence(contents: string, agentId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('Owner evidence unavailable.');
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `agents-${agentId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
