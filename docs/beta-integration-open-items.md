# Beta integration open items

Updated 2026-09-29. This file tracks the combined R1/R2 release candidate. Keep an item open until its evidence exists on the exact candidate commit. A local mock, skipped live-provider test, or UI visibility without matching server enforcement does not complete a hosted gate.

Rachel chose **a new isolated staging environment first** for R1/R2 acceptance. The invite-only beta at `https://beta.sinaloa-inbox.com` is a later promotion target after staging passes. The native agent address domain is `agents.sinaloa-inbox.com`; staging must configure `SINALOA_AGENT_DOMAIN` accordingly. Keep staging provider data, secrets, storage, and callbacks separate from beta.

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
- [x] Local backend (99 pass, 8 live-provider/PostgreSQL skips), frontend (58), TypeScript SDK (37), Python SDK (4), bridge (26), OpenClaw adapter (16), Worker (6), typecheck, production web build, and both agent adapter builds pass on the combined working tree.
- [x] Wrangler dry-runs pass for the root Worker and isolated `staging` environment.
- [x] GitHub's `test` check passed at `98c5469`, including Docker build/startup, PostgreSQL tests, both Wrangler dry-runs, frontend, SDKs, backend, and the bridge suite with the real-server file fixture enabled.
- [x] Integrated code is committed and pushed in draft PR #5. The exact remote branch head was verified at `98c5469` before this tracker update.
- [ ] Require green checks for the final exact head SHA. Cloudflare's automatic branch Preview failed at `98c5469` after a successful build: its dashboard deploy command is `npx wrangler preview`, but `wrangler.jsonc` lacks a `previews` block. This is a separate Preview configuration issue; it does not establish staging readiness.

## WorkOS beta account configuration reported from the product setup chat

- [x] Application named `Sinaloa Beta`; hosted UI enabled.
- [x] Self-service sign-up disabled; invitations enabled; MFA required; breached passwords rejected.
- [x] Callback: `https://beta.sinaloa-inbox.com/api/auth/workos/callback`.
- [x] Homepage and sign-out: `https://beta.sinaloa-inbox.com`.
- [x] Initiate login: `https://beta.sinaloa-inbox.com/api/auth/workos/sign-in`.
- [x] Session policy: 7-day maximum, 1-day inactivity timeout, 5-minute access token.
- [x] Hosted invitation and password-reset URLs remain at WorkOS defaults.
- [x] Configure a separate staging WorkOS application, callback, and credentials for the isolated staging origin.
- [ ] Verify invite-only admission, Twilio phone verification, and TOTP with two separate human accounts in staging.

## Provider and deployment gates not blocked by R2

- [x] Provision separate staging Neon PostgreSQL, apply all four checksum-verified migrations, and restore a manual snapshot to a new branch.
- [ ] Verify the deployed application connects to staging PostgreSQL with certificate-verified TLS and passes live CRUD/restart checks. Define a durable beta backup policy before real-user signoff.
- [ ] Provision the HTTPS malware scanner and verify clean, infected, timeout, redirect, and negative-health behavior.
- [ ] Verify the Cloudflare build token has `Containers Edit` permission.
- [ ] Complete the staging Worker's non-R2 variables and encrypted secrets. Database, WorkOS, and application keys are saved; scanner, Twilio Verify, and exact invited-email allowlist remain.
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
- [ ] Two invited humans complete WorkOS MFA and independently enroll one external agent each.
- [ ] Real OpenClaw and xAI agents use the hosted MCP endpoint with renewable credentials; refresh credentials never enter model prompts.
- [ ] Complete two distinct multi-turn cases, typed offer/decision, a clean shared file, offline delivery, connector restart, and exactly-once reply behavior.
- [ ] Exercise expired and revoked credentials, pause/resume, block/unblock, quarantine, cross-tenant denial, stale browser session, reload, and pagination.
- [ ] Verify alerts, backup/restore, Container restart, and rollback to the previous image/commit.
- [ ] Promote the verified commit to the invite-only beta and invite the 20 humans in small batches only after the critical journey passes on staging.

## Current blockers

1. PR #5 remains draft. GitHub's `test` check passed at `98c5469` with the real-server fixture enabled. Cloudflare's automatic Preview still failed because `wrangler.jsonc` has no `previews` block; configure a fully isolated Preview or disable automatic Previews while using the separate staging Worker.
2. Staging Neon migrations and a snapshot restore are verified in the provider dashboard; live application database TLS, WorkOS onboarding, scanner, remaining runtime secrets, Container rollout, and readiness remain open.
3. Direct live R2 signed-object operations pass. Hosted scanner/quarantine, recipient-grant, and restart acceptance remain open.
4. Real hosted OpenClaw/xAI and two-human browser acceptance cannot run until deployment is healthy.
