# Phase C: scoped tools, runtime collaboration and integration

Prepared 2026-10-17 against integration `7442248d16635c2256c11bf02dcaf493ca4fe039`.
Status: reviewable implementation plan for [v3 §§48–55](build-plan-v3.md); contracts and live gates remain to be approved and executed.

## Outcome

Two independently owned agents can collaborate across separate cases using small canonical snapshots and authorized tools. Their trusted hosts manage work leases and credentials. The server binds each model turn to its own case, counterparty, allowed actions and live lease. Owners see the resulting proposals, decisions, files and receipts and can stop access effectively.

Successful onboarding and a model-generated ACK do not complete this phase. Acceptance includes real negotiation, human decisions, safe files, interruptions and enforcement. Phase C does not add calendar/payment execution, group delivery, public discovery or a new conversation store.

## People and write ownership

| Area | Je with Claude — Lane A | Rachel with Codex — Lane B |
| --- | --- | --- |
| Primary responsibility | Server contracts, authorization, persistence, integration and server evidence | Trusted runtime/client integration, tools consumption, setup and owner experience, client evidence |
| Exclusive paths | `src/**`, `db/**`, `worker/**`, `scanner/**`, server `test/**`, `test/contract-fixtures/**`, `scripts/**`, deployment/root configuration and `handoffs.md` | `integrations/**`, `sdk/**`, `frontend/**`, generated `web/**` through build, client tests and runtime setup guides under the existing execution-plan ownership |
| Shared interface | Publishes schemas, errors, security semantics and executable fixtures; owns the only server route wiring | Reviews fixtures and reports exact expected/actual mismatches; consumes the approved contract without editing server fixtures |
| Integration | Sole integration lead; one writer at a time for `src/server.js`, root manifests and shared build scripts | Supplies reviewed task heads, compatibility results and regenerated client artifacts; requests root changes from Je |
| Human role | Je coordinates server-side operations/evidence with the existing release approvals | Rachel approves product/contracts/releases and her account consent; Codex executes her assigned technical work |

Keep `AGENTS.md`, `CLAUDE.md` and the human-owned execution plan unchanged. This document supplies task detail within that ownership. An individual delegated file must be named on the board before another lane edits it. The packaging/background workstream already claimed under `integrations/distribution/**` keeps that scope; C runtime work consumes it rather than rebuilding it.

## Entry and dependency rules

- Reconcile the current integration SHA, CI, B-local/hosted evidence and unresolved [Phase B completion tasks](phase-b-completion-plan.md). Preserve original gate results and countersigns.
- Phase C design and fixture-only scaffolding can run while Je finishes B. Dependent implementation waits for the relevant published contract, Lane B ACK and human approval. Hosted acceptance waits for accepted B onboarding on each route used in that gate.
- Muse/Instinct blockers remain visible with their B-R owners. A limited C gate for accepted routes is labeled with that scope; it cannot close full multi-host onboarding.
- Reuse the existing queue, lifecycle, idempotency, installation, policies, cases, assets and audit services. No parallel supervisor, registration engine or provider-only inbox.

## Work packages and merge order

| Wave / ID | Owner | Deliverable | Dependency and completion proof |
| --- | --- | --- | --- |
| 0 / C-A0 | Je | Inventory current case/tool/lease behavior; publish proposed `case-session-v1`, `case-tools-v1` and `http-wake-v1` contracts separately. Cover schemas, scopes, errors, idempotency, lease fences, expiry, limits, compatibility, flags and rollback. IDs are proposals until published. | Design can start now. Commit executable fixtures before consumers; get client ACK and human contract approval. |
| 0 / C-B0 | Rachel/Codex | Review contracts, identify affected Hermes/OpenClaw/xAI and SDK surfaces, and consume the shared fixtures in client tests. Prepare runtime test/evidence scripts. | Fixture-only scaffolding after publication; report `MISMATCH` with request, expected response, actual response and impact. No server patches. |
| 1 / C-A1 | Je | Mint server-bound short-lived CaseSessions only after a trusted authenticated work claim. Bind agent, installation, work, case, counterparty, tools, fence and expiry; validate on every read/write. | Approved session contract. Test wrong identity/tenant/case, stale fence, expiry, lease loss, work completion, case/agent pause and agent/installation revoke. PostgreSQL and FileStore parity. |
| 1 / C-B1 | Rachel/Codex | Host-only claim/renew/ack/complete/fail, credential refresh, reconnect and presence; private CaseSession transport and cancellation of invalidated turns. | C-A1 fixtures approved. Prove model output cannot renew or settle leases and contains no operational token; restart/lost-response/expiry recovery preserves identity and fencing. |
| 2 / C-A2 | Je | Implement bounded canonical snapshot and reply tools with session-derived case/recipient, durable idempotent effects and typed errors. | C-A1 integrated. Reject supplied recipient/case overrides, duplicate conflicting keys, inaccessible state and oversized reads; replay identical writes safely. |
| 2 / C-B2 | Rachel/Codex | Typed SDK/tool client and snapshot-first execution; isolate simultaneous cases and tool contexts. Preserve temporary fallback only for explicitly supported older clients. | C-A2 fixtures approved. Test two cases with the same counterparty plus another owner; no history/recipient bleed or hidden fallback after authorization denial. |
| 3 / C-A3 | Je | Proposal, decision, authority and human-request tools over current case/policy services. Revalidate current authority and owner decisions; audit all effects. | C-A2 integrated. Human approval required where policy says so; expired/changed/rejected grants fail; no unsupported external execution is enabled. |
| 3 / C-B3 | Rachel/Codex | Real Hermes, OpenClaw and xAI/Grok adapter adoption: small turn instruction, snapshot, typed actions, safe resume after a human decision. Owner UI shows canonical pending decisions/results. | C-A3 fixtures approved. Tool sequences and actual runtimes prove proposal/counterproposal/accept/reject; identify exact xAI product/runtime rather than assuming consumer-app support. |
| 4 / C-A4 | Je | Asset list/share and case-completion tools with current case grants, private object storage, scan/quota/hash checks and canonical outcome receipt. | C-A3 plus existing asset contract. Deny unscanned/infected/ungranted/wrong-tenant files and stale sessions; distinguish work settlement from case completion. |
| 4 / C-B4 | Rachel/Codex | Asset and completion client flow, clear owner projections, and tests for share/download/deny and final outcome receipts. | C-A4 fixtures approved. Both owners see the same canonical artifact/outcome; a processed work item cannot falsely mark the case finished. |
| Parallel / C-A5 | Je | One generic HTTPS wake adapter: challenge, signatures, replay protection, opaque references, public-address validation, DNS pinning/rebinding defenses, redirect rejection, timeouts/size/rate limits and bounded durable retry. | Separate approved wake contract. Can develop alongside waves 1–4 without a competing `server.js` writer. Supplies Phase B B-R8; do not create another webhook delivery engine. |
| Parallel / C-B5 | Rachel/Codex | Trusted reference receiver and host adapter for opaque wake → authenticated canonical fetch → scoped tool execution. Provider-specific clients consume that boundary where the actual provider supports it. | C-A5 fixtures approved. Test signature/replay/duplicate/outage/restart and private storage; actual hosted receiver evidence before route availability claims. No assumption that Muse/Instinct accepts arbitrary callbacks. |
| 5 / C-A6 | Je | Assemble one reviewed integration candidate, server-side flag rollout/rollback, combined CI and hosted evidence worksheet. | All accepted server/client task heads integrated in dependency order; clean rebuild and exact SHA. |
| 5 / C-B6 | Rachel/Codex | Run client suite, artifact/source hash comparison, real runtime/tool checks and owner browser journey on C-A6's candidate; review evidence. | One matching release/connector set. Human-approved live operations and countersign. Report provider/route scope and every remaining failure. |

Do not build speculative providers before B-R5/authorization review establishes their supported interface. Rachel/Codex can work on SDKs and runtime adapters while Je implements server tools; Je can work on HTTPS wake while a client migration is being verified, provided shared-file writes are serialized.

## Contract details both lanes must agree before coding

1. **Session custody and scope:** how the trusted host obtains and privately binds short-lived scope to the model tool channel; the model never receives the installation refresh credential. Define exactly which context/tool handles the runtime can expose safely.
2. **Authorization on every operation:** server-derived case and counterparty; allowed tool set, fence, expiry and current owner/installation/agent/case controls. Read-only snapshot access must not outlive a revoked scope.
3. **Canonical idempotency and ordering:** stable operation keys across uncertain network results, conflicting-reuse errors and atomic effect/audit persistence. Clarify which writes create work, when a turn may complete and how a late model result is rejected.
4. **Snapshot limits:** objective, participants, status, recent relevant events, proposal, authority, allowed actions, assets and requested response with explicit size/pagination bounds. Inbound content remains untrusted data.
5. **Control changes mid-turn:** cancellation and terminal/retryable error mapping, lease renewal failure, paused work accounting and exact resume/reclaim behavior. Never route an authorization failure through a privileged compatibility fallback.
6. **Approval and completion semantics:** explicit human authorization, changed/expired policy handling, case outcome receipt versus per-message processing receipt, and no fabricated completion when tools fail.
7. **Compatibility and rollout:** supported legacy adapter behavior, flag defaults, server-published availability, connector minimum/version hashes, coordinated upgrade and rollback that cannot resurrect revoked access.

## Phase C hosted acceptance matrix

These are proposed acceptance rows for this phase, not the old Phase A 23-row test. Je produces server/owner evidence; Rachel/Codex produces runtime/tool/browser evidence. Both review the same run.

| Rows | Scenario | Required result |
| --- | --- | --- |
| C01–C03 | Fresh real runtime scope, bounded snapshot, two simultaneous cases | Correct identity/installation/fence; minimal canonical state; no cross-case or cross-owner data. |
| C04–C06 | Typed reply, duplicate/lost response, conflicting key or recipient override | One canonical effect on safe replay; conflicts/overrides rejected; recipient derived from server scope. |
| C07–C09 | Multi-turn proposals/counterproposals, acceptance/rejection, human approval | Policy checked at action time; owner decision persisted; model cannot bypass it or execute unsupported actions. |
| C10–C12 | Clean asset share, quarantine/infected/missing grant denial, outcome completion | Private checksummed clean artifact visible only to authorized parties; canonical case receipt distinct from work receipt. |
| C13–C15 | Runtime restart/offline work, dropped wake/SSE/poll recovery, retry/fence race | Same authorized identity, durable work, one canonical output, stale runner denied. Evidence separates model invocation count from persisted effects. |
| C16–C18 | Case/agent pause in flight, lease/session expiry, installation/agent revoke in flight | Scope invalidated promptly; no new authorized tool action or late settlement; held work resumes only under valid control state. |
| C19–C21 | HTTPS challenge/signature/replay, SSRF/DNS/redirect protections, duplicate/missed callback | Verified public endpoint, opaque payload, authenticated fetch, bounded retry and no duplicate canonical effect. |
| C22–C24 | Owner views and sign-out/CSRF, cross-tenant denial, compatibility/rollback and artifact agreement | Both owners see their correctly attributed cases/files/decisions; isolation and session controls work; exact artifact versions and explicit rollback evidence. |

Run the shared applicable matrix for real Hermes and OpenClaw, with xAI/Grok's scoped MCP/API acceptance recorded separately for the actual available runtime. Each additional advertised host consumes the same contract and adds real host-specific evidence. Generic HTTPS receiver tests prove the adapter, not automatic Muse/Instinct availability. Their closed-app results remain required in the Phase B host matrix.

For each row record candidate SHA, artifact hashes, runtime/version, host route, case/work/operation identifiers, timestamped result, expected versus actual, request/receipt/audit references and redacted owner evidence. Keep credentials private. Test-output summaries alone do not prove model effects, human controls or hosted behavior.

## Integration procedure and stopping points

1. Each task claims disjoint paths on board #34 and uses its own branch/worktree from current integration. Je checks for concurrent Phase B work before assigning shared server, helper or frontend files.
2. Je publishes versioned contracts/fixtures; Rachel/Codex ACKs or reports mismatches; Rachel approves contracts. This planning PR does not itself approve API schemas.
3. Implement server and client tasks against those fixtures. Run focused authorization/recovery tests and the applicable lane suite. Generated bundles are rebuilt by the owning client branch; no hand-merging of generated files.
4. Open draft task PRs into `integration/agent-native`. Je integrates only reviewed green heads after the current gate freeze permits it, resolves shared conflicts once, rebuilds and runs both lanes plus PostgreSQL/container CI on the resulting SHA.
5. Obtain the existing release approval for that exact candidate, deploy staging once and freeze it. Install its matching clients and capture fresh owner/provider preflight. Do not change code or configuration mid-gate.
6. Run the agreed hosted matrix with approvals before each new live send/fault or destructive step. Local/mocked success, diagnostic passes on different binaries and historical human waivers retain their labels.
7. If code changes, create and validate a new candidate and rerun the full applicable gate. Publish exact-SHA evidence and human countersign before enabling the new route/tools for beta.

Keep the original paused case `case_0260691b187444b08368d1047ee317cb` paused. Use fresh disposable identities/cases where destructive tests require them; no existing revoked test identity is silently re-enrolled.

## Product beta exit alongside Phase C

Je owns server/operations proof for database isolation, private R2/scanning, backup/restore, queue/dead-letter monitoring, readiness/capacity and rollback. Rachel/Codex owns the browser checks for owner separation, current permissions, sign-out/CSRF, folders/Done, files, approvals and truthful connection state, reporting unsupported backend controls rather than simulating them. These checks reuse existing product tests and runbooks; they do not create duplicate implementations.

Rachel chooses the invited host cohort from verified rows and approves the release. The full onboarding objective stays open until Muse, Instinct and the other named hosts satisfy their connection/wake requirements or she explicitly changes that scope. Phase D discovery/A2A remains later work over the same canonical system.
