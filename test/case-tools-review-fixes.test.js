// C-A6 server review fixes (board #34): the humanDecision work message matches case-session v1 §3.1,
// only the server's own authority refusals become case-tool errors (case-tools v1 §2, §12.5), and
// agent status takes no wake lock while ENVOI_HTTP_WAKE_V1 is off (http-wake v1 §1).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { authorityToolError, humanDecisionWorkMessage } from '../src/case-tools.js';
import { api, launch, owner } from './a3-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionSchemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'case-session', 'schemas.json'), 'utf8'));
const toolSchemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'case-tools', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(sessionSchemas);
const validateDecision = ajv.getSchema(`${sessionSchemas.$id}#/definitions/humanDecisionWorkMessage`);

const request = {
  id: 'request_example', inboxId: 'inbox_alice', agentId: 'agent_alice', caseId: 'case_example',
  policyEvaluationId: 'policy_eval_example', counterpartyAgentId: 'agent_bob', counterpartyInboxId: 'inbox_bob',
  counterpartyAddress: 'bob@envoi.mail'
};
const at = '2026-10-19T00:00:00.000Z';
const decision = (outcome, humanId, requestedAction = 'proposal.accept') =>
  humanDecisionWorkMessage({ id: 'msg_human_decision_example', request, outcome, humanId, requestedAction, at });

test('every human decision outcome is a valid humanDecisionWorkMessage', () => {
  for (const [outcome, humanId] of [['approved', 'human_owner'], ['declined', 'human_owner'], ['expired', null], ['expired', 'human_ignored']]) {
    for (const requestedAction of ['proposal.accept', 'case.complete']) {
      const message = decision(outcome, humanId, requestedAction);
      assert.ok(validateDecision(message), `${outcome}/${requestedAction}: ${ajv.errorsText(validateDecision.errors)}`);
    }
  }
});

test('an expiry is sent by system and names no person', () => {
  const expired = decision('expired', 'human_ignored');
  assert.equal(expired.senderType, 'system');
  assert.ok(!('senderHumanId' in expired) && !('from' in expired), 'no person fields on an expiry');
  assert.equal(expired.text, 'Expired: accept the requested option.');
  const approved = decision('approved', 'human_owner', 'case.complete');
  assert.deepEqual([approved.senderType, approved.senderHumanId, approved.from], ['human', 'human_owner', { humanId: 'human_owner' }]);
  assert.equal(approved.text, 'Approved: the requested case outcome.');
});

test('a human decision refuses an unknown action, outcome or a decision without its person', () => {
  assert.throws(() => decision('approved', 'human_owner', 'other'), /proposal\.accept or case\.complete/);
  // A request whose evaluation is missing has no action to name.
  assert.throws(() => humanDecisionWorkMessage({ id: 'msg_x', request, outcome: 'approved', humanId: 'human_owner', requestedAction: undefined, at }), /proposal\.accept or case\.complete/);
  assert.throws(() => decision('withdrawn', 'human_owner'), /Unknown human decision outcome/);
  assert.throws(() => decision('declined', null), /names the person/);
});

const refusal = (message, statusCode) => Object.assign(new Error(message), { statusCode });

test('the server\'s own authority refusals map to their case-tools codes', () => {
  const cases = [
    ['A current server-issued policy evaluation for this agent and case is required', 403, 'AUTHORITY_DENIED'],
    ['Policy decision failed integrity verification', 409, 'AUTHORITY_DENIED'],
    ['Policy denied this action: missingPermission', 403, 'AUTHORITY_DENIED'],
    ['Current policy denied this action: missingPermission', 403, 'AUTHORITY_DENIED'],
    ['This action requires human approval', 409, 'AUTHORITY_PENDING'],
    ['Policy decision expired before execution', 409, 'AUTHORITY_EXPIRED'],
    ['Proposal changed after policy evaluation', 409, 'AUTHORITY_CHANGED'],
    ['Action authority binding changed after policy evaluation', 409, 'AUTHORITY_CHANGED'],
    ['Policy decision does not authorize this proposal option', 403, 'AUTHORITY_CHANGED'],
    ['Current policy requires a new human approval', 409, 'AUTHORITY_CHANGED'],
    ['This one-time policy evaluation has already been consumed', 409, 'AUTHORITY_CHANGED'],
    ['Proposal not found', 404, 'AUTHORITY_CHANGED'],
    ['Proposal option is missing or expired', 409, 'OPTION_NOT_LIVE'],
    ['Proposal cannot be accepted from accepted', 409, 'PROPOSAL_NOT_AWAITING'],
    ['Case participants changed while acquiring the mutation lock; retry', 409, 'TOOL_BUSY']
  ];
  for (const [message, statusCode, code] of cases) {
    const mapped = authorityToolError(refusal(message, statusCode));
    assert.equal(mapped?.toolCode, code, message);
    assert.ok(toolSchemas['x-tool-errors'][code], `${code} is a canonical tool error`);
  }
});

test('faults and session ends are never turned into authority results', () => {
  // A storage or programming fault stays an HTTP 500 (case-tools §2).
  assert.equal(authorityToolError(new Error('connection terminated unexpectedly')), null);
  assert.equal(authorityToolError(Object.assign(new Error('Policy decision expired before execution'), { statusCode: 500 })), null);
  assert.equal(authorityToolError(new TypeError('Cannot read properties of undefined')), null);
  // A coded API error keeps its own envelope, for example a session that ended mid-call (§1).
  assert.equal(authorityToolError(Object.assign(new Error('This case session has ended.'), { statusCode: 401, code: 'CASE_SESSION_ENDED' })), null);
  assert.equal(authorityToolError(Object.assign(new Error('This case is paused or revoked by a human.'), { statusCode: 409, code: 'CASE_CONTROLLED' })), null);
  // An unrecognised refusal is not guessed at.
  assert.equal(authorityToolError(refusal('Something else entirely expired', 409)), null);
  // A tool error already chosen passes through unchanged.
  const chosen = Object.assign(new Error('x'), { toolCode: 'AUTHORITY_REQUIRED' });
  assert.equal(authorityToolError(chosen), chosen);
});

test('with HTTPS wake off, agent status carries the fixed flag-off field', { timeout: 60000 }, async t => {
  const server = await launch({ ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' });
  t.after(() => server.stop());
  const who = await owner(server.baseUrl, '9301');
  for (let index = 0; index < 3; index += 1) {
    const status = await api(server.baseUrl, '/api/agent/status', { token: who.agentApiToken });
    assert.equal(status.status, 200, status.text);
    assert.deepEqual(status.payload.httpWake, { available: false, version: 1, subscription: null });
  }
});
