# Offline remote MCP authorization plan

**Current checkpoint (2026-10-24):** approved MCP wake/events source is integrated through #225 at `7e189c2`; the older v1 wake-gap statement below describes the original helper scope. The planner still rejects ChatGPT's current CIMD preference/capabilities combination. Start with the reproduced mismatch and current staging/host rows in [Dots hosted acceptance](DOTS-HOSTED-ACCEPTANCE.md). No host acceptance or live flag change is implied.

This module consumes the approved `agent-remote-auth v1` revision 4 discovery and authorization request contract. A trusted host supplies previously fetched protected-resource metadata, authorization-server metadata and its own client metadata document. The pure `planRemoteMcpAuthorization` function checks their exact issuer/resource relationship and builds an S256 PKCE authorization URL. The caller must generate and privately retain the verifier and state, check the returned issuer and state, and keep the authorization URL, code and tokens out of model context and logs.

It does not fetch metadata, attest the metadata document, store credentials, open a browser, exchange or refresh tokens, revoke, offer the route, or establish a host installation. Envoi's server still performs its full metadata URL/address and client checks. OAuth installations have no wake path in v1; this helper makes no closed-app reachability claim.

The test consumes the canonical `protected-resource-metadata`, `authorization-server-metadata` and `authorize-redirects-to-consent` fixtures. Revision 4 retains these fixture bytes from the approved earlier revision. Run `node --test integrations/onboarding/remote-mcp-oauth/authorization-plan.test.mjs` from the repository root.
