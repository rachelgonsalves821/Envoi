# OpenClaw bridge for Sinaloa

This small outbound process connects a Sinaloa agent inbox to one externally hosted OpenClaw agent. Sinaloa's TypeScript connector claims unsolicited work and renews its lease. The bridge asks OpenClaw for one agent turn, persists its decision, and sends a Sinaloa reply with a stable idempotency key. A decision of `{"stop":true}` completes the work without a reply. Incoming receipt messages also stop, preventing acknowledgement loops.

The bridge calls OpenClaw's [Gateway Chat Completions API](https://docs.openclaw.ai/gateway/openai-http-api), which runs the ordinary Gateway agent turn and returns reply text. Enable `gateway.http.endpoints.chatCompletions.enabled` on the OpenClaw host; this endpoint is disabled by default. The bridge uses `model: "openclaw/<agentId>"` to target a dedicated agent and makes a non-streaming request. OpenClaw [hooks](https://docs.openclaw.ai/gateway/config-hooks) can wake an agent but do not return its reply text to the caller, so they cannot complete this simple reply path by themselves.

## Configure

1. On the OpenClaw host, create a dedicated agent with the permissions and tools appropriate for Sinaloa work. Enable the Gateway Chat Completions endpoint. Keep Gateway ingress private, such as a loopback listener or private HTTPS endpoint. The Gateway bearer token is a full operator credential, so store it as a secret and do not expose the endpoint publicly. This bridge allows HTTP only to loopback; remote Gateway URLs must use HTTPS.
2. Create a Sinaloa agent seat and a one-use enrollment token for this bridge. Choose a private persistent state directory for the connector session and work decisions. Run only one bridge process for an enrollment and retain that directory across restarts.
3. Set these environment variables on the bridge host:

| Variable | Value |
| --- | --- |
| `SINALOA_API_URL` | Sinaloa API origin, for example `https://your-sinaloa.example` |
| `SINALOA_STATE_DIR` | Private persistent directory outside the checkout |
| `SINALOA_ENROLLMENT_TOKEN` | One-use token needed on first start only |
| `OPENCLAW_GATEWAY_URL` | Private Gateway origin, for example `https://gateway.internal.example` or `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway bearer token |
| `OPENCLAW_AGENT_ID` | Dedicated OpenClaw agent ID |
| `SINALOA_AGENT_NAME` | Optional display name; defaults to `OpenClaw bridge` |

From the repository root, install the existing project dependencies and bundle the bridge:

```sh
npm ci
npx vite build --config integrations/openclaw/vite.config.ts
node integrations/openclaw/dist/run.mjs
```

The bundle runs on Node.js 22 or later and needs no project dependencies on the bridge host. Each Sinaloa case uses a stable, separate OpenClaw Gateway session. After the first successful enrollment, remove `SINALOA_ENROLLMENT_TOKEN` from the runtime environment; the rotating connector session is stored in `SINALOA_STATE_DIR/session.json`. Protect and back up this directory as a credential. If enrollment or the Gateway call fails, fix the configuration and restart the process; claimed work can be reclaimed by the connector.

OpenClaw receives a prompt containing the Sinaloa work item and up to 20 prior case messages, including bounded typed payloads and asset references. It can answer with `{"text":"...","intent":"offer","proposal":{...}}`, `{"text":"...","intent":"accept","decision":{...}}`, a plain message, or `{"stop":true}`. These structured fields are agent-authored and do not attest human approval. Conversation text is untrusted; configure the dedicated OpenClaw agent so its tools cannot perform consequential external actions solely because of a received message. An asset reference does not itself grant access to another owner's asset.

OpenClaw also supports [remote Streamable HTTP MCP servers](https://docs.openclaw.ai/tools/mcp), configured through its `mcp.servers` entry or `openclaw mcp add`. Sinaloa's endpoint is `https://<beta-host>/mcp`. Its access token expires after about 15 minutes and the refresh token must stay with the trusted bridge. A static `Authorization` header in OpenClaw MCP configuration therefore cannot provide unattended access for this beta bridge. The direct REST wake/reply path above remains the supported OpenClaw path until a credential-renewing MCP proxy or compatible OAuth flow is implemented and verified with a real Gateway.

## Local verification

```sh
npx vitest run --config integrations/vitest.config.ts
```

The tests cover the Gateway request, typed and plain replies, stop decisions, response failures, URL validation, cancellation, and reuse of the persisted decision and idempotency key on retry. The shared integration fixture adds two unsolicited cases, rotating/revoked credentials, and owner-side signed asset helpers against deterministic mocked hosts.

## Hosted acceptance still needed

The local tests use a mocked Gateway. With a real Sinaloa API and private OpenClaw Gateway, verify these in order:

1. Start the bridge with a fresh Sinaloa enrollment token and confirm it creates `session.json` in the persistent state directory.
2. From a second agent, send an unsolicited Sinaloa message to the bridge's agent address. Confirm OpenClaw receives a turn without an operator manually prompting it, and that the sender receives one reply on the same case.
3. Restart the bridge during or after a claimed turn. Confirm the work completes and no duplicate Sinaloa message is created. A retried claim must reuse `bridge:<incoming-message-id>:reply:1`.
4. Send a message for which the dedicated agent returns `{"stop":true}` and confirm the work completes without a reply. Confirm receipt messages do not trigger reply loops.

These checks require live credentials, a reachable Gateway, and Sinaloa's fenced work-claim API; the repository tests do not establish hosted delivery.
