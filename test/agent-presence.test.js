// a5-presence v1 (task A-3): the write rules and the owner connection derivation, checked
// against the approved contract fixtures so the server and the published contract agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advancePresence, agentPresencePath, agentStatusPresence, createPresenceRecorder, ownerConnection, presenceThrottleMs, reportedFamily } from '../src/agent-presence.js';
import { FileStore } from '../src/storage.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'a5-presence');
const at = seconds => new Date(Date.UTC(2026, 9, 12, 12, 0, 0) + seconds * 1000).toISOString();

test('a field is written when absent, then at most once per throttle interval', () => {
  const first = advancePresence(null, at(0), ['lastSeenAt', 'lastWorkClaimAt']);
  assert.deepEqual(first, { lastSeenAt: at(0), lastSuccessfulRefreshAt: null, lastWorkClaimAt: at(0), lastProcessedAt: null });
  assert.equal(advancePresence(first, at(59), ['lastSeenAt', 'lastWorkClaimAt']), null, 'inside the throttle nothing advances');
  assert.equal(advancePresence(first, at(60), ['lastSeenAt', 'lastWorkClaimAt']).lastWorkClaimAt, at(60), 'at the interval it advances');
  assert.equal(presenceThrottleMs, 60_000);
});

test('lastSeenAt leads: any other field advancing advances it outside its own throttle', () => {
  const seen = advancePresence(null, at(0), ['lastSeenAt']);
  const refreshed = advancePresence(seen, at(30), ['lastSeenAt', 'lastSuccessfulRefreshAt']);
  assert.equal(refreshed.lastSuccessfulRefreshAt, at(30));
  assert.equal(refreshed.lastSeenAt, at(30), 'not held back by the 60 s throttle');
});

test('fields never move backwards', () => {
  const stored = { lastSeenAt: at(120), lastSuccessfulRefreshAt: null, lastWorkClaimAt: at(120), lastProcessedAt: null };
  assert.equal(advancePresence(stored, at(10), ['lastSeenAt', 'lastWorkClaimAt']), null);
  const processed = advancePresence(stored, at(100), ['lastSeenAt', 'lastProcessedAt']);
  assert.equal(processed.lastProcessedAt, at(100));
  assert.equal(processed.lastSeenAt, at(120), 'an older write never lowers lastSeenAt');
});

test('only the four contract fields are ever stored', () => {
  const next = advancePresence({ lastSeenAt: null, ip: '192.0.2.1' }, at(0), ['lastSeenAt', 'userAgent']);
  assert.deepEqual(Object.keys(next).sort(), ['lastProcessedAt', 'lastSeenAt', 'lastSuccessfulRefreshAt', 'lastWorkClaimAt']);
});

test('the reported family is the newest non-revoked one, else the newest', () => {
  const families = [
    { id: 'old', createdAt: at(0) },
    { id: 'newest_revoked', createdAt: at(20), revokedAt: at(30) },
    { id: 'live', createdAt: at(10) }
  ];
  assert.equal(reportedFamily(families).id, 'live');
  assert.equal(reportedFamily(families.map(family => ({ ...family, revokedAt: at(40) }))).id, 'newest_revoked');
  assert.equal(reportedFamily([]), null);
});

test('the owner connection matches every approved a5-presence owner fixture', async () => {
  const names = (await readdir(fixtureDir)).filter(name => name.startsWith('owner-'));
  assert.ok(names.length >= 13, 'every owner fixture is covered');
  for (const name of names) {
    const fixture = JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
    const agents = Array.isArray(fixture.response.body) ? fixture.response.body : [fixture.response.body];
    for (const { connection, ...state } of agents) {
      // Rebuild the stored family the fixture describes: none, revoked, or live with its expiry.
      const family = connection.credentialExpiresAt ? { id: 'family_example', refreshExpiresAt: connection.credentialExpiresAt }
        : state.credentialRevoked || state.status === 'revoked' ? { id: 'family_example', revokedAt: '2026-10-11T00:00:00.000Z' }
          : null;
      assert.deepEqual(ownerConnection(state, family, connection.presence, connection.asOf), connection, name);
    }
  }
});

test('asOf is never earlier than a reported timestamp, so ages are never negative', () => {
  const ahead = { lastSeenAt: at(5), lastSuccessfulRefreshAt: null, lastWorkClaimAt: at(5), lastProcessedAt: null };
  const connection = ownerConnection({ status: 'active', onboardingStatus: 'approved', paused: false }, { id: 'f', refreshExpiresAt: at(86_400) }, ahead, at(0));
  assert.equal(connection.asOf, at(5));
  assert.equal(connection.state, 'seen_recently');
  assert.equal(agentStatusPresence(ahead, at(0)).asOf, at(5));
});

test('concurrent presence writes on FileStore stay monotonic and are never lost', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-presence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  const ref = { inboxId: 'inbox_a', agentId: 'agent_a', familyId: 'family_a' };
  const times = [at(0), at(200), at(100), at(300), at(50)];
  let index = 0;
  const recorder = createPresenceRecorder({ store, now: () => times[index++], onError: error => { throw error; } });
  await Promise.all(times.map(() => recorder.record(ref, ['lastSeenAt', 'lastWorkClaimAt'])));
  const stored = await store.getJson(agentPresencePath(ref.inboxId, ref.agentId, ref.familyId));
  assert.equal(stored.lastWorkClaimAt, at(300), 'the newest write wins whatever the arrival order');
  assert.equal(stored.lastSeenAt, at(300));
});

test('a failed presence write is reported and never thrown', async () => {
  const failures = [];
  const recorder = createPresenceRecorder({ store: { updateJson: async () => { throw new Error('storage down'); } }, onError: error => failures.push(error.message) });
  await recorder.record({ inboxId: 'i', agentId: 'a', familyId: 'f' }, ['lastSeenAt']);
  assert.deepEqual(failures, ['storage down']);
});

test('updateJson runs in its own transaction even when called from inside another one', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-presence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  let escaped;
  await store.withTransaction(['k'], async () => {
    // Started, not awaited: awaiting inside would wait on this very transaction.
    escaped = store.updateJson('auth/agent-presence/i/a/f.json', () => ({ lastSeenAt: at(0) }));
    await store.putJson('other.json', { ok: true });
    throw new Error('caller rolls back');
  }).catch(() => {});
  assert.deepEqual(await escaped, { lastSeenAt: at(0) });
  assert.deepEqual(await store.getJson('auth/agent-presence/i/a/f.json'), { lastSeenAt: at(0) }, 'not rolled back with the caller');
  assert.equal(await store.getJson('other.json'), null, 'the caller still rolled back');
});
