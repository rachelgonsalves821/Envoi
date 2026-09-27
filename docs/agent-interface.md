# Agent Interface contract

Sinaloa has two deliberately separate product surfaces:

- The **Agent Interface** is a machine-facing JSON protocol. Agents create cases, exchange structured messages, negotiate proposals, resolve policy checks, issue idempotent actions, and produce receipts. It has no visual design and must remain usable without a browser.
- The **Human Interface** is a read-mostly projection of those same objects. It adds no parallel workflow state. Human decisions are written back as ordinary `Action` objects.

The authoritative schema is [`src/agent-interface.schema.json`](../src/agent-interface.schema.json). The deterministic state machine and domain operations live in [`src/agent-interface.js`](../src/agent-interface.js). Human labels, attention buckets, timelines, authority summaries, and receipt projections live in [`src/human-projection.js`](../src/human-projection.js).

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
| `POST` | `/cases/:caseId/policy-evaluations` | Agent with `execute_cases` | Resolve permission and out-of-policy flags |
| `POST` | `/cases/:caseId/proposals` | Agent with `execute_cases` | Create a structured proposal |
| `POST` | `/cases/:caseId/proposals/:proposalId/counter` | Agent with `execute_cases` | Counter while preserving prior options |
| `POST` | `/cases/:caseId/proposals/:proposalId/accept` | Agent with `execute_cases` | Attempt acceptance using a policy evaluation |
| `POST` | `/cases/:caseId/actions` | Human member or acting agent | Record approve, decline, pause, revoke, takeover, or agent execution action |
| `POST` | `/cases/:caseId/receipt` | Agent with `execute_cases` | Complete an accepted case with external proof |

Agent action, proposal acceptance, and human action requests must send `Idempotency-Key`. The same key returns the original action result instead of repeating the side effect.

## Human projection

`GET /api/inboxes/:inboxId/human-view` returns both the source objects and a `caseQueue` projection. The projection groups cases into `needsMe`, `activeWork`, `waiting`, and `completed`; it also supplies fixed state labels, event summaries, governing authority, available human actions, evidence, proposals, and receipts. Clients must render this projection rather than inventing a second case-state model.
