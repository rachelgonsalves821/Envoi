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

**Contract:** `a3-pause-auth`, version 1. **Status:** published for review; not approved. **Fixtures:** [`test/contract-fixtures/a3-pause-auth/`](../../../test/contract-fixtures/a3-pause-auth/) (schemas in `schemas.json`, one JSON file per case, registered in `test/contract-fixtures/index.json`). **Owner:** Lane A. **Consumer:** Lane B (A2 connector lifecycle, UI). **Implemented by:** task A-1. Nothing in this section is implemented yet. Where today's server behaves differently, the text says so.

This contract defines the stable codes an agent credential can receive, what each code means for the connector, how a paused agent behaves, and the pause/resume events. It applies D1 from [claude-codex-build-plan.md](claude-codex-build-plan.md) §1 and v3 §10–§20.

### 1. Error envelope

Every error covered by this contract has this JSON body:

```json
{ "code": "AGENT_PAUSED", "error": "AGENT_PAUSED", "message": "This agent is paused by its owner.", "requestId": "req_example" }
```

- `code` is the stable machine code. Clients branch on `code` only, never on `message` or on the HTTP status alone.
- `error` always equals `code`. It stays because existing clients read either `error` (`publicHttpError` already puts the code there) or `code` (the browser's `ACCOUNT_CHANGED` handling).
- `message` is safe to show a human. It never contains a credential or a token fingerprint, and it never reveals whether some other token exists.
- `requestId` echoes `x-request-id` when the client sent one (truncated to 128 characters). Otherwise the server generates it.
- Optional fields: `retryAfterSeconds` (`RATE_LIMITED`) and `caseId` (`CASE_CONTROLLED`).
- Clients must ignore unknown fields. New optional fields are additive and do not bump the version.

**Current behavior:** routes that use `fail()` send `{ "error": "<message>" }` with no code, and `ACCOUNT_CHANGED` sends `{ "error": "<message>", "code": "ACCOUNT_CHANGED" }`. A-1 moves every case in §2 to the envelope above. Errors not listed in §2 keep their current shape in v1. Examples are enrollment rejections, validation `400`s and `AGENT_BLOCKED`.

### 2. Codes

"Lifecycle" is the A2 connector state (v3 §19) that the connector enters. "Stay" means the state does not change.

| Code | HTTP | Returned when | Next allowed operation | Lifecycle |
| --- | --- | --- | --- | --- |
| `AGENT_PAUSED` | 409 | A valid credential of a **paused** agent attempts an action: send, case action, proposal, MCP tool call, `mcp-read-token`, or settling a lease (`renew`, `acknowledge`, `complete`, `fail`, instruction `reply`). Claim, refresh, status, connection-status, SSE and delta never return it (see §3). | Stop actions. Keep refreshing, keep SSE open, read `GET /api/agent/status`. Wait for `agent.resumed`. Do not re-enroll or reconnect. | `PAUSED` |
| `CREDENTIAL_REVOKED` | 401 | The credential family is revoked, the agent is revoked or removed, or the owner revoked access. Returned for both access and refresh tokens. | None. Stop claims, sends, refresh, MCP, case writes and late settlement. The owner must re-enroll. | `REVOKED` |
| `CREDENTIAL_EXPIRED` | 401 | The family's rolling inactivity expiry (`refreshExpiresAt`, 30 days by default) has passed. Returned for refresh and for that family's access tokens. Pause does not extend the expiry. | No refresh. The owner issues a reconnect for the **same** identity (§4). Do not enroll a new agent. | `NEEDS_RECONNECT` |
| `ACCESS_TOKEN_EXPIRED` | 401 | The access token expired but its family is still valid. | Refresh once with the stored refresh token, then retry the original request once. | Stay |
| `AUTHENTICATION_REQUIRED` | 401 | The bearer token is missing, malformed, or unknown to the server. The response is the same whether or not a similar token exists. | If the connector holds a refresh token, refresh once. If that fails, follow the code the refresh returns. | Stay (then per refresh result) |
| `ROTATION_ID_REQUIRED` | 400 | `POST /api/agent-token` arrives without a `rotationId` matching `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. The server checks this before looking up the token, so the response reveals nothing about the token and the token is **not** consumed. | Do not retry automatically. Tell the human to update the connector. The stored credential still works once the connector is updated. | `NEEDS_RECONNECT`, with "update your connector" guidance |
| `REFRESH_TOKEN_INVALID` | 401 | The refresh token is unknown, malformed, or no longer retained by the server. The response is the same whether or not a similar token exists. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` |
| `REFRESH_REPLAY` | 401 | A refresh token that was **already used** comes back with a **different** `rotationId` from the one that used it. The server treats this as a possible copied credential, audits it as `agent.refresh_replay_detected` and shows it to the owner. v1 does not revoke the family automatically. | Do not retry with another `rotationId`. The owner reconnects and may also revoke. | `NEEDS_RECONNECT` |
| `REFRESH_RECOVERY_EXPIRED` | 401 | An already-used refresh token comes back with the **same** `rotationId` after the 5-minute recovery window, so the server can no longer return the successor. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` |
| `CASE_CONTROLLED` | 409 | A human paused or revoked this **case**. The code is case-scoped: the agent can still work other cases. A case resume cannot override an agent pause, and `AGENT_PAUSED` wins when both apply. The body includes `caseId`. | Skip that case and do not retry the write until the case resumes. Claim never offers work from a controlled case. | Stay |
| `ACCOUNT_CHANGED` | 409 | Browser only. A mutating human request carries an `x-envoi-expected-human` header naming a different account from the session cookie. Agent credentials never receive it. | The browser reloads before doing anything else. | Not applicable (UI only) |
| `RATE_LIMITED` | 429 | The request rate limit was hit, or one principal has too many concurrent event streams. The response has a `retry-after` header (seconds) and `retryAfterSeconds` in the body. | Wait at least `retry-after`, then retry with jittered backoff. | `DEGRADED` until a request succeeds |
| `INTERNAL_SERVER_ERROR` (500), `AUTH_UNAVAILABLE` (503), any other 5xx, a non-JSON 502/503/504 from the edge, a network error or a timeout | 5xx / none | A server, edge or network failure. Never an authorization decision. | Retry with bounded exponential backoff and jitter, and keep all credentials. A refresh that fails this way keeps its pending `rotationId` and retries with the **same** ID (A1 recovery). | `DEGRADED` until a request succeeds |

`POST /api/agent-token` checks these outcomes in order and returns the first that applies:

1. `rotationId` missing or malformed → `ROTATION_ID_REQUIRED`.
2. Token unknown, malformed or not retained → `REFRESH_TOKEN_INVALID`.
3. Family or agent revoked or removed → `CREDENTIAL_REVOKED`.
4. Family expired → `CREDENTIAL_EXPIRED`.
5. Token already used:
   - with a different `rotationId` → `REFRESH_REPLAY`;
   - with the same `rotationId`, inside the recovery window → `200` with the identical successor;
   - with the same `rotationId`, after the window → `REFRESH_RECOVERY_EXPIRED`.
6. Otherwise → `200` with a new successor. The agent may be `active` **or** `paused`.

To tell the step 5 cases apart, the server keeps the hash of the `rotationId` that used the token on the used refresh-credential record. That way `REFRESH_REPLAY` and `REFRESH_RECOVERY_EXPIRED` stay distinguishable after the encrypted recovery envelope is deleted. **Current behavior:** steps 2–5 all return a generic `401`, and a paused agent's refresh is rejected.

### 3. Paused agent behavior

An agent is paused when the owner calls `POST /api/inboxes/{inboxId}/agents/{agentId}/pause`. A paused agent stays **addressable and authenticated**. It may observe and maintain its credential but may not act (`canReceive` true, `canAct` false; v3 §11).

| Operation with a valid credential of a paused agent | Result |
| --- | --- |
| `POST /api/agent-token` (refresh) | `200`, normal successor. Refresh never grants action rights. |
| `GET /api/agent/status` (new in v1) | `200` `{ "state": "paused", "agent": { "id", "address", "status": "paused" }, "inboxId" }`. Active agents get `"state": "active"`. A5 will add presence fields additively. |
| `POST /api/agent/connection-status` | `200`, as today. |
| `GET /api/inboxes/{inboxId}/events` (SSE) and `.../events/delta` | Allowed. Pausing **no longer closes** the stream (today it does). |
| Read-only `GET`s the credential could already make (inbox, cases, messages) | Allowed. |
| `POST /api/agent/work/claim` | `200` `{ "work": null, "state": "paused" }`. Never an error. |
| Any other mutating request, including settling a held lease and every MCP tool call | `409 AGENT_PAUSED`. |

Every claim response gains a `state` field: `"claimed"` when `work` is present, `"idle"` when there is nothing to do, and `"paused"` as above. The rest of the claim response does not change. `nextAvailableAt` is reserved for `a4-wake`.

**Held work.** Pause by itself never uses up a delivery or work attempt, never advances backoff and never dead-letters anything. Held work stays durable until resume, explicit human cancellation, or a separately documented retention action.

- **Inbound to a paused recipient.** The server accepts the sender's request as if the recipient were active: no `404` and no dead letter. If the case has **no** held outbound message, the message is delivered to the paused recipient's inbox (`status: "delivered"`). Only the work is held: it is not claimable until resume. **Current behavior:** sending to a paused agent returns `404 Recipient is unavailable`.
- **Outbound from a paused sender.** The paused agent's already-queued outbound items move to `status: "held"`, with `heldReason: "sender_paused"` and `heldAt`. Their attempt count and next-attempt time do not change.
- **D1 per-case barrier.** Outbox ordering is strict per case, in both directions. While a case has a held outbound message, every later outbox item in that case is accepted (`202`) and durably queued, including the active counterparty's reply. Those items get `status: "held"`, `heldReason: "case_ordering"` and `heldBehindMessageId`. They are not rejected or dead-lettered, and they are delivered in order after the barrier clears. This is the explicit exception to v3 §12, and it applies to that case only.
- **Barrier release.** The barrier clears in one of two ways. If the sender is resumed, its held messages become eligible first, then the ones queued behind them. If a human cancels the held message (`status: "cancelled"`), the case is released immediately **without** resuming the agent.
- **In-flight lease.** Pausing during a fenced claim invalidates the lease, so later settlement with that lease returns `409 AGENT_PAUSED`. The attempt count does not increase. On resume the work is offered again with a new fence and the same idempotency protection. External effects committed before the pause stay recorded and are not silently retried.
- **Oversight.** The owner can see the held count and the age of the oldest held item. A-1 specifies the UI field names; this contract does not.

### 4. Reconnect while paused

The owner can issue a reconnect token (`POST /api/inboxes/{inboxId}/agents/{agentId}/credentials/reconnect-token`) for an approved agent that is **active or paused**. Redeeming it at `POST /api/agent-enroll` issues a new credential family for the **same** identity, keeping its address, cases and history. The response is today's reconnect response with `agent.status: "paused"`, and the agent stays paused. Claims and actions reopen only after a separate human resume. **Current behavior:** issuing and redeeming both require `active`.

This enables the long-pause path:

1. The agent is offline for more than 30 days while paused, so refresh returns `CREDENTIAL_EXPIRED` and the connector moves to `NEEDS_RECONNECT`.
2. The owner reconnects, and the connector is `PAUSED` with fresh credentials.
3. The owner resumes, and the connector is `RUNNING`.

### 5. Events

Events use the existing stream format. The SSE `id` is the event cursor, the SSE `event` is the type, and `data` is the JSON event `{ id, type, createdAt, sequence, cursor, ... }`. Clients ignore unknown fields and unknown event types.

| Event | When | Fields beyond the common ones |
| --- | --- | --- |
| `agent.paused` | The owner pauses the agent. The stream stays open afterwards. | `agentId`, `status: "paused"` (`humanId` may be present) |
| `agent.resumed` | The owner resumes the agent. | `agentId`, `status: "active"` (`humanId` may be present) |
| `work.available` | Immediately after `agent.resumed` when the agent has held work, so the connector does not wait for a poll. | `agentId`, `reason: "agent_resumed"` |

On `agent.resumed`, the connector leaves `PAUSED` and claims once immediately, whether or not `work.available` follows. `a4-wake` will add more `work.available` reasons, so v1 consumers must accept any `reason` string.

### 6. Fixtures

Each fixture file has these fields:

- `contract`, `version` and `id` (the file name without `.json`);
- `description`;
- `kind`: `http`, `sse` or `network`;
- the request and response, or the event, or the network failure;
- a `client` block with:
  - the expected `lifecycle`: one of the v3 §19 states, or `UNCHANGED` ("Stay" in §2), or `NOT_APPLICABLE` (browser-only codes);
  - the `retry` policy: `none`, `refresh_then_retry_once`, `after_retry_after`, `backoff`, `after_resume` or `after_case_resume`;
  - optional `guidance` for the human: `update_connector`, `owner_reconnect`, `owner_reenroll`, `reload_browser` or `wait_for_resume`;
  - the `next` operation.

Every HTTP response body and SSE event names a definition in `schemas.json` (draft-07; `fixture` describes the file itself). `test/contract-fixtures.test.js` validates every fixture against its schema, checks that `error` equals `code`, and checks that token values are placeholders.

| Group | Fixtures |
| --- | --- |
| Codes | `agent-paused-send`, `agent-paused-settlement`, `credential-revoked-claim`, `credential-revoked-refresh`, `credential-expired-refresh`, `credential-expired-claim`, `access-token-expired`, `authentication-required`, `rotation-id-required`, `refresh-token-invalid`, `refresh-replay`, `refresh-recovery-expired`, `refresh-recovered`, `case-controlled`, `account-changed`, `rate-limited`, `server-error`, `edge-unavailable`, `network-failure-refresh` |
| Paused behavior | `paused-claim`, `idle-claim`, `claimed-work`, `paused-refresh`, `paused-status`, `paused-recipient-accepted`, `case-ordering-held`, `reconnect-while-paused` |
| Events | `event-agent-paused`, `event-agent-resumed`, `event-work-available` |

### 7. Compatibility and migration

- For clients that branch on `code`, the change is additive: `code`, `state`, the `held` statuses and the new events are all new fields or values.
- After A-1, existing connectors will see four behavior changes, each less disruptive for an old connector than what happens today:
  - a paused agent's claim returns `200` with `state: "paused"` instead of `401`/`403`;
  - its refresh succeeds instead of returning `401`;
  - pausing no longer closes SSE;
  - a send to a paused agent is accepted instead of returning `404`.
- No database migration is needed. `held` and `cancelled` are new values in the existing text status column, and held work keeps its attempt counters.
- Rollback: reverting A-1 restores today's behavior. Messages left in `held` would have to be moved back to `queued` by the rollback procedure written with A-1.
