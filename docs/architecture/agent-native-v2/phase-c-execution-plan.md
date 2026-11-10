# Phase C: scoped tools, runtime collaboration and integration

Original design prepared 2026-10-17 against integration `7442248d16635c2256c11bf02dcaf493ca4fe039`; documentation reconciled 2026-11-10 at pjsk02's request.
Status: implementation/acceptance specification for [v3 §§48–55](build-plan-v3.md), not a fresh task list. **Use [CURRENT-CLOSEOUT.md](../../../integrations/gates/phase-c/CURRENT-CLOSEOUT.md) for the only current remaining-work checklist, completed observations and source-impact rules.** Core contracts and original implementation are already integrated; current-source regression/hosted closeout remains open.

**Reconciliation 2026-10-23 (integration `d05498d`; see [`contract-status.md`](contract-status.md)).** The C-A0 contracts (`case-session`, `case-tools`, `http-wake`) are approved with exact approvals, and C-A1 to C-A6 are integrated (C-A6 at `f3a71f6`); the text below was written before that and is kept as the plan. The hosted C01–C24 acceptance, new-host Phase C acceptance and the Stage A batch are separate human-run gates and are not established here. The accepted Hermes/OpenClaw B/C record is not reopened. Phase D stays with Rachel.

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
| Human role | pjsk02 is the sole approver under the governing build plan; Je coordinates server-side operations/evidence | Rachel supplies her own account consent and assigned workstream evidence; Codex follows Lane B ownership |

`AGENTS.md`, `CLAUDE.md` and the governing execution plan remain human-owned; the 2026-11-10 user-requested documentation reconciliation does not delegate implementation paths or release authority. This document supplies task detail within that ownership. An individual delegated implementation file must be named on the board before another lane edits it. The packaging/background workstream already claimed under `integrations/distribution/**` keeps that scope; C runtime work consumes it rather than rebuilding it.

## Entry and dependency rules

- Reconcile the current integration SHA, CI, B-local/hosted evidence and unresolved [Phase B completion tasks](phase-b-completion-plan.md). Preserve original gate results and countersigns.
- Phase C design and fixture-only scaffolding can run while Je finishes B. Dependent implementation waits for the relevant published contract, Lane B ACK and human approval. Hosted acceptance waits for accepted B onboarding on each route used in that gate.
- Muse/Instinct blockers remain visible with their B-R owners. A limited C gate for accepted routes is labeled with that scope; it cannot close full multi-host onboarding.
- Reuse the existing queue, lifecycle, idempotency, installation, policies, cases, assets and audit services. No parallel supervisor, registration engine or provider-only inbox.

## Work packages and merge order

This is the original implementation breakdown. C-A0 contracts and C-A1–C-A6 were already approved/integrated as recorded in the October 23 reconciliation above. Selected C-B1–C-B5 source was included through #143, with later fixes carried by later compositions; see [historical inclusion records](../../../integrations/gates/B-C-CLOSEOUT.md#baseline-and-accepted-work). Do not reimplement these rows or reapply constituent PRs. C-B6's historical acceptance stays accepted; only the current deltas and final joins in CURRENT-CLOSEOUT are open.

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

This is the requirement reference for the phase, not an unchecked list of 24 new tests. Historical accepted B/C evidence and later completed observations stay credited. The current closeout maps only remaining assertions to these rows. Je produces server/owner evidence; Rachel/Codex produces runtime/tool/browser evidence. Both review the exact current profile and any explicitly carried evidence with its original provenance.

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

Reconcile the shared applicable requirements for real Hermes and OpenClaw using preserved accepted evidence plus justified changed-source checks under L5. Do not repeat the full matrix merely because a later step failed. xAI/Grok's scoped MCP/API acceptance is recorded separately for the actual available runtime. Each additional advertised host consumes the same contract and adds real host-specific evidence; an unaccepted host is not silently added to this scoped closeout. Generic HTTPS receiver tests prove the adapter, not automatic Muse/Instinct availability. Their closed-app results remain separate Phase B host requirements.

For each row record candidate SHA, artifact hashes, runtime/version, host route, case/work/operation identifiers, timestamped result, expected versus actual, request/receipt/audit references and redacted owner evidence. Keep credentials private. Test-output summaries alone do not prove model effects, human controls or hosted behavior.

## Integration procedure and stopping points

1. Each task claims disjoint paths on board #34 and uses its own branch/worktree from current integration. Je checks for concurrent Phase B work before assigning shared server, helper or frontend files.
2. Lane A publishes versioned contracts/fixtures; Lane B ACKs or reports mismatches; pjsk02 approves contracts. Reuse existing approvals for unchanged contracts. This documentation does not approve API schemas.
3. Implement server and client tasks against those fixtures. Run focused authorization/recovery tests and the applicable lane suite. Generated bundles are rebuilt by the owning client branch; no hand-merging of generated files.
4. Open draft task PRs into `integration/agent-native`. Je integrates only reviewed green heads after the current gate freeze permits it, resolves shared conflicts once, rebuilds and runs both lanes plus PostgreSQL/container CI on the resulting SHA.
5. Obtain the existing release approval for that exact candidate, deploy staging once and freeze it. Install its matching clients and capture fresh owner/provider preflight. Do not change code or configuration mid-gate.
6. Run the agreed hosted matrix with approvals before each new live send/fault or destructive step. Local/mocked success, diagnostic passes on different binaries and historical human waivers retain their labels.
7. If code changes, validate the new candidate and record its row/host impact under [build-plan L5](claude-codex-build-plan.md#5-loop-rules). Preserve unaffected observations; repeat only invalidated assertions unless the complete applicable scope was invalidated or the human requires a fresh full gate. Bind new observations to the exact selected profile and label carried evidence honestly. Final hosted acceptance and any beta enablement still require the appropriate human countersign/release authority.

Keep the original paused case `case_0260691b187444b08368d1047ee317cb` paused. Use fresh disposable identities/cases where destructive tests require them; no existing revoked test identity is silently re-enrolled.

## Product beta exit alongside Phase C

Je owns server/operations proof for database isolation, private R2/scanning, backup/restore, queue/dead-letter monitoring, readiness/capacity and rollback. Rachel/Codex owns the browser checks for owner separation, current permissions, sign-out/CSRF, folders/Done, files, approvals and truthful connection state, reporting unsupported backend controls rather than simulating them. These checks reuse existing product tests and runbooks; they do not create duplicate implementations.

pjsk02 approves the invited cohort and releases; each owner supplies personal consent where required. Full additional-host onboarding remains separately open until its connection/wake requirements pass or the human explicitly changes scope. Dots/public publishing, Grok/Muse/Instinct breadth, general production operations and Phase D interoperability do not reopen this scoped Hermes/OpenClaw closeout. Preserve the original product exit requirements in their own tracks.
