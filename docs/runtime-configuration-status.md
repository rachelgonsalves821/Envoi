# Cloudflare runtime configuration status

The Worker `sinaloa` Production settings were checked in a signed-in Cloudflare dashboard on 2026-09-28. Historical observations below describe that snapshot. The fresh account check below is the current evidence; older staging instructions in this file predate Rachel's choice of one invite-only beta environment at `beta.sinaloa-inbox.com`.

## Fresh account check — 2026-09-29

- Rachel authorized Neon Console's read-only GitHub email access, and a new **Neon `sinaloa-beta` PostgreSQL project** was created in AWS US East 2 (Ohio), project ID `dry-tooth-12968475`. Its default `production` branch contains database `sinaloa_beta` on PostgreSQL 18. The project is on Neon's Free plan with a **6-hour history retention** window. Its connection secret has not been entered into Cloudflare, migrations have not run, and a restore test is still open. A longer retention/backup policy is needed before real-user beta signoff.
- Cloudflare R2 still opens the subscription page, not a bucket list. The page offers activation at $0 due now and $0 base monthly, with usage charges beyond its allowance and automatic renewal. Activation is awaiting Rachel's action-time approval; no R2 bucket, S3 credential, or live object test exists.
- The Workers & Pages dashboard shows only `sinaloa`, with its latest deployment failed and no active route or Worker invocations. The Containers page is accessible but lists no deployed Containers. Paid/Containers access is therefore visible, while a working rollout is unproven.
- The failed `sinaloa` build produced a Container image and uploaded the Worker, then failed during the Cloudflare Containers API deployment step. That build used `main` at `cc86af3`, before the current partner/R1/R2 integration work. Retrying that old build would not validate the release candidate.
- The active `sinaloa build token` lists `Account.Containers` among 25 permissions, but the dashboard list does not reveal whether that permission is **Edit**. Token scope and a fresh exact-head deployment remain unverified.
- The integrated partner/R1/R2 code at merge commit `cc539d5` passed 99 backend tests (8 live-provider/PostgreSQL skips), 58 frontend tests, 37 TypeScript SDK tests, typecheck/production build, six Worker tests, and both Wrangler dry-runs in an isolated checkout. A dry-run is not a live Container rollout. Local Wrangler OAuth login did not finish during this check, so no deploy authorization is available from the CLI yet.
- `sinaloa-inbox.com` is active in this Cloudflare account, with full DNS setup and Workers Paid listed. Its zone overview reports **no Workers connected**; public DNS has no `beta.sinaloa-inbox.com` record yet. The hostname can be bound only after the beta Worker serves the reviewed release.
- The signed-in WorkOS dashboard has a `Sinaloa Beta` application in its **Staging** environment. Its callback, homepage, initiate-login, and sign-out URLs all use `https://beta.sinaloa-inbox.com`; an existing `sk_test_…` API key is listed. The full key has not been revealed or transferred, and neither a live sign-in nor beta Worker secret configuration has been verified.
- There is still no verified beta Worker, malware scanner, beta runtime secret table, or live database/WorkOS/R2/provider acceptance. The current process has no provider credentials; this is not evidence that credentials do not exist in the owners' accounts.
- The release target is one isolated invite-only **beta** environment at `beta.sinaloa-inbox.com`, with native addresses under `agents.sinaloa-inbox.com`. The old `staging` Wrangler environment and per-environment instructions below must be reconciled with that decision before deployment. Keep the existing `sinaloa` Production Worker and its data untouched until the reviewed beta candidate is ready.

## Current account check — 2026-09-28

- The signed-in account's **Workers Paid** card showed **Current plan**, and its highlights list Containers. This verifies the account entitlement, not a working deployment or the Builds token's `Containers Edit` permission.
- R2 still redirected to `/r2/plans` and showed **Add R2 subscription to my account**. No R2 bucket or live signed-object test is available yet. The account owner must complete the billing/terms step personally before staging storage can be provisioned.
- `wrangler whoami` still reported **not authenticated** on this computer. No staging Worker, Container, PostgreSQL database, WorkOS environment, scanner, or runtime secret was provisioned by this check. The local process environment did not contain the required provider credentials.
- Use the separate `sinaloa-staging` Worker configuration and staging-only provider resources. Do not use the existing Production Worker or its data for beta acceptance.

## Follow-up verification — 2026-09-28

- The recovery branch now defines a separate Wrangler `staging` environment (`sinaloa-staging`) with its own Container and Durable Object configuration. This is code configuration, not evidence that staging has been created or deployed in Cloudflare.
- Read-only HTTPS requests to `https://sinaloa.rachelgonsalves821.workers.dev/health` and `https://sinaloa-staging.rachelgonsalves821.workers.dev/health` both returned Cloudflare HTTP 404. Neither hostname passed an application health check. A 404 alone cannot distinguish an absent deployment from disabled routing or a different live hostname.
- `wrangler whoami` reported **not authenticated**. No connected browser surface was available for a fresh account inspection. Current Workers Paid/Containers entitlement, R2 activation, Builds token permissions, runtime variable/secret inventory, WorkOS, PostgreSQL and scanner state remain unverified in this follow-up.
- The earlier saved variables belong to the Production Worker only. Staging needs its own runtime table, test-only PostgreSQL/R2/scanner resources, and origin-bound WorkOS callback before a staging rollout. Do not copy production secrets or data into staging.

## Applied without deployment

At the dashboard check, the Production runtime table was initially empty. The following eleven plaintext variables were entered and saved using **More options → Save**, not **Add variables and deploy**. The resulting table showed every name/value below. These settings are preparation for a release, not proof that a container is running, and they have not been reverified since the follow-up above.

| Runtime variable | Saved value |
| --- | --- |
| `SINALOA_PUBLIC_URL` | `https://sinaloa.rachelgonsalves821.workers.dev` |
| `SINALOA_CORS_ORIGIN` | `https://sinaloa.rachelgonsalves821.workers.dev` |
| `SINALOA_EDGE_ALLOWED_HOSTS` | `sinaloa.rachelgonsalves821.workers.dev` |
| `WORKOS_REDIRECT_URI` | `https://sinaloa.rachelgonsalves821.workers.dev/api/auth/workos/callback` |
| `SINALOA_DB_SSL_MODE` | `verify-full` |
| `SINALOA_POLICY_ACTIVE_KEY_ID` | `primary` |
| `SINALOA_OBJECT_STORAGE_PROVIDER` | `s3` |
| `SINALOA_S3_REGION` | `auto` |
| `SINALOA_ENABLE_EXTERNAL_EMAIL` | `false` |
| `SINALOA_ENABLE_CALENDAR_WRITES` | `false` |
| `SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS` | `false` |

The actual workers.dev hostname was read from **Domains**. Its switch was disabled/off; no custom domains were present. No domain, route, subscription, credential, access permission, build command, production branch or deployment was changed in this workstream. WorkOS must still register the callback above in the intended provider environment.

The dashboard warns that Wrangler configuration must stay synchronized. The recovery branch now sets `keep_vars: true` and checks it during deployment validation to preserve dashboard-managed variables. Secrets remain encrypted runtime secrets, never source-controlled values.

## Required configuration still missing

“Missing” below means absent from the Production Worker runtime table at the last dashboard check. It does not prove the provider account/resource does not exist elsewhere, nor establish the current state of either Worker's table.

| Name | Cloudflare type | Source / completion requirement |
| --- | --- | --- |
| `DATABASE_URL` | Secret | Managed PostgreSQL connection URL; validate TLS, backups and migrations |
| `WORKOS_CLIENT_ID` | Variable | Intended WorkOS environment |
| `WORKOS_API_KEY` | Secret | Same WorkOS environment; live membership/sign-in acceptance required |
| `WORKOS_COOKIE_PASSWORD` | Secret | Independent strong application session secret, at least 32 characters |
| `SINALOA_DATA_ENCRYPTION_KEY` | Secret | Independent strong encryption key, at least 32 characters; retain securely for existing encrypted data |
| `SINALOA_POLICY_SIGNING_KEY` | Secret | Independent signing key, at least 32 characters, corresponding to `primary`; alternatively use `SINALOA_POLICY_SIGNING_KEYS` JSON keyring |
| `SINALOA_AGENT_DOMAIN` | Variable | Confirm controlled native-address domain; release-plan candidate is `agents.sinaloa-inbox.com`, not yet applied/verified |
| `SINALOA_S3_ENDPOINT` | Variable | Copy the actual endpoint for the intended R2 bucket/account/jurisdiction |
| `SINALOA_S3_BUCKET` | Variable | Private application bucket name |
| `SINALOA_S3_ACCESS_KEY_ID` | Secret | R2 credential restricted to the intended bucket |
| `SINALOA_S3_SECRET_ACCESS_KEY` | Secret | Corresponding restricted R2 credential |
| `SINALOA_MALWARE_SCANNER_URL` | Variable | HTTPS scan endpoint implementing the binary POST contract |
| `SINALOA_MALWARE_SCANNER_TOKEN` | Secret | Scanner service credential if its endpoint requires authentication; recommended for production |

Optional provider-specific settings: `SINALOA_DB_CA` (secret, if the provider CA is not trusted by the image), `SINALOA_MALWARE_SCANNER_HEALTH_URL` (same-origin HTTPS override; default `/health` must return HTTP 200 JSON `{"ready":true}`), and `SINALOA_S3_SESSION_TOKEN` (secret, only for temporary S3 credentials).

`NODE_ENV`, `SINALOA_AUTH_MODE`, `SINALOA_HUMAN_AUTH_PROVIDER`, `SINALOA_HOST`, `SINALOA_PORT`, `SINALOA_COOKIE_SECURE`, and the trusted-proxy default are supplied by `worker/runtime-config.js`; no duplicate dashboard entries are necessary. Other tuning settings may use validated code defaults for initial staging.

## Provider evidence and blockers

- **R2 was still inactive at the current dashboard check.** Opening R2 Object Storage redirected to `/r2/plans`, showing “Get started with R2” and “Add R2 subscription to my account.” Activation requires the account owner to accept billing/terms. After activation, create private staging and production buckets, restricted S3 credentials and app-origin CORS, then run live upload/download/quarantine tests.
- **PostgreSQL, WorkOS and scanner provisioning remain unverified.** The relevant checkout contains environment examples, not configured production environment files. No credentials were invented or copied from unrelated projects. The local disposable PostgreSQL test instance is not a production service.
- **Application secrets still need secure provisioning.** Store them directly as encrypted Worker runtime secrets using the owner’s approved secure process; do not paste them in chat or commit them. Keep encryption/signing keys backed up securely.
- **Workers Paid and Containers entitlement are confirmed in the current dashboard.** The intended Builds token's `Account > Containers Edit` permission and an actual Container rollout remain unverified.
- **Initial optional integrations stay disabled.** Resend email credentials/domain verification and Google/Microsoft calendar OAuth are not required while their feature flags are false. They require separate provider setup and acceptance before enablement.

## Completion sequence

1. Owner activates R2 and verifies the Builds token's `Containers Edit` permission in the intended account; locate or provision managed PostgreSQL, the WorkOS environment and HTTPS scanner. Record resource names and owners without recording secret values.
2. Partner sets up isolated staging and production resources, then fills each Worker's runtime entries with real provider values and independent application keys. Keep each environment's public URL, CORS, WorkOS callback and R2 CORS on its own exact origin.
3. Run the ignored `.env.production` through `node --env-file=.env.production scripts/preflight.mjs`, without printing values. Passing preflight only validates configuration structure.
4. Apply migrations and run live dependency acceptance. Confirm the reviewed deployment preserves the runtime table, then deploy the reviewed commit and verify smoke/end-to-end tests.
5. Enable/publicize the custom domain only after acceptance, updating all origin-bound settings together.
