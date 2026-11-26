# Focused navigation extraction from PR #264

Status: Navigation-only candidate prepared for review. Final exact-commit CI and READY evidence are maintained in the draft PR and board #34. This ledger grants no integration approval.

Base: integration/agent-native 5b4d7c2941be4052564f12d02c4d5f304af76ffc.
Source: frozen draft #264, lane-b/inbox-navigation-fast, df01e525cfc7a76502eb353f2fb1d3bea43431a1. The original branch is not modified. Its recorded green CI 41366755582 and November 1 synthetic-browser observations in frontend/PERFORMANCE_HANDOFF.md are historical source evidence; they do not validate this extraction.

## Exact carry ledger

- frontend/src/internal-navigation.ts: copied from df01e525 (internalRoute, navigateInternal, INTERNAL_ROUTE_EVENT); extended here with replaceState support for canonical and refused history entries.
- frontend/src/workspace-switch.ts: copied from df01e525, unchanged at extraction (abort and latest-authorized-response coordination).
- frontend/test/internal-navigation.test.ts and frontend/test/workspace-switch.test.ts: copied unchanged from df01e525.
- frontend/src/App.tsx: navigation imports only; App route/popstate/click handling and retained Connect/Workspace mounts; WorkspaceApp route prop and reactive claim/authorization route rendering; workspaceSwitch reference and private-state cancellation; authorized selectWorkspace staging; defer requested section until selection succeeds; chooseInbox deferred section update; claim-to-app navigation; Manage agents selection callback; ClaimPage Back client navigation.
- Original App diff hunk old-line starts carried: 122, 167, 180, 523, 559, 581, 866, 985, 1013 (against 5b4d7c2). The original import hunk is reduced to the two navigation modules.
- Additional work here: selection intent guards across promise continuations and cancellation when choosing a section; pending/failure/stale-response regression coverage. Added app-navigation.ts and its regression suite for URL-backed inbox/section/folder/case intent, latest-selection commit, Back/Forward restoration, cancellation and refusal repair. Wired AppShell clicks and history events through that coordinator; direct loads select the URL inbox only from the authorized directory. Synthetic fixture and current browser findings are recorded in acceptance/navigation-local.md. The current synthetic browser sweep and required local checks pass; final exact-commit CI evidence is maintained in the draft PR.

## Excluded source

Do not integrate #264 wholesale after this candidate. The carried hunks/modules above would duplicate navigation work. Any later #264 remainder must remove/reconcile those changes and rebuild generated web from its own final source.

Excluded: initial-workspace and agent-inbox-cache modules/tests; early startup/directory overlap; provisional identifier storage; child prefetch/cache changes; backend/grant concurrency; split asset/build configuration; server and fixture changes; marketing/Astro/auth-link routing; staging acceptance/deployment recipes. No latency claim transfers to this candidate.

## Other owned candidates

PR #279 at 975954ab16d473172cabac0b60c7b209f5f4cdc6 remains separate. Its CaseWorkspace organization-ID label and case-viewer regression hunks are outside this extraction and must be retained at integration. Both candidates regenerate web/index.html; rebuild it after combining source, never merge generated output by hand.

PR #259 (codex/dots-workflow-closeout, observed ab8779f) remains with its Dots owner. Its App.tsx quick-connect import and EnrollmentDialog guidance hunks are outside these navigation hunks; no Dots content is carried or edited. Shared generated web/index.html similarly requires rebuilding. Recheck both PR heads before final handoff.

## Completion evidence

Current synthetic browser coverage and its limits are in acceptance/navigation-local.md; this does not inherit the old browser PASS. Focused history/switch tests pass, and all required local Lane B checks pass. Final local/CI results belong to the draft PR before READY. No merge, deployment, credentials, staging window or real-agent operation is required.

## Current source overlap audit

At the audit, #264 remains df01e525, #259 remains ab8779f434e030fd5199497036d9709049a7dc96, and #279 remains 975954ab16d473172cabac0b60c7b209f5f4cdc6. Both independent frontend source patches pass git apply --check against this navigation candidate. No conflicting source hunk was observed in #259 or #279. They remain separate candidates with unchanged owners/branches.

All three candidates change generated web/index.html. Combining them requires accepting the final combined frontend source and running npm run build; do not choose one PR's generated file and thereby discard another's source changes. The original #264 has intentional source overlap with this extraction: remove its carried navigation hunks/modules from any later remainder, retain the new history coordinator, and rebuild. No performance/backend/marketing acceptance from #264 transfers here.
