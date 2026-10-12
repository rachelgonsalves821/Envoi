# Lane B consuming review: agent-registration v1

Publication: PR #76 at `4da219e7156138c94e26b8105efe7ffe43ec6f98` (revision 3), handoffs.md §§4, 7 and 13, and 78 canonical fixtures plus schemas.json.

The previous ACK was superseded by #78's MISMATCH at 36f7943. The corrected exact-publication review now passes: #78 103/103; this package's planner/output consumer 5/5, including every multi-step fixture; onboarding tests 27/27. The new review resolves the original legacy-list contradiction and includes every deliberate revision-3 change. The human must approve the republished v1 after the fresh Lane B ACK.

The planner drafts local confirmation before activation: CONFIRMING / confirm_approval, masked verified approver email hint, workspace, agent and permissions. Host-native prompt is preferred whenever available. Chat through the model is advisory and waits for the human's explicit answer; the model cannot answer for them. Decline or timeout does not activate. The output examples exactly match canonical safe projections and permit approverEmailHint, not an operational credential or internal identifier.

See REGISTRATION-REREVIEW.md for reproduction. Fixtures are read from a separate pinned publication checkout, with no copies and no Lane A edits. This is design-only B-3.1a: no registration request, credential exchange, published /connect, enabled route or hosted acceptance claim. A-3.1b authorization, A-4.x server and the hosted gates remain outstanding.
