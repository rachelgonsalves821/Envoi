import test from 'node:test';
import assert from 'node:assert/strict';
import { replayResponse, scopedIdempotencyPath, semanticDigest, validateIdempotencyKey } from '../src/idempotency.js';
import { humanConversationMessagingEnabled } from '../src/human-messaging.js';

test('idempotency records are tenant scoped and require exact canonical requests', () => {
  const left = scopedIdempotencyPath('onboarding', 'org_a', 'human_a', 'retry-key');
  const right = scopedIdempotencyPath('onboarding', 'org_b', 'human_b', 'retry-key');
  assert.notEqual(left, right);
  assert.equal(left.includes('retry-key'), false);
  const requestDigest = semanticDigest({ name: 'Agent', capabilities: ['schedule'], nested: { b: 2, a: 1 } });
  assert.equal(requestDigest, semanticDigest({ nested: { a: 1, b: 2 }, capabilities: ['schedule'], name: 'Agent' }));
  const response = { account: { id: 'agent_1' } };
  assert.deepEqual(replayResponse({ principalId: 'human_a', requestDigest, response }, { principalId: 'human_a', requestDigest }), response);
  assert.throws(() => replayResponse({ principalId: 'human_a', requestDigest, response }, { principalId: 'human_a', requestDigest: semanticDigest({ name: 'Different' }) }), /different request/);
});

test('idempotency keys are bounded and human conversation injection is disabled in production', () => {
  assert.equal(validateIdempotencyKey('safe-key'), 'safe-key');
  for (const value of ['', 'x'.repeat(201), 'bad\nkey']) assert.throws(() => validateIdempotencyKey(value, { required: true }), /required|invalid/);
  assert.equal(humanConversationMessagingEnabled({ SINALOA_AUTH_MODE: 'production' }), false);
  assert.equal(humanConversationMessagingEnabled({ SINALOA_AUTH_MODE: 'development' }), true);
});
