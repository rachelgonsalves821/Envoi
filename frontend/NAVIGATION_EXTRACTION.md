# Focused navigation extraction from PR #264

Status: IN PROGRESS. This is not a READY receipt or an integration approval.

Base: integration/agent-native 5b4d7c2941be4052564f12d02c4d5f304af76ffc.
Source: frozen draft #264, lane-b/inbox-navigation-fast, df01e525cfc7a76502eb353f2fb1d3bea43431a1. The original branch is not modified. Its recorded green CI 41366755582 and November 1 synthetic-browser observations in frontend/PERFORMANCE_HANDOFF.md are historical source evidence; they do not validate this extraction.

## Exact carry ledger

- frontend/src/internal-navigation.ts: copied from df01e525, unchanged at extraction (internalRoute, navigateInternal, INTERNAL_ROUTE_EVENT).
- frontend/src/workspace-switch.ts: copied from df01e525, unchanged at extraction (abort and latest-authorized-response coordination).
- frontend/test/internal-navigation.test.ts and frontend/test/workspace-switch.test.ts: copied unchanged from df01e525.
- frontend/src/App.tsx: navigation imports only; App route/popstate/click handling and retained Connect/Workspace mounts; WorkspaceApp route prop and reactive claim/authorization route rendering; workspaceSwitch reference and private-state cancellation; authorized selectWorkspace staging; defer requested section until selection succeeds; chooseInbox deferred section update; claim-to-app navigation; Manage agents selection callback; ClaimPage Back client navigation.
- Original App diff hunk old-line starts carried: 122, 167, 180, 523, 559, 581, 866, 985, 1013 (against 5b4d7c2). The original import hunk is reduced to the two navigation modules.
- Additional work here: selection intent guards across promise continuations and cancellation when choosing a section; pending/failure/stale-response regression coverage. History restoration beyond the original top-level route handling remains to finish and verify.

## Excluded source

Do not integrate #264 wholesale after this candidate. The carried hunks/modules above would duplicate navigation work. Any later #264 remainder must remove/reconcile those changes and rebuild generated web from its own final source.

Excluded: initial-workspace and agent-inbox-cache modules/tests; early startup/directory overlap; provisional identifier storage; child prefetch/cache changes; backend/grant concurrency; split asset/build configuration; server and fixture changes; marketing/Astro/auth-link routing; staging acceptance/deployment recipes. No latency claim transfers to this candidate.

## Other owned candidates

PR #279 at 975954ab16d473172cabac0b60c7b209f5f4cdc6 remains separate. Its CaseWorkspace organization-ID label and case-viewer regression hunks are outside this extraction and must be retained at integration. Both candidates regenerate web/index.html; rebuild it after combining source, never merge generated output by hand.

PR #259 (codex/dots-workflow-closeout, observed ab8779f) remains with its Dots owner. Its App.tsx quick-connect import and EnrollmentDialog guidance hunks are outside these navigation hunks; no Dots content is carried or edited. Shared generated web/index.html similarly requires rebuilding. Recheck both PR heads before final handoff.

## Remaining completion evidence

Finish and test Back/Forward restoration of authorized inbox/section/folder/case, direct links/refresh, pending navigation interrupted by another route, query-handle reactivity, and failed/denied history transitions. Run a current synthetic local browser journey (do not inherit the old browser PASS). Then run all build-plan Lane B commands, npm run build, clean generated-file checks, final exact-head CI; open the focused draft and post READY only after that evidence passes. Record any actual source conflict precisely. No merge, deployment, credentials, staging window or real-agent operation is required.
