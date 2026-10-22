# Phase B remote MCP/OAuth client gap packet

**Base:** `integration/agent-native` at `bbd361ea52aab80fc53c402130a35718f6bee561`. **Contract:** `agent-remote-auth v1` revision 2, ACKed and human approved on build board #34. This packet is an audit of client and contract dependencies. It is not a host installation, an OAuth credential exchange, or a closed-app wake result.

## What the approved contract establishes

An OAuth host discovers Envoi's protected resource and authorization server, identifies a public metadata-document client or a reviewed pre-registered provider client, and completes authorization code with S256 PKCE and the exact `/mcp` resource. The owner consents to a named new or existing agent and effective permissions. The host, not the model, keeps the code verifier, code, access token and refresh token. It reads the narrower effective `scope` in the token response, rotates refresh tokens, treats a lost code-exchange response as a new authorization, and revokes when disconnected. A bearer from this flow is accepted at `/mcp` only. An installation declares `on_demand`; this is not evidence that the host works with its app closed.

The existing client surface does not yet offer this route. `integrations/onboarding/host-plan.mjs` and `integrations/onboarding/helper/transport.mjs` deliberately reject a server snapshot with `remote_mcp_oauth: true` or `on_demand: true`. The canonical `routes-available-remote-mcp` fixture describes precisely that later valid snapshot. The planner also keeps `liveEnrollmentAllowed: false`. This rejection is safe while flags stay off, but route setup cannot pass until a Lane B availability/skill/planner pairing consumes the approved fixture. The owner `on_demand` state contract at PR #175 is ACKed and version-specifically human approved (board comment 6324921026); integration and implementation remain. PR #173 already owns the consent UI; avoid overlapping it. PRs #176–#177 are Je's Lane A work and remain untouched.

## MISMATCH / REQUEST lane-a: OAuth installation cannot register http-wake

**Expected:** The approved remote-auth handoff says a host with a signed HTTPS callback can add an `http-wake v1` subscription to its OAuth installation, and Phase B breadth requires a separately observed closed-app wake result before any automatic-reachability claim.

**Observed:** `agent-remote-auth v1` §9 makes an audience-bound token an unrecognized bearer on **every** path outside `/mcp`, including `/api/agent/*`; `oauth-token-refused-on-rest.json` pins the `401 AUTHENTICATION_REQUIRED` behavior. `http-wake v1` §3 requires that installation's access token for create, activate, list and end at `/api/agent/wake-subscriptions*`. A model-safe MCP tool cannot simply take custody of the host's access token: remote-auth §10 keeps tokens out of model context, and http-wake §3 keeps subscription management with the host, not an MCP case-session token. Thus an OAuth-only installation cannot create or activate the subscription described by remote-auth's wake note under both approved contracts as written.

**Request:** Lane A should publish a contract amendment and paired positive/negative fixtures for one host-side, installation-bound wake-management path. It must preserve `/mcp` audience enforcement on unrelated REST APIs, never expose operational tokens or challenge material to the model, and define pause, refresh, revoke, replay, flag-off and rollback behavior. Lane B can then implement the host adapter against that approved path. Until this is resolved, record `http-wake` for OAuth hosts as **unavailable**. A host-specific provider event route would need its own reviewed contract and evidence.

Minimal fixture set requested:

| Case | Required assertion |
| --- | --- |
| OAuth wake create and activate | Same installation and access token may complete callback challenge through the new scoped host path. |
| OAuth bearer on ordinary REST | Remains `401 AUTHENTICATION_REQUIRED`, matching `oauth-token-refused-on-rest`. |
| Other installation/client and model token | Cannot create, list, activate or end this installation's subscription. |
| Pause, refresh and revocation | Management works while paused; refresh preserves binding; revocation ends subscription and delivery. |
| Flag-off and source rollback | No callback is sent and the recovery path is explicit. |

## Remaining Lane B work and acceptance

1. Pair the approved PR #175 contract with Lane A's server projection and Lane B's owner UI: **On demand**, “No requests yet” or “Last request …”. Never infer running or connected from a token exchange or an open browser.
2. Consume `routes-available-remote-mcp` and the provider counterpart in `/connect`, `skill.json`, the planner and helper availability validation, keyed only to a validated server snapshot. Keep provider bootstrap hidden until a named provider has an approved design and verified private field; never present a bootstrap code in chat or logs.
3. Provide host setup guidance that records the supported interface, registered client identity, exact redirect URI, `/mcp` resource, requested versus effective scopes, private credential custody, renewal, disconnect/revoke and same-identity reconnect. Verify with actual host responses, not fixture-only tests.
4. Test discovery, owner consent, authorization-code exchange, `/mcp` identity/read/send/reply, refresh, pause and revoke at one pinned release. A cloud-only host may pass this as `on_demand`. Automatic reachability requires a supported wake surface and two closed-app arrivals producing canonical replies without reopening the host.
5. Keep the flag off and the route unadvertised until server, client, on-demand owner state and the named-host gate are integrated and observed together. Re-pin any generated bundle hashes after a client change.

## Evidence boundary

The 59 remote-auth fixtures and the `#173` UI tests establish contract and offline client behavior. PR #177 covers discovery/client validation/authorization request only. There is no observed token exchange, `/mcp` use, refresh, revoke, named host installation or closed-app wake in this packet. A ChatGPT Dots or Grok MCP connector working in an open chat would establish an on-demand route only; it would not satisfy closed-app wake.
