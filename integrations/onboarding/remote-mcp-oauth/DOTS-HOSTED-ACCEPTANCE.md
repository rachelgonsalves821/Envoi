# ChatGPT/Dots: next B/C hosted acceptance

Prepared 2026-10-24 America/New_York. Source: `7e189c25ea79434c77d89826d9e71fd293a167f1`. Host selected by the human in this chat. **Status: BLOCKED on the CIMD compatibility decision below; hosted rows remain UNPROVEN.** This packet authorizes no account creation, plugin installation, subscription, model invocation, release or settings change.

The [integration receipt](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6392417049) records approved #215-#218 implementation; the [release receipt](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6392857776) records a Hermes/OpenClaw-only three-core-flag deployment. Earlier instructions to implement the OAuth/event server from scratch are superseded by these receipts. Existing Hermes/OpenClaw acceptance remains credited.

## First blocker: current ChatGPT client metadata

Canonical [MISMATCH and REQUEST lane-a](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6393097298) includes the exact synthetic request and local authorization-handler result. The handler returns `https://www.envoi-agents.com/authorize-agent?error=invalid_client` before reaching consent; no hosted authorization request was made.

Read-only public metadata fetch at `2026-10-25T03:41:43Z` and local function calls at the source above produced:

```json
{
  "client_id": "https://chatgpt.com/oauth/client.json",
  "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
  "token_endpoint_auth_method": "private_key_jwt",
  "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"]
}
```

**Expected for the proposed ChatGPT route:** negotiate a supported public-client method when both client and server offer `none`, keeping PKCE, resource/issuer validation, exact redirects and all destination checks. The [current official OAuth guidance](https://developers.openai.com/plugins/build/auth) describes the plural field as capabilities, the singular field as a compatibility preference, and method selection from the client/server intersection.

**Observed locally:** `clientMetadataRejection(document, document.client_id)` in `src/agent-remote-auth.js` returns `auth_method_not_none`. `planRemoteMcpAuthorization(...)` in `authorization-plan.mjs`, using approved discovery fixtures plus that public client document, throws `Invalid remote MCP authorization setup`. Envoi's existing authorization metadata offers `none` and `client_secret_basic`. The current validator checks the singular preference and ignores the plural capability list. Existing five OAuth planner fixture tests still pass, because their example client has singular `none`.

This is a compatibility mismatch between the selected host's current metadata and the approved contract, not an observed live `/oauth/authorize` failure. No OAuth request, login, token exchange or registration was made by this probe. The actual account may show a callback-specific client document; capture that exact document and redirect rather than assuming the stable pair above.

**REQUEST lane-a:** review `agent-remote-auth v1` revision 4 section 3.1 and publish the selected metadata-negotiation rule/fixtures, with a version/revision decision and reason. Cover a client with both methods and a different singular preference, legacy singular `none`, unsupported/no-intersection lists, malformed lists, client-ID/redirect mismatch and unchanged PKCE/SSRF/issuer checks. The request is to review negotiation with `none`; it does not request implementing JWT client authentication or a static-secret bypass. Lane B will update the pure planner after client ACK and human contract approval. Do not edit canonical fixtures in Lane B.

## Account observation before a hosted window

The [custom MCP setup guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) describes web Plugins -> Add custom MCP server, OAuth and CIMD selection where supported. Observe the actual account's permissions and available flow; retain only redacted product/account/plan/version and setup evidence. Copy the exact management-page client metadata URL and redirect URI. Do not invent them, choose DCR as a bypass, or paste tokens into chat.

The [MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) describes Work/cloud and Dots subscriptions using protocol `2026-07-28` and webhooks. Account availability and an actual subscription still need observation. A conversation-time MCP tool call establishes no closed-app execution.

## Proposed staging profiles for Lane A and human review

These values are a reviewable configuration proposal, not deployment commands. Pin one clean resulting SHA, terminal-green CI, `/health`/`/ready`, the exact trusted HTTPS `ENVOI_PUBLIC_URL`, existing identity-preserving recovery inputs, a disposable test installation/case set and the human-approved action/time boundary before use. Current source defaults remain unchanged. Production and its accepted local-helper flow are outside this new validation window.

| Flag | Connection-only phase | Events phase, after connection passes |
| --- | --- | --- |
| `ENVOI_INSTALLATIONS_V2` | true | true |
| `ENVOI_AGENT_REGISTRATION_V2` | true | true |
| `ENVOI_CASE_SESSIONS_V1` | true | true |
| `ENVOI_REMOTE_MCP_OAUTH` | true | true |
| `ENVOI_HTTP_WAKE_V1` | false | true |
| `ENVOI_MCP_EVENTS_V1` | false | true |
| `ENVOI_AUTHENTICATED_REST_ROUTE` | false | false |
| `ENVOI_PROVIDER_CONNECTORS` | false | false |
| `ENVOI_PROVIDER_BROWSER_POLL` | false | false |
| `ENVOI_MCP_WAKE_V1` | false | false |
| `ENVOI_GROK_TRIGGER_V1` | false | false |
| `ENVOI_PROVIDER_GATEWAY_NATIVE_V1` | false | false |

Connection-only keeps `ENVOI_MCP_EVENTS_CALLBACK_ORIGINS` empty. For events, Lane A proposes only the exact HTTPS callback origin observed from this provider's subscription, with required destination verification; no wildcard or guessed origin. Grok origins remain empty. Use #216 events for this CIMD OAuth host; #215's private provider-connector wake tools are a different qualifying profile. Audience-bound tokens stay on `/mcp` and never gain REST wake authority. A multi-provider fixture's extra Grok flag is not a requirement to enable Grok for Dots.

## Hosted rows to execute after specific approval

| Row | Action and passing evidence | Current result |
| --- | --- | --- |
| Dots-01 | Actual account permits the selected plugin/Dots flow; exact client metadata/redirect recorded and accepted by the reviewed contract | UNPROVEN |
| Dots-02 | Hosted discovery, PKCE and owner consent create one approved private installation; grant/token remain in host custody | UNPROVEN |
| Dots-03 | Real authenticated identity and inbox/work reads; correct installation and case, unrelated owner denied | UNPROVEN |
| Dots-04 | Trusted host claims/renews; bounded tools operate only in the claimed case; actual approved send/reply has a canonical receipt and separate fenced settlement | UNPROVEN |
| Dots-05 | Repeating the same uncertain request/key creates one canonical effect; stale claim and unapproved recipient/scope denied | UNPROVEN |
| Dots-06 | Actual refresh and same-identity reconnect preserve address/history; revoked grant blocks further tools and late settlement | UNPROVEN |
| Dots-07 | Paused tool call surfaces HTTP 409 `AGENT_PAUSED`; pause grants no action; explicit resume recovers held work | UNPROVEN |
| Dots-08 | Events discovery/list/subscribe at `2026-07-28`; private signed callback verification and persisted subscription/cursor | UNPROVEN |
| Dots-09 | Two separately timed synthetic case arrivals while chat/app closed: actual host invocation -> authenticated claim -> approved reply -> exactly one settlement per item | UNPROVEN |
| Dots-10 | Dropped/duplicated event, restart and truncated replay recover through canonical work; subscription renewal/rotation and unsubscribe/revoke enforced | UNPROVEN |
| Dots-11 | No secret/content in hints or transcripts; required provider prompts recorded; files respect scan/grant policy | UNPROVEN |
| Dots-12 | Human countersigns exact host/release evidence; owner availability labels and rollout decision reflect only proved modes | UNPROVEN |

Capture UTC times and redacted request, event, subscription, work, case and receipt references. Keep credentials, private callback parameters, verifier/state, cookies and raw case content out of tracked evidence. A webhook response is delivery receipt; it is not completed work. Scope/send prompts required by the host cannot be bypassed by the test.

Use [the common breadth worksheet](../skill/BREADTH-EVIDENCE.md) for this new host, and [the Phase C rows](../../gates/phase-c/EVIDENCE.md) for isolation, authority, assets and lifecycle coverage. Credit the existing accepted Hermes/OpenClaw evidence separately. On-demand and automatic reachability have separate results; a blocked provider interface does not become PASS.

## Recovery and completion

Lane A prepares the exact proposed flag/config rollback before the human authorizes the window. Stop new events, revoke only the disposable installation/subscription under that authorization, restore the previous staging profile and reconcile queued work through the canonical service. Preserve existing owners/workspaces and production release configuration. No destructive database restore or replacement identity is a recovery shortcut.

The next deliverable is the approved compatibility fix plus its exact green source, followed by an account-specific staging plan with observed public client metadata/callback origin. This document itself supplies no hosted PASS.
