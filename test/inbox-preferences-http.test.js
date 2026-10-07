import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { createInboxPreferencesHttp } from '../src/inbox-preferences-http.js';
import { caseReadMarker } from '../src/inbox-preferences.js';
import { projectCaseForHuman, projectWorkspaceForHuman } from '../src/human-projection.js';

async function createHarness(context, existingRoot) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'envoi-inbox-preferences-http-'));
  const store = new FileStore(root);
  await store.init();
  const inboxes = {
    inbox_one: { id: 'inbox_one', organizationId: 'org_one' },
    inbox_two: { id: 'inbox_two', organizationId: 'org_two' }
  };
  const humans = {
    alice: { id: 'human_alice', organizationId: 'org_one' },
    bob: { id: 'human_bob', organizationId: 'org_one' },
    'alice-two': { id: 'human_alice', organizationId: 'org_two' }
  };
  if (!existingRoot) {
    const createdAt = store.now();
    for (const inbox of Object.values(inboxes)) {
      await store.putJson(`inboxes/${inbox.id}/cases/case_one.json`, {
        id: 'case_one', schemaVersion: '1.0', state: 'waitingForHuman', createdAt, updatedAt: createdAt,
        events: [{ id: 'evt_one', createdAt, type: 'message', payload: { text: 'Please review' } }],
        authorityRefs: ['grant_one'], policyEvaluations: [{ id: 'policy_one', decision: 'needsHuman' }]
      });
    }
  }
  const denied = new Set();
  const calls = [];
  let revokeDuringBody = false;
  const writeJson = (res, statusCode, value) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const callbacks = {
    store,
    requireHuman: async req => {
      calls.push('human');
      return humans[req.headers['x-test-human']] ?? null;
    },
    requireInboxAccess: async (req, { human, inboxId }) => {
      calls.push('inbox');
      const inbox = inboxes[inboxId];
      if (!inbox) throw Object.assign(new Error('Inbox not found'), { statusCode: 404 });
      if (denied.has(req.headers['x-test-human']) || inbox.organizationId !== human.organizationId) {
        throw Object.assign(new Error('Active membership required'), { statusCode: 403 });
      }
      return inbox;
    },
    requireCaseAccess: async (_req, { inbox, caseId }) => {
      calls.push('case');
      const workCase = await store.getJson(`inboxes/${inbox.id}/cases/${caseId}.json`);
      return workCase ? projectCaseForHuman(workCase) : null;
    },
    readBody: async req => {
      calls.push('body');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (revokeDuringBody) denied.add(req.headers['x-test-human']);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
    },
    writeJson
  };
  const adapter = createInboxPreferencesHttp(callbacks);
  const server = createServer(async (req, res) => {
    res.setHeader('Set-Cookie', 'existing-session=preserved; HttpOnly');
    try {
      if (req.method === 'GET' && req.url === '/test-human-view') {
        const inboxId = req.headers['x-test-inbox'] || 'inbox_one';
        const workCase = await store.getJson(`inboxes/${inboxId}/cases/case_one.json`);
        const view = { inbox: inboxes[inboxId], caseQueue: projectWorkspaceForHuman([workCase]).cases, cases: [workCase] };
        return writeJson(res, 200, await adapter.projectHumanView(req, { inboxId, view }));
      }
      if (!await adapter.handleRequest(req, res)) writeJson(res, 404, { error: 'Unhandled route' });
    } catch (error) { writeJson(res, error.statusCode || 500, { error: error.message }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!existingRoot) await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    root, store, callbacks, adapter, calls, denied,
    revokeOnBody() { revokeDuringBody = true; },
    async request(route, { human = 'alice', inboxId = 'inbox_one', body, method = body === undefined ? 'GET' : 'POST' } = {}) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { 'x-test-human': human, 'x-test-inbox': inboxId, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
    }
  };
}

test('personal HTTP folder and preference writes persist, deduplicate and move out of Done', async context => {
  const harness = await createHarness(context);
  const original = await harness.store.getJson('inboxes/inbox_one/cases/case_one.json');
  const folderRoute = '/api/inboxes/inbox_one/inbox-folders';
  const caseRoute = '/api/inboxes/inbox_one/cases/case_one/inbox-preferences';
  const created = await harness.request(folderRoute, { body: { name: ' Travel ' } });
  const duplicate = await harness.request(folderRoute, { body: { name: 'TRAVEL' } });
  assert.equal(created.status, 200);
  assert.deepEqual(duplicate.body, created.body);
  const view = await harness.request('/test-human-view');
  const revision = view.body.caseQueue[0].inboxPreference.revision;
  const done = await harness.request(caseRoute, { body: { folderId: created.body.folder.id, archive: true, read: true, readThrough: revision } });
  assert.equal(done.status, 200);
  assert.equal(done.body.inboxPreference.archived, true);
  assert.equal(done.body.inboxPreference.read, true);
  assert.match(done.cookie, /existing-session=preserved/);
  const restarted = await createHarness(context, harness.root);
  const persisted = await restarted.request('/test-human-view');
  assert.deepEqual(persisted.body.folders, [created.body.folder]);
  assert.deepEqual(persisted.body.caseQueue[0].inboxPreference, done.body.inboxPreference);
  const restored = await restarted.request(caseRoute, { body: { archive: false } });
  assert.equal(restored.body.inboxPreference.archived, false);
  assert.equal(restored.body.inboxPreference.folderId, created.body.folder.id);
  assert.equal(restored.body.inboxPreference.readThrough, revision);
  assert.deepEqual(await harness.store.getJson('inboxes/inbox_one/cases/case_one.json'), original);
});

test('every HTTP mutation requires a human, current inbox membership and an existing case', async context => {
  const harness = await createHarness(context);
  const folderRoute = '/api/inboxes/inbox_one/inbox-folders';
  const caseRoute = '/api/inboxes/inbox_one/cases/case_one/inbox-preferences';
  assert.equal((await harness.request(folderRoute, { human: 'agent', body: { name: 'Travel' } })).status, 401);
  assert.equal((await harness.request(caseRoute, { human: 'agent', body: { archive: true } })).status, 401);
  assert.equal((await harness.request('/api/inboxes/inbox_two/inbox-folders', { body: { name: 'Travel' } })).status, 403);
  assert.equal((await harness.request('/api/inboxes/inbox_one/cases/case_missing/inbox-preferences', { body: { archive: true } })).status, 404);
  harness.revokeOnBody();
  harness.calls.length = 0;
  assert.equal((await harness.request(caseRoute, { body: { archive: true } })).status, 403);
  assert.deepEqual(harness.calls, ['human', 'body', 'inbox']);
  assert.deepEqual(await harness.store.listJson('human-inbox-preferences/org_one/personal/human_alice/inboxes/inbox_one/cases'), []);
});

test('HTTP scope comes from trusted human/inbox callbacks and annotations stay personal', async context => {
  const harness = await createHarness(context);
  const folderRoute = '/api/inboxes/inbox_one/inbox-folders';
  const caseRoute = '/api/inboxes/inbox_one/cases/case_one/inbox-preferences';
  const created = await harness.request(folderRoute, { body: { name: 'Travel' } });
  await harness.request(caseRoute, { body: { folderId: created.body.folder.id, archive: true } });
  for (const options of [{ human: 'bob' }, { human: 'alice-two', inboxId: 'inbox_two' }]) {
    const view = await harness.request('/test-human-view', options);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.folders, []);
    assert.equal(view.body.caseQueue[0].inboxPreference.archived, false);
  }
  assert.equal((await harness.request(caseRoute, { human: 'bob', body: { folderId: created.body.folder.id } })).status, 404);
  for (const body of [{ archive: true, humanId: 'human_bob' }, { archive: true, organizationId: 'org_two' }, { archive: true, scopeMode: 'shared' }]) {
    assert.equal((await harness.request(caseRoute, { body })).status, 400);
  }
});

test('HTTP stale acknowledgement keeps a new message unread and projection writes nothing', async context => {
  const harness = await createHarness(context);
  const initialView = await harness.request('/test-human-view');
  const revision = initialView.body.caseQueue[0].inboxPreference.revision;
  const casePath = 'inboxes/inbox_one/cases/case_one.json';
  const workCase = await harness.store.getJson(casePath);
  workCase.events.push({ id: 'evt_two', createdAt: workCase.events[0].createdAt, type: 'message', payload: { text: 'A newer message' } });
  await harness.store.putJson(casePath, workCase);
  const stale = await harness.request('/api/inboxes/inbox_one/cases/case_one/inbox-preferences', { body: { read: true, readThrough: revision } });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.inboxPreference.read, false);
  harness.store.putJson = async () => { throw new Error('Projection must not write'); };
  const refreshed = await harness.request('/test-human-view');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.caseQueue[0].inboxPreference.read, false);
  assert.notEqual(refreshed.body.caseQueue[0].inboxPreference.revision, revision);
  assert.equal(Object.hasOwn(refreshed.body.cases[0], 'inboxPreference'), false);
});

test('adapter requires callbacks, leaves unrelated routes alone and protects projection inputs', async context => {
  const harness = await createHarness(context);
  for (const name of ['requireHuman', 'requireInboxAccess', 'requireCaseAccess', 'readBody', 'writeJson']) {
    assert.throws(() => createInboxPreferencesHttp({ ...harness.callbacks, [name]: undefined }), new RegExp(name));
  }
  assert.equal((await harness.request('/api/inboxes/inbox_one/inbox-folders')).status, 404);
  assert.equal((await harness.request('/unrelated', { body: {} })).status, 404);
  assert.equal((await harness.request('/api/inboxes/inbox_one/cases/case_one/inbox-preferences', { body: { state: 'completed' } })).status, 400);
  const req = { headers: { 'x-test-human': 'alice' } };
  const workCase = await harness.store.getJson('inboxes/inbox_one/cases/case_one.json');
  const view = { caseQueue: [Object.freeze(workCase)], cases: [workCase] };
  const projected = await harness.adapter.projectHumanView(req, { inboxId: 'inbox_one', view });
  assert.notEqual(projected.caseQueue[0], workCase);
  assert.equal(projected.cases, view.cases);
  assert.equal(Object.hasOwn(workCase, 'inboxPreference'), false);
  await assert.rejects(() => harness.adapter.projectHumanView(req, {
    inboxId: 'inbox_one', view: { ...view, inbox: { id: 'inbox_two', organizationId: 'org_two' } }
  }), error => error.statusCode === 400);
});

test('real human case projection keeps observed GET and POST revisions consistent', async context => {
  const harness = await createHarness(context);
  const casePath = 'inboxes/inbox_one/cases/case_one.json';
  const raw = await harness.store.getJson(casePath);
  assert.equal(caseReadMarker(raw), caseReadMarker(projectCaseForHuman(raw)));
  raw.messages = [{ id: 'msg_raw_only', createdAt: raw.createdAt, text: 'Canonical-only message field' }];
  await harness.store.putJson(casePath, raw);
  assert.notEqual(caseReadMarker(raw), caseReadMarker(projectCaseForHuman(raw)));
  const view = await harness.request('/test-human-view');
  const displayed = view.body.caseQueue[0];
  assert.ok(displayed.timeline.length > 0);
  assert.equal(displayed.inboxPreference.revision, caseReadMarker(projectCaseForHuman(raw)));
  const saved = await harness.request('/api/inboxes/inbox_one/cases/case_one/inbox-preferences', {
    body: { read: true, readThrough: displayed.inboxPreference.revision }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.inboxPreference.read, true);
  assert.equal((await harness.request('/test-human-view')).body.caseQueue[0].inboxPreference.read, true);
});

test('optional mutation guard rechecks under supplied locks before folder and case writes', async context => {
  const harness = await createHarness(context);
  let guards = 0;
  const guarded = createInboxPreferencesHttp({
    ...harness.callbacks,
    mutationAuthorization: async (_req, { human, inbox }) => {
      assert.equal(human.id, 'human_alice');
      assert.equal(inbox.id, 'inbox_one');
      return {
        lockKeys: ['fixture:membership-and-session'],
        authorize: async () => {
          assert.ok(harness.store.currentTransaction().keys.has('fixture:membership-and-session'));
          guards += 1;
          throw Object.assign(new Error('Fixture revocation detected'), { statusCode: 403 });
        }
      };
    }
  });
  harness.adapter.handleRequest = guarded.handleRequest;
  for (const [route, body] of [
    ['/api/inboxes/inbox_one/inbox-folders', { name: 'Travel' }],
    ['/api/inboxes/inbox_one/cases/case_one/inbox-preferences', { archive: true }]
  ]) {
    assert.equal((await harness.request(route, { body })).status, 403);
  }
  assert.equal(guards, 2);
  assert.deepEqual(await harness.store.listJson('human-inbox-preferences/org_one/personal/human_alice/inboxes/inbox_one/cases'), []);
});
