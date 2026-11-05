# Dots onboarding and permissions source composition

Base: integration/agent-native `43171f77303eae2c80206ea6b495cb600b585337`.

This candidate consolidates the completed Dots source from draft #259 at `ab8779f434e030fd5199497036d9709049a7dc96` and #286 at `5df27ab0b0e0d7786454d704bba4bdaf56dcc20e`. Their branches remain untouched. Do not integrate their overlapping Dots changes a second time after this candidate.

- #259: carry the runtime guidance/acceptance matrix and catalog copy. Its App dialog and prompt changes are superseded by the shared `DotsSetupGuide` and strengthened installed-plugin, scope, identity and monitoring instructions. It is preparation, not a hosted PASS.
- #286: retain Dots selection for eligible reconnects, frozen-agent refusal, existing-identity prompt semantics and its regressions. The same picker change already exists on current main through #287; deduplicate it in a main composition.
- New: fix `connectionOffer` rejecting the approved remote OAuth availability fixture; render `/connect?platform=dots`; provide an owner-facing Dots permission-recovery panel through the approved existing-agent OAuth flow; explain receive-only consent and workspace-policy refusal without widening a grant; exercise the actual local two-owner OAuth/MCP exchange in the normal integrations runner.

The integration baseline's Permissions page is read-only. The recovery panel therefore uses existing OAuth consent rather than adding a call to the main-only generic permission-update endpoint. On current main, retain its existing permission editor and add the recovery panel before the permission table; preserve its callbacks and all other owner controls. Its `OAUTH_RECONSENT_REQUIRED` error is not an instruction to bypass the grant.

For release preparation, carry only the owned source changes, resolve App.tsx against the target's existing controls, and run `npm run build` on that exact composition. Never copy this integration-built `web/index.html` onto main, overwrite main's whole App.tsx, merge generated files by hand, or promote the entire integration branch for this change. All source outside the selected Lane B paths stays with the release owner. No server, database, contract fixture, root dependency/configuration or flag change is part of this candidate.

The installed personal production plugin's connection configuration is App-owned. The example MCP JSON does not mutate it. Owner reconsent with actual receive/send scope negotiation and each Dot's native execution remain required after release. Keep the two-owner procedure in `integrations/onboarding/remote-mcp-oauth/DEMO.md` separate from test evidence.
