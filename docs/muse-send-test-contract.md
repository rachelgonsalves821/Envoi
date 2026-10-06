# Muse-to-Hermes staging send: connector contract

This is a bounded interoperability experiment. It is **not** general Muse send access, unattended reply support, or a production connector. The owner chooses one active Hermes agent address in the same staging database and authorizes one send. Meta must classify and approve the connector action under its own rules; Envoi does not treat account connection as approval to send.

## Owner preparation

After Muse has its own Envoi identity, an authenticated workspace owner calls:

```http
POST /api/inboxes/{museInboxId}/agents/{museAgentId}/muse-send-test-grants
Content-Type: application/json

{"recipientAddress":"<exact active Hermes staging address>"}
```

The ordinary human session and CSRF checks apply. The server validates that the sender belongs to that workspace and that the recipient is an active Hermes agent in the same staging environment. It returns a five-minute `envoi_muse_send_test_*` bearer credential bound to the Muse agent and that exact recipient. Capture it only in Muse's private connector credential field. Never place it in Muse chat, a URL, documentation, logs, or Git. The grant does not upgrade the earlier read-only `agent_probe` credential.

The read probe and send test use different short-lived credentials. If Muse's custom-connector UI supports only one stored credential per connector, configure them as separate test connectors or replace the credential for this controlled send; do not claim a combined durable connection. Complete connector setup before issuing the five-minute grant so most of its lifetime remains for the actual call.

## Muse action: send one native message

Declare this action as a **sensitive write** for Meta review. It sends content to another agent and can have external consequences. [Meta's connector guidelines](https://muse.ai/platform/docs) require a fresh user approval for every sensitive write; do not configure or describe it as an unattended read, and record the actual approval Muse shows.

```http
POST /api/inboxes/{museInboxId}/messages
Authorization: Bearer <private five-minute send-test credential>
Content-Type: application/json

{"senderAgentId":"<bound Muse agent ID>","recipientEmail":"<approved Hermes address>","text":"<message, at most 2000 characters>"}
```

The connector must send only those three JSON properties. The server derives the idempotency key and reuses Envoi's canonical native-message path: its address lookup, send/receive permission, contact block, case creation, delivery worker, and message history. The caller cannot supply a different recipient, case ID, file, payload, authority claim, or work-claim operation. A successful first call returns the canonical message with its `id`, `caseId`, `status`, and timestamps (`202` when queued). The sender should report only that confirmed server result; `202 queued` is not proof Hermes has processed or replied.

If the HTTP result is uncertain, retry **the same request and credential**. An exact retry must resolve to the same canonical message (`200` replay or the original pending status), with no duplicate case or message. Changing the text or recipient with the same credential must fail without sending a second message. An expired, revoked, or already used credential cannot authorize a new message. A `401` means no active credential; `403` means the grant or policy denies the action; `404` means the recipient is unavailable; `409` means a conflicting reuse. Surface the failure instead of claiming delivery.

## Acceptance evidence

1. Record the exact staging release SHA and confirm both agent identities and the Hermes recipient resolve in **the same** staging database.
2. From Muse's Custom Connector, obtain a real tool-call trace for its `POST`, including HTTP status and returned `id`/`caseId`, without recording credentials or private message text. A model statement alone is insufficient.
3. Check Envoi's canonical sender and recipient histories for the same message ID and case ID. An Envoi `202` with no recipient record yet is only queued.
4. Retry the identical action once and confirm a single canonical message. Try a changed payload and a different recipient in a controlled fixture and confirm denial. Revoke the grant and confirm it cannot send again.
5. Record whether Muse required fresh approval. Do not claim unattended Muse-to-Muse messaging from a manually approved send test.

Do not grant general `send_agent_messages` or a rotating refresh credential to Muse to make this test pass. Durable authenticated inbound work and wake behavior remain separate gates.
