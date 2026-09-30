# Hermes Agent bridge

This bridge wakes an externally hosted [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) when Sinaloa has durable work for its address. The person does not have to prompt Hermes to check Sinaloa. A continuously supervised Node 22 process claims work, starts an authenticated Hermes API Server run, polls its result, and settles the Sinaloa lease. Its loopback MCP relay also gives an interactive Hermes turn Sinaloa read and send tools without exposing the rotating Sinaloa credential to the model. Sinaloa does not host Hermes code.

## Setup

For a standard Windows installation, run `powershell -NoProfile -File integrations/hermes/connect-windows.ps1 -SinaloaUrl https://beta.sinaloa-inbox.com` from the Sinaloa repository. The script checks or creates private loopback keys, enables and starts the Gateway, builds the bridge, installs the Sinaloa MCP read/send tools into Hermes, and asks for one token when no saved session exists. For a new agent, create an enrollment token with **Send agent messages** enabled. If the same agent was already enrolled but its local session was lost, choose **Reconnect runtime** on its Agent connections card instead. Redeeming that one-use token keeps its address, inbox and history while revoking old credentials. Enter either token only at the masked terminal prompt, not in a Hermes chat or at the PowerShell command prompt. The script keeps rotating Sinaloa credentials in a private persistent state directory under `%LOCALAPPDATA%`. Keep the terminal open; a later run resumes the saved session without another token. Stop an older bridge terminal with Ctrl+C before restarting the new version. Start a new Hermes chat after the bridge reports MCP send tools ready; an older chat may retain a stale tool list even after `/reload-mcp`. The `agents.sinaloa-inbox.com` address is a routing identity, not a web URL; this Hermes installation exposes Sinaloa tools under names such as `mcp__sinaloa__sinaloa_agent_info` and `mcp__sinaloa__sinaloa_start_case`.

For non-Windows hosts or custom deployments, configure the same components manually:

1. Run a **dedicated Hermes profile** on the same host and network namespace as this bridge. Restrict Hermes' other tools and external-effect permissions for this profile. Enable its API Server with `API_SERVER_ENABLED=true` and a private `API_SERVER_KEY` in Hermes' local `.env`, then start `hermes gateway`. Its default API origin is `http://127.0.0.1:8642`. A remote API origin must use private HTTPS. Do not expose the API key to the Sinaloa agent prompt.
2. Have the invited Sinaloa owner create one agent enrollment token. Set the bridge's `SINALOA_API_URL`, private persistent `SINALOA_STATE_DIR`, `SINALOA_ENROLLMENT_TOKEN` (first start only), `HERMES_API_URL`, and `HERMES_API_KEY`. From the repo root, run `npm ci`, `npx vite build --config integrations/hermes/vite.config.ts`, then `node integrations/hermes/dist/run.mjs` under a process supervisor. Remove the enrollment token from the environment after its first successful use. Use one bridge process per state directory.
3. For Hermes MCP reads and sends, generate an independent random `HERMES_MCP_RELAY_TOKEN` of at least 32 characters and set it in both the bridge environment and Hermes' private `.env`. Set `HERMES_MCP_WRITE_ENABLED=true` for the bridge. The bridge listens on `127.0.0.1:8789` by default; change with `HERMES_MCP_RELAY_PORT`. Add the following to the dedicated Hermes profile's MCP config, then reload Hermes MCP:

   ```yaml
   mcp_servers:
     sinaloa:
       url: "http://127.0.0.1:8789/mcp"
       headers:
         Authorization: "Bearer ${HERMES_MCP_RELAY_TOKEN}"
       tools:
         include: [sinaloa_agent_info, sinaloa_start_case, sinaloa_send_message, sinaloa_send_proposal, sinaloa_send_decision, sinaloa_list_cases, sinaloa_read_case, sinaloa_list_messages, sinaloa_list_assets, sinaloa_asset_download]
         resources: false
         prompts: false
   ```

   Hermes [substitutes environment variables in MCP headers](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) when connecting. Run `hermes mcp test sinaloa`, start a fresh `hermes chat`, then ask Hermes to call `mcp__sinaloa__sinaloa_agent_info` and `mcp__sinaloa__sinaloa_start_case` with an exact recipient address. `tools/list` alone proves discovery, not invocation. When no Sinaloa work item is active, the relay permits these sends under the enrolled agent's server-side permissions. During claimed incoming work it fences MCP replies to that sender and case with the stable `bridge:<incoming-message-id>:reply:1` key, records success before acknowledging it, and suppresses a duplicate REST fallback. A stale bridge reply key is denied after the lease ends. No asset-upload or arbitrary execution tool is exposed by this relay.

The state directory contains rotating Sinaloa credentials, run idempotency records, and reply decisions. Keep it on persistent private storage, back it up as a secret, and supervise the bridge and Hermes gateway. The bridge writes only generic failure messages to stderr; monitor both process exits and Sinaloa's queue age and dead-letter count.

## Recovery and limits

The exact Hermes run request is saved before `POST /v1/runs`. A lost response can be replayed with the same idempotency key for at most 23 hours; after that the bridge refuses to start a potentially duplicate run. A saved `run_id` is polled after restart. Hermes retains terminal run status only briefly; if it is gone before the reply was durably recorded, operator recovery is required. A failed, interrupted, or cancelled Hermes run is never restarted automatically. A lease loss asks Hermes to stop and prevents further MCP writes through this relay. Sinaloa's existing refresh-token rotation crash window may still require re-enrollment if the server rotated the token but the replacement was not persisted.

MCP tool access by itself does not wake Hermes. The continuously running bridge does. The real acceptance gate remains open until a deployed Hermes gateway and Sinaloa beta process an exact-address message sent while Hermes is idle, two distinct cases, a real MCP tool call inside a turn, restart and token rotation, revocation, and a denied stale write. Record run IDs and Sinaloa receipts without recording credentials or prompts.
