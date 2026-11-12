# Phase B onboarding implementation queue

Prepared 2026-10-16 from integration `2b18170d59b0096ff997d9a79487d50ccb627ef9`.
Planning only. Start implementation after the Phase A closeout is reconciled under the build rules. No package publication, route enablement, merge or deployment is authorized by this document.

## Goal and approved inputs

First milestone: a fresh Hermes or OpenClaw host runs `envoi-link connect https://www.envoi-agents.com`, presents a safe claim URL/code, the owner approves, the host human confirms the approver/workspace/agent/permissions, the helper activates privately, and the runtime receives and settles real work.

Consume `agent-registration` v1 revision 3 at `4da219e7156138c94e26b8105efe7ffe43ec6f98`, with `a3-pause-auth` v3, `a4-wake` v2 and `a5-presence` v1. Canonical fixtures remain in `test/contract-fixtures`; do not copy them.

The corrected registration contract received [Lane B ACK](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134589212) and [fresh human approval](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134778271) before integration of #76/#78/#72. The registry and some prose still say published or await fresh approval; REQUEST lane-a to reconcile those status annotations with the existing approval, without changing the approved wire contract or requesting duplicate approval.

The following are proposed task subdivisions of A-4.x/B-4.x, not newly approved contracts. Branch each task from the then-current integration head; draft PRs target integration/agent-native.

## Ordered implementation tasks

| Proposed task | Owner / allowed paths | Depends on | Done when |
| --- | --- | --- | --- |
| A-4.1 common approval and installation foundation | Lane A: src, server tests, rollout/config files | Recorded Phase A gate; approved core contract | Legacy and new flows share approval logic; family-to-installation projection and revoke/reconnect rules match fixtures; restart cannot freeze an identity after installation-only revoke/replay; flags default off |
| A-4.2 durable registration and human claim | Lane A: server/storage and canonical server tests | A-4.1 | Route availability, pending registration/poll, durable creation/network limits, wrong-guess limit, address/slot holds, approve/reject/withdraw and claim list match all contract fixtures; membership/assurance/permission checks remain live |
| A-4.3 activation and recovery | Lane A: server/storage and tests | A-4.2 | Atomic private activation, persisted activationId recovery, identical successor response, expiry/tombstones, per-installation revoke and cleanup survive restart on both stores |
| B-4.1 private helper state machine | Lane B: integrations/onboarding, sdk | A-4.1-4.3 fixtures and usable server surface | Real connect replaces draft-only result only for an offered route; bootstrap/activationId saved before requests; credentials saved atomically; safe status output; explicit CONFIRMING step; no activation after decline/timeout; bootstrap removed after success |
| B-4.2 owner claim and installation UI | Lane B: frontend | A-4.2/A-4.3 | Code matching, workspace/agent/permissions, approve/reject/withdraw, expiry and errors consume approved responses; active/ended installations and revoke/reconnect are accurate |
| B-4.3 connect page and runtime integration | Lane B: integrations, frontend, connect content; Lane A wires public routes/root build changes | B-4.1/B-4.2 | Page/skill/manifest/helper show only server-offered routes; real Hermes/OpenClaw use the existing connector lifecycle; Quick Connect remains under Advanced; built assets match sources |
| Gate B-local | Both lanes and human runtime operators | One integrated SHA with above tasks | Fresh Hermes and OpenClaw complete the journey without tokens in chat, message each other, restart/recover missed work, reconnect the same identity, and stop after installation revoke |

B-4.1 and B-4.2 can consume the same published fixtures without editing Lane A paths. Implementation must not invent server behavior while waiting for A-4.x. One writer per file; serialize any overlap.

## Required behavior and validation

- A pending registration has no operational send, work, MCP or status rights.
- Verification code normalization, claim/activation windows, source/network limits and cleanup come from `schemas.json`/`x-limits`, not this queue or duplicated client constants. Preserve the contract's 24-hour minimum/25-hour deletion bound.
- Decisions, activation and uncertain network retries reuse persisted identifiers and idempotency state. Losing a response must not create a second agent or installation.
- The model sees only approved safe projections. It never sees bootstrap, operational access/refresh credentials, activationId or raw server dumps.
- Activation is followed by authenticated status before reporting connected. Connectivity is distinct from demonstrated closed-app reachability.
- A paused reconnect remains paused; installation-only revocation preserves identity/address/history, and stops further connector actions without automatic enrollment.
- Lane A runs each canonical fixture on FileStore and PostgreSQL, with restart/race, isolation, cleanup and rollback checks. Lane B consumes canonical fixtures through the existing loaders and checks actual helper/UI outcomes.
- Run focused checks and the full lane suite from PowerShell; combined integration CI must include PostgreSQL, production container and generated consistency. Rebuild web only with `npm run build`.
- Use [ACCEPTANCE.md](skill/ACCEPTANCE.md) for real-host validation and retain sanitized route-by-host evidence. Human approval controls live hosts, test sends, flag enablement and deployment.

## Route scope after the local milestone

Core v1 offers `local_helper`, and separately enabled `authenticated_rest`, both with `envoi_link` delivery. Clients read `GET /api/onboarding/routes`, never deployment flags.

Remote MCP/OAuth and provider connectors require A-3.1b publication, Lane B review and human approval before their dependent code. Keep those routes unavailable until their own acceptance passes. Poll/on-demand require an approved presence-label revision; do not advertise unattended wake from an open chat or a brand name.

The local milestone is the first deliverable, not completion of the multi-route breadth gate. Follow it with authenticated REST acceptance and the reviewed remote/provider routes and host-specific closed-app evidence. Phase C case-scoped tools and Phase D A2A remain later waves.

## Closeout and rollout boundary

The current helper/package/manifest remain unpublished and blocked until implementation and release gates pass. This plan does not change them. Phase B acceptance is a new onboarding gate; successful Phase A tests do not replace it.

See the [Phase A closeout handoff](../gates/PHASE-A-CLOSEOUT-2026-10-16.md) and [governing build plan](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md).
