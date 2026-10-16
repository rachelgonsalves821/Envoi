# Phase B client implementation checkpoint

Prepared 2026-10-16. Task: B-4 onboarding, Lane B.
Branch: `lane-b/B-4-onboarding-plan`.
Base and rollback reference: `2b18170d59b0096ff997d9a79487d50ccb627ef9` (latest fetched `origin/integration/agent-native` at this checkpoint).
Worktree: `C:/Users/KAILASH/.codex/worktrees/phase-b-onboarding/Sinaloa`.

## Gate and authoritative inputs

**BLOCKED B-4 implementation: human Phase A countersign pending.** Since the initial claim, Lane A published [GATE GA PASS on human attestation](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6226642223) for `2b18170d59b0096ff997d9a79487d50ccb627ef9` and [draft #98 @9793e07](https://github.com/rachelgonsalves821/Envoi/pull/98). Its record explicitly says 23/23 rows are human-attested, no row-level server observations are independently cited on this SHA, and the human countersign is missing. Lane A requests the countersign plus confirmation of the closing-run Builds freeze and test-agent identity. This agent does not supply that countersign or convert attestation into observed test evidence. The human-confirmed corrections remain accepted; no new hosted run is requested. Full CI alone cannot satisfy the hosted gate. #98 also prepares the existing contract approval annotation correction, with no wire change; it has not been merged into this base.

Read [AGENTS.md](../../AGENTS.md), the [governing build plan](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md), current handoffs and canonical fixtures. Read both preparation files directly at PR #96 head `f29f885dd0c949c0b1413fb406d10ce5dc85742c`, without merging that PR:

- [Phase B implementation queue](https://github.com/rachelgonsalves821/Envoi/blob/f29f885dd0c949c0b1413fb406d10ce5dc85742c/integrations/onboarding/PHASE-B-IMPLEMENTATION.md).
- [Phase A closeout handoff](https://github.com/rachelgonsalves821/Envoi/blob/f29f885dd0c949c0b1413fb406d10ce5dc85742c/integrations/gates/PHASE-A-CLOSEOUT-2026-10-16.md).
- [Lane B claim and Lane A closeout request](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6226579598).

Contract inputs are already approved: `agent-registration` v1 revision 3 @`4da219e7156138c94e26b8105efe7ffe43ec6f98`, `a3-pause-auth` v3, `a4-wake` v2 and `a5-presence` v1. [Revision-3 ACK](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134589212) and [human approval](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134778271) stand. Stale published/await-approval prose is a Lane A annotation reconciliation request, not a reason to request approval again. Registration fixture bytes on this base match the approved publication (`git diff 4da219e HEAD -- test/contract-fixtures/agent-registration` is empty).

This checkpoint is planning and review only. Once Lane A records the gate and the human countersign exists, start client implementation against canonical fixtures in parallel with A-4.x. Endpoint availability blocks real-service validation, not fixture-driven client implementation after that gate. Keep package publication, offered routes and actual access behind their own checkpoints.

## Parallel implementation and file ownership

The following are proposed file boundaries, not wire changes. Before assigning writers, create a separate worktree and task branch from the then-latest integration for each, record its base SHA, and reserve disjoint files. Read-only helper and UI reviews informed this plan; the lead independently reruns tests and verifies their findings.

| Task / writer | Reserved paths | Deliverable |
| --- | --- | --- |
| B-4.1 helper | `integrations/onboarding/envoi-link.mjs`, new `helper/{state,store,transport,output,confirmation}.mjs`, new helper tests under `integrations/onboarding/test/`, onboarding `package.json` | Private registration/confirmation/activation journal and bounded recovery; safe status/doctor projection; update the package's explicit files list |
| B-4.2 UI | New `frontend/src/onboarding/{types,api,claim-state}.ts`, `{ClaimPage,OwnerClaims,AgentInstallations}.tsx`, claim-specific CSS, new `frontend/test/agent-claim*.test.ts` and `agent-installations*.test.ts` | Typed-code claim, new/existing targets, permissions, recent approvals and withdrawal, installation list/revoke/reconnect |
| B-4.3 connect content | New `frontend/src/onboarding/ConnectPage.tsx`, connect-specific CSS/tests, `integrations/onboarding/skill/**`, `host-plan.mjs` and its existing tests | Public route-aware connect guidance, skill/heartbeat/manifest content and host capability selection |
| Runtime integration | `integrations/connector/**`, necessary Hermes/OpenClaw adapter files and their tests | Adopt an activated credential session into the existing connector lifecycle and runtime bridge |
| Lead, serialized | `frontend/src/App.tsx`, `frontend/src/api.ts`, shared stylesheet imports, any necessary shared SDK exports/types, root `vitest*.config.ts` and `vite.config.ts`, generated `web/**` | Session/route wiring, additive error metadata, Advanced Quick Connect, assembled build and verification |

No writer may edit another reservation concurrently. The helper store can use the existing store's patterns, but changes to `integrations/connector/store.ts` belong to the runtime writer. Agree the helper-to-runtime private session handoff locally before starting; do not add bootstrap fields to the operational `ConnectorSession`. Optional shared registration SDK transport belongs to the lead if reuse actually requires it. Do not add a root dependency for convenience.

## B-4.1 helper sequence and recovery

1. Validate the canonical origin and host capabilities. Obtain private storage and an exclusive process lock before handling secrets. Reject unsafe/symlinked directories and malformed state without dumping it. Read `GET /api/onboarding/routes`; offer only server-available `local_helper` and `envoi_link`. Never infer availability from flags, catalogs, brands or a successful old connection.
2. Resume an existing private session or saved registration before creating anything. Registration creation is explicitly **not idempotent**: losing its response may require another creation; the orphan expires with no operational rights. Persist a received registration response before exposing the safe claim projection. Do not invent a server idempotency header or recovery lookup for creation.
3. Poll the saved registration using its bootstrap bearer only on registration status and activation. Honor `pollAfterSeconds`, rate-limit metadata, deadlines and bounded backoff. Re-display a code only on an explicit human request while pending and unexpired. Never put the code in the claim URL, query, fragment or analytics.
4. Approved polling enters `CONFIRMING`. Display the server-derived masked approver email, workspace, agent name/address and mapped permission summary. Prefer a native host prompt. Tool/model-mediated confirmation is advisory and must wait for the human's explicit answer. Bind confirmation to those approval details; require it again if they change. Decline/no answer by activation expiry deletes bootstrap state without activation. There is no bootstrap-authenticated decline endpoint.
5. After confirmation, durably persist one activation ID, the exact activation request and an unresolved-attempt record before sending. Retain the same ID/request across timeout, network/5xx failure and restart. A different ID after commit can revoke the installation as activation replay. Budget retries conservatively from the earliest possibly committed attempt; stop before the recovery window can end.
6. Validate activation success, then atomically commit operational credentials with a private local completion marker before deleting bootstrap/activation state. Keep a journal/session reconciliation rule: matching committed credentials take precedence over an uncleared activation journal. A failed save preserves recovery state and must not report connected.
7. On uncertain exhaustion, poll once before abandoning activation. Activated/tombstone means the identity exists and the owner reconnects it. Token-invalid while unresolved selects `check_owner_agents`; never assume existence or auto-register. Map definitive errors by the approved surface/state policy, preserving the distinction between invalid-body/update-helper and a consumed/ended activation. Do not erase recoverable state on a transient failure.
8. Activation remains `ACTIVATING` until authenticated `GET /api/agent/status` succeeds. A paused attachment stays paused. Start existing refresh/wake/lease/settlement machinery with operational credentials only. Revocation stops actions and late settlement without automatic enrollment.

Private persistence must provide whole-file atomic replacement plus tested durability barriers before activation send and before bootstrap deletion. Existing `integrations/connector/store.ts:privateJson` writes a temporary file and renames it but does not call `sync`; copying it alone does not establish crash durability. Reuse account-only Windows ACLs, absolute system-helper paths, POSIX modes, exclusive locks and stale-lock handling. Establish supported platform write/rename/flush behavior with fault injection. Never claim power-loss durability that the platform cannot establish.

Only the 17 keys in `schemas.json/x-model-visible` may reach model-facing stdout/tool/chat output. Keep bootstrap/operational tokens, activation and internal IDs/UUIDs, headers, raw server dumps and storage paths private, including stderr. Permission wording comes from `x-permission-labels`; connected and closed-app reachability remain separate. Limits/deadlines come from the approved schema tables, not a second fixture copy or invented server rule. If a bundled client contract table is needed, derive it from the canonical source through an owned build step requested from Lane A.

## B-4.2 claim and installations UI

Use the existing `frontend/src/api.ts:request` transport for browser mutations: same-origin session, configured CSRF cookie/header, expected-human header, session-generation abort, bounded CSRF recovery and account-change handling remain in force. Add error metadata support without bypassing those checks. Current `ApiError` construction drops top-level `reason`, `requestId`, `retryAfterSeconds` and the `Retry-After` header; canonical `claim-attempts-exhausted` requires disabling entry for its 840-second retry interval. This is a client implementation gap, not a server MISMATCH.

The existing permission selector exposes four permissions and drops `use_email_transport`. Use contract-specific requested/grantable permission values for all five registration permissions. Effective rights are requested intersected with granted and organization maximum, plus required receive rights; the response remains authoritative. Never treat requested runtime metadata or delivery capabilities as independently verified facts.

`/claim` retains its clean route through the existing sign-in return path. The owner types the code, reviews lookup details, chooses an eligible new/existing target and explicitly submits approve/reject. Preserve the exact body for uncertain decision retries; approval replay can occur after activation. Do not change a decided target implicitly. On stale replacement, reload installations and ask the owner to confirm the revised target. For existing agents, use the newest active installation as `replacesInstallationId` or null; explain that activation replaces all earlier active installations, and that approval alone leaves the existing installation working.

Show pending activation, activation deadline, expiry and neutral withdrawn/no-longer-valid approval accurately. Recent claims support co-manager attribution and withdrawal of every manageable approved entry, not only `approvedByMe`. Activated claims link to their agent. List every active legacy installation before the server-bounded ended entries; never cap the active list. Route/mode/runtime are declarations. Credential-family active/ended is distinct from a5 presence. Keep existing a5 agent/connection labels, including paused plus needs reconnect and missing/unknown status.

Installation revoke ends only that installation, preserving identity/address/cases/history and allowing a new registration to attach. Agent-wide freeze/revoke remains distinct; frozen identities cannot use registration reconnect. Keep their legacy re-onboarding under Advanced. No browser approval or open tab synthesizes presence.

## B-4.3 runtime and connect boundaries

`setupConnection` currently consumes a legacy enrollment handoff and calls `enrollConnector` (`POST /api/agent-enroll`). Add a deliberate activated-session completion path; do not fabricate an enrollment token or redeem one again. Reuse `adapterFor`, discover/preflight/configure/createBridge, `FileBridgeStore`, `InstalledConnection`, `startConnection` and the existing lifecycle. Keep refresh IDs, inbox-keyed cursor persistence, SSE/delta recovery, independent safety polling and settlement fences intact. Use stub adapters for fixture checks; no real runtime launch is part of this checkpoint.

The public page, helper, skill and manifest consume `GET /api/onboarding/routes` and fail closed on unavailable/invalid snapshots. Keep Quick Connect under Advanced. Core v1 supports local helper and separately offered authenticated REST, both with envoi_link; this milestone implements Hermes/OpenClaw local helper only. Do not expose REST merely because the client catalog knows it. Remote OAuth/provider routes, new on-demand labels and Phase C/D remain outside scope. Unavailable routes must not become selectable. Host name or activation success never proves closed-app wake.

## Canonical fixture validation matrix

Consume [the registry](../../test/contract-fixtures/index.json) and source JSON through existing loaders, without copies. The future tests must drive real client components with fixture responses, not only schema-validate duplicated expected objects.

| Boundary | Canonical fixtures / checks | Expected client result |
| --- | --- | --- |
| Routes | routes-disabled / available / available-rest, feature-disabled, rollback | Only available supported route/mode offered; malformed/unknown availability fails closed |
| Pending registration | registration-created / pending / expired / rejected / withdrawn, bootstrap no-access probes | Saved private state, timed poll, bounded safe claim output; bootstrap never used for agent operations |
| Confirmation | registration-approved, changed details, native/advisory prompt, decline/deadline | Correct approver/workspace/agent/permissions; zero activation without applicable explicit consent |
| Activation recovery | activation-created / recovered / server-error / token-invalid-unresolved / recovery-expired / after-recovery-window / invalid / replay | Exact request/ID recovery; correct guidance; no duplicate registration; no credentials printed |
| Crash points | Before send; lost committed response; failed session save; committed session before cleanup; simultaneous helper; corrupt/stale state | Stable activation ID; commit precedes cleanup; matching session wins; no unsafe overwrite |
| Claim decisions | lookup, approve-new/existing, wrong-code, reject, approve/reject replay and replay-after-activation | Typed matching code, correct permission/target body, replay exact request, approval is not connection |
| Claim failures | attempts-exhausted, forbidden, not-admitted, auth-unavailable, account-changed, stale, quota/address/not-reconnectable | Deadline disables guesses; session reload/reauth or allowed retry; no invented target/quota behavior |
| Claims and installs | owner-claims, withdraw/replayed/not-found, owner-installations/legacy-several/frozen, revoke/not-found, reconnect-after-installation-revoke | Co-manager actions, every active legacy row, distinct end reasons, preserved identity and paused state |
| Operational lifecycle | a3 paused/revoked/expired and refresh recovery; a4 stream/control/delta/claim-hint cases | Existing lifecycle/cursors/retry/settlement; no claims while paused or calls after revoke |
| Presence/output | a5 owner/agent fixtures; registration x-model-visible; legacy addresses | Exact conservative labels; allowlist output only; authenticated status before connected; wake remains unproven |

Tests inject transport, storage, confirmation, clocks and crashes. No real Envoi requests, hosts, provider credentials or live messages. Once A-4.x endpoints exist, run corresponding local real-service cases on one exact integration SHA and report actual expected/observed MISMATCHs through #34. Hosted Hermes/OpenClaw acceptance and route enablement require the human checkpoint.

## REQUEST lane-a and next action

1. Lane A has published the closeout record/result in #98 (linked above). The next prerequisite is the human countersign on that stated basis, including the requested freeze and test-agent confirmations; Lane A then records the formal gate completion on #34. No repeated contract approval or invented PASS rows.
2. Reconcile stale contract approval annotations. Continue A-4.1 foundation, A-4.2 registration/claim and A-4.3 activation/recovery against the unchanged fixtures, default flags off. Publish endpoint readiness per task so Lane B can schedule real-service validation.
3. Public route wiring: support `GET/HEAD /claim` and `/connect` using the built frontend entry with existing nonce/CSP/cache handling. Current static entry routing accepts `/` and `/web/**` (plus robots/sitemap), not these paths. Serve reviewed `/connect/SKILL.md`, `/connect/HEARTBEAT.md` and `/connect/skill.json` from the initial response with correct content types. Derive offered manifest values from route availability, preserving the catalog/offer distinction. Lane B supplies content; Lane A owns route binding/security tests. Do not enable unavailable routes.
4. Root build/package changes, if needed, belong to Lane A (`scripts/**`, root package files). Request an exact diff after module layout and helper bundling are settled; no speculative root dependency change is needed for planning.

Next session: fetch origin, read #34, verify the exact ledger/result/countersign, then rebase clean task branches on latest integration. If the gate is still pending, keep production code blocked and only continue independent contract/planning review. After it passes, delegate the disjoint helper/UI/content/runtime writers above, consume fixtures while Lane A implements endpoints, verify independently and open draft PRs into integration/agent-native. Rebuild generated assets only via `npm run build`.

Bounded loops: stop after the same test failure three times or five fixes with no new pass; at most three red CI rounds. Post exact-SHA READY only after required checks pass. Never merge/deploy, close PRs, publish packages, enable flags/settings, launch real hosts or send live messages under this checkpoint.

## Verification at the base

PowerShell, lead rerun against this worktree's canonical fixtures:

- `npm ci`: locked dependencies installed; audit reported zero vulnerabilities. No package/lock change.
- Full Lane B checks: typecheck PASS; frontend 275; TypeScript SDK 199; integrations 218 PASS / 1 existing skip; Python SDK 6; build PASS with no generated drift. The Node/download suite and exact-head CI outcomes are recorded in the PR and #34 before READY.
- Two independent read-only reviews: no blocking findings. Relative Markdown targets and changed-path checks PASS.
- Registration publication comparison: no diff against approved `4da219e`; no fixture copies or edits.
- `npx vitest run --config vitest.registration-review.config.ts`: 103/103 PASS, all 78 registered fixtures consumed.
- `node --test integrations/onboarding/test/envoi-link.test.mjs integrations/onboarding/test/host-plan.test.mjs integrations/onboarding/test/skill-contract.test.mjs`: 27/27 PASS.
- `ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT=<this worktree>/test/contract-fixtures/agent-registration; node --test integrations/onboarding/test/agent-registration.review.mjs`: 5/5 PASS.

These are existing contract/draft checks, not B-4 implementation or real-service evidence. PR/CI results will be published on #34 at the exact committed head. No gate PASS, runtime behavior, wire, flags, fixtures or generated files changed by this checkpoint.
