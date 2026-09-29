# Cloudflare Beta Release Plan

The current implementation and verification status is tracked in [deployment recovery plan](deployment-recovery-plan.md). Use [Worker deployment instructions](../worker/README.md) for the current commands and runtime configuration contract.

## Deployment target

Sinaloa will run as a Cloudflare Container behind a Worker on the Workers Paid plan. The Worker owns public routing and forwards application traffic to a named beta container built from the repository Dockerfile. Cloudflare DNS will serve `sinaloa-inbox.com` only after the container deployment and readiness checks pass.

The repository defines a separate `staging` Wrangler environment. `wrangler deploy --env staging` targets the `sinaloa-staging` Worker and its own Container/Durable Object binding; the top-level `wrangler deploy` targets `sinaloa`. A local staging dry-run validates the shape of this configuration but does not prove account entitlement, resources, secrets or a running Container. Stage with test-only humans, a separate PostgreSQL database, private R2 bucket, scanner credentials and WorkOS callback. Set `SINALOA_PUBLIC_URL`, CORS origin, edge allowed hosts, WorkOS redirect and R2 CORS to the **actual** staging `workers.dev` origin after it is known. Do not reuse production data, keys or credentials. Dashboard variables and secrets are per Worker and must be checked for both environments.

The beta requires managed PostgreSQL, WorkOS, and a malware-scanner service. Cloudflare R2 supplies private object storage. Resend is required only when external email is enabled. No production secret or provider credential is committed to Git.

## Isolated workstreams

| Workstream | Worktree | Owned files | Deliverable |
| --- | --- | --- | --- |
| Container runtime | `Sinaloa-cloudflare-container` | `wrangler.jsonc`, `worker/**`, Cloudflare package scripts/dependencies, container-specific Docker/config | Worker-to-container routing, secret pass-through, health/readiness behavior, wake strategy |
| R2 and scanning | `Sinaloa-cloudflare-storage` | `src/object-storage.js`, new storage modules/tests, storage-specific docs | R2 compatibility, safe downloads, scan lifecycle, retention policy, live credential-gated checks |
| Integration and release | `Sinaloa-cloudflare-integration` | CI/readiness regression, this release plan, controlled merge and final validation | Combined tests, DNS/env matrix, deployment verification, rollback |

The original `Sinaloa` checkout remains the preservation checkout. Its uncommitted policy/config work is backed up under `C:\Users\Rachel\Documents\Codex\Sinaloa-safety-20260927-210243` and must not be overwritten, reset, cleaned, or used for Cloudflare implementation.

## Required Cloudflare resources

1. Workers Paid subscription with Containers enabled.
2. Worker named `sinaloa`, matching the connected Workers Builds project and the committed Wrangler configuration.
3. Container application built by Workers Builds from the repository Dockerfile.
4. Private R2 bucket with public access disabled.
5. R2 API credentials scoped only to the beta bucket.
6. Custom domain route for `sinaloa-inbox.com`, added only after the Worker URL passes acceptance tests.
7. Runtime secrets configured under Worker settings, not build variables.
8. Observability enabled for Worker and Container logs.

### Workers Builds container access

Cloudflare's automatically created Workers Builds API token does not include the `Containers Edit` permission. Before deploying this Worker, confirm the connected account has an active Workers Paid subscription and select a user API token in the Worker's **Settings > Build > API token** with `Account > Containers Edit` for that account, as well as permission to deploy the `sinaloa` Worker. Keep this token in Cloudflare; do not commit it or add it as a runtime secret. Retry the failed build after saving the build settings.

If the image builds and Worker upload succeeds but deployment fails at `/accounts/.../containers/me`, check the Workers Paid subscription and build token permissions in Cloudflare. A Wrangler dry-run cannot verify either account entitlement or token access.

## External resources

1. Managed PostgreSQL with TLS, automated backups, and a connection limit suitable for the configured pool.
2. WorkOS production environment with `https://sinaloa-inbox.com/api/auth/workos/callback` registered.
3. A malware-scanner endpoint that fails closed and is reachable from the container, with authenticated binary scan POST and a positive JSON `/health` response.

Resend sending and inbound domains are post-beta resources while external email stays disabled.

## Runtime configuration

The release must configure at least these values as runtime variables or secrets:

- `NODE_ENV=production`
- `SINALOA_AUTH_MODE=production`
- `SINALOA_HOST=0.0.0.0`
- `SINALOA_PORT=<container port>`
- `SINALOA_PUBLIC_URL=https://sinaloa-inbox.com`
- `SINALOA_CORS_ORIGIN=https://sinaloa-inbox.com`
- `SINALOA_AGENT_DOMAIN=agents.sinaloa-inbox.com`
- `DATABASE_URL`
- `SINALOA_DB_SSL_MODE=verify-full`
- `SINALOA_DB_CA` only when the provider CA is not trusted by the base image
- WorkOS client, API, cookie, redirect, and issuer values
- R2 S3 endpoint, bucket, region, access key, and secret key values
- Malware-scanner URL and token
- Strong data-encryption and policy-signing keys

External email stays disabled until Resend DNS, webhook verification, complaint handling, and approved-contact tests pass.

## Pre-deployment gates

1. The exact release commit is reviewed on the recovery branch; the working tree is clean and the two-owner beta plan's product and security gates are assigned.
2. `npm ci` succeeds from the lockfile.
3. `npm test` passes with no cancellation or failure.
4. `npm run test:frontend` passes.
5. TypeScript/Python SDK and Worker tests, `npm run build` and both TypeScript checks pass.
6. Live PostgreSQL test and migration ledger pass against a disposable database.
7. Credential-gated R2 and scanner tests pass.
8. `npm audit --omit=dev` reports no known production vulnerabilities.
9. Both top-level and `--env staging` Wrangler dry-runs succeed and report the expected separate Worker, Container and Durable Object configurations.
10. No secret or real Cloudflare resource identifier appears in the Git diff.

## Post-deployment acceptance

Run these checks first on the isolated staging `workers.dev` URL. Only after they pass, merge the exact reviewed commit to `main`, deploy the production Worker, and repeat the critical journey on the beta hostname:

1. `/health` returns success without dependency details.
2. `/ready` verifies PostgreSQL connectivity, limited R2 access and positive scanner health. It does not prove a private bucket upload/download, WorkOS sign-in or case correctness; exercise those separately below.
3. The human UI loads over HTTPS without console errors or mixed content.
4. WorkOS sign-in, callback, secure cookies, origin validation, and CSRF mutations work behind the Worker proxy.
5. An invited human creates a workspace and enrolls an agent; an uninvited verified human and a low-assurance session cannot manage agents.
6. A second independently owned human enrolls an agent. Knowing the exact active native address is enough for direct communication; no first-contact invitation or approval is required.
7. OpenClaw and a Grok/xAI API-backed runner connect through the hosted MCP endpoint and durable inbox bridge. Both receive unsolicited work, reply, survive token renewal and offline restart, and stop after credential revocation.
8. The two agents keep two simultaneous multi-turn cases separate. Both humans see the same typed messages, proposal/decision outcomes, actors, delivery/processing/failure receipts and complete paginated timelines.
9. Pause/resume, native block/unblock, permission changes and internal-case human decisions take effect on the server; unauthorized or forged authority does not show as verified.
10. SSE events stream without buffering and reconnect without missing or duplicating events.
11. A signed private R2 PUT/GET/DELETE and clean/infected scanner check pass. Files remain quarantined until clean; infected/error objects never receive download URLs, and both humans can inspect safe metadata.
12. Restart the Container and verify queued work, cases and assets persist. Exercise a PostgreSQL/R2/keys restoration and record recovery time; verify logs and alerts for readiness, failed jobs and backup status.

## DNS cutover

Do not attach the apex domain to a failing or partially configured Worker. Validate the `workers.dev` deployment first, then add `sinaloa-inbox.com` as the Worker custom domain. Configure `agents.sinaloa-inbox.com` as the native agent identity domain and apply only the Resend-provided SPF, DKIM, MX, and verification records to `mail.sinaloa-inbox.com`.

## Rollback

1. Keep the last green Worker deployment available for immediate rollback.
2. Never run destructive database migrations during the first beta deployment.
3. Disable external email with `SINALOA_ENABLE_EXTERNAL_EMAIL=false` if provider or DNS validation fails.
4. Remove the custom-domain route or roll back the Worker before changing database state.
5. Preserve failed delivery, scan, and migration records for diagnosis; do not delete them during rollback.
