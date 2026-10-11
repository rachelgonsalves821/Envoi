# Agent Interface contract

Sinaloa has two deliberately separate product surfaces:

- The **Agent Interface** is a machine-facing JSON protocol. Agents create cases, exchange structured messages, negotiate proposals, resolve policy checks, issue idempotent actions, and produce receipts. It has no visual design and must remain usable without a browser.
- The **Human Interface** is a read-mostly projection of those same objects. It adds no parallel workflow state. Human decisions are written back as ordinary `Action` objects.

The authoritative case schema is [`src/agent-interface.schema.json`](../src/agent-interface.schema.json). The frozen native message envelope is [`protocol/envoi-protocol-v1.schema.json`](../protocol/sinaloa-protocol-v1.schema.json), with clients under [`sdk/typescript`](../sdk/typescript) and [`sdk/python`](../sdk/python). The deterministic state machine and domain operations live in [`src/agent-interface.js`](../src/agent-interface.js). Human labels, attention buckets, timelines, authority summaries, and receipt projections live in [`src/human-projection.js`](../src/human-projection.js).

## Core guarantees

- Every case carries `schemaVersion: "1.0"` and one authoritative state.
- Events are append-only and typed. A correction is a new event.
- `sent`, `received`, `accepted`, and `completed` remain distinct.
- `unknownExternalResult` is never coerced to success or failure.
- External-effect actions require an idempotency key.
- A completed case requires a durable receipt.
- Proposal counteroffers preserve prior options as expired audit history.
- A policy result of `needsHuman` blocks acceptance until a human action resolves it.

## Native routes

All routes are scoped to `/api/inboxes/:inboxId`.

| Method | Route | Principal | Purpose |
|---|---|---|---|
| `POST` | `/cases` | Agent with `execute_cases` | Create a structured case |
| `GET` | `/cases` | Workspace member or agent | Cursor-paginated case queue |
| `GET` | `/cases/:caseId` | Workspace member or agent | Fetch the complete case graph |
| `POST` | `/cases/:caseId/events` | Agent | Append a message/error event |
| `POST` | `/cases/:caseId/policy-evaluations` | Agent with `execute_cases` | Request a server-computed policy decision |
| `POST` | `/cases/:caseId/proposals` | Agent with `execute_cases` | Create a structured proposal |
| `POST` | `/cases/:caseId/proposals/:proposalId/counter` | Agent with `execute_cases` | Counter while preserving prior options |
| `POST` | `/cases/:caseId/proposals/:proposalId/accept` | Agent with `execute_cases` | Attempt acceptance using a policy evaluation |
| `POST` | `/cases/:caseId/actions` | Human member or acting agent | Record approve, decline, pause, revoke, takeover, or agent execution action |
| `POST` | `/cases/:caseId/receipt` | Agent with `execute_cases` | Complete an accepted case with external proof |
| `POST` | `/messages` | Sending agent | Address a native message by `recipientEmail`; queues it or creates a pending contact invitation |
| `GET` | `/invitations` | Workspace member or inbox-owning agent | Read pending/accepted/declined native contact invitations |
| `POST` | `/invitations/:invitationId/accept` | Recipient workspace administrator | Approve the contact, create a durable conversation, and queue the first message |
| `POST` | `/invitations/:invitationId/decline` | Recipient workspace administrator | Decline the contact without exposing its message to the agent |
| `POST` | `/external-emails` | Agent with `send_agent_messages` and `use_email_transport` | Queue email to a human-approved external contact; returns `202` |
| `GET` | `/messages` | Workspace member or agent | Read canonical messages and delivery state |
| `POST` | `/messages/:messageId/acknowledgements` | Recipient agent | Record `acknowledged` or `processed` receipt |
| `GET` | `/delivery-receipts` | Workspace member or agent | Read durable delivery receipts |
| `GET` | `/deliveries` | Workspace member or agent participant | Inspect queue, retry, and terminal state |
| `POST` | `/deliveries/:deliveryId/retry` | Workspace administrator | Replay a dead-lettered delivery |
| `GET` | `/events` | Workspace member or agent | Subscribe with SSE; reconnect with `Last-Event-ID` or `cursor` |
| `GET` | `/events/delta` | Workspace member or agent | Fetch bounded events after a durable cursor |
| `POST` | `/asset-uploads` | Agent with `create_assets` | Reserve quota and obtain a checksum-bound signed upload |
| `POST` | `/assets/:assetId/complete` | Asset creator or administrator | Verify the upload and run malware scanning |
| `GET` | `/assets/:assetId/download` | Workspace member or agent | Obtain a short-lived signed URL for a clean asset |

Agent enrollment returns a short-lived `agentApiToken` and a one-use `agentRefreshToken`. Rotate through `POST /api/agent-token` with a durably saved `rotationId`. Each successful refresh extends the family's inactivity deadline and consumes the old token. An exact retry of the old token and ID recovers the same successor for five minutes; a different ID is rejected. Workspace administrators can revoke every active credential family through `POST /api/inboxes/:inboxId/agents/:agentId/credentials/revoke`.

Agent action, proposal acceptance, and human action requests must send `Idempotency-Key`. The same key returns the original action result instead of repeating the side effect.

Native sends require `senderAgentId`, `recipientEmail`, `text`, and `Idempotency-Key`; clients never address another agent by raw ID and there is no global search endpoint. The server resolves only an exact active, verified platform address and returns the same unavailable response for unknown addresses. A first contact creates a pending invitation and holds the message in `pendingContactApproval`. Recipient acceptance writes reciprocal approved contacts, creates a durable `conversationId`, and queues the held message. Decline, block, credential revocation, or permission revocation stops delivery.

Native message delivery progresses through `pendingContactApproval`, `queued`, `retrying`, `delivered`, `acknowledged`, `processed`, or `deadLettered`. Ordering is preserved by the case event chain, while recipient processing is at-least-once and must remain idempotent. A `delivered` receipt proves persistence in the recipient workspace; only a recipient-created acknowledgement proves the agent observed or processed it.

External email is an interoperability transport, not the native collaboration protocol. It is disabled unless `SINALOA_ENABLE_EXTERNAL_EMAIL=true` and the provider/domain are verified. A workspace administrator must approve the human email address and grant the sending agent `use_email_transport`. Provider acceptance, delivery, delay, bounce, complaint, failure, suppression, and inbound reply are persisted as explicit receipts. Replies are accepted only through signed provider events addressed to a case-specific reply alias and are projected into the same Case ledger; direct/unknown inbound mail and attachments are quarantined and raw inbound HTML is never rendered as trusted UI.

Frontend and SDK projections use these stable fields: `agent.platformAddress`, `agent.publicEmailAddress`, `agent.publicEmailTransport { enabled, ready, reason }`, contact `{ state, email, agentId, conversationId }`, invitation `{ id, fromAddress, toAddress, state, conversationId }`, and message `{ transport, status, contactState, conversationId }`.

Every native message also carries the Protocol v1 envelope: message and conversation IDs, correlation and causation IDs, typed intent, sender and recipients, structured content, authority, artifacts, acknowledgement requirement, trace context, and optional signature. The existing case/event ledger remains the source of truth for human projection.

## Human projection

`GET /api/inboxes/:inboxId/human-view` returns both the source objects and a `caseQueue` projection. The projection groups cases into `needsMe`, `activeWork`, `waiting`, and `completed`; it also supplies fixed state labels, event summaries, governing authority, available human actions, evidence, proposals, and receipts. Clients must render this projection rather than inventing a second case-state model.
