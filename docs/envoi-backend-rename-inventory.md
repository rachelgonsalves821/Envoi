# Envoi backend rename inventory

Audited against `origin/main` at `376c760bc100b38c8f1c9f689875019f58327724` on 2026-10-08. This is a source inventory, not a fresh Cloudflare dashboard audit. The mapping for every `SINALOA_*` environment key below is the same suffix under `ENVOI_*` (for example, `SINALOA_PUBLIC_URL` → `ENVOI_PUBLIC_URL`). No runtime key or Cloudflare resource was renamed by this inventory change.

## Change now without a cutover

- Human-readable process logs: `Sinaloa delivery worker failed` and `Sinaloa backend listening` can say Envoi. These two log strings are changed with this inventory. They are not structured event identifiers.
- Future comments and purely internal local identifiers may be renamed when their owning code is touched, provided exported names, stored data, and wire formats are unchanged.

## Runtime environment keys: rename only as one coordinated migration

These are live configuration interfaces, not just variable labels. `worker/runtime-config.js` forwards allowed keys to the Container; `src/production-config.js`, `src/server.js`, `src/auth.js`, `src/workos-auth.js`, storage and scanner modules read or validate them; `wrangler.jsonc` and the environment examples declare values. A Cloudflare dashboard rename before all consumers support `ENVOI_*` can prevent startup or disable a security check. Preserve existing encrypted secret **values** during the transition; do not print or copy them into source control.

| Group | Exact current keys (`SINALOA_` prefix omitted; proposed prefix `ENVOI_`) |
| --- | --- |
| Origin, access and identity | `AUTH_MODE`, `HUMAN_AUTH_PROVIDER`, `PUBLIC_URL`, `AGENT_DOMAIN`, `CORS_ORIGIN`, `EDGE_ALLOWED_HOSTS`, `HOST`, `PORT`, `TRUSTED_PROXY`, `COOKIE_SAMESITE`, `COOKIE_SECURE`, `CSRF_COOKIE_NAME`, `BETA_INVITED_EMAILS`, `AUTH_FLOW_MINUTES`, `OTP_EXPIRY_MINUTES`, `SESSION_HOURS`, `AGENT_ACCESS_TOKEN_TTL_SECONDS`, `AGENT_REFRESH_TOKEN_TTL_DAYS` |
| Database and local state | `DATA_DIR`, `DATA_ENCRYPTION_KEY`, `DB_CA`, `DB_CONNECT_TIMEOUT_MS`, `DB_POOL_SIZE`, `DB_QUERY_TIMEOUT_MS`, `DB_SSL`, `DB_SSL_MODE`, `DB_STATEMENT_TIMEOUT_MS` |
| Delivery and agent work | `DELIVERY_LEASE_MS`, `DELIVERY_MAX_ATTEMPTS`, `DELIVERY_POLL_MS`, `DELIVERY_RETRY_BASE_MS`, `DELIVERY_RETRY_MAX_MS`, `AGENT_WORK_LEASE_MS`, `AGENT_WORK_MAX_ATTEMPTS`, `AGENT_WORK_RETRY_BASE_MS`, `OPERATIONAL_BACKLOG_LOG_INTERVAL_MS`, `STREAM_MEMBERSHIP_RECHECK_MS` |
| Assets, R2 and scanner | `OBJECT_ALLOWED_MIME_TYPES`, `OBJECT_MAX_BYTES`, `OBJECT_QUOTA_REAPER_INTERVAL_MS`, `OBJECT_STORAGE_PROVIDER`, `WORKSPACE_OBJECT_QUOTA_BYTES`, `S3_ACCESS_KEY_ID`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_REQUEST_TIMEOUT_MS`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN`, `MALWARE_SCANNER_HEALTH_URL`, `MALWARE_SCANNER_TOKEN`, `MALWARE_SCANNER_URL`, `SCANNER_TOKEN`, `SCAN_COMPLETED_JOB_RETENTION_MS`, `SCAN_DEAD_LETTER_RETENTION_MS`, `SCAN_INFECTED_RETENTION_MS`, `SCAN_LEASE_MS`, `SCAN_MAX_ATTEMPTS`, `SCAN_RETENTION_INTERVAL_MS`, `SCAN_RETENTION_RETRY_MS`, `SCAN_RETRY_BASE_MS`, `SCAN_RETRY_MAX_MS`, `SCAN_WORKER_INTERVAL_MS` |
| Policy and optional integrations | `POLICY_ACTIVE_KEY_ID`, `POLICY_DECISION_TTL_SECONDS`, `POLICY_EXECUTE_AT_TOLERANCE_SECONDS`, `POLICY_MAX_AUTOMATIC_PAYMENT_MINOR`, `POLICY_SIGNING_KEY`, `POLICY_SIGNING_KEYS`, `POLICY_VERSION`, `EMAIL_DOMAIN_VERIFIED`, `EMAIL_PROVIDER`, `PUBLIC_EMAIL_DOMAIN`, `ENABLE_EXTERNAL_EMAIL`, `ENABLE_CALENDAR_WRITES`, `ENABLE_CONSEQUENTIAL_ACTIONS`, `EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT`, `EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT`, `CALENDAR_OAUTH_TIMEOUT_MS` |
| Limits, health and release | `MAX_BODY_BYTES`, `MAX_SSE_PER_PRINCIPAL`, `READINESS_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `RELEASE_SHA` |
| Restore and stress tooling only | `RESTORE_SOURCE_DATABASE_URL`, `RESTORE_SOURCE_DB_CA`, `RESTORE_SOURCE_QUIESCED`, `RESTORE_TARGET_DATABASE_URL`, `RESTORE_TARGET_DB_CA`, `RESTORE_TARGET_ISOLATED`, `STRESS_READS`, `STRESS_WRITES_PER_CASE` |

`SINALOA_CONTAINER` is a **Cloudflare Durable Object binding**, not an environment variable. It appears in Wrangler and Worker code and must be changed as a binding migration. `SINALOA_SCANNER_TOKEN` is the scanner Worker's side of the shared scanner credential; its name must change together with app-side `SINALOA_MALWARE_SCANNER_TOKEN` and both Worker configurations. Generic `DATABASE_URL`, `WORKOS_*`, and other provider keys do not need a product-name rename.

## Names that are not runtime variables

| Surface | Current names and risk | Treatment |
| --- | --- | --- |
| Cloudflare resources | Worker `sinaloa`, staging/beta/scanner Worker and Container names, R2 bucket names, and `SinaloaContainer` class | These identify deployed resources and state. Plan a distinct infrastructure migration; do not search-and-replace them in a backend cleanup. |
| PostgreSQL | `sinaloa_*` tables, migration ledger and advisory lock, plus existing Neon project/database names | Keep physical names until a tested migration and restore path exist. Renaming JavaScript SQL strings alone would break persistence. |
| Agent protocol | `sinaloa_*` MCP tool IDs, server info, schema `$id`, connector download paths and package names | Existing clients depend on these names. Add tested aliases/versioning before retiring old IDs. They need not change for the public Envoi domain to function. |
| Observability and API | `sinaloa.operational_backlog` event, `sinaloa.operational_backlog_error`, and `/health`/`/ready` `service: "sinaloa"` | Monitoring and smoke scripts can consume these. Change only with dashboard, alert and test updates, or keep as compatibility identifiers. |
| WorkOS and cookies | WorkOS organization metadata `product: "sinaloa"`, default `sinaloa_session` and `sinaloa_csrf` cookie names | Metadata may be used by the provider; cookie rename signs users out and needs coordinated settings. |
| Development sentinels | `sinaloa.mail`, `sinaloa.invalid`, development-only key derivation salts and readiness object name | Preserve until tests, local fixtures and any security semantics are reviewed. These are not the public agent-address domain. |
| Historical evidence | Older docs, audit records, PR links and incident evidence | Keep historically accurate. Current operator docs can add Envoi terminology without rewriting dated observations. |

## Safe migration order after this inventory is reviewed

1. Add one centralized environment reader for each `ENVOI_*` key with a documented fallback to the corresponding `SINALOA_*` key. If both are set with different values, fail startup for security-critical settings rather than silently choosing one. Update Worker forwarding, preflight, examples and tests in the same candidate.
2. Validate staging with the **existing** names, then add new names with identical values to the staging Worker and scanner. Confirm Container startup, `/ready`, sign-in, database, R2 and scanner. Never log secret values.
3. Move beta configuration only after staging evidence. Rotate secrets only when independently required; a rename is not a rotation. Once all deployments and rollback targets consume new names, remove old names in a later release.
4. Treat Cloudflare resource identities, database names, MCP tool IDs, cookies and monitoring schemas as separate migrations with their own compatibility and rollback decisions. No production-domain move depends on renaming those internals.

This inventory intentionally does **not** instruct an operator to rename Cloudflare dashboard keys now.
