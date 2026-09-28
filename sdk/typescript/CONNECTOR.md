# TypeScript outbound connector

`src/connector.ts` is an outbound polling and fenced-work connector. It is exported through the package's `./connector` subpath so the core client remains independent of the connector runtime.

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

The connector validates HTTPS (allowing local HTTP for development), redeems `/api/agent-enroll`, stores the returned agent ID, dedicated inbox ID, address and credentials, refreshes via `/api/agent-token`, and reads `/api/inboxes/:id/events/delta`. It commits each event cursor only after `onEvent` resolves. A callback or cursor-save failure causes at-least-once replay. Expired access tokens rotate proactively; a 401 on delta or a work request triggers one forced rotation and retry. `run` polls with bounded exponential backoff and jitter, and stops on abort or an authentication/persistence failure. It does not log credentials. A failed save after token rotation is fatal because retrying the consumed refresh token could trigger replay protection. A crash between the server's rotation response and local durable save still requires re-enrollment: the current rotation API offers no recovery transaction.

If the stored refresh credential has expired, the connector stops before making a doomed refresh request. Revocation (403 or a failed token refresh) also stops the run loop; it does not silently re-enroll. A case-start caller must persist a new `caseId` from `newCaseId()` and a stable idempotency key before first send, then reuse both on retry. Two cases between the same pair need different IDs. The connector keeps its work lease renewed through the final processing request and refuses to send a new reply once shutdown or lease loss is observed. A reply already in flight can still complete across a network failure, so the handler must keep its logical reply key stable across retries.

**`onEvent` is an observation callback, not the work-processing handler.** With `handler` supplied, `run` claims canonical work independently of the event cursor. It renews the fence during admission/processing, writes a fenced `acknowledged` receipt after `admit`, writes a fenced `processed` receipt after `process`, and reports handler failure with a safe reason code. Stable per-attempt idempotency keys protect receipt retries. The handler must make its own admission and external effects idempotent by message ID; `context.reply` requires a stable key for each logical reply. Polling also works after downtime: queued messages remain server-side until claimable. There is no installation heartbeat or server-derived connected/last-seen status to display yet. Consequential external actions require separately verified policy and human authority; these transport receipts do not authorize them.

## Fenced work API contract

1. `POST /api/agent/work/claim` with `{}` returns `{work:null}` or `{work:{workId,message,leaseToken,leaseExpiresAt}}`. `message` is the full canonical recipient-inbox message. A processed message is never claimable; an expired lease may be reclaimed with a new fence.
2. `POST /api/agent/work/:workId/renew` with `{leaseToken}` returns `{workId,leaseToken,leaseExpiresAt}` and rejects a stale or revoked holder.
3. `POST /api/agent/work/:workId/acknowledge` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'acknowledged',receipt}` after durable handler admission. An existing acknowledged receipt remains valid when a new fence reclaims unfinished work.
4. `POST /api/agent/work/:workId/complete` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'processed',receipt}`. The server verifies the live fence, creates the server-derived receipt once, and does not let a stale holder settle it.
5. `POST /api/agent/work/:workId/fail` with `{leaseToken,retryable,reasonCode?}` returns `{workId,status:'retryable'|'failed'}`. The connector never sends the raw handler error. Revocation or pause prevents new claims and late settlement.

The v1 server scopes claims to a credential family because it has no installation resource yet. Installation identity, heartbeat/last-seen, and truthful connected/offline status require separate server resources. Event callbacks and SSE connections are never proof of processing; only the server's canonical receipts are.

## Setup status for OpenClaw and Grok

This is a TypeScript outbound connector library, not a deployed MCP server or an OpenClaw plugin. An OpenClaw Gateway/channel can run it as a background bridge, and a Grok-backed application using the xAI API can invoke its handler. Neither integration has a tested hosted setup recipe yet; consumer Grok chat has no implied connector support. The partner-owned remote MCP endpoint and tool schemas are still required for both supported beta paths. MCP tool discovery alone cannot wake an unattended agent: run this connector continuously, durably admit work, and acknowledge/complete via its fenced claim API.

One-use enrollment returns rotating agent access and refresh tokens. Store the entire `ConnectorSession` atomically in a secret store outside prompts and logs. The connector refreshes expiring access tokens and retries a 401 once. Revocation rejects subsequent calls and stops the run loop. The library's case and asset helpers use the same refresh path. OpenClaw/xAI application adapters still need to wire these helpers to their tool calls, ensure the bridge stays running, and prove the two-owner/two-case/asset fixture against the hosted service. Do not put a short-lived agent access token directly in a static MCP configuration; the server and adapters need a renewal bridge or interoperable OAuth flow before that setup is beta-ready.
