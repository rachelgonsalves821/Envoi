# Provider contract review and approval packets

Lane B, 2026-10-23. Review branch `lane-b/B-C-contract-consumer-review`, isolated worktree `provider-contract-review`. Base: `d05498d8dc13c6f07dc151da7a41a1619ff62436`. Scope is contract consumption and review only. Both remote flags remain OFF; Stage A candidate/batch/receiver and Phase D are unchanged. No dependent production implementation, integration, deployment, settings, provider registration or hosted/paid execution.

## Results

| PR / contract | Exact publication | Verdict | Board receipt | Exact-head CI |
| --- | --- | --- | --- | --- |
| #215 mcp-wake v1 | `32975892945718296a4968a3d6ddbc40ef6d175b` | CONTRACT-ACK | [ACK](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782280) | [40006142554](https://github.com/rachelgonsalves821/Envoi/actions/runs/40006142554) |
| #216 provider-event-wake v1 | `3e1574f828868be63257c6bfaf62b5e7682db249` | MISMATCH; approval withheld | [Findings](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373764059) | [40005388334](https://github.com/rachelgonsalves821/Envoi/actions/runs/40005388334) |
| #217 provider-gateway-native v1 | `9b13fa3cb44c68e15d7bb1d70c8c5fe1fdd15e95` | MISMATCH; approval withheld | [Findings](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373764561) | [40005942025](https://github.com/rachelgonsalves821/Envoi/actions/runs/40005942025) |
| #218 provider-connector-tools v1 | `3af8669a907c316b95ff92fa7031a50a654e1a18` | CONTRACT-ACK | [ACK](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782839) | [40006418798](https://github.com/rachelgonsalves821/Envoi/actions/runs/40006418798) |

All four CI runs are terminal SUCCESS,26/26 steps at their own exact publication heads. Actual logs show PostgreSQL325/325 with zero skips and both audits zero vulnerabilities. This is contract/static-source evidence, not implemented provider behavior or account capability.

Own Windows PowerShell/Node24.19.0 execution: generic + bespoke tests15/15,17/17,15/15,15/15 respectively (62 test executions, zero skips). The bespoke #218 checks import the actual live tool table. Additional offline Lane B review loads96 canonical fixtures directly from pinned Git objects (22/38/30/6), without copies:16 grouped positive checks pass; interoperability probes report16 observations grouped into six findings below. Zero network calls. No broad unrelated suites or accepted hosted gates rerun.

## Reproduction

From an owned worktree containing this review script and the four publication objects, install the existing lockfile dependencies. Run from PowerShell:

```powershell
$env:ENVOI_REMOTE_MCP_OAUTH='false'
$env:ENVOI_PROVIDER_CONNECTORS='false'
node integrations/contract-fixtures/provider-contracts.review.mjs
```

The script is review-only. Exit0 means no observed finding; exit1 means a positive consumption assertion failed; exit2 means the contract mismatch probes found issues. The current expected result is exit2, not an all-green contract claim. Git objects pin the shared canonical fixture source, so this script does not execute unapproved routes or copy fixtures. Fetch the publication objects if using a shallow checkout; never run repository work in the primary human checkout.

## #215 approval packet — ready for the human

Dependency: approved remote-auth rev4/Policy B and http-wake v1; pre-registered connector backend with private token custody and declared wake origins. This contract adds four model-reachable wake tools only behind a proposed default-off flag. It adds no scope or REST audience exception. The receiver still claims and settles through canonical fenced operations, with startup/safety polling and unchanged opaque notifications.

Tradeoffs to approve explicitly: reuse `envoi.agent` without a new wake consent line; exact pre-registered origins; paused tools return HTTP409; rollback ends only MCP-created subscriptions; delivery mode remains `on_demand`. Metadata-document clients have no path in this version. Real client registration/configuration and closed-app evidence remain separate.

**DRAFT FOR HUMAN POSTING — NOT APPROVAL BY CODEX:**

> CONTRACT-APPROVED mcp-wake v1 @32975892945718296a4968a3d6ddbc40ef6d175b (#215), following Lane B ACK6373782280. I accept the published design: reuse envoi.agent; restrict destinations to pre-registered wakeOrigins; return HTTP409 while paused; end only MCP-created subscriptions on flag-off; keep on_demand labels unchanged. This approves the contract under existing Lane A/B ownership and gates. Both remote flags remain OFF and all new flags default OFF; Stage A unchanged. No integration/main update, merge, deploy, settings change, provider registration/submission, real-host/model or hosted/paid operation is approved.

## #216 approval packet — withheld pending Lane A corrections

1. Both successful/idempotent unsubscribe fixtures omit `delivery.mode:"webhook"` from the documented wire shape.
2. The contract explicitly forbids verification caching, whereas the cited OpenAI guide specifies a bounded principal/callback cache. Publish expiry/invalidation/rotation behavior and fixtures.
3. Ten delivery fixtures sign almost seven days before their event occurs. Example:1792238402 is2026-10-17T12:00:02Z; event time is2026-10-24T12:00:00Z. Re-sign time-consistent fixtures and add controlled-clock freshness/stale/future/retry checks. Correct HMAC alone does not validate freshness.

Primary references actually retrieved: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [Grok webhook triggers](https://docs.x.ai/grok/automations/webhooks). Public protocol support does not establish an enabled account/workspace or a working Grok claim path.

After a corrected exact publication, consuming re-review and its own CI: the human packet must select MCP2.0 event support at `/mcp` while preserving old-client behavior; encrypted HMAC-secret custody/deletion; default-empty provider allowlists; transport-only Grok until its G1 claim gate is proved; and unchanged presence labels. D1–D3/G1–G4 remain external evidence gates. Do not post CONTRACT-APPROVED for the current head. No new human policy decision is needed to fix these technical mismatches.

## #217 approval packet — withheld pending Lane A corrections

1. Scope upgrade returns generation5 and `requiresNewSessionCookie:true`, but no executable wire sequence shows old-cookie refusal and same-installation acquisition of the new native-work cookie before a successful claim. Clarify existing owner-confirmed repair/re-pairing versus another explicit flow; preserve assurance and no self-upgrade.
2. Claim retries after a lost successful response are unspecified. Add same-run/restart replay of the outstanding packet without leasing another item or double-charging budget, then next-item progression and wrong-run refusal. Action idempotency and crash/lease expiry do not define this retry.
3. `actRequest.text.maxLength=4096` counts characters, not UTF-8 bytes.1100 emoji pass the schema while yielding4400 text bytes and a4508-byte request (below the8192 request cap). Add an explicit byte guard and multibyte boundary fixtures for the stated4096-byte reply cap.

After a corrected exact publication, consuming re-review and CI: the human packet selects the server-held Stage2 credential route; explicit owner `native_work` upgrade; reply/request_owner/defer only; standing consent bounded by current permissions, cadence and lifetime plus existing per-item human decisions; canonical expiry/attempt accounting and bounded runs. No assets/email bridge or host-held operational credentials. Stage1 remains unchanged; Instinct/Muse and actual scheduled/closed-app acceptance remain OPEN. No approval text for the current head is ready to post.

## #218 approval packet — ready for the human

Dependency: existing approved registration/remote-auth permissions and19 live MCP tools. No server implementation or new tool/scope is selected. After approval, Lane B can update the existing Muse readiness document to cite the classification; submission and provider account operations remain separate.

Recommended optionA preserves existing grants and describes them honestly. `envoi.agent` includes claim/settlement authority; sending needs `envoi.send`. The minimum submitted tool set does not narrow the actual OAuth grant. Meta's M1–M5 evidence remains unproved, including whether optionA satisfies M2. B/C require distinct permission/scope/client contract work. This packet proposesA; it does not claim the human selected it or Meta accepted it.

**DRAFT FOR HUMAN POSTING — NOT APPROVAL BY CODEX:**

> CONTRACT-APPROVED provider-connector-tools v1 @3af8669a907c316b95ff92fa7031a50a654e1a18 (#218), following Lane B ACK6373782839. I select optionA as Envoi's proposed approach: retain existing scopes, describe envoi.agent honestly as including work-state writes, and use the published minimum tool set with optional envoi.send for replies. Meta's acceptance and M1–M5 gates remain open; this does not establish a read-only grant. B/C are not selected. Both remote flags stay OFF; Stage A unchanged. No integration/main update, merge, deploy, settings change, provider submission/registration, real-host/model or hosted/paid operation is approved.

## Integration and acceptance boundaries

These are separate contract approvals, excluded from the #219/#220 implementation composition. All four branches append at the same handoff/registry positions: Lane A must preserve exact reviewed schema/fixture bytes and obtain changed-composition checks when resolving appends. No implementation starts against #216/#217 before fixes, ACK and exact human approval. No previous Policy B or historical hosted acceptance is reopened.

#218 classifies the existing19 tools; #215's four future flagged tools are not automatically included in Muse's minimum submission. Adding them to a reviewed provider offering requires the applicable classification/provider review. #216 event methods are protocol methods, not model tools. A 2xx/202 delivery receipt never proves a fenced claim/reply/settlement or changes on-demand presence.

Following any contract approval, implementation acceptance needs actual FileStore/PostgreSQL parity, permission/session/tenant binding, secret exclusion, lost-response/idempotency, lifecycle/rollback and resulting-SHA checks under the agreed lanes. Hosted/provider capability, exact integration, Stage A and Production operations remain separate selections.
