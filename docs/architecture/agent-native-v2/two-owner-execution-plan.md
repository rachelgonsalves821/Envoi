# Envoi agent-first onboarding: two-owner execution plan

**Prepared:** 2026-10-08. **Status:** reviewable plan; no implementation PR is merged or deployed by this document.

This plan implements the supplied *Envoi Agent-Native Architecture Build Plan v3* in its required order. The release objective is simple: a human asks an independently hosted agent to connect itself to Envoi; the human verifies and authorizes it; the agent keeps one stable Envoi identity, receives durable work, and collaborates without handing runtime secrets to the model or requiring the human to prompt it for every message. Envoi does not host customer agent runtimes. Phase D interoperability is subsequent work, not a dependency for agent-first onboarding.

## Verified starting point and work already done

| Item | Current evidence | Treatment |
| --- | --- | --- |
| `main` | `376c760bc100b38c8f1c9f689875019f58327724` as checked 2026-10-08. It has the native case/inbox, transactional delivery, fenced work claims, remote MCP, unified connector, Hermes/OpenClaw/xAI adapters, WorkOS oversight, and scanner/file-grant foundations. | Re-fetch before implementation or acceptance; do not treat an old checkout as current. |
| [PR #30](https://github.com/rachelgonsalves821/Envoi/pull/30), Step 0 | Draft, unmerged, head `2494e952d2b7486c981a23399f04a386312bdbc9`. Fixes seven high-severity development-dependency findings, adds full-audit CI gate, records local and hosted baseline. Exact-head Backend CI succeeded, including Docker and disposable PostgreSQL. Beta `/health` and `/ready` reported the then-current main SHA and ready DB/storage/scanner; staging returned `releaseSha: null`. | Review as Step 0. Retain the staging exact-SHA attribution gap for hosted acceptance. Do not redo its dependency work. |
| [PR #31](https://github.com/rachelgonsalves821/Envoi/pull/31), A1 | Draft, unmerged, **stacked on #30**, head `0d834492674b07ca3090ea113fe9328720d731ef`. Rolling refresh expiry, mandatory persisted `rotationId`, five-minute encrypted same-successor recovery, and updates across TypeScript/Python SDK and shipped connector bundles. Exact-head Backend CI succeeded with Docker, PostgreSQL, scanner and audit jobs. | Review as the single A1 implementation. Do not rebuild credential rotation in either new workstream. Server and all active connector binaries must change together; old binaries will fail at their next refresh. Hosted lost-response/restart and rollback proof remain. |
| [PR #21](https://github.com/rachelgonsalves821/Envoi/pull/21), Muse probe | Draft, unmerged, based on older main. Five-minute read-only probe, bounded one-message test grant, and **default-disabled, non-authorizing** installation-intent route. Meta proxy/Sentinel denied the attempted reads before Envoi; no Muse-origin 200, send, or wake proof. It edits `src/server.js`, `src/agent-mcp.js`, and frontend files also relevant to this plan. | Keep isolated as provider feasibility work. Reconcile a specific reviewed change through the shared contract; do not merge the entire branch into Phase A/B or count its intent route as enrollment. |
| [PR #29](https://github.com/rachelgonsalves821/Envoi/pull/29) | Open frontend conversation-refresh change touching `frontend/src/App.tsx` and generated `web/index.html`. | Owner B rebases its UI work after the PR's disposition; neither workstream copies its UI patch. |

The existing [Step 0 baseline in #30](https://github.com/rachelgonsalves821/Envoi/blob/codex/agent-native-step0/docs/architecture/agent-native-v2/baseline.md) reports live beta readiness **at main**, not at #30 or #31. Neither green CI nor `/ready` proves an unattended real-runtime journey. The original v3 plan remains the product/architecture contract where this file does not amend it.

## Two exclusive ownership lanes

| | Owner A — partner, Envoi service and operations | Owner B — Rachel, external runtime connection and experience |
| --- | --- | --- |
| Owns | Server state, auth/authorization, case/work contracts, persistence/migrations, event and status endpoints, deployment and hosted evidence. | Connector/helper, SDKs, runtime adapters, setup skill/content, human onboarding UI, connector tests, real Hermes/OpenClaw product evidence. |
| Paths | `src/**`, `db/**`, `worker/**`, `scanner/**`, server `test/**`, `.github/workflows/**`, `wrangler.jsonc`, `Dockerfile.cloudflare`, server API schemas and deployment/recovery docs. | `integrations/**`, `sdk/**`, `frontend/**`, static `/connect` content and generated `web/**`, client tests, runtime setup guides. |
| Shared seam | Own and publish API/error/event schemas and a two-owner fixture in `docs/architecture/agent-native-v2/handoffs.md`; implement route binding in `src/server.js`. | Review each contract before coding against it; consume it in clients/UI and report exact mismatches. Own wording of `/connect` skill and page; Owner A only wires the route. |

No owner edits the other's paths to make a test pass. If a contract needs changing, Owner A writes current behavior, proposed change, migration effect and fixture first; Owner B signs off on client impact. PR #31 predates this split and remains one already-prepared cross-cutting PR; split new work **after** it rather than rewriting its history.

## Ordered build and integration gates

### 0. Finish the prepared baseline and A1 reviews

1. **Owner A:** Review #30 exact-head CI and baseline; verify current `main`, live `/health`/`/ready`, provider readiness and the candidate release SHA. Fix staging SHA attribution before using staging as an exact-candidate acceptance target. Keep primary dirty checkouts untouched.
2. **Owner A + Owner B:** Review #31 against #30. Owner A checks server replay, expiry, revocation and encrypted recovery; Owner B checks local persistence-before-request, every published connector/SDK bundle and restart tests. Record the old-client incompatibility and a coordinated update/restart and compatible rollback procedure. Preserve the mandated `rotationId` contract.
3. **Code gate:** #30 then #31 may be integrated only through normal review; this plan grants no merge or live deployment approval. Exact-head CI, disposable PostgreSQL/Docker checks and coordinated connector compatibility are required before moving to A3. Real hosted lost-response/restart recovery belongs to the Phase A acceptance gate after A5. Do not use the unrelated #21 Muse route to satisfy A1.

### A3. Pause semantics — before connector lifecycle

- **Owner A:** Separate `canReceive` from `canAct`; accept and hold work for paused recipients; hold queued outbound work from paused senders; allow authenticated refresh/status while paused; stop claims and writes; preserve SSE; publish explicit pause/resume states and a resume wake event. Cover the v3 pause matrix, including long pause, in-flight lease, and token rotation.
- **Owner B:** Review the frozen response/event contract and add client fixtures for each pause state. Do not yet implement the full state machine or modify server code.
- **Gate:** Server tests prove pause cannot become 401/re-enrollment, silent dead letter, or unauthorized delivery. Publish examples in the handoff file.

### A2. Connector lifecycle — after A3 contract

- **Owner B:** Implement `STARTING`, `RUNNING`, `DEGRADED`, `PAUSED`, `NEEDS_RECONNECT`, `REVOKED`, `STOPPED` in the existing shared connector, reused by Hermes/OpenClaw/xAI. Use stable server codes rather than HTTP status alone; keep durable state and bounded retry; never silently re-enroll or retry a revoked credential.
- **Owner A:** Supply stable error/status fixtures and verify server-side revocation and pause enforcement. No second lifecycle engine in `src/**`.
- **Gate:** Client fixtures and local real-service tests cover restart, outage, pause, recovery and revoke.

### A4. Resilient wake — after A2

- **Owner A:** Publish durable work-available/resume events and cursor/delta behavior using the existing stream and queue. Expose next eligible retry time where practical. Keep the queue, not a notification, authoritative.
- **Owner B:** Make SSE the low-latency trigger; resume from cursor, delta-recover gaps, always try a claim after reconnect, and keep a moderate jittered safety poll for retry/lease eligibility. No new WebSocket service or parallel queue.
- **Gate:** Drop SSE and restart the connector; retry-delayed and offline work still processes once without a new event.

### A5. Minimal presence and Phase A hosted acceptance

- **Owner A:** Store conservative `lastSeenAt`, refresh, claim and processed timestamps on the existing credential family; expose them in a bounded status response. Do not introduce `AgentInstallation` yet.
- **Owner B:** Show “seen recently”, “paused”, or “needs reconnect” without equating enrollment or an open browser with a running runtime.
- **Both:** Run the v3 Phase A real-Hermes fixture on a staging release with a verified SHA: inbound work, restart, pause/held work, refresh across pause, lost refresh response, SSE failure and safety poll, delayed retry, then revoke and deny all later actions. Record request IDs, status, exact SHA and owner signoffs. **Phase B cannot become the default until this passes.**

### B. Agent-led onboarding — design in parallel, enable after Phase A

- **Owner A:** Implement pending `AgentRegistration` with no operational rights; rate-limited public registration/status; authenticated human claim with matching verification code, workspace membership and permission intersection; one-time private activation; first-class `AgentInstallation` tied to a persistent `Agent Identity`; installation revoke/reconnect/presence and migration from existing credential families. Reuse one approval/authorization implementation. Keep old identities and inbox history on reconnect. Publish endpoint schemas and test fixtures first.
- **Owner B:** Build and package trusted `envoi-link connect`, private bootstrap/activation/credential storage, capability detection and chosen delivery mode, sanitized status/doctor output, `/connect` page plus `SKILL.md`/`HEARTBEAT.md`, code-matching claim UI and the default “tell your agent” flow. Retain current Quick Connect under Advanced until real acceptance. The model sees only URL/code and safe status, never operational tokens. Do not claim a closed provider is reachable from a skill file alone.
- **Gate:** Fresh real Hermes and OpenClaw installations complete the v3 Phase B sequence without token copy into chat; agents message each other, restart, recover missed work and stop after installation revocation. A second runtime can reconnect the same identity without losing address/cases/history. Backend and UI agree on installation status.

### C. Case-scoped model tools — after Phase B acceptance

- **Owner A:** Create server-bound `CaseSession` after trusted host claim; short-lived tool scope binds agent, installation, work, case, counterparty, fence and expiry. Implement case-snapshot/reply/propose/decide/authority/human-request/assets/complete tools plus a signed, challenged generic HTTPS wake adapter. Reject stale leases, third-party case IDs and unscanned assets. The model cannot choose a new recipient or case inside a session.
- **Owner B:** Move host claim/renew/settlement and credentials out of model-visible prompts; adapt Hermes/OpenClaw/xAI to snapshot-first, case-scoped tools with a temporary compatibility fallback. Run two simultaneous multi-turn cases, safe file exchange and human decision across both owners.
- **Gate:** One exact hosted commit passes end-to-end cross-owner, restart, revoke, pause, duplicate, file-denial and human-oversight fixtures. “Case completed” requires the canonical outcome receipt, not merely a processed-message receipt.

### D. Later interoperability, not an onboarding prerequisite

After C, Owner A can add relationship/trusted-discovery policy and an A2A adapter over canonical Envoi cases (`AgentCard` → approved identity/gateway, `Task` → Case, `Artifact` → Asset). Owner B can supply A2A client tests and setup guidance. Neither owner creates a second inbox, public arbitrary-address lookup, or separate conversation store. Muse/Instinct provider approval and app-closed wake remain independent provider gates; #21 does not prove them.

## Review and handoff discipline

Every PR names its base SHA, owner, changed paths, API contract revision, client/server compatibility, focused tests, hosted evidence still missing, and rollback target. Owner A provides a small executable fixture before Owner B implements a dependent client. Owner B reports expected versus observed API results without patching server files. Each gate uses the **same exact combined commit** for backend, connector, browser and provider tests. Preserve the distinction between implemented code, CI, deployment and live acceptance. No main merge, staging promotion or beta deployment is authorized by this plan.
