# Phase B hosted onboarding: execution record (prepare before live run)

**Status:** PREPARED, NOT RUN. This record is for the first hosted Hermes/OpenClaw helper gate. It does not grant authority to deploy, change flags, enroll an agent, send work, call a model, fault a service, or revoke an installation. Fill the release and operation fields, obtain the existing separate rollout and bounded-test approvals, then copy this file to `phase-b-hosted-<40-character-sha>.md` for the run.

The local 21/21 gate at `e8a958f` is prior evidence. Rachel and Je also [countersigned the historical B/C tests](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176). Credit that closeout; it does not establish a hosted run of later client bytes. The operator and human reviewer must identify which rows are affected by the selected exact candidate, run those rows on the served release and installed artifacts, and record why any historical result remains applicable. Keep Phase C wake C19–C21 in the first hosted batch as already selected, but record those results in the Phase C packet rather than silently counting them as Phase B onboarding.

## 1. Immutable release and staging baseline

| Field | Required value / evidence | Current state |
| --- | --- | --- |
| Candidate source | Full 40-character SHA, clean worktree, exact-head CI and integrated CI URLs | Consolidated [#199](https://github.com/rachelgonsalves821/Envoi/pull/199) was integrated once into `integration/agent-native` at `244c117fb2a00d6bdc95a991f9021a1fdb94b262`. Its [exact-head CI](https://github.com/rachelgonsalves821/Envoi/actions/runs/39822315681) and [integration-push CI](https://github.com/rachelgonsalves821/Envoi/actions/runs/39824809365) each passed all 26 steps. The source combines #192, #195 and #197 once, including the #174 Windows wake-store fix through #192; do not apply those constituent changes again. #184 remains documentation only. This is integrated code, **not** a selected or served staging release. The separate approved #198 contract stack and later client/server stacks are not included. Select the final combined exact candidate, decide affected-row applicability, then repin served and installed hashes. |
| Staging Worker | Account, Worker name, current version ID, current `/health` release SHA, `/ready`, and routes response | Rachel-account read-only observation [#34 comment 6327296775](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6327296775): `sinaloa-staging` version `0c075364-f7c0-458c-a297-edd05e72abe1` at 100%, serving `2b18170d59b0096ff997d9a79487d50ccb627ef9`; `/health` and `/ready` pass; `/api/onboarding/routes` returns `Not found` on this old release. A further read-only browser check reported at 2026-10-22 18:16 UTC still found that release SHA, with `/health` OK/configuration validated and `/ready` ready (database, deployment identity, object storage and scanner checks ready). This is current baseline evidence only, not a served #199 or hosted gate pass. |
| Staging container | Current image digest/reference paired with the current Worker version | Same Cloudflare build `f4710486-1a23-4046-be09-6f30db292ea2` records image `sha256:cf918d33dcfbf8c561c64b4f1f6c7a2f6a9bee61410d9b8e67018b71904a522f`; Container Versions v57 is 100% on this digest. This proves the **current baseline pair**, not a rehearsed rollback. |
| Staging storage | Sanitized database/storage identity, separation from beta, backup and restore status | Rachel's [Neon inventory](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6325917054): staging project `dry-poetry-47244003`, default branch `br-soft-mouse-b4fauf5d`, database `sinaloa_staging`; beta is separate project `dry-tooth-12968475`, default branch `br-tiny-morning-b4vk2xih`, database `sinaloa_beta`. Staging has a six-hour history window and no snapshot schedule. A fresh staging manual snapshot at 2026-10-21 21:49:21 UTC was restored at 21:50:27 into isolated branch `br-dawn-credit-b41uibf0`; the original production branch remained default. Both source and restore show 50+ `sinaloa_documents` rows in Neon's loaded UI; the restored branch also shows six public tables and four migration rows ([updated board evidence](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6327296775)). This proves populated isolated restoration at a bounded UI count level, not exact row/hash parity or application read. The encrypted live `DATABASE_URL` target remains unverified. |
| Rollback | Previous Worker version **and** image, settings/flag values, verified paired restore procedure, rehearsal result, operator | Current pair above is identified; prior image retention and paired restore rehearsal remain open. v56 is at 0% and may be pruned. Rachel is the staging operator. |
| Served artifacts | SHA-256 of `/connect/SKILL.md` and the public connector and OpenClaw downloads as fetched from staging | Not yet checked against staging |
| Private helper | SHA-256 of the built `integrations/onboarding/dist/envoi-link.mjs` from the selected candidate and the copy used by each host; there is no public helper download | #199's integrated source manifest records helper SHA-256 `b5b2dd9909b3d8cf044a74e60a9a9c84da3d5eed3b3c14a2656d9174807d73d2`; this is a source-build reference, not a served or installed match. Rebuild and repin if the final candidate changes. |
| Installed artifacts | SHA-256 of the exact skill, helper and runtime files used by the Hermes and OpenClaw profiles | Not yet installed |
| Hosted runtime bundles | Record the selected entry point, exact source SHA, Node 22 version, build command and SHA-256 of every installed file | The normal local helper is built privately with its sibling connector bundle; the public connector and OpenClaw Quick Connect downloads are checked separately against installed bytes. If the manual host `run.mjs` path is selected instead, root `npm run build` does not build it: run the Hermes/OpenClaw Vite entry build from the pinned candidate and hash the installed Hermes file or complete OpenClaw `dist/` graph. Local draft manual-bundle builds passed on 2026-10-21; no pinned or installed hash is claimed. |
| Receiver | HTTPS host/URL/TLS operator, route to each runtime, durable private store, restart procedure | Rachel authorized a bounded Windows-PC receiver using a temporary public HTTPS tunnel. Operator-reported preflight: signed `cloudflared` 2026.10.3 (SHA-256 `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`) opened a Quick Tunnel to a **closed local port**, and staging `createWakeDestination.resolve` accepted its actual `/envoi/wake` URL against `ENVOI_PUBLIC_URL`. The ephemeral hostname is withheld. This proves DNS/SSRF destination acceptance only; no callback, listener, subscription, installed runtime or closed-app wake was exercised. #199 now persists validated wake settings in the private per-installation directory and reloads them on supervised start under the connector lock. For the live batch, verify the actual installed service reuses those settings after restart with no setup-shell wake environment; if the tunnel URL changes, use the explicit stopped-service rotation path and record the new endpoint before accepting a callback. The PC, tunnel and connector must remain running for hosted wake. The executable Hermes/OpenClaw receiver composition and exact-release test remain open. |

**Staging promotion method:** `scripts/promote-release.mjs --deploy` is guarded to `origin/main` and cannot deploy the integrated SHA `244c117` unchanged. The runbook's `npm run cf:deploy:staging` instead invokes `scripts/deploy-staging.mjs`, which accepts a clean exact HEAD and stamps `ENVOI_RELEASE_SHA`, subject to its secret-name guards. These are distinct paths. Select and record the reviewed staging path and final candidate before any rollout; do not claim the main-only guard applies to the staging script.

Collect remaining read-only staging facts under Stage A packet #172 §2.2 on the release account and reconcile them with the [recorded baseline](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6327296775). Stage A owns the deployment and recovery run sheet; this Lane B packet records only the dependencies for hosted client testing. Record only secret **names**, never values. The command operator must check their Wrangler version's help first. An inaccessible account or an unmatched Worker/image pair is a stop, not an inferred pass. A Worker-only rollback does not establish a restored container image; the two-component restoration needs an observed rehearsal.

## 2. Bounded test authorization fields

Complete every cell before the live batch; the two approvals distinguish rollout from test traffic.

| Field | Value |
| --- | --- |
| Rollout approval: candidate, flag sequence, key custody and paired rollback | PENDING |
| Test approval: exact rows, operations, identities, model budget and cleanup | PENDING |
| Staging operator and read access for evidence collector | Rachel operates staging; evidence collector and any read-only access still TO DECIDE |
| UTC window, maximum duration and hard stop time | TO DECIDE in the exact-version bounded-test approval; no prior prep time is an approved window |
| Two disposable owner identities and workspace IDs (private reference only) | TO DECIDE in the exact-version bounded-test approval; record exact private references before the batch, not in this public packet |
| Hermes version/OS and model provider/model | TO DECIDE |
| OpenClaw version/OS and model provider/model | TO DECIDE |
| Maximum model calls, tokens and total cost | TO DECIDE in the exact-version bounded-test approval, including per-call and total limits |
| Maximum approved sends, faults, restarts, pauses, revokes | TO DECIDE; no operation count inferred from a proposed spend limit |
| Evidence custodian and sanitized retention location | TO DECIDE |
| Cleanup operator and deadline | TO DECIDE in the exact-version bounded-test approval |

The test plan must enumerate each planned send and intervention by row and target. Do not start with a generic approval to 'run the gate'. Keep test message bodies, codes, tokens, cookies, activation IDs and raw HTTP out of this record.

## 3. Hosted onboarding rows

Use the local [21-row template](phase-b-local-TEMPLATE.md) as the behavioral source. Record server event IDs/sequences, owner view, and host observation for every newly applicable row. A row passes on the new candidate only when the three views agree. For a retained historical pass, cite its countersign and a specific applicability rationale rather than relabeling it as a new run.

| Group | Required hosted observation | Server/owner evidence | Host evidence | Result |
| --- | --- | --- | --- | --- |
| Rows 1–10 Hermes | Fresh profile; `/connect` and served skill; `envoi-link connect`; private registration; claim URL/code only in chat; owner claim and permission approval; private activation; authenticated connection; one native work item | PENDING | PENDING | NOT RUN |
| Repeat group 1–10′ OpenClaw | Same fresh journey and observations on OpenClaw; counted as one grouped row in the 21-row source template | PENDING | PENDING | NOT RUN |
| Rows 11–12 exchange | Approved Hermes send; one OpenClaw reply; canonical receipts | PENDING | PENDING | NOT RUN |
| Rows 13–15 recovery | Stop OpenClaw, approve one item while offline, restart with same private state and credential family, process once | PENDING | PENDING | NOT RUN |
| Rows 16–17 revoke | Revoke the installation; reject late claim, refresh, send and processing; no automatic reenrollment | PENDING | PENDING | NOT RUN |
| Rows 18–19 reconnect | Human-approved new installation for the **same** agent ID and address; prior history retained | PENDING | PENDING | NOT RUN |
| Row 20 owner agreement | Revoked and active installation states match server, owner UI and host | PENDING | PENDING | NOT RUN |

Also record four hosted-specific checks:

1. **No source checkout or secret pasting:** the operator gives a fresh agent only the public `/connect` starting point. Record every operator assist. If the agent cannot fetch the public skill unaided, mark the deviation and determine whether the advertised flow still holds.
2. **Artifact agreement:** compare served skill/download SHA-256 with the candidate manifest and the installed bytes. A mismatch stops the batch until a new exact release is selected and the whole applicable gate is reassessed.
3. **Supervised restart:** on the selected Windows host, record the actual Task Scheduler or wrapper configuration and the private per-installation wake-settings path. Restart the connector with no setup-shell `ENVOI_WAKE_*` values, verify that it reloads the validated settings under the connector lock and still selects hosted wake rather than default polling, and reconcile any changed tunnel URL through the explicit stopped-service rotation path before accepting a new callback. A passing offline persistence test or one-time setting in the setup shell is insufficient.
4. **Pre-subscription receiver alignment (read-only):** immediately before the first subscription attempt, compare the current tunnel's exact public HTTPS URL and forwarded loopback port with the private `hosted-wake.json` URL/path and port for that installation. Compare its installation ID with authenticated server/owner evidence. Inspect the registered Task Scheduler action (or selected supervisor) and its private state directory to confirm it starts the pinned Node 22+ connector bundle for the same installation; compare the installed bundle SHA-256 with the selected candidate manifest. Perform these comparisons privately and record only UTC time, PASS/FAIL and artifact hashes here, without the ephemeral hostname, installation ID, state contents or credentials. A missing setting or mismatch stops the batch before subscription; use the explicit stopped-service rotation path and repeat this check after any tunnel URL, service action or artifact change. The earlier closed-port DNS/SSRF preflight does not establish this alignment.

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
| Pre-subscription receiver alignment | NOT RUN |
| Hosted template rows | 0/21 passed; no rows run |
| Per-host observations | Hermes 0/10 run; OpenClaw repeat group 1–10′ NOT RUN |
| Shared observations 11–20 | 0/10 run |
| Deviations and defects | None observed; test not run |
| Server, owner and host evidence links | NOT RUN |
| Phase B hosted result and independent review | PENDING |
| Human countersign for this exact release | PENDING |

Passing this record closes hosted helper onboarding for the two tested products and versions only. Other route and named-host breadth remains a separate Phase B milestone.
