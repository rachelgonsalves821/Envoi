import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

async function startServer(t, environment = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-session-test-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, WORKOS_COOKIE_NAME: 'sinaloa_session', SINALOA_CSRF_COOKIE_NAME: 'sinaloa_csrf', ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const controllers = new Set();
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${diagnostics}`)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}: ${diagnostics}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, dataDir, controllers };
}

async function request(server, session, pathname, { body, headers, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: { ...session.headers(server.baseUrl, method), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  session.capture(response);
  return { response, payload: await response.json() };
}

async function signIn(server, { secret, returning = false } = {}) {
  const session = new BrowserSession();
  if (returning) {
    const directory = path.join(server.dataDir, 'auth', 'phone-rate-limits');
    for (const name of await readdir(directory)) await writeFile(path.join(directory, name), JSON.stringify({ starts: [] }));
  }
  const started = await request(server, session, '/api/auth/phone/start', { body: { phoneNumber: '+14165550123', displayName: 'Session owner' } });
  assert.equal(started.response.status, 201);
  const verified = await request(server, session, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.response.status, 200);
  if (!secret) {
    const setup = await request(server, session, '/api/auth/totp/setup', { body: {} });
    assert.equal(setup.response.status, 201);
    secret = setup.payload.secret;
  }
  const completed = await request(server, session, '/api/auth/totp/verify', { body: { code: generateSync({ secret, ...(returning ? { epoch: Math.floor(Date.now() / 1000) + 30 } : {}) }) } });
  assert.equal(completed.response.status, 200);
  return { session, secret, expiresAt: verified.payload.expiresAt };
}

async function createWorkspace(server, session) {
  const result = await request(server, session, '/api/inboxes', { body: { name: 'Session regression workspace' } });
  assert.equal(result.response.status, 201);
  return result.payload;
}

async function openStream(server, session, inboxId) {
  const controller = new AbortController();
  server.controllers.add(controller);
  const response = await fetch(`${server.baseUrl}/api/inboxes/${inboxId}/events`, { headers: session.headers(server.baseUrl, 'GET'), signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames = [];
  const receive = async () => {
    const { done, value } = await reader.read();
    if (done) return true;
    buffered += decoder.decode(value, { stream: true });
    const blocks = buffered.split('\n\n');
    buffered = blocks.pop();
    for (const block of blocks) {
      const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7);
      const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (data) frames.push({ event, data: JSON.parse(data) });
    }
    return false;
  };
  // The ready frame proves history replay finished and the live subscription is attached.
  await withDeadline(async () => {
    while (!frames.some(frame => frame.event === 'ready')) assert.equal(await receive(), false, 'Stream closed before becoming ready');
  }, 3000, 'Stream never became ready', controller);
  frames.length = 0;
  return {
    frames,
    async waitForClose(timeoutMs = 2000) {
      await withDeadline(async () => { while (!await receive()) {} }, timeoutMs, 'Authenticated stream stayed open after the session ended', controller);
    }
  };
}

async function withDeadline(operation, timeoutMs, message, controller) {
  let timer;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error(message)); controller.abort(); }, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

function assertCookiesCleared(response) {
  const values = response.headers.getSetCookie();
  assert.ok(values.some(value => /^sinaloa_session=;/.test(value) && /Max-Age=0/i.test(value)), 'Logout clears the session cookie');
  assert.ok(values.some(value => /^sinaloa_csrf=;/.test(value) && /Max-Age=0/i.test(value)), 'Logout clears the CSRF cookie');
}

test('logout revokes APIs and an open stream; repeated logout still clears browser cookies', async t => {
  const server = await startServer(t);
  const { session } = await signIn(server);
  const inbox = await createWorkspace(server, session);
  const staleSession = new BrowserSession();
  staleSession.cookies = new Map(session.cookies);
  const staleGetHeaders = staleSession.headers(server.baseUrl, 'GET');
  const stalePostHeaders = staleSession.headers(server.baseUrl, 'POST');
  const stream = await openStream(server, session, inbox.id);

  const loggedOut = await request(server, session, '/api/auth/logout', { body: {} });
  assert.equal(loggedOut.response.status, 200);
  assertCookiesCleared(loggedOut.response);
  assert.equal(session.cookies.size, 0);
  await stream.waitForClose();

  for (const pathname of ['/api/auth/me', '/api/organizations', `/api/inboxes/${inbox.id}/events`]) {
    const denied = await request(server, staleSession, pathname, { headers: staleGetHeaders });
    assert.equal(denied.response.status, 401, `${pathname} rejects the revoked cookie`);
    assertCookiesCleared(denied.response);
  }
  const deniedWrite = await request(server, staleSession, '/api/inboxes', { headers: stalePostHeaders, body: { name: 'Should not be created' } });
  assert.equal(deniedWrite.response.status, 401);

  const repeated = await request(server, staleSession, '/api/auth/logout', { headers: stalePostHeaders, body: {} });
  assert.equal(repeated.response.status, 200);
  assertCookiesCleared(repeated.response);
  const missing = await request(server, new BrowserSession(), '/api/auth/logout', { body: {} });
  assert.equal(missing.response.status, 200);
  assertCookiesCleared(missing.response);
});

test('an idle open stream closes when its human session expires', async t => {
  const server = await startServer(t, { SINALOA_SESSION_HOURS: String(5 / 3600) });
  const { session, expiresAt } = await signIn(server);
  const inbox = await createWorkspace(server, session);
  const stream = await openStream(server, session, inbox.id);
  const remaining = Date.parse(expiresAt) - Date.now();
  assert.ok(remaining > 0, 'Fixture completed authentication before expiry');
  await stream.waitForClose(remaining + 2000);
  const denied = await request(server, session, '/api/auth/me');
  assert.equal(denied.response.status, 401);
  assertCookiesCleared(denied.response);
  assert.ok(stream.frames.every(frame => ['session.expired', 'session.revoked', 'session_expired', 'auth_required', 'session_ended'].includes(frame.event)), 'No private event arrives after the session ends');
});

test('live events are withheld immediately after persisted session expiry', async t => {
  const server = await startServer(t);
  const first = await signIn(server);
  const inbox = await createWorkspace(server, first.session);
  const second = await signIn(server, { secret: first.secret, returning: true });
  const stream = await openStream(server, first.session, inbox.id);
  const directory = path.join(server.dataDir, 'auth', 'sessions');
  const tokenHash = crypto.createHash('sha256').update(decodeURIComponent(first.session.cookies.get('sinaloa_session'))).digest('hex');
  const filename = path.join(directory, `${tokenHash}.json`);
  const original = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify({ ...original, expiresAt: new Date(Date.now() - 1000).toISOString() }));

  // A second session is authorized to create an event; the expired subscriber must not receive it.
  const contact = await request(server, second.session, `/api/inboxes/${inbox.id}/external-contacts`, { body: { email: 'session-event@example.com' } });
  assert.equal(contact.response.status, 201);
  await stream.waitForClose();
  assert.ok(stream.frames.every(frame => ['session.expired', 'session.revoked', 'session_expired', 'auth_required', 'session_ended'].includes(frame.event)), 'Expired stream received no workspace event');
});
