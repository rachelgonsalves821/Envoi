import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { assertValidProtocolMessage } from '../src/protocol-v1.js';

const protocolFields = ['schemaVersion', 'messageId', 'conversationId', 'taskId', 'correlationId', 'causationId', 'from', 'to', 'intent', 'content', 'proposal', 'authority', 'artifactRefs', 'requiresAck', 'traceparent', 'signature', 'createdAt'];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const controlFrames = new Set(['ready', 'replay_required', 'replay_error', 'credential.ended']);
const requestCursor = request => {
  const query = new URL(request.path, 'http://fixture.invalid').searchParams;
  return request.headers?.['last-event-id'] || query.get('cursor') || null;
};

// a4-wake §2: stored events carry their cursor as the SSE id and rise above the resume
// cursor; control frames carry none; ready and replay_required report the right cursor.
function checkStreamFrames(fixture, label, check, validator) {
  const resume = requestCursor(fixture.request);
  let last = resume;
  for (const [index, frame] of fixture.frames.entries()) {
    const frameLabel = `${label} frame ${index}`;
    if (frame.comment) continue;
    check(validator(frame.schema), frame.data, frameLabel);
    if (controlFrames.has(frame.event)) {
      assert.equal(frame.id, undefined, `${frameLabel}: control frames carry no id`);
      const fromLatest = new URL(fixture.request.path, 'http://fixture.invalid').searchParams.get('from') === 'latest';
      if (['ready', 'replay_required'].includes(frame.event) && !fromLatest) assert.equal(frame.data.cursor, last, `${frameLabel}: reports the last cursor sent, else the resume cursor`);
      continue;
    }
    assert.equal(frame.id, frame.data.cursor, `${frameLabel}: SSE id is the cursor`);
    assert.equal(frame.event, frame.data.type, `${frameLabel}: SSE event name`);
    if (last) assert.ok(frame.id > last, `${frameLabel}: ids rise above the resume cursor and each other`);
    last = frame.id;
  }
}

// a4-wake §3: delta pages are ordered after the request cursor and report a consistent next cursor.
function checkDeltaPage(fixture, label) {
  const { events, nextCursor, hasMore } = fixture.response.body;
  let last = requestCursor(fixture.request);
  for (const event of events) {
    if (last) assert.ok(event.cursor > last, `${label}: events rise above the request cursor`);
    last = event.cursor;
  }
  assert.equal(nextCursor, last, `${label}: nextCursor is the last event cursor, else the request cursor`);
  if (hasMore) assert.ok(events.length > 0, `${label}: hasMore implies a non-empty page`);
}

// envoi-browser-names §1 and §6: the response sets and clears exactly the listed cookies, with the
// table's attributes; old names appear only as clears; requests carry old names only when marked.
function checkBrowserNames(fixture, schemas, label) {
  const table = schemas['x-browser-cookies'];
  const set = [];
  const cleared = [];
  for (const header of fixture.response.headers?.['set-cookie'] || []) {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    const [name, value] = pair.split('=');
    const row = table.find((entry) => entry.new === name || entry.old === name);
    assert.ok(row, `${label}: ${name} is in x-browser-cookies`);
    const isClear = value === '' && attributes.includes('Max-Age=0');
    (isClear ? cleared : set).push(name);
    if (!isClear) assert.ok(attributes.some((attribute) => /^Max-Age=\d+$/.test(attribute)), `${label}: ${name} has a Max-Age`);
    if (name === row.old) assert.ok(isClear, `${label}: ${name} is only ever cleared`);
    assert.ok(attributes.includes(`Path=${row.path}`), `${label}: ${name} Path`);
    assert.equal(attributes.includes('HttpOnly'), row.httpOnly, `${label}: ${name} HttpOnly`);
    assert.ok(attributes.includes(`SameSite=${row.sameSite}`), `${label}: ${name} SameSite`);
    if (row.domain === 'never') assert.ok(!attributes.some((attribute) => attribute.startsWith('Domain=')), `${label}: ${name} has no Domain`);
  }
  assert.deepEqual(set.sort(), [...fixture.cookies.set].sort(), `${label}: cookies set`);
  assert.deepEqual(cleared.sort(), [...fixture.cookies.cleared].sort(), `${label}: cookies cleared`);
  const headers = fixture.request.headers || {};
  const oldInRequest = /sinaloa/i.test(JSON.stringify(headers));
  assert.equal(oldInRequest, fixture.oldNamesInRequest === true, `${label}: old names appear in the request only when oldNamesInRequest is set`);
  // §1.3: responses that end or start a session clear every retired name.
  const sessionResponse = fixture.cookies.set.includes('envoi_session') || fixture.request.path === '/api/auth/logout';
  if (sessionResponse) for (const row of table) assert.ok(fixture.cookies.cleared.includes(row.old), `${label}: clears ${row.old}`);
  // §2: a mutation with the Envoi session sends the Envoi CSRF header.
  if (fixture.request.method !== 'GET' && /(?:^|;\s*)envoi_session=/.test(headers.cookie || '') && !fixture.oldNamesInRequest) {
    for (const header of Object.values(schemas['x-browser-headers'])) assert.ok(headers[header], `${label}: sends ${header}`);
  }
}

const presenceFields =['lastSeenAt', 'lastSuccessfulRefreshAt', 'lastWorkClaimAt', 'lastProcessedAt'];

// a5-presence §2: no timestamp is later than asOf, and lastSeenAt leads the other three.
function checkPresence(presence, asOf, label) {
  for (const field of presenceFields) {
    if (presence[field] && asOf) assert.ok(presence[field] <= asOf, `${label}: ${field} is not later than asOf`);
    if (presence[field] && field !== 'lastSeenAt') assert.ok(presence.lastSeenAt && presence.lastSeenAt >= presence[field], `${label}: lastSeenAt is not earlier than ${field}`);
  }
}

// a5-presence §4.2 and §5: re-derive seenAt, the connection state and both labels from the fixture's own fields.
function checkOwnerConnection(fixture, schemas, label) {
  assert.deepEqual(schemas['x-connection-states'].map((entry) => entry.state), schemas.definitions.connectionState.enum, `${label}: state table order`);
  assert.deepEqual(schemas['x-agent-labels'].map((entry) => entry.label), ['Revoked', 'Rejected', 'Pending', 'Paused', 'Active'], `${label}: agent label table order`);
  const agents = Array.isArray(fixture.response.body) ? fixture.response.body : [fixture.response.body];
  for (const [index, agent] of agents.entries()) {
    const agentLabel = `${label} agent ${index}`;
    const { connection } = agent;
    const revoked = agent.status === 'revoked' || agent.credentialRevoked;
    const { lastSeenAt, lastWorkClaimAt } = connection.presence;
    const resumeGrace = Boolean(agent.resumedAt) && Date.parse(connection.asOf) - Date.parse(agent.resumedAt) <= connection.recentWindowSeconds * 1000
      && (!lastWorkClaimAt || lastWorkClaimAt < agent.resumedAt);
    const seenAt = agent.paused || resumeGrace ? lastSeenAt : lastWorkClaimAt;
    assert.equal(connection.seenAt, seenAt, `${agentLabel}: seenAt is lastSeenAt while paused or in the resume grace, otherwise lastWorkClaimAt`);
    const state = revoked ? 'revoked'
      : agent.onboardingStatus === 'rejected' ? 'rejected'
        : agent.onboardingStatus !== 'approved' ? 'pending_approval'
          : connection.credentialExpiresAt === null ? 'not_connected'
            : connection.credentialExpiresAt <= connection.asOf ? 'needs_reconnect'
              : seenAt === null ? 'never_seen'
                : Date.parse(connection.asOf) - Date.parse(seenAt) <= connection.recentWindowSeconds * 1000 ? 'seen_recently'
                  : 'not_seen_recently';
    assert.equal(connection.state, state, `${agentLabel}: connection.state follows the first matching row`);
    assert.equal(fixture.client.connectionLabel, schemas['x-connection-states'].find((entry) => entry.state === state).connectionLabel, `${agentLabel}: connection label`);
    const expectedAgentLabel = revoked ? 'Revoked' : agent.onboardingStatus === 'rejected' ? 'Rejected' : agent.onboardingStatus !== 'approved' ? 'Pending' : agent.paused ? 'Paused' : 'Active';
    assert.equal(fixture.client.agentLabel, expectedAgentLabel, `${agentLabel}: agent label`);
    if (['not_connected', 'pending_approval', 'rejected'].includes(state)) assert.deepEqual(Object.values(connection.presence), [null, null, null, null], `${agentLabel}: no family, no presence`);
    if (revoked) assert.equal(connection.credentialExpiresAt, null, `${agentLabel}: a revoked family reports no expiry`);
    // A revoked agent reports status revoked even when it was paused (credentialRevoked overrides).
    if (!revoked) assert.equal(agent.paused, agent.status === 'paused', `${agentLabel}: paused mirrors the agent status`);
    checkPresence(connection.presence, connection.asOf, agentLabel);
  }
}

test('contract fixture registry has a versioned shape', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  assert.equal(Number.isInteger(index.version) && index.version >= 1, true);
  assert.equal(Array.isArray(index.contracts), true);
  const ids = new Set();
  for (const contract of index.contracts) {
    assert.match(contract.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(contract.id), false, `duplicate contract id ${contract.id}`);
    ids.add(contract.id);
    assert.equal(Number.isInteger(contract.version) && contract.version >= 1, true, contract.id);
    assert.ok(['published', 'approved'].includes(contract.status), contract.id);
    assert.equal(typeof contract.handoff, 'string', contract.id);
    assert.equal(contract.dir, contract.id);
    assert.equal(contract.schemas === undefined || typeof contract.schemas === 'string', true, contract.id);
    assert.equal(Array.isArray(contract.fixtures) && contract.fixtures.length > 0, true, contract.id);
  }
});

test('every registered fixture exists, parses and is registered exactly once', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  for (const contract of index.contracts) {
    const dir = path.join(root, contract.dir);
    const onDisk = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== contract.schemas).sort();
    assert.deepEqual([...contract.fixtures].sort(), onDisk, `${contract.id} fixture list`);
    for (const name of contract.fixtures) await readJson(path.join(dir, name));
  }
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, index.contracts.map((contract) => contract.dir).sort(), 'unregistered fixture directory');
});

test('every fixture matches its declared schema', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  for (const contract of index.contracts.filter((entry) => entry.schemas)) {
    const dir = path.join(root, contract.dir);
    const schemas = await readJson(path.join(dir, contract.schemas));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(schemas);
    const validator = (name) => {
      const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
      assert.ok(validate, `${contract.id} has no schema ${name}`);
      return validate;
    };
    const check = (validate, value, label) => assert.equal(validate(value), true, `${label}: ${ajv.errorsText(validate.errors)}`);
    for (const name of contract.fixtures) {
      const fixture = await readJson(path.join(dir, name));
      const label = `${contract.id}/${name}`;
      check(validator('fixture'), fixture, label);
      assert.equal(fixture.contract, contract.id, label);
      assert.equal(fixture.version, contract.version, label);
      assert.equal(`${fixture.id}.json`, name, label);
      if (fixture.response) {
        const value = 'body' in fixture.response ? fixture.response.body : fixture.response.bodyText;
        check(validator(fixture.response.schema), value, `${label} response`);
        if (value && typeof value === 'object' && 'code' in value) {
          assert.equal(value.error, value.code, `${label}: error must equal code`);
          const entry = schemas['x-codes']?.[value.code];
          assert.ok(entry, `${label}: ${value.code} is not in x-codes`);
          assert.equal(fixture.response.status, entry.status, `${label}: HTTP status for ${value.code}`);
          assert.equal(fixture.client.lifecycle, entry.lifecycle, `${label}: lifecycle for ${value.code}`);
          assert.equal(fixture.client.retry, entry.retry, `${label}: retry for ${value.code}`);
          const guidance = value.reason ? entry.guidanceByReason?.[value.reason] : entry.guidance;
          assert.equal(fixture.client.guidance, guidance, `${label}: guidance for ${value.code}`);
        } else if (fixture.response.status >= 400 && schemas['x-codes']) {
          assert.equal(fixture.response.schema, 'edgeText', `${label}: error responses must use the error envelope`);
        }
        // envoi-browser-names: the plain { error } shape is kept only for browser requests (a3 §1).
        if (fixture.response.schema === 'plainError') assert.ok(fixture.request?.headers?.cookie, `${label}: plainError is only for browser requests`);
        if (fixture.response.status === 302) {
          assert.match(String(fixture.response.headers?.location || ''), /^(?:\/|https:\/\/)/, `${label}: a redirect has a location`);
          assert.equal(fixture.response.headers['cache-control'], 'no-store', `${label}: redirects are not cached`);
        }
        const workMessage = fixture.response.body?.work?.message;
        if (workMessage && workMessage.kind !== 'humanInstruction') {
          // Claimed native work must be a stored message the server could have produced.
          assert.doesNotThrow(() => assertValidProtocolMessage(Object.fromEntries(protocolFields.map((key) => [key, workMessage[key]]))), `${label}: protocol envelope`);
          assert.equal(workMessage.id, workMessage.messageId, `${label}: id is the protocol messageId`);
          assert.equal(workMessage.caseId, workMessage.conversationId, `${label}: caseId is the conversationId`);
          assert.equal(workMessage.from.agentId, workMessage.senderAgentId, `${label}: from is the sender`);
          assert.ok(workMessage.to.some((recipient) => recipient.agentId === workMessage.recipientAgentId), `${label}: to includes the recipient`);
        }
        if (fixture.response.status === 429) assert.equal(fixture.response.headers?.['retry-after'], String(value.retryAfterSeconds), `${label}: retry-after`);
      }
      if (fixture.event) {
        check(validator(fixture.event.schema), fixture.event.data, `${label} event`);
        if (fixture.event.id !== undefined) assert.equal(fixture.event.event, fixture.event.data.type, `${label}: SSE event name`);
        if (fixture.event.id !== undefined) assert.equal(fixture.event.id, fixture.event.data.cursor, `${label}: SSE id is the cursor`);
        else assert.equal('cursor' in fixture.event.data, false, `${label}: control events carry no cursor`);
      }
      if (fixture.frames) checkStreamFrames(fixture, label, check, validator);
      if (fixture.response?.schema === 'deltaPage') checkDeltaPage(fixture, label);
      if (schemas['x-browser-cookies']) checkBrowserNames(fixture, schemas, label);
      if (['ownerAgentList', 'ownerAgent'].includes(fixture.response?.schema)) checkOwnerConnection(fixture, schemas, label);
      if (fixture.response?.schema === 'agentStatusWithPresence') checkPresence(fixture.response.body.presence, fixture.response.body.asOf, label);
      assert.doesNotMatch(JSON.stringify(fixture), /(?:(?:envoi|sinaloa)_agent_(?:access|refresh)_|(?:envoi|sinaloa)_mcp_read_|(?:envoi|sinaloa)_enroll_)(?!PLACEHOLDER)/, `${label}: tokens must be placeholders`);
    }
  }
});
