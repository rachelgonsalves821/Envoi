# Phase A real-host gate: operator runbook

This is the executable preparation for [v3 §29](../../docs/architecture/agent-native-v2/build-plan-v3.md). It does not replace the 23 required observations. Use one disposable staging owner, a second staging sender, a new agent identity, a separate Hermes profile, and one exact integration commit. Never use an existing beta agent or Rachel's regular Hermes profile. The human owns staging deployment, agent approvals, real-host actions, and gate countersign under the [two-lane execution plan](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md).

## 0. Freeze the candidate

Run on a clean checkout of the selected integration candidate. The gate driver itself may be on a separate branch; its preflight compares all production sources with `--sha`, excluding only `integrations/gates/**`.

```powershell
node integrations/gates/phase-a-hosted-preflight.mjs --origin https://sinaloa-staging.rachelgonsalves821.workers.dev --sha <40-character-integration-SHA> --hermes-home C:\Users\Rachel\Documents\Codex\Envoi-phase-a-disposable-hermes
```

All five checks must pass: source, hosted `/health` and `/ready` with that SHA and healthy database/R2/scanner, public and local connector bytes matching `release.json`, a separate profile directory, and a working Hermes CLI. Record the SHA and bundle hash. If any check fails, do not count a later behavior as Phase A evidence.

## 1. Prepare the real host without reusing a live agent

Official Hermes Windows installation supports separate `-HermesHome` and `-InstallDir` paths. Use those options if a separate installation is needed; do not run a repair or update against Rachel's existing `%LOCALAPPDATA%\hermes` installation merely to make this gate pass. The disposable profile needs its own model-provider configuration through Hermes' private setup, plus a successful ordinary model request, before Envoi enrollment. Keep credentials out of Git, chat, command-line arguments, and evidence.

Set `HERMES_HOME` to the disposable profile for **every** Hermes and connector process in this fixture. Start one Hermes gateway/API Server and one Envoi connector under separate supervisors or terminals. Create a staging agent and approve its scoped permissions using the second staging human as sender. Enroll using the private Envoi handoff and the official bundled connector. Keep the connector's persistent state directory private and separate from all existing connections. Confirm a real authenticated Hermes model turn and Envoi tool call; `tools/list` alone is insufficient.

For controlled transport faults, start the loopback proxy **before** enrolling the disposable connector:

```powershell
node integrations/gates/phase-a-fault-proxy.mjs --origin https://sinaloa-staging.rachelgonsalves821.workers.dev
```

It prints a `http://127.0.0.1:<port>` URL. Point only the disposable connector's private handoff `apiUrl` at that loopback URL; retain the original staging origin separately and confirm the proxy's `/health` reports the candidate SHA. The connector accepts loopback HTTP for local development; TLS remains enforced from proxy to staging. The proxy never writes request or response bodies, headers, or credentials. It must remain in the same network namespace as the connector. A terminal-only process stops with its terminal, so keep the gateway, connector, and proxy open for the complete fixture. Do not edit an existing agent's handoff or state.

## 2. Execute all 23 observations on one release

Record each step's UTC time, redacted request/audit IDs, connector state, message/work ID, and observed outcome. Keep sensitive raw logs private. A local test or a status label alone does not prove work was processed. The authoritative sanitized evidence goes to `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md` through Lane A and needs the human's countersign.

| Steps | Operator action and required observation |
| --- | --- |
| 1–2 | Connect the disposable Hermes identity; send one native message from the distinct staging sender. Confirm Hermes receives it, a model run actually acts, and there is exactly one canonical reply and settlement receipt. |
| 3–4 | Stop and restart only the connector, preserving its private state. Confirm same agent ID/address/family and that work arriving offline is processed without duplicate output. |
| 5–9 | Human pauses the test agent. Sender sends another message. Confirm durable held work, unchanged attempt count, no dead letter, and a successful refresh while paused. A paused agent may authenticate but must not claim or send. |
| 10–12 | Human resumes. Held work must become immediately claimable in case order; Hermes acts once and produces one canonical reply and receipt. |
| 13–16 | In the proxy terminal type `lost-refresh` **before** the connector's next refresh. The proxy waits for a successful upstream `POST /api/agent-token`, then destroys the downstream response once. Confirm `refreshResponsesDropped: 1`; the connector retries with the same persisted `rotationId`, receives the identical successor token set, and advances rolling expiry. Compare credential equality privately; publish only `same successor: yes` and nonsecret timestamps. Never cause a second unrelated refresh to stand in for this recovery test. |
| 17–18 | Type `cut-sse` in the proxy terminal. Confirm `sseStreamsCut > 0` and subsequent reconnect attempts blocked while `/health`, `/ready`, token refresh and authenticated REST still work. Send eligible work; confirm bounded safety polling claims and processes it without an SSE event. |
| 19–20 | Induce one retryable handler failure before any external effect. Confirm the server records `nextAvailableAt`, then the connector processes the same work when eligible without a new event, once, with one receipt. Keep SSE blocked during this step. |
| 21–23 | Revoke the disposable **credential family** using the staging owner's agent-wide revoke control. Confirm the connector transitions to terminal `REVOKED`. Verify refresh, claim, send, MCP write and a previously leased late settlement are each rejected; no new canonical output. Use a test agent because this action freezes it. |

The proxy terminal accepts `status`, `restore-sse`, and `exit` after the fault steps. Its counters prove only that faults were injected, not that the connector recovered. Correlate them with server audit IDs and canonical receipts. If any step fails, file the responsible Lane A/Lane B defect, integrate its fix, deploy a new exact SHA, and rerun **all 23**; never combine partial results from different commits. Publish the Phase B `/connect` skill only after human-countersigned `GATE GA PASS`.

## 3. Port this proof to other agents

Hermes is a reference fixture for Envoi's shared queue, credential lifecycle, and connector. It is not the only supported product. For each additional host, use the same `SKILL.md`/JSON contract and repeat identity, owner approval, scoped tools, durable work, restart, expiry/renewal, revoke, and duplicate tests. Then separately prove that host's actual unattended wake mechanism with its app closed. Mark hosts that can only use an open-chat connector as **on demand**. The [draft capability matrix in PR #72](https://github.com/rachelgonsalves821/Envoi/pull/72) tracks Hermes, OpenClaw, Muse, Instinct, ChatGPT Dots and future agents without promising features a provider has not exposed.
