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

- **v2 (`envoi-names` v1, Envoi naming N1), approved 2026-10-10 (`CONTRACT-APPROVED a3-pause-auth v2`, build board #34, after Lane B `CONTRACT-ACK`).** The only change is the credential prefixes in fixtures and schemas: `envoi_agent_access_`, `envoi_agent_refresh_` and `envoi_mcp_read_`, with example addresses on `envoi.mail`. Codes, statuses, lifecycle, events and behaviour are identical to v1. The regenerated v2 fixtures land in that PR together with the server change, so fixtures and server never disagree on one SHA; `index.json` lists a3 as version 2, status `published`. It needs a Lane B ACK and human approval like any version.

- **v3 (`envoi-browser-names` v1 §3, Envoi naming N2), approved 2026-10-11 (`CONTRACT-APPROVED a3-pause-auth v3`, build board #34, after Lane B `CONTRACT-ACK`).** Name-only: the three human-session fixtures (`account-changed`, `cancel-held-message`, `reconnect-token-while-paused`) send `cookie: envoi_session=…; envoi_csrf=…`, `x-envoi-csrf` and an `origin`, so the real server's CSRF gate passes them before the case each one describes; v2 had neither a CSRF cookie nor an origin. Every fixture's `version` is 3. Codes, statuses, lifecycle, events and behaviour are identical to v2. The fixtures land with the N2-server implementation and integrate on one SHA with N2-client, which moves Lane B's review pin to v3; it needs a Lane B ACK and human approval like any version.

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
- **v2 (`envoi-browser-names` v1 §3, Envoi naming N2), approved 2026-10-11 (`CONTRACT-APPROVED a4-wake v2`, build board #34, after Lane B `CONTRACT-ACK`).** Name-only: every placeholder token uses `envoi_agent_access_` (and `stream-mcp-read-rejected` uses `envoi_mcp_read_`), which `envoi-names` v1 had promised for v1 but the approved v1 fixtures never carried. The token-leak guard in `schemas.json` now matches both the `envoi_` and `sinaloa_` prefixes. Every fixture's `version` is 2; behaviour is identical to v1. It lands with N2-server, integrates on one SHA with N2-client (Lane B's review pin moves to v2), and needs a Lane B ACK and human approval.

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

## a5-presence v1

**Contract:** `a5-presence`, version 1. **Status:** approved by the human on 2026-10-11 (`CONTRACT-APPROVED a5-presence v1 @a232f46`, build board #34) after Lane B `CONTRACT-ACK` (consuming tests in PR #62). Frozen: changes need a new version. Implemented by A-3.

**Fixtures:** [`test/contract-fixtures/a5-presence/`](../../../test/contract-fixtures/a5-presence/). That holds:
- `schemas.json`: the schemas plus the machine-readable tables `x-presence-throttle`, `x-presence-updates`, `x-presence-never`, `x-connection-states` and `x-agent-labels`;
- one JSON file per case.

**Owner:** Lane A. **Consumer:** Lane B (B-3 presence UI and connector diagnostics). **Implemented by:** task A-3.

This contract adds minimal Phase A presence (v3 §27–§28; two-owner plan A5). It records when the server last heard from an installation, and it shows that to the agent's owner in conservative terms. It builds on:
- `a3-pause-auth` v2: credential families, pause, and `GET /api/agent/status`;
- `a4-wake` v1: the claim loop and safety timer that keep a healthy connector talking to the server.

**What presence means.** Presence is evidence that **some process holding this installation's credentials** recently called the server. It is never proof of any of these:
- that a runtime is running;
- that a model is reachable;
- that work will be processed.

The UI must not say "online", "running" or "connected" (§5).

### 1. Presence is an installation projection

- **Keyed by credential family.** There is one presence record per credential family. In Phase A a credential family *is* the installation. Families are created by enrollment redemption, by onboarding approval and by a reconnect or re-enroll redemption. Each reconnect replaces the earlier families (a3 §4).
- **Phase B migration.** When `AgentInstallation` arrives (v3 §43–§44), each family's record becomes that installation's presence:
  - `lastSeenAt` → `lastSeenAt`;
  - `lastWorkClaimAt` → `lastClaimAt`;
  - `lastProcessedAt` → `lastProcessedAt`;
  - `lastSuccessfulRefreshAt` stays with the installation's credential.

  The agent identity is never reinterpreted as a runtime.
- **Stored apart from authorization.** This is a deliberate deviation from the wording "fields on the existing credential family" in v3 §27 and the build plan.
  - The record lives at `auth/agent-presence/{inboxId}/{agentId}/{familyId}.json`, not inside the family document.
  - The family document is written read-modify-write by refresh, revocation and setup reports. A presence write inside it could overwrite a concurrent revocation or expiry roll.
  - It is a new document path on both FileStore and PostgreSQL, not a SQL migration. No existing listing reads that prefix.
- **What it never holds.** No IP address, user agent, host name, runtime version, request path or token material. It holds only the four timestamps below.
- **Removal.** Removing an agent deletes all of its presence records, with or without `deleteHistory`.

### 2. Fields

| Field | Meaning |
| --- | --- |
| `lastSeenAt` | The last request authenticated by this family's credential (§3), including setup checks. **Diagnostic only:** it decides the connection state only while the agent is paused (§4.2). |
| `lastSuccessfulRefreshAt` | The last `POST /api/agent-token` that returned `200` for this family. That covers both a new successor and an A1 recovery of the same successor. |
| `lastWorkClaimAt` | The last **work-loop** request: a `POST /api/agent/work/claim` answered with `state: "claimed"` or `state: "idle"`, or a lease request (`renew`, `acknowledge`, `complete`, `fail`, instruction `reply`) with any outcome except `409 AGENT_PAUSED`. It shows that the connector's work loop is talking to the queue, not that work was found. Renewals keep it fresh during a long handler. A paused claim (`state: "paused"`) does not count. |
| `lastProcessedAt` | The last work `complete` that returned `201`, meaning the message became `processed`. An idempotent replay (`200`) of an earlier completion does not count. |

Each value is either an ISO 8601 UTC timestamp with milliseconds, taken from the server's clock, or `null` if it never happened.

**Write rules**
- **After the outcome, outside the request's transaction.** The server records presence once the response outcome is known, for the family that authenticated the request. It never writes inside a request's mutation or transaction. So a presence write cannot be rolled back by a failing request, and it cannot abort a successful one.
- **Throttled.** A field is written only when its stored value is absent or at least **60 s** older than the new value. Each field therefore changes at most once per family per 60 s, however many requests arrive and across all server instances. The one exception is the next rule.
- **`lastSeenAt` leads.** A write that advances any other field also advances `lastSeenAt` to the same time in the same document write, outside `lastSeenAt`'s own throttle. So `lastSeenAt` is never earlier than the other three.
- **Monotonic.** A field never moves backwards, even under concurrent requests. Each write is a single conditional storage operation that compares in storage, not in memory. A-3 adds this primitive to both FileStore and PostgreSQL; `claimJson` only checks for absence.
- **Lag.** When writes succeed, a stored value is at most 60 s earlier than the latest activity it records, and never later than it.
- **Best effort.** A presence write never changes a response's status or body. If the write fails, the request still succeeds and the failure is logged.
- **Quiet.** Presence writes are not audited and publish no events.

### 3. What updates presence

The same table is machine-readable in `schemas.json` → `x-presence-updates`. A-3 tests each row on FileStore and PostgreSQL.

**"Authenticated" means** that the server resolved the bearer token to an identity:
- a typed `envoi_` access or refresh credential of a family that is not revoked or expired;
- belonging to an approved agent that is `active` or `paused`.

That is the identity a3 §2.1 checks 1–4 accept. Credentials of pending or legacy agents, and untyped development tokens, never write presence.

| Request (authenticated by this family) | Outcome | `lastSeenAt` | `lastSuccessfulRefreshAt` | `lastWorkClaimAt` | `lastProcessedAt` |
| --- | --- | --- | --- | --- | --- |
| `POST /api/agent-token` (refresh token) | `200` | ✓ | ✓ | | |
| `POST /api/agent/work/claim` | `200`, `state` is `claimed` or `idle` | ✓ | | ✓ | |
| `POST /api/agent/work/claim` | `200`, `state: "paused"` | ✓ | | | |
| `POST /api/agent/work/{workId}/complete` | `201` | ✓ | | ✓ | ✓ |
| `POST /api/agent/work/{workId}/{renew,acknowledge,complete,fail}`, `POST /api/agent/instructions/{id}/reply` | any other response except `409 AGENT_PAUSED` | ✓ | | ✓ | |
| Any other request with an authenticated **access** token. Examples: status, connection-status, event stream connect, delta, `/mcp`, sends, case actions, read-only `GET`s | Any response, including validation `400`, permission `403`, `409 AGENT_PAUSED`, `CASE_CONTROLLED` and a `429` returned after authentication | ✓ | | | |

**What never updates presence**
- **Rejected credentials.** Any `401` (`AUTHENTICATION_REQUIRED`, `ACCESS_TOKEN_EXPIRED`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED`, `REFRESH_*`, and the uncoded `401` that pending agents get), `ROTATION_ID_REQUIRED`, and a `429 RATE_LIMITED` returned before authentication.
- **Model-held `mcp_read` tokens.** They are bearer tokens a model may pass around, so they are not evidence of the installation.
- **Enrollment and reconnect redemption** (`POST /api/agent-enroll`). Setting up credentials does not show that a runtime keeps running.
- **Holding a stream open.** Only the stream **connect** counts. Keepalives and the heartbeat credential re-check (a3 §5) do not, because a half-open connection can keep accepting writes.
- **Anything a human does.** Browser sessions, approval, pause, resume, issuing a reconnect token and an open dashboard never touch presence.

**Setup traffic.** Setup and doctor commands call `GET /api/agent/status` and `POST /api/agent/connection-status` from a short-lived process (for example `integrations/openclaw/quick-connect.ts`). Those update `lastSeenAt` only. For an active agent they never make it `seen_recently`, because that needs work-loop activity (§4.2). The setup report's `ready`/`error` result stays a setup check (`connectionSetup`) and never changes the connection state.

### 4. Where presence is exposed

**Bounded.** Each response carries exactly the fields below, for one family per agent. There is no history, list or per-request detail.

#### 4.1 The agent: `GET /api/agent/status`

The a3 status response gains two fields:
- `presence`: the calling family's four fields (§2), as stored;
- `asOf`: the server's time when it built the response.

The request's own update may not be included yet, so values can be up to 60 s behind. `asOf` follows the §4.2 rule: it is never earlier than any `presence` timestamp. Connector doctor or setup output may show these values, computing ages from `asOf`. The connector's lifecycle never depends on them.

```json
{
  "state": "active",
  "agent": { "id": "agent_example", "address": "example@envoi.mail", "status": "active" },
  "inboxId": "inbox_example",
  "asOf": "2026-10-12T12:00:42.000Z",
  "presence": {
    "lastSeenAt": "2026-10-12T12:00:00.000Z",
    "lastSuccessfulRefreshAt": "2026-10-12T11:52:10.000Z",
    "lastWorkClaimAt": "2026-10-12T12:00:00.000Z",
    "lastProcessedAt": null
  }
}
```

#### 4.2 The owner: `connection` on owner agent views

Owner views of an agent gain `connection`:
- `GET /api/inboxes/{inboxId}/agents`;
- the inbox view's `agents[]`;
- the pause and resume responses.

**Who sees it.** Only human sessions of the owning workspace.
- `GET /api/inboxes/{inboxId}/agents` also accepts the agent's own access token. For that caller the field is omitted; the agent reads its own presence from §4.1.
- `connection` is never sent to counterparties, never included in the participant directory and never put in events.

**Where it is computed.** In the owner response projection only, not in the agent control state the server uses for authorization decisions. So a presence read never slows or fails an authorization path.
- If the presence read fails, the server omits `connection` and the response still succeeds. `connection` is therefore optional for consumers. The `ownerAgent` schema describes the success path only.
- A client that gets no `connection` (a rolled-back server, or a failed read) shows "Status unknown". It never falls back to deriving "online" from enrollment or approval.

```json
"connection": {
  "state": "seen_recently",
  "asOf": "2026-10-12T12:00:42.000Z",
  "recentWindowSeconds": 300,
  "seenAt": "2026-10-12T12:00:00.000Z",
  "credentialExpiresAt": "2026-11-11T11:52:10.000Z",
  "presence": {
    "lastSeenAt": "2026-10-12T12:00:00.000Z",
    "lastSuccessfulRefreshAt": "2026-10-12T11:52:10.000Z",
    "lastWorkClaimAt": "2026-10-12T12:00:00.000Z",
    "lastProcessedAt": "2026-10-12T11:58:03.000Z"
  }
}
```

- **`asOf`** is the server's time when it built the response, raised if needed so it is never earlier than any `presence` timestamp (instances' clocks can differ slightly). `credentialExpiresAt` is not part of this rule. Clients compute ages as `asOf − timestamp`, never from their own clock, and clamp negative ages to 0.
- **`recentWindowSeconds`** is 300 in v1.
  - A healthy active connector claims every 30–60 s (a4 §6) and renews during long handlers, so with the 60 s write lag `seenAt` is at most ~120 s old.
  - A healthy paused connector reads status every 30–60 s (a4 §4), with the same bound.
  - 300 s absorbs a missed poll or a brief outage without flapping.
  - A connector run with no work handler never claims, so it shows `not_seen_recently`. Every shipped runtime has a handler.
- **`seenAt`** is the timestamp of the installation's last **check-in**, the one the state is based on:
  - `presence.lastSeenAt` while the agent is paused, because a paused connector reads status instead of claiming;
  - `presence.lastSeenAt` in the **resume grace**: the agent's `resumedAt` is at most `recentWindowSeconds` before `asOf`, and `lastWorkClaimAt` is `null` or earlier than `resumedAt`. A connector that was checking in while paused gets one window to claim after resume;
  - otherwise `presence.lastWorkClaimAt`.

  It is `null` when that field is `null`. A-3 records `resumedAt` on the agent record at each resume. Like other agent record fields, it appears in owner views.
- **Reported family.** The newest non-revoked family by `createdAt`. If every family is revoked, the newest family. If the agent has no family, there is none.
- **`credentialExpiresAt`** is the reported family's rolling `refreshExpiresAt` (a3 `CREDENTIAL_EXPIRED`). It is `null` when there is no family or the reported family is revoked.
- **`presence`** holds the reported family's four fields. They are all `null` when there is no family. A revoked agent keeps its last-known values.

**`connection.state`.** The first matching row wins. The same table, with UI labels, is in `x-connection-states`.

| # | Condition | `state` |
| --- | --- | --- |
| 1 | `status` is `revoked`, or `credentialRevoked` is `true` (every family revoked, for example after `REFRESH_REPLAY`) | `revoked` |
| 2 | `onboardingStatus` is `rejected` | `rejected` |
| 3 | `onboardingStatus` is any other value except `approved` | `pending_approval` |
| 4 | No credential family | `not_connected` |
| 5 | `credentialExpiresAt` ≤ `asOf` | `needs_reconnect` |
| 6 | `seenAt` is `null` | `never_seen` |
| 7 | `asOf − seenAt` ≤ `recentWindowSeconds` | `seen_recently` |
| 8 | Otherwise | `not_seen_recently` |

Removed agents are not listed, so they need no state.

- **Pause is separate.** `connection.state` describes the installation; the existing `paused` field describes the agent.
  - A paused agent whose connector keeps reading status is `seen_recently` with `paused: true`.
  - In the a3 long-pause path it becomes `needs_reconnect` with `paused: true`.
- **Right after resume.** The resume grace keeps the paused-time basis, so the resume response of a connector that was checking in says `seen_recently` with no flap. A running connector claims as soon as it sees `agent.resumed` (a4 §4), and the basis moves to `lastWorkClaimAt`. If it has not claimed when the grace ends, the state honestly becomes `not_seen_recently`.
- **Rejected after approval.** Rejecting an already-approved agent revokes its families, so it shows `revoked` (row 1), not `rejected`.
- **Only what the server can see.** Here, `needs_reconnect` means the family's expiry passed. A connector can also reach `NEEDS_RECONNECT` from codes the server cannot see afterwards, for example `REFRESH_TOKEN_INVALID` after a lost state file. The server shows those as `not_seen_recently` once the connector stops calling.
- **Unknown values.** Clients must accept unknown `state` values and show them as "Status unknown".

### 5. Owner UI wording (B-3)

| `state` | Connection label | Must never claim |
| --- | --- | --- |
| `seen_recently` | "Seen recently" | That the runtime is online, running or will process work |
| `not_seen_recently` | "Last checked in {relative time of `seenAt` from `asOf`}" | That the runtime is stopped or broken |
| `never_seen` | "Not checked in yet" | That enrollment or a passed setup check means the runtime runs |
| `not_connected` | "Not connected" | |
| `needs_reconnect` | "Needs reconnect" | |
| `pending_approval` | "Waiting for approval" | |
| `rejected` | "Not approved" | |
| `revoked` | "Access revoked" | |
| missing `connection`, or an unknown `state` | "Status unknown" | Anything derived from enrollment or approval |

- **Agent label** (`x-agent-labels`; first match wins):
  1. "Revoked" when `status` is `revoked` or `credentialRevoked` is `true`;
  2. "Rejected" when `onboardingStatus` is `rejected`;
  3. "Pending" when `onboardingStatus` is any other value except `approved`;
  4. "Paused" when `paused` is `true`;
  5. otherwise "Active".
- **Show both.** Show the agent label next to the connection label, for example "Paused · Seen recently".
- **Nothing in the browser changes the label.** Enrollment, approval, issuing a reconnect token or having the dashboard open never change it. Only `connection` does.
- **What "checked in" means.** A check-in is `seenAt`: the work loop talking to the queue, or a status read while paused. Setup checks are not check-ins.
- **Optional detail.** The UI may show the four timestamps, for example "Last processed work 2 min ago". Label `lastSeenAt` as "Last request", not "Last seen", so it never contradicts the connection label. `lastWorkClaimAt` means "the work loop checked in", not "received work".

### 6. Fixtures

**Fields.** Fixtures use the a3 §6 file fields: `contract`, `version`, `id`, `description`, `kind: "http"`, `request` and `response`. `request.auth` is `human_session` (a signed-in member of the owning workspace) or `agent_access`. Only the `client` block differs from a3:
- **Owner fixtures** have `client.surface: "owner_ui"`, plus `client.connectionLabel` and `client.agentLabel` (the §5 wording).
- **Agent status fixtures** have `client.surface: "connector"` and `client.lifecycle`, which is unchanged from a3.

**What `test/contract-fixtures.test.js` checks**
- Every response against its schema.
- Each owner fixture's `seenAt` and `connection.state`, re-derived from §4.2 using the fixture's own `agent`, `asOf`, `credentialExpiresAt` and `presence`.
- The connection label against `x-connection-states`, and the agent label against the §5 rule (plus the `x-agent-labels` order).
- That no `presence` timestamp is later than `asOf`.
- That `lastSeenAt` is never earlier than the other three (§2, "`lastSeenAt` leads").
- That tokens are placeholders.

| Group | Fixtures |
| --- | --- |
| Owner list | `owner-seen-recently`, `owner-resume-grace-expired`, `owner-not-seen-recently`, `owner-never-seen` (setup checks only), `owner-not-connected`, `owner-pending-approval`, `owner-rejected`, `owner-needs-reconnect`, `owner-paused-seen-recently`, `owner-paused-needs-reconnect`, `owner-revoked`, `owner-revoked-refresh-replay` |
| Owner control | `owner-pause-response`, `owner-resume-response` |
| Agent | `agent-status-presence`, `agent-status-paused-presence` |

### 7. Compatibility and migration

- **Additive.** `asOf` and `presence` on the agent status, and `connection` on owner views, are new fields. a3 and a4 behavior does not change, and old clients ignore the new fields.
- **No events, no endpoints, no SQL migration.** Presence uses new document paths. Families that existed before A-3 start with all-`null` presence. They show `never_seen` until their connector's next claim, which is at most ~60 s away for a healthy connector.
- **Cost.** All four fields share one document per family, and each field changes at most once per 60 s, so at most four document writes per family per 60 s. The usual case is one write a minute per connected installation, which updates `lastSeenAt` and `lastWorkClaimAt` together.
- **Rollback.** Reverting A-3 removes the fields, and clients show "Status unknown". The `auth/agent-presence/` documents become inert and can be deleted with no other effect.

**Consumer changes for B-3** (Lane B; informative)
- `frontend/src/App.tsx` currently derives "online" / "Enrolled" from enrollment and approval, and reads a `pausedAt` field the server never sends. Replace that with `connection.state`, the agent's `paused` field and the §5 wording.
- Add `connection?` (optional) and `resumedAt?` to the agent type in `frontend/src/types.ts`.
- The onboarding step "Observe runtime activity" (`frontend/src/model.ts`) may use `connection.presence.lastProcessedAt`.
- Connector doctor may print `presence` from `GET /api/agent/status`.

## envoi-browser-names v1

**Contract:** `envoi-browser-names`, version 1. **Status:** approved by the human on 2026-10-11 (`CONTRACT-APPROVED envoi-browser-names v1 @1b88e1d`, build board #34) after Lane B `CONTRACT-ACK` (consuming tests in PR #66). Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/envoi-browser-names/`](../../../test/contract-fixtures/envoi-browser-names/).

**Owner:** Lane A. **Consumer:** Lane B (frontend).

**Implemented by** two tasks, integrated together on **one SHA**, like N1:
- N2-server (Lane A);
- N2-client (Lane B).

This contract covers the browser names of Envoi naming phase N2 ([`docs/architecture/envoi-naming-plan.md`](../envoi-naming-plan.md)). It is a separate contract id, so `envoi-names` v1 stays approved and unchanged.

**Decision (human, 2026-10-09; unchanged): a clean cutover.**
- There are no `sinaloa_*` aliases.
- The server never accepts an old cookie or header *value*, so it cannot half-accept one.
- It only detects old cookie *names*, so it can clear them (§1.3).

**Scope.** Only the names a browser sends or receives.
- The other N2 work needs no client change and is tracked in the naming plan: monitoring events (PR #63), configuration keys and docs.
- Object-storage metadata, scanner request headers and other internal identifiers move with N3 (human decision, 2026-10-10).

### 1. Cookies

| Old | New | `Path` | `HttpOnly` | `SameSite` | `Domain` | Set by |
| --- | --- | --- | --- | --- | --- | --- |
| `sinaloa_session` | `envoi_session` | `/` | yes | `ENVOI_COOKIE_SAMESITE`, default `Lax` | `WORKOS_COOKIE_DOMAIN` when set | Successful WorkOS callback; local phone verify |
| `sinaloa_csrf` | `envoi_csrf` | `/` | no (the browser reads it) | `Strict` | never | Same as the session; `GET /api/auth/me` when missing |
| `sinaloa_workos_flow` | `envoi_workos_flow` | `/api/auth/workos` | yes | `Lax` | never | WorkOS sign-in start (`Max-Age` = flow minutes × 60, default 600) |

`Secure` is added in production or with `ENVOI_COOKIE_SECURE=true`. Session and CSRF `Max-Age` is `ENVOI_SESSION_HOURS` × 3600 (default 86400). All of these attributes are unchanged from today.

#### 1.1 Configuration

**Overrides keep working.** `WORKOS_COOKIE_NAME` and `ENVOI_CSRF_COOKIE_NAME` (or its alias `SINALOA_CSRF_COOKIE_NAME`, until N2-config-2 removes it) still override the names.

**Old names are refused.** Startup, in every mode (`src/production-config.js` and the development startup check), refuses two things:
- an override that names a retired cookie (`sinaloa_session`, `sinaloa_csrf` or `sinaloa_workos_flow`);
- a session cookie name equal to the CSRF cookie name.
- Otherwise the new default would never apply.
- Worse, the clearing rule below would delete the live session at sign-in.

**N2-server also updates `.env.example`,** which sets both overrides to the old names today, and the tests that do the same.

**Human check.** Confirm that no staging or beta dashboard variable sets `WORKOS_COOKIE_NAME`, `ENVOI_CSRF_COOKIE_NAME` or `SINALOA_CSRF_COOKIE_NAME`. This is on the N2-config dashboard checklist.

#### 1.2 The CSRF cookie name in `GET /api/auth/config`

`GET /api/auth/config` reports `csrfCookieName: "envoi_csrf"`. That holds for the WorkOS and local providers alike. The frontend keeps reading the name from there, and its fallback becomes `envoi_csrf`.

#### 1.3 Old cookies are ignored and cleared

**Ignored.** A request that carries only old cookies is unauthenticated. For example, `GET /api/auth/me` returns `401 { "error": "Authenticated human session required" }`. A mutation that carries only old cookies, such as logout from an old tab, skips the CSRF gate because it has no `envoi_session`.

**Cleared.** These responses also clear old cookies, with `Max-Age=0` and the old cookie's own `Path` and `Domain` from the table:

| Response | Clears |
| --- | --- |
| WorkOS sign-in start | `sinaloa_workos_flow` |
| Successful WorkOS callback; local phone verify; `POST /api/auth/logout` | all three old names |
| A callback whose flow fails (§4) | `envoi_workos_flow` and all three old names |
| `GET /api/auth/me` returning `401` | the old names the request carried; the server reads the name only, never the value |

**The session cookie's `Domain`.** A `Domain` cookie and a host-only cookie with the same name are separate, so one clear cannot remove both. `sinaloa_session` is therefore cleared in its host-only form, plus its `Domain` form when `WORKOS_COOKIE_DOMAIN` is set. The fixtures show the host-only case.

**What stays the same.** Callback error, re-authenticate and `fresh` branches other than §4's are unchanged. Header order is not part of the contract: compare `set-cookie` values as a set.

**When the clearing code goes.** It keeps the three old names in the source until the cookies can no longer exist:
- at least 24 h (the cookie `Max-Age`) after the cutover reaches beta;
- plus the rollback window.

N3 removes it. Until then it is the only allowed `sinaloa` text in the session code.

#### 1.4 Hosted sessions

The cutover does not revoke a WorkOS session behind an old cookie. It stays live at WorkOS until WorkOS's own lifetime ends (beta policy: 7-day maximum, 1-day inactivity).

Signing in again may be silent and create a second WorkOS session. To end the old sessions at once, the people signed in to staging (Rachel has an active staging session) sign out before the cutover deploy.

### 2. CSRF header

- **The header.** Mutating browser requests send **`x-envoi-csrf`**, equal to the `envoi_csrf` cookie. The server checks only that header; `x-sinaloa-csrf` is ignored.
- **When the check runs.** It runs on every non-`GET`/`HEAD`/`OPTIONS` request that carries `envoi_session`, except the existing exemptions: the email webhook, local object upload, and phone start and verify. `POST /api/auth/logout` is **not** exempt.
- **Origin.** As today, the `Origin` header must also equal the `ENVOI_PUBLIC_URL` origin. Outside production with no public URL, it must equal `http://{host}`.
- **Failure.** Any failure, including sending only the old header, gets today's response: `403 { "error": "CSRF validation failed" }`. That shape stays outside the a3 envelope (a3 §1).
- **CORS.** `access-control-allow-headers` lists `x-envoi-csrf` instead of `x-sinaloa-csrf`. Every other entry is unchanged; `x-amz-meta-sinaloa-sha256` moves in N3.
- **Already Envoi.** Header names that already say Envoi do not change, for example `x-envoi-expected-human`.

### 3. Name-only versions of a3 and a4

These ride on the cutover SHA, like `a3-pause-auth` v2 in N1. Their regenerated fixtures land in the N2-server PR, together with the Lane B review updates in N2-client, because Lane B's review tests pin exact versions.
- `sdk/typescript/test/a3-pause-auth.review.ts` accepts only versions 1–2.
- `sdk/typescript/reviews/a4-wake.review.ts` requires version 1.

Codes, statuses, lifecycle, events and behaviour are identical to the previous versions.

**`a3-pause-auth` v3.** The three human-session fixtures (`account-changed`, `cancel-held-message`, `reconnect-token-while-paused`) change:
- They send `cookie: envoi_session=…; envoi_csrf=…`, `x-envoi-csrf` and an `origin`.
- The v2 fixtures had no CSRF cookie and no origin, so the real server would have answered `403` before the case each one describes. v3 adds both, so the requests now pass the CSRF gate.

**`a4-wake` v2.** 21 fixtures change their placeholders:
- `sinaloa_agent_access_` → `envoi_agent_access_` in the `claim-*`, `delta-*` and `stream-*` fixtures;
- `sinaloa_mcp_read_` → `envoi_mcp_read_` in `stream-mcp-read-rejected`.

The five `event-*` fixtures are already clean.

**Token-leak guards.** The guards in both `schemas.json` files (`errorEnvelope.message` `not.pattern`) match **both** the `envoi_` and `sinaloa_` prefixes.
- a4's guard matches only `sinaloa_` today, so it would miss a real `envoi_` token.
- A deny pattern is not an alias: it keeps refusing to leak a retired credential format.

**`a5-presence`.** Unaffected: its fixtures name no cookie (`request.auth: "human_session"`).

### 4. Cutover hazards

**A sign-in in progress at deploy time.** The browser returns to the callback holding only `sinaloa_workos_flow`.
- **Current behavior:** the callback returns a raw `401` JSON page.
- **After N2-server:** when the flow binding is missing or does not match, or the flow is expired, missing or already used, the callback redirects to `/?auth_error=sign_in_failed`. It clears `envoi_workos_flow` and the old names, like the existing error branch. The user starts sign-in again.

**Tabs still running the old frontend.** Such a tab keeps sending `x-sinaloa-csrf`, so every change it makes gets `403 CSRF validation failed` until it reloads. `index.html` is served `no-store`, so a reload loads the new frontend. Lane B offers "Reload" on that error.

**Event streams.** A human `EventSource` that reconnects after the deploy gets `401`, because its old cookie is ignored. Lane B sends the user to sign-in, as on any `401`.

**Rollback** to the pre-cutover SHA:
- **People who already signed in again.** Their old cookies were cleared and the old code ignores `envoi_*`, so they sign in once more.
- **People who opened the app after the cutover.** Their old cookies were cleared by the `GET /api/auth/me` `401`, so they sign in once more too.
- **Browsers that never visited after the cutover.** Their `sinaloa_session` (up to 24 h `Max-Age`) works again.
- **Shared fixtures.** The registry entry, the a3 v3 and a4 v2 fixtures and Lane B's version pins all revert with the SHA.

### 5. Client changes (Lane B; informative)

**Browser code**
- `frontend/src/api.ts`: send `x-envoi-csrf`, and make the fallback cookie name `envoi_csrf`.
- `frontend/test/api.test.ts`: update the expectations.
- Offer "Reload" on `403 CSRF validation failed`.
- Send the user to sign-in when the stream gets a `401`.

**Build.** Rebuild `web/**`, including `web/index.html`, through `npm run build`.

**Review tests**
- `sdk/typescript/test/a3-pause-auth.review.ts` → v3.
- `sdk/typescript/reviews/a4-wake.review.ts` → v2.
- A consuming test for this contract.

**Server-side checklist (Lane A; informative):**
- `src/workos-auth.js`;
- `src/human-auth.js`, which has a second CSRF default;
- `src/server.js`: CORS and the clears;
- `.env.example`;
- `docs/envoi-backend-rename-inventory.md`;
- `test/browser-session.js`, the shared helper;
- `test/session-lifecycle-integration.test.js`, `test/session-response.test.js`, `test/workos-auth.test.js`, `test/workos-session.test.js`, `test/human-instructions-integration.test.js` and `test/inbox-preferences-integration.test.js`.

**Not adopted:** a `__Host-` cookie prefix. It cannot be combined with `WORKOS_COOKIE_DOMAIN`.

### 6. Fixtures

**Fixture fields.** The file fields are the a3 §6 ones, plus a top-level `cookies` field: `{ set: [names], cleared: [names] }`, which lists exactly the cookies the response sets and clears.

**`client` block**
- `lifecycle: "NOT_APPLICABLE"`.
- `retry`.
- `next`.
- `guidance`, one of:
  - `none`;
  - `sign_in_again`: show sign-in and let the user start it again;
  - `reload_browser` (as in a3).

| Fixture | Case |
| --- | --- |
| `auth-config-csrf-cookie` | `GET /api/auth/config` reports `envoi_csrf`. |
| `sign-in-start-sets-flow-cookie` | Sign-in start sets `envoi_workos_flow` and clears `sinaloa_workos_flow`. |
| `sign-in-sets-cookies` | The callback sets `envoi_session` and `envoi_csrf`, and clears `envoi_workos_flow` and the three old names. |
| `callback-old-flow-cookie` | A sign-in in progress at the deploy redirects to `/?auth_error=sign_in_failed` (§4). |
| `phone-verify-sets-cookies` | Local phone verify (development, so no `Secure`) sets both cookies and clears the old names. |
| `logout-clears-cookies` | Logout with the new cookies, the new header and a matching `Origin`. This is also the positive CSRF case. |
| `logout-old-cookies-only` | Logout from a browser holding only old cookies. The gate is skipped, the response is `{ revoked: false, logoutUrl: null }`, and the old names are cleared. |
| `me-old-cookies-only` | `GET /api/auth/me` with only old cookies returns `401` and clears them. |
| `csrf-old-header-rejected` | The same as a valid mutation, except it sends only `x-sinaloa-csrf`. It gets `403`. |

**`schemas.json`** carries the cookie table as `x-browser-cookies` and the header mapping as `x-browser-headers`.

**What `test/contract-fixtures.test.js` checks**
- The `set-cookie` values, as a set, match `cookies.set` and `cookies.cleared`.
- Every cookie name is in the table.
- Old names only ever appear as clears.
- The successful callback, phone verify and both logout fixtures clear all three old names.
- Every cookie that is set has a `Max-Age`.
- Every mutation that carries `envoi_session` sends `x-envoi-csrf`, unless it is marked `oldNamesInRequest` (`x-browser-headers`).
- Every cookie's `Path`, `HttpOnly` and `SameSite` match the table.
- A redirect's `location` and `cache-control: no-store`.
- No request carries a `sinaloa` cookie or header, except the fixtures marked `oldNamesInRequest`. N2-server extends this check to every contract when a3 v3 and a4 v2 land.
- `plainError` is used only for browser requests (requests that carry a cookie).

## agent-registration v1

**Contract:** `agent-registration`, version 1 (build-plan task **A-3.1a**). **Status:** published, third revision (§13). The human's first `CONTRACT-APPROVED` preceded Lane B's review, which found a `MISMATCH`. By the human's decision the corrected contract stays v1, and it needs Lane B `CONTRACT-ACK` and a fresh `CONTRACT-APPROVED`. Design only: no server code exists, and nothing here is default-on.

**Fixtures:** [`test/contract-fixtures/agent-registration/`](../../../test/contract-fixtures/agent-registration/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-codes`, `x-limits`, `x-model-visible`, `x-permission-labels`, `x-route-availability`, `x-delivery-availability`, `x-operations`, `x-legacy-projection` and `x-installation-derivation`;
- one JSON file per case, including migration, rollback and re-enable fixtures (§9).

**Owner:** Lane A. **Consumer:** Lane B. That covers `envoi-link connect`, the `/connect` skill and manifest, the claim UI, and the host planner in PR #72. **Implemented by:** A-4.x. It waits for this contract's approval **and** the hosted Phase A gate (two-owner plan A5).

**What it covers.** This is the route-neutral Phase B core from v3 §30–§45, as amended by PR #75:
- one registration, human claim, activation and installation state machine;
- the same agent operations for every connection route.

It builds on `a3-pause-auth` v3 (envelope, codes, pause, reconnect), `a4-wake` v2 (work availability) and `a5-presence` v1 (presence, owner connection states).

**Not in v1.** Everything below is **A-3.1b** (`agent-remote-auth`), which is published separately:
- the remote MCP/OAuth route;
- the provider-connector route, including OAuth metadata, consent-as-claim and the secure-field bootstrap code;
- the delivery modes `webhook`, `provider` and `a2a`.

`poll` and `on_demand` also stay off until an `a5-presence` revision gives them an honest owner label (§1). Each of these is `available: false` in v1, and registration or activation refuses it.

### 1. Flags and route availability

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_INSTALLATIONS_V2` | The installation model: the legacy projection (§9), `installation` on agent status (§6.4) and the owner installation routes (§6.5). |
| `ENVOI_AGENT_REGISTRATION_V2` | Registration (§3), polling (§4), the claim routes (§5) and activation (§6). It requires `ENVOI_INSTALLATIONS_V2`; startup fails closed if this flag is on and that one is off. |
| `ENVOI_AUTHENTICATED_REST_ROUTE` | Offers the `authenticated_rest` route, in addition to the two above. **New** relative to v3 §65, because the breadth gate (v3 §47) proves REST separately. |

**About `ENVOI_AUTHENTICATED_REST_ROUTE`.** `connectionRoute` is declared by the client, and in v1 both routes use the same bootstrap and bearer mechanics. So this flag controls what Envoi **offers and supports**:
- what the routes endpoint, `/connect` and `skill.json` advertise;
- whether a registration declaring `authenticated_rest` is accepted.

It cannot stop a REST client that declares `local_helper`.

**Route availability.** Lane A owns the flags; clients never read them. Clients read `GET /api/onboarding/routes`, which needs no auth and is served with `cache-control: public, max-age=60`. It returns `routeAvailability`:
- `registrationEnabled` and `installationsEnabled`;
- all four `connectionRoute`s and all six `deliveryMode`s, each exactly once, in schema order, with `available`.

The rules are in `x-route-availability` and `x-delivery-availability`:

| Route or mode | Available when |
| --- | --- |
| `local_helper` | both V2 flags are on |
| `authenticated_rest` | both V2 flags and `ENVOI_AUTHENTICATED_REST_ROUTE` are on |
| `remote_mcp_oauth`, `provider_connector` | never in v1 (A-3.1b) |
| delivery mode `envoi_link` | both V2 flags are on |
| any other delivery mode | never in v1 |

`envoi_link` means SSE plus the a4-wake safety poll, run by a trusted host process. A REST client that implements a4 the same way also declares it.

**Outcomes.** `/connect`, `skill.json` and the helper offer only what this endpoint marks available. A route whose flag is off returns `404 FEATURE_DISABLED`, and the fixture test ties that code to the fixture's flags. The human turns a flag on only after the route's hosted gate passes (v3 §47).

### 2. Codes, tokens and limits

Every value here is machine-readable in `x-limits`.

| Item | Rule |
| --- | --- |
| Verification code | 8 symbols, uniformly random, from the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (40 bits), shown as `XXXX-XXXX`. Typing is case-insensitive, spaces and hyphens are ignored, `I`/`L` read as `1` and `O` as `0`. Stored only as HMAC-SHA256 under a key derived from `ENVOI_DATA_ENCRYPTION_KEY`, never in clear and never logged. A new code that collides with a live one is drawn again. |
| Bootstrap token | `envoi_reg_` + 32 random bytes, base64url. Stored as SHA-256 and bound to one registration. See below. |
| Claim window | 600 s from creation (`expiresAt`). |
| Activation window | 600 s from approval (`activationExpiresAt`). |
| Activation recovery | 300 s from activation (§6.2). When the window ends, the token record becomes a **tombstone**, kept until cleanup. Any activation or poll with that token then gets `401 ACTIVATION_RECOVERY_EXPIRED`, which revokes nothing and tells the helper that an agent already exists. The window ends by time (`activatedAt` + 300 s), whether or not a job has run. |
| Polling | `pollAfterSeconds` is 5. A poll less than 4 s after the previous one gets `429 RATE_LIMITED` with reason `poll_interval`. This check may live in memory; it is not a safety boundary. |
| Registration creation | At most 10 per source per hour, 30 per network per hour, 100 per wide network per hour, at most 1,000 pending globally, and a body of at most 4,096 bytes. All are keyed by `clientIp` (with today's trusted-proxy rule): **source** is the IPv4 address or the IPv6 /64, **network** the IPv4 /24 or the IPv6 /48, **wide network** the IPv6 /32. The network limits stop one cheaply obtained IPv6 /48 (65,536 /64s) from filling the global cap. The key is never the bearer- or cookie-keyed `rateIdentity`, which an unauthenticated caller could vary. **Durable:** the counters live in the document store, so a container restart does not reset them. Over any limit → `429 RATE_LIMITED`, reason `registration_limit`. |
| Claim failures | At most 5 per human per 15 minutes, durable. A lookup, approve or reject whose code does not match counts as one failure; 5xx responses never count. When the limit is hit → `429 RATE_LIMITED`, reason `claim_attempts`, and the correct code is refused too until `retry-after`. |
| Approvals waiting | At most 3 approved-but-unactivated registrations per human (`PENDING_ACTIVATION_LIMIT`). |
| Cleanup | Each registration record is kept **at least** 24 h after creation and deleted **by** 25 h, whatever its state, together with its token index or tombstone, its code index, its address hold (only if the hold still names this registration, since a later registration may have replaced it, §9) and its recovery envelope. Nothing is deleted earlier, so the tombstone, decision replays (§5.3, §5.4) and the owner's 24-hour list hold for their whole window. Lookup only ever finds **pending** registrations. |
| Abuse monitoring | Creating a registration and hitting any limit emit structured log events: `agent_registration.created` and `agent_registration.limited`. They carry the hashed source, the route and the reason, never the body or a token (v3 §37). |

**Where a bootstrap token works.** It authenticates only the registration status route (§4) and activation (§6.1). On any other **authenticated** route it is an unrecognized bearer and gets `401 AUTHENTICATION_REQUIRED`, identical to an unknown token. That covers `/mcp` (an HTTP 401, not a JSON-RPC result), claim, send and status. Public routes ignore it. `POST /api/agent-token` reads only its own body (a3 §2.2). There are fixtures for pending, rejected and expired tokens.

**Never register twice by accident.** A helper may send an activation and never learn its outcome. Such an activation is **unresolved**, and the agent may or may not exist. The rules:
- Retry backoff gives up before the recovery window ends. Before abandoning an unresolved activation, the helper polls status (§4) once. `activated` or `ACTIVATION_RECOVERY_EXPIRED` means the agent exists (owner reconnect). `pending_claim`, `approved`, `rejected`, `expired` or `withdrawn` resolve it the usual way.
- The helper deletes the `activationId` once its activation is resolved: credentials saved, or any definitive `4xx` from §6.1.
- If the token was already deleted by cleanup, the helper gets `REGISTRATION_TOKEN_INVALID` while still unresolved. It then uses the row's `guidanceByHelperState.activation_unresolved`, which is `check_owner_agents`: "ask the owner whether the agent appears in Envoi; reconnect it if it does, register again if it does not". It never registers again on its own, and never sends the owner to reconnect an agent that may not exist (fixture `activation-token-invalid-unresolved`).

**Change from the two-owner plan.** The plan's starting rule was "five wrong claims before invalidation". Here the human **types** the code (§5.1), so a wrong code never identifies a registration and there is nothing to invalidate. The cap applies per human instead. Five tries per 15 minutes against a 40-bit space, by allowlisted, signed-in humans only, makes guessing a live code negligible. The plan's "bounded per pending owner/workspace" is met per human (three approvals waiting, §5.3), plus the source, network and global creation limits. A registration has no owner or workspace until it is claimed, so it cannot be bounded per workspace (§10).

### 3. Registration

`POST /api/agent-registrations` takes no auth. The body is `registrationCreateRequest`, a closed object: unknown fields → `400 REGISTRATION_INVALID`.

| Field | Rule |
| --- | --- |
| `requestedName` | 1–80 characters. Control, zero-width and bidirectional formatting characters are refused, including U+061C and U+180E. |
| `requestedLocalPart` | Optional. Today's local-part rules: 3–32 characters matching `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, and not reserved. Nothing is held at this step. |
| `requestedPermissions` | 1–5 of `send_agent_messages`, `receive_agent_messages`, `create_assets`, `execute_cases`, `use_email_transport`. The agent asks; it never grants (v3 §40). |
| `connectionRoute` | Must be available (§1), otherwise `400 ROUTE_NOT_AVAILABLE`. |
| `runtime` | `{ type, version }`. Metadata only, never trusted. |
| `deliveryCapabilities` | The six booleans of v3 §36. These are host declarations: shown to the human as claims, never used as evidence. |
| `helper` | Optional `{ name, version }`. |

**`201` `registrationCreated`** is sent with `cache-control: no-store`:

```json
{ "registrationId": "registration_…", "status": "pending_claim", "bootstrapToken": "envoi_reg_…",
  "claim": { "url": "https://www.envoi-agents.com/claim", "verificationCode": "F7KQ-PM4D", "expiresAt": "…" },
  "expiresAt": "…", "pollAfterSeconds": 5 }
```

- `claim.url` is `${ENVOI_PUBLIC_URL}/claim`, with no query or fragment, so it **never contains the code** (§10).
- **Not idempotent.** If the response is lost, the helper registers again. The orphan expires and grants nothing.
- **A registration grants nothing,** in any state other than activated. It has no inbox, messaging, work claim, case, file, MCP or directory access (v3 §36).

**Names and addresses in responses.** The name and local-part rules above apply to **new** names. Responses also carry existing agents and workspaces, which predate them. Today's addresses can be 48-character slugs, slug-suffix forms or bare UUIDs starting with a digit, and today's names have no length limit. So:
- response-side `address` accepts every existing address (fixtures `agent-status-legacy-address`, `owner-claims`);
- every agent or workspace name the server returns is a `displayName`, made in this order:
  1. control, zero-width and bidirectional formatting characters are removed;
  2. token-like substrings (`x-model-visible` never-list prefixes) are replaced with `[redacted]`;
  3. the result is truncated to 80 characters (79 plus `…`);
  4. a name left empty becomes the address local part.

  So the refusal rule and the length bound hold for anything a helper may show a model, and the server-derived equality rule (§7) never forces a helper to repeat an unbounded string.

### 4. Registration status

`GET /api/agent-registrations/{registrationId}` with `Authorization: Bearer envoi_reg_…` returns `registrationStatus`.

**Status is derived from time.** A pending registration past `expiresAt`, or an approved one past `activationExpiresAt`, *is* `expired`. That holds even if no cleanup job has run yet, and it holds on every route.

| `status` | Extra fields | Helper does |
| --- | --- | --- |
| `pending_claim` | `expiresAt`, `pollAfterSeconds` | Waits and polls. Shows the code again only if the human asks and it has not expired. |
| `approved` | `target`, `workspaceName`, `approverEmailHint`, `agent { name, address, id? }` (`id` exactly for `existing_agent`), `effectivePermissions`, `activationExpiresAt` | **Confirms, then activates** (lifecycle `CONFIRMING`, state `confirm_approval`). It shows who approved (`approverEmailHint`), `workspaceName`, the agent and the permissions to the human beside the host, and activates (§6) only after that human confirms. See "Local confirmation" below. |
| `activated` | `installationId` | Visible only inside the 300 s recovery window. After that, polls get `401 ACTIVATION_RECOVERY_EXPIRED`. Credentials are **never** repeated here. A helper that lost them retries activation with its `activationId` (§6.2); otherwise the owner reconnects the existing agent. |
| `rejected` | none | Stops and deletes the bootstrap token. |
| `expired` | none | Stops. Never shows the old code again. Starts one new registration only if the human asks. |
| `withdrawn` | none | Stops. A manager withdrew the approval, or an activation-time re-check found it no longer holds (§6.1). Asks the human before registering again. |

An unknown, deleted or mismatched token gets `401 REGISTRATION_TOKEN_INVALID`, the same response in every case.

**Local confirmation.** A code shown in a shared chat can be typed by any allowlisted human, who could then approve the agent into their own workspace (§10). So the helper never activates on its own.
- After polling `approved`, it shows `approverEmailHint`, the approving `workspaceName`, the agent's name and address, and `permissionSummary`, then waits for the human beside the host to confirm them.
- **`approverEmailHint` is the check that matters.** The approver chooses `workspaceName`, so a name like "Acme, your workspace" proves nothing. The hint is derived from the approving human's verified sign-in email: the first character of the local part, `***`, then the full domain, e.g. `o***@example.com`. The approver cannot choose it, and the real owner recognizes their own account.
- **Where the confirmation comes from.** A helper that has a host-native interactive prompt (a terminal prompt or a dialog on the host) must use it. That is the only path the helper itself can attribute to the human. When the helper runs only as a tool the model calls, the confirmation reaches it through the model and is **advisory**. `/connect` and `nextAction` then tell the model to show the approver and workspace to the human and wait for the human's explicit answer. §10 lists this as residual risk.
- If the human declines, or does not answer before `activationExpiresAt`, the helper deletes the bootstrap token and does not activate. The approval then expires, which releases its hold and slot. The owner sees it as `expired` in `GET /api/agent-claims`.
- The confirmation is a host-side step, so the wire is unchanged apart from the lifecycle and state values. The activation window (600 s) covers it.

### 5. Human claim

#### 5.1 Who can claim

Every claim route checks the following, in this order:

1. **A human session.** Mutations also need CSRF, as envoi-browser-names v1 requires. A CSRF failure keeps today's plain `403 { error }` browser response; it is not an `x-codes` entry.
2. **The beta allowlist,** re-evaluated now rather than taken from an earlier login. A human who is no longer admitted → `401 AUTHENTICATION_REQUIRED`.
3. **The current assurance rule.** Local auth requires `mfa`. WorkOS sessions keep their provider assurance.

**Managing the target** is a separate check, at approve time. It uses the live provider-membership check (`maxAgeMs: 0`):
- `new_agent`: the human must be able to manage `workspaceInboxId`;
- `existing_agent`: the human must be able to manage that agent's **dedicated inbox**, the same rule today's reconnect-token route uses.

An unknown, foreign or removed id gets the **identical** `403 CLAIM_FORBIDDEN`. Holding a code never reveals whether a workspace or agent exists.

The human types the code their agent shows at `/claim`. Typing it is the comparison v3 §38 asks for. §10 covers what typing does and does not protect against.

#### 5.2 Lookup

`POST /api/agent-claims/lookup` with `{ verificationCode }` returns `claimLookup`:
- the normalized code;
- `requestedName` and `requestedLocalPart`;
- `requestedPermissions`, and `grantablePermissions` (requested ∩ organization maximum);
- `connectionRoute`, `runtime` and `deliveryCapabilities`;
- `createdAt`, so the UI can show "registered N minutes ago", and `expiresAt`.

The UI presents the agent's fields as **claims the agent makes**, not facts.

A code that is malformed, unknown, expired, decided, or another registration's gets `404 CLAIM_CODE_INVALID`. The response is identical in every case and counts as one failure.

**Malformed codes.** `typedCode` (at most 32 characters) describes what a well-behaved client sends. On every claim route the server answers any `verificationCode` it cannot normalize to 8 symbols (§2) with `404 CLAIM_CODE_INVALID`, never `CLAIM_INVALID`. That includes a missing or non-string code and an over-long one. The code is checked before the body (§5.3 precedence).

#### 5.3 Approve

`POST /api/agent-registrations/{registrationId}/approve`. The body is `claimApproveRequest`:

```json
{ "verificationCode": "F7KQ-PM4D",
  "target": { "kind": "new_agent", "workspaceInboxId": "inbox_…", "name": "…", "localPart": "…" },
  "grantedPermissions": ["send_agent_messages", "receive_agent_messages"], "policyProfile": "default" }
```

For an existing agent, `target` is `{ "kind": "existing_agent", "agentId": "agent_…", "replacesInstallationId": "installation_…" | null }`.

The code is required again, which binds the decision to what the owner saw. The `{registrationId}` comes from the lookup.

**Permissions, for both targets**
- `grantedPermissions` is required. The UI pre-fills it with the requested permissions, or for an existing agent with its current ones.
- The server computes `effectivePermissions` = requested ∩ granted ∩ organization maximum, plus `receive_agent_messages`. Every agent can receive, as today's enrollment already ensures, so the schemas require it in every `effectivePermissions` (§10).
- In v1 the organization maximum is the full list, since there are no per-organization ceilings yet.
- Anything granted but not requested is dropped silently. The response states the result.
- **Re-attaching an agent re-decides its permissions,** as today's re-enroll does. This matters most after a revocation or replay: old permissions are never restored without a fresh decision.

**Agent slots.** These follow today's `assertActiveAgentSlot`:
- a human has `x-limits.activeAgentsPerHuman` (2) slots;
- the slot belongs to the agent's **principal human**;
- an `active` or `paused` agent uses a slot while it has a **live** family (neither revoked nor past `refreshExpiresAt`), **or no family at all**;
- a live approval that will need a slot when it activates counts too: every `new_agent` approval, and an `existing_agent` approval of an agent whose families are all dead (an agent with no family already counts itself).

For an `existing_agent` approval the count excludes the agent being attached (today's `excludingAgentId`). The activation-time re-check (§6.1) also excludes the approval being activated. So nothing is counted twice.

**`new_agent`**
- **Nothing is created at approval.** The server:
  - holds the address for this registration (§9, "Address holds");
  - counts one slot against the approver, who becomes the agent's principal human;
  - counts one waiting approval (`PENDING_ACTIVATION_LIMIT`);
  - records the decision.
- The agent, its dedicated inbox and its directory entries are created **at activation** (§6.3).
- If activation never happens (expiry or withdrawal), the hold and the slot are released and no agent ever existed.
- An address held by a live approval counts as taken (`409 ADDRESS_TAKEN`).

**`existing_agent`**
- The agent must be approved and `active` or `paused`. It may have every credential family revoked or expired.
- A pending or rejected agent, or one frozen by the agent-wide revoke (status `revoked`), gets `409 AGENT_NOT_RECONNECTABLE`. A frozen agent is still re-enrolled through Quick Connect in v1.
- If the agent has no live family, the approval needs a slot, checked against the agent's principal human (`ACTIVE_AGENT_LIMIT`).
- **`replacesInstallationId` must name the agent's newest active installation** (latest `activatedAt`, §6.4), or be `null` when it has none, otherwise `409 CLAIM_STALE`. This forces the UI to show the owner which installation, and which last check-in, will be disconnected. Activation replaces **every** active installation, including older legacy ones.
- Approval changes nothing yet. The current installation keeps working until the new one **activates**.

**Policy profile.** `policyProfile` is `"default"` only in v1: the workspace's active policy.

**`200` `claimApproved`** returns:
- `target` and `workspaceName`;
- `agent { name, address }`, plus `id` for `existing_agent`;
- `effectivePermissions`, `policyProfile` and `activationExpiresAt`.

**No credential ever reaches the browser.** Today's `POST …/agent-onboarding/{agentId}/approve` returns tokens; A-4.x moves both paths onto one approval module (v3 §41), and only the legacy route keeps its response shape. The server stores the following for the activation-time re-checks (§6.1):
- `approverHumanId`;
- the target;
- for `existing_agent`, the agent's `accessGeneration` and `replacesInstallationId`.

**Audit:** `agent.registration_approved`, with the target and the effective permissions.

**Precedence.** The first matching check wins:
1. session and CSRF (`401`, plain `403`), then `ACCOUNT_CHANGED`;
2. `RATE_LIMITED`, for the claim-failure lock or the ordinary limit;
3. **the code and the registration's state:**
   - The code matches a registration **this human decided**, in **any later state** (`approved`, `activated`, `withdrawn`, expired after approval, or `rejected`). A lost response is usually retried after the helper has already activated, so the replay must not depend on the state. Neither branch below counts as a failure:
     - the same decision with an identical body replays the identical original `200` (fixtures `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-reject-replayed`);
     - any other decision or body gets `409 CLAIM_ALREADY_DECIDED`: approve with a different body, approve after rejecting, or reject after approving (fixture `claim-reject-after-approve`). To change an approval, withdraw it (§5.4) and have the agent register again.
   - Otherwise, unless the code matches a `pending_claim` registration that has not expired, the response is `404 CLAIM_CODE_INVALID`, and it counts as a failure. That includes a registration another human decided.
4. `CLAIM_INVALID` (body validation);
5. `CLAIM_FORBIDDEN`;
6. `AGENT_NOT_RECONNECTABLE`, `CLAIM_STALE`, `ADDRESS_TAKEN`, `ACTIVE_AGENT_LIMIT` or `PENDING_ACTIVATION_LIMIT`.

The code is checked before anything that would reveal facts about workspaces or agents.

**Concurrency.** The first decision wins, through a conditional write.

#### 5.4 Reject, list and withdraw

- **Reject:** `POST /api/agent-registrations/{registrationId}/reject` with `{ verificationCode }` → `200 { registrationId, status: "rejected" }`. Allowed while pending. Retries follow the §5.3 precedence: the same human retrying a lost reject gets the identical `200`, and a reject after their own approval gets `409 CLAIM_ALREADY_DECIDED`. Neither counts as a failure. Audit `agent.registration_rejected`.
- **List:** `GET /api/agent-claims` → `ownerClaimList`, newest first by `approvedAt`, at most `x-limits.ownerClaimListMax` (20). It holds approvals of registrations **created** in the last 24 hours, so the list never outlives the records (§2). It includes every approval whose target the caller can manage now (the same live check as approve and withdraw), whether the caller or a colleague made it. `approvedByMe` tells them apart. An approval whose target the caller can no longer manage is not listed, even their own, so every listed `approved` entry can be withdrawn. So a co-manager sees a colleague's approval and can withdraw it, which is the "undo a colleague's mistake" mitigation in §10. Each entry shows its status and activation deadline; `installationId` is set exactly when it activated.
- **Withdraw:** `POST /api/agent-claims/{registrationId}/withdraw` → `200 { registrationId, status: "withdrawn" }`.
  - Allowed while `approved`, for any human who passes the same live management check on the target.
  - If the same human repeats their own withdrawal, they get the identical `200` (fixture `claim-withdraw-replayed`). The server stores `withdrawnByHumanId` for this.
  - Otherwise → `404 CLAIM_NOT_FOUND`, identical for unknown, not approved and not manageable.
  - It releases the address hold and the slot, and makes later activation fail with `REGISTRATION_ENDED` reason `withdrawn`.
  - Audit `agent.registration_withdrawn`.

### 6. Activation and installations

#### 6.1 Activate

`POST /api/agent-installations/activate` with `Authorization: Bearer envoi_reg_…`:

```json
{ "registrationId": "registration_…", "activationId": "…", "deliveryMode": "envoi_link" }
```

**`activationId`** matches `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. The helper persists it privately **before** sending, like A1's `rotationId`.

**`deliveryMode`** is the host's declared wake mode. It is `envoi_link` only in v1. It is a **declaration**, never evidence of closed-app reachability (§7).

The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1 | `ENVOI_AGENT_REGISTRATION_V2` off | `404 FEATURE_DISABLED` |
| 2 | `activationId` missing or malformed (checked before the token; nothing consumed) | `400 ACTIVATION_ID_REQUIRED` |
| 3 | Token unknown, deleted by cleanup, or not this registration's | `401 REGISTRATION_TOKEN_INVALID`. Revokes nothing. |
| 4 | Token is a tombstone (activated, recovery window over) | `401 ACTIVATION_RECOVERY_EXPIRED`. Revokes nothing. |
| 5 | Body otherwise invalid | `400 ACTIVATION_INVALID`. Nothing consumed; the approval stays live (fixture `activation-invalid`). |
| 6 | Status `activated`, the installation has **ended** (any `activationId`) | `401 ACTIVATION_RECOVERY_EXPIRED`. Nothing changes: an ended installation's history is never rewritten. |
| 7 | Status `activated` and the **same** `activationId` | `200` with the **identical** body as the original `201`. If the envelope cannot be decrypted → `401 ACTIVATION_RECOVERY_EXPIRED`. |
| 7a | Status `activated` and a **different** `activationId` | `401 ACTIVATION_REPLAY`. Two parties hold one bootstrap token, so the still-active installation that activation created is revoked. See below. |
| 8 | `deliveryMode` not available | `400 DELIVERY_MODE_NOT_AVAILABLE`. Nothing consumed. |
| 9 | Status `pending_claim` and not expired | `409 REGISTRATION_PENDING` |
| 10 | `rejected`, `expired` (derived from time, §4) or `withdrawn` | `409 REGISTRATION_ENDED` with that `reason` |
| 11 | `approved`, but a re-check fails | `409 REGISTRATION_ENDED` reason `withdrawn`, and the registration becomes `withdrawn` |
| 12 | `approved` and every re-check passes | `201` `activated` |

**What `ACTIVATION_REPLAY` does.** It applies only inside the recovery window, because after it the token is a tombstone (row 4). It also applies only while the installation is active (row 6). The revoked family's `revokedReason` is stored as `"revoked"`, so a3 holders get `CREDENTIAL_REVOKED` with `reason: "revoked"` and `credential.ended`. `activation_replay` is recorded only on the installation (`replayDetectedAt`) and in the audit event `agent.activation_replay_detected`. It never reaches an a3 reason.

The helper row pairs lifecycle `REVOKED` with guidance `owner_reconnect`, while a3 pairs `REVOKED` with `owner_reenroll`. That is deliberate: this revoke ends one installation but does **not** freeze the identity, so the owner can attach a new registration to the same agent (§6.5).

**Re-checks (row 11)** run inside the activation's lock, so a decision that no longer holds can never activate:
- the approver is still admitted and can still manage the target (live check);
- the registration's `connectionRoute` is still available (§1), so a route turned off after registration never gains an installation;
- for `new_agent`:
  - the address hold still belongs to this registration;
  - the address can still be reserved;
- for `existing_agent`:
  - the agent still exists, is approved, and is `active` or `paused`;
  - its `accessGeneration` is unchanged, so the agent-wide revoke or freeze has not happened since;
  - its newest active installation is still `replacesInstallationId`;
  - the slot rule (§5.3) still admits it, if it needs a slot, counting without this approval itself.

If a re-check fails, the helper is told `approval_ended`, a neutral "this approval no longer holds; ask the human", not that the owner withdrew it.

**`activated` body:**
- `installation` (§6.4);
- `agent { id, name, address, status }` and `inboxId`;
- `effectivePermissions`;
- `agentApiToken`, `agentRefreshToken`, `agentTokenExpiresAt`, `agentRefreshTokenExpiresAt` and `tokenType`.

The token fields are the same as today's enrollment response. Refresh then continues through `POST /api/agent-token` unchanged (A1, a3 §2.2).

**Retries.** A 5xx, network error or timeout is retried as the identical request, same `activationId` included, with bounded backoff (`backoff` in `x-codes`). If the first attempt committed, row 7 returns its credentials. Retrying stops before the recovery window ends, and an activation still unresolved then follows §2 ("Never register twice"). A later retry gets row 4, and the owner reconnects the existing agent; a new agent is never registered.

#### 6.2 Lost activation response

On `201`, the server stores a 300-second AES-GCM recovery envelope of the response. This mirrors A1's `rotationRecoveryKey` and `rotationRecoveryContext`:
- the key is HKDF-SHA256 with input key material the **raw** bootstrap token, salt the SHA-256 of `ENVOI_DATA_ENCRYPTION_KEY`, and info `envoi-agent-activation-recovery-v1`, 32 bytes;
- the registration id and the SHA-256 of the `activationId` are bound as AES-GCM additional data, not HKDF inputs.

A database read plus the server key therefore cannot decrypt it, and an envelope cannot be replayed into another registration or activation.

The envelope is deleted when the window ends. When the installation ends (revoke, replace or replay), deleting it is best-effort: row 6 already refuses to return credentials for an ended installation, whatever the envelope state. At the end of the window the token record becomes the row-4 tombstone. The helper saves the credentials atomically, then deletes the bootstrap token and the `activationId`.

#### 6.3 What activation does

**Creates the installation and its credential family together.**
- In v1 an installation has exactly one family.
- Presence stays keyed by that family with the a5 field names (§10).
- Activation itself writes no presence, as a5 §3 already says for enrollment redemption.

**For `new_agent`, it also creates the agent:** `status: "active"`, `onboardingStatus: "approved"`, the held address (reserved now in `identities/`), its dedicated inbox and its directory entries, exactly as enrollment does today. Both `principalHumanId` and `approvedByHumanId` are the approver.

**For `existing_agent`, it:**
1. sets the agent's permissions to `effectivePermissions`;
2. revokes **every earlier** family with `reason: "replaced"`, so every active installation is replaced;
3. releases held leases, emitting `work.available` with reason `lease_released` (a4 §4);
4. closes the old streams with `credential.ended`.

This matches a3 §4 reconnect redemption, including its release of held sends and its delivery-worker kick when the agent is active. It does **not** match today's Quick Connect re-enroll, which sets the agent back to `active`. A paused agent stays paused: the response carries `agent.status: "paused"`, and the connector enters `PAUSED`.

**Audit:** `agent.installation_activated`, for the owner.

#### 6.4 The installation object

| Field | Meaning |
| --- | --- |
| `id` | `installation_…`. Legacy families use `installation_legacy_` + the family id without its `credential_family_` prefix (§9). Only legacy installations use that prefix. |
| `agentId` | The agent identity, which outlives installations. |
| `connectionRoute` | How this host authenticates (v3 §45). |
| `deliveryMode` | The host's **declared** wake mode. |
| `runtime` | `{ type, version }` as declared; `version` may be `null`. |
| `status` | `active` or `ended` (§10). `active` means the family is **not revoked**; it is not a connection state. An expired, unrevoked family stays `active`, and a5-presence shows it as `needs_reconnect`. |
| `endedReason` | `null` while active. Otherwise `revoked`, `replaced`, `refresh_replay` or `activation_replay`. |
| `legacy` | `true` for a projected pre-Phase-B family (§9): then the id has the legacy prefix, the route is `local_helper`, the mode `envoi_link` and `runtime.version` is `null`. An activation always creates `legacy: false`. |
| `createdAt`, `activatedAt`, `endedAt` | Timestamps. `endedAt` is `null` while active. |

**Stored vs derived (`x-installation-derivation`).** The installation document stores only immutable fields: ids, route, mode, runtime, timestamps and `replayDetectedAt`. `status`, `endedReason` and `endedAt` are **derived from its credential family at read time**:
- active while the family is not revoked;
- `endedReason` is `activation_replay` if `replayDetectedAt` is set, otherwise the family's `revokedReason`, defaulting to `revoked`;
- `endedAt` is the family's `revokedAt`.

Every path that revokes a family therefore updates its installation, with no second write to drift. That includes Quick Connect reconnect, the agent-wide revoke and `REFRESH_REPLAY`, even while the flags are off.

**Agent status.** `GET /api/agent/status` gains `installation: { id, connectionRoute, deliveryMode, legacy }` exactly when `ENVOI_INSTALLATIONS_V2` is on. The field is additive (a3 §1); old connectors ignore it.

#### 6.5 Owner installation routes (`ENVOI_INSTALLATIONS_V2`)

**`GET /api/inboxes/{inboxId}/agents/{agentId}/installations`** → `ownerInstallationList`:
- **every** active installation, newest `activatedAt` first, then at most `x-limits.ownerInstallationEndedMax` (5) ended ones, newest `endedAt` first;
- the list has **no bound on active installations**, and a client must not assume one. v1 creates at most one non-legacy active installation per agent. But before the legacy approve was guarded (6e9d4bf), each approve POST created a new family without revoking earlier ones, and refresh keeps such families alive. Each of them shows as active until a reconnect replaces them all (fixture `owner-installations-legacy-several`). Ended families are never deleted, which is why only the list caps them;
- the UI shows route, mode and runtime **as declared**, while connection state and wording still come only from a5-presence §4–§5.

**`POST …/installations/{installationId}/revoke`** (human session, manager of the agent's inbox) → `200 { installation }`, now `ended`/`revoked`:
- it revokes that installation's family; holders get `CREDENTIAL_REVOKED` with `reason: "revoked"`;
- unlike the agent-wide `credentials/revoke`, it **does not freeze the identity**: a new registration can attach to it (`existing_agent`, with permissions decided again);
- **not even after a restart.** Today's startup job `reconcileLegacyAgentRevocations` freezes every active or paused agent whose families are all revoked. Unchanged, it would freeze an agent after this revoke, or after a `REFRESH_REPLAY` or `ACTIVATION_REPLAY` of its only family, on the next boot, and its claims would then get `AGENT_NOT_RECONNECTABLE`. A-4.x must narrow it to the pre-freeze data it was written for (§12), so that only the agent-wide revoke freezes. Fixture: `reconnect-after-installation-revoke`;
- once every family is revoked, a5-presence v1 reports the agent as `revoked` ("Access revoked"), as it already does today. An agent left only with expired families shows `needs_reconnect`;
- an unknown id → `404 INSTALLATION_NOT_FOUND`;
- audit `agent.installation_revoked`.

#### 6.6 One set of agent operations for every route

"Route-neutral" means every route reaches the **same** operations, with the same codes (`x-operations`):

| Operation | Requests | Defined by |
| --- | --- | --- |
| Identity | `GET /api/agent/status` | a3 §3, a5 §4.1, §6.4 here |
| Work availability | event stream, delta, claim `nextAvailableAt` | a4-wake v2 |
| Claim | `POST /api/agent/work/claim` | a3 §3, a4 §4–§5 |
| Reply | instruction reply, `POST /api/inboxes/{inboxId}/messages` | existing shapes, a3 codes |
| Settlement | `POST /api/agent/work/{workId}/{renew,acknowledge,complete,fail}` | a3 §3 |
| Refresh | `POST /api/agent-token` | A1, a3 §2.2 |

v1 adds no new agent operation. A-3.1b maps the remote MCP and provider routes onto these same operations, including HTTP `409 AGENT_PAUSED` rather than a JSON-RPC result (a3 §3).

### 7. What the model may see

`x-model-visible` is the allowlist. A helper, connector or tool may put **only these keys** where a model can read them: helper stdout, tool results or chat.

**Server-derived keys.** Each must equal its source in the response; the fixture test checks this.

| Key | Source |
| --- | --- |
| `claimUrl` | `claim.url` |
| `verificationCode` | `claim.verificationCode`, only while `pending_claim` and before `expiresAt` |
| `expiresInSeconds` | derived from `claim.expiresAt` |
| `registrationStatus` | `status` |
| `workspaceName` | from an approved registration |
| `approverEmailHint` | from an approved registration (§4) |
| `agentName`, `agentAddress`, `agentStatus` | `agent` |
| `permissionSummary` | `effectivePermissions` mapped through `x-permission-labels`, in the same order |
| `connectionRoute`, `deliveryMode` | `installation` |
| `guidance` | the received code's guidance |

**Helper-derived keys.** Closed values, or helper-authored text.

| Key | Values |
| --- | --- |
| `schemaVersion` | short version string |
| `state` | `pending_approval`, `confirm_approval`, `connected`, `paused`, `needs_reconnect`, `revoked`, `degraded`, `registration_ended`, `needs_help`. It must fit the response: the fixture test maps each response to the states it allows. `confirm_approval` is the §4 local confirmation. A connected-on-demand state arrives with the a5 revision. |
| `reachability` | `not_verified_closed_app`, `verified_while_host_running`, `verified_closed_app`. Host-owned evidence (v3 §47); the server never asserts it in v1. |
| `nextAction` | at most 300 characters of helper text, quoting only server-derived values |

**Never model-visible:** the bootstrap token, the `activationId`, any access or refresh token or fragment, registration, installation, agent, inbox and credential-family ids (including their bare UUIDs), raw bodies, authorization and cookie headers, and storage paths. An existing agent's address is model-visible even when its local part is a UUID, because it is the address and not an id.

**Beyond v3's "only claim URL/code".** v3 §32 step 5 and §47 step 6 have the model see only the claim URL and code. v1 also allows the keys above: workspace, agent name and address, permissions, route and mode. None of them is a secret, and the §4 confirmation needs them in the chat (§10).

**Answers to Lane B's open questions** (PR #72, `HELPER-OUTPUT-EXAMPLES.md`):
1. **Wire states and codes:** see §4 and §8.
2. **What "connected" means:** an authenticated `GET /api/agent/status` succeeded after activation (fixture `agent-status-installation`, lifecycle `CONNECTED`). Activation responses are `ACTIVATING` until that check passes. It is never delivery evidence; `verified_closed_app` stays host-owned (v3 §47), and the owner's "On demand" label is a later a5 revision.
3. **Code expiry and retry:** codes last 10 minutes. On retry while pending, the helper reuses the stored registration and shows the code again only if the human asks. An expired code is never shown.
4. **Permission labels:** only `x-permission-labels`.
5. **Publishing `/connect`:** when `GET /api/onboarding/routes` shows an available route. The UI never reads flags.
6. **`verified_closed_app` evidence:** none in v1 (see 2).

### 8. Codes

New codes use the a3 §1 envelope. `reason` carries the values shown below.

**Rows are per client surface** (`x-codes` → `bySurface`):
- **`helper`:** the registration helper or REST client during setup. Its lifecycle values are `REGISTERING`, `PENDING_CLAIM`, `CONFIRMING`, `ACTIVATING`, `CONNECTED` and `REGISTRATION_ENDED`, plus a3's `NEEDS_RECONNECT`, `REVOKED` and `DEGRADED`. A row may also give `guidanceByHelperState`, which takes precedence over `guidanceByReason` and `guidance` when the fixture's `client.helperState` names that state (§2).
- **`connector`:** the a3 rows, unchanged.
- **`owner_ui`:** lifecycle `NOT_APPLICABLE`.

| Code | HTTP | Surface: lifecycle / retry / guidance |
| --- | --- | --- |
| `FEATURE_DISABLED` | 404 | helper: `REGISTRATION_ENDED` / none / `route_unavailable`; owner_ui: `route_unavailable` |
| `ROUTE_NOT_AVAILABLE` | 400 | helper: `REGISTRATION_ENDED` / none / `route_unavailable` |
| `DELIVERY_MODE_NOT_AVAILABLE` | 400 | helper: `UNCHANGED` / none / `update_helper` |
| `REGISTRATION_INVALID` | 400 | helper: `REGISTRATION_ENDED` / none / `update_helper` (registration body only) |
| `REGISTRATION_TOKEN_INVALID` | 401 | helper: `REGISTRATION_ENDED` / none / `register_again`; with helper state `activation_unresolved` → `check_owner_agents` (§2) |
| `REGISTRATION_PENDING` | 409 | helper: `PENDING_CLAIM` / `poll_after` / `wait_for_claim` |
| `REGISTRATION_ENDED` | 409 | helper: `REGISTRATION_ENDED` / none / `rejected` → `owner_rejected`, `expired` → `register_again`, `withdrawn` → `approval_ended` |
| `ACTIVATION_INVALID` | 400 | helper: `UNCHANGED` / none / `update_helper` (§6.1 row 5; the approval stays live) |
| `ACTIVATION_ID_REQUIRED` | 400 | helper: `UNCHANGED` / none / `update_helper` |
| `ACTIVATION_REPLAY` | 401 | helper: `REVOKED` / none / `owner_reconnect` (the identity is not frozen, §6.1) |
| `ACTIVATION_RECOVERY_EXPIRED` | 401 | helper: `NEEDS_RECONNECT` / none / `owner_reconnect` (also any activation or poll on a tombstoned token) |
| `AUTHENTICATION_REQUIRED` | 401 | helper: `UNCHANGED` / none / none; connector: a3 (`refresh_then_retry_once`); owner_ui: `sign_in` |
| `CLAIM_CODE_INVALID` | 404 | owner_ui: `check_code` |
| `CLAIM_INVALID` | 400 | owner_ui: `fix_claim` |
| `CLAIM_FORBIDDEN` | 403 | owner_ui: `not_permitted` |
| `CLAIM_STALE` | 409 | owner_ui: `reload_claim` (the replaced installation changed) |
| `CLAIM_ALREADY_DECIDED` | 409 | owner_ui: `withdraw_first` |
| `CLAIM_NOT_FOUND` | 404 | owner_ui: none |
| `ADDRESS_TAKEN` | 409 | owner_ui: `choose_another_address` |
| `ACTIVE_AGENT_LIMIT` | 409 | owner_ui: `agent_limit` |
| `PENDING_ACTIVATION_LIMIT` | 409 | owner_ui: `withdraw_or_wait` |
| `AGENT_NOT_RECONNECTABLE` | 409 | owner_ui: `choose_another_agent` |
| `INSTALLATION_NOT_FOUND` | 404 | owner_ui: none |
| `ACCOUNT_CHANGED` | 409 | owner_ui: `reload_browser` |
| `RATE_LIMITED` | 429 | helper: `DEGRADED` / `after_retry_after` / `service_busy`; connector: a3; owner_ui: `after_retry_after` / `service_busy`, `claim_attempts` → `too_many_attempts` |
| `INTERNAL_SERVER_ERROR` / `AUTH_UNAVAILABLE` | 500 / 503 | every surface: `backoff` / `service_unavailable` (helper and connector `DEGRADED`) |

**More points.**
- The test reads a fixture's row from its `client.surface`.
- `RATE_LIMITED` reasons are per route: `registration_limit` only on creation, `poll_interval` only on the status poll, `claim_attempts` only on the claim routes. Any route may return the ordinary a3 limit with no reason.
- Request bodies over the server's general limit keep today's `413`.

### 9. Migration and rollback

**Migration (`ENVOI_INSTALLATIONS_V2` on).** Every credential family with no `installationId` is **projected** as an installation (`x-legacy-projection`; fixture `migration-legacy-family`) when its agent is **approved**, or **frozen** by the agent-wide revoke (`onboardingStatus: "revoked"`, fixture `owner-installations-frozen-agent`). A frozen agent's installations therefore show as ended, as §6.4 promises, instead of disappearing. Families of pending or rejected agents are not projected.

| Installation field | Projected value |
| --- | --- |
| `id` | `installation_legacy_` + the family id without its `credential_family_` prefix |
| `connectionRoute` / `deliveryMode` | `local_helper` / `envoi_link`. Every shipped connector (Hermes, OpenClaw, xAI) is a local bridge. |
| `runtime` | `{ type: family.runtime \|\| agent.runtime \|\| "unknown", version: null }`. Families issued by the legacy approve have no `runtime`. |
| `createdAt`, `activatedAt` | the family's `createdAt` |
| `status`, `endedReason`, `endedAt` | from the family, as in §6.4. Families revoked before `a50766c` (2026-10-09) have no `revokedReason`, so they default to `revoked`. |
| `legacy` | `true` |

- **Nothing is written.** No user re-enrolls, no SQL migration runs and presence is untouched.
- **Replacement.** A legacy installation is replaced like any other when a new registration activates for that agent.

**New documents.** These are path-keyed documents on both FileStore and PostgreSQL, so there is no SQL migration:

| Path | Holds |
| --- | --- |
| `auth/agent-registrations/{registrationId}.json` | the registration, including the decision and its re-check fields |
| `auth/agent-registration-tokens/{sha256}.json` | `{ registrationId }` |
| `auth/agent-registration-codes/{hmac}.json` | `{ registrationId }` |
| `auth/agent-registration-recovery/{…}.json` | the §6.2 envelope |
| `auth/agent-installations/{agentInboxId}/{agentId}/{installationId}.json` | immutable installation fields |
| `rate-limits/agent-registrations/…`, `rate-limits/agent-claims/…` | durable counters |
| `auth/agent-address-holds/{address}.json` | an address hold: `{ registrationId, expiresAt }` |

New families also gain `installationId`, a new field on an existing document.

**Address holds** live under their own prefix, not in `identities/`, so an ended hold can never block today's paths.
- **Live holds count as taken.** Every path that reserves or checks an address treats a live hold (registration still `approved`, before `activationExpiresAt`) as taken: `reserveIdentity`, enrollment-token creation, `agent-address-availability`, and approval itself. The one exception is the holding registration's own activation.
- **Ended holds are ignored.** A hold has ended once its registration is no longer `approved` or is past `activationExpiresAt`. Withdraw, reject, expiry and activation each end it, and withdraw and activation also delete it.
- **Replacing an ended hold** happens inside the approval's own `withInboxMutation` transaction, under the lock key `address-hold:<address>`: read the hold with `getJson`, check its registration, then `putJson`. `updateJson` cannot be used there: it runs its own transaction, which deadlocks behind the caller's on FileStore and commits separately on PostgreSQL. `putJsonIfAbsent` checks only for absence, and `claimJson` only sets a null field on an existing document, so neither can replace an ended hold.
- **At activation** the hold becomes the real reservation, through `reserveIdentity`'s `putJsonIfAbsent` in `identities/`. If that fails, the row-11 re-check fails.

**Rollback: both flags off** (fixture `rollback-flags-off`).
- Agents activated through the new flow keep working on their families. `GET /api/agent/status` just loses `installation`.
- The registration, claim and activation routes return `404 FEATURE_DISABLED`.
- An approved but unactivated registration cannot finish. No agent was created for it, and the owner uses Quick Connect instead.
- Nothing is deleted.

**Re-enable** (fixture `reenable-after-rollback`). Status is derived from the families, so changes made while the flags were off show up correctly with nothing to reconcile. For example, a Quick Connect reconnect that replaced the new-flow family appears as an ended `replaced` installation next to the new legacy one.

**Code rollback.** Reverting A-4.x leaves the documents unread, and families keep working, because `installationId` is an ignored extra field. No cleanup job then runs, so registration documents (requested name, runtime) remain. The rollback runbook purges the `auth/agent-registration*` prefixes and expired holds by hand.

### 10. Deliberate differences, and residual risk

| Plan text | v1 decision | Why |
| --- | --- | --- |
| §42: a separate short-lived activation code after approval | The bootstrap token activates once, with `activationId` recovery | One fewer secret, with the same binding: one registration, private to the helper, single use. The secure-field fallback's bootstrap **code** belongs to A-3.1b. |
| §43: `status` includes `connected`, `offline`, `degraded`, `needs_reconnect` and `paused` | Stored status is `active` or `ended`, derived from the family | Connection wording has one source of truth, a5-presence. `paused` belongs to the agent and `needs_reconnect` is credential expiry. Storing them twice would let them disagree. |
| §43: `inboxId` and `capabilities` on the installation | Not included | The inbox belongs to the agent. Declared capabilities stay on the registration, so they are never mistaken for proof. |
| §36: registration statuses | Adds `activated` and `withdrawn` | Recovery needs `activated`; the owner's undo needs `withdrawn`. |
| §38: the claim screen "displays the same code" | The human types the code, and `claim.url` never contains it | See below. |
| §39: grants **per installation** | Permissions stay **per agent**, re-decided at every attach | Matches today's model and a3. Per-installation grants arrive with central authorization (Phase D). |
| §39: a policy profile | `"default"` only | No named profiles exist yet. The field is in the wire shape, so adding them later is additive. |
| §65: the flag list | Adds `ENVOI_AUTHENTICATED_REST_ROUTE` | REST is proven separately (§1). |
| a5 §1: presence renames at Phase B (`lastWorkClaimAt` → `lastClaimAt`) | Not renamed | Installation and family are 1:1 in v1, so a rename would only break a5 consumers. Revisit when an installation can have several families. |
| Two-owner plan: "five wrong claims before invalidation" | Five failures per human per 15 minutes | §2 |
| Two-owner plan: creation "bounded per pending owner/workspace" | Bounded per source, network and wide network, globally, and at three waiting approvals per human | A registration has no owner or workspace until it is claimed (§2). |
| v3 §40: effective permissions are a strict intersection | The intersection plus `receive_agent_messages`, always | Every agent can receive, as today's enrollment ensures. An agent that cannot receive could not get owner instructions. |
| v3 §32 step 5, §47 step 6: the model sees only the claim URL and code | `x-model-visible` also allows workspace, agent name and address, permissions, route and mode | None is a secret, and the §4 confirmation needs them in the chat (§7). |
| PR #75: on-demand hosts need an "On demand" label | `poll` and `on_demand` stay unavailable | The label does not exist yet; with a5 v1 a healthy on-demand host would look broken. |

**What typing the code protects against, and what it does not.** Typing stops the one-click case: a link that pre-fills a code and gets an agent approved without the owner ever handling the code. It does **not** stop social engineering. Anyone can create a registration with no auth, then talk an owner into typing its code: a new agent in the victim's workspace, or a takeover of an existing agent's identity. Conversely, a code exposed in a chat transcript can be claimed by whoever types it first.

The v1 mitigations are:
- only allowlisted, signed-in humans can claim;
- the lookup shows the requested details as the agent's claims, with its age;
- `existing_agent` forces explicit confirmation of the installation being replaced (`replacesInstallationId`), re-decides permissions, and re-checks everything at activation;
- **the helper activates only after the human beside the host confirms** the approver (`approverEmailHint`), the workspace, the agent and the permissions (§4). A code leaked from a shared chat and approved by someone else therefore stops at that human, who sees a stranger's account and declines;
- every approval appears in `GET /api/agent-claims`, for the approver and for every current manager of its target, with Withdraw until activation (§5.4);
- approvals, activations and replays are audited;
- names refuse control and bidirectional characters.

**Accepted for the beta, not in v1:**
- a coarse network origin on the lookup screen;
- fresh re-authentication before replacing an existing agent's installation;
- address squatting: an allowlisted human could hold up to three addresses at a time, ten minutes each, by approving self-made registrations, and repeat that by script. The beta has few, known humans, and each hold is audited;
- the confirmation is enforced by the helper. A host controlled by the attacker can skip it, but such an attacker already holds the bootstrap token, and the owner who typed the code still had to approve;
- without a host-native prompt the confirmation is advisory: a model that is manipulated, or that answers for the human, can confirm a stranger's approval. The approver hint still reaches the chat, where the human can see it;
- `approverEmailHint` shows a masked email and full domain to whoever runs the host. For a leaked code, that is the attacker's own sign-in, which they chose to use;
- a declined confirmation is not reported to the owner, who sees the approval only as `expired`. A bootstrap-authenticated decline route is a v2 candidate;
- a distributed attacker with many /48 or /24 networks can still fill the global pending cap. Every registration expires within 600 s, and `agent_registration.limited` events surface the attack; operators can lower the limits.

These are candidates for v2 or A-3.1b.

### 11. Fixtures

`test/contract-fixtures.test.js` checks the following for every fixture:
- **schemas:** responses, and request bodies named in `request.schema`. A negative body named in `request.invalidAgainst` must **fail**, and for the reason in `request.invalidBecause`. Every body sent to a registration route names one or the other;
- **codes:** the `x-codes` row for the fixture's surface (status, lifecycle, retry, guidance including `guidanceByHelperState`, `retry-after`); that route-specific codes appear only on their route (`REGISTRATION_INVALID` and `ROUTE_NOT_AVAILABLE` on creation, the activation codes on activate, `INSTALLATION_NOT_FOUND` on installation routes); that `FEATURE_DISABLED`, `ROUTE_NOT_AVAILABLE` and `DELIVERY_MODE_NOT_AVAILABLE` occur exactly when the fixture's flags say so; that a bootstrap token on any other route gets `AUTHENTICATION_REQUIRED`; and that each `RATE_LIMITED` reason fits its route;
- **headers:** `cache-control` on every successful response (`public, max-age=60` for routes, `no-store` otherwise, except the a3 status route);
- **helper lifecycle:** the lifecycle of each successful helper response, including `CONFIRMING` for an approved poll;
- **model-visible output:** every key is allowlisted; server-derived values equal their source; `state` fits the response; no token, internal id, `activationId` or id UUID from the exchange or its stored state appears, not even in free text; no code appears outside a pending registration;
- **route availability:** completeness and the flag rules;
- **claims:** code normalization, grantable and effective permissions (always including receive, also by schema), `agent.id` exactly for `existing_agent` (also by schema), a new agent's chosen name and address, the response target matching the request, and the owner claim list's order;
- **installation lists:** every active installation newest first, then at most `ownerInstallationEndedMax` ended ones newest first, all for the listed agent;
- **installations elsewhere:** an activation creates an active, non-legacy installation on the requested mode and an available route; a revoke returns ended/revoked; a legacy installation has the projected shape (by schema);
- **derivation:** every listed installation, and the installation named by agent status, is re-derived from the stored families (projection, frozen agents, read-time status, and the five-newest-ended cut). A legacy installation can never have ended by `activation_replay`;
- **migration and restart steps:** every step of the migration, rollback, re-enable and restart fixtures. After a restart every step succeeds, the stored agent is approved and not frozen, an `existing_agent` approval attaches to it, and its `replacesInstallationId` is the newest active installation derived from the stored families, or `null`;
- **tokens:** placeholders only, now including `envoi_reg_`.

A separate test checks three things:
- `activation-recovered`, `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-reject-replayed` and `claim-withdraw-replayed` repeat their originals exactly, and `activation-token-invalid-unresolved` is the identical activation request;
- the registration, lookup, approval (both targets), polling and paused-activation fixtures describe one consistent registration, including its claim window and activation deadline;
- the lookup's window equals `registrationTtlSeconds`, the unresolved retry declares its helper state, the legacy fixture stores more ended families than the list shows, and the limits agree (claim-list bound, retention order, widening creation limits).

The revision-3 checks were mutation-tested: 42 deliberate fixture and schema mutations are each caught, and existing agents' UUID and 48-character addresses and 80-character display names validate.

| Group | Fixtures |
| --- | --- |
| Availability | `routes-available`, `routes-available-rest`, `routes-disabled` |
| Registration | `registration-created`, `registration-feature-disabled`, `registration-route-not-available`, `registration-rest-not-enabled`, `registration-invalid`, `registration-unsafe-name`, `registration-rate-limited` |
| No access | `bootstrap-pending-no-status`, `bootstrap-pending-no-mcp`, `bootstrap-rejected-no-claim`, `bootstrap-expired-no-send` |
| Polling | `registration-pending`, `registration-approved`, `registration-rejected`, `registration-expired`, `registration-withdrawn`, `registration-activated`, `registration-poll-after-recovery-window`, `registration-poll-too-fast`, `registration-token-invalid` |
| Claim | `claim-lookup`, `claim-feature-disabled`, `claim-code-invalid`, `claim-attempts-exhausted`, `claim-not-admitted`, `claim-auth-unavailable`, `claim-approve-new-agent`, `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-approve-existing-agent`, `claim-approve-wrong-code`, `claim-already-decided`, `claim-account-changed`, `claim-forbidden`, `claim-address-taken`, `claim-agent-limit`, `claim-pending-activation-limit`, `claim-agent-not-reconnectable`, `claim-stale`, `claim-invalid`, `claim-reject`, `claim-reject-replayed`, `claim-reject-after-approve`, `claim-reject-wrong-code`, `owner-claims`, `claim-withdraw`, `claim-withdraw-replayed`, `claim-withdraw-not-found` |
| Activation | `activation-created`, `activation-recovered`, `activation-paused-agent`, `activation-pending`, `activation-rejected`, `activation-expired`, `activation-withdrawn`, `activation-id-required`, `activation-invalid`, `activation-token-invalid-unresolved`, `activation-replay`, `activation-after-recovery-window`, `activation-recovery-expired`, `activation-delivery-not-available`, `activation-server-error` |
| Installations | `agent-status-installation`, `agent-status-legacy-address`, `owner-installations`, `owner-installations-legacy-several`, `owner-installations-frozen-agent`, `owner-installation-revoke`, `owner-installation-not-found`, `installations-feature-disabled` |
| Migration and restart | `migration-legacy-family`, `rollback-flags-off`, `reenable-after-rollback`, `reconnect-after-installation-revoke` |

### 12. Implementation notes for A-4.x (Lane A; informative)

- **One approval module.** Extract today's pending-agent approval into `src/agent-approval.js` and call it from the legacy approve route and from §5.3 (v3 §41). Registration and installations go in `src/agent-registration.js` and `src/agent-installations.js` (v3 §64).
- **Locks and slot counting.** Approve, withdraw and activate run inside `withInboxMutation`, with lock keys for the registration, the principal's `human:<id>:active-agents` and, for `new_agent`, `address-hold:<address>`. State moves only through conditional writes. Slot counting (`assertActiveAgentSlot`) charges the principal human, counts agents with a live family or no family (live: not revoked and not past `refreshExpiresAt`), and passes `excludingAgentId` for `existing_agent`. It adds that human's live `new_agent` approvals, plus `existing_agent` approvals of their agents that have no live family.
- **Startup reconciliation.** Narrow `reconcileLegacyAgentRevocations` (`src/server.js`, run at boot) so that it never freezes an agent whose families were ended by a per-installation revoke, a replay or a replacement. The freeze arrived in `ce07de5` (2026-10-02), and every boot since then has reconciled the pre-freeze data, while today's agent-wide revoke freezes in its own mutation. So the preferred option is to run the job once more behind a marker document and then retire it. The alternative is to reconcile only when every family lacks `revokedReason`, which arrived in `a50766c` (2026-10-09). Add a restart test on FileStore and PostgreSQL for `reconnect-after-installation-revoke`, and one for a `REFRESH_REPLAY` of an agent's only family.
- **Approval module.** The legacy approve route also lets a linked principal who is not an inbox manager approve. The shared module keeps that rule for the legacy route only.
- **Tests.** Every fixture runs against FileStore and PostgreSQL. Restart tests prove that durable limits, holds and pending registrations survive a container restart (two-owner plan B). A cleanup test proves the 24-hour deletion and the release of address holds.
- **Deployment.** Add the three flags to the Worker allowlist, `production-config`, `promote-release`, `.env.production.example` and `check-deployment`, all defaulting off.
- **Order (two-owner plan).** No implementation starts before `CONTRACT-APPROVED agent-registration v1`, and none is enabled before the hosted Phase A gate passes.

### 13. Revisions within v1 (before ACK)

- **Lane A independent review, against `a814a75`.** The review found three blockers:
  - activation did not re-check the decision, and approvals could not be undone;
  - re-attaching an agent restored its old permissions and skipped the agent limit;
  - approval created an agent that was orphaned if activation never happened.

  Most of the should-fix items were also addressed:
  - surface-specific code rows that match a3;
  - read-time installation status;
  - HKDF over the raw token;
  - the IPv6 /64 source key;
  - `CLAIM_FORBIDDEN` without an existence oracle;
  - approve replay and the owner claim list;
  - `poll` and `on_demand` held back;
  - a model-visible allowlist that fits Lane B's output;
  - the missing fixtures;
  - test checks that now fail on each of the review's 26 surviving mutations.

  Nothing had been consumed yet, so the version stays 1.
- **Lane A re-review, against `5e24430`.** The re-review confirmed the three blockers fixed and found four problems the revision introduced:
  - a late retry could register a duplicate agent; the token now becomes a tombstone that answers `ACTIVATION_RECOVERY_EXPIRED`;
  - the replay semantics were contradictory; `CLAIM_ALREADY_DECIDED` now has its own code;
  - address holds blocked today's reservation paths; they now live under their own prefix;
  - slot counting was unspecified; the slot is charged to the principal human, and "live" means unexpired.

  Also fixed:
  - test holes: free-text leaks, `state` not tied to the response, silent loss of a request schema, negative bodies that could fail for the wrong reason, the agent-status projection, and legacy `activation_replay`;
  - nits: withdraw by any co-manager, reject replay, the newest active installation, a neutral `approval_ended` guidance, and address squatting listed as residual risk.

  The version stays 1.
- **Lane B `MISMATCH` round 1 and a full Lane A review, against `36f7943` (after the first `CONTRACT-APPROVED`).**
  - **Why:** Lane B's consumer review found that `ownerInstallationList` capped `installations` at 6. That rejected a valid list of two active legacy installations plus five ended ones. The new Lane A session then ran three independent reviews, of the prose against the plans, the schemas and fixtures, and the claims about today's code.
  - **Version:** the approval preceded Lane B's review and nothing consumes v1 yet, so the human decided it stays v1 and is re-approved after a new `CONTRACT-ACK`.
  - **Product decisions (human):**
    - local confirmation of the approving workspace before activation (§4);
    - co-managers see and can withdraw each other's approvals (§5.4);
    - network-level registration limits (§2).
  - **Blockers fixed:**
    - the installation list has no bound on active entries; ended ones are capped by the test, and a seven-entry fixture proves it (§6.5);
    - response-side addresses and names accept existing agents' UUID and 48-character addresses and unbounded names (§3);
    - startup reconciliation must not freeze an agent after a per-installation revoke or a replay (§6.5, §12, a restart fixture);
    - agents frozen by the agent-wide revoke are still projected (§9).
  - **Semantics fixed:**
    - decision replays work in every later state, for approve, reject and withdraw (§5.3, §5.4);
    - the `REGISTRATION_TOKEN_INVALID` wording matches the tombstone, and an unresolved activation gets `check_owner_agents` (§2);
    - records are kept at least 24 h and deleted by 25 h;
    - `claim.url` follows `ENVOI_PUBLIC_URL`;
    - `receive_agent_messages` and `agent.id`-by-target are enforced by schema;
    - U+061C and U+180E are refused;
    - the slot rule matches `assertActiveAgentSlot`;
    - `active` means not revoked;
    - an activation replay never rewrites an ended installation;
    - activation re-checks the route and the slot;
    - an invalid activation body has its own code, `ACTIVATION_INVALID`, and leaves the approval live;
    - the recovery-key construction and the hold transaction are stated correctly;
    - three plan differences gained §10 rows.
  - **Test holes closed:** derivation outside migration fixtures, `cache-control`, `activationId` and UUID leaks, bootstrap tokens elsewhere, rate-limit reasons, claim-list order, cross-fixture deadlines, and fixtures for §6.1 rows 3 and 5 and the claim-route `FEATURE_DISABLED`.
  - **Re-review of the revision (`bcbef50`)** found no blocker. Fixed:
    - a fixture for existing agents' addresses and names;
    - a confirmation the helper can actually attribute: host-native prompt preferred, chat advisory, and `approverEmailHint` because the approver chooses `workspaceName`;
    - display-bounded, redacted names;
    - a restart check that proves the agent was not frozen;
    - codes tied to their routes;
    - the claim list keyed on creation and filtered by the live check;
    - the cleanup sparing a replaced hold;
    - no double-counted slots;
    - limit consistency checks.
  - **Mutation testing:** 42 deliberate mutations caught (§11).
