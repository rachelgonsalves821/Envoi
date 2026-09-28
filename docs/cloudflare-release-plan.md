# Cloudflare Beta Release Plan

## Deployment target

Sinaloa will run as a Cloudflare Container behind a Worker on the Workers Paid plan. The Worker owns public routing and forwards application traffic to a named beta container built from the repository Dockerfile. Cloudflare DNS will serve `sinaloa-inbox.com` only after the container deployment and readiness checks pass.

The beta still requires managed PostgreSQL, WorkOS, Resend, and a malware-scanner service. Cloudflare R2 supplies private object storage. No production secret, Cloudflare account identifier, resource identifier, or provider credential is committed to Git.

## Isolated workstreams

| Workstream | Worktree | Owned files | Deliverable |
| --- | --- | --- | --- |
| Container runtime | `Sinaloa-cloudflare-container` | `wrangler.jsonc`, `worker/**`, Cloudflare package scripts/dependencies, container-specific Docker/config | Worker-to-container routing, secret pass-through, health/readiness behavior, wake strategy |
| R2 and scanning | `Sinaloa-cloudflare-storage` | `src/object-storage.js`, new storage modules/tests, storage-specific docs | R2 compatibility, safe downloads, scan lifecycle, retention policy, live credential-gated checks |
| Integration and release | `Sinaloa-cloudflare-integration` | CI/readiness regression, this release plan, controlled merge and final validation | Combined tests, DNS/env matrix, deployment verification, rollback |

The original `Sinaloa` checkout remains the preservation checkout. Its uncommitted policy/config work is backed up under `C:\Users\Rachel\Documents\Codex\Sinaloa-safety-20260927-210243` and must not be overwritten, reset, cleaned, or used for Cloudflare implementation.

## Required Cloudflare resources

1. Workers Paid subscription with Containers enabled.
2. Worker named consistently with the committed Wrangler configuration.
3. Container application built by Workers Builds from the repository Dockerfile.
4. Private R2 bucket with public access disabled.
5. R2 API credentials scoped only to the beta bucket.
6. Custom domain route for `sinaloa-inbox.com`, added only after the Worker URL passes acceptance tests.
7. Runtime secrets configured under Worker settings, not build variables.
8. Observability enabled for Worker and Container logs.

## External resources

1. Managed PostgreSQL with TLS, automated backups, and a connection limit suitable for the configured pool.
2. WorkOS production environment with `https://sinaloa-inbox.com/api/auth/workos/callback` registered.
3. Resend sending and inbound domains using a dedicated subdomain such as `mail.sinaloa-inbox.com`.
4. A malware-scanner endpoint that fails closed and is reachable from the container.

## Runtime configuration

The release must configure at least these values as runtime variables or secrets:

- `NODE_ENV=production`
- `SINALOA_AUTH_MODE=production`
- `SINALOA_HOST=0.0.0.0`
- `SINALOA_PORT=<container port>`
- `SINALOA_PUBLIC_URL=https://sinaloa-inbox.com`
- `SINALOA_CORS_ORIGIN=https://sinaloa-inbox.com`
- `SINALOA_AGENT_DOMAIN=agents.sinaloa-inbox.com`
- `SINALOA_PUBLIC_EMAIL_DOMAIN=mail.sinaloa-inbox.com`
- `DATABASE_URL`
- `SINALOA_DB_SSL_MODE=verify-full`
- `SINALOA_DB_CA` only when the provider CA is not trusted by the base image
- WorkOS client, API, cookie, redirect, and issuer values
- R2 S3 endpoint, bucket, region, access key, and secret key values
- Malware-scanner URL and token
- Resend API and signed-webhook values
- Strong data-encryption and policy-signing keys

External email stays disabled until Resend DNS, webhook verification, complaint handling, and approved-contact tests pass.

## Pre-deployment gates

1. Working tree contains only reviewed Cloudflare changes merged from the isolated worktrees.
2. `npm ci` succeeds from the lockfile.
3. `npm test` passes with no cancellation or failure.
4. `npm run test:frontend` passes.
5. `npm run build` and both TypeScript checks pass.
6. Live PostgreSQL test and migration ledger pass against a disposable database.
7. Credential-gated R2 and scanner tests pass.
8. `npm audit --omit=dev` reports no known production vulnerabilities.
9. `wrangler deploy --dry-run` succeeds and reports the expected Worker, Container, Durable Object, and asset configuration.
10. No secret or real Cloudflare resource identifier appears in the Git diff.

## Post-deployment acceptance

Run these checks first on the generated `workers.dev` URL, then repeat them on `sinaloa-inbox.com`:

1. `/health` returns success without dependency details.
2. `/ready` returns success only when PostgreSQL, R2, scanner, WorkOS, and enabled email dependencies are ready.
3. The human UI loads over HTTPS without console errors or mixed content.
4. WorkOS sign-in, callback, secure cookies, origin validation, and CSRF mutations work behind the Worker proxy.
5. A friend creates an organization and workspace and enrolls one agent.
6. A second user enrolls another agent and receives an exact-address invitation.
7. Accept, decline, retry, and block states match in both human views.
8. Agent messages remain hidden before approval and appear after acceptance.
9. SSE events stream without buffering and reconnect without duplicating events.
10. R2 uploads remain quarantined until a clean scan; infected/error objects never receive download URLs.
11. Approved external email sends, delivery webhooks, replies, bounces, complaints, and suppression states are durable.
12. Revoked credentials immediately stop API and delivery access.

## DNS cutover

Do not attach the apex domain to a failing or partially configured Worker. Validate the `workers.dev` deployment first, then add `sinaloa-inbox.com` as the Worker custom domain. Configure `agents.sinaloa-inbox.com` as the native agent identity domain and apply only the Resend-provided SPF, DKIM, MX, and verification records to `mail.sinaloa-inbox.com`.

## Rollback

1. Keep the last green Worker deployment available for immediate rollback.
2. Never run destructive database migrations during the first beta deployment.
3. Disable external email with `SINALOA_ENABLE_EXTERNAL_EMAIL=false` if provider or DNS validation fails.
4. Remove the custom-domain route or roll back the Worker before changing database state.
5. Preserve failed delivery, scan, and migration records for diagnosis; do not delete them during rollback.
