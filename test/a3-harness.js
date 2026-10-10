// Shared harness for the a3-pause-auth v1 integration tests (task A-1).
// Not a test file itself: `npm test` only runs test/*.test.js.
//
// Pattern follows test/human-controls-integration.test.js: spawn src/server.js
// on a temp FileStore data dir in development auth mode, create owners through
// the phone/TOTP dev flow, then drive the HTTP API. Expiry and recovery-window
// cases are simulated by editing FileStore JSON on disk while the server runs
// (FileStore.getJson/listJson read from disk on every call; see src/storage.js).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const fixtureDir = path.join(here, 'contract-fixtures', 'a3-pause-auth');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const PAST = '2000-01-01T00:00:00.000Z';
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_PATTERN = /(?:envoi|sinaloa)_(?:agent_(?:access|refresh)|mcp_read|enroll)_/;

// ---------------------------------------------------------------- schemas

const schemas = JSON.parse(await readFile(path.join(fixtureDir, 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
export const xCodes = schemas['x-codes'];

export function assertSchema(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schema ${name} exists in schemas.json`);
  assert.ok(validate(value), `${name} schema mismatch: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- server

// The server reads ENVOI_* and keeps SINALOA_* as legacy aliases; a conflicting
// pair fails closed (src/envoi-environment.js). Set both names to one value.
function withAliases(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const suffix = key.replace(/^(ENVOI|SINALOA)_/, '');
    if (suffix === key) { out[key] = value; continue; }
    out[`ENVOI_${suffix}`] = value;
    out[`SINALOA_${suffix}`] = value;
  }
  return out;
}

export async function launch(extraEnv = {}, existingDataDir = null) {
  const dataDir = existingDataDir || await mkdtemp(path.join(tmpdir(), 'envoi-a3-'));
  const env = { ...process.env, ...withAliases({ DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ...extraEnv }) };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 15000);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const streams = new Set();
  let stopped = false;
  return {
    baseUrl,
    dataDir,
    streams,
    get stderr() { return stderr; },
    stop: async (preserveData = false) => {
      if (stopped) return;
      stopped = true;
      for (const stream of streams) stream.close();
      if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
      if (!preserveData) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

// ---------------------------------------------------------------- HTTP

export async function api(baseUrl, route, { method, token, session, body, key, headers = {} } = {}) {
  const verb = method || (body !== undefined ? 'POST' : 'GET');
  const response = await fetch(`${baseUrl}${route}`, {
    method: verb,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? session.headers(baseUrl, verb) : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  session?.capture(response);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, headers: response.headers, payload, text };
}

const describe = res => `HTTP ${res.status} ${res.text?.slice(0, 500)}`;

export function assertOk(res, status = 200) {
  assert.equal(res.status, status, describe(res));
  return res.payload;
}

// Contract §1: every covered error has { code, error === code, message, requestId }.
// Assertions branch on `code`, never on the status alone; the status must match x-codes.
export function assertError(res, code, extra = {}) {
  const expected = xCodes[code];
  assert.ok(expected, `unknown contract code ${code}`);
  const body = res.payload;
  assert.ok(body && typeof body === 'object', `expected JSON error envelope with code ${code}; got ${describe(res)}`);
  assert.equal(body.code, code, `expected code ${code}; got ${describe(res)}`);
  assert.equal(res.status, expected.status, `code ${code} must use HTTP ${expected.status}; got ${describe(res)}`);
  assert.equal(body.error, code, 'error must equal code');
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0, 'message must be non-empty');
  assert.doesNotMatch(body.message, TOKEN_PATTERN, 'message must not contain a credential');
  assert.match(String(body.requestId), REQUEST_ID_PATTERN, 'requestId must be present and safe');
  for (const [field, value] of Object.entries(extra)) assert.deepEqual(body[field], value, `${code}.${field}`);
  assertSchema('errorEnvelope', body);
  return body;
}

export async function eventually(check, { timeoutMs = 6000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// ---------------------------------------------------------------- actors

// Same dev flow as human-controls-integration.test.js owner(). `suffix` must be
// a unique 4-digit string per server so phone numbers and slugs do not collide.
export async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const phone = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165557${suffix}`, displayName: `A3 owner ${suffix}` } });
  assert.ok(phone.payload?.developmentCode, `phone start: ${describe(phone)}`);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: phone.payload.challengeId, code: phone.payload.developmentCode } });
  assert.ok(verified.payload?.human, `phone verify: ${describe(verified)}`);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `A3 ${suffix}` } });
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `A3 agent ${suffix}`, slug: `a3-${suffix}` } });
  assert.equal(enrolled.status, 201, describe(enrolled));
  return { session, human: verified.payload.human, ...enrolled.payload };
}

export const agentRoute = (who, action) => `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/${action}`;

export async function pauseAgent(baseUrl, who) {
  const res = await api(baseUrl, agentRoute(who, 'pause'), { session: who.session, body: {} });
  assert.equal(res.status, 200, `pause: ${describe(res)}`);
  return res.payload;
}

export async function resumeAgent(baseUrl, who) {
  const res = await api(baseUrl, agentRoute(who, 'resume'), { session: who.session, body: {} });
  assert.equal(res.status, 200, `resume: ${describe(res)}`);
  return res.payload;
}

export async function revokeAgent(baseUrl, who) {
  // The route that calls revokeAgentCredentialFamilies for an owner revoke.
  const res = await api(baseUrl, agentRoute(who, 'credentials/revoke'), { session: who.session, body: {} });
  assert.equal(res.status, 200, `revoke: ${describe(res)}`);
  return res.payload;
}

export function send(baseUrl, from, to, { key, caseId, text = 'A3 test message', token = from.agentApiToken, headers } = {}) {
  return api(baseUrl, `/api/inboxes/${from.inbox.id}/messages`, {
    token,
    key: key || `a3-${crypto.randomUUID()}`,
    headers,
    body: { senderAgentId: from.agent.id, recipientEmail: to.agent.address, ...(caseId ? { caseId } : {}), type: 'request', text }
  });
}

export const claim = (baseUrl, token, body = {}, headers) => api(baseUrl, '/api/agent/work/claim', { token, body, headers });
export const agentStatus = (baseUrl, token) => api(baseUrl, '/api/agent/status', { token });
export const refresh = (baseUrl, agentRefreshToken, rotationId) => api(baseUrl, '/api/agent-token', {
  body: { grantType: 'refresh_token', agentRefreshToken, ...(rotationId === undefined ? {} : { rotationId }) }
});
export const newRotationId = () => `rotation_${crypto.randomBytes(8).toString('hex')}`;

// Reads through the owner's human session so the check does not depend on
// what a paused agent token may read.
export async function ownerMessages(baseUrl, who, caseId) {
  const query = caseId ? `?caseId=${encodeURIComponent(caseId)}` : '';
  const res = await api(baseUrl, `/api/inboxes/${who.inbox.id}/messages${query}`, { session: who.session });
  assert.equal(res.status, 200, describe(res));
  return res.payload;
}

export async function waitForMessageStatus(baseUrl, who, messageId, status, options = {}) {
  return eventually(async () => (await ownerMessages(baseUrl, who)).find(item => item.id === messageId && item.status === status), { message: `${messageId} to be ${status} in ${who.inbox.id}`, ...options });
}

export async function ownerEvents(baseUrl, who) {
  const res = await api(baseUrl, `/api/inboxes/${who.inbox.id}/events/delta?limit=200`, { session: who.session });
  assert.equal(res.status, 200, describe(res));
  return res.payload.events;
}

// ---------------------------------------------------------------- disk

export const dataFile = (server, ...parts) => path.join(server.dataDir, ...parts);

export async function readData(server, ...parts) {
  try { return JSON.parse(await readFile(dataFile(server, ...parts), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Write via temp file + rename so the running server never reads a torn file.
export async function writeData(server, parts, value) {
  const target = dataFile(server, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, target); return; }
    catch (error) { if (attempt > 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; await sleep(25); }
  }
}

export async function editData(server, parts, edit) {
  const current = await readData(server, ...parts);
  assert.ok(current, `expected ${parts.join('/')} to exist`);
  const next = edit(structuredClone(current)) || current;
  await writeData(server, parts, next);
  return next;
}

export async function deleteData(server, ...parts) {
  for (let attempt = 0; ; attempt += 1) {
    try { await unlink(dataFile(server, ...parts)); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      if (attempt > 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await sleep(25);
    }
  }
}

// FileStore layout used by src/server.js.
export const accessCredentialParts = token => ['auth', 'agent-credentials', `${sha256(token)}.json`];
export const refreshCredentialParts = token => ['auth', 'agent-refresh-credentials', `${sha256(token)}.json`];
export const recoveryParts = refreshToken => ['auth', 'agent-rotation-recovery', `${sha256(refreshToken)}.json`];
export const familyParts = (inboxId, agentId, familyId) => ['auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`];
export const workClaimParts = (inboxId, workId) => ['inboxes', inboxId, 'work-claims', `${workId}.json`];
export const outboxParts = messageId => ['outbox', `delivery_${messageId}.json`];

export async function familyPartsForToken(server, accessToken) {
  const index = await readData(server, ...accessCredentialParts(accessToken));
  assert.ok(index?.familyId, 'access credential index has a familyId');
  return familyParts(index.inboxId, index.agentId, index.familyId);
}

export const expireAccessToken = (server, token) => editData(server, accessCredentialParts(token), value => ({ ...value, expiresAt: PAST }));
export async function expireFamily(server, accessToken) {
  return editData(server, await familyPartsForToken(server, accessToken), value => ({ ...value, refreshExpiresAt: PAST }));
}

// Deterministic "queued but not yet delivered" outbound message.
//
// Native delivery is kicked immediately after enqueue, so pausing after a send
// races the delivery worker. FileStore.claimOutbox already enforces strict
// per-orderingKey (caseId) order: an item is not claimable while an earlier
// sequence with the same orderingKey is not delivered/deadLettered. The gate is
// a synthetic outbox record with sequence 0 for the case and availableAt far in
// the future, so it is never claimed itself but holds every later item in that
// case in `queued`. The test sends, pauses, then removes the gate; from then on
// only the server's pause hold (held/sender_paused) can stop delivery.
// No server hook is needed; the record belongs to no real inbox or agent.
export async function installOutboxGate(server, caseId) {
  const id = `delivery_a3_test_gate_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  await writeData(server, ['outbox', `${id}.json`], {
    id,
    kind: 'nativeAgentMessage',
    messageId: `msg_a3_test_gate_${id.slice(-12)}`,
    senderInboxId: 'inbox_a3_test_gate',
    recipientInboxId: 'inbox_a3_test_gate',
    orderingKey: caseId,
    status: 'queued',
    attempts: 0,
    maxAttempts: 5,
    availableAt: '2999-01-01T00:00:00.000Z',
    sequence: 0,
    createdAt: now,
    updatedAt: now
  });
  return { id, remove: () => deleteData(server, 'outbox', `${id}.json`) };
}

// ---------------------------------------------------------------- SSE

// Minimal SSE reader over fetch. Collects frames as { id, event, data }.
// `id` is undefined for frames without an id line (e.g. credential.ended).
export async function openEventStream(server, inboxId, token, { headers = {} } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}/api/inboxes/${inboxId}/events`, {
    headers: { accept: 'text/event-stream', authorization: `Bearer ${token}`, ...headers },
    signal: controller.signal
  });
  const stream = {
    status: response.status,
    headers: response.headers,
    payload: null,
    text: '',
    events: [],
    ended: false,
    close() { controller.abort(); server.streams.delete(stream); },
    async waitFor(predicate, { timeoutMs = 6000, message = 'SSE event' } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = stream.events.find(predicate);
        if (found) return found;
        if (stream.ended) break;
        await sleep(20);
      }
      const found = stream.events.find(predicate);
      if (found) return found;
      throw new Error(`Timed out waiting for ${message}; stream ended=${stream.ended}; got ${stream.events.map(item => item.event).join(', ')}`);
    },
    async waitForEnd(timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (!stream.ended && Date.now() < deadline) await sleep(20);
      return stream.ended;
    }
  };
  if (response.status !== 200 || !String(response.headers.get('content-type') || '').startsWith('text/event-stream')) {
    stream.text = await response.text();
    try { stream.payload = JSON.parse(stream.text); } catch { stream.payload = null; }
    stream.ended = true;
    return stream;
  }
  server.streams.add(stream);
  (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const entry = { id: undefined, event: 'message', data: undefined, raw: frame };
          const dataLines = [];
          let meaningful = false;
          for (const line of frame.split(/\r?\n/)) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            const content = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            meaningful = true;
            if (field === 'id') entry.id = content;
            else if (field === 'event') entry.event = content;
            else if (field === 'data') dataLines.push(content);
          }
          if (!meaningful) continue;
          const data = dataLines.join('\n');
          try { entry.data = JSON.parse(data); } catch { entry.data = data; }
          stream.events.push(entry);
        }
      }
    } catch { /* aborted or server stopped */ }
    finally { stream.ended = true; server.streams.delete(stream); }
  })();
  return stream;
}
