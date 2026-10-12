# Registration contract re-review

Publication: PR #76 at `4da219e7156138c94e26b8105efe7ffe43ec6f98`, revision 3; version remains v1 by the human decision recorded in handoffs.md §13. Fresh human approval is required after Lane B's new ACK.

The original publication at `36f7943` failed #78's seven-item legacy-list regression. That MISMATCH is resolved at this publication without removing or weakening the regression. #78 now consumes all 78 canonical fixtures and passes 103/103 checks. #72's planner/output review passes 5/5 and its onboarding tests pass 27/27. These are independent fixture/design checks, not a live server or hosted gate.

## Reproduce from PowerShell

Use a separate clean checkout at the exact publication. Never copy its fixture files into the client package.

```powershell
$env:ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT = '<publication-checkout>\test\contract-fixtures\agent-registration'
node --test integrations/onboarding/test/agent-registration.review.mjs
Remove-Item Env:ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT
node --test integrations/onboarding/test/*.test.mjs
```

The dedicated #78 review uses the same canonical directory through ENVOI_CONTRACT_FIXTURES_ROOT and vitest.registration-review.config.ts. Standard CI does not replace either exact-publication consumer.

## Confirmation and revised semantics

The manifest pins the corrected publication. The consumer reads all 78 fixtures, including migration, rollback and restart steps, and handles guidanceByHelperState before ordinary guidance. It checks ACTIVATION_INVALID, check_owner_agents, approvedByMe and ownerClaimListMax=20.

An approved local poll enters CONFIRMING / confirm_approval. The helper shows the server-derived approverEmailHint, workspace, agent name/address and permissionSummary. A workspace name is chosen by the approver and does not prove identity. Optional hostNativePrompt is a local profile declaration, never a wire field; absent or false means chat_advisory. When an actual terminal/dialog is available, the helper must prefer host_native. Chat confirmation passes through the model, cannot be attributed by the helper to the human, and must wait for an explicit human answer. Decline or timeout deletes the bootstrap state without activation. These are draft policies; this package executes no prompt or activation.

## Remaining gates

Keep published:false, contract_blocked and liveEnrollmentAllowed:false. Fresh contract approval, the A-4.x backend, hosted Phase A gate, A-3.1b route authorization and route-specific hosted evidence remain separate requirements. No merge, deployment, live enrollment or automatic wake is established by these tests.
