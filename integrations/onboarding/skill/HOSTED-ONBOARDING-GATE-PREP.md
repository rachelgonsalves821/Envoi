# Phase B hosted onboarding: execution record (prepare before live run)

**Status:** PREPARED, NOT RUN. This record is for the first hosted Hermes/OpenClaw helper gate. It does not grant authority to deploy, change flags, enroll an agent, send work, call a model, fault a service, or revoke an installation. Fill the release and operation fields, obtain the existing separate rollout and bounded-test approvals, then copy this file to an evidence record for the exact 40-character release SHA for the run.

The local 21/21 gate at `e8a958f` is prior evidence only. Hosted Phase B requires a fresh user journey on the exact served release and installed artifacts. Run this before dependent Phase C C01–C24 rows. Keep Phase C wake C19–C21 on in the first hosted batch as already selected, but record those results in the Phase C packet rather than silently counting them as Phase B onboarding.

## 1. Immutable release and staging baseline

| Field | Required value / evidence | Current state |
| --- | --- | --- |
| Candidate source | Full 40-character SHA, clean worktree, exact-head CI and integrated CI URLs | Proposed `25c66372dc16f399cc5b213368246ebba9d65fd1`; final selection open |
| Staging Worker | Account, Worker name, current version ID, current `/health` release SHA, `/ready`, and routes response | Read-only dashboard observation 2026-10-21: account `54a5d6c680bd813fa60f8e088b098b8d`, Worker `sinaloa-staging`, active version prefix `0c075364` at 100% traffic. Public `/health` reports `2b18170d59b0096ff997d9a79487d50ccb627ef9`; `/ready` reports ready in staging; `/api/onboarding/routes` returned 404 `Not found`. This is the currently served ancestor, not the proposed candidate. |
| Staging container | Current image digest/reference paired with the current Worker version | Read-only dashboard observation 2026-10-21: app `sinaloa-beta-staging` (`a03cd3b2-67bf-4626-8444-e89d9114fcb9`), active v57 at 100%, image `registry.cloudflare.com/54a5d6c680bd813fa60f8e088b098b8d/sinaloa-beta-staging@sha256:cf918d33dcfbf8c561c64b4f1f6c7a2f6a9bee61410d9b8e67018b71904a522f`; v56 at 0%, image digest `sha256:da6918267fd409cb6eaeae5a7550d1297b1aa2b905d2fe0fb009d4586efa5047`. Worker/container pairing still needs verification. |
| Staging storage | Sanitized database/storage identity, separation from beta, backup and restore status | Read-only Neon console observation 2026-10-21: staging project `sinaloa-staging` (`dry-poetry-47244003`), default `production` branch `br-soft-mouse-b4fauf5d`, database `sinaloa_staging`; distinct beta project `sinaloa-beta` (`dry-tooth-12968475`), default branch `br-tiny-morning-b4vk2xih`, database `sinaloa_beta`. Both show six-hour history retention, one manual snapshot from 2026-09-29, and **no snapshot schedule**. The staging snapshot has no expiry. An archived staging branch from that snapshot remains visible; prior repo evidence says it was restored and queried, but a current restore test was not run. The Worker's encrypted `DATABASE_URL` has not been matched to this project or branch, so live runtime separation remains unverified. |
| Rollback | Previous Worker version **and** image, settings/flag values, verified paired restore procedure, rehearsal result, operator | Container v56 is visible at 0% traffic; its relationship to a previous Worker version is unknown. Paired Worker/image rollback and database restore rehearsal and verification evidence is not yet available. |
| Served artifacts | SHA-256 of `/connect/SKILL.md`, helper, connector and OpenClaw download as fetched from staging | Not yet checked against staging |
| Installed artifacts | SHA-256 of the exact local files installed in Hermes/OpenClaw profiles | Not yet installed |
| Receiver | HTTPS host/URL/TLS operator, route to each runtime, durable private store, restart procedure | Undecided; see Stage A packet #172 §4 |

Collect the read-only staging facts with the commands in Stage A packet #172 §2.2 on the release account. Record only secret **names**, never values. The command operator must check their Wrangler version's help first. An inaccessible account or an unmatched Worker/image pair is a stop, not an inferred pass.

The 2026-10-21 Worker settings show `ENVOI_DEPLOYMENT_ENVIRONMENT=staging` and `ENVOI_RELEASE_SHA=2b18170d59b0096ff997d9a79487d50ccb627ef9`, while `SINALOA_RELEASE_SHA` still names `8c5f67b…`. Calendar, consequential-action and email flags are `false`. No agent-native flag value was exposed in the read-only view. The Neon console confirms separate named projects and their backup controls, but the encrypted Worker secret prevents matching the live runtime to the intended staging project. These observations establish the old served baseline only; they do not establish candidate deployment, flag readiness, a safe rollback pair, or a hosted gate pass.

The sanitized observations and unresolved checks are also recorded on [build-board issue #34](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6325917054). The first receiver's OS is an explicit candidate decision: if it uses Windows, or the Windows wake-store repair in #174 is selected, pin a new candidate and served/installed artifact hashes and decide which gates must be rerun. If #174 stays outside this Stage A candidate, record the selected non-Windows receiver platform and the known Windows wake-store limitation. Neither choice is a hosted pass by itself.

## 2. Bounded test authorization fields

Complete every cell before the live batch; the two approvals distinguish rollout from test traffic.

| Field | Value |
| --- | --- |
| Rollout approval: candidate, flag sequence, key custody and paired rollback | PENDING |
| Test approval: exact rows, operations, identities, model budget and cleanup | PENDING |
| Staging operator and read access for evidence collector | Rachel confirmed on 2026-10-21 that she can operate staging. Exact run window, evidence handoff, and any additional read access remain TO DECIDE. This is not rollout or test approval. |
| UTC window, maximum duration and hard stop time | TO DECIDE |
| Two disposable owner identities and workspace IDs (private reference only) | TO DECIDE |
| Hermes version/OS and model provider/model | TO DECIDE |
| OpenClaw version/OS and model provider/model | TO DECIDE |
| Maximum model calls, tokens and total cost | TO DECIDE |
| Maximum approved sends, faults, restarts, pauses, revokes | TO DECIDE |
| Evidence custodian and sanitized retention location | TO DECIDE |
| Cleanup operator and deadline | TO DECIDE |

The test plan must enumerate each planned send and intervention by row and target. Do not start with a generic approval to 'run the gate'. Keep test message bodies, codes, tokens, cookies, activation IDs and raw HTTP out of this record.

## 3. Hosted onboarding rows

Use the local [21-row template](../../../docs/architecture/agent-native-v2/evidence/phase-b-local-TEMPLATE.md) as the exact behavioral source. It scores Hermes rows 1–10 individually, OpenClaw rows 1–10′ as one grouped row with ten required observations, and shared rows 11–20 individually: 21 logical rows, 30 host-level observations. Record server event IDs/sequences, owner view, and host observation for every applicable row. A row passes only when the three views agree.

| Group | Required hosted observation | Server/owner evidence | Host evidence | Result |
| --- | --- | --- | --- | --- |
| H01–H10 Hermes | Fresh profile; `/connect` and served skill; `envoi-link connect`; private registration; claim URL/code only in chat; owner claim and permission approval; private activation; authenticated connection; one native work item | PENDING | PENDING | NOT RUN |
| O01–O10 OpenClaw (one grouped logical row) | Same fresh journey and all ten observations on OpenClaw | PENDING | PENDING | NOT RUN |
| X11–X12 exchange | Approved Hermes send; one OpenClaw reply; canonical receipts | PENDING | PENDING | NOT RUN |
| R13–R15 recovery | Stop OpenClaw, approve one item while offline, restart with same private state and credential family, process once | PENDING | PENDING | NOT RUN |
| V16–V17 revoke | Revoke the installation; reject late claim, refresh, send and processing; no automatic reenrollment | PENDING | PENDING | NOT RUN |
| N18–N19 reconnect | Human-approved new installation for the **same** agent ID and address; prior history retained | PENDING | PENDING | NOT RUN |
| U20 owner agreement | Revoked and active installation states match server, owner UI and host | PENDING | PENDING | NOT RUN |

Also record two hosted-specific checks:

1. **No source checkout or secret pasting:** the operator gives a fresh agent only the public `/connect` starting point. Record every operator assist. If the agent cannot fetch the public skill unaided, mark the deviation and determine whether the advertised flow still holds.
2. **Artifact agreement:** compare served skill/download SHA-256 with the candidate manifest and the installed bytes. A mismatch stops the batch until a new exact release is selected and the whole applicable gate is reassessed.

## 4. Phase C dependency and wake boundary

Once Phase B hosted onboarding passes, transfer the two installation IDs and exact release identities (without credentials) to the Stage A Phase C record. The wake-on C19–C21 batch must show: signed raw-byte callback, authenticated canonical fetch, intended runtime claiming scoped work, and one canonical effect. Include missed callback, duplicate callback, restart, pause and revoke. A callback ACK alone does not pass. Do not claim automatic closed-app reachability for a host whose agent process is stopped.

## 5. Stop and cleanup

Stop immediately for failed `/health` or `/ready`; release/artifact mismatch; unexpected flag or route; staging/beta storage overlap; rollback pair not verified; TLS/signature failure; cross-tenant or wrong-agent effect; exposed secret in transcript/log; unbudgeted model or network cost; unauthorized send or lifecycle action; or a row needing a different candidate. Freeze writes, retain sanitized evidence, and use the approved rollback procedure. Every failure opens a fix and a fresh full applicable gate on one new exact candidate.

At the approved end, stop the receiver, end subscriptions/sessions, revoke disposable installations, and preserve sanitized server/owner/host evidence with UTC timestamps. Mark cleanup results explicitly; do not delete raw private evidence before its approved retention point.

## 6. Result and countersign

| Field | Value |
| --- | --- |
| Exact release, Worker version and image | NOT RUN |
| Served/installed artifact agreement | NOT RUN |
| Hosted template logical rows | 0/21 passed; no rows run |
| Per-host observations | Hermes 0/10 run; OpenClaw 0/10 run (one grouped logical row) |
| Shared observations 11–20 | 0/10 run |
| Deviations and defects | None observed; test not run |
| Server, owner and host evidence links | NOT RUN |
| Phase B hosted result and independent review | PENDING |
| Human countersign for this exact release | PENDING |

Passing this record closes hosted helper onboarding for the two tested products and versions only. Other route and named-host breadth remains a separate Phase B milestone.
