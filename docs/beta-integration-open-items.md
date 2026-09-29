# Beta integration open items

Updated 2026-09-29. This file tracks the combined R1/R2 release candidate. Keep an item open until its evidence exists on the exact candidate commit. A local mock, skipped live-provider test, or UI visibility without matching server enforcement does not complete a hosted gate.

Rachel chose **a new isolated staging environment first** for R1/R2 acceptance. The invite-only beta at `https://beta.sinaloa-inbox.com` is a later promotion target after staging passes. The chosen native agent address domain is `agents.sinaloa-inbox.com`; staging must configure `SINALOA_AGENT_DOMAIN` accordingly. Keep staging provider data, secrets, storage, and callbacks separate from beta.

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
- [x] `b0337b9` — xAI case-file announcement through MCP (`integrations/grok/**`); committed locally and may be pushed with the integration branch.
- [x] The `integrations/agent-bridges/real-assets.test.ts` fixture is paired locally with the matching partner `src/**` contract. It passed against a real local server and scanner with two owners, two cases, typed offer/decision, mirrored receipt, shared file, block/pause/resume and tenant denial. Commit and push them together.

## Required before combining scopes

- [ ] Freeze and document the exact server/client fixture for two owners, two agents, two concurrent cases, typed offer/decision, clean file grant, pause/resume, block/unblock, revoke, and human approval.
- [x] Local partner contract mirrors typed native outcomes and one final receipt to both owners; the two-owner fixture checks equality.
- [x] Local granted-file projection shows the clean asset to the recipient human, and the copied recipient download URL stops working after a block.
- [x] Local manager pause/resume and native block/unblock controls call enforcing routes; focused frontend and two-owner server tests pass.
- [x] Local chosen-address test verifies exact lowercase address, atomic collision denial, parent redemption audit marker and two-active-agent cap. Hosted configuration remains open.
- [ ] Run backend, frontend, TypeScript SDK, Python SDK, bridge, Worker, typecheck, production build, Docker build, PostgreSQL, and both Wrangler dry-runs on the combined candidate.
- [ ] Commit all combined changes, push `codex/r1-r2-integration`, open or update the integration PR, and require green GitHub CI for the exact head SHA.

## WorkOS beta account configuration reported from the product setup chat

- [x] Application named `Sinaloa Beta`; hosted UI enabled.
- [x] Self-service sign-up disabled; invitations enabled; MFA required; breached passwords rejected.
- [x] Callback: `https://beta.sinaloa-inbox.com/api/auth/workos/callback`.
- [x] Homepage and sign-out: `https://beta.sinaloa-inbox.com`.
- [x] Initiate login: `https://beta.sinaloa-inbox.com/api/auth/workos/sign-in`.
- [x] Session policy: 7-day maximum, 1-day inactivity timeout, 5-minute access token.
- [x] Hosted invitation and password-reset URLs remain at WorkOS defaults.
- [ ] Configure a separate staging WorkOS callback and credentials for the isolated staging origin; verify invite-only admission and MFA there.

## Provider and deployment gates not blocked by R2

- [ ] Provision managed PostgreSQL with TLS, migrations, backups, and a restore test.
- [ ] Provision the HTTPS malware scanner and verify clean, infected, timeout, redirect, and negative-health behavior.
- [ ] Verify the Cloudflare build token has `Containers Edit` permission.
- [ ] Configure the isolated staging Worker's non-R2 variables and encrypted secrets without printing or committing secret values.
- [ ] Bind a dedicated staging HTTPS hostname only when the reviewed Worker is ready to serve it. Keep `beta.sinaloa-inbox.com` for later promotion.
- [ ] Run configuration preflight, Container/Wrangler dry-run, and all tests that do not require live object storage.

## R2-dependent gates

- [ ] Activate the Cloudflare R2 subscription.
- [ ] Create a private staging bucket, bucket-restricted S3 credentials, and exact-origin CORS.
- [ ] Configure R2 endpoint, bucket, access key, and secret as staging runtime settings.
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

1. The combined integration changes are still under active test and are not yet pushed.
2. Isolated staging PostgreSQL, WorkOS, and scanner resources and secrets are not yet verified.
3. R2 subscription and live object-storage acceptance remain outstanding.
4. Real hosted OpenClaw/xAI and two-human browser acceptance cannot run until deployment is healthy.
