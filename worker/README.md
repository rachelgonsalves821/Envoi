# Cloudflare Containers deployment

This adapter runs the Envoi application container behind a Cloudflare Worker. All HTTP methods, cookies, CSRF headers, encoded paths, streaming response bodies, and Server-Sent Events pass through to the Node application. Authenticated responses are marked `no-store` at the edge.

The Worker uses a stable Durable Object name and `max_instances: 1`, so every request reaches the same container. A one-minute Cron Trigger calls `/ready`; this wakes a stopped container and continually resets the five-minute idle timeout while scheduling is healthy. If multiple application containers are introduced later, move delivery polling to a separately leased worker before increasing `max_instances`.

## Names

Envoi runs in public production at `https://www.envoi-agents.com/`. Some Cloudflare resources still carry their original names, because renaming a Worker, container or bucket means recreating it:

| Deployment | Wrangler env | Worker | Container application | Scanner Worker |
| --- | --- | --- | --- | --- |
| Production | `beta` | `sinaloa-beta` | `sinaloa-beta-release` | `sinaloa-scanner-beta` |
| Staging | `staging` | `sinaloa-staging` | `sinaloa-beta-staging` | `sinaloa-scanner-staging` |

The top-level Worker `sinaloa` is retired; nothing deploys to it. The `production` script names below are aliases for the `beta` Wrangler env. Cloudflare Workers Builds calls `npm run cf:deploy:beta` by name, so that script stays.

## Release targets and recorded promotion

Promote one reviewed, merged-main commit explicitly to staging, then to production. Record its full SHA, successful CI run, deployment outputs, Worker versions and Container image identifiers in the release evidence. Recheck `git rev-parse HEAD` against the recorded SHA before each deploy. Use a clean checkout; any fix requires a new merged SHA and renewed staging acceptance. The original [launch runbook](../docs/closed-beta-launch-runbook.md) records the first-release gates and evidence.

The retired Worker `sinaloa` must remain disconnected from Git Builds. The unqualified `npm run cf:deploy` deliberately fails. Use the promotion wrapper below for release deployments. It selects the intended Cloudflare account, validates the recorded SHA and clean checkout, and supplies `ENVOI_RELEASE_SHA` to the selected environment. Actual deployment requires HEAD to equal both the recorded SHA and the fetched `origin/main`; dry-run permits a candidate descended from `origin/main`.

| Target | Deploy command | First application smoke origin |
| --- | --- | --- |
| Staging | `node scripts/promote-release.mjs staging FULL_SHA --deploy` | `https://sinaloa-staging.rachelgonsalves821.workers.dev/` |
| Production | `node scripts/promote-release.mjs production FULL_SHA --deploy` | `https://www.envoi-agents.com/` |

Replace `FULL_SHA` with the recorded full 40-hex SHA. Omit `--deploy` for a dry-run. Fetch `origin/main` before selecting the merged release candidate. The underlying `cf:deploy:staging` and `cf:deploy:production` (alias of `cf:deploy:beta`) scripts remain explicit target commands. Both stamp `ENVOI_RELEASE_SHA` from `git rev-parse HEAD` (since N2-config-2, a kept dashboard `SINALOA_RELEASE_SHA` is no longer read), and `cf:deploy:staging` (`scripts/deploy-staging.mjs`) also refuses a dirty worktree, including untracked files. Because `keep_vars` is true, an unstamped `wrangler deploy --env staging` keeps the previous release SHA variables, so `/health` would then report an older SHA than the code being served. Every staging deploy path must therefore go through `cf:deploy:staging` or `promote-release.mjs`.

Production is **custom-domain-only**: `env.beta.workers_dev` is false and its edge hostname allowlist contains `www.envoi-agents.com` plus the legacy `beta.sinaloa-inbox.com` route, which stays until its redirects are verified. Do not smoke the production application's workers.dev hostname or widen the allowlist to accommodate it. The production scanner uses its own workers.dev origin and authenticated health contract.

A production deploy keeps `www.envoi-agents.com` and `beta.sinaloa-inbox.com` bound and rolls out `sinaloa-beta-release`. Finish any resource, credential, migration and scanner prerequisites before deploying. A dry-run does not bind a domain or prove live readiness.

## Workers Builds

**Workers & Pages → sinaloa-staging → Settings → Build** tracks `integration/agent-native` (changed from `codex/staging-readiness` on 2026-10-09 for the agent-native build, H-2 Option 1), with preview-branch builds off and deploy command `npm run cf:deploy:staging`, so every staging build stamps `ENVOI_RELEASE_SHA` with its own commit. A merge to `main` does not automatically promote that SHA to staging. Freeze staging Builds during hosted acceptance so another deployment cannot replace the candidate under test, and record the deployed Worker version for each acceptance run. Changing the Builds branch or resuming automatic builds is a separate provider configuration decision.

The staging Builds configuration uses root directory `/`, Node 22 from `.node-version`, build command `npm run build`, and deploy command `npm run cf:deploy:staging`. Workers Builds installs lockfile dependencies; GitHub CI runs the broader suite.

### Staging dashboard change for the agent-native build (human-only, H-2)

The agent-native build runs its hosted gates on exact `integration/agent-native` SHAs. Only the human owner changes Cloudflare settings. Choose **one** option in **Workers & Pages → sinaloa-staging → Settings → Builds**:

- **Option 1 — keep automatic builds on the integration branch.** Set the production branch to `integration/agent-native`, keep preview-branch builds off, keep build command `npm run build`, and change the deploy command to `npm run cf:deploy:staging`. Every integration push then redeploys staging with its own SHA. The deploy fails if `npm run build` leaves the checkout dirty, which means committed generated files (`web/**`, `release.json`) are stale; fix that on the branch rather than relaxing the check. Pause builds while a gate is being run so the SHA under test is not replaced. The deploy command must be replaced, not just the branch: the old `npx wrangler deploy --env staging` command would keep a stale SHA.
- **Option 2 — deploy staging only by hand (recommended during gates).** Disconnect the Git repository or turn off automatic builds entirely, so no unstamped Builds deploy can run later and leave a stale SHA. Deploy each gate SHA from a clean checkout with `git checkout <sha>`, `npm ci`, `npm run build`, then `npm run cf:deploy:staging` (or `node scripts/promote-release.mjs staging <sha> --deploy` once that SHA is on `main`).

Either way, after deploying, confirm `npm run smoke:deployment -- https://sinaloa-staging.rachelgonsalves821.workers.dev/ <sha>` passes. That check requires `/health` and `/ready` to report the exact `releaseSha`.

Container deployments must use `wrangler deploy`; `wrangler versions upload` does not publish updated container images.

## Runtime configuration

Use target-specific Worker variables and encrypted secrets. Configure public URL/CORS/agent domain, external PostgreSQL with `ENVOI_DB_SSL_MODE=verify-full`, private R2 S3 endpoint and bucket, HTTPS scanner, WorkOS callback, and their credentials. Supply `ENVOI_DB_CA` as a secret only when the provider CA is not trusted by the base image. Set staging `ENVOI_EDGE_ALLOWED_HOSTS` to its exact workers.dev hostname. Production's canonical browser origin and WorkOS callback target `www.envoi-agents.com`; the legacy `sinaloa-inbox.com` Host/CORS entries stay allowed until their redirects are verified.

Wrangler `keep_vars: true` preserves dashboard-managed runtime variables on deploy. Production pins its non-secret origin, WorkOS client ID, private bucket, scanner URL and disabled optional integrations in `wrangler.jsonc`; credentials remain encrypted Worker secrets managed separately. See [runtime configuration status](../docs/runtime-configuration-status.md) for the dated provider setup record. Preserve this setting unless every dashboard variable has an explicit managed replacement.

Keep staging and production databases, credentials and invitees separate. Run `npm run db:migrate` with the selected environment's private connection before its traffic and before releases with migrations. Store database URL, API credentials, scanner token, encryption and signing keys as encrypted secrets. Never use frontend build variables for these values. Production allows self-service signup; the server's public admission mode and its bounded account limit are described in the [dual-admission rollout](../docs/workos-public-signup-rollout.md).

The data encryption key is still held under its legacy name `SINALOA_DATA_ENCRYPTION_KEY` (see `src/envoi-environment.js`). Moving it means re-entering the same value as `ENVOI_DATA_ENCRYPTION_KEY`; a different or missing key locks owners out of MFA, connector tokens and phone lookups.

## Preflight and deployment

1. Confirm Workers Paid, Container entitlement, and the selected deploy token's Containers/Worker permissions. Record the release SHA and clean checkout; confirm candidate CI passes.
2. Copy `.env.production.example` to an ignored private env file for the intended target, with values supplied directly from provider dashboards. Run `node --env-file=.env.production scripts/preflight.mjs`. It uses Container defaults and the allowlist, prints setting names rather than values, and fails for invalid or missing configuration. It does not prove live credentials or services. Avoid mixing staging and production env files.
3. Configure the target Worker's Runtime variables and secrets, WorkOS callback and R2 CORS. Confirm each environment's scanner has its own privately entered token matching that environment's application token, and prove authenticated scanner health before app deployment.
4. Run migrations and the explicitly enabled PostgreSQL/R2/scanner integration checks against isolated resources for the selected environment. See [object storage checks](../docs/object-storage-production.md). Prove R2 writes/deletes and allowed signed-upload headers; `/ready` checks only R2 read access.
5. Run the required CI matrix, `npm run build`, and `npm run cf:check`. Its dry-runs target staging, production and the production scanner, and never the retired `sinaloa` Worker. Dry-runs skip Container rollout and do not prove entitlement or image startup.
6. On the recorded SHA, deploy staging with `node scripts/promote-release.mjs staging FULL_SHA --deploy`. Save deployment output and version/image identifiers. Run `npm run smoke:deployment -- https://sinaloa-staging.rachelgonsalves821.workers.dev/ FULL_SHA`, then complete staging sign-in, enrollment, two-agent messaging, blocking/revocation, SSE and file acceptance. Confirm the tested version is still deployed and record evidence on the SHA.
7. Recheck the same accepted SHA and deploy with `node scripts/promote-release.mjs production FULL_SHA --deploy`. Save deployment output/version/image identifiers and run `npm run smoke:deployment -- https://www.envoi-agents.com/ FULL_SHA`. The expected-SHA argument requires both `/health` and `/ready` to report that exact `releaseSha`; missing or different evidence fails smoke. Do not substitute a workers.dev origin.
8. A passing public smoke or `/ready` alone does not prove a release. Record hosted acceptance, recovery and alert evidence for the SHA.

## Scanner health contract and readiness scope

The scan URL uses the authenticated binary POST protocol. A separate authenticated GET `/health` on the same scanner origin (or `ENVOI_MALWARE_SCANNER_HEALTH_URL`) must return HTTP 200 with JSON `{"ready":true}`. Other statuses, redirects, malformed responses and negative readiness fail closed. The health URL must use the same origin so the scanner token cannot be sent to a different service.

`/ready` probes PostgreSQL reads, R2 read connectivity, scanner health and enabled-email configuration. It does not verify R2 write/delete/CORS, WorkOS interactive sign-in, or actual provider delivery. Those require release acceptance. Provider exception text is never returned in the public readiness response.

## Capacity and rollback

`cf:config-check` prevents accidentally raising the single-instance cap while event subscriptions and rate counters remain process-local. Keep the one-minute wake-up until background jobs have an independent scheduler. This keeps the basic instance running and incurs usage beyond the Workers subscription; configure billing, queue-age and error alerts.

Keep the previous Worker version, Container image, database backup and migration ledger in the release evidence. Rehearse application rollback across compatible schemas, recording the exact restored Worker/image identifiers and data checks. Turn optional external actions off during incident response. Preserve queue/scan records for diagnosis.
