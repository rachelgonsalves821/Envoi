# Phase A hosted gate: operator evidence worksheet

Use this with [the operator runbook](PHASE-A-HOSTED-RUNBOOK.md) for the 23 observations in v3 §29. This is a **blank recording aid**, not a gate result. The authoritative evidence file is maintained by Lane A at `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md`; the human countersigns `GATE GA PASS` only after every row is proved on one hosted staging release.

## Candidate and host

| Field | Record without secrets |
| --- | --- |
| Integration commit SHA (40 characters) | UNPROVEN |
| Hosted `/health` and `/ready` SHA match | UNPROVEN |
| Hosted database, R2 and scanner readiness | UNPROVEN |
| Connector bundle SHA-256 matches `release.json` | UNPROVEN |
| Disposable Hermes profile and explicit model provider | UNPROVEN |
| Real model turn in that profile | UNPROVEN |
| Distinct staging owner and sender | UNPROVEN |
| Private connector state directory preserved for restart | UNPROVEN |
| UTC start/end and operator | UNPROVEN |

Do not record tokens, codes, cookies, provider account details, private URLs, full message bodies, or raw request/response logs here. Keep raw evidence in the approved private location. Redacted request/audit IDs, message/work IDs, receipt IDs, UTC timestamps and the exact release SHA are appropriate. Use `PASS`, `FAIL`, or `UNPROVEN` in each row; a local unit test, proxy counter, open browser, `tools/list`, or presence label alone cannot make a row PASS.

## One-release observation ledger

| # | Required hosted observation | Status | UTC / redacted IDs / canonical evidence |
| --- | --- | --- | --- |
| 1 | Disposable Hermes connects with the approved staging identity and authenticated Envoi tool access. | UNPROVEN | — |
| 2 | A distinct staging sender sends native work; a real Hermes model turn acts and produces one canonical reply and settlement receipt. | UNPROVEN | — |
| 3 | Stop and restart only the connector while preserving its private state. | UNPROVEN | — |
| 4 | Same identity/address/credential family continues; offline-arriving work is processed once without duplicate canonical output. | UNPROVEN | — |
| 5 | Human pauses the disposable test agent. | UNPROVEN | — |
| 6 | Sender submits new work while that agent is paused. | UNPROVEN | — |
| 7 | Work remains durable and held; the agent cannot claim or send. | UNPROVEN | — |
| 8 | Held work does not consume an attempt or enter dead-letter. | UNPROVEN | — |
| 9 | Authentication refresh succeeds during pause for status/reachability only. | UNPROVEN | — |
| 10 | Human resumes the same agent. | UNPROVEN | — |
| 11 | Held work becomes claimable immediately and preserves case ordering. | UNPROVEN | — |
| 12 | Hermes processes it once with one canonical reply and settlement receipt. | UNPROVEN | — |
| 13 | Loopback proxy drops exactly one successful refresh response after the server commits the rotation. | UNPROVEN | — |
| 14 | Connector retries using the same durably persisted `rotationId`, not a new rotation. | UNPROVEN | — |
| 15 | Server returns the identical successor credentials; compare privately and record only equality. | UNPROVEN | — |
| 16 | Rolling refresh expiry advances; record only nonsecret timestamps. | UNPROVEN | — |
| 17 | Proxy cuts the SSE stream and blocks its reconnect while authenticated REST remains available. | UNPROVEN | — |
| 18 | New eligible work is claimed and processed by bounded safety polling without an SSE event. | UNPROVEN | — |
| 19 | A pre-effect handler failure creates retry-delayed work with a server `nextAvailableAt`. | UNPROVEN | — |
| 20 | With SSE still blocked, connector processes that same work when eligible, once, without a new event. | UNPROVEN | — |
| 21 | Human revokes the disposable credential family using the staging agent-wide control. | UNPROVEN | — |
| 22 | Connector enters terminal `REVOKED` and does not silently re-enroll. | UNPROVEN | — |
| 23 | Later refresh, claim, send, MCP write and previously leased late settlement all fail; no new canonical output appears. | UNPROVEN | — |

## Fault and outcome correlation

The proxy's `refreshResponsesDropped: 1` and `sseStreamsCut > 0` prove injection only. Link each counter to the same connector's persisted rotation/cursor state, server audit/request IDs and canonical outcome receipts. For steps 19–20, distinguish a delayed retry from a second work item. For step 23, record a denial for **each** operation named in the row, including the late settlement. Do not publish credential equality values or raw authorization headers.

If a row fails, mark the gate FAIL, identify the Lane A or Lane B contract involved, integrate a fix, deploy a new exact SHA, and restart all 23 observations. Do not combine rows from different SHAs. Leave the worksheet UNPROVEN when the real provider, host, second human, or countersign is unavailable.
