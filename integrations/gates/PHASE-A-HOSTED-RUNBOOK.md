# Phase A real-host gate: operator runbook

This is the executable preparation for [v3 §29](../../docs/architecture/agent-native-v2/build-plan-v3.md). It does not replace the 23 required observations. Use one disposable staging owner, a second staging sender, a new agent identity, a separate Hermes profile, and one exact integration commit. Never use an existing beta agent or Rachel's regular Hermes profile. The human owns staging deployment, agent approvals, real-host actions, and gate countersign under the [two-lane execution plan](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md).

This Phase A run does not depend on the Phase B registration-contract correction. The candidate must contain the #84 server evidence and its paired #85 browser event update before the run. [PHASE-A-SESSION-PREP.md](PHASE-A-SESSION-PREP.md) requires a fresh candidate preflight, private provider check, owner responsibilities and a new human-confirmed session time; it is not hosted acceptance evidence.

## 0. Freeze the candidate

Run on a clean checkout of the selected integration candidate. The gate driver itself may be on a separate branch; its preflight compares all production sources with `--sha`, excluding only `integrations/gates/**`.

```powershell
node integrations/gates/phase-a-hosted-preflight.mjs --origin https://sinaloa-staging.rachelgonsalves821.workers.dev --sha <40-character-integration-SHA> --hermes-home <absolute-disposable-home> --hermes-version <expected-version> --regular-api-port <regular-Hermes-port>
```

All five checks must pass (the Hermes version must equal the explicit expected version, and the disposable .env must set a valid API_SERVER_PORT different from the regular profile port): source, hosted `/health` and `/ready` with that SHA and healthy database/R2/scanner, public and local connector bytes matching `release.json`, a separate profile directory, and the CLI at `<hermes-home>\\bin\\hermes.exe` on Windows (or `<hermes-home>/bin/hermes` on Unix). The preflight never resolves a machine-wide `hermes` from PATH. Its `READY_FOR_MODEL_TURN` verdict is only technical preparation: configure the disposable model provider and prove an ordinary real model turn before enrolling it or counting hosted observations. Record the SHA and bundle hash. If any check fails, do not count a later behavior as Phase A evidence.

## 1. Prepare the real host without reusing a live agent

Official Hermes Windows installation supports separate `-HermesHome` and `-InstallDir` paths. Set -HermesHome to the chosen absolute disposable profile and -InstallDir to that same profile's bin directory, so the preflight finds <home>\bin\hermes.exe. Use those options if a separate installation is needed; do not run a repair or update against Rachel's existing `%LOCALAPPDATA%\hermes` installation merely to make this gate pass. The disposable profile needs its own model-provider configuration through Hermes' private setup, plus a successful ordinary model request, before Envoi enrollment. Keep credentials out of Git, chat, command-line arguments, and evidence.

On a machine that already runs Hermes, give the disposable Gateway a different `API_SERVER_PORT` in its private `.env` before starting it. Use the disposable CLI by absolute path with `HERMES_HOME` set for every command; do not rely on the machine-wide `hermes` command or its existing Gateway. Run `hermes setup model` in that profile, then restart only the disposable Gateway and verify a real model turn. Use a dedicated provider account or restricted test key; the human completes provider sign-in, any billing/terms step, and private credential entry. The operator records only the provider name and whether a turn succeeded, never the key or full account details.

```powershell
$env:HERMES_HOME = '<absolute-disposable-home>'
$hermesCli = Join-Path $env:HERMES_HOME 'bin\hermes.exe'
.\integrations\gates\prepare-disposable-hermes.ps1 -Action ModelTurn -HermesHome $env:HERMES_HOME -Provider <selected-provider> -Model <working-test-model>
```

The earlier Nous/Solar probe is historical; recheck the operator-selected provider/model in the disposable profile. Invocation-only overrides do not fix an unavailable saved default. Before starting the disposable Gateway, privately select the working model in this profile with `& $hermesCli setup model`, retaining the existing Nous login. Do not change the regular profile. The corrected helper runs a bounded text-only check without optional model tools; use it rather than the former one-iteration example. Gateway model/tool access must still be verified separately.

The model turn must return a real model response from the explicitly selected test provider. Do **not** use `--safe-mode` for this check: the installed Hermes CLI states that it implies `--ignore-user-config`, so it can report no provider even when this profile has model settings. A successful CLI `--version`, a running API Server, or `tools/list` does not establish model readiness. The bundled connector's `prepare --runtime hermes --prepare-runtime` must reach both Envoi staging and this profile's API Server; `MODEL_NOT_READY` is a provider setup failure, not an Envoi enrollment failure.

Set `HERMES_HOME` to the disposable profile for **every** Hermes and connector process in this fixture. Start one Hermes gateway/API Server and one Envoi connector under separate supervisors or terminals. The disposable owner creates the staging agent and approves its scoped permissions; a second staging human is the distinct sender. Enroll using the private Envoi handoff and the official bundled connector. Keep the connector's persistent state directory private and separate from all existing connections. Confirm a real authenticated Hermes model turn and Envoi tool call; `tools/list` alone is insufficient.

For controlled transport faults, start the loopback proxy **before** enrolling the disposable connector:

```powershell
node integrations/gates/phase-a-fault-proxy.mjs --origin https://sinaloa-staging.rachelgonsalves821.workers.dev --port <fixed-unused-loopback-port>
```

Choose the fixed unused port before enrollment and reuse exactly that --port after every proxy restart. The connector persists apiUrl and refuses a different URL; a random replacement port would force re-enrollment. It prints a `http://127.0.0.1:<port>` URL. Point only the disposable connector's private handoff `apiUrl` at that loopback URL; retain the original staging origin separately and confirm the proxy's `/health` reports the candidate SHA. The connector accepts loopback HTTP for local development; TLS remains enforced from proxy to staging. The proxy never logs or persists request/response bodies, headers, credentials or hashes. lost-refresh keeps only an in-memory SHA-256 of the four successor fields; hold-settlement temporarily keeps one bounded request in private memory and discards it on release/exit. Its release evidence is only HTTP status and a sanitized code. It must remain in the same network namespace as the connector. A terminal-only process stops with its terminal, so keep the gateway, connector, and proxy open for the complete fixture. Do not edit an existing agent's handoff or state.

## 2. Execute all 23 observations on one release

### Corrected restart candidate prerequisites

After a runtime-reconnection fix, retain the failed run as evidence and select a new reviewed, committed candidate; uncommitted local bundles are not a release SHA. Rebuild and verify its generated connector metadata, pass exact-head CI, then have the release operator deploy and freeze that exact SHA. Do not apply a local bundle to a running old-SHA fixture and count mixed results. Pair any required UI perspective correction before selecting the final candidate.

Start a fresh 23-row ledger and use fresh messages/cases with individual human approval before every send. Keep the original paused case paused and preserve its messages and receipts. Do not re-enroll or overwrite the existing private connector state to make restart recovery pass; establish its saved identity and credential family first. Obtain authenticated receiver-owner snapshots before and after the offline checkpoint. If the owner view is unavailable, record the missing evidence rather than substituting the sender view.

For steps 3-4, stop only the disposable connector, leaving its Gateway and fixed proxy port unchanged. Capture offline delivery before restarting. A parked Hermes MCP connection can take five minutes to self-probe; the corrected connector should retain the same relay for a bounded six-minute recovery window, report waiting/pending checks, and claim nothing before an actual identity-tool call succeeds. Manually restarting the Gateway is recovery evidence, not a passing connector-only restart test. A timeout or failed assertion stops the gate and preserves that attempt.

Specify each expected ACK as a standalone, clearly delimited value without sentence punctuation after it. Agree the expected exact string before its approved send; do not normalize an unexpected reply or resend to conceal a mismatch. No live sends are authorized by this runbook.

Record each step's UTC time, audit sequence/event ID, connector state, message/work ID, credential-family ID and observed outcome in the [blank 23-row worksheet](PHASE-A-EVIDENCE-WORKSHEET.md). Keep sensitive raw logs private. A local test or a status label alone does not prove work was processed. The authoritative sanitized evidence goes to `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md` through Lane A and needs the human's countersign.

| Steps | Operator action and required observation |
| --- | --- |
| 1–2 | Connect the disposable Hermes identity; send one native message from the distinct staging sender. Confirm Hermes receives it, a model run actually acts, and there is exactly one canonical reply and settlement receipt. |
| 3–4 | Stop and restart only the connector, preserving its private state. Confirm same agent ID/address/family and that work arriving offline is processed without duplicate output. |
| 5–9 | Plan the pause across the next lazy refresh boundary below. Human pauses the test agent; sender sends **two messages in one case**, retaining their delivered order. Confirm both delivered receipts, no processed receipts or work claims, no dead letter, and advancing owner-view credentialExpiresAt/lastSuccessfulRefreshAt while paused. Save before/after owner agent views at least 60 seconds apart. A paused agent may authenticate but must not claim or send. |
| 10–12 | Human resumes. Both held messages must be claimed promptly, in the same order as delivery, with attempts: 1. Hermes processes **each** once, with one processed event/receipt and one canonical reply per message. Cite agent.resumed, work.available and ordered agent.work_claimed sequences. |
| 13–16 | In the proxy terminal type `lost-refresh` **before** the connector's next refresh. The proxy waits for a successful upstream `POST /api/agent-token`, then destroys the downstream response once. Confirm `refreshResponsesDropped: 1`; the connector retries with the same persisted `rotationId`, receives the identical successor token set, and advances rolling expiry. The next forwarded successful refresh must print recoveredIdentical: true (false or missing is not a pass). Pair this private digest comparison with agent.refresh_recovered for the same family; its refreshExpiresAt must equal the owner view credentialExpiresAt saved immediately after the dropped rotation. Publish only equality, IDs and nonsecret timestamps. Never cause a second unrelated refresh to stand in for this recovery test. |
| 17–18 | Type `cut-sse` in the proxy terminal. Confirm `sseStreamsCut > 0` and subsequent reconnect attempts blocked while `/health`, `/ready`, token refresh and authenticated REST still work. Send eligible work; confirm bounded safety polling claims and processes it without an SSE event. |
| 19–20 | With SSE still blocked, type **fail-ack-once**, then send one controlled work item. The next acknowledge receives exactly one synthetic 503 before upstream acknowledgement or Hermes processing. Confirm acknowledgementsFailed: 1 and agent.work_failed with retryable: true, attempts: 1 and retryAt. The second claim must carry the same workId, fence: 2 and createdAt ≥ retryAt; Hermes acts once, with one processed event/receipt and no new SSE event. Do not stop the Gateway to cause repeated failures. |
| 21–23 | First type **restore-sse** and wait for activeSse > 0; record that credential.ended reaches the connector. Prepare the owner revoke control, type **hold-settlement**, and send one controlled item. Wait for settlementBuffered: true (upstream has not received complete), then revoke promptly within the connector's 30-second request timeout. Confirm terminal REVOKED, type **release**, and require {status: 401, code: CREDENTIAL_REVOKED}. The buffered request survives the connector aborting its fetch. Use replay-refresh and replay-claim after revoke for two further server HTTP401/CREDENTIAL_REVOKED denials. They retain each latest authenticated request only in bounded private memory and consume it once. Record send and MCP-write connector-local refusals separately from those server denials, plus unchanged refresh presence and no new canonical output after revoke. A local guard is not an HTTP 401. No silently inferred PASS. If the request timed out/retried before revoke, discard this attempt's evidence. |

The proxy terminal accepts lost-refresh, cut-sse, restore-sse, fail-ack-once, hold-settlement, release, replay-refresh, replay-claim, status and exit. restore-sse belongs **before** step 21, not after the revoke. If no credential.ended frame is observed, identify the actual REST refusal path and leave the frame path unproven. Its counters prove only that faults were injected, not that the connector recovered. Correlate them with server audit sequence/IDs and canonical receipts. Use Lane A's [phase-a-TEMPLATE.md](../../docs/architecture/agent-native-v2/evidence/phase-a-TEMPLATE.md), saving raw owner views only to a private folder and publishing only scripts/ga-evidence.mjs output; never publish /messages, agent-view or raw HTTP. If any step fails, file the responsible Lane A/Lane B defect, integrate its fix, deploy a new exact SHA, and rerun **all 23**; never combine partial results from different commits. Publish the Phase B `/connect` skill only after human-countersigned `GATE GA PASS`.

### Compressed proxy responses and a diagnostic Test 15 retest

The fault proxy compares the four decoded successor fields, not compressed wire bytes. It supports identity, gzip, deflate and Brotli responses, with independent 64 KiB encoded and decoded limits. Unsupported encodings, malformed data and oversized decoded bodies cannot prove equality. Ordinary forwarding retains the upstream bytes and Content-Encoding header. Buffered revocation probes also decode only the bounded comparison copy before extracting a public error code; no credential, digest or raw response is printed or persisted.

If an earlier proxy reported a mismatch because it could not decode compression, preserve that attempt as **UNPROVEN — measurement defect**, not a retroactive pass or proof of server credential divergence. An offline regression fix does not repair the historical measurement. Retain every other failed gate assertion, including any exact-ACK failure.

For a separately approved diagnostic retest:

1. Record the frozen server/connector candidate and the corrected proxy artifact identity. A gate-only tooling patch is not a newly deployed application release; never combine diagnostic evidence into a claimed all-23-check pass.
2. Get approval for the isolated fixture maintenance needed to load the corrected proxy. The existing supervisor imports the proxy once; editing a file does not replace its running code. Preserve the private connector state, agent/address/family and fixed proxy port. Do not restart another profile, re-enroll or deploy. If maintenance also restarts the disposable Gateway or connector, record it explicitly and recheck readiness before arming any fault.
3. Record a fresh owner baseline and the next natural access-refresh boundary. Do not edit expiry or trigger an unrelated rotation. Ensure the earlier fault has completed and no other fault is armed. Keep the original case paused.
4. Ask the human before arming exactly one lost-refresh fault. This retest needs no new message send. Observe the persisted pending rotation without printing its ID, tokens or fingerprint; record only whether it stays unchanged.
5. Capture a fresh owner view immediately after the drop, before a subsequent unrelated rotation. Require one dropped response, recoveredIdentical: true, a same-family agent.refresh_recovered event and equality between its refreshExpiresAt and that owner credentialExpiresAt. Record expiry advancement and successful connector recovery independently. False, null, missing or invalid evidence is not a pass; do not silently re-arm.
6. Stop after this diagnostic. Further SSE faults, live sends or revocation require their own approval. A complete hosted gate still requires the runbook's one-release, all-23 observations and human countersign.

### Lazy refresh timing (steps 9 and 13)

There is no force-refresh command. Refresh happens on the next authenticated operation at `agentTokenExpiresAt − 60 seconds`; the access TTL is 900 seconds, so a wait of about **14 minutes** per boundary is possible. Use the bundled connector's nonsecret status output immediately before pause and again before arming lost-refresh:

```powershell
$status = (& node .\web\downloads\envoi-connector.mjs status --state-dir <private-disposable-state-dir>) | ConvertFrom-Json
$boundary = ([DateTimeOffset]::Parse($status.credentialExpiresAt)).AddSeconds(-60)
$boundary.UtcDateTime.ToString('o')
```

`status.credentialExpiresAt` is the saved access `agentTokenExpiresAt`; `status.refreshExpiresAt` is the rolling family expiry and is **not** the refresh trigger. Pause before the first boundary and remain paused until the owner-view refresh fields advance. Arm lost-refresh before the next boundary and wait for its one dropped 200 and recoveredIdentical. Do not edit token expiries, inject credentials, re-enroll or trigger an unrelated rotation to shorten the hosted gate. Budget at least two refresh waits and more than the former 90-minute slot.

## 3. Port this proof to other agents

Hermes is a reference fixture for Envoi's shared queue, credential lifecycle, and connector. It is not the only supported product. For each additional host, use the same `SKILL.md`/JSON contract and repeat identity, owner approval, scoped tools, durable work, restart, expiry/renewal, revoke, and duplicate tests. Then separately prove that host's actual unattended wake mechanism with its app closed. Mark hosts that can only use an open-chat connector as **on demand**. The [draft capability matrix in PR #72](https://github.com/rachelgonsalves821/Envoi/pull/72) tracks Hermes, OpenClaw, Muse, Instinct, ChatGPT Dots and future agents without promising features a provider has not exposed.
