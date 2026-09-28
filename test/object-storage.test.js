import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FileStore } from '../src/storage.js';
import {
  InMemoryMetadataStore,
  InMemoryQuotaLedger,
  LocalObjectStorageAdapter,
  ObjectStorageError,
  ObjectStorageService,
  S3CompatibleObjectStorageAdapter,
  validateObjectStorageConfig
} from '../src/object-storage.js';

const checksum = body => crypto.createHash('sha256').update(body).digest('base64');

async function createLocalService({ scanner = { scan: async () => ({ status: 'clean', engine: 'test' }) }, quota = 1000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-object-store-'));
  const adapter = new LocalObjectStorageAdapter(root);
  const service = new ObjectStorageService({
    adapter,
    metadataStore: new InMemoryMetadataStore(),
    quotaLedger: new InMemoryQuotaLedger({ defaultQuotaBytes: quota }),
    scanner,
    maxObjectBytes: 1000,
    allowedMimeTypes: ['text/plain']
  });
  await service.init();
  return { root, adapter, service };
}

async function createAndUpload({ service, adapter }, body = Buffer.from('safe message'), options = {}) {
  const started = await service.beginUpload({
    workspaceId: options.workspaceId ?? 'workspace_a',
    filename: options.filename ?? 'message.txt',
    mimeType: options.mimeType ?? 'text/plain',
    size: body.length,
    checksumSha256: checksum(body)
  });
  const token = new URL(started.upload.url).pathname.split('/').at(-1);
  await adapter.putPresigned(token, body, started.upload.headers);
  return started;
}

test('local storage isolates workspace keys and fails downloads closed until clean', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const started = await createAndUpload(setup);
  assert.match(started.object.key, /^workspaces\/workspace_a\/objects\/obj_[0-9a-f-]+$/);
  assert.equal(started.object.state, 'quarantine');
  await assert.rejects(() => setup.service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await setup.service.completeUpload(started.object.id);
  const clean = await setup.service.scanObject(started.object.id);
  assert.equal(clean.state, 'clean');
  const download = await setup.service.createDownload(started.object.id);
  assert.match(download.url, /^local-object:\/\/download\//);
  const original = await setup.service.getObject(started.object.id);
  assert.equal(original.filename, 'message.txt');
  assert.equal(original.checksumSha256, checksum(Buffer.from('safe message')));
});

test('object metadata and checksums are immutable and uploads are verified', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const body = Buffer.from('fixed payload');
  const started = await setup.service.beginUpload({ workspaceId: 'workspace_a', filename: 'fixed.txt', mimeType: 'text/plain', size: body.length, checksumSha256: checksum(body) });
  const token = new URL(started.upload.url).pathname.split('/').at(-1);
  await assert.rejects(() => setup.adapter.putPresigned(token, Buffer.from('tampered'), started.upload.headers), error => error.code === 'CHECKSUM_MISMATCH');
  await assert.rejects(() => setup.service.completeUpload(started.object.id), error => error.code === 'UPLOAD_VERIFICATION_FAILED');
  const record = await setup.service.getObject(started.object.id);
  assert.throws(() => { record.filename = 'changed.txt'; }, TypeError);
  assert.equal((await setup.service.getObject(started.object.id)).filename, 'fixed.txt');
});

test('infected and scanner-error objects remain unavailable', async t => {
  const infected = await createLocalService({ scanner: { scan: async () => ({ status: 'infected', engine: 'clamav', signature: 'Eicar-Test-Signature' }) } });
  const failed = await createAndUpload(infected, Buffer.from('infected'));
  await infected.service.scanObject(failed.object.id);
  assert.equal((await infected.service.getObject(failed.object.id)).state, 'infected');
  await assert.rejects(() => infected.service.createDownload(failed.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await rm(infected.root, { recursive: true, force: true });

  const broken = await createLocalService({ scanner: { scan: async () => { throw new Error('scanner offline'); } } });
  const brokenUpload = await createAndUpload(broken, Buffer.from('scanner error'));
  await assert.rejects(() => broken.service.scanObject(brokenUpload.object.id), /scanner offline/);
  assert.equal((await broken.service.getObject(brokenUpload.object.id)).state, 'error');
  await assert.rejects(() => broken.service.createDownload(brokenUpload.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await rm(broken.root, { recursive: true, force: true });
});

test('quota reservations are race-safe and only commit verified uploads', async () => {
  const ledger = new InMemoryQuotaLedger({ defaultQuotaBytes: 10 });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => ledger.reserve('workspace_a', 6)));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected' && attempt.reason.code === 'QUOTA_EXCEEDED').length, 3);
  const reservation = attempts.find(attempt => attempt.status === 'fulfilled').value;
  await ledger.release(reservation.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 0, reserved: 0, quota: 10 });
  const committed = await ledger.reserve('workspace_a', 6);
  await ledger.commit(committed.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 6, reserved: 0, quota: 10 });
  await ledger.deleteCommitted(committed.id);
  await ledger.deleteCommitted(committed.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 0, reserved: 0, quota: 10 });
});

test('persistent quota releases expired reservations and rejects late commits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-object-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const reservation = await store.reserveObjectQuota('workspace_a', 8, 10, 1_000);
  const reclaimed = await store.reclaimExpiredObjectQuota(new Date(new Date(reservation.expiresAt).getTime() + 1).toISOString());
  assert.deepEqual(reclaimed, { releasedReservations: 1, releasedBytes: 8 });
  assert.deepEqual(await store.objectQuotaUsage('workspace_a', 10), { workspaceId: 'workspace_a', used: 0, reserved: 0, quota: 10 });
  await assert.rejects(() => store.commitObjectQuota(reservation.id), error => error.code === 'QUOTA_RESERVATION_EXPIRED');
  const committed = await store.reserveObjectQuota('workspace_a', 6, 10);
  await store.commitObjectQuota(committed.id);
  await store.deleteCommittedObjectQuota(committed.id);
  await store.deleteCommittedObjectQuota(committed.id);
  assert.deepEqual(await store.objectQuotaUsage('workspace_a', 10), { workspaceId: 'workspace_a', used: 0, reserved: 0, quota: 10 });
});

test('strict validation rejects unsafe input and public S3 configurations', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const valid = { workspaceId: 'workspace_a', filename: 'safe.txt', mimeType: 'text/plain', size: 3, checksumSha256: checksum(Buffer.from('abc')) };
  await assert.rejects(() => setup.service.beginUpload({ ...valid, filename: '../escape.txt' }), error => error.code === 'INVALID_FILENAME');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, mimeType: 'application/octet-stream' }), error => error.code === 'INVALID_MIME_TYPE');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, size: 0 }), error => error.code === 'INVALID_SIZE');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, checksumSha256: 'not-a-checksum' }), error => error.code === 'INVALID_CHECKSUM');
  assert.throws(() => validateObjectStorageConfig({ provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1', accessKeyId: 'key', secretAccessKey: 'secret', publicBucket: true }), error => error instanceof ObjectStorageError && error.code === 'INVALID_STORAGE_CONFIG');
});

test('S3-compatible adapter creates private checksum-bound presigned URLs', async () => {
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-value'
  });
  const digest = checksum(Buffer.from('payload'));
  const upload = await adapter.createPresignedUpload({ key: 'workspaces/workspace_a/objects/obj_1', contentType: 'text/plain', checksumSha256: digest, expiresInSeconds: 60 });
  const url = new URL(upload.url);
  assert.equal(url.protocol, 'https:');
  assert.match(url.pathname, /^\/private-bucket\/workspaces\/workspace_a\/objects\/obj_1$/);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
  assert.deepEqual(url.searchParams.get('X-Amz-SignedHeaders').split(';'), ['content-type', 'host', 'if-none-match', 'x-amz-checksum-sha256', 'x-amz-meta-sinaloa-sha256']);
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  assert.equal(upload.headers['x-amz-checksum-sha256'], digest);
  assert.equal(upload.headers['x-amz-meta-sinaloa-sha256'], digest);
  assert.equal(upload.headers['if-none-match'], '*');
  assert.ok(!upload.url.includes('secret-value'));
  const download = await adapter.createPresignedDownload({ key: 'workspaces/workspace_a/objects/obj_1', expiresInSeconds: 60 });
  assert.equal(new URL(download.url).searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('R2 mode uses region auto and metadata-bound SHA-256 without unsupported full-object checksum mode', async () => {
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 'r2', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'private-bucket', accessKeyId: 'R2EXAMPLE', secretAccessKey: 'secret-value'
  });
  const digest = checksum(Buffer.from('payload'));
  const upload = await adapter.createPresignedUpload({ key: 'workspaces/workspace_a/objects/obj_1', contentType: 'text/plain', checksumSha256: digest, expiresInSeconds: 60 });
  const url = new URL(upload.url);
  assert.match(url.searchParams.get('X-Amz-Credential'), /\/auto\/s3\/aws4_request$/);
  assert.equal(upload.headers['x-amz-meta-sinaloa-sha256'], digest);
  assert.equal(upload.headers['x-amz-checksum-sha256'], undefined);
  assert.deepEqual(url.searchParams.get('X-Amz-SignedHeaders').split(';'), ['content-type', 'host', 'if-none-match', 'x-amz-meta-sinaloa-sha256']);
  await assert.rejects(() => adapter.createPresignedDownload({ key: 'valid/key', expiresInSeconds: 604_801 }), error => error.code === 'INVALID_PRESIGN_TTL');
});

test('S3 adapter bounds transport time and sanitizes timeout failures', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'must-not-leak', requestTimeoutMs: 5
  });
  await assert.rejects(() => adapter.headObject('workspaces/workspace_a/objects/obj_1'), error => {
    assert.equal(error.code, 'OBJECT_STORAGE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.message.includes('must-not-leak'), false);
    assert.equal(error.message.includes('s3.example.test'), false);
    return true;
  });
});
