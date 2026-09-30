import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { mcpReplyMessageId } from '../agent-bridges/bridge';

export interface ActiveHermesWork { message: WorkMessage; signal: AbortSignal }

/** A Hermes tool reply may address only the sender and case of its current fenced work item. */
export function authorizedHermesReply(active: ActiveHermesWork | null, name: string, args: Record<string, unknown>) {
  const id = mcpReplyMessageId(name, args);
  return Boolean(id && active && active.message.id === id && !active.signal.aborted
    && active.message.caseId && args.caseId === active.message.caseId
    && args.recipientAddress === active.message.from.address);
}

/** Interactive Hermes turns may initiate work; a bridge-owned turn remains fenced to its sender and case. */
export function authorizedHermesWrite(active: ActiveHermesWork | null, name: string, args: Record<string, unknown>) {
  if (active) return authorizedHermesReply(active, name, args);
  if (!['sinaloa_start_case', 'sinaloa_send_message', 'sinaloa_send_proposal', 'sinaloa_send_decision'].includes(name)) return false;
  // A delayed reply from an expired work lease must never become an interactive send.
  return typeof args.idempotencyKey === 'string' && !args.idempotencyKey.startsWith('bridge:');
}
