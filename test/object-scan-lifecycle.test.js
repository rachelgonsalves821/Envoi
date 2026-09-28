import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { InMemoryMetadataStore } from '../src/object-storage.js';
import { DurableMalwareScanLifecycle, InMemoryMalwareScanJobStore } from '../src/object-scan-lifecycle.js';

const checksum = body => crypto.createHash('sha256').update(body).digest('base64');

async function setup({ body = Buffer.from('safe'), scanner, maxAttempts = 3, deadLetterRetentionMs = 2_000, infectedRetentionMs = 3_000 } = {}) {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const metadataStore = new InMemoryMetadataStore();
  const object = {
    id: 'obj_test', key: 'workspaces/workspace_a/objects/obj_test', workspaceId: 'workspace_a', filename: 'test.txt',
    mimeType: 'text/plain', size: body.length, checksumSha256: checksum(body), state: 'quarantine', scannedAt: null, scan: null
  };
  await metadataStore.create(object);
  const deleted = [];
  const adapter = {
    getObject: async () => body,
    deleteObject: async key => { deleted.push(key); }
  };
  const jobStore = new InMemoryMalwareScanJobStore();
  const lifecycleOptions = {
    jobStore, adapter, metadataStore, scanner, maxAttempts, leaseMs: 1_000, retryBaseMs: 1_000, retryMaxMs: 10_000,
    deadLetterRetentionMs, infectedRetentionMs, completedJobRetentionMs: 4_000, retentionRetryMs: 1_000,
    clock: () => new Date(now), random: () => 0.5
  };
  return { adapter, deleted, jobStore, lifecycleOptions, metadataStore, object, setNow: value => { now = new Date(value); } };
}

test('scan retry survives lifecycle restart and eventually unlocks a verified clean object', async () => {
  let attempts = 0;
  const state = await setup({ scanner: { scan: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('temporary scanner outage'), { code: 'SCANNER_UNAVAILABLE' }); return { status: 'clean', engine: 'test' }; } } });
  const first = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  await assert.rejects(() => first.processObject(state.object.id, 'worker-a'), error => error.code === 'SCANNER_UNAVAILABLE' && error.scanJob.status === 'retrying');
  assert.equal((await state.metadataStore.get(state.object.id)).state, 'error');
  assert.equal((await state.jobStore.get(`scan_${state.object.id}`)).attempts, 1);

  state.setNow('2026-01-01T00:00:01.000Z');
  const afterRestart = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  const clean = await afterRestart.processNext('worker-b');
  assert.equal(clean.state, 'clean');
  assert.equal(clean.scan.engine, 'test');
  assert.equal((await state.jobStore.get(`scan_${state.object.id}`)).status, 'clean');
});

test('lease expiry makes abandoned work claimable by another worker', async () => {
  const state = await setup({ scanner: { scan: async () => ({ status: 'clean' }) } });
  const lifecycle = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  const job = await lifecycle.enqueue(state.object.id);
  assert.ok(await state.jobStore.claim(job.id, 'crashed-worker', 1_000, new Date('2026-01-01T00:00:00.000Z')));
  assert.equal(await state.jobStore.claim(job.id, 'early-worker', 1_000, new Date('2026-01-01T00:00:00.999Z')), null);
  assert.equal((await state.jobStore.claim(job.id, 'recovery-worker', 1_000, new Date('2026-01-01T00:00:01.000Z'))).lockedBy, 'recovery-worker');
});

test('retention lease expiry makes abandoned cleanup claimable', async () => {
  const state = await setup({ scanner: { scan: async () => ({ status: 'infected', engine: 'test' }) }, infectedRetentionMs: 1_000 });
  const lifecycle = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  await lifecycle.processObject(state.object.id, 'scan-worker');
  const first = await state.jobStore.claimRetention('crashed-retention-worker', 1_000, new Date('2026-01-01T00:00:01.000Z'));
  assert.equal(first.statusBeforeRetention, 'infected');
  const recovered = await state.jobStore.claimRetention('recovery-worker', 1_000, new Date('2026-01-01T00:00:02.000Z'));
  assert.equal(recovered.statusBeforeRetention, 'infected');
  assert.equal(recovered.lockedBy, 'recovery-worker');
});

test('immutable checksum failures dead-letter immediately and retention deletes the binary', async () => {
  const expected = Buffer.from('expected');
  const state = await setup({ body: Buffer.from('tampered'), scanner: { scan: async () => assert.fail('scanner must not receive unverified bytes') } });
  state.object.size = expected.length;
  state.object.checksumSha256 = checksum(expected);
  await state.metadataStore.remove(state.object.id);
  await state.metadataStore.create(state.object);
  const lifecycle = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  await assert.rejects(() => lifecycle.processObject(state.object.id, 'worker-a'), error => error.code === 'CHECKSUM_MISMATCH' && error.scanJob.status === 'deadLettered');
  const job = await state.jobStore.get(`scan_${state.object.id}`);
  assert.equal(job.attempts, 1);
  assert.equal(job.lastError.message.includes('tampered'), false);
  assert.equal((await state.metadataStore.get(state.object.id)).state, 'error');

  state.setNow('2026-01-01T00:00:02.000Z');
  const reaped = await lifecycle.reapRetention('retention-worker');
  assert.equal(reaped.action, 'deleted-object');
  assert.deepEqual(state.deleted, [state.object.key]);
  assert.equal((await state.metadataStore.get(state.object.id)).state, 'deleted');
  assert.equal(await state.jobStore.get(job.id), null);
});

test('infected objects stay locked, are retained for policy duration, then deleted', async () => {
  const state = await setup({ scanner: { scan: async () => ({ status: 'infected', engine: 'clamav', signature: 'test-signature' }) } });
  const lifecycle = new DurableMalwareScanLifecycle(state.lifecycleOptions);
  const infected = await lifecycle.processObject(state.object.id, 'worker-a');
  assert.equal(infected.state, 'infected');
  state.setNow('2026-01-01T00:00:02.999Z');
  assert.equal(await lifecycle.reapRetention('retention-worker'), null);
  state.setNow('2026-01-01T00:00:03.000Z');
  assert.equal((await lifecycle.reapRetention('retention-worker')).action, 'deleted-object');
  assert.equal((await state.metadataStore.get(state.object.id)).state, 'deleted');
});
