# Deployment and migration contract

Current closed-beta operations use the [launch runbook](closed-beta-launch-runbook.md). The merged implementation baseline is main at `fc2e1d8b72280789e365e9f8b8e399717933ccb6`; hosted release acceptance must be recorded against the actual candidate SHA. This contract describes implementation behavior, not completed live acceptance.

The closed beta runs one Cloudflare application Container behind its Worker. PostgreSQL row leases fence delivery processing, but local rate counters and event fanout do not establish multi-instance readiness. Keep max_instances at 1 until shared enforcement and fanout have been implemented and accepted. PostgreSQL commits the sender message, case event, audit event, and outbox record in one transaction. Production assets use a private S3-compatible bucket; PostgreSQL owns atomic per-workspace quota reservations and immutable metadata.

## Required environment variables

- `SINALOA_HOST`: use `0.0.0.0` inside a container or hosted service.
- `SINALOA_PORT`: the service port exposed by the host.
- `SINALOA_DATA_DIR`: persistent storage path for inboxes, messages, cases, events, and assets.
- `SINALOA_CORS_ORIGIN`: comma-separated web origins allowed to call the API.
- `SINALOA_MAX_BODY_BYTES`: maximum JSON request size; increase only when the asset strategy is ready for it.
- `DATABASE_URL`: required in production. It stores application records and the transactional delivery outbox.
- `SINALOA_DB_POOL_SIZE`: PostgreSQL connection pool size.
- `SINALOA_DB_SSL_MODE`: use `verify-full` in production. Certificate verification cannot be disabled in production.
- `SINALOA_DB_CA`: optional PEM CA chain supplied as a runtime secret when the provider is not trusted by the base image.
- `SINALOA_DB_CONNECT_TIMEOUT_MS`, `SINALOA_DB_STATEMENT_TIMEOUT_MS`, `SINALOA_DB_QUERY_TIMEOUT_MS`: bounded positive connection and query timeouts.
- `SINALOA_POLICY_ACTIVE_KEY_ID`: key ID used to sign new policy decisions.
- `SINALOA_POLICY_SIGNING_KEYS`: JSON keyring supplied as a runtime secret. Keep the previous key during rotation until all unexpired decisions and retained audit records no longer require it.
- `SINALOA_POLICY_DECISION_TTL_SECONDS`, `SINALOA_POLICY_EXECUTE_AT_TOLERANCE_SECONDS`, `SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR`: strict authority bounds; malformed values prevent production startup.
- `SINALOA_DELIVERY_MAX_ATTEMPTS`: delivery attempts before a message enters the dead-letter queue; defaults to `5`.
- `SINALOA_DELIVERY_POLL_MS`: idle worker polling interval; defaults to `250` milliseconds.
- `SINALOA_DELIVERY_LEASE_MS`: lease duration used to recover work from an interrupted process; defaults to `30000` milliseconds.
- `SINALOA_DELIVERY_RETRY_BASE_MS`, `SINALOA_DELIVERY_RETRY_MAX_MS`: exponential-backoff bounds.
- `SINALOA_AGENT_DOMAIN`: native platform-address domain. Local development defaults to `sinaloa.mail`; production startup requires a registrable domain you control, such as `agents.example.com`. Native delivery still uses the Sinaloa protocol, not SMTP.
- `SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS`: lifetime of an agent workload access token; defaults to `900` seconds and cannot be less than `60`.
- `SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS`: maximum lifetime of an agent credential family; defaults to `30` days.
- `SINALOA_AUTH_MODE`: use `production` outside local development; this enables secure-cookie and fail-closed production safeguards.
- `SINALOA_HUMAN_AUTH_PROVIDER`: defaults to `workos` in production and `local` in development. Do not run the local provider in production.
- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`: required for production AuthKit. The cookie password must be at least 32 characters and the redirect URI must be registered in WorkOS.
- `WORKOS_ISSUER`: expected WorkOS access-token issuer. When omitted, the backend derives the client-specific WorkOS issuer.
- `WORKOS_COOKIE_NAME`, `WORKOS_COOKIE_DOMAIN`, `SINALOA_COOKIE_SAMESITE`, `SINALOA_COOKIE_SECURE`: optional session-cookie controls. Production cookies are always secure and HTTP-only.
- `SINALOA_PUBLIC_URL`: canonical HTTPS origin used for logout returns and one-time agent enrollment links.
- `SINALOA_BETA_INVITED_EMAILS`: exact comma-separated email allowlist required for production human admission.
- `SINALOA_DATA_ENCRYPTION_KEY`: required in production; encrypts authenticator secrets at rest. Store it in the hosting provider's secret manager.
- `SINALOA_ENABLE_EXTERNAL_EMAIL`: defaults to `false`. Set it to `true` only when agents must send public email to humans and every provider/DNS requirement below is complete.
- `SINALOA_EMAIL_PROVIDER`: set to `resend` when public transport is enabled; the default is `disabled`.
- `SINALOA_PUBLIC_EMAIL_DOMAIN`: a registrable domain or subdomain verified with the provider, such as `agents.example.com`. It is deliberately separate from the internal `sinaloa.mail` identity.
- `SINALOA_EMAIL_DOMAIN_VERIFIED`: set to `true` only after provider DNS verification succeeds. The application refuses to send otherwise.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`: provider secret and signed-webhook secret. Register `POST /api/email-webhooks/resend` for inbound and delivery events.
- `SINALOA_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT`, `SINALOA_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT`: defense-in-depth caps for one-to-one public email. Use an edge/distributed limiter as well when running multiple instances.
- `SINALOA_ENABLE_CALENDAR_WRITES`, `SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS`: both default to `false`; enable only after the corresponding policy and provider controls are verified.
- `SINALOA_CALENDAR_OAUTH_TIMEOUT_MS`: bounded timeout for calendar token exchanges. Calendar authorization uses one-time state plus PKCE; enabling writes in production requires one complete Google or Microsoft OAuth configuration with an HTTPS callback on the public Sinaloa origin.
- `SINALOA_REQUEST_TIMEOUT_MS`, `SINALOA_MAX_SSE_PER_PRINCIPAL`: request and concurrent-stream resource bounds.
- `SINALOA_OBJECT_STORAGE_PROVIDER`: set to `s3` in production; `local` is for development.
- `SINALOA_S3_ENDPOINT`, `SINALOA_S3_BUCKET`, `SINALOA_S3_REGION`, `SINALOA_S3_ACCESS_KEY_ID`, `SINALOA_S3_SECRET_ACCESS_KEY`, `SINALOA_S3_SESSION_TOKEN`: private S3-compatible storage settings. Public buckets and public base URLs are rejected.
- `SINALOA_OBJECT_MAX_BYTES`, `SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES`, `SINALOA_OBJECT_ALLOWED_MIME_TYPES`: immutable upload and quota policy.
- `SINALOA_MALWARE_SCANNER_URL`, `SINALOA_MALWARE_SCANNER_TOKEN`: HTTPS scanner endpoint. Downloads remain locked unless a scan returns `clean`; no scanner means fail closed.
- `SINALOA_OBJECT_QUOTA_REAPER_INTERVAL_MS`: interval for reclaiming abandoned upload reservations; defaults to five minutes.
- `SINALOA_S3_REQUEST_TIMEOUT_MS`: bounded timeout for private object-storage operations; defaults to 30 seconds.
- `SINALOA_SCAN_WORKER_INTERVAL_MS`, `SINALOA_SCAN_RETENTION_INTERVAL_MS`, `SINALOA_SCAN_MAX_ATTEMPTS`, `SINALOA_SCAN_LEASE_MS`, `SINALOA_SCAN_RETRY_BASE_MS`, `SINALOA_SCAN_RETRY_MAX_MS`: durable malware-scan worker, lease, retry, and dead-letter controls.
- `SINALOA_SCAN_INFECTED_RETENTION_MS`, `SINALOA_SCAN_DEAD_LETTER_RETENTION_MS`, `SINALOA_SCAN_COMPLETED_JOB_RETENTION_MS`, `SINALOA_SCAN_RETENTION_RETRY_MS`: quarantine/dead-letter retention and cleanup retry controls.

## Current hosting shape

Use one beta backend Container behind TLS with PostgreSQL and private S3-compatible object storage. Promote an exact recorded candidate to staging, then beta, using the explicit environment commands in the launch runbook. The beta application is custom-domain-only; run its smoke after binding beta.sinaloa-inbox.com. The SSE endpoint must support long-lived connections and must not be buffered by the proxy.

The backend exposes `/health` for liveness and `/ready` for dependency readiness. In production, readiness fails with HTTP `503` if PostgreSQL, private object storage, the malware scanner, or an enabled public-email transport is unavailable. Checks are bounded by `SINALOA_READINESS_TIMEOUT_MS` and return only sanitized reasons. It handles `SIGTERM` by stopping quota cleanup and delivery workers, closing SSE connections, and closing the HTTP server cleanly.

Run `npm run db:migrate` as a release job before switching traffic. The same checksum-verified runner also executes safely during application startup under a PostgreSQL advisory lock, so concurrent instances cannot race schema changes. Applied migrations are recorded in `sinaloa_schema_migrations`; changing an already-applied SQL file fails startup. The production image includes `db/`, runs as the unprivileged `node` user, installs from `package-lock.json`, and uses `/ready` for its container health check.

## Hosted acceptance and later multi-instance gates

The following are required before opening the service to untrusted external traffic:

1. Configure isolated WorkOS, exact-email beta admission, encrypted runtime secrets and current organization membership/management policies.
2. Prove the single-instance request, stream and credential-abuse bounds for the reviewed candidate. Add shared rate enforcement, event fanout and request tracing before multiple instances; configured local limits alone do not prove the rotating-credential stress gate.
3. Provision the private bucket and scanner, then verify upload, quarantine, scan, and signed-download behavior in the production region.
4. Configure secret management, automated backups, retention, and restore drills.
5. Keep optional external email disabled for initial beta. Before separately enabling `use_email_transport`, verify a controlled public email domain, provider SPF/DKIM and DMARC, and inbound and bounce/complaint webhooks.

Human-owned routes derive identity from the authenticated session and do not trust a request-body `humanId`. Agent write routes require the one-time API credential returned during enrollment.

Production human authentication uses WorkOS AuthKit with PKCE, one-time server-side state, sealed HTTP-only sessions, issuer validation, and provider logout. `/api/auth/workos/sign-in`, `/api/auth/workos/sign-up`, and `/api/auth/workos/callback` implement the hosted flow. Production startup fails closed when required WorkOS configuration is missing.

The approved invite-only beta has WorkOS MFA Off and self-service signup disabled. Hosted sessions expose assurance: provider; this is provider authentication, not evidence of a second factor. WorkOSAuthService requires an authenticated sealed provider session, an email-verified user and an exact entry in SINALOA_BETA_INVITED_EMAILS. Protected organization actions also require current active membership and management authority. Hosted getHuman does not impose the local requireMfa option. The local provider uses `/api/auth/phone/start` and `/api/auth/phone/verify` only in development; those hosted routes return 404. Development one-time codes and local TOTP assurance must not be used as hosted acceptance evidence. Twilio Verify is not a beta prerequisite. A future MFA or SSO policy change needs a reviewed provider and application contract.

Local-development TOTP setup and verification are available through `/api/auth/totp/setup` and `/api/auth/totp/verify`. Hosted WorkOS sessions cannot use those local routes; the current provider policy has MFA Off. Local authenticator secrets are encrypted with AES-256-GCM.

Local development phone verification requests are throttled to one per minute and five per hour per keyed phone identity. Local TOTP replay is rejected; `/api/auth/logout` clears the WorkOS cookie and redirects through provider logout in hosted mode.

Verified humans can create a 15-minute, one-time enrollment token at `/api/inboxes/:id/agent-enrollment-tokens`. Agents exchange that token at `/api/agent-enroll` to receive their Sinaloa identity and approved permission policy. Enrollment tokens must be treated like credentials and transmitted only over TLS.

Agent message writes require the returned short-lived workload access token, `recipientEmail`, and an `Idempotency-Key` header. Exact verified platform addresses are resolved without a search API. An exact active native address permits immediate direct delivery without a first-contact invitation or human approval. Server authorization, active identity, permissions, native blocking and pause/revocation are still enforced; legacy invitation state is not the admission mechanism for native messaging. PostgreSQL atomically records queued sender copies and outbox entries; a leased worker resolves permissions, approval, and blocking again before delivery. Transient failures retry with exponential backoff. Permanent failures and exhausted retries enter the dead-letter queue. Refresh tokens rotate on every use, and revoking their credential family immediately invalidates every access and refresh token in that family.

Recipient agents acknowledge work with `POST /api/inboxes/:id/messages/:messageId/acknowledgements`, using `state: acknowledged` or `state: processed`. Humans and agents can read receipts from `/delivery-receipts`; authorized workspace operators can inspect `/deliveries` and replay a dead-lettered item through `POST /deliveries/:deliveryId/retry`.

Message and case list endpoints accept `limit` (maximum 200) and an ISO timestamp `before` cursor. PostgreSQL executes these as bounded JSONB queries rather than loading the complete inbox history.

Agent event subscriptions emit durable SSE `id` values. Reconnect with `Last-Event-ID` or `?cursor=` to replay missed events. Clients that cannot hold an SSE connection can call `/api/inboxes/:id/events/delta?cursor=...&limit=...` and persist the returned `nextCursor`.

Local agent addresses under `sinaloa.mail` are native sandbox identities; hosted environments configure a real platform-address domain. Public SMTP remains independent and disabled unless `SINALOA_ENABLE_EXTERNAL_EMAIL=true`. When ready, each agent also receives `slug@SINALOA_PUBLIC_EMAIL_DOMAIN`. Humans approve external contacts before an agent can send. `POST /api/inboxes/:id/external-emails` queues an idempotent provider send through the same durable outbox. Signed provider webhooks update delivery receipts; only replies sent to generated reply aliases route into the supervised case. Unknown/direct inbound mail and attachments are quarantined and never exposed to an agent.

The `FileStore` boundary is intentionally isolated for local development and tests. It implements the same delivery and quota APIs but cannot provide crash-atomic multi-file commits. Production must set `DATABASE_URL`; the PostgreSQL adapter provides transactional message/outbox commits, concurrent worker leasing, monotonic event cursors, and row-locked quota reservations. Asset binaries use signed URLs and never need a shared application volume in S3 mode.

## Public email DNS

Do not attempt to publish `sinaloa.mail`: `.mail` is not present in the IANA root zone. Use a domain you control, preferably a dedicated subdomain such as `agents.yourdomain.com`. Add the exact SPF, DKIM, and inbound MX records issued by the provider. Add DMARC at `_dmarc.<public-domain>` in monitoring mode first, review aggregate reports, then move to quarantine/reject once every legitimate sender aligns. Provider acceptance is recorded as `accepted`; only a signed `email.delivered` webhook becomes `delivered`. Bounces, complaints, failures, and suppressions remain distinct receipts, and complaints/suppressions automatically block the contact.

## Object storage lifecycle

Agents request a signed upload at `POST /api/inboxes/:id/asset-uploads`. The server atomically reserves workspace quota and returns a checksum-bound URL. After upload, `POST /api/inboxes/:id/assets/:assetId/complete` verifies size and SHA-256, commits quota, and invokes the scanner. Objects remain `quarantine`, `infected`, or `error` until a clean scan; only `clean` objects receive a signed download URL from `GET /api/inboxes/:id/assets/:assetId/download`. Direct binary uploads are disabled in S3 mode.

Organizations are first-class Sinaloa records. In WorkOS mode, creation also provisions the WorkOS organization and owner membership; the local Sinaloa organization ID remains the stable application reference. Workspaces carry `organizationId`, and human authorization accepts only active organization members.

The one-step onboarding route accepts an `Idempotency-Key` header (or `idempotencyKey` JSON field). Production clients should always send one so retries cannot create multiple agent accounts.
