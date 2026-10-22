# Consolidated P0 candidate: #192 + #195 + #197

Direct human assignment, 2026-10-22 America/New_York: finish the consolidated candidate, fix the test issue, run full checks and prepare it for approval. Billing remains deferred. This is source preparation in an isolated worktree, not approval to integrate, deploy, change account settings, invite users or run real hosted agents.

## Exact source selection

Base: integration/agent-native at `2312734c4e93c533d3e457929d0afc67b62fc130` (includes #189's generated enum projection). Branch: `lane-b/P0-consolidated-192-195-197`.

| Input | Frozen head | Included once |
| --- | --- | --- |
| #192 | `fe7e0e9395832ed49917fc4ed800c5466dfe5ffd` | Windows wake-store identity, normal scoped wake startup, historical acceptance correction and application/scanner/exact-main release guards |
| #195 | `bba852a98abbc4d8c64cad9196add9020f2b44de` | Root Vitest/mocker/spy 5.0.3 security dependency update |
| #197 | `41e5892e072672462af741263327f5fa6e58edec` | Its two commits above #192 only: private per-installation wake configuration for supervised restarts, stopped-service rotation/removal, entrypoint tests and portable Windows manifest fixture |

The original branches are preserved. Select this combined delta once; do not additionally apply #192, #195, #197 or #174's same changes. No portable REST or remote-auth implementation is added by this narrower assignment. The existing approved case-session, case-tools and http-wake contracts are consumed unchanged.

## Final behavior and the test finding

The normal connector and OpenClaw Quick Connect entrypoints reopen saved private wake configuration under the connector lock. A service installation persists complete validated settings. An empty supervisor environment can therefore restart the same installation with its wake receiver, scoped host and canonical poller. Partial, mismatched or corrupt configuration fails closed. Explicit configure-wake/clear-wake commands require the connector lock, so the service must be stopped for rotation/removal. The startup manifest contains paths, not wake settings or credentials.

The reported broad-suite failure in #192 was a one-second default readiness wait. The selected #197 source carries an explicit bounded five-second wait for the same listener-before-subscription assertion. The loopback probe must still return exactly 400, the ready callback must run once, and canonical claim/body, duplicate-process rejection and cleanup assertions remain. This is a test scheduling correction; it changes no product timeout and does not turn the simulated callback into hosted acceptance. No assertion, test, security threshold or skip rule is weakened.

The first combined CI run also exposed an existing FileStore cleanup-test race: it observed session deletion and immediately asserted token-index deletion, although cleanup awaits those writes separately. The test now waits for both existing end-state conditions within the same 15-second bound and retains its strict deletion, expired-session and authentication assertions. No product cleanup, retention policy or canonical fixture changes.

Generated web files and download manifests come exclusively from npm run build. Source/generated agreement, full suite results, audits and exact final commit/CI identities are recorded in this candidate's draft PR. A green constituent PR alone does not certify the combined source and dependency tree.

## Acceptance and release boundary

Prior Phase A, B-local 21/21 and human-countersigned B/C work remain credited: https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176 . This candidate validates later changed source; it does not request a blanket replay or invent a new installed-host run. See P0-COMPLETION.md for the historical assembly, docs/p0-release-guards.md for the guards and the existing operator guide for wake configuration.

WorkOS Production billing remains deferred. Both supplied client IDs were verified in Staging; neither replaces the existing pin as Production. No WorkOS ID, issuer, owner/workspace mapping, private secret, flag or account setting is changed here. Remote-auth and optional consequential routes retain their existing disabled defaults.

Before a future human release, record the resulting source SHA, Worker version, container image reference/digest, served and installed artifact hashes, applicable changed-behavior checks, retained compatible rollback pair and intended cohort. Reconcile existing live database/recovery, backups/alert and credential evidence; perform only actual missing or changed operations under their separate authorization. The recorded R2 credential expiry remains October 29 and needs account-operator reconciliation. No deployment, paid operation, live traffic or invitation is part of this candidate.

The bounded approval request is to review and integrate this exact combined source into integration/agent-native. It does not approve main promotion, a deployment or Production activation. Source rollback target is the base above; operational rollback remains the separately verified Worker/container/settings pair. Historical accepted tests stay associated with their original release identities.

## Freshly rebuilt artifact identities

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| web/downloads/envoi-connector.mjs | 469816 | 747a6cb09424dfe932f753460189c05eddb2c7984c776673bc92ee2549459360 |
| web/downloads/envoi-openclaw.mjs | 387273 | 67a1cd9733d935e1c91e951ff38090f42142d3d71d9bb889a39b774c473ac16b |
| integrations/onboarding/dist/envoi-link.mjs | 641368 | b5b2dd9909b3d8cf044a74e60a9a9c84da3d5eed3b3c14a2656d9174807d73d2 |
