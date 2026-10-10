# Agent-native v2 shared contract handoffs

This file records shared contracts **before** their implementation. The integrator owns changes to `src/server.js` and shared schemas. Other phases remain ordered A1 → A3 → A2 → A4 → A5 → Phase A hosted acceptance → Phase B.

## A1: renewable credentials and replay-safe rotation

**Current contract.** `POST /api/agent-token` takes `{grantType:"refresh_token",agentRefreshToken}`. `src/server.js` consumes the old refresh token, issues a new access/refresh pair, and returns it once. A credential family's `refreshExpiresAt` is fixed at enrollment. `sdk/typescript/src/connector.ts` saves the successor only after the response; loss of that response or crash before save strands the connector. Current old-token replay returns 401.

**Proposed change.** The trusted connector persists a stable `rotationId` in its private session state before sending the request. The request includes that ID. The server atomically marks the old refresh credential used, extends the family expiry by the configured inactivity lifetime, creates one successor, and stores a short-lived AES-GCM recovery envelope bound to the old raw refresh token, rotation ID, family, and a server secret/context. A retry of the exact old token and rotation ID during the recovery period receives exactly the same successor. A different ID, expired recovery, or revoked family is rejected. The connector atomically saves the successor and clears its pending rotation. Rachel explicitly chose **mandatory `rotationId` with every connector updated together** on 2026-10-07; the A1 release cannot be staged server-only or advertised as compatible with already-running old connector binaries.

**Reason.** Current refresh expiration kills otherwise healthy installations after roughly 30 days, and a lost rotation response may require re-enrollment. A stable request ID plus short encrypted recovery fixes this without storing plaintext successor tokens or creating immortal credentials.

**Dependent modules.** `src/server.js` credential issue/rotate/authentication paths; TypeScript SDK `rotateAgentToken` and `SinaloaConnector`; connector persistence in `integrations/connector`; Hermes/OpenClaw bridges that reuse the connector; auth/SDK/integration tests; deployment configuration for the existing `SINALOA_DATA_ENCRYPTION_KEY` secret. No model-facing token exposure.

**Migration impact.** Existing credential families keep their identity and grants; no agent re-enrollment. Existing stored sessions without `pendingRotation` remain valid once an updated connector writes that field before its first rotation. Every shipped connector and direct SDK caller must be updated and tested in the same candidate. Before deploying the server change, distribute the updated Hermes, OpenClaw, xAI, and generic connector bundles and arrange to restart old running installations at cutover; an old binary will fail its next refresh because it omits mandatory `rotationId`. Do not promote or merge A1 until the combined server/bundle candidate, restart sequence, and rollback target are accepted. A rotation already pending during a server-secret change may need owner reconnect because recovery encryption uses the configured data-encryption key. The recovery record must be garbage-collectable after a bounded window and invalidated by revocation. Hosted validation must use a known release SHA and simulate an actual lost response.

**Status.** Implemented in the A1 branch, pending exact-commit CI and review. The API now requires `rotationId`; the TypeScript connector saves it before refresh and recovers a lost response within five minutes. The Python SDK and direct TypeScript SDK require callers to supply their own persisted ID. Hermes, OpenClaw, and xAI bridges use the updated connector. Phase A hosted acceptance and any production promotion remain separate.

## a3-pause-auth v1

**Contract:** `a3-pause-auth`, version 1. **Status:** approved by the human on 2026-10-09 (`CONTRACT-APPROVED a3-pause-auth v1 @e97853c`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/a3-pause-auth/`](../../../test/contract-fixtures/a3-pause-auth/). It holds:
- `schemas.json`, which contains the draft-07 schemas and the machine-readable code table `x-codes`;
- one JSON file per case.

All files are registered in `test/contract-fixtures/index.json`.

**Owner:** Lane A. **Consumer:** Lane B (A2 connector lifecycle, SDKs, UI). **Implemented by:** task A-1.

None of this is implemented yet. Where the server behaves differently today, the text says "Current behavior".

This contract covers the stable codes an agent credential can receive, what each code means for the connector, how a paused agent behaves, and the pause/resume events. It applies D1 from [claude-codex-build-plan.md](claude-codex-build-plan.md) §1 and v3 §10–§20.

### 1. Error envelope

Every error covered by this contract has this JSON body:

```json
{ "code": "AGENT_PAUSED", "error": "AGENT_PAUSED", "message": "This agent is paused by its owner.", "requestId": "req_example" }
```

- **`code`** is the stable machine code. Clients branch on `code` only. They never branch on `message` or on the HTTP status alone.
- **`error`** always equals `code`. It stays for clients that already read a code from `error`.
- **`message`** is safe to show a human. Clients display `message`, not `error`.
  - It never contains a credential or token fingerprint.
  - It never reveals whether some other token exists.
- **`requestId`** echoes the client's `x-request-id` only if it matches `^[A-Za-z0-9._:-]{1,128}$`. Otherwise the server generates one.
- **Optional fields:**
  - `retryAfterSeconds` (`RATE_LIMITED`);
  - `caseId` (`CASE_CONTROLLED`);
  - `reason` (`CREDENTIAL_REVOKED`; see §2).
- **Forward compatibility.** Clients ignore unknown fields. New optional fields are additive and do not bump the version.

**Current behavior.** There are four different error shapes today:
- Routes that use `fail()` send `{ "error": "<message>" }`. This includes the claim pre-check, MCP, SSE connect and rate limiting.
- Errors thrown with a code send `{ "error": "<CODE>", "message", "requestId" }` with no `code` field. `CASE_CONTROLLED` is one of these.
- Errors thrown without a code send `{ "error": "REQUEST_FAILED", "message", "requestId" }`. Refresh and in-transaction claim errors are like this.
- The header-based `ACCOUNT_CHANGED` sends `{ "error": "<message>", "code": "ACCOUNT_CHANGED" }`.

A-1 moves every case in §2 to the single envelope above. Errors not listed in §2 keep their current shape in v1. Examples are enrollment rejections, validation `400`s, permission `403`s and `AGENT_BLOCKED`.

### 2. Codes

The columns mean:
- **Lifecycle:** the A2 connector state (v3 §19) the connector enters. `UNCHANGED` means the state does not change.
- **Guidance:** the safe, user-facing hint the connector or UI shows.

The same table is machine-readable in `schemas.json` → `x-codes`. The fixture test checks every fixture against it.

| Code | HTTP | Returned when | Next allowed operation | Lifecycle | Guidance |
| --- | --- | --- | --- | --- | --- |
| `AGENT_PAUSED` | 409 | A valid credential of a **paused** agent tries to act. That covers send, case action, proposal, any `/mcp` request, `mcp-read-token`, any request made with an `mcp_read` token, or settling a lease (`renew`, `acknowledge`, `complete`, `fail`, instruction `reply`). Never returned by claim, refresh, status, connection-status, SSE or delta (§3). | Stop actions. Keep refreshing, keep SSE open, read `GET /api/agent/status`. Wait for `agent.resumed`. Do not re-enroll or reconnect. | `PAUSED` | `wait_for_resume` |
| `CREDENTIAL_REVOKED` | 401 | This credential family can no longer be used. `reason` says why. **`revoked`:** the owner revoked access, or the agent was revoked or removed. **`replaced`:** a reconnect issued a newer family, and every reconnect revokes all earlier families. **`refresh_replay`:** the family was revoked after a `REFRESH_REPLAY`. Returned for access tokens and refresh tokens. | None. Stop claims, sends, refresh, MCP, case writes and late settlement. | `REVOKED` | `revoked` → `owner_reenroll`; `refresh_replay` → `owner_reenroll`; `replaced` → `replaced_by_reconnect` |
| `CREDENTIAL_EXPIRED` | 401 | The family's rolling inactivity expiry passed (`refreshExpiresAt`, 30 days by default). Returned for refresh and for access tokens of that family. Pause does not extend the expiry. | No refresh. The owner issues a reconnect for the **same** identity (§4). Do not enroll a new agent. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `ACCESS_TOKEN_EXPIRED` | 401 | The access token expired but its family is valid. | Refresh once with the stored refresh token, then retry the original request once. | `UNCHANGED` | `none` |
| `AUTHENTICATION_REQUIRED` | 401 | The bearer token is missing, malformed, unknown, or belongs to a different inbox than the route. The response is identical whether or not a similar token exists. | If the connector holds a refresh token, refresh once. If that fails, follow the code the refresh returns. | `UNCHANGED` | `none` |
| `ROTATION_ID_REQUIRED` | 400 | `POST /api/agent-token` without a `rotationId` that matches `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. Checked before the token is looked up, so it reveals nothing about the token. The token is **not** consumed. | Do not retry automatically. The stored credential stays valid for the updated connector. | `NEEDS_RECONNECT` | `update_connector` |
| `REFRESH_TOKEN_INVALID` | 401 | One of three cases. (a) The refresh token is unknown, malformed or no longer retained. (b) It was already used, but its record does not say which `rotationId` used it, which is true of records written before A-1. (c) Its own expiry passed while the family is still valid. Identical whether or not a similar token exists. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `REFRESH_REPLAY` | 401 | A refresh token that was **already used** is presented with a **different** `rotationId` from the one that used it. This means two holders of one token, so the server **revokes that family**: later requests get `CREDENTIAL_REVOKED` with `reason: "refresh_replay"`. The server also closes the family's streams with `credential.ended` and audits `agent.refresh_replay_detected` for the owner. A1's same-`rotationId` recovery already covers an honest lost response, so this never fires for a correct connector. | None. Do not retry with another `rotationId`. | `REVOKED` | `owner_reenroll` |
| `REFRESH_RECOVERY_EXPIRED` | 401 | An already-used refresh token is presented with the **same** `rotationId` after the 5-minute recovery window, so the successor can no longer be returned. Also returned when the recovery envelope cannot be decrypted, for example after a data-encryption key change. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `CASE_CONTROLLED` | 409 | A human paused or revoked this **case**. Case-scoped: the agent keeps working other cases. A case resume cannot override an agent pause, and `AGENT_PAUSED` takes precedence when both apply. The body includes `caseId`. | Skip that case. Do not retry the write until the case resumes. Claim never offers work from a controlled case. | `UNCHANGED` | `case_paused` |
| `ACCOUNT_CHANGED` | 409 | Browser only, from either of two paths. (1) A mutating human request whose `x-envoi-expected-human` header names a different account from the session cookie. (2) The session's human changed while a human mutation was being authorized. Never returned to agent credentials. | The browser reloads before doing anything else. | `NOT_APPLICABLE` | `reload_browser` |
| `RATE_LIMITED` | 429 | Request rate limit, or too many concurrent event streams for one principal. Includes a `retry-after` header (seconds) and `retryAfterSeconds` in the body. | Wait at least `retry-after`, then retry with jittered backoff. | `DEGRADED` until a request succeeds | `service_busy` |
| `INTERNAL_SERVER_ERROR` (500), `AUTH_UNAVAILABLE` (503), any other 5xx, a non-JSON 502/503/504 from the edge, a network error or a timeout | 5xx / none | Server, edge or network failure. Never an authorization decision. | Retry with bounded exponential backoff and jitter, and keep all credentials. A refresh that fails this way keeps its pending `rotationId` and retries with the **same** ID (A1 recovery). | `DEGRADED` until a request succeeds | `service_unavailable` |

#### 2.1 Precedence on access-token routes

`RATE_LIMITED` may be returned before any of these checks. After that, the first matching check wins:

1. `AUTHENTICATION_REQUIRED`: no recognizable token for this route.
2. `CREDENTIAL_REVOKED`: the family is revoked, even if the access token has also expired.
3. `CREDENTIAL_EXPIRED`
4. `ACCESS_TOKEN_EXPIRED`
5. `AGENT_PAUSED`: only on the operations listed in §2. A paused agent learns it is paused before any validation or permission error.
6. Validation `400`s and permission `403`s, which are unchanged.
7. `CASE_CONTROLLED`

A valid paused credential is therefore never reported as `401`. An expired or revoked one always is.

#### 2.2 Refresh outcome order (`POST /api/agent-token`)

The first matching step wins:

1. `rotationId` missing or malformed → `ROTATION_ID_REQUIRED`.
2. Token unknown, malformed or not retained → `REFRESH_TOKEN_INVALID`.
3. Family or agent revoked or removed → `CREDENTIAL_REVOKED`.
4. Family expired → `CREDENTIAL_EXPIRED`.
5. Token already used:
   - the used record has no stored `rotationId` hash → `REFRESH_TOKEN_INVALID`;
   - a different `rotationId` → `REFRESH_REPLAY`, and the family is revoked;
   - the same `rotationId`, inside the recovery window → `200` with the identical successor;
   - the same `rotationId`, after the window or when the envelope cannot be decrypted → `REFRESH_RECOVERY_EXPIRED`.
6. Token unused but past its own expiry → `REFRESH_TOKEN_INVALID`.
7. Otherwise → `200` with a new successor. The agent may be `active` **or** `paused`, and the response does not say which.

For step 5, A-1 adds the hash of the consuming `rotationId` to the used refresh-credential document. That keeps the cases distinguishable after the 5-minute encrypted envelope is reaped. This is a new field on a stored document, not a SQL migration. Records written before A-1 lack it and fall under the first bullet of step 5.

**Current behavior:** steps 2–6 all return `{ "error": "REQUEST_FAILED", ... }` with HTTP `401`. A paused agent's refresh is rejected. A replay does not revoke the family.

### 3. Paused agent behavior

An agent is paused when the owner calls `POST /api/inboxes/{inboxId}/agents/{agentId}/pause`. A paused agent stays **addressable and authenticated**: it can observe and maintain its credential but cannot act (`canReceive` true, `canAct` false; v3 §11).

| Operation by a paused agent with a valid **access token** | Result |
| --- | --- |
| `POST /api/agent-token` (refresh) | `200` with a normal successor. Refresh never grants action rights. |
| `GET /api/agent/status` (new in v1) | `200` `{ "state": "paused", "agent": { "id", "address", "status": "paused" }, "inboxId" }`. An active agent gets `"state": "active"`. A5 adds presence fields additively. |
| `POST /api/agent/connection-status` | `200`, as today. |
| `GET /api/inboxes/{inboxId}/events` (SSE) and `.../events/delta` | Allowed. Pausing **no longer closes** the stream (§5). |
| Read-only `GET`s the access token could already make (inbox, cases, messages) | Allowed. |
| `POST /api/agent/work/claim` | `200` `{ "work": null, "state": "paused" }`. Never an error. |
| Any request on `/mcp`, including `initialize` and `tools/list` | HTTP `409` with the §1 envelope, `code: "AGENT_PAUSED"`, not a JSON-RPC result. MCP clients surface it as a transport error. |
| Any request made with an `mcp_read` token, including `GET`s | `409 AGENT_PAUSED`. Model-held read tokens stop working during a pause. |
| Any other mutating request, including settling a lease claimed before the pause | `409 AGENT_PAUSED` |

Every claim response gets a `state` field:
- `"claimed"` when `work` is present;
- `"idle"` when there is nothing to claim;
- `"paused"` as above.

The rest of the claim response does not change. `work.message` remains the stored message record: either the full native agent message (schema `nativeWorkMessage`: protocol envelope fields plus `senderType`, `senderAgentId`, `senderInboxId`, `recipientAgentId`, `recipientInboxId`, `recipientEmail`, `transport: "native"`, `text` and `status`), or a human instruction in its current shape. `nextAvailableAt` is reserved for `a4-wake`.

**Current behavior:** a paused agent's claim, MCP request and status read all return `401`. Its `mcp_read` token is rejected too, because `getAgentPrincipal` requires `active`.

#### Held work

Pause alone never:
- consumes a delivery or work attempt;
- advances backoff;
- dead-letters anything.

Held work stays durable until one of three things happens: resume, explicit human cancellation, or a separately documented retention action.

- **Inbound to a paused recipient.** The sender's request is accepted exactly as if the recipient were active: `202`, `status: "queued"`, no `404`, no dead letter. In a case with **no** held outbound message, delivery then proceeds normally. The message reaches the paused recipient's inbox (`status: "delivered"`), and only the recipient's work is held: it is not claimable until resume. **Current behavior:** `404 Recipient is unavailable`.
- **Outbound from a paused sender.** On pause, the agent's already-queued outbound items move to `status: "held"` with `heldReason: "sender_paused"` and `heldAt`. Attempt count and next-attempt time do not change. The paused agent and its owner see this on the message record (fixture `sender-paused-held-message`).
- **D1 per-case barrier.** Outbox ordering is strict per case in both directions: the `orderingKey` is the `caseId`. While a case has a `sender_paused` message, every later outbox item in that case stays queued behind it. This includes the active counterparty's reply. That reply is still accepted with the same `202` and `status: "queued"` as any other send. The counterparty is **not** told that the other side is paused, and it never sees a held message ID. The item is never rejected or dead-lettered, and it is delivered in order once the barrier clears. On the owner's side, the message record shows `status: "held"`, `heldReason: "case_ordering"` and `heldBehindMessageId`. This is the explicit exception to v3 §12 for that case only.
- **Barrier release.** The barrier stays while **any** `sender_paused` message remains in the case. It clears in one of two ways:
  - **Resume.** The sender's held messages become eligible in order, followed by the items behind them.
  - **Human cancellation.** A human cancels the held messages, each with `POST /api/inboxes/{inboxId}/messages/{messageId}/cancel` (human session, workspace manager). The response is `200` with the message in `status: "cancelled"`. Cancellation publishes `message.cancelled` (§5). It does **not** resume the agent. When the last `sender_paused` message in a case is cancelled, the case is released immediately.
- **In-flight lease.** Pausing during a fenced claim invalidates the lease.
  - Later settlement with that lease returns `409 AGENT_PAUSED`.
  - The attempt count does not increase.
  - On resume, the work is offered again with a new fence and the same idempotency protection.
  - External effects committed before the pause stay recorded and are not silently retried.
- **Oversight.** The owner sees the held count and the oldest held age. A-1 names the UI fields; this contract does not.

### 4. Reconnect while paused

**Issuing.** The owner can issue a reconnect token (`POST /api/inboxes/{inboxId}/agents/{agentId}/credentials/reconnect-token`) for an approved agent that is **active or paused**. The response is today's `201` response.

**Redeeming.** Redeeming the token at `POST /api/agent-enroll` issues a new credential family for the **same** identity, so address, cases and history are kept.
- As today, it **revokes every earlier family**. Their holders get `CREDENTIAL_REVOKED` with `reason: "replaced"`.
- The response is today's reconnect response with `agent.status: "paused"`. The agent stays paused.
- Claims and actions reopen only after a separate human resume.

**Current behavior:** issuing and redeeming both require `active`.

The long-pause path:
1. The agent is offline for more than 30 days while paused.
2. Refresh returns `CREDENTIAL_EXPIRED`, and the connector moves to `NEEDS_RECONNECT`.
3. The owner reconnects. The connector is now `PAUSED` with fresh credentials.
4. The owner resumes. The connector moves to `RUNNING`.

### 5. Events

**Persisted events** use the existing stream format:
- the SSE `id` is the event cursor;
- the SSE `event` is the type;
- `data` is the JSON event `{ id, type, createdAt, sequence, cursor, ... }`.

Clients ignore unknown fields and unknown event types.

| Event | When | Fields beyond the common ones |
| --- | --- | --- |
| `agent.paused` | The owner pauses the agent. The stream stays open afterwards. | `agentId`, `humanId`, `status: "paused"` |
| `agent.resumed` | The owner resumes the agent. | `agentId`, `humanId`, `status: "active"` |
| `work.available` | **New.** Sent right after `agent.resumed` when the agent has held work, so it does not wait for a poll. | `agentId`, `reason: "agent_resumed"` |
| `message.cancelled` | **New.** A human cancels a held message. Sent to the canceling owner's inbox. | `messageId`, `caseId`, `humanId` |

`agent.paused` and `agent.resumed` already exist today with these fields. The change is that the stream is no longer closed after `agent.paused`.

When the connector receives `agent.resumed`, it leaves `PAUSED` and claims once immediately, whether or not `work.available` follows. `a4-wake` will add more `work.available` reasons, so v1 consumers must accept any `reason` string.

**Stream control event.** Agent streams re-check their credential family on every heartbeat, and also immediately on revoke, replay or reconnect.

- **When it fires.** The family is revoked, replaced or expired.
- **What the server sends.** It writes `event: credential.ended` with `data: { "code": "CREDENTIAL_REVOKED" | "CREDENTIAL_EXPIRED", "reason"? }` and no `id`, then closes the stream.
- **Why there is no `id`.** It is not a persisted event, so it does not move the cursor.
- **How the connector reacts.** It applies the lifecycle for that `code` from §2.

**Current behavior:** agent streams are never re-authorized, and `disconnectAgentStreams` closes them without sending an event. The stream itself does not reach the connector's error handling, so SSE connect errors (for example, too many streams) also use the §1 envelope after A-1.

### 6. Fixtures

**Fixture file fields.** Each fixture file has:
- `contract`, `version` and `id` (the file name without `.json`);
- `description`;
- `kind`: `http`, `sse` or `network`;
- the request and response, or the event, or the network failure;
- a `client` block with:
  - the expected `lifecycle`: a v3 §19 state, `UNCHANGED` or `NOT_APPLICABLE`;
  - the `retry` policy: `none`, `refresh_then_retry_once`, `after_retry_after`, `backoff`, `after_resume` or `after_case_resume`;
  - the required `guidance` (values from §2, plus `none`);
  - the `next` operation.

**What `test/contract-fixtures.test.js` checks.** Every HTTP response body and SSE event names a definition in `schemas.json`. The test then checks:
- every fixture against its schema;
- that `error` equals `code`;
- that each error fixture's HTTP status, lifecycle, retry and guidance match `x-codes`;
- that SSE ids are cursors;
- that no `message` and no fixture value contains a real-looking token. All token values are placeholders.

| Group | Fixtures |
| --- | --- |
| Codes | `agent-paused-send`, `agent-paused-settlement`, `agent-paused-mcp`, `agent-paused-mcp-read-token`, `credential-revoked-claim`, `credential-revoked-refresh`, `credential-replaced-claim`, `credential-expired-refresh`, `credential-expired-claim`, `access-token-expired`, `authentication-required`, `rotation-id-required`, `refresh-token-invalid`, `refresh-replay`, `refresh-recovery-expired`, `refresh-recovered`, `case-controlled`, `account-changed`, `rate-limited`, `server-error`, `auth-unavailable`, `edge-unavailable`, `network-failure-refresh` |
| Paused behavior | `paused-claim`, `idle-claim`, `claimed-work`, `paused-refresh`, `paused-status`, `paused-recipient-accepted`, `case-ordering-reply-accepted`, `sender-paused-held-message`, `cancel-held-message`, `reconnect-token-while-paused`, `reconnect-while-paused` |
| Events | `event-agent-paused`, `event-agent-resumed`, `event-work-available`, `event-message-cancelled`, `event-credential-ended` |

### 7. Compatibility and migration

**Server behavior changes old connectors will see after A-1.** Each one is less disruptive than today's behavior:
- A paused agent's claim returns `200` with `state: "paused"` instead of `401`.
- Its refresh succeeds instead of returning `401`.
- Pausing no longer closes SSE.
- A send to a paused agent is accepted instead of returning `404`.
- A detected refresh replay now revokes the family.

**Consumer changes Lane B must make (B-1 and B-3).** Without these, the new envelope reads badly or cannot be acted on:
- **Display text.** The TypeScript SDK (`sdk/typescript/src/index.ts` `responsePayload`), the Python SDK (`sdk/python/sinaloa_protocol`) and the connector's work calls (`sdk/typescript/src/connector.ts` `postWork`) take `body.error` as the human-readable text. After A-1, `error` is the code, so users would see `AGENT_PAUSED`. Read `message` for display.
- **Branching.** Pass `code` through to the thrown error so A2 can branch on it.
- **Statuses.** Add `held` and `cancelled` to the `DeliveryState` unions (`sdk/typescript/src/index.ts`, `frontend/src/types.ts`).
- **Browser.** The browser already reads `code` for `ACCOUNT_CHANGED`. It will now also catch path (2) in §2, which it misses today.

**Data.** No SQL migration is needed:
- `held` and `cancelled` are new values in the existing text status column, and held work keeps its attempt counters;
- the used refresh-credential document gains one field (§2.2).

**Rollback.** Reverting A-1 restores today's behavior. The rollback procedure written with A-1 must move messages left in `held` back to `queued`. Families revoked by a replay stay revoked.

### 8. Revisions within v1

- **MISMATCH round 1, from Lane B, against `564b9dd`.** `claimed-work.json` returned a cut-down `work.message` with no sender or recipient fields, and the existing SDK correctly rejected it. This was a fixture error, not a contract change, so the version stays 1:
  - the fixture now carries the complete stored native message;
  - `claimClaimed.work.message` now requires `nativeWorkMessage` (or a human instruction);
  - the fixture test also checks the message's protocol envelope with the server's own `assertValidProtocolMessage`.

- **v2 (`envoi-names` v1, Envoi naming N1), published in the N1 server PR (`lane-a/N1-envoi-names-server`).** The only change is the credential prefixes in fixtures and schemas: `envoi_agent_access_`, `envoi_agent_refresh_` and `envoi_mcp_read_`, with example addresses on `envoi.mail`. Codes, statuses, lifecycle, events and behaviour are identical to v1. The regenerated v2 fixtures land in that PR together with the server change, so fixtures and server never disagree on one SHA; `index.json` lists a3 as version 2, status `published`. It needs a Lane B ACK and human approval like any version.

## a4-wake v1

**Contract:** `a4-wake`, version 1. **Status:** approved by the human on 2026-10-10 (`CONTRACT-APPROVED a4-wake v1 @e9c00ac`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/a4-wake/`](../../../test/contract-fixtures/a4-wake/), which holds:
- `schemas.json`: the schemas plus the `x-codes` table;
- one JSON file per case.

**Owner:** Lane A. **Consumer:** Lane B (B-2 resilient wake). **Implemented by:** task A-2. Nothing here changes server behavior until A-2; anything A-2 changes is marked **Current behavior**.

This contract builds on `a3-pause-auth` v1:
- its error envelope and codes;
- `credential.ended`;
- `GET /api/agent/status`;
- the `agent.paused`, `agent.resumed` and `work.available` events (a3 §5).

It defines how a connector learns that work may be waiting:
- the event stream and resume rules;
- the delta endpoint for gaps;
- which events trigger a claim;
- the claim hint;
- the bounded polling a connector must keep.

**The queue stays authoritative.** Every wake signal is only a hint to call `POST /api/agent/work/claim`. A connector that misses every event must still settle all work through claims. There is no new WebSocket service and no parallel queue (v3 §21–§26).

### 1. Cursors

- **Scope.** A cursor identifies one stored event in one inbox. Clients store the last *processed* cursor **keyed by `inboxId`**.
- **Format.** A cursor is the event's sequence number written as exactly 20 decimal digits, zero-padded (for example `00000000000000000042`). Sequences are allocated per inbox in commit order, so within one inbox comparing two cursors as strings is the same as comparing them as numbers.
  - Clients may compare cursors of the same inbox to drop duplicates or detect regressions. The TypeScript connector already does this.
  - Clients never construct cursors and never compare cursors across inboxes.
- **No other format is served.** The server never serves events without a sequence. If an inbox still has such legacy events, its history is reported as `EVENT_HISTORY_UNAVAILABLE` (§5) until migrated. **Current behavior:** a `createdAt|id` fallback cursor exists in code for unmigrated events.
- **Validation.** A resume cursor is rejected with `EVENT_CURSOR_INVALID` if it is:
  - not exactly 20 digits;
  - or greater than the inbox's newest sequence, for example after a database restore restarted sequences or when it comes from another inbox.

  Silently accepting such a cursor would skip events.

### 2. Event stream

`GET /api/inboxes/{inboxId}/events` (SSE).

**Authentication**
- The stream takes the agent's **access** token and is allowed while paused (a3 §3).
- An `mcp_read` token is rejected with 401 `AUTHENTICATION_REQUIRED`.
- A request that carries a human session cookie is treated as a human stream, so connectors must not send cookies.
- **Current behavior:** auth failures on this route use the old `{ error }` shape. A-2 uses the a3 envelope.

**Where the stream starts**

| Request | Start |
| --- | --- |
| `Last-Event-ID` header (takes precedence) or `?cursor=` | After that cursor. An empty value means no cursor. |
| `?from=latest` and no cursor | No replay. `ready` reports the inbox's newest cursor (or `null` for an empty inbox), which the client stores as its baseline (see below). For a connector with no stored cursor for this inbox, or one resetting after `EVENT_CURSOR_INVALID`. It then claims. (New in A-2.) |
| Neither | Replay from the beginning of the inbox history. |

**Replay limit.** One connection replays at most 500 events (5 pages of 100). Beyond that the server sends `replay_required`, and the client continues through delta (§3).

**Frames**

| Frame | SSE `id` | `data` | Meaning and client action |
| --- | --- | --- | --- |
| Stored event (e.g. `message.delivered`) | its cursor | the event JSON `{ id, type, createdAt, sequence, cursor, ... }` | Apply it, then store `cursor`. Ids increase strictly on one connection and start above the resume cursor. Drop anything at or below the stored cursor. |
| `ready` | none | `{ inboxId, at, cursor }`. On a `from=latest` stream, `cursor` is the inbox's newest cursor. Otherwise it is the last cursor sent on this connection, else the resume cursor, else `null`. | Replay is complete and live events follow. **Claim once** (§4). Store `cursor` only on a `from=latest` stream (baseline rule below). |
| `replay_required` | none | `{ cursor, hasMore: true }`; `cursor` follows the same rule as `ready` | The server could not finish replay on this connection and closes it. Page delta from your own last processed cursor until `hasMore` is false, reconnect from the newest cursor, then claim once. |
| `replay_error` | none | `{}` | Transient server failure, and the stream closes. Reconnect with backoff (§6). |
| `credential.ended` | none | a3 §5 | Apply the lifecycle for `data.code`. Do not reconnect with that credential. |
| `: keepalive <ISO time>` (comment) | — | — | Every 20 s. With no frame or comment for 60 s, close the stream and reconnect. |

**Cursor persistence.** The client keeps one stored cursor per inbox.
- **Normal rule:** it advances only when a stored event (a frame with an `id`) has been processed. Control frames without an `id` (`ready`, `replay_required`, `replay_error`, `credential.ended`) never advance it, and their `cursor` fields are informational.
- **Baseline exception:** on a `from=latest` stream, the client stores `ready.cursor` as its starting cursor before processing any later event. This applies only when the inbox has no stored cursor or the client is resetting after `EVENT_CURSOR_INVALID`. If `ready.cursor` is `null`, the stored cursor stays empty until the first event.
- **Why the exception is safe:** nothing is skipped silently. Pending work lives in the queue, and the claim that follows `ready` picks it up.

Clients ignore unknown event types and fields, but still store their cursor. Human-only frames (`session.recheck`, `session.expired`, `session.revoked`) are never sent to an agent stream.

**Current behavior:**
- `replay_required` carries `{}` only when a live stream's write queue overflows. A-2 sends `{ cursor, hasMore: true }` there too.
- A history that needs migration currently produces `replay_error`. A-2 detects it before opening the stream and returns 503 `EVENT_HISTORY_UNAVAILABLE` instead, so `replay_error` only ever means transient.

### 3. Delta endpoint

`GET /api/inboxes/{inboxId}/events/delta?cursor=<cursor>&limit=<1-200>`

**Request and response**
- The default limit is 100. Authentication is the same as the stream, and the endpoint is allowed while paused.
- The response is `200 { events, nextCursor, hasMore }`, where:
  - `events` are the events after `cursor`, in cursor order, with the same JSON as stream `data`;
  - `nextCursor` is the last returned cursor, or the request cursor when the page is empty, or `null` with no cursor;
  - `hasMore: true` implies the page is non-empty.
- Repeat with `cursor = nextCursor` until `hasMore` is false. A valid cursor equal to the newest event returns an empty page with the same cursor.

**Errors** (all use the a3 envelope)

| Code | When |
| --- | --- |
| `EVENT_CURSOR_INVALID` | Invalid cursor (§1). |
| `EVENT_LIMIT_INVALID` | Invalid limit. |
| `EVENT_HISTORY_UNAVAILABLE` | Unmigrated history. |

**Use:** delta is for recovery after `replay_required` only. Connectors do **not** poll delta periodically; the safety timer claims instead (§6).

**Current behavior:**
- A cursor longer than 512 characters returns `{ error: "Event cursor is invalid" }`.
- Other cursor, limit and history errors return `{ error: "REQUEST_FAILED", message, requestId }`.
- The stream's cursor 400 uses the `{ error }` shape.
- Cursors beyond the newest event are accepted silently.

### 4. When a connector claims

**Single flight.** At most one claim request is in flight. Triggers that arrive meanwhile collapse into at most one follow-up claim, sent when the current one returns.

**Triggers**
1. Startup.
2. `ready` on a new stream.
3. The end of delta recovery after `replay_required`.
4. `work.available` (any `reason`).
5. `agent.resumed`.
6. `message.delivered` or `human.instruction_created` whose `recipientAgentId` is this agent. A `message.delivered` for this agent's *own sent* message, whose `recipientAgentId` is someone else, is not a trigger.
7. A finished piece of work. The connector keeps claiming until the claim returns `idle`.
8. The safety timer or claim hint (§6).

All other events only advance the cursor.

**Paused.** A claim returning `state: "paused"` stops triggers 1–8 until the connector sees the agent active again, by either route:
- `agent.resumed`;
- or `GET /api/agent/status` returning `state: "active"`. A paused connector reads status after every `ready` or reconnect and every 30–60 s with jitter, so a missed or unreplayable `agent.resumed` cannot keep it paused forever.

**`work.available` reasons.** Consumers must accept any `reason` string; producers emit only these. Every event is written to the agent's own inbox and carries exactly `{ id, type, createdAt, sequence, cursor, agentId, reason }` plus `caseId` where noted. It never names the human or the other workspace.

| `reason` | `caseId` | Emitted when |
| --- | --- | --- |
| `agent_resumed` | no | The owner resumed this agent and inbound work is waiting (a3). |
| `case_resumed` | yes | A human (from either side) resumed a paused case. One event goes to each participant inbox whose agent has claimable inbound work in that case, in the same case mutation. |
| `counterparty_resumed` | no | An agent that had sent this agent delivered-but-unclaimable work (claims skip work from a sender that cannot act) was resumed. |
| `lease_released` | no | A reconnect issued a new credential family. The server released this agent's live leases held by the replaced families, without using an attempt (like the a3 pause re-offer), so the new installation can claim them now rather than waiting up to the lease length. |

Normal arrivals produce `message.delivered`, not `work.available`.

**Safety timer only.** These changes make work claimable with no event:
- retry delays ending;
- lease expiry;
- a contact being unblocked;
- human-instruction authority being restored.

They are covered by the claim hint (§5) and the safety timer (§6).

### 5. Claim hint

An empty claim (`state: "idle"`) may carry two fields:
- **`nextAvailableAt`**: an ISO time, never in the past;
- **`nextAvailableInMs`**: a non-negative integer, the same instant measured from the response.

Clients schedule from `nextAvailableInMs`, so clock skew does not matter.

The value is the earliest of two times, considering only work that passes every eligibility filter of the claim itself except time:
- the request's `acceptHumanInstructions`;
- the case not paused or revoked;
- the sender able to act;
- no block;
- attempts remaining;
- human-instruction authority.

The two times are:
- the `retryAt` of this agent's retryable work;
- the `leaseExpiresAt` of this agent's live leases from any of its credential families.

Both fields are absent when nothing is scheduled. They are never sent with `state: "paused"` and never refer to other agents' work. **Current behavior:** never sent.

### 6. Polling and backoff

**Safety timer**

| State | Rule |
| --- | --- |
| Healthy stream | Claim every 30–60 s, uniform jitter. A hint earlier than that schedules one claim at that time, at least 1 s away. |
| Disconnected or degraded (reconnecting, `replay_error`, missed keepalive) | Claim every 15 s ±20 % jitter. |
| Paused | No claims. Status as in §4. |

**Reconnect**
- Use exponential backoff from 1 s to 30 s with full jitter.
- Reset the backoff only after a stream has stayed open for 60 s.
- Close the previous stream before opening a new one.
- A 429 `RATE_LIMITED` on connect (for example too many concurrent streams) waits at least `retry-after`.

**Exactly-once settlement.** The claim fence and settlement idempotency keys (existing) make each piece of work settle exactly once. A handler can still run twice if its lease expires mid-run, so connectors renew leases while working and handlers dedupe by `workId`. Gate GA4 checks that retry-delayed work and work that arrived offline each settle exactly once after reconnect, with no new event.

### 7. Codes added to the a3 envelope

| Code | HTTP | Returned when | Next allowed operation | Lifecycle | Guidance |
| --- | --- | --- | --- | --- | --- |
| `EVENT_CURSOR_INVALID` | 400 | The resume cursor is malformed, or beyond the inbox's newest event (§1). | Discard the stored cursor for this inbox, reconnect with `from=latest`, and claim once. Work is not lost because the queue is authoritative. | `UNCHANGED` | `none` |
| `EVENT_LIMIT_INVALID` | 400 | The delta limit is not an integer from 1 to 200. | Keep the cursor and fix the limit. This is a client bug, so do not retry the same request. | `UNCHANGED` | `none` |
| `EVENT_HISTORY_UNAVAILABLE` | 503 | The inbox history needs a server-side cursor migration (stream connect or delta). | Retry with backoff and keep the disconnected safety timer. | `DEGRADED` | `service_unavailable` |

### 8. Fixtures

**Fields.** Fixtures use the a3 §6 fields, with two additions:
- **`client.claim`**: whether the outcome triggers exactly one claim.
- **`kind: "sse-session"`**: has a `request` (with resume headers or query) and `frames`, an ordered list. Each frame is either `{ id?, event, data, schema }` (`schema` is required on event frames) or `{ comment }`.

**What the fixture test checks**
- **Stream frames:** control frames carry no `id`, and stored events do. Ids rise above the resume cursor. `ready` and `replay_required` report the right cursor.
- **Delta pages:** `nextCursor` and `hasMore` are consistent, and cursors rise above the request cursor.
- **Events:** producer schemas are closed.

| Group | Fixtures |
| --- | --- |
| Stream | `stream-resume-last-event-id`, `stream-resume-query-cursor`, `stream-ready-no-replay`, `stream-from-latest`, `stream-replay-required`, `stream-replay-error`, `stream-keepalive`, `stream-credential-ended`, `stream-cursor-invalid`, `stream-cursor-beyond-newest`, `stream-history-unavailable`, `stream-mcp-read-rejected` |
| Wake events | `event-message-delivered-to-agent`, `event-message-delivered-own-send`, `event-work-available-case-resumed`, `event-work-available-counterparty-resumed`, `event-work-available-lease-released` |
| Delta | `delta-page-more`, `delta-last-page`, `delta-empty-after-cursor`, `delta-cursor-invalid`, `delta-limit-invalid`, `delta-history-unavailable` |
| Claim | `claim-idle-next-available`, `claim-idle-no-hint`, `claim-paused-no-hint` |

### 9. Compatibility and B-2 notes

**Server changes are additive for a3 clients:**
- the new `work.available` reasons;
- the claim hint;
- coded stream and delta errors;
- `from=latest`;
- `cursor` always present in `replay_required`;
- releasing old-family leases on reconnect.

No new endpoints and no data migration.

**Consumer changes for B-2:**
- stop polling delta every 5 s (`sdk/typescript/src/connector.ts`, `deltaPollMs`) and use the §6 safety timer instead;
- key stored cursors by `inboxId`;
- read status while paused;
- treat `EVENT_CURSOR_INVALID` as "restart with `from=latest`".

**Rollback:** reverting A-2 removes the hints, the new reasons and `from=latest`. Clients fall back to the safety timer, which they must keep anyway.

### 10. Revisions within v1

- **MISMATCH round 1 (Lane B, `stream-from-latest`, against `67df29d`).** The no-id invariant contradicted the `from=latest` fixture, which told the client to store `ready.cursor`. §2 now separates the processed cursor, which only stored events advance, from the explicit `from=latest` baseline exception (no stored cursor for the inbox, or reset after `EVENT_CURSOR_INVALID`). The `ready` row and the wording of two fixtures now match. This is a clarification, so the version stays 1.

## envoi-names v1

**Contract:** `envoi-names`, version 1. **Status:** approved by the human on 2026-10-10 (`CONTRACT-APPROVED envoi-names v1 @2591063`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/envoi-names/`](../../../test/contract-fixtures/envoi-names/). **Owner:** Lane A. **Consumer:** Lane B. **Implemented by:** N1 (see [`docs/architecture/envoi-naming-plan.md`](../envoi-naming-plan.md)).

**What it changes:** every agent-facing name moves from Sinaloa to Envoi.

**Decision (human, 2026-10-09).** There are no beta testers yet, so this is a **clean cutover**:
- the server and every client change on **one integration SHA**;
- the server offers **no `sinaloa_*` aliases**;
- credentials issued before the cutover stop working, and their owners reconnect (§2).

This contract also defines **`a3-pause-auth` v2**. The only change is the credential prefixes in a3's fixtures and schemas; everything else is unchanged from v1. The regenerated a3 v2 fixtures are published with the N1 implementation PR, so the server and its fixtures change on the same SHA.

`a4-wake` v1, which is not yet approved, uses the new prefixes in its fixtures within v1.

### 1. MCP tool names

`tools/list` returns these names, and `tools/call` accepts only them. A call to a `sinaloa_*` name gets JSON-RPC error `-32602` "Tool not available to this agent", the same response as any unknown tool. Arguments, results and scopes are unchanged.

| Old | New |
| --- | --- |
| `sinaloa_agent_info` | `envoi_agent_info` |
| `sinaloa_list_cases` | `envoi_list_cases` |
| `sinaloa_read_case` | `envoi_read_case` |
| `sinaloa_list_messages` | `envoi_list_messages` |
| `sinaloa_start_case` | `envoi_start_case` |
| `sinaloa_send_message` | `envoi_send_message` |
| `sinaloa_send_proposal` | `envoi_send_proposal` |
| `sinaloa_send_decision` | `envoi_send_decision` |
| `sinaloa_send_completion` | `envoi_send_completion` |
| `sinaloa_claim_work` | `envoi_claim_work` |
| `sinaloa_renew_work` | `envoi_renew_work` |
| `sinaloa_acknowledge_work` | `envoi_acknowledge_work` |
| `sinaloa_complete_work` | `envoi_complete_work` |
| `sinaloa_fail_work` | `envoi_fail_work` |
| `sinaloa_list_assets` | `envoi_list_assets` |
| `sinaloa_begin_asset_upload` | `envoi_begin_asset_upload` |
| `sinaloa_complete_asset_upload` | `envoi_complete_asset_upload` |
| `sinaloa_asset_download` | `envoi_asset_download` |
| `sinaloa_grant_asset` | `envoi_grant_asset` |

A model-held `mcp_read` token still lists only `envoi_agent_info`, `envoi_read_case` and `envoi_list_messages`. The MCP `serverInfo.name` stays `envoi`.

### 2. Credential formats

| Credential | Format |
| --- | --- |
| Access token | `envoi_agent_access_` + 43 base64url characters |
| Refresh token | `envoi_agent_refresh_` + 64 base64url characters |
| Case read token (`mcp_read`) | `envoi_mcp_read_` + 43 base64url characters |

**Issuing.** The server issues only these formats. That covers enrollment, reconnect, refresh, the A1 recovery successor and `mcp-read-token`.

**Accepting.** The server accepts only these formats. Credentials are stored hashed, so a credential issued before the cutover carries the old `sinaloa_` prefix and is refused with an a3 code:
- an access or `mcp_read` token gets `AUTHENTICATION_REQUIRED`;
- a refresh token gets `REFRESH_TOKEN_INVALID`.

The connector moves to `NEEDS_RECONNECT` and the owner reconnects the same identity (a3 §4), which issues `envoi_` credentials. Agent identity, address, cases and history are kept.

**On staging and beta:** the cutover deploy is announced on the build board, and any test agent reconnects once.

### 3. Other agent-facing names

- **Health identity.** `/health` and `/ready` report `service: "envoi"` (already integrated: PRs #46 and #48).
- **Protocol schema `$id`:**
  - the message schema is `https://envoi-agents.com/schemas/protocol/v1/message.json`, in file `protocol/envoi-protocol-v1.schema.json`;
  - the agent interface is `https://envoi-agents.com/schemas/agent-interface/v1.json`.

  Messages themselves carry `schemaVersion: "1.0"` and do not change.
- **Downloads.** `web/downloads/` serves only `envoi-connector.mjs` and `envoi-openclaw.mjs`, and `release.json` lists only those. The `sinaloa-*.mjs` duplicates are no longer built (`scripts/package-openclaw.mjs`, Lane A) or served.

### 4. Client names (Lane B; informative)

Lane B owns these names. They are listed so the cutover is complete on one SHA:
- **TypeScript:** `@envoi/protocol` with `EnvoiClient`, `EnvoiConnector`, `EnvoiError` and `EnvoiIntent`.
- **Python:** `envoi-protocol` / `envoi_protocol`.
- **Connector:**
  - internal identifiers and every user-visible string;
  - the state directory `…/envoi/<runtime>/<id>`, migrating an existing `…/sinaloa/…` directory once on first start;
  - OS service labels `com.envoi.*`;
  - Hermes, OpenClaw and xAI adapter prompts and relays use only the `envoi_*` tool names.

### 5. Fixtures

**Fixtures:**
- `mcp-tools-list`
- `mcp-tools-list-case-read`
- `mcp-call-old-name`
- `credentials-issued`
- `access-old-prefix`
- `refresh-old-prefix`
- `mcp-read-old-prefix`
- `health-identity`

`schemas.json` carries the tool-name mapping as `x-tool-names`. Clients can assert their adapters reference only the new names.
