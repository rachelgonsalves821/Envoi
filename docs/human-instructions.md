# Human instructions and own-case agent replies

The dedicated instruction API, durable queue, fenced work lifecycle and authenticated local reply API are implemented in `src/server.js` and `src/human-instructions.js`. Native messaging validation remains on its existing branch. No external execution is authorized by instruction text, delivery receipts or replies.

## Composer API

`POST /api/inboxes/:inboxId/cases/:caseId/instructions`

- Authenticate with the current human session and the server's normal CSRF and expected-human account guards.
- Supply `Idempotency-Key` and JSON `{ "text": "Please ask about Tuesday." }`. Optional `recipientAgentId` must equal the current inbox owner agent. All other request fields reject.
- The human must currently manage the inbox. The server rechecks the same human identity and manager membership inside `withCaseMutation`, including current provider membership in production.
- The owner agent must be active, approved, nonrevoked, correctly registered to this inbox and have `receive_agent_messages`. Send permission is not needed to receive instructions.
- The case must already exist locally as a structured case, contain the owner agent and remain active. Paused, revoked and terminal cases reject. Shared bindings, agent directory ownership and canonical participants must agree.

This is an enabled dedicated manager feature in production. It uses the existing authenticated manager authority and own-case constraints; it is independent of the legacy `/human-messages` API. That legacy API's production disable remains intact. No environment override or fake native sender is used.

Text is trimmed, nonblank and bounded to 60000 UTF-8 bytes, with control characters forbidden except tabs/newlines. Reuse the same key for retries of one submission. The key is scoped to inbox and authenticated human and binds the normalized text, case and recipient. Creation returns **201**, an identical retry **200**, and changed semantics **409**.

Both responses return the instruction message directly:

```json
{
  "id": "msg_instruction_<digest>",
  "kind": "humanInstruction",
  "inboxId": "inbox_own",
  "caseId": "case_existing",
  "senderType": "human",
  "senderHumanId": "human_current",
  "from": { "humanId": "human_current" },
  "recipientInboxId": "inbox_own",
  "recipientAgentId": "agent_own",
  "type": "instruction",
  "text": "Please ask about Tuesday.",
  "status": "delivered",
  "createdAt": "<ISO timestamp>",
  "deliveredAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

There is no `senderAgentId`, `senderInboxId` or native `from.address`. `delivered` means admitted to the local durable work queue, not consumed or externally executed.

## Connector work contract

`POST /api/agent/work/claim` retains its existing agent bearer authentication and response envelope: `{ work: { workId: message.id, message, leaseToken, leaseExpiresAt } }`. Empty queues still return `{ work: null }`.

Human work requires explicit per-claim negotiation: send JSON `{ "acceptHumanInstructions": true }`. An omitted flag, `false`, `{}` or an empty POST body continues claiming native work only. A provided flag must be boolean; malformed flags return 400. Human candidates are excluded before participant lookups and mutation locks unless the flag is true, so legacy connectors neither claim them nor consume their retries. Instructions remain durably queued until an updated connector opts in.

Existing installed connectors must refresh to the latest connector bundle and restart to support human instruction consumption and replies. Updating the server alone does not update installed connectors. The updated SDK/connector must send `acceptHumanInstructions: true` only when it implements the truthful human message shape and dedicated fenced reply path below.

Connectors must distinguish `kind: humanInstruction` from native messages and accept its truthful human `from` object without requiring a native sender address. Route replies to the dedicated API below. Keep message-based admission deduplication, stable reply keys, renewals, fenced acknowledgement/completion and safe retry behavior. Instruction text supplies guidance; it is not a policy approval or execution authority.

The claim route includes human instructions in the existing durable inbox message queue, preserving timestamp ordering, exclusive leases, credential-family fencing, token hashing, attempt limits and retry backoff. Native messages retain sender permission and agent-contact checks. Human instructions instead validate the durable human case event, current owner agent, case controls and participant ownership. Before claim or any settlement/reply, the server also rereads both the instruction sender and inbox owner human and requires their **current manager memberships**, including an uncached WorkOS membership lookup. Removed/demoted human membership denies processing even if it was valid at admission. An expired browser session does not cancel already-admitted durable work; current human membership and current agent credentials remain required.

Own inbox and case locks, plus shared participant inbox locks, cover human claim and settlement writes. The existing `renew`, `acknowledge`, `complete` and `fail` REST paths and outer settlement shapes are unchanged. Human delivery receipts have `senderType: human` and `senderHumanId`, with no fabricated `senderAgentId`. Failure and max-attempt exhaustion persist truthful own-inbox receipts. The legacy `/api/inboxes/:inboxId/messages/:messageId/acknowledgements` path returns **410** for instruction work, including a recheck inside its mutation; human work cannot settle without a lease.

## Dedicated reply API

`POST /api/agent/instructions/:messageId/reply`

Authenticate with the active owner agent's bearer token. Supply `Idempotency-Key` and JSON:

```json
{ "text": "I will ask about Tuesday.", "leaseToken": "<claimed opaque fence>" }
```

Both **receive and send permissions** are required. Only `text` and `leaseToken` are accepted. The instruction must be bound to the current own inbox/agent and its existing case. The lease must belong to the current credential family and match the current fence. A new reply requires a live claimed/acknowledged lease, so reply before completing work. Replying does not itself acknowledge, complete or execute the instruction.

Creation returns **201** and a direct durable reply message:

```json
{
  "id": "msg_instruction_reply_<digest>",
  "kind": "humanInstructionReply",
  "inboxId": "inbox_own",
  "caseId": "case_existing",
  "senderType": "agent",
  "senderAgentId": "agent_own",
  "senderInboxId": "inbox_own",
  "recipientInboxId": "inbox_own",
  "recipientHumanId": "human_instruction_sender",
  "from": { "agentId": "agent_own", "address": "<real own agent address>" },
  "inReplyTo": "<instruction ID>",
  "type": "message",
  "text": "I will ask about Tuesday.",
  "status": "delivered",
  "createdAt": "<ISO timestamp>",
  "deliveredAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

The reply has no recipient agent, so it is not enqueued back to the same agent or sent to the peer. It is visible in the own human view. Its case event converges across already-visible shared-case projections, while the reply message remains local. Idempotent replay returns **200** after checking the durable reply. The key binds instruction ID and normalized text rather than the lease token, allowing a current reclaimed lease to reuse a previously persisted logical reply. Stale fences still reject. An existing reply may replay under its matching completed fence; a new reply after completion rejects.

The SDK and shared runtime bridges call this endpoint through `context.reply` for human work, supplying the claimed lease token and an existing stable logical reply key, such as `bridge:${message.id}:reply:1`. Native work continues using the native reply path. No native human address is invented.

## Durability and audit

The instruction transaction writes the own inbox message, human case event, idempotency response and `human.instruction_created` audit event. Reply transactions write the own message, agent case event, idempotency response and `agent.instruction_replied` audit event. Audit publication follows transaction commit. Shared canonical cases and already-visible projections converge; deleted history is not recreated. Message delivery events preserve case state, proposals, policy evaluations and authority refs. No delivery outbox item is required for local human work and no external transport is invoked.

## Expected errors

| Status | Preconditions or error |
| --- | --- |
| 400 | Missing/invalid idempotency key, blank/oversized/control-character text, invalid IDs, missing lease token, extra request fields |
| 401 | No authenticated human for instruction creation; inactive, expired or revoked agent credentials for work/replies |
| 403 | Human lacks current manager access; owner/participant mismatch; missing receive/send permission; human authority removed since admission; CSRF rejection |
| 404 | Missing existing case or instruction work not assigned to this agent; reply attempted on native work |
| 409 | Paused/revoked/terminal case, removed history, changed idempotency semantics, stale/expired/consumed lease, changed binding during locking, inconsistent durable records; expected-human account mismatch |
| 410 | Attempt to acknowledge/process instruction work through the unfenced legacy acknowledgement API |

Claim skips ineligible human work rather than preventing unrelated eligible messages from being claimed; storage/provider failures still propagate. All operations fail closed on current authority, ownership and case controls.

## Verification

`node --test test/human-instructions.test.js test/human-instructions-integration.test.js`

Unit tests cover atomic records, concurrent duplicates, malformed/spoofed requests, cross-owner records, current agent/case controls, durable work validation, shared-case convergence and rollback. Real-server tests create a native shared case, submit human instructions through HTTP, claim them, reply, renew, acknowledge and complete them, restart the server, verify own human-view visibility, and exercise legacy fences, session guards, human membership removal, permission loss, credential revocation, retries and terminal failures. No external integration is executed by these tests.
