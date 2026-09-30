import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  HttpMalwareScanner,
  InMemoryMetadataStore,
  InMemoryQuotaLedger,
  ObjectStorageService,
  S3CompatibleObjectStorageAdapter
} from '../src/object-storage.js';

const r2Enabled = process.env.SINALOA_RUN_LIVE_R2_TESTS === '1';
const scannerEnabled = process.env.SINALOA_RUN_LIVE_SCANNER_TESTS === '1';
const checksum = body => crypto.createHash('sha256').update(body).digest('base64');
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

function liveR2Adapter() {
  return new S3CompatibleObjectStorageAdapter({
    provider: 'r2',
    endpoint: process.env.SINALOA_LIVE_R2_ENDPOINT,
    bucket: process.env.SINALOA_LIVE_R2_BUCKET,
    region: 'auto',
    accessKeyId: process.env.SINALOA_LIVE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.SINALOA_LIVE_R2_SECRET_ACCESS_KEY,
    sessionToken: process.env.SINALOA_LIVE_R2_SESSION_TOKEN,
    requestTimeoutMs: 15_000
  });
}

function liveScanner(token = process.env.SINALOA_LIVE_SCANNER_TOKEN, timeoutMs = 15_000) {
  return new HttpMalwareScanner({ endpoint: process.env.SINALOA_LIVE_SCANNER_URL, token, timeoutMs });
}

async function upload(adapter, started, body) {
  const response = await fetch(started.upload.url, { method: 'PUT', headers: started.upload.headers, body, signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `R2 signed upload returned ${response.status}`);
}

test('live R2 signed upload, metadata, download, and deletion', { skip: !r2Enabled }, async () => {
  const adapter = liveR2Adapter();
  const body = Buffer.from(`Sinaloa R2 integration ${crypto.randomUUID()}`);
  const key = `integration-tests/${crypto.randomUUID()}`;
  try {
    const signed = await adapter.createPresignedUpload({ key, contentType: 'text/plain', checksumSha256: checksum(body), size: body.length, expiresInSeconds: 300 });
    const response = await fetch(signed.url, { method: signed.method, headers: signed.headers, body, signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `R2 signed upload returned ${response.status}`);
    const head = await adapter.headObject(key);
    assert.equal(head.size, body.length);
    assert.equal(head.checksumSha256, checksum(body));
    const denied = new S3CompatibleObjectStorageAdapter({
      provider: 'r2', endpoint: process.env.SINALOA_LIVE_R2_ENDPOINT,
      bucket: process.env.SINALOA_LIVE_R2_BUCKET, region: 'auto',
      accessKeyId: process.env.SINALOA_LIVE_R2_ACCESS_KEY_ID,
      secretAccessKey: `invalid-${crypto.randomUUID()}`
    });
    await assert.rejects(() => denied.headObject(key), error => error.code === 'OBJECT_STORAGE_UNAVAILABLE');
    const download = await adapter.createPresignedDownload({ key, expiresInSeconds: 300 });
    const downloaded = await fetch(download.url, { signal: AbortSignal.timeout(15_000) });
    assert.ok(downloaded.ok, `R2 signed download returned ${downloaded.status}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);
  } finally { await adapter.deleteObject(key); }
  assert.equal(await adapter.headObject(key), null);
});

test('live scanner distinguishes harmless content from EICAR and rejects bad credentials', { skip: !scannerEnabled }, async () => {
  const scanner = liveScanner();
  const clean = Buffer.from(`Sinaloa scanner integration ${crypto.randomUUID()}`);
  const cleanResult = await scanner.scan({ body: clean, object: { id: `obj_${crypto.randomUUID()}`, mimeType: 'text/plain', checksumSha256: checksum(clean) } });
  assert.equal(cleanResult.status, 'clean');
  const infectedResult = await scanner.scan({ body: eicar, object: { id: `obj_${crypto.randomUUID()}`, mimeType: 'text/plain', checksumSha256: checksum(eicar) } });
  assert.equal(infectedResult.status, 'infected');
  if (process.env.SINALOA_LIVE_SCANNER_TOKEN) {
    const invalid = liveScanner(`invalid-${crypto.randomUUID()}`);
    await assert.rejects(() => invalid.scan({ body: clean, object: { id: `obj_${crypto.randomUUID()}`, mimeType: 'text/plain', checksumSha256: checksum(clean) } }), error => error.code === 'SCANNER_UNAVAILABLE');
  }
});

test('live R2 and scanner keep files quarantined until clean and reject checksum mismatches', { skip: !r2Enabled || !scannerEnabled }, async () => {
  const adapter = liveR2Adapter();
  const service = new ObjectStorageService({
    adapter,
    metadataStore: new InMemoryMetadataStore(),
    quotaLedger: new InMemoryQuotaLedger({ defaultQuotaBytes: 1_000_000 }),
    scanner: liveScanner(),
    allowedMimeTypes: ['text/plain']
  });
  const createdKeys = [];
  try {
    for (const [body, expected] of [[Buffer.from(`clean ${crypto.randomUUID()}`), 'clean'], [eicar, 'infected']]) {
      const started = await service.beginUpload({ workspaceId: 'integration_tests', filename: `${expected}.txt`, mimeType: 'text/plain', size: body.length, checksumSha256: checksum(body) });
      createdKeys.push(started.object.key);
      await assert.rejects(() => service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
      await upload(adapter, started, body);
      const scanned = await service.scanObject(started.object.id);
      assert.equal(scanned.state, expected);
      if (expected === 'clean') assert.ok((await service.createDownload(started.object.id)).url);
      else await assert.rejects(() => service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
    }
    const expectedBody = Buffer.from('expected payload');
    const wrongBody = Buffer.from('tampered payload');
    const started = await service.beginUpload({ workspaceId: 'integration_tests', filename: 'mismatch.txt', mimeType: 'text/plain', size: wrongBody.length, checksumSha256: checksum(expectedBody) });
    createdKeys.push(started.object.key);
    await upload(adapter, started, wrongBody);
    await assert.rejects(() => service.scanObject(started.object.id), error => error.code === 'CHECKSUM_MISMATCH');
    await assert.rejects(() => service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  } finally { await Promise.all(createdKeys.map(key => adapter.deleteObject(key))); }
});

test('live R2 rejects oversized signed PUT and sealed keys cannot be recreated', { skip: !r2Enabled }, async () => {
  const adapter = liveR2Adapter();
  const body = Buffer.from('size-bound safe upload');
  const key = `integration-tests/${crypto.randomUUID()}`;
  try {
    const signed = await adapter.createPresignedUpload({ key, contentType: 'text/plain', checksumSha256: checksum(body), size: body.length, expiresInSeconds: 300 });
    const oversized = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: Buffer.alloc(body.length + 1), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    assert.ok(!oversized.ok, 'R2 must enforce the signed Content-Length');
    await oversized.body?.cancel();
    assert.equal(await adapter.headObject(key), null);
    const valid = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    assert.ok(valid.ok, `Size-bound upload returned ${valid.status}`);
    await valid.body?.cancel();
    await adapter.deleteObject(key);
    await adapter.sealDeletedObject(key);
    await adapter.sealDeletedObject(key);
    const recreated = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    assert.equal(recreated.status, 412, 'Same-key tombstone must reject the still-live signed PUT');
    await recreated.body?.cancel();
    assert.equal((await adapter.getObject(key)).length, 0);
  } finally { await adapter.deleteObject(key); }
});
