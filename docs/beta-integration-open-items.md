# Beta integration open items

Updated 2026-09-29. This file tracks the combined R1/R2 release candidate. Keep an item open until its evidence exists on the exact candidate commit. A local mock, skipped live-provider test, or UI visibility without matching server enforcement does not complete a hosted gate.

Rachel chose **a new isolated staging environment first** for R1/R2 acceptance. The invite-only beta at `https://beta.sinaloa-inbox.com` is a separate deployment target. The native agent address domain is `agents.sinaloa-inbox.com`; staging must configure `SINALOA_AGENT_DOMAIN` accordingly. Keep staging provider data, secrets, storage, and callbacks separate from beta. Integrating the reviewed code into `main` does not by itself deploy the beta Worker.

## Ownership boundary

| Owner | Paths and responsibilities |
| --- | --- |
| Rachel | `frontend/**`, `web/**`, `sdk/**`, `integrations/**`; onboarding and human observability; OpenClaw and xAI client behavior; browser and real-agent acceptance |
| Partner | `src/**`, `db/**`, `protocol/**`, `worker/**`, deployment configuration; shared case/file state; authorization and controls; hosted MCP contract; provider deployment and operations |
| Shared integration | Cross-owner fixtures and release documentation. A client test that proves a partner API must land with the matching server contract or remain open. |

## Rachel-owned changes safe to publish

- [x] `79e7a40` — updated R1 enrollment interface bundle (`web/**`).
- [x] `0739ce2` — manager pause/resume controls (`frontend/**`); already on the remote integration branch.
- [x] `f2f39a1` — renewable client asset exchange path and SDK support (`integrations/**`, `sdk/**`); already published on its feature branch.
- [x] `b0337b9` — xAI case-file announcement through MCP (`integrations/grok/**`); published on the integration branch.
- [x] `fd8b262` — trusted OpenClaw/xAI bridges can share only host-approved case files during normal agent turns; published on the integration branch.
- [x] The `integrations/agent-bridges/real-assets.test.ts` fixture is committed with the matching partner `src/**` contract and passes locally against a real server and scanner with two owners, two cases, typed offer/decision, mirrored receipt, shared file, block/pause/resume and tenant denial.

## Required before combining scopes

- [x] The server/client fixture and expected authorization, case, file, and receipt behavior are documented in `docs/beta-backend-integration-contract.md` and exercised by local integration tests.
- [x] Local canonical shared case mirrors structured proposals, decisions, and one final receipt to both owners; the two-owner fixture checks equality.
- [x] Both local human projections retain the exact structured terms, decision, state, and receipt. Frontend rendering checks those terms and the accepted decision in each owner view. Hosted browser acceptance remains open.
- [x] Local granted-file projection shows the clean asset to the recipient human, and the copied recipient download URL stops working after a block.
- [x] OpenClaw and xAI bridge loops accept an agent-selected handle only from a host-approved exact-file manifest, then verify the file, grant it to the authenticated case sender, and announce the asset ID with one retry key. Hosted real-provider file acceptance remains open.
- [x] Local manager pause/resume and native block/unblock controls call enforcing routes; focused frontend and two-owner server tests pass.
- [x] Local chosen-address test verifies exact lowercase address, atomic collision denial, parent redemption audit marker and two-active-agent cap. Hosted configuration remains open.
- [x] Local backend (104 pass, 8 live-provider/PostgreSQL skips), frontend (61), TypeScript SDK (37), Python SDK (4), bridge (26 with the real-server fixture enabled), Worker (6), scanner (4), typecheck, production web build, and the bounded local stress harness pass on the combined working tree. Full npm audit reports zero vulnerabilities after the Wrangler update.
- [x] Wrangler dry-runs pass for the isolated `staging` and `beta` application environments and dedicated beta scanner. The unqualified deploy script fails closed instead of targeting the old production Worker.
- [x] Partner staging host admission fails closed on an absent or unlisted hostname, with Worker tests passing after integration.
- [x] The bounded local stress harness passes with three owners, two cases, concurrent writes/reads/MCP calls, idempotent retries, and denied injection/spoof attempts. It found rotating invalid MCP bearer strings bypassed the per-token limiter; MCP requests now consume a source-IP limit before bearer lookup and a per-token limit after successful authentication. This is local FileStore evidence, not hosted load acceptance.
- [x] GitHub's `test` check passed at `98c5469`, including Docker build/startup, PostgreSQL tests, both Wrangler dry-runs, frontend, SDKs, backend, and the bridge suite with the real-server file fixture enabled.
- [x] Integrated code plus scanner are committed on `codex/staging-readiness`; [PR #6](https://github.com/rachelgonsalves821/Sinaloa/pull/6) targets `main`. Integrate this branch once, rather than merging the stacked branches independently.
- [x] At `b68a7b9`, GitHub Backend CI and Cloudflare Builds for `sinaloa-staging` both passed. The old production Worker `sinaloa` was disconnected from Git Builds; the staging Worker follows `codex/staging-readiness` and has preview-branch builds off. Recheck both statuses on any new review SHA before `main`.

## WorkOS staging invitation configuration

- [x] Application named `Sinaloa Beta`; hosted UI enabled.
- [x] Self-service sign-up disabled; invitations enabled; breached passwords rejected. Rachel approved MFA Off for the invite-only beta; WorkOS Staging displays Disabled.
- [x] Default application's callback: `https://sinaloa-staging.rachelgonsalves821.workers.dev/api/auth/workos/callback`; the undeployed beta callback remains an additional registered URI for rollback.
- [x] Default application's homepage and sign-out default: `https://sinaloa-staging.rachelgonsalves821.workers.dev`.
- [x] Default application's initiate login: `https://sinaloa-staging.rachelgonsalves821.workers.dev/api/auth/workos/sign-in`.
- [x] Session policy: 7-day maximum, 1-day inactivity timeout, 5-minute access token.
- [x] Hosted invitation and password-reset URLs remain at WorkOS defaults.
- [x] Configure a separate staging WorkOS application, callback, and credentials for the isolated staging origin.
- [x] Rachel privately rotated the staging Worker's encrypted `WORKOS_API_KEY` to the default application's app-scoped key; `WORKOS_CLIENT_ID` and the WorkOS default-app URLs now point to that application. A manual staging rebuild of `60d2583` succeeded and refreshed the Container environment.
- [x] A fresh hosted sign-in request reached AuthKit with the default client ID and staging callback. `/health` and `/ready` returned 200 after rollout. Rachel's 6:07 PM dashboard invitation email was Delivered and that invitation now shows Accepted. Rachel reports a successful sign-in; WorkOS shows her user Active and an active Password session for `Sinaloa Beta` issued at 6:15 PM. In-app callback/admission still needs independent observation.
- [ ] Invite the second tester, then complete both humans' sign-in/callback and application-admission acceptance without assuming that invite acceptance proves sign-in.
- [ ] Verify invite-only WorkOS admission with two separate human accounts in staging; SMS and application TOTP are not required.
- [x] On 2026-09-29, rechecked WorkOS Staging: hosted UI enabled and self-service sign-up disabled. MFA was initially Required for non-SSO users, then changed to Off at Rachel's explicit request; the dashboard displays Disabled. The default `Sinaloa Beta` application's callback, homepage, initiate-login, and sign-out defaults match the staging Worker. Enterprise SSO is enabled at environment level, with one active built-in test connection for `example.com`. Rachel has a verified WorkOS session; the in-app callback/admission and second tester remain open.

## Provider and deployment gates not blocked by R2

- [x] Provision separate staging Neon PostgreSQL, apply all four checksum-verified migrations, and restore a manual snapshot to a new branch.
- [x] Provision separate Neon `sinaloa-beta` database `sinaloa_beta` (project `dry-tooth-12968475`) and apply migrations `001`–`004` with Git LF checksums. A manual snapshot was restored to a new branch (`br-odd-dream-b4wya7aw`); its four migration checksums match the active branch. Beta database secret and durable scheduled backup policy remain open.
- [x] Create private Cloudflare R2 bucket `sinaloa-beta` with public access disabled and exact `https://beta.sinaloa-inbox.com` CORS for `PUT`, `GET`, and `HEAD`. Rachel created `sinaloa-beta-object-rw-2026-09`, restricted to that bucket with Object Read & Write access through 2026-10-29. Worker secret entry remains open; credential values never enter Git or chat.
- [x] Create isolated non-production WorkOS `Sinaloa Beta` environment `environment_01M3QMT0ZAK069BRK0ENNANZAT` and default application `app_01M3QMT1FH2PQXB5J78XJWJNW2` (`client_01M3QMT1BN3HEBGE4VPEAQA0GT`). Set its four beta-origin URLs, invite-only signup, MFA Off, 7-day maximum session, 1-day inactivity timeout and 5-minute access tokens. This is not a Production-class WorkOS environment; live beta sign-in remains unproven.
- [ ] Verify the deployed application connects to staging PostgreSQL with certificate-verified TLS and passes live CRUD/restart checks. Define a durable beta backup policy before real-user signoff.
- [ ] Provision the HTTPS malware scanner and verify clean, infected, timeout, redirect, and negative-health behavior.
- [ ] Verify the Cloudflare build token has `Containers Edit` permission.
- [ ] Complete the staging Worker's non-R2 variables and encrypted secrets. Database, WorkOS, application keys, and the two-human invite allowlist are saved; scanner endpoint verification remains.
- [ ] Bind a dedicated staging HTTPS hostname only when the reviewed Worker is ready to serve it. Keep `beta.sinaloa-inbox.com` for later promotion.
- [ ] Run configuration preflight, Container/Wrangler dry-run, and all tests that do not require live object storage.

## R2-dependent gates

- [x] Activate Cloudflare R2.
- [x] Create the private `sinaloa-staging` bucket, a 30-day bucket-restricted Object Read & Write credential, and exact-origin CORS.
- [x] Save the R2 endpoint, bucket, access key, and secret on the staging Worker; both keys are encrypted secrets and no rollout occurred.
- [x] Pass a direct live signed-object test for upload, size/checksum metadata, download, invalid-key rejection, and deletion after the `d8f51e8` HEAD-length adapter fix.
- [ ] Prove signed PUT/GET, checksum, quota, clean scan, quarantine, recipient grant, denial, and restart persistence against live R2.

## Isolated staging acceptance before beta promotion

- [ ] Deploy the exact reviewed commit and obtain a positive `/ready` response.
- [ ] Two invited humans complete WorkOS sign-in and independently enroll one external agent each; MFA Off is the approved beta policy.
- [ ] Real OpenClaw and xAI agents use the hosted MCP endpoint with renewable credentials; refresh credentials never enter model prompts.
- [ ] Complete two distinct multi-turn cases, typed offer/decision, a clean shared file, offline delivery, connector restart, and exactly-once reply behavior.
- [ ] Exercise expired and revoked credentials, pause/resume, block/unblock, quarantine, cross-tenant denial, stale browser session, reload, and pagination.
- [ ] Verify alerts, backup/restore, Container restart, and rollback to the previous image/commit.
- [ ] Promote the verified commit to the invite-only beta and invite the 20 humans in small batches only after the critical journey passes on staging.

## Current blockers

1. Recheck exact-head CI after the integration commit. The old production Worker's Git build is disconnected; staging preview-branch builds are off. A merge to `main` must not be mistaken for beta promotion.
2. The staging application Container is running. `/health` and `/ready` return 200 with PostgreSQL, R2 read, and scanner ready. Rachel has a verified WorkOS session, but in-app admission, a second-user callback, and live app CRUD/restart tests remain open. MFA Off is the approved beta policy.
3. Direct live R2 and scanner tests pass separately. Hosted app quarantine, recipient-grant, browser CORS, infected-file denial, and restart acceptance remain open.
4. Real hosted OpenClaw/xAI and the two-human/two-case browser journey remain untested on the deployed SHA.
5. The beta Worker and dedicated scanner are configured and pass dry-run, but their live deployments, hostname binding, beta-only runtime secrets, provider acceptance, durable backup, and app rollback drill remain open. The separate beta R2 bucket, Neon schema and manual restore, and non-production WorkOS application are provisioned.
