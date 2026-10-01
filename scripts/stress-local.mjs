import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { generateSync } from 'otplib';
import { BrowserSession } from '../test/browser-session.js';

const boundedCount = (name, fallback, maximum) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
};

const WRITE_COUNT_PER_CASE = boundedCount('SINALOA_STRESS_WRITES_PER_CASE', 12, 100);
const RETRY_COUNT = 8;
const HOSTILE_COUNT = 8;
const READ_COUNT = boundedCount('SINALOA_STRESS_READS', 100, 500);
const MCP_COUNT = 20;

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] || 0);
};

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: '',
      SINALOA_PORT: '0',
      SINALOA_AUTH_MODE: 'development',
      SINALOA_HUMAN_AUTH_PROVIDER: 'local',
      SINALOA_OBJECT_STORAGE_PROVIDER: 'local',
      SINALOA_ENABLE_EXTERNAL_EMAIL: 'false',
      SINALOA_ENABLE_CALENDAR_WRITES: 'false',
      SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS: 'false',
      SINALOA_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local server start timed out: ${stderr.slice(-500)}`)), 10_000);
    const onOutput = () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    child.stdout.on('data', onOutput);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local server exited ${code}: ${stderr.slice(-500)}`)); });
  });
  return {
    baseUrl,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    })
  };
}

async function api(baseUrl, route, { token, session, body, key } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  const start = performance.now();
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? session.headers(baseUrl, method) : {}),
      ...(key ? { 'idempotency-key': key } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json(), ms: performance.now() - start };
}

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', {
    session, body: { phoneNumber: `+14165557${suffix}`, displayName: `Stress owner ${suffix}` }
  });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', {
    session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode }
  });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', {
    session, body: { code: generateSync({ secret: setup.payload.secret }) }
  })).status, 200);
  const inbox = await api(baseUrl, '/api/inboxes', { session, body: { name: `Stress ${suffix}` } });
  assert.equal(inbox.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${inbox.payload.id}/agent-enrollment-tokens`, {
    session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] }
  });
  assert.equal(enrollment.status, 201);
  const agent = await api(baseUrl, '/api/agent-enroll', {
    body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Stress agent ${suffix}`, slug: `stress-${suffix}` }
  });
  assert.equal(agent.status, 201);
  return { session, human: verified.payload.human, ...agent.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Case state did not converge within 10 seconds');
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-stress-local-'));
let server;
try {
  server = await startServer(dataDir);
  const { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([
    owner(baseUrl, '3101'), owner(baseUrl, '3102'), owner(baseUrl, '3103')
  ]);
  const send = (from, to, caseId, text, key, senderAgentId = from.agent.id) => api(baseUrl, `/api/inboxes/${from.inbox.id}/messages`, {
    token: from.agentApiToken, key,
    body: { senderAgentId, recipientEmail: to.agent.address, caseId, type: 'status', intent: 'status', text, payload: { progress: text } }
  });
  const read = (from, caseId) => api(baseUrl, `/api/inboxes/${from.inbox.id}/cases/${caseId}`, { token: from.agentApiToken });
  const cases = ['case_stress_A', 'case_stress_B'];
  const opened = await Promise.all(cases.map((caseId, index) => send(alice, bob, caseId, `Open ${caseId}`, `open-${index}`)));
  assert.ok(opened.every(result => result.status === 202), `Case start statuses: ${opened.map(result => result.status)}`);
  await eventually(async () => (await Promise.all(cases.map(caseId => read(bob, caseId)))).every(result => result.status === 200));

  const writes = [];
  for (const caseId of cases) {
    for (let index = 0; index < WRITE_COUNT_PER_CASE; index += 1) {
      const sender = index % 2 ? bob : alice;
      writes.push(send(sender, sender === alice ? bob : alice, caseId, `${caseId} update ${index}`, `${caseId}-update-${index}`));
    }
  }
  const writeResults = await Promise.all(writes);
  assert.ok(writeResults.every(result => result.status === 202), `Concurrent write statuses: ${writeResults.map(result => result.status)}`);

  const retryResults = await Promise.all(Array.from({ length: RETRY_COUNT }, () =>
    send(alice, bob, cases[0], 'One logical retry', 'same-logical-event')));
  assert.ok(retryResults.every(result => [200, 202].includes(result.status)));
  assert.equal(new Set(retryResults.map(result => result.payload.id)).size, 1);

  const [injections, spoofs] = await Promise.all([
    Promise.all(Array.from({ length: HOSTILE_COUNT }, (_, index) =>
      send(outsider, bob, cases[0], `Inject ${index}`, `inject-${index}`))),
    Promise.all(Array.from({ length: HOSTILE_COUNT }, (_, index) =>
      send(alice, bob, cases[0], `Spoof ${index}`, `spoof-${index}`, bob.agent.id)))
  ]);
  assert.ok(injections.every(result => result.status === 403), `Injection statuses: ${injections.map(result => result.status)}`);
  assert.ok(spoofs.every(result => [401, 403].includes(result.status)), `Spoof statuses: ${spoofs.map(result => result.status)}`);

  const canonical = await eventually(async () => {
    const [aAlice, aBob, bAlice, bBob] = await Promise.all([
      read(alice, cases[0]), read(bob, cases[0]), read(alice, cases[1]), read(bob, cases[1])
    ]);
    if ([aAlice, aBob, bAlice, bBob].some(result => result.status !== 200)) return null;
    const countA = aAlice.payload.events.filter(event => event.payload.messageId).length;
    const countB = bAlice.payload.events.filter(event => event.payload.messageId).length;
    if (countA !== WRITE_COUNT_PER_CASE + 2 || countB !== WRITE_COUNT_PER_CASE + 1) return null;
    if (!isDeepStrictEqual(aAlice.payload, aBob.payload) || !isDeepStrictEqual(bAlice.payload, bBob.payload)) return null;
    return [aAlice.payload, bAlice.payload];
  });
  for (const item of canonical) {
    for (let index = 1; index < item.events.length; index += 1) {
      assert.equal(item.events[index].precedingEventRef, item.events[index - 1].id);
    }
  }

  const reads = await Promise.all(Array.from({ length: READ_COUNT }, (_, index) =>
    read(index % 2 ? bob : alice, cases[index % 2])));
  assert.ok(reads.every(result => result.status === 200), `Read statuses: ${reads.map(result => result.status)}`);

  const mcpCalls = await Promise.all(Array.from({ length: MCP_COUNT }, async (_, index) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alice.agentApiToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'sinaloa_agent_info', arguments: {} } }),
      signal: AbortSignal.timeout(30_000)
    });
    return { status: response.status, payload: await response.json() };
  }));
  assert.ok(mcpCalls.every(result => result.status === 200 && result.payload.result), `MCP statuses: ${mcpCalls.map(result => result.status)}`);

  const invalidMcp = async token => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(30_000)
    });
    await response.body?.cancel();
    return response.status;
  };
  const fixedInvalid = await Promise.all(Array.from({ length: 190 }, () => invalidMcp('fixed-invalid-token')));
  const rotatingInvalid = await Promise.all(Array.from({ length: 190 }, (_, index) => invalidMcp(`rotating-invalid-token-${index}`)));
  assert.ok(fixedInvalid.includes(429), 'The fixed invalid token should eventually be rate limited');
  assert.ok(fixedInvalid.every(status => status === 401 || status === 429));
  assert.ok(rotatingInvalid.every(status => status === 401 || status === 429));
  const rateLimitBypass = !rotatingInvalid.includes(429);

  console.log(JSON.stringify({
    mode: 'local disposable FileStore; no hosted providers',
    owners: 3,
    cases: 2,
    concurrentWrites: writeResults.length,
    idempotentRetries: retryResults.length,
    deniedInjections: injections.length,
    deniedSpoofs: spoofs.length,
    concurrentReads: reads.length,
    concurrentMcpCalls: mcpCalls.length,
    writeLatencyMs: { p50: percentile(writeResults.map(result => result.ms), 0.5), p95: percentile(writeResults.map(result => result.ms), 0.95) },
    readLatencyMs: { p50: percentile(reads.map(result => result.ms), 0.5), p95: percentile(reads.map(result => result.ms), 0.95) },
    caseMessageEventCounts: canonical.map(item => item.events.filter(event => event.payload.messageId).length),
    invalidBearerFlood: {
      fixed: { unauthorized: fixedInvalid.filter(status => status === 401).length, rateLimited: fixedInvalid.filter(status => status === 429).length },
      rotating: { unauthorized: rotatingInvalid.filter(status => status === 401).length, rateLimited: rotatingInvalid.filter(status => status === 429).length }
    },
    result: rateLimitBypass ? 'FINDING: rotating invalid bearer strings bypass the local request limit' : 'PASS'
  }, null, 2));
  if (rateLimitBypass) process.exitCode = 1;
} finally {
  await server?.stop();
  const tempRoot = path.resolve(tmpdir());
  const target = path.resolve(dataDir);
  if (!target.startsWith(`${tempRoot}${path.sep}`) || !path.basename(target).startsWith('sinaloa-stress-local-')) {
    throw new Error('Refusing to remove an unexpected stress fixture path');
  }
  await rm(target, { recursive: true, force: true });
}
