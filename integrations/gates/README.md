# GA3/A2 local real-service rerun

Tested integration: **14ce3c45c0089dfb4314dcc632afebb3588b5104**.
Result: **seven scenarios passed**. Public result: `evidence/ga3-14ce3c4/summary.json`.

The runner starts a disposable FileStore server through `npm start` and a separate
Node child process running production `startConnection`, `SinaloaConnector` and
`FileBridgeStore` from the tested SHA. The adapter is a controlled local durable
handler; no real Hermes/OpenClaw host or provider is started. Real HTTP fetch is
observed through response clones without mutation.

Protected production sources, root configuration, fixtures and generated artifacts
are compared against the requested SHA. The shipped connector SHA-256 is
`89cc0cbb20bdb3a8dfdcd05ba019f74d589a29db11458a7508adf977f5b63936`, matching
`release.json`. Only the gate driver is compiled separately. Default retry policy
is retained; event/work polling is shortened to 100ms to bound the test. An
explicit setup reconnect binds the disposable installation to Hermes before
testing; later scenarios assert identity/token preservation.

| Scenario | Verified behavior |
| --- | --- |
| Restart | Stop/start connector process; preserve disk credentials/identity; process offline arrivals once without repeating prior work. |
| Outage | Stop npm server; persist DEGRADED/NETWORK_ERROR and retry deadline; restart connector while offline; restart same data/port; recover automatically without enrollment. |
| Pause | Consume pause event; accept/deliver inbound work; no claims once pause is known. |
| Refresh across pause | Restart paused connector with saved access expiry in the past; real rotation succeeds; successor persists; identity/pause retained; zero claims. |
| Held work | Queue outbound behind existing harness gate; pause sender; remove gate; durable hold consumes no attempts/backoff; D1 reply stays queued. |
| Resume | Explicit resume; consume event; deliver held outbound before reply; process reply and fresh arrivals. |
| Revoke | Revoke in-flight handler; real MCP CREDENTIAL_REVOKED persists terminal state and aborts handler; no late completion or further refresh/claim/MCP requests; revoked restart stops before HTTP. |

```powershell
npx vite build --config vite.ga3-worker.config.ts
node integrations/gates/ga3-a2-local.mjs
```

Private directories and owned process trees are removed. Tokens and lease fences
are redacted. The ignored local `result.json` holds detailed request/response and
durable lifecycle evidence; ignored logs capture process stdout/stderr. These
HTTP transcripts stay local. The committed summary contains no HTTP payloads,
credentials, account/agent identifiers or private configuration.

Lane A posts authoritative `GATE GA3 PASS` under build-plan §6. Hosted GA,
PostgreSQL GA4 and real runtime acceptance remain separate gates. No production
code change is included. The contract review carried forward from PR #49 is
extended here; Lane A should integrate this updated evidence/review branch rather
than the older review snapshot, to avoid duplicate scaffolding additions.
