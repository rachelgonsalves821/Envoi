# Production object storage

Sinaloa stores binaries in a private Cloudflare R2 bucket through its S3 API. Application metadata, quota reservations, and malware scan jobs remain in PostgreSQL. No production path depends on a persistent local filesystem.

## R2 contract

Use the S3 API endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, a private bucket, and region `auto`. The adapter also accepts Cloudflare's `us-east-1` region alias. Custom domains and endpoint paths are rejected for explicit `r2` configuration because presigned URLs only work on the S3 API domain.

Uploads are single-object `PUT` requests with short-lived SigV4 query authentication. The signature binds `Content-Type`, `If-None-Match: *`, and `x-amz-meta-sinaloa-sha256`. R2 does not support SHA-256 as a full-object `PutObject` checksum, so Sinaloa stores the expected SHA-256 as signed immutable metadata, verifies size and metadata with `HEAD`, then downloads and re-hashes the bytes before malware scanning. A checksum mismatch is non-retryable and is dead-lettered without invoking the scanner. Downloads remain unavailable unless metadata state is exactly `clean`.

Browser CORS must allow the application origins, methods `PUT`, `GET`, and `HEAD`, and request headers `Content-Type`, `If-None-Match`, and `x-amz-meta-sinaloa-sha256`. Do not configure public bucket access or a public development URL.

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
- `SINALOA_MALWARE_SCANNER_URL` over HTTPS and optional `SINALOA_MALWARE_SCANNER_TOKEN`
- `DATABASE_URL` for durable quotas, metadata, and scan jobs
- Optional `SINALOA_SCAN_WORKER_INTERVAL_MS` (default `1000`) for queued scans, retries, and expired leases
- Optional `SINALOA_SCAN_RETENTION_INTERVAL_MS` (default `60000`) for clean-job purging and infected/dead-letter binary retention

The background scan workers are enabled only when `DATABASE_URL` is configured. The R2 token needs object read/write permission on only the configured bucket. The scanner credential must authorize only the scan endpoint. Neither secret may be exposed to clients; only presigned bearer URLs leave the server.

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
$env:SINALOA_LIVE_SCANNER_TOKEN='<optional token>'

node --test test/object-storage-live.test.js
```

The R2 test writes a unique object, verifies signed upload/HEAD/download, and deletes it in a `finally` block. Use a dedicated integration-test bucket rather than production data.
