# Envoi backend rename inventory

Audited against `origin/main` at `376c760bc100b38c8f1c9f689875019f58327724` on 2026-10-08. This is a source inventory, not a fresh Cloudflare dashboard audit. The mapping for every `SINALOA_*` environment key below is the same suffix under `ENVOI_*` (for example, `SINALOA_PUBLIC_URL` → `ENVOI_PUBLIC_URL`). This branch updates backend reads, Worker forwarding, scanner lookup, examples, package identity, and user-visible service labels. Existing Cloudflare settings remain untouched. During the transition, old and new key names are accepted only when their values agree.

## Changed in code without a live cutover

- Human-readable process logs, the private npm package name, WorkOS metadata on newly created organizations, MCP server display name, and `/health`/`/ready` `service` now say Envoi. The deployment smoke script accepts either service label while older releases remain live.
- Backend code reads `ENVOI_*` names; the Container startup, migration entry point, production validator, and PostgreSQL option builder accept existing `SINALOA_*` settings through a conflict-detecting compatibility layer. The Worker allowlist forwards `ENVOI_*`, falling back to old dashboard names. The scanner accepts either token name, but refuses conflicting tokens.
- The development-only agent domain defaults to `envoi.mail`; production already uses `agents.envoi-agents.com`. This does not migrate previously stored development addresses.

## Runtime environment keys: rename only as one coordinated migration

These are live configuration interfaces, not just variable labels. This branch prepares new consumers, but `wrangler.jsonc` and the current dashboard still declare old names. Existing `SINALOA_*` values continue to work after this code is deployed. Do not change dashboard keys ahead of a reviewed staging deployment and a secret-safe cutover. Preserve existing encrypted secret **values** during the transition; do not print or copy them into source control.

| Group | Exact current keys (`SINALOA_` prefix omitted; proposed prefix `ENVOI_`) |
| --- | --- |
| Origin, access and identity | `AUTH_MODE`, `HUMAN_AUTH_PROVIDER`, `PUBLIC_URL`, `AGENT_DOMAIN`, `CORS_ORIGIN`, `EDGE_ALLOWED_HOSTS`, `HOST`, `PORT`, `TRUSTED_PROXY`, `COOKIE_SAMESITE`, `COOKIE_SECURE`, `CSRF_COOKIE_NAME`, `BETA_INVITED_EMAILS`, `AUTH_FLOW_MINUTES`, `OTP_EXPIRY_MINUTES`, `SESSION_HOURS`, `AGENT_ACCESS_TOKEN_TTL_SECONDS`, `AGENT_REFRESH_TOKEN_TTL_DAYS` |
| Database and local state | `DATA_DIR`, `DATA_ENCRYPTION_KEY`, `DB_CA`, `DB_CONNECT_TIMEOUT_MS`, `DB_POOL_SIZE`, `DB_QUERY_TIMEOUT_MS`, `DB_SSL`, `DB_SSL_MODE`, `DB_STATEMENT_TIMEOUT_MS` |
| Delivery and agent work | `DELIVERY_LEASE_MS`, `DELIVERY_MAX_ATTEMPTS`, `DELIVERY_POLL_MS`, `DELIVERY_RETRY_BASE_MS`, `DELIVERY_RETRY_MAX_MS`, `AGENT_WORK_LEASE_MS`, `AGENT_WORK_MAX_ATTEMPTS`, `AGENT_WORK_RETRY_BASE_MS`, `OPERATIONAL_BACKLOG_LOG_INTERVAL_MS`, `STREAM_MEMBERSHIP_RECHECK_MS` |
| Assets, R2 and scanner | `OBJECT_ALLOWED_MIME_TYPES`, `OBJECT_MAX_BYTES`, `OBJECT_QUOTA_REAPER_INTERVAL_MS`, `OBJECT_STORAGE_PROVIDER`, `WORKSPACE_OBJECT_QUOTA_BYTES`, `S3_ACCESS_KEY_ID`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_REQUEST_TIMEOUT_MS`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN`, `MALWARE_SCANNER_HEALTH_URL`, `MALWARE_SCANNER_TOKEN`, `MALWARE_SCANNER_URL`, `SCANNER_TOKEN`, `SCAN_COMPLETED_JOB_RETENTION_MS`, `SCAN_DEAD_LETTER_RETENTION_MS`, `SCAN_INFECTED_RETENTION_MS`, `SCAN_LEASE_MS`, `SCAN_MAX_ATTEMPTS`, `SCAN_RETENTION_INTERVAL_MS`, `SCAN_RETENTION_RETRY_MS`, `SCAN_RETRY_BASE_MS`, `SCAN_RETRY_MAX_MS`, `SCAN_WORKER_INTERVAL_MS` |
| Policy and optional integrations | `POLICY_ACTIVE_KEY_ID`, `POLICY_DECISION_TTL_SECONDS`, `POLICY_EXECUTE_AT_TOLERANCE_SECONDS`, `POLICY_MAX_AUTOMATIC_PAYMENT_MINOR`, `POLICY_SIGNING_KEY`, `POLICY_SIGNING_KEYS`, `POLICY_VERSION`, `EMAIL_DOMAIN_VERIFIED`, `EMAIL_PROVIDER`, `PUBLIC_EMAIL_DOMAIN`, `ENABLE_EXTERNAL_EMAIL`, `ENABLE_CALENDAR_WRITES`, `ENABLE_CONSEQUENTIAL_ACTIONS`, `EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT`, `EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT`, `CALENDAR_OAUTH_TIMEOUT_MS` |
| Limits, health and release | `MAX_BODY_BYTES`, `MAX_SSE_PER_PRINCIPAL`, `READINESS_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `RELEASE_SHA` |
| Restore and stress tooling only | `RESTORE_SOURCE_DATABASE_URL`, `RESTORE_SOURCE_DB_CA`, `RESTORE_SOURCE_QUIESCED`, `RESTORE_TARGET_DATABASE_URL`, `RESTORE_TARGET_DB_CA`, `RESTORE_TARGET_ISOLATED`, `STRESS_READS`, `STRESS_WRITES_PER_CASE` |

`SINALOA_CONTAINER` is a **Cloudflare Durable Object binding**, not an environment variable. It appears in Wrangler and Worker code and must be changed as a binding migration. `SINALOA_SCANNER_TOKEN` is the scanner Worker's side of the shared scanner credential; the code also accepts `ENVOI_SCANNER_TOKEN`. Generic `DATABASE_URL`, `WORKOS_*`, and other provider keys do not need a product-name rename.

## Names that are not runtime variables

| Surface | Current names and risk | Treatment |
| --- | --- | --- |
| Cloudflare resources | Worker `sinaloa`, staging/beta/scanner Worker and Container names, R2 bucket names, and `SinaloaContainer` class | These identify deployed resources and state. Plan a distinct infrastructure migration; do not search-and-replace them in a backend cleanup. |
| PostgreSQL | `sinaloa_*` tables, migration ledger and advisory lock, plus existing Neon project/database names | Keep physical names until a tested migration and restore path exist. Renaming JavaScript SQL strings alone would break persistence. |
| Agent protocol | `sinaloa_*` MCP tool IDs, schema `$id`, connector-internal names and stored token prefixes | Existing clients depend on these names. Add tested aliases/versioning before retiring old IDs. The MCP server's display name now says Envoi. |
| Observability and API | `sinaloa.operational_backlog` and `sinaloa.operational_backlog_error` structured events | Monitoring may consume these. The health/readiness service label now says Envoi; update any external alert or dashboard matching the old value before promoting the branch. |
| WorkOS and cookies | Existing WorkOS organization metadata `product: "sinaloa"`, default `sinaloa_session` and `sinaloa_csrf` cookie names | New organization metadata says Envoi. Existing records are historical; cookie rename signs users out and needs coordinated settings. |
| Development sentinels | Development-only key derivation salts and readiness object name | Preserve until local persistence and security semantics are reviewed. These are not the public agent-address domain. |
| Historical evidence | Older docs, audit records, PR links and incident evidence | Keep historically accurate. Current operator docs can add Envoi terminology without rewriting dated observations. |

## Manual actions after this branch is deployed and staging passes

1. **Cloudflare → Workers & Pages → `sinaloa-staging` → Settings → Variables and Secrets:** for each existing `SINALOA_*` runtime key, add the matching `ENVOI_*` key with the same value. Start with non-secrets; obtain encrypted values only from the authorized secret source or rotate them. Never paste values into chat, GitHub, or docs. Confirm `/ready`, sign-in, database, R2 and scanner against the exact deployed SHA. Do not delete old keys until rollback also understands new names.
2. Repeat for the **beta application Worker** only after staging passes. The sensitive encrypted keys include `SINALOA_DATA_ENCRYPTION_KEY`, `SINALOA_POLICY_SIGNING_KEY`/`SINALOA_POLICY_SIGNING_KEYS`, `SINALOA_S3_ACCESS_KEY_ID`, `SINALOA_S3_SECRET_ACCESS_KEY`, and `SINALOA_MALWARE_SCANNER_TOKEN`. `SINALOA_BETA_INVITED_EMAILS` is a configuration value containing private addresses; handle it accordingly. `DATABASE_URL`, `WORKOS_API_KEY`, and `WORKOS_COOKIE_PASSWORD` retain their existing names.
3. **Cloudflare → scanner Workers (`sinaloa-scanner-staging` and `sinaloa-scanner-beta`) → Settings → Variables and Secrets:** add `ENVOI_SCANNER_TOKEN` with the same stage-specific value as `SINALOA_SCANNER_TOKEN`. The app Worker's `ENVOI_MALWARE_SCANNER_TOKEN` must match its scanner. Do not reuse the staging token in beta. Verify authenticated scanner health and one clean/infected fixture before deleting old names.
4. **Cloudflare → Workers & Pages → Builds and routes:** review the connected staging/beta build commands, custom-domain routes, the old `beta.sinaloa-inbox.com` route, and any external checks expecting `/health` `service: "sinaloa"`. The old hostname and `wrangler.jsonc` route are still present; retire them only with the domain release. A rename of Worker, Container, Durable Object binding/class or R2 bucket needs a distinct migration with rollback; it is not a dashboard variable edit.
5. **WorkOS dashboard:** optionally relabel the existing `Sinaloa Beta`/`Sinaloa Staging` applications. Do not change client IDs, callback URLs or cookie names merely to change display text. Existing organization metadata can remain historical.
6. **Neon dashboard:** project/database names `sinaloa-beta`, `sinaloa-staging`, `sinaloa_beta`, and `sinaloa_staging` are resource identities. Leave them until there is a separate backed-up database migration; no agent-facing Envoi address depends on their names.
7. After all deployed releases and rollback targets consume `ENVOI_*`, remove old aliases in a later PR. Treat database tables, MCP tool IDs, token prefixes, cookies and structured monitoring event names as separate compatibility migrations.

Do **not** rename Cloudflare dashboard keys before this branch is deployed and tested in staging. A key rename is not a credential rotation.
