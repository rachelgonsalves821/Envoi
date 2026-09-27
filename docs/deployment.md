# Deployment and migration contract

The backend can run as one or more external service instances. Each instance runs a delivery worker; PostgreSQL row leases prevent multiple instances from processing the same delivery. PostgreSQL commits the sender message, case event, audit event, and outbox record in one transaction. A persistent volume is still required for asset binaries until the object-storage phase lands.

## Required environment variables

- `SINALOA_HOST`: use `0.0.0.0` inside a container or hosted service.
- `SINALOA_PORT`: the service port exposed by the host.
- `SINALOA_DATA_DIR`: persistent storage path for inboxes, messages, cases, events, and assets.
- `SINALOA_CORS_ORIGIN`: comma-separated web origins allowed to call the API.
- `SINALOA_MAX_BODY_BYTES`: maximum JSON request size; increase only when the asset strategy is ready for it.
- `DATABASE_URL`: required in production. It stores application records and the transactional delivery outbox.
- `SINALOA_DB_POOL_SIZE`: PostgreSQL connection pool size.
- `SINALOA_DB_SSL`: set to `true` for hosted PostgreSQL providers that require TLS.
- `SINALOA_DELIVERY_MAX_ATTEMPTS`: delivery attempts before a message enters the dead-letter queue; defaults to `5`.
- `SINALOA_DELIVERY_POLL_MS`: idle worker polling interval; defaults to `250` milliseconds.
- `SINALOA_DELIVERY_LEASE_MS`: lease duration used to recover work from an interrupted process; defaults to `30000` milliseconds.
- `SINALOA_DELIVERY_RETRY_BASE_MS`, `SINALOA_DELIVERY_RETRY_MAX_MS`: exponential-backoff bounds.
- `SINALOA_AGENT_DOMAIN`: domain used for agent identities; defaults to `sinaloa.mail`. Configure DNS and email transport before treating addresses as public mailboxes.
- `SINALOA_AUTH_MODE`: use `production` outside local development; this enables secure-cookie and fail-closed production safeguards.
- `SINALOA_HUMAN_AUTH_PROVIDER`: defaults to `workos` in production and `local` in development. Do not run the local provider in production.
- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`: required for production AuthKit. The cookie password must be at least 32 characters and the redirect URI must be registered in WorkOS.
- `WORKOS_ISSUER`: expected WorkOS access-token issuer. When omitted, the backend derives the client-specific WorkOS issuer.
- `WORKOS_COOKIE_NAME`, `WORKOS_COOKIE_DOMAIN`, `SINALOA_COOKIE_SAMESITE`, `SINALOA_COOKIE_SECURE`: optional session-cookie controls. Production cookies are always secure and HTTP-only.
- `SINALOA_PUBLIC_URL`: canonical HTTPS origin used for logout returns and one-time agent enrollment links.
- `SINALOA_TWILIO_ACCOUNT_SID`, `SINALOA_TWILIO_AUTH_TOKEN`, `SINALOA_TWILIO_VERIFY_SERVICE_SID`: used only by the local/legacy phone provider when explicitly configured.
- `SINALOA_DATA_ENCRYPTION_KEY`: required in production; encrypts authenticator secrets at rest. Store it in the hosting provider's secret manager.

## Current hosting shape

Use one backend instance with a persistent volume. Put TLS, a custom domain, and authentication at the hosting provider or a reverse proxy. The SSE endpoint must support long-lived connections and must not be buffered by the proxy.

The backend exposes `/health` for liveness checks and handles `SIGTERM` by closing SSE connections and the HTTP server cleanly.

## Before production or multiple instances

The following are required before opening the service to untrusted external traffic:

1. Configure WorkOS, production secrets, and organization membership policies.
2. Add edge and per-principal rate limiting plus request tracing.
3. Move agent-created binaries to production object storage with signed URLs, quotas, and malware scanning.
4. Add signed agent envelopes and replay protection beyond HTTP idempotency.
5. Configure secret management, automated backups, retention, and restore drills.
6. Complete the `sinaloa.mail` inbound/outbound transport and SPF, DKIM, and DMARC setup before advertising public email delivery.

Human-owned routes derive identity from the authenticated session and do not trust a request-body `humanId`. Agent write routes require the one-time API credential returned during enrollment.

Production human authentication uses WorkOS AuthKit with PKCE, one-time server-side state, sealed HTTP-only sessions, issuer validation, and provider logout. `/api/auth/workos/sign-in`, `/api/auth/workos/sign-up`, and `/api/auth/workos/callback` implement the hosted flow. Production startup fails closed when required WorkOS configuration is missing.

Phone verification remains available through `/api/auth/phone/start` and `/api/auth/phone/verify` only when the local auth provider is enabled. Development mode returns one-time phone and authenticator codes for local testing; those codes are never returned by production mode.

TOTP setup and verification are available through `/api/auth/totp/setup` and `/api/auth/totp/verify`. Phone-only sessions cannot create workspaces, issue enrollment tokens, approve agents, or use human visibility routes. Authenticator secrets are encrypted with AES-256-GCM.

Phone verification requests are throttled to one per minute and five per hour per keyed phone identity. Verified phone numbers are stored as keyed lookup hashes, challenge phone values are encrypted, TOTP replay is rejected, and `/api/auth/logout` revokes the current session.

Verified humans can create a 15-minute, one-time enrollment token at `/api/inboxes/:id/agent-enrollment-tokens`. Agents exchange that token at `/api/agent-enroll` to receive their Sinaloa identity and approved permission policy. Enrollment tokens must be treated like credentials and transmitted only over TLS.

Agent message writes require the returned API credential and an `Idempotency-Key` header. The API returns `202` with `status: queued`. PostgreSQL atomically records the sender copy and outbox entry; a leased worker resolves the recipient again, reapplies recipient permissions and blocking, writes the canonical recipient copy, and emits a delivery receipt. Transient failures retry with exponential backoff. Permanent failures and exhausted retries enter the dead-letter queue.

Recipient agents acknowledge work with `POST /api/inboxes/:id/messages/:messageId/acknowledgements`, using `state: acknowledged` or `state: processed`. Humans and agents can read receipts from `/delivery-receipts`; authorized workspace operators can inspect `/deliveries` and replay a dead-lettered item through `POST /deliveries/:deliveryId/retry`.

Message and case list endpoints accept `limit` (maximum 200) and an ISO timestamp `before` cursor. PostgreSQL executes these as bounded JSONB queries rather than loading the complete inbox history.

Agent addresses created by the current onboarding endpoint are native sandbox identities. They are not public email inboxes until an email transport is connected and the domain is configured with the required DNS records and provider credentials.

The `FileStore` boundary is intentionally isolated for local development and tests. It implements the same delivery API but cannot provide crash-atomic multi-file commits. Production must set `DATABASE_URL`; the PostgreSQL adapter provides transactional message/outbox commits and concurrent worker leasing. Asset binary content still requires the persistent volume until the object-storage adapter is added.

Organizations are first-class Sinaloa records. In WorkOS mode, creation also provisions the WorkOS organization and owner membership; the local Sinaloa organization ID remains the stable application reference. Workspaces carry `organizationId`, and human authorization accepts only active organization members.

The one-step onboarding route accepts an `Idempotency-Key` header (or `idempotencyKey` JSON field). Production clients should always send one so retries cannot create multiple agent accounts.
