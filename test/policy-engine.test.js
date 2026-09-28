import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExactBinding,
  classifyAction,
  createWorkspacePolicy,
  evaluatePolicy,
  requiresPolicyEvaluation,
  verifyDecisionChain,
  verifyDecisionRecord
} from '../src/policy-engine.js';

const now = '2026-09-27T20:00:00.000Z';
const policy = createWorkspacePolicy({ version: 'v1', consequentialActionsEnabled: true, externalEmailEnabled: true, calendarWritesEnabled: true, maxPaymentMinorWithoutHuman: 10_000 });
const base = { id: 'eval_1', workspaceId: 'inbox_1', caseId: 'case_1', agentId: 'agent_1', permissionGranted: true, now, policy };

test('action registry fails closed for renamed and unknown external effects', () => {
  assert.equal(classifyAction('case.classify'), 'safeInternal');
  assert.equal(requiresPolicyEvaluation('case.classify'), false);
  for (const action of ['wireFunds', 'funds.transfer', 'commitment.renamed']) {
    assert.equal(classifyAction(action), 'unknown');
    assert.equal(requiresPolicyEvaluation(action), true);
    assert.equal(evaluatePolicy({ ...base, requestedAction: action }).reasonCode, 'unsupportedAction');
  }
});

test('malformed workspace policies are rejected instead of clamped', () => {
  assert.throws(() => createWorkspacePolicy({ version: '', decisionTtlSeconds: 'NaN' }), /invalid/);
  assert.throws(() => createWorkspacePolicy({ version: 'v1', decisionTtlSeconds: 2 }), /invalid/);
  assert.throws(() => createWorkspacePolicy({ version: 'v1', maxPaymentMinorWithoutHuman: -1 }), /invalid/);
});

test('malformed execution timestamps are denied instead of ignored', () => {
  const result = evaluatePolicy({ ...base, requestedAction: 'payment.send', actionPayload: { counterparties: ['payee'], amount: { minorUnits: 10, currency: 'USD' }, executeAt: 'not-a-date' } });
  assert.equal(result.decision, 'deny');
  assert.equal(result.reasonCode, 'invalidExecutionWindow');
});

test('records bind exact counterparties, amounts, and execution time tolerance', () => {
  const payload = { counterparties: [{ type: 'human', email: 'PAYEE@example.com' }], amount: { minorUnits: 5000, currency: 'cad' }, executeAt: '2026-09-27T20:02:00Z' };
  const record = evaluatePolicy({ ...base, requestedAction: 'payment.send', actionPayload: payload, requestedExpiresAt: '2026-09-27T20:10:00Z' });
  assert.equal(record.decision, 'allow');
  assert.doesNotThrow(() => assertExactBinding(record, { requestedAction: 'payment.send', actionPayload: payload, at: '2026-09-27T20:02:30Z' }));
  assert.throws(() => assertExactBinding(record, { requestedAction: 'payment.send', actionPayload: payload, at: '2026-09-27T20:00:59Z' }), /earlier/);
  assert.throws(() => assertExactBinding(record, { requestedAction: 'payment.send', actionPayload: { ...payload, amount: { minorUnits: 9000, currency: 'CAD' } }, at: '2026-09-27T20:02:00Z' }), /binding changed/);
});

test('decision chains fail closed for removal, rewriting, and missing predecessors', () => {
  const first = evaluatePolicy({ ...base, requestedAction: 'case.classify' });
  const second = evaluatePolicy({ ...base, id: 'eval_2', requestedAction: 'case.classify', previousRecordDigest: first.recordDigest, now: '2026-09-27T20:00:01Z' });
  const third = evaluatePolicy({ ...base, id: 'eval_3', requestedAction: 'case.classify', previousRecordDigest: second.recordDigest, now: '2026-09-27T20:00:02Z' });
  assert.equal(verifyDecisionChain([first, second, third]), true);
  assert.equal(verifyDecisionChain([first, third]), false);
  assert.equal(verifyDecisionChain([first, { ...second, decision: 'deny' }, third]), false);
  assert.equal(verifyDecisionChain([{ ...first, previousRecordDigest: 'missing' }]), false);
});

test('key rotation verifies old records, signs new records with active key, and rejects revoked keys', () => {
  const oldKey = 'old-policy-signing-key-material-000001';
  const newKey = 'new-policy-signing-key-material-000002';
  const oldRecord = evaluatePolicy({ ...base, requestedAction: 'case.classify', keyring: { activeKeyId: 'old', keys: { old: oldKey } } });
  const rotated = { activeKeyId: 'new', keys: { old: oldKey, new: newKey } };
  const newRecord = evaluatePolicy({ ...base, id: 'eval_2', requestedAction: 'case.classify', previousRecordDigest: oldRecord.recordDigest, now: '2026-09-27T20:00:01Z', keyring: rotated });
  assert.equal(oldRecord.integrityKeyId, 'old');
  assert.equal(newRecord.integrityKeyId, 'new');
  assert.equal(verifyDecisionChain([oldRecord, newRecord], { keyring: rotated }), true);
  assert.equal(verifyDecisionRecord(oldRecord, { keyring: { activeKeyId: 'new', keys: { new: newKey } } }), false);
  assert.equal(verifyDecisionRecord({ ...newRecord, integrityKeyId: 'unknown' }, { keyring: rotated }), false);
  const unsigned = evaluatePolicy({ ...base, id: 'unsigned', requestedAction: 'case.classify' });
  assert.equal(verifyDecisionRecord(unsigned, { keyring: rotated, requireSigned: true }), false);
  assert.equal(verifyDecisionRecord(unsigned, { keyring: rotated }), false);
});
