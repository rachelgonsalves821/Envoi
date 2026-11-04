# HW7 Envoi benchmark evidence

This benchmark used Envoi commit `5b4d7c2941be4052564f12d02c4d5f304af76ffc` with a local development-auth FileStore server. It creates only synthetic owners, agents, cases, and messages, then deletes the temporary data directory. No hosted service, external recipient, model, or paid API is involved.

## Predeclared comparison

Claim: a client using Envoi's durable work claims can process inbound agent work within five seconds when an event is missed or a retry is delayed. The simpler baseline claims only when an event arrives. The initial client improvement claims once at startup. The revised client also waits for the server's `nextAvailableInMs` hint and claims again. These are three client policies in the harness, not three Envoi server versions.

The ordinary, missed-event, and retry-delay cases were chosen before inspecting results. `combined_fault` is a held-out case combining offline arrival and a transient failure, run after the retry-hint policy was selected. Each case has three synthetic messages per policy. The same server commit, task text pattern, recipient permissions, five-second deadline, and 1.2-second retry base apply to all policies. Distinct receiver inboxes prevent unprocessed baseline messages from interfering with the improved policies.

Success is the recipient owner's API showing the message as `processed` within five seconds. Failed strategies are observed through the full deadline. The script records claim/settlement API calls and elapsed time after the message has reached `delivered`; it excludes owner enrollment and initial delivery setup. The script cleans up failed work after scoring, outside the measured interval.

## Reproduce

Use Windows PowerShell, Node 24, and the repository dependencies at the source commit. From the repository root:

```powershell
npm.cmd install
node integrations/gates/hw7/benchmark.mjs
```

The script writes `results.json` beside itself. It needs local loopback access and permission to create a temporary data directory in this folder. No credentials are needed. The committed `results.json` is the observed run on 2026-11-04.

## Scope

This measures deterministic client wake policies on the local FileStore adapter. It does not test PostgreSQL, hosted latency, a real model, random network loss, or production connector integration. The benchmark client change is not merged into the product connector. API call counts exclude setup and cleanup; model/API token cost is zero.
