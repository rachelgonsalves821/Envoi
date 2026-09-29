# Remote agent MCP endpoint (implementation status)

Sinaloa serves a stateless MCP Streamable HTTP endpoint at `https://<beta-host>/mcp`. It implements the 2025-11-25 handshake-era JSON-RPC request/response path. `POST /mcp` accepts `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. Clients send `Accept: application/json, text/event-stream`, `Content-Type: application/json`, and `Authorization: Bearer <agent access token>`. After initialization they send `MCP-Protocol-Version: 2025-11-25`. A missing version header is interpreted as 2025-03-26 for the backwards-compatibility rule in the transport specification; an unsupported explicit version is rejected. The server does not issue an MCP session ID, and `GET /mcp` returns 405 because this endpoint does not offer server-initiated SSE. Incoming work is recovered through `sinaloa_claim_work` or the durable outbound connector, not MCP push.

The access token is the existing agent access credential issued on enrollment. It expires after 15 minutes by default. A trusted connector renews it with its one-use refresh credential at `POST /api/agent-token` (body `{ "grantType": "refresh_token", "agentRefreshToken": "..." }`) and keeps both credentials outside model prompts and external model providers. Credential revocation, agent pause, and permission changes take effect on the next MCP request; the underlying REST route checks the credential again for tool operations. This is bearer-token compatibility for controlled beta clients; OAuth discovery and browser-hosted sign-in are not implemented.

### Trusted xAI relay contract

Rachel's trusted connector owns the full access and refresh credentials in its secret store. xAI receives function names, JSON argument schemas, tool-call arguments, and returned tool content only; it receives **no Sinaloa credential or `/mcp` Authorization header**. The connector checks the requested tool against the authenticated agent's `tools/list` set, checks the access token expiry before **each** forwarded call (including calls late in a model turn), and rotates with `/api/agent-token` when needed. It forwards the same tool name, arguments, and idempotency key to hosted `/mcp`. If an access token expires between check and forwarding, the connector may refresh once and retry that same logical call. A pause or revoke failure stops forwarding; the connector must not switch identities or mint a new idempotency key. Rotation is one-use and must be saved durably before another call. A crash after successful rotation but before local durable save requires re-enrollment under the current server contract.

The external model path has no Sinaloa credential scope because it holds no Sinaloa credential. Provider-direct hosted MCP with a full agent bearer is outside the beta contract. If a provider requires direct remote MCP authentication, a separately reviewed scoped delegation or OAuth contract is needed before enabling that mode.

Tools are listed only when the authenticated agent has the matching permission. No tool accepts a caller-supplied inbox or sender-agent ID. All read and write operations use the caller's dedicated inbox and forward to the canonical REST route with the same bearer credential. Tool results contain a JSON text item. REST responses appear as `{ "status": <HTTP status>, "payload": <REST body> }`; a failed REST operation returns MCP `isError: true` with the REST status. The `sinaloa_agent_info` tool returns the agent ID, inbox ID, address, and permissions directly.

| Tool | Key arguments | Permission |
| --- | --- | --- |
| `sinaloa_agent_info` | none | active credential |
| `sinaloa_list_cases` | optional `limit`, `before` | send or receive |
| `sinaloa_read_case` | `caseId` | send or receive |
| `sinaloa_list_messages` | optional `caseId`, `limit`, `before` | send or receive |
| `sinaloa_start_case` | `recipientAddress`, `text`, `idempotencyKey`; optional protocol `intent`; creates typed `request` | send |
| `sinaloa_send_message` | the same arguments plus required `caseId` | send |
| `sinaloa_send_proposal` | `recipientAddress`, `caseId`, `text`, structured `proposal`, `idempotencyKey` | send |
| `sinaloa_send_decision` | `recipientAddress`, `caseId`, `text`, `decision`, `idempotencyKey`; `counteroffer` creates typed `counterproposal`; optional `proposalMessageId`, `details` | send |
| `sinaloa_send_completion` | `recipientAddress`, `caseId`, `text`, `result`, `idempotencyKey`; optional verified human `authorityBasis`, `evidenceRefs` | send |
| `sinaloa_list_assets` | optional `caseId`; grant-filtered metadata | send or receive |
| `sinaloa_begin_asset_upload` | `filename`, `mimeType`, `size`, SHA-256 base64 checksum, `idempotencyKey`; optional `caseId` | create assets |
| `sinaloa_complete_asset_upload` | `assetId` | create assets |
| `sinaloa_grant_asset` | `assetId`, `caseId`, `recipientAgentId`, `idempotencyKey` | create assets |
| `sinaloa_asset_download` | `assetId` | send or receive |
| `sinaloa_claim_work` | none | receive |
| `sinaloa_renew_work` | `workId`, `leaseToken` | receive |
| `sinaloa_acknowledge_work` / `sinaloa_complete_work` | `workId`, `leaseToken`, `idempotencyKey` | receive |
| `sinaloa_fail_work` | `workId`, `leaseToken`, `retryable`; optional `reasonCode` | receive |

`sinaloa_start_case` derives a stable new case ID from the authenticated agent and idempotency key, then sends the first message through the native exact-address route. Repeating that key and payload returns the same message and case. `sinaloa_send_message` requires an explicit case ID so two conversations between the same pair do not collapse into one. Work tools preserve REST lease fencing and settlement idempotency; see [Agent Work Claim API](agent-work-claim-api.md).

Proposal, counterproposal, decision, and completion tools send typed native messages through the same REST route and update the same shared case visible in both participant inboxes. Agent-authored decision claims are unverified; verified approval originates only from an authenticated human `POST /api/inboxes/:id/cases/:caseId/actions` call. A completion that claims that approval must name its exact action ID and result. Asset tools never put file bytes into MCP JSON. Begin upload returns a short-lived signed binary PUT URL and immutable metadata; the caller uploads directly to that URL, completes verification and scanning, explicitly grants the case asset to the counterparty with `sinaloa_grant_asset`, then asks for a signed download URL. The grant is a durable server record; the URL is not the grant. Downloads fail until the scanner marks the asset clean. Creator, case pair, tenant, pause, block, and credential checks remain in REST. Repeating a begin-upload or grant request with the same idempotency key and matching payload returns the same reservation or grant; a conflicting payload returns `409`.

### Wire errors and pagination

Missing, expired, paused, or revoked bearer: HTTP `401` with `WWW-Authenticate`. Unsupported explicit protocol version: HTTP `400`. Invalid tool name, unavailable permission, or malformed arguments: JSON-RPC `-32602`. Canonical REST denial is HTTP `200` at the MCP transport level with `result.isError:true` and JSON text containing `{status,error,message}`; examples include case-pair injection `403 CASE_PARTICIPANT_MISMATCH`, blocked asset download `403 AGENT_BLOCKED`, unclean asset `423 ASSET_NOT_CLEAN`, and conflicting retry `409 IDEMPOTENCY_CONFLICT`. A transport or internal tool failure returns `isError:true` without internal details. Tool outputs do not contain access or refresh credentials.

`sinaloa_list_cases` and `sinaloa_list_messages` accept `limit` (1–100) and `before`, forwarded unchanged to the canonical REST pagination. `sinaloa_list_assets` accepts `caseId` for the same grant-filtered REST list. `sinaloa_agent_info` is the one direct result shape (`{agentId,inboxId,address,permissions}`); REST-backed tools return `{status,payload}` in the JSON text item.

The source of truth for argument schemas is `src/agent-mcp.js` and `tools/list`. The wire behavior follows the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) specifications. Local protocol, authorization, isolation, two-case, retry, and fenced-settlement tests are in `test/agent-mcp.test.js`.

## Remaining B3 beta work

- Prove real OpenClaw and xAI API client interoperability, including trusted relay token renewal and revocation, on the deployed HTTPS origin. The local JSON-RPC wire tests do not prove client compatibility. Browser-hosted MCP clients that require OAuth discovery need that additional authorization path; current beta bearer credentials work with controlled bridge clients.
- Verify the hosted Cloudflare container, PostgreSQL, R2, scanner, WorkOS, two-owner UI, and unattended inbound wake/reply fixture. MCP discovery by itself does not perform inbound work.
