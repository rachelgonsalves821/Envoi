# agent-registration v1 independent consumption review

Publication: PR #76 @`36f7943646f245ec1ac96bec706690fa370f3780`.
Human approval is on build board #34; this review supplies the previously missing independent Lane B evidence.

Decision: **MISMATCH**, not ACK. The dedicated suite reports **84 pass / 1 fail**. All 68 canonical fixtures validate, along with the original request bodies and surface-specific codes/guidance. The failing check is a valid legacy-list boundary missing from the fixture matrix.

## Reproduction

From this review checkout, point at a separate exact-publication checkout in PowerShell:

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = 'C:\Users\KAILASH\.codex\worktrees\agent-registration-review\Sinaloa\test\contract-fixtures'
npx vitest run --config vitest.registration-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

The existing shared registry/loader reads the publication directly. No fixtures are copied or edited. `legacyList(2)` in the test constructs the exact failing body in memory from `migration-legacy-family`'s canonical active and ended objects, with unique legacy UUID IDs. All seven items individually satisfy `installation`; they have two active entries first and exactly five ended entries sorted newest first.

## Exact mismatch

Request represented: `GET /api/inboxes/inbox_example/agents/agent_example/installations`, human session cookie `envoi_session=PLACEHOLDER_session`, as in `owner-installations.json`.

Expected from handoff §6.5: an HTTP 200 `ownerInstallationList` can show every active legacy family, followed by up to five ended installations. Thus two active legacy installations plus five ended installations is a valid seven-item body. Section §6.5 explicitly permits several active legacy families until reconnect replaces them.

Observed publication: `schemas.json#/definitions/ownerInstallationList/properties/installations/maxItems = 6`. Ajv rejects the valid seven-item body:

```json
[{"instancePath":"/installations","schemaPath":"#/properties/installations/maxItems","keyword":"maxItems","params":{"limit":6},"message":"must NOT have more than 6 items"}]
```

A one-active/five-ended body is accepted. The seven-item rejection is solely the global list bound, not an invalid installation, more than five ended rows, bad order, or multiple new-flow active installations. Both active rows are legacy.

No actual server response is claimed: A-4.x is unimplemented. This is a contract/schema consumption contradiction that would force a consumer to reject a documented result or hide a still-active legacy installation.

Lane A correction: align the global list constraint with all active legacy rows plus at most five ended rows, and add a multi-active legacy fixture/regression. Current fixture-specific checks already enforce <=5 ended and <=1 non-legacy active. Do not fix it by dropping active entries or weakening the client expectation. The approved contract's frozen-version rule means Lane A and the human must record the correction/version decision.

## Other review evidence

- Independent suite: 84/85; all 68 registered fixtures and declared schemas pass. Tests cover request-negative reasons, per-surface stable codes/retry headers, Origin/CSRF, browser credential exclusion, model-visible sources/allowlist, route order/availability, permission intersection, exact recovery/replay, tombstones, bootstrap restrictions, paused attach and rollback.
- Actual EnvoiConnector accepts additive installation status and the flags-off status response using only one authenticated status request, with no enroll/claim calls. Actual frontend handles the claim inadmissibility 401 as sign-in.
- PR #72 @`27b8c4e48e081fc83c2c7169713e02274ddfbdaf` was independently checked out without edits. Its existing consuming suite passes 3/3 against the exact PR #76 directory. It exercises the host planner and sanitized examples but omits the seven-item boundary.
- Publication fixtures remain marked `published`, although board approval exists. That bookkeeping discrepancy is recorded without changing Lane A files.
- The x-codes prose for REGISTRATION_TOKEN_INVALID still says "including after the activation recovery window". Handoff §6.1 row 4 and the tombstone fixtures correctly use ACTIVATION_RECOVERY_EXPIRED for that interval. Lane A should clarify the stale prose. After 24-hour cleanup, a helper with a persisted activationId must use owner_reconnect, as §2 says, rather than treating the generic register_again guidance as permission to create a duplicate.

ACK is withheld pending Lane A correction and a focused rerun against its exact corrected SHA. This review does not implement registration, modify PR #72, call live endpoints, enable flags, merge, deploy or run a real host. Hosted Phase A, A-4.x and route-specific acceptance gates remain in force. Standard CI does not invoke this dedicated publication review and cannot clear its MISMATCH.
