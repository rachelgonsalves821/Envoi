# Gate B-local operator scripts

These are helpers for [`docs/architecture/agent-native-v2/gate-b-local-runbook.md`](../../docs/architecture/agent-native-v2/gate-b-local-runbook.md). They were written during the `7baaf63` and `4ad14b6` runs, where every one of them saved a failed step or a wrong diagnosis.

They are operator tools for a Windows host, not product code. Run them from a clean gate checkout at the gate SHA. Private state lives in `-GateDir` (default `%USERPROFILE%\envoi-gate-b-local`), never in the repository.

| Script | Use |
| --- | --- |
| `start-server.ps1` | The local FileStore server with only the Phase B flags. It writes `gate-sha.txt`, which the other scripts check, and keeps the log UTF-8. |
| `start-https.ps1` | The HTTPS front end on `https://localhost:8443`. It needs `localhost.pem` and `localhost-key.pem` in `-GateDir`. |
| `preflight.mjs` | Read-only checks: `/health` SHA, offered routes, `skill.json`, `SKILL.md` byte-identical, unauthenticated status refused. |
| `prepare-hermes-profile.ps1` | Checks that a new Hermes profile is fresh. It sets `gateway.standalone: true` and enables the API Server with a key that is never printed. |
| `start-openclaw-connector.ps1` | Restarts an activated OpenClaw connector (rows 13–15). It refuses to start unless the gate and the OpenClaw Gateway answer. Not for the first activation, which needs a plain interactive `resume`. |
| `reconnect-openclaw.ps1` | Rows 18–20: checks the saved connection is `revoked`, then runs `connect --new` interactively for an `existing_agent` reconnect. |
| `check.mjs` | Read-only server and helper status: registrations, installations, families, presence, events, helper state. Ids and times only. |
| `secret-scan.mjs` | Searches the given folders for the exact helper secrets and prints only paths and counts. Use it for the row 6 and stop-condition evidence. |
| `hermes-tool-calls.mjs` | What a Hermes chat actually ran: tool names with command or URL arguments, no output. |

Node 24 and the OpenClaw npm prefix default to `C:\envoi-gate\node24` and `C:\envoi-gate\openclaw-npm`. Override them with `-Node24` and `-NpmPrefix`, or with `ENVOI_GATE_NODE24` and `ENVOI_GATE_OPENCLAW_PREFIX`.
