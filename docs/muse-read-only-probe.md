# Personal Muse read-only connection probe

This is a **feasibility test**, not a Muse wake or messaging integration. The Muse identity receives a normal Envoi address, but its first credential can only read a count summary for its own pending work. Do not label this identity “automatically available” until an app-closed fetch and reply are observed separately.

## Before creating a token

1. In the personal Muse account, confirm Custom Connectors can make an HTTPS `GET` with a privately captured bearer credential. Prepare a connector action targeting `https://<Envoi host>/api/agent/work/availability`. Its JSON response is `{ ready, leased, retrying, exhausted, oldestReadyAt, checkedAt }`; it contains no work ID, case ID, message text, file, or credential. Do not add a send or claim action yet.
2. Use a current local Envoi checkout with Node.js 22 or newer. Keep the terminal private. Confirm the selected Envoi HTTPS origin is reachable. Do not put a token in a command argument, environment variable, URL, Muse chat, or this conversation.
3. In Envoi **Agent connections → Enroll an agent**, select **Muse (read-only test)**. Choose a new address. Envoi restricts this runtime to `receive_agent_messages` and creates a one-use enrollment token valid for 15 minutes. It does not make Muse reachable yet.

## Redeem and test

Run from the repository checkout:

```powershell
node scripts/muse-probe-enroll.mjs --api-url https://www.envoi-agents.com
```

Paste the one-use enrollment token only at the helper's **hidden-input prompt**. The helper calls `POST /api/agent-enroll` with `runtime: "muse"`, then displays the new Envoi address and a single five-minute `agent_probe` bearer credential. Paste that credential directly into Muse's secure Custom Connector credential field; do not paste it in Muse chat. The helper does not save the credential. Envoi does not issue a full agent access or refresh token for this enrollment.

Ask Muse to call its configured `GET /api/agent/work/availability` tool once. A `200` response with the six fields above proves authenticated reachability; an empty inbox legitimately reports `ready: 0`. Confirm the call and release SHA in Envoi logs. A model statement without a tool trace is not proof. `401` after five minutes is expected. A new owner-approved **Reconnect runtime** token is required for another probe; reconnect retains the address and revokes the old probe family.

The probe credential is rejected by agent send, work claim, token renewal, full MCP, and case/file APIs. It is tied to one agent inbox, expires after five minutes, and is revoked with that agent's credential family. If Muse cannot privately store a bearer header or call the URL, record the actual product error. Do not widen this token or give Muse a full refresh credential to bypass the limit.

## Next feasibility gates

After one authenticated call, test whether Muse can schedule a read-only check with its app closed. Record two separate incoming Envoi delivery times and the corresponding Muse tool-call times. This establishes polling behavior only. Seek a supported event-triggered wake contract from Meta before promising immediate activation. Sending or replying needs a separate, owner-approved scoped grant and a test of Meta's write-approval classification.
