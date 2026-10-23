# Phase B/C closure checklist

Audited 2026-10-23 America/New_York by Je/Codex. Phase D belongs to Rachel and is excluded. This is the client-owned closure handoff; board [#34](https://github.com/rachelgonsalves821/Envoi/issues/34) remains the coordination authority. It supplements the Phase B completion and Phase C execution plans, preserving their history and original acceptance scope.

This is the earlier audit snapshot, retained for traceability. The [client composition manifest](B-C-CLIENT-COMPOSITION.md) pins the selected current inputs and records the completed quickstart corrections; its source selection supersedes the pending-source instructions below. Original writer branches remain unchanged.

## Baseline and accepted work

| Item | Verified state | Remaining action |
| --- | --- | --- |
| Source baseline | `d05498d8dc13c6f07dc151da7a41a1619ff62436`, containing #203 server and #173 owner-consent client once | Resulting integration-push CI [39996743328](https://github.com/rachelgonsalves821/Envoi/actions/runs/39996743328) completed SUCCESS at that exact source SHA. The approved integration step is closed; do not ask for its approval or execution again. Server integration push [39994248902](https://github.com/rachelgonsalves821/Envoi/actions/runs/39994248902) at `9ddfae9` succeeded. |
| B-local | Real Hermes/OpenClaw 21/21 at `e8a958f`; #165/#168 integrated | Preserve that exact evidence; no repeat requested. |
| Historical B/C | [Human-attested complete/countersigned](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176) | Attach any located historical row/SHA/host references without inventing identifiers or reopening accepted work. |
| C-B1 through C-B5 | Selected scoped lifecycle, nine-tool clients, adapters, assets/owner UI and signed wake included through #143 | Do not reapply original #118/#120/#124-#142 increments merely because PR copies remain open. |
| Later normal-entry/supervised wake | #199 contains selected #192/#195/#197 content once, including #174 Windows fix | Assess only later changed client/configuration behavior against the next selected release. Original PR copies are not a second backlog. |
| Contracts | Existing case-session, case-tools, http-wake approvals; registration revision 5, remote-auth revision 4/Policy B and on-demand presence approvals remain credited | No blanket contract reapproval. Some registry/handoff status metadata still says published: Lane A owns correcting those status lines with existing approval links. |
| Route defaults | Both remote-auth flags OFF; Stage A unchanged | Integration or offline tests do not enable a route or authorize a deployment. |

A PR being open, or its head not being an integration ancestor after reviewed cherry-picking, does not prove its implementation is absent. Use inclusion records and the selected source increment. Historical acceptance, changed-source checks and Production operations retain separate evidence.

## Prepared source still needing an integration decision

All heads below are snapshots, not moving-head approvals. Existing owners keep their branches. Refresh on the terminal-green integration baseline, rebuild generated files only with `npm run build`, and publish the resulting composition's own checks. Je makes integration decisions; Lane A remains integrator under the repository rules.

| Work | Pending source | Exact next step / exit |
| --- | --- | --- |
| Owner on-demand presence | #183 `3c21f3bdc1e801045432de45ff06f7f678a1d07b` | Owner refreshes only its frontend increment onto the merged authorization/consent base; preserve #173 and regenerate HTML. Verify the 13 canonical fixtures, pause/reconnect precedence and owner labels in the combined source. |
| Host OAuth authorization planner | #196 `7ec6c1ec132f0c454b313821512e9be4e049c6ea` | Integrate the three-file pure planner once after review. It constructs/validates authorization setup only; the actual host still owns callback/state verification, credential custody, exchange, renewal and disconnect. No new custom OAuth client is implied. |
| Portable REST and host-breadth preparation | #206 `e0d0e9fc8052acbca66ddd2be7be14a6f3a571b2` | Existing composition owner refreshes it against current auth source and verifies compatibility. Select #206 once instead of separately replaying #179/#190/#182/#204 and #181's inherited REST work. Keep unaccepted routes unavailable. Its old M1-M9 blocker text is superseded by #203's resolved review. |
| Served/installed artifact preflight | #193 `069355775bdc0ddfefb95ec1d53f1c11e32f8b8c` | Select the additive checker once. After a separately approved deployment, run it on a clean exact candidate and real installed profiles. Its hash comparison is neither host execution nor rollback acceptance. |
| Windows session replacement | #210 `03b79b195ac64efbafd3d2e93ee5fa768e8a4cfe` | Existing author refreshes on terminal-green #203/#173, rebuilds and publishes new-head checks. Prior independent technical ACK is [6370871237](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6370871237); its old base CI is not a future composition receipt. |
| Python SDK quickstart | #207 `aab146b6f5392ebb425bd6687b6623e8e3b99bb3` | Existing owner corrects the native-acknowledgement guidance described below, then publishes exact-head focused checks/review. Keep the SDK's limited surface explicit. |
| TypeScript SDK quickstart | #209 `39c625102ccefe326755220d2145488047500561` | Existing owner reconciles the retained stale case/asset and status-only lifecycle paragraphs described below; examples remain offline. |
| Private distribution | #111, #117, #119; final launcher head `4776200d2d87a3a80af1469cbdd250d04ccdb869` | Existing distribution owner supplies the incremental recipe against the final helper build and current contracts. #119 carries private-install prerequisites; do not replay them twice. Review upgrade/provenance and background-service handoff separately from inert launcher tests. Public publication remains a separate decision. |
| Hosted evidence packets | #184 `a6f1d77f32847bb97eb55317e0e4c6fac91efdef`; #172 `94b5fa1c42a4cf0f69cedbf566d5a3995ddf458e` | Retain historical B/C closeout. Refresh stale candidate/preparation statements, pin final receiver/client/server source and identify only changed rows. Packets are not new hosted passes. |

Marketing #145/#191 and the historical provider designs are not new prerequisites for accepted Hermes/OpenClaw C implementation. Product launch/P0 readiness remains separate below.

## Concrete quickstart corrections

**#207 Python:** README's main supported-use snippet and `examples/offline_quickstart.py acknowledge` show a successful `processed` acknowledgement at `/api/inboxes/{inboxId}/messages/{messageId}/acknowledgements`. In current `src/server.js`, that route returns HTTP 410 for native agent work or human instructions and requires `/api/agent/work/:workId` fenced settlement. The TypeScript SDK already marks `acknowledge` deprecated for native messages. The strict Python mock returning 200 proves request construction, not native completion.

[REQUEST lane-b 6371233202](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6371233202) to the existing #207 owner: label that example explicitly legacy-only; remove it from the normal native collaboration sequence; explain the 410 refusal and point native processing to the existing trusted connector. If retaining the legacy wire example, add a separate documented native-refusal example/check so readers cannot infer a native `processed` receipt. Do not add an unfenced settlement path or invent Python lifecycle support.

**#209 TypeScript:** its newly added quickstart gives correct stable case/event/rotation guidance, but retained lower sections still call server case convergence and cross-owner case grants blanket beta blockers, and describe revocation as a generic 403. The current C tools and lifecycle use canonical scopes and stable codes. REQUEST lane-b to that owner: distinguish the older structured mutation/legacy asset methods from approved `CaseToolsClient.snapshot`, `checkAuthority`, `decide`, `shareAsset` and `complete` methods in `sdk/typescript/src/case-tools.ts`; link their current guide/source. Describe revoked handling using stable codes and the connector. Keep unsupported legacy-method behavior explicit rather than declaring all C case/assets missing. Run the documented focused SDK command with `--config vitest.sdk.config.ts`.

These are client documentation corrections within existing contracts. They do not reopen contract approval and do not justify editing another owner's branch here.

## Remaining host and contract exits

| Host / boundary | Current evidence | Concrete remaining exit / owner |
| --- | --- | --- |
| Hermes/OpenClaw helper | Accepted historical local/B/C work; selected source integrated | Existing runtime/operator owner pins the next source and installed/served artifacts, determines changed rows for normal-entry/supervised wake and #210 if selected, and executes only separately approved new operations. |
| Cloud-only MCP/OAuth host | Server and consent are merged, flags OFF; offline planner prepared | Existing host owner captures actual client metadata/redirect, PKCE/resource/scope acceptance, private token custody, identity/tools/send/reply, refresh, pause and revoke on one approved hosted source. A model or owner-browser token exchange is not a substitute. |
| OAuth installation wake | Approved remote-auth v1 tokens are `/mcp` audience-bound and cannot use REST http-wake subscription routes | Lane A publishes a separately reviewed MCP-scoped wake/subscription contract or selected compatible interface, with fixtures. No Lane B REST audience bypass. This is new contract work, not another request to approve existing revision 4. |
| Dots | #182/#206 record candidate account/plugin and event interfaces; no actual Envoi host pass | Actual account capability check and approved event discovery/subscription/delivery contract, then exact-host exchange and closed-app/lifecycle evidence. Lane A owns protocol; host owner supplies consumer and evidence. |
| Grok consumer / automation / Bot | Separate interfaces recorded; not interchangeable with the xAI API bridge | Actual product/account capability first; if selected, Lane A defines the webhook sender/bridge signature, custody and lifecycle contract before client implementation. Verify the same authorized host produces the canonical reply. |
| xAI Responses API bridge | Integrated scoped adapter plus pending #206 token-origin hardening | Select client source and perform an approved actual-provider scoped-tool/case/restart/renew/revoke gate. Record this exact API bridge separately from consumer Grok. |
| Muse | Selected reviewed/listed Connector Platform path; #204 preparation carried by #206 | Existing provider owner completes reviewed auth/tool classification and submission/account approval, then actual canonical exchange and two closed-app effects. Excluded Custom Connector work is not revived. Read-only OAuth scope is an explicit contract/product choice where current `envoi.agent` includes claim/settlement. |
| Instinct | Account-reported scheduled HTTPS; public ready probes, app open; no native Envoi installation | Lane A publishes approved scheduled native processing or Stage 2 canonical gateway semantics. Current trusted persistent REST helper rejects scheduledPolling; Stage 1 read/notify cannot claim/reply. No email bridge is selected. Existing provider owner validates real private auth, schedule, canonical reply and lifecycle after approval. |

For each additional advertised host: exact product/version/route, one approved source/artifact set, current identity/installation, owner consent, canonical exchange, two separately timed closed-app arrivals if automatic reachability is promised, interruption/restart, refresh/reconnect, pause/held/resume, revoke/late denial and truthful owner status. An on-demand-only pass has that scope. Provider-blocked rows remain open until evidenced or explicitly removed by the human's scope decision.

## REQUEST lane-a: one bounded handoff

[Posted handoff 6371261746](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6371261746). The terminal client integration receipt completed after that comment; the next paragraph supersedes its pending-CI snapshot.

1. Preserve completed #203/#173 integration and successful terminal push CI 39994248902/39996743328; do not reapply that stack or request its approval again.
2. Reconcile current contract status metadata using existing approvals, and attach historical exact-run references when located. Do not replace the human countersign with an invented run.
3. With existing client owners, prepare one dependency-ordered source selection for #183/#196/#206/#193/#210 and distribution/quickstarts. Resolve generated overlap once by rebuilding; retain original PR heads and avoid duplicate constituent content.
4. Publish separate contract drafts/fixtures for (a) OAuth/MCP-scoped wake, (b) the selected Dots/Grok event interface after account capability, and (c) Instinct scheduled native processing/Stage 2 if selected. Include installation/tenant binding, least privilege, opaque delivery, idempotency/fences, duplicate/lost delivery, current permission/pause/revoke, custody, bounded retry and flag rollback. Reuse the canonical queue/case/audit system. Each new contract needs client ACK and human approval before dependent implementation.
5. Existing release owner updates the final exact candidate/receiver and changed-row packet. This request approves no new source integration, flag change, deployment or live host action.

## Production operations are a separate closure track

[Runner authentication 6370743004](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6370743004) supersedes the old missing-authentication blocker: approved OAuth grant and read-only account/Worker/Container/registry checks passed. Missing a registry-named permission in an older inventory alone does not prove capability failure. Provider write capability and cutover are not exercised by those reads. Billing/Production unlock preparation has advanced; old billing-deferred notes are historical, not a new instruction to change billing.

The existing release owner still pins exact source, operator window, writer holds, fresh recovery boundary, strict owner/workspace mapping, private two-key transfer, paired Worker/image/config release, rollback, both-owner sign-in/verification/continuity and reopening. Reconcile live database/object/key/queue recovery, authenticated scanner, backup schedule/retention, delivered alerts and recorded October 29 R2 credential expiry against actual existing evidence. Request only genuinely missing operations. Keep automatic Builds paused per the existing approval boundary. None of this tracker changes account settings or authorizes a deployment/invitation.

## Independent checks performed in this audit

Only the owned audit worktree was switched temporarily to each exact PR head; owner branches were unchanged. The review toolchain uses installed dependencies from the current audit integration lock (Vitest 5.0.3), so this is focused independent source verification, not a claim to reproduce each author's complete environment/full suite or CI. No server/provider credentials, real model or hosted traffic were used.

| Exact source | Independent command / result |
| --- | --- |
| #196 `7ec6c1e` | `node --test integrations/onboarding/remote-mcp-oauth/authorization-plan.test.mjs`: 5/5 PASS; trusted origin/metadata, PKCE, scopes, redirect and canonical fixture checks. |
| #183 `3c21f3b` | Vitest frontend on-demand-presence test: 16/16 PASS, covering 13 canonical fixtures and control/unknown state behavior. |
| #193 `0693557` | Vitest artifact-preflight test: 4/4 PASS. No served/installed hosted check was performed. |
| #206 `e0d0e9f` | Vitest portable-rest-cli/runtime and grok/mcp-origin files: 5/5 PASS, including persisted-identity restart and configured-origin token boundary. |
| #207 `aab146b` | Python `unittest discover -s tests -p test_*.py`: 8/8 PASS, including four documented offline example subprocesses. Documentation issue above remains. |
| #209 `39c6251` | Vitest SDK offline-quickstart file: 2/2 PASS; exact requests, retries and no global fetch. Documentation corrections above remain. |

The closure-document PR records its own focused/static and required suite/CI receipts separately. This checklist claims neither a new B/C hosted pass nor full Phase B breadth completion. No Phase D source, other owner's branch, canonical fixture/contract, integration/main ref, running runtime, original paused case, setting or deployment was changed.
