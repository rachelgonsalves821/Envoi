# Parallel client beta-readiness audit

Reviewed 2026-10-17 in the isolated `lane-b/phase-c-client-preflight` worktree, based on `264c3fc4426f3957145dd80ce5de0c9529a99cbd` plus preparation commit `02975a764ec09f520c1d09130ee771921cf442a5`. Integration was inspected at `984051fe09092ddbd71039908ee15f8d4b7b8e4f`; these branch results are not acceptance of that combined tree or a deployment.

This audit concerns Rachel/Codex's client paths only. No production behavior, Je-owned file, canonical fixture, provider profile, live runtime or old-case state is changed. The original case `case_0260691b187444b08368d1047ee317cb` must remain paused. No Phase C contract is invented or approved here.

## Coverage and outstanding proof

| Area | Existing executable client coverage | Additional regression in this task | Still required before beta acceptance |
| --- | --- | --- | --- |
| Sign-out and session recovery | `frontend/test/account-actions.test.ts`, `session-screens.test.ts`, `browser-session-recovery.test.ts`, `api.test.ts`: common sign-out rendering, retryable failure, expired session, late responses and account-change handling | Abort during CSRF identity recovery prevents replay; changed account with a newly rotated cookie still prevents a write | Actual hosted WorkOS sign-in/sign-out, cookie behavior and top-right control accessibility across desktop/mobile screens |
| Mutation replay safety | `api.test.ts`: bounded CSRF recovery, authorization/503 denial, expected-human headers and same-origin cookies | Instruction text, idempotency key, displayed account and exact encoded route survive one recovery unchanged; non-replayable FormData is never auto-retried | Server-side durable idempotency, changed-account denial and real concurrent-tab behavior on the final candidate |
| Owner separation | `case-viewer-perspective.test.ts`, `shared-case-human-view.test.ts`, `workspace-refresh.test.ts`, `local-human-journey.test.ts`: correct local/counterparty labels, missing-context fail-closed behavior, stale refresh cancellation and isolated local two-owner server journey | Account-change recovery regression also protects Done writes | Two genuinely separate hosted owner sessions; server cross-tenant denial and no wrong-owner cached data after sign-in/out |
| Done, folders and read state | `inbox-preferences.test.ts`, `workspace-refresh.test.ts`, `inbox-folder-dialogs.test.ts`, `history.test.ts`: personal archive semantics, filtered selection, refresh epochs, retained older history and dialog state | Existing race tests already exercise queued pre-Done refresh; no redundant replacement added | Real UI click, reload, paginated history and second-owner checks; canonical task state must remain independent of personal Done |
| Agent permissions and removal | `human-access.test.ts`, `agent-presence.test.ts`, `agent-installations.test.ts`, `agent-removal-dialog.test.ts`: management visibility, truthful presence, revoked presentation, destructive confirmation and busy/error handling | Both keep-history and delete-history choices reach the protected removal route with explicit body and expected-human/CSRF headers | Actual server freeze/removal durability, revoked-token denial, file/history retention/deletion isolation and human-confirmed destructive gate |
| Assets and human decisions | `api.test.ts`, `human-access.test.ts`, `conversation-timeline.test.ts`: protected action/download requests, unsafe download URL rejection and observer-only rendering | No speculative Phase C tools added | Real private scanned object access, wrong-owner denial, authoritative approval and case-completion receipts on Je's approved contracts |
| Onboarding and runtime availability | `agent-claim.test.ts`, `onboarding-connect.test.ts`, `quick-connect.test.ts`, shared contract consumption | No overlapping Phase B implementation added | Je's real-host Phase B results, hosted flags and actual Muse/Instinct supported connection plus closed-app wake evidence |
| Phase C gate records | `integrations/gates/phase-c/evidence.test.ts`: candidate consistency, typed artifact pins, all 24 rows, canonical timestamps, expected/actual summaries, separate recovery counts, missing approvals and no automated-to-hosted promotion | Bounded manifest reads and actual proof-file existence/type/size checks; realpath containment rejects junction escape without reading proof contents | Real observation contents, binary/hash verification, host scope, approval validity, Je's server evidence and human countersign |

These suites are a coverage inventory, not a numerical source-code coverage measurement. React static rendering and mocked requests do not prove that a browser interaction or server authorization succeeds. `local-human-journey.test.ts` starts a disposable local server; it is not hosted or real-agent evidence. CI and live results must be attached to their exact candidate, not copied forward from another branch.

## Execution and next ownership boundary

Focused new checks:

```powershell
npx vitest run --config vitest.config.ts frontend/test/beta-readiness.test.ts
npx vitest run --config integrations/vitest.config.ts integrations/gates/phase-c/evidence.test.ts
npm run typecheck
```

The suites operate on mocked fetch, private in-memory metadata and synthetic temporary evidence files. The offline inspector checks proof-file metadata but never opens proof contents. It does not send, fault, pause/resume, revoke, enroll, deploy or contact a provider. Supporting real proof remains outside tracked files. Full client regression commands remain those in the lane execution plan; record actual results separately rather than treating this inventory as a test report.

### Initial recorded local validation, 2026-10-17

| Command | Actual result |
| --- | --- |
| New `beta-readiness.test.ts` | 6 passed |
| New `evidence.test.ts` | 22 passed |
| `npm run typecheck` | Passed |
| `npm run test:frontend` | 350 passed |
| `npm run test:sdk:typescript` | 199 passed |
| `npm run test:integrations` | 288 passed, 1 skipped |
| `npm run test:sdk:python` | 6 passed |
| `npm run build` | Passed; no tracked generated-file changes |
| `git diff --check` | Passed |

Tests ran from PowerShell outside the Windows sandbox's known temporary-directory restrictions. These are local branch results with the new tests/tooling, not exact-head GitHub CI. Backend/PostgreSQL/container suites and hosted/real-agent checks were not rerun for this client-only audit. No observed result is copied into the blank gate manifest, and the existing integration skip is not converted into a pass.

### Additional evidence-hardening checkpoint, 2026-10-17 23:15 Toronto

The evidence suite now has 40 passing checks; evidence plus source-readiness checks total 46, and the separate beta mutation suite remains 6 passing checks. The full preparation-branch integration suite passes 306 with 1 existing skip; frontend350, typecheck and diff checks pass. These are this preparation branch's results, not the newer runtime task branches or their CI. Independent review identified SHA/hash coercion on malformed JSON types; explicit string checks and regressions now reject arrays, objects and other non-string digests without throwing or echoing inputs. Proof contents and runtime state remain uninspected.

The session/tools publication `15fff09` has since passed consuming review and received explicit implementation approval. The wake publication `269d969` has passed consuming review; its separate human implementation approval remains outstanding. See `EVIDENCE.md` for the dated task checkpoint rather than inferring that published fixtures are an implemented server. Real-host checks still require the combined exact candidate, accepted Phase B route evidence, matching artifacts and separate live-operation approvals. Preserve CSP/distribution workstream ownership.
