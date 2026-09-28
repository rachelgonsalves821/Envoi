# Deployment recovery implementation plan

Owner: integration coordinator. Started 2026-09-28 from `cc86af3` on `codex/deployment-recovery`.

## Outcome

Prepare a tested release candidate for Cloudflare Workers Paid + Containers. The owner will upgrade the account. Application startup additionally requires real PostgreSQL, WorkOS, R2, scanner, and runtime secrets; code changes cannot substitute for provisioning those services.

The latest audited deployment built the Docker image and uploaded the Worker, then failed at `/containers/me`. The production runtime configuration was empty. Preserve that diagnosis separately from code and reliability defects.

## Workstreams and ownership

All implementations use the clean integration checkout on the recovery branch. The original `Sinaloa` checkout contains preserved work and must remain untouched. Agents do not commit, switch branches, or restore shared files; the coordinator integrates and reviews the complete diff.

| Workstream | Assigned owner | Owned files | Deliverables |
| --- | --- | --- | --- |
| Backend authorization and policy | Existing backend coding chat | `src/server.js`, auth/policy modules, related tests | Transactional case mutation and policy consumption; owner/admin intervention; agent rejection and stream revocation; case permissions; WorkOS membership authority; safe return URLs |
| Storage and delivery | Existing object-storage coding chat | Store implementations, delivery worker, storage/delivery tests, storage guide, live storage test | Transaction API, atomic FileStore visibility, quota expiry repair, lease fencing, opt-in R2/scanner integration checks |
| Inbox history | Pagination subagent | Frontend, new history helper and tests | Bounded history with usable older-page navigation, stable cursors, counts, refresh/stream reconciliation |
| Deployment and integration | Coordinator | Worker/configuration/CI/scripts/docs, readiness helpers; final server integration after backend freeze | Runtime preflight, honest dependency readiness, fixed deployment guide, repeatable validation, service inventory, final integration review |

## Integration contracts

- Stores expose `withTransaction(keys, callback)` for sorted logical lock keys; PostgreSQL operations use one transaction/client and advisory locks, and nested calls reuse the context. FileStore must provide equivalent serialized mutation and rollback semantics for tests/development.
- Route mutation and policy-chain updates use a consistent locking strategy. A conservative serialized beta write path is preferable to incomplete concurrency protection; its capacity limit must be documented and measured.
- Delivery completion/failure must carry a lease ownership/version token. A stale worker may not change documents, status, or receipts after another worker reclaims the job.
- The history helper owns its read contract. The coordinator adds routes after the backend owner freezes `server.js`, avoiding concurrent edits to that file.
- New runtime configuration keys must appear in production validation, the Worker allowlist, examples, preflight, and the deployment guide together.

## Ordered delivery gates

1. Implement defects with regressions proving unauthorized operations fail and concurrent legitimate operations preserve data. Fix redirect, role, rejected-agent, case permission, quota, policy-consumption, and lease races.
2. Add the missing live-service integration test and startup/preflight tools. Report explicit skips when credentials are absent; never describe skips as successful live validation.
3. Integrate history pagination and readiness. Readiness must positively validate scanner health and accurately describe the limits of storage/auth checks. Preserve fail-closed quarantine and optional feature defaults.
4. Run the complete backend/frontend/SDK/Worker/typecheck matrix plus disposable PostgreSQL where available. Run production dependency audit, container packaging dry-run, and clean-install/container checks where tooling permits.
5. Review transaction boundaries, rollback/lease behavior, permissions, secret handling, migration compatibility, and frontend pagination. Record test evidence and unresolved environment requirements here.
6. Prepare one reviewable recovery change on GitHub, with exact deployment commands, runtime inventory and cutover/rollback steps. Do not deploy, change subscriptions, or expose the custom domain before the required environment is ready.

## Environment completion checklist

- Workers Paid enabled by owner; correct account and build-token permissions.
- Managed PostgreSQL URL, verified TLS, database backup and migration validation.
- WorkOS client/API/cookie configuration; approved callback at the actual public hostname; membership authorization checked against the provider.
- Private R2 bucket and restricted credentials; browser CORS for signed uploads/downloads.
- HTTPS scanner with the documented scan and health contracts, credentials and timeouts.
- Independent signing/encryption keys; explicit public URL/CORS/agent domain; secure cookies.
- External email, calendar writes and consequential actions remain disabled for initial staging.

No credentials belong in this document or in source control. Inspect configuration names and provider resource existence without printing secret values. If services do not exist, record the exact missing setup rather than inventing credentials or weakening production validation.

## Scaling boundary

Keep the initial deployment at one named instance while correcting concurrency, leases and paging. The one-minute wake-up is intentional for background delivery/scanning. Shared cross-instance rate enforcement/event fanout and production capacity testing are a later expansion gate, not a reason to increase the instance count now. Deploy checks must reject accidental incompatible scaling until those mechanisms exist.

## Status

All three implementation workstreams have delivered their initial changes. Final integration review additionally found and repaired provider URL validation, stale WorkOS session authority, and PostgreSQL quota lock ordering. Webhook inbox locking is included in the final verification scope.

### Service inventory checked on 2026-09-28

- Cloudflare dashboard is accessible. The `sinaloa` Worker still shows the original failed deployment. The runtime agent has saved eleven non-secret staging variables without deploying; required credentials remain missing. See [runtime configuration status](runtime-configuration-status.md). R2 activation is also required. The build is connected to `main`, so the recovery branch is kept separate from production deployment.
- The earlier audit found Workers Free; the owner plans to upgrade. A successful container rollout must still verify entitlement and the build token.
- Existing checkouts contain environment examples, but no configured production environment file was found. No PostgreSQL, WorkOS, R2 or scanner runtime credentials were available for live acceptance tests. This does not prove that no provider resources exist; their provisioning and configuration remain unverified.
- A disposable local PostgreSQL 16 instance was created solely for regression tests. It is not the application database.

### Local verification

| Check | Result |
| --- | --- |
| Node 22 full backend suite | 79 passed, 0 failed/cancelled; 7 opt-in tests skipped (4 PostgreSQL, 3 R2/scanner) |
| Frontend | 38 passed |
| TypeScript SDK / Python SDK | 4 passed / 4 passed |
| Type checking and production frontend build | Passed |
| Worker tests / configuration check | 6 passed / passed |
| Wrangler deployment dry-run | Passed; no deployment performed |
| Production dependency audit | 0 reported vulnerabilities |
| Real PostgreSQL 16 | 4 passed, including transaction rollback, pagination, stale delivery leases and quota contention |
| Actual Docker image and deployed acceptance | Pending CI and provisioned services |

### Remaining release sequence

1. Review the recovery pull request and its CI result, including the actual Docker image build. The local machine lacks Docker; Wrangler dry-run verifies Worker packaging only.
2. Upgrade Workers and verify build-token access. Provision or locate the managed database, WorkOS environment, private R2 bucket and HTTPS scanner. Fill the ignored production environment template and run preflight without logging values.
3. Back up the database and apply migrations through `004_history_indexes.sql`. This additive migration backfills event cursors and creates indexes; schedule index building appropriately for existing large datasets.
4. Exercise database TLS, WorkOS sign-in and live membership changes, R2 upload/download/CORS and clean/infected scanner verdicts. Use a dedicated integration-test bucket.
5. Merge/deploy the reviewed commit only after runtime configuration is present. Run public smoke checks and the human/two-agent acceptance journey on the actual workers.dev origin.
6. Add the custom domain only after acceptance. Repeat public URL, CORS, edge allowlist, WorkOS callback and bucket CORS configuration for that origin.

### Explicit capacity limits

History pages and event replay are bounded, but each individual case still embeds its event/proposal/policy arrays. Large individual cases need a separate paginated timeline design before high-volume use; truncating authoritative policy data is not safe. Agent and connector lists, some legacy endpoints, and exact history counts also remain capacity considerations. Load-test realistic data and concurrent writes before a broad launch. WorkOS membership checks are live and fail closed; provider latency/outages affect protected requests. Multi-instance rate enforcement and event fanout remain future work.
