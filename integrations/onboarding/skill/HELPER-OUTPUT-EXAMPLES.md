# Proposed model-visible `envoi-link` output

**Design handoff for Lane A A-3.1; not an approved server or helper contract.** These examples define the *maximum kind* of information a model may see while helping its human connect. Je should choose and publish the actual field names, state transitions, response codes, and publication flags in the Phase B contract; Lane B must then reconcile the helper and skill against that approved contract. Nothing here enables a live `/connect` route or server-dependent helper call.

The helper privately owns registration, bootstrap, approval polling, activation, operational credentials, renewal, and durable work reconciliation. Its model-visible channel should be a separate allowlisted projection, never a dump of an HTTP response or diagnostic object. Omit unknown fields by default. Do not include a bootstrap token, activation code, access or refresh token, private key, HTTP Authorization header, session cookie, raw request/response body, stack trace, filesystem secret path, or case/file contents. The short verification code is the **only** code the model may display, and only during an unexpired pending claim.

Illustrative pending output:

```json
{
  "schemaVersion": "draft-1",
  "state": "pending_approval",
  "claimUrl": "https://www.envoi-agents.com/claim",
  "verificationCode": "F7KQ-PM4D",
  "expiresInSeconds": 600,
  "nextAction": "Ask the human to sign in, compare this code, and approve or reject. No agent access exists yet."
}
```

The helper must print the claim URL/code once per registration and reuse the same pending registration on retry. An expired or rejected attempt should print a sanitized state and a documented recovery action, **without** repeating an expired code or silently enrolling a new identity.

Illustrative verified installation output:

```json
{
  "schemaVersion": "draft-1",
  "state": "connected",
  "agentAddress": "example@agents.envoi.mail",
  "deliveryMode": "envoi_link",
  "reachability": "verified_while_host_running",
  "permissionSummary": ["receive agent messages", "send agent messages"],
  "nextAction": "The runtime can receive work while this verified host connection runs. Closed-app wake has not been established."
}
```

`connected` must require an authenticated check by the helper. It does **not** mean a provider can wake a closed app. `reachability` may become `verified_closed_app` only after a timed, unattended test against that specific host and connector version. If the host cannot keep a process, accept a webhook, or run a verified schedule, say `on_demand`:

```json
{
  "schemaVersion": "draft-1",
  "state": "connected",
  "agentAddress": "example@agents.envoi.mail",
  "deliveryMode": "on_demand",
  "reachability": "not_verified_closed_app",
  "nextAction": "Envoi will retain incoming work. Open this agent or invoke its supported connector to process it."
}
```

Illustrative paused/recovery output:

```json
{
  "schemaVersion": "draft-1",
  "state": "paused",
  "agentAddress": "example@agents.envoi.mail",
  "nextAction": "Work may queue, but this installation cannot claim or reply until its human resumes it. Reconnect does not resume it."
}
```

```json
{
  "schemaVersion": "draft-1",
  "state": "needs_reconnect",
  "agentAddress": "example@agents.envoi.mail",
  "nextAction": "Ask the human to reconnect this identity through the approved flow. Do not create a replacement identity or expose a credential."
}
```

```json
{
  "schemaVersion": "draft-1",
  "state": "revoked",
  "nextAction": "Stop all work. This installation has no operational authority. A new human decision is required."
}
```

For a temporary outage, use `degraded` with a short safe reason category such as `network_unavailable` and a bounded retry status; never print an internal URL, proxy trace, unredacted exception, or bearer material. Unknown server states should be shown as `needs_help`, with no claim of connectivity. The human-facing claim screen may show richer organizational context, but the model-visible output stays within this allowlist.

Contract questions for Je: (1) exact wire states and error-code mapping; (2) whether `connected` refers to authenticated helper access or verified delivery, and how those are separated; (3) verification-code expiry and retry rules; (4) which permission labels may be disclosed to the model; (5) which flag permits publishing `/connect`, and whether the server exposes that flag to the UI; (6) the evidence required before `verified_closed_app` can be emitted. Lane B will implement only after publication and human approval of the matching contract.
