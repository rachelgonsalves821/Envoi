# agent-registration v1 independent consumption review

Publication: PR #76 at `4da219e7156138c94e26b8105efe7ffe43ec6f98` (revision 3).
Base: integration/agent-native at `9e178da96e840b169b17d6a2c6c99722cf0e8cab`.

Decision: the exact-publication consuming review passes **103/103**. All **78** unique registered fixtures and their request/response schemas are loaded through the canonical shared registry, with no copies. The original `legacyList(2)` seven-item regression is preserved and now passes. The earlier MISMATCH at `36f7943` is resolved. The human's version decision keeps v1 and requires a fresh approval after the new Lane B ACK; the earlier approval does not freeze this revised publication.

## Reproduction

From this review checkout, point at the separate exact-publication checkout in PowerShell:

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = 'C:\Users\KAILASH\.codex\worktrees\registration-v1-republished\Sinaloa\test\contract-fixtures'
npx vitest run --config vitest.registration-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

## Expected and observed

| Consumer boundary | Expected at revision 3 | Observed |
| --- | --- | --- |
| Legacy owner list | Every active legacy installation plus up to five ended; no global active cap | Canonical two-active/five-ended fixture, original seven-item regression and 25-active/five-ended probe accepted |
| Approved poll | `CONFIRMING`, `confirm_approval`, server-derived approver hint, workspace, agent and permissions | Exact match; missing hint rejected; no verification code repeated |
| Unresolved activation after token cleanup | `client.helperState=activation_unresolved` selects `guidanceByHelperState.activation_unresolved=check_owner_agents` | Exact match; no automatic duplicate registration |
| Invalid activation | `400 ACTIVATION_INVALID`, `UNCHANGED`, `update_helper`; approval stays live | Exact fixture/policy match |
| Co-manager approvals | `approvedByMe`, descending approval order, at most 20 | Both attribution values consumed; 20 admitted, 21 rejected, missing attribution rejected |
| Decision replay | Original approve, reject and withdraw body in later states | Exact match, including approve replay after activation |
| Restart after installation revoke | `kind=restart`, approved unfrozen agent can attach again | Every step consumed and validated; ended installation and same-identity approval accepted |
| Model output | Explicit allowlist now includes `approverEmailHint`; server-derived values match | All canonical projections accepted without token/internal-ID leakage |

The suite also checks route availability, permission intersection, Origin/CSRF, browser credential exclusion, request-negative reasons, recovery/tombstones, bootstrap no-access probes, paused attachment and rollback. Actual EnvoiConnector consumes additive installation status without changing enrollment; actual frontend sends the inadmissible-human 401 to sign-in.

This is contract consumption, not server execution: A-4.x and hosted acceptance remain outstanding. No Lane A path, shared fixture, runtime behavior or generated artifact is edited by this review. PR #72 separately consumes this same publication and drafts the host-native-preferred / chat-advisory local confirmation policy. Neither review grants access or enables a route.
