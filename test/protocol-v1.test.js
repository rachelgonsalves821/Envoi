import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidProtocolMessage, createProtocolMessage, PROTOCOL_VERSION } from '../src/protocol-v1.js';

test('Sinaloa Protocol v1 creates a strict agent message envelope', () => {
  const message = createProtocolMessage({
    messageId: 'msg_1',
    conversationId: 'conversation_1',
    correlationId: 'msg_0',
    causationId: 'proposal_1',
    from: { agentId: 'agent_a', address: 'a@envoi.mail' },
    to: [{ agentId: 'agent_b', address: 'b@envoi.mail' }],
    intent: 'counteroffer',
    text: 'Could we meet at 3:30 instead?',
    authority: { scope: 'calendar.schedule', humanApproval: 'notRequired' },
    artifactRefs: ['asset_1'],
    createdAt: '2026-10-01T15:00:00.000Z'
  });

  assert.equal(message.schemaVersion, PROTOCOL_VERSION);
  assert.equal(message.intent, 'counteroffer');
  assert.equal(message.content[0].text, 'Could we meet at 3:30 instead?');
  assert.equal(assertValidProtocolMessage(message), message);
});

test('Sinaloa Protocol v1 rejects incomplete envelopes', () => {
  assert.throws(() => assertValidProtocolMessage({ schemaVersion: '1.0' }), /does not satisfy/);
});
