# Meta Muse connector access escalation

**Status, October 6, 2026:** A credential-free report was submitted through Muse **Settings → Report an issue → Connectors**. Muse confirmed **Bug ID 1063711089343829**. The separate [Connector Platform submission form](https://muse.ai/platform/submission) is open, but its first step requires a verified developer/contact identity, public privacy policy and product terms, and a 512 × 512 connector icon. Those items are not established in this repository. No Connector Platform application has been submitted and no Muse-origin authenticated Envoi response has been observed.

## What Meta should investigate

Envoi is a third-party agent communications platform. An Envoi owner enrolled a personal Muse test identity on isolated staging and saved a five-minute, read-only `agent_probe` bearer in Muse's secure `custom.envoi-staging` Custom Connector. The connector was limited to `sinaloa-staging.rachelgonsalves821.workers.dev`; the intended actions were only:

| Action | Expected result | Observed Muse result |
| --- | --- | --- |
| `GET https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/me` | Envoi `200` with that Muse agent's address, `agent_probe` scope, and `work_probe` permission | `proxy CONNECT denied` / `403 Forbidden` before an Envoi HTTP response |
| `GET https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/availability` | Envoi `200` with content-free work counts | `policy_denied`, `policy: sentinel-policy`, `detail: network access denied for this task`, `rule: GET /api/agent/work/availability`; no Envoi HTTP response |

The owner approved the requested one-time read/host actions. Muse used an authored connector skill and the credential surrogate supplied by its secure connector flow. No bearer value appeared in chat or repository files. The denied calls had `User-Agent: Envoi-Muse-Connector/0.1`. Muse reported that the personal Custom Connector stores host and authentication metadata but does not expose a supported method-registration or per-task Sentinel-grant control in the tested account. These are observations from this account, not a claim about all Muse accounts.

An earlier attempt around 9:01 a.m. Toronto time used the default `Python-urllib/3.12` client and received Cloudflare `1010` (`browser_signature_banned`) at the edge. The later Muse denial was different: it occurred before Cloudflare or Envoi. A local unauthenticated request with the named client identifier returned Envoi `401`; this proves the route responds from this computer, **not** that Meta egress is allowed. The later Muse read attempt was around 9:40 a.m. Toronto time. Exact Meta request IDs and any Cloudflare Ray ID were not exposed in the saved trace.

## Reproducible, least-privilege fixture

1. Use the owner-approved Muse test identity in the isolated Envoi staging tenant; generate a new five-minute read-only credential via **Agent connections → Reconnect runtime** immediately before the test. Never put it in a prompt, URL, log, or review attachment. No current credential is included in this packet.
2. Place it only in Muse's secure connector credential capture for the exact staging host. Run only the two GET actions above, through the Meta-supported connector tool path. No shell bypass, send, claim, file access, or browser sign-in is requested.
3. Record the Meta task/tool invocation ID, timestamp, connector identifier, policy decision/rule and host. If it reaches Envoi, record the Envoi request ID and `200` identity and availability responses, omitting the bearer and any private message data.
4. The gate passes only when both requests return authenticated Envoi responses and a matching server trace on a known deployed commit. A connector record marked “connected,” local `401`, Cloudflare build success, or Muse narrative alone does not pass.

The current [read-only OpenAPI specification](muse-connector-read.openapi.json) describes the existing endpoints and exact scope. It is a feasibility API: it has no OAuth account link, connector-side refresh, work claim, message read, send, or wake. The durable connector design and Meta review packet are in [the submission plan](muse-connector-platform-submission-plan.md).

## Questions for the Connector Platform review

1. For a **reviewed** Envoi connector, does Meta accept this read-only REST API, a remote Streamable HTTP MCP server, or both? Which endpoint registration, authentication, and tool-schema fields cause these calls to run through an approved connector path rather than the denied personal skill egress path?
2. Can Meta review the `proxy CONNECT denied` and `sentinel-policy` decisions for the exact staging host and GET path above? Which non-secret task IDs or policy trace fields should Envoi provide, and where can the owner upload them securely?
3. Does connector approval itself permit a linked personal Muse to call the approved tools, or are separate host allowlisting, account eligibility, or user permissions required? What is the expected time to test an unpublished connector in the owner's Muse account?
4. Before any wake claim: does Meta offer a documented third-party event ingress or app-closed scheduled invocation for this connector? If neither, Envoi will label Muse interactive-only and keep inbound work queued.

## Submission readiness

The public form currently asks for connector name, company/developer, product website, example prompts, 512 × 512 icon, payment category, contact name, work email, support email/URL, privacy-policy URL, and product-terms URL before **Technical specs** can be opened. Envoi's product website and the non-payment classification are known. The repository does not establish the remaining legal/contact/brand fields, and the five-minute probe is not a review-duration authentication solution. Do not fabricate those fields or offer a reviewer a credential in prose. Once the owner provides verified details and the renewable scoped installation is ready, enter the technical specification and this incident packet through the portal's secure process. Acceptance of Meta's terms belongs to the authorized Envoi owner.
