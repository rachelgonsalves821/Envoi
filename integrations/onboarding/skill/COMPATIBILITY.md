# Runtime capability evidence for the draft skill

An agent's ability to read this skill does **not** establish that its host can run `envoi-link`, store credentials privately, or wake it after the app closes. Record each capability separately for each tested runtime and version. “Unverified” is a test backlog, not a claim that the host lacks the capability. No entry below authorizes publishing the skill or advertising automatic availability.

| Runtime | Read skill/link | Local helper | Remote MCP/OAuth | Reviewed connector | Trusted REST | Private credentials | Closed-app wake and Envoi reply |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes | Unverified for Phase B | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| OpenClaw | Unverified for Phase B | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Instinct | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Muse | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| ChatGPT Dots | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Other runtime | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |

## Public documentation versus an Envoi test (checked 2026-10-12)

The table above remains **unverified for Envoi**. Public provider documentation establishes candidate setup paths, not authenticated Envoi access, a private Envoi installation, or an unattended reply.

| Host | Documented candidate | What still needs a real test |
| --- | --- | --- |
| Muse | Meta's [Connector Platform guidelines](https://muse.ai/platform/docs) describe a reviewed connector submission with endpoint/authentication/scopes, test credentials, tool classifications, and sensitive-write approval on every use. | Whether an Envoi connector is approved and available to this Muse account; identity/inbox/send tool calls; whether Meta offers a supported incoming-event mechanism. A browser or one-off API probe does not prove closed-app wake. |
| ChatGPT Dots | Official [custom MCP plugin instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) describe OAuth-backed remote MCP tools; [Dots app access](https://learn.chatgpt.com/docs/dots/computers-and-apps) uses enabled plugins. Official [MCP Events](https://developers.openai.com/plugins/build/mcp-events) supports webhook subscriptions with dots on MCP 2.0 (`2026-07-28`). | Envoi has not implemented or hosted that event contract; an owner must install and authorize a real plugin, subscribe the dot, then prove signed opaque wake, authenticated fetch, reply, restart, and revoke on the exact release. A dot's general background work is not evidence of an Envoi event subscription. |
| Instinct | Instinct's [official site](https://instinct.com/) describes a text/call assistant that can use a phone and computer. | The reviewed official material does not establish a public custom MCP client, installation API, private connector field, or Envoi-triggered callback. Inspect the owner's actual account and obtain a supported integration contract before claiming a route or wake mode. |

`HOST-SETUP-PROBES.md` gives the bounded checks for each host. Keep the generic capability flags false until the exact host/version demonstrates them. For Dots, MCP Events is a possible future delivery mechanism and requires Lane A server design and security review; this Lane B package does not create a subscription or webhook. For Muse, classify Envoi message send/reply as a write and test whether Meta treats it as sensitive; never promise unattended sending if approval is required every time.

For each observed result, record the runtime/version, host OS, test date, exact Envoi release SHA, evidence link, and whether a human had to reopen the agent or approve a sensitive action. A successful one-time inbox read or send does not count as closed-app wake. Select a delivery mode only after its end-to-end test; otherwise label the installation **on demand**. Envoi must continue to hold pending work in its durable queue while a host is offline.

The preferred order in v3 is verified provider/native invocation, verified HTTPS webhook, Envoi Link with SSE, verified scheduled polling, then on-demand use. This is an order to evaluate, not a promise that every host supports every mode.

The **same Envoi registration, human claim, installation, permission, and durable-work contract** should apply across these rows. A runtime-specific adapter supplies only the host's verified launch, secret storage, wake, and tool-call capabilities. Phase A uses Hermes as one real-host reference fixture; Phase B repeats the agent-led flow with Hermes and OpenClaw. Muse, Instinct, Dots, and future hosts need their own capability and closed-app wake evidence before their UI can promise automatic availability. A hosted connector that can read an inbox while a chat is open is still **on demand** until it passes that test.
