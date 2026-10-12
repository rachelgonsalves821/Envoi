import type { Agent, AgentConnection } from './types';

export function agentLabel(agent: Agent): string {
  if (agent.status === 'revoked' || agent.credentialRevoked) return 'Revoked';
  if (agent.onboardingStatus === 'rejected') return 'Rejected';
  if (agent.onboardingStatus !== 'approved') return 'Pending';
  return agent.paused ? 'Paused' : 'Active';
}

/** Presence ages stay anchored to the server snapshot, including under clock skew. */
export function presenceAge(asOf: string, timestamp: string | null): string | null {
  if (!timestamp) return null;
  const age = Math.max(0, Date.parse(asOf) - Date.parse(timestamp));
  if (!Number.isFinite(age)) return null;
  const seconds = Math.floor(age / 1_000);
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function connectionLabel(connection?: AgentConnection): string {
  switch (connection?.state) {
    case 'seen_recently': return 'Seen recently';
    case 'not_seen_recently': {
      const relative = presenceAge(connection.asOf, connection.seenAt);
      return relative === null ? 'Status unknown' : `Last checked in ${relative}`;
    }
    case 'never_seen': return 'Not checked in yet';
    case 'not_connected': return 'Not connected';
    case 'needs_reconnect': return 'Needs reconnect';
    case 'pending_approval': return 'Waiting for approval';
    case 'rejected': return 'Not approved';
    case 'revoked': return 'Access revoked';
    default: return 'Status unknown';
  }
}
