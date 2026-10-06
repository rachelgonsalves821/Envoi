import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_STREAM_RECHECK_MS, createProviderMembershipCache, streamRecheckMs } from '../src/provider-membership.js';

const SECOND = 1000;
const ORG = 'org_workos_1';

// A pretend WorkOS plus a clock we control. `members` is who WorkOS currently lists;
// set `workos.unreachable` to make every lookup fail.
function fixture() {
  const members = new Set(['user_1']);
  const clock = { time: 0 };
  const calls = [];
  const workos = { unreachable: false };
  const lookup = async (userId, organizationId) => {
    calls.push({ userId, organizationId, at: clock.time });
    if (workos.unreachable) throw new Error('WorkOS is unreachable');
    return members.has(userId) ? { userId, organizationId, status: 'active' } : null;
  };
  const check = createProviderMembershipCache({ lookup, now: () => clock.time });
  return { members, workos, clock, calls, check, person: (id = 'user_1') => ({ id: `human_${id}`, providerUserId: id }) };
}

test('an ordinary request asks WorkOS once and keeps that answer for the whole request', async () => {
  const { check, calls, clock, person } = fixture();
  const human = person();
  assert.ok(await check(human, ORG));
  clock.time += 10 * 60 * SECOND;
  assert.ok(await check(human, ORG));
  assert.equal(calls.length, 1);
});

test('an open stream keeps trusting the answer while it is newer than the recheck window', async () => {
  const { check, calls, clock, person } = fixture();
  const human = person();
  const stream = { maxAgeMs: 60 * SECOND };
  for (const second of [0, 20, 40]) { // the 20-second heartbeat
    clock.time = second * SECOND;
    assert.ok(await check(human, ORG, stream));
  }
  assert.equal(calls.length, 1);
});

test('a member removed from the organization while a stream is open is denied at the next recheck', async () => {
  const { check, members, calls, clock, person } = fixture();
  const human = person();
  const stream = { maxAgeMs: 60 * SECOND };

  assert.ok(await check(human, ORG, stream), 'allowed when the stream opens');
  members.delete('user_1'); // removed in WorkOS at 0:30
  clock.time = 30 * SECOND;
  assert.ok(await check(human, ORG, stream), 'still within the window, so the old answer is used');
  clock.time = 40 * SECOND;
  assert.ok(await check(human, ORG, stream), 'the delay is bounded by the window, not by the stream lifetime');
  clock.time = 60 * SECOND;
  assert.equal(await check(human, ORG, stream), null, 'denied once the window has passed');
  assert.equal(calls.length, 2);
});

test('before this change a removed member kept access for as long as the stream stayed open', async () => {
  const { check, members, clock, person } = fixture();
  const human = person();
  assert.ok(await check(human, ORG)); // no maxAgeMs: the old behaviour
  members.delete('user_1');
  clock.time = 5 * 60 * SECOND;
  assert.ok(await check(human, ORG), 'this is the gap the stream recheck closes');
});

test('a member who is still in the organization keeps access across rechecks', async () => {
  const { check, calls, clock, person } = fixture();
  const human = person();
  const stream = { maxAgeMs: 60 * SECOND };
  for (const second of [0, 60, 120, 180]) {
    clock.time = second * SECOND;
    assert.ok(await check(human, ORG, stream));
  }
  assert.equal(calls.length, 4);
});

test('if WorkOS cannot be reached at a recheck, the check fails so the stream can be closed', async () => {
  const { check, workos, clock, person } = fixture();
  const human = person();
  const stream = { maxAgeMs: 60 * SECOND };
  assert.ok(await check(human, ORG, stream));
  workos.unreachable = true;
  clock.time = 60 * SECOND;
  await assert.rejects(check(human, ORG, stream), /unreachable/);
});

test('checks that overlap share a single call to WorkOS', async () => {
  const { check, calls, clock, person } = fixture();
  const human = person();
  const stream = { maxAgeMs: 60 * SECOND };
  clock.time = 90 * SECOND;
  const answers = await Promise.all([check(human, ORG, stream), check(human, ORG, stream), check(human, ORG, stream)]);
  assert.ok(answers.every(Boolean));
  assert.equal(calls.length, 1);
});

test('each connection and each organization is remembered separately', async () => {
  const { check, calls, person } = fixture();
  const stream = { maxAgeMs: 60 * SECOND };
  await check(person(), ORG, stream);
  await check(person(), ORG, stream); // a new connection is a new person object
  const human = person();
  await check(human, 'org_a', stream);
  await check(human, 'org_b', stream);
  assert.equal(calls.length, 4);
});

test('the recheck interval is configurable, but a bad value cannot turn rechecking off', () => {
  assert.equal(DEFAULT_STREAM_RECHECK_MS, 60 * SECOND);
  assert.equal(streamRecheckMs(undefined), 60 * SECOND);
  assert.equal(streamRecheckMs(''), 60 * SECOND);
  assert.equal(streamRecheckMs('30000'), 30 * SECOND);
  assert.equal(streamRecheckMs('2500.9'), 2500);
  assert.equal(streamRecheckMs('abc'), 60 * SECOND);
  assert.equal(streamRecheckMs('0'), 60 * SECOND);
  assert.equal(streamRecheckMs('-5'), 60 * SECOND);
  assert.equal(streamRecheckMs('999'), 60 * SECOND);
  assert.equal(streamRecheckMs('Infinity'), 60 * SECOND);
});

test('the server passes the recheck window when it authorizes an open event stream', async () => {
  // The behaviour above only helps if the stream actually asks for it. This guards
  // the one line in src/server.js that connects the two.
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /canAccessInbox\(human, inbox, \{ maxAgeMs: streamMembershipRecheckMs \}\)/);
  assert.match(source, /streamRecheckMs\(process\.env\.SINALOA_STREAM_MEMBERSHIP_RECHECK_MS\)/);
});
