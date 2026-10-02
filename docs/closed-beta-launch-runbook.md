# Closed-beta launch runbook

Updated 2026-09-29. Local results and remaining hosted gates are in the [readiness evidence log](closed-beta-readiness-evidence-2026-09-29.md). The merged implementation baseline is `main` commit **`fc2e1d8b72280789e365e9f8b8e399717933ccb6`** (PR #6). This is the current operator procedure; older [two-owner plan](beta-two-owner-execution-plan.md) and [handoff audit](beta-handoff-audit.md) are historical. The [runtime inventory](runtime-configuration-status.md) contains dated observations, not permanent provider guarantees.

**Code integrated; cohort admission remains gated by evidence.** Earlier staging readiness and fixture/CI results do not prove a newly reviewed candidate, beta Container, real agents, backup recovery or operational signoff. Record every gate against one exact full candidate SHA and target environment. Do not mark pending evidence passed, or treat an HTTP 401 from unauthenticated scanner health as authenticated readiness.

## 0. Record and freeze the candidate

Rachel owns product/account decisions and private credential entry and executes all hosted commands from her authenticated account. Je prepares and verifies the technical release and operational evidence. CLI credentials on another machine may point to a different Cloudflare account; they do not authorize hosted changes. Alerts must reach both owners; their exact destinations and primary incident responder remain pending and must be recorded before signoff. Parallel implementation work must have non-overlapping file ownership.

Create future fixes from merged main, review a bounded diff, and require green CI on the final candidate. In the clean candidate checkout, record:

```powershell
git rev-parse HEAD
git status --short
git show --no-patch --format=fuller HEAD
```

The release record must contain the **full candidate SHA**, main baseline, review/CI URL, clean working-tree result, migration set/checksums, environment, operator, timestamp, previous accepted Worker version and Container image digest. Do not record only “latest main”. If fixes change the SHA, rerun the affected checks and replace the candidate record before promotion; staging and beta must deploy that same accepted SHA.

Cloudflare staging Builds has historically tracked `codex/staging-readiness`. Merging to main therefore does not prove staging updated. Use the guarded manual promotion command from the candidate checkout. Freeze concurrent legacy staging Builds during acceptance so an automatic build cannot replace the candidate. Live promotion fetches origin/main and requires a clean checkout with HEAD equal to both the supplied full SHA and fetched main; merge reviewed fixes and obtain CI before live promotion. A dry-run can check a descendant candidate before merge and does not authorize live deployment. It pins the intended Cloudflare account and sets SINALOA_RELEASE_SHA. Its default is a dry-run; --deploy performs the live deployment from Rachel's authenticated account. Verify that the old `sinaloa` Worker remains disconnected from Git Builds. Avoid bare `wrangler deploy`, which selects that old Worker; `npm run cf:deploy` intentionally fails.

Run the repository CI matrix on the candidate: clean install, backend, frontend, TypeScript/Python SDK, bridge, Worker/scanner tests, local stress, typecheck/build, disposable PostgreSQL tests, actual Docker build and fail-closed startup, production dependency audit and `npm run cf:check`. CI's disposable PostgreSQL and missing-configuration Docker checks are code evidence, not live-service evidence. Report live-test skips explicitly. Record focused regressions for scanner-token preflight and rotating invalid bearer/cookie abuse; passing configuration shape alone does not close those security gates.

## 1. Verify isolated resources and private configuration

| Target | Application Worker / Container | Public app origin | Separate providers |
| --- | --- | --- | --- |
| Staging | `sinaloa-staging` / `sinaloa-beta-staging` | `https://sinaloa-staging.rachelgonsalves821.workers.dev` | Neon `sinaloa-staging`, private R2 `sinaloa-staging`, staging scanner and selected staging WorkOS app |
| Beta | `sinaloa-beta` / `sinaloa-beta-release` | `https://www.envoi-agents.com` | Neon `sinaloa-beta` / `sinaloa_beta`, private R2 `sinaloa-beta`, `sinaloa-scanner-beta`, separate WorkOS `Sinaloa Beta` environment/app |

Verify current Workers Paid/Containers entitlement, effective deployment permissions, resource ownership and billing limits. The runtime inventory records intended resource identities, but the operator must confirm the active project/branch/Worker in each dashboard. A tab labelled Production on the `sinaloa-beta` Worker is that Worker's live settings, not permission to reuse the old `sinaloa` Worker.

The user confirms only staging secrets have been configured; beta secret entry remains pending. Before the first beta app deploy, Rachel must enter these **nine beta-only encrypted application secrets** privately on `sinaloa-beta`. Verify names and application behavior without reading values into logs, chat or source control:

| Secret name | Rule |
| --- | --- |
| `DATABASE_URL` | Beta Neon active branch/database, direct TLS connection; `SINALOA_DB_SSL_MODE=verify-full` controls verified certificate behavior |
| `WORKOS_API_KEY` | Beta application's key from its separate WorkOS environment |
| `WORKOS_COOKIE_PASSWORD` | New strong beta cookie key, at least 32 characters |
| `SINALOA_DATA_ENCRYPTION_KEY` | New strong beta encryption key, at least 32 characters; securely retain for recovery |
| `SINALOA_POLICY_SIGNING_KEY` | New strong beta signing key, at least 32 characters; active key ID `primary` |
| `SINALOA_S3_ACCESS_KEY_ID` | Bucket-scoped beta R2 credential |
| `SINALOA_S3_SECRET_ACCESS_KEY` | Matching beta R2 secret |
| `SINALOA_BETA_INVITED_EMAILS` | Exact approved beta emails, comma-separated; no wildcard |
| `SINALOA_MALWARE_SCANNER_TOKEN` | New beta scanner bearer, matching scanner Worker's encrypted `SINALOA_SCANNER_TOKEN` |

Cookie, encryption, signing and scanner keys must be independent of each other and of staging/old production keys. The matching app/scanner bearer is the deliberate exception. Store durable encryption/signing recovery material privately and retain old keys as needed for existing data/signatures. Provider deployment credentials are not app runtime secrets. Additional provider CA/session-token settings are conditional, not substitutes for these nine names.

The beta non-secret origin, exact edge hostname, CORS origin, WorkOS client/callback, R2 endpoint/bucket, scanner URL and disabled feature flags are pinned in `wrangler.jsonc`. Reconcile dashboard values with that contract. Configure WorkOS callback/homepage/logout on the same HTTPS beta origin and exact-origin R2 CORS for signed PUT/GET/HEAD and upload headers. Verify bucket public access disabled and credential bucket scope. Native agent addresses use `agents.envoi-agents.com`; they do not require SMTP.

The approved policy is **invite-only, WorkOS MFA Off, self-service signup disabled**. The app requires an authenticated sealed provider session, verified email and exact-email admission. Hosted auth reports `assurance: provider`; it does not attest a second factor. Current active organization membership/management authority is checked for protected controls. Local phone/TOTP routes and Twilio Verify are not hosted beta prerequisites. Test invalid/stale sessions and changed membership; do not invent a hosted “low-MFA” rejection gate under the approved policy.

For local configuration checks, privately populate separate ignored `.env.staging` / `.env.beta` files or inject equivalent secure process settings; the files do not upload Cloudflare secrets:

```powershell
node --env-file=.env.staging scripts/preflight.mjs
node --env-file=.env.beta scripts/preflight.mjs
```

A successful preflight checks setting validity only. Require authenticated beta scanner `/health` HTTP 200 with `{"ready":true}`, clean and infected verdicts, bad-token rejection and bounded error/timeout behavior. `/ready` after app deployment verifies DB connectivity, R2 reads and scanner health; signed writes/deletes/CORS and sign-in are separate proofs.

## 2. Back up, migrate and prove staging on the candidate

Before touching a hosted schema, verify the selected database identity, backup availability and rollback compatibility. Run migrations using the intended environment settings:

```powershell
node --env-file=.env.staging src/migrate.js
```

Compare `sinaloa_schema_migrations` with immutable Git LF SQL bytes on the recorded candidate; the baseline includes migrations 001–004. Never edit an applied migration or silently replace its checksum to force startup. Diagnose a mismatch against exact immutable bytes and restore evidence first. Do not run the destructive regression fixtures against a user database: PostgreSQL tests belong to a disposable database, and opt-in storage tests belong to a dedicated private integration bucket and scanner, as documented in [storage verification](object-storage-production.md).

After configuration, backups, provider proofs and candidate CI are recorded, Rachel runs the guarded dry-run and live promotion from the clean reviewed checkout. Replace the placeholder with the actual accepted full SHA:

```powershell
$candidateSha = '<reviewed full 40-character SHA>'
node scripts/promote-release.mjs staging $candidateSha
node scripts/promote-release.mjs staging $candidateSha --deploy
npm run smoke:deployment -- https://sinaloa-staging.rachelgonsalves821.workers.dev/ $candidateSha
```

Record the resulting Worker version and Container digest. The smoke command validates releaseSha returned by both /health and /ready against the supplied candidate; record that identity proof alongside readiness. Complete the staging product/security/provider journey in gates 4–5 with real invited testers and independently hosted agents. A healthy older staging commit does not establish candidate acceptance.

## 3. Promote the same accepted SHA to beta

Before exposure, require beta-only secret names, config preflight, authenticated beta scanner proof, callback/CORS configuration, available backup and validated schema. Record the custom-domain exposure decision. Migrate the separate beta database only after backup and candidate compatibility checks:

```powershell
node --env-file=.env.beta src/migrate.js
node scripts/promote-release.mjs beta $candidateSha
node scripts/promote-release.mjs beta $candidateSha --deploy
```

**The beta deploy attaches `www.envoi-agents.com` immediately.** Beta has `workers_dev: false` and admits only the custom hostname. Application smoke therefore happens **after** successful custom-domain binding and DNS resolution, never through the beta workers.dev address. Keep the apex and old production Worker outside this release target. Stop admission and diagnose if deployment, TLS or binding fails.

```powershell
npm run smoke:deployment -- https://www.envoi-agents.com/ $candidateSha
```

Record Worker version, Container digest, hostname binding/DNS/TLS, `/health`, `/ready`, `/api/auth/config` and frontend smoke. Then repeat the critical real product, security and provider journey against the beta origin with approved test users; custom-origin behavior and beta-only services must be proven before inviting the cohort.

## 4. Product and negative-security evidence

Each row needs environment, candidate SHA, actor/provider versions, sanitized correlation IDs, actual expected/observed result, timestamp and a link to evidence. Mark it pending until observed. Rachel signs product behavior; Je signs server/provider enforcement.

| Gate | Required hosted evidence |
| --- | --- |
| Human admission | Two independently invited verified users complete WorkOS callback and in-app admission with MFA Off; unrelated/uninvited, expired and stale sessions fail. Secure cookies, origin/CSRF checks and current membership/role changes are enforced. |
| Enrollment and isolation | Separate owners/inboxes; one-use enrollment and least-privilege scopes; two-active-agent cap; third agent denied; observer cannot manage; retry does not create duplicate identity. |
| Real external agents | Real OpenClaw Gateway and xAI API clients complete hosted MCP tool calls using renewable credentials. Record successful calls matched to server logs, not tool discovery, plausible answer text or request configuration. Keep refresh tokens on private bridge hosts and out of model prompts; xAI gets scoped read tokens. Use the existing [OpenClaw](../integrations/openclaw/README.md) and [Grok](../integrations/grok/README.md) guides. |
| Shared product loop | Unsolicited exact-address work arrives without a first-contact invitation; two simultaneous multi-turn cases keep separate IDs and identical canonical outcomes visible to both humans. Exercise typed proposal/decision/receipt, offline delivery, history pagination and SSE reconnect/replay. Enrollment is not evidence the agent is online; a processing receipt is not case completion. |
| Renewal and restart | Continue past ordinary access-token expiry; restart bridge during settlement, catch up once with no duplicate canonical reply, and stop future REST/MCP work after revocation. Test/document recovery from a crash between refresh rotation and durable local save. |
| Control and authority | Pause/resume, block/unblock and revoke change server behavior at send/claim/settlement/MCP/asset boundaries. Cross-tenant reads/writes, third-party case-ID reuse, send-as spoofing and agent-forged human authority fail. Record the actual 401/403/409/423 or other contract-specific result for each path. |
| Abuse bounds | Rotating invalid bearer tokens and arbitrary cookies cannot reset request limits. Concurrent requests, SSE admission and timeouts remain bounded on the single Container. Do not increase max_instances or infer distributed enforcement from this proof. |

## 5. File and provider safety evidence

Prove beta bucket-scoped signed PUT/HEAD/GET/DELETE, SHA-256/size immutability and browser CORS on the exact beta origin using disposable owned test objects. Confirm wrong credentials fail and remove only the created test objects. Test upload retry/idempotency and quota accounting without touching unrelated data.

Through the application, show quarantine denies downloads; clean scan allows the bound case recipient and both authorized human views; unrelated/blocked/revoked recipients are denied. Infected, scanner error/timeout and unscanned objects never receive download URLs. Upload signatures bind expected byte size and checksum/content type; verify a real browser supplies signed Content-Length implicitly (JavaScript must not set that forbidden header). Rejected/abandoned uploads retain quota until URL expiry plus cleanup grace and successful deletion/key sealing. Conditional zero-byte tombstones remain at those private keys to stop an in-flight PUT recreating bytes after quota release; lifecycle policies must preserve them. Prove quota stays reserved through cleanup failures and releases exactly once.

Recipient grants use authenticated app content URLs and recheck current controls/checksum per fetch. Owner/authorized-manager R2 presigned GET URLs remain usable for their already-issued lifetime (default 300 seconds); revocation prevents new URLs and does not cancel prior S3 signatures. Record this distinction in acceptance and tester expectations. Record scanner signature freshness/cold-start behavior and clean/infected verdicts. Direct scanner probes and R2 readiness alone do not prove combined grants/quarantine safety.

## 6. Recovery, operations and credential rotation

Before user admission, assign and prove automated backup policy/retention, recovery access and secure key storage. Historical empty-schema restore branches and Neon's recorded six-hour Free history window do not prove durable populated recovery. Seed representative test data: two owners, cases/messages/events/receipts, asset metadata/grants, object bytes, queue/scan states and encrypted records. Back up the populated database and required R2 objects/key material, then restore into an isolated branch/bucket with isolated secrets and optional actions off. Compare IDs, counts, canonical outcomes, object hashes, grants, decryption/signature verification and migration ledger. Prove restored queued work resumes once. Record actual recovery time and recovered-data boundary/RPO; never replace active user data to perform this drill.

Use the read-only database comparison helper after quiescing the source and restoring a populated snapshot. Privately populate ignored `.env.restore` with `SINALOA_RESTORE_SOURCE_DATABASE_URL`, `SINALOA_RESTORE_TARGET_DATABASE_URL` and optional separate CA settings. Set `SINALOA_RESTORE_SOURCE_QUIESCED=1` and `SINALOA_RESTORE_TARGET_ISOLATED=1` only after establishing those conditions. Both connections require verified TLS and distinct endpoints:

```powershell
node --env-file=.env.restore scripts/verify-restored-data.mjs
```

It compares counts and deterministic SHA-256 fingerprints for six fixed application tables and checks both migration ledgers against the candidate SQL. It refuses a source without cases/messages/assets and emits counts/digests/error codes, never rows or URLs. It does not restore or modify data. A pass covers database row equality only; independently prove R2 recovery, keys/decryption, indexes/sequence objects, resumed queues, timing/RPO and actual quiescence/isolation.

Rehearse Container restart with durable queued work/cases/assets and record lease recovery/no duplicate effect. Before deploying a candidate, record the previous accepted application commit, Worker version, image digest and schema compatibility. Rehearse application rollback to that compatible version on isolated test resources, recording the exact supported deployment/provider operations actually used. Preserve schema and data: no down-migration, table truncation, bulk queue deletion, lost scan/audit records or key removal. A release with incompatible schema needs a separate data-preserving recovery plan; do not force an older image against it. Pause admission/affected work during an incident and preserve evidence.

Configure alerts for `/ready` failure, Container errors/restarts, oldest delivery/scan work, dead letters and backup failure, plus agreed billing/capacity limits. Both owners must receive a test alert at the agreed destinations, with a named primary incident responder and a known response/rollback path. Destinations and primary response ownership remain pending until recorded. Record thresholds and evidence. Bound realistic concurrent load for one `basic` Container; the one-minute warm-up cron incurs usage and is not a substitute for queue monitoring.

The beta bucket credential `sinaloa-beta-object-rw-2026-09` is recorded as expiring **2026-10-29**. **Rotation owner and renewal reminder are pending.** Assign an accountable person and an approved reminder before launch, verify the actual expiration time privately, create/enter replacement bucket-scoped credentials before expiry, prove signed operations/readiness with the replacement and then retire the old credential. If staging continues, separately rotate its expiring credential. This runbook creates no scheduled task or provider change.

## 7. Cohort go/no-go

Rachel's written product signoff and Je's operational signoff must refer to the same promoted SHA and completed evidence log. Require all product, negative-security, provider, recovery, alert and rotation gates; `/ready`, a merge, green fixtures or one successful invitation cannot substitute. Confirm external email, calendar writes and consequential actions remain false.

Invite a tiny first batch of the explicitly approved cohort (maximum 20) only after signoff. Observe 24–48 hours before expansion. Halt admission/expansion on authentication bypass, data loss/inconsistent shared state, unsafe downloads, scanner unavailability or persistent queue failures. Document beta capacity and renewal/re-enrollment limitations for testers. Any unverified gate remains a launch blocker with a named next action.
