# Trusted HTTPS wake client (C-B5)

Consumes human-approved `http-wake` v1 at `269d9697cb8dd2d6ddd77f49e671c7fff69164ca`. These modules implement the receiver and host-side reference boundary; they do not deploy a listener, enroll an agent, enable a server flag or advertise any provider as supported.

## Composition

- `HttpWakeKeys` reads only the configured HTTPS Envoi origin's fixed public key-set path, with bounded verified-TLS requests and no redirects or credentials. It honors cache age, rotates keys, throttles unknown-key refresh and returns retryable deferrals after failed key retrieval.
- `HttpWakeReceiver.receive()` verifies ordered raw-byte signature and envelope checks against its configured registered URL, never the incoming Host header. Unknown fields/reasons are ignored and unknown types are acknowledged without execution. An accepted notification is saved privately before acknowledgement, with a durable pending action and replay record.
- `FileWakeStore.open()` restricts a dedicated directory to its owner and acquires the existing process lock. Atomic, flushed, bounded state preserves subscription identities, owner-revocation memory, replay IDs and interrupted dispatch. Corrupt or linked state fails closed; it is not silently recreated. Call `close()` after stopping the host and HTTP requests. Use a separate directory per installation, not a vendor profile or another connector's root.
- `EnvoiWakeHostTransport` uses an existing `EnvoiConnector` at the same configured origin. Its narrow `wakeRequest()` reuses the connector's credential rotation, terminal-code handling and paused connectivity. Responses are bounded to 16 MiB, including retained subscription history rather than an invented item-count cap. Stable error codes, reasons, request IDs and retry delays remain available without echoing upstream messages. It never passes installation credentials to a model or selects a destination from a notification.
- `HttpWakeHost` maintains subscriptions, pending replacements and seven-day renewal; remembers endings; suppresses automatic creation after owner revoke, host end, credential end or receiver-gone; and dispatches durable hints only after their acknowledgement is flushed. Work is single-flight, controls independently revalidate live leases, and unknown operation outcomes remain pending for recovery.
- `createWakeHttpHandler()` returns a Node HTTP handler without opening a socket. It accepts one fixed path, caps raw bodies at 1 KiB, bounds body/verification time and calls `host.acknowledge(acceptedId)` only from the response `finish` event. The ID comes from the verified receiver result, not an incoming header. A duplicate can finish an interrupted acknowledgement without resampling a canonical effect.

The deployment owner supplies HTTPS termination and forwards unchanged raw bytes. The URL used for verification must be the server's returned canonical subscription URL. Never reconstruct it from proxy headers. Run the receiver before creating a subscription: a challenge can precede the create response, in which case it is deferred until the subscription ID has been stored.

Construct the transport with the existing connector and trusted agent/installation/inbox identity. Construct the receiver with `{ origin, registeredUrl, store }`; construct the host with the transport, same store, a trusted `WakeWorkDriver`, and that registered URL. Pass both to the HTTP handler. Only an explicitly authorized operator starts an HTTPS server or calls `host.run(signal)`; importing these modules does neither.

## Runtime requirements

The work driver is trusted host code, never model output. `processWorkOnce(signal)` must invoke the existing canonical fenced connector loop, configured with the approved snapshot-first CaseSession handler. `revalidateLiveLeases(signal)` must immediately renew every live lease and cancel a turn that loses authority. It must not be an empty callback or a claim trigger. An optional `nextAvailableInMs()` supplies the canonical claim hint. These requirements need actual runtime integration and real-host evidence; passing callback mocks does not prove them.

`EnvoiConnector.scopedWakeWorkDriver()` binds these operations to the actual scoped connector. It refuses an absent, replaced or legacy handler before processing. Control revalidation fetches canonical status, checks session availability, and immediately renews each active lease through the same single-flight renewal used by the periodic loop. Lost authority or an unverified control response aborts active turns; a late model result cannot settle that work. The driver supplies only the canonical idle claim hint adjusted for elapsed time. The frozen host handle contains no credentials or raw lease handles. Keep it private to the host, not in model context. This binding does not attest a provider's effective tool isolation: the configured CaseSession handler must still use an independently accepted runtime boundary.

`createScopedWakeHost({ connector, store, origin, identity, registeredUrl })` composes this driver with `EnvoiWakeHostTransport` and `HttpWakeHost`; it neither opens a listener nor starts polling. The actual connector must already have the approved CaseSession handler. A control hint waits for any older renewal and requests fresh authority afterward, without waiting for status or a model turn to finish. Lease-local cancellation returns an activity indication so the host can inspect subsequent canonical work; it is not a processed receipt or permission to retry a model effect. Credential revocation remains terminal. Deliberate work teardown does not turn a successful settlement into a failed renewal. Background idle hints reschedule the host when the claim actually completes; retry-after blocks early work retries while status maintenance continues.

`host.run()` claims at startup and schedules status/maintenance independently of a long-running model turn, defaulting to 60 seconds and never accepting an interval above 900 seconds. Earlier canonical hints are honored where supplied; server retry-after restrictions take precedence while rate-limited. Polling continues when wake is absent or disabled. Feature disable invalidates old subscription/challenge state; it cannot cause re-enrollment or revive an old subscription. Pause preserves connectivity but suppresses claims. Existing credential errors remain authoritative. Stop the driver and HTTP server with the same abort signal before closing storage.

## Validation and acceptance boundary

PowerShell, from the repository root:

```powershell
npx vitest run --config integrations/vitest.config.ts integrations/connector/http-wake
npx vitest run --config vitest.sdk.config.ts sdk/typescript/test/http-wake.test.ts
npm run typecheck
```

Receiver tests consume canonical executable fixtures without modifying or copying them. Synthetic keys and loopback HTTP servers test additional boundaries; they are not real Hermes/OpenClaw, hosted provider or tenant evidence. Store fixtures use disposable temporary directories only. No proof files contain live credentials.

C-A5 server routes/signing/SSRF enforcement remain Je's work. This client does not implement a competing outbound wake queue. A generic receiver is not evidence that Muse or Instinct accepts arbitrary callbacks or wakes with its app closed. Actual provider admission and runtime orchestration, receiver packaging/deployment, accepted Phase B route evidence, matching combined artifacts and human-approved C19–C21/C-B6 hosted checks remain separate requirements. Do not expose an unavailable route or mark the full gate passed from these tests or CI.
