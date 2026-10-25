# B/C implementation candidate: #215–#218

Source baseline: `f89740459fbdf12b3f81d57dccf7ae9f60c91eb1`, isolated branch `lane-b/BC-approved-provider-clients`. The human explicitly authorized the necessary server, contract-fixture and root-configuration edits here. This document is the current implementation checkpoint; historical contract requests and composition/ACL notes describe earlier checkpoints.

## Scope and approvals

| Issue | Approved publication | Candidate behavior |
| --- | --- | --- |
| #215 | mcp-wake v1, `32975892945718296a4968a3d6ddbc40ef6d175b`; board approval 6374090183 | Four qualifying MCP wake tools over the existing durable HTTPS wake service; provider origin restrictions, private verification and private host client. |
| #216 | provider-event-wake v1 rev2, `d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b`; board approval 6389430643 | Qualified MCP 2026 event discovery/subscriptions and HMAC callback receiver/host, bounded cursor replay, plus owner-managed Grok transport. A trigger receipt never authorizes or proves execution. |
| #217 | provider-gateway-native v1 rev2, `f56e3c4790ad712f0863f4cfcd85185da58c54ad`; board approval 6389743298 | Owner scope upgrade and same-identity repair, private canonical claim/lease/case session, opaque bounded snapshots, reply/request-owner/defer and atomic canonical settlement. |
| #218 | provider-connector-tools v1 option A, `3af8669a907c316b95ff92fa7031a50a654e1a18`; board approval 6374090183 | Fixture-backed Muse classification/submission packet for the ten existing tools: identity 1, snapshot 3, work 5, reply 1. Adds no server tool, scope, route or flag. |

The four approved fixture publications are reconciled without semantic edits. #217 was already in the baseline. Publication-era status text in appended handoffs is retained as historical evidence and accompanied by credited approval receipts. Contract approval is not being requested again.

## Runtime and identity boundaries

All four new extension flags default OFF; beta source configuration explicitly keeps them OFF. Callback/trigger origin allowlists are empty. Existing flags and owner/workspace data remain unchanged. Builds remains paused: this work does not call a settings API, change a live Worker, run a migration, rotate keys, register providers or deploy.

The existing canonical work queue, fenced claims, signed policy bindings, human decisions, case controls and settlement services remain authoritative. Native work holds private leases/case sessions only inside encrypted server custody; snapshots expose opaque refs and bounded untrusted data. Scope changes end the old generation and require owner-confirmed repair of the same installation. Agent permissions are not widened automatically. Owner actions recheck current membership and CSRF; delegated browser cookies cannot grant scope or manage wake targets.

Wake profile state and delivery share the existing durable queue and its inbox transactions. Callback destination DNS is rechecked before each attempt; verification precedes activation; encrypted secret custody is cleared on ending. Subscribe/reconnect and safety polling reconcile canonical work even when a callback is lost. No callback response is treated as settlement.

## Validation

Final local and exact-head CI results are recorded on the draft PR and build board after execution. PostgreSQL parity and the real production Docker build run only in ephemeral CI. Local test servers and owners are synthetic. Production databases, owners, workspaces, keys and provider accounts are not used for these checks.

## What remains and who owns it

1. **This chat / candidate owner:** finish full local checks, deterministic generated-build comparison and exact-head draft-PR CI, including PostgreSQL and Docker. Publish READY with the source SHA and evidence. Fix failures without weakening tests.
2. **Human approver:** review and approve integration of that exact draft-PR SHA into `integration/agent-native`. No flag enablement or deployment is included in this approval.
3. **Lane A / release owner, after a separate explicit approval:** prepare an isolated hosted validation window for these new provider profiles, with pinned source, recovery controls, account-specific origins/credentials and narrowly scoped flags. Changes to settings, provider configuration or deployment need their own concrete approval. Owner and workspace identities must remain continuous.
4. **Provider-account owners and both lanes:** demonstrate the new profiles on actual supported hosts and retain canonical effects, replay/recovery, pause/revoke and ownership evidence. Grok G1–G4 and Muse M1–M5 remain provider acceptance gates; reusable source clients do not establish account capabilities. Submit only the approved Muse ten-tool packet when authorized.
5. **Human approver:** countersign the new hosted evidence and approve rollout separately. Source implementation completion and hosted acceptance are distinct checkpoints.

Existing signed Hermes/OpenClaw B/C acceptance remains credited, including board comment 6330847176. This candidate neither reopens those completed gates nor claims that new ChatGPT/Dots, Grok, Instinct or Muse acceptance has occurred. Phase D work with independent approved contracts may proceed in parallel; no blanket Phase A/B/C closure is inferred from this source-only candidate.

## Review and recovery checklist

- Confirm draft base is `integration/agent-native` and the source ancestry begins at `f897404`; verify the exact final SHA and green checks.
- Confirm approved fixtures are unchanged and #218 adds no tools/scopes/routes/flag.
- Confirm all extension flags OFF, callback/trigger allowlists empty and Builds still paused.
- Confirm no deployment, provider account operation, secret rotation or live identity mapping occurred.
- Review owner upgrade, old-cookie invalidation, same-identity repair, transaction rollback, late callback generation fencing, private-session epoch recovery and terminal human-decision reoffer tests.
- In a future authorized hosted window, disable new flags before rollback, reconcile outstanding private leases through the existing canonical queue and use same-identity repair. Preserve both owners/workspaces; never enroll replacement identities to conceal a recovery failure.
