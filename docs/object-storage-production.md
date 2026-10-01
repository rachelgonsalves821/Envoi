# Production object storage

Sinaloa stores binaries in a private Cloudflare R2 bucket through its S3 API. Application metadata, quota reservations, and malware scan jobs remain in PostgreSQL. No production path depends on a persistent local filesystem.

## R2 contract

Use the S3 API endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, a private bucket, and region `auto`. The adapter also accepts Cloudflare's `us-east-1` region alias. Custom domains and endpoint paths are rejected for explicit `r2` configuration because presigned URLs only work on the S3 API domain.

Uploads are single-object `PUT` requests with short-lived SigV4 query authentication. Application upload signatures bind the reserved `Content-Length`, `Content-Type`, `If-None-Match: *`, and `x-amz-meta-sinaloa-sha256`. Browser JavaScript receives no `Content-Length` header to set: Fetch generates it from the supplied bytes. Node clients likewise send the actual body length. Changing that length invalidates the signature; hosted acceptance must prove this with both a browser upload and an oversized R2 PUT. R2 does not support SHA-256 as a full-object `PutObject` checksum, so Sinaloa stores the expected SHA-256 as signed immutable metadata, verifies size and metadata with `HEAD`, then downloads and re-hashes the bytes before malware scanning. A checksum mismatch is non-retryable and is dead-lettered without invoking the scanner. Downloads remain unavailable unless metadata state is exactly `clean`.

Browser CORS must allow the application origins, methods `PUT`, `GET`, and `HEAD`, and request headers `Content-Type`, `If-None-Match`, and `x-amz-meta-sinaloa-sha256`. Do not configure public bucket access or a public development URL.

## Abandoned upload cleanup and quota

Every new application upload stores its signed-URL expiry, cleanup deadline and verification timestamp in PostgreSQL metadata. Its quota reservation has a null database expiry and remains held until verification commits it or safe cleanup releases it. Generic quota expiry never releases these holds. Upload URLs last 15 minutes by default; cleanup waits another 15 minutes to allow ordinary in-flight transfers to finish. The grace period alone is not a guarantee against a delayed PUT.

An immutable HEAD size/checksum mismatch changes the metadata to `upload-cleanup-pending`; completion, scanning and download then fail closed. Missing upload bytes remain retryable until the cleanup deadline. Aborted uploads also remain tracked because the returned signed capability is still live. The server calls `reapExpiredUploads({ limit: 25 })` at startup and on its quota-reaper interval. PostgreSQL selects at most that many due records, and a per-object transaction serializes verification against cleanup. Failed deletion or key sealing retains quota, persists a sanitized pending outcome, and retries after 1 minute.

Cleanup deletes the user bytes, then conditionally writes a **zero-byte private tombstone at the same object key** before releasing quota. `If-None-Match: *` ensures a delayed signed PUT cannot recreate the object after release. If a late upload wins the deletion-to-tombstone race, cleanup defers and keeps the hold. Successful cleanup preserves terminal `deleted` application metadata. Tombstones remain indefinitely; do not delete them or apply a lifecycle policy that removes them without proving the provider's maximum in-flight request lifetime. They contain no uploaded user bytes and are never exposed through the application. Custom storage adapters must implement `sealDeletedObject(key)` and explicitly confirm sealing before cleanup can release holds.

A successful verification also enqueues durable scan work in the same metadata transaction, so a restart between verification and inline scanning leaves recoverable work. Verified uploads are excluded from abandoned-upload cleanup; their scan-job retention policy below applies instead. Existing legacy quarantine records lack the new timestamps, so their cleanup deadline uses creation plus 30 minutes. Before deleting one, the service checks for an existing durable scan job or committed quota: either proves the upload was verified, restores its verification timestamp, and enqueues any missing durable scan work. These files are preserved.

Upload-start idempotency replays the original signed capability. After its expiry or terminal cleanup, start a new logical upload with a new idempotency key; the current agent file workflow does not automatically renew that reservation. Treat a long-interrupted file exchange as an operator recovery step and include it in hosted acceptance.

## Durable scan lifecycle

Construct `PostgresMalwareScanJobStore` with the existing `PostgresStore` (or its pool) and pass it as `scanJobStore` to `ObjectStorageService`. This stores jobs under `object-storage/scan-jobs/` in the existing `sinaloa_documents` table and claims them with PostgreSQL row locks and expiring leases. No additional table is required.

The service's existing `scanObject(id)` contract remains synchronous for the request that created the job. With a durable store configured, the job is persisted before scanning. A worker must also call `processNextScan(workerId)` until it returns `null`; this recovers retryable failures and jobs abandoned after a process crash. A separate scheduled worker must call `reapScanRetention(workerId)` until it returns `null`.

Default policy:

- Scanner and transport failures retry up to 5 attempts with jittered exponential backoff, starting at 5 seconds and capped at 15 minutes.
- Job leases last 60 seconds. Expired leases can be reclaimed by another worker.
- Invalid scan results, missing objects, and checksum failures dead-letter immediately.
- Infected binaries are retained, locked from download, for 30 days and are then deleted.
- Dead-lettered binaries are retained, locked from download, for 7 days and are then deleted.
- Completed clean job records are retained for 90 days; the clean binary remains available.
- Retention deletion failures retry after 1 hour. Object deletion is idempotent.

Override these durations through the `scanLifecycle` constructor options only after compliance and incident-response review. Metadata remains after binary retention deletion with state `deleted` and the previous scan outcome embedded for audit.

## Required runtime configuration

The existing server integration must provide:

- `SINALOA_OBJECT_STORAGE_PROVIDER=s3`
- `SINALOA_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `SINALOA_S3_BUCKET=<private bucket>`
- `SINALOA_S3_REGION=auto`
- `SINALOA_S3_ACCESS_KEY_ID` and `SINALOA_S3_SECRET_ACCESS_KEY` from a bucket-scoped R2 API token
- Optional `SINALOA_S3_SESSION_TOKEN` when temporary credentials are used
- `SINALOA_MALWARE_SCANNER_URL` over HTTPS and required production secret `SINALOA_MALWARE_SCANNER_TOKEN`
- `DATABASE_URL` for durable quotas, metadata, and scan jobs
- Optional `SINALOA_SCAN_WORKER_INTERVAL_MS` (default `1000`) for queued scans, retries, and expired leases
- Optional `SINALOA_SCAN_RETENTION_INTERVAL_MS` (default `60000`) for clean-job purging and infected/dead-letter binary retention

The background scan workers are enabled only when `DATABASE_URL` is configured. The R2 token needs object read/write permission on only the configured bucket. The scanner credential must authorize the scan endpoint and its same-origin health endpoint. `GET /health` (or `SINALOA_MALWARE_SCANNER_HEALTH_URL`) must return HTTP 200 with JSON `{"ready":true}`; redirects and other responses fail readiness. Neither secret may be exposed to clients; only presigned bearer URLs leave the server.

## Credential-gated verification

Live tests are opt-in and skipped by default:

```powershell
$env:SINALOA_RUN_LIVE_R2_TESTS='1'
$env:SINALOA_LIVE_R2_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com'
$env:SINALOA_LIVE_R2_BUCKET='<private bucket>'
$env:SINALOA_LIVE_R2_ACCESS_KEY_ID='<access key>'
$env:SINALOA_LIVE_R2_SECRET_ACCESS_KEY='<secret key>'

$env:SINALOA_RUN_LIVE_SCANNER_TESTS='1'
$env:SINALOA_LIVE_SCANNER_URL='https://scanner.example/scan'
$env:SINALOA_LIVE_SCANNER_TOKEN='<scanner token>'

node --test test/object-storage-live.test.js
```

The R2 tests write unique objects, verify signed upload/HEAD/download, reject oversized body lengths, and prove a still-live signed PUT cannot replace a same-key tombstone. Test keys are deleted in a `finally` block; this explicit cleanup is safe for synthetic test data and must not be copied to application tombstone maintenance. Use a dedicated integration-test bucket rather than production data.
The scanner test sends harmless text and the EICAR test signature to confirm distinct verdicts. When a scanner token is configured, it also checks that an invalid token is rejected. With both services configured, a combined test verifies quarantine, clean download, infected download denial, and immutable checksum rejection. Tests are skipped unless the matching `SINALOA_RUN_LIVE_*_TESTS` flag is set. Run them only against a dedicated test bucket and scanner endpoint; do not use production objects.
