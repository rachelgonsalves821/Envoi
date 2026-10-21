# Stage A packet: first hosted Phase C batch on staging (outline)

**Status:** outline. Owner: Lane A. Approver: Je (pjsk02). Rachel approves the release and the test batch.

This packet answers Rachel's staging-readiness checklist ([#34 comment 6278173316](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6278173316)). When every section below is filled in and reviewed, Codex brings Rachel **one** approval request with two separate clauses:
1. the exact-SHA staging rollout, its flags and its rollback;
2. the bounded hosted test batch and its costs, including the required wake coverage.

Nothing in this packet authorizes a deploy, a flag or secret change, a model call, an enrollment, a send, a fault or a revoke. The procedure itself is [`phase-c-rollout-runbook.md`](phase-c-rollout-runbook.md). This packet records the facts and choices that runbook leaves as **TO CONFIRM**.

## 0. Where each section stands

| § | Section | Owner | Status | Blocked on |
| --- | --- | --- | --- | --- |
| 1 | Final candidate and inclusion list | Lane A, with Lane B for the client | **Open** | Lane B's client inclusion answer (§1.3) |
| 2 | Staging baseline and paired rollback | Rachel (read-only facts, her account), Lane A (write-up) | **Open** | Rachel's Cloudflare read-only output (§2.2) |
| 3 | Flags, settings and network scope, wake ON | Lane A, Je for key custody | **Open** | §2 facts; key custody decision (§3.3) |
| 4 | Wake receiver and host handoff | Lane B (receiver), Je (hosting), Lane A (server side) | **Open** | Receiver hosting decision (§4.1) |
| 5 | Bounded hosted test batch | Lane A drafts, Lane B reviews the client rows | **Open** | §1, §4 |
| 6 | Approval request | Codex, for Rachel | Not started | §1–§5 reviewed |

## 1. Final candidate and inclusion list

### 1.1 Candidate

- **SHA:** `25c66372dc16f399cc5b213368246ebba9d65fd1` on `integration/agent-native` (#170, integrated 2026-10-21).
- **CI:** exact-head PR [run 39524219752](https://github.com/rachelgonsalves821/Envoi/actions/runs/39524219752) and integration push [run 39550313276](https://github.com/rachelgonsalves821/Envoi/actions/runs/39550313276), both 26/26 with both audits at 0.
- **Local gate:** Gate B-local PASS 21/21 at `e8a958f`, countersigned ([6304550858](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6304550858)), evidence `evidence/phase-b-local-e8a958f1f6d56e9efde5c0f9bc269b2bdd43d7bc.md`. The runtime at `25c6637` is identical to `e8a958f`: `src`, `web`, `db`, `protocol`, the skill, `test/contract-fixtures`, `Dockerfile.cloudflare` and `wrangler.jsonc` have no diff. Rachel's agent found no runtime delta needing another live run ([CLOSE-OK 6305156369](https://github.com/rachelgonsalves821/Envoi/pull/170#issuecomment-6305156369)).

### 1.2 Artifact identities at the candidate

| Artifact | Identity | How to recheck |
| --- | --- | --- |
| Private helper `integrations/onboarding/dist/envoi-link.mjs` | SHA-256 `5c2a4318cc37adf97b4a28a46345b9a720d16987c93746ea6eb667cb51ffabaa` | clean `npm ci` and `npm run build`, then hash |
| `web/downloads/envoi-connector.mjs` | SHA-256 `4d9ad722cdc79b9be303e0b42cd69d3749652f608021fd2d376c4a342cbe3f12`, 463,987 bytes | `web/downloads/release.json` |
| `web/downloads/envoi-openclaw.mjs` | SHA-256 `c0fa24e9f56325f3224e63489350c1dd9eba3b49689bf6fada25b39fda4ad2ee`, 350,700 bytes | `web/downloads/release.json` |
| Served `/connect/SKILL.md` | SHA-256 `b6e685a34f151d195affe5f6bbc505765e1e4d3ad6fbeaf345693e9b1d7932df` | `scripts/gate-b-local/preflight.mjs` against staging |
| Container image | **TO CONFIRM** after `npm run cf:deploy:staging` builds it | §2.2 |
| Worker version | **TO CONFIRM** after the deploy | §2.2 |

The image is not byte-identical to one built at `e8a958f`: the Dockerfile copies `docs/` and the root package files, which differ. Its identity is recorded after the build.

### 1.3 Inclusion list

**In the candidate** (integrated):
- Phase B: agent-registration v1 rev 4 (#155, #156, #157 via #158), onboarding, the served skill with its deployment origin (#161, #163).
- Phase C server: case-session, case-tools and http-wake (C-A0–C-A6, #148), with the follow-ups #150, #151, #152 and the rollout runbook #153.
- Provider browser polling (#144), with `ENVOI_PROVIDER_BROWSER_POLL` **off** (decision [6279259661](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6279259661)).
- Gate B-local evidence and tooling (#149, #160, #165, #167, #168), and the vite 8.3.3 dependency fix (#169).
- Some Phase C client code is already present, for example `integrations/connector/http-wake-receiver.ts`, `http-wake-host.ts` and `integrations/agent-bridges/scoped-turn.ts`.

**Not in the candidate:** #166 (superseded by #169), and the open Lane B Phase C client drafts:
- #118 (C-B1 case sessions) and #120 (C-B2 case tools);
- #124, #125, #127, #129, #134 and #135 (C-B3 runtime transports);
- #126 and #140 (C-B4 owner views);
- #130, #131 and #132 (C-B5 HTTPS wake receiver);
- #128 (C-B0/C-B6 evidence prep), plus #136 and #138.

**Question for Lane B.** Which C-B1–C-B5 content does the hosted batch need that `25c6637` does not already contain? If any is needed, integrating it changes the served connector downloads and possibly the helper. That makes a new candidate, which needs its own exact-head CI and an applicable-gate assessment under L5 before this packet can name it. **This is the item most likely to change §1.1.**

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

### 4.1 Decisions needed

| Question | Owner | Answer |
| --- | --- | --- |
| Where the public HTTPS receiver runs (host, operator, TLS), and its cost | Je, with Lane B | **TO DECIDE** |
| Which receiver code, at which version and hash | Lane B (C-B5) | **TO CONFIRM**, tied to §1.3 |
| How the receiver hands a wake to the Hermes or OpenClaw host | Lane B | **TO CONFIRM** |
| Which process must stay running, and which idle, offline and restart states are supported | Lane B | **TO CONFIRM**; a dead process cannot be woken |
| Missed and duplicate wake recovery | Lane B, Lane A | per http-wake v1; **TO CONFIRM** the evidence for each |

### 4.2 Fences that stay in force

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
