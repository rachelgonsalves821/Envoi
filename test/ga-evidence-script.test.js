import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence } from '../scripts/ga-evidence.mjs';

// Gate GA: the extractor publishes only allow-listed fields from a saved owner view.
test('events keep ids, types, times and evidence fields, in sequence order, and drop everything else', () => {
  const page = { events: [
    { id: 'evt_2', sequence: 2, type: 'agent.work_failed', createdAt: '2026-10-13T10:00:02.000Z', workId: 'msg_1', attempts: 1, retryable: true, retryAt: '2026-10-13T10:00:07.000Z', text: 'private body' },
    { id: 'evt_1', sequence: 1, type: 'agent.credentials_rotated', createdAt: '2026-10-13T10:00:01.000Z', credentialFamilyId: 'credential_family_1', recovered: true, refreshExpiresAt: '2026-11-12T10:00:01.000Z', subject: 'private' }
  ], cursor: 'c2' };
  const table = extractEvidence('events', page);
  const lines = table.split('\n');
  assert.match(lines[0], /^\| sequence \| id \| type \| createdAt \|/);
  assert.ok(lines[2].includes('evt_1') && lines[3].includes('evt_2'), 'sorted by sequence');
  assert.ok(table.includes('recovered') && table.includes('retryAt'));
  assert.doesNotMatch(table, /private/);
});

test('deliveries drop the worker lease token and error text; agents keep the presence projection', () => {
  const deliveries = extractEvidence('deliveries', [{ id: 'delivery_msg_1', messageId: 'msg_1', status: 'delivered', attempts: 1, maxAttempts: 8, deadLetteredAt: null, leaseToken: 'secret-lease', lastError: 'stack trace' }]);
  assert.doesNotMatch(deliveries, /secret-lease|stack trace|leaseToken|lastError/);
  assert.match(deliveries, /\| delivery_msg_1 \| msg_1 \| delivered \| 1 \| 8 \|/);
  const agents = extractEvidence('agents', [{ id: 'agent_1', status: 'paused', paused: true, permissions: ['send_agent_messages'], connection: { state: 'paused', credentialExpiresAt: '2026-11-12T10:00:00.000Z', presence: { lastSuccessfulRefreshAt: '2026-10-13T10:00:00.000Z' } } }]);
  assert.match(agents, /connection\.presence\.lastSuccessfulRefreshAt/);
  assert.doesNotMatch(agents, /send_agent_messages/, 'only listed fields');
});

test('a value that looks like a credential, free text or a nested object is refused, not published', () => {
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', reasonCode: 'Bearer abc' }] }), /credential/);
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', reasonCode: 'envoi_agent_access_abc' }] }), /credential/);
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', reasonCode: 'x'.repeat(161) }] }), /long text/);
  assert.throws(() => extractEvidence('receipts', [{ id: 'r', state: { nested: true } }]), /nested/);
  assert.throws(() => extractEvidence('messages', []), /Usage/);
  assert.throws(() => extractEvidence('events', [{ id: 'evt_1' }]), /expected list/);
});

test('--since keeps only items at or after that time', () => {
  const page = { events: [
    { id: 'evt_old', sequence: 1, type: 'a', createdAt: '2026-10-13T09:00:00.000Z' },
    { id: 'evt_new', sequence: 2, type: 'b', createdAt: '2026-10-13T11:00:00.000Z' }
  ] };
  const table = extractEvidence('events', page, { since: '2026-10-13T10:00:00.000Z' });
  assert.ok(table.includes('evt_new') && !table.includes('evt_old'));
  assert.throws(() => extractEvidence('events', page, { since: 'yesterday' }), /ISO/);
});
