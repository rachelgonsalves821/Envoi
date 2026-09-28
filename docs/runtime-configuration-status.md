# Cloudflare runtime configuration status

Checked 2026-09-28 in the signed-in Cloudflare dashboard, Worker `sinaloa`, Production settings.

## Applied without deployment

The runtime table was initially empty. The following eleven plaintext variables were entered and saved using **More options → Save**, not **Add variables and deploy**. The resulting table showed every name/value below. These settings are preparation for the first staging release, not proof that a container is running.

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

“Missing” below means absent from the Worker runtime table at this check. Except for R2 activation, it does not prove the provider account/resource does not exist elsewhere.

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

- **R2 is not activated on this Cloudflare account.** Opening R2 Object Storage redirected to `/r2/plans`, showing “Get started with R2” and “Add R2 subscription to my account.” Activation requires accepting billing/terms. No subscription was purchased or terms accepted. After activation, create the private bucket, restricted S3 credentials and app-origin CORS; run live upload/download/quarantine tests.
- **PostgreSQL, WorkOS and scanner provisioning remain unverified.** The relevant checkout contains environment examples, not configured production environment files. No credentials were invented or copied from unrelated projects. The local disposable PostgreSQL test instance is not a production service.
- **Application secrets still need secure provisioning.** Store them directly as encrypted Worker runtime secrets using the owner’s approved secure process; do not paste them in chat or commit them. Keep encryption/signing keys backed up securely.
- **Workers Paid and container entitlement still need release verification.** This workstream did not change or inspect billing subscriptions beyond the R2 activation page, and did not retry the existing failed build.
- **Initial optional integrations stay disabled.** Resend email credentials/domain verification and Google/Microsoft calendar OAuth are not required while their feature flags are false. They require separate provider setup and acceptance before enablement.

## Completion sequence

1. Owner enables the required Workers/R2 services; locate or provision the managed PostgreSQL, WorkOS environment and HTTPS scanner.
2. Fill the remaining runtime entries with real provider values and independent application keys. Preserve the same staging origin in public URL, CORS, WorkOS callback and R2 CORS.
3. Run the ignored `.env.production` through `node --env-file=.env.production scripts/preflight.mjs`, without printing values. Passing preflight only validates configuration structure.
4. Apply migrations and run live dependency acceptance. Confirm the reviewed deployment preserves the runtime table, then deploy the reviewed commit and verify smoke/end-to-end tests.
5. Enable/publicize the custom domain only after acceptance, updating all origin-bound settings together.
