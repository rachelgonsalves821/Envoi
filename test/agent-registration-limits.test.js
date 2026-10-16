// agent-registration v1 (task A-4.2): §2 creation and claim-failure limits on a real FileStore, and
// on PostgreSQL when DATABASE_URL is set. The PostgreSQL database is shared, so those runs use
// random addresses and humans, and never move the clock forward for creations (that would leave
// future times in the shared global counter).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { createPollLimiter, createRegistrationLimits, networkKeys } from '../src/agent-registration-limits.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const creationPath = name => path.join('rate-limits', 'agent-registrations', `${name}.json`);
const minute = 60_000;
const hour = 3_600_000;

async function fileStore(t, dir) {
  const root = dir ?? await mkdtemp(path.join(tmpdir(), 'envoi-registration-limits-'));
  if (!dir) t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  return { store, root };
}

// A clock the test moves by hand.
function clock(startMs = Date.parse('2026-10-16T12:00:00.000Z')) {
  let current = startMs;
  return { now: () => new Date(current), set: ms => { current = ms; }, advance: ms => { current += ms; }, get ms() { return current; } };
}

async function snapshot(root) {
  const dir = path.join(root, 'rate-limits');
  const files = await readdir(dir, { recursive: true }).catch(() => []);
  const result = {};
  for (const file of files.sort()) {
    const content = await readFile(path.join(dir, file), 'utf8').catch(error => (error.code === 'EISDIR' ? null : Promise.reject(error)));
    if (content !== null) result[file] = content;
  }
  return result;
}

test('networkKeys derives source, network and wide network per §2', () => {
  const v4 = { source: 'v4:203.0.113.5', network: 'v4:203.0.113', wide: null };
  const cases = [
    ['203.0.113.5', v4],
    [' 203.0.113.5 ', v4],
    ['::ffff:203.0.113.5', v4],
    ['::FFFF:203.0.113.5', v4],
    ['::ffff:cb00:7105', v4],
    ['0:0:0:0:0:ffff:203.0.113.5', v4],
    ['[::ffff:203.0.113.5]', v4],
    ['2001:db8:85a3:0:0:8a2e:370:7334', { source: 'v6:2001:0db8:85a3:0000', network: 'v6:2001:0db8:85a3', wide: 'v6:2001:0db8' }],
    ['2001:0DB8:85A3:0000:0000:8A2E:0370:7334', { source: 'v6:2001:0db8:85a3:0000', network: 'v6:2001:0db8:85a3', wide: 'v6:2001:0db8' }],
    ['2001:db8:85a3::8a2e:370:7334', { source: 'v6:2001:0db8:85a3:0000', network: 'v6:2001:0db8:85a3', wide: 'v6:2001:0db8' }],
    ['2001:db8:1:2::1', { source: 'v6:2001:0db8:0001:0002', network: 'v6:2001:0db8:0001', wide: 'v6:2001:0db8' }],
    ['2001:db8::', { source: 'v6:2001:0db8:0000:0000', network: 'v6:2001:0db8:0000', wide: 'v6:2001:0db8' }],
    ['::1', { source: 'v6:0000:0000:0000:0000', network: 'v6:0000:0000:0000', wide: 'v6:0000:0000' }],
    ['::', { source: 'v6:0000:0000:0000:0000', network: 'v6:0000:0000:0000', wide: 'v6:0000:0000' }],
    ['fe80::1%eth0', { source: 'v6:fe80:0000:0000:0000', network: 'v6:fe80:0000:0000', wide: 'v6:fe80:0000' }],
    ['fe80::abcd:1%25', { source: 'v6:fe80:0000:0000:0000', network: 'v6:fe80:0000:0000', wide: 'v6:fe80:0000' }],
    ['64:ff9b::192.0.2.1', { source: 'v6:0064:ff9b:0000:0000', network: 'v6:0064:ff9b:0000', wide: 'v6:0064:ff9b' }],
    ['garbage', { source: 'raw:garbage', network: 'raw:garbage', wide: null }],
    ['1.2.3', { source: 'raw:1.2.3', network: 'raw:1.2.3', wide: null }],
    ['256.1.1.1', { source: 'raw:256.1.1.1', network: 'raw:256.1.1.1', wide: null }],
    ['2001:db8::1::2', { source: 'raw:2001:db8::1::2', network: 'raw:2001:db8::1::2', wide: null }],
    ['', { source: 'raw:', network: 'raw:', wide: null }],
    [undefined, { source: 'raw:undefined', network: 'raw:undefined', wide: null }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(networkKeys(input), expected, JSON.stringify(input));
  // Two addresses in one /64 share a source.
  assert.equal(networkKeys('2001:db8:1:2::1').source, networkKeys('2001:db8:1:2:ffff:ffff:ffff:ffff').source);
});

test('[FileStore] 10 per source per hour, refusal writes nothing, the window slides, and counts are durable', async t => {
  const { store, root } = await fileStore(t);
  const time = clock();
  const start = time.ms;
  const limits = createRegistrationLimits({ store, now: time.now });
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(await limits.consumeCreation('203.0.113.5'), { allowed: true }, `creation ${index + 1}`);
    time.advance(minute);
  }
  // 10 minutes have passed; the oldest leaves the window 50 minutes from now.
  const before = await snapshot(root);
  assert.deepEqual(await limits.consumeCreation('203.0.113.5'), { allowed: false, retryAfterSeconds: 3000 });
  assert.deepEqual(await limits.consumeCreation('::ffff:203.0.113.5'), { allowed: false, retryAfterSeconds: 3000 }, 'a mapped address is the same source');
  assert.deepEqual(await snapshot(root), before, 'a refusal writes nothing');
  assert.deepEqual(await limits.consumeCreation('203.0.113.6'), { allowed: true }, 'another source in the /24 is allowed');

  // Never a raw address in a path or a document.
  const after = await snapshot(root);
  assert.ok(Object.keys(after).length > 0);
  for (const [file, content] of Object.entries(after)) {
    assert.ok(!file.includes('203.0.113') && !content.includes('203.0.113'), file);
    assert.match(path.basename(file), /^(?:(?:source|network)-[a-f0-9]{64}|global)\.json$/);
  }
  const source = await store.getJson(creationPath(`source-${sha256('v4:203.0.113.5')}`));
  assert.equal(source.times.length, 10);

  // Durable: a new store object on the same directory sees the same counts.
  const { store: reopened } = await fileStore(t, root);
  const again = createRegistrationLimits({ store: reopened, now: time.now });
  assert.deepEqual(await again.consumeCreation('203.0.113.5'), { allowed: false, retryAfterSeconds: 3000 });

  // The window slides: just after the oldest leaves, one more is allowed, then the next refused.
  time.set(start + hour + 1);
  assert.deepEqual(await again.consumeCreation('203.0.113.5'), { allowed: true });
  const refused = await again.consumeCreation('203.0.113.5');
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 60, 'the second-oldest leaves one minute after the first');
  const pruned = await reopened.getJson(creationPath(`source-${sha256('v4:203.0.113.5')}`));
  assert.equal(pruned.times.length, 10, 'stored times are pruned to the window');
  assert.ok(pruned.times.every(value => Date.parse(value) > time.ms - hour));
});

test('[FileStore] an IPv4 /24 is one network: 30 per hour', async t => {
  const { store } = await fileStore(t);
  const time = clock();
  const limits = createRegistrationLimits({ store, now: time.now });
  for (let index = 0; index < 30; index += 1) {
    assert.deepEqual(await limits.consumeCreation(`198.51.100.${index + 1}`), { allowed: true });
    time.advance(1000);
  }
  assert.deepEqual(await limits.consumeCreation('198.51.100.200'), { allowed: false, retryAfterSeconds: 3570 });
  assert.deepEqual(await limits.consumeCreation('198.51.101.200'), { allowed: true }, 'another /24');
});

test('[FileStore] IPv6: a /64 is one source and /64s in one /48 share 30 per hour', async t => {
  const { store } = await fileStore(t);
  const time = clock();
  const limits = createRegistrationLimits({ store, now: time.now });
  for (let index = 0; index < 10; index += 1) assert.equal((await limits.consumeCreation(`2001:db8:aaaa:1::${index + 1}`)).allowed, true);
  assert.equal((await limits.consumeCreation('2001:db8:aaaa:1:ffff::1')).allowed, false, 'same /64');
  for (let index = 2; index <= 21; index += 1) assert.equal((await limits.consumeCreation(`2001:db8:aaaa:${index.toString(16)}::1`)).allowed, true, `/64 ${index}`);
  const refused = await limits.consumeCreation('2001:db8:aaaa:99::1');
  assert.deepEqual(refused, { allowed: false, retryAfterSeconds: 3600 }, 'a fresh /64 in the full /48');
  assert.equal((await limits.consumeCreation('2001:db8:aaab:99::1')).allowed, true, 'another /48');
});

test('[FileStore] IPv6: /48s in one /32 share 100 per hour', async t => {
  const { store } = await fileStore(t);
  const time = clock();
  const limits = createRegistrationLimits({ store, now: time.now });
  for (let index = 0; index < 100; index += 1) assert.equal((await limits.consumeCreation(`2001:db9:${index.toString(16)}::1`)).allowed, true, `/48 ${index}`);
  time.advance(5 * minute);
  assert.deepEqual(await limits.consumeCreation('2001:db9:ffff::1'), { allowed: false, retryAfterSeconds: 3300 });
  assert.equal((await limits.consumeCreation('2001:dba:1::1')).allowed, true, 'another /32');
});

test('[FileStore] at most 1,000 creations within the 600 s claim window', async t => {
  const { store } = await fileStore(t);
  const time = clock();
  const limits = createRegistrationLimits({ store, now: time.now });
  const iso = ms => new Date(ms).toISOString();
  // 999 recent creations, and 50 older than the claim window that no longer count.
  const times = [...Array(50).fill(iso(time.ms - 601_000)), ...Array(999).fill(iso(time.ms - 1000))];
  await store.putJson(creationPath('global'), { times });
  assert.deepEqual(await limits.consumeCreation('192.0.2.1'), { allowed: true });
  const global = await store.getJson(creationPath('global'));
  assert.equal(global.times.length, 1000, 'pruned to the window on write');
  assert.deepEqual(await limits.consumeCreation('192.0.2.2'), { allowed: false, retryAfterSeconds: 599 });
  assert.deepEqual(await limits.consumeCreation('2001:db8::1'), { allowed: false, retryAfterSeconds: 599 });
  time.advance(599_000);
  assert.deepEqual(await limits.consumeCreation('192.0.2.2'), { allowed: true }, 'the seeded creations left the window');
});

test('[FileStore] malformed stored times count as absent', async t => {
  const { store } = await fileStore(t);
  const time = clock();
  const limits = createRegistrationLimits({ store, now: time.now });
  await store.putJson(creationPath(`source-${sha256('v4:192.0.2.9')}`), { times: [...Array(20).fill('not a time'), 42, null] });
  await store.putJson(creationPath('global'), { times: 'nope' });
  assert.deepEqual(await limits.consumeCreation('192.0.2.9'), { allowed: true });
  assert.equal((await store.getJson(creationPath(`source-${sha256('v4:192.0.2.9')}`))).times.length, 1);
});

test('[FileStore] concurrent creations from one source never exceed the limit', async t => {
  const { store } = await fileStore(t);
  const limits = createRegistrationLimits({ store });
  const results = await Promise.all(Array.from({ length: 25 }, () => limits.consumeCreation('192.0.2.77')));
  assert.equal(results.filter(result => result.allowed).length, 10);
  assert.ok(results.filter(result => !result.allowed).every(result => result.retryAfterSeconds >= 3599 && result.retryAfterSeconds <= 3600));
});

async function claimFailures(t, store, humanId, time) {
  const limits = createRegistrationLimits({ store, now: time.now });
  const start = time.ms;
  for (let index = 0; index < 4; index += 1) {
    await limits.recordClaimFailure(humanId);
    time.advance(1000);
  }
  assert.equal(await limits.claimLockRetryAfter(humanId), 0, '4 failures do not lock');
  await limits.recordClaimFailure(humanId); // at start + 4 s
  assert.equal(await limits.claimLockRetryAfter(humanId), 896, 'the oldest leaves 900 s after start, 896 s from now');
  time.advance(10_000);
  assert.equal(await limits.claimLockRetryAfter(humanId), 886);
  assert.equal(await limits.claimLockRetryAfter(`${humanId}-other`), 0, 'per human');
  // A sixth failure: the oldest of the newest five (start + 1 s) decides.
  await limits.recordClaimFailure(humanId);
  assert.equal(await limits.claimLockRetryAfter(humanId), 887);
  time.set(start + 900_000);
  assert.equal(await limits.claimLockRetryAfter(humanId), 1, 'still locked until start + 1 s leaves');
  time.set(start + 901_000);
  assert.equal(await limits.claimLockRetryAfter(humanId), 0, 'unlocked after 900 s');
  time.set(start + 2_000_000);
  await limits.recordClaimFailure(humanId);
  const stored = await store.getJson(path.join('rate-limits', 'agent-claims', `${sha256(humanId)}.json`));
  assert.equal(stored.failures.length, 1, 'pruned to the window on write');
  assert.ok(!JSON.stringify(stored).includes(humanId));
}

test('[FileStore] claim failures: 5 per human per 15 minutes, durable', async t => {
  const { store, root } = await fileStore(t);
  const time = clock();
  await claimFailures(t, store, 'human_alice', time);
  const files = await readdir(path.join(root, 'rate-limits', 'agent-claims'));
  assert.deepEqual(files, [`${sha256('human_alice')}.json`]);
  // Durable across a new store object.
  const limits = createRegistrationLimits({ store, now: time.now });
  for (let index = 0; index < 4; index += 1) await limits.recordClaimFailure('human_bob');
  const { store: reopened } = await fileStore(t, root);
  const again = createRegistrationLimits({ store: reopened, now: time.now });
  await again.recordClaimFailure('human_bob');
  assert.equal(await again.claimLockRetryAfter('human_bob'), 900);
});

test('poll limiter: one recorded poll per 4 s per registration', () => {
  const limiter = createPollLimiter();
  assert.equal(limiter.check('registration_a', 0), 0);
  assert.equal(limiter.check('registration_a', 3999), 5);
  assert.equal(limiter.check('registration_a', 4000), 0, 'a refused poll is not recorded');
  assert.equal(limiter.check('registration_a', 7999), 5);
  assert.equal(limiter.check('registration_b', 7999), 0, 'per registration');
  assert.equal(limiter.check('registration_a', 8000), 0);
  const custom = createPollLimiter({ minIntervalMs: 100, retryAfterSeconds: 2 });
  assert.equal(custom.check('r', 0), 0);
  assert.equal(custom.check('r', 99), 2);
  assert.equal(custom.check('r', 100), 0);
  assert.equal(typeof createPollLimiter().check('r'), 'number', 'defaults to Date.now()');

  // Bounded memory: pruning drops only entries older than an hour.
  const bounded = createPollLimiter();
  for (let index = 0; index < 10_000; index += 1) bounded.check(`old_${index}`, 0);
  assert.equal(bounded.check('recent', 2 * hour), 0);
  assert.equal(bounded.check('recent', 2 * hour + 1), 5, 'the recent entry survives pruning');
  assert.equal(bounded.check('old_1', 2 * hour + 1), 0);
});

if (process.env.DATABASE_URL) {
  const { PostgresStore } = await import('../src/postgres-storage.js');
  const open = async t => {
    const store = new PostgresStore(process.env.DATABASE_URL);
    t.after(() => store.close());
    await store.init();
    return store;
  };
  // A random IPv6 /32 per run, so runs sharing the database never share a counter.
  const randomPrefix = () => `2001:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}`;

  test('[PostgreSQL] 10 per source per hour, refusal writes nothing, durable across store objects', async t => {
    const store = await open(t);
    const time = clock(Date.now());
    const limits = createRegistrationLimits({ store, now: time.now });
    const prefix = randomPrefix();
    const ip = `${prefix}:1::1`;
    for (let index = 0; index < 10; index += 1) {
      assert.deepEqual(await limits.consumeCreation(ip), { allowed: true }, `creation ${index + 1}`);
      time.advance(1000);
    }
    const sourcePath = creationPath(`source-${sha256(networkKeys(ip).source)}`);
    const before = await store.getJson(sourcePath);
    assert.deepEqual(await limits.consumeCreation(`${prefix}:1:ffff::2`), { allowed: false, retryAfterSeconds: 3590 });
    assert.deepEqual(await store.getJson(sourcePath), before, 'a refusal writes nothing');
    const reopened = await open(t);
    const again = createRegistrationLimits({ store: reopened, now: time.now });
    assert.deepEqual(await again.consumeCreation(ip), { allowed: false, retryAfterSeconds: 3590 });
    assert.deepEqual(await again.consumeCreation(`${prefix}:2::1`), { allowed: true }, 'another /64');
  });

  test('[PostgreSQL] concurrent creations from one source never exceed the limit', async t => {
    const store = await open(t);
    const limits = createRegistrationLimits({ store });
    const ip = `${randomPrefix()}:7::7`;
    const results = await Promise.all(Array.from({ length: 15 }, () => limits.consumeCreation(ip)));
    assert.equal(results.filter(result => result.allowed).length, 10);
  });

  test('[PostgreSQL] claim failures: 5 per human per 15 minutes', async t => {
    const store = await open(t);
    await claimFailures(t, store, `human_pg_${crypto.randomUUID()}`, clock(Date.now()));
  });
}
