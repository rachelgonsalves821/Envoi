# Product Roadmap and Launch Readiness Audit

## Status

The current build is a strong prototype and has several production-grade primitives: MFA-backed human access, short-lived agent credentials with refresh rotation, an idempotent delivery outbox, a protocol schema and SDKs, a PostgreSQL-backed queue, and an early object-storage boundary. It is **not launch-ready** for customer data or agent actions with material consequences.

This audit covers the backend, frontend, configuration, persistence, CI, and the uncommitted object/email work present on September 27, 2026. It does not certify any external provider, DNS configuration, hosted database, or deployed infrastructure.

## Verification Performed

| Check | Result |
| --- | --- |
| `npm test` | 22 passed; 1 PostgreSQL integration test skipped because `DATABASE_URL` was not set |
| `npm run test:frontend` | 19 passed |
| `npm run build` | passed |
| Production deployment exercise | not performed |
| Real PostgreSQL, S3, scanner, email, calendar, and WorkOS integration tests | not performed |

## Launch Blockers (P0)

### 1. Unify all file handling behind quarantined object storage

The legacy `POST /api/inboxes/:id/assets` route still accepts base64 content, writes it directly under the local data directory, and serves it back inline. It bypasses object metadata immutability, checksum verification, quota accounting, malware scanning, tenant-safe presigned URLs, and the clean-only download gate. A caller may also choose an unsafe MIME type for an inline response, creating a stored-XSS path against the same origin that currently stores human bearer tokens in `localStorage`.

**Exit criteria:** remove or disable the legacy binary route in production; accept assets only through the object-storage flow; force safe download disposition/content types; scan asynchronously; and migrate existing metadata and binaries with an auditable migration.

### 2. Finish object-storage operations, not only the API boundary

The current PostgreSQL quota reservation uses row locking and is a correct basis for multi-instance atomic reservations. However, abandoned presigned uploads leave quota reservations indefinitely, and the local-file implementation is only safe for one process. The scanner is fail-closed by default, but there is no deployed scanner, queue, reservation reaper, object retention process, incident workflow, S3 conformance test, or live PostgreSQL quota test.

**Exit criteria:** production mode requires PostgreSQL plus private S3-compatible storage; reservations expire and are reclaimed; scanner outcomes are durable; infected/error objects are retained or deleted under a defined policy; scanner and S3 integration tests run in CI; and upload/download audit events are queryable.

### 3. Replace self-reported policy decisions with server-enforced policy

Case policy evaluation currently derives `needsHuman` from agent-supplied `outOfPolicyFlags` and maps permissions from action-name prefixes. An agent can omit a flag or choose a loosely classified action name, so this is not a trustworthy authorization engine for payments, commitments, data sharing, or calendar actions.

**Exit criteria:** define versioned workspace policies and server-side evaluators; bind approvals to exact action payloads, counterparties, amount/time limits, and expiry; require re-evaluation immediately before execution; and preserve a tamper-evident decision record.

### 4. Make production configuration fail closed

The server can choose file storage when `DATABASE_URL` is absent, and environment defaults retain development-oriented identities and storage. The agent domain `sinaloa.mail` is internal only because `.mail` is not publicly delegated. Secrets are supplied directly by environment variables, and there is no startup readiness gate covering all production dependencies.

**Exit criteria:** a production config validator rejects file storage, development encryption keys, unverified mail domains, absent scanner/S3/WorkOS settings, wildcard CORS, and unsafe cookie settings; secrets come from a managed secret store with rotation; and readiness validates required dependencies without exposing secrets.

### 5. Close browser and API security gaps

The web client stores a human bearer token in `localStorage`; the server lacks an explicit Content Security Policy, HSTS, CSRF protection for cookie-authenticated flows, and comprehensive rate/abuse limits. Authenticated write endpoints, webhook ingestion, uploads, and SSE connections need intentional resource limits and security tests.

**Exit criteria:** move human sessions to secure, HttpOnly, SameSite cookies or a BFF session; ship a restrictive CSP/HSTS/Permissions Policy; add CSRF protection for cookie writes; rate-limit by principal and IP; set endpoint-specific payload/time/concurrency limits; and complete authenticated XSS/CSRF/IDOR test coverage.

### 6. Prove tenancy, recovery, and schema management

Tenant isolation is primarily encoded in document paths, not enforced by database row-level security. PostgreSQL schema creation occurs in application startup while the checked-in SQL migration does not represent all current tables. There is no tested backup/restore, point-in-time recovery, retention, deletion, or disaster-recovery process.

**Exit criteria:** use reviewed migrations and a migration runner; enforce tenant boundaries in data access and preferably database RLS; test cross-tenant authorization; automate encrypted backups/PITR and a restore drill; and define retention, export, deletion, and legal-hold behavior.

## Closed Beta: Dual Email Transport

The beta supports two intentionally separate transports:

1. **Native platform email** gives every active Sinaloa agent a verified platform address. Agents exchange an address out of band; there is no global agent search. A first message creates a pending contact and conversation invitation. Approval opens a durable internal conversation where the existing protocol, outbox, agent sandbox, human-readable projection, receipts, and blocking controls apply.
2. **Public SMTP email** lets an active agent send a transactional one-to-one message to an approved human or external contact. It uses a real, registrable sending domain and signed provider webhooks. Replies addressed to a per-conversation alias re-enter the same supervised conversation; unknown inbound messages remain quarantined or pending and never reach an agent automatically.

Humans remain observers and approvers. They do not compose agent messages. For both transports, agent identity is taken from its credential and provisioned address, never from a caller-supplied `from` field.

### Beta transport exit criteria

- A configurable, registrable domain is provisioned; `sinaloa.mail` remains an internal development identity only.
- Native routing accepts `recipientEmail`, resolves only active verified platform addresses, does not expose directory search/enumeration, creates pending invitations, and stops immediately on block or credential revocation.
- Public SMTP is disabled by default and enabled only by `SINALOA_ENABLE_EXTERNAL_EMAIL=true`; enabling it requires a verified provider domain, SPF/DKIM/DMARC, provider credentials, signed webhook secret, HTTPS, and readiness checks.
- Public sends are limited to active agents with `use_email_transport`, approved outbound contacts, one-to-one transactional content, idempotency, per-agent/per-recipient limits, bounce/complaint suppression, and an auditable delivery receipt.
- Inbound replies are signature-verified, mapped only through a reply alias, replay-safe, size-limited, and stored in the originating conversation. Attachments remain disabled until scanner-gated object storage is deployed.
- The human UI distinguishes platform and public addresses, displays invitation/contact state, delivery/bounce/reply state, and never presents a disabled capability as available.

## Product-Critical Work (P1)

### Agent interoperability and trust

- Publish Agent Cards and an A2A-compatible discovery/authentication profile.
- Bind protocol messages to verifiable workload identity, signatures, replay windows, and capability scopes.
- Add external-counterparty verification, contact lifecycle, reputation/abuse controls, and clear human review of unknown agents.
- Version the protocol and SDK compatibility policy; add contract tests across TypeScript and Python SDKs.

### Email and calendar delivery

- Expand the beta public-email transport beyond approved one-to-one contacts only after provider reputation, inbound attachment handling, suppression workflows, and outage runbooks are exercised.
- Keep native/internal identities distinct from public email addresses in every UI and API response.
- Complete calendar operations beyond OAuth connection: token refresh, least-privilege scopes, availability reads, booking idempotency, cancellation, audit evidence, and revoked-consent handling.

### Reliability and operations

- Add OpenTelemetry traces, structured logs, metrics, dashboards, alerts, and correlation from API request through outbox, provider, and receipt.
- Define queue capacity, worker autoscaling, dead-letter operational playbooks, and periodic reconciliation with providers.
- Replace broad JSON-document listing with indexed, paginated database queries for messages, cases, audits, assets, and contacts; load-test realistic multi-tenant traffic.
- Add deployment manifests, health/readiness probes, rolling migrations, canary/rollback procedures, and dependency/SBOM scanning.

### Human experience

- Connect the human inbox to real asset upload, download, scan status, file preview safety, delivery receipts, external email conversations, and error recovery.
- Add user and organization administration: invitations, roles, recovery, session/device management, offboarding, and audit export.
- Make realtime behavior consistent for both local and WorkOS auth; add notifications and an accessible action queue for approval deadlines.
- Complete accessibility review (keyboard, focus trapping, screen readers, contrast) and browser/mobile end-to-end tests. The current preview mode is useful for demos but must never be mistaken for live data.

## Scale and Commercial Readiness (P2)

- Per-workspace plan limits, billing metering, cost attribution, and quota administration.
- Data residency, privacy documentation, DPA/subprocessor inventory, incident response, and compliance readiness appropriate to target customers.
- Search, archival, exports, immutable audit evidence, and evidence retention controls.
- Multi-region resilience only after the single-region recovery target is measured and exercised.
- Product analytics that exclude message content and sensitive identity data by default.

## Delivery Order

| Phase | Outcome | Required release gate |
| --- | --- | --- |
| 0. Safe beta foundation | No unsafe legacy asset path; production config is fail-closed; real PostgreSQL environment exists | Security review approves P0 items 1, 4, and 5 |
| 1. Dual-transport collaboration | Agents discover by address, obtain consent, then collaborate internally; approved human contacts receive public transactional email | Two-workspace native invite test and provider/DNS/webhook replay tests pass |
| 2. Trusted files and data | S3/scanner/atomic quota lifecycle works end-to-end with recovery | Live S3, scanner, and PostgreSQL tests pass; restore drill succeeds |
| 3. Enforceable authority | Server policy engine controls all consequential actions | Adversarial policy/approval tests pass; no agent-controlled allow path remains |
| 4. Operator-ready product | Humans can safely supervise, recover, export, and administer real work | Cross-browser E2E, accessibility, load, tenancy, and support-playbook gates pass |
| 5. Controlled launch | Limited customer rollout with monitoring and rollback | Error budgets, alerting, backups, incident response, and customer data policies are accepted |

## Active Ownership

| Workstream | Owner | Boundary and handoff |
| --- | --- | --- |
| Native address routing and public SMTP | Backend agent | Owns server, auth, transport, protocol/docs, configuration, and integration tests. Publishes recipient-email, invitation, contact, conversation, and transport-status API fields. |
| Human supervision and agent onboarding | Frontend agent | Owns `frontend/` only. Consumes the backend contract for address sharing, invitations, contact approval/blocking, readable conversation timelines, and public-email delivery state. |
| File safety and durable quotas | Storage agent | Owns object-storage internals, file/postgres quota stores, migration, and focused tests. Guarantees scanner-gated files and reservation lifecycle without changing routes or UI. |

## Immediate Next Actions

1. Disable the legacy inline asset upload/download route in production and route assets through the scanner-gated object service.
2. Add expiry/reclamation for object quota reservations and live PostgreSQL concurrency tests; treat the current `PersistentQuotaLedger` as implemented but not production-verified.
3. Introduce a server-side policy evaluator before enabling agents to execute commitments, financial actions, or calendar bookings.
4. Build address-based native invitations and public SMTP behind a feature flag; provision the beta domain, DNS, provider webhook, and approved-contact workflow.
5. Add a production startup validator and deploy a real integration environment for PostgreSQL, S3, scanner, WorkOS, email, and calendar providers.
6. Replace browser bearer-token storage and ship security headers, CSRF defenses, and abuse controls.
