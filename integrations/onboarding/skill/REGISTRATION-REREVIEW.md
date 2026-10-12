# Registration contract re-review handoff

Status on 2026-10-12: **prepared, blocked on Lane A correction**. This is not a contract ACK, permission to merge, or live enrollment implementation.

Preparation rerun on Rachel's Windows machine: #72's published-fixture consumer 3/3 PASS; onboarding tests 25/25 PASS; unchanged #78 consuming review 84 PASS / 1 FAIL with the same seven-item legacy-list contradiction. Its review test is byte-identical to the published #78 test. The original #76 publication remains unchanged; no corrected SHA is claimed.

## Pinned evidence

| Item | Exact reference |
| --- | --- |
| Uncorrected Lane A publication | PR #76 at `36f7943646f245ec1ac96bec706690fa370f3780` |
| Independent Lane B review | PR #78 at `35d186dac9e34245fbdfe351ef91df7b39c78336` |
| Current onboarding consumer before this note | PR #72 at `27b8c4e48e081fc83c2c7169713e02274ddfbdaf` |
| MISMATCH | [Build-board report](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6133129091) |

## Lane A delivery needed

1. Correct `ownerInstallationList` to permit every active legacy installation plus up to five ended installations. Preserve the limit of one non-legacy active installation; do not hide active legacy entries.
2. Add a canonical fixture with at least two active legacy installations and five ended installations, and retain negative coverage for too many ended or non-legacy active rows.
3. Resolve the `REGISTRATION_TOKEN_INVALID` prose versus `ACTIVATION_RECOVERY_EXPIRED` and persisted-activation recovery guidance.
4. Publish the exact corrected SHA and record the correction/version decision with the human because v1 was already approved. Lane B does not modify the handoff or fixtures.

## Lane B re-review sequence

Use separate clean review and publication checkouts. Load the canonical publication directly; never copy fixtures into the client package.

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = '<corrected-publication-checkout>\test\contract-fixtures'
npx vitest run --config vitest.registration-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

Run that command from the #78 review checkout. Its existing `legacyList(2)` boundary must pass without deleting, skipping, or weakening the expectation. Standard CI does not run this dedicated review.

Then run the #72 planner/output consumer from the onboarding checkout:

```powershell
$env:ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT = '<corrected-publication-checkout>\test\contract-fixtures\agent-registration'
node --test integrations/onboarding/test/agent-registration.review.mjs
Remove-Item Env:ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT
node --test integrations/onboarding/test/*.test.mjs
```

The current #72 test pins 68 fixtures and version 1. Reconcile those pins with the actual corrected publication and recorded version decision; do not retain a stale count or relax assertions merely to make the test pass. Update `skill.json`'s publication SHA and the review notes only after reviewing the new publication.

Run the full Lane B suite and exact-head CI before READY. Post either a new exact MISMATCH or `CONTRACT-ACK` with both consumers' evidence and the publication SHA. The human confirms the corrected contract approval afterward.

## Gates that remain separate

Keep `published: false`, `contract_blocked`, and `liveEnrollmentAllowed: false`. The hosted Phase A gate, A-4.x backend, A-3.1b route authorization, and route-specific hosted acceptance are independent requirements. A green planner test or a contract ACK is not proof of live enrollment or automatic wake.
