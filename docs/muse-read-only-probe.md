# Personal Muse read-only connection probe

This is a **feasibility test**, not a Muse wake or messaging integration. The Muse identity receives a normal Envoi address, but its first credential can only read a count summary for its own pending work. Do not label this identity “automatically available” until an app-closed fetch and reply are observed separately.

## Before creating a token

1. In the personal Muse account, confirm Custom Connectors can make HTTPS `GET` calls with a privately captured bearer credential. Prepare read-only actions targeting `https://<Envoi host>/api/agent/me` and `https://<Envoi host>/api/agent/work/availability`. The first returns the authenticated address with `scope: "agent_probe"` and `permissions: ["work_probe"]`. The second returns `{ ready, leased, retrying, exhausted, oldestReadyAt, checkedAt }`; it contains no work ID, case ID, message text, file, or credential. Do not add a send or claim action yet.
2. Confirm the selected Envoi HTTPS origin is reachable. Do not put a token in a command argument, environment variable, URL, Muse chat, or this conversation. The browser can redeem the token; Node.js 22 or newer is needed only for the terminal fallback.
3. In Envoi **Agent connections → Enroll an agent**, select **Muse (read-only test)**. Choose a new address. Envoi restricts this runtime to `receive_agent_messages` and creates a one-use enrollment token valid for 15 minutes. It does not make Muse reachable yet.

## Redeem and test

In the same Envoi enrollment dialog, click **Generate five-minute probe credential**. This explicitly redeems the one-use enrollment token. Copy the credential shown once directly into Muse's secure Custom Connector credential field. Closing the dialog clears the displayed credential; the browser does not save it. Do not paste it in Muse chat.

If browser redemption fails, expand **Terminal fallback** before the enrollment token expires. From a current local Envoi checkout run:

```powershell
node scripts/muse-probe-enroll.mjs --api-url https://sinaloa-staging.rachelgonsalves821.workers.dev
```

Paste the one-use enrollment token only at the helper's **hidden-input prompt**. The browser button and helper call the same `POST /api/agent-enroll` endpoint with `runtime: "muse"`; use one path only. Both display the new Envoi address and a single five-minute `agent_probe` bearer credential. The helper does not save the credential. Envoi does not issue a full agent access or refresh token for this enrollment.

Ask Muse to call `GET /api/agent/me`, then `GET /api/agent/work/availability` once. A `200` identity response naming its new Envoi address, followed by a `200` availability response, proves authenticated reachability; an empty inbox legitimately reports `ready: 0`. Confirm both calls and the release SHA in Envoi logs. A model statement without a tool trace is not proof. `401` after five minutes is expected. A new owner-approved **Reconnect runtime** token is required for another probe; reconnect retains the address and revokes the old probe family.

The probe credential is rejected by agent send, work claim, token renewal, full MCP, and case/file APIs. It is tied to one agent inbox, expires after five minutes, and is revoked with that agent's credential family. If Muse cannot privately store a bearer header or call the URL, record the actual product error. Do not widen this token or give Muse a full refresh credential to bypass the limit.

## Next feasibility gates

After one authenticated call, test whether Muse can schedule a read-only check with its app closed. Record two separate incoming Envoi delivery times and the corresponding Muse tool-call times. This establishes polling behavior only. Seek a supported event-triggered wake contract from Meta before promising immediate activation. Sending or replying needs a separate, owner-approved scoped grant and a test of Meta's write-approval classification.
