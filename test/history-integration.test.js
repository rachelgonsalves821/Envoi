import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

const browserSession = new BrowserSession();

test('workspace pages, delta boundaries and capped SSE replay preserve all history', async t => {
  const server = await startServer(); t.after(server.stop);
  const started = await request(server.baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550899', displayName: 'History owner' } });
  await request(server.baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const setup = await request(server.baseUrl, '/api/auth/totp/setup', { token: undefined, body: {} });
  await request(server.baseUrl, '/api/auth/totp/verify', { token: undefined, body: { code: generateSync({ secret: setup.payload.secret }) } });
  const workspace = await request(server.baseUrl, '/api/inboxes', { token: undefined, body: { name: 'History' } });
  assert.equal(workspace.status, 201);
  const inboxId = workspace.payload.id;
  const store = new FileStore(server.dataDir);
  for (let index = 1; index <= 505; index += 1) {
    const id = `evt_history_${index}`;
    await store.putJson(path.join('inboxes', inboxId, 'events', `${id}.json`), { id, type: 'history.test', createdAt: '2026-01-01T00:00:00.000Z', sequence: index + 100, cursor: String(index + 100).padStart(20, '0') });
  }
  for (let index = 1; index <= 55; index += 1) {
    const id = `case_history_${String(index).padStart(3, '0')}`;
    await store.putJson(path.join('inboxes', inboxId, 'cases', `${id}.json`), { id, schemaVersion: '1.0', state: 'new', objective: 'History', createdAt: '2026-01-01', updatedAt: '2026-01-01', events: [] });
  }
  const first = await request(server.baseUrl, `/api/inboxes/${inboxId}/human-view`, { token: undefined });
  assert.equal(first.status, 200); assert.equal(first.payload.cases.length, 50); assert.equal(first.payload.summary.cases, 55);
  const identity = await request(server.baseUrl, '/api/auth/me', { token: undefined });
  assert.deepEqual(first.payload.requester, { id: identity.payload.id, auth: { provider: 'local', assurance: 'mfa' } });
  const older = await request(server.baseUrl, `/api/inboxes/${inboxId}/human-view?history=${encodeURIComponent(JSON.stringify({ cases: first.payload.history.cases.nextCursor }))}`, { token: undefined });
  assert.equal(older.payload.cases.length, 5);
  assert.equal(new Set([...first.payload.cases, ...older.payload.cases].map(row => row.id)).size, 55);
  assert.equal((await request(server.baseUrl, `/api/inboxes/${inboxId}/human-view?history=bad`, { token: undefined })).status, 400);
  const delta = await request(server.baseUrl, `/api/inboxes/${inboxId}/events/delta?limit=200`, { token: undefined });
  assert.equal(delta.payload.events.length, 200); assert.equal(delta.payload.hasMore, true);
  const next = await request(server.baseUrl, `/api/inboxes/${inboxId}/events/delta?limit=1&cursor=${delta.payload.nextCursor}`, { token: undefined });
  assert.ok(next.payload.events[0].cursor > delta.payload.nextCursor);
  const response = await fetch(`${server.baseUrl}/api/inboxes/${inboxId}/events`, { headers: browserSession.headers(server.baseUrl, 'GET') });
  const replay = await response.text();
  assert.equal((replay.match(/^id: /gm) || []).length, 500);
  assert.match(replay, /event: replay_required\ndata:/);
  const checkpoint = [...replay.matchAll(/^id: (.+)$/gm)].at(-1)[1];
  const remainder = await request(server.baseUrl, `/api/inboxes/${inboxId}/events/delta?cursor=${checkpoint}`, { token: undefined });
  assert.equal(remainder.payload.events.length, await store.countJson(path.join('inboxes', inboxId, 'events')) - 500);
});

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-test-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, SINALOA_ENABLE_CALENDAR_WRITES: 'true', SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS: 'true', SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, dataDir, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function request(baseUrl, pathname, options = {}) {
  const { token, body, headers = {}, method = body ? 'POST' : 'GET' } = options;
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(Object.hasOwn(options, 'token') && !token ? browserSession.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  browserSession.capture(response);
  const payload = await response.json();
  return { status: response.status, payload };
}
