# Cloudflare Containers deployment

This adapter runs one beta Sinaloa application container behind a Cloudflare Worker. All HTTP methods, cookies, CSRF headers, encoded paths, streaming response bodies, and Server-Sent Events pass through to the Node application. Authenticated responses are marked `no-store` at the edge.

The Worker uses a stable Durable Object name and `max_instances: 1`, so every request reaches the same beta container. A one-minute Cron Trigger calls `/ready`; this wakes a stopped container and continually resets the five-minute idle timeout while scheduling is healthy. If multiple application containers are introduced later, move delivery polling to a separately leased worker before increasing `max_instances`.

## Release targets and recorded promotion

Follow the [closed-beta launch runbook](../docs/closed-beta-launch-runbook.md) for release gates and evidence. Promote one reviewed, merged-main commit explicitly to `sinaloa-staging`, then to `sinaloa-beta`. Record its full SHA, successful CI run, deployment outputs, Worker versions and Container image identifiers in the release evidence. Recheck `git rev-parse HEAD` against the recorded SHA before each deploy. Use a clean checkout; any fix requires a new merged SHA and renewed staging acceptance.

The old production Worker `sinaloa` must remain disconnected from Git Builds. The unqualified `npm run cf:deploy` deliberately fails. Use the promotion wrapper below for release deployments. It selects the intended Cloudflare account, validates the recorded SHA and clean checkout, and supplies `SINALOA_RELEASE_SHA` to the selected environment. Actual deployment requires HEAD to equal both the recorded SHA and the fetched `origin/main`; dry-run permits a candidate descended from `origin/main`.

| Target | Deploy command | First application smoke origin |
| --- | --- | --- |
| Staging | `node scripts/promote-release.mjs staging FULL_SHA --deploy` | `https://sinaloa-staging.rachelgonsalves821.workers.dev/` |
| Beta | `node scripts/promote-release.mjs beta FULL_SHA --deploy` | `https://www.envoi-agents.com/` |

Replace `FULL_SHA` with the recorded full 40-hex SHA. Omit `--deploy` for a dry-run. Fetch `origin/main` before selecting the merged release candidate. The underlying `cf:deploy:staging` and `cf:deploy:beta` scripts remain explicit target commands. Both stamp `SINALOA_RELEASE_SHA` from `git rev-parse HEAD`, and `cf:deploy:staging` (`scripts/deploy-staging.mjs`) also refuses a dirty worktree, including untracked files. Because `keep_vars` is true, an unstamped `wrangler deploy --env staging` keeps the previous `SINALOA_RELEASE_SHA`, so `/health` would then report an older SHA than the code being served. Every staging deploy path must therefore go through `cf:deploy:staging` or `promote-release.mjs`.

Beta is **custom-domain-only**: `env.beta.workers_dev` is false and its edge hostname allowlist contains `www.envoi-agents.com` plus the temporary existing `beta.sinaloa-inbox.com` route. Do not smoke the beta application's workers.dev hostname or widen the allowlist to accommodate it. The first new-domain application smoke occurs after custom-domain binding. The separate beta scanner uses its own workers.dev origin and authenticated health contract.

The beta deploy binds `www.envoi-agents.com`, retains `beta.sinaloa-inbox.com` during cutover, and rolls out `sinaloa-beta-release`; finish the beta resource, credential, migration and scanner prerequisites before deploying. A dry-run does not bind the new domain or prove live readiness. DNS/custom-domain readiness and successful application smoke on the new origin are gates before invitations.

## Workers Builds

As recorded in the launch audit, **Workers & Pages → sinaloa-staging → Settings → Builds** tracks `codex/staging-readiness`, with preview-branch builds off, and its deploy command `npx wrangler deploy --env staging` does not set `SINALOA_RELEASE_SHA`. Staging `/health` reports `releaseSha: null` until the first stamped deploy; after that, an unstamped Builds deploy would keep reporting the **old** SHA (`keep_vars`). A merge to `main` does not automatically promote that SHA to staging. Use the explicit recorded-SHA procedure above, and freeze concurrent staging Builds during acceptance so another deployment cannot replace the candidate under test. Record the deployed Worker version for each acceptance run. Changing the Builds branch or resuming automatic builds is a separate provider configuration decision.

The staging Builds configuration uses root directory `/`, Node 22 from `.node-version`, build command `npm run build`, and deploy command `npx wrangler deploy --env staging`. Workers Builds installs lockfile dependencies; GitHub CI runs the broader suite.

### Staging dashboard change for the agent-native build (human-only, H-2)

The agent-native build runs its hosted gates on exact `integration/agent-native` SHAs. Only the human owner changes Cloudflare settings. Choose **one** option in **Workers & Pages → sinaloa-staging → Settings → Builds**:

- **Option 1 — keep automatic builds on the integration branch.** Set the production branch to `integration/agent-native`, keep preview-branch builds off, keep build command `npm run build`, and change the deploy command to `npm run cf:deploy:staging`. Every integration push then redeploys staging with its own SHA. The deploy fails if `npm run build` leaves the checkout dirty, which means committed generated files (`web/**`, `release.json`) are stale; fix that on the branch rather than relaxing the check. Pause builds while a gate is being run so the SHA under test is not replaced. The deploy command must be replaced, not just the branch: the old `npx wrangler deploy --env staging` command would keep a stale SHA.
- **Option 2 — deploy staging only by hand (recommended during gates).** Disconnect the Git repository or turn off automatic builds entirely, so no unstamped Builds deploy can run later and leave a stale SHA. Deploy each gate SHA from a clean checkout with `git checkout <sha>`, `npm ci`, `npm run build`, then `npm run cf:deploy:staging` (or `node scripts/promote-release.mjs staging <sha> --deploy` once that SHA is on `main`).

Either way, after deploying, confirm `npm run smoke:deployment -- https://sinaloa-staging.rachelgonsalves821.workers.dev/ <sha>` passes. That check requires `/health` and `/ready` to report the exact `releaseSha`.

Container deployments must use `wrangler deploy`; `wrangler versions upload` does not publish updated container images.

## Runtime configuration

Use target-specific Worker variables and encrypted secrets. Configure public URL/CORS/agent domain, external PostgreSQL with `SINALOA_DB_SSL_MODE=verify-full`, private R2 S3 endpoint and bucket, HTTPS scanner, WorkOS callback, and their credentials. Supply `SINALOA_DB_CA` as a secret only when the provider CA is not trusted by the base image. Set staging `SINALOA_EDGE_ALLOWED_HOSTS` to its exact workers.dev hostname. Beta's canonical browser origin and WorkOS callback target `www.envoi-agents.com`; the old beta Host/CORS stays allowed temporarily.

Wrangler `keep_vars: true` preserves dashboard-managed runtime variables on deploy. Beta pins its non-secret origin, WorkOS client ID, private bucket, scanner URL and disabled optional integrations in `wrangler.jsonc`; credentials remain encrypted Worker secrets managed separately. See [runtime configuration status](../docs/runtime-configuration-status.md) for provider setup. Preserve this setting unless every dashboard variable has an explicit managed replacement.

Keep staging, beta and old production databases, credentials and invitees separate. Run `npm run db:migrate` with the selected environment's private connection before its traffic and before releases with migrations. Store database URL, API credentials, scanner token, encryption and signing keys as encrypted secrets. Never use frontend build variables for these values. The approved beta WorkOS policy has MFA Off; configure its callback and disable signup before release.

## Preflight and first deployment

1. Confirm Workers Paid, Container entitlement, and the selected deploy token's Containers/Worker permissions. Record the release SHA and clean checkout; confirm candidate CI passes.
2. Copy `.env.production.example` to an ignored private env file for the intended target, with values supplied directly from provider dashboards. Run `node --env-file=.env.production scripts/preflight.mjs`. It uses Container defaults and the allowlist, prints setting names rather than values, and fails for invalid or missing configuration. It does not prove live credentials or services. Avoid mixing staging and beta env files.
3. Configure the target Worker's Runtime variables and secrets, exact environment-specific `SINALOA_BETA_INVITED_EMAILS`, WorkOS callback and R2 CORS. Confirm beta's scanner has its own privately entered token matching the beta application token and prove authenticated scanner health before app deployment.
4. Run migrations and the explicitly enabled PostgreSQL/R2/scanner integration checks against isolated resources for the selected environment. See [object storage checks](../docs/object-storage-production.md). Prove R2 writes/deletes and allowed signed-upload headers; `/ready` checks only R2 read access.
5. Run the required CI matrix, `npm run build`, and `npm run cf:check`. Its dry-runs target staging, beta and the beta scanner, preserving the old production Worker. Dry-runs skip Container rollout and do not prove entitlement or image startup.
6. On the recorded SHA, deploy staging with `node scripts/promote-release.mjs staging FULL_SHA --deploy`. Save deployment output and version/image identifiers. Run `npm run smoke:deployment -- https://sinaloa-staging.rachelgonsalves821.workers.dev/ FULL_SHA`, then complete staging sign-in, enrollment, two-agent messaging, blocking/revocation, SSE and file acceptance. Confirm the tested version is still deployed and record evidence on the SHA.
7. Complete beta prerequisites in the runbook, including separate secrets, migrations, WorkOS settings, scanner proof and operational preparation. Recheck the same accepted SHA and deploy with `node scripts/promote-release.mjs beta FULL_SHA --deploy`. This binds the custom domain immediately. Save deployment output/version/image identifiers and run `npm run smoke:deployment -- https://www.envoi-agents.com/ FULL_SHA` after the hostname resolves. The expected-SHA argument requires both `/health` and `/ready` to report that exact `releaseSha`; missing or different evidence fails smoke. Do not substitute a workers.dev origin.
8. Complete hosted beta acceptance, recovery and alert gates and record product/operational signoff before inviting the cohort. A passing public smoke or `/ready` alone is insufficient.

## Scanner health contract and readiness scope

The scan URL uses the authenticated binary POST protocol. A separate authenticated GET `/health` on the same scanner origin (or `SINALOA_MALWARE_SCANNER_HEALTH_URL`) must return HTTP 200 with JSON `{"ready":true}`. Other statuses, redirects, malformed responses and negative readiness fail closed. The health URL must use the same origin so the scanner token cannot be sent to a different service.

`/ready` probes PostgreSQL reads, R2 read connectivity, scanner health and enabled-email configuration. It does not verify R2 write/delete/CORS, WorkOS interactive sign-in, or actual provider delivery. Those require release acceptance. Provider exception text is never returned in the public readiness response.

## Beta capacity and rollback

`cf:config-check` prevents accidentally raising the single-instance cap while event subscriptions and rate counters remain process-local. Keep the one-minute wake-up until background jobs have an independent scheduler. This keeps the basic instance running and incurs usage beyond the Workers subscription; configure billing, queue-age and error alerts.

Keep the previous Worker version, Container image, database backup and migration ledger in the release evidence. Rehearse application rollback across compatible schemas, recording the exact restored Worker/image identifiers and data checks. Turn optional external actions off during incident response. Preserve queue/scan records for diagnosis. The runbook requires populated restore, rollback and delivered alert evidence before launch.
