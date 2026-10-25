# TypeScript outbound connector

`src/connector.ts` is an outbound SSE wake and fenced-work connector. It is exported through the private package's `./connector` subpath so the core client remains independent of the connector runtime.

For current local-helper onboarding, use the reviewed [private helper](../../integrations/onboarding/README.md) and the owner claim/host confirmation flow. Resume its saved installation after interruption. The explicit `enrollConnector` example below describes the older owner-issued one-use enrollment API, not permission to silently enroll a new agent or replace an uncertain installation. Current scoped model work uses [CaseSessions and typed tools](#scoped-case-tools-and-human-decisions).

```ts
import { enrollConnector, EnvoiConnector } from '@envoi/protocol/connector';

// Implement load/save with an OS keychain or managed secret store. Each save
// must atomically replace the full session, especially the rotating refresh token.
const store = myDurableSecretStore;
await enrollConnector('https://api.example', oneUseCode, store, { name: 'My agent' });

const stop = new AbortController();
await new EnvoiConnector('https://api.example', store, {
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

**`onEvent` is an observation callback, not the work-processing handler.** With `handler` supplied, `run` claims canonical work independently of the event cursor. It renews the fence during admission/processing, writes a fenced `acknowledged` receipt after `admit`, writes a fenced `processed` receipt after `process`, and reports handler failure with a safe reason code. Stable per-attempt idempotency keys protect receipt retries. The handler must make its own admission and external effects idempotent by message ID; `context.reply` requires a stable key for each logical reply. Safety claims also work after downtime: queued messages remain server-side until claimable. The integrated installation and a5 presence projection provide server-derived status, including paused and needs-reconnect states. Enrollment, an open browser and an SSE connection alone do not prove runtime readiness or automatic reachability. Consequential external actions require separately verified policy and human authority; these transport receipts do not authorize them.

## Fenced work API contract

1. `POST /api/agent/work/claim` with `{}` returns `{work:null}` or `{work:{workId,message,leaseToken,leaseExpiresAt}}`. `message` is the full canonical recipient-inbox message. A processed message is never claimable; an expired lease may be reclaimed with a new fence.
2. `POST /api/agent/work/:workId/renew` with `{leaseToken}` returns `{workId,leaseToken,leaseExpiresAt}` and rejects a stale or revoked holder.
3. `POST /api/agent/work/:workId/acknowledge` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'acknowledged',receipt}` after durable handler admission. An existing acknowledged receipt remains valid when a new fence reclaims unfinished work.
4. `POST /api/agent/work/:workId/complete` with `{leaseToken}` and `Idempotency-Key` returns `{workId,status:'processed',receipt}`. The server verifies the live fence, creates the server-derived receipt once, and does not let a stale holder settle it.
5. `POST /api/agent/work/:workId/fail` with `{leaseToken,retryable,reasonCode?}` returns `{workId,status:'retryable'|'failed'}`. The connector never sends the raw handler error. Revocation or pause prevents new claims and late settlement.

Claims remain fenced to their credential family, and the integrated installation/session resources additionally bind scoped case turns to installation, work, case, counterparty and fence. Legacy family-backed connections retain their supported compatibility behavior; an installation projection is not a fabricated processing receipt. Event callbacks and SSE connections are never proof of processing; only the server's canonical receipts are.

## Setup status for OpenClaw and Grok

This library is consumed by the integrated Hermes/OpenClaw and xAI API adapters. Prior Hermes/OpenClaw B/C acceptance is human-attested and countersigned; preserve its original source/host scope in the [acceptance record](../../integrations/gates/phase-c/EVIDENCE.md). Additional provider routes and later changed clients have their own gates. An xAI API bridge result does not imply consumer Grok, Bot or automation support. MCP discovery alone does not wake an unattended agent: the trusted host must keep the supported queue/wake and fenced processing path running.

One-use enrollment returns rotating agent access and refresh tokens. Store the entire `ConnectorSession` atomically in a secret store outside prompts and logs. The connector refreshes expiring access tokens and retries a stable access-expiry/authentication code once. Revocation rejects subsequent calls and stops the run loop. The library's case and asset helpers use the same refresh path. The integrated adapters own their private credential/CaseSession bridges and runtime cancellation. New host/version claims still need exact-source two-owner/two-case/assets/lifecycle evidence. Do not put a short-lived agent access token in static model-facing MCP configuration. Audience-bound OAuth installations use the separately approved remote-auth flow and `/oauth/token`; they cannot be fed into this REST connector to bypass its audience or subscription restrictions.


## Scoped case tools and human decisions

Use `caseSessionHandler` for current scoped model turns. The trusted connector owns claim, renew, acknowledge, complete/fail, credential rotation and cancellation. Its handler receives a private `CaseSessionChannel`, not an installation token for the model. Instantiate `CaseToolsClient` from [`src/case-tools.ts`](src/case-tools.ts) inside that trusted handler. `durableQueue` and `trustedRuntime` below stand for your host's own services; they are not SDK exports.

```ts
import { EnvoiConnector } from './src/connector.ts';
import { CaseToolsClient } from './src/case-tools.ts';

await new EnvoiConnector(origin, store, {
  caseSessionHandler: {
    admit: work => durableQueue.putIfAbsent(work.id, work),
    process: async (channel, { signal, workId }) => {
      const tools = new CaseToolsClient(channel);
      const snapshot = await tools.snapshot();
      await trustedRuntime.run({ snapshot, tools, signal, workId });
    }
  }
}).run(stop.signal);
```

Keep `channel`, refresh/access credentials and operational lease control in trusted host code. Give the model only the bounded snapshot and allowed tool definitions/handles through the reviewed adapter boundary. Each turn is bound to its own case and counterparty. Do not supply a recipient/case override or retry an authorization failure through a privileged legacy path. Abort runtime work when the channel/host signal ends and reject late writes or settlement.

The typed tools are `snapshot`, `reply`, `propose`, `decide`, `checkAuthority`, `requestHuman`, `listAssets`, `shareAsset` and `complete`. Writes require a stable operation key saved before the request and reused with the same arguments after uncertain results. The client serializes calls, checks the live tool subset and response bounds, and fetches the initial snapshot before other operations. `requestHuman` ends this turn: wait for canonical owner-decision work and a fresh scoped turn before continuing. A model statement that approval was granted is not authority.

Use scanned, current case grants for assets. Inbox upload/download helpers alone do not authorize another owner; `listAssets` and `shareAsset` enforce the current scoped boundary. Signed URLs and bearer headers stay outside model context/logs. `complete` creates a canonical case outcome only when its authority and evidence checks pass. The host's per-work processed receipt does not itself complete a case.

SSE and the jittered safety poll reuse the authoritative queue; the integrated signed HTTPS receiver is an additional trigger for supported installations. A notification acknowledgement is not a canonical reply or completion. Source integration does not establish a provider-specific wake mechanism. Keep unaccepted hosts unavailable or accurately on demand as the approved server projection specifies; see [the B/C closure checklist](../../integrations/gates/B-C-CLOSEOUT.md).
