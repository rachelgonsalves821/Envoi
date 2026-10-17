import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence } from '../scripts/ga-evidence.mjs';

// Gate GA: the extractor publishes only allow-listed fields from a saved owner view.
test('events keep ids, types, times and evidence fields, in sequence order, and drop everything else', () => {
  const page = { events: [
    { id: 'evt_2', sequence: 2, type: 'agent.work_failed', createdAt: '2026-10-13T10:00:02.000Z', workId: 'msg_1', attempts: 1, retryable: true, retryAt: '2026-10-13T10:00:07.000Z', text: 'private body' },
    { id: 'evt_1', sequence: 1, type: 'agent.refresh_recovered', createdAt: '2026-10-13T10:00:01.000Z', credentialFamilyId: 'credential_family_1', refreshExpiresAt: '2026-11-12T10:00:01.000Z', subject: 'private' }
  ], cursor: 'c2' };
  const table = extractEvidence('events', page);
  const lines = table.split('\n');
  assert.match(lines[0], /^\| sequence \| id \| type \| createdAt \|/);
  assert.ok(lines[2].includes('evt_1') && lines[3].includes('evt_2'), 'sorted by sequence');
  assert.ok(table.includes('refreshExpiresAt') && table.includes('retryAt'));
  assert.doesNotMatch(table, /private/);
});

test('deliveries drop the worker lease token and error text; agents keep the presence projection', () => {
  const deliveries = extractEvidence('deliveries', [{ id: 'delivery_msg_1', messageId: 'msg_1', status: 'delivered', attempts: 1, maxAttempts: 8, deadLetteredAt: null, leaseToken: 'secret-lease', lastError: 'stack trace' }]);
  assert.doesNotMatch(deliveries, /secret-lease|stack trace|leaseToken|lastError/);
  // Step 8: an explicit null deadLetteredAt is evidence and keeps its column.
  assert.equal(deliveries.split('\n')[0], '| id | messageId | status | attempts | maxAttempts | deadLetteredAt |');
  assert.equal(deliveries.split('\n')[2], '| delivery_msg_1 | msg_1 | delivered | 1 | 8 | null |');
  const agents = extractEvidence('agents', [{ id: 'agent_1', status: 'paused', paused: true, permissions: ['send_agent_messages'], connection: { state: 'paused', credentialExpiresAt: '2026-11-12T10:00:00.000Z', presence: { lastSuccessfulRefreshAt: '2026-10-13T10:00:00.000Z' } } }]);
  assert.match(agents, /connection\.presence\.lastSuccessfulRefreshAt/);
  assert.doesNotMatch(agents, /send_agent_messages/, 'only listed fields');
});

test('a value that looks like a credential, free text or a nested object is refused, not published', () => {
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', caseId: 'Bearer abc' }] }), /credential/);
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', caseId: 'case_envoi_agent_access_abc' }] }), /credential/);
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', caseId: 'x'.repeat(161) }] }), /long text/);
  // A client-chosen reason must be a code, never free text.
  assert.throws(() => extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', reasonCode: 'Ask Bob re invoice 4471' }] }), /upper-case code/);
  assert.match(extractEvidence('events', { events: [{ id: 'evt_1', sequence: 1, type: 'x', reasonCode: 'HANDLER_FAILED' }] }), /HANDLER_FAILED/);
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
  assert.throws(() => extractEvidence('deliveries', [], { since: '2026-10-13T10:00:00.000Z' }), /does not apply/);
  assert.equal(extractEvidence('events', page, { since: '2026-10-14T00:00:00.000Z' }), 'No events matched.');
});

// Gate B-local: the installation list and owner claim list publish ids, states and times only.
test('installations and claims keep the allow-listed projection; registration events keep their ids', () => {
  const installations = extractEvidence('installations', { agentId: 'agent_1', installations: [
    { id: 'installation_1', agentId: 'agent_1', status: 'ended', endedReason: 'activation_replay', legacy: false, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', runtime: { type: 'hermes', version: '0.9.0' }, createdAt: '2026-10-17T10:00:00.000Z', activatedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:05:00.000Z' }
  ] });
  assert.equal(installations.split('\n')[0], '| id | status | endedReason | legacy | connectionRoute | deliveryMode | runtime.type | runtime.version | activatedAt | endedAt |');
  assert.match(installations, /installation_1 \| ended \| activation_replay \| false/);
  const claims = extractEvidence('claims', { claims: [
    { registrationId: 'registration_1', status: 'activated', target: 'new_agent', agent: { name: 'Private name', address: 'gate@envoi.mail' }, effectivePermissions: ['send_agent_messages'], approvedAt: '2026-10-17T10:01:00.000Z', activationExpiresAt: '2026-10-17T10:11:00.000Z', installationId: 'installation_1', approvedByMe: true }
  ] });
  assert.match(claims, /registration_1 \| activated \| new_agent \| gate@envoi\.mail/);
  assert.doesNotMatch(claims, /Private name|send_agent_messages/, 'names and permissions are not listed');
  const events = extractEvidence('events', { events: [
    { id: 'evt_9', sequence: 9, type: 'agent.installation_activated', createdAt: '2026-10-17T10:02:00.000Z', agentId: 'agent_1', installationId: 'installation_1', registrationId: 'registration_1', target: 'new_agent', connectionRoute: 'local_helper', deliveryMode: 'envoi_link', permissions: ['send_agent_messages'], humanId: 'human_1' }
  ] });
  assert.match(events, /installationId/);
  assert.match(events, /registration_1/);
  assert.doesNotMatch(events, /human_1/, 'the approving human id is not published');
  assert.throws(() => extractEvidence('claims', { claims: [{ registrationId: 'envoi_reg_leak', status: 'approved' }] }), /credential/);
});
