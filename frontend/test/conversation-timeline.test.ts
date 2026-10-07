import { describe, expect, it } from 'vitest';
import { collapseMessageProgress } from '../src/conversation-timeline';
import type { CaseEvent } from '../src/types';

function event(id: string, payload: CaseEvent['payload'], overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    id, type: 'message', actor: 'human_owner', createdAt: '2026-10-06T12:00:00.000Z',
    payload, linkedPolicyEvaluation: null, precedingEventRef: null, ...overrides
  };
}

describe('collapseMessageProgress', () => {
  it('renders one human instruction with its latest delivery state and original attribution', () => {
    const delivered = event('instruction_delivered', {
      messageId: 'instruction_one', messageType: 'instruction', text: 'Ask about Tuesday.',
      senderType: 'human', senderHumanId: 'human_owner', recipientAgentId: 'agent_owner', deliveryState: 'delivered'
    }, { summary: 'Human instruction', precedingEventRef: 'earlier_event', linkedPolicyEvaluation: 'original_policy' });
    const acknowledged = event('instruction_acknowledged', {
      ...delivered.payload, deliveryState: 'acknowledged', authority: 'untrusted later field'
    }, { actor: 'agent_owner', createdAt: '2026-10-06T12:01:00.000Z', linkedPolicyEvaluation: 'different_policy' });
    const processed = event('instruction_processed', {
      ...delivered.payload, text: 'Later text must not replace the original.', deliveryState: 'processed'
    }, { actor: 'agent_owner', createdAt: '2026-10-06T12:02:00.000Z' });

    expect(collapseMessageProgress([delivered, acknowledged, processed])).toEqual([
      { ...delivered, payload: { ...delivered.payload, deliveryState: 'processed' } }
    ]);
  });

  it('preserves reply bubbles, distinct same-text messages and their first positions', () => {
    const instruction = event('instruction', { messageId: 'instruction_one', text: 'Same text', deliveryState: 'delivered' });
    const reply = event('reply', { messageId: 'reply_one', messageType: 'instructionReply', text: 'Same text', inReplyTo: 'instruction_one' }, { actor: 'agent_owner' });
    const separate = event('separate', { messageId: 'instruction_two', text: 'Same text', deliveryState: 'delivered' });
    const processed = event('progress', { messageId: 'instruction_one', deliveryState: 'processed' }, { actor: 'agent_owner' });

    expect(collapseMessageProgress([instruction, reply, separate, processed])).toEqual([
      { ...instruction, payload: { ...instruction.payload, deliveryState: 'processed' } }, reply, separate
    ]);
  });

  it('never collapses receipts, actions or state changes even when they reference the same message', () => {
    const message = event('message', { messageId: 'message_one', text: 'Hello', deliveryState: 'delivered' });
    const receipt = event('receipt', { messageId: 'message_one', deliveryState: 'acknowledged' }, { type: 'receipt' });
    const action = event('action', { messageId: 'message_one', action: 'approveOnce' }, { type: 'humanAction' });
    const stateChange = event('state', { messageId: 'message_one', from: 'new', to: 'inProgress' }, { type: 'stateChange' });
    const processed = event('processed', { messageId: 'message_one', deliveryState: 'processed' });

    expect(collapseMessageProgress([message, receipt, action, stateChange, processed])).toEqual([
      { ...message, payload: { ...message.payload, deliveryState: 'processed' } }, receipt, action, stateChange
    ]);
  });

  it('keeps every message without a nonblank string message ID', () => {
    const events = [undefined, null, '', '   ', 42, {}, []].flatMap((messageId, index) => [
      event(`first_${index}`, { messageId, text: 'Same text' }),
      event(`second_${index}`, { messageId, text: 'Same text' })
    ]);

    expect(collapseMessageProgress(events)).toEqual(events);
  });

  it('uses supplied event order for progress without ranking statuses or sorting timestamps', () => {
    const first = event('first', { messageId: 'message_one', text: 'Hello', deliveryState: 'processed' });
    const later = event('later', { messageId: 'message_one', deliveryState: 'failed' });
    const last = event('last', { messageId: 'message_one', deliveryState: 'retrying' }, { createdAt: '2026-10-05T12:00:00.000Z' });

    expect(collapseMessageProgress([first, later, last])).toEqual([
      { ...first, payload: { ...first.payload, deliveryState: 'retrying' } }
    ]);
  });

  it('does not erase the latest status when duplicate events omit or have invalid progress', () => {
    const first = event('first', { messageId: 'message_one', text: 'Hello', deliveryState: 'delivered' });
    const acknowledged = event('acknowledged', { messageId: 'message_one', deliveryState: 'acknowledged' });
    const incomplete = [undefined, null, '', '   ', 42, {}].map((deliveryState, index) =>
      event(`incomplete_${index}`, { messageId: 'message_one', deliveryState }));

    expect(collapseMessageProgress([first, acknowledged, ...incomplete])).toEqual([
      { ...first, payload: { ...first.payload, deliveryState: 'acknowledged' } }
    ]);
  });

  it('preserves source records and is idempotent for already collapsed timelines', () => {
    const events = [
      event('first', { messageId: 'message_one', text: 'Hello', deliveryState: 'delivered' }),
      event('second', { messageId: 'message_one', text: 'Hello', deliveryState: 'processed' })
    ];
    const before = structuredClone(events);
    for (const item of events) { Object.freeze(item.payload); Object.freeze(item); }
    Object.freeze(events);

    const collapsed = collapseMessageProgress(events);
    expect(events).toEqual(before);
    expect(collapsed).not.toBe(events);
    expect(collapsed[0]).not.toBe(events[0]);
    expect(collapseMessageProgress(collapsed)).toEqual(collapsed);
    expect(collapseMessageProgress([])).toEqual([]);
  });
});
