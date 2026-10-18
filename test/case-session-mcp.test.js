// C-A1: the case-session v1 rules that need no running server, checked against the contract's
// tables and fixtures. The /mcp fixtures answered at the JSON-RPC level are replayed through the
// session handler with stand-in tools, because C-A1 implements none (case-tools v1 is C-A2–C-A4).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/storage.js';
import { fileURLToPath } from 'node:url';
import { createCaseSessionMcp } from '../src/case-session-mcp.js';
import { allowedCaseTools, caseSessionsEpochPath, caseToolTable, createCaseSessions, endedPrecedence, firstCondition, leaseStaleReason, sessionConditions } from '../src/case-sessions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'contract-fixtures', 'case-session');
const schemas = JSON.parse(await readFile(path.join(fixtureDir, 'schemas.json'), 'utf8'));
const fixtures = await Promise.all((await readdir(fixtureDir)).filter(name => name !== 'schemas.json').map(async name => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'))));
const allTools = new Set(caseToolTable.map(row => row.name));
const caseTools = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'case-tools', 'schemas.json'), 'utf8'))['x-tools'];

test('the tool table, precedence and limits are the contract\'s', () => {
  const needs = value => Array.isArray(value) ? value : [value];
  assert.deepEqual(caseToolTable.map(row => ({ name: row.name, needs: row.needs, workKinds: row.workKinds })),
    schemas['x-case-tools'].map(row => ({ name: row.name, needs: needs(row.needs), workKinds: row.workKinds })));
  assert.deepEqual(endedPrecedence, schemas['x-ended-precedence']);
});

test('allowedTools at mint is exactly what the permissions and work kind allow, in table order', () => {
  const minted = fixtures.flatMap(fixture => (fixture.response ? [fixture.response] : (fixture.steps || []).map(step => step.response))
    .filter(response => response?.schema === 'sessionCreated').map(response => ({ fixture, session: response.body.session })));
  assert.ok(minted.length >= 4);
  for (const { fixture, session } of minted) {
    const context = fixture.context || {};
    if (!context.permissions) continue;
    assert.deepEqual(allowedCaseTools(context.permissions, session.workKind, allTools), session.allowedTools, fixture.id);
  }
  // Only implemented tools are carried (§6.4).
  assert.deepEqual(allowedCaseTools(['send_agent_messages', 'receive_agent_messages', 'execute_cases', 'create_assets'], 'agent_message', new Set()), []);
  assert.deepEqual(allowedCaseTools(['receive_agent_messages'], 'human_instruction', allTools), ['envoi_case_snapshot', 'envoi_case_list_assets']);
});

test('lease staleness follows the contract order', () => {
  const now = '2026-10-17T12:00:00.000Z';
  const live = { credentialFamilyId: 'family_a', leaseTokenHash: 'hash', status: 'claimed', leaseExpiresAt: '2026-10-17T12:01:00.000Z' };
  assert.equal(leaseStaleReason(live, 'family_a', 'hash', now), null);
  assert.equal(leaseStaleReason(null, 'family_a', 'hash', now), 'superseded');
  assert.equal(leaseStaleReason({ ...live, leaseTokenHash: 'other' }, 'family_b', 'hash', now), 'other_installation');
  assert.equal(leaseStaleReason(live, 'family_a', 'other', now), 'superseded');
  assert.equal(leaseStaleReason({ ...live, status: 'completed', leaseExpiresAt: null }, 'family_a', 'hash', now), 'settled');
  assert.equal(leaseStaleReason({ ...live, status: 'retryable', failure: { retryable: true } }, 'family_a', 'hash', now), 'settled');
  assert.equal(leaseStaleReason({ ...live, status: 'retryable', reofferWithoutAttempt: true, leaseExpiresAt: null }, 'family_a', 'hash', now), 'released');
  assert.equal(leaseStaleReason({ ...live, leaseExpiresAt: now }, 'family_a', 'hash', now), 'expired');
});

test('conditions follow x-ended-precedence, and pause, case control and settlement imply lease_lost', () => {
  const now = '2026-10-17T12:00:00.000Z';
  const session = { id: 'case_session_a', fence: 2, leaseTokenHash: 'hash' };
  const usable = {
    family: { refreshExpiresAt: '2026-11-01T00:00:00.000Z' },
    agent: { status: 'active', onboardingStatus: 'approved' },
    caseRecord: { state: 'inProgress' }, ineligibleReason: null,
    claim: { fence: 2, leaseTokenHash: 'hash', status: 'claimed', leaseExpiresAt: '2026-10-17T12:01:00.000Z' },
    message: { status: 'delivered' }, pointer: { sessionId: 'case_session_a' }
  };
  const released = { ...usable.claim, status: 'retryable', leaseExpiresAt: null, reofferWithoutAttempt: true };
  assert.equal(firstCondition(sessionConditions(session, usable, now)), null);
  const cases = [
    [{ family: { ...usable.family, revokedAt: now } }, 'credential_ended'],
    [{ family: { refreshExpiresAt: now } }, 'credential_ended'],
    [{ agent: { status: 'revoked', onboardingStatus: 'revoked' } }, 'credential_ended'],
    [{ agent: { status: 'paused', onboardingStatus: 'approved' }, claim: released }, 'agent_paused'],
    [{ caseRecord: { state: 'paused' }, claim: released }, 'case_controlled'],
    [{ ineligibleReason: 'counterparty_unavailable' }, 'work_ineligible'],
    [{ claim: { ...usable.claim, status: 'completed', leaseExpiresAt: null }, message: { status: 'processed' } }, 'work_settled'],
    [{ claim: { ...usable.claim, status: 'retryable', leaseExpiresAt: null, failure: { retryable: true } } }, 'work_settled'],
    [{ pointer: { sessionId: 'case_session_b' } }, 'superseded'],
    [{ claim: { ...usable.claim, fence: 3, leaseTokenHash: 'next' } }, 'lease_lost'],
    [{ claim: { ...usable.claim, leaseExpiresAt: now } }, 'lease_lost'],
    // A recorded credential end outranks a pause that also holds.
    [{ family: { ...usable.family, revokedAt: now }, agent: { status: 'paused', onboardingStatus: 'approved' }, claim: released }, 'credential_ended']
  ];
  for (const [change, reason] of cases) {
    const conditions = sessionConditions(session, { ...usable, ...change }, now);
    assert.equal(firstCondition(conditions), reason, JSON.stringify(change));
    for (const implied of ['agent_paused', 'case_controlled', 'work_settled']) {
      if (conditions[implied]) assert.equal(conditions.lease_lost, true, `${implied} implies lease_lost`);
    }
  }
});

// Stand-ins for the case tools, returning the placeholder result the fixtures carry, since real results
// belong to case-tools v1. tools/list fixtures show placeholder schemas; tools/call fixtures send real
// arguments, so calls use case-tools v1's input schemas.
const placeholderResult = async () => ({ content: [{ type: 'text', text: JSON.stringify({ defined_by: 'case-tools v1' }) }], isError: false });
const listed = new Map(caseToolTable.map(row => [row.name, { description: 'Defined by case-tools v1.', inputSchema: { type: 'object', additionalProperties: false }, run: placeholderResult }]));
const called = new Map(caseTools.map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema, run: placeholderResult }]));

test('the session MCP handler answers every JSON-RPC-level /mcp fixture exactly', async t => {
  const handlers = { listed: createCaseSessionMcp(listed), called: createCaseSessionMcp(called) };
  let handler = handlers.listed;
  let current = null;
  const server = http.createServer((req, res) => handler.handle(req, res, current).catch(error => { res.writeHead(500); res.end(String(error)); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let replayed = 0;
  for (const fixture of fixtures) {
    const steps = fixture.request ? [{ request: fixture.request, response: fixture.response }] : fixture.steps || [];
    for (const step of steps) {
      if (step.request?.auth !== 'case_session' || step.request.path !== '/mcp' || step.response.status !== 200) continue;
      const context = step.context || fixture.context || {};
      handler = step.request.body.method === 'tools/call' ? handlers.called : handlers.listed;
      // §6.4: the session's allowedTools, less what the current permissions no longer allow.
      const permitted = new Set(allowedCaseTools(context.permissions, context.workKind, handler.implemented));
      current = { effectiveTools: (context.allowedTools || []).filter(name => permitted.has(name)), scope: {} };
      const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: step.request.headers, body: JSON.stringify(step.request.body) });
      assert.equal(response.status, 200, fixture.id);
      assert.equal(response.headers.get('cache-control'), 'no-store', fixture.id);
      assert.deepEqual(await response.json(), step.response.body, fixture.id);
      replayed += 1;
    }
  }
  assert.ok(replayed >= 11, `replayed ${replayed} fixtures`);
});

// §1: an epoch that does not parse never admits a session, and a bad or future-dated document moves it.
test('a corrupt or future-dated epoch fails closed', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-epoch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  const sessions = (enabled = true) => createCaseSessions({ store, enabled, hashSecret: value => value, recordAudit: async () => null });
  const now = new Date('2026-10-17T12:00:00.000Z');
  await store.putJson(caseSessionsEpochPath, { epoch: 'not-a-time', activeUntil: '2026-10-17T12:00:30.000Z' });
  assert.equal(await sessions().epoch(), null, 'refused while unparseable');
  assert.equal((await sessions().heartbeat(now)).epoch, now.toISOString(), 'the heartbeat moves an unparseable epoch to now');
  await store.putJson(caseSessionsEpochPath, { epoch: '2026-10-17T11:00:00.000Z', activeUntil: '9999-01-01T00:00:00.000Z' });
  assert.equal((await sessions().startEpoch(now)).epoch, now.toISOString(), 'a future-dated activeUntil counts as lapsed');
  await store.putJson(caseSessionsEpochPath, { epoch: '2026-10-17T11:00:00.000Z', activeUntil: '2026-10-17T12:00:30.000Z' });
  assert.equal((await sessions().startEpoch(now)).epoch, '2026-10-17T11:00:00.000Z', 'a fresh activeUntil keeps the epoch');
  assert.equal((await sessions().heartbeat(now)).activeUntil, '2026-10-17T12:01:00.000Z');
  assert.equal((await sessions(false).startEpoch(now)).epoch, now.toISOString(), 'a flag-off start always moves it');
});

test('a case tool must refuse extra arguments', () => {
  assert.throws(() => createCaseSessionMcp(new Map([['envoi_case_snapshot', { description: 'x', inputSchema: { type: 'object' }, run: async () => ({}) }]])), /must refuse additional properties/);
});
