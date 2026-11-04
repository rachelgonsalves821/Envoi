# HW7 Envoi benchmark evidence

This benchmark used Envoi commit `5b4d7c2941be4052564f12d02c4d5f304af76ffc` with a local development-auth FileStore server. It creates only synthetic owners, agents, cases, and messages, then deletes the temporary data directory. No hosted service, external recipient, model, or paid API is involved.

## Predeclared comparison

Claim: a client using Envoi's durable work claims can process inbound agent work within five seconds when an event is missed or a retry is delayed. The simpler baseline claims only when an event arrives. The initial client improvement claims once at startup. The revised client also waits for the server's `nextAvailableInMs` hint and claims again. These are three client policies in the harness, not three Envoi server versions.

The ordinary, missed-event, and retry-delay cases were chosen before inspecting results. `combined_fault` is a held-out case combining offline arrival and a transient failure, run after the retry-hint policy was selected. Each case has three synthetic messages per policy. The same server commit, task text pattern, recipient permissions, five-second deadline, and 1.2-second retry base apply to all policies. Distinct receiver inboxes prevent unprocessed baseline messages from interfering with the improved policies.

Success is the recipient owner's API showing the message as `processed` within five seconds. Failed strategies are observed through the full deadline. The script records claim/settlement API calls and elapsed time after the message has reached `delivered`; it excludes owner enrollment and initial delivery setup. The script cleans up failed work after scoring, outside the measured interval.

## Reproduce

Check out the `lane-b/hw7-benchmark` evidence branch, whose parent is the tested source commit. Use Windows PowerShell and Node 24. From the repository root:

```powershell
npm.cmd install
node integrations/gates/hw7/benchmark.mjs
```

The script writes `results.json` beside itself. It needs local loopback access and permission to create a temporary data directory in this folder. No credentials are needed. The committed `results.json` is the observed run on 2026-11-04.

## Scope

This measures deterministic client wake policies on the local FileStore adapter. It does not test PostgreSQL, hosted latency, a real model, random network loss, or production connector integration. The benchmark client change is not merged into the product connector. API call counts exclude setup and cleanup; model/API token cost is zero.

## Follow-up: actual connector path

The original comparison above does not run Envoi's connector. The follow-up at `evidence/ga4-86778ca/summary.json` runs production `startConnection`, `EnvoiConnector`, and `FileBridgeStore` in a separate worker process against a real local Envoi server. An HTTP proxy cuts the active SSE stream and rejects reconnects while forwarding REST. The test force-stops the worker before an offline arrival, restarts with saved state, and checks the offline message and a retry-delayed message through server-owned status, one local effect file per message, and one completion receipt per message. Later safety claims and another restart must not duplicate either effect.

Both messages passed on commit `86778ca2f8f544b2c63ba2b6015199ec814ac190`. Measured from the worker restart, the offline message reached processed status in 838 ms; the delayed message in 19,616 ms with a 20-second configured server retry base. Recovery through both messages used 11 observed REST calls, including four work claims, or 5.5 REST calls per successful message. The controlled handler made zero model calls and incurred zero paid API cost. This test includes a forced process stop before the offline message, not a crash after an external effect.

The Hermes adapter local tests also passed 2/2. They use a simulated provider and include an SSE-unavailable MCP reply, plus a restart with two offline cases. The saved output is `evidence/hermes-local-vitest.txt`. Neither run tests a real Hermes host or hosted PostgreSQL.

To reproduce the connector run from the evidence branch, set `ENVOI_GA4_TARGET_ROOT` to the absolute path of that checkout and `ENVOI_GA4_SHA` to its current 40-character commit SHA. Build the worker with `npx vite build --config integrations/gates/ga4-worker.vite.config.mjs`, then run `node integrations/gates/hw7/connector-local.mjs`. The runner writes a new `evidence/ga4-<sha>/summary.json`. On Windows, ensure the temporary directory is writable; the recorded run set `TEMP` and `TMP` to `integrations/gates/.runtime/tmp` in the checkout.
