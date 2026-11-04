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

A second run at `evidence/ga4-d4981d2-5000/summary.json` used the server's default 5-second retry base on commit `d4981d2207da2568a486141016cb28518938b1c8`. Both scenarios passed: 921 ms for the offline arrival and 2,516 ms for the delayed retry, each measured from worker restart. The retry clock began before restart, so this is not an end-to-end latency from the first failed attempt. That run also used 11 REST calls and four claims through both completions. Set `ENVOI_HW7_RETRY_BASE_MS=5000` to select this variant; omitting it uses the 20-second fault gate setting.

The Hermes adapter local tests also passed 2/2. They use a simulated provider and include an SSE-unavailable MCP reply, plus a restart with two offline cases. The saved output is `evidence/hermes-local-vitest.txt`. Neither run tests a real Hermes host or hosted PostgreSQL.

### Hosted PostgreSQL repeat

The same production connector runner passed against a newly created, isolated Neon PostgreSQL project (`envoi-hw7-eval-20261104`) on commit `c38998e224940e508b987af0b23ad24e7ec856ae`. See [`run 1`](evidence/ga4-postgres-c38998e-60000/summary.json), [`run 2`](evidence/ga4-postgres-c38998e-60000-repeat2/summary.json), and [`run 3`](evidence/ga4-postgres-c38998e-60000-repeat3/summary.json). SSE was cut while REST remained available, and the worker was force-stopped before the offline message arrived. In the three runs, the offline message reached processed status 6,717, 8,751, and 6,806 ms after restart (median 6,806 ms); the deliberately delayed retry reached it in 59,741, 59,461, and 57,849 ms. Each message had exactly one controlled effect and one completion receipt in every run; later safety claims and another restart caused no duplicate effect. Recovery through both completions used 14, 13, and 13 REST calls, including seven, six, and six work claims. That is 6.7 REST calls per successful message on average. The handler made zero model calls. The 60-second server retry base deliberately kept the retry pending through hosted setup and restart, so the roughly 60-second retry observations do not indicate unexpectedly slow retry scheduling. All three offline results exceed the five-second claim from the original local benchmark.

Run 3 recorded effect and completion timestamps: the offline handler effect occurred 4,084 ms after restart and the processed completion receipt arrived at 5,612 ms. The later server-owned message status check completed at 6,806 ms. This narrows the failed five-second target to the end-to-end hosted processing and observation path. The current evidence does not isolate a slow SQL query or connector operation, so changing retry logic again would be unsupported. Profile the claim, settlement, and status read round trips against hosted PostgreSQL, then optimize the measured bottleneck and retest the three cases with the same fault schedule.

Two initial hosted attempts were invalid setup runs: one five-second retry expired before worker restart during hosted setup; another reused persistent owner and case identifiers. The runner now creates distinct identities and case identifiers for each run. They are not counted as product failures or successful trials. Three trials per fault case are still too few for a reliability estimate. Neon database charges and query count were not independently measured; the zero paid-API figure refers to model and external paid APIs, not database hosting. The controlled handler is not the real Hermes host or `HttpWakeHost`, and crash after an external effect remains untested. The relevant local host scheduler and runner tests passed 17/17 with loopback network access. No product connector change was justified by the passing duplicate and recovery checks. Next, run this fault scenario through the actual hosted wake host and repeat crash after effect, then measure the costs and latency under a real model workload.

To reproduce the connector run from the evidence branch, set `ENVOI_GA4_TARGET_ROOT` to the absolute path of that checkout and `ENVOI_GA4_SHA` to its current 40-character commit SHA. Build the worker with `npx vite build --config integrations/gates/ga4-worker.vite.config.mjs`, then run `node integrations/gates/hw7/connector-local.mjs`. The runner writes a new `evidence/ga4-<sha>/summary.json`. On Windows, ensure the temporary directory is writable; the recorded run set `TEMP` and `TMP` to `integrations/gates/.runtime/tmp` in the checkout.

For PostgreSQL, additionally put the isolated database URI in a private ignored file and set `ENVOI_HW7_DATABASE_URL_FILE` to its absolute path and `ENVOI_HW7_RETRY_BASE_MS=60000` before invoking the same runner. Optionally set `ENVOI_HW7_EVIDENCE_RUN` to a short label for repeat runs. The runner strips Neon URI `sslmode` and uses Envoi's `ENVOI_DB_SSL_MODE=verify-full`. Never commit the URI or private runtime directory. Its output folder is `evidence/ga4-postgres-<sha>-60000[-label]/`.
