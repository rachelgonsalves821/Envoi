# TypeScript outbound connector

`src/connector.ts` is an outbound SSE wake and fenced-work connector. It is exported through the package's `./connector` subpath so the core client remains independent of the connector runtime.

```ts
import { enrollConnector, SinaloaConnector } from '@sinaloa/protocol/connector';

// Implement load/save with an OS keychain or managed secret store. Each save
// must atomically replace the full session, especially the rotating refresh token.
const store = myDurableSecretStore;
await enrollConnector('https://api.example', oneUseCode, store, { name: 'My agent' });

const stop = new AbortController();
await new SinaloaConnector('https://api.example', store, {
  handler: {
    // This must commit the message by ID to durable local storage before resolving.
    admit: message => myAgentQueue.putIfAbsent(message.id, message),
    // Processing can run again after a crash or lease expiry. Deduplicate by message.id.
    process: async (message, context) => {
      const reply = await myAgentRuntime.handle(message, { signal: context.signal });
      if (reply) await context.reply(reply, `reply:${message.id}:1`);
    }
  },
  onEvent(event) {
    // Observation only. Work is claimed separately from this event cursor.
    if (event.type === 'message.delivered') console.log('New inbox event', event.id);
  }
}).run(stop.signal);
```

The connector validates HTTPS (allowing local HTTP for development), enrolls once, and refreshes through the durable credential store. Its run loop watches `/api/inboxes/:id/events` without cookies. Stored events advance an inbox-specific cursor after observation finishes; duplicates are dropped. A fresh or invalid cursor connects with `from=latest` and stores the ready baseline. Delta is read only after `replay_required`, from the last processed cursor. Claims are single flight; a burst schedules at most one pending follow-up. Startup, ready, recovery, own work/resume and inbound delivery/instruction events wake the queue. Own-send deliveries do not. Finished work drains to idle. Safety claims run every 30–60 seconds with a healthy stream and every 12–18 seconds while disconnected or degraded; relative idle hints can wake earlier, with a one-second minimum. A paused connector reads agent status after reconnect/ready and every 30–60 seconds. Reconnect uses full jitter from one to thirty seconds, honors Retry-After, and resets only after sixty seconds of uptime. Sixty seconds without stream bytes closes the connection. The deprecated pollIntervalMs option no longer controls wake timers. Stable contract codes control credential refresh and terminal states; an unknown HTTP status does not imply revocation. Before refresh, it atomically saves `pendingRotation` containing a stable `rotationId` and refresh-token fingerprint. After saving the successor, it clears that pending state. If the response is lost or the process restarts, it retries with the same ID and the server returns the same successor during a five-minute recovery window. A failed save after receipt stops the connector while preserving the pending state; restart may recover it within that window. After the window, owner reconnect is required.

If the stored refresh credential has expired, the connector stops before making a doomed refresh request. Stable revocation or reconnect-required codes also stop the run loop; it does not silently re-enroll. A case-start caller must persist a new `caseId` from `newCaseId()` and a stable idempotency key before first send, then reuse both on retry. Two cases between the same pair need different IDs. The connector keeps its work lease renewed through the final processing request and refuses to send a new reply once shutdown or lease loss is observed. A reply already in flight can still complete across a network failure, so the handler must keep its logical reply key stable across retries.

**`onEvent` is an observation callback, not the work-processing handler.** With `handler` supplied, `run` claims canonical work independently of the event cursor. It renews the fence during admission/processing, writes a fenced `acknowledged` receipt after `admit`, writes a fenced `processed` receipt after `process`, and reports handler failure with a safe reason code. Stable per-attempt idempotency keys protect receipt retries. The handler must make its own admission and external effects idempotent by message ID; `context.reply` requires a stable key for each logical reply. Safety claims also work after downtime: queued messages remain server-side until claimable. There is no installation heartbeat or server-derived connected/last-seen status to display yet. Consequential external actions require separately verified policy and human authority; these transport receipts do not authorize them.

## Fenced work API contract

1. `POST /api/agent/work/claim` with `{}` returns `{work:null}` or `{work:{workId,message,leaseToken,leaseExpiresAt}}`. `message` is the full canonical recipient-inbox message. A processed message is never claimable; an expired lease may be reclaimed with a new fence.
2. `POST /api/agent/work/:workId/renew` with `{leaseToken}` returns `{workId,leaseToken,leaseExpiresAt}` and rejects a stale or revoked holder.
3. `POST /api/agent/work/:workId/acknowledge` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'acknowledged',receipt}` after durable handler admission. An existing acknowledged receipt remains valid when a new fence reclaims unfinished work.
4. `POST /api/agent/work/:workId/complete` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'processed',receipt}`. The server verifies the live fence, creates the server-derived receipt once, and does not let a stale holder settle it.
5. `POST /api/agent/work/:workId/fail` with `{leaseToken,retryable,reasonCode?}` returns `{workId,status:'retryable'|'failed'}`. The connector never sends the raw handler error. Revocation or pause prevents new claims and late settlement.

The v1 server scopes claims to a credential family because it has no installation resource yet. Installation identity, heartbeat/last-seen, and truthful connected/offline status require separate server resources. Event callbacks and SSE connections are never proof of processing; only the server's canonical receipts are.

## Setup status for OpenClaw and Grok

This is a TypeScript outbound connector library, not a deployed MCP server or an OpenClaw plugin. An OpenClaw Gateway/channel can run it as a background bridge, and a Grok-backed application using the xAI API can invoke its handler. Neither integration has a tested hosted setup recipe yet; consumer Grok chat has no implied connector support. The partner-owned remote MCP endpoint and tool schemas are still required for both supported beta paths. MCP tool discovery alone cannot wake an unattended agent: run this connector continuously, durably admit work, and acknowledge/complete via its fenced claim API.

One-use enrollment returns rotating agent access and refresh tokens. Store the entire `ConnectorSession` atomically in a secret store outside prompts and logs. The connector refreshes expiring access tokens and retries a stable access-expiry/authentication code once. Revocation rejects subsequent calls and stops the run loop. The library's case and asset helpers use the same refresh path. OpenClaw/xAI application adapters still need to wire these helpers to their tool calls, ensure the bridge stays running, and prove the two-owner/two-case/asset fixture against the hosted service. Do not put a short-lived agent access token directly in a static MCP configuration; the server and adapters need a renewal bridge or interoperable OAuth flow before that setup is beta-ready.
