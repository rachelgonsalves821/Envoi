import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

async function launch(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_HUMAN_AUTH_PROVIDER: 'local',
      SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir,
      SINALOA_EMAIL_PROVIDER: 'disabled', SINALOA_OBJECT_STORAGE_PROVIDER: 'local' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server start timed out: ${stderr}`)); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
  };
}

async function api(baseUrl, route, { token, session, body, headers = {} } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? session.headers(baseUrl, method) : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  return response.payload;
}

async function login(baseUrl, suffix, { mfa = true } = {}) {
  const session = new BrowserSession();
  const started = expectStatus(await api(baseUrl, '/api/auth/phone/start', {
    session, body: { phoneNumber: `+1416555${suffix}`, displayName: `Preferences human ${suffix}` }
  }), 201);
  const verified = expectStatus(await api(baseUrl, '/api/auth/phone/verify', {
    session, body: { challengeId: started.challengeId, code: started.developmentCode }
  }), 200);
  if (mfa) {
    const setup = expectStatus(await api(baseUrl, '/api/auth/totp/setup', { session, body: {} }), 201);
    expectStatus(await api(baseUrl, '/api/auth/totp/verify', {
      session, body: { code: generateSync({ secret: setup.secret }) }
    }), 200);
  }
  return { session, human: verified.human };
}

async function owner(baseUrl, suffix) {
  const account = await login(baseUrl, suffix);
  const workspace = expectStatus(await api(baseUrl, '/api/inboxes', {
    session: account.session, body: { name: `Preferences ${suffix}` }
  }), 201);
  const enrollment = expectStatus(await api(baseUrl, `/api/inboxes/${workspace.id}/agent-enrollment-tokens`, {
    session: account.session, body: { permissions: ['execute_cases'] }
  }), 201);
  const enrolled = expectStatus(await api(baseUrl, '/api/agent-enroll', {
    body: { enrollmentToken: enrollment.enrollmentToken, name: `Preferences agent ${suffix}`, slug: `preferences-${suffix}` }
  }), 201);
  return { ...account, ...enrolled };
}

async function fixture(context, suffix) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-preferences-integration-'));
  let server;
  context.after(async () => { await server?.stop(); await rm(dataDir, { recursive: true, force: true }); });
  server = await launch(dataDir);
  const account = await owner(server.baseUrl, suffix);
  const createdCase = expectStatus(await api(server.baseUrl, `/api/inboxes/${account.inbox.id}/cases`, {
    token: account.agentApiToken, body: { objective: 'Track an inbox preference without changing case execution' }
  }), 201);
  const store = new FileStore(dataDir);
  const inboxRoute = `/api/inboxes/${account.inbox.id}`;
  const caseRoute = `${inboxRoute}/cases/${createdCase.id}`;
  return {
    account, createdCase, store, inboxRoute, caseRoute,
    request: (route, options) => api(server.baseUrl, route, options),
    view: async (session = account.session) => expectStatus(await api(server.baseUrl, `${inboxRoute}/human-view`, { session }), 200),
    login: (suffix, options) => login(server.baseUrl, suffix, options),
    restart: async () => { await server.stop(); server = await launch(dataDir); }
  };
}

function queueCase(view, caseId) {
  const workCase = view.caseQueue.find(item => item.id === caseId);
  assert.ok(workCase, `Expected ${caseId} in human-view caseQueue`);
  assert.ok(workCase.inboxPreference, 'Expected inboxPreference projection');
  return workCase;
}

async function addMember(state, account) {
  const organizationId = state.account.inbox.organizationId;
  const membership = { organizationId, humanId: account.human.id, role: 'member', status: 'active', createdAt: new Date().toISOString() };
  await state.store.putJson(path.join('organizations', organizationId, 'members', `${account.human.id}.json`), membership);
  await state.store.putJson(path.join('humans', account.human.id, 'organizations', `${organizationId}.json`), { organizationId, role: 'member' });
  return membership;
}

test('real server projects inbox preferences, preserves case state, persists across restart and makes new events unread', async context => {
  const state = await fixture(context, '6201');
  const session = state.account.session;
  const initial = queueCase(await state.view(), state.createdCase.id);
  assert.equal(initial.inboxPreference.read, false);
  assert.equal(initial.inboxPreference.archived, false);
  assert.equal(initial.inboxPreference.folderId, null);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, initial.inboxPreference);

  const created = expectStatus(await state.request(`${state.inboxRoute}/inbox-folders`, {
    session, body: { name: 'Research' }
  }), 200);
  assert.deepEqual(Object.keys(created), ['folder']);
  assert.deepEqual(Object.keys(created.folder).sort(), ['id', 'name']);
  assert.equal(created.folder.name, 'Research');
  assert.ok(created.folder.id);
  assert.deepEqual((await state.view()).folders, [created.folder]);

  const canonical = expectStatus(await state.request(state.caseRoute, { token: state.account.agentApiToken }), 200);
  const updated = expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session, body: { folderId: created.folder.id, archive: true, read: true, readThrough: initial.inboxPreference.revision }
  }), 200);
  assert.deepEqual(Object.keys(updated), ['inboxPreference']);
  assert.equal(updated.inboxPreference.folderId, created.folder.id);
  assert.equal(updated.inboxPreference.archived, true);
  assert.equal(updated.inboxPreference.read, true);
  assert.equal(updated.inboxPreference.readThrough, initial.inboxPreference.revision);
  assert.deepEqual(expectStatus(await state.request(state.caseRoute, { token: state.account.agentApiToken }), 200), canonical);
  const archived = queueCase(await state.view(), state.createdCase.id);
  assert.equal(archived.state, initial.state);
  assert.deepEqual(archived.inboxPreference, updated.inboxPreference);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, updated.inboxPreference);

  await state.restart();
  const persisted = await state.view();
  assert.deepEqual(persisted.folders, [created.folder]);
  assert.deepEqual(queueCase(persisted, state.createdCase.id).inboxPreference, updated.inboxPreference);
  assert.deepEqual(expectStatus(await state.request(state.caseRoute, { token: state.account.agentApiToken }), 200), canonical);

  const event = expectStatus(await state.request(`${state.caseRoute}/events`, {
    token: state.account.agentApiToken, body: { type: 'message', payload: { text: 'A new update after marking read' } }
  }), 201);
  const changed = queueCase(await state.view(), state.createdCase.id);
  assert.ok(changed.events.some(item => item.id === event.id));
  assert.equal(changed.inboxPreference.read, false);
  assert.notEqual(changed.inboxPreference.revision, updated.inboxPreference.revision);
  assert.equal(changed.inboxPreference.readThrough, updated.inboxPreference.readThrough);
  assert.equal(changed.inboxPreference.archived, true);
  assert.equal(changed.inboxPreference.folderId, created.folder.id);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, changed.inboxPreference);

  const staleRead = expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session, body: { read: true, readThrough: initial.inboxPreference.revision }
  }), 200);
  assert.equal(staleRead.inboxPreference.read, false);
  const restored = expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session, body: { archive: false, folderId: null, read: true, readThrough: changed.inboxPreference.revision }
  }), 200);
  assert.equal(restored.inboxPreference.read, true);
  assert.equal(restored.inboxPreference.archived, false);
  assert.equal(restored.inboxPreference.folderId, null);
});

test('real human sessions in the same organization keep folders and case preferences personal', async context => {
  const state = await fixture(context, '6202');
  const second = await state.login('6203');
  await addMember(state, second);
  const secondInitial = await state.view(second.session);
  assert.equal(secondInitial.inbox.organizationId, state.account.inbox.organizationId);
  assert.equal(secondInitial.requester.id, second.human.id);
  assert.deepEqual(secondInitial.folders, []);
  const secondPreference = queueCase(secondInitial, state.createdCase.id).inboxPreference;
  assert.equal(secondPreference.read, false);
  assert.equal(secondPreference.archived, false);

  const firstFolder = expectStatus(await state.request(`${state.inboxRoute}/inbox-folders`, {
    session: state.account.session, body: { name: 'Personal' }
  }), 200).folder;
  const firstPreference = expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session: state.account.session, body: { folderId: firstFolder.id, read: true, archive: true }
  }), 200).inboxPreference;
  const secondView = await state.view(second.session);
  assert.deepEqual(secondView.folders, []);
  assert.deepEqual(queueCase(secondView, state.createdCase.id).inboxPreference, secondPreference);
  expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session: second.session, body: { folderId: firstFolder.id }
  }), 404);

  const secondFolder = expectStatus(await state.request(`${state.inboxRoute}/inbox-folders`, {
    session: second.session, body: { name: 'Personal' }
  }), 200).folder;
  assert.notEqual(secondFolder.id, firstFolder.id);
  const secondUpdated = expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session: second.session, body: { folderId: secondFolder.id, read: true, archive: false }
  }), 200).inboxPreference;
  assert.deepEqual((await state.view()).folders, [firstFolder]);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, firstPreference);
  await state.restart();
  assert.deepEqual((await state.view(second.session)).folders, [secondFolder]);
  assert.deepEqual(queueCase(await state.view(second.session), state.createdCase.id).inboxPreference, secondUpdated);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, firstPreference);
});

test('real routes reject unauthenticated, agent, nonmember and insufficient-assurance preference writes', async context => {
  const state = await fixture(context, '6204');
  const outsider = await state.login('6205');
  const phoneOnly = await state.login('6206', { mfa: false });
  await addMember(state, phoneOnly);
  const initial = queueCase(await state.view(), state.createdCase.id).inboxPreference;
  for (const options of [{}, { token: state.account.agentApiToken }, { session: outsider.session }, { session: phoneOnly.session }]) {
    for (const [route, body] of [
      [`${state.inboxRoute}/inbox-folders`, { name: 'Unauthorized' }],
      [`${state.caseRoute}/inbox-preferences`, { read: true, archive: true }]
    ]) {
      const rejected = await state.request(route, { ...options, body });
      assert.ok([401, 403].includes(rejected.status), `Expected authentication/access rejection: ${rejected.status} ${JSON.stringify(rejected.payload)}`);
    }
  }
  const agentView = await state.request(`${state.inboxRoute}/human-view`, { token: state.account.agentApiToken });
  assert.ok([401, 403].includes(agentView.status), JSON.stringify(agentView.payload));
  const outsiderView = await state.request(`${state.inboxRoute}/human-view`, { session: outsider.session });
  assert.equal(outsiderView.status, 401, JSON.stringify(outsiderView.payload));
  expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session: state.account.session, headers: { 'x-sinaloa-csrf': 'invalid' }, body: { read: true }
  }), 403);
  expectStatus(await state.request(`${state.caseRoute}/inbox-preferences`, {
    session: state.account.session, body: { state: 'completed' }
  }), 400);
  expectStatus(await state.request(`${state.inboxRoute}/cases/case_missing/inbox-preferences`, {
    session: state.account.session, body: { archive: true }
  }), 404);
  assert.deepEqual((await state.view()).folders, []);
  assert.deepEqual(queueCase(await state.view(), state.createdCase.id).inboxPreference, initial);
  assert.deepEqual(expectStatus(await state.request(state.caseRoute, { token: state.account.agentApiToken }), 200), state.createdCase);
});
