# Phase A hosted gate: operator evidence worksheet

This blank Lane B worksheet aligns with [Lane A's phase-a-TEMPLATE.md](../../docs/architecture/agent-native-v2/evidence/phase-a-TEMPLATE.md) from #84. Use the [operator runbook](PHASE-A-HOSTED-RUNBOOK.md) for all 23 observations on one exact paired integration SHA. Lane A owns the authoritative `phase-a-<sha>.md`; the human countersigns. **Every row starts UNPROVEN.**

## Run header

| Field | Record without secrets |
| --- | --- |
| Final paired candidate SHA (40 characters) | UNPROVEN |
| Fresh preflight UTC and all five checks PASS | UNPROVEN |
| /health releaseSha and configurationValidated: true, before/after | UNPROVEN |
| /ready SHA and database/object storage/scanner readiness | UNPROVEN |
| Staging Builds frozen by the human | UNPROVEN |
| Hosted/local connector bundle SHA-256 matches release.json | UNPROVEN |
| Disposable owner and distinct sender (labels only) | UNPROVEN |
| Test agent id/address and agent inbox id | UNPROVEN |
| Hermes observed/expected version, OS, provider name and real model turn | UNPROVEN |
| Separate disposable profile, API_SERVER_PORT and fixed proxy --port | UNPROVEN |
| Preserved private connector state directory | UNPROVEN |
| UTC start/end and operator | UNPROVEN |

Never record tokens, cookies, claim codes, message text, lease tokens, provider account details, raw HTTP, successor fields or their digest. The proxy publishes only counters, equality, HTTP status and sanitized code. Keep raw owner snapshots in a private folder outside Git. Publish only Lane A's `scripts/ga-evidence.mjs` allow-listed output from events, agents, receipts and deliveries. Never save/publish /messages or agent-view. Correlate audit **sequence and id**, workId, messageId, receipt id and credentialFamilyId; do not assume request IDs exist on successful responses. Presence fields can lag 60 seconds.

## One-release observation ledger

S = sanitized server evidence from Lane A; C = connector/proxy observation. PASS requires both where specified. Record UTC and IDs/sequences in the evidence column.

| # | Required observation | Server evidence (S) | Connector / proxy evidence (C) | Status / recorded evidence |
| --- | --- | --- | --- | --- |
| 1 | Disposable Hermes connects | agent.enrolled; agent.connection_setup_checked; active owner agent, seen_recently connection | Identity/tool access and a new real model turn | UNPROVEN — |
| 2 | Native work processed once | message.delivered → agent.work_claimed (fence: 1, attempts: 1, family) → message.processed; one processed receipt and reply message.queued | One real model effect/reply | UNPROVEN — |
| 3 | Restart connector | lastSeenAt stops and resumes | Stop/restart same private state directory | UNPROVEN — |
| 4 | Same identity/family continues | No credentials_reconnected/reenrolled; next claim same family as #2; offline message processed once | No duplicate output, no re-enrollment | UNPROVEN — |
| 5 | Pause | agent.paused; paused: true, status: paused | Connector PAUSED | UNPROVEN — |
| 6 | Two messages in one case while paused | Ordered message.delivered and delivered receipts from distinct sender | Retain the two message IDs and delivery order | UNPROVEN — |
| 7 | Held work persists | No claim between pause/resume; delivered but no processed receipts for both messages | Claim work:null,state:paused; send 409 AGENT_PAUSED | UNPROVEN — |
| 8 | No attempt/dead letter consumed | Delivered outbox rows, deadLetteredAt:null; no failed/dead-letter event; first claims after resume attempts:1 | No model processing while paused | UNPROVEN — |
| 9 | Refresh while paused | Before/after owner views: credentialExpiresAt and lastSuccessfulRefreshAt advance while paused:true | Lazy refresh success across planned boundary; allow ~14 min | UNPROVEN — |
| 10 | Resume | agent.resumed then work.available reason:agent_resumed | Same agent, no re-enrollment | UNPROVEN — |
| 11 | Immediate ordered claims | Both agent.work_claimed times follow resume promptly; same-case claim order equals delivery order | Two held IDs remain distinct | UNPROVEN — |
| 12 | Both processed once | One processed event/receipt per held message | One reply/model effect per message | UNPROVEN — |
| 13 | Lose one committed refresh response | Owner view immediately after drop has advanced credentialExpiresAt | lost-refresh armed before boundary; refreshResponsesDropped:1 | UNPROVEN — |
| 14 | Retry same rotationId | agent.refresh_recovered for same family; no refresh_replay_detected; not revoked | Same persisted rotationId reused within recovery window | UNPROVEN — |
| 15 | Identical successor | Recovered event refreshExpiresAt equals credentialExpiresAt in the view saved just after #13 | In-memory four-field SHA-256 comparison recoveredIdentical:true; false/null fails | UNPROVEN — |
| 16 | Rolling expiry advances | Compare owner credentialExpiresAt at #9 and #13 | Record only nonsecret expiry times | UNPROVEN — |
| 17 | Cut SSE | No server SSE audit exists | cut-sse; sseStreamsCut>0, reconnect blocked, REST available | UNPROVEN — |
| 18 | Safety poll processes work | New delivered work then agent.work_claimed | No SSE event reached connector | UNPROVEN — |
| 19 | One pre-effect retryable failure | agent.work_failed retryable:true, attempts:1, retryAt | fail-ack-once gives exactly one acknowledge 503; acknowledgementsFailed:1; no Hermes effect on first attempt | UNPROVEN — |
| 20 | Process same work when eligible | Same workId claimed fence:2, createdAt≥retryAt; one processed event/receipt | SSE still cut; no new event; one model effect | UNPROVEN — |
| 21 | Restore SSE, then revoke | agent.credentials_revoked with family count; revoked owner connection | restore-sse and activeSse>0 **before revoke**; hold-settlement on controlled work, settlementBuffered:true before revoke | UNPROVEN — |
| 22 | Terminal REVOKED | Presence stops | credential.ended frame → REVOKED, no re-enrollment; if another path fired, label it explicitly | UNPROVEN — |
| 23 | Nothing succeeds afterwards | No refresh/recovery/claim/processed/queued event or receipt after revoke; lastSuccessfulRefreshAt unchanged | release held complete → HTTP401/CREDENTIAL_REVOKED; replay-refresh and replay-claim → same server denial; send/MCP write connector-local refusal plus no server effect | UNPROVEN — |

## Fault and outcome correlation

The proxy's counters prove injection, not recovery. Match the dropped response and digest equality with the **same** family's recovery event and post-drop expiry. Counts alone cannot prove an identical successor. Read owner refresh fields before/after at least 60 seconds apart, and plan both lazy refresh boundaries from connector status (`credentialExpiresAt` is saved access expiry, not rolling refresh expiry).

For #19–20 retain the failed workId, attempts and retryAt, then the same workId/fence:2 at or after retryAt. Do not stop the Gateway or accept multiple injected failures. No canonical model effect occurs on the injected acknowledge failure.

For #21–23 restore SSE and wait for an actual stream before revocation. Prepare the human revoke control first, buffer a complete request, and revoke promptly within the default 30-second connector request timeout. Release only after revoke; the request survives downstream abort. Optional replay-refresh/claim retain only each latest request in private bounded memory, consume it once, and print status/code only; exit discards all buffers. Record each named operation separately. Connector-local refusal is **not** an HTTP401: distinguish it from the three proxy/server probes. For send/MCP write, correlate the local CREDENTIAL_REVOKED refusal with no server-side effect after the revoke time. If the authoritative gate demands an additional server probe, provide it before marking PASS, never infer one. If no credential.ended frame was observed, leave that frame path UNPROVEN and identify the actual REST path.

## Result

| Field | Value |
| --- | --- |
| Rows PASS | UNPROVEN / 23 |
| Defects (lane, PR) | UNPROVEN |
| Lane A GATE GA PASS/FAIL @sha | UNPROVEN |
| Human countersign | UNPROVEN |

Any failed row requires a fix, new exact SHA and rerun of all 23. Do not combine rows from different releases. Local tests, a presence label, open browser, tools/list or this worksheet alone establish no hosted PASS.
