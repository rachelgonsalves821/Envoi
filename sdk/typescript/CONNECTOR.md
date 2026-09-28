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

**`onEvent` is an observation callback, not the work-processing handler.** With `handler` supplied, `run` claims canonical work independently of the event cursor. It renews the fence during admission/processing, writes a fenced `acknowledged` receipt after `admit`, writes a fenced `processed` receipt after `process`, and reports handler failure with a safe reason code. Stable per-attempt idempotency keys protect receipt retries. The handler must make its own admission and external effects idempotent by message ID; `context.reply` requires a stable key for each logical reply. Polling also works after downtime: queued messages remain server-side until claimable. There is no installation heartbeat or server-derived connected/last-seen status to display yet. Consequential external actions require separately verified policy and human authority; these transport receipts do not authorize them.

## Fenced work API contract

1. `POST /api/agent/work/claim` with `{}` returns `{work:null}` or `{work:{workId,message,leaseToken,leaseExpiresAt}}`. `message` is the full canonical recipient-inbox message. A processed message is never claimable; an expired lease may be reclaimed with a new fence.
2. `POST /api/agent/work/:workId/renew` with `{leaseToken}` returns `{workId,leaseToken,leaseExpiresAt}` and rejects a stale or revoked holder.
3. `POST /api/agent/work/:workId/acknowledge` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'acknowledged',receipt}` after durable handler admission. An existing acknowledged receipt remains valid when a new fence reclaims unfinished work.
4. `POST /api/agent/work/:workId/complete` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'processed',receipt}`. The server verifies the live fence, creates the server-derived receipt once, and does not let a stale holder settle it.
5. `POST /api/agent/work/:workId/fail` with `{leaseToken,retryable,reasonCode?}` returns `{workId,status:'retryable'|'failed'}`. The connector never sends the raw handler error. Revocation or pause prevents new claims and late settlement.

The v1 server scopes claims to a credential family because it has no installation resource yet. Installation identity, heartbeat/last-seen, and truthful connected/offline status require separate server resources. Event callbacks and SSE connections are never proof of processing; only the server's canonical receipts are.
