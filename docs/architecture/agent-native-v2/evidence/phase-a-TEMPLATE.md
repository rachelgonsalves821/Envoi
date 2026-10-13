# Phase A hosted gate evidence: TEMPLATE

Copy this file to `phase-a-<40-character-sha>.md` for the run. Lane A fills in the server-side evidence, Lane B the connector and fault-proxy observations from `integrations/gates/PHASE-A-EVIDENCE-WORKSHEET.md`, and the human countersigns. It covers v3 §29 (all 23 steps) on **one** exact integration SHA. Any failed row means a fix, a new SHA and a rerun of all 23 steps (L5).

**Never record** tokens, cookies, claim codes, message text, provider account details or raw HTTP. Publish only the output of `scripts/ga-evidence.mjs`, which keeps allow-listed ids, types, times and counts.

## Run header

| Field | Value |
| --- | --- |
| Candidate SHA | |
| Staging `/health` `releaseSha` and `configurationValidated: true` (before and after the run) | |
| Staging `/ready`: database, object storage and scanner ready | |
| Staging Builds frozen for the run (human) | |
| Connector bundle SHA-256 equals `release.json` (Lane B preflight) | |
| Disposable owner and distinct sender (labels only) | |
| Test agent id and address; agent inbox id | |
| Hermes version, OS, model provider (name only) | |
| UTC start and end; operator | |

## How the server evidence is captured

The human operator stays signed in to staging as the disposable owner. At each checkpoint below, they open these owner views in that browser tab and save each JSON response to a **private** folder, never the repository. Opening them is a plain `GET` with the session; no token is copied.

| View | URL (on the staging origin) | What it proves |
| --- | --- | --- |
| Audit feed | `/api/inboxes/{agentInboxId}/events/delta?limit=200` (follow `cursor` for more) | Every server decision: delivery, claim, settlement, pause, resume, refresh recovery, revoke. Ordinary refreshes are not events; use the agent view |
| Agent view | `/api/inboxes/{agentInboxId}/agents` | Status, `paused`, `credentialRevoked`, `connection.state`, `credentialExpiresAt`, presence |
| Receipts | `/api/inboxes/{agentInboxId}/delivery-receipts` | Canonical delivered and processed receipts |
| Outbox rows | `/api/inboxes/{agentInboxId}/deliveries` | Delivery `status`, `attempts`, `deadLetteredAt` |

Then publish only the sanitized table:

```powershell
node scripts/ga-evidence.mjs events  <private>\delta-step12.json --since <run start UTC>
node scripts/ga-evidence.mjs agents  <private>\agents-step9.json
node scripts/ga-evidence.mjs receipts <private>\receipts-step12.json --since <run start UTC>
node scripts/ga-evidence.mjs deliveries <private>\deliveries-step8.json
```

The extractor drops message text, worker lease tokens and error strings. It refuses any value that looks like a credential. **Never save or publish `/messages` or `agent-view`, which contain message bodies.**

**Correlation ids.** The server's durable ids are the audit event `id` and `sequence`, plus `workId`, `messageId`, receipt `id` and `credentialFamilyId`. Cite those. A request id appears only in an error body and is logged only for 5xx errors, so it rarely correlates anything.

**Presence is throttled** to one write per field per 60 s. Read the agent view before and after each refresh, at least 60 s apart.

## Steps

**Sources:** `S` is server evidence (cite event `sequence` and ids); `C` is connector or proxy evidence (Lane B worksheet). A row is `PASS` only when every listed source agrees.

| # | Observation | Server evidence to cite (S) | Connector or proxy evidence (C) | Status |
| --- | --- | --- | --- | --- |
| 1 | Hermes connects | `agent.enrolled` and `agent.connection_setup_checked`; agent view `status: active`, `connection.state: seen_recently` | identity and tool access; a real model turn | |
| 2 | Native work processed | `message.delivered` → `agent.work_claimed` (`fence: 1`, `attempts: 1`, `credentialFamilyId`) → `message.processed`; one `delivery_receipt_{messageId}_processed`; one reply `message.queued` | the model turn acted once | |
| 3 | Restart the connector | presence `lastSeenAt` stops, then resumes | process stopped and restarted with the same state directory | |
| 4 | Reconnects and continues | no `agent.credentials_reconnected` or `agent.reenrolled`; the next `agent.work_claimed` carries the **same** `credentialFamilyId` as step 2; one `message.processed` for offline work | no duplicate output | |
| 5 | Pause | `agent.paused`; agent view `paused: true`, `status: paused` | connector `PAUSED` | |
| 6 | New work while paused | `message.delivered` for the new message, sent from the distinct sender | — | |
| 7 | Work persists | no `agent.work_claimed` between `agent.paused` and `agent.resumed`; its `_delivered` receipt exists with no `_processed` receipt | claim returns `{work: null, state: "paused"}`; send gets `409 AGENT_PAUSED` | |
| 8 | No dead letter | outbox row `status: delivered`, `deadLetteredAt: null`; no `message.failed`/dead-letter event; the first claim after resume shows `attempts: 1` | — | |
| 9 | Refresh while paused | agent view, saved before and after: `connection.credentialExpiresAt` and `presence.lastSuccessfulRefreshAt` advance while `paused: true` | refresh succeeded; the refresh is lazy (about every 14 min), so plan the pause across a refresh boundary | |
| 10 | Resume | `agent.resumed`, then `work.available` (`reason: agent_resumed`) | — | |
| 11 | Claimable immediately, in case order | the `agent.work_claimed` times follow `agent.resumed` closely; for **two** held messages in one case, the claim order matches delivery order | — | |
| 12 | Processed once | one `message.processed` and one processed receipt per held message | one reply | |
| 13 | Lost refresh response | agent view after the drop: `credentialExpiresAt` has advanced (the rotation committed) | proxy `refreshResponsesDropped: 1` | |
| 14 | Retry with the same `rotationId` | `agent.refresh_recovered` with the same `credentialFamilyId` (written only when the stored successor is returned for the same `rotationId`); no `agent.refresh_replay_detected`; the family is not revoked | the connector reused its persisted `rotationId` | |
| 15 | Identical successor | `agent.refresh_recovered` `refreshExpiresAt` **equals** the agent view's `credentialExpiresAt` saved after step 13 (the dropped rotation's successor) | private equality of the successor (proxy digest), published as yes/no | |
| 16 | Rolling expiry advances | agent view `credentialExpiresAt` saved at steps 9 and 13 increases | — | |
| 17 | Drop SSE | — (the server keeps no SSE record) | proxy `sseStreamsCut > 0`; REST still answers | |
| 18 | Safety polling | `message.delivered` then `agent.work_claimed` for work sent while SSE is cut | no SSE event reached the connector | |
| 19 | Retry-delayed work | `agent.work_failed` with `retryable: true`, `attempts: 1`, `retryAt` | the single injected pre-effect failure | |
| 20 | Processed when eligible | a second `agent.work_claimed` for the **same** `workId`, `fence: 2`, `createdAt ≥ retryAt`; one `message.processed`; one receipt | no new SSE event | |
| 21 | Revoke the family | `agent.credentials_revoked` (`credentialFamilyCount`); agent view `credentialRevoked: true`, `connection.state: revoked` | — | |
| 22 | Connector `REVOKED` | presence stops | terminal `REVOKED`, no re-enrollment | |
| 23 | Nothing succeeds afterwards | `presence.lastSuccessfulRefreshAt` does not advance; no `agent.refresh_recovered`, `agent.work_claimed`, `message.processed`, `message.queued` or receipt after the revoke time | each of refresh, claim, send, MCP write and late settlement denied with `401 CREDENTIAL_REVOKED` (late settlement via the proxy's held request) | |

## Result

| Field | Value |
| --- | --- |
| Rows PASS | / 23 |
| Defects found (lane, PR) | |
| Lane A sign-off (`GATE GA PASS/FAIL @sha`) | |
| Human countersign | |
