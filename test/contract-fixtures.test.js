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
      assert.doesNotMatch(JSON.stringify(fixture), /(?:sinaloa_agent_(?:access|refresh)_|sinaloa_mcp_read_|sinaloa_enroll_)(?!PLACEHOLDER)/, `${label}: tokens must be placeholders`);
    }
  }
});
