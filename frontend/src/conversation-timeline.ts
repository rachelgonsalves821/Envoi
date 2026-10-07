import type { CaseEvent } from './types';

export function collapseMessageProgress(events: CaseEvent[]): CaseEvent[] {
  const collapsed: CaseEvent[] = [];
  const messagePositions = new Map<string, number>();

  for (const event of events) {
    const messageId = event.payload.messageId;
    if (event.type !== 'message' || typeof messageId !== 'string' || !messageId.trim()) {
      collapsed.push(event);
      continue;
    }

    const position = messagePositions.get(messageId);
    if (position === undefined) {
      messagePositions.set(messageId, collapsed.length);
      collapsed.push(event);
      continue;
    }

    const deliveryState = event.payload.deliveryState;
    if (typeof deliveryState === 'string' && deliveryState.trim()) {
      const original = collapsed[position];
      collapsed[position] = { ...original, payload: { ...original.payload, deliveryState } };
    }
  }

  return collapsed;
}
