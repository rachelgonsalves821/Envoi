# H-5 beta release checklist

**H-5 in the build plan (§8):** integration goes to `main` and is deployed to beta (`www.envoi-agents.com`). The human leads every step that merges, deploys or touches a dashboard. Lane A prepares the steps and checks them, and Lane B verifies the connector side.

**Names only.** Never paste a value into chat, GitHub or docs.

**Start only after `GATE GA PASS @<sha>`** is countersigned on board #34. That SHA is the **candidate**, `C` below. Beta then gets exactly the code that passed the gate.

| | Value |
| --- | --- |
| Candidate `C` (gate-passed integration SHA) | |
| Beta before the release (`/health` `releaseSha`) | `17ac7a9…` as of 2026-10-13; recheck |
| Release commit `M` on `main` | |
| Operator, UTC start and end | |

## What changes for beta users

There are no beta testers yet, so these are one-time costs for the team's own test accounts. No data is lost.

- **Browsers sign in once more.** The cookies are now `envoi_session`, `envoi_csrf` and `envoi_workos_flow`. Old `sinaloa_*` cookies are ignored and cleared (envoi-browser-names v1 §1, §4). A tab left open on the old app gets `403` on changes until it reloads.
- **Test agents reconnect once.**
  - Credentials issued before the release carry the `sinaloa_` prefix and are refused (envoi-names v1 §2).
  - Refresh now requires a `rotationId` (a3), so old connector binaries also get `ROTATION_ID_REQUIRED`.
  - The owner reconnects each agent with the **new** connector. Identity, address, cases and history are kept.
- **MCP tool names change** from `sinaloa_*` to `envoi_*` (envoi-names v1 §1). Any client configured with the old tool names must be updated.
- **No database migration.** `db/` has not changed since `17ac7a9`, so the schema is the same before and after. Rollback across this release is schema-compatible.
- **Phase B code is not in this release.** Agent-led onboarding exists only as a contract and fixtures; there is no server code or flag to turn on.
- **Pause and held work are new** (a3). A paused agent's outbound work is `held`, and a human can cancel held work. This matters for rollback (see the last section).

## Before the merge

**1. Record the rollback target.** Read from beta, and keep these values out of Git (Lane A can read `/health` itself):
- `/health` `releaseSha`;
- the current `sinaloa-beta` Worker version id (Cloudflare → Workers & Pages → `sinaloa-beta` → Deployments);
- the Container image;
- a database backup point. That is the provider's backup or branch for the beta database; take one now if the provider needs it.

**2. Beta app secrets (`sinaloa-beta` → Settings → Variables and Secrets).** For each secret beta still holds only as `SINALOA_X`, add `ENVOI_X` with the **same value**:
- `BETA_INVITED_EMAILS`;
- `POLICY_SIGNING_KEY` (or `POLICY_SIGNING_KEYS`);
- `S3_ACCESS_KEY_ID`;
- `S3_SECRET_ACCESS_KEY`;
- `MALWARE_SCANNER_TOKEN`;
- any optional secret such as `DB_CA` or `S3_SESSION_TOKEN`.

The rules:
- **Keep `SINALOA_DATA_ENCRYPTION_KEY` exactly as it is, and do not add `ENVOI_DATA_ENCRYPTION_KEY`.** The new code reads the old name for this one key. A different value under the new name makes the server refuse to start, and changing the key would lock out encrypted data. Its migration is a separate decision (`docs/envoi-backend-rename-inventory.md`, "Encryption key").
- **Same value matters for rollback too.** The previous code (`17ac7a9`) also reads `ENVOI_*` with a `SINALOA_*` fallback, and fails closed when a pair disagrees.
- **If a value cannot be recovered,** rotate it: put the new value under `ENVOI_X` and delete `SINALOA_X` in the same change. For S3 keys, create new R2 credentials, and revoke the old ones only after the rollback window. Never rotate the encryption key.
- **If `MALWARE_SCANNER_TOKEN` is rotated,** in the same change set `ENVOI_SCANNER_TOKEN` to the new value on `sinaloa-scanner-beta` and delete its `SINALOA_SCANNER_TOKEN`. The scanner beta runs today returns 503 when the two names disagree.
- **Cookie overrides: delete, never twin.** `sinaloa-beta` must not set `WORKOS_COOKIE_NAME`, `ENVOI_CSRF_COOKIE_NAME` or `SINALOA_CSRF_COOKIE_NAME`. Delete any that exist. A retired cookie name, such as a twin `ENVOI_CSRF_COOKIE_NAME=sinaloa_csrf`, makes the new server refuse to start (`src/workos-auth.js`, envoi-browser-names v1 §1.1).
- **Plain variables: no script checks these, so check by hand.**
  - List every Plaintext or JSON variable on `sinaloa-beta` whose name starts with `SINALOA_`, and change its prefix to `ENVOI_`.
  - Add that twin, with the same value, **only if** all three hold:
    - the `ENVOI_` name is in `CONTAINER_ENV_KEYS` (`worker/runtime-config.js`) or is `ENVOI_EDGE_ALLOWED_HOSTS`;
    - it is **not** already in `wrangler.jsonc` `env.beta.vars` at `M`;
    - it is not a cookie override.
  - Everything else needs nothing, for example `SINALOA_RELEASE_SHA`, `AUTH_MODE`, `HOST`, `PORT` and `COOKIE_SECURE`. So do the plain variables an earlier deploy created, because `wrangler.jsonc` now supplies their `ENVOI_` names with the same values.
  - Record the names you checked, names only, in the release evidence. The deploy scripts check only secret names, so a plain setting would otherwise be lost without an error.

**3. Beta scanner (`sinaloa-scanner-beta`).** Add `ENVOI_SCANNER_TOKEN`, with the same value as beta's `ENVOI_MALWARE_SCANNER_TOKEN`. The new scanner reads only that name.

**4. Does beta deploy automatically?** Check `sinaloa-beta` → Settings → Build. Nothing in the repository records this.
- **If it is connected to `main`,** read its deploy command.
  - Continue only if the command is exactly `npm run cf:deploy:beta`. That command refuses missing or retired-only secret names (`scripts/deploy-beta-build.mjs`), so a half-configured beta fails the build instead of shipping.
  - With any other command, for example a plain `wrangler deploy --env beta`, the human **turns automatic builds off before step 6**. Such a command would ship `M` with no secret check, the container would refuse to start for missing `ENVOI_*` settings, and beta would be down.
- **If it is not connected,** the deploy is step 7.

**5. Lane A pre-merge check.**
- [ ] CI is green on `C`.
- [ ] `origin/main` is still an ancestor of `C`. It was on 2026-10-13, so the merge introduces nothing that the gate did not test.
- [ ] Lane A posts the exact merge PR on the board.

## Merge and deploy

**6. Merge.** The human opens and merges a PR from `integration/agent-native` at `C` into `main`. Call the resulting commit `M`. Lane A checks `git rev-parse M^{tree}` = `git rev-parse C^{tree}`.

**7. Deploy, from a clean checkout of `M`** (`git checkout M`, `npm ci`, `npm run build`, and `git status` must be clean):

```powershell
npm run cf:deploy:scanner:beta
node scripts/promote-release.mjs beta <M>
node scripts/promote-release.mjs beta <M> --deploy
```

- `cf:deploy:scanner:beta` refuses if the beta scanner lacks `ENVOI_SCANNER_TOKEN`. `promote-release` checks that name too, but it does not deploy the scanner, so the scanner line is needed. Either order is safe: the scanner beta runs today already accepts `ENVOI_SCANNER_TOKEN`.
- `wrangler deploy` builds `Dockerfile.cloudflare`, so Docker must be running on the deploying machine.
- `promote-release` dry-runs first. Then it refuses unless `HEAD` equals the fetched `origin/main`, the tree is clean, and every required `ENVOI_*` secret name exists. It also refuses if any secret is held **only** under a retired name. It stamps `ENVOI_RELEASE_SHA` with `M`.
- If beta auto-builds from `main` (step 4), skip the app deploy line and wait for that build.
- Container deploys need `wrangler deploy`, which these scripts use. The container restarts with the new settings.

## Verify (before telling anyone)

**8. Server**
```powershell
npm run smoke:deployment -- https://www.envoi-agents.com/ <M>
```
The smoke script checks `/health` and `/ready` (production mode, `configurationValidated`, ready, exact `releaseSha`), `/api/auth/config`, the page at `/` and the WorkOS redirect. Check the rest by hand:
- [ ] `/health` says `service: envoi`. The smoke script also accepts the old `sinaloa`. `configurationValidated: true` proves the encryption key arrived through its legacy name.
- [ ] `/ready`: database, object storage and malware scanner each `ready`.
- [ ] `/web/downloads/release.json` lists `envoi-connector.mjs` and `envoi-openclaw.mjs`, and the SHA-256 of each file served from `/web/downloads/` matches it. Lane B's preflight already checks this for staging.

**9. Browser (human).**
- [ ] Sign in at `www.envoi-agents.com`; signing in again once is expected.
- [ ] The inbox loads.
- [ ] A change succeeds, which proves CSRF works.
- [ ] Sign out works.

**10. Agents (human, with Lane B).** For each existing beta test agent:
- [ ] download the new connector from beta's `/web/downloads/`;
- [ ] reconnect it from the owner UI;
- [ ] confirm it reaches `CONNECTED`;
- [ ] send one message and get one processed reply.

## Close out

**11. Board.** Lane A posts `RELEASED H-5 @<M>` with:
- the smoke output;
- `/health` and `/ready`;
- the rollback target from step 1;
- the step 9 and 10 results.

The sanitized record goes in `docs/architecture/agent-native-v2/evidence/h5-beta-<M>.md`.

**12. Cleanup (human), after the rollback window,** at least 24 hours with no rollback:
- on `sinaloa-beta`, delete the old `SINALOA_*` secrets that now have `ENVOI_*` twins, and `SINALOA_RELEASE_SHA`;
- delete the plain `SINALOA_*` variables that earlier deploys left;
- on `sinaloa-scanner-beta`, delete `SINALOA_SCANNER_TOKEN`;
- **keep `SINALOA_DATA_ENCRYPTION_KEY`**.

## Rollback

Use rollback if any step 8–10 check fails and cannot be fixed forward quickly. Prefer fixing forward.

**First, check for held or cancelled work (read-only, by whoever has beta database access):**

```sql
SELECT status, count(*) FROM sinaloa_outbox WHERE status IN ('held', 'cancelled') GROUP BY 1;
```

The previous code does not know these statuses. It delivers a case's messages only after every earlier one is `delivered` or `deadLettered`, so one `held` or `cancelled` message stalls the rest of that case.
- If `held` > 0, resume those paused agents first, so the work is delivered.
- If `cancelled` > 0, fix forward instead, or have the human decide a data fix before rolling back.
- To keep this simple, do not pause agents or cancel held work during the rollback window.

**Then choose a path:**
- **Safe path (preferred).**
  1. Revert the merge in a PR to `main` (a new commit `R`) and merge it. `promote-release` requires `HEAD` to equal `origin/main`. If beta auto-builds from `main`, merging `R` is the deploy.
  2. Otherwise, run `node scripts/promote-release.mjs beta <R> --deploy` from a clean checkout of `R`.
  3. `/health` then reports `R`.
- **Fast path.** In Cloudflare, roll `sinaloa-beta` back to the Worker version recorded in step 1. Nothing in the repository shows whether a Worker version rollback also restores the Container image. Confirm the image is the recorded one; otherwise use the safe path.

**Afterwards**
- **Browsers** sign in once more.
- **Agents reconnected in step 10 must reconnect again,** using the old connector from beta's `/web/downloads/`. The previous code issues and accepts only `sinaloa_` credentials.
- **Connector state.** The new connector moved each agent's state from `…/sinaloa/<runtime>/<id>` to `…/envoi/…`, so the old one starts with no saved state. Before releasing again, Lane B resolves any duplicate `sinaloa/` and `envoi/` state directories; otherwise the new connector stops with `STATE_MIGRATION_CONFLICT`.
- **No schema step** is needed: the schema did not change.
- **Secrets.** Do not delete any `SINALOA_*` secret before the rollback window ends.
