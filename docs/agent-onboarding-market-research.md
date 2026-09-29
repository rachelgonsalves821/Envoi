# Research: making an existing agent easy to connect to Sinaloa

Research date: 2026-09-28. This is a product and architecture recommendation, not a change to Rachel's in-progress PRD. Companion implementation proposal: [agent-connectivity-beta.md](agent-connectivity-beta.md).

## The decision to make first

An **agent identity** (address, permissions, inbox and history) can live on Sinaloa continuously even if the **agent runtime** (model loop, tools and customer secrets) lives elsewhere or sleeps. Messages wait durably while the runtime is offline; availability affects response time, not whether a message exists. This is the cleanest way to connect agents users already built in Python, TypeScript, LangGraph, CrewAI, Letta or another host.

If Sinaloa also runs arbitrary customer agent code, it becomes a compute host. That entails building isolated execution, image/source deployment, model/tool secret management, egress policy, metering, scheduling, crash recovery and abuse controls. Several established products do this, but it is a distinct product line and should not be hidden inside basic enrollment.

Recommended beta: **Sinaloa hosts the collaboration service; the user hosts their existing agent and runs a small Sinaloa connector beside it.** Give a second, managed-hosting path later for users who lack an agent runtime. The beta UI should make this separation plain: “Connect an existing agent” is available now; “Host an agent with Sinaloa” is future work.

## What other platforms actually do

| Platform / pattern | Where the agent runs and how it connects | Lesson for Sinaloa |
| --- | --- | --- |
| [CrewAI AMP](https://docs-platform.crewai.com/platform/en/introduction) | Managed deployment of crew code through GitHub, Studio or CLI, then a generated API to call the deployed crew. | A one-click managed deployment is possible, but it requires owning agent code builds and runtime operations. Useful later as an optional hosted lane. |
| [LangSmith Agent Server](https://docs.langchain.com/langsmith/data-plane) | Hosted/hybrid/self-hosted agent server with separate API and background workers. PostgreSQL stores runs/state; Redis wakes workers and carries transient streaming signals. | Keep canonical work in durable storage; treat a stream or notification as a wake-up. Separate the collaboration API from agent execution capacity. |
| [Letta App Server](https://docs.letta.com/self-hosting/app-server) | An always-on harness can run separately and be reached by SDK/WebSocket. Letta explicitly separates where agent state is stored from where the harness executes; its remote router can reach a remote environment. | Identity/state need not move when the runtime moves. The integration SDK should hide transport and reconnect details. |
| [LiveKit Agents](https://docs.livekit.io/deploy/custom/deployments/) | Agent server workers may run on LiveKit Cloud or customer infrastructure. They register over an outbound WebSocket and accept dispatched jobs; no inbound public port is required. | An outbound connector is a strong default for customer agents behind NAT/firewalls. Hosted runtime can be offered separately. |
| [Official OpenAI Agents SDK docs](https://developers.openai.com/api/docs/guides/agents/sdk) | The SDK runs the agent loop inside the customer's application; the customer server owns deployment, state, tools and approvals. A separate managed Agents API is another runtime option. | “Built with an agent SDK” does not mean the agent is permanently online or discoverable. Sinaloa should integrate with the application's handler, not assume the model provider hosts a mailbox. |
| [A2A protocol](https://a2a-protocol.org/dev/specification/) | Standardizes agent cards, task/message exchange, polling, streaming and optional push notifications for separately hosted agents. | Provide an adapter for interoperability after the core Sinaloa connector works. A2A is a wire contract, not a substitute for Sinaloa's identity, durable inbox and human view. |
| [MCP Streamable HTTP](https://ts.sdk.modelcontextprotocol.io/server) | Makes tools/resources callable by compatible hosts over HTTP, optionally with SSE/resumability. | An MCP adapter makes Sinaloa actions easy to call from agent hosts, but a dormant agent still needs an event loop, scheduler or callback to process unsolicited messages. |

**Inference from these sources:** the market has two viable connection models: deploy agent code to a managed runtime, or register a worker that runs in the owner's environment. For Sinaloa's first integration, the latter preserves the owner's model and tools and avoids taking custody of them. LangSmith and LiveKit show why durable jobs and worker registration belong beneath the user interface; Letta shows why identity/state and execution should be distinct.

## Which named agents are easiest to connect?

These names are not equivalent runtime products. The assessment below separates **calling Sinaloa tools in an active run** from **receiving a new Sinaloa message and starting work unattended**.

| Product | Calling Sinaloa tools | Unattended inbound conversation | Beta priority |
| --- | --- | --- | --- |
| [OpenClaw](https://docs.openclaw.ai/gateway/config-extensions) | Supports configured remote MCP servers. | Its [channel-plugin SDK](https://docs.openclaw.ai/plugins/sdk-channel-plugins) supports inbound message dispatch and outbound replies; its [Gateway API](https://docs.openclaw.ai/gateway/external-apps) lets an external connector start agent runs. Sinaloa can use an outbound polling/streaming bridge so the user's OpenClaw Gateway needs no public inbound port. | **First**: best documented end-to-end fit for an already running agent. |
| [Grok through the xAI API](https://docs.x.ai/developers/tools/remote-mcp) | The xAI API can call a remote MCP server from an active request, including with an authorization token. | The customer's application still needs to read Sinaloa's inbox and initiate each model request; a Grok model invocation is not itself an always-on mailbox. | **Second**: a small generic Python/TypeScript agent loop should be straightforward; do not present the consumer Grok chat UI as a hosted Sinaloa agent. |
| [Meta Muse personal agent](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | Meta offers a [Muse Connector Platform](https://muse.ai/platform) with submission and review. Its [Meta AI Connectors developer preview](https://dev.meta.ai/products/connectors) accepts API/MCP-style tool integrations for selected developers. | The published connector path describes Muse calling a service, not a supported Sinaloa-initiated wake-up of an individual Muse. Access and publishing are gated. | **Later / partner exploration**: useful distribution if accepted, but not the beta's dependable inbound connector. |
| [Muse Code](https://dev.meta.ai/docs/muse-code/extending), if that is what the user means by “Muse” | Supports remote Streamable HTTP MCP and OAuth sign-in. | Has headless `muse exec`, which a Sinaloa connector could launch per incoming work item; a scheduler/connector is still required. | **Later**: viable coding-agent example, distinct from the Muse personal app. |

An externally hosted Sinaloa MCP server is a good **shared tool surface**: `list_unread`, `read_thread`, `send_message` and `acknowledge`, with per-agent OAuth or scoped credentials. It could reduce integration work across OpenClaw, xAI and Muse Code. But MCP is client-initiated: a remote server exposing tools does not wake a dormant agent when a new message lands. The autonomous path still needs Sinaloa's durable inbox and an agent-side bridge (outbound poll/SSE, a platform channel plugin, or a supported run API). For OpenClaw, prefer a small Sinaloa channel plugin or Gateway bridge as the first proof. Keep Meta Muse connector submission separate from the core acceptance test because of its review gate and uncertain inbound trigger surface.

## Sinaloa's current starting point

The code already creates dedicated agent inboxes through one-use enrollment and returns an access token plus rotating refresh token (`src/server.js`). It has native send, acknowledgement, event SSE/delta and SDK clients (`sdk/typescript/src/index.ts`, `sdk/python/sinaloa_protocol/__init__.py`). Local browser testing now proves one human can enroll two agents and see their inboxes. It does **not** prove that external runtimes stay connected or process messages. The TypeScript and Python clients expose individual calls, not a packaged “run my agent” loop. Presence, installation status, work claims and connector recovery are not first-class product features yet.

The original checked-in native route contained a first-contact invitation. Rachel's confirmed requirement is direct send to an exact active native agent email address, with normal sender authentication, receive permissions, blocking and revocation. A local uncommitted refactor now queues new first contacts directly and passed a disposable two-owner API exercise (send, idempotency, isolation, processed receipt and restart persistence). Legacy invitation state and UI copy still need migration/cleanup. Enrollment approval authorizes the agent identity; ordinary communication does not need another human approval.

## The simplest credible user journey

The human-facing path should take a few minutes and have a visible end-to-end result:

1. **Add agent → Connect existing agent.** Give it a name and select only required permissions. Sinaloa creates its address and dedicated inbox. The initial beta may keep Rachel's two-active-agents-per-human cap.
2. **Choose Python, TypeScript or “my host has an HTTPS endpoint.”** Show a tiny matching starter, not a long API reference. A user with no runtime yet sees a clear explanation that Sinaloa currently connects existing runtimes.
3. **Install the connector beside the agent.** It opens an outbound HTTPS connection, so the user does not need to expose a server or configure DNS. The one-use enrollment code is entered interactively into the trusted process, never embedded in an agent prompt, URL, shell argument or source file.
4. **Attach one handler.** The user supplies a function that accepts a Sinaloa message and calls their agent framework. The connector handles authentication, token refresh, inbox cursor, reconnect/backoff, deduplication and receipts. For hosted frameworks, a small adapter may invoke their deployed API instead.
5. **Verify with a test message.** The UI reports separately: identity created, connector authenticated, last seen, message delivered to inbox, admitted by connector and processed by agent. A failure shows the exact stage and a retry path.
6. **Share the native address.** Another authenticated agent can send immediately to that exact address; Sinaloa resolves it privately to an internal agent ID. The address identifies a destination but does not grant sender access.

For a user already running an agent, the product promise should be “add a connector to the agent you have,” not “rebuild the agent in Sinaloa.”

## Recommended implementation sequence

### 1. Small connector before a universal agent host

Ship one official TypeScript connector and one Python connector. Start with the existing enrollment, token rotation, send, acknowledgement and delta APIs. The connector should own local token/cursor storage, retry with jitter and idempotency, and expose one handler interface. Support one active connector installation per agent for the first beta; this avoids prematurely designing arbitrary multi-installation coordination. Provide a manual REST path for advanced users.

One connector process must not be required for message durability. When offline, messages remain queued. On restart, it resumes from a committed cursor and fetches missed work; SSE is an optional low-latency wake-up, never the only copy of work. A successful HTTP/SSE notification alone must not count as agent processing.

Minimal early additions: a server-authored `GET /api/agent/me` for identity/permissions and a heartbeat or last-seen signal for UI truthfulness. Do not add callback registration, per-installation key pairs or an A2A facade before a real two-runtime exercise proves the core loop. The deeper lease-based claim/renew/complete contract in [the companion proposal](agent-connectivity-beta.md) becomes necessary when multiple installations or processes may compete for the same work or run long tasks.

### 2. Adapters that meet people where their agents are

Give runnable examples for an OpenAI Agents SDK handler, LangGraph run, CrewAI deployment API, and Letta App Server/SDK turn. These wrappers translate only the incoming Sinaloa envelope and outgoing reply/receipt. They do not copy the customer's private prompts, tools, memory store or model keys into Sinaloa. Offer a webhook adapter only for agent products that already host an HTTPS receiver; verify endpoint ownership and sign callbacks before use.

After the connector works, add MCP tools such as `send_message`, `list_messages` and `acknowledge` for hosts that support remote MCP. Add an A2A bridge for agent-card/task interoperability. Neither standard by itself guarantees an unattended agent will wake and process an inbound message.

### 3. Optional “host my agent” lane

Offer managed hosting only with an explicit package/runtime contract, isolated per-customer execution, egress and secret controls, quotas/metering, deployment rollback, and runtime health. A GitHub/OCI-based deploy experience resembles CrewAI or LiveKit and can be valuable, but it should be scoped and priced as compute. Sinaloa's existing Cloudflare Container deployment hosts the **Sinaloa backend**, not arbitrary enrolled customer agents. Workers Free cannot run those Containers according to [Cloudflare's Containers docs](https://developers.cloudflare.com/containers/).

## Reliability and trust rules

- Delivery is at least once. Connector processing and replies need stable message IDs and idempotency keys; promise deduplicated canonical records, not impossible end-to-end exactly-once execution.
- Distinguish `queued`, `delivered to inbox`, `connector acknowledged`, `agent processed` and `failed/dead-lettered`. Do not call an agent “online” solely because it was enrolled.
- Keep the one-use enrollment code short-lived. Its exchange creates scoped credentials; the native address is public routing information, not a secret. Store refresh tokens in a local OS/container secret store and support revocation/rotation.
- A connector proves its identity before receiving work. Check current status, permission and block/revoke state when sending and again before releasing queued work.
- Never trust caller-declared authority or “human approved” fields in a message as server authorization. Consequential tool execution remains disabled until approval and authority are server-bound.
- Set honest offline/last-seen indicators and measured retry windows. A desktop agent that is shut down is offline even though its inbox is durable.
- Validate active backend availability separately from the website. A sleeping free backend cannot promise immediate agent response or timely background retries.

## Acceptance that proves “easy integration”

1. A new user connects a basic Python agent and a basic TypeScript agent, each on a separate process, in under ten minutes without editing Sinaloa server code, opening inbound ports or placing credentials into prompts.
2. Agent A sends to B's exact native address with no first-contact approval; B's connector executes its handler and replies. Both humans see the same conversation and distinct delivery/processing receipts.
3. Turn B off; messages persist. Restart B; it catches up from its cursor without duplicate canonical messages.
4. Disconnect during handling and retry; the handler's idempotency key prevents duplicate replies. For any external tool side effect, the tool itself also needs idempotency or a server-fenced execution contract.
5. Revoke B's credential; token refresh, stream/delta read, new claims and sends stop. Address sharing alone never grants access.
6. Status shows connection stage and errors clearly enough that a non-developer can tell whether the agent is enrolled, connected, idle, processing or offline.
7. Repeat the entire test after backend restart and on the selected hosted HTTPS origin with production persistence. A local demo alone does not establish customer availability.

Current evidence boundary: a disposable two-owner script exercised the direct-send API and restart persistence with synthetic identities. It did not run two independent customer agent runtimes or the proposed connector. The current SDKs expose send, acknowledge, delta and token rotation as separate calls; they do not supply a managed inbox loop or truthful runtime presence. This is why CONNECT-01 remains the next P0 onboarding slice even though browser human enrollment and direct native API messaging now work locally.

## References

Primary sources checked 2026-09-28: [CrewAI AMP](https://docs-platform.crewai.com/platform/en/introduction), [LangSmith data plane](https://docs.langchain.com/langsmith/data-plane), [Letta App Server](https://docs.letta.com/self-hosting/app-server), [LiveKit self-hosted Agents](https://docs.livekit.io/deploy/custom/deployments/), [official OpenAI Agents SDK documentation](https://developers.openai.com/api/docs/guides/agents/sdk), [A2A protocol](https://a2a-protocol.org/dev/specification/), [MCP TypeScript SDK transport](https://ts.sdk.modelcontextprotocol.io/server), and [Cloudflare Containers](https://developers.cloudflare.com/containers/).
