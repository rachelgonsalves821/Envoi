import { describe, expect, it } from 'vitest';
import { grokBotTestReply } from '../src/onboarding/GrokBotVerification';
import type { DeliveryReceipt, Message } from '../src/types';

const text = 'Envoi Grok Bot reply test with a unique marker';
const createdAt = '2026-11-12T12:00:00Z';
const request: Message = { id: 'request', caseId: 'case', senderType: 'agent', senderAgentId: 'peer', recipientAgentId: 'bot', type: 'request', text, createdAt, status: 'processed' };
const reply: Message = { id: 'msg_work_reply_test', caseId: request.caseId, causationId: request.id, senderType: 'agent', senderAgentId: 'bot', recipientAgentId: 'peer', type: 'message', text: 'Confirmed', createdAt, status: 'delivered' };
const receipt: DeliveryReceipt = { id: 'receipt', type: 'delivery', messageId: request.id, recipientAgentId: 'bot', state: 'processed', createdAt };

describe('Grok Bot test evidence', () => {
  it('requires a peer request, its processed receipt, and the Bot reply linked to that request', () => {
    expect(grokBotTestReply({ messages: [request, reply], deliveryReceipts: [receipt] }, 'bot', text)).toEqual(reply);
    expect(grokBotTestReply({ messages: [request, reply], deliveryReceipts: [] }, 'bot', text)).toBeUndefined();
    expect(grokBotTestReply({ messages: [request], deliveryReceipts: [receipt] }, 'bot', text)).toBeUndefined();
    expect(grokBotTestReply({ messages: [request, reply], deliveryReceipts: [receipt] }, 'bot', `${text}!`)).toBeUndefined();
  });

  it.each([
    { senderAgentId: 'another-bot' }, { recipientAgentId: 'another-peer' }, { caseId: 'other-case' },
    { causationId: 'another-request' }, { id: 'msg_regular' }
  ])('ignores unrelated or ordinary outbound messages (%j)', patch => {
    expect(grokBotTestReply({ messages: [request, { ...reply, ...patch }], deliveryReceipts: [receipt] }, 'bot', text)).toBeUndefined();
  });
});
