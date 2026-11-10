# Phase D v1 interoperability acceptance worksheet

Status: **SOURCE CANDIDATE; hosted gate unproven.** This worksheet is a reviewable execution record, not approval to enable a flag, deploy, invite a peer, integrate the candidate, or run a provider. The approved contract is `phase-d` v1 at `4d8d00c4bb426b4b1ddff263037618bbe35d66e1`, [published on board #34](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415432796), [ACKed](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415457132), and [approved by pjsk02](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6416305575). The controlling source is `docs/architecture/agent-native-v2/handoffs.md#phase-d-v1` and the registered fixtures are in `test/contract-fixtures/phase-d/`.

## Source candidate

| Field | Receipt |
| --- | --- |
| Draft PR | `lane-b/phase-d-source-readiness` into `integration/agent-native`. [#211](https://github.com/rachelgonsalves821/Envoi/pull/211) is the historical source review. |
| Exact source SHA | Record after the final source/CI round. Do not infer this from an earlier green head. |
| Flag defaults | `ENVOI_RELATIONSHIPS_V2=false`; `ENVOI_A2A_GATEWAY=false` |
| Local peer evidence | Phase D HTTP, fixture, frontend event/API and SDK tests. The card, send response and direct Task parse with the official [A2A Python SDK 1.2.3](https://github.com/a2aproject/a2a-python/releases/tag/v1.2.3) protobuf models. Its `RestTransport` completed a disposable local card/send/poll exchange when the client supplied the contract's `Content-Type: application/a2a+json`. Its unconfigured `httpx` JSON default received HTTP 415; this is a client setup requirement, not a hosted PASS. |
| PR CI | Record the exact head and completed check URLs. |
| Hosted source / peer | **Not selected or authorized**. Proposed independent client: official A2A Python SDK 1.2.3 using its HTTP+JSON 1.0 binding; confirm peer/version, deployment SHA and time before execution. |

## Hosted run prerequisites

1. Obtain separate human authorization for the exact source to integrate/deploy, both Phase D flags, and one external peer test. Preserve existing owners, workspaces, inboxes, keys, namespaces, Dots history and protected paused Cases. Use disposable identities and a clearly identified peer account; keep credentials out of this worksheet.
2. Record the served build SHA, public HTTPS origin, peer implementation/version, owner/operator, and start time. Verify the served SHA equals the approved deployment SHA and that the two flags are in the intended state. Do not accept a local mock or a self-call as the external peer.
3. Capture redacted HTTP method/status/code, card fields, Case/Task/Asset identifiers, durable event and outbox receipts, and current access decisions for the rows below. Store sensitive raw traces only in the approved evidence store.
4. Return both flags to their prior state after the run; verify prior Cases and Assets remain readable by previously authorized parties. Record the rollback time and observed state.

## Acceptance matrix

All rows remain **UNPROVEN** until a hosted external peer run at one exact source SHA produces the indicated evidence. A local test or green CI must not be entered as a hosted PASS.

| Row | Passing observation | Evidence to record | Result |
| --- | --- | --- | --- |
| D-01 | Authenticated exact-address Agent Card advertises only HTTP+JSON 1.0, Bearer, immediate text send and Task read; unrelated callers cannot enumerate it | Card response and unauthorized/not-found status | UNPROVEN |
| D-02 | External peer sends one supported text message and polls its returned Task | Peer request/response, mapped canonical Case ID and final Task state | UNPROVEN |
| D-03 | Native message, Case, event and outbox commit before wake and projection | Durable store/audit timestamps and wake receipt for D-02 | UNPROVEN |
| D-04 | A clean scanned Asset with an explicit current grant appears as a Task Artifact; download checks current authority | Scan/grant/Task/download receipts and denied revoked download | UNPROVEN |
| D-05 | Reuse of the same message ID after an uncertain response returns the same Case/Task; conflicting reuse is denied | Two peer attempts, one native message/event, conflict code | UNPROVEN |
| D-06 | Pause, revoke, reciprocal block, cross-workspace access, expired/stale credentials and permission loss deny later send, poll and download as applicable | Status/code and unchanged store counts for each denial | UNPROVEN |
| D-07 | Streaming, push, continuation, blocking send and unsupported methods fail explicitly and are absent from the card | Peer negative requests and error codes | UNPROVEN |
| D-08 | Flags-off rollback removes Phase D routes while preserving earlier Cases/Assets, directed trust history and unrelated routes | Flag state, route responses, stored-record and prior-route checks | UNPROVEN |
| D-09 | Human countersigns D-01 through D-08 at the exact served SHA | Board #34 countersign comment URL, author, SHA and explicit scope | UNPROVEN |

## Decision and rollback

Hosted PASS requires D-01 through D-09 at the same served SHA. On any failed row, stop the peer run, restore both flags to their prior values, preserve all records for diagnosis, and post the exact observed mismatch to board #34. Rework returns through the existing draft PR and a new exact-head CI check. Contract changes require a new version publication, consumer ACK and pjsk02 approval. Keep the current candidate in draft and both flags off pending the separate release decision.

## Source reconciliation

- Original source `c072fcf` is already on main via #276 (`6b771c1`), including the contract, server, UI and SDKs. #276 also added a public availability route and UI gating. Main `5a2e2a7` retains that branch-specific behavior.
- Integration `0986d0f` did not contain Phase D. This candidate composes Lane A's `235c925` once, without merging main or replaying #211. Lane A's flags-off fallback fix and FileStore/PostgreSQL test parametrization remain intact. The published fixture bytes and newer integration work are preserved. Rebuild from candidate source with `npm run build`.
- #211's CI, its unpublished image, the October staging baseline and its proposed window are historical. The PostgreSQL script now explicitly runs both Phase D HTTP files. Verify the completed PR workflow and seven PostgreSQL Phase D HTTP variants at the final draft SHA.

## Reproduce local evidence

Run from the candidate checkout in PowerShell with Node 24 and Python. Install dependencies with `npm ci` and install `a2a-sdk==1.2.3` in an isolated Python environment on PATH. The peer runner starts a disposable loopback FileStore server, creates two synthetic agents and gives the independent Python SDK process a temporary bearer credential. The SDK uses the advertised direct REST interface and checks the returned Task ID against the poll. The server is stopped on completion.

```powershell
node integrations/gates/phase-d-local-peer.mjs
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --test --test-concurrency=1 test/phase-d-core.test.js test/phase-d-a2a-http.test.js test/phase-d-relationships-http.test.js test/asset-grants-integration.test.js
```

Local evidence is separate from the hosted result column above.

| Row | Local result and remaining hosted proof |
| --- | --- |
| D-01 | SDK parses authenticated Bearer card. HTTP checks deny missing auth and reciprocal block. Capture actual peer and unrelated caller receipts. |
| D-02 | SDK sends immediate text and polls the same Task. Capture hosted Case ID and state. |
| D-03 | HTTP test reads the committed native Case and A2A event. Capture hosted message, Case, event and outbox timestamps against wake and response. |
| D-04 | Local scanned Artifact and authorized download pass. Asset grant suite checks current access after revocation. Capture the full hosted scan/grant/Artifact/revoked-download sequence. |
| D-05 | HTTP tests confirm same-ID Task replay and changed-body 409. Drop the first hosted response and prove one native write/event. |
| D-06 | HTTP checks cover wrong caller/target, reciprocal block and organization isolation. Record pause, revoke, expired/stale credential and permission-loss cases separately in hosted evidence. |
| D-07 | Local tests check stream 501, blocking rejection and request subset validation. Probe unsupported methods from the hosted peer. |
| D-08 | Local HTTP verifies flag-off route absence and relationship reversibility. Capture pre/post protected state and earlier Case/Asset reads in staging. |
| D-09 | Pending human countersign after hosted D-01–D-08. |

## Unresolved contract and product decisions

1. Adopt or omit #276's public `GET /api/phase-d/availability` and default-off UI visibility behavior on integration. The approved v1 route list lacks that endpoint. Main keeps its existing implementation. This candidate retains the v1 owner controls.
2. Define reciprocal-block semantics when owner discovery omits optional `actorAgentId`. Agent-authenticated and explicit-actor lookups have a defined actor. Decide whether to infer the workspace agent, require an actor or specify another rule for owner lookup.
3. Confirm whether Case-session MCP and native gateway Case mutations belong in v1's ordered evaluator scope. Existing migration covers agent Case HTTP mutations and Asset grants. Extending it to other entry points needs a recorded decision and owner review.

PostgreSQL coverage was already decided and implemented in `235c925`. It remains a validation requirement.

## Hosted execution and paired rollback record

Before approval, fill in exact integration SHA and full CI URL, intended Worker version and immutable container digest, served health/readiness SHA, served asset hashes, separate peer and recipient principal/workspace/agent bindings, approved negative-test identities, operator acceptance, prior Worker version plus container digest and settings, protected-record inventory and UTC start/hard stop. Use a fresh exclusive window of at most 90 minutes after Phase C releases staging. The historical peer and target aliases are unbound. Capture flag values and secret names only. Establish rollback of the paired Worker and image before any traffic.

The operator verifies installations are already enabled and the public URL is the staging HTTPS origin. The proposed profile enables only relationships and A2A. Preserve other flags and keep automatic Builds paused. Run one positive text exchange, at most two same-ID retries and one conflicting-ID request, one scanned explicitly granted Asset, then one request per listed refusal. Capture UTC time, method/status/stable code, redacted correlation and object IDs, and source/Worker/image tuple. Stop at the first unexpected write, authorization result, version/flag drift, protected-state change or hard stop.

Stop the peer first. Restore the prior A2A setting, then relationships, and confirm route absence and earlier authorized Case/Asset reads. If code rollback is required, restore the recorded Worker/image/settings pair and verify the prior health/readiness SHA, flag profile and protected inventory. Preserve the data and traces. Record handback and any discrepancy. A failed gate requires a corrected exact integration SHA and a full rerun. The human countersigns the hosted evidence separately.
