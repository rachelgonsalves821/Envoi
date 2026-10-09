import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { enrollmentConnectionStatus, validateConnectionReport } from '../src/agent-connection.js';

async function startServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-quick-connect-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com/' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  t.after(() => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  }));
  return { baseUrl, dataDir };
}

async function api(baseUrl, pathname, { session, token, body, method = body ? 'POST' : 'GET' } = {}) {
  const sessionHeaders = session ? session.headers(baseUrl, method) : {};
  if (sessionHeaders.origin) sessionHeaders.origin = 'https://www.envoi-agents.com';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...sessionHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function human(baseUrl, suffix, mfa = true) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165550${suffix}`, displayName: `Quick Connect owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  if (mfa) {
    const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
    assert.equal(setup.status, 201);
    assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  }
  return { session, human: verified.payload.human };
}

test('connector downloads support GET and body-free HEAD with matching metadata', async t => {
  const { baseUrl } = await startServer(t);
  const metadata = await fetch(`${baseUrl}/web/downloads/release.json`).then(response => response.json());
  for (const [filename, contentType] of [
    ['release.json', 'application/json; charset=utf-8'],
    ['envoi-connector.mjs', 'text/javascript; charset=utf-8']
  ]) {
    const url = `${baseUrl}/web/downloads/${filename}`;
    const get = await fetch(url);
    const bytes = Buffer.from(await get.arrayBuffer());
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(get.status, 200);
    assert.equal(head.status, 200);
    for (const header of ['content-type', 'content-length', 'cache-control']) {
      assert.equal(head.headers.get(header), get.headers.get(header));
    }
    assert.equal(head.headers.get('content-type'), contentType);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    if (filename === 'envoi-connector.mjs') {
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), metadata.artifacts[filename].sha256);
    }
  }
  for (const method of ['GET', 'HEAD']) {
    const missing = await fetch(`${baseUrl}/web/downloads/not-a-release.mjs`, { method });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    const invalid = await fetch(`${baseUrl}/web/%2e%2e%2fpackage.json`, { method });
    assert.equal(invalid.status, 400);
    await invalid.arrayBuffer();
  }
});

test('Quick Connect enrollment and setup status remain scoped and secret-free', async t => {
  const { baseUrl, dataDir } = await startServer(t);
  const owner = await human(baseUrl, '331');
  const outsider = await human(baseUrl, '332');
  const phoneOnly = await human(baseUrl, '333', false);
  const workspace = await api(baseUrl, '/api/inboxes', { session: owner.session, body: { name: 'Quick Connect workspace' } });
  assert.equal(workspace.status, 201);
  const workspaceId = workspace.payload.id;
  const create = async localPart => api(baseUrl, `/api/inboxes/${workspaceId}/agent-enrollment-tokens`, {
    session: owner.session, body: { agentProfile: { name: 'Potato', localPart }, permissions: ['receive_agent_messages'] }
  });
  const created = await create('quick-potato');
  assert.equal(created.status, 201);
  const { enrollmentId, enrollmentToken, quickConnect } = created.payload;
  assert.deepEqual(quickConnect, {
    version: 1, runtime: 'openclaw', apiUrl: 'https://www.envoi-agents.com', enrollmentToken,
    expiresAt: created.payload.expiresAt, agentName: 'Potato', address: 'quick-potato@envoi.mail'
  });
  const statusPath = `/api/inboxes/${workspaceId}/agent-enrollment-tokens/${enrollmentId}/status`;
  const status = async () => api(baseUrl, statusPath, { session: owner.session });
  assert.deepEqual((await status()).payload, { enrollmentId, phase: 'waiting', expiresAt: created.payload.expiresAt });
  assert.equal((await api(baseUrl, statusPath)).status, 401);
  assert.equal((await api(baseUrl, statusPath, { session: outsider.session })).status, 401);
  assert.equal((await api(baseUrl, statusPath, { session: phoneOnly.session })).status, 401);
  const membershipPath = path.join(dataDir, 'organizations', workspace.payload.organizationId, 'members', `${owner.human.id}.json`);
  const membership = JSON.parse(await readFile(membershipPath, 'utf8'));
  await writeFile(path.join(dataDir, 'organizations', workspace.payload.organizationId, 'members', `${phoneOnly.human.id}.json`), JSON.stringify({ ...membership, humanId: phoneOnly.human.id, role: 'admin' }));
  assert.equal((await api(baseUrl, statusPath, { session: phoneOnly.session })).status, 401, 'workspace admin still requires MFA');
  await writeFile(membershipPath, JSON.stringify({ ...membership, role: 'viewer' }));
  assert.equal((await status()).status, 403);
  await writeFile(membershipPath, JSON.stringify(membership));
  const missing = await api(baseUrl, `/api/inboxes/${workspaceId}/agent-enrollment-tokens/enrollment_missing/status`, { session: owner.session });
  assert.equal(missing.status, 404);

  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken } });
  assert.equal(enrolled.status, 201);
  const token = enrolled.payload.agentApiToken;
  const agent = enrolled.payload.agent;
  const agentInbox = enrolled.payload.inbox;
  assert.equal((await status()).payload.phase, 'enrolled');
  assert.deepEqual((await status()).payload.agent, { id: agent.id, inboxId: agentInbox.id, address: agent.address, name: agent.name });
  assert.equal((await api(baseUrl, statusPath, { token })).status, 401);
  assert.equal((await api(baseUrl, `/api/inboxes/${agentInbox.id}/agent-enrollment-tokens/${enrollmentId}/status`, { token })).status, 403);
  const report = { version: 1, runtime: 'openclaw', phase: 'ready', gatewayTest: 'passed' };
  assert.equal((await api(baseUrl, '/api/agent/connection-status', { session: owner.session, body: report })).status, 401);
  const reported = await api(baseUrl, '/api/agent/connection-status', { token, body: report });
  assert.equal(reported.status, 200);
  assert.equal(reported.payload.phase, 'ready');
  assert.ok(reported.payload.checkedAt);
  const ready = (await status()).payload;
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.checkedAt, reported.payload.checkedAt);
  for (const secret of [enrollmentToken, token, enrolled.payload.agentRefreshToken, crypto.createHash('sha256').update(enrollmentToken).digest('hex')]) assert.equal(JSON.stringify(ready).includes(secret), false);
  assert.equal(Object.keys(ready).some(key => /token|credential|gateway|family/i.test(key)), false);

  const rotated = await api(baseUrl, '/api/agent-token', { body: { agentRefreshToken: enrolled.payload.agentRefreshToken, rotationId: 'rotation-quick-connect-1' } });
  assert.equal(rotated.status, 200);
  assert.equal((await status()).payload.phase, 'ready');
  const error = await api(baseUrl, '/api/agent/connection-status', { token: rotated.payload.agentApiToken, body: { version: 1, runtime: 'openclaw', phase: 'error', gatewayTest: 'failed', errorCode: 'GATEWAY_UNREACHABLE' } });
  assert.equal(error.status, 200);
  assert.equal((await status()).payload.phase, 'error');
  assert.equal((await status()).payload.errorCode, 'GATEWAY_UNREACHABLE');
  for (const bad of [
    { ...report, version: 2 }, { ...report, runtime: 'hermes' }, { ...report, phase: 'online' },
    { ...report, gatewayTest: 'failed' }, { ...report, gatewayToken: 'secret' },
    { ...report, phase: 'error', errorCode: 'message containing secret' },
    { ...report, errorCode: 'GATEWAY_AUTH_FAILED' }, []
  ]) assert.equal((await api(baseUrl, '/api/agent/connection-status', { token, body: bad })).status, 400);
  assert.equal((await status()).payload.phase, 'error');

  const second = await create('quick-second');
  const secondEnrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: second.payload.enrollmentToken } });
  assert.equal(secondEnrolled.status, 201);
  assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: secondEnrolled.payload.agentApiToken, body: report })).status, 200);
  assert.equal((await status()).payload.phase, 'error', 'another agent report cannot change this enrollment');
  assert.equal((await api(baseUrl, `/api/inboxes/${agentInbox.id}/agents/${agent.id}/credentials/revoke`, { session: owner.session, body: {} })).status, 200);
  assert.equal((await status()).payload.phase, 'revoked');
  assert.equal((await api(baseUrl, '/api/agent/connection-status', { token, body: report })).status, 401);

  const expired = await create('quick-expired');
  assert.equal(expired.status, 201);
  const expiryPath = path.join(dataDir, 'auth', 'enrollment-tokens', `${crypto.createHash('sha256').update(expired.payload.enrollmentToken).digest('hex')}.json`);
  const expiryRecord = JSON.parse(await readFile(expiryPath, 'utf8'));
  await writeFile(expiryPath, JSON.stringify({ ...expiryRecord, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const expiredStatus = `/api/inboxes/${workspaceId}/agent-enrollment-tokens/${expired.payload.enrollmentId}/status`;
  assert.equal((await api(baseUrl, expiredStatus, { session: owner.session })).payload.phase, 'expired');
  assert.equal((await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: expired.payload.enrollmentToken } })).status, 401);
  await writeFile(expiryPath, JSON.stringify({ ...expiryRecord, revokedAt: new Date().toISOString() }));
  assert.equal((await api(baseUrl, expiredStatus, { session: owner.session })).payload.phase, 'revoked');
  assert.equal((await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: expired.payload.enrollmentToken } })).status, 401);
});

test('setup projection cannot revive revoked families or agents and ignores unknown reports', () => {
  const record = { id: 'enrollment_a', usedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:15:00Z', agentInboxId: 'inbox_a' };
  const agent = { id: 'agent_a', status: 'active', onboardingStatus: 'approved', name: 'Potato', address: 'potato@envoi.mail' };
  const family = { refreshExpiresAt: '2030-01-01T00:00:00Z', connectionSetup: { version: 1, runtime: 'openclaw', phase: 'ready', gatewayTest: 'passed', checkedAt: '2026-01-01T00:10:00Z' } };
  assert.equal(enrollmentConnectionStatus(record, agent, family).phase, 'ready', 'token expiry is irrelevant after redemption');
  assert.equal(enrollmentConnectionStatus(record, agent, { ...family, revokedAt: '2026-01-02' }).phase, 'revoked');
  assert.equal(enrollmentConnectionStatus(record, { ...agent, status: 'paused' }, family).phase, 'revoked');
  assert.equal(enrollmentConnectionStatus(record, agent, { ...family, refreshExpiresAt: '2020-01-01' }).phase, 'expired');
  assert.equal(enrollmentConnectionStatus(record, agent, { ...family, connectionSetup: { ...family.connectionSetup, runtime: 'unknown' } }).phase, 'enrolled');
  assert.throws(() => validateConnectionReport(null), /Invalid connection setup report/);
});

test('all runtimes bind setup reports and reconnect without replacing identity or saved history', async t => {
  const { baseUrl, dataDir } = await startServer(t);
  let owner = await human(baseUrl, '334');
  let workspace = await api(baseUrl, '/api/inboxes', { session: owner.session, body: { name: 'Unified runtimes' } });
  const create = runtime => api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, {
    session: owner.session, body: { runtime, agentProfile: { name: runtime, localPart: `unified-${runtime}` } }
  });
  for (const invalid of ['unknown', null, {}, 'Hermes']) assert.equal((await create(invalid)).status, 400);
  for (const runtime of ['openclaw', 'hermes', 'grok']) {
    if (runtime !== 'openclaw') {
      // The existing beta policy deliberately caps active agents at two per human.
      owner = await human(baseUrl, runtime === 'hermes' ? '335' : '336');
      workspace = await api(baseUrl, '/api/inboxes', { session: owner.session, body: { name: `Unified ${runtime}` } });
    }
    const created = await create(runtime);
    assert.equal(created.status, 201);
    assert.equal(created.payload.quickConnect.runtime, runtime);
    const statusPath = `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens/${created.payload.enrollmentId}/status`;
    const wrongRuntime = runtime === 'hermes' ? 'grok' : 'hermes';
    assert.equal((await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: created.payload.enrollmentToken, runtime: wrongRuntime } })).status, 400);
    assert.equal((await api(baseUrl, statusPath, { session: owner.session })).payload.phase, 'waiting', 'runtime mismatch does not consume the token');
    const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: created.payload.enrollmentToken, runtime } });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.payload.agent.runtime, runtime);
    const report = { version: 1, runtime, phase: 'ready', runtimeTest: 'passed' };
    assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: enrolled.payload.agentApiToken, body: { ...report, runtime: wrongRuntime } })).status, 400);
    assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: enrolled.payload.agentApiToken, body: report })).status, 200);
    assert.equal((await api(baseUrl, statusPath, { session: owner.session })).payload.phase, 'ready');
    const { agent, inbox } = enrolled.payload;
    const historyPath = path.join(dataDir, 'inboxes', inbox.id, 'retained-history.json');
    await writeFile(historyPath, JSON.stringify({ previousConversation: `${runtime}-history` }));
    const reconnectPath = `/api/inboxes/${inbox.id}/agents/${agent.id}/credentials/reconnect-token`;
    assert.equal((await api(baseUrl, reconnectPath, { session: owner.session, body: { runtime: 'unknown' } })).status, 400);
    const reconnect = await api(baseUrl, reconnectPath, { session: owner.session, body: {} });
    assert.equal(reconnect.status, 201);
    assert.equal(reconnect.payload.quickConnect.operation, 'reconnect');
    assert.equal(reconnect.payload.quickConnect.runtime, runtime, 'defaults to the persisted runtime');
    assert.equal(reconnect.payload.quickConnect.address, agent.address);
    const reconnectStatus = `/api/inboxes/${inbox.id}/agent-enrollment-tokens/${reconnect.payload.enrollmentId}/status`;
    assert.equal((await api(baseUrl, reconnectStatus, { session: owner.session })).payload.phase, 'waiting');
    // Issuing a reconnect handoff must not disconnect the existing runtime.
    assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: enrolled.payload.agentApiToken, body: report })).status, 200);
    const renewed = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnect.payload.enrollmentToken, runtime } });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.payload.agent.id, agent.id);
    assert.equal(renewed.payload.agent.address, agent.address);
    assert.equal(renewed.payload.inbox.id, inbox.id);
    assert.equal((await api(baseUrl, reconnectStatus, { session: owner.session })).payload.phase, 'enrolled');
    assert.equal((await api(baseUrl, statusPath, { session: owner.session })).payload.phase, 'revoked');
    assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: enrolled.payload.agentApiToken, body: report })).status, 401);
    assert.equal((await api(baseUrl, '/api/agent-token', { body: { agentRefreshToken: enrolled.payload.agentRefreshToken, rotationId: 'rotation-runtime-revoked-1' } })).status, 401);
    assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: renewed.payload.agentApiToken, body: report })).status, 200);
    const ready = (await api(baseUrl, reconnectStatus, { session: owner.session })).payload;
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.agent.inboxId, inbox.id);
    assert.equal(JSON.stringify(ready).includes(reconnect.payload.enrollmentToken), false);
    assert.deepEqual(JSON.parse(await readFile(historyPath, 'utf8')), { previousConversation: `${runtime}-history` });
    assert.equal((await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnect.payload.enrollmentToken } })).status, 401);
    if (runtime === 'grok') {
      const migration = await api(baseUrl, reconnectPath, { session: owner.session, body: { runtime: 'hermes' } });
      assert.equal(migration.payload.quickConnect.runtime, 'hermes');
      const migrated = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: migration.payload.enrollmentToken, runtime: 'hermes' } });
      assert.equal(migrated.status, 200);
      assert.equal(migrated.payload.agent.id, agent.id);
      assert.equal(migrated.payload.agent.runtime, 'hermes');
      assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: migrated.payload.agentApiToken, body: report })).status, 400);
      assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: migrated.payload.agentApiToken, body: { ...report, runtime: 'hermes' } })).status, 200);
    }
  }
});

test('reports accept generic runtime checks, reject conflicting legacy fields and unknown diagnostics', () => {
  for (const runtime of ['openclaw', 'hermes', 'grok']) {
    assert.equal(validateConnectionReport({ version: 1, runtime, phase: 'ready', runtimeTest: 'passed' }).runtime, runtime);
    assert.equal(validateConnectionReport({ version: 1, runtime, phase: 'error', runtimeTest: 'failed', errorCode: 'MODEL_CREDENTIAL_MISSING' }).errorCode, 'MODEL_CREDENTIAL_MISSING');
  }
  assert.throws(() => validateConnectionReport({ version: 1, runtime: 'openclaw', phase: 'ready', runtimeTest: 'passed', gatewayTest: 'failed' }), /Invalid/);
  assert.throws(() => validateConnectionReport({ version: 1, runtime: 'hermes', phase: 'ready', gatewayTest: 'passed' }), /Invalid/);
  assert.throws(() => validateConnectionReport({ version: 1, runtime: 'hermes', phase: 'error', runtimeTest: 'failed', errorCode: 'private credential details' }), /Invalid/);
  const record = { id: 'enrollment_bound', runtime: 'hermes', usedAt: '2026-01-01', expiresAt: '2026-01-02' };
  const agent = { status: 'active', onboardingStatus: 'approved' };
  const family = { runtime: 'hermes', refreshExpiresAt: '2099-01-01', connectionSetup: { version: 1, runtime: 'grok', phase: 'ready', runtimeTest: 'passed', checkedAt: '2026-01-01' } };
  assert.equal(enrollmentConnectionStatus(record, agent, family).phase, 'enrolled', 'mismatched saved reports never project readiness');
});
