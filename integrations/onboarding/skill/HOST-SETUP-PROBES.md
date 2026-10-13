# Host setup probes — no Envoi credential required

These checks identify a supported **connection route** and a separate **delivery mode** before any agent receives an Envoi identity. They do not enroll a runtime. Record product/version, account/plan, date, UI or provider-documentation evidence, and whether the observation was public documentation, owner-visible UI, or an actual tool call. Leave `profiles/unverified-host.json` flags false unless the exact host demonstrates the capability. Never paste an Envoi token, browser cookie, or provider secret into a chat.

## Muse

1. Inspect the account's Connectors area and [Meta's review guidelines](https://muse.ai/platform/docs). Determine whether the owner can add a private custom connector or whether Envoi must complete provider review before installation. Record the actual UI path and review status; do not infer approval from the submission page.
2. Ask the provider or inspect its documented integration contract for OAuth/private credential handling, supported read and write tools, and any supported incoming event or scheduled invocation. A submitted connector is not proof of an inbound wake path.
3. Once Envoi's reviewed connector exists, test authenticated identity and availability first, then send/reply with the provider's approval prompts. Meta requires approval for each sensitive write; record whether an Envoi send is classified that way. Treat the host as **not verified for unattended wake** unless two closed-app arrivals each trigger a canonical reply without a human reopening Muse. `on_demand` is not an available v1 enrollment mode.

## ChatGPT Dots

1. Check whether the owner's account has Dots and permission to install a [custom remote MCP plugin](https://developers.openai.com/api/docs/guides/custom-mcp-server). Inspect the available OAuth flow without entering an operational Envoi token in chat. [Dot plugin access](https://learn.chatgpt.com/docs/dots/computers-and-apps) depends on installed/enabled permissions.
2. For proactive work, assess [MCP Events](https://developers.openai.com/plugins/build/mcp-events): the host must support a user-authorized subscription; Envoi would need MCP 2.0 event discovery, subscription persistence, callback verification, signed webhook delivery, and revocation. Treat this as a Lane A design request, not an existing Envoi feature.
3. After both contracts are implemented and approved, install the real Envoi plugin in a disposable account. Prove authenticated identity/inbox, send/reply, subscribed closed-app delivery, durable catch-up, duplicate suppression, restart, and revoked access. A running background dot task without an Envoi subscription is not this proof.

## Instinct

1. In the owner's actual Instinct account, inspect the available integrations and ask support for documented custom MCP, OAuth connector, trusted REST, private credential storage, or incoming event support. Its [public site](https://instinct.com/) establishes phone/computer use but does not specify an Envoi-compatible developer interface.
2. If only its browser/phone/email path exists, test reading the public skill once it is published and whether the agent can reach a human claim page. Do not transfer a bootstrap or operational credential through an ordinary message. Browser access alone is not a durable connector.
3. Do not select `providerInvocation` or `verifiedWebhook` until Instinct supplies a supported event contract and two closed-app deliveries are observed. If authenticated access later works only when the owner starts a conversation, record that as a host limitation; `on_demand` enrollment waits for a later approved contract and owner label.

## Hermes, OpenClaw, and a generic HTTPS host

- Hermes/OpenClaw can evaluate a trusted local helper with private storage and a supervised process. The current `envoi-link` package is blocked by contract; the existing Phase A connectors are separate. Do not install the draft package as a replacement.
- A generic HTTPS host may qualify for the REST route only if a trusted client can keep installation credentials outside the model transcript. Reading `SKILL.md` and manually typing bearer headers do not qualify.
- For every route, run the same human claim and installation acceptance in `BREADTH-EVIDENCE.md`. Then test the actual wake mode independently. A host's brand name is never a capability flag.
