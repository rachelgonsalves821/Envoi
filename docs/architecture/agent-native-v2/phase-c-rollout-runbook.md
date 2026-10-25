# Phase C staging rollout runbook (C-A6)

**Owner:** Lane A (server, contracts, integration). **Approver and operator:** Je (pjsk02); Rachel approves the release where the Phase C plan says so. **Scope:** staging only. This runbook does not cover beta or `main`.

This runbook covers turning on the Phase C server features on staging for the hosted C01–C24 run ([Phase C plan](phase-c-execution-plan.md), "Phase C hosted acceptance matrix"), and turning them off again. It changes nothing by itself. Every deploy, setting and flag change below is a human action (build plan §1 D3), and each one is confirmed on board #34 before it happens.

Values marked **TO CONFIRM** are not recorded in this repository. Fill them in from a read-only check before the run. Do not guess them.

## 1. Facts this runbook depends on

| Item | Value | Source |
| --- | --- | --- |
| Candidate SHA | **TO CONFIRM.** *(Reconciled 2026-10-23: `integration/agent-native` is now `d05498d`, with push CI green. The Stage A candidate, batch and receiver are unchanged and still need the human's exact selection; nothing below selects a newer SHA, and the remote-authorization flags stay OFF.)* `integration/agent-native` was `f3a71f6` at C-A6. The follow-ups #150, #151 and #152 are integrated in `e8a958f` (#162), the SHA that passed Gate B-local (countersigned on #34, comment 6304550858); `f7cafcb` adds only its evidence. The vite advisory fix (#169, vite 8.3.3) leaves `web/**` and the helper byte-identical, and vite is a dev dependency the image never installs, so it doesn't change the gated runtime. Recheck that on the final candidate: `npm run build` must leave `git status` clean and the helper must stay `5c2a4318…`. Any change to `src/**`, `web/**`, `db/**`, `protocol/**` or the helper needs the applicable gate again (L5). | board #34 |
| Release manifest and helper hashes | **TO CONFIRM for the final candidate.** At `9b9c109`/`f3a71f6` the owner recorded release-manifest `7b75636c…a013c` and onboarding-helper `0921201a…16f0`. The follow-ups change no generated output, but recompute the hashes on the final candidate anyway. | INTEGRATED C-A6 post |
| Staging Worker | Wrangler environment `staging` in `wrangler.jsonc` (`workers_dev: true`, one `basic` container, `max_instances: 1`, cron `* * * * *`). Deployed with `npm run cf:deploy:staging`, which passes only `ENVOI_RELEASE_SHA` and refuses a dirty worktree. | `wrangler.jsonc`, `scripts/deploy-staging.mjs` |
| Staging URL | `https://sinaloa-staging.rachelgonsalves821.workers.dev` as recorded on 2026-09-29. **TO CONFIRM** that it is still current. | `docs/runtime-configuration-status.md` |
| Cloudflare account | `RELEASE_ACCOUNT_ID` in `scripts/promote-release.mjs`. **TO CONFIRM** that staging is in this account. | repo |
| Staging database identity and backup | **TO CONFIRM.** It must be separate from beta; the GA rerun found that sharing caused contamination. | Je, read-only |
| Currently deployed staging version | **TO CONFIRM.** Record the Worker version ID, the container image reference and `/health` `releaseSha`. This is the rollback target (§6). | Je, read-only |
| Wake settings and signing key | **TO CONFIRM** (§3). **The first hosted batch runs with wake ON, and rows C19–C21 are in it** (Rachel's scope decision, board #34 comments 6278276747 and 6299040516). So that batch needs a public HTTPS receiver, the signing key and the wake settings before it starts. Wake OFF with C19–C21 reported as not run is no longer an option for it; that applies only to a later run Je and Rachel scope that way, and then those rows are never reported as passed. | Je, Rachel |
| Pinned Wrangler | `wrangler ^4.144.0` (root `package.json`). Check each command's flags with `--help` on the installed version before use. | repo |

## 2. Flags: order and dependencies

All four are server-only settings, default off. Only the exact string `true` turns one on. Any other non-empty value, such as `TRUE`, `1` or ` true`, fails startup, and so does a dependency that is not met (`src/onboarding-flags.js`). A misconfigured container never starts with a feature that only appears to be on.

| Step | Flag | Requires | What it turns on |
| --- | --- | --- | --- |
| 1 | `ENVOI_INSTALLATIONS_V2` | — | Installation records and owner installation routes (agent-registration v1). |
| 2 | `ENVOI_AGENT_REGISTRATION_V2` | 1 | Agent-led registration, claims and the `local_helper` route in `GET /api/onboarding/routes`. |
| 3 | `ENVOI_CASE_SESSIONS_V1` | 1 | Case-session mint and end, session tokens on `/mcp`, the case tools, coded settlement errors, and lease release on case pause (case-session v1 §1). |
| 4 | `ENVOI_HTTP_WAKE_V1` | 1 | Wake routes, the key set at `/.well-known/envoi-wake-keys.json`, and outbound notifications (http-wake v1 §1). It needs `ENVOI_WAKE_SIGNING_KEYS` with exactly one active key, or startup fails. |

`ENVOI_AUTHENTICATED_REST_ROUTE` stays `false`. It is not part of Phase C.

**Turning flags on.** Go one step at a time, in the order above. After each step, run the preflight (§5) and confirm that the new availability shows before taking the next step. Steps 3 and 4 do not technically need step 2, but the hosted rows exercise registered installations, so this order is the one to use.

**Turning flags off.** Use the reverse order: 4, 3, 2, 1. Turning off 1 while 2, 3 or 4 is on fails startup, which is safe, but it leaves staging down until the setting is fixed.

**How a change takes effect.** Flags and settings reach the container through the Worker's `CONTAINER_ENV_KEYS` (`worker/runtime-config.js`). Each settings change creates a new Worker version, while a running container keeps the settings it started with. On the next readiness probe, which the staging cron runs every minute, `restartForSettings` notices the changed settings fingerprint and restarts the container once (`worker/index.js`). Allow for that restart before reading the preflight: a flag is not on until `/health` and the status fields say so.

## 3. Required settings

| Setting | Kind | Needed for | Value |
| --- | --- | --- | --- |
| `ENVOI_RELEASE_SHA` | var, set by `cf:deploy:staging` | everything | the candidate SHA (§1) |
| The four flags (§2) | var | their feature | `true` or `false` |
| `ENVOI_WAKE_SIGNING_KEYS` | **secret** | flag 4 | JSON list of `{ kid, privateKey (PKCS#8 Ed25519, base64), activeFrom, notAfter }`, with exactly one active key (http-wake v1 §5.2). **TO CONFIRM:** key generation and custody by Je. |
| `ENVOI_WAKE_SELF_HOSTS` | var | flag 4 | The deployment's registrable domains and platform hosts, so that Envoi never calls itself. The host of `ENVOI_PUBLIC_URL` is always included. **TO CONFIRM** the staging list, for example its `workers.dev` host and `envoi-agents.com`. |
| `ENVOI_WAKE_EXTRA_BLOCKED_CIDRS` | var | flag 4 | Public-space ranges that must never be reached, such as the container platform's egress ranges (http-wake v1 §4.2). **TO CONFIRM.** |
| `ENVOI_WAKE_DNS_RESOLVERS` | var, optional | flag 4 | Defaults to `1.1.1.1,8.8.8.8`. The container needs outbound UDP and TCP port 53 to these resolvers (http-wake v1 §14). **TO CONFIRM** for Cloudflare Containers. |

**How to set the wake signing key.** Use `wrangler versions secret put ENVOI_WAKE_SIGNING_KEYS --env staging`, never `wrangler secret put`.
- `versions secret put` adds the secret to a new Worker version without deploying anything else. You then deploy that version on purpose, and record it as part of the rollback pair (§6).
- `secret put` creates and deploys a version immediately, so it can change what is running mid-gate, outside the recorded pair.
- Enter the value on standard input, never as a command argument. Never put it in Git, chat, the board, screenshots or logs. The server never logs keys.
- Publish the next key at least 24 h before its `activeFrom` (`keyPublishLeadSeconds`), except in an emergency rotation (§5.2 of the contract).
- **TO CONFIRM:** the exact `wrangler versions deploy` invocation for staging on the installed Wrangler.

## 4. Epochs: what restarts and rollbacks do

Both features keep a stored epoch document. Neither a session nor a subscription can outlive a disable or a code rollback.

**Case sessions** (`config/case-sessions-epoch`, case-session v1 §1):
- **Startup with the flag off** moves the epoch to now, so every earlier session token becomes an unknown bearer (`401 AUTHENTICATION_REQUIRED`).
- **Startup with the flag on** moves the epoch only if `activeUntil` has passed. While the flag is on, each server extends `activeUntil` to now + 60 s every 20 s.
- **Effect on the run:**
  - a restart, deploy or settings change that keeps the container down for **more than 60 s** ends every live session;
  - hosts mint a new session on their next turn, and nothing durable is lost;
  - a shorter restart keeps sessions.
- **During the run:** record every restart, and treat session refusals in the 60 s after one as expected, not as row failures.

**HTTPS wake** (`config/http-wake-epoch`, http-wake v1 §1):
- Same rules, with a 6 h window. While the flag is on, each server refreshes `activeUntil` to now + 6 h at least every 10 minutes. The server does it more often: every second at `f3a71f6`, and once a minute after #152.
- **Effect on the run:**
  - a restart or outage shorter than 6 h keeps every subscription;
  - startup with the flag off, or a longer gap, ends every earlier subscription with `endedReason: "feature_disabled"`, and hosts register and prove their URL again;
  - every move is audited as `http_wake.epoch_moved`, with its cause.
- **Rolling back code:** a pre-C-A5 server never refreshes `activeUntil`. Redeploying C-A5 more than 6 h later therefore moves the epoch, and that is intended.
- **Mixed rollout:** any instance that starts with the flag off moves the epoch for all instances. Staging runs `max_instances: 1`, so this only matters if that changes.

## 5. Read-only preflight

Run this before the first flag step, after each flag step, after every restart, and at the start of each session of the run. None of it writes anything.

1. **`GET /health`:** `ok: true`, `releaseSha` equal to the candidate SHA (§1), and `configurationValidated: true`. A `releaseSha` of `null` or another SHA stops the run.
2. **`GET /ready`:** HTTP 200 with `ready: true`, `deploymentEnvironment: "staging"` and the same `releaseSha`. Any failing dependency check (database, object storage, scanner) stops the run.
3. **`GET /api/onboarding/routes`** (no auth): `installationsEnabled` and `registrationEnabled` match flags 1 and 2.
4. **`GET /api/agent/status`** with a disposable test agent's access token: `caseSessions.available` matches flag 3 and `httpWake.available` matches flag 4. Never use a production identity, and never the paused case `case_0260691b187444b08368d1047ee317cb`.
5. **`GET /.well-known/envoi-wake-keys.json`:**
   - with flag 4 off: `404 FEATURE_DISABLED`;
   - with it on: `200`, exactly one `active` key, no private material, and `cache-control: public, max-age=300, s-maxage=0`.
6. **Record:** the time, the Worker version ID and the container image reference (**TO CONFIRM** where Je reads them, read-only) next to the results in the evidence worksheet.

## 6. Rollback

**The rollback pair.** Before the first deploy, record:
- the previous staging Worker version ID;
- its container image reference;
- its settings: the flag values and which secrets exist. Never record secret values.

All three are **TO CONFIRM** (§1). The pair is the unit of rollback: restore the Worker version and the image it ran with together, with those settings.

**Rollback by flag** comes first and is enough for most problems:
1. Set the flags off in reverse order (§2), using one new Worker version with the settings change only.
2. Let the container restart, which moves both epochs, so no session or subscription survives.
3. Run the preflight (§5).

With a flag off, its routes return `404 FEATURE_DISABLED`, nothing is sent, queued wake notifications are dropped, and work is untouched.

**Rollback by code** is for when a candidate bug needs the previous release:
1. Turn the flags off first.
2. Restore the previous Worker version together with its container image, and its settings.
3. Confirm with `/health` that `releaseSha` is the previous SHA.
4. **TO CONFIRM** the exact Cloudflare operation that restores the version and its image together. Rehearse it on staging before the run if it has not been done (`docs/closed-beta-launch-runbook.md`, restart and rollback).

**No database rollback.** Phase C adds no SQL migration. Its new records are documents in the existing document store:
- case-session: `inboxes/{inboxId}/case-sessions/…`, `auth/case-sessions/…` and the epoch;
- case-tools: human-decision requests (`inboxes/{inboxId}/case-human-requests/…`), which sit beside the existing policy bindings;
- http-wake: `http-wake/…` and the epoch.

An older server ignores them, and the epochs keep them from coming back to life. Do not delete them, truncate tables or run down-migrations.

**Agent-registration hazard.** If the rollback target is older than the A-4.x server code, follow `docs/deployment.md` "Phase B agent-registration code rollback" first. Otherwise, reverting freezes agents whose installations were ended individually.

**After any rollback,** post the result on #34, and treat the current run as stopped (§7).

## 7. Freeze rules for the hosted C01–C24 run

1. **One candidate.** The whole run uses one exact candidate SHA, deployed once to staging and confirmed by the preflight. Clients and connectors come from the matching release set, with hashes recorded.
2. **No code change mid-run.**
   - Nothing is deployed to staging during the run, including no Cloudflare dashboard edits that create a new version.
   - A fix means a new candidate: integrate it, run exact-head CI, deploy it, and **rerun the whole applicable matrix**, not just the failed row (build plan §5 L5).
3. **No configuration change mid-run.**
   - Flags, wake settings and secrets stay as recorded at the start.
   - The exceptions are a rollback (§6), which ends the run, and a step a row explicitly calls for, such as a flag-off rollback row in C22–C24. Each of those is approved on #34 before it happens and recorded in the worksheet.
4. **Restarts are recorded.** Record every container restart with its time and cause, because it may end live case sessions (§4).
5. **Live actions need approval.** Every new live send, fault injection or destructive step needs Je's approval first (Phase C plan, "Integration procedure and stopping points", step 6). Use fresh disposable identities and cases. Keep `case_0260691b187444b08368d1047ee317cb` paused, and never re-enrol a revoked test identity.
6. **Evidence for each row:**
   - the candidate SHA and artifact hashes;
   - the runtime and its version, and the route;
   - case, work and operation identifiers;
   - a timestamped result, with expected versus actual;
   - request, receipt and audit references;
   - redacted owner evidence.
   
   Never record credentials. Local, mocked or other-binary results keep their labels and do not count.
7. **Beta is out of scope.** The run changes nothing on beta and enables nothing there. Enabling a route or tool for beta waits for the exact-SHA evidence and the human countersign.
