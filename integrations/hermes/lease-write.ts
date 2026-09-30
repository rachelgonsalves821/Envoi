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
