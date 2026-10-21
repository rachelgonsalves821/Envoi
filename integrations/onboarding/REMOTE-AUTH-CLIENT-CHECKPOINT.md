# RA-B1 remote-auth consent checkpoint

Task RA-B1, Lane B. Base: bbd361ea52aab80fc53c402130a35718f6bee561.
Contract consumed: agent-remote-auth v1 revision 2 at that SHA, ACK 6321065617 and human approval 6321077051 on build board #34. The human separately approved the bounded implementation in this chat.

## Scope

Owner-session /authorize-agent consent UI, target/reconnect choice, one-time redirect, render-only decisions, pending approval withdrawal, static canonical response validators, and an unmounted provider bootstrap component. Existing transport supplies CSRF, account binding and session cancellation. These clients use synthetic fixtures until Lane A implements their endpoints. No OAuth tokens are exchanged by frontend code.

ProviderBootstrapPanel is a component for a future reviewed provider flow. It does not enumerate, register, advertise or activate any real provider. It accepts a reviewed target request, requires an explicit issue action, retains the response only in memory, never retries issuance automatically and clears the displayed code on hide, expiry or unmount. A lost response is not recoverable; review recent approvals and let the unused registration expire.

Consent state never retains a code-bearing redirect. An approval response can navigate once; reloads and retries render authoritative decision states. Unknown write outcomes retain an in-memory snapshot for a bounded identical retry. A read never navigates. New authorization remains the recovery path for a lost code or token response.

## Dependencies and bounds

Lane A still owns OAuth routes, persistence, Worker proxy/cache/environment changes, server planner and redaction. The a5 on_demand label/state revision and closed credential-family shape amendments still need their own publication, Lane B ACK and human approval. This PR changes no installation/presence labels or route-availability policy. RA-B2 remains gated.

Both ENVOI_REMOTE_MCP_OAUTH and ENVOI_PROVIDER_CONNECTORS remain off. Stage A's release candidate, bounded hosted batch and receiver plan are unchanged. No merge, deployment, flags/settings, provider registration, real host/model calls or hosted tests are authorized.

No server persistence or migration is introduced. Rollback of this client patch is the pre-PR integration base; eventual server rollback follows the approved contract's flags-off semantics. Source rollback does not revoke or delete installations. Rebuild generated assets with npm run build; never hand-merge web output.

## Validation

Offline fixture/controller/transport/render tests cover the four decision outcomes, first redirect, lost response/reload/restart/expiry, Withdraw races, same-identity selection, PKCE and bearer credential boundaries as contract consumption, provider bootstrap secrecy and lifecycle, account/session changes, malformed payloads, bounded retries and static validator reproducibility/CSP execution.

Required before READY: focused tests; typecheck; full frontend, TypeScript SDK, integrations and Python SDK suites; npm test; npm run build; exact-head CI and generated consistency. Record actual results in the PR description. Server parity and real route/provider acceptance remain missing until separately completed by their owners. No named-host compatibility is established by these offline tests.
