# Phase B client implementation status

## Current closure checkpoint — 2026-10-23 America/New_York

The original implementation report below is retained as history. Its pending #99/#101/#102 integration and blanket hosted-unproven statements describe that earlier local-helper milestone, not the accepted current B/C scope.

- Local Hermes/OpenClaw Gate B passed 21/21 at `e8a958f`; evidence #165/#168 is integrated. Prior B/C work is human-attested complete/countersigned in [board record 6330847176](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176). Keep its original release/host scope; missing transcription does not reopen acceptance.
- Shared Phase C source is integrated through #143. Later Windows/normal-entry/supervised-wake fixes entered once through #199. Do not reapply the older task PRs merely because GitHub still lists them as open.
- Remote authorization server composition #203 and owner consent client #173 are MERGED; source baseline is `d05498d8dc13c6f07dc151da7a41a1619ff62436`. Resulting integration-push CI and later route/host acceptance are distinct checks. Both remote-auth flags remain OFF.
- On-demand presence #183, offline host planner #196, portable/host composition #206, artifact checker #193, distribution #111/#117/#119, quickstarts #207/#209 and persistence #210 have separate remaining source-selection/review gates. Their existence does not establish named-host acceptance.
- [The B/C closure checklist](../gates/B-C-CLOSEOUT.md) records each current gap, owner and exit, including exact pending heads and the quickstart documentation corrections. The cloud-host/provider/wake gaps remain explicit; no extra host pass or new release is inferred.

## Historical local-helper implementation report

Task: B-4.1 private helper, B-4.2 claim/installations UI, B-4.3 connect/runtime integration. Lane B only.

## Formal prerequisite and scope

Phase A was countersigned on the human-attestation basis recorded in Lane A PR #98 at cba3907f428f49c2d8a95cf7813dc9cfbfe26ca7 and build-board #34 comment6226711305. This authorizes client implementation against approved agent-registration v1 revision3, a3-pause-auth v3, a4-wake v2 and a5-presence v1. It is not a new independent hosted-test observation. Existing contract approval remains accepted.

Implementation began at integration2b18170; the PR is rebased to the latest integration before publication. Planning checkpoint is draft #97 at a0589d8, full CI SUCCESS on run38982654085 attempt3. Runtime and UI writers used separate worktrees and disjoint files. The lead independently reviewed, assembled and tested their results.

## Implemented client behavior

- Private local helper: registration and timed pending polling; explicit native confirmation of masked approver/workspace/agent/permissions; stable activation ID/request saved before network; atomic flushed credentials with completion metadata; lost-response/crash recovery; safe output; same-identity explicit reconnect after definitive installation revocation.
- Operational credentials stay in private host storage. Bootstrap authenticates only its registration status and activation. The safe projection is allowlisted. No automatic duplicate enrollment after uncertain activation.
- Runtime adoption uses the existing Hermes/OpenClaw connector, not legacy enrollment. Completed-session restart starts the foreground work loop; refresh, cursor/delta, safety poll, pause, revoke and settlement behavior remain in the shared lifecycle. Live status does not compete with the running connector's refresh ownership.
- Owner claim UI uses existing browser session, CSRF, expected-human and stale-request guards. Five registration permissions, exact decision replay, stale replacement confirmation, co-manager withdrawal, every active legacy installation and ended history are represented. Installation-only revoke preserves identity reconnect; actual agent-wide freeze uses Advanced legacy re-onboarding.
- Public connect content is availability-driven and local-route scoped. Quick Connect stays under Advanced. Skill/heartbeat commands match the helper. Remote OAuth/provider, authenticated REST implementation and Phase C/D remain outside this local milestone.
- Existing npm run build regenerates public frontend/connector assets and builds the helper exclusively into ignored integrations/onboarding/dist with a sibling connector and private hash metadata. The private package is not published. No helper web download is created.

## Verification and limits

Lead PowerShell checks: typecheck, frontend344, TypeScript SDK199, Python SDK6, Node/download413 pass /15 existing skips, integration suite260 pass /1 existing skip, assembled-helper CLI8/8 and private-store recovery10/10 focused; full final counts/CI are recorded in the PR and #34. Helper confirmation/recovery uses canonical fixtures and injected transports, clocks, stores, crash points and stub runtime adapters. The actual helper engine-to-adoption-to-foreground path is fixture-tested. Build and private package hashes are checked before publication of the draft PR.

File replacement uses exclusive temporary files, file sync and atomic rename, plus POSIX directory sync. Windows protects the whole state directory using account-only ACLs and absolute system-helper paths; Node cannot establish directory-flush power-loss guarantees for every Windows filesystem.

These are client/fixture results. Lane A owns real server behavior, contracts/fixtures and public route binding. Server work is in stacked drafts #99/#101/#102; integration has the CI infrastructure repair at383a5bc. A separate minimal Lane B audit-events draft #103 at845605c28124206dcbbeb457e02d1f78a77f90fc responds to board6228344065 so those server PRs can run their frontend audit checks.

## Next actions and human checkpoint

1. Finish exact-head full CI, including PostgreSQL, production container and generated consistency. Publish exact SHA/results on #34; never report READY for pending/red checks. Stop at documented retry limits.
2. Lane A/human integrate reviewed client/server heads in dependency order, including the minimal audit-event update. Verify the one resulting integration SHA and default-off behavior.
3. Validate corresponding local real-service routes after integration and endpoint readiness. Report exact expected-versus-observed MISMATCHs; never patch Lane A paths.
4. The human controls enabling routes, private real Hermes/OpenClaw acceptance, messages, distribution, deployment and settings. Prepare the journey but do not initiate those actions. Hosted acceptance and closed-app reachability are still unproven for this onboarding milestone.

The approval reviewer rejected a proposed public helper download because this milestone explicitly prohibits publication. The implementation uses a private local build instead; there is no public helper artifact/link. A helper worker also exhausted its own approval-review quota; its preserved files were independently reviewed and assembled through the lead's normal authorized review path. No action was retried by bypassing a rejected review.

Rollback: return to the PR base's client sources and rebuild via npm run build. Preserve any private activation/session state for recovery; do not delete uncertain activation journals or re-register automatically.
