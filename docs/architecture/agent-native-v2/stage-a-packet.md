# Stage A packet: first hosted Phase C batch on staging (outline)

**Status:** outline. Owner: Lane A. Approver: Je (pjsk02). Rachel approves the release and the test batch.

This packet answers Rachel's staging-readiness checklist ([#34 comment 6278173316](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6278173316)). When every section below is filled in and reviewed, Codex brings Rachel **one** approval request with two separate clauses:
1. the exact-SHA staging rollout, its flags and its rollback;
2. the bounded hosted test batch and its costs, including the required wake coverage.

Nothing in this packet authorizes a deploy, a flag or secret change, a model call, an enrollment, a send, a fault or a revoke. The procedure itself is [`phase-c-rollout-runbook.md`](phase-c-rollout-runbook.md). This packet records the facts and choices that runbook leaves as **TO CONFIRM**.

## 0. Where each section stands

| § | Section | Owner | Status | Blocked on |
| --- | --- | --- | --- | --- |
| 1 | Final candidate and inclusion list | Lane A, with Lane B for the client | **Proposed** `25c6637`; client inclusion answered (§1.3) | Je's final selection; the image and Worker pair after the build (§1.2) |
| 2 | Staging baseline and paired rollback | Rachel (read-only facts, her account), Lane A (write-up) | **Open** | Rachel's Cloudflare read-only output (§2.2) |
| 3 | Flags, settings and network scope, wake ON | Lane A, Je for key custody | **Open** | §2 facts; key custody decision (§3.3) |
| 4 | Wake receiver and host handoff | Lane B (receiver), Je (hosting), Lane A (server side) | **Composition known** (§4.1); offline coverage 155/155 | The operator, hosting and TLS decisions (§4.2) |
| 5 | Bounded hosted test batch | Lane A drafts, Lane B reviews the client rows | **Open** | §1, §4 |
| 6 | Approval request | Codex, for Rachel | Not started | §1–§5 reviewed |

## 1. Final candidate and inclusion list

### 1.1 Candidate

- **SHA:** `25c66372dc16f399cc5b213368246ebba9d65fd1` on `integration/agent-native` (#170, integrated 2026-10-21).
- **CI:** exact-head PR [run 39524219752](https://github.com/rachelgonsalves821/Envoi/actions/runs/39524219752) and integration push [run 39550313276](https://github.com/rachelgonsalves821/Envoi/actions/runs/39550313276), both 26/26 with both audits at 0.
- **Local gate:** Gate B-local PASS 21/21 at `e8a958f`, countersigned ([6304550858](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6304550858)), evidence `evidence/phase-b-local-e8a958f1f6d56e9efde5c0f9bc269b2bdd43d7bc.md`. The runtime at `25c6637` is identical to `e8a958f`: `src`, `web`, `db`, `protocol`, the skill, `test/contract-fixtures`, `Dockerfile.cloudflare` and `wrangler.jsonc` have no diff. Rachel's agent found no runtime delta needing another live run ([CLOSE-OK 6305156369](https://github.com/rachelgonsalves821/Envoi/pull/170#issuecomment-6305156369)).
- **Evidence retention:** the published worksheet, its 11 sanitized tables and the as-run probe source are kept in the repository. The private raw local evidence (data, views, logs and the private worksheet copy) was deleted by the operator before the retention asked for in CLOSE-OK ([6309161732](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6309161732)). It is **unavailable**, not retained and not independently verified as raw host data. This does not change the countersigned result.
- **Integration has moved on:** integration is now at `bbd361e` (#171, agent-remote-auth v1 revision 2). That change is contract-only: `handoffs.md`, new `test/contract-fixtures/agent-remote-auth/` fixtures and their test. It adds no runtime source and **does not select a new candidate**. The candidate stays `25c6637` unless a reviewed host-composition change is shown, in which case the new head needs its own artifacts, CI and applicable-gate assessment.

### 1.2 Artifact identities at the candidate

| Artifact | Identity | How to recheck |
| --- | --- | --- |
| Private helper `integrations/onboarding/dist/envoi-link.mjs` | SHA-256 `5c2a4318cc37adf97b4a28a46345b9a720d16987c93746ea6eb667cb51ffabaa` | clean `npm ci` and `npm run build`, then hash |
| `web/downloads/envoi-connector.mjs` | SHA-256 `4d9ad722cdc79b9be303e0b42cd69d3749652f608021fd2d376c4a342cbe3f12`, 463,987 bytes | `web/downloads/release.json` |
| `web/downloads/envoi-openclaw.mjs` | SHA-256 `c0fa24e9f56325f3224e63489350c1dd9eba3b49689bf6fada25b39fda4ad2ee`, 350,700 bytes | `web/downloads/release.json` |
| Served `/connect/SKILL.md` | SHA-256 `b6e685a34f151d195affe5f6bbc505765e1e4d3ad6fbeaf345693e9b1d7932df` | `scripts/gate-b-local/preflight.mjs` against staging |
| Container image | **TO CONFIRM** after `npm run cf:deploy:staging` builds it | §2.2 |
| Worker version | **TO CONFIRM** after the deploy | §2.2 |

These hashes are the committed and operator-built identities at the candidate source. They are **not yet verified** against bytes served by staging or installed on a host; that check belongs to the hosted run.

The image is not byte-identical to one built at `e8a958f`: the Dockerfile copies `docs/` and the root package files, which differ. Do not infer an unchanged production image from "docs only". The exact image and Worker pair is recorded after the build, separately from these source identities.

### 1.3 Inclusion list

**In the candidate** (integrated):
- Phase B: agent-registration v1 rev 4 (#155, #156, #157 via #158), onboarding, the served skill with its deployment origin (#161, #163).
- Phase C server: case-session, case-tools and http-wake (C-A0–C-A6, #148), with the follow-ups #150, #151, #152 and the rollout runbook #153.
- Provider browser polling (#144), with `ENVOI_PROVIDER_BROWSER_POLL` **off** (decision [6279259661](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6279259661)).
- Gate B-local evidence and tooling (#149, #160, #165, #167, #168), and the vite 8.3.3 dependency fix (#169).
- **Phase C client (C-B1–C-B5)**, through #143 (`9b9c109`, an ancestor of `25c6637`, 48 commits earlier). #143 applied each stack once ([Lane B's answer 6318749324](https://github.com/rachelgonsalves821/Envoi/pull/172#issuecomment-6318749324)):
  - #139 at `5f6cb04`, which carries #118, #120, #124, #125, #127, #129, #130, #131, #132, #134 and #135;
  - #140 at `5d38b2a`, which includes #138, #123 and #136;
  - the tops of #126 (`41e16ae`), #128 (`546ad5c`) and #142 (`a932de2`).

  Lane B's tree comparison at `25c6637` found the SDK, shared agent bridge, Grok and OpenClaw, connector, Hermes, owner-file and evidence-prep content present, including the C-B5 receiver, host, driver and HTTP handler and the import-safe packaged exports. The later differences are the reviewed Phase B reconnect, adoption and origin work, not missing Phase C source.

**Not in the candidate:** #166 (superseded by #169).

The standalone C-B drafts listed above are still open on GitHub, but only as old stacks. Their selected content is already in the candidate, so **no further merge of them is needed**, and their stacked ancestors must not be reapplied. This is source inclusion only. It is not acceptance of C-B3, C-B5 or C-B6, which the hosted run decides.

## 2. Staging baseline and paired rollback

### 2.1 What is already known

- **Worker:** Wrangler environment `staging` (`workers_dev: true`, one `basic` container, `max_instances: 1`, cron `* * * * *`). It is deployed with `npm run cf:deploy:staging`, which passes only `ENVOI_RELEASE_SHA` and refuses a dirty worktree.
- **URL on record:** `https://sinaloa-staging.rachelgonsalves821.workers.dev` (2026-09-29). Still to be confirmed current.
- **No database rollback:** Phase C adds no SQL migration (runbook §6).

### 2.2 Read-only facts Rachel collects

Staging runs in the release account `54a5d6c680bd813fa60f8e088b098b8d` (`RELEASE_ACCOUNT_ID` in `scripts/promote-release.mjs`), Worker `sinaloa-staging`. Je has no access to it: his Wrangler login is his own account, and `deployments list --env staging` returns `10007 This Worker does not exist on your account`. So Rachel runs these ([request 6319964774](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6319964774)). Whether Je gets read-only access for the run itself is open (§2.3).

Run these from a clean checkout of `25c6637`, signed in to that account. They only read; none of them deploys or changes anything. Check each command's flags with `--help` on the installed Wrangler first. Paste the output, without any secret value.

| Fact | Command | Records |
| --- | --- | --- |
| Account | `npx wrangler whoami` | the account staging is in |
| Live staging version (rollback target) | `npx wrangler deployments list --env staging` | the current version ID and when it was deployed |
| Recent versions | `npx wrangler versions list --env staging` | the version history |
| Container image | `npx wrangler containers list` and `npx wrangler containers images list` | the image reference the live version runs |
| Secret **names** only | `npx wrangler secret list --env staging` | which secrets exist; never their values |
| Live release | `curl -s https://sinaloa-staging.rachelgonsalves821.workers.dev/health` and `/ready` | `releaseSha`, `deploymentEnvironment`, dependency checks |
| Live flags | `curl -s https://sinaloa-staging.rachelgonsalves821.workers.dev/api/onboarding/routes` | which Phase B flags are on now |

Also needed from Je or Rachel, not from these commands:
- **The staging database's identity and backup status**, in sanitized form. It must be separate from beta; the GA rerun found that sharing caused contamination.
- **The exact Cloudflare operation that restores a Worker version together with its image**, and whether it has been rehearsed on staging (runbook §6).

### 2.3 Rollback plan (filled in from §2.2)

- **Rollback pair:** Worker version **TO CONFIRM**, image **TO CONFIRM**, settings (flag values and secret names) **TO CONFIRM**.
- **Who operates staging during the run:** Rachel, or Je with read-only access to the release account. **TO DECIDE.** The preflight (runbook §5) records the Worker version and image at every step, so whoever runs it needs that read access.
- **Rollback by flag** first: flags off in reverse order in one settings-only version, wait for the restart, run the preflight.
- **Rollback by code** if needed: flags off, restore the pair, confirm `/health` shows the previous SHA, and follow `docs/deployment.md` "Phase B agent-registration code rollback" if the target predates A-4.x.
- **Stop conditions:** runbook §5 preflight failures and §7 freeze rules.

## 3. Flags, settings and network scope (wake ON)

### 3.1 Flags, in order

| Step | Flag | First hosted batch |
| --- | --- | --- |
| 1 | `ENVOI_INSTALLATIONS_V2` | `true` |
| 2 | `ENVOI_AGENT_REGISTRATION_V2` | `true` |
| 3 | `ENVOI_CASE_SESSIONS_V1` | `true` |
| 4 | `ENVOI_HTTP_WAKE_V1` | `true`: **wake ON, C19–C21 included** (Rachel's decision [6278276747](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6278276747)) |
| — | `ENVOI_AUTHENTICATED_REST_ROUTE` | `false` |
| — | `ENVOI_PROVIDER_BROWSER_POLL` | `false` |

Each step is followed by the runbook §5 preflight.

### 3.2 Wake settings

| Setting | Proposed value | Status |
| --- | --- | --- |
| `ENVOI_WAKE_SELF_HOSTS` | the staging `workers.dev` host and `envoi-agents.com` | **TO CONFIRM** with §2.2 |
| `ENVOI_WAKE_EXTRA_BLOCKED_CIDRS` | Cloudflare Containers egress ranges | **TO CONFIRM**: needs Cloudflare's published ranges |
| `ENVOI_WAKE_DNS_RESOLVERS` | default `1.1.1.1,8.8.8.8` | **TO CONFIRM** that the container has outbound DNS (UDP and TCP 53) |

### 3.3 Signing key custody

- **Je generates** one Ed25519 key (PKCS#8, base64) on a trusted machine and keeps the only copy outside Git, chat and the board.
- **It goes in** with `wrangler versions secret put ENVOI_WAKE_SIGNING_KEYS --env staging`, entered on standard input, never `wrangler secret put`. The resulting version is recorded as part of the rollback pair.
- **Rotation:** a next key is published at least 24 h before its `activeFrom`.
- **TO CONFIRM:** where Je stores the key, and the exact `wrangler versions deploy` invocation on the installed Wrangler.

## 4. Wake receiver and host handoff

The first batch must show the whole path, not just an HTTP 200 callback: the signed notification reaches the receiver, the receiver makes an authenticated canonical fetch, and the intended host and agent claim and do the authorized work.

### 4.1 Receiver composition, from the integrated source

Lane B's answers ([6321223317](https://github.com/rachelgonsalves821/Envoi/pull/172#issuecomment-6321223317), [6321318450](https://github.com/rachelgonsalves821/Envoi/pull/172#issuecomment-6321318450)), from source in the candidate:

- **Artifact:** the verified `envoi-connector.mjs` (§1.2) exports `EnvoiConnector`, `HttpWakeReceiver`, `FileWakeStore`, `createScopedWakeHost` and `createWakeHttpHandler` (`integrations/connector/entry.ts`, `http-wake.md`). The host imports all of them from that one artifact, so class identity holds. Importing opens no port and starts no process or subscription.
- **Handoff:** the host application gives the real `EnvoiConnector` its private `ConnectorStore` and the accepted snapshot-first `CaseSession` handler. `createScopedWakeHost` binds the scoped wake work driver, the authenticated wake transport, the installation identity and the registered URL. The receiver and the host use the **same** private `FileWakeStore` and the canonical subscription URL the server returns. The driver, not model output and not anything in a notification, does the canonical work and lease revalidation.
- **HTTPS and process:** an explicitly authorized host application attaches `createWakeHttpHandler` to its HTTPS listener, or to a TLS terminator that passes the raw bytes unchanged. It passes the shutdown signal and runs `host.run(signal)`. The receiver must be up **before** the subscription is created. The download is not itself a deployed receiver: it needs a running trusted host and listener, and a reachable runtime. A stopped process cannot be woken, and nothing here claims closed-app reachability.
- **Recovery:** the receiver stores acceptance, replay and pending state durably before it acknowledges. The HTTP handler sends the acknowledgement and dispatches only after the response finishes. A restart reopens the same private per-installation store and lock. A subscription the owner ended is never silently recreated.
- **Offline coverage, not hosted evidence:** five suites passed 155/155 on source byte-identical to integration: `http-wake-driver`, `http-wake-http`, `http-wake-host`, `http-wake-receiver` and the Hermes scoped host. They cover scoped admission, mint, end and fenced completion; refusal of a wrong origin or owner; raw-byte verification and replay deduplication; acknowledgement before dispatch; recovery of an interrupted dispatch; single-flight claims; pause; and terminal revoke without re-enrollment. They do not prove an installed runtime, public TLS, hosting or a billed model turn.

### 4.2 Decisions still needed

| Question | Owner | Answer |
| --- | --- | --- |
| The public HTTPS host, its operator, TLS, and the registered public URL | Je, with Lane B | **TO DECIDE** |
| The network path from that host to the Hermes or OpenClaw runtime, and which process stays running for the whole batch | Je, with Lane B | **TO DECIDE** |
| Which idle, offline and restart states the batch exercises | Lane B, Lane A | **TO CONFIRM** within the states in §4.1 |
| Hosting cost, the budget, and cleanup (stop the listener, end the subscriptions, delete the private store) | Je | **TO DECIDE** |
| Signing-key custody | Je | §3.3 |

**C19–C21 evidence must show the whole chain:** a signed callback, then an authenticated canonical fetch, then scoped work by the intended agent. It must also cover a missed callback, a duplicate callback and a restart, with pause and revoke in force. An HTTP 200, or a callback mock, is not enough.

### 4.3 Fences that stay in force

Pause and revocation keep their effect during wake: a paused case or agent gets no new authorized work, and a revoked installation is refused (C16–C18).

## 5. Bounded hosted test batch

| Item | Value |
| --- | --- |
| Runtimes and versions | Hermes **TO CONFIRM**, OpenClaw **TO CONFIRM** (fresh profiles, as in Gate B-local) |
| Model provider and model, by name | **TO CONFIRM** |
| Two-owner test identities | **TO CONFIRM**: two disposable staging owners; never a production identity, never the paused case `case_0260691b187444b08368d1047ee317cb` |
| Installations | fresh, matching the served artifacts in §1.2 |
| Rows | C01–C24 (Phase C plan, hosted acceptance matrix), with each deferral stated and its reason |
| Every send, restart, offline period, fault, pause and revoke | listed per row, with exact targets and limits: **TO DRAFT** |
| Model and billing budget | **TO CONFIRM** (calls, tokens, cost ceiling) |
| Duration and freeze window | **TO CONFIRM** (runbook §7: one candidate, no mid-run change) |
| Cleanup | revoke the test installations, end sessions and subscriptions, retain the evidence |
| Stop conditions | runbook §5 and §7, plus any secret in a transcript or log |
| Reviewers | server rows: Lane A; client rows: Lane B; countersign: Je |

Order of work: hosted onboarding first (Phase B on staging), then the dependent C rows.

## 6. Approval request (written last)

When §1–§5 are complete and reviewed, Codex posts Rachel one request with separate clauses:
1. **Rollout:** the candidate SHA, the flag order and settings, and the rollback pair.
2. **Test batch:** the rows, identities, every planned send or fault, the model budget, the duration and the cleanup.

Final Phase C acceptance still needs the hosted evidence and Je's countersign afterwards.
