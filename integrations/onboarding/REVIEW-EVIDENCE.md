# B-3.1a onboarding draft review evidence

Base: integration/agent-native at `9e178da96e840b169b17d6a2c6c99722cf0e8cab`. Contract publication: agent-registration v1 revision 3 at `4da219e7156138c94e26b8105efe7ffe43ec6f98` (PR #76). The earlier narrow ACK and seven-item MISMATCH at 36f7943 are historical; the corrected consuming review passes. A fresh human approval follows the new Lane B ACK.

This Lane B draft uses one host-capability planner for local helper, remote MCP/OAuth, reviewed provider connector and authenticated REST. Connection route and delivery mode are separate. Only supplied canonical server availability can select a route/mode; all actual host wake evidence remains unproven. The unpublished manifest offers no routes. Every supported draft remains contract_blocked with liveEnrollmentAllowed:false. No helper is executed, no prompt is opened and no network or credential exchange occurs.

Local approved polling now plans CONFIRMING / confirm_approval. Show the server-derived approverEmailHint, workspace, agent and permission summary. Prefer an actual host-native prompt; absent or false hostNativePrompt means advisory chat through the model, requiring an explicit human answer. The model never answers for the human. Decline or timeout deletes bootstrap state without activation. Profiles without the new optional capability remain valid. The profile field is planning metadata, not a server registration field.

Changed paths: integrations/onboarding/** plus the pre-existing integrations/gates/PHASE-A-HOSTED-PREP.md worksheet in this PR. This revision touches only onboarding. No Lane A paths or shared fixtures are edited. Hosted tooling in #73 remains a separate task.

Focused PowerShell validation:
- #78 exact-publication schema/client consuming review: 103/103, all 78 canonical fixtures, original legacyList(2) regression preserved and now passing.
- #72 exact-publication planner/output consuming review: 5/5, every HTTP/migration/rollback/restart operation consumed from the same fixture checkout with no copies.
- Onboarding Node suite: 27/27, including host-native/advisory selection, false/non-boolean capability handling, draft gate and model-visible examples.

Full Lane B suite and exact-head CI are recorded in the PR/build-board READY evidence. Standard CI does not itself run the separate #76 fixture publication review.

Hosted evidence still missing: Phase A real-Hermes acceptance and human countersign, A-4.x server, A-3.1b remote/provider authorization and route-specific onboarding/wake evidence. Muse, Instinct and ChatGPT Dots capabilities remain unverified. Contract ACK and synthetic profiles do not enable enrollment or prove unattended execution.

Rollback target: integration base 9e178da; remove the isolated draft package. No merge, deployment, live enrollment or real-host run.
