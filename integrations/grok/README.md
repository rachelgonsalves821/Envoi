# Grok-backed Sinaloa bridge

This customer-hosted process polls Sinaloa's durable work API, sends each new case message to xAI's [Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses), and sends a typed reply through the fenced connector. It is for a Grok model reached through an **xAI API key**; it is not a consumer Grok-app integration. A running process is needed for unsolicited work because remote MCP tool discovery does not push messages into a model.

1. In the Sinaloa human UI, create an agent enrollment token with send and receive permissions; add `create_assets` if this agent will share files. Configure an xAI API key in your local secret manager or process environment. Keep both credentials out of prompts, source files and command arguments.
2. On a persistent machine with Node.js 22+ and this repository installed, build the bridge:

   ```sh
   npm ci
   npx vite build --config integrations/grok/vite.config.ts
   ```

3. Set `SINALOA_API_URL` to the beta HTTPS API origin, `SINALOA_STATE_DIR` to a private persistent directory, `XAI_API_KEY`, and `SINALOA_ENROLLMENT_TOKEN` for the first run. Optionally set `XAI_MODEL` (defaults to `grok-4.7`). Set `SINALOA_MCP_URL` to `https://<beta-host>/mcp` to give each xAI Responses turn agent-info, case-read and message-read MCP tools. Immediately before each turn, the bridge uses its renewable local agent credential to mint a five-minute, case-scoped MCP read token. Only that scoped token goes to xAI; its lifetime covers the two-minute request timeout. The refresh token remains on the bridge host. Start one process for this enrollment:

   ```sh
   node integrations/grok/dist/run.mjs
   ```

   Remove `SINALOA_ENROLLMENT_TOKEN` from the process environment after enrollment. The bridge stores rotating Sinaloa credentials and per-message reply decisions under `SINALOA_STATE_DIR`; back up and restrict this directory. Run it under a process supervisor so it restarts after a crash. Do not run two copies against the same state directory or enrollment.

4. Send a native message to this agent's exact address from a second enrolled agent. The bridge claims work after delivery, calls xAI, sends a reply using the source case ID, and marks processing complete. Stop and restart it while a message is queued to check catch-up. To test token rotation, keep it running past the short access-token lifetime. To test revocation, revoke the agent credential in Sinaloa and confirm processing stops.

The model receives the latest 20 case messages plus the current message, including bounded structured payloads and asset references. It can answer with `{"text":"...","intent":"offer","proposal":{...}}`, `{"text":"...","intent":"accept","decision":{...}}`, a plain message, or `{"stop":true}`. Proposal and decision content is agent-authored; it does not attest human approval. Receipt messages stop automatically. The xAI request sets `store:false`; check xAI's current data-handling terms for your account. A saved full decision is reused if Sinaloa retries a claim, so a server interruption does not create a second canonical reply. A crash *during* a model call before its decision is saved can repeat that model call. With MCP configured, every non-receipt turn must return a completed case-read MCP call before the bridge accepts its reply. The MCP tool list defaults to agent-info, one-case and message reads. The bridge retains the sole send path and does not grant the model write or signed-asset tools.

The bridge uses direct REST for wake/reply. With `SINALOA_MCP_URL`, it includes a [remote MCP tool](https://docs.x.ai/developers/tools/remote-mcp) in each xAI Responses request. Run `npx vitest run --config integrations/vitest.config.ts` for deterministic bridge and MCP invocation-harness tests. To verify a **real xAI-to-hosted-Sinaloa MCP call**, start the bridge once to enroll, set `SINALOA_MCP_URL` to the public HTTPS `/mcp` endpoint, and run:

```sh
node integrations/grok/dist/mcp-smoke.mjs
```

The smoke command mints an agent-info-only MCP read token, allows only `sinaloa_agent_info` for that xAI request, requires a completed `mcp_call` item without an error, and checks that Grok reports the enrolled agent address returned by the tool. The refresh token stays in the local state directory. The local Vitest fixture simulates a provider making that tool request and rejects a response that merely echoes the expected address without a call. It is **not** hosted proof. For acceptance, record the smoke command's success alongside a matching hosted Sinaloa `/mcp` request in server logs, then send two independent cases with typed proposal and decision replies, restart during one settlement, wait through token rotation, and verify revocation stops future calls. xAI's [tool usage documentation](https://docs.x.ai/developers/tools/tool-usage-details) distinguishes attempted calls from successful calls; a request body containing `type: "mcp"` alone proves only configuration. A single handed-off token expires after five minutes; the bridge mints a new scoped token for each turn. The shared bridge code is in `integrations/agent-bridges/`; OpenClaw uses a separate adapter over that contract.

## Clean case file exchange

The model receives asset IDs, never raw file bytes or signed storage URLs. For agent-initiated sharing during normal work, create a private JSON manifest on the bridge host with files under the same directory:

```json
{"files":[{"handle":"report","path":"report.txt","mimeType":"text/plain","sha256":"64 lowercase hex characters for the exact file bytes"}]}
```

Set `SINALOA_ASSET_MANIFEST_PATH` to that manifest before starting the bridge. The host owner approves exact bytes by SHA-256; the model sees only the handle and filename. It may return `{"text":"Here is the report","intent":"message","assetHandle":"report"}` for an incoming case message. The bridge takes the case and recipient from authenticated claimed work, verifies the file again, uploads and scans it, grants it to that case's counterparty, and sends one asset-ID announcement. A retried claim reuses the same saved decision and idempotency key. The enrolled agent needs `create_assets` permission; live R2 and scanner acceptance is still required.

For an operator-triggered exchange, stop the bridge temporarily so this command has exclusive access to its rotating session. Set `SINALOA_CASE_ID`, `SINALOA_RECIPIENT_AGENT_ID`, `SINALOA_RECIPIENT_ADDRESS`, `SINALOA_ASSET_PATH`, `SINALOA_ASSET_MIME_TYPE`, `SINALOA_ASSET_TEXT` and one stable `SINALOA_ASSET_KEY` in the process environment. Keep `SINALOA_API_URL` and `SINALOA_STATE_DIR` set, then run:

```sh
node integrations/grok/dist/share-asset.mjs
```

The command reserves a signed upload, PUTs the bytes, requires a clean scan, grants the case asset to the bound counterparty, and sends a native message with its asset ID. Reuse the same key when retrying an uncertain result, then restart the bridge. The other owner can discover the granted asset and request a signed download through their own authorized inbox. This path requires the P2 server grant contract and a reachable scanner/storage service.

For the hosted xAI file-journey check, use the recipient agent's separate state directory and set `SINALOA_CASE_ID` plus `SINALOA_EXPECTED_ASSET_ID` to the shared case and the ID printed by `share-asset.mjs`. Run `node integrations/grok/dist/mcp-smoke.mjs`. This mode mints a case-scoped read token, asks xAI to call only `sinaloa_list_messages`, and requires both a completed MCP call and the expected asset ID in the answer. The expected ID stays out of the model prompt. Match this result to the hosted `/mcp` request and the recipient's granted asset download in server logs. The probe never sends the file bytes or a signed storage URL to xAI.
