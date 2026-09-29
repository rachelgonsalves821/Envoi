# Cloudflare Containers deployment

This adapter runs one beta Sinaloa application container behind a Cloudflare Worker. All HTTP methods, cookies, CSRF headers, encoded paths, streaming response bodies, and Server-Sent Events pass through to the Node application. Authenticated responses are marked `no-store` at the edge.

The Worker uses a stable Durable Object name and `max_instances: 1`, so every request reaches the same beta container. A one-minute Cron Trigger calls `/ready`; this wakes a stopped container and continually resets the five-minute idle timeout while scheduling is healthy. If multiple application containers are introduced later, move delivery polling to a separately leased worker before increasing `max_instances`.

## Workers Builds

The old production Worker `sinaloa` is deliberately disconnected from Git Builds so pushing `main` cannot deploy it. Do not reconnect it for staging acceptance. The isolated `sinaloa-staging` Worker is connected under **Workers & Pages → sinaloa-staging → Settings → Builds**. `sinaloa-beta` is a separate, explicitly deployed Worker with its own Container application and `beta.sinaloa-inbox.com` custom domain. The beta custom domain becomes live on the first beta deploy, so configure and validate beta-only resources and credentials before running it.

- Production branch for this staging Worker: `codex/staging-readiness`; preview-branch builds are off.
- Root directory: `/`
- Node version: 22, selected by the checked-in `.node-version` (also used by CI/Docker).
- Build command: `npm run build` (Workers Builds installs the lockfile dependencies first; GitHub CI runs the broader suite).
- Deploy command: `npx wrangler deploy --env staging`

Container deployments must use `wrangler deploy`; `wrangler versions upload` does not publish updated container images.

## Runtime configuration

Use Worker variables/secrets rather than committed values. At minimum configure the public URL/CORS/agent domain, external PostgreSQL with `SINALOA_DB_SSL_MODE=verify-full`, private R2 S3 endpoint and bucket, HTTPS scanner, WorkOS callback, and all corresponding credentials. Supply `SINALOA_DB_CA` as a secret only when the provider CA is not trusted by the base image. Set `SINALOA_EDGE_ALLOWED_HOSTS` to the exact hostname(s) intended for that Worker, including `beta.sinaloa-inbox.com` on beta and any deliberately retained `workers.dev` hostname.

Wrangler `keep_vars: true` preserves dashboard-managed runtime variables on deploy. The beta environment pins its non-secret origin, WorkOS client ID, private bucket, scanner URL and disabled optional integrations in `wrangler.jsonc`; its credentials remain encrypted Worker secrets managed separately. See `docs/runtime-configuration-status.md` for current provider setup; do not remove this preservation setting without moving every dashboard variable into an explicit managed configuration.

Run `npm run db:migrate` against the isolated staging PostgreSQL database before staging traffic and before releases with migrations. Production migration and deployment require separate approval. Verify `/health` and `/ready` through the deployed staging hostname; readiness remains `503` until all critical dependencies are available.

## Preflight and first deployment

1. Workers Paid and the selected build token's Containers/Worker permissions must be active. The account's Free plan cannot deploy this configuration.
2. Copy `.env.production.example` to the ignored `.env.production` and supply actual values from the provider dashboards. Do not copy the development `.env.example` into production.
3. Run `node --env-file=.env.production scripts/preflight.mjs`. This validates the same defaults and allowlist used by the Container, prints setting names rather than values, and exits nonzero for missing/invalid configuration. It does **not** prove credentials or live services work.
4. Put these values in the target Worker's **Runtime variables and secrets**, not frontend build variables. Store database URL, API credentials, scanner token, encryption and signing keys as encrypted secrets. Include the exact environment-specific `SINALOA_BETA_INVITED_EMAILS` allowlist. MFA is controlled in WorkOS; the approved beta policy currently has it Off. Set `SINALOA_EDGE_ALLOWED_HOSTS` to the real staging workers.dev hostname on staging, and to `beta.sinaloa-inbox.com` on beta; the Worker returns 421 when this allowlist is missing or the hostname is not listed. Use the same HTTPS origin for `SINALOA_PUBLIC_URL`, CORS and the WorkOS callback; configure R2 CORS for that origin too. Keep staging, beta and old production resources, credentials and invitees separate.
5. Run migrations and the explicitly enabled PostgreSQL/R2/scanner integration tests against the intended environment. See `docs/object-storage-production.md` for the isolated test bucket settings. Confirm R2 CORS allows the app origin and signed-upload headers.
6. Run the full CI matrix, `npm run build`, and `npm run cf:check`. A dry-run skips container rollout and cannot prove entitlement, image startup, or dependency readiness.
7. Deploy the reviewed commit to staging using `npm run cf:deploy:staging`. The unqualified `cf:deploy` script deliberately fails rather than touching the old Production Worker. Run `npm run smoke:deployment -- https://YOUR-ACTUAL-STAGING-HOST.workers.dev/`, then complete the real sign-in, enrollment, two-agent messaging, blocking/revocation, SSE and artifact acceptance checks before beta deployment.
8. After beta resources, secrets, WorkOS callback and allowlists are configured and migrations pass, run `npm run cf:deploy:beta` on the accepted commit. This attaches `beta.sinaloa-inbox.com` to `sinaloa-beta` and rolls out its separate Container. Run the smoke command on that exact hostname before inviting beta users.

## Scanner health contract and readiness scope

The scan URL uses the existing authenticated binary POST protocol. A separate authenticated GET endpoint at `/health` on the same scanner origin (or `SINALOA_MALWARE_SCANNER_HEALTH_URL`) must return HTTP 200 with JSON `{"ready":true}`. Other statuses, redirects, malformed responses and negative readiness fail closed. The health URL must use the same origin so the scanner token cannot be sent to a different service.

`/ready` probes PostgreSQL reads, R2 read connectivity, scanner health and enabled-email configuration. It does not claim to verify R2 write/delete/CORS, WorkOS interactive sign-in, or actual provider delivery. Those are release acceptance checks. Provider exception text is never returned in the public readiness response.

## Beta capacity and rollback

`cf:config-check` prevents accidentally raising the single-instance cap while event subscriptions and rate counters remain process-local. Keep the one-minute wake-up until background jobs have an independent scheduler. This keeps the basic instance running and incurs usage beyond the Workers subscription; configure billing/queue-age/error alerts.

Keep the previous image/Worker version, database backup, and migration ledger. Roll back application versions only across compatible schemas. Turn optional external actions off during incident response. Preserve queue/scan records for diagnosis rather than deleting them.
