import { api, ApiError } from './api';
import type { DotsWorkMode } from './quick-connect';
import type { Agent, AgentWorkMode } from './types';

export function agentWorkMode(agent: Pick<Agent, 'workMode'>): AgentWorkMode | undefined {
  const mode = agent.workMode?.mode;
  return mode === 'routine' || mode === 'ask' || mode === 'off' ? mode : undefined;
}

export function syncMessageFor(agent: Pick<Agent, 'address'>): string {
  return `Sync with Envoi for ${agent.address}`;
}

export function isOnDemandAgent(agent: Agent): boolean {
  return agent.connection?.state === 'on_demand' ||
    ['off', 'on', 'failing', 'starting', 'unavailable'].includes(agent.backgroundReceiving?.state ?? '');
}

export function needsDotReceivingSync(agent: Agent): boolean {
  const mode = agentWorkMode(agent);
  const status = agent.backgroundReceiving;
  return (mode === 'routine' || mode === 'ask') && Boolean(status && status.state !== 'connector' && status.state !== 'on' && isOnDemandAgent(agent));
}

export async function saveDotsSetupMode(organizationId: string, workspaceInboxId: string, agentId: string, mode: DotsWorkMode, signal: AbortSignal) {
  const inboxes = await api.workspaces(organizationId, signal);
  const targets = inboxes.filter(inbox => inbox.kind === 'agent' && inbox.parentInboxId === workspaceInboxId
    && inbox.ownerAgentId === agentId && inbox.status !== 'removed');
  if (targets.length !== 1) throw new Error('The new agent inbox is not available yet.');
  try {
    await api.setAgentWorkMode(targets[0].id, agentId, mode === 'on_demand' ? 'off' : mode, signal);
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
  }
}
