# Deployment recovery implementation plan

Owner: integration coordinator. Started 2026-09-28 from `cc86af3` on `codex/deployment-recovery`.

> Historical implementation log. Its older commit IDs, test counts, first-contact acceptance steps and uncommitted-work statements describe earlier snapshots. For the current beta scope and branch handoff, use the [two-owner execution plan](beta-two-owner-execution-plan.md) and [handoff audit](beta-handoff-audit.md). Direct exact-address messaging requires no first-contact request.

## Outcome

Prepare a tested release candidate for Cloudflare Workers Paid + Containers, the selected first-beta architecture following Rachel's stated upgrade intention. Rachel still needs to complete the actual account/billing action; no subscription change is implied by this document. Application startup additionally requires real PostgreSQL, WorkOS, R2, scanner, and runtime secrets; code changes cannot substitute for provisioning those services. The [two-owner execution plan](beta-two-owner-execution-plan.md) assigns the remaining product and platform work.

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
| Actual Docker image and fail-closed startup | Passed in GitHub CI on `28e3a33`; required protocol schema is now included in the production image |
| Deployed/provider acceptance | Pending provisioned services and an authorized deployment; R2/scanner skips are not live validation |

### Release candidate and CI

[Draft PR #1](https://github.com/rachelgonsalves821/Sinaloa/pull/1) contains commits `08f46b7` and `28e3a33`; it has not been merged. [Backend CI run 36469762053](https://github.com/rachelgonsalves821/Sinaloa/actions/runs/36469762053) passed on `28e3a33`, including clean install, backend/frontend/SDK/Worker checks, production build, Wrangler dry-run, actual Docker build, invalid-production-configuration startup rejection, PostgreSQL 16 regression tests and dependency audit. The startup check proves fail-closed behavior; it does not prove successful startup with real providers. The first CI attempt exposed the missing `protocol/` directory in the image, which the second commit fixes and guards against regression.

### Automatic Cloudflare preview decision

The connected repository also attempts branch previews automatically. The latest inspected preview build `08101683-4f22-4a76-a1d1-21acd235b725` built the frontend but failed at `npx wrangler preview` because the configuration has no `previews` block. This failure is separate from the passing GitHub workflow and the original production `/containers/me` entitlement failure. No successful Cloudflare deployment has occurred.

Recommendation: temporarily disable automatic branch previews while the paid account and required services/secrets are incomplete, subject to owner approval of that setting change. Retain GitHub CI as the review gate. Adding an empty `previews` block is insufficient: previews need isolated Containers/Durable Objects, their own provider resources or safe test scopes, callback URLs and credentials. Re-enable previews only after that environment has been designed and verified. The integration/release owner prepares the configuration; Rachel approves disabling previews or provisioning an isolated preview environment. No preview setting, billing, R2 activation, domain exposure, merge or deployment was changed during this follow-up.

### Remaining work and named owners

| Order | Gate | Owner | Completion evidence |
| --- | --- | --- | --- |
| 0 | Resolve hosting choice and new review findings | Rachel chooses hosting; backend/frontend owners investigate; integration/release coordinates | Explicit first-beta hosting decision; new authorization/concurrency/onboarding and UI findings triaged and fixed or dispositioned with evidence |
| 1 | Review candidate and preview strategy | Integration/release agent; Rachel approves account/release actions | PR #1 reviewed; green CI retained; automatic previews disabled with approval or isolated preview design accepted |
| 2 | Workers Paid, R2 activation and provider inventory | Rachel/account owner; Cloudflare runtime agent maintains configuration table | Paid entitlement and build-token access verified; database, WorkOS, private bucket and scanner resources identified |
| 3 | Runtime configuration | Cloudflare runtime agent with provider/account owners | Eleven saved non-secret settings reconciled to the selected origin; remaining secrets securely configured; preflight passes without printing values |
| 4 | Database and storage acceptance | Storage agent | Backup/restore and migration instructions verified; migration through `004`; TLS, R2 CORS/signed operations and clean/infected scanner checks pass |
| 5 | Authentication and authorization acceptance | Backend agent | WorkOS callback/sign-in, live membership changes, permission denials, rejection/revocation and secure session checklist completed |
| 6 | Product UI acceptance | Frontend agent | Human/two-agent journey, older-page navigation, counts, reconnect/replay and error states verified against the release environment |
| 7 | Approved deployment and live smoke | Integration/release agent; Rachel approves merge/deployment and any endpoint exposure | Exact reviewed commit deployed; positive readiness and live acceptance evidence recorded; rollback procedure available |
| 8 | Wider launch and scale | Integration/release agent with backend/frontend/storage owners | Capacity checks completed; custom domain separately approved and verified; optional external actions remain off until separately accepted |

The original implementation passed CI, but follow-up agent reviews have raised new potential code blockers. Do not describe the candidate as code-complete or merge it until these findings are triaged. The critical path now includes hosting confirmation, review remediation, account/service setup and live acceptance; an elapsed-time estimate is unreliable until these are resolved. Acceptance checklists are assigned to the backend, frontend and storage agents; this plan does not claim their live checks have already run.

### Follow-up review: local fixes verified; release BLOCKED pending renewed CI and environment gates

Integration has now reviewed both owners' changes and independently rerun the combined checkout: Node 22 backend 81 passed, 0 failed/cancelled, 7 explicit skips; frontend 45/45; typecheck and production frontend build passed; PostgreSQL 16 4/4 passed separately. The generated `web/index.html` was rebuilt and normalized to LF, and `git diff --check` passes. These follow-up changes remain uncommitted/unpushed, so the green CI on `28e3a33` does not cover them yet. Frontend permission selection and requester-authority gating are delivered, including authority refresh during pagination; the inert global pause control is removed. The earlier finding details below explain the fixes, rather than asserting those defects remain unfixed. Next integration gate: include the reviewed changes in PR #1 and obtain renewed CI once the automatic-preview/hosting decision is coordinated. Live provider and browser acceptance remain pending.

Backend owner has delivered the scoped fixes and frozen its four files. The fixes include requester-specific `canManageInbox` and deferred audit publication after enrollment/message commit. Focused auth/config checks passed 16/16. PostgreSQL regression setup applied migrations 001–004 to a disposable local database; this does not migrate the production database.

- Backend acceptance owner reports 14/14 local acceptance tests passing, but three concrete blockers in `src/server.js`: first-contact native message creation (reported lines 2411–2488) bypasses `withInboxMutation`, risking concurrent invitation/held-message overwrite and writes after rejection; enrollment redemption (1549–1559) checks active WorkOS membership without rechecking the issuer's current management role; redemption (1562–1578) consumes the token before identity/inbox/directory/credential/audit writes complete in a single transaction, risking a consumed token and partial records. Backend owner is assigned scoped source fixes and regressions; no storage, Worker or frontend edits under that assignment. Integration must review the resulting diff and rerun relevant suites and CI before removing this block. Live WorkOS acceptance remains unrun. Storage source files remain frozen.
- Frontend source review confirms that enrollment and pending-agent approval submit a fixed four-permission set, including `execute_cases` and `create_assets`, preventing least-privilege selection (`frontend/src/App.tsx`, reported lines 26, 926 and 932). Frontend owner is assigned selectable least-privilege permission scopes and tests.
- Frontend source review confirms enabled case/invitation actions for read-only humans, while backend owner/admin checks reject them. Frontend owner is assigned capability gating and removal or honest disabling of the inert global “Pause all work” control. Dependency: the backend owner must expose requester-specific management authority in `GET /api/inboxes/:id/human-view` (for example `canManageInbox`) because existing capabilities are hardcoded and invitation actionability is state-only. Frontend must fail closed when authority is absent; backend enforcement remains authoritative. Integrate both owners' fixes and tests before any push or merge.
- Frontend has supplied a source-review checklist, not completed live browser acceptance: two-human workspace isolation; first-contact reject/accept and real message/receipt flow; multi-page history plus SSE reconnect; approval/pause/revoke and observer restrictions; quarantine/scanning/clean/infected/error attachment states with download only when clean. Run on the selected production-like host without the mock `?preview=1` mode.

### Remaining release sequence

1. Review draft PR #1 and the passing CI on `28e3a33`, including the actual Docker image build and fail-closed startup check. Resolve the automatic preview strategy before further branch pushes trigger avoidable failed builds.
2. Upgrade Workers and verify build-token access. Provision or locate the managed database, WorkOS environment, private R2 bucket and HTTPS scanner. Fill the ignored production environment template and run preflight without logging values.
3. Back up the database and apply migrations through `004_history_indexes.sql`. This additive migration backfills event cursors and creates indexes; schedule index building appropriately for existing large datasets.
4. Exercise database TLS, WorkOS sign-in and live membership changes, R2 upload/download/CORS and clean/infected scanner verdicts. Use a dedicated private integration-test bucket with bucket-scoped credentials. Follow [storage acceptance instructions](object-storage-production.md): exact-origin CORS for PUT/GET/HEAD with Content-Type, If-None-Match and x-amz-meta-sinaloa-sha256; HTTPS scanner binary POST and same-origin authenticated GET `/health` returning HTTP 200 with `{ "ready": true }`. Run `node --test test/object-storage-live.test.js` with both `SINALOA_RUN_LIVE_R2_TESTS=1` and `SINALOA_RUN_LIVE_SCANNER_TESTS=1` plus the documented `SINALOA_LIVE_*` configuration. Record clean/EICAR, quarantine, wrong-auth, checksum and deletion results. These live tests remain pending.
5. Merge/deploy the reviewed commit only after runtime configuration is present. Run public smoke checks and the human/two-agent acceptance journey on the actual workers.dev origin.
6. Add the custom domain only after acceptance. Repeat public URL, CORS, edge allowlist, WorkOS callback and bucket CORS configuration for that origin.

### Explicit capacity limits

History pages and event replay are bounded, but each individual case still embeds its event/proposal/policy arrays. Large individual cases need a separate paginated timeline design before high-volume use; truncating authoritative policy data is not safe. Agent and connector lists, some legacy endpoints, and exact history counts also remain capacity considerations. Load-test realistic data and concurrent writes before a broad launch. WorkOS membership checks are live and fail closed; provider latency/outages affect protected requests. Multi-instance rate enforcement and event fanout remain future work.
