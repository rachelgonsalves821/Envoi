# TypeScript outbound connector: current slice

`src/connector.ts` is a polling connector for the routes the server currently implements. It is exported through the package's `./connector` subpath so the core client remains independent of the connector runtime.

```ts
import { enrollConnector, SinaloaConnector } from '@sinaloa/protocol/connector';

// Implement load/save with an OS keychain or managed secret store. Each save
// must atomically replace the full session, especially the rotating refresh token.
const store = myDurableSecretStore;
await enrollConnector('https://api.example', oneUseCode, store, { name: 'My agent' });

const stop = new AbortController();
await new SinaloaConnector('https://api.example', store, {
  onEvent(event) {
    // Observation / wake-up only. Do not run consequential work here.
    if (event.type === 'message.delivered') console.log('New inbox event', event.id);
  }
}).run(stop.signal);
```

The connector validates HTTPS (allowing local HTTP for development), redeems `/api/agent-enroll`, stores the returned agent ID, dedicated inbox ID, address and credentials, refreshes via `/api/agent-token`, and reads `/api/inboxes/:id/events/delta`. It commits each event cursor only after `onEvent` resolves. A callback or cursor-save failure causes at-least-once replay. Expired access tokens rotate proactively; a 401 on delta triggers one forced rotation and retry. `run` polls with bounded exponential backoff and jitter, and stops on abort or an authentication/persistence failure. It does not log credentials. A failed save after token rotation is fatal because retrying the consumed refresh token could trigger replay protection. A crash between the server's rotation response and local durable save still requires re-enrollment: the current rotation API offers no recovery transaction.

**`onEvent` is an observation callback, not a work-processing handler.** The current server has durable delivery and idempotent `acknowledged`/`processed` receipt endpoints, but no atomic recipient work claim, lease renewal, or fenced completion. Multiple installations can see the same event and call the same handler. The connector therefore does not invoke an agent runtime or write processing receipts. A customer's agent may be offline while messages accumulate; its next poll replays the event history. This is event catch-up, not proof that agent work completed. There is no installation heartbeat or server-derived connected/last-seen status to display yet.

## Required server contract to enable processing

1. `POST /api/agent/work/claim` authenticates the active installation, checks the recipient inbox/agent, current receive permission, pause/revocation/block state, and atomically grants one eligible delivered message to exactly one installation. Response includes `workId`, canonical `messageId` and payload, opaque fencing token, and `leaseExpiresAt`. A processed message is never claimable. An expired lease may be reclaimed with a *new* fencing token.
2. `POST /api/agent/work/:id/renew` extends a live lease only for the matching installation and fencing token. The server bounds lease duration and refuses revoked or stale holders.
3. A claim-bound acknowledgement records `acknowledged` only after the runtime has durably admitted the message. `POST /api/agent/work/:id/complete` atomically verifies the live fencing token, commits `processed` and the canonical receipt, and consumes the claim with a stable idempotency key. Replays return the existing result; a different payload for the same key conflicts. `processed` cannot regress to `acknowledged`.
4. `POST /api/agent/work/:id/fail` records retryable or terminal failure under the same fence; lease expiry makes retryable work claimable. Revocation or pause immediately prevents new claims and late settlement.
5. A message lookup or claim response supplies the full canonical message; the current delta event is only a notification. The existing paginated `/messages` route is not an exact work lookup. Installation identity, heartbeat/last-seen, and truthful connected/offline status require separate server resources.

Once that contract exists, a processing loop can claim, durably admit, acknowledge, invoke an idempotent runtime handler, renew leases during long work, complete under the fence, and then commit its event cursor. Until then, do not treat inbox delivery, an SSE connection, or an observation callback as agent processing.
