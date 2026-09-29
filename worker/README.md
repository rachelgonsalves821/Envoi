# Cloudflare Containers deployment

This adapter runs one beta Sinaloa application container behind a Cloudflare Worker. All HTTP methods, cookies, CSRF headers, encoded paths, streaming response bodies, and Server-Sent Events pass through to the Node application. Authenticated responses are marked `no-store` at the edge.

The Worker uses a stable Durable Object name and `max_instances: 1`, so every request reaches the same beta container. A one-minute Cron Trigger calls `/ready`; this wakes a stopped container and continually resets the five-minute idle timeout while scheduling is healthy. If multiple application containers are introduced later, move delivery polling to a separately leased worker before increasing `max_instances`.

## Workers Builds

Connect the GitHub repository under **Workers & Pages → sinaloa → Settings → Builds**.

- Production branch: `main`
- Root directory: `/`
- Node version: 22, selected by the checked-in `.node-version` (also used by CI/Docker).
- Build command: `npm run build && npm run test:cloudflare && npm run cf:config-check` (Workers Builds installs the lockfile dependencies first).
- Deploy command: `npm run cf:deploy`

Container deployments must use `wrangler deploy`; `wrangler versions upload` does not publish updated container images.

## Runtime configuration

Use Worker variables/secrets rather than committed values. At minimum configure the public URL/CORS/agent domain, external PostgreSQL with `SINALOA_DB_SSL_MODE=verify-full`, private R2 S3 endpoint and bucket, HTTPS scanner, WorkOS callback, and all corresponding credentials. Supply `SINALOA_DB_CA` as a secret only when the provider CA is not trusted by the base image. Set `SINALOA_EDGE_ALLOWED_HOSTS` to `sinaloa-inbox.com` plus any deliberately retained `workers.dev` hostname.

Wrangler `keep_vars: true` preserves dashboard-managed runtime variables on deploy. Secrets are managed separately. See `docs/runtime-configuration-status.md` for the last recorded Production settings and remaining staging/provider setup; do not remove this preservation setting without moving every variable into an explicit managed configuration.

Run `npm run db:migrate` against the isolated staging PostgreSQL database before staging traffic and before releases with migrations. Production migration and deployment require separate approval. Verify `/health` and `/ready` through the deployed staging hostname; readiness remains `503` until all critical dependencies are available.

## Preflight and first deployment

1. Workers Paid and the selected build token's Containers/Worker permissions must be active. The account's Free plan cannot deploy this configuration.
2. Copy `.env.production.example` to the ignored `.env.production` and supply actual values from the provider dashboards. Do not copy the development `.env.example` into production.
3. Run `node --env-file=.env.production scripts/preflight.mjs`. This validates the same defaults and allowlist used by the Container, prints setting names rather than values, and exits nonzero for missing/invalid configuration. It does **not** prove credentials or live services work.
4. Put these values in the staging Worker's **Runtime variables and secrets**, not frontend build variables. Store database URL, API credentials, scanner token, encryption and signing keys as encrypted secrets. Include the exact staging `SINALOA_BETA_INVITED_EMAILS` allowlist and staging Twilio Verify settings required for management-session assurance. Set `SINALOA_EDGE_ALLOWED_HOSTS` to the real staging workers.dev hostname; the Worker returns 421 when this allowlist is missing or the hostname is not listed. Use that same HTTPS origin for `SINALOA_PUBLIC_URL`, CORS and the WorkOS callback; configure R2 CORS for that origin too. Keep production resources, credentials and invitees separate.
5. Run migrations and the explicitly enabled PostgreSQL/R2/scanner integration tests against the intended environment. See `docs/object-storage-production.md` for the isolated test bucket settings. Confirm R2 CORS allows the app origin and signed-upload headers.
6. Run the full CI matrix, `npm run build`, and `npm run cf:check`. A dry-run skips container rollout and cannot prove entitlement, image startup, or dependency readiness.
7. Deploy the reviewed commit to staging using `wrangler deploy --env staging`. Do not use `npm run cf:deploy` for staging; that script targets the top-level Production Worker. Run `npm run smoke:deployment -- https://YOUR-ACTUAL-STAGING-HOST.workers.dev/`, then complete the real sign-in, enrollment, two-agent messaging, blocking/revocation, SSE and artifact acceptance checks before domain cutover.

## Scanner health contract and readiness scope

The scan URL uses the existing authenticated binary POST protocol. A separate authenticated GET endpoint at `/health` on the same scanner origin (or `SINALOA_MALWARE_SCANNER_HEALTH_URL`) must return HTTP 200 with JSON `{"ready":true}`. Other statuses, redirects, malformed responses and negative readiness fail closed. The health URL must use the same origin so the scanner token cannot be sent to a different service.

`/ready` probes PostgreSQL reads, R2 read connectivity, scanner health and enabled-email configuration. It does not claim to verify R2 write/delete/CORS, WorkOS interactive sign-in, or actual provider delivery. Those are release acceptance checks. Provider exception text is never returned in the public readiness response.

## Beta capacity and rollback

`cf:config-check` prevents accidentally raising the single-instance cap while event subscriptions and rate counters remain process-local. Keep the one-minute wake-up until background jobs have an independent scheduler. This keeps the basic instance running and incurs usage beyond the Workers subscription; configure billing/queue-age/error alerts.

Keep the previous image/Worker version, database backup, and migration ledger. Roll back application versions only across compatible schemas. Turn optional external actions off during incident response. Preserve queue/scan records for diagnosis rather than deleting them.
