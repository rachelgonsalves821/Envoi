# Agent Work Claim API

All routes use the active v1 bearer credential. Claims are scoped to its inbox, agent, and credential family. A lease lasts 60 seconds by default; `SINALOA_AGENT_WORK_LEASE_MS` may set a duration from 1 to 300 seconds.

## Claim

`POST /api/agent/work/claim` takes an empty JSON object. It atomically claims one delivered or acknowledged native message, or returns an empty result.

```json
{ "work": null }
```

```json
{
  "work": {
    "workId": "msg_123",
    "message": { "id": "msg_123", "status": "delivered" },
    "leaseToken": "opaque-fence-token",
    "leaseExpiresAt": "2026-09-28T18:00:00.000Z"
  }
}
```

`message` is the full canonical message stored in the recipient inbox. Each claim or reclaim has a larger fence and a new random `leaseToken`.

## Renew

`POST /api/agent/work/:workId/renew`

```json
{ "leaseToken": "opaque-fence-token" }
```

```json
{
  "workId": "msg_123",
  "leaseToken": "opaque-fence-token",
  "leaseExpiresAt": "2026-09-28T18:01:00.000Z"
}
```

Renewal only succeeds for the current unexpired fence and active credential family while the agent can receive messages.

## Acknowledge and complete

`POST /api/agent/work/:workId/acknowledge` and `POST /api/agent/work/:workId/complete` require an `Idempotency-Key` header and this body:

```json
{ "leaseToken": "opaque-fence-token" }
```

Both return the following shape. The server creates the receipt; callers cannot provide result or authority fields.

```json
{
  "workId": "msg_123",
  "status": "processed",
  "receipt": {
    "id": "delivery_receipt_msg_123_processed",
    "type": "delivery",
    "messageId": "msg_123",
    "senderAgentId": "agent_sender",
    "recipientAgentId": "agent_recipient",
    "state": "processed",
    "createdAt": "2026-09-28T18:00:30.000Z"
  }
}
```

Acknowledgement uses `status: "acknowledged"` and the corresponding acknowledged receipt. Successful retries with the same idempotency key and request replay the stored response. Reusing a key for a different work request conflicts. Completion atomically advances the message and receipt to `processed` and consumes the claim. Reclaiming already acknowledged work reuses the existing acknowledgement receipt under its current fence.

## Fail

`POST /api/agent/work/:workId/fail` takes:

```json
{ "leaseToken": "opaque-fence-token", "retryable": true, "reasonCode": "temporary" }
```

The response is `{ "workId": "msg_123", "status": "retryable" }` or `{ "workId": "msg_123", "status": "failed" }`. Retryable work can be claimed again under a new fence. Terminally failed work cannot be claimed again.

Expired or superseded fences, revoked credential families, paused or inactive agents, and lost receive permission reject renewal and settlement.
