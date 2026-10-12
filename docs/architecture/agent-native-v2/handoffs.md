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

**Contract:** `agent-registration`, version 1 (build-plan task **A-3.1a**). **Status:** published, awaiting Lane B `CONTRACT-ACK` and the human's `CONTRACT-APPROVED`. Design only: no server code exists, and nothing here is default-on.

**Fixtures:** [`test/contract-fixtures/agent-registration/`](../../../test/contract-fixtures/agent-registration/). That holds:
- `schemas.json`: the schemas plus the machine-readable tables `x-codes`, `x-limits`, `x-model-visible`, `x-permission-labels`, `x-route-availability`, `x-delivery-availability` and `x-operations`;
- one JSON file per case, including one migration and one rollback fixture (§9).

**Owner:** Lane A. **Consumer:** Lane B (`envoi-link connect`, the `/connect` skill and manifest, the claim UI, and the host planner in PR #72). **Implemented by:** A-4.x, which waits for this contract's approval **and** the hosted Phase A gate (two-owner plan A5).

This is the route-neutral Phase B core from v3 §30–§45, as amended by PR #75:
- one registration, human claim, activation and installation state machine;
- the same agent operations for every connection route.

It builds on `a3-pause-auth` v3 (envelope, codes, pause, reconnect), `a4-wake` v2 (work availability) and `a5-presence` v1 (presence, owner connection states).

**Not in v1.** Everything below belongs to **A-3.1b** (`agent-remote-auth`), published separately:
- the remote MCP/OAuth route and the provider-connector route, including OAuth metadata, consent-as-claim and the secure-field bootstrap code;
- the delivery modes `webhook`, `provider` and `a2a`.

Each of those routes and modes is `available: false` in v1, and registration refuses it (§1).

### 1. Flags and route availability

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_INSTALLATIONS_V2` | The installation model: the legacy projection (§9), `installation` on agent status (§6.4) and the owner installation routes (§6.5). |
| `ENVOI_AGENT_REGISTRATION_V2` | Registration (§3), polling (§4), the human claim (§5) and activation (§6). Requires `ENVOI_INSTALLATIONS_V2`. Startup fails closed if this flag is on and that one is off. |
| `ENVOI_AUTHENTICATED_REST_ROUTE` | The `authenticated_rest` route, in addition to the two above. **New** relative to v3 §65: the breadth gate (v3 §47) proves REST separately from the local helper, so REST needs its own switch. |

Lane A owns these flags. The client never reads them. It reads the public route-availability endpoint:

`GET /api/onboarding/routes` (no auth, `cache-control: public, max-age=60`) → `routeAvailability`:
- `registrationEnabled` and `installationsEnabled`;
- all four `connectionRoute`s and all six `deliveryMode`s, each with `available`.

The rules are `x-route-availability` and `x-delivery-availability`:
- `local_helper` is available when both V2 flags are on;
- `authenticated_rest` additionally needs `ENVOI_AUTHENTICATED_REST_ROUTE`;
- `remote_mcp_oauth` and `provider_connector` are never available in v1;
- `envoi_link`, `poll` and `on_demand` are available when both V2 flags are on;
- `webhook`, `provider` and `a2a` are never available in v1.

`/connect`, `skill.json` and the helper offer only what this endpoint marks available. A flag-off route returns `404 FEATURE_DISABLED`.

**Rollout.** The human turns a flag on only after the route's hosted gate passes (v3 §47). The default `/connect` copy names only routes that are available.

### 2. Codes, tokens and limits

All values are machine-readable in `x-limits`.

| Item | Rule |
| --- | --- |
| Verification code | 8 symbols from the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, uniformly random (40 bits), shown as `XXXX-XXXX`. Input is case-insensitive, spaces and hyphens are ignored, and `I`/`L` read as `1` and `O` as `0`. Stored only as an HMAC-SHA256 under a key derived from `ENVOI_DATA_ENCRYPTION_KEY`, never in clear and never logged. If a new code collides with a live one, the server draws again. |
| Bootstrap token | `envoi_reg_` + 32 random bytes, base64url. Stored as SHA-256. Bound to one registration. It authenticates only §4 and §6. On any other route it is an unknown token: `401 AUTHENTICATION_REQUIRED`, identical to any unrecognized bearer (fixture `bootstrap-token-no-access`). |
| Claim window | 600 s from creation (`expiresAt`). |
| Activation window | 600 s from approval (`activationExpiresAt`). |
| Activation recovery | 300 s, as for A1 refresh recovery (§6.2). |
| Polling | `pollAfterSeconds` 5. Polling faster gets `429 RATE_LIMITED`, reason `poll_interval`. This limit may live in memory, because it is not a safety boundary. |
| Registration creation | At most 10 per source address per hour, at most 1,000 pending registrations globally, and a body of at most 4,096 bytes. **Durable:** the counters live in the document store, so a container restart does not reset them. Over a limit → `429 RATE_LIMITED`, reason `registration_limit`. |
| Claim failures | At most 5 per human per 15 minutes, durable. A lookup, approve or reject with a code that does not match counts as one failure. When the limit is hit → `429 RATE_LIMITED`, reason `claim_attempts`, and the **correct** code is refused too until `retry-after`. |
| Cleanup | Every registration record and its code and token index are deleted within 24 h of creation, whatever their state. The code index is deleted as soon as the registration is decided or expires. |

**Change from the two-owner plan's starting numbers ("five wrong claims before invalidation").** The human **types** the code (§5.1), so a wrong code does not identify a registration and there is nothing to invalidate. The cap therefore applies per human. With 40 bits, five tries per 15 minutes, and only allowlisted, signed-in humans able to try, guessing a live code is negligible. Every other starting value is unchanged.

### 3. Registration

`POST /api/agent-registrations`, no auth. Body `registrationCreateRequest` (closed object; unknown fields → `400 REGISTRATION_INVALID`).

| Field | Rule |
| --- | --- |
| `requestedName` | 1–80 characters. |
| `requestedLocalPart` | Optional. Same rules as today's agent address local part: 3–32 characters, `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, not reserved. Not reserved at this step; the human chooses the final address (§5.3). |
| `requestedPermissions` | 1–5 of `send_agent_messages`, `receive_agent_messages`, `create_assets`, `execute_cases`, `use_email_transport`. The agent asks; it never grants (v3 §40). |
| `connectionRoute` | Must be available (§1), or the response is `400 ROUTE_NOT_AVAILABLE`. |
| `runtime` | `{ type, version }`. `type` matches `^[a-z0-9][a-z0-9_-]{0,31}$`; `version` is a short version string or `null`. Metadata only, never trusted. |
| `deliveryCapabilities` | Six booleans, as in v3 §36: `persistentProcess`, `outboundHttps`, `sse`, `webhook`, `scheduledPolling`, `a2a`. Host declarations, shown to the human as claims, never trusted as evidence. |
| `helper` | Optional `{ name, version }`. |

**`201` `registrationCreated`** (`cache-control: no-store`):

```json
{ "registrationId": "registration_…", "status": "pending_claim", "bootstrapToken": "envoi_reg_…",
  "claim": { "url": "https://www.envoi-agents.com/claim", "verificationCode": "F7KQ-PM4D", "expiresAt": "…" },
  "expiresAt": "…", "pollAfterSeconds": 5 }
```

- `claim.url` is `${ENVOI_PUBLIC_URL}/claim` and **never contains the code**. That is deliberate (§10).
- **Not idempotent.** If the response is lost, the helper registers again. The orphan expires in 10 minutes and grants nothing.
- **A pending registration grants nothing.** It has no inbox, messaging, work claim, case, file, MCP or directory access (v3 §36).

### 4. Registration status

`GET /api/agent-registrations/{registrationId}` with `Authorization: Bearer envoi_reg_…`. The response is `registrationStatus`, one of:

| `status` | Extra fields | Helper does |
| --- | --- | --- |
| `pending_claim` | `expiresAt`, `pollAfterSeconds` | Wait and poll. |
| `approved` | `target` (`new_agent` or `existing_agent`), `agent { name, address }`, `effectivePermissions`, `activationExpiresAt` | Activate (§6). |
| `activated` | `installationId` | Already done. Credentials are **never** repeated here. If they were lost, recover with the same `activationId` inside 300 s (§6.2); otherwise the owner reconnects. |
| `rejected` | none | Stop, and delete the bootstrap token. |
| `expired` | none | Stop. Never show the old code again. Start one new registration only if the human asks. |

`expired` covers both an unclaimed registration and an approved one that was not activated in time. A token that is unknown, deleted, or does not belong to `{registrationId}` gets `401 REGISTRATION_TOKEN_INVALID`, identical in every case.

### 5. Human claim

#### 5.1 Who can claim

Every claim request needs all of the following:
- **A human session** with CSRF, as for every human mutation (envoi-browser-names v1). Lookup is a POST, so it carries CSRF too.
- **A fresh allowlist check.** The beta allowlist is re-evaluated at claim time, not taken from an earlier login. If the human is no longer admitted, the response is `401 AUTHENTICATION_REQUIRED`.
- **Authentication assurance.** Under local auth, the current assurance rule (`mfa`) applies. WorkOS sessions keep their provider assurance.
- **A live management check for approve.** The human must be able to manage the chosen workspace, using the live provider-membership check (`maxAgeMs: 0`). For `existing_agent`, the human must also be that agent's owner (its principal human, or the workspace manager). Otherwise `403 CLAIM_FORBIDDEN`.

The human types the code shown by their agent at `/claim`. Typing it is the confirmation that the code matches (v3 §38).

#### 5.2 Lookup

`POST /api/agent-claims/lookup` with `{ verificationCode }`. The response is `claimLookup`:
- the normalized code, `requestedName` and `requestedLocalPart`;
- `requestedPermissions` and `grantablePermissions` (requested ∩ organization maximum);
- `connectionRoute`, `runtime` and `deliveryCapabilities`;
- `createdAt` and `expiresAt`.

The UI presents the agent's fields as **things the agent claims**, not facts.

If the code is malformed, unknown, expired, already decided, or belongs to another registration, the response is `404 CLAIM_CODE_INVALID`. It is identical in every case and counts as one failure.

#### 5.3 Approve

`POST /api/agent-registrations/{registrationId}/approve`, body `claimApproveRequest`:

```json
{ "verificationCode": "F7KQ-PM4D", "workspaceInboxId": "inbox_…",
  "target": { "kind": "new_agent", "name": "…", "localPart": "…" },
  "grantedPermissions": ["send_agent_messages", "receive_agent_messages"], "policyProfile": "default" }
```

The code is required again, which binds the decision to what the owner saw. `{registrationId}` comes from the lookup.

**`new_agent`**
- `grantedPermissions` is required.
- The server computes `effectivePermissions` = requested ∩ granted ∩ organization maximum, plus `receive_agent_messages` (today's rule: an agent always receives).
- In v1, the organization maximum is the full permission list, because there are no per-organization ceilings yet.
- Anything granted but not requested is dropped silently. The response says what was actually granted.
- The agent is created **at approval**: `status: "active"`, `onboardingStatus: "approved"`, its address reserved and its dedicated inbox created, as enrollment does today.
- It has no credential family until activation, so a5-presence shows it as `not_connected` ("Not connected").
- `ACTIVE_AGENT_LIMIT` and address uniqueness (`409 ADDRESS_TAKEN`) apply here.

**`existing_agent`**
- `grantedPermissions` must be absent. The agent keeps its permissions, address, cases and history.
- The target must be an approved agent that is `active` or `paused` in the chosen workspace. It may have every credential family revoked; that is today's re-enroll case. Otherwise the response is `409 AGENT_NOT_RECONNECTABLE`.
- Approval changes nothing yet. The current installation keeps working until the new one **activates** (§6.3). A paused agent stays paused (a3 §4).

**Other fields and response**
- `policyProfile` is `"default"` only in v1, meaning the workspace's active policy. Named profiles come later.
- **`200` `claimApproved`:** `agent { id, name, address, status }`, `inboxId`, `effectivePermissions`, `policyProfile` and `activationExpiresAt`.
- **No credential is ever returned to the browser.** That differs from today's `POST …/agent-onboarding/{agentId}/approve`, which returns tokens. A-4.x moves both paths onto one approval module (v3 §41), and only the legacy route keeps its response shape.
- **Audit:** `agent.registration_approved`, with the target and the effective permissions.

**Precedence.** The first matching check wins:
1. `RATE_LIMITED` (claim failures, or the ordinary request limit);
2. session and CSRF (`401`, `403`, `ACCOUNT_CHANGED`);
3. `CLAIM_CODE_INVALID`, if the registration is missing, not pending, expired, or the code does not match;
4. `CLAIM_INVALID` (body validation);
5. `CLAIM_FORBIDDEN`;
6. `AGENT_NOT_RECONNECTABLE`, `ADDRESS_TAKEN` or `ACTIVE_AGENT_LIMIT`.

The code is checked before anything that would reveal facts about workspaces or agents.

**Concurrency.** The first decision wins. A second human entering the same code afterwards gets `CLAIM_CODE_INVALID`.

#### 5.4 Reject

`POST /api/agent-registrations/{registrationId}/reject` with `{ verificationCode }` returns `200` `{ registrationId, status: "rejected" }`. Audit: `agent.registration_rejected`.

### 6. Activation and installations

#### 6.1 Activate

`POST /api/agent-installations/activate` with `Authorization: Bearer envoi_reg_…`. Body:

```json
{ "registrationId": "registration_…", "activationId": "…", "deliveryMode": "envoi_link" }
```

**`activationId`**
- Matches `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`.
- The helper persists it privately **before** sending, exactly like A1's `rotationId`.
- It is checked before the token is looked up. If it is missing → `400 ACTIVATION_ID_REQUIRED`, and nothing is consumed.

**`deliveryMode`**
- The host's declared wake mode: `envoi_link`, `poll` or `on_demand` in v1. Anything else → `400 ROUTE_NOT_AVAILABLE`.
- It is a **declaration**. The server never treats it as evidence of closed-app reachability (§7).

**Outcomes.** The first matching row wins.

| Condition | Response |
| --- | --- |
| Feature off | `404 FEATURE_DISABLED` |
| `activationId` missing or malformed | `400 ACTIVATION_ID_REQUIRED` |
| Token unknown, deleted, or not this registration's | `401 REGISTRATION_TOKEN_INVALID` |
| Body otherwise invalid / mode unavailable | `400 REGISTRATION_INVALID` / `400 ROUTE_NOT_AVAILABLE` |
| `pending_claim` | `409 REGISTRATION_PENDING` |
| Rejected, or claim/activation window passed | `409 REGISTRATION_ENDED` with `reason` `rejected` or `expired` |
| Already activated, **different** `activationId` | `401 ACTIVATION_REPLAY`. The installation that activation created is revoked, because two parties hold one bootstrap token. Its holders get `CREDENTIAL_REVOKED` with `reason: "revoked"` and `credential.ended` (a3 §2, §5). Audit `agent.activation_replay_detected` for the owner. |
| Already activated, **same** `activationId`, within 300 s | `200` with the **identical** body as the original `201` |
| Already activated, same `activationId`, after 300 s or envelope undecryptable | `401 ACTIVATION_RECOVERY_EXPIRED` |
| Approved and inside the window | `201` `activated` |

**`activated` body:**
- `installation` (§6.4), `agent { id, name, address, status }` and `inboxId`;
- `permissions`;
- `agentApiToken`, `agentRefreshToken`, `agentTokenExpiresAt`, `agentRefreshTokenExpiresAt` and `tokenType`.

The token fields are the same as today's enrollment response. Refresh continues through `POST /api/agent-token` unchanged (A1, a3 §2.2).

#### 6.2 Lost activation response

On `201`, the server stores a 300-second AES-GCM recovery envelope of the response, bound to:
- the bootstrap token's hash;
- the `activationId`;
- the registration;
- `ENVOI_DATA_ENCRYPTION_KEY`.

This is the same construction as A1. The helper saves the credentials atomically, then deletes the bootstrap token and `activationId`.

#### 6.3 What activation does

**Creates the installation and its credential family together.** One installation has exactly one credential family in v1. Presence stays keyed by that family, exactly as a5-presence §1 defines it.

**For `existing_agent` targets:**
- revokes **every earlier** credential family of the agent with `reason: "replaced"`;
- releases held leases;
- closes their streams with `credential.ended`.

This matches a3 §4 reconnect redemption. A paused agent stays paused: the response carries `agent.status: "paused"`, and the connector enters `PAUSED`.

**Audit:** `agent.installation_activated`.

#### 6.4 The installation object

| Field | Meaning |
| --- | --- |
| `id` | `installation_…`. Legacy families use `installation_legacy_` + the family UUID (§9). |
| `agentId` | The agent identity, which outlives installations. |
| `connectionRoute` | How this host authenticates (v3 §45). |
| `deliveryMode` | The host's **declared** wake mode. |
| `runtime` | `{ type, version }` as declared; `version` may be `null`. |
| `status` | `active` or `ended` (§10). |
| `endedReason` | `null` while active; otherwise `revoked`, `replaced`, `refresh_replay` or `activation_replay`. |
| `legacy` | `true` for a projected pre-Phase-B family (§9). |
| `createdAt`, `activatedAt`, `endedAt` | Timestamps. `endedAt` is `null` while active. |

**At most one active installation per agent in v1.** A second runtime for the same identity replaces the first at activation. Concurrent installations for one agent are a later version.

**Agent status.** `GET /api/agent/status` gains `installation: { id, connectionRoute, deliveryMode, legacy }` when `ENVOI_INSTALLATIONS_V2` is on. This is additive (a3 §1 forward compatibility); old connectors ignore it.

#### 6.5 Owner installation routes (`ENVOI_INSTALLATIONS_V2`)

**List:** `GET /api/inboxes/{inboxId}/agents/{agentId}/installations` → `ownerInstallationList`.
- Bounded: the active installation first, then at most five ended ones, newest first.
- The owner UI shows route, delivery mode and runtime **as declared**.
- The connection state and wording still come only from a5-presence §4–§5.

**Revoke:** `POST …/installations/{installationId}/revoke` (human session, workspace manager) → `200 { installation }`, now `ended`/`revoked`.
- Holders get `CREDENTIAL_REVOKED` with `reason: "revoked"`.
- Unlike the agent-wide `credentials/revoke` route, this **does not freeze the agent identity**. A new registration can attach to the same agent (`existing_agent`).
- If the agent is left with no active family, a5-presence v1 reports it as `revoked` ("Access revoked"), as it already does when every family is revoked.
- An unknown id → `404 INSTALLATION_NOT_FOUND`.
- Audit: `agent.installation_revoked`.

#### 6.6 One set of agent operations for every route

Route-neutral means every connection route reaches the **same** operations, with the same codes. They are listed in `x-operations`:

| Operation | Requests | Defined by |
| --- | --- | --- |
| Identity | `GET /api/agent/status` | a3 §3, a5 §4.1, §6.4 here |
| Work availability | event stream, delta, claim `nextAvailableAt` | a4-wake v2 |
| Claim | `POST /api/agent/work/claim` | a3 §3, a4 §4–§5 |
| Reply | instruction reply, `POST /api/inboxes/{inboxId}/messages` | existing shapes, a3 codes |
| Settlement | `POST /api/agent/work/{workId}/{renew,acknowledge,complete,fail}` | a3 §3 |
| Refresh | `POST /api/agent-token` | A1, a3 §2.2 |

v1 adds no new agent operation:
- the local helper and REST client call these directly;
- A-3.1b maps the remote MCP and provider routes onto the same operations, including HTTP `409 AGENT_PAUSED` rather than a JSON-RPC result (a3 §3).

### 7. What the model may see

`x-model-visible` is the allowlist. A helper, connector or tool may put **only these values** where a model can read them (helper stdout, tool results, chat):

| Key | Source |
| --- | --- |
| `claimUrl` | `claim.url` |
| `verificationCode` | `claim.verificationCode`, only while `pending_claim` and before `expiresAt` |
| `expiresInSeconds` | derived from `claim.expiresAt` |
| `registrationStatus` | `status` |
| `agentName`, `agentAddress`, `agentStatus` | `agent` |
| `permissionSummary` | `effectivePermissions` through `x-permission-labels` |
| `connectionRoute`, `deliveryMode` | `installation` |
| `guidance` | the received code's guidance |

**Never model-visible:** the bootstrap token, the `activationId`, any access or refresh token or fragment, registration, installation and inbox ids, raw request and response bodies, authorization and cookie headers, and storage paths. Each helper fixture's `client.modelVisible` shows the exact projection, and the fixture test enforces this allowlist.

**Answers to Lane B's open questions** (PR #72, `HELPER-OUTPUT-EXAMPLES.md`):
1. **Wire states and error codes.** These are §4 and §8. The helper's own `contract_blocked` placeholder goes away once this is approved.
2. **What "connected" means.** It means an authenticated `GET /api/agent/status` succeeded after activation (fixture `agent-status-installation`). It is **not** delivery. In v1 the server never asserts closed-app reachability. A `verified_closed_app` claim stays host-owned evidence (v3 §47), and the owner-visible "On demand" label is a later a5-presence revision.
3. **Code expiry and retry.** Codes expire after 10 minutes. On retry while pending, the helper reuses the stored registration and does not print the code again. An expired code is never shown again.
4. **Permission labels.** Only `x-permission-labels` may be shown to the model.
5. **Publishing `/connect`.** `/connect` is published when `GET /api/onboarding/routes` shows an available route. The server exposes availability; the UI never reads flags.
6. **`verified_closed_app` evidence.** None is defined in v1. See question 2.

### 8. Codes

New codes use the a3 §1 envelope. `reason` carries the values below. A3 and a5 codes keep their meanings. The `lifecycle` column is the helper's registration lifecycle (`REGISTERING`, `PENDING_CLAIM`, `ACTIVATING`, `CONNECTED`, `REGISTRATION_ENDED`) or an a3 connector state. The same table is machine-readable in `x-codes`.

| Code | HTTP | Lifecycle | Retry | Guidance |
| --- | --- | --- | --- | --- |
| `FEATURE_DISABLED` | 404 | `REGISTRATION_ENDED` | none | `route_unavailable` |
| `ROUTE_NOT_AVAILABLE` | 400 | `REGISTRATION_ENDED` | none | `route_unavailable` |
| `REGISTRATION_INVALID` | 400 | `REGISTRATION_ENDED` | none | `update_helper` |
| `REGISTRATION_TOKEN_INVALID` | 401 | `REGISTRATION_ENDED` | none | `register_again` |
| `REGISTRATION_PENDING` | 409 | `PENDING_CLAIM` | `poll_after` | `wait_for_claim` |
| `REGISTRATION_ENDED` | 409 | `REGISTRATION_ENDED` | none | `rejected` → `owner_rejected`; `expired` → `register_again` |
| `ACTIVATION_ID_REQUIRED` | 400 | `UNCHANGED` | none | `update_helper` |
| `ACTIVATION_REPLAY` | 401 | `REVOKED` | none | `owner_reconnect` |
| `ACTIVATION_RECOVERY_EXPIRED` | 401 | `NEEDS_RECONNECT` | none | `owner_reconnect` |
| `AUTHENTICATION_REQUIRED` | 401 | `UNCHANGED` | none | `none` |
| `CLAIM_CODE_INVALID` | 404 | `NOT_APPLICABLE` | none | `check_code` |
| `CLAIM_INVALID` | 400 | `NOT_APPLICABLE` | none | `fix_claim` |
| `CLAIM_FORBIDDEN` | 403 | `NOT_APPLICABLE` | none | `not_permitted` |
| `ADDRESS_TAKEN` | 409 | `NOT_APPLICABLE` | none | `choose_another_address` |
| `ACTIVE_AGENT_LIMIT` | 409 | `NOT_APPLICABLE` | none | `agent_limit` |
| `AGENT_NOT_RECONNECTABLE` | 409 | `NOT_APPLICABLE` | none | `choose_another_agent` |
| `INSTALLATION_NOT_FOUND` | 404 | `NOT_APPLICABLE` | none | `none` |
| `ACCOUNT_CHANGED` | 409 | `NOT_APPLICABLE` | none | `reload_browser` |
| `RATE_LIMITED` | 429 | `UNCHANGED` | `after_retry_after` | `service_busy`; `claim_attempts` → `too_many_attempts` |
| `INTERNAL_SERVER_ERROR` / `AUTH_UNAVAILABLE` | 500 / 503 | `DEGRADED` | `backoff` | `service_unavailable` |

**Retries.** A helper retries an activation that failed on a 5xx, network error or timeout with the **same** `activationId` (`retry_same_activation_id` in `x-codes`' retry vocabulary). Request bodies over the server's general limit keep today's `413`.

### 9. Migration and rollback

**Migration, `ENVOI_INSTALLATIONS_V2` on.** Each existing credential family that is not revoked and has no `installationId` is **projected** as an installation. The fixture is `migration-legacy-family`.

| Installation field | Projected value |
| --- | --- |
| `id` | `installation_legacy_` + the family UUID |
| `connectionRoute` | `local_helper`, because every shipped connector (Hermes, OpenClaw, xAI) is a local bridge |
| `deliveryMode` | `envoi_link` |
| `runtime` | `{ type: family.runtime, version: null }` |
| `createdAt`, `activatedAt` | the family's `createdAt` |
| `legacy` | `true` |

- **Nothing is written.** No user re-enrolls, no SQL migration runs and presence is untouched.
- **Ended legacy installations** are projected from revoked families with the a3 `revokedReason`.
- **Replacement.** A legacy installation is replaced like any other when a new registration activates for that agent.

**New documents** (no SQL migration; path-keyed documents on FileStore and PostgreSQL):

| Path | Holds |
| --- | --- |
| `auth/agent-registrations/{registrationId}.json` | the registration |
| `auth/agent-registration-tokens/{sha256}.json` | `{ registrationId }` |
| `auth/agent-registration-codes/{hmac}.json` | `{ registrationId }` |
| `auth/agent-installations/{agentInboxId}/{agentId}/{installationId}.json` | the installation |
| `rate-limits/agent-registrations/…` and `rate-limits/agent-claims/…` | the durable counters |

New families also gain `installationId`, a new field on an existing document.

**Rollback.** Turn both flags off. The fixture is `rollback-flags-off`.
- Agents activated through the new flow keep working on their credential families. `GET /api/agent/status` just loses its `installation` field.
- The registration, claim and activation routes return `404 FEATURE_DISABLED`.
- An approved but unactivated agent shows "Not connected", and the owner reconnects it with Quick Connect.
- Nothing is deleted. Installation and registration documents are ignored and come back if the flags are turned on again. Registrations still age out (§2).

**Code rollback.** Reverting A-4.x leaves those documents unread. Families keep working, because `installationId` is an ignored extra field.

### 10. Deliberate differences from v3 and the two-owner plan

| Plan text | v1 decision | Why |
| --- | --- | --- |
| §42: a separate short-lived activation code after approval | The bootstrap token itself activates, once, with `activationId` recovery | It removes one more secret and keeps the same binding: one registration, private to the helper, single use. The secure-field fallback's bootstrap **code** is A-3.1b's, not this. |
| §43: `AgentInstallation.status` has `connected`, `offline`, `degraded`, `needs_reconnect` and `paused` | The stored `status` is `active` or `ended` | Connection wording already has one source of truth (a5-presence). `paused` belongs to the agent, and `needs_reconnect` is credential expiry. Storing them twice would let them disagree. |
| §38: the claim screen "displays the same code" | The human types the code; `claim.url` never contains it | A pre-filled code lets anyone who sends the owner a link get their agent approved with one click (the known device-flow phishing pattern). Typing the code is the comparison. |
| §39: the human chooses permissions **per installation** ("installation grants") | Permissions stay **per agent** in v1 | That matches today's model and a3. Per-installation grants arrive with central authorization (Phase D). |
| §39: a policy profile | `"default"` only | No named profiles exist yet. The field is in the wire shape so adding them later is additive. |
| Two-owner plan: "five wrong claims before invalidation" | Five failures per human per 15 minutes | See §2. |

### 11. Fixtures

`test/contract-fixtures.test.js` checks the following for every fixture:
- schemas, including request bodies that name a `request.schema`;
- the `x-codes` row: status, lifecycle, retry, guidance and `retry-after`;
- the model-visible allowlist;
- route availability against the fixture's flags;
- code normalization;
- the permission intersection;
- installation-list ordering;
- the legacy projection;
- every migration and rollback step;
- placeholder-only tokens, now including `envoi_reg_`.

| Group | Fixtures |
| --- | --- |
| Availability | `routes-available`, `routes-disabled` |
| Registration | `registration-created`, `registration-feature-disabled`, `registration-route-not-available`, `registration-invalid`, `registration-rate-limited`, `bootstrap-token-no-access` |
| Polling | `registration-pending`, `registration-approved`, `registration-rejected`, `registration-expired`, `registration-activated`, `registration-poll-too-fast`, `registration-token-invalid` |
| Claim | `claim-lookup`, `claim-code-invalid`, `claim-attempts-exhausted`, `claim-approve-new-agent`, `claim-approve-existing-agent`, `claim-reject`, `claim-forbidden`, `claim-address-taken`, `claim-agent-limit`, `claim-agent-not-reconnectable`, `claim-invalid` |
| Activation | `activation-created`, `activation-recovered`, `activation-paused-agent`, `activation-pending`, `activation-rejected`, `activation-expired`, `activation-id-required`, `activation-replay`, `activation-recovery-expired`, `activation-delivery-not-available` |
| Installations | `agent-status-installation`, `owner-installations`, `owner-installation-revoke`, `owner-installation-not-found`, `installations-feature-disabled` |
| Migration | `migration-legacy-family`, `rollback-flags-off` |

### 12. Implementation notes for A-4.x (Lane A; informative)

- **One approval module.** Extract today's pending-agent approval into `src/agent-approval.js` and call it from both the legacy approve route and §5.3 (v3 §41). Registration and installations go in `src/agent-registration.js` and `src/agent-installations.js` (v3 §64).
- **Locks.** Approve and activate run inside `withInboxMutation`, with lock keys for the registration and `human:<id>:active-agents`. A registration moves state through a conditional write, so two approvals or two activations cannot both win.
- **Test coverage.** Every fixture runs against FileStore and PostgreSQL. Restart tests prove that the durable limits and pending registrations survive a container restart (two-owner plan B), and a cleanup test proves the 24-hour deletion.
- **Deployment.** Add the three flags to the Worker allowlist, `production-config`, `promote-release`, `.env.production.example` and `check-deployment`, all defaulting off.
- **Constraint from the two-owner plan.** No implementation starts before `CONTRACT-APPROVED agent-registration v1`, and none is enabled before the hosted Phase A gate passes.
