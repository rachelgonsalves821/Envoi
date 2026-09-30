# Hermes Agent bridge

This bridge wakes an externally hosted [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) when Sinaloa has durable work for its address. The person does not have to open Hermes or prompt it to check Sinaloa. A continuously supervised Node 22 process claims work, starts an authenticated Hermes API Server run, polls its result, and settles the Sinaloa lease. Sinaloa does not host Hermes code.

## Setup

1. Run a **dedicated Hermes profile** on the same host and network namespace as this bridge. Restrict Hermes' other tools and external-effect permissions for this profile. Enable its API Server with `API_SERVER_ENABLED=true` and a private `API_SERVER_KEY` in Hermes' local `.env`, then start `hermes gateway`. Its default API origin is `http://127.0.0.1:8642`. A remote API origin must use private HTTPS. Do not expose the API key to the Sinaloa agent prompt.
2. Have the invited Sinaloa owner create one agent enrollment token. Set the bridge's `SINALOA_API_URL`, private persistent `SINALOA_STATE_DIR`, `SINALOA_ENROLLMENT_TOKEN` (first start only), `HERMES_API_URL`, and `HERMES_API_KEY`. From the repo root, run `npm ci`, `npx vite build --config integrations/hermes/vite.config.ts`, then `node integrations/hermes/dist/run.mjs` under a process supervisor. Remove the enrollment token from the environment after its first successful use. Use one bridge process per state directory.
3. For Hermes MCP reads, generate an independent random `HERMES_MCP_RELAY_TOKEN` of at least 32 characters and set it in both the bridge environment and Hermes' private `.env`. The bridge listens on `127.0.0.1:8789` by default; change with `HERMES_MCP_RELAY_PORT`. Add the following to the dedicated Hermes profile's MCP config, then reload Hermes MCP:

   ```yaml
   mcp_servers:
     sinaloa:
       url: "http://127.0.0.1:8789/mcp"
       headers:
         Authorization: "Bearer ${HERMES_MCP_RELAY_TOKEN}"
       tools:
         include: [sinaloa_agent_info, sinaloa_list_cases, sinaloa_read_case, sinaloa_list_messages, sinaloa_list_assets, sinaloa_asset_download]
         resources: false
         prompts: false
   ```

   Hermes [substitutes environment variables in MCP headers](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) when connecting. Run `hermes mcp test sinaloa` and verify an authenticated `sinaloa_agent_info` call from a Hermes turn. `tools/list` alone proves discovery, not invocation.
4. Collaboration MCP writes are optional and disabled by default. For a dedicated profile, set `HERMES_MCP_WRITE_ENABLED=true` on the bridge and add `sinaloa_send_message`, `sinaloa_send_proposal`, and `sinaloa_send_decision` to Hermes' `tools.include`. The relay accepts those writes only during the matching live Sinaloa work lease and only with the prompt's stable `bridge:<incoming-message-id>:reply:1` key. It records success before acknowledging the MCP call; the bridge suppresses a duplicate REST fallback. No asset-upload or arbitrary execution tool is exposed by the relay.

The state directory contains rotating Sinaloa credentials, run idempotency records, and reply decisions. Keep it on persistent private storage, back it up as a secret, and supervise the bridge and Hermes gateway. The bridge writes only generic failure messages to stderr; monitor both process exits and Sinaloa's queue age and dead-letter count.

## Recovery and limits

The exact Hermes run request is saved before `POST /v1/runs`. A lost response can be replayed with the same idempotency key for at most 23 hours; after that the bridge refuses to start a potentially duplicate run. A saved `run_id` is polled after restart. Hermes retains terminal run status only briefly; if it is gone before the reply was durably recorded, operator recovery is required. A failed, interrupted, or cancelled Hermes run is never restarted automatically. A lease loss asks Hermes to stop and prevents further MCP writes through this relay. Sinaloa's existing refresh-token rotation crash window may still require re-enrollment if the server rotated the token but the replacement was not persisted.

MCP tool access by itself does not wake Hermes. The continuously running bridge does. The real acceptance gate remains open until a deployed Hermes gateway and Sinaloa beta process an exact-address message sent while Hermes is idle, two distinct cases, a real MCP tool call inside a turn, restart and token rotation, revocation, and a denied stale write. Record run IDs and Sinaloa receipts without recording credentials or prompts.
