# GA3/A2 local evidence at 478c2d7

The gate is blocked at installed-connector startup. This directory contains a prerequisite reproduction, not a passing lifecycle runner. Restart, outage, pause, held work, resume, refresh across pause and revoke were not run.

Production server, SDK, connector and generated bundle sources match integration SHA `478c2d758f0360704fb96d5940a287b85453f44a`. `npm run build` succeeded from PowerShell and produced no tracked drift. The rebuilt `envoi-connector.mjs` SHA-256 is `e37fe31c3ee6e30cdd72492b5dfeff77455dfd62fc8cd17178ae4bda6a98ccab`, matching `release.json`.

The server was started by `npm start` with disposable FileStore data, no DATABASE_URL, and development authentication. A disposable agent was enrolled using the real phone/TOTP/inbox/enrollment flow in the existing read-only A3 harness. The rebuilt CLI was started against its saved credentials. The same health rejection occurred with the ordinary CLI invocation and with the recorder used for the committed evidence.

Actual response to the connector's `GET /health`: HTTP 200 with `service: "envoi"` and the exact release SHA. `integrations/connector/core.ts:98` instead accepts only `service === "sinaloa"`. Before runtime adapter preflight, the connector reports `ENVOI_UNREACHABLE`, waits/retries and persists `DEGRADED` / `NETWORK_ERROR`. Both live status and doctor remain available; no re-enrollment or token rotation occurred. No real Hermes/OpenClaw host or provider was started.

Evidence:

- `evidence/ga3-478c2d7/result.json`: exact request, response status/headers/body, live status and doctor snapshots, bundle hash, tested SHA and explicit unrun scenarios.
- `evidence/ga3-478c2d7/connector.log`: startup rejection, automatic retry and control stop.
- `evidence/ga3-478c2d7/server.log`: real npm start and local server startup.

Reproduce from PowerShell in an own worktree at the target SHA (or this evidence-only branch, whose production files are identical):

```powershell
npm run build
node --check integrations/gates/ga3-a2-startup-probe.mjs
node integrations/gates/ga3-a2-startup-probe.mjs
# Expected exit code: 1; inspect result.json for the reproduced mismatch.
```

Node 22+ and npm installed beside Node are required. The probe validates all tracked paths against the exact SHA, excluding only this evidence directory, and verifies the bundle hash. A temporary Node `--import` observer records only the connector's actual health exchange using a cloned response; it does not alter the HTTP request or response. Credentials stay in the disposable private directory, are redacted from evidence, and are deleted after stopping the owned processes. An infrastructure error is recorded separately and must not be treated as a reproduced mismatch.

Follow-up fix task: Lane B corrects the consumer health identity check and adds a real-service health regression assertion, then rebuilds the downloads and follows L1/L2. After integration, L5 requires the whole GA3/A2 gate on one new exact integration SHA. These logs do not authorize GA3 PASS at 478c2d7. No production source was patched to bypass the gate failure.
