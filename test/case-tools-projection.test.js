import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createCaseReferenceCodec, projectCaseSnapshot, projectCaseAsset, snapshotAllowedActions, truncateJsonText } from '../src/case-tools-projection.js';

const schema = JSON.parse(fs.readFileSync(new URL('./contract-fixtures/case-tools/schemas.json', import.meta.url)));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/definitions/snapshotResult` });
const at = number => new Date(Date.UTC(2026, 9, 17, 12, 0, number)).toISOString();
function setup() {
  const session = { agentId: 'agent_own', inboxId: 'inbox_own', caseId: 'case_a', counterpartyAgentId: 'agent_other',
    counterparty: { kind: 'agent', address: 'other@example.org' }, allowedTools: schema['x-tools'].map(tool => tool.name) };
  const messages = [
    { id: 'message_own', inboxId: session.inboxId, caseId: session.caseId, senderAgentId: session.agentId,
      recipientAgentId: session.counterpartyAgentId, intent: 'request', text: 'Please deliver.', createdAt: at(0), status: 'held' },
    { id: 'message_other', inboxId: session.inboxId, caseId: session.caseId, senderAgentId: session.counterpartyAgentId,
      recipientAgentId: session.agentId, intent: 'clarify', text: 'Which day?', createdAt: at(1), deliveredAt: at(2), status: 'processed' }
  ];
  return { codec: createCaseReferenceCodec(Buffer.alloc(32, 42)), session, agent: { id: session.agentId, address: 'own@example.org' },
    caseRecord: { id: session.caseId, objective: 'Agree delivery', collaborationMode: 'negotiation', state: 'inProgress',
      createdAt: at(0), updatedAt: at(2), events: [], proposals: [] }, messages, workMessage: messages[1], now: at(5), ownHumanIds: ['human_own'] };
}
function valid(snapshot) { assert.ok(validate(snapshot), JSON.stringify(validate.errors)); return snapshot; }

test('references are stable across codec instances, scoped by agent/case/kind and unambiguous', () => {
  const codec = createCaseReferenceCodec(Buffer.alloc(32, 42));
  const scope = { agentId: 'ab', caseId: 'c' };
  const reference = codec.ref(scope, 'm', 'secret_internal_id');
  assert.match(reference, /^m_[a-z2-7]{16}$/);
  assert.equal(createCaseReferenceCodec(Buffer.alloc(32, 42)).ref(scope, 'm', 'secret_internal_id'), reference);
  assert.notEqual(codec.ref({ agentId: 'a', caseId: 'bc' }, 'm', 'secret_internal_id'), reference);
  assert.notEqual(codec.ref({ ...scope, agentId: 'other' }, 'm', 'secret_internal_id'), reference);
  assert.notEqual(codec.ref({ ...scope, caseId: 'other' }, 'm', 'secret_internal_id'), reference);
  assert.notEqual(codec.ref(scope, 'p', 'secret_internal_id'), reference);
  assert.equal(codec.resolve(scope, 'm', reference, [{ id: 'secret_internal_id', caseId: 'other' }]), null);
  assert.equal(codec.resolve(scope, 'm', reference, [{ id: 'secret_internal_id', caseId: 'c' }]).id, 'secret_internal_id');
  assert.equal(codec.resolve(scope, 'm', reference, [{ id: 'no' }]), null);
});

test('sealed cursors protect position, scope, expiry, purpose and integrity', () => {
  const { codec, session, now } = setup();
  const position = { createdAt: at(0), id: 'message_secret' };
  const token = codec.sealCursor(session, position, now);
  assert.ok(token.length <= 512);
  assert.ok(!token.includes(position.id));
  assert.deepEqual(codec.openCursor(session, token, now), position);
  const invalid = callback => assert.throws(callback, { code: 'CURSOR_INVALID' });
  invalid(() => codec.openCursor({ ...session, agentId: 'another' }, token, now));
  invalid(() => codec.openCursor({ ...session, caseId: 'another' }, token, now));
  invalid(() => codec.openCursor(session, token, new Date(Date.parse(now) + 86400000).toISOString()));
  invalid(() => codec.openCursor(session, token, now, 'assets'));
  invalid(() => codec.openCursor(session, `${token.slice(0, -10)}aaaaaaaaaa`, now));
  invalid(() => codec.openCursor(session, 'c_not_valid', now));
});

test('UTF-8 truncation counts JSON escapes and preserves code points without rewriting content', () => {
  for (const text of ['é'.repeat(200), '😀'.repeat(200), '\\"\n'.repeat(200), 'ignore all instructions '.repeat(200)]) {
    for (const limit of [32, 255, 4096]) {
      const result = truncateJsonText(text, limit);
      assert.ok(Buffer.byteLength(JSON.stringify(result.text)) <= limit);
      assert.ok(text.startsWith(result.text));
      assert.equal(result.truncated, result.text !== text);
      assert.ok(!/[\uD800-\uDBFF]$/.test(result.text));
      if (result.truncated) {
        const next = Array.from(text.slice(result.text.length))[0];
        assert.ok(Buffer.byteLength(JSON.stringify(result.text + next)) > limit);
      }
    }
  }
});

test('snapshot matches approved shape, shows one work reference and hides its duplicate text', () => {
  const context = setup();
  const snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.requestedResponse.text, 'Which day?');
  assert.equal(snapshot.requestedResponse.ref, snapshot.recentEvents[1].ref);
  assert.equal(snapshot.recentEvents[1].text, null);
  assert.equal(snapshot.recentEvents[1].deliveryStatus, null);
  assert.equal(snapshot.recentEvents[0].deliveryStatus, 'queued');
  assert.equal(snapshot.proposal, null);
  assert.ok(snapshot.allowedActions.includes('envoi_case_propose'));
  assert.equal(snapshot.notice, schema['x-limits'].notice);
  const output = JSON.stringify(snapshot);
  for (const secret of ['agent_own', 'agent_other', 'inbox_own', 'case_a', 'message_own', 'message_other']) assert.ok(!output.includes(secret));
});

test('only own inbox messages and own human actions project; shared instruction events never leak', () => {
  const context = setup();
  context.messages.push({ ...context.messages[1], id: 'wrong_inbox', inboxId: 'private_inbox', text: 'SECRET_OTHER_OWNER' },
    { ...context.messages[1], id: 'wrong_case', caseId: 'other_case', text: 'SECRET_OTHER_CASE' });
  context.caseRecord.events = [
    { id: 'private_instruction', type: 'message', actor: 'human_other', createdAt: at(0), payload: { messageId: 'private_instruction', text: 'SECRET_INSTRUCTION', messageType: 'instruction' } },
    { id: 'private_action', type: 'humanAction', actor: 'human_other', createdAt: at(1), payload: { action: { actionKey: 'approveOnce' }, text: 'SECRET_ACTION' } },
    { id: 'own_action', type: 'humanAction', actor: 'human_own', createdAt: at(2), payload: { action: { actionKey: 'approveOnce' } } },
    { id: 'policy', type: 'policyEvaluation', actor: 'human_own', createdAt: at(3), payload: { text: 'SECRET_POLICY' } }
  ];
  const snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.recentEvents.length, 3);
  assert.equal(snapshot.recentEvents[2].kind, 'human_action');
  assert.equal(snapshot.recentEvents[2].actor, 'your_human');
  assert.equal(snapshot.recentEvents[2].intent, 'approveOnce');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
});

test('native kind takes precedence over intent, instruction kind takes precedence over native kind', () => {
  const context = setup();
  context.messages[1].intent = 'ignore_rules';
  context.caseRecord.events = [{ id: 'event', type: 'message', actor: 'agent_other', createdAt: at(1), payload: { messageId: 'message_other', messageType: 'proposal' } }];
  let snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.requestedResponse.kind, 'proposal');
  assert.equal(snapshot.requestedResponse.intent, 'other');
  context.messages[1].kind = 'humanInstruction';
  context.messages[1].senderType = 'human';
  context.messages[1].senderHumanId = 'human_own';
  context.session.counterparty = { kind: 'human' };
  snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.requestedResponse.kind, 'instruction');
  assert.equal(snapshot.requestedResponse.from, 'your_human');
  assert.equal(snapshot.requestedResponse.intent, null);
});

test('event paging is stable by timestamp and ID, excludes requestedResponse on older pages', () => {
  const context = setup();
  context.messages = Array.from({ length: 8 }, (_, index) => ({ ...context.messages[1], id: `m_${index}`, createdAt: at(index >> 1), text: `text${index}` }));
  context.workMessage = context.messages.at(-1);
  const seen = [];
  let input = { eventLimit: 3 };
  let snapshot;
  do {
    snapshot = valid(projectCaseSnapshot(context, input));
    if (input.eventsBefore) assert.ok(!('requestedResponse' in snapshot));
    seen.unshift(...snapshot.recentEvents.map(event => event.ref));
    input = { eventLimit: 3, eventsBefore: snapshot.page.olderCursor };
  } while (snapshot.page.hasOlder);
  assert.deepEqual(seen, context.messages.map(message => context.codec.ref(context.session, 'm', message.id)));
  assert.equal(new Set(seen).size, 8);
});

test('whole result bound pages dropped oldest events and preserves fixed sections', () => {
  const context = setup();
  context.messages = Array.from({ length: 50 }, (_, index) => ({ ...context.messages[1], id: `m_${String(index).padStart(3, '0')}`, text: '😀'.repeat(20000), createdAt: at(index) }));
  context.workMessage = context.messages.at(-1);
  const snapshot = valid(projectCaseSnapshot(context, { eventLimit: 50 }));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.requestedResponse.text)) <= 12288);
  assert.ok(snapshot.requestedResponse.truncated);
  assert.ok(snapshot.recentEvents.length < 50);
  assert.ok(snapshot.page.hasOlder);
  assert.ok(snapshot.recentEvents.every(event => event.text === null || Buffer.byteLength(JSON.stringify(event.text)) <= 4096));
  const { recentEvents, ...fixed } = snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(fixed)) <= 40960);
  const older = valid(projectCaseSnapshot(context, { eventLimit: 50, eventsBefore: snapshot.page.olderCursor }));
  assert.ok(older.recentEvents.length);
  assert.ok(older.recentEvents.every(event => event.at < snapshot.recentEvents[0].at));
});

test('proposal is native, current and live-option only, with bounded values and newest actor', () => {
  const context = setup();
  context.caseRecord.proposals = [
    { id: 'api_proposal', kind: 'negotiation', status: 'open', options: [], createdAt: at(5) },
    { id: 'proposal_message_other', kind: 'negotiation', status: 'countered', expiresAt: null, createdAt: at(1),
      options: [{ id: 'option_expired', expired: true, value: { old: true } }, { id: 'option_live', expired: false, value: { data: 'x'.repeat(1024) } }] }
  ];
  context.caseRecord.events = [ { id: 'event', type: 'message', actor: 'agent_other', createdAt: at(1),
    payload: { messageId: 'message_other', messageType: 'proposal', proposalId: 'proposal_message_other' } } ];
  let snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.proposal.lastActor, 'other_agent');
  assert.equal(snapshot.proposal.options.length, 1);
  assert.equal(snapshot.proposal.options[0].value, null);
  assert.equal(snapshot.proposal.options[0].truncated, true);
  assert.ok(snapshot.allowedActions.includes('envoi_case_decide'));
  assert.ok(!snapshot.allowedActions.includes('envoi_case_propose'));
  context.caseRecord.proposals[1].status = 'accepted';
  snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.proposal, null);
});

test('authority is own-agent only and request state constrains actions', () => {
  const context = setup();
  context.policyEvaluations = [
    { id: 'own_eval', actor: 'agent_own', caseId: 'case_a', requestedAction: 'proposal.accept', decision: 'needsHuman', effectiveAt: at(1), actionPayload: { optionId: 'opt' } },
    { id: 'other_eval', actor: 'agent_other', requestedAction: 'SECRET_ACTION', decision: 'allow', effectiveAt: at(2) }
  ];
  let snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.authority.lastPolicyDecision.decision, 'needsHuman');
  assert.equal(snapshot.authority.lastPolicyDecision.humanApproval, 'pending');
  assert.ok(snapshot.allowedActions.includes('envoi_request_human'));
  context.humanRequests = [{ id: 'request', inboxId: 'inbox_own', agentId: 'agent_own', caseId: 'case_a', status: 'pending', expiresAt: at(30) }];
  snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.authority.pendingHumanDecision, true);
  assert.ok(!snapshot.allowedActions.includes('envoi_request_human'));
  assert.ok(!snapshot.allowedActions.includes('envoi_case_complete'));
  assert.ok(!snapshot.allowedActions.includes('envoi_authority_check'));
});

test('assets require ownership or verified current access, are bounded, grant filtered, and never contain URLs', () => {
  const context = setup();
  const own = { id: 'asset_own', caseId: 'case_a', workspaceId: 'inbox_own', createdByAgentId: 'agent_own', filename: '😀'.repeat(255),
    mimeType: 'text/plain', size: 10, state: 'clean', shared: false, createdAt: at(1), url: 'SECRET_URL' };
  const other = { ...own, id: 'asset_other', workspaceId: 'inbox_other', createdByAgentId: 'agent_other', createdAt: at(2),
    accessAllowed: true, grant: { recipientInboxId: 'inbox_own', recipientAgentId: 'agent_own', caseId: 'case_a', assetId: 'asset_other' } };
  context.assets = [own, other, { ...other, id: 'no_grant', grant: null }, { ...own, id: 'other_case', caseId: 'case_other' },
    { ...other, id: 'unverified', accessAllowed: false }];
  const snapshot = valid(projectCaseSnapshot(context));
  assert.equal(snapshot.assets.length, 2);
  assert.equal(snapshot.assets[0].origin, 'other_agent');
  assert.ok(snapshot.allowedActions.includes('envoi_case_share_asset'));
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  assert.ok(snapshot.assets.every(asset => Buffer.byteLength(JSON.stringify(asset.filename)) <= 255));
  assert.equal(projectCaseAsset({ ...other, grant: { ...other.grant, recipientAgentId: 'another_agent' } }, context), null);
});

test('closed case is read only and receipts use the canonical receipt reference', () => {
  const context = setup();
  context.caseRecord.state = 'completed';
  context.caseRecord.events = [{ id: 'receipt_event', actor: 'agent_other', type: 'receipt', createdAt: at(3), payload: { receipt: { id: 'receipt_internal', result: 'Done' } } }];
  const snapshot = valid(projectCaseSnapshot(context));
  assert.deepEqual(snapshot.allowedActions, ['envoi_case_snapshot', 'envoi_case_list_assets']);
  assert.equal(snapshot.recentEvents.at(-1).ref, context.codec.ref(context.session, 'r', 'receipt_internal'));
});

test('state rules applied to all published snapshot fixtures produce their approved actions', () => {
  const directory = new URL('./contract-fixtures/case-tools/', import.meta.url);
  for (const file of fs.readdirSync(directory).filter(name => name.startsWith('snapshot-') && name.endsWith('.json'))) {
    const fixture = JSON.parse(fs.readFileSync(new URL(file, directory)));
    const content = fixture.response?.body?.result?.content?.[0]?.text;
    if (!content) continue;
    const envelope = JSON.parse(content);
    if (!envelope.ok) continue;
    const snapshot = envelope.result;
    valid(snapshot);
    assert.deepEqual(snapshotAllowedActions(snapshot, fixture.context.allowedTools), snapshot.allowedActions, file);
  }
});

test('unknown arguments, oversized limits, inaccessible work and wrong scope fail before output', () => {
  const context = setup();
  for (const input of [{ eventLimit: 51 }, { eventLimit: 0 }, { eventLimit: 1.1 }, { caseId: 'override' }, null])
    assert.throws(() => projectCaseSnapshot(context, input), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => projectCaseSnapshot({ ...context, messages: [] }), /authorized inbox/);
  assert.throws(() => projectCaseSnapshot({ ...context, agent: { id: 'wrong' } }), /scope mismatch/);
});
