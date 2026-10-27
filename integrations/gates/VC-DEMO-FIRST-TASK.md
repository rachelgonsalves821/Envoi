# Two-owner onboarding and first-task demo

This Lane B change adds a human-confirmed host operation through the approved native-message API and `EnvoiConnector.startCase`. It adds no server API, model tool, permission or grant. Each owner runs their own helper; website inboxes show the resulting exchange. The existing case composer still sends instructions to the local agent inside that case.

## Release preparation

1. Pin the reviewed integration source containing this change, green CI and generated artifacts. Preserve existing identities, workspaces, histories and paused cases. Exclude unrelated signup, Dots and Phase D work.
2. The human release owner captures fresh paired Worker/container/config rollback pins. AGENTS.md/build-plan reserve merge, deploy, settings and real-runtime operations to the human. Use the existing `HERMES-OPENCLAW-RELEASE-PROFILE.md`: the beta profile `hermes-openclaw-preserve-monad` enables registration/installations/CaseSessions, keeps other onboarding extensions OFF and retains the existing Monad capability. A default deploy does not select that profile. This worksheet is not release authorization.
3. After release, verify main `/health` reports the selected source, `/ready` passes and `/api/onboarding/routes` offers `local_helper` and `envoi_link`. Verify served UI/download bytes independently; health and GitHub main are insufficient.
4. Give each host the reviewed private package's `envoi-link.mjs`, matching `envoi-connector.mjs` and `private-release.json`; verify hashes/sizes. Do not mix a new helper with an old running connector. The package remains private/unpublished. Node.js 22+ and an already configured Hermes/OpenClaw host are required.
5. Use the two existing invited owner accounts in separate browser profiles. Public signup/WorkOS cutover is excluded. Coordinate a fresh exclusive window with the existing acceptance/release owner before restarting their hosts or touching retained state.

## Human-operated rehearsal

Record source/image/artifact hashes, actual runtime/profile/version/model, owner consent, timings, model calls and canonical effects in private evidence. Never put credentials in transcripts, screenshots or the board.

1. A opens main `/connect`, chooses Hermes and runs `node /absolute/path/envoi-link.mjs connect https://www.envoi-agents.com --runtime hermes` on that host. Claim the matching code in A's account, approve the intended workspace/identity/send-receive permissions, and explicitly confirm the approval on the host. Keep the helper terminal running. Enrollment/presence alone does not prove a model run.
2. B repeats in their own account/host with `--runtime openclaw`. Keep state separate. Read each exact Envoi address from an authenticated view.
3. In a second interactive terminal on A's host, run `node /absolute/path/envoi-link.mjs task https://www.envoi-agents.com --runtime hermes`. Enter B's exact address and “Please suggest two times for our demo follow-up. Reply once with two options.” Review origin, sender, recipient and text; type `yes` yourself.
4. Without prompting B to check its inbox, observe its real runtime processing. Show request/reply and canonical delivery/processing receipts in both website inboxes. `accepted` is enqueue acceptance, not processing or completion.
5. B starts a **new** task using their command with `--runtime openclaw`, addressed to A: “Please review this three-point agenda: product, onboarding, next steps. Reply once with one improvement.” Observe A's actual processing/reply and both histories.
6. Retry an accepted request using `task <same-origin> --runtime <same-runtime> --retry <reported-UUID>`. The helper restores exact input and asks for confirmation. Expect `replayed: true`, no second case/message/model execution. After any uncertain send, preserve state and reuse the same retry ID.
7. Decline one confirmation: no send. Pause a sender in its owner UI: no new task reaches the other inbox. Resume, then finish remaining release-required lifecycle/recovery rows in the existing hosted worksheet.
8. Run the exact presentation twice and retain a clean backup recording. Record actual timings rather than promising an unmeasured SLA. Finish with stopped handback and human acceptance.

## Recovery and evidence limits

- The task command uses the existing running connector as sole credential/rotation owner. It does not enroll, start a runtime, install a service or grant access. Current server pause/revoke, sender/recipient permissions, contact controls and case ordering remain authoritative.
- Exact input/case/key are saved atomically before dispatch. Server idempotency covers a lost send response or receipt save. Preserve missing/corrupt/mismatched state for reconciliation; never delete it or create a replacement identity to force recovery.
- The local send requires the private control credential, the loopback Host, JSON and a bounded body; browser Origin headers are rejected. No browser cookie authorizes sending.
- Automated rehearsal uses actual local Envoi persistence, registration/approval/activation HTTP, control, scoped tools and two synthetic browser sessions, with **inert runtime adapters and zero models/hosted traffic**. It does not establish WorkOS login, real host/model behavior, deployed artifact identity or hosted acceptance. Those remain separately observed human gates.
