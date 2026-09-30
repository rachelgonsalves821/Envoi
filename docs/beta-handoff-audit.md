# Beta handoff audit

> **Historical implementation plan, superseded 2026-09-29.** The sections below preserve the 2026-09-28 development snapshot, including old branch status, incomplete features, commands and test counts. They are not current deployment instructions. PR #6 merged the implementation into `main` at `fc2e1d8b72280789e365e9f8b8e399717933ccb6`; do not branch from or promote the old recovery tip. Use the [closed-beta launch runbook](closed-beta-launch-runbook.md) for exact-candidate promotion, current release gates and signoff. Shared cases, file grants, controls and MCP/client paths now have merged implementations; hosted acceptance remains unverified until recorded. The approved invite-only beta has WorkOS MFA Off, disabled signup and exact-email admission; local SMS/TOTP does not establish hosted assurance. Historical gaps below must be rechecked against merged code before creating work.

Updated 2026-09-28. This is a pressure test of the code and branch state, not a claim that the product is ready for real users. The [two-owner execution plan](beta-two-owner-execution-plan.md) is the implementation checklist; the [PRD](PRD.md) defines the beta behavior.

## What the partner should fetch

Use `codex/deployment-recovery` at the exact reviewed tip containing this audit. `origin/main` was `cc86af3` at the audit and does not contain the recovery work. Draft [PR #1](https://github.com/rachelgonsalves821/Sinaloa/pull/1) remains open; its description is older than the code. Do not assume a green GitHub run means Cloudflare accepted a Container rollout.

The local `codex/beta-auth-sdk`, `codex/beta-policy` and `codex/beta-scan` committed changes are patch-equivalent to commits already on `main`; they require no separate merge. The only remote feature branch with committed changes absent from `main` is `codex/deployment-recovery`. Older container, storage and original checkouts also hold uncommitted work. Preserve those worktrees; do not bulk merge or reset them. The only identified unique remnants relevant to this branch were a production signing-key placeholder guard and live R2 session-token forwarding, restored in the recovery branch during this audit.

Both owners should create their work branches from the same recovery tip and record its SHA. Before any merge to `main`, verify Cloudflare's current automatic build/deploy settings: the repository documents `main` as its production branch. Review and stage the combined result, then merge the exact accepted release commit.

## Pressure-test findings

| Gate | Current evidence | Owner in plan |
| --- | --- | --- |
| Shared multi-turn case | Native messages reach both inboxes, but proposal/action/receipt mutations can save only the actor's case. A reused case ID is not bound to the original pair. Both owners cannot yet rely on one outcome. | P1 |
| Cross-owner safe file | Upload/list/download are scoped to the uploader's inbox. Message `artifactRefs` do not grant the counterparty access. | P2 |
| Human control and admission | Pause is stored but is not enforced at all work boundaries; resume is missing. The application does not itself establish invite-only admission, required MFA, or the two-active-agent cap. A legacy declined invitation can still block a later direct send. | P3 |
| Verified authority | Agent-supplied authority and signature text can be stored; a human approval must come from authenticated server-side action, not an agent claim. | P1/P3 |
| Remote MCP client | The server has an authenticated `/mcp` foundation. OpenClaw's current bridge uses REST, with no remote MCP client path. Grok advertises read MCP tools to xAI, while replies use REST; tests inspect request shape rather than a real hosted tool call. The xAI bearer can expire late in a turn and has broader server scope than the tools shown to the model. | R2/P4 |
| Honest onboarding and file retry | UI checklist can confuse enrollment with presence and a processing receipt with completed collaboration. SDK upload reservation has no caller idempotency key, so a lost response can duplicate reservation/quota. | R1/R2 |
| Hosting and providers | The exact-head GitHub CI passed on the earlier `f56990e` recovery tip, while the Cloudflare branch preview failed. Docker CI checks packaging and rejection of missing production config, not healthy startup with real services. PostgreSQL, WorkOS, R2, scanner, MFA and Container entitlement remain live acceptance gates. | P5/P6/R4 |

The focused MCP, work-claim, frontend, SDK and bridge fixtures pass locally. Live-provider tests explicitly skip without credentials. This audit adds the previously omitted bridge suite to CI. A hosted two-human, two-agent, two-case exchange with restart, safe file, controls and MCP calls remains unproven.

## Handoff rule

This is a usable **development baseline** for parallel work, not a beta-complete release. The partner owns server, data and Cloudflare work (P1–P6); Rachel owns the browser, SDK, integrations and product acceptance (R1–R4). Freeze one shared server contract and fixture before parallel edits, then integrate and test on a staging commit. Do not merge to `main` merely to give the partner access: the branch is fetchable directly, and a `main` push may trigger production deployment.
